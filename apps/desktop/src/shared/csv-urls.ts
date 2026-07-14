// Extract landing-page URLs from pasted/loaded CSV (or plain) text for the tag-suggestion scanner.
// One URL per row, taking the first URL-looking cell so "url,label" rows work too; adds https:// to a
// bare domain, skips a header cell, validates via URL(), and de-duplicates. De-dup folds near-dupes
// that point at the SAME page to scan (a trailing slash, or a plain #anchor) so the scanner visits each
// page once. Pure + framework-free so it's shared by the renderer and unit-testable.

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

// The de-dup KEY for a URL: two URLs sharing this key are the same page to scan, so only the first is
// kept. We fold a trailing slash (/x/ === /x) and a plain #anchor (/x#form === /x), but KEEP apart
// anything that can serve different content: protocol, host, and query string, plus a hash-ROUTE
// fragment (#/… or #!…, where a hash-routing SPA uses the fragment as the actual page).
function dedupeKey(href: string): string {
  try {
    const u = new URL(href);
    const hashVal = u.hash.replace(/^#/, '');
    if (!hashVal || !/^[/!]/.test(hashVal)) u.hash = ''; // drop empty + plain-anchor fragments; keep #/… routes
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.href;
  } catch {
    return href;
  }
}

/** Result of parsing a CSV: the UNIQUE URLs to scan, plus how many valid URLs were found before
 *  de-dup and how many near-dupes were skipped — so the UI can show "N unique pages (M skipped)". */
export interface CsvUrlStats {
  urls: string[]; // unique, in first-seen order (as written)
  total: number; // valid URLs found before de-dup
  duplicates: number; // total - urls.length (exact + near-duplicate rows skipped)
}

export function parseCsvUrlStats(text: string): CsvUrlStats {
  const urls: string[] = [];
  const seen = new Set<string>();
  let total = 0;
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
      total += 1; // a valid URL on this row (counted before de-dup)
      const key = dedupeKey(href);
      if (!seen.has(key)) {
        seen.add(key);
        urls.push(href); // keep the URL as written (first occurrence); later near-dupes are skipped
      }
      break; // first URL on the row wins; the rest of the row is treated as a label
    }
  }
  return { urls, total, duplicates: total - urls.length };
}

export function parseCsvUrls(text: string): string[] {
  return parseCsvUrlStats(text).urls;
}

// Cap a CSV import to the scanner's per-run page cap (SCAN_URLS_CAP in main/suggestions/scan-core.ts),
// so the "Scan N pages" count the UI promises matches what the backend actually scans. Keep these two in
// sync — SCAN_URLS_CAP is the real backend cap; this mirrors it for the renderer's UI + CSV slicing.
export const CSV_URL_CAP = 250;
