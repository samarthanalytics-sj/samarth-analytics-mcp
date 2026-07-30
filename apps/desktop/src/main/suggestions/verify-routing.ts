// PURE page-routing for "Verify tag firing" (no browser, unit-testable).
//
// A GTM Click Text / Click URL trigger is SITE-WIDE: GTM has no notion of "this CTA is on the
// careers page". So when we verify a container's existing tags, every click tag arrives with no
// concrete page and the driver would drive them all on the homepage — falsely reporting "no element
// matched" for any CTA that actually lives on /careers, /blog, a service page, etc.
//
// Given the crawled element inventory (each element carries the page it was found on), route each
// click/link tag to the page where its trigger's control ACTUALLY exists, so the multi-page driver
// drives it there. Tags whose control is on no crawled page are left untouched → the engine reports
// them "couldn't auto-test here" (inconclusive), never "not firing".

import type { VerifyTagInput, DetectedElementView } from '../../shared/ipc';

function isClickTrigger(kind: string): boolean {
  return kind === 'link_click' || kind === 'all_clicks';
}

// EXACT mirror of the in-page driver's `matches` (verify-driver.ts driveInPage): trims the haystack,
// lower-cases both, default operator = equals for text / contains for URL. Kept identical so routing
// predicts what the driver will actually find + click — if these diverged, a tag could be routed to a
// page the driver then can't drive on.
// Normalize a label identically to the in-page driver (verify-driver.ts normLabel): nbsp → space, arrow/
// chevron glyphs → space, collapse whitespace, case-fold. Kept in lock-step so routing predicts what the
// driver will actually match on a decorated CTA ("Read full analysis →").
function normLabel(s: string): string {
  return (s || '')
    .replace(/[   ]/g, ' ')
    .replace(/[←-⇿➔➙➜➡⟶⮕▶▸❯»›→‹«]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function matches(hay: string, val: string | undefined, op: string | undefined, defaultOp: 'equals' | 'contains'): boolean {
  if (!val) return false;
  const h = normLabel(hay);
  const vl = normLabel(val);
  const effectiveOp = op ?? defaultOp;
  switch (effectiveOp) {
    case 'contains': return h.indexOf(vl) >= 0;
    case 'startsWith': return h.indexOf(vl) === 0;
    case 'endsWith': return vl.length > 0 && h.length >= vl.length && h.lastIndexOf(vl) === h.length - vl.length;
    case 'matchRegex':
      try { return new RegExp(val, 'i').test((hay || '').trim()); } catch { return false; }
    // equals, with a contains fallback — mirrors the driver's equals-then-contains, so a tag is routed to a
    // page whose decorated/extra-word CTA the driver will then locate.
    default: return h === vl || h.indexOf(vl) >= 0;
  }
}

// The inventory stores the RESOLVED ABSOLUTE href (HTMLAnchorElement.href → "https://site.com/careers"),
// but the in-page driver matches the RAW attribute (getAttribute('href') → "/careers" for internal
// links). So a `{{Click URL}} equals "/careers"` trigger matches the driver's raw path but not the
// inventory's absolute URL. Try BOTH the absolute form and its derived path+query+hash, so a click-URL
// tag routes whether the trigger was written as a full URL or a site-relative path.
function hrefCandidates(href: string | undefined): string[] {
  const abs = (href ?? '').trim();
  if (!abs) return [''];
  const out = [abs];
  try {
    const u = new URL(abs);
    const rel = `${u.pathname}${u.search}${u.hash}`;
    if (rel && rel !== abs) out.push(rel);
  } catch {
    /* not an absolute URL (mailto:/tel:/relative) — the single candidate is enough */
  }
  return out;
}

/** Does this crawled element satisfy the tag's click/link trigger? When both text and URL are set,
 *  BOTH must match (same AND the in-page driver applies). */
export function elementMatchesTrigger(trigger: VerifyTagInput['trigger'], el: DetectedElementView): boolean {
  if (!isClickTrigger(trigger.kind)) return false;
  const hasText = Boolean(trigger.clickTextValue);
  const hasUrl = Boolean(trigger.clickUrlValue);
  if (!hasText && !hasUrl) return false;
  if (hasText && !matches(el.text ?? '', trigger.clickTextValue, trigger.clickTextOperator, 'equals')) return false;
  if (hasUrl && !hrefCandidates(el.href).some((h) => matches(h, trigger.clickUrlValue, trigger.clickUrlOperator, 'contains'))) return false;
  return true;
}

/**
 * Normalize a user-pasted "pages to verify" list into same-origin absolute URLs. Each entry is resolved
 * against `target` (so a bare "/contact" becomes absolute), dropped if it can't parse or is off-origin
 * (never drive another site), and de-duplicated preserving order. PURE.
 */
export function normalizeVerifyPages(raw: unknown, target: string): string[] {
  const list = Array.isArray(raw) ? raw : [];
  let origin = '';
  try { origin = new URL(target).origin; } catch { return []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    const s = String(r ?? '').trim();
    if (!s) continue;
    let abs: string;
    try { abs = new URL(s, target).href; } catch { continue; }
    try { if (new URL(abs).origin !== origin) continue; } catch { continue; }
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

/** A page the driver would drive anyway (homepage / site-wide) — path is "/" or empty. */
export function isHomePage(page: string | undefined, baseUrl?: string): boolean {
  if (!page || page === 'site-wide' || page === '/') return true;
  try {
    const u = new URL(page, baseUrl ?? 'http://localhost');
    return u.pathname === '/' || u.pathname === '';
  } catch {
    return false;
  }
}

/**
 * Route each click/link tag to the page where its control exists. Only click/link tags with no
 * concrete page yet are re-pointed; pageview / custom_event / form tags and tags already scoped to a
 * concrete page (a Page Path condition) are left as-is. When a control appears on the homepage
 * (nav/footer) we keep the homepage — minimal navigation — otherwise we point at the first other
 * page it appears on. PURE.
 */
export function routeTagsToPages<T extends VerifyTagInput>(tags: T[], elements: DetectedElementView[], baseUrl?: string): T[] {
  if (elements.length === 0) return tags;
  return tags.map((t) => {
    if (!isClickTrigger(t.trigger.kind)) return t;
    // Respect a trigger already scoped to a concrete (off-homepage) page.
    if (!isHomePage(t.page, baseUrl)) return t;
    const matching = elements.filter((e) => elementMatchesTrigger(t.trigger, e));
    if (matching.length === 0) return t; // control on no crawled page → engine → inconclusive
    if (matching.some((e) => isHomePage(e.page, baseUrl))) return t; // on the homepage → keep it
    const page = matching[0].page;
    return page ? { ...t, page } : t;
  });
}

/**
 * Classify a click/link tag's control as GLOBAL (site chrome), so the caller can drive it ONCE instead
 * of on every chosen page. Global = the matched control sits in the header / nav / footer on ANY page,
 * OR the same href (else the same text) appears on >= minRepeatPages distinct crawled pages - a repeated
 * site-wide control (the email / phone / WhatsApp / social buttons in the header/footer). Needs the crawl
 * inventory; with no inventory it returns false (nothing is deduped → the safe fallback). PURE.
 */
export function isGlobalClickTag(
  trigger: VerifyTagInput['trigger'],
  elements: DetectedElementView[],
  opts: { minRepeatPages?: number } = {},
): boolean {
  if (!isClickTrigger(trigger.kind) || elements.length === 0) return false;
  const matching = elements.filter((e) => elementMatchesTrigger(trigger, e));
  if (matching.length === 0) return false;
  // In the site chrome (header / nav / footer) on ANY page → the control repeats on every page.
  if (matching.some((e) => e.region === 'header' || e.region === 'nav' || e.region === 'footer')) return true;
  // The same href (else the same visible text) appears on >= minRepeatPages distinct pages → repeated.
  const minPages = Math.max(2, opts.minRepeatPages ?? 2);
  const pagesByKey = new Map<string, Set<string>>();
  for (const e of matching) {
    const key = normLabel(e.href ?? '') || normLabel(e.text ?? '');
    if (!key || !e.page) continue;
    const set = pagesByKey.get(key) ?? new Set<string>();
    set.add(e.page);
    pagesByKey.set(key, set);
  }
  for (const pages of pagesByKey.values()) if (pages.size >= minPages) return true;
  return false;
}

/**
 * Expand each tag across the chosen verify pages (explicit-pages mode). A GLOBAL click tag (its control
 * repeats site-wide) is emitted ONCE on the first page - driving it on every page just re-fires the same
 * tag (the header/footer CTA that showed up firing 50x/80x). Every OTHER tag is emitted on EACH page, so
 * a page-specific CTA (or a form on a page the crawl missed) is still exercised. PURE.
 */
export function expandTagsOverPages<T extends { id: string; tagName: string; trigger: VerifyTagInput['trigger'] }>(
  tags: T[],
  pages: string[],
  elements: DetectedElementView[],
): Array<{ id: string; name: string; page: string; trigger: VerifyTagInput['trigger'] }> {
  if (pages.length === 0) return [];
  return tags.flatMap((t) => {
    const targets = isGlobalClickTag(t.trigger, elements) ? [pages[0]] : pages;
    return targets.map((page) => ({ id: t.id, name: t.tagName, page, trigger: t.trigger }));
  });
}
