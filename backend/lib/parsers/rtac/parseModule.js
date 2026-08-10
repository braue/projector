// Layer 1 of the RTAC export parser — structure only.
//
// Turns one export XML file into a generic, loss-tolerant structural module.
// It knows the *shape* of an RTAC module (an ExportSource, a container kind,
// and a set of SettingPages that are each a table of column-keyed rows) but
// assigns NO protocol semantics — that is Layer 2's job (project.js).
//
// The kind is whatever element actually names the container — not a hard-coded
// allowlist — so an export written by a newer AcSELerator than this parser
// still yields a module carrying its real kind, its name, and its setting
// pages. Kind-specific structure (POU source, EtherCAT topology, ...) is
// pulled by the extractor registered for that kind in kinds.js.

import { createHash } from 'node:crypto';

import { describeKind, NON_KIND_CHILDREN } from './kinds.js';
import { cdata, collect, findFirst, parseXml, text, toArray } from '../xml.js';

// Parse one <SettingPage> into { name, addItems?, columns, rows }. A row is an
// object keyed by <Column> text -> <Value> text; column order is captured
// separately (stable within a page, and what the UI renders by).
function parseSettingPage(settingPage) {
  const columns = [];
  const seen = new Set();
  const rows = [];

  for (const rowEl of toArray(settingPage.Row)) {
    const row = {};
    for (const setting of toArray(rowEl.Setting)) {
      const column = text(setting.Column);
      if (!column) continue;
      // <Value /> -> "" ; <Value>x</Value> -> "x"
      row[column] = 'Value' in setting ? text(setting.Value) : '';
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
    rows.push(row);
  }

  const page = { name: text(settingPage.Name), columns, rows };

  // <Commands><AddItems><Start/><Quantity/></AddItems></Commands> records how a
  // block of points was bulk-added in the RTAC UI — it hints at point layout.
  const addItems = findFirst(settingPage, 'AddItems');
  if (addItems) {
    page.addItems = { start: text(addItems.Start), quantity: text(addItems.Quantity) };
  }
  return page;
}

// NOT user logic: the RTAC implements every protocol connection as a function
// block, so a ControllerPOU (a CDATA blob of CoDeSys XML, tens of thousands
// of lines) is present on essentially every connection and says nothing about
// the project — but tokenizing it dominates parse time on large exports. A
// stop node keeps it as one unparsed string: presence stays exact, cost
// disappears. User-written ST/LD/CFC lives in its own POU modules, untouched.
const STOP_NODES = ['*.ControllerPOU'];

// The container is the first child element of <RTACModule> that is not
// bookkeeping. Its element name is the module kind.
function findContainer(rtac) {
  for (const [key, value] of Object.entries(rtac)) {
    if (NON_KIND_CHILDREN.has(key) || key.startsWith('@_')) continue;
    if (value && typeof value === 'object') return { kind: key, container: toArray(value)[0] };
  }
  return { kind: 'Unknown', container: rtac };
}

// Parse one export file (raw XML) into a structural module. `file` is the path
// relative to the export root and doubles as the module's stable identity.
function parseRtacModule(xmlString, file = '<memory>') {
  const doc = parseXml(xmlString, STOP_NODES);
  const rtac = doc.RTACModule;
  if (!rtac) {
    throw new Error(`${file}: missing <RTACModule> root`);
  }

  const { kind, container } = findContainer(rtac);
  const spec = describeKind(kind);

  const exportSource = findFirst(rtac, 'ExportSource') ?? {};
  const module = {
    file,
    kind,
    category: spec.category,
    kindLabel: spec.label,
    schema: text(findFirst(exportSource, 'Schema')) || null,
    // The RTAC's own model-option-table number, e.g. "3555" for an SEL-3555.
    deviceMOT: text(findFirst(exportSource, 'DeviceMOT')) || null,
    // Most containers carry <Name>; NavigatorLayout carries the project name
    // as an attribute instead.
    name: text(container?.Name) || container?.['@_Name'] || null,
  };

  module.settingPages = collect(container, 'SettingPage').map(parseSettingPage);

  // The blob rode through unparsed (STOP_NODES); recorded for fidelity — do
  // not surface it as "this connection has logic".
  module.hasControllerPou = findFirst(container, 'ControllerPOU') !== undefined;

  // Graphical logic (CFC/LD) ships as an ArchivedContent blob the parser
  // cannot decode: presence for the UI, and a fingerprint so compare still
  // sees edits inside it. LOGIC KINDS ONLY — protocol connections embed
  // ArchivedContent blobs of their own (OPCUA data sources), which are the
  // RTAC's plumbing: not user logic, and their regeneration is exactly the
  // raw-blob noise signatures must not see.
  if (spec.category === 'logic') {
    const archived = findFirst(container, 'ArchivedContent');
    if (archived !== undefined) {
      module.hasArchivedContent = true;
      module.archivedContentHash = createHash('sha1').update(cdata(archived)).digest('hex');
    }
  }

  // Kind-specific structure last, so an extractor may refine the defaults but
  // the generic capture above happens for every kind, known or not.
  if (spec.extract) Object.assign(module, spec.extract(container));

  return module;
}

export { parseRtacModule };
