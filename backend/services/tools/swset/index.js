// Switch Settings (SWSET) — edit an SEL managed-switch Configuration XML in
// a native form instead of the old XML->Excel->XML round-trip. Parse resolves
// the family schema against the device and returns every current value; the
// baseline XML stays in the run (where the old tool hid it in a worksheet),
// and generate applies the submitted values onto that baseline so the output
// is the input with only the edits changed.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { httpError } from '../../../lib/http.js';
import { buildSchema273x } from './schema273x.js';
import { collectSettings, parseConfigXml, buildConfigXml, xmlGet, xmlSet } from './xml.js';

const BASELINE = 'baseline.xml';

// The row count of an XML-backed list (the old container_len): the value at
// `base` may be a real array or a dict keyed by stringified indices.
function containerLength(settings, base) {
  let node = settings;
  for (const key of base) {
    if (node != null && typeof node === 'object' && !Array.isArray(node)) node = node[key] ?? {};
    else if (Array.isArray(node)) node = [];
    else return 0;
  }
  if (Array.isArray(node)) return node.length;
  if (node != null && typeof node === 'object') return Object.keys(node).length;
  return 0;
}

function parsedConfig(text) {
  const doc = parseConfigXml(text);
  const config = doc?.Configuration;
  if (config == null || typeof config !== 'object') {
    throw httpError(400, 'not a switch Configuration XML');
  }
  return { doc, config };
}

function schemaFor(config) {
  const nameplate = config.Nameplate ?? {};
  if (!('Type' in nameplate)) {
    throw httpError(400, 'no Nameplate Type in the XML — only the SEL-273x family is supported');
  }
  return { nameplate, schema: buildSchema273x(nameplate) };
}

/** The schema with every current value resolved in, for the UI. */
function resolveModel(config) {
  const { nameplate, schema } = schemaFor(config);
  const settings = collectSettings(config);
  const sections = schema.sections.map((section) => ({
    id: section.id,
    label: section.label,
    tables: section.tables.map((table) => {
      if (table.kind === 'nameplate') {
        return { ...table, values: Object.fromEntries(
          table.fields.map((f) => [f.id, nameplate[f.key] ?? '']),
        ) };
      }
      if (table.kind === 'fields') {
        return { ...table, values: Object.fromEntries(
          table.fields.map((f) => [f.id, xmlGet(settings, f.path) ?? '']),
        ) };
      }
      const count = containerLength(settings, table.base);
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        rows.push(Object.fromEntries(table.columns.map((column) => [
          column.id,
          column.fixed ?? (xmlGet(settings, [...table.base, i, ...column.key]) ?? ''),
        ])));
      }
      return { ...table, rows };
    }),
  }));
  return { nameplate, sections };
}

class SwsetService {
  constructor({ workspace }) {
    this.workspace = workspace;
  }

  /** Parse one uploaded Configuration XML into the editable model. */
  async parse(upload) {
    const text = upload.buffer.toString('utf8');
    const { config } = parsedConfig(text); // validate before creating the run
    const { nameplate, sections } = resolveModel(config);
    const { runId, dir } = await this.workspace.createRun('swset');
    await writeFile(path.join(dir, BASELINE), text);
    return {
      tool: 'swset',
      run: runId,
      deviceType: nameplate.Type ?? '',
      fid: nameplate.FID ?? '',
      sections,
    };
  }

  /**
   * Apply submitted values onto the run's baseline and emit the XML.
   * `tables` is { [tableId]: { fields?: {fieldId: value}, rows?: [{columnId: value}] } }
   * — the service re-resolves every path from the schema, so the client never
   * names XML paths directly.
   */
  async generate(runId, tables) {
    const dir = await this.workspace.runDir('swset', runId);
    const text = await readFile(path.join(dir, BASELINE), 'utf8');
    const { doc, config } = parsedConfig(text);
    const { nameplate, schema } = schemaFor(config);
    const settings = collectSettings(config);

    let applied = 0;
    const skipped = [];
    const write = (pathArr, value, create, label) => {
      if (xmlSet(config, pathArr, value, { create: Boolean(create) })) applied += 1;
      else skipped.push(label);
    };

    for (const section of schema.sections) {
      for (const table of section.tables) {
        const submitted = tables?.[table.id];
        if (!submitted) continue;
        if (table.kind === 'fields' && submitted.fields) {
          for (const field of table.fields) {
            if (field.readOnly || !(field.id in submitted.fields)) continue;
            write(field.path, submitted.fields[field.id], field.create, `${table.label} — ${field.label}`);
          }
        }
        if (table.kind === 'list' && Array.isArray(submitted.rows)) {
          const existing = containerLength(settings, table.base);
          submitted.rows.forEach((row, i) => {
            const isNew = i >= existing;
            if (isNew && !table.canAddRows) return;
            // A brand-new row that is entirely blank is not a row.
            if (isNew && table.columns.every((c) => c.fixed || c.readOnly || !String(row[c.id] ?? '').trim())) {
              return;
            }
            for (const column of table.columns) {
              if (column.fixed || column.readOnly || !(column.id in row)) continue;
              write(
                [...table.base, i, ...column.key],
                row[column.id],
                column.create || isNew,
                `${table.label} row ${i + 1} — ${column.label}`,
              );
            }
          });
        }
      }
    }

    const stem = String(nameplate.FID ?? nameplate.Type ?? 'switch').replaceAll(/[<>:"/\\|?*]/g, '');
    const report = { path: `${stem} updated.xml`, label: 'Updated configuration XML' };
    await writeFile(path.join(dir, report.path), buildConfigXml(doc));
    return { tool: 'swset', run: runId, applied, skipped, reports: [report] };
  }
}

export { SwsetService, resolveModel };
