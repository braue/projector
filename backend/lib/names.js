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

export { uniqueName };
