// Persistent tool settings — the few machine-specific paths and preferences
// the tools need (e.g. where Diagram Builder's bin folder is). One JSON file
// under the tools workspace; a flat object, PATCH-merged from the UI.
//
// Never credentials: passwords and session cookies travel per request and
// stay in memory.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

class ToolSettings {
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'tools', 'settings.json');
  }

  async get() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
  }

  /** Shallow-merge `patch`; a null value removes the key. */
  async update(patch) {
    const next = { ...await this.get() };
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2));
    return next;
  }
}

export { ToolSettings };
