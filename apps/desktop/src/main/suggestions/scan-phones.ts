// Scan one or more live pages for PHONE NUMBERS and return the unique lines, merged across pages.
//
// Two independent detectors, because a page carries phone numbers two different ways and only one of
// them is trackable by a click:
//   1. tel: links   - a real anchor, so a GTM Click trigger can be scoped to it exactly.
//   2. visible text - printed in a footer or a "call us" block with no href at all, so there is no
//                     click event to fire on. Detected anyway, and reported honestly as such, because
//                     the user needs to see the number exists before deciding what to do about it.
//
// This module owns ONLY the I/O (drive the browser, read the DOM output). Every decision about what
// counts as a phone number, how two writings of one line are recognised as the same, and what to name
// its resources, lives in the pure shared/phone-numbers module.

import { makeDriver } from './scan-url';
import { urlAllowed } from '../../../../web-audit-mcp/src/utils/urlGuard.js';
import { phoneFromTelHref, extractPhonesFromText, mergePhoneSightings, type RawPhoneSighting, type UniquePhone } from '../../shared/phone-numbers';
import type { TagScanOptions } from '../../shared/ipc';

export interface PhoneScanResult {
  /** The pages actually read (a page that failed to load is reported, not silently skipped). */
  pagesScanned: string[];
  failedPages: Array<{ url: string; error: string }>;
  phones: UniquePhone[];
  /** True when at least one page yielded no visible-text sample, so text-only numbers on it could
   *  not be seen. Surfaced so "no numbers found" is never mistaken for "the page has none". */
  textUnavailable: boolean;
}

/** Read one already-opened page's DOM output into raw sightings. Pure given the driver output. */
export function sightingsFromPage(
  page: { raw?: { elements: Array<{ href?: string; text?: string; region?: string }>; textSample?: string } },
  pageUrl: string
): { sightings: RawPhoneSighting[]; hadText: boolean } {
  const sightings: RawPhoneSighting[] = [];
  for (const el of page.raw?.elements ?? []) {
    const dialable = phoneFromTelHref(el.href ?? '');
    if (!dialable) continue;
    sightings.push({
      raw: el.href ?? '',
      source: 'tel_link',
      page: pageUrl,
      ...(el.text ? { label: el.text } : {}),
      ...(el.region ? { region: el.region } : {}),
    });
  }
  const text = page.raw?.textSample ?? '';
  for (const candidate of extractPhonesFromText(text)) {
    sightings.push({ raw: candidate, source: 'text', page: pageUrl });
  }
  return { sightings, hadText: Boolean(text) };
}

/**
 * Scan the given URLs for phone numbers. SSRF-guarded per URL before any browser is launched, and
 * one page failing never stops the rest: it is reported in failedPages so the result can never look
 * complete when it is not.
 */
export async function scanUrlsForPhones(urls: readonly string[], opts: TagScanOptions = {}): Promise<PhoneScanResult> {
  const targets = [...new Set(urls.map((u) => String(u ?? '').trim()).filter(Boolean))];
  if (!targets.length) throw new Error('No URL to scan.');
  // A rejected URL is REPORTED, not thrown: one bad entry in a list must not lose the numbers found
  // on the good ones, and the caller needs to tell the user which url was refused and why.
  const allowed: string[] = [];
  const refused: Array<{ url: string; error: string }> = [];
  for (const t of targets) {
    const verdict = urlAllowed(t, []);
    if (verdict.ok) allowed.push(t);
    else refused.push({ url: t, error: `Cannot scan this URL: ${verdict.reason}` });
  }
  if (!allowed.length) {
    return { pagesScanned: [], failedPages: refused, phones: [], textUnavailable: false };
  }

  const driver = await makeDriver(opts);
  const sightings: RawPhoneSighting[] = [];
  const pagesScanned: string[] = [];
  const failedPages: Array<{ url: string; error: string }> = [...refused];
  let textUnavailable = false;
  try {
    for (const url of allowed) {
      let page;
      try {
        page = await driver.open(url);
      } catch (e) {
        failedPages.push({ url, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
        continue;
      }
      if (!page.ok || !page.raw) {
        failedPages.push({ url, error: page.error ?? `HTTP ${page.httpStatus ?? 'error'}` });
        continue;
      }
      const finalUrl = page.finalUrl || url;
      const { sightings: found, hadText } = sightingsFromPage(page, finalUrl);
      if (!hadText) textUnavailable = true;
      sightings.push(...found);
      pagesScanned.push(finalUrl);
    }
  } finally {
    await driver.close().catch(() => undefined);
  }

  return { pagesScanned, failedPages, phones: mergePhoneSightings(sightings), textUnavailable };
}
