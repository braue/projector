// One PDFium WASM instance for the process.
//
// Init is neither cheap nor small, and two callers now need it — the drawing
// generator rasterizes pages, find-in-PDF reads their text — so the handle
// lives here rather than in either of them.

import { PDFiumLibrary } from '@hyzyla/pdfium';

let library = null;

/** The shared library, initialized on first use. */
function pdfium() {
  return (library ??= PDFiumLibrary.init());
}

export { pdfium };
