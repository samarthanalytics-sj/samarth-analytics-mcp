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
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 860px; margin: 24px auto; padding: 0 24px; line-height: 1.5; font-size: 13px; }
  h1 { font-size: 22px; border-bottom: 2px solid #2563eb; padding-bottom: 6px; }
  h2 { font-size: 16px; margin-top: 22px; border-bottom: 1px solid #dddddd; padding-bottom: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
  th, td { border: 1px solid #cccccc; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f3f8; }
  code { background: #f2f2f2; padding: 1px 4px; border-radius: 3px; font-family: Consolas, "Courier New", monospace; font-size: 12px; }
  pre { background: #f6f8fa; padding: 10px; border-radius: 6px; overflow-x: auto; font-family: Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.35; }
  pre code { background: none; padding: 0; }
  ul { margin: 6px 0; padding-left: 22px; }
  p { margin: 6px 0; }
`;

/** Wrap the report Markdown in a full styled HTML document. `word: true` adds the MS-Office
 *  namespaces so a file saved as .doc opens as a formatted document in Word / Google Docs. */
export function reportHtmlDocument(title: string, md: string, opts: { word?: boolean } = {}): string {
  const ns = opts.word
    ? " xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'"
    : '';
  return `<!DOCTYPE html><html${ns}><head><meta charset="utf-8"><title>${esc(title)}</title><style>${REPORT_CSS}</style></head><body>${markdownToHtml(md)}</body></html>`;
}
