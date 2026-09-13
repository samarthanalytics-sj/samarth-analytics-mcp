/**
 * A synthetic runtime-capture artifact for demoing the audit's RUNTIME source.
 *
 * IMPORTANT: this is NOT real audit evidence. It is a hand-authored fixture that
 * matches the `samarth.runtime-capture/v3` multi-state shape the audit engine
 * parses (see parseRuntimeCapture in apps/portal/api/gtm/audit.ts). It exists so
 * a user can see what a populated coverage matrix / Consent Mode proof looks like
 * without standing up the runtime worker. The audit marks runtime rows
 * Partial/Covered from whatever this artifact contains — so it must never be
 * presented as a verified capture of the user's own site.
 */
export const SAMPLE_RUNTIME_CAPTURE = {
  schema: "samarth.runtime-capture/v3",
  capturedAt: "2026-01-01T00:00:00.000Z",
  notes: [
    "SAMPLE artifact — synthetic data for demonstration only.",
    "Not a real capture of any site. Replace with a runtime-worker / CLI capture for a real audit.",
  ],
  requestedUrls: ["https://example.com/", "https://example.com/checkout"],
  states: [
    {
      state: "default_denied",
      pages: [
        {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          consentState: "default_denied",
          dataLayerEvents: ["consent_default", "page_view"],
          dataLayerKeys: ["event", "gtm.start", "consent"],
          consentEvents: [
            {
              kind: "default",
              tMs: 12,
              fields: {
                ad_storage: "denied",
                analytics_storage: "denied",
                ad_user_data: "denied",
                ad_personalization: "denied",
              },
            },
          ],
          trackerHits: [
            {
              url: "https://www.google-analytics.com/g/collect?v=2&gcs=G100",
              method: "GET",
              matched: ["ga4_collect"],
              groups: ["ga4"],
              query: { gcs: "G100" },
              tMs: 480,
            },
          ],
          cookies: [],
          firstMeasurementTMs: 480,
          consoleErrors: [],
          pageErrors: [],
          sgtmCandidates: [{ url: "https://sgtm.example.com/g/collect" }],
        },
      ],
    },
    {
      state: "granted",
      pages: [
        {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          consentState: "granted",
          dataLayerEvents: ["consent_update", "page_view", "view_item"],
          dataLayerKeys: ["event", "consent", "ecommerce"],
          consentEvents: [
            {
              kind: "update",
              tMs: 950,
              fields: {
                ad_storage: "granted",
                analytics_storage: "granted",
                ad_user_data: "granted",
                ad_personalization: "granted",
              },
            },
          ],
          trackerHits: [
            {
              url: "https://www.google-analytics.com/g/collect?v=2&gcs=G111&en=page_view",
              method: "GET",
              matched: ["ga4_collect"],
              groups: ["ga4"],
              query: { gcs: "G111", en: "page_view" },
              tMs: 520,
            },
            {
              url: "https://sgtm.example.com/g/collect?v=2&en=view_item",
              method: "GET",
              matched: ["ga4_collect"],
              groups: ["ga4"],
              query: { en: "view_item" },
              tMs: 610,
            },
          ],
          cookies: [{ name: "_ga", tMs: 540 }, { name: "_ga_XXXX", tMs: 540 }],
          firstMeasurementTMs: 520,
          consoleErrors: [],
          pageErrors: [],
          sgtmCandidates: [{ url: "https://sgtm.example.com/g/collect" }],
        },
        {
          requestedUrl: "https://example.com/checkout",
          finalUrl: "https://example.com/checkout",
          consentState: "granted",
          dataLayerEvents: ["page_view", "begin_checkout", "purchase"],
          dataLayerKeys: ["event", "ecommerce"],
          consentEvents: [],
          trackerHits: [
            {
              url: "https://sgtm.example.com/g/collect?v=2&en=purchase",
              method: "GET",
              matched: ["ga4_collect"],
              groups: ["ga4"],
              query: { en: "purchase" },
              tMs: 700,
            },
            {
              url: "https://www.facebook.com/tr?ev=Purchase&eid=evt_abc123",
              method: "GET",
              matched: ["meta_pixel"],
              groups: ["meta"],
              query: { ev: "Purchase", eid: "evt_abc123" },
              tMs: 720,
            },
          ],
          cookies: [{ name: "_fbp", tMs: 705 }],
          firstMeasurementTMs: 700,
          consoleErrors: [],
          pageErrors: [],
          sgtmCandidates: [{ url: "https://sgtm.example.com/g/collect" }],
        },
      ],
    },
    {
      state: "analytics_granted_ads_denied",
      pages: [
        {
          requestedUrl: "https://example.com/",
          finalUrl: "https://example.com/",
          consentState: "analytics_granted_ads_denied",
          dataLayerEvents: ["consent_update", "page_view"],
          dataLayerKeys: ["event", "consent"],
          consentEvents: [
            {
              kind: "update",
              tMs: 900,
              fields: {
                ad_storage: "denied",
                analytics_storage: "granted",
                ad_user_data: "denied",
                ad_personalization: "denied",
              },
            },
          ],
          trackerHits: [
            {
              url: "https://www.google-analytics.com/g/collect?v=2&gcs=G101",
              method: "GET",
              matched: ["ga4_collect"],
              groups: ["ga4"],
              query: { gcs: "G101" },
              tMs: 500,
            },
          ],
          cookies: [{ name: "_ga", tMs: 520 }],
          firstMeasurementTMs: 500,
          consoleErrors: [],
          pageErrors: [],
          sgtmCandidates: [{ url: "https://sgtm.example.com/g/collect" }],
        },
      ],
    },
  ],
  summary: {
    pages: 4,
    groups: { ga4: 5, meta: 1 },
    consoleErrors: 0,
    pageErrors: 0,
  },
} as const;

/** Pretty-printed JSON of the sample capture, for the paste-area / download. */
export const SAMPLE_RUNTIME_CAPTURE_JSON = JSON.stringify(
  SAMPLE_RUNTIME_CAPTURE,
  null,
  2,
);
