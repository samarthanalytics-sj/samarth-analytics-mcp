/**
 * Consent Mode v2 + runtime proof engine — pure, deterministic, dependency-free.
 *
 * This module is the single source of truth for Consent Mode v2 auditing. It is
 * imported by the Vercel audit route (apps/portal/api/gtm/audit.ts) and exercised
 * directly by the deterministic test suite (shared/__tests__/consent-audit.node.test.ts).
 *
 * DESIGN PRINCIPLES
 * - Pure: every exported function takes plain data and returns plain data. No I/O,
 *   no Date.now(), no randomness, no network. Identical input → identical output.
 * - Read-only: this module only inspects. It never writes/deletes/publishes.
 * - Conservative: when a field is not visible we mark Manual Review / Not Covered,
 *   never a false finding. We never claim live behaviour without a runtime artifact.
 * - Source-labelled: every finding declares whether it came from CONFIG, RUNTIME,
 *   or the reconciliation of CONFIG + RUNTIME.
 *
 * The three layers:
 *   1. CONFIG  — inspect GTM configuration only.
 *   2. RUNTIME — inspect an imported runtime capture only.
 *   3. CONFIG + RUNTIME — reconcile configured intent against observed reality.
 */

// ── Source / severity / confidence enums ──────────────────────────────────

export type ConsentSource = "CONFIG" | "RUNTIME";
export type ConsentSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ConsentConfidence = "high" | "medium" | "low";
export type ConsentEffort = "S" | "M" | "L";

/** Coverage of the Consent Mode v2 audit given the supplied inputs. */
export type ConsentCoverage =
  | "config_only"
  | "runtime_imported"
  | "reconciled";

/** The canonical Consent Mode v2 signal parameters. */
export const CONSENT_V2_FIELDS = [
  "ad_storage",
  "analytics_storage",
  "ad_user_data",
  "ad_personalization",
] as const;
export type ConsentField = (typeof CONSENT_V2_FIELDS)[number];

// ── Input shapes (plain data, mirror the GTM / runtime structures) ─────────

export interface ConsentParam {
  key?: string;
  value?: string;
  type?: string;
  list?: ConsentParam[];
  map?: ConsentParam[];
}

export interface ConsentTag {
  tagId?: string;
  name?: string;
  type?: string;
  parameter?: ConsentParam[];
  firingTriggerId?: string[];
  /** GTM per-tag consent settings (consentStatus: NOT_SET | NEEDED | NOT_NEEDED). */
  consentSettings?: { consentStatus?: string; consentType?: { value?: string } };
  /** Sequencing — a tag that must fire before this one (setup) / after (teardown). */
  setupTag?: { tagName?: string }[];
  parentFolderId?: string;
}

export interface ConsentTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  customEventFilter?: { parameter?: ConsentParam[] }[];
  filter?: { parameter?: ConsentParam[] }[];
}

export interface ConsentVariable {
  variableId?: string;
  name?: string;
  type?: string;
  parameter?: ConsentParam[];
}

/** Normalised GTM configuration the engine inspects (CONFIG source). */
export interface ConsentConfigInput {
  tags: ConsentTag[];
  triggers: ConsentTrigger[];
  variables: ConsentVariable[];
  /** Lower-cased concatenation of every tag/variable name+param, for text scans. */
  textBlob: string;
  /** "web" | "server" etc. from container.usageContext, lower-cased. */
  usageContexts: string[];
}

// ── Runtime capture shapes (RUNTIME source) ────────────────────────────────

export type ConsentStateLabel =
  | "default_denied"
  | "granted"
  | "analytics_granted_ads_denied"
  | "ads_granted_analytics_denied"
  | "partial"
  | "unknown"
  | string;

export interface RuntimeHit {
  url?: string;
  method?: string;
  /** Vendor groups, e.g. ["ga4"], ["meta"], ["google_ads"]. */
  groups?: string[];
  matched?: string[];
  /** Parsed query params for GA4 hits (gcs/gcd/tid/en/…) when available. */
  query?: Record<string, string>;
  /** Monotonic order/timestamp (ms since navigation start) when captured. */
  tMs?: number;
}

export interface RuntimeCookie {
  name?: string;
  /** ms since navigation start when first observed, when captured. */
  tMs?: number;
}

export interface RuntimeConsentEvent {
  /** "default" | "update". */
  kind?: string;
  /** ms since navigation start, when captured. */
  tMs?: number;
  fields?: Partial<Record<ConsentField, "granted" | "denied">>;
}

export interface RuntimePage {
  requestedUrl?: string;
  finalUrl?: string | null;
  /** The declared consent state this page was captured under. */
  consentState?: ConsentStateLabel;
  consoleErrors?: string[];
  pageErrors?: string[];
  trackerHits?: RuntimeHit[];
  dataLayerEvents?: string[];
  dataLayerKeys?: string[];
  /** Consent default/update events observed in the dataLayer, in order. */
  consentEvents?: RuntimeConsentEvent[];
  /** Cookies observed, optionally with first-seen timing. */
  cookies?: RuntimeCookie[];
  /** ms since navigation start of the first measurement (GA4) hit, when known. */
  firstMeasurementTMs?: number;
}

export interface RuntimeInput {
  capturedAt?: string;
  pages: RuntimePage[];
  /** Distinct declared consent states present in the capture. */
  states: ConsentStateLabel[];
  ok: boolean;
}

// ── Finding shape ──────────────────────────────────────────────────────────

export interface ConsentFinding {
  /** Stable, content-derived id (caller may re-hash; we keep it readable here). */
  id: string;
  /** Always "consent" for this engine's findings. */
  domain: "consent";
  severity: ConsentSeverity;
  confidence: ConsentConfidence;
  sources: ConsentSource[];
  finding: string;
  whyItMatters: string;
  suggestedFix: string;
  businessImpact: string;
  effort: ConsentEffort;
  needsManualReview?: boolean;
  parameter?: string;
  /** Entity the finding is about (tag/trigger name+id, or a captured page path). */
  entity?: { name?: string; id?: string; path?: string };
  affected?: string[];
  /** Short evidence snippets (e.g. a redacted hit URL, a console error line). */
  evidence?: string[];
}

// ── Small helpers ──────────────────────────────────────────────────────────

function lc(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function tagParam(tag: ConsentTag, key: string): string | undefined {
  return tag.parameter?.find((p) => p.key === key)?.value;
}

/** GA4 config (Google tag / GA4 config) tags. */
export function isGa4Config(tag: ConsentTag): boolean {
  return tag.type === "gaawc" || tag.type === "googtag";
}
/** GA4 event tags. */
export function isGa4Event(tag: ConsentTag): boolean {
  return tag.type === "gaawe";
}

const MARKETING_ANALYTICS_TYPES = new Set([
  "gaawc",
  "gaawe",
  "googtag",
  "ua",
  "awct", // Google Ads conversion
  "sp", // Google Ads remarketing
  "flc", // Floodlight counter
  "fls", // Floodlight sales
  "img", // image pixel
]);

const MARKETING_NAME_HINT =
  /(facebook|meta[\s_-]?pixel|fbq|tiktok|linkedin|pinterest|snap(?:chat)?|twitter|x[\s_-]?pixel|criteo|taboola|outbrain|bing|microsoft[\s_-]?ads|hotjar|clarity|segment|amplitude|mixpanel)/i;

/** True for tags that load analytics/marketing pixels. */
export function isMarketingOrAnalyticsTag(tag: ConsentTag): boolean {
  const t = lc(tag.type);
  if (!t) return false;
  if (MARKETING_ANALYTICS_TYPES.has(t)) return true;
  if (t === "html" || t === "cvt_" || t.startsWith("cvt_")) {
    // Custom HTML / custom template — only treat as marketing when the name hints
    // at a known vendor. Conservative: callers should mark these manual review.
    return MARKETING_NAME_HINT.test(tag.name ?? "");
  }
  return false;
}

/** Parse a query string from a GA4 collect URL into a flat map. */
export function parseHitQuery(url: string | undefined): Record<string, string> {
  if (!url || typeof url !== "string") return {};
  const q = url.indexOf("?");
  if (q < 0) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(q + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    if (!k) continue;
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Read gcs/gcd from a hit: prefer parsed query, fall back to URL regex. */
export function hitConsentSignals(hit: RuntimeHit): { gcs?: string; gcd?: string } {
  const q = hit.query && Object.keys(hit.query).length > 0 ? hit.query : parseHitQuery(hit.url);
  const out: { gcs?: string; gcd?: string } = {};
  if (typeof q.gcs === "string" && q.gcs) out.gcs = q.gcs;
  if (typeof q.gcd === "string" && q.gcd) out.gcd = q.gcd;
  return out;
}

function isGa4Hit(hit: RuntimeHit): boolean {
  return (hit.groups ?? []).includes("ga4");
}
function isVendorHit(hit: RuntimeHit): boolean {
  const g = hit.groups ?? [];
  return g.some((x) => x !== "ga4" && x !== "gtm");
}

/** Classify a declared consent state into the canonical buckets we reason about. */
export function classifyState(state: ConsentStateLabel | undefined): {
  analytics: "granted" | "denied" | "unknown";
  ads: "granted" | "denied" | "unknown";
} {
  const s = lc(state);
  if (!s || s === "unknown") return { analytics: "unknown", ads: "unknown" };
  if (s === "granted") return { analytics: "granted", ads: "granted" };
  if (s === "default_denied" || s === "denied" || s === "all_denied")
    return { analytics: "denied", ads: "denied" };
  if (s === "analytics_granted_ads_denied")
    return { analytics: "granted", ads: "denied" };
  if (s === "ads_granted_analytics_denied")
    return { analytics: "denied", ads: "granted" };
  // partial / anything else — be conservative.
  return { analytics: "unknown", ads: "unknown" };
}

function pageWhere(page: RuntimePage): string {
  return page.finalUrl || page.requestedUrl || "(page)";
}

function push(out: ConsentFinding[], f: ConsentFinding): void {
  // De-dupe on id; first writer wins (deterministic given stable ordering).
  if (out.some((x) => x.id === f.id)) return;
  out.push(f);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. CONFIG checks — inspect GTM configuration only. Source: CONFIG.
// ════════════════════════════════════════════════════════════════════════════

/** Detect consent initialisation: a Consent Mode default in tags/triggers/text. */
export function detectConsentInit(cfg: ConsentConfigInput): {
  hasDefault: boolean;
  hasUpdate: boolean;
  hasConsentInitTrigger: boolean;
  fieldsSeen: Set<ConsentField>;
} {
  const blob = cfg.textBlob;
  const hasDefault = /consent['"\s,]*default|gtag\(['"]consent['"],\s*['"]default/.test(blob)
    || /consent[_\s-]?default/.test(blob);
  const hasUpdate = /consent['"\s,]*update|gtag\(['"]consent['"],\s*['"]update/.test(blob)
    || /consent[_\s-]?update/.test(blob);
  const hasConsentInitTrigger = cfg.triggers.some(
    (t) => lc(t.type) === "consentinit" || /consent[\s_-]?initialization/.test(lc(t.name)),
  );
  const fieldsSeen = new Set<ConsentField>();
  for (const f of CONSENT_V2_FIELDS) {
    if (blob.includes(f)) fieldsSeen.add(f);
  }
  return { hasDefault, hasUpdate, hasConsentInitTrigger, fieldsSeen };
}

/** No Consent Mode v2 signals at all in CONFIG. */
function ruleConfigNoConsentSignals(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const init = detectConsentInit(cfg);
  if (init.fieldsSeen.size === 0 && !init.hasDefault && !init.hasUpdate && !init.hasConsentInitTrigger) {
    push(out, {
      id: "consent-config-none",
      domain: "consent",
      severity: "medium",
      confidence: "medium",
      sources: ["CONFIG"],
      finding: "No Consent Mode v2 signals found in GTM configuration",
      whyItMatters:
        "No references to ad_storage, analytics_storage, ad_user_data, ad_personalization, or a consent default/update were found across tags, triggers, or variables. A CMP outside GTM may still supply consent — this needs manual confirmation.",
      suggestedFix:
        "Confirm a CMP initialises Consent Mode v2 (default state) before marketing/analytics tags fire. If consent is managed inside GTM, add a Consent Initialization trigger and a default-consent tag.",
      businessImpact:
        "Without verified consent signalling, regulated jurisdictions (GDPR/ePrivacy/CCPA) may see non-compliant tag firing.",
      effort: "M",
      needsManualReview: true,
      parameter: "ad_storage / analytics_storage / consent",
    });
  }
}

/** Consent init present but no default-denied path visible. */
function ruleConfigNoDefaultDenied(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const init = detectConsentInit(cfg);
  if (!init.hasDefault && (init.fieldsSeen.size > 0 || init.hasUpdate)) {
    push(out, {
      id: "consent-config-no-default",
      domain: "consent",
      severity: "medium",
      confidence: "medium",
      sources: ["CONFIG"],
      finding: "Consent fields are referenced but no consent default state is visible",
      whyItMatters:
        "Consent Mode v2 requires a default state to be set before any measurement fires (typically denied in regulated regions). The configuration references consent fields but no `default` call is visible in GTM.",
      suggestedFix:
        "Add a consent default tag (gtag('consent','default', …)) on the Consent Initialization trigger so a state is set before tags fire. The CMP may set this outside GTM — confirm manually.",
      businessImpact:
        "Missing a default state can let tags fire before consent is established, risking non-compliant collection.",
      effort: "M",
      needsManualReview: true,
      parameter: "consent default",
    });
  }
}

/** Missing specific Consent Mode v2 fields where some are visible. */
function ruleConfigMissingV2Fields(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const init = detectConsentInit(cfg);
  // Only meaningful when SOME consent fields are present (i.e. CMv1-style or
  // partial v2). If none are present, ruleConfigNoConsentSignals already covered it.
  if (init.fieldsSeen.size === 0) return;
  const missing = CONSENT_V2_FIELDS.filter((f) => !init.fieldsSeen.has(f));
  if (missing.length === 0) return;
  const v2New = missing.filter((f) => f === "ad_user_data" || f === "ad_personalization");
  const severity: ConsentSeverity = v2New.length > 0 ? "high" : "medium";
  push(out, {
    id: `consent-config-missing-fields:${missing.join(",")}`,
    domain: "consent",
    severity,
    confidence: "medium",
    sources: ["CONFIG"],
    finding: `Consent configuration is missing field(s): ${missing.join(", ")}`,
    affected: missing,
    whyItMatters:
      "Consent Mode v2 (mandatory for EEA/UK Google Ads & remarketing since March 2024) requires ad_user_data and ad_personalization in addition to ad_storage and analytics_storage. Missing fields mean the consent signal is incomplete.",
    suggestedFix:
      `Add the missing field(s) (${missing.join(", ")}) to your consent default/update calls. If a CMP outside GTM supplies them, confirm with a runtime capture.`,
    businessImpact:
      v2New.length > 0
        ? "Without ad_user_data / ad_personalization, Google Ads personalisation and remarketing degrade and EEA conversions may be dropped."
        : "Incomplete consent signals reduce modelling quality and may not satisfy regional requirements.",
    effort: "M",
    needsManualReview: true,
    parameter: missing.join(" / "),
  });
}

/** Per-tag consent settings missing on marketing/analytics tags. */
function ruleConfigPerTagConsent(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const missing: string[] = [];
  const manualReview: string[] = [];
  for (const tag of cfg.tags) {
    const t = lc(tag.type);
    const isKnown = MARKETING_ANALYTICS_TYPES.has(t);
    const isHinted = (t === "html" || t.startsWith("cvt_")) && MARKETING_NAME_HINT.test(tag.name ?? "");
    if (!isKnown && !isHinted) continue;
    const status = tag.consentSettings?.consentStatus;
    if (!status || status === "NOT_SET") {
      if (isHinted) manualReview.push(tag.name ?? "Unnamed tag");
      else missing.push(tag.name ?? "Unnamed tag");
    }
  }
  if (missing.length > 0) {
    push(out, {
      id: `consent-config-pertag-missing:${missing.length}`,
      domain: "consent",
      severity: "high",
      confidence: "high",
      sources: ["CONFIG"],
      finding: `${missing.length} marketing/analytics tag(s) have no per-tag consent settings`,
      affected: missing.slice(0, 25),
      whyItMatters:
        "When a tag's consentSettings.consentStatus is NOT_SET the tag fires regardless of consent state. GTM's Additional Consent Checks let you require ad_storage / analytics_storage per tag.",
      suggestedFix:
        "Set consentSettings to NEEDED (with the required consent types) for each tag that loads marketing or analytics scripts/pixels. Use NOT_NEEDED only with documented justification.",
      businessImpact:
        "Firing marketing/analytics tags without per-tag consent gating in regulated regions is a direct compliance risk.",
      effort: "M",
      parameter: "consentSettings.consentStatus",
    });
  }
  if (manualReview.length > 0) {
    push(out, {
      id: `consent-config-pertag-review:${manualReview.length}`,
      domain: "consent",
      severity: "medium",
      confidence: "low",
      sources: ["CONFIG"],
      finding: `${manualReview.length} custom tag(s) named like marketing vendors have no consent settings`,
      affected: manualReview.slice(0, 25),
      whyItMatters:
        "These are Custom HTML / custom-template tags whose names suggest a marketing vendor (e.g. Meta, TikTok). We cannot confirm from configuration alone that they load a pixel, so this is flagged for manual review rather than as a definite failure.",
      suggestedFix:
        "Manually confirm whether each tag loads a marketing/analytics pixel. If so, add per-tag consent settings or gate it on a consent-aware trigger.",
      businessImpact:
        "Ungated vendor pixels in custom tags can collect data before consent — verify to avoid compliance gaps.",
      effort: "M",
      needsManualReview: true,
      parameter: "consentSettings.consentStatus",
    });
  }
}

/** Ordering risk: measurement tags on All Pages with no consent init before them. */
const ALL_PAGES_TRIGGER_ID = "2147479553"; // GTM built-in All Pages trigger id

function ruleConfigOrderingRisk(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const init = detectConsentInit(cfg);
  // Only meaningful when there IS consent configured but no explicit consent-init
  // trigger to guarantee ordering, AND measurement tags fire on page load.
  if (!init.hasDefault && init.fieldsSeen.size === 0) return; // no consent at all → other rules cover it
  if (init.hasConsentInitTrigger) return; // ordering guaranteed by the special trigger
  const pageLoadMeasurement = cfg.tags.filter((tag) => {
    if (!isMarketingOrAnalyticsTag(tag) && !isGa4Config(tag)) return false;
    const triggers = tag.firingTriggerId ?? [];
    return triggers.includes(ALL_PAGES_TRIGGER_ID);
  });
  if (pageLoadMeasurement.length === 0) return;
  push(out, {
    id: `consent-config-ordering:${pageLoadMeasurement.length}`,
    domain: "consent",
    severity: "medium",
    confidence: "low",
    sources: ["CONFIG"],
    finding:
      "Consent is configured but no Consent Initialization trigger guarantees it runs before measurement tags",
    affected: pageLoadMeasurement.slice(0, 25).map((t) => t.name ?? "Unnamed tag"),
    whyItMatters:
      "Consent default must execute before measurement/marketing tags so the correct consent state is applied. Without GTM's Consent Initialization trigger, ordering depends on tag priority/sequencing that CONFIG cannot fully verify.",
    suggestedFix:
      "Place the consent default tag on the Consent Initialization trigger, or use tag sequencing/priority to guarantee it runs first. Confirm ordering with a runtime capture.",
    businessImpact:
      "If measurement fires before consent default, the first hits carry the wrong consent state.",
    effort: "M",
    needsManualReview: true,
    parameter: "Consent Initialization trigger",
  });
}

/** url_passthrough / ads_data_redaction / region settings visibility. */
function ruleConfigPassthroughRedaction(cfg: ConsentConfigInput, out: ConsentFinding[]) {
  const init = detectConsentInit(cfg);
  // Only relevant if consent IS configured. We report what is NOT visible as
  // manual-review items, never as definite failures.
  if (!init.hasDefault && init.fieldsSeen.size === 0) return;
  const blob = cfg.textBlob;
  const hasPassthrough = /url_passthrough|urlpassthrough/.test(blob);
  const hasRedaction = /ads_data_redaction|adsdataredaction/.test(blob);
  const hasRegion = /\bregion\b|region_codes|regions/.test(blob);
  const missing: string[] = [];
  if (!hasPassthrough) missing.push("url_passthrough");
  if (!hasRedaction) missing.push("ads_data_redaction");
  if (!hasRegion) missing.push("region");
  if (missing.length === 0) return;
  push(out, {
    id: `consent-config-passthrough:${missing.join(",")}`,
    domain: "consent",
    severity: "low",
    confidence: "low",
    sources: ["CONFIG"],
    finding: `Consent advanced settings not visible in config: ${missing.join(", ")}`,
    affected: missing,
    whyItMatters:
      "url_passthrough preserves ad-click identifiers when ad_storage is denied; ads_data_redaction redacts ad identifiers under denial; region settings scope consent defaults to specific geographies. These are often set by the CMP outside GTM, so absence is not proof they are missing.",
    suggestedFix:
      "Confirm whether the CMP or gtag config sets url_passthrough, ads_data_redaction, and region-scoped defaults. If consent is managed in GTM, consider enabling url_passthrough and ads_data_redaction.",
    businessImpact:
      "Without url_passthrough/redaction, denied-consent conversions lose modelling signal and attribution degrades.",
    effort: "S",
    needsManualReview: true,
    parameter: missing.join(" / "),
  });
}

/** Run all CONFIG-only consent rules. Pure. */
export function runConsentConfigRules(cfg: ConsentConfigInput): ConsentFinding[] {
  const out: ConsentFinding[] = [];
  ruleConfigNoConsentSignals(cfg, out);
  ruleConfigNoDefaultDenied(cfg, out);
  ruleConfigMissingV2Fields(cfg, out);
  ruleConfigPerTagConsent(cfg, out);
  ruleConfigOrderingRisk(cfg, out);
  ruleConfigPassthroughRedaction(cfg, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 2. RUNTIME checks — inspect runtime capture only. Source: RUNTIME.
// ════════════════════════════════════════════════════════════════════════════

/** GA4 hits missing gcs/gcd. */
function ruleRuntimeGcsGcdMissing(rt: RuntimeInput, out: ConsentFinding[]) {
  let ga4 = 0;
  let withSignals = 0;
  const evidence: string[] = [];
  for (const page of rt.pages) {
    for (const hit of page.trackerHits ?? []) {
      if (!isGa4Hit(hit)) continue;
      ga4++;
      const sig = hitConsentSignals(hit);
      if (sig.gcs || sig.gcd) withSignals++;
      else if (evidence.length < 3 && hit.url) evidence.push(hit.url.slice(0, 160));
    }
  }
  if (ga4 === 0) return;
  if (withSignals === 0) {
    push(out, {
      id: `consent-runtime-gcs-missing:${ga4}`,
      domain: "consent",
      severity: "medium",
      confidence: "high",
      sources: ["RUNTIME"],
      finding: `${ga4} GA4 hit(s) observed with no Consent Mode signal (gcs/gcd)`,
      whyItMatters:
        "Every captured GA4 /g/collect request lacked the gcs/gcd Consent Mode parameters. This is strong evidence that Consent Mode is not wired up on the captured page(s).",
      suggestedFix:
        "Verify a consent default/update runs before GA4 fires so the Google tag stamps gcs/gcd on each hit.",
      businessImpact:
        "Without gcs/gcd, Google cannot apply consent-aware modelling and regional behaviour may be non-compliant.",
      effort: "M",
      evidence: evidence.length ? evidence : undefined,
    });
  } else if (withSignals < ga4) {
    push(out, {
      id: `consent-runtime-gcs-partial:${withSignals}/${ga4}`,
      domain: "consent",
      severity: "low",
      confidence: "medium",
      sources: ["RUNTIME"],
      finding: `${ga4 - withSignals} of ${ga4} GA4 hit(s) are missing Consent Mode signals (gcs/gcd)`,
      whyItMatters:
        "Some GA4 hits carried gcs/gcd and some did not. Mixed signalling usually means certain hits fire before the consent default is applied, or a subset of pages lack consent wiring.",
      suggestedFix:
        "Identify which hits lack gcs/gcd (often the earliest hit on a page) and ensure the consent default runs first on every page.",
      businessImpact:
        "Inconsistent consent signalling corrupts modelling and can mix compliant and non-compliant collection.",
      effort: "M",
    });
  }
}

/** Measurement hits under denied state. */
function ruleRuntimeHitsUnderDenied(rt: RuntimeInput, out: ConsentFinding[]) {
  for (const page of rt.pages) {
    const cls = classifyState(page.consentState);
    const where = pageWhere(page);
    const ga4Hits = (page.trackerHits ?? []).filter(isGa4Hit);
    const vendorHits = (page.trackerHits ?? []).filter(isVendorHit);

    // Under analytics-denied, a GA4 hit is expected to still fire WITH gcs
    // showing denial (Consent Mode cookieless ping). The problem is when it
    // fires carrying NO consent signal (looks like consent never applied).
    if (cls.analytics === "denied" && ga4Hits.length > 0) {
      const noSignal = ga4Hits.filter((h) => {
        const s = hitConsentSignals(h);
        return !s.gcs && !s.gcd;
      });
      if (noSignal.length > 0) {
        push(out, {
          id: `consent-runtime-ga4-denied-nosignal:${where}`,
          domain: "consent",
          severity: "high",
          confidence: "high",
          sources: ["RUNTIME"],
          finding: "GA4 hit fired under denied consent with no Consent Mode signal",
          entity: { path: where },
          affected: [where],
          whyItMatters:
            `Under the captured "${page.consentState}" state, ${noSignal.length} GA4 hit(s) carried no gcs/gcd. A correctly wired site sends a cookieless consent-aware ping (gcs=G100) under denial — a hit with no signal suggests consent was never applied to GA4.`,
          suggestedFix:
            "Ensure the consent default (denied) is set before the Google tag fires so denied-state hits carry gcs/gcd.",
          businessImpact:
            "Collecting under denial without consent signalling is a compliance exposure and breaks consent modelling.",
          effort: "M",
          evidence: noSignal.slice(0, 3).map((h) => (h.url ?? "").slice(0, 160)).filter(Boolean),
        });
      }
    }

    // Vendor (ads/marketing) hit under denied is a strong red flag regardless
    // of signals: ad pixels should not fire at all when ad_storage is denied.
    if (cls.ads === "denied" && vendorHits.length > 0) {
      const vendors = Array.from(
        new Set(vendorHits.flatMap((h) => (h.groups ?? []).filter((g) => g !== "ga4" && g !== "gtm"))),
      );
      push(out, {
        id: `consent-runtime-vendor-denied:${where}:${vendors.sort().join(",")}`,
        domain: "consent",
        severity: "high",
        confidence: "high",
        sources: ["RUNTIME"],
        finding: `Marketing/ads vendor hit observed under denied consent (${vendors.join(", ")})`,
        entity: { path: where },
        affected: [where],
        whyItMatters:
          `Under the captured "${page.consentState}" state (ads denied), ${vendorHits.length} marketing/ads request(s) to ${vendors.join(", ")} were observed. Ad/marketing pixels should not load when ad_storage is denied.`,
        suggestedFix:
          "Gate these vendor tags on consent (per-tag consent settings or a consent-aware trigger) so they do not fire under ad denial.",
        businessImpact:
          "Firing ad pixels under denial is a direct GDPR/ePrivacy violation and exposes the client to enforcement.",
        effort: "M",
        evidence: vendorHits.slice(0, 3).map((h) => (h.url ?? "").slice(0, 160)).filter(Boolean),
      });
    }
  }
}

/** Granted state should produce the expected GA4 hit. */
function ruleRuntimeGrantedExpectsHit(rt: RuntimeInput, out: ConsentFinding[]) {
  for (const page of rt.pages) {
    const cls = classifyState(page.consentState);
    if (cls.analytics !== "granted") continue;
    const ga4Hits = (page.trackerHits ?? []).filter(isGa4Hit);
    const where = pageWhere(page);
    if (ga4Hits.length === 0) {
      push(out, {
        id: `consent-runtime-granted-nohit:${where}`,
        domain: "consent",
        severity: "high",
        confidence: "high",
        sources: ["RUNTIME"],
        finding: "No GA4 hit observed under granted consent",
        entity: { path: where },
        affected: [where],
        whyItMatters:
          `Under the captured "${page.consentState}" state (analytics granted), zero GA4 /g/collect requests were recorded. With consent granted, GA4 should send a page_view.`,
        suggestedFix:
          "Confirm the Google tag fires on this page and that the consent update to granted reaches GA4 before it would send.",
        businessImpact:
          "Missing hits under granted consent mean real, consented traffic is not measured — direct data loss.",
        effort: "M",
      });
    }
  }
}

/** Cookies set before consent (timing) where cookie snapshots exist. */
function ruleRuntimeCookiesBeforeConsent(rt: RuntimeInput, out: ConsentFinding[]) {
  const TRACKING_COOKIE =
    /^(_ga|_gid|_gcl|_fbp|_fbc|_uet|IDE|test_cookie|_ttp|li_|_pin_|_scid)/i;
  for (const page of rt.pages) {
    const cookies = page.cookies ?? [];
    if (cookies.length === 0) continue;
    const cls = classifyState(page.consentState);
    // Determine when consent default/update happened.
    const consentTs = (page.consentEvents ?? [])
      .map((e) => e.tMs)
      .filter((t): t is number => typeof t === "number");
    const firstConsentTMs = consentTs.length ? Math.min(...consentTs) : undefined;
    const offenders: string[] = [];
    for (const c of cookies) {
      const name = c.name ?? "";
      if (!TRACKING_COOKIE.test(name)) continue;
      // Two ways to flag: explicit timing before consent, OR a tracking cookie
      // present at all under a denied state.
      if (typeof c.tMs === "number" && typeof firstConsentTMs === "number") {
        if (c.tMs < firstConsentTMs) offenders.push(name);
      } else if (cls.analytics === "denied" || cls.ads === "denied") {
        offenders.push(name);
      }
    }
    if (offenders.length === 0) continue;
    const where = pageWhere(page);
    push(out, {
      id: `consent-runtime-cookie-before:${where}:${Array.from(new Set(offenders)).sort().join(",")}`,
      domain: "consent",
      severity: "high",
      confidence: typeof firstConsentTMs === "number" ? "high" : "medium",
      sources: ["RUNTIME"],
      finding: `Tracking cookie(s) set before/without consent (${Array.from(new Set(offenders)).join(", ")})`,
      entity: { path: where },
      affected: [where],
      whyItMatters:
        typeof firstConsentTMs === "number"
          ? `On "${page.consentState}", these tracking cookies were observed before the consent event at ${firstConsentTMs}ms.`
          : `On "${page.consentState}" (a denied state), these tracking cookies were present even though storage should be denied.`,
      suggestedFix:
        "Ensure storage-setting tags are gated on consent and that no tracking cookies are written before the consent default applies.",
      businessImpact:
        "Setting tracking cookies before consent is a textbook ePrivacy/cookie-law violation.",
      effort: "M",
      evidence: Array.from(new Set(offenders)).slice(0, 5),
    });
  }
}

/** Console errors related to CMP / consent / tag loading. */
function ruleRuntimeConsentConsoleErrors(rt: RuntimeInput, out: ConsentFinding[]) {
  const CMP_RE =
    /(consent|cmp|cookiebot|onetrust|usercentrics|trustarc|didomi|quantcast|iubenda|gtag|dataLayer|gtm\.js)/i;
  for (const page of rt.pages) {
    const errs = [...(page.pageErrors ?? []), ...(page.consoleErrors ?? [])];
    const related = errs.filter((e) => CMP_RE.test(e));
    if (related.length === 0) continue;
    const where = pageWhere(page);
    push(out, {
      id: `consent-runtime-console:${where}:${related.length}`,
      domain: "consent",
      severity: "medium",
      confidence: "medium",
      sources: ["RUNTIME"],
      finding: `${related.length} CMP/consent-related JavaScript error(s) observed`,
      entity: { path: where },
      affected: [where],
      whyItMatters:
        "Errors mentioning the CMP, consent, gtag, or the GTM container can interrupt consent initialisation or tag loading, leaving the page in an undefined consent state.",
      suggestedFix:
        "Investigate the errors below; a broken CMP or consent script can block both compliant gating and legitimate measurement.",
      businessImpact:
        "A failing consent script can either leak data or silently block all measurement.",
      effort: "M",
      evidence: related.slice(0, 5).map((s) => s.slice(0, 160)),
    });
  }
}

/** Run all RUNTIME-only consent rules. Pure. */
export function runConsentRuntimeRules(rt: RuntimeInput): ConsentFinding[] {
  const out: ConsentFinding[] = [];
  if (!rt.ok) return out;
  ruleRuntimeGcsGcdMissing(rt, out);
  ruleRuntimeHitsUnderDenied(rt, out);
  ruleRuntimeGrantedExpectsHit(rt, out);
  ruleRuntimeCookiesBeforeConsent(rt, out);
  ruleRuntimeConsentConsoleErrors(rt, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// 3. CONFIG + RUNTIME reconciliation. Source: CONFIG + RUNTIME.
// ════════════════════════════════════════════════════════════════════════════

/** Config claims gating, runtime shows a vendor hit under denied. */
function ruleReconcileGatingClaimVsVendor(
  cfg: ConsentConfigInput,
  rt: RuntimeInput,
  out: ConsentFinding[],
) {
  // "Config claims gating" = at least one marketing/analytics tag has consentSettings NEEDED.
  const claimsGating = cfg.tags.some(
    (t) => isMarketingOrAnalyticsTag(t) && t.consentSettings?.consentStatus === "NEEDED",
  );
  if (!claimsGating) return;
  for (const page of rt.pages) {
    const cls = classifyState(page.consentState);
    if (cls.ads !== "denied") continue;
    const vendorHits = (page.trackerHits ?? []).filter(isVendorHit);
    if (vendorHits.length === 0) continue;
    const where = pageWhere(page);
    const vendors = Array.from(
      new Set(vendorHits.flatMap((h) => (h.groups ?? []).filter((g) => g !== "ga4" && g !== "gtm"))),
    );
    push(out, {
      id: `consent-reconcile-gating-vs-vendor:${where}:${vendors.sort().join(",")}`,
      domain: "consent",
      severity: "critical",
      confidence: "high",
      sources: ["CONFIG", "RUNTIME"],
      finding: "Config gates tags on consent, but runtime shows vendor hits under denial",
      entity: { path: where },
      affected: [where],
      whyItMatters:
        `GTM configuration declares per-tag consent (consentSettings=NEEDED) for marketing/analytics tags, yet under the captured "${page.consentState}" state, ${vendorHits.length} vendor request(s) to ${vendors.join(", ")} still fired. Configured intent and observed reality disagree.`,
      suggestedFix:
        "Trace which tag produced these requests — the consent gating may be on a different tag, or the pixel may be loaded outside GTM. Reconcile so no ad vendor fires under denial.",
      businessImpact:
        "A gap between declared gating and real behaviour is the worst case: the org believes it is compliant while it is not.",
      effort: "L",
      evidence: vendorHits.slice(0, 3).map((h) => (h.url ?? "").slice(0, 160)).filter(Boolean),
    });
  }
}

/** Consent default configured, runtime first measurement occurs before consent. */
function ruleReconcileMeasurementBeforeConsent(
  cfg: ConsentConfigInput,
  rt: RuntimeInput,
  out: ConsentFinding[],
) {
  const init = detectConsentInit(cfg);
  if (!init.hasDefault && init.fieldsSeen.size === 0) return; // no consent intent to reconcile
  for (const page of rt.pages) {
    const consentTs = (page.consentEvents ?? [])
      .filter((e) => lc(e.kind) === "default")
      .map((e) => e.tMs)
      .filter((t): t is number => typeof t === "number");
    if (consentTs.length === 0) continue;
    const firstDefault = Math.min(...consentTs);
    // First measurement time: explicit field, else min GA4 hit tMs.
    let firstHit = page.firstMeasurementTMs;
    if (typeof firstHit !== "number") {
      const hitTs = (page.trackerHits ?? [])
        .filter(isGa4Hit)
        .map((h) => h.tMs)
        .filter((t): t is number => typeof t === "number");
      if (hitTs.length) firstHit = Math.min(...hitTs);
    }
    if (typeof firstHit !== "number") continue;
    if (firstHit < firstDefault) {
      const where = pageWhere(page);
      push(out, {
        id: `consent-reconcile-measure-before-default:${where}`,
        domain: "consent",
        severity: "high",
        confidence: "high",
        sources: ["CONFIG", "RUNTIME"],
        finding: "First GA4 measurement fired before the consent default event",
        entity: { path: where },
        affected: [where],
        whyItMatters:
          `Config sets a consent default, but on "${page.consentState}" the first GA4 hit was observed at ${firstHit}ms, before the consent default at ${firstDefault}ms. The earliest hit carried the wrong (or no) consent state.`,
        suggestedFix:
          "Move the consent default to the Consent Initialization trigger so it always runs before the Google tag.",
        businessImpact:
          "Hits sent before the default are mis-stamped, corrupting consent modelling and compliance posture.",
        effort: "M",
        evidence: [`first_hit=${firstHit}ms`, `consent_default=${firstDefault}ms`],
      });
    }
  }
}

/** Config has consent-update-dependent triggers, runtime lacks consent update events. */
function ruleReconcileConsentUpdateMissing(
  cfg: ConsentConfigInput,
  rt: RuntimeInput,
  out: ConsentFinding[],
) {
  // Config depends on a consent update if there is an update reference OR a
  // custom-event trigger whose event name mentions consent.
  const init = detectConsentInit(cfg);
  const consentDependentTriggers = cfg.triggers.filter((t) => {
    if (lc(t.type) !== "customevent") return false;
    const blob = JSON.stringify(t.customEventFilter ?? t.filter ?? []).toLowerCase();
    return /consent|cmp|cookie/.test(blob) || /consent/.test(lc(t.name));
  });
  if (!init.hasUpdate && consentDependentTriggers.length === 0) return;
  // Did runtime observe any consent update event or consent-named dataLayer event?
  let observedUpdate = false;
  for (const page of rt.pages) {
    if ((page.consentEvents ?? []).some((e) => lc(e.kind) === "update")) observedUpdate = true;
    if ((page.dataLayerEvents ?? []).some((e) => /consent/.test(lc(e)))) observedUpdate = true;
  }
  // Only meaningful if runtime captured SOME dataLayer activity; absence of any
  // dataLayer events proves nothing (custom dataLayer name etc).
  const sawAnyDlActivity = rt.pages.some(
    (p) => (p.dataLayerEvents ?? []).length > 0 || (p.consentEvents ?? []).length > 0,
  );
  if (!sawAnyDlActivity) return;
  if (!observedUpdate) {
    push(out, {
      id: `consent-reconcile-no-update`,
      domain: "consent",
      severity: "medium",
      confidence: "medium",
      sources: ["CONFIG", "RUNTIME"],
      finding: "Config expects a consent update, but none was observed at runtime",
      whyItMatters:
        "The configuration references a consent update (or a consent-dependent custom-event trigger), yet the runtime capture recorded dataLayer activity without any consent update event. The CMP may not be firing the update on the captured flow.",
      suggestedFix:
        "Capture the consent acceptance flow (or confirm the CMP pushes a consent update / dataLayer event) and re-check. This is not a site-wide claim — only the captured flow lacked it.",
      businessImpact:
        "If the consent update never fires, tags stay in their default (often denied) state even after the user accepts.",
      effort: "M",
      needsManualReview: true,
    });
  }
}

/** Config missing v2 fields AND runtime GA4 hits missing gcs/gcd → reinforced. */
function ruleReconcileMissingFieldsAndSignals(
  cfg: ConsentConfigInput,
  rt: RuntimeInput,
  out: ConsentFinding[],
) {
  const init = detectConsentInit(cfg);
  const missing = CONSENT_V2_FIELDS.filter((f) => !init.fieldsSeen.has(f));
  if (missing.length === 0) return;
  // Runtime GA4 hits missing gcs/gcd?
  let ga4 = 0;
  let withSignals = 0;
  for (const page of rt.pages) {
    for (const hit of page.trackerHits ?? []) {
      if (!isGa4Hit(hit)) continue;
      ga4++;
      const s = hitConsentSignals(hit);
      if (s.gcs || s.gcd) withSignals++;
    }
  }
  if (ga4 === 0) return;
  if (withSignals === 0) {
    push(out, {
      id: `consent-reconcile-missing-and-nosignal:${missing.join(",")}`,
      domain: "consent",
      severity: "high",
      confidence: "high",
      sources: ["CONFIG", "RUNTIME"],
      finding:
        "Config is missing Consent Mode v2 fields and runtime GA4 hits carry no gcs/gcd",
      affected: missing,
      whyItMatters:
        `Configuration is missing ${missing.join(", ")} AND all ${ga4} captured GA4 hit(s) lacked gcs/gcd. Config and runtime agree: Consent Mode v2 is not effectively applied.`,
      suggestedFix:
        `Implement a complete Consent Mode v2 default/update (including ${missing.join(", ")}) and verify gcs/gcd appear on GA4 hits in a fresh capture.`,
      businessImpact:
        "Both intent and reality show no working consent signalling — high compliance and modelling risk.",
      effort: "L",
      parameter: missing.join(" / "),
    });
  }
}

/** Run all reconciliation rules. Pure. Requires runtime.ok. */
export function runConsentReconcileRules(
  cfg: ConsentConfigInput,
  rt: RuntimeInput,
): ConsentFinding[] {
  const out: ConsentFinding[] = [];
  if (!rt.ok) return out;
  ruleReconcileGatingClaimVsVendor(cfg, rt, out);
  ruleReconcileMeasurementBeforeConsent(cfg, rt, out);
  ruleReconcileConsentUpdateMissing(cfg, rt, out);
  ruleReconcileMissingFieldsAndSignals(cfg, rt, out);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Top-level engine entry point.
// ════════════════════════════════════════════════════════════════════════════

export interface ConsentAuditResult {
  coverage: ConsentCoverage;
  /** Distinct consent states present in the runtime capture (empty if none). */
  runtimeStates: ConsentStateLabel[];
  /** Which of denied / granted / partial states are present. */
  stateCoverage: { denied: boolean; granted: boolean; partial: boolean };
  findings: ConsentFinding[];
}

/**
 * Run the full Consent Mode v2 + runtime proof engine.
 *
 * @param cfg  GTM configuration (CONFIG source). Required.
 * @param rt   Parsed runtime capture (RUNTIME source). null/!ok → config-only.
 */
export function runConsentAudit(
  cfg: ConsentConfigInput,
  rt: RuntimeInput | null,
): ConsentAuditResult {
  const findings: ConsentFinding[] = [];
  findings.push(...runConsentConfigRules(cfg));

  let coverage: ConsentCoverage = "config_only";
  let runtimeStates: ConsentStateLabel[] = [];
  let stateCoverage = { denied: false, granted: false, partial: false };

  if (rt && rt.ok) {
    findings.push(...runConsentRuntimeRules(rt));
    findings.push(...runConsentReconcileRules(cfg, rt));
    runtimeStates = rt.states.slice();
    for (const s of rt.states) {
      const cls = classifyState(s);
      if (cls.analytics === "denied" && cls.ads === "denied") stateCoverage.denied = true;
      else if (cls.analytics === "granted" && cls.ads === "granted") stateCoverage.granted = true;
      else stateCoverage.partial = true;
    }
    // "reconciled" requires BOTH a capture AND consent intent in config to
    // reconcile against. With a capture but no config consent intent, the
    // RUNTIME checks still ran, but there is nothing to reconcile — so we
    // report "runtime_imported" to avoid over-claiming.
    const init = detectConsentInit(cfg);
    const hasConfigIntent =
      init.hasDefault ||
      init.hasUpdate ||
      init.hasConsentInitTrigger ||
      init.fieldsSeen.size > 0 ||
      cfg.tags.some((t) => Boolean(t.consentSettings?.consentStatus && t.consentSettings.consentStatus !== "NOT_SET"));
    coverage = hasConfigIntent ? "reconciled" : "runtime_imported";
  }

  // Stable deterministic ordering: severity desc, then id asc.
  const SEV: Record<ConsentSeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  findings.sort((a, b) => {
    const d = SEV[b.severity] - SEV[a.severity];
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { coverage, runtimeStates, stateCoverage, findings };
}
