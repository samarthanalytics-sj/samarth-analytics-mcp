// Extract landing-page URLs from pasted/loaded CSV (or plain) text for the tag-suggestion scanner.
// One URL per row, taking the first URL-looking cell so "url,label" rows work too; adds https:// to a
// bare domain, skips a header cell, validates via URL(), and de-duplicates. Pure + framework-free so
// it's shared by the renderer and unit-testable.

// Don't promote a bare filename (report.csv, index.html, photo.png) to https://report.csv.
const FILE_EXT = /\.(csv|tsv|txt|json|xml|xlsx?|html?|pdf|png|jpe?g|gif|svg|webp|zip|gz|tgz|tar|docx?|pptx?|md)$/i;

// Normalise a single cell to an http(s) URL, or null if it isn't one.
function normCell(raw: string): string | null {
  let t = raw.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!t) return null;
  if (/^(urls?|pages?|landing\s*pages?|address(?:es)?|links?)$/i.test(t)) return null; // header cell
  if (!/^https?:\/\//i.test(t)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?#]|$)/i.test(t) && !FILE_EXT.test(t)) t = 'https://' + t;
    else return null;
  }
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export function parseCsvUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cells = line.split(',');
    for (let i = 0; i < cells.length; i++) {
      let href = normCell(cells[i]);
      if (!href) continue; // not a URL — try the next cell (handles "label,url" rows)
      // A URL with a query string can legitimately contain commas (?ids=1,2,3) that the comma-split
      // broke up. Greedily re-join following cells while they look like query continuations (no
      // whitespace, i.e. not a "url, label" label) and still parse as the same URL extended.
      if (href.includes('?')) {
        let combined = cells[i];
        for (let j = i + 1; j < cells.length && cells[j] !== '' && !/\s/.test(cells[j]); j++) {
          const merged = normCell(`${combined},${cells[j]}`);
          if (!merged) break;
          combined = `${combined},${cells[j]}`;
          href = merged;
        }
      }
      if (!seen.has(href)) {
        seen.add(href);
        out.push(href);
      }
      break; // first URL on the row wins; the rest of the row is treated as a label
    }
  }
  return out;
}

// Cap a CSV import to the scanner's per-run page cap (SCAN_URLS_CAP in main/suggestions/scan-core.ts),
// so the "Scan N pages" count the UI promises matches what the backend actually scans.
export const CSV_URL_CAP = 60;
