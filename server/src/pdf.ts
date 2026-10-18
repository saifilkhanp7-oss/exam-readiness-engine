// Text extraction from PDFs with pdf.js. Keeps line breaks so headings can be detected.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfText {
  pages: string[];                         // text of each page (index 0 = page 1)
  outline: { title: string; page: number; level: number }[];
}

export async function extractPdf(data: Uint8Array, onProgress?: (f: number) => void): Promise<PdfText> {
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    let lastY: number | null = null;
    for (const it of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = it.transform?.[5];
      if (lastY != null && y != null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n';
      text += it.str;
      if (it.hasEOL) text += '\n';
      lastY = y ?? lastY;
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
    page.cleanup();
    onProgress?.(i / doc.numPages);
  }

  const outline: PdfText['outline'] = [];
  try {
    const walk = async (nodes: any[] | null, level: number) => {
      for (const n of nodes ?? []) {
        let page = 0;
        try {
          const dest = typeof n.dest === 'string' ? await doc.getDestination(n.dest) : n.dest;
          if (dest?.[0]) page = (await doc.getPageIndex(dest[0])) + 1;
        } catch { /* ignore broken links */ }
        if (page) outline.push({ title: String(n.title).trim(), page, level });
        if (level < 2) await walk(n.items, level + 1);
      }
    };
    await walk(await doc.getOutline(), 1);
  } catch { /* no outline */ }

  await doc.destroy();
  return { pages, outline };
}
