/**
 * Anonymized, SYNTHETIC GTM container fixtures for golden/snapshot tests.
 *
 * ⚠️  No real client data is committed here. These containers are hand-authored
 * to mirror the *shapes and patterns* seen in real GTM exports (tag types,
 * parameter keys, trigger ids, consent settings) without reproducing any actual
 * account's contents. Public ids use the reserved GTM-XXXXXXX placeholder form,
 * measurement ids use G-XXXXXXX, and all names are generic. Treat these as
 * representative-but-fictional.
 *
 * They are consumed by audit-snapshot.node.test.ts, which feeds them through the
 * real shared consent engine (../consent-audit) and the real accuracy normalizer
 * (../audit-accuracy) — the exact pure cores the production routes use — and
 * snapshots the result to lock in the public-SaaS accuracy invariants:
 *   - findings are source-scoped (CONFIG vs RUNTIME),
 *   - CONFIG-only confidence is capped at medium,
 *   - structured evidence[] is always present,
 *   - a CONFIG-only run makes no observed-runtime claims.
 */

import type {
  ConsentConfigInput,
  ConsentTag,
  ConsentTrigger,
  ConsentVariable,
  RuntimeInput,
  RuntimePage,
  RuntimeHit,
} from "../../consent-audit";

const ALL_PAGES_TRIGGER_ID = "2147479553";

/** Build the lower-cased text blob the engine scans, mirroring the route. */
function blobFor(
  tags: ConsentTag[],
  variables: ConsentVariable[],
  extra: string[] = [],
): string {
  const parts: string[] = [...extra];
  const walkParams = (ps: ConsentTag["parameter"]): void => {
    for (const p of ps ?? []) {
      if (p.key) parts.push(p.key);
      if (p.value) parts.push(p.value);
      walkParams(p.list);
      walkParams(p.map);
    }
  };
  for (const t of tags) {
    parts.push(t.name ?? "", t.type ?? "");
    walkParams(t.parameter);
  }
  for (const v of variables) {
    parts.push(v.name ?? "", v.type ?? "");
    walkParams(v.parameter);
  }
  return parts.join("\n").toLowerCase();
}

// ── Fixture A: web container, CONFIG only, consent gaps ─────────────────────
// A realistic small web container: a GA4 config tag, two GA4 event tags, a Meta
// pixel via custom HTML, and an Ads conversion — none with per-tag consent
// settings, and no Consent Initialization trigger. This is the dominant
// real-world "config looks busy, consent not wired" shape.

const FIXTURE_A_TAGS: ConsentTag[] = [
  {
    tagId: "10",
    name: "GA4 - Config",
    type: "googtag",
    firingTriggerId: [ALL_PAGES_TRIGGER_ID],
    parameter: [{ type: "template", key: "tagId", value: "G-XXXXXXX" }],
  },
  {
    tagId: "11",
    name: "GA4 - page_view",
    type: "gaawe",
    firingTriggerId: [ALL_PAGES_TRIGGER_ID],
    parameter: [
      { type: "template", key: "eventName", value: "page_view" },
      { type: "tagReference", key: "measurementId", value: "{{GA4 - Config}}" },
    ],
  },
  {
    tagId: "12",
    name: "GA4 - generate_lead",
    type: "gaawe",
    firingTriggerId: ["30"],
    parameter: [
      { type: "template", key: "eventName", value: "generate_lead" },
      { type: "tagReference", key: "measurementId", value: "{{GA4 - Config}}" },
    ],
  },
  {
    tagId: "13",
    name: "Meta Pixel - Base",
    type: "html",
    firingTriggerId: [ALL_PAGES_TRIGGER_ID],
    parameter: [
      {
        type: "template",
        key: "html",
        value: "<script>fbq('init','000000000000000');fbq('track','PageView');</script>",
      },
    ],
  },
  {
    tagId: "14",
    name: "Google Ads - Conversion",
    type: "awct",
    firingTriggerId: ["30"],
    parameter: [
      { type: "template", key: "conversionId", value: "AW-XXXXXXXXX" },
      { type: "template", key: "conversionLabel", value: "abcDEF123" },
    ],
  },
];

const FIXTURE_A_TRIGGERS: ConsentTrigger[] = [
  { triggerId: "30", name: "CTA - Lead submit", type: "click" },
];

const FIXTURE_A_VARIABLES: ConsentVariable[] = [
  { variableId: "50", name: "DLV - lead_value", type: "v" },
];

export const FIXTURE_A_CONFIG_ONLY_WEB: {
  label: string;
  containerPublicId: string;
  usageContext: string[];
  config: ConsentConfigInput;
} = {
  label: "web-config-only-consent-gaps",
  containerPublicId: "GTM-XXXXXXX",
  usageContext: ["web"],
  config: {
    tags: FIXTURE_A_TAGS,
    triggers: FIXTURE_A_TRIGGERS,
    variables: FIXTURE_A_VARIABLES,
    usageContexts: ["web"],
    textBlob: blobFor(FIXTURE_A_TAGS, FIXTURE_A_VARIABLES),
  },
};

// ── Fixture B: web container WITH a runtime capture (reconcilable) ───────────
// Same container plus a small runtime capture under a "default_denied" state.
// The captured GA4 hit carries gcs/gcd Consent Mode params, so the engine can
// reconcile config intent against observed signals — exercising RUNTIME-sourced
// and reconcile-layer findings (high confidence, proof-backed).

function ga4Hit(opts: { gcs?: string; gcd?: string; tMs?: number }): RuntimeHit {
  const q: Record<string, string> = { v: "2", tid: "G-XXXXXXX", en: "page_view" };
  if (opts.gcs) q.gcs = opts.gcs;
  if (opts.gcd) q.gcd = opts.gcd;
  return {
    url: `https://www.google-analytics.com/g/collect?${Object.entries(q)
      .map(([k, v]) => `${k}=${v}`)
      .join("&")}`,
    method: "POST",
    groups: ["ga4"],
    matched: ["ga4_collect"],
    query: q,
    tMs: opts.tMs,
  };
}

const FIXTURE_B_PAGES: RuntimePage[] = [
  {
    requestedUrl: "https://example.test/",
    finalUrl: "https://example.test/",
    consentState: "default_denied",
    consoleErrors: [],
    pageErrors: [],
    trackerHits: [ga4Hit({ gcs: "G100", gcd: "11111", tMs: 850 })],
    dataLayerEvents: ["consent_default", "gtm.js", "page_view"],
    dataLayerKeys: ["event", "gtm"],
    consentEvents: [
      {
        kind: "default",
        tMs: 120,
        fields: {
          ad_storage: "denied",
          analytics_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
        },
      },
    ],
    cookies: [{ name: "_ga", tMs: 900 }],
    firstMeasurementTMs: 850,
  },
  // A second page under the same denied state whose GA4 hit carries NO gcs/gcd —
  // a realistic "consent wiring missed on one template" shape. This is what makes
  // the engine emit a high-confidence RUNTIME-sourced finding (proof-backed),
  // exercising the source-scoping invariants for observed behaviour.
  {
    requestedUrl: "https://example.test/pricing",
    finalUrl: "https://example.test/pricing",
    consentState: "default_denied",
    consoleErrors: [],
    pageErrors: [],
    trackerHits: [ga4Hit({ tMs: 700 })],
    dataLayerEvents: ["gtm.js", "page_view"],
    dataLayerKeys: ["event", "gtm"],
    consentEvents: [],
    cookies: [{ name: "_ga", tMs: 760 }],
    firstMeasurementTMs: 700,
  },
];

export const FIXTURE_B_RECONCILE_WEB: {
  label: string;
  containerPublicId: string;
  usageContext: string[];
  config: ConsentConfigInput;
  runtime: RuntimeInput;
} = {
  label: "web-runtime-reconcile",
  containerPublicId: "GTM-YYYYYYY",
  usageContext: ["web"],
  config: {
    tags: FIXTURE_A_TAGS,
    triggers: [...FIXTURE_A_TRIGGERS, { triggerId: "t1", name: "Consent Initialization", type: "consentInit" }],
    variables: FIXTURE_A_VARIABLES,
    usageContexts: ["web"],
    textBlob: blobFor(FIXTURE_A_TAGS, FIXTURE_A_VARIABLES, [
      "gtag('consent','default',{",
      "ad_storage:'denied'",
      "analytics_storage:'denied'",
      "ad_user_data:'denied'",
      "ad_personalization:'denied'",
      "wait_for_update:500",
      "region:['es','de']",
    ]),
  },
  runtime: {
    capturedAt: "2026-06-01T00:00:00.000Z",
    pages: FIXTURE_B_PAGES,
    states: ["default_denied"],
    ok: true,
  },
};

export const ALL_FIXTURES = [
  FIXTURE_A_CONFIG_ONLY_WEB,
  FIXTURE_B_RECONCILE_WEB,
] as const;
