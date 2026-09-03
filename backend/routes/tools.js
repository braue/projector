// The Tools surface — global utilities beside the projects, mounted at
// /api/tools. This router owns what every tool shares: job polling, run-file
// listing/download/removal, and copying a run file into a project's Files
// store. Each tool mounts its own sub-router here as it lands.

import path from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { httpError, requireQuery } from '../lib/http.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function toolsRoutes(tools, projects) {
  const { workspace, jobs, settings } = tools;
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // Tool inputs come from either place the user keeps files: a multipart
  // upload (the OS file picker / drag-in), or a file already in a project's
  // Files store, named as JSON { project, path }.
  const resolveInput = async (req) => {
    if (req.file) return req.file;
    const { project, path: filePath } = req.body ?? {};
    if (project && filePath) {
      const files = (await projects.bundle(project)).files;
      return {
        originalname: path.basename(String(filePath)),
        buffer: await files.read(filePath),
      };
    }
    throw httpError(400, 'send a multipart "file", or { project, path } naming a project file');
  };

  router.get('/jobs/:id', (req, res) => {
    res.json(jobs.get(req.params.id));
  });

  // Machine-specific tool settings (paths, preferences — never credentials).
  router.get('/settings', async (_req, res) => {
    res.json(await settings.get());
  });
  router.patch('/settings', async (req, res) => {
    res.json(await settings.update(req.body ?? {}));
  });

  // HMI Tag Tester: one input in (upload or project file), the report out.
  router.post('/hmi/analyze', upload.single('file'), async (req, res) => {
    res.json(await tools.hmi.analyze(await resolveInput(req)));
  });

  // SEL terminal: open over REST, output over SSE, input as line posts. The
  // input rate is one line per Enter, so plain posts carry it fine — only
  // the relay->browser direction needs a stream.
  router.post('/terminal/open', async (req, res) => {
    res.status(201).json(await tools.terminal.open(req.body ?? {}));
  });

  router.get('/terminal/:id/stream', (req, res) => {
    // Subscribe BEFORE committing to the SSE response, so an unknown session
    // is still a plain 404 the error middleware can shape. The backlog (and a
    // tombstone's close) flush synchronously inside subscribe, ahead of the
    // headers — hold those until the stream is committed.
    let headed = false;
    let done = false;
    const pending = [];
    const emit = (event, payload) => {
      if (event === 'closed') done = true;
      if (!headed) {
        pending.push([event, payload]);
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (event === 'closed') res.end();
    };
    const unsubscribe = tools.terminal.subscribe(req.params.id, {
      data: (text) => emit('data', text),
      closed: (reason) => emit('closed', reason),
    });
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    headed = true;
    for (const [event, payload] of pending.splice(0)) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    if (done) {
      res.end();
      return;
    }
    req.on('close', unsubscribe);
  });

  router.post('/terminal/:id/input', (req, res) => {
    tools.terminal.input(req.params.id, req.body?.data);
    res.json({ ok: true });
  });

  router.post('/terminal/:id/close', (req, res) => {
    tools.terminal.close(req.params.id);
    res.json({ ok: true });
  });

  // QuickSet Extract: source a configs tree (DB dump job, or uploaded ZIP),
  // then inventory and settings extraction over the run.
  router.post('/quickset/dump', async (req, res) => {
    res.status(202).json(await tools.quickset.startDump(req.body ?? {}));
  });
  router.post('/quickset/upload', upload.single('file'), async (req, res) => {
    res.status(201).json(await tools.quickset.uploadConfigs(await resolveInput(req)));
  });
  router.get('/quickset/:run/inventory', async (req, res) => {
    res.json(await tools.quickset.inventory(req.params.run));
  });
  router.post('/quickset/:run/extract', async (req, res) => {
    res.json(await tools.quickset.extract(req.params.run, req.body?.settings));
  });

  // Switch Settings: XML in (upload or project file), editable model out;
  // edits back, updated XML out.
  router.post('/swset/parse', upload.single('file'), async (req, res) => {
    res.json(await tools.swset.parse(await resolveInput(req)));
  });
  router.post('/swset/:run/generate', async (req, res) => {
    res.json(await tools.swset.generate(req.params.run, req.body?.tables));
  });

  // RTAC Exporter. The bridge logs into the database itself (the fixed
  // admin/TAIL pair, like the catalog bridge) — no credentials in requests.
  router.post('/rtac-export/projects', async (_req, res) => {
    res.json(await tools.rtacExport.listProjects());
  });
  router.post('/rtac-export/export', async (req, res) => {
    res.status(202).json(await tools.rtacExport.startExport(req.body ?? {}));
  });

  // DAC SIM Converter: a ZIP of the DAC export bundle (settings.json beside
  // the DAC folders) in, generated simulator projects out, as a job.
  router.get('/dacsim/settings-template', async (_req, res) => {
    res.type('application/json')
      .set('Content-Disposition', 'attachment; filename="settings.json"')
      .send(await tools.dacsim.settingsTemplate());
  });
  router.post('/dacsim/upload', upload.single('file'), async (req, res) => {
    res.status(201).json(await tools.dacsim.uploadBundle(await resolveInput(req)));
  });
  // The projector-native path: DAC exports picked from a project's tree plus
  // form fields; settings.json is generated server-side.
  router.post('/dacsim/from-project', async (req, res) => {
    const { project, ...payload } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(201).json(await tools.dacsim.stageFromProject(files, payload));
  });
  router.post('/dacsim/:run/convert', async (req, res) => {
    res.status(202).json(await tools.dacsim.startConvert(req.params.run));
  });

  // Drawing Generator: part number in, configured drawings + AutoCAD bundle
  // out. open-dwg launches local AutoCAD on one bundled drawing with its
  // layer script — the on-demand DWG pass.
  router.get('/dwgen/models', async (_req, res) => {
    res.json({ models: await tools.dwgen.listModels() });
  });
  router.post('/dwgen/generate', async (req, res) => {
    res.json(await tools.dwgen.generate(req.body ?? {}));
  });
  router.post('/dwgen/open-dwg', async (req, res) => {
    res.json(await tools.dwgen.openDwg(req.body ?? {}));
  });

  // Keep a run result: copy it into a project's Files store (unique-ified
  // there, never overwriting — the same rules as a direct upload).
  router.post('/save-to-project', async (req, res) => {
    const { project, tool, run, path: filePath, dir, name } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const buffer = await workspace.readFile(tool, run, filePath);
    const files = (await projects.bundle(project)).files;
    const originalname = String(name ?? '').trim() || path.basename(String(filePath));
    // A tool output saved into the project is a version like any other;
    // callers may say what changed, and the tool run names the default.
    const note = String(req.body?.note ?? '').trim() || `saved from ${tool} run ${run}`;
    res.status(201).json(await files.upload(dir ?? '', [{ originalname, buffer }], note));
  });

  router.get('/:tool/runs/:run/files', async (req, res) => {
    res.json({ files: await workspace.listFiles(req.params.tool, req.params.run) });
  });

  router.get('/:tool/runs/:run/file', async (req, res) => {
    const absolute = await workspace.filePath(
      req.params.tool,
      req.params.run,
      requireQuery(req, 'path'),
    );
    res.download(absolute);
  });

  router.delete('/:tool/runs/:run', async (req, res) => {
    await workspace.removeRun(req.params.tool, req.params.run);
    res.json({ ok: true });
  });

  return router;
}

export { toolsRoutes };
