// Upgrade safety: installing a newer Projector over an older one must keep the
// user's data. None of this is exercised by running the app, so it is pinned
// here — a rename or a flag flip that would silently orphan or delete the data
// directory fails the suite instead of a customer's install.
//
// Two facts do the work:
//   - The data directory is %APPDATA%\<productName>\data (electron/main.js
//     passes app.getPath('userData')), which is outside the install directory
//     the installer replaces.
//   - The uninstaller that a one-click update runs first must not take
//     %APPDATA% with it.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

test('packaging: the identity that decides the data directory is stable', () => {
  // Electron derives userData from the app name — %APPDATA%\Projector. Change
  // this and every existing install's projects, notes, files, and todo list
  // are still on disk, but under a name the new build never looks at.
  assert.equal(pkg.productName, 'Projector');
  // NSIS keys the upgrade (finding and uninstalling the older version) on the
  // appId. A change here makes the installer a fresh install alongside the old.
  assert.equal(pkg.build.appId, 'com.braue.projector');
});

test('packaging: an upgrade cannot delete the data directory', () => {
  // A one-click update runs the previous version's uninstaller first. This is
  // the flag that decides whether it takes %APPDATA%\Projector with it.
  assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false);
});

test('packaging: nothing user-written is shipped inside the install directory', async () => {
  // The install directory is deleted and rewritten on every upgrade, so
  // anything the user can change must not live there. backend/data is the
  // from-source data directory; it must never be packaged.
  assert.ok(pkg.build.files.includes('!backend/data/**'));

  // The installer hook may close the running app, but must not remove data.
  // Comments are stripped first — the hook's own comment explains that state
  // lives in %APPDATA%, which is the opposite of a deletion.
  const hook = await readFile(path.join(ROOT, 'build', 'installer.nsh'), 'utf8');
  const commands = hook
    .split('\n')
    .filter((line) => !line.trim().startsWith(';'))
    .join('\n');
  assert.match(commands, /taskkill/);
  assert.doesNotMatch(commands, /RMDir|\bDelete\b|APPDATA/i);
});
