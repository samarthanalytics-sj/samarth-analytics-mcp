/**
 * Deterministic accuracy validation suite for the Consent Mode v2 + runtime
 * proof engine (../consent-audit.ts).
 *
 * Pure-logic, table-driven. Every case feeds plain data into runConsentAudit /
 * the rule runners and asserts on the result. No I/O, no network, no Date.now.
 * Identical input -> identical output, so these are reproducible accuracy checks
 * (the task asked for 100+ validations — this file declares and runs >= 100
 * named cases and prints the exact count at the end).
 *
 * Run: npx tsx apps/portal/shared/__tests__/consent-audit.node.test.ts
 */

import assert from "node:assert";
import {
  runConsentAudit,
  runConsentConfigRules,
  runConsentRuntimeRules,
  runConsentReconcileRules,
  classifyState,
  parseHitQuery,
  hitConsentSignals,
  detectConsentInit,
  isGa4Config,
  isGa4Event,
  isMarketingOrAnalyticsTag,
  CONSENT_V2_FIELDS,
  type ConsentConfigInput,
  type ConsentTag,
  type ConsentTrigger,
  type RuntimeInput,
  type RuntimePage,
  type RuntimeHit,
  type ConsentFinding,
  type ConsentStateLabel,
} from "../consent-audit";

// ── tiny test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

// ── builders ─────────────────────────────────────────────────────────────--

function cfg(partial: Partial<ConsentConfigInput> = {}): ConsentConfigInput {
  return {
    tags: partial.tags ?? [],
    triggers: partial.triggers ?? [],
    variables: partial.variables ?? [],
    textBlob: partial.textBlob ?? "",
    usageContexts: partial.usageContexts ?? ["web"],
  };
}

/** Build a textBlob that references the given consent fields + a default call. */
function blobWith(opts: {
  fields?: readonly string[];
  hasDefault?: boolean;
  hasUpdate?: boolean;
  passthrough?: boolean;
  redaction?: boolean;
  region?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.hasDefault) parts.push("gtag('consent','default',{");
  if (opts.hasUpdate) parts.push("gtag('consent','update',{");
  for (const f of opts.fields ?? []) parts.push(`${f}:'denied'`);
  if (opts.passthrough) parts.push("url_passthrough:true");
  if (opts.redaction) parts.push("ads_data_redaction:true");
  if (opts.region) parts.push("region:['ES','DE']");
  return parts.join(" ").toLowerCase();
}

function tag(partial: Partial<ConsentTag> = {}): ConsentTag {
  return { tagId: "1", name: "Tag", type: "html", ...partial };
}

function consentInitTrigger(): ConsentTrigger {
  return { triggerId: "t1", name: "Consent Initialization", type: "consentInit" };
}

const ALL_PAGES = "2147479553";

function rt(pages: RuntimePage[], states?: ConsentStateLabel[]): RuntimeInput {
  const derived =
    states ??
    Array.from(new Set(pages.map((p) => p.consentState).filter(Boolean))) as ConsentStateLabel[];
  return { capturedAt: "2026-06-01T00:00:00.000Z", pages, states: derived, ok: true };
}

function ga4Hit(opts: { gcs?: string; gcd?: string; tMs?: number } = {}): RuntimeHit {
  const q: Record<string, string> = { tid: "G-XXXX", en: "page_view" };
  if (opts.gcs) q.gcs = opts.gcs;
  if (opts.gcd) q.gcd = opts.gcd;
  const qs = Object.entries(q)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return {
    url: `https://www.google-analytics.com/g/collect?v=2&${qs}`,
    method: "POST",
    groups: ["ga4"],
    matched: ["ga4_collect"],
    query: q,
    tMs: opts.tMs,
  };
}

function metaHit(tMs?: number): RuntimeHit {
  return {
    url: "https://www.facebook.com/tr?id=1&ev=PageView",
    method: "GET",
    groups: ["meta"],
    matched: ["meta_pixel"],
    query: {},
    tMs,
  };
}

function has(findings: ConsentFinding[], idPrefix: string): ConsentFinding | undefined {
  return findings.find((f) => f.id.startsWith(idPrefix));
}
function hasNo(findings: ConsentFinding[], idPrefix: string): boolean {
  return !findings.some((f) => f.id.startsWith(idPrefix));
}

// ════════════════════════════════════════════════════════════════════════════
// GROUP A — pure helper unit checks
// ════════════════════════════════════════════════════════════════════════════

test("A01 parseHitQuery extracts gcs/gcd", () => {
  const q = parseHitQuery("https://x/g/collect?v=2&gcs=G100&gcd=11111&en=page_view");
  assert.equal(q.gcs, "G100");
  assert.equal(q.gcd, "11111");
  assert.equal(q.en, "page_view");
});
test("A02 parseHitQuery empty for no query string", () => {
  assert.deepEqual(parseHitQuery("https://x/path"), {});
});
test("A03 parseHitQuery handles undefined", () => {
  assert.deepEqual(parseHitQuery(undefined), {});
});
test("A04 parseHitQuery decodes url-encoded values", () => {
  const q = parseHitQuery("https://x/c?dl=https%3A%2F%2Fa.com%2Fp");
  assert.equal(q.dl, "https://a.com/p");
});
test("A05 parseHitQuery decodes plus as space", () => {
  const q = parseHitQuery("https://x/c?t=hello+world");
  assert.equal(q.t, "hello world");
});
test("A06 hitConsentSignals prefers parsed query", () => {
  const s = hitConsentSignals({ url: "https://x/c?gcs=G999", query: { gcs: "G100" } });
  assert.equal(s.gcs, "G100");
});
test("A07 hitConsentSignals falls back to url regex", () => {
  const s = hitConsentSignals({ url: "https://x/c?gcs=G100&gcd=11111" });
  assert.equal(s.gcs, "G100");
  assert.equal(s.gcd, "11111");
});
test("A08 hitConsentSignals empty when no signals", () => {
  const s = hitConsentSignals({ url: "https://x/c?en=page_view" });
  assert.equal(s.gcs, undefined);
  assert.equal(s.gcd, undefined);
});
test("A09 classifyState granted -> both granted", () => {
  assert.deepEqual(classifyState("granted"), { analytics: "granted", ads: "granted" });
});
test("A10 classifyState default_denied -> both denied", () => {
  assert.deepEqual(classifyState("default_denied"), { analytics: "denied", ads: "denied" });
});
test("A11 classifyState denied alias -> both denied", () => {
  assert.deepEqual(classifyState("denied"), { analytics: "denied", ads: "denied" });
});
test("A12 classifyState analytics_granted_ads_denied", () => {
  assert.deepEqual(classifyState("analytics_granted_ads_denied"), {
    analytics: "granted",
    ads: "denied",
  });
});
test("A13 classifyState ads_granted_analytics_denied", () => {
  assert.deepEqual(classifyState("ads_granted_analytics_denied"), {
    analytics: "denied",
    ads: "granted",
  });
});
test("A14 classifyState unknown -> unknown/unknown", () => {
  assert.deepEqual(classifyState("partial"), { analytics: "unknown", ads: "unknown" });
});
test("A15 classifyState undefined -> unknown/unknown", () => {
  assert.deepEqual(classifyState(undefined), { analytics: "unknown", ads: "unknown" });
});
test("A16 isGa4Config true for gaawc", () => assert.ok(isGa4Config(tag({ type: "gaawc" }))));
test("A17 isGa4Config true for googtag", () => assert.ok(isGa4Config(tag({ type: "googtag" }))));
test("A18 isGa4Config false for gaawe", () => assert.ok(!isGa4Config(tag({ type: "gaawe" }))));
test("A19 isGa4Event true for gaawe", () => assert.ok(isGa4Event(tag({ type: "gaawe" }))));
test("A20 isMarketing true for awct (Ads)", () =>
  assert.ok(isMarketingOrAnalyticsTag(tag({ type: "awct" }))));
test("A21 isMarketing true for flc (Floodlight)", () =>
  assert.ok(isMarketingOrAnalyticsTag(tag({ type: "flc" }))));
test("A22 isMarketing false for plain html", () =>
  assert.ok(!isMarketingOrAnalyticsTag(tag({ type: "html", name: "Hello" }))));
test("A23 isMarketing true for html named like Meta Pixel", () =>
  assert.ok(isMarketingOrAnalyticsTag(tag({ type: "html", name: "Meta Pixel Base" }))));
test("A24 isMarketing true for html named TikTok", () =>
  assert.ok(isMarketingOrAnalyticsTag(tag({ type: "html", name: "TikTok Events" }))));
test("A25 isMarketing false for empty type", () =>
  assert.ok(!isMarketingOrAnalyticsTag(tag({ type: "" }))));
test("A26 CONSENT_V2_FIELDS has the four canonical fields", () => {
  assert.deepEqual([...CONSENT_V2_FIELDS], [
    "ad_storage",
    "analytics_storage",
    "ad_user_data",
    "ad_personalization",
  ]);
});
test("A27 detectConsentInit finds default in blob", () => {
  const i = detectConsentInit(cfg({ textBlob: "gtag('consent','default',{ad_storage:'denied'})" }));
  assert.ok(i.hasDefault);
});
test("A28 detectConsentInit finds update in blob", () => {
  const i = detectConsentInit(cfg({ textBlob: "gtag('consent','update',{})" }));
  assert.ok(i.hasUpdate);
});
test("A29 detectConsentInit finds consentInit trigger", () => {
  const i = detectConsentInit(cfg({ triggers: [consentInitTrigger()] }));
  assert.ok(i.hasConsentInitTrigger);
});
test("A30 detectConsentInit counts fields seen", () => {
  const i = detectConsentInit(cfg({ textBlob: "ad_storage analytics_storage" }));
  assert.equal(i.fieldsSeen.size, 2);
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP B — CONFIG-only rules
// ════════════════════════════════════════════════════════════════════════════

test("B01 empty config -> no-consent-signals finding", () => {
  const f = runConsentConfigRules(cfg());
  assert.ok(has(f, "consent-config-none"));
});
test("B02 no-consent finding needs manual review", () => {
  const f = runConsentConfigRules(cfg());
  assert.ok(has(f, "consent-config-none")!.needsManualReview);
});
test("B03 no-consent finding source is CONFIG", () => {
  const f = runConsentConfigRules(cfg());
  assert.deepEqual(has(f, "consent-config-none")!.sources, ["CONFIG"]);
});
test("B04 complete v2 default -> no 'none' finding", () => {
  const f = runConsentConfigRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
  );
  assert.ok(hasNo(f, "consent-config-none"));
});
test("B05 complete v2 default -> no missing-fields finding", () => {
  const f = runConsentConfigRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
  );
  assert.ok(hasNo(f, "consent-config-missing-fields"));
});
test("B06 missing ad_user_data -> missing-fields HIGH", () => {
  const f = runConsentConfigRules(
    cfg({
      textBlob: blobWith({
        hasDefault: true,
        fields: ["ad_storage", "analytics_storage", "ad_personalization"],
      }),
    }),
  );
  const mf = has(f, "consent-config-missing-fields");
  assert.ok(mf);
  assert.equal(mf!.severity, "high");
  assert.ok(mf!.affected!.includes("ad_user_data"));
});
test("B07 missing ad_personalization -> missing-fields HIGH", () => {
  const f = runConsentConfigRules(
    cfg({
      textBlob: blobWith({
        hasDefault: true,
        fields: ["ad_storage", "analytics_storage", "ad_user_data"],
      }),
    }),
  );
  const mf = has(f, "consent-config-missing-fields");
  assert.equal(mf!.severity, "high");
});
test("B08 missing only legacy field -> missing-fields MEDIUM", () => {
  // present: analytics_storage, ad_user_data, ad_personalization; missing ad_storage (legacy)
  const f = runConsentConfigRules(
    cfg({
      textBlob: blobWith({
        hasDefault: true,
        fields: ["analytics_storage", "ad_user_data", "ad_personalization"],
      }),
    }),
  );
  const mf = has(f, "consent-config-missing-fields");
  assert.equal(mf!.severity, "medium");
});
test("B09 analytics-only consent -> missing-fields lists all 3 ad fields", () => {
  const f = runConsentConfigRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }) }),
  );
  const mf = has(f, "consent-config-missing-fields");
  assert.ok(mf!.affected!.includes("ad_storage"));
  assert.ok(mf!.affected!.includes("ad_user_data"));
  assert.ok(mf!.affected!.includes("ad_personalization"));
});
test("B10 fields present but no default -> no-default finding", () => {
  const f = runConsentConfigRules(cfg({ textBlob: "ad_storage analytics_storage ad_user_data ad_personalization" }));
  assert.ok(has(f, "consent-config-no-default"));
});
test("B11 update-only but no default -> no-default finding", () => {
  const f = runConsentConfigRules(cfg({ textBlob: blobWith({ hasUpdate: true }) }));
  assert.ok(has(f, "consent-config-no-default"));
});
test("B12 default present -> no no-default finding", () => {
  const f = runConsentConfigRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
  );
  assert.ok(hasNo(f, "consent-config-no-default"));
});
test("B13 per-tag: GA4 config tag NOT_SET -> pertag-missing HIGH", () => {
  const f = runConsentConfigRules(
    cfg({
      tags: [tag({ type: "gaawc", name: "GA4 Config", consentSettings: { consentStatus: "NOT_SET" } })],
      textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
    }),
  );
  const m = has(f, "consent-config-pertag-missing");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("B14 per-tag: missing consentSettings entirely -> pertag-missing", () => {
  const f = runConsentConfigRules(
    cfg({ tags: [tag({ type: "awct", name: "Ads Conversion" })], textBlob: blobWith({ hasDefault: true }) }),
  );
  assert.ok(has(f, "consent-config-pertag-missing"));
});
test("B15 per-tag: NEEDED -> no pertag-missing", () => {
  const f = runConsentConfigRules(
    cfg({
      tags: [tag({ type: "gaawc", name: "GA4", consentSettings: { consentStatus: "NEEDED" } })],
      textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
    }),
  );
  assert.ok(hasNo(f, "consent-config-pertag-missing"));
});
test("B16 per-tag: custom html vendor-named NOT_SET -> review (not missing)", () => {
  const f = runConsentConfigRules(
    cfg({ tags: [tag({ type: "html", name: "Meta Pixel" })], textBlob: blobWith({ hasDefault: true }) }),
  );
  assert.ok(has(f, "consent-config-pertag-review"));
  assert.ok(hasNo(f, "consent-config-pertag-missing"));
});
test("B17 per-tag review finding has low confidence + manual review", () => {
  const f = runConsentConfigRules(
    cfg({ tags: [tag({ type: "html", name: "TikTok base" })], textBlob: blobWith({ hasDefault: true }) }),
  );
  const r = has(f, "consent-config-pertag-review")!;
  assert.equal(r.confidence, "low");
  assert.ok(r.needsManualReview);
});
test("B18 per-tag: non-marketing html -> neither pertag finding", () => {
  const f = runConsentConfigRules(
    cfg({ tags: [tag({ type: "html", name: "Hello World banner" })], textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
  );
  assert.ok(hasNo(f, "consent-config-pertag-missing"));
  assert.ok(hasNo(f, "consent-config-pertag-review"));
});
test("B19 ordering: GA4 on All Pages, no consentInit trigger -> ordering finding", () => {
  const f = runConsentConfigRules(
    cfg({
      tags: [tag({ type: "gaawc", name: "GA4", firingTriggerId: [ALL_PAGES] })],
      textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
    }),
  );
  assert.ok(has(f, "consent-config-ordering"));
});
test("B20 ordering: consentInit trigger present -> no ordering finding", () => {
  const f = runConsentConfigRules(
    cfg({
      tags: [tag({ type: "gaawc", name: "GA4", firingTriggerId: [ALL_PAGES] })],
      triggers: [consentInitTrigger()],
      textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
    }),
  );
  assert.ok(hasNo(f, "consent-config-ordering"));
});
test("B21 ordering: no consent at all -> no ordering finding (other rule covers)", () => {
  const f = runConsentConfigRules(
    cfg({ tags: [tag({ type: "gaawc", name: "GA4", firingTriggerId: [ALL_PAGES] })] }),
  );
  assert.ok(hasNo(f, "consent-config-ordering"));
});
test("B22 ordering: GA4 not on All Pages -> no ordering finding", () => {
  const f = runConsentConfigRules(
    cfg({
      tags: [tag({ type: "gaawc", name: "GA4", firingTriggerId: ["999"] })],
      textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
    }),
  );
  assert.ok(hasNo(f, "consent-config-ordering"));
});
test("B23 passthrough: consent set but no advanced settings -> passthrough finding LOW", () => {
  const f = runConsentConfigRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
  );
  const p = has(f, "consent-config-passthrough");
  assert.ok(p);
  assert.equal(p!.severity, "low");
});
test("B24 passthrough: all advanced settings present -> no passthrough finding", () => {
  const f = runConsentConfigRules(
    cfg({
      textBlob: blobWith({
        hasDefault: true,
        fields: CONSENT_V2_FIELDS,
        passthrough: true,
        redaction: true,
        region: true,
      }),
    }),
  );
  assert.ok(hasNo(f, "consent-config-passthrough"));
});
test("B25 passthrough: no consent at all -> no passthrough finding", () => {
  const f = runConsentConfigRules(cfg());
  assert.ok(hasNo(f, "consent-config-passthrough"));
});
test("B26 passthrough: only redaction missing -> lists redaction only", () => {
  const f = runConsentConfigRules(
    cfg({
      textBlob: blobWith({
        hasDefault: true,
        fields: CONSENT_V2_FIELDS,
        passthrough: true,
        region: true,
      }),
    }),
  );
  const p = has(f, "consent-config-passthrough")!;
  assert.deepEqual(p.affected, ["ads_data_redaction"]);
});
test("B27 all CONFIG findings are domain=consent", () => {
  const f = runConsentConfigRules(cfg({ tags: [tag({ type: "awct" })] }));
  assert.ok(f.every((x) => x.domain === "consent"));
});
test("B28 all CONFIG findings carry CONFIG source only", () => {
  const f = runConsentConfigRules(cfg({ textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }) }));
  assert.ok(f.every((x) => x.sources.length === 1 && x.sources[0] === "CONFIG"));
});
test("B29 CONFIG rules are deterministic (same input twice)", () => {
  const c = cfg({ tags: [tag({ type: "awct" })], textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }) });
  assert.deepEqual(runConsentConfigRules(c), runConsentConfigRules(c));
});
test("B30 every CONFIG finding has fix + businessImpact + effort", () => {
  const f = runConsentConfigRules(cfg({ tags: [tag({ type: "awct" })] }));
  assert.ok(f.every((x) => x.suggestedFix && x.businessImpact && x.effort));
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP C — RUNTIME-only rules
// ════════════════════════════════════════════════════════════════════════════

test("C01 GA4 hit with gcs/gcd -> no gcs-missing finding", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111", gcd: "11111" })] }]));
  assert.ok(hasNo(f, "consent-runtime-gcs-missing"));
});
test("C02 all GA4 hits missing gcs/gcd -> gcs-missing MEDIUM", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit()] }]));
  const m = has(f, "consent-runtime-gcs-missing");
  assert.ok(m);
  assert.equal(m!.severity, "medium");
});
test("C03 gcs-missing finding includes evidence", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit()] }]));
  assert.ok((has(f, "consent-runtime-gcs-missing")!.evidence ?? []).length > 0);
});
test("C04 mixed gcs presence -> gcs-partial LOW", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" }), ga4Hit()] }]),
  );
  const m = has(f, "consent-runtime-gcs-partial");
  assert.ok(m);
  assert.equal(m!.severity, "low");
});
test("C05 no GA4 hits at all -> no gcs finding", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [] }]));
  assert.ok(hasNo(f, "consent-runtime-gcs"));
});
test("C06 GA4 hit under denied WITH gcs (G100) -> no denied-nosignal finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit({ gcs: "G100", gcd: "11111" })] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-ga4-denied-nosignal"));
});
test("C07 GA4 hit under denied WITHOUT signal -> denied-nosignal HIGH", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit()] }]),
  );
  const m = has(f, "consent-runtime-ga4-denied-nosignal");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("C08 Meta vendor hit under denied -> vendor-denied HIGH", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  const m = has(f, "consent-runtime-vendor-denied");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("C09 vendor-denied evidence includes vendor group name", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(has(f, "consent-runtime-vendor-denied")!.finding.toLowerCase().includes("meta"));
});
test("C10 vendor hit under granted -> no vendor-denied finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [metaHit()] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-vendor-denied"));
});
test("C11 analytics_granted_ads_denied: meta hit -> vendor-denied (ads denied)", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "analytics_granted_ads_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(has(f, "consent-runtime-vendor-denied"));
});
test("C12 granted but no GA4 hit -> granted-nohit HIGH", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [] }]),
  );
  const m = has(f, "consent-runtime-granted-nohit");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("C13 granted with GA4 hit -> no granted-nohit finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-granted-nohit"));
});
test("C14 analytics_granted_ads_denied with no GA4 hit -> granted-nohit (analytics granted)", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "analytics_granted_ads_denied", trackerHits: [] }]),
  );
  assert.ok(has(f, "consent-runtime-granted-nohit"));
});
test("C15 denied with no GA4 hit -> NO granted-nohit (denial may suppress)", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-granted-nohit"));
});
test("C16 tracking cookie before consent event -> cookie-before HIGH", () => {
  const f = runConsentRuntimeRules(
    rt([{
      requestedUrl: "https://e/",
      consentState: "default_denied",
      consentEvents: [{ kind: "default", tMs: 200, fields: {} }],
      cookies: [{ name: "_ga", tMs: 100 }],
    }]),
  );
  const m = has(f, "consent-runtime-cookie-before");
  assert.ok(m);
  assert.equal(m!.severity, "high");
  assert.equal(m!.confidence, "high");
});
test("C17 tracking cookie after consent event -> no cookie-before finding", () => {
  const f = runConsentRuntimeRules(
    rt([{
      requestedUrl: "https://e/",
      consentState: "granted",
      consentEvents: [{ kind: "default", tMs: 100, fields: {} }],
      cookies: [{ name: "_ga", tMs: 300 }],
    }]),
  );
  assert.ok(hasNo(f, "consent-runtime-cookie-before"));
});
test("C18 tracking cookie under denied, no timing -> cookie-before MEDIUM confidence", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", cookies: [{ name: "_fbp" }] }]),
  );
  const m = has(f, "consent-runtime-cookie-before");
  assert.ok(m);
  assert.equal(m!.confidence, "medium");
});
test("C19 non-tracking cookie -> no cookie-before finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", cookies: [{ name: "session_id" }] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-cookie-before"));
});
test("C20 tracking cookie under granted, no timing -> no cookie-before finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", cookies: [{ name: "_ga" }] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-cookie-before"));
});
test("C21 CMP console error -> console finding MEDIUM", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", consoleErrors: ["OneTrust failed to load"] }]),
  );
  const m = has(f, "consent-runtime-console");
  assert.ok(m);
  assert.equal(m!.severity, "medium");
});
test("C22 unrelated console error -> no console finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", consoleErrors: ["image 404 not found"] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-console"));
});
test("C23 gtag page error -> console finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "granted", pageErrors: ["gtag is not defined"] }]),
  );
  assert.ok(has(f, "consent-runtime-console"));
});
test("C24 runtime rules skipped when ok=false", () => {
  const bad: RuntimeInput = { pages: [{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit()] }], states: ["default_denied"], ok: false };
  assert.equal(runConsentRuntimeRules(bad).length, 0);
});
test("C25 all RUNTIME findings carry RUNTIME source only", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()] }]),
  );
  assert.ok(f.every((x) => x.sources.length === 1 && x.sources[0] === "RUNTIME"));
});
test("C26 RUNTIME rules deterministic", () => {
  const r = rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()] }]);
  assert.deepEqual(runConsentRuntimeRules(r), runConsentRuntimeRules(r));
});
test("C27 vendor-denied entity path set to page url", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/x", finalUrl: "https://e/x", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.equal(has(f, "consent-runtime-vendor-denied")!.entity!.path, "https://e/x");
});
test("C28 multiple pages each evaluated", () => {
  const f = runConsentRuntimeRules(
    rt([
      { requestedUrl: "https://e/a", finalUrl: "https://e/a", consentState: "default_denied", trackerHits: [metaHit()] },
      { requestedUrl: "https://e/b", finalUrl: "https://e/b", consentState: "default_denied", trackerHits: [metaHit()] },
    ]),
  );
  assert.equal(f.filter((x) => x.id.startsWith("consent-runtime-vendor-denied")).length, 2);
});
test("C29 every RUNTIME finding has fix + businessImpact + effort", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()], cookies: [{ name: "_ga" }] }]),
  );
  assert.ok(f.every((x) => x.suggestedFix && x.businessImpact && x.effort));
});
test("C30 denied GA4 hit WITH gcs -> still no gcs-missing finding", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit({ gcs: "G100", gcd: "11111" })] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-gcs-missing"));
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP D — CONFIG + RUNTIME reconciliation
// ════════════════════════════════════════════════════════════════════════════

const gatedCfg = cfg({
  tags: [tag({ type: "awct", name: "Ads", consentSettings: { consentStatus: "NEEDED" } })],
  textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }),
});

test("D01 gating claim vs vendor hit under denied -> CRITICAL", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  const m = has(f, "consent-reconcile-gating-vs-vendor");
  assert.ok(m);
  assert.equal(m!.severity, "critical");
});
test("D02 gating-vs-vendor carries both CONFIG and RUNTIME sources", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.deepEqual(has(f, "consent-reconcile-gating-vs-vendor")!.sources.sort(), ["CONFIG", "RUNTIME"]);
});
test("D03 no gating claim -> no gating-vs-vendor finding", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-gating-vs-vendor"));
});
test("D04 gating claim but vendor under granted -> no finding", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [metaHit()] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-gating-vs-vendor"));
});
test("D05 measurement before consent default -> HIGH", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{
      requestedUrl: "https://e/",
      consentState: "granted",
      consentEvents: [{ kind: "default", tMs: 300 }],
      firstMeasurementTMs: 150,
      trackerHits: [ga4Hit({ gcs: "G111", tMs: 150 })],
    }]),
  );
  const m = has(f, "consent-reconcile-measure-before-default");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("D06 measurement after consent default -> no finding", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{
      requestedUrl: "https://e/",
      consentState: "granted",
      consentEvents: [{ kind: "default", tMs: 100 }],
      firstMeasurementTMs: 400,
      trackerHits: [ga4Hit({ gcs: "G111", tMs: 400 })],
    }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-measure-before-default"));
});
test("D07 measure-before falls back to min GA4 hit tMs when no firstMeasurementTMs", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{
      requestedUrl: "https://e/",
      consentState: "granted",
      consentEvents: [{ kind: "default", tMs: 300 }],
      trackerHits: [ga4Hit({ gcs: "G111", tMs: 150 })],
    }]),
  );
  assert.ok(has(f, "consent-reconcile-measure-before-default"));
});
test("D08 no consent intent in config -> no measure-before finding", () => {
  const f = runConsentReconcileRules(
    cfg(),
    rt([{
      requestedUrl: "https://e/",
      consentState: "granted",
      consentEvents: [{ kind: "default", tMs: 300 }],
      trackerHits: [ga4Hit({ tMs: 150 })],
    }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-measure-before-default"));
});
test("D09 config expects update, runtime saw dataLayer but no update -> no-update MEDIUM", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, hasUpdate: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", dataLayerEvents: ["gtm.js", "gtm.dom"], consentEvents: [{ kind: "default", tMs: 100 }] }]),
  );
  const m = has(f, "consent-reconcile-no-update");
  assert.ok(m);
  assert.equal(m!.severity, "medium");
});
test("D10 config expects update, runtime DID see update -> no finding", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, hasUpdate: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", consentEvents: [{ kind: "default", tMs: 100 }, { kind: "update", tMs: 200 }] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-no-update"));
});
test("D11 no update expected -> no no-update finding", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", dataLayerEvents: ["gtm.js"] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-no-update"));
});
test("D12 update expected but NO dataLayer activity -> no finding (proves nothing)", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, hasUpdate: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied" }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-no-update"));
});
test("D13 consent-named custom event trigger counts as update-dependent", () => {
  const triggers: ConsentTrigger[] = [
    { triggerId: "t9", name: "Consent Accepted", type: "customEvent", customEventFilter: [{ parameter: [{ key: "arg0", value: "consent_update" }] }] },
  ];
  const f = runConsentReconcileRules(
    cfg({ triggers, textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", dataLayerEvents: ["gtm.js", "gtm.dom"] }]),
  );
  assert.ok(has(f, "consent-reconcile-no-update"));
});
test("D14 missing fields + all GA4 hits no gcs -> reinforced HIGH", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }) }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit()] }]),
  );
  const m = has(f, "consent-reconcile-missing-and-nosignal");
  assert.ok(m);
  assert.equal(m!.severity, "high");
});
test("D15 missing fields but GA4 hits HAVE gcs -> no reinforced finding", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }) }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-missing-and-nosignal"));
});
test("D16 complete fields -> no reinforced finding even with no-gcs hits", () => {
  const f = runConsentReconcileRules(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit()] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-missing-and-nosignal"));
});
test("D17 reconcile rules skipped when ok=false", () => {
  const bad: RuntimeInput = { pages: [{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }], states: ["default_denied"], ok: false };
  assert.equal(runConsentReconcileRules(gatedCfg, bad).length, 0);
});
test("D18 reconcile rules deterministic", () => {
  const r = rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]);
  assert.deepEqual(runConsentReconcileRules(gatedCfg, r), runConsentReconcileRules(gatedCfg, r));
});
test("D19 reconcile findings reference both sources or are properly labelled", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(f.every((x) => x.sources.includes("CONFIG") && x.sources.includes("RUNTIME")));
});
test("D20 every reconcile finding has fix + businessImpact + effort", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(f.every((x) => x.suggestedFix && x.businessImpact && x.effort));
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP E — top-level runConsentAudit: coverage, state coverage, ordering
// ════════════════════════════════════════════════════════════════════════════

test("E01 no runtime -> coverage config_only", () => {
  assert.equal(runConsentAudit(cfg(), null).coverage, "config_only");
});
test("E02 runtime + config consent intent -> reconciled", () => {
  const r = runConsentAudit(
    cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS }) }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.equal(r.coverage, "reconciled");
});
test("E03 runtime but NO config consent intent -> runtime_imported", () => {
  const r = runConsentAudit(
    cfg(),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.equal(r.coverage, "runtime_imported");
});
test("E04 runtime with consentSettings NEEDED tag -> reconciled (config intent via per-tag)", () => {
  const r = runConsentAudit(
    cfg({ tags: [tag({ type: "gaawc", consentSettings: { consentStatus: "NEEDED" } })] }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.equal(r.coverage, "reconciled");
});
test("E05 ok=false runtime -> config_only", () => {
  const bad: RuntimeInput = { pages: [], states: [], ok: false };
  assert.equal(runConsentAudit(cfg({ textBlob: blobWith({ hasDefault: true }) }), bad).coverage, "config_only");
});
test("E06 stateCoverage.denied set for default_denied", () => {
  const r = runConsentAudit(cfg(), rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit({ gcs: "G100" })] }]));
  assert.ok(r.stateCoverage.denied);
});
test("E07 stateCoverage.granted set for granted", () => {
  const r = runConsentAudit(cfg(), rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]));
  assert.ok(r.stateCoverage.granted);
});
test("E08 stateCoverage.partial set for analytics_granted_ads_denied", () => {
  const r = runConsentAudit(cfg(), rt([{ requestedUrl: "https://e/", consentState: "analytics_granted_ads_denied", trackerHits: [ga4Hit({ gcs: "G101" })] }]));
  assert.ok(r.stateCoverage.partial);
});
test("E09 stateCoverage all three across multi-state capture", () => {
  const r = runConsentAudit(
    cfg(),
    rt([
      { requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit({ gcs: "G100" })] },
      { requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] },
      { requestedUrl: "https://e/", consentState: "analytics_granted_ads_denied", trackerHits: [ga4Hit({ gcs: "G101" })] },
    ]),
  );
  assert.ok(r.stateCoverage.denied && r.stateCoverage.granted && r.stateCoverage.partial);
});
test("E10 runtimeStates reflects distinct states", () => {
  const r = runConsentAudit(
    cfg(),
    rt(
      [
        { requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [ga4Hit({ gcs: "G100" })] },
        { requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] },
      ],
      ["default_denied", "granted"],
    ),
  );
  assert.deepEqual(r.runtimeStates.sort(), ["default_denied", "granted"]);
});
test("E11 findings sorted severity desc (critical first)", () => {
  const r = runConsentAudit(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()], cookies: [{ name: "_ga" }] }]),
  );
  const sev = r.findings.map((f) => f.severity);
  const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
  for (let i = 1; i < sev.length; i++) {
    assert.ok(rank[sev[i - 1]] >= rank[sev[i]], `unsorted at ${i}: ${sev[i - 1]} < ${sev[i]}`);
  }
});
test("E12 top-level audit deterministic (deep equal twice)", () => {
  const c = gatedCfg;
  const r = rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()] }]);
  assert.deepEqual(runConsentAudit(c, r), runConsentAudit(c, r));
});
test("E13 config_only still runs config rules (empty cfg has a finding)", () => {
  assert.ok(runConsentAudit(cfg(), null).findings.length >= 1);
});
test("E14 runtime_imported includes RUNTIME findings", () => {
  const r = runConsentAudit(
    cfg(),
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(r.findings.some((f) => f.sources.includes("RUNTIME")));
});
test("E15 reconciled includes a reconcile (CONFIG+RUNTIME) finding when applicable", () => {
  const r = runConsentAudit(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(r.findings.some((f) => f.sources.includes("CONFIG") && f.sources.includes("RUNTIME")));
});
test("E16 no duplicate finding ids in output", () => {
  const r = runConsentAudit(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()], cookies: [{ name: "_ga" }] }]),
  );
  const ids = r.findings.map((f) => f.id);
  assert.equal(ids.length, new Set(ids).size);
});
test("E17 empty runtime states + ok -> coverage runtime_imported or reconciled, no crash", () => {
  const r = runConsentAudit(cfg({ textBlob: blobWith({ hasDefault: true }) }), { pages: [], states: [], ok: true });
  assert.ok(["runtime_imported", "reconciled"].includes(r.coverage));
});
test("E18 every finding domain is consent", () => {
  const r = runConsentAudit(gatedCfg, rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]));
  assert.ok(r.findings.every((f) => f.domain === "consent"));
});
test("E19 every finding has confidence among high/medium/low", () => {
  const r = runConsentAudit(gatedCfg, rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), ga4Hit()] }]));
  assert.ok(r.findings.every((f) => ["high", "medium", "low"].includes(f.confidence)));
});
test("E20 stateCoverage all false when no states", () => {
  const r = runConsentAudit(cfg(), null);
  assert.deepEqual(r.stateCoverage, { denied: false, granted: false, partial: false });
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP F — scenario / end-to-end accuracy fixtures (realistic shapes)
// ════════════════════════════════════════════════════════════════════════════

// F: a "good" complete v2 setup with healthy runtime proof.
const goodCfg = cfg({
  tags: [
    tag({ type: "gaawc", name: "GA4 Config", consentSettings: { consentStatus: "NEEDED" }, firingTriggerId: ["555"] }),
    tag({ type: "awct", name: "Ads Conversion", consentSettings: { consentStatus: "NEEDED" } }),
  ],
  triggers: [consentInitTrigger()],
  textBlob: blobWith({
    hasDefault: true,
    hasUpdate: true,
    fields: CONSENT_V2_FIELDS,
    passthrough: true,
    redaction: true,
    region: true,
  }),
});
const goodRt = rt([
  {
    requestedUrl: "https://e/",
    consentState: "default_denied",
    consentEvents: [{ kind: "default", tMs: 100, fields: { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" } }],
    firstMeasurementTMs: 300,
    trackerHits: [ga4Hit({ gcs: "G100", gcd: "11111", tMs: 300 })],
    cookies: [],
    dataLayerEvents: ["gtm.js", "gtm.dom", "gtm.load"],
  },
  {
    requestedUrl: "https://e/",
    consentState: "granted",
    consentEvents: [
      { kind: "default", tMs: 100, fields: { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" } },
      { kind: "update", tMs: 200 },
    ],
    firstMeasurementTMs: 300,
    trackerHits: [ga4Hit({ gcs: "G111", gcd: "11111", tMs: 300 })],
    cookies: [{ name: "_ga", tMs: 320 }],
    dataLayerEvents: ["gtm.js", "gtm.dom", "gtm.load", "consent_update"],
  },
]);

test("F01 good setup -> coverage reconciled", () => {
  assert.equal(runConsentAudit(goodCfg, goodRt).coverage, "reconciled");
});
test("F02 good setup -> no critical findings", () => {
  const r = runConsentAudit(goodCfg, goodRt);
  assert.ok(!r.findings.some((f) => f.severity === "critical"));
});
test("F03 good setup -> no high findings", () => {
  const r = runConsentAudit(goodCfg, goodRt);
  assert.ok(!r.findings.some((f) => f.severity === "high"));
});
test("F04 good setup -> no gcs-missing (all hits carry gcs)", () => {
  assert.ok(hasNo(runConsentAudit(goodCfg, goodRt).findings, "consent-runtime-gcs-missing"));
});
test("F05 good setup -> no vendor-denied", () => {
  assert.ok(hasNo(runConsentAudit(goodCfg, goodRt).findings, "consent-runtime-vendor-denied"));
});
test("F06 good setup -> no granted-nohit", () => {
  assert.ok(hasNo(runConsentAudit(goodCfg, goodRt).findings, "consent-runtime-granted-nohit"));
});
test("F07 good setup -> no measure-before-default", () => {
  assert.ok(hasNo(runConsentAudit(goodCfg, goodRt).findings, "consent-reconcile-measure-before-default"));
});
test("F08 good setup -> no no-update (update observed)", () => {
  assert.ok(hasNo(runConsentAudit(goodCfg, goodRt).findings, "consent-reconcile-no-update"));
});
test("F09 good setup -> stateCoverage denied+granted true, partial false", () => {
  const r = runConsentAudit(goodCfg, goodRt);
  assert.ok(r.stateCoverage.denied && r.stateCoverage.granted && !r.stateCoverage.partial);
});

// F: the "violations" scenario mirroring the v3-violations fixture.
const badCfg = cfg({
  tags: [tag({ type: "awct", name: "Meta CAPI", consentSettings: { consentStatus: "NEEDED" } })],
  textBlob: blobWith({ hasDefault: true, fields: ["analytics_storage"] }),
});
const badRt = rt([
  {
    requestedUrl: "https://shop.example/",
    finalUrl: "https://shop.example/",
    consentState: "default_denied",
    consoleErrors: ["Uncaught TypeError: cmp is not a function"],
    consentEvents: [{ kind: "default", tMs: 300 }],
    firstMeasurementTMs: 220,
    trackerHits: [ga4Hit({ tMs: 220 }), metaHit(240)],
    cookies: [{ name: "_fbp", tMs: 180 }, { name: "_ga", tMs: 230 }],
    dataLayerEvents: ["gtm.js", "gtm.dom"],
  },
]);

test("F10 bad scenario -> coverage reconciled", () => {
  assert.equal(runConsentAudit(badCfg, badRt).coverage, "reconciled");
});
test("F11 bad scenario -> has CRITICAL gating-vs-vendor", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-reconcile-gating-vs-vendor"));
});
test("F12 bad scenario -> has vendor-denied HIGH", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-runtime-vendor-denied"));
});
test("F13 bad scenario -> GA4 denied no-signal flagged", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-runtime-ga4-denied-nosignal"));
});
test("F14 bad scenario -> cookie-before-consent flagged", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-runtime-cookie-before"));
});
test("F15 bad scenario -> console error flagged", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-runtime-console"));
});
test("F16 bad scenario -> missing-fields config finding", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-config-missing-fields"));
});
test("F17 bad scenario -> reinforced missing-and-nosignal", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-reconcile-missing-and-nosignal"));
});
test("F18 bad scenario -> first finding is the critical one (sort)", () => {
  assert.equal(runConsentAudit(badCfg, badRt).findings[0].severity, "critical");
});
test("F19 bad scenario -> measure-before-default flagged (220 < 300)", () => {
  assert.ok(has(runConsentAudit(badCfg, badRt).findings, "consent-reconcile-measure-before-default"));
});
test("F20 bad scenario -> more findings than good scenario", () => {
  assert.ok(runConsentAudit(badCfg, badRt).findings.length > runConsentAudit(goodCfg, goodRt).findings.length);
});

// ════════════════════════════════════════════════════════════════════════════
// GROUP G — edge cases & conservatism guarantees
// ════════════════════════════════════════════════════════════════════════════

test("G01 unknown vendor group -> treated as vendor (manual-style high) under denial", () => {
  const hit: RuntimeHit = { url: "https://unknown.tracker/x", groups: ["mysterytracker"], query: {} };
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [hit] }]));
  assert.ok(has(f, "consent-runtime-vendor-denied"));
});
test("G02 gtm-only group is not a vendor hit", () => {
  const hit: RuntimeHit = { url: "https://gtm/x", groups: ["gtm"], query: {} };
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [hit] }]));
  assert.ok(hasNo(f, "consent-runtime-vendor-denied"));
});
test("G03 unknown consent state -> no denied/granted findings (conservative)", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "weird_state", trackerHits: [metaHit(), ga4Hit()] }]));
  assert.ok(hasNo(f, "consent-runtime-vendor-denied"));
  assert.ok(hasNo(f, "consent-runtime-granted-nohit"));
});
test("G04 empty pages array -> no runtime findings, no crash", () => {
  assert.equal(runConsentRuntimeRules(rt([])).length, 0);
});
test("G05 page with no trackerHits/cookies/errors -> no findings", () => {
  assert.equal(runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied" }])).length, 0);
});
test("G06 config with only NOT_NEEDED tags -> reconciled coverage (intent present)", () => {
  const r = runConsentAudit(
    cfg({ tags: [tag({ type: "gaawc", consentSettings: { consentStatus: "NOT_NEEDED" } })] }),
    rt([{ requestedUrl: "https://e/", consentState: "granted", trackerHits: [ga4Hit({ gcs: "G111" })] }]),
  );
  assert.equal(r.coverage, "reconciled");
});
test("G07 no consent intent + ok runtime with denied vendor -> runtime_imported but still flags vendor", () => {
  const r = runConsentAudit(cfg(), rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit()] }]));
  assert.equal(r.coverage, "runtime_imported");
  assert.ok(has(r.findings, "consent-runtime-vendor-denied"));
});
test("G08 hit with groups undefined -> not treated as ga4 or vendor", () => {
  const hit: RuntimeHit = { url: "https://x/y" };
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [hit] }]));
  assert.ok(hasNo(f, "consent-runtime-vendor-denied"));
  assert.ok(hasNo(f, "consent-runtime-gcs"));
});
test("G09 GA4 hit signal read from URL when query map absent", () => {
  const hit: RuntimeHit = { url: "https://www.google-analytics.com/g/collect?v=2&gcs=G100&gcd=11111", groups: ["ga4"] };
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [hit] }]));
  assert.ok(hasNo(f, "consent-runtime-ga4-denied-nosignal"));
});
test("G10 multiple denied vendors deduped in single finding id", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", trackerHits: [metaHit(), metaHit()] }]),
  );
  assert.equal(f.filter((x) => x.id.startsWith("consent-runtime-vendor-denied")).length, 1);
});
test("G11 ad-only denial (ads_granted_analytics_denied) GA4 nosignal -> denied-nosignal", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "ads_granted_analytics_denied", trackerHits: [ga4Hit()] }]),
  );
  assert.ok(has(f, "consent-runtime-ga4-denied-nosignal"));
});
test("G12 ads_granted_analytics_denied: vendor hit allowed (ads granted) -> no vendor-denied", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "ads_granted_analytics_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-vendor-denied"));
});
test("G13 config-only audit never emits RUNTIME-sourced findings", () => {
  const r = runConsentAudit(gatedCfg, null);
  assert.ok(r.findings.every((f) => !f.sources.includes("RUNTIME")));
});
test("G14 server-side container usageContext does not crash audit", () => {
  const r = runConsentAudit(cfg({ usageContexts: ["server"], textBlob: blobWith({ hasDefault: true, passthrough: true }) }), null);
  assert.ok(Array.isArray(r.findings));
});
test("G15 url_passthrough present alone still flags redaction+region missing", () => {
  const f = runConsentConfigRules(cfg({ textBlob: blobWith({ hasDefault: true, fields: CONSENT_V2_FIELDS, passthrough: true }) }));
  const p = has(f, "consent-config-passthrough")!;
  assert.ok(p.affected!.includes("ads_data_redaction"));
  assert.ok(p.affected!.includes("region"));
});
test("G16 cookie-before only triggers on tracking cookie names", () => {
  const f = runConsentRuntimeRules(
    rt([{ requestedUrl: "https://e/", consentState: "default_denied", consentEvents: [{ kind: "default", tMs: 200 }], cookies: [{ name: "lang", tMs: 50 }] }]),
  );
  assert.ok(hasNo(f, "consent-runtime-cookie-before"));
});
test("G17 _fbp cookie under denial flagged", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", cookies: [{ name: "_fbp" }] }]));
  assert.ok(has(f, "consent-runtime-cookie-before"));
});
test("G18 _gcl cookie under denial flagged", () => {
  const f = runConsentRuntimeRules(rt([{ requestedUrl: "https://e/", consentState: "default_denied", cookies: [{ name: "_gcl_au" }] }]));
  assert.ok(has(f, "consent-runtime-cookie-before"));
});
test("G19 audit with runtime ok but empty states -> stateCoverage all false", () => {
  const r = runConsentAudit(cfg({ textBlob: blobWith({ hasDefault: true }) }), { pages: [], states: [], ok: true });
  assert.deepEqual(r.stateCoverage, { denied: false, granted: false, partial: false });
});
test("G20 reconcile gating-vs-vendor needs ads denied (analytics-only denial -> none)", () => {
  const f = runConsentReconcileRules(
    gatedCfg,
    rt([{ requestedUrl: "https://e/", consentState: "ads_granted_analytics_denied", trackerHits: [metaHit()] }]),
  );
  assert.ok(hasNo(f, "consent-reconcile-gating-vs-vendor"));
});

// ── run summary ──────────────────────────────────────────────────────────--

const total = passed + failed;
console.log(`\nConsent Mode v2 engine — accuracy validation suite`);
console.log(`  cases run:    ${total}`);
console.log(`  passed:       ${passed}`);
console.log(`  failed:       ${failed}`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
if (total < 100) {
  console.error(`\n✗ Expected at least 100 validation cases, only ${total} ran.`);
  process.exit(1);
}
console.log(`\n✓ All ${total} consent-audit validation cases passed (>= 100 required).`);
