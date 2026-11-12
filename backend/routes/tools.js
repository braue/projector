// The Tools surface — global utilities beside the projects, mounted at
// /api/tools. This router owns what every tool shares — run-file download, copying a run file into a project's Files store — plus each
// tool's own endpoints, grouped per tool below. Tool jobs live in the app's
// job registry (routes/jobs.js).

import { copyFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError, requireQuery } from '../lib/http.js';
import { Router, uploads } from '../lib/router.js';

const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function toolsRoutes(tools, projects) {
  const { workspace } = tools;
  const router = Router();
  const upload = uploads({ maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 1 });
  const uploadPair = uploads({ maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 2 }).fields(['workbook', 'report']);
  const locateUpload = uploads({ maxFileSize: 16 * 1024 * 1024, maxFiles: 4 });

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

  // QuickSet Extract: read a QuickSet database backup ZIP (or a bare
  // DMData.dump). A project file is read in place: start { project, path,
  // password }. A file from disk goes in two steps so only the bytes that
  // matter cross: locate (multipart: name, size, and "range" parts each named
  // by its start offset — the file's tail first) answers { need } until it
  // can name the slice to send, then start { name, password, located } and
  // PUT the slice as the raw body of /quickset/:run/data.
  router.post('/quickset/locate', locateUpload.array('range'), async (req, res) => {
    const size = Number(req.body?.size);
    if (!Number.isFinite(size) || size <= 0) throw httpError(400, 'size required');
    const ranges = (req.files ?? []).map((f) => ({ start: Number(f.originalname), buffer: f.buffer }));
    res.json(await tools.quickset.locate({ name: String(req.body?.name ?? ''), size, ranges }));
  });
  router.post('/quickset/start', async (req, res) => {
    const { project, path: filePath, name, password, located } = req.body ?? {};
    if (project && filePath) {
      const files = (await projects.bundle(project)).files;
      res.status(202).json(await tools.quickset.start({
        name: path.basename(String(filePath)),
        password,
        absolute: await files.rawPath(filePath),
      }));
      return;
    }
    res.status(202).json(await tools.quickset.start({ name: String(name ?? ''), password, located }));
  });
  router.put('/quickset/:run/data', async (req, res) => {
    res.json(await tools.quickset.feed(req.params.run, req));
  });
  router.get('/quickset/:run/result', async (req, res) => {
    res.json(await tools.quickset.result(req.params.run));
  });
  router.post('/quickset/:run/extract', async (req, res) => {
    res.json(await tools.quickset.extract(req.params.run, req.body?.settings));
  });
  // The device browser, served so it opens in a browser tab; its per-device
  // settings load from viewer_data/ beside it.
  router.get('/quickset/:run/viewer/:file', async (req, res) => {
    await res.sendFile(await tools.quickset.viewerFile(req.params.run, req.params.file));
  });
  router.get('/quickset/:run/viewer/viewer_data/:file', async (req, res) => {
    await res.sendFile(await tools.quickset.viewerFile(req.params.run, `viewer_data/${req.params.file}`));
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
  // admin/TAIL pair) — no credentials in requests. Its project list is the
  // shared /api/acrtac/projects.
  router.post('/rtac-export/export', async (req, res) => {
    res.status(202).json(await tools.rtacExport.startExport(req.body ?? {}));
  });

  // DAC SIM Converter: DAC exports picked from a project's tree plus form
  // fields in (settings.json is generated server-side); one job converts.
  // Nothing lands in the project until the explicit save call places the
  // run's simulator projects into the tree.
  router.post('/dacsim/generate', async (req, res) => {
    const { project, ...payload } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(202).json(await tools.dacsim.generate(files, payload));
  });
  router.post('/dacsim/:run/save', async (req, res) => {
    const { project } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(201).json(await tools.dacsim.save(files, req.params.run));
  });

  // CLECO DAC Inits: generate device init blocks into a run-local copy of a
  // DAC .rtac ({ project, path, params, reclosers, transformers,
  // feedersBreakers, overwrite }); identifiers already used in the project come
  // back as `conflicts` and are only rewritten when named in `overwrite`. Save
  // lands the run as a new version of that same entry.
  router.post('/dacinit/generate', async (req, res) => {
    const { project, ...payload } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(202).json(await tools.dacinit.generate(files, payload));
  });
  router.post('/dacinit/:run/save', async (req, res) => {
    const { project } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(201).json(await tools.dacinit.save(files, req.params.run));
  });

  // Automatic FAT → Excel: a FAT workbook and an automatic-FAT HTML report,
  // each a multipart upload ("workbook" / "report") or a project file named
  // by <field>Project + <field>Path; plus `engineer`. One job converts; save
  // lands the result as a new version of the workbook's project entry.
  // `feeders` (a JSON array) limits the run to those feeders; `bands` (JSON
  // [{ name, color, feeders }]) sets the substation bands; /fatsheets/feeders
  // lists a report's feeders for the picker (the report alone, same fields).
  const fatInput = (req, field) => {
    const body = req.body ?? {};
    const file = req.files?.[field]?.[0];
    if (file) return { name: file.originalname, buffer: file.buffer };
    const project = body[`${field}Project`];
    const filePath = body[`${field}Path`];
    return project && filePath ? { project: String(project), path: String(filePath) } : null;
  };
  const fatFilesFor = async (project) => (await projects.bundle(project)).files;
  router.post('/fatsheets/feeders', uploadPair, async (req, res) => {
    res.json(await tools.fatsheets.feeders(fatFilesFor, fatInput(req, 'report')));
  });
  router.post('/fatsheets/generate', uploadPair, async (req, res) => {
    const body = req.body ?? {};
    const json = (field) => {
      if (!body[field]) return null;
      try {
        return JSON.parse(body[field]);
      } catch {
        throw httpError(400, `${field} must be JSON`);
      }
    };
    const feeders = json('feeders');
    const bands = json('bands');
    res.status(202).json(await tools.fatsheets.generate(fatFilesFor, {
      workbook: fatInput(req, 'workbook'),
      report: fatInput(req, 'report'),
      engineer: body.engineer ?? '',
      feeders,
      bands,
    }));
  });
  router.post('/fatsheets/:run/save', async (req, res) => {
    res.status(201).json(await tools.fatsheets.save(fatFilesFor, req.params.run));
  });

  // The project tree's generic AcRTAC actions on an RTAC entry, each a
  // pollable job. Import: { project, path, name, deviceType, firmware }.
  // Open: { name } — launch the AcSELerator RTAC GUI on that database
  // project (double-click; no project files involved).
  router.post('/acrtac/import', async (req, res) => {
    const { project, ...payload } = req.body ?? {};
    if (!project) throw httpError(400, 'project required');
    const files = (await projects.bundle(project)).files;
    res.status(202).json(await tools.acrtac.import(files, payload));
  });
  router.post('/acrtac/open', (req, res) => {
    res.status(202).json(tools.acrtac.open(req.body ?? {}));
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
    // Copied disk-to-disk — a run output can be a hundreds-of-MB exports ZIP,
    // and its bytes never need to enter the heap.
    const absolute = await workspace.filePath(tool, run, filePath);
    const files = (await projects.bundle(project)).files;
    const entryName = String(name ?? '').trim() || path.basename(String(filePath));
    // A tool output saved into the project is a version like any other;
    // callers may say what changed, and the tool run names the default.
    const note = String(req.body?.note ?? '').trim() || `saved from ${tool} run ${run}`;
    const added = await files.placeEntry(dir ?? '', entryName, note, (target) => copyFile(absolute, target));
    res.status(201).json({ added: [added] });
  });

  router.get('/:tool/runs/:run/file', async (req, res) => {
    const absolute = await workspace.filePath(
      req.params.tool,
      req.params.run,
      requireQuery(req, 'path'),
    );
    await res.download(absolute);
  });

  return router;
}

export { toolsRoutes };
