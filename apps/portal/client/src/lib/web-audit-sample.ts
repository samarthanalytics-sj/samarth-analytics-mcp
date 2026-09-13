import type { WebAuditReport } from "@shared/web-audit-report";

/**
 * Synthetic demo report for the Web Audit page's "Use sample" button. Not real
 * audit evidence — it illustrates the rendering of a non-compliant site (tags
 * before consent, a pre-ticked opt-in, a missing first-layer reject). Loaded
 * dynamically so it never weighs down the page chunk.
 */
export const WEB_AUDIT_SAMPLE: WebAuditReport = {
  site: "https://demo.example.com",
  auditedAt: "2026-06-15T10:24:00.000Z",
  score: 41,
  verdict: "poor",
  summary: {
    pagesCrawled: 5,
    pagesCaptured: 3,
    scenariosRun: ["ignore", "reject", "accept"],
    cmp: { detected: true, vendor: "Custom / unknown CMP", rejectOnFirstLayer: false },
    formsFound: 3,
    consentCoverage: "runtime_only",
    findingCounts: { critical: 1, high: 1, medium: 2, low: 0, info: 1 },
  },
  notes: [],
  captures: [
    {
      scenario: "ignore",
      url: "https://demo.example.com/",
      httpStatus: 200,
      trackerHits: 9,
      firingHits: 4,
      consentEvents: 0,
      interactionClicked: null,
      notes: [],
    },
    {
      scenario: "reject",
      url: "https://demo.example.com/",
      httpStatus: 200,
      trackerHits: 11,
      firingHits: 5,
      consentEvents: 0,
      interactionClicked: true,
      notes: [],
    },
    {
      scenario: "accept",
      url: "https://demo.example.com/",
      httpStatus: 200,
      trackerHits: 14,
      firingHits: 8,
      consentEvents: 1,
      interactionClicked: true,
      notes: [],
    },
  ],
  findings: [
    {
      id: "banner_preconsent_fire_home",
      domain: "banner",
      severity: "critical",
      confidence: "high",
      finding:
        "4 tracker hit(s) fired before the user made any consent choice on https://demo.example.com/.",
      whyItMatters:
        "The banner is cosmetic if tags fire anyway: consent must be obtained BEFORE trackers run (GDPR Art. 6/7, ePrivacy 5(3)).",
      suggestedFix:
        "Block these tags until consent — use consent-aware triggers / Consent Mode and verify the CMP pushes the default before the container loads.",
      evidence: [
        "[ga4] t+420ms https://region1.google-analytics.com/g/collect?v=2&tid=G-DEMO&en=page_view",
        "[meta] t+610ms https://www.facebook.com/tr?id=000&ev=PageView",
      ],
      page: "https://demo.example.com/",
    },
    {
      id: "banner_cookies_after_reject_home",
      domain: "banner",
      severity: "high",
      confidence: "high",
      finding:
        "Tracking cookies (_ga, _fbp) present after consent was rejected on https://demo.example.com/.",
      whyItMatters:
        "Identifiers set despite refusal contradict the recorded consent state and are direct evidence in complaints/audits.",
      suggestedFix:
        "Gate the cookie-setting tags behind consent and have the CMP delete known tracking cookies on reject.",
      page: "https://demo.example.com/",
    },
    {
      id: "banner_no_reject_first_layer",
      domain: "banner",
      severity: "medium",
      confidence: "medium",
      finding:
        'The consent banner offers "Accept" on the first layer but no equally easy "Reject".',
      whyItMatters:
        "EDPB guidance and several DPAs require rejecting to be as easy as accepting; accept-only first layers invalidate consent.",
      suggestedFix:
        'Add a "Reject all" button on the first banner layer with the same prominence as "Accept all".',
    },
    {
      id: "forms_home_form_0_prechecked_marketing",
      domain: "forms",
      severity: "medium",
      confidence: "medium",
      finding:
        'A newsletter form has a pre-ticked marketing opt-in ("Subscribe to our newsletter").',
      whyItMatters:
        "GDPR/ePrivacy require unticked, affirmative opt-in. A pre-ticked box is not valid consent.",
      suggestedFix:
        "Render the marketing checkbox unticked by default and record the opt-in with a timestamp.",
      page: "https://demo.example.com/",
    },
    {
      id: "advanced_pings_info",
      domain: "consent",
      severity: "info",
      confidence: "high",
      finding: "GA4 sent cookieless consent-mode pings (gcs denied) before a choice.",
      whyItMatters:
        'This is "advanced consent mode" behaviour — cookieless pings for modelling, generally accepted but worth confirming you intend it.',
      suggestedFix:
        "If you want zero pre-consent requests, switch to basic consent mode (load gtag only after consent).",
    },
  ],
};
