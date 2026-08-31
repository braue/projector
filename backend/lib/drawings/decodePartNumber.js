// SEL part-number (MOT) decoder, ported from Volture. Each model's
// metadata.json carries a `part_number` block describing what every position
// of the ordering string means; decoding returns one entry per described
// position with the selected code, its human-readable description, and
// provenance — the UI's option-by-option breakdown.

import { conditionScore } from '../selPartNumberRules.js';
import { loadDeviceMetadata } from './deviceMetadata.js';

function lookupOption(options, code) {
  if (!options || typeof options !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(options, code)) return options[code];
  // Layer option keys can use a trailing '-' as a filler for the second char.
  const withFiller = `${code[0] ?? ''}-`;
  if (Object.prototype.hasOwnProperty.call(options, withFiller)) return options[withFiller];
  return null;
}

/** Decode against one metadata object's `part_number` spec; null without one.
 *
 * Some products take differently-sized ordering strings per submodel (a
 * 421-4 is 21 characters, a 421-7 is 25) with the same field at different
 * positions, which one flat table cannot describe. A spec may carry
 * `submodels: [{name, length?, when?, positions}]`; an entry matches when its
 * `length` (if given) equals the part number's and its `when` conditions (if
 * given, the drawing-rule condition syntax — needed where submodels share a
 * length and differ by a digit, like the legacy 487E firmware codes) match.
 * `spec.positions` stays the fallback for part numbers no submodel claims. */
function decodeWithMetadata(metadata, partNumber) {
  const spec = metadata?.part_number;
  if (!spec) return null;
  const value = String(partNumber ?? '').trim().toUpperCase();
  const submodel = (spec.submodels ?? []).find((sub) => {
    if (sub.length != null && Number(sub.length) !== value.length) return false;
    if (sub.when && !conditionScore(sub.when, value).matched) return false;
    return sub.length != null || sub.when != null;
  }) ?? null;
  const positions = ((submodel ?? spec).positions ?? []).map((pos) => {
    const start = Number(pos.position) - 1;
    const length = Number(pos.length) || 1;
    const code = start >= 0 ? value.slice(start, start + length) : '';

    // Composite fields (e.g. a slot's "card type | digital-input voltage")
    // decode each sub-digit independently and join the descriptions.
    let components = null;
    let description;
    if (Array.isArray(pos.components)) {
      components = pos.components.map((comp) => {
        const subCode = code.slice(comp.offset, comp.offset + (comp.length || 1));
        const subDesc = lookupOption(comp.options, subCode);
        return { label: comp.label ?? null, code: subCode, description: subDesc ?? null };
      });
      const parts = components.map((c) => c.description).filter(Boolean);
      description = parts.length ? parts.join(' | ') : null;
    } else {
      description = lookupOption(pos.options, code);
    }

    return {
      position: pos.position,
      field: pos.field,
      label: pos.label,
      code,
      description: description ?? null,
      matched: description != null,
      components,
      source: pos.source ?? null,
      confidence: pos.confidence ?? null,
      note: pos.note ?? null,
    };
  });

  return {
    model: spec.model ?? null,
    product: spec.product ?? null,
    partNumber: value || null,
    submodel: submodel?.name ?? null,
    positions,
  };
}

async function decodePartNumber(model, partNumber, devicesDir) {
  return decodeWithMetadata(await loadDeviceMetadata(model, devicesDir), partNumber);
}

export { decodePartNumber, decodeWithMetadata };
