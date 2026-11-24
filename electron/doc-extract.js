// Local text extraction from documents (no network): PDF, DOCX, TXT/MD/CSV/JSON/HTML.

import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_CHARS = 60000;

export async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fsp.readFile(filePath));
    const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '', lastY = null;
      const lines = [];
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
        line += item.str + (item.hasEOL ? '\n' : '');
        lastY = y;
      }
      lines.push(line);
      pages.push(lines.join('\n'));
    }
    await (task.destroy?.() ?? doc.cleanup?.());
    text = pages.join('\n\n');
  } else if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    const res = await mammoth.extractRawText({ path: filePath });
    text = res.value;
  } else if (['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.rtf'].includes(ext)) {
    text = await fsp.readFile(filePath, 'utf8');
  } else if (['.html', '.htm'].includes(ext)) {
    text = (await fsp.readFile(filePath, 'utf8')).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  } else {
    throw new Error(`Cannot extract text from ${ext || 'this'} files. Supported: PDF, DOCX, TXT, MD, CSV, HTML.`);
  }
  text = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = text.length > MAX_CHARS;
  return { text: truncated ? text.slice(0, MAX_CHARS) : text, truncated, chars: text.length };
}
