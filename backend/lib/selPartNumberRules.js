// Shared SEL part-number rule engine. SEL device metadata (metadata.json)
// describes which drawing/layer/transport applies to a given part number via
// `when` condition blocks and option-group selectors keyed off character
// positions in the part number. Both port-info resolution (profilePorts) and
// image generation (selDevices) match part numbers the same way, so the
// matching primitives live here and each caller supplies its own no-match
// fallback (return null vs. render a default drawing).

const WILDCARD_CHARS = new Set(['X', '*', '?']);

function normalizeKey(value) {
  return String(value ?? '').trim().toUpperCase();
}

// Part numbers can carry embedded whitespace in raw settings; strip it so
// position offsets line up with the metadata's character positions.
function normalizePartNumber(value) {
  return normalizeKey(value).replace(/\s+/g, '');
}

function arrayify(value) {
  return Array.isArray(value) ? value : [value];
}

function partValue(partNumber, position, length = 1) {
  const start = Number(position) - 1;
  if (!Number.isInteger(start) || start < 0) return '';
  return normalizeKey(partNumber).slice(start, start + length);
}

function wildcardExampleMatches(partNumber, example) {
  const pattern = normalizeKey(example);
  const value = normalizeKey(partNumber);
  if (!pattern || value.length < pattern.length) return false;

  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    if (WILDCARD_CHARS.has(expected)) continue;
    if (value[index] !== expected) return false;
  }

  return true;
}

// Score a `when` block against a part number. More specific conditions score
// higher so the best rule wins in selectBestRule. An unrecognized condition key
// is a metadata authoring error, so it throws (fail loud) rather than scoring
// as a silent non-match — which would let the catch-all/first rule render an
// incorrect drawing with no warning.
function conditionScore(when, partNumber) {
  if (!when || Object.keys(when).length === 0) return { matched: true, score: 0 };

  let score = 0;
  for (const [key, expected] of Object.entries(when)) {
    const positionMatch = /^position_(\d+)$/.exec(key);
    if (positionMatch) {
      const expectedValues = arrayify(expected).map(normalizeKey);
      const maxLength = Math.max(...expectedValues.map((value) => value.length), 1);
      const actual = partValue(partNumber, Number(positionMatch[1]), maxLength);
      if (!expectedValues.some((value) => actual.startsWith(value))) return { matched: false, score: 0 };
      score += 2;
      continue;
    }

    if (key === 'examples') {
      if (!arrayify(expected).some((example) => wildcardExampleMatches(partNumber, example))) {
        return { matched: false, score: 0 };
      }
      score += 3;
      continue;
    }

    if (key === 'observed_configurations') {
      const examples = arrayify(expected).map((configuration) => configuration?.example_model_number).filter(Boolean);
      if (!examples.some((example) => wildcardExampleMatches(partNumber, example))) {
        return { matched: false, score: 0 };
      }
      score += 3;
      continue;
    }

    throw new Error(`Unrecognized part-number condition key: ${key}`);
  }

  return { matched: true, score };
}

// Pick the highest-scoring matching rule. `fallback(rules)` decides what to do
// when nothing matches — callers pass a function that returns a default rule
// (image generation) or omit it to get null (port-info resolution).
function selectBestRule(rules, partNumber, { fallback } = {}) {
  const list = arrayify(rules);
  const matches = list
    .map((rule, index) => ({ rule, index, ...conditionScore(rule?.when, partNumber) }))
    .filter((candidate) => candidate.matched)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (matches.length > 0) return matches[0].rule;
  return typeof fallback === 'function' ? fallback(list) : null;
}

function exactOptionKey(options, value) {
  const normalizedValue = normalizeKey(value);
  return Object.keys(options ?? {}).find((key) => normalizeKey(key) === normalizedValue) ?? null;
}

function optionKeyMatches(partNumber, position, key, lengthHint) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return false;

  const variants = [normalizedKey];
  if (normalizedKey.endsWith('-')) variants.push(normalizedKey.slice(0, -1));

  return variants.some((variant) => {
    if (!variant) return false;
    const length = Math.max(variant.length, lengthHint ?? 1);
    return partValue(partNumber, position, length).startsWith(variant);
  });
}

function selectOptionKey(options, partNumber, position, lengthHint) {
  const keys = Object.keys(options ?? {}).sort((a, b) => b.length - a.length);
  return keys.find((key) => optionKeyMatches(partNumber, position, key, lengthHint)) ?? null;
}

// Resolve which option key a group's selector picks for this part number.
// A group with no valid `source` selector or `options` map is a metadata
// authoring error and throws (fail loud); a well-formed selector that simply
// matches no option returns null, which callers treat as "group absent".
function selectLayerOption(groupConfig, partNumber) {
  const selector = groupConfig?.source;
  const options = groupConfig?.options;
  if (!selector || !options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('SEL metadata option group is missing a valid `source` selector or `options` map');
  }

  if (selector.value != null) return exactOptionKey(options, selector.value);

  if (Array.isArray(selector.parts)) {
    const separator = selector.separator ?? '';
    const value = selector.parts
      .map((part) => partValue(partNumber, Number(part.position), part.length ?? 1))
      .join(separator);
    return exactOptionKey(options, value);
  }

  return selectOptionKey(options, partNumber, Number(selector.position), selector.length ?? 1);
}

export {
  arrayify,
  conditionScore,
  exactOptionKey,
  normalizePartNumber,
  partValue,
  selectBestRule,
  selectLayerOption,
  selectOptionKey,
  wildcardExampleMatches,
};
