// Tag-verification results export — pure builders for the downloadable report (CSV + a styled HTML body
// that the IPC turns into a PDF via Electron printToPDF, or writes as .doc with the MS-Office namespaces).
// Mirrors the on-screen results table: the scorecard counts, the coverage line, and one row per verdict
// (Status · Tag · GA4 event name · Trigger event · Fired via · Signal · Proof). The PDF/DOC embed each
// tag's proof SCREENSHOT as an <img> (data-URI); the CSV is text-only (it lists whether proof exists).
// No I/O, no DOM — safe to run in the main process and unit-testable.

import type { VerifyExportPayload, VerifyExportRow } from './ipc';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// One CSV field: wrap in quotes and double any embedded quote, per RFC 4180. Newlines/commas are then
// safe inside the quotes. null/undefined → empty. Non-strings are stringified.
const csvField = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;

const COLUMNS = ['Status', 'Tag', 'GA4 event name', 'Event', 'Fired via', 'Signal', 'Proof'] as const;

/** The results as a CSV spreadsheet (one row per verdict). A CSV/Excel file cannot embed an image, so the
 *  Proof column notes that a screenshot exists and where to see it — the PDF and DOC exports embed the
 *  actual image. The event name is the tag's configured GA4 event (e.g. "phone_click"). */
export function verifyResultsCsv(payload: VerifyExportPayload): string {
  const rows = payload.rows ?? [];
  const lines = [COLUMNS.map(csvField).join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.status ?? '',
        r.tag ?? '',
        r.eventName ?? '',
        r.triggerEvent ?? '',
        r.firedVia ?? '',
        r.signal ?? '',
        r.screenshot ? 'captured (image in PDF/DOC export)' : '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

// Print-safe (light) palette per status label — pill fg/bg + a left accent for the row. Keyed by the
// human status string the renderer sends (matches the on-screen V_STATUS labels).
const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
  Fired: { fg: '#047857', bg: '#d1fae5' },
  'Config OK': { fg: '#a16207', bg: '#fef3c7' },
  'Server-side': { fg: '#1d4ed8', bg: '#dbeafe' },
  Untested: { fg: '#4b5563', bg: '#f3f4f6' },
  Issue: { fg: '#b91c1c', bg: '#fee2e2' },
};
const statusStyle = (s: string): { fg: string; bg: string } => STATUS_STYLE[s] ?? STATUS_STYLE.Untested;

// A safe, embeddable proof image, or ''. Only base64 image data-URIs are allowed into the document, so a
// malformed/unexpected `screenshot` value can never inject markup or reference a remote host.
const IMG_DATA_URI = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const proofImg = (screenshot?: string): string =>
  screenshot && IMG_DATA_URI.test(screenshot)
    ? `<img src="${screenshot}" alt="proof" style="width:132px;height:auto;max-height:96px;object-fit:cover;object-position:top;border:1px solid #d0d5dd;border-radius:4px;display:block" />`
    : '<span style="color:#9ca3af">—</span>';

function statusPill(status: string): string {
  const s = statusStyle(status);
  return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;background:${s.bg};color:${s.fg};white-space:nowrap">${esc(status)}</span>`;
}

function resultRow(r: VerifyExportRow): string {
  const cell = (html: string): string => `<td>${html}</td>`;
  const text = (v?: string): string => (v && v.trim() ? esc(v) : '<span style="color:#9ca3af">—</span>');
  const code = (v?: string): string => (v && v.trim() ? `<code>${esc(v)}</code>` : '<span style="color:#9ca3af">—</span>');
  return (
    '<tr>' +
    cell(statusPill(r.status)) +
    cell(`<span style="font-weight:600;color:#1a1a1a">${text(r.tag)}</span>`) +
    cell(code(r.eventName)) +
    cell(code(r.triggerEvent)) +
    cell(`<span style="white-space:nowrap">${text(r.firedVia)}</span>`) +
    cell(`<span style="color:#4b5563;font-size:12px">${text(r.signal)}</span>`) +
    cell(proofImg(r.screenshot)) +
    '</tr>'
  );
}

/** The scorecard: one big-number card per meaningful outcome. Always shows Fired + Issues; Config OK,
 *  Server-side and Untested only when non-zero — exactly like the on-screen scorecard. */
function scorecard(counts: VerifyExportPayload['counts']): string {
  const cards: Array<{ label: string; n: number; fg: string; bg: string }> = [
    { label: 'Fired', n: counts.fired, ...statusStyle('Fired') },
    ...(counts.config ? [{ label: 'Config OK', n: counts.config, ...statusStyle('Config OK') }] : []),
    ...(counts.server ? [{ label: 'Server-side', n: counts.server, ...statusStyle('Server-side') }] : []),
    { label: 'Issues', n: counts.issues, ...statusStyle(counts.issues ? 'Issue' : 'Fired') },
    ...(counts.untested ? [{ label: 'Untested', n: counts.untested, ...statusStyle('Untested') }] : []),
  ];
  const card = (c: { label: string; n: number; fg: string; bg: string }): string =>
    `<div style="flex:1;min-width:110px;border:1px solid ${c.fg}22;border-radius:10px;background:${c.bg};padding:12px 14px">` +
    `<div style="font-size:26px;font-weight:800;color:${c.fg};line-height:1">${c.n}</div>` +
    `<div style="font-size:12px;color:#374151;margin-top:3px">${esc(c.label)}</div></div>`;
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px">${cards.map(card).join('')}</div>`;
}

/** Host of a URL for the report heading/filename, or '' if it can't be parsed. */
export function siteLabel(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The full styled report body (heading + scope + scorecard + results table), ready to hand to
 *  reportHtmlDocument() as `execHtml` for the PDF/DOC. Mirrors the on-screen Tag-verification results. */
export function verifyResultsHtml(payload: VerifyExportPayload): string {
  const rows = payload.rows ?? [];
  const host = siteLabel(payload.url);
  const parts: string[] = [];

  parts.push(
    `<h1 style="font-size:24px;font-weight:700;border-bottom:2px solid #2563eb;padding-bottom:7px;margin:0 0 6px">Tag Verification Report${host ? ` — ${esc(host)}` : ''}</h1>`,
  );

  const scope: string[] = [];
  if (payload.url) scope.push(`<b>Site:</b> ${esc(payload.url)}`);
  if (payload.authoritative) scope.push('Authoritative — read from GTM’s own Tag Assistant debug stream');
  if (scope.length) parts.push(`<div style="font-size:12.5px;color:#4b5563;margin:0 0 12px">${scope.join(' &nbsp;·&nbsp; ')}</div>`);

  parts.push(scorecard(payload.counts));

  if (payload.pagesDriven) {
    const crawl =
      payload.pagesCrawled
        ? ` (scanned ${payload.pagesCrawled}${payload.pagesTotal && payload.pagesTotal > payload.pagesCrawled ? ` of ${payload.pagesTotal}` : ''} site page${payload.pagesCrawled === 1 ? '' : 's'} to locate each CTA)`
        : '';
    parts.push(
      `<div style="font-size:12px;color:#6b7280;margin:0 0 10px">Drove across ${payload.pagesDriven} page${payload.pagesDriven === 1 ? '' : 's'}${crawl} — each click tag is driven on the page its CTA actually lives on.</div>`,
    );
  }

  if (!rows.length) {
    parts.push('<div style="border:1px solid #e5e7eb;border-radius:8px;background:#f8fafc;color:#4b5563;padding:12px 14px;font-size:13px">No tags were verified in this run.</div>');
  } else {
    const head = COLUMNS.map((c) => `<th>${esc(c)}</th>`).join('');
    parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.map(resultRow).join('')}</tbody></table>`);
  }

  parts.push(
    `<div style="font-size:11px;color:#9ca3af;margin-top:16px">Read-only verification — the tags were exercised as published; nothing was created, changed or published in your container.</div>`,
  );
  return parts.join('\n');
}
