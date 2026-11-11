// PDF text: the text layer PDFium reads, page by page — and for pages that
// have none (a scanned drawing set, a photographed nameplate saved as PDF),
// the text OCR reads off the rendered page.

import { pdfium } from '../pdfium.js';
import { bitmapToPgm, recognize } from './ocr.js';
import { flatten } from './text.js';

/** A page with fewer characters than this is treated as an image of paper. */
const TEXTLESS_BELOW = 16;

/** OCR resolution: 300 dpi is what Tesseract is tuned for... */
const OCR_DPI = 300;
/** ...unless the page is a D-size drawing, which at 300 dpi is ~70 MP. */
const OCR_MAX_PIXELS = 24_000_000;

/** Scanned pages read per document. Past this a scan is an archive box, and
 *  its first pages say what it is. */
const MAX_OCR_PAGES = 400;

/**
 * Every page's text. With `ocr`, textless pages are rendered and read;
 * without it they come back empty and `wantsOcr` says there is more to get.
 *
 * Returns { pages: string[], wantsOcr, ocrPages: number[] (1-based) }.
 */
async function pdfPages(bytes, { ocr = false } = {}) {
  const library = await pdfium();
  const document = await library.loadDocument(Buffer.from(bytes));
  try {
    const pages = [];
    const textless = [];
    let index = 0;
    for (const page of document.pages()) {
      const text = flatten(page.getText());
      pages.push(text);
      if (text.length < TEXTLESS_BELOW) textless.push(index);
      index += 1;
    }
    const ocrPages = [];
    if (ocr) {
      for (const at of textless.slice(0, MAX_OCR_PAGES)) {
        const page = document.getPage(at);
        const { originalWidth, originalHeight } = page.getOriginalSize();
        const dpiScale = OCR_DPI / 72;
        const fitScale = Math.sqrt(OCR_MAX_PIXELS / Math.max(1, originalWidth * originalHeight));
        const scale = Math.min(dpiScale, fitScale);
        const { data, width, height } = await page.render({ scale, render: 'bitmap' });
        const read = flatten(await recognize(bitmapToPgm({ data, width, height })));
        // A page's own few characters (a stamp, a page number) stay ahead
        // of what OCR found on it.
        pages[at] = [pages[at], read].filter(Boolean).join(' ');
        ocrPages.push(at + 1);
      }
    }
    return { pages, wantsOcr: !ocr && textless.length > 0, ocrPages };
  } finally {
    document.destroy();
  }
}

export { pdfPages };
