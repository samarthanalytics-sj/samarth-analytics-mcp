// Tag-verification results export - a clean, client-facing NUMBERED list of the tags that FIRED, each as
// "N. <Title>" plus A. Tag Name / B. Event Name / C. Trigger Name, with its proof screenshot embedded.
// The IPC turns this HTML into a PDF (Electron printToPDF) or writes it as .doc; the XLSX export (the
// detailed spreadsheet) is built separately. No I/O, no DOM - safe in the main process and unit-testable.

import type { VerifyExportPayload, VerifyExportRow } from './ipc';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only base64 image data-URIs are embedded, so a malformed/unexpected `screenshot` value can never
// inject markup or reference a remote host.
const IMG_DATA_URI = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
const proofImg = (screenshot?: string): string =>
  screenshot && IMG_DATA_URI.test(screenshot)
    ? `<img src="${screenshot}" alt="proof" style="width:100%;max-width:540px;height:auto;max-height:440px;object-fit:contain;object-position:top;border:1px solid #d0d5dd;border-radius:6px;margin:8px 0 0;display:block" />`
    : '';

// A tag counts as "fired" (belongs in the deliverable) when it fired for real, was config-verified, or
// relayed server-side - anything that produced a fire. Issue / untested tags are left out.
const isFired = (status: string): boolean => status === 'Fired' || status === 'Config OK' || status === 'Server-side';

/** A clean, human title from a tag name: strip a leading "Vendor - Type - " (e.g. "GA4 - Event - ") and a
 *  trailing " Tag", so "GA4 - Event - The ChowNow Feed Tag" becomes "The ChowNow Feed". Exported for tests. */
export function tagTitle(tag?: string): string {
  const raw = (tag ?? '').trim();
  const clean = raw.replace(/^[^-]+ - [^-]+ - /, '').replace(/\s+Tag$/i, '').trim();
  return clean || raw;
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

/** One fired tag as a numbered entry: "N. <Title>" + A/B/C lines + its proof screenshot. */
function tagEntry(n: number, r: VerifyExportRow): string {
  const line = (letter: string, label: string, value?: string): string =>
    `<div style="margin:2px 0">${letter}. ${esc(label)} : ${value && value.trim() ? esc(value) : '<span style="color:#9ca3af">-</span>'}</div>`;
  return (
    '<div style="margin:0 0 20px;page-break-inside:avoid">' +
    `<div style="font-size:16px;font-weight:700;color:#111;margin:0 0 5px">${n}. ${esc(tagTitle(r.tag))}</div>` +
    '<div style="font-size:13px;color:#222;line-height:1.6;margin:0 0 0 16px">' +
    line('A', 'Tag Name', r.tag) +
    line('B', 'Event Name', r.triggerEvent) +
    line('C', 'Trigger Name', r.trigger) +
    '</div>' +
    proofImg(r.screenshot) +
    '</div>'
  );
}

/** The export body: a numbered list of the FIRED tags (Tag / Event / Trigger + proof screenshot), ready to
 *  hand to reportHtmlDocument() as `execHtml` for the PDF/DOC. Replaces the old status table - the
 *  client-facing "verified tags" deliverable format. */
export function verifyResultsHtml(payload: VerifyExportPayload): string {
  const host = siteLabel(payload.url);
  const fired = (payload.rows ?? []).filter((r) => isFired(r.status));
  const parts: string[] = [];

  parts.push(
    `<h1 style="font-size:22px;font-weight:700;border-bottom:2px solid #2563eb;padding-bottom:7px;margin:0 0 12px">Verified Tags${host ? ` - ${esc(host)}` : ''}</h1>`,
  );

  if (!fired.length) {
    parts.push('<div style="border:1px solid #e5e7eb;border-radius:8px;background:#f8fafc;color:#4b5563;padding:12px 14px;font-size:13px">No tags fired in this run.</div>');
  } else {
    parts.push(fired.map((r, i) => tagEntry(i + 1, r)).join('\n'));
  }

  parts.push(
    '<div style="font-size:11px;color:#9ca3af;margin-top:16px">Read-only verification - the tags were exercised as published; nothing was created, changed, or published in your container.</div>',
  );
  return parts.join('\n');
}
