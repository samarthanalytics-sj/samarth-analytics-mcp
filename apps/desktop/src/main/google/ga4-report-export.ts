// Turn the GA4 audit report Markdown into a styled HTML document, for PDF (Electron printToPDF) and
// Word (.doc — Word/Google Docs open HTML saved with the Office namespaces). PURE + unit-testable;
// the IPC does the file I/O. The Markdown subset is exactly what buildGa4AuditReport emits: # / ##
// headings, GFM tables, "- " lists, ``` code fences (the Unicode bars), and **bold** / *italic* /
// `code` inline — so a focused converter beats pulling in a Markdown dependency.

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineMd(text: string): string {
  // Escape HTML first, THEN apply inline markers (markers themselves are never escaped). Order:
  // code before bold before italic so `*` inside code/bold isn't double-processed.
  let h = esc(text);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return h;
}

const isTableSep = (line: string): boolean => {
  const s = line.trim();
  return /^[|\s:-]+$/.test(s) && s.includes('-') && s.includes('|');
};
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** GA4-report Markdown → HTML (the subset buildGa4AuditReport emits). */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${inlineMd(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const th = header.map((c) => `<th>${inlineMd(c)}</th>`).join('');
      const trs = rows.map((r) => `<tr>${header.map((_, j) => `<td>${inlineMd(r[j] ?? '')}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*-\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
  }
  return out.join('\n');
}

const REPORT_CSS = `
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 880px; margin: 28px auto; padding: 0 28px; line-height: 1.55; font-size: 14px; }
  h1 { font-size: 26px; font-weight: 700; border-bottom: 2px solid #2563eb; padding-bottom: 7px; margin-bottom: 12px; }
  h2 { font-size: 20px; font-weight: 700; margin-top: 26px; border-bottom: 1px solid #dddddd; padding-bottom: 4px; }
  h3 { font-size: 16px; font-weight: 700; margin-top: 18px; }
  h1, h2, h3 { page-break-after: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
  th, td { border: 1px solid #d0d5dd; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #eef2f8; font-weight: 700; }
  tr, li { page-break-inside: avoid; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-family: Consolas, "Courier New", monospace; font-size: 12.5px; }
  pre { background: #f6f8fa; padding: 10px; border-radius: 6px; overflow-x: auto; font-family: Consolas, "Courier New", monospace; font-size: 12.5px; line-height: 1.4; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  ul { margin: 7px 0; padding-left: 22px; }
  li { margin: 3px 0; }
  p { margin: 7px 0; }
`;

/** Wrap the report in a full styled HTML document. `execHtml` (the designed Executive Summary) is
 *  placed first, then the markdown body. `word: true` adds the MS-Office namespaces so a file saved
 *  as .doc opens as a formatted document in Word / Google Docs. */
export function reportHtmlDocument(title: string, md: string, opts: { word?: boolean; execHtml?: string } = {}): string {
  const ns = opts.word
    ? " xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'"
    : '';
  const body = `${opts.execHtml ?? ''}${markdownToHtml(md)}`;
  return `<!DOCTYPE html><html${ns}><head><meta charset="utf-8"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>${body}</body></html>`;
}

/** The i-th candidate save path: i<=0 → the chosen path unchanged; i>=1 → "name (i).ext" (the counter
 *  inserted before the extension, e.g. "report (2).pdf"). Used to fall back to a fresh filename when the
 *  chosen file is LOCKED (still open in a PDF/Word viewer) so a re-download doesn't fail with EBUSY.
 *  Pure + separator-aware (handles both \\ and /); a dot only counts as the extension when it comes
 *  after the last path separator (so "C:\\a.b\\report" isn't mis-split). */
export function dedupedReportPath(filePath: string, i: number): string {
  if (i <= 0) return filePath;
  const sep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dot = filePath.lastIndexOf('.');
  return dot > sep && dot >= 0
    ? `${filePath.slice(0, dot)} (${i})${filePath.slice(dot)}`
    : `${filePath} (${i})`;
}
