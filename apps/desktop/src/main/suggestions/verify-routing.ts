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
function matches(hay: string, val: string | undefined, op: string | undefined, defaultOp: 'equals' | 'contains'): boolean {
  if (!val) return false;
  const h = (hay || '').trim();
  const hl = h.toLowerCase();
  const vl = val.toLowerCase();
  const effectiveOp = op ?? defaultOp;
  switch (effectiveOp) {
    case 'contains': return hl.indexOf(vl) >= 0;
    case 'startsWith': return hl.indexOf(vl) === 0;
    case 'endsWith': return vl.length > 0 && hl.lastIndexOf(vl) === hl.length - vl.length;
    case 'matchRegex':
      try { return new RegExp(val, 'i').test(h); } catch { return false; }
    default: return hl === vl; // equals
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
