// The real sample export (Desktop/RTAC_PROJECT, overridable via
// ACRTAC_SAMPLE_DIR) as parseRtacProject input. Tests that need it skip
// cleanly when the folder is absent.

import { access, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SAMPLE_DIR = process.env.ACRTAC_SAMPLE_DIR
  ?? path.join(os.homedir(), 'Desktop', 'RTAC_PROJECT');

const sampleExists = await access(SAMPLE_DIR).then(() => true, () => false);

async function loadSample() {
  const files = [];
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      else if (/\.xml$/i.test(entry.name)) {
        files.push({ file: relPath, xml: await readFile(path.join(dir, entry.name), 'utf8') });
      }
    }
  };
  await walk(SAMPLE_DIR, '');
  return files;
}

export { loadSample, sampleExists };
