/**
 * Tag-presence reconciliation: compare what a GTM container is CONFIGURED to
 * send against what actually FIRED on the live site, across the captured pages
 * and consent scenarios. Answers the questions a config-only audit can't:
 *
 *   - configured-but-never-fired — a vendor is set up in GTM but no matching
 *     network hit was observed (tag paused, container not published, trigger
 *     never met, or blocked).
 *   - fired-but-not-configured — a vendor hit fired on the site but no tag in
 *     this container targets it (hardcoded snippet, another container/workspace).
 *   - GA4 id mismatch — GA4 fired with a measurement id this container doesn't
 *     configure.
 *
 * Pure + framework-free (no Playwright, no I/O) so it runs in the browser-free
 * test suite. The browser-bound capture supplies the ScenarioCapture[]; the GTM
 * container is the parsed export_container(format:"full") JSON.
 */

import type { CapturedHit } from './browser.js';
import type { ScenarioCapture } from './capture.js';

export type Vendor = 'ga4' | 'google_ads' | 'meta' | 'floodlight' | 'tiktok' | 'linkedin';

const VENDOR_LABEL: Record<Vendor, string> = {
  ga4: 'GA4',
  google_ads: 'Google Ads',
  meta: 'Meta Pixel',
  floodlight: 'Floodlight',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn Insight',
};

export interface Destination {
  vendor: Vendor;
  /** Specific id when extractable (GA4 G-…, Ads AW-…, Meta pixel digits); else undefined. */
  id?: string;
  /** Provenance: configuring tag name, or the observed hit url. */
  source: string;
}

export interface VendorReconcile {
  vendor: Vendor;
  configured: boolean;
  fired: boolean;
  configuredIds: string[];
  observedIds: string[];
}

export interface ReconcileFinding {
  id: string;
  severity: 'info' | 'low' | 'medium' | 'high';
  confidence: 'high' | 'medium' | 'low';
  finding: string;
  whyItMatters: string;
  suggestedFix: string;
  evidence?: string[];
}

export interface ReconcileResult {
  byVendor: VendorReconcile[];
  findings: ReconcileFinding[];
}

const GA4_ID = /\bG-[A-Z0-9]{4,}\b/i;
const AW_ID = /\bAW-[0-9]+\b/i;

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/* ───────────── Configured side (GTM container) ───────────── */

interface RawParam {
  key?: string;
  value?: string;
  list?: RawParam[];
  map?: RawParam[];
}
interface RawTag {
  name?: string;
  type?: string;
  paused?: boolean;
  parameter?: RawParam[];
}

// Tolerant: locate the tags array wherever the export nests it; never throws.
function tagsOf(raw: unknown): RawTag[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const container =
    obj.container && typeof obj.container === 'object' ? (obj.container as Record<string, unknown>) : obj;
  const tags = container.tags ?? obj.tags;
  return Array.isArray(tags) ? (tags.filter((t) => t && typeof t === 'object') as RawTag[]) : [];
}

function paramValue(tag: RawTag, key: string): string | undefined {
  const p = (tag.parameter ?? []).find((x) => x.key === key && typeof x.value === 'string');
  return p?.value;
}

function matchId(value: string | undefined, re: RegExp): string | undefined {
  const m = value?.match(re);
  return m ? m[0].toUpperCase() : undefined;
}

// Normalise a configured Google Ads conversionId to just AW-<digits> (GTM often
// stores "AW-123/AbCd" — id + label), so it matches the label-less observed id.
function normalizeAdsId(cid: string | undefined): string | undefined {
  if (!cid) return undefined;
  const m = cid.match(AW_ID);
  if (m) return m[0].toUpperCase();
  return /^\d+$/.test(cid) ? `AW-${cid}` : undefined;
}

// GA4 id from a Custom HTML body — ONLY in a real gtag config / loader context,
// and at realistic length, so arbitrary "G-FORCE"/"G-WAGON" text doesn't match.
function ga4IdFromHtml(html: string): string | undefined {
  const m = html.match(/(?:gtag\(\s*['"]config['"]\s*,\s*['"]|[?&]id=)(G-[A-Z0-9]{8,})/i);
  return m ? m[1].toUpperCase() : undefined;
}

function destinationsForTag(tag: RawTag): Destination[] {
  const type = (tag.type ?? '').toLowerCase();
  const source = tag.name || type || '(unnamed tag)';
  const out: Destination[] = [];

  if (type === 'gaawe' || type === 'gaawc') {
    const mid = paramValue(tag, 'measurementIdOverride') ?? paramValue(tag, 'measurementId');
    out.push({ vendor: 'ga4', id: matchId(mid, GA4_ID), source });
  } else if (type === 'googtag') {
    // Unified Google tag: its id can be GA4 (G-…) OR Google Ads (AW-…).
    const tid = paramValue(tag, 'tagId') ?? paramValue(tag, 'measurementId');
    const aw = matchId(tid, AW_ID);
    if (aw) out.push({ vendor: 'google_ads', id: aw, source });
    else out.push({ vendor: 'ga4', id: matchId(tid, GA4_ID), source });
  } else if (type === 'awct' || type === 'sp') {
    out.push({ vendor: 'google_ads', id: normalizeAdsId(paramValue(tag, 'conversionId')), source });
  } else if (type === 'flc' || type === 'fls') {
    out.push({ vendor: 'floodlight', source });
  } else if (type === 'html') {
    const html = paramValue(tag, 'html') ?? '';
    const fb = html.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/i);
    if (fb) out.push({ vendor: 'meta', id: fb[1], source });
    else if (/connect\.facebook\.net|fbq\s*\(/i.test(html)) out.push({ vendor: 'meta', source });

    const g = ga4IdFromHtml(html);
    if (g) out.push({ vendor: 'ga4', id: g, source });

    if (/ttq\.(load|track|page)|analytics\.tiktok\.com/i.test(html)) out.push({ vendor: 'tiktok', source });

    const li = html.match(/_linkedin_partner_id\s*=\s*["'](\d+)["']/i);
    if (li) out.push({ vendor: 'linkedin', id: li[1], source });
    else if (/snap\.licdn\.com|px\.ads\.linkedin\.com/i.test(html)) out.push({ vendor: 'linkedin', source });
  }
  return out;
}

/** Vendor destinations a (non-paused) container is configured to send to. */
export function extractConfiguredDestinations(rawContainer: unknown): Destination[] {
  const out: Destination[] = [];
  for (const tag of tagsOf(rawContainer)) {
    if (tag.paused === true) continue; // a paused tag is intentionally off — don't expect it live
    out.push(...destinationsForTag(tag));
  }
  return out;
}

/* ───────────── Observed side (live capture) ───────────── */

// Mirrors compliance.isFiringHit but maps to a vendor (a hit that actually
// transmits data, not just a script load).
function firingVendor(hit: CapturedHit): Vendor | null {
  if (hit.ids.includes('ga4_collect') || hit.ids.includes('ua_collect')) return 'ga4';
  if (hit.groups.includes('meta')) return /facebook\.com\/tr\b/i.test(hit.url) ? 'meta' : null;
  if (hit.groups.includes('linkedin')) return /px\.ads\.linkedin\.com/i.test(hit.url) ? 'linkedin' : null;
  if (hit.groups.includes('google_ads')) return 'google_ads';
  if (hit.groups.includes('floodlight')) return 'floodlight';
  if (hit.groups.includes('tiktok')) return 'tiktok';
  return null;
}

function observedId(hit: CapturedHit, vendor: Vendor): string | undefined {
  if (vendor === 'ga4') {
    const tid = hit.query?.tid ?? hit.url.match(/[?&]tid=(G-[A-Z0-9]{4,})/i)?.[1];
    return tid && GA4_ID.test(tid) ? tid.toUpperCase() : undefined;
  }
  if (vendor === 'meta') {
    // The capture pipeline only keeps query for GA4 hits, so read the pixel id
    // straight from the /tr?id=<digits> url.
    const m = hit.url.match(/[?&]id=(\d{6,})/i);
    return m ? m[1] : undefined;
  }
  if (vendor === 'google_ads') {
    const path = hit.url.match(/\/(?:pagead\/)?conversion(?:_async)?\/(\d+)/i);
    if (path) return `AW-${path[1]}`;
    const aw = hit.url.match(AW_ID);
    return aw ? aw[0].toUpperCase() : undefined;
  }
  return undefined;
}

/** Vendor destinations that actually fired across all captured pages/scenarios. */
export function extractObservedDestinations(captures: ScenarioCapture[]): Destination[] {
  const out: Destination[] = [];
  for (const cap of Array.isArray(captures) ? captures : []) {
    for (const hit of Array.isArray(cap?.trackerHits) ? cap.trackerHits : []) {
      const vendor = firingVendor(hit);
      if (!vendor) continue;
      const id = observedId(hit, vendor);
      // The google_ads group conflates real conversions (which carry a
      // conversion id) with GA4 Google-signals / remarketing pings (which do
      // not). Only count it as a configurable Ads destination when an id is
      // present, so signals pings don't masquerade as an un-governed Ads tag.
      if (vendor === 'google_ads' && !id) continue;
      out.push({ vendor, id, source: hit.url });
    }
  }
  return out;
}

/* ───────────── Reconcile ───────────── */

function idList(label: string, ids: string[]): string {
  return ids.length ? ` (${ids.join(', ')})` : label;
}

export interface ReconcileOptions {
  /** Whether a consent-GRANTED capture (accept clicked) ran. When false, a
   *  vendor not firing is expected for consent-gated tags, so we don't flag
   *  configured-but-never-fired. Defaults to true. */
  consentGranted?: boolean;
}

export function reconcile(
  rawContainer: unknown,
  captures: ScenarioCapture[],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const consentGranted = opts.consentGranted !== false;
  const configured = extractConfiguredDestinations(rawContainer);
  const observed = extractObservedDestinations(captures);
  const vendors = [...new Set([...configured, ...observed].map((d) => d.vendor))].sort();

  const byVendor: VendorReconcile[] = [];
  const findings: ReconcileFinding[] = [];

  for (const vendor of vendors) {
    const cfg = configured.filter((d) => d.vendor === vendor);
    const obs = observed.filter((d) => d.vendor === vendor);
    const configuredIds = uniq(cfg.map((d) => d.id).filter((x): x is string => Boolean(x)));
    const observedIds = uniq(obs.map((d) => d.id).filter((x): x is string => Boolean(x)));
    byVendor.push({ vendor, configured: cfg.length > 0, fired: obs.length > 0, configuredIds, observedIds });
    const label = VENDOR_LABEL[vendor];

    if (cfg.length > 0 && obs.length === 0 && consentGranted) {
      findings.push({
        id: `configured_not_fired_${vendor}`,
        severity: 'low',
        confidence: 'medium',
        finding: `${label}${idList('', configuredIds)} is configured in this GTM container but never fired on the captured pages.`,
        whyItMatters:
          'A tag that never fires sends no data — the most common causes are a paused tag, an unpublished container, a trigger that was not met on the captured pages, or the tag being blocked. Captured pages/scenarios are a sample, so confirm against the pages where it should fire.',
        suggestedFix:
          'Check that the tag is unpaused and published, that its trigger matches the live pages, and that consent/blocking does not suppress it. If it should fire elsewhere, audit those pages.',
        evidence: cfg.slice(0, 5).map((d) => `configured by tag "${d.source}"${d.id ? ` → ${d.id}` : ''}`),
      });
    }

    if (cfg.length === 0 && obs.length > 0) {
      findings.push({
        id: `fired_not_configured_${vendor}`,
        severity: 'medium',
        confidence: 'medium',
        finding: `${label}${idList('', observedIds)} fired on the live site but no tag in this GTM container targets it.`,
        whyItMatters:
          'A vendor firing without a matching container tag usually means a hardcoded on-page snippet or a different GTM container/workspace is sending the data — it is outside this container\'s governance (consent gating, change control).',
        suggestedFix:
          'Move the tag into this container so it is governed and consent-gated, or confirm which other container/snippet owns it.',
        evidence: obs.slice(0, 5).map((d) => `observed ${d.source.slice(0, 160)}`),
      });
    }

    // GA4 fired with a measurement id this container doesn't configure.
    if (vendor === 'ga4' && configuredIds.length > 0 && observedIds.length > 0) {
      const extra = observedIds.filter((id) => !configuredIds.includes(id));
      if (extra.length > 0) {
        findings.push({
          id: 'ga4_measurement_id_mismatch',
          severity: 'medium',
          confidence: 'high',
          finding: `GA4 fired with measurement id ${extra.join(', ')}, which this container does not configure (it configures ${configuredIds.join(', ')}).`,
          whyItMatters:
            'Data is flowing to a GA4 property this container does not manage — a leftover hardcoded gtag, a second container, or a wrong id means analytics land in an unexpected property.',
          suggestedFix:
            'Confirm which property should receive data; remove the stray gtag/container or align the configured measurement id.',
          evidence: extra.map((id) => `observed GA4 hit with tid=${id}`),
        });
      }
    }
  }

  return { byVendor, findings };
}
