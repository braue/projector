// Parser for SEL AcSELerator RTAC project exports — the folder-of-XML format
// produced by cli.exportxml() (and by exporting a project as XML from
// AcSELerator, rather than as an encrypted .exp blob).
//
// One structural idea carries the whole format: everything configurable is a
// <SettingPage>, and every SettingPage is a table of <Row>s whose <Setting>
// cells are a <Column> name plus a <Value>. A page named "Settings" holds
// connection config; pages like "Binary Inputs" or "Coils" hold point maps.
//
// Layer 1 (parseModule.js + kinds.js) is structural and loss-tolerant; layer 2
// (project.js) assigns semantics. New RTAC object types are added as one entry
// in kinds.js — see that file.
//
// parseRtacProject takes the export files (already in memory — an export is a
// few MB of XML) and returns the project model. Unparseable files are
// collected rather than thrown, so one bad file cannot lose the rest of the
// export.

import { parseRtacModule } from './parseModule.js';
import { buildProject } from './project.js';

const RTAC_MODEL_VERSION = 2;

function parseRtacProject(files) {
  const modules = [];
  const errors = [];

  for (const { file, xml } of files) {
    try {
      modules.push(parseRtacModule(xml, file));
    } catch (err) {
      errors.push({ file, error: err?.message ?? String(err) });
    }
  }

  return {
    modelVersion: RTAC_MODEL_VERSION,
    fileCount: files.length,
    errors,
    ...buildProject(modules),
  };
}

export { RTAC_MODEL_VERSION, parseRtacProject };
