// Machine settings — the app's small persistent preferences, from tool paths
// (where AutoCAD lives, saved terminal connections) to window conveniences
// (pane widths, remembered form fields). A flat object, PATCH-merged.
//
// Window preferences live here and not in localStorage: the packaged app
// listens on port 0, so its origin — and with it everything Chromium keys by
// origin — changes on every launch.
//
// Never credentials: passwords and session cookies travel per request and
// stay in memory.
//
// The file sits under tools/ because tool settings came first; it stays there
// so existing installs keep theirs.

import path from 'node:path';

import { httpError } from '../lib/http.js';
import { JsonFile } from '../lib/jsonFile.js';

class SettingsService {
  constructor({ dataDir }) {
    this.store = new JsonFile(path.join(dataDir, 'tools', 'settings.json'), {
      label: 'the settings',
      empty: () => ({}),
      clean: (raw) => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}),
    });
  }

  get() {
    return this.store.read();
  }

  /** Shallow-merge `patch`; a null value removes the key. */
  async update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw httpError(400, 'settings patch must be an object');
    }
    const { doc } = await this.store.update((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      return next;
    });
    return doc;
  }
}

export { SettingsService };
