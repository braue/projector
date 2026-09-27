// RTAC VLAN Deploy's Python half (py/sel_web.py + py/rtac_vlan_deploy.py):
// runs test/sel_web_test.py, which checks the device requests against real
// captures and drives the whole bridge over simulated devices. Skipped where
// no Python 3 is on PATH.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const python = ['python3', 'python'].find(
  (cmd) => spawnSync(cmd, ['-c', 'import sys; assert sys.version_info >= (3, 8)']).status === 0,
);

test('sel_web + rtac_vlan_deploy (python)', { skip: !python && 'no Python 3 on PATH' }, () => {
  const run = spawnSync(python, [path.join(HERE, 'sel_web_test.py')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});
