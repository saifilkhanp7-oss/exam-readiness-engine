// OCR for scanned PDFs: renders image-only pages with pdf.js + @napi-rs/canvas and reads them with Tesseract.
// English language data is bundled (@tesseract.js-data/eng), so no download is needed at run time.
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { createWorker, type Worker } from 'tesseract.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const engData = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };

/** pdf.js needs a canvas factory in Node; this one uses @napi-rs/canvas (prebuilt, no system libraries). */
class NapiCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.max(1, Math.ceil(width)), Math.max(1, Math.ceil(height)));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc: { canvas: Canvas }, width: number, height: number) {
    cc.canvas.width = Math.max(1, Math.ceil(width));
    cc.canvas.height = Math.max(1, Math.ceil(height));
  }
  destroy(cc: { canvas: Canvas | null; context: unknown }) {
    if (cc.canvas) { cc.canvas.width = 0; cc.canvas.height = 0; }
    cc.canvas = null; cc.context = null;
  }
}

let workerPromise: Promise<Worker> | null = null;
function getWorker() {
  workerPromise ??= createWorker('eng', 1, {
    langPath: engData.langPath,
    gzip: engData.gzip,
    cachePath: os.tmpdir(),
    logger: () => {},
  });
  return workerPromise;
}

/** OCR the given 1-based pages of a PDF. Returns text per page number. */
export async function ocrPages(data: Uint8Array, pages: number[], onProgress?: (f: number) => void): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pages.length) return out;
  const doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, CanvasFactory: NapiCanvasFactory as never }).promise;
  const worker = await getWorker();
  let done = 0;
  for (const n of pages) {
    const page = await doc.getPage(n);
    // About 200 dpi is enough for printed text and keeps memory low.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 1650 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as never, viewport }).promise;
    const png = await canvas.encode('png');
    const { data: res } = await worker.recognize(png);
    out.set(n, cleanOcr(res.text));
    page.cleanup();
    onProgress?.(++done / pages.length);
  }
  await doc.destroy();
  return out;
}

/** Fix the usual OCR noise: hyphenated line breaks, stray spaces, common character swaps in headings. */
export function cleanOcr(text: string): string {
  return text
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[|]/g, 'I')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function shutdownOcr() {
  if (workerPromise) { (await workerPromise).terminate(); workerPromise = null; }
}
