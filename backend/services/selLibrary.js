// The SEL document library — the manuals, data sheets, application guides and
// ordering information that live as PDFs on this machine (C:\SEL by default).
//
// This service knows two things: whether the library is there, and how to open
// one of its files. Finding a document is the full-text index's job
// (services/selFullText.js), which searches the contents of all ~124,000 pages
// rather than guessing from filenames — so nothing here needs to enumerate the
// library, and a folder of that size is not worth walking to learn nothing.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { httpError, resolveWithin } from '../lib/http.js';
import { openWithOs } from '../lib/openWithOs.js';

class SelLibrary {
  #root;

  constructor({ root }) {
    this.#root = path.resolve(root);
  }

  async status() {
    const info = await stat(this.#root).catch(() => null);
    return { root: this.#root, rootPresent: Boolean(info?.isDirectory()) };
  }

  /** Confine a caller-supplied path to the library before touching disk. */
  #resolve(relPath) {
    if (!relPath) throw httpError(400, 'path required');
    return resolveWithin(this.#root, relPath, 'path escapes the SEL library');
  }

  /**
   * Hand the PDF to the OS default viewer. Same reasoning as the project file
   * store: loopback deployment makes this the user's own machine, and the path
   * is library-confined by #resolve.
   */
  async open(relPath, page = null) {
    const absolute = this.#resolve(relPath);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw httpError(404, `no such document: ${relPath}`);
    // Landing on a specific page needs the file:// form with a #page fragment,
    // which browser-based viewers honour. That routes through the URL handler
    // rather than the PDF file association, so it is used only when a page was
    // actually asked for — a plain open still goes to whatever opens PDFs.
    const target =
      page && Number.isFinite(Number(page))
        ? `file:///${absolute.split(path.sep).join('/').replace(/ /g, '%20')}#page=${Number(page)}`
        : absolute;
    openWithOs(target);
  }
}

export { SelLibrary };
