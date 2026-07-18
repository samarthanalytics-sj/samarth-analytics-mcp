// Phase 3 — AUTO-SEED: derive durable memories straight from a GTM container's configuration, so a client's
// memory starts useful with zero typing. PURE + deterministic (no LLM, no network): the facts come from the
// container snapshot itself, which is why this needs no extraction prompt and carries no injection risk.
//
// Only DURABLE facts are derived. Deliberately NOT included: tag/trigger/variable counts, paused counts, or
// anything else that churns on every edit — re-seeding would otherwise pile up a near-duplicate note each time.

import { detectTagBrand, type TagBrand } from './tag-brand';
import type { MemoryCandidate } from './memory-extract';

/** The subset of a container snapshot this engine reads (structural, so callers can pass the audit shape). */
export interface SeedTag {
  name: string;
  type: string;
  paused?: boolean;
  parameter?: Array<Record<string, unknown>>;
  consentSettings?: { consentStatus?: string; consentType?: unknown } | null;
}
export interface SeedSnapshot {
  tags: SeedTag[];
}

/** Vendor brands worth recording as "this client uses X". GA4/Google-tag are covered by the Measurement ID
 *  fact, and the generic html/img/tag brands say nothing about a vendor, so all are excluded. */
const VENDOR_LABEL: Partial<Record<TagBrand, string>> = {
  meta: 'Meta (Facebook)',
  gads: 'Google Ads',
  floodlight: 'Floodlight',
  msads: 'Microsoft Ads',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  snap: 'Snapchat',
  hotjar: 'Hotjar',
  clarity: 'Microsoft Clarity',
  amplitude: 'Amplitude',
  x: 'X (Twitter)',
};

/** GA4 ecommerce funnel events we call out when tags exist for them. */
const FUNNEL_EVENTS = [
  'view_item_list', 'view_item', 'add_to_cart', 'remove_from_cart', 'view_cart',
  'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase', 'refund',
];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Read a flat `parameter` entry's value by key. */
function param(tag: SeedTag, key: string): string {
  for (const p of tag.parameter ?? []) {
    if (p && typeof p === 'object' && str((p as Record<string, unknown>).key) === key) {
      return str((p as Record<string, unknown>).value);
    }
  }
  return '';
}

/** A concrete GA4 Measurement / Google tag id (G-…, GT-…, AW-…), ignoring {{variable}} references. */
const isConcreteId = (v: string): boolean => /^(G|GT|AW)-[A-Z0-9-]+$/i.test(v.trim());

/** Unambiguous Meta/Facebook PIXEL evidence in a tag name — matches "Meta Pixel", "Meta CAPI",
 *  "Meta - Event - X" (this app's own convention), fbevents/fbq and "Facebook …", but NOT a Custom HTML
 *  "SEO Meta Tags" injector, "Meta Description", or site-verification meta tags. */
const META_PIXEL_NAME_RE = /facebook|fb\s*pixel|fbevents|fbq\s*\(|meta\s*(pixel|capi|conversions)|meta\s*-\s*event/i;

/** Structurally read a config tag's server_container_url setting from its parameter tree (the
 *  configSettingsTable map rows: {key:'parameter', value:'server_container_url'} + a sibling
 *  {key:'parameterValue', value:<url or {{variable}}>}). present=false when the setting isn't there;
 *  url set only when the value is a concrete http(s) URL. */
function serverContainerUrl(tag: SeedTag): { present: boolean; url?: string } {
  let present = false;
  let url: string | undefined;
  const visit = (node: unknown): void => {
    if (present || node == null) return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.map)) {
      const entries = (o.map as unknown[]).filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object');
      if (entries.some((e) => str(e.key) === 'parameter' && str(e.value) === 'server_container_url')) {
        present = true;
        const v = str(entries.find((e) => str(e.key) === 'parameterValue')?.value).trim();
        if (/^https?:\/\//i.test(v)) url = v;
        return;
      }
      visit(o.map);
    }
    if (Array.isArray(o.list)) visit(o.list);
  };
  visit(tag.parameter ?? []);
  return { present, ...(url ? { url } : {}) };
}

/** Sort + de-duplicate, preserving a stable, readable order. */
const uniqSorted = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));

/**
 * Derive durable, client-scoped memory candidates from a container snapshot. Deterministic: the same
 * container always yields the same notes, so re-seeding dedupes cleanly against what's already saved.
 */
export function seedMemoriesFromContainer(snapshot: SeedSnapshot): MemoryCandidate[] {
  const tags = (snapshot?.tags ?? []).filter((t) => t && typeof t === 'object');
  const live = tags.filter((t) => !t.paused); // a paused tag is not what this client "uses"
  const out: MemoryCandidate[] = [];

  // 1. Measurement / Google tag ids actually configured (not {{variables}}).
  const ids = uniqSorted(
    live.flatMap((t) => [param(t, 'measurementId'), param(t, 'measurementIdOverride'), param(t, 'tagId')]).filter(isConcreteId),
  );
  if (ids.length) {
    out.push({ kind: 'fact', text: `Measurement/tag IDs configured in this container: ${ids.join(', ')}.` });
  }

  // 2. Vendor platforms in use (from the tag brand: type code, else vendor hints in the name).
  // 'meta' only ever comes from NAME hints (there is no Meta type code), and detectTagBrand's bare
  // \bmeta\b hint - fine for a cosmetic icon - would turn a Custom HTML "SEO Meta Tags" injector into a
  // false "client uses Facebook" fact. So for an authoritative fact, require unambiguous pixel evidence.
  const vendors = uniqSorted(
    live.map((t) => {
      const brand = detectTagBrand(t.type, t.name);
      if (brand === 'meta' && !META_PIXEL_NAME_RE.test(t.name)) return '';
      return VENDOR_LABEL[brand] ?? '';
    }).filter(Boolean),
  );
  if (vendors.length) {
    out.push({ kind: 'fact', text: `Marketing/analytics platforms set up in this container: ${vendors.join(', ')}.` });
  }

  // 3. Web-to-server (sGTM) relay: the Google/GA4 CONFIG tag carrying a server_container_url setting.
  // Structural read (not a regex over the JSON blob), gated to config tag types - so a Custom HTML tag
  // that merely mentions the string, or an unrelated URL nearby, can never seed a wrong endpoint.
  for (const t of live) {
    if (t.type !== 'googtag' && t.type !== 'gaawc') continue;
    const r = serverContainerUrl(t);
    if (!r.present) continue;
    out.push({
      kind: 'fact',
      text: r.url
        ? `Web-to-server (sGTM) relay is configured: ${r.url}`
        : 'Web-to-server (sGTM) relay is configured (server_container_url is set via a variable).',
    });
    break; // one note is enough
  }

  // 4. Consent Mode: only tags whose consent status is actually "needed" are consent-GATED. The live API
  // returns the default "notSet" (ungated) on unconfigured tags and "notNeeded" means declared-no-consent
  // - counting those would claim gating on containers that have none. Case-insensitive for the export-JSON
  // UPPER_SNAKE vs API camelCase split.
  const consented = live.filter((t) => str(t.consentSettings?.consentStatus).trim().toLowerCase() === 'needed').length;
  if (consented > 0) out.push({ kind: 'fact', text: 'Consent Mode is in use: some tags declare consent settings (consent-gated).' });

  // 5. Ecommerce funnel coverage, from GA4 event tags' configured event names.
  const events = uniqSorted(live.filter((t) => t.type === 'gaawe').map((t) => param(t, 'eventName').trim().toLowerCase()));
  const funnel = FUNNEL_EVENTS.filter((e) => events.includes(e));
  if (funnel.length) {
    out.push({ kind: 'fact', text: `Ecommerce events tracked in this container: ${funnel.join(', ')}.` });
  }

  // 6. Naming convention, when it is clearly established (>= 3 GA4 event tags follow the FULL shape the
  // note asserts — prefix AND the trailing "Tag", so the preference never over-claims).
  const ga4Event = live.filter((t) => t.type === 'gaawe');
  const conventional = ga4Event.filter((t) => /^ga4\s*-\s*event\s*-\s*.+\btag\s*$/i.test(t.name.trim())).length;
  if (ga4Event.length >= 3 && conventional >= 3 && conventional >= Math.ceil(ga4Event.length * 0.6)) {
    out.push({ kind: 'preference', text: 'This container names GA4 event tags "GA4 - Event - <Name> Tag" — follow that convention for new tags.' });
  }

  return out;
}

/** Stable lead-ins of the LIST-VALUED seed facts (their tails change as the container evolves). Used to
 *  supersede a stale earlier seed instead of piling a near-duplicate next to it on re-seed. */
export const SEED_FACT_PREFIXES = [
  'Measurement/tag IDs configured',
  'Marketing/analytics platforms set up',
  'Web-to-server (sGTM) relay is configured',
  'Ecommerce events tracked',
] as const;

/** A seed proposal, optionally superseding an existing (stale) auto-seeded memory: approving it should
 *  REPLACE that memory rather than sit beside it. */
export interface SeedCandidate extends MemoryCandidate {
  supersedesId?: string;
}

/** Attach supersession ids: a candidate that shares a known list-fact prefix with an existing memory whose
 *  text DIFFERS is an update of it (the container changed since the last seed). `existing` should be the
 *  AUTO-seeded memories applicable to this container. PURE. */
export function attachSupersessions(cands: MemoryCandidate[], existing: Array<{ id: string; text: string }>): SeedCandidate[] {
  return cands.map((c) => {
    const prefix = SEED_FACT_PREFIXES.find((p) => c.text.startsWith(p));
    if (!prefix) return c;
    const prior = existing.find((m) => m.text.startsWith(prefix) && m.text !== c.text);
    return prior ? { ...c, supersedesId: prior.id } : c;
  });
}
