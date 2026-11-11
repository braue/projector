// NSIS only writes an uninstaller by running an installer, so electron-builder
// builds a throwaway one and runs it — under Wine on Linux. It already has a
// pure-JS reader that pulls the uninstaller out of that installer instead, but
// only uses it on macOS Catalina+. Projector is built on Linux and not code
// signed (the run exists so the uninstaller can be signed), so use the reader
// here too: no Wine. Idempotent; fails loudly if electron-builder moves on.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const file = require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js')
const stock = 'if ((0, macosVersion_1.isMacOsCatalina)()) {'
const patched = 'if ((0, macosVersion_1.isMacOsCatalina)() || process.platform === "linux") {'

const src = readFileSync(file, 'utf8')
if (src.includes(patched)) process.exit(0)
if (!src.includes(stock)) {
  console.error(`patch-nsis-uninstaller: pattern not found in ${file} — electron-builder changed, revisit the patch`)
  process.exit(1)
}
writeFileSync(file, src.replace(stock, patched))
console.log('patch-nsis-uninstaller: uninstaller is now extracted without Wine')
