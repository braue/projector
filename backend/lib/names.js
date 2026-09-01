/**
 * A display name reduced to a safe path segment. The character class is the
 * one thing that has to agree with resolveChild's idea of a safe segment, so
 * it lives here rather than once per store.
 */
function idBase(name, fallback) {
  return name.replace(/[^\w.-]+/g, '_') || fallback;
}

// First of base, base-2, base-3, ... that isUsed accepts as free.
function uniqueName(base, isUsed) {
  let candidate = base;
  let suffix = 2;
  while (isUsed(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export { idBase, uniqueName };
