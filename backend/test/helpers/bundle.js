// The per-project service bundle the way services/projects.js builds it,
// over a temp directory — files own the bytes, artifacts the meaning.

import { ArtifactsService } from '../../lib/artifacts.js';
import { FilesService } from '../../services/files.js';
import { RdbKind } from '../../services/rdb.js';
import { ScdKind } from '../../services/scd.js';
import { SwKind } from '../../services/sw.js';

async function makeBundle(projectDir, { catalog } = {}) {
  let artifacts;
  const files = new FilesService({
    dataDir: projectDir,
    onChanged: (relPath) => artifacts?.invalidate(relPath),
  });
  artifacts = new ArtifactsService({
    files,
    catalog: catalog ?? { names: [], error: null },
    projectDir,
  });
  artifacts.register('rdb', new RdbKind({ artifacts, projectDir }));
  artifacts.register('scd', new ScdKind({ artifacts }));
  artifacts.register('sw', new SwKind({ artifacts }));
  await files.init();
  return { files, artifacts, load: (ref) => artifacts.comparable(ref) };
}

const asUpload = (name, content) => ({ originalname: name, buffer: Buffer.from(content) });

/** The rtac-directory annotator FilesService-only tests hand to tree() —
 *  matching ArtifactsService.kindOf's built-in rtac detection. */
const rtacAnnotate = (name, isDirectory) => (isDirectory && /\.rtac$/i.test(name) ? 'rtac' : null);

export { asUpload, makeBundle, rtacAnnotate };
