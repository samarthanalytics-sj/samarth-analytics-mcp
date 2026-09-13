// PURE bridge (no browser): raw forms extracted from a page → per-form FILL PLANS for the
// real-submit review UI. Reuses the shared field classifier + locale profiles (form-fill.ts) and the
// form purpose classifier (forms.ts). Fills/submits NOTHING — it only proposes editable values.

import type { RawForm, RawFormField } from '../../../../web-audit-mcp/src/agent/forms.js';
import { analyzeForms } from '../../../../web-audit-mcp/src/agent/forms.js';
import { buildFillPlan, localeById, LOCALES } from '../../../../web-audit-mcp/src/agent/form-fill.js';
import { isKnownAdPlatform } from '../../shared/runtime-capture';
import { expectedBeaconPlatform } from './verify-tags';
import type { FormFillView } from '../../shared/ipc';

/** A field worth showing/filling: it has a name or id to target and isn't a control/hidden field. */
function fillable(f: RawFormField): boolean {
  return Boolean(f.name || f.id) && !['hidden', 'submit', 'button', 'image', 'reset'].includes(f.type);
}

/** The supported locations for the picker (US now; UK/AUS/etc. registered in LOCALES later). */
export function localeOptions(): Array<{ id: string; label: string }> {
  return Object.values(LOCALES).map((l) => ({ id: l.id, label: l.label }));
}

function isGa4Platform(platform: string): boolean {
  return platform === 'ga4_event' || platform === 'google_tag';
}

/** Pair what a REAL submit fired to the container's ACTUAL tags, so the operator sees WHICH tags fired,
 *  AND which pixel tags are fed server-side. GA4/base tags match by EVENT NAME (the /collect `en=`);
 *  pixel/ad tags (Meta/LinkedIn/…) fire a BEACON not a GA4 event, so they match by the observed
 *  beacon's vendor. A pixel tag that sent NO vendor beacon while the form DID relay to a first-party
 *  server container (a 'server' beacon = /g/collect on the site's own host) is fed SERVER-SIDE via the
 *  Conversion API — the browser never calls the vendor, so a missing browser beacon is expected, NOT a
 *  failure (same rule as the synthetic verify path). PURE. */
export function classifyFiredContainerTags(
  events: string[],
  beaconPlatforms: string[],
  tags: Array<{ tagName: string; eventName: string; platform: string }>,
): { firedTags: Array<{ tagName: string; eventName: string }>; serverRelayTags: string[] } {
  const evSeen = new Set(events.map((e) => (e ?? '').trim().toLowerCase()).filter(Boolean));
  const platsSeen = new Set(beaconPlatforms.filter(Boolean));
  const sawServerRelay = platsSeen.has('server');
  const firedTags: Array<{ tagName: string; eventName: string }> = [];
  const serverRelayTags: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (seen.has(t.tagName)) continue;
    if (isGa4Platform(t.platform)) {
      const en = (t.eventName ?? '').trim().toLowerCase();
      if (en && evSeen.has(en)) { firedTags.push({ tagName: t.tagName, eventName: t.eventName }); seen.add(t.tagName); }
    } else {
      // Pixel/ad tag → fired if its OWN vendor's beacon was seen. 'ad' (undecodable) counts any pixel.
      const want = expectedBeaconPlatform(t.platform);
      const fired = want === 'ad' ? [...platsSeen].some((p) => isKnownAdPlatform(p)) : platsSeen.has(want);
      if (fired) { firedTags.push({ tagName: t.tagName, eventName: t.eventName }); seen.add(t.tagName); }
      else if (sawServerRelay) { serverRelayTags.push(t.tagName); seen.add(t.tagName); }
    }
  }
  return { firedTags, serverRelayTags };
}

/** Back-compat: just the fired tags (GA4 by event name, pixel by vendor beacon). PURE. */
export function matchFiredContainerTags(
  events: string[],
  beaconPlatforms: string[],
  tags: Array<{ tagName: string; eventName: string; platform: string }>,
): Array<{ tagName: string; eventName: string }> {
  return classifyFiredContainerTags(events, beaconPlatforms, tags).firedTags;
}

/** Convert raw forms (from driver.open) into per-form fill plans. `emailTag` makes the test email
 *  traceable + unique per run. PURE (deterministic given its inputs). */
export function toFormFillViews(
  rawForms: RawForm[],
  pageUrl: string,
  localeId: string | undefined,
  emailTag: string,
): FormFillView[] {
  const locale = localeById(localeId);
  const purposeByIndex = new Map(analyzeForms(rawForms, pageUrl).map((a) => [a.index, a.purpose]));
  return rawForms
    .filter((f) => (f.fields ?? []).some(fillable))
    .map((f) => ({
      index: f.index,
      title: (f.title || f.formName || f.formId || `Form ${f.index + 1}`).slice(0, 80),
      formId: f.formId,
      formClasses: f.formClasses,
      action: f.action,
      method: f.method,
      purpose: purposeByIndex.get(f.index) ?? 'other',
      hidden: f.hidden === true,
      fields: buildFillPlan(f.fields.filter(fillable), locale, { emailTag }),
    }));
}
