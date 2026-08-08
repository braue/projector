// The scan every extractor needs: the first non-empty value among candidate
// setting-name spellings, trimmed; null when none is set.
function firstSetting(settings, keys) {
  for (const key of keys) {
    const value = String(settings[key] ?? '').trim();
    if (value) return value;
  }
  return null;
}

export { firstSetting };
