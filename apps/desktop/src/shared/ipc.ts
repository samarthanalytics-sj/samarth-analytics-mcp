// Shared IPC DTOs — imported (type-only) by main, preload, and renderer.
//
// IMPORTANT: these are the ONLY account shapes the renderer ever sees. They
// carry no secret bytes and no secret refs — `hasGoogleToken` / `hasApiKey` are
// booleans derived in the main process. Keeping secrets out of these types is
// the type-level guarantee behind "the renderer never receives tokens or keys".

// TYPE-ONLY import (erased at build) of the structured install plan attached to a
// form suggestion — mirrors how the other web-audit tag-suggest types are pulled
// into the main/shared layer. Carries no runtime dependency into the renderer.
import type { InstallPlan } from '../../../web-audit-mcp/src/agent/tag-suggest/install-plan';

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';
export type GoogleProduct = 'gtm' | 'ga4';

/** Which ad platforms a Tag Suggestions scan generates tags for (mirrors web-audit's SuggestPlatform,
 *  declared locally so the renderer/shared layer stays dependency-free). Any subset may be selected;
 *  each maps the SAME detected elements to its own tags, sharing one trigger per detection. */
export type SuggestPlatform = 'ga4' | 'meta' | 'google_ads' | 'tiktok' | 'linkedin' | 'reddit' | 'pinterest';

/** The classified intent of a CTA (mirrors web-audit's CtaIntent, declared locally so the
 *  renderer/shared layer stays dependency-free). Carried on a CTA-derived SuggestedTagView so the
 *  platform derivations map by intent (authoritative) rather than the event-name text. */
export type CtaIntent =
  | 'add_to_cart' | 'subscribe' | 'book_demo' | 'request_quote' | 'contact_sales'
  | 'contact' | 'download' | 'get_started' | 'login' | 'search' | 'learn_more' | 'faq' | 'generic';

export interface LlmConfigView {
  provider: LlmProvider;
  model: string;
  /** Whether an API key is stored (encrypted) for this account. Never the key. */
  hasApiKey: boolean;
}

export interface AccountView {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  isActive: boolean;
  /** Whether a Google OAuth token is vaulted for this account (set in Phase 2). */
  hasGoogleToken: boolean;
  lastProduct?: GoogleProduct;
  llm?: LlmConfigView;
  /** Remembered GTM account/container/workspace selection. */
  gtmContext?: GtmContext;
  ga4Context?: Ga4Context;
}

export interface AddAccountInput {
  email: string;
  displayName?: string;
}

/** Which app-level LLM providers have an API key stored. */
export type ProviderStatus = Record<LlmProvider, boolean>;

export interface SecretSelfTest {
  ok: boolean;
  detail: string;
  encryptionAvailable: boolean;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatReply {
  text: string;
  /** Tools the model invoked while answering (for display). */
  toolCalls: ChatToolCall[];
}

/** Incremental events pushed during a streaming chat. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'tool_result'; name: string; ok: boolean; error?: string }
  | {
      type: 'confirm';
      confirmId: string;
      tool: string;
      summary: string;
      details: Record<string, unknown>;
      destructive?: boolean;
      /** When set, the approval card requires typing this word (e.g. "delete") to approve. */
      requireTextConfirm?: string;
    };

export interface GtmAccountView {
  accountId: string;
  name: string;
  path: string;
}

export interface GtmContainerView {
  containerId: string;
  name: string;
  publicId: string;
  path: string;
  /** GTM usage contexts (e.g. ['web'] or ['server']) — lets pickers filter server containers. */
  usageContext?: string[];
}

export interface GtmWorkspaceView {
  workspaceId: string;
  name: string;
  path: string;
}

/** The GTM account/container/workspace the user is currently working in. */
/** Which GA4 property the GA4 chat works against (the GA4 mirror of GtmContext). */
export interface Ga4Context {
  /** "properties/123456" */
  property?: string;
  propertyName?: string;
  /** Display name of the parent GA4 account (for the breadcrumb). */
  accountName?: string;
}

export interface GtmContext {
  accountId?: string;
  accountName?: string;
  containerId?: string;
  containerName?: string;
  /** The container's public id "GTM-XXXXXXX" — how users identify a container (vs the numeric id). */
  containerPublicId?: string;
  workspaceId?: string;
  workspaceName?: string;
}

/** Result of creating a SERVER container from a web container (gtm:createServerContainer). */
export interface ServerContainerResultView {
  serverContainer: { containerId: string; publicId: string; name: string; taggingServerUrls: string[] };
  workspaceId: string;
  measurementId: string;
  created: { client: string; trigger: string; serverTag: string };
  serverUrlSet: boolean;
  webWired: { tagId: string; name: string } | null;
  /** Non-GA4 conversion tags found in the web container that still need a server-side tag by hand. */
  webNonGa4: Array<{ kind: string; name: string; detail: string }>;
}

export interface Ga4AccountView {
  account: string;
  displayName: string;
  propertyCount: number;
}

/* ── GA4 property audit (the "GA4 Audit" panel) ── */
/** A GA4 property in the panel's picker — flattened across all accessible accounts. */
export interface Ga4PropertyListItem {
  property: string; // "properties/123456"
  displayName: string;
  accountName: string;
}
/** One advisory GA4 audit finding (config or data-quality). GA4 is read-only — no auto-fix. */
export interface Ga4AuditFindingView {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
  recommendation?: string;
}
/** Per-area coverage for the audit (Pass / Partial / Fail / Not Verified). */
export interface Ga4AreaStatusView {
  area: string;
  status: 'pass' | 'partial' | 'fail' | 'not_verified';
}
/** GA4 property CONFIG audit (mirrors the main-process Ga4AuditReport). */
export interface Ga4AuditReportView {
  counts: { dataStreams: number; keyEvents: number; customDimensions: number; customMetrics: number; findings: number };
  summary: { high: number; medium: number; low: number; info: number };
  findings: Ga4AuditFindingView[];
  /** Coverage table — what was checked + its status. */
  areas: Ga4AreaStatusView[];
}
/** GA4 DATA-QUALITY audit over a chosen window (mirrors Ga4DataQualityResult). */
export interface Ga4DataQualityView {
  totalSessions: number;
  windowDays: number;
  startDate?: string;
  endDate?: string;
  /** Human span e.g. "Jan 1 – Jan 28, 2026", or null if the dates are unavailable. */
  dateRange: string | null;
  findings: Ga4AuditFindingView[];
}
/** Per-category row of the weighted scorecard (subscore null = Not Verified, excluded from the composite). */
export interface Ga4ScorecardCategoryView {
  name: string;
  subscore: number | null;
  weight: number;
  /** Renormalised weight over the VERIFIED categories (0..1; 0 when Not Verified) — the
   *  redistribution the scorecard footnote honours; scored categories sum to 1. */
  effectiveWeight: number;
  contribution: number;
  status: string;
}
/** One row of the Data Trust Matrix — what a client can safely quote from this audit. */
export interface Ga4TrustRowView {
  metric: string;
  /** PASS-GATED verdict: safe only when every gating check passed; a missing/unverified gate is
   *  'unverified' (never safe); a failed gate is 'do_not_quote'; a partial gate is 'caution'. */
  verdict: 'safe' | 'caution' | 'unverified' | 'do_not_quote';
  /** verdict === 'safe'. */
  safe: boolean;
  reason: string;
}
/** Structured Executive Summary — renders as the designed card panel on-screen and the styled
 *  PDF/Word export, from one rule-based computation. */
export interface Ga4ExecSummaryView {
  propertyName: string;
  propertyId: string;
  auditId: string;
  /** The selected audit window: human date range + day count, e.g. "Apr 1 – Jun 29, 2026 (90 days)". */
  dateRange: string;
  composite: number | null;
  grade: string;
  reliabilityPct: number;
  reliabilityConfidence: string;
  /** Critical metrics (conversions/revenue) that capped the reliability headline; empty = uncapped. */
  reliabilityCappedBy: string[];
  /** Itemized receipt for the headline (biggest loss first): which metric is losing points, the
   *  SPECIFIC gate responsible, and the action that recovers them - so a low number always reads as
   *  the property's verification state, never as the tool's judgement. */
  reliabilityWhy: Array<{ metric: string; weightPct: number; lostPts: number; verdict: string; cause: string; fix: string }>;
  verdict: string;
  biggestRisk: string;
  highestImpactFix: string;
  coverage: { checked: number; partial: number; notVerified: number };
  categories: Ga4ScorecardCategoryView[];
  trust: Ga4TrustRowView[];
}
/** Visualisations payload: the daily sessions trend line + colourful device/channel breakdowns. */
export interface Ga4VisualsView {
  /** Headline metric cards (current window vs prior): formatted value + signed delta % + the Data
   *  Trust Matrix verdict for that metric, so a green arrow never over-claims an unverified number.
   *  deltaPct null = no prior-window data to compare against. */
  metrics?: Array<{ label: string; value: string; prior: string; deltaPct: number | null; verdict: 'safe' | 'caution' | 'unverified' | 'do_not_quote' }>;
  daily: Array<{ date: string; sessions: number }>;
  peakIndex: number;
  trendLabel: string;
  trendSummary: string;
  /** Top channels' daily sessions (aligned date axis) for the per-channel multi-line chart. */
  channelDaily: Array<{ channel: string; series: Array<{ date: string; sessions: number }> }>;
  devices: Array<{ name: string; sessions: number }>;
  channels: Array<{ name: string; sessions: number }>;
  /** Peak-day driving channel (same source the chart marker + trend summary use) for the insights
   *  panel, so the three never disagree. dayShare/windowShare are 0-1 fractions. */
  drivingChannel: { name: string; dayShare: number; windowShare: number } | null;
  /** Whether channel attribution is safe to quote (Data Trust Matrix); false greys the channel charts. */
  channelTrusted: boolean;
  /** Verdict-aware caveat shown when channelTrusted is false — a FAILED channel gate reads
   *  "material share of sessions lack source data"; an UNVERIFIED one must NOT assert measured
   *  loss and says the split is unverified instead. Null when trusted. */
  channelCaveat: string | null;
}
/** One finding as a colour-coded card (section 4). */
export interface Ga4FindingCardView {
  severity: string; // critical | high | medium | low | info
  area: string;
  message: string;
  businessRisk: string;
  recommendation: string;
  /** Verification state, orthogonal to severity: confirmed | unconfirmed | blocked. Drives the
   *  Section-4 state chip so an inference-heavy read isn't shown as an established fact. */
  state?: 'confirmed' | 'unconfirmed' | 'blocked';
}
/** Structured body sections (2-4 so far) for the designed card panel + styled export, mirroring the
 *  markdown report so the on-screen panel and the PDF render the same content as Section 1. */
export interface Ga4SectionsView {
  /** Section 2 — the single highest-severity ("what is wrong") finding, expanded. */
  topFinding: {
    severity: string;
    area: string;
    message: string;
    evidence?: string;
    whyItMatters?: string;
    ifUnconfirmed?: string;
    recommendation?: string;
    related?: string;
  } | null;
  /** Shown in section 2 when there is no actionable finding. */
  noIssueNote: string | null;
  /** Section 3 — outcomes (sessions/key-events/revenue growth) vs traffic. */
  outcomes: {
    assessed: boolean;
    sessionsPct: number | null;
    keyEventsPct: number | null;
    revenuePct: number | null;
    /** Formatted from→to counts for each bar's data-point label (prior period → this period); null when
     *  growth wasn't assessed. */
    sessionsFrom: string | null;
    sessionsTo: string | null;
    keyEventsFrom: string | null;
    keyEventsTo: string | null;
    revenueFrom: string | null;
    revenueTo: string | null;
    keSafe: boolean;
    revSafe: boolean;
    sesSafe: boolean;
    /** Verdict-aware caveat line (null when key events + revenue are quotable): distinguishes a
     *  FAILED gate ("not safe to quote") from an UNVERIFIED one ("confirm before quoting"). */
    quoteNote: string | null;
    read: string;
    trendPattern: string | null;
    /** One-line RESTATED window total with the single-bucket burst excluded (the quotable number
     *  while the burst is unexplained); null when no concentration spike fired. */
    restated: string | null;
    /** "What changed by channel": top movers vs the prior period - the headline delta decomposed.
     *  Empty when the prior per-channel slice is unavailable. deltaPct null = channel is new. */
    drivers: Array<{ channel: string; from: string; to: string; delta: string; deltaPct: number | null }>;
  } | null;
  /** Section 4 — every finding, highest severity first. */
  findings: Ga4FindingCardView[];
  /** Section 4 — "Blocked by verification": checks that could not run this window (unmeasured, not a
   *  clean pass). Rendered as a distinct blocked-state group; kept out of the severity counts. */
  blocked?: Array<{ area: string; message: string; recommendation: string }>;
  actionableCount: number;
  /** Section 5 — area coverage (status + confidence + evidence). */
  areas: Array<{ area: string; statusKey: string; confidence: string; evidence: string }>;
  /** Section 6 — property baseline context. */
  baseline: {
    sessions: string;
    priorSessions: string;
    trend: string;
    growth: { sessionsPct: number | null; keyEventsPct: number | null; revenuePct: number | null; keSafe: boolean; revSafe: boolean } | null;
    peakDay: string | null;
    newVsReturning: string;
    topMarkets: string | null;
    /** Engagement one-liner: avg engagement time/session, engaged-session rate, engaged sessions/user. */
    engagement: string | null;
    /** Weekly-retention cohort headline (Week 1 / Week 4), or null when there isn't enough data. */
    retention: string | null;
  } | null;
  /** Section 6 — per-channel performance (conversion rate + revenue per channel, not just share). */
  channelPerformance: Array<{ channel: string; sessions: string; convRate: string; revenue: string; engagement: string }>;
  /** Section 6 — top landing pages (entry-page conversion rate + revenue: which pages convert/leak). */
  landingPages: Array<{ page: string; sessions: string; convRate: string; revenue: string; engagement: string }>;
  /** Section 6 — device performance (how each device type converts and spends). */
  devicePerformance: Array<{ device: string; sessions: string; convRate: string; revenue: string; engagement: string }>;
  /** Section 6 — market performance (which geographies convert and spend). */
  geoPerformance: Array<{ country: string; sessions: string; convRate: string; revenue: string; engagement: string }>;
  /** Section 6 — marketing-campaign performance (tagged utm_campaign traffic ranked by the campaign
   *  engine), the top campaign, and the untagged-traffic share. null = no utm_campaign-tagged traffic.
   *  `conversions` is the KEY-EVENT count (rendered as "Key events", never as sales); `purchases` is the
   *  real transaction count ('—' when not fetched); `caveat` is the mandatory guardrail footnote. */
  campaignPerformance: { rows: Array<{ campaign: string; sessions: string; conversions: string; purchases: string; revenue: string; engagement: string }>; best: string | null; untaggedShare: string; caveat: string } | null;
  /** Section 6 — AI/LLM referral-traffic performance + its share of all sessions. null = no AI traffic. */
  llmTraffic: { rows: Array<{ source: string; sessions: string; convRate: string; revenue: string; engagement: string }>; share: string } | null;
  /** Section 6 — top products by ITEM revenue (item-scoped metrics; the caveat is mandatory).
   *  null = non-ecommerce property or the item query returned nothing. */
  productPerformance: { rows: Array<{ item: string; viewed: string; addedToCart: string; purchased: string; viewToBuy: string; revenue: string }>; caveat: string } | null;
  /** Section 6 — rule-based "Key insights" bullets (peaks/lows, top performers, the near-100%-conv flag). */
  insights: string[];
  /** Section 6 — true when the conversion-rate/revenue columns of the performance tables lean on a
   *  metric the Data Trust Matrix hasn't confirmed, so the renderer flags them as provisional. */
  perfProvisional?: boolean;
  /** Section 6 — ecommerce funnel step reach (users per step + step conversion + depth). An event-
   *  coverage approximation, not a strict sequential funnel. null when the property has no view_item. */
  funnel: { steps: Array<{ label: string; users: string; pctEntry: string; stepConv: string }>; overall: string } | null;
  /** Section 7 — decision readiness (which business questions the data can answer). */
  decisions: Array<{ q: string; status: string; note: string }>;
  /** Section 8 — what was not verified, and what gates sign-off. */
  notVerified: { gate: string; items: Array<{ item: string; blocks: string }> };
  /** Section 9 — scope & metadata appendix. */
  scope: {
    auditId: string;
    composite: number | null;
    grade: string;
    reliabilityPct: number;
    window: string;
    retention: string;
    timezone: string;
    currency: string;
    generated: string;
    property: string;
    limitations: string;
    findings: { critical: number; high: number; medium: number; low: number; info: number };
    footer: string;
  };
}
/** Combined GA4 property audit (config + data quality) returned to the GA4 Audit panel. */
export interface Ga4PropertyAuditResult {
  config: Ga4AuditReportView;
  dataQuality: Ga4DataQualityView;
  /** Full templated audit as a Markdown document (rendered in the panel + downloadable). */
  markdown: string;
  /** Structured Executive Summary for the designed card panel + styled export. */
  exec: Ga4ExecSummaryView;
  /** Charts payload (daily trend line + colourful bars) for the panel + PDF. */
  visuals: Ga4VisualsView;
  /** Structured body sections (2-4) for the designed card panel + styled export. */
  sections: Ga4SectionsView;
}
/** The data-quality window for a GA4 audit: a count of trailing days (default 28), or an explicit
 *  custom range (YYYY-MM-DD, inclusive, interpreted in the property's timezone). */
export type Ga4AuditWindow = number | { startDate: string; endDate: string };

/* ── Tag suggestions (the "measurement plan from a URL" review/approve panel) ──
   SuggestedTagView mirrors web-audit's SuggestedTag, declared locally so the
   renderer/shared layer stays dependency-free. It is the create_gtm_tracking_tag
   payload shape plus review metadata (label/evidence/confidence/EM-overlap). */
export interface SuggestedTagView {
  id: string;
  /** "/contact" or "site-wide" once deduped across pages. */
  page: string;
  label: string;
  evidence: string;
  /** Optional caveat (e.g. an embedded provider whose native trigger won't fire). */
  note?: string;
  /** The STRUCTURED, installable companion to `note`: the site-side requirement(s)
   *  for this tag's trigger to fire (listener tag(s) / attributes / code), expressed
   *  where possible as an auto-creatable Custom HTML listener tag. Currently attached
   *  to form suggestions only — surfaced read-only in the review panel's "How to
   *  install" panel. Carried through untouched from the engine SuggestedTag.install. */
  install?: InstallPlan;
  confidence: 'high' | 'medium' | 'low';
  /** GA4 Enhanced Measurement already auto-tracks this — flagged, not pushed. */
  enhancedMeasurementOverlap: boolean;
  /** 'ga4_event' = a GA4 event tag; 'google_tag' = the base Google tag (GA4
   *  Configuration) — uses tagId, not eventName/eventParameters. 'meta_pixel' = a
   *  Meta (Facebook) Pixel tag — measurementId holds the Meta Pixel ID (default
   *  {{Meta Pixel ID}}), eventName is the Meta event. The other pixel platforms
   *  mirror it (measurementId = that platform's ID variable): 'tiktok_pixel' /
   *  'linkedin_insight' / 'reddit_pixel' / 'pinterest_tag'. Google Ads uses
   *  'google_ads_conversion' (measurementId = the Conversion ID, conversionLabel =
   *  the Conversion Label), 'google_ads_remarketing' (measurementId = the Conversion
   *  ID), and 'conversion_linker' (no id fields). */
  platform:
    | 'ga4_event'
    | 'google_tag'
    | 'meta_pixel'
    | 'tiktok_pixel'
    | 'linkedin_insight'
    | 'reddit_pixel'
    | 'pinterest_tag'
    | 'google_ads_conversion'
    | 'google_ads_remarketing'
    | 'conversion_linker';
  tagName: string;
  measurementId: string;
  /** For platform 'google_ads_conversion': the Ads Conversion Label (default
   *  {{Google Ads Conversion Label}}). */
  conversionLabel?: string;
  /** For platform 'google_tag': the Measurement ID (or its {{variable}}). */
  tagId?: string;
  /** For platform 'google_tag': optional gtag config settings. */
  configSettings?: Array<{ name: string; value: string }>;
  /** For a CTA-derived tag: the classified CTA intent, so platform derivations map by intent
   *  (authoritative) rather than the event-name text. */
  ctaIntent?: CtaIntent;
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  /** Companion Lookup Table variable(s) an event parameter VALUE references by {{name}} (e.g.
   *  form_name = {{Lookup - X Form Name}} keyed on {{Page Path}}) — auto-created (type smm) with the
   *  tag when missing. */
  eventParamLookups?: Array<{
    variableName: string;
    input: string;
    rows: Array<{ key: string; value: string }>;
    defaultValue?: string;
  }>;
  trigger: {
    name: string;
    kind: string;
    clickUrlValue?: string;
    clickUrlOperator?: string;
    /** For matchRegex click-URL: GTM's "matches RegEx (ignore case)" condition parameter. */
    clickUrlIgnoreCase?: boolean;
    clickTextValue?: string;
    clickTextOperator?: string;
    /** For matchRegex click-text: GTM's "matches RegEx (ignore case)" condition parameter. */
    clickTextIgnoreCase?: boolean;
    /** Companion Lookup Table (type smm, input {{Click Text}}, each text → "true") the trigger fires
     *  on ({{<name>}} equals "true") — auto-created with the tag when missing. */
    lookupTable?: { name: string; texts: string[] };
    clickElementValue?: string;
    clickElementOperator?: string;
    formIdValue?: string;
    formIdOperator?: string;
    formClassesValue?: string;
    formClassesOperator?: string;
    pagePathValue?: string;
    pagePathOperator?: string;
    pageUrlValue?: string;
    pageUrlOperator?: string;
    eventName?: string;
    /** For a custom_event trigger whose tag also keys off form-specific dataLayer data (e.g. one
     *  shared `form_submission` event split by `{{form_name}}`/`{{form_id}}`): the dataLayer
     *  key→value pairs to include in the synthetic push so the RIGHT tag's condition matches. Resolved
     *  from the trigger's extra conditions + the container's Data Layer Variables. */
    customEventData?: Record<string, string>;
  };
  /** Best-effort JPEG data-URI of the page location this tag would track (its CTA/form ringed),
   *  captured by a locate-only pass that reuses the verify driver's screenshot logic. Absent when the
   *  element couldn't be located, the kind has no on-page element, or the screenshot cap was hit. */
  screenshot?: string;
}

/** Result of suggestions:screenshotTags — one locate-only proof screenshot per suggested (creatable)
 *  tag: the element/location it would track, ringed. Reuses the verify driver's ring + capture.
 *  `screenshot` is absent when the element couldn't be located on its page. */
export interface SuggestionScreenshotResult {
  url: string;
  shots: Array<{ tagId: string; page: string; screenshot?: string }>;
  error?: string;
}

/** Streamed after each page during a scan — the running suggestion list (so the
 *  review panel fills in as the crawl proceeds) + crawl progress. */
export interface ScanProgressView {
  scanned: number;
  opened: number;
  queued: number;
  suggestions: SuggestedTagView[];
}

/** Options for a URL scan (suggestions:scan). The scan runs all available
 *  engines (Electron + Cheerio) and merges their findings — no engine choice. */
export interface TagScanOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Post-load settle (ms) for the browser engine — lets JS-rendered forms appear. */
  settleMs?: number;
  /** Which ad platforms to generate tags for (default ['ga4']). Any subset may be selected; each
   *  non-'ga4' platform adds tags derived from the GA4 ones (sharing each trigger). */
  platforms?: SuggestPlatform[];
  /** How many pages to scan IN PARALLEL (a pool of independent browser drivers). Omitted → auto from
   *  the machine's CPU (≈ cores/3, capped). Bounded by the page budget so it never over-provisions. */
  scanConcurrency?: number;
}

/** One detected clickable element (before dedup) — the raw inventory. */
export interface DetectedElementView {
  page: string;
  /** email | phone | download | outbound | cta */
  kind: string;
  text: string;
  href?: string;
  region?: string;
}
/** One detected form (before dedup). */
export interface DetectedFormView {
  page: string;
  purpose: string;
  action: string;
  provider: string;
}

/** Result of crawling a URL for tag suggestions (suggestions:scan). */
export interface TagScanResult {
  site: string;
  siteHost: string;
  scannedAt: string;
  summary: {
    pagesCrawled: number;
    pagesScanned: number;
    formsFound: number;
    trackableElements: number;
    suggestions: number;
    byConfidence: { high: number; medium: number; low: number };
    enhancedMeasurementOverlap: number;
    newTracking: number;
    /** Auto-detected site type — 'ecommerce' unlocks the ecommerce funnel suggestions. Undefined on
     *  an empty/failed scan. */
    websiteType?: 'ecommerce' | 'non_ecommerce';
    /** Human-readable signals behind an 'ecommerce' classification (shown in the badge tooltip). */
    ecommerceEvidence?: string[];
  };
  suggestions: SuggestedTagView[];
  pages: Array<{ page: string; forms: number; elements: number }>;
  /** Every trackable element + form detected (before dedup) — the full inventory. */
  inventory: { elements: DetectedElementView[]; forms: DetectedFormView[] };
  /** GTM containers + measurement ids LIVE on the scanned site (from its scripts). */
  installed: { containers: string[]; measurementIds: string[] };
  notScanned: Array<{ url: string; reason: string }>;
  warnings: string[];
  /** Browser-driver diagnostics for the "Show debug" toggle (why a scan found nothing). */
  debug?: ScanDebug;
}

/** One page's browser-driver diagnostics (form-probe DOM counts + nav status). */
export interface ScanDebugPage {
  url: string;
  httpStatus: number | null;
  /** DOM counts the form probe saw, and how many forms the extractor got out. */
  probe?: { forms: number; inputs: number; textareas: number; selects: number; submitish: number; extracted: number };
  error?: string;
}
/** Browser-driver diagnostics for a tag-suggestion scan (drives the debug toggle). */
export interface ScanDebug {
  /** Which driver(s) ran (e.g. 'electron', 'electron+cheerio'). */
  driver: string;
  /** Settle strategy: 'auto' (network-idle) or a fixed 'Nms'. */
  settleMode: string;
  pages: ScanDebugPage[];
  /** Browser console errors/warnings observed during the scan (capped). */
  consoleErrors: string[];
  /** Page-level load failures (did-fail-load main frame, render-process-gone). */
  pageErrors: string[];
}

/* ── Verify tag firing ("Verify firing" — does the tag fire; if not, fix the trigger) ── */

/** A tag to verify: identity + the trigger the driver drives and the core evaluates. */
export interface VerifyTagInput {
  id: string;
  tagName: string;
  eventName: string;
  platform: string;
  /** The tag's Measurement ID (or {{variable}}). When a literal G-/GT-/AW-XXXX, the GA4 hit's tid= is
   *  matched too, so two GA4 tags firing the same event on different properties are attributed right. */
  measurementId?: string;
  /** The page the tag's trigger lives on ("/contact", "site-wide") — drives per-page verification. */
  page?: string;
  trigger: SuggestedTagView['trigger'];
}

/** One analytics /collect hit captured (and aborted, never delivered) during verification. */
export interface CapturedHitView {
  url: string;
  body: string | null;
  /** ga4 | meta | tiktok | server | ad */
  collector: string;
}

/** Per-tag verdict from the firing verification. */
export interface VerifyTagVerdict {
  tagId: string;
  tagName: string;
  /** true = a matching /collect hit fired after the tag's trigger interaction. */
  fired: boolean;
  /** true = the tag fired, but off a SYNTHETIC dataLayer event we pushed (a custom_event trigger) —
   *  NOT a real user interaction. This proves the tag's config/trigger is correct, but NOT that the
   *  site (e.g. a real form submit) actually emits that event. Real click/form/page-load fires leave
   *  this false. Surfaced so form/custom-event "fires" aren't over-claimed as real-submit proof. */
  synthetic?: boolean;
  /** true = we could NOT actually test this tag on this run (its CTA/form isn't on the page we
   *  drove, or it fires on a shared dataLayer event but keys off form-specific data a synthetic
   *  push can't supply). NOT a failure — the tag may well fire for a real user. The UI files these
   *  under "couldn't auto-test here" instead of "not firing" so a working tag isn't called broken. */
  inconclusive?: boolean;
  /** true = a specific-vendor pixel/ads tag (Meta/TikTok/…) sent NO browser beacon, BUT the same
   *  interaction relayed to a first-party server container (sGTM /g/collect). Strong sign the
   *  destination is fed SERVER-SIDE via the Conversion API — the browser never calls the vendor, so a
   *  missing browser beacon is expected, not proof it's broken. Filed under a distinct "relayed
   *  server-side" group (always also `inconclusive`), never "not firing". */
  serverRelay?: boolean;
  /** The event name observed on the firing hit (GA4). */
  event?: string;
  /** Why it did not fire (always set when fired=false). */
  reason?: string;
  /** For a "fired but wrong event name" verdict: the GA4 event name(s) actually observed on the
   *  interaction, so the UI can offer to align the tag's Event Name to one of them. */
  observedEvents?: string[];
  /** Every distinct host the interaction beaconed to (any platform) — shows what network activity
   *  actually fired, even for tag types we can't decode. */
  observedBeacons?: string[];
  /** What the driver did to exercise the trigger. */
  interaction?: { kind: 'click' | 'submit' | 'navigate' | 'custom_event' | 'none'; targetFound: boolean; performed: boolean; note?: string };
  /** A sample captured hit as evidence. */
  evidence?: CapturedHitView;
  /** A corrected trigger to apply when the tag did not fire (the "fix the trigger" step). */
  suggestedTrigger?: SuggestedTagView['trigger'];
  /** Human-readable description of the proposed fix. */
  fixNote?: string;
  /** JPEG data-URI screenshot of the page right after this tag's interaction (the driven control
   *  ringed) — visual proof of what was exercised. Best-effort; absent for un-driven/capped tags. */
  screenshot?: string;
  /** true = this verdict is AUTHORITATIVE — it comes from GTM's own Monitoring API (addEventCallback via
   *  the injected GTM Monitor tag), not from beacon inference. `fired`/`monitorStatus`/`monitorEvents`
   *  are then ground truth: exactly which tags GTM fired, like Tag Assistant. */
  verifiedByMonitor?: boolean;
  /** For a monitor verdict: the tag's worst reported status — 'success' | 'failure' | 'exception' |
   *  'timeout'. Absent for non-monitor verdicts. */
  monitorStatus?: string;
  /** For a monitor verdict: the dataLayer events GTM fired this tag on. */
  monitorEvents?: string[];
  /** For a monitor verdict: the tag's execution time (ms), when reported. */
  monitorExecutionMs?: number;
}

/** Result of verifying tag firing (suggestions:verifyTags). */
export interface VerifyTagsResult {
  url: string;
  /** The container/preview snippet was injected onto the page. */
  injected: boolean;
  /** The injected snippet carried workspace-preview auth (gtm_auth/gtm_preview) so DRAFT tags load.
   *  When false with injected=true, a PUBLISHED snippet was pasted — draft tags will not fire. */
  previewAuth: boolean;
  pagesOk: boolean;
  error?: string;
  verdicts: VerifyTagVerdict[];
  /** true = this run used AUTHORITATIVE mode: verdicts came from the real Tag Assistant debug stream
   *  (GTM's own per-event tag firing), not beacon inference. The UI renders the fired/not-fired panel. */
  verifiedByMonitor?: boolean;
  /** Authoritative mode needs a ONE-TIME Google sign-in for Tag Assistant to debug a GTM container —
   *  the UI shows the "Sign in for Tag Assistant" button when set. */
  needTaSignIn?: boolean;
  /** The distinct page URLs the driver actually navigated + drove tags on (multi-page drive). A
   *  click tag whose CTA lives off the homepage is driven on ITS page, so this is usually >1. */
  pagesDriven?: string[];
  /** How many pages the pre-verify crawl visited to locate each CTA's page (0 = no crawl / inventory
   *  was supplied by the caller). */
  pagesCrawled?: number;
  /** How many pages the site actually has (from its sitemap/discovery). When pagesCrawled < pagesTotal,
   *  some pages were beyond the scan budget, so a click tag whose CTA lives there stays "untested here"
   *  — the UI surfaces this so the coverage is honest. */
  pagesTotal?: number;
  /** DevTools-Network-style log of the analytics calls captured during the run (browser layer-1):
   *  Meta pixel (facebook.com/tr), GA4, the sGTM relay (/g/collect), and other pixels, with key params.
   *  Server-side Meta CAPI (graph.facebook.com) is NOT here — it never reaches the browser. */
  networkLog?: Array<{ vendor: string; endpoint: string; params: string }>;
  /** The site's REAL dataLayer pushes captured during the run, each with its parameters — a
   *  Tag-Assistant-style view of exactly what the site emits (page_view, form_start, cta_click, …) so
   *  a trigger can be built/aligned to the real event + params. `synthetic` = a verifier-pushed event
   *  (used to test a custom_event tag), NOT proof the site fires it. */
  dataLayer?: Array<{ event: string; params: string; synthetic?: boolean }>;
  /** Phase B (best-effort): GTM's on-page debug signal — whether the container actually loaded +
   *  the dataLayer event stream. Present only when gtmDebug was requested. */
  gtmDebug?: { containerLoaded: boolean; containerIds: string[]; dataLayerEvents: string[] };
  /** Phase 3 (authoritative Tag Assistant runs): the per-event timeline — one entry per dataLayer event
   *  the container processed, with the exact push (API Call), resolved variables, and the tags that fired
   *  on it. Powers the in-app "show it in detail" results view. */
  taEvents?: TaEventView[];
  /** Phase 3: DLV-based trigger suggestions for tags that did NOT fire, built from the REAL captured
   *  pushes — so the user can create/align a trigger for anything not firing. */
  taSuggestions?: TaTriggerSuggestion[];
}

/** One row of the tag-verification results EXPORT (CSV / PDF / DOC). The renderer derives these from the
 *  verdicts (reusing the same status/label logic the on-screen table uses) so the download matches the UI.
 *  `screenshot` (a JPEG data-URI) is embedded as an <img> in the PDF/DOC; the CSV omits it (text only). */
export interface VerifyExportRow {
  /** Human label of the verdict's status, e.g. "Fired" / "Config OK" / "Server-side" / "Untested" / "Issue". */
  status: string;
  /** The tag's name, e.g. "GA4 - Event - Phone Click Tag". */
  tag: string;
  /** The event it fired on (the dataLayer/trigger event, e.g. "gtm.linkClick", in an authoritative run). */
  triggerEvent?: string;
  /** How the fire was observed — the interaction-kind label, e.g. "Tag" / "Click" / "Form". */
  firedVia?: string;
  /** The evidence line, e.g. "GTM monitor: success" or the observed beacon host(s). */
  signal?: string;
  /** JPEG data-URI proof screenshot (Tag Assistant tag-detail / driven page). Embedded in PDF/DOC only. */
  screenshot?: string;
}

/** Everything the tag-verification export needs, sent from the renderer to the export IPC. Serializable. */
export interface VerifyExportPayload {
  /** The site verified (for the report heading + default filename). */
  url?: string;
  /** true = an authoritative Tag Assistant / GTM-monitor run (shown as a note in the report). */
  authoritative?: boolean;
  /** The scorecard counts, mirroring the on-screen cards. */
  counts: { fired: number; config: number; server: number; untested: number; issues: number };
  /** Coverage line: pages driven / crawled / total (each optional). */
  pagesDriven?: number;
  pagesCrawled?: number;
  pagesTotal?: number;
  /** Every verdict as an export row, in display order (fired → config → server → untested → not-firing). */
  rows: VerifyExportRow[];
}

/** One dataLayer event in the Tag-Assistant-style timeline. */
export interface TaEventView {
  /** Stable, unique, 1-based chronological index — the timeline's identity. `eventId` is NOT unique across
   *  a multi-page drive (gtm.uniqueEventId resets per page), so React keys, expand state, and the
   *  screenshot alignment all key on `seq`. */
  seq: number;
  eventId: number;
  eventName: string;
  /** The exact dataLayer push that raised this event (TA's "API Call" block). */
  apiCall?: Record<string, unknown>;
  /** Resolved variable values at this event (name → value). */
  variables?: Record<string, string>;
  /** Tags GTM ran on this event, with their status. */
  tagsFired: Array<{ name: string; status: 'fired' | 'failed' | 'running' | 'unknown' }>;
  /** JPEG data-URI screenshot of the REAL Tag Assistant panel for this event (its Tags-Fired view),
   *  captured by clicking the event in Tag Assistant. Best-effort — absent if the capture didn't land. */
  screenshot?: string;
}

/** A DLV-based trigger suggestion for a tag that did NOT fire, built from the real captured pushes. */
export interface TaTriggerSuggestion {
  tagName: string;
  /** The dataLayer event to trigger on (empty if none was captured). */
  event: string;
  /** Variable → observed value pairs to scope the trigger. `key` is the FULL GTM variable reference
   *  (e.g. "dlv - form_name", "Page Path"), rendered {{key}}. */
  conditions: Array<{ key: string; value: string }>;
  /** Plain-English "how to build this in GTM". */
  how: string;
}

/** A live progress tick streamed WHILE a verify run is in flight (suggestions:verify:event), so the UI
 *  can show what's happening instead of a bare "Verifying…" spinner through a 50-page crawl + drive.
 *  - prepare : minting/reading is about to start
 *  - monitor : minting the throwaway GTM Monitor preview (authoritative mode only)
 *  - crawl   : scanning site pages to locate each tag's trigger (the long phase)
 *  - drive   : navigating each page and exercising its tags */
export interface VerifyProgressView {
  phase: 'prepare' | 'monitor' | 'crawl' | 'drive';
  /** A short human label for the phase (e.g. "Scanning site pages to locate each tag"). */
  message: string;
  /** The page being scanned / driven right now, when applicable. */
  page?: string;
  /** Completed count so far in this phase (1-based), when known. */
  done?: number;
  /** Total for this phase (an estimate for the crawl, capped at the page budget), when known. */
  total?: number;
}

/** Options for verifying tag firing. */
export interface VerifyTagsOptions {
  /** The GTM Preview snippet / URL / GTM-XXXX id the user pasted, so DRAFT tags load. */
  containerSnippet?: string;
  settleMs?: number;
  navTimeoutMs?: number;
  /** Phase B: also read GTM's on-page debug signal (container loaded? + dataLayer events) so a
   *  "0 fired" result can tell "container didn't load" from "loaded but didn't match". */
  gtmDebug?: boolean;
  /** Multi-page drive: when no element inventory is supplied, crawl the site first so click/link
   *  tags whose CTA lives on another page are driven THERE (not always on the homepage). Default on;
   *  set false to force single-page driving against the URL as-is. */
  crawlForPages?: boolean;
  /** Page/depth budget for that pre-verify crawl (clamped by the scanner). */
  crawlMaxPages?: number;
  crawlMaxDepth?: number;
  /** Verify ONLY these exact page URLs (one per line in the UI). When set, the auto-crawl is skipped and
   *  EVERY tag is driven on EACH of these pages — so forms/tags on pages the crawl missed still get
   *  exercised. Same-origin URLs only; anything else is dropped. */
  verifyPages?: string[];
  /** The operator-REVIEWED forms to submit for real through Tag Assistant (from the Forms review panel,
   *  with any edited field values). When present, these are submitted instead of auto-discovered/default-
   *  filled forms — so "Verify with Tag Assistant" uses exactly what the user reviewed. */
  reviewedForms?: Array<{ page: string; formId: string; formClasses: string; method: string; fields: Array<{ selector: string; type: string; value: string }>; expectedTags?: string[] }>;
  /** AUTHORITATIVE (Tag-Assistant-grade) mode: instead of a pasted snippet, mint a THROWAWAY preview
   *  that injects a GTM Monitor tag, so verdicts come from GTM's OWN per-tag firing (addEventCallback),
   *  not beacon inference. Requires the GTM account/container/workspace to mint from; draft-only, never
   *  published, the throwaway workspace is discarded after. Opt-in (a container write) — the renderer
   *  confirms first. */
  monitor?: { accountId: string; containerId: string; workspaceId: string };
}

/* ── Real-submit form verification: fetch a form's OWN fields + a locale fill plan (review step) ── */
/** One fillable field on a form with its locale-derived, user-editable test value. */
export interface FormFillFieldView {
  /** Stable selector (name-based, else id-based) the driver will fill in Phase 2. */
  selector: string;
  name: string;
  label: string;
  /** input type / 'select' / 'textarea' / 'checkbox' / 'radio'. */
  type: string;
  /** Detected fill role (given_name, email, phone, country, subject, consent, …). */
  role: string;
  required: boolean;
  /** The value to submit — locale default, edited by the operator. For a checkbox: 'true' = checked. */
  value: string;
  /** For a <select>: its real option labels, so the review UI offers them. */
  options?: string[];
}
/** A detected form + its fill plan, for the review-before-submit step. */
export interface FormFillView {
  index: number;
  title: string;
  formId: string;
  formClasses: string;
  action: string;
  method: string;
  purpose: string;
  /** True = not rendered at scan time (a modal that opens on a click). */
  hidden: boolean;
  fields: FormFillFieldView[];
}
export interface FormsForFillOptions {
  /** Location profile id (default 'us'). Drives locale-appropriate phone/postal/region + country. */
  localeId?: string;
  navTimeoutMs?: number;
}
export interface FormsForFillResult {
  url: string;
  localeId: string;
  /** The supported locations for the picker (US now; UK/AUS later). */
  locales: Array<{ id: string; label: string }>;
  forms: FormFillView[];
  error?: string;
}

/** One reviewed field to fill before a REAL submit. */
export interface FormSubmitFieldInputView {
  selector: string;
  type: string;
  value: string;
}
/** The ONE reviewed form to submit — its identity (so the driver targets THIS form, not a same-named
 *  field on another form) plus the fields to fill. */
export interface SubmitFormInputView {
  formId: string;
  formClasses: string;
  /** 'js' = a div/JS widget (click its submit control); otherwise a native <form>. */
  method: string;
  fields: FormSubmitFieldInputView[];
}
export interface SubmitFormVerifyOptions {
  /** GTM Preview snippet so DRAFT tags load; omit to test the live/published container. */
  containerSnippet?: string;
  /** When set, after the submit the fired GA4 events are paired to THIS container's tags (by event
   *  name) so the result names the actual tags that fired. Best-effort; omit to skip pairing. */
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
}
/** Result of a REAL form submission: what analytics events/beacons the tag fired. The form's POST is
 *  delivered (a real submission); analytics hits are captured+aborted (no GA4/ad pollution). */
export interface SubmitFormVerifyResult {
  ok: boolean;
  injected: boolean;
  previewAuth: boolean;
  filled: number;
  submitted: boolean;
  note?: string;
  error?: string;
  /** GA4 event names observed after the submit — the proof the form fired the tag. */
  events: string[];
  /** Distinct analytics beacon hosts observed. */
  beacons: string[];
  /** Distinct beacon VENDORS observed (meta/linkedin/pinterest/…) — used to pair pixel/ad tags. */
  beaconPlatforms?: string[];
  /** The container's ACTUAL tags whose event name matches an observed event — paired when the caller
   *  passed container context. These fired on the REAL submit (a genuine FIRED, not synthetic). */
  firedTags?: Array<{ tagName: string; eventName: string }>;
  /** Pixel/ad tags that sent NO browser beacon but whose form relayed to a first-party server
   *  container (server-side / Conversion API) — expected, not a failure. Shown as "server-side", never
   *  ❌ NOT FIRED. Mirrors VerifyTagVerdict.serverRelay on the synthetic path. */
  serverRelayTags?: string[];
  /** JPEG data-URI screenshot of the form after the real submit (the form ringed) — visual proof of
   *  what was submitted. Best-effort. */
  screenshot?: string;
}

/* ── Container-tag-driven form verification: crawl → keep only forms that HAVE a tag → one de-duped
 *    data-entry → submit each → verify + fix. ── */
/** One de-duplicated field in the shared data-entry set (email/name/phone shown ONCE across forms). */
export interface SharedFillField {
  /** Stable de-dup key (role, or role|label for selects) — each matched form pulls its value by this. */
  key: string;
  role: string;
  label: string;
  type: string;
  value: string;
  options?: string[];
}
/** A site form that has a matching container tag — the thing we submit + verify. */
export interface MatchedFormView {
  page: string;
  formTitle: string;
  formId: string;
  formClasses: string;
  method: string;
  purpose: string;
  fields: Array<{ selector: string; type: string; role: string; label: string; value: string; options?: string[] }>;
  /** Container form tags expected to fire when this form is submitted (name + GA4 event name + platform). */
  expectedTags: Array<{ tagName: string; eventName: string; platform: string }>;
}
export interface FormTagVerifyPlanOptions {
  accountId: string;
  containerId: string;
  workspaceId: string;
  localeId?: string;
  /** Crawl budget for finding forms across the site. */
  maxPages?: number;
  /** "Pages to verify" — when set, scan ONLY these pages for forms (no sitemap crawl), matching the
   *  scoped tag-verification run. Same list the verify call gets, so the two stay in lockstep. */
  verifyPages?: string[];
}
export interface FormTagVerifyPlanResult {
  url: string;
  localeId: string;
  locales: Array<{ id: string; label: string }>;
  /** Unique forms that have a container tag (each lists the tags expected to fire on it). */
  matched: MatchedFormView[];
  /** The collapsed, editable data-entry set — fill once, applies to every matched form. */
  sharedFields: SharedFillField[];
  /** Container form tags that matched NO form on the site (a coverage gap to flag). */
  unmatchedTags: string[];
  pagesCrawled: number;
  error?: string;
}

/* ── Container audit (the "Container audit" panel) ── */
export interface AuditFindingView {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence?: 'certain' | 'likely' | 'runtime-required' | 'guessing';
  /** Stable per-check id (e.g. 'B6-ad-pixel-consent') — lets the UI batch by check. */
  checkId?: string;
  category: string;
  message: string;
  resource?: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string; type?: string };
  recommendation: string;
  /** True when `fix` is a ready-to-run tool call (pause/unpause/delete). */
  autoFixable: boolean;
  fix?: { tool: string; args: Record<string, unknown> };
}
/** Server-container remediation PLAN (mirrors server-plan.ts). */
export interface ServerPlanView {
  items: Array<{
    id: string;
    category: 'critical' | 'high' | 'medium' | 'low' | 'info';
    status: 'existing' | 'missing';
    kind: 'client' | 'trigger' | 'tag' | 'variable' | 'builtin' | 'config';
    name: string;
    description: string;
    dependsOn: string[];
    requires: string[];
    defaultSelected: boolean;
    executable: boolean;
  }>;
  detected: { measurementId: string | null; serverUrl: string | null; webWiredUrl: string | null; dataTag: 'configured' | 'misconfigured' | 'not_installed' };
  inventory: {
    clients: Array<{ name: string; type: string }>;
    tags: Array<{ name: string; type: string; paused: boolean }>;
    triggers: Array<{ name: string; type: string }>;
    variables: Array<{ name: string; type: string }>;
    enabledBuiltIns: string[];
  };
}
export interface ServerPlanApplyResultView {
  serverContainer: { containerId: string; publicId: string; name: string };
  workspaceId: string;
  applied: string[];
  reused: string[];
  skipped: Array<{ id: string; reason: string }>;
  failed: Array<{ id: string; error: string }>;
}

/** Server container documentation for ON-SCREEN rendering. Mirrors server-doc.ts
 *  buildServerDocView - the same helpers the MD/CSV/XLSX/PDF exports use, so what's shown
 *  on the page and what's written to a file can't diverge. Secret values never appear. */
/** A chat attachment after main-process text extraction. The renderer injects `text` into the
 *  OUTGOING message only; the bubble renders just name/chars (never the content). */
export interface ChatAttachmentView {
  name: string;
  bytes: number;
  chars: number;
  text: string;
  truncated: boolean;
}

export interface ServerDocView {
  meta: { containerName: string; publicId?: string; workspaceName?: string; generatedAt: string; liveVersionId: string | null };
  overview: { taggingServerUrls: string[]; counts: { clients: number; tags: number; triggers: number; variables: number; transformations: number }; configScore: number | null };
  findings: Array<{ severity: string; where: string; message: string; recommendation: string }>;
  destinations: Array<{ destination: string; types: string; tags: number; paused: number }>;
  flowLines: string[];
  clients: Array<{ name: string; type: string }>;
  tags: Array<{ name: string; type: string; destination: string; firesOn: string; vars: string; notes: string }>;
  triggers: Array<{ name: string; type: string; condition: string }>;
  variables: Array<{ name: string; type: string; usedBy: string }>;
  transformations: Array<{ name: string; type: string }>;
  /** Published version history (newest first, max 10). Header list only - no publish dates. */
  versions: Array<{ versionId: string; name: string; tags: number; triggers: number; variables: number; live: boolean; deleted: boolean }>;
  /** Web<->server linkage summary - present only when a web container was provided. */
  webLink: { wiring: 'wired' | 'not_wired' | 'url_mismatch' | 'unknown'; idsMatch: boolean | null; coveragePct: number | null; score: { configuration: number; coverage: number | null; overall: number }; lines: string[] } | null;
}

/** Web GTM <-> Server GTM coverage comparison (config-level). Mirrors server-coverage.ts. */
export interface ServerCoverageView {
  rows: Array<{ platform: string; event: string; webTag: string; status: 'covered' | 'missing' | 'not_matchable'; by?: string; recommendation?: string; template?: { tagId: string; name: string } }>;
  unusedServer: Array<{ tag: string; platform: string; event: string }>;
  ga4: { client: boolean; relay: boolean; webMeasurementIds: string[]; serverMeasurementIds: string[]; idsMatch: boolean | null };
  webWiring: { status: 'wired' | 'not_wired' | 'url_mismatch' | 'unknown'; webUrl: string; serverUrls: string[] };
  summary: { webEvents: number; covered: number; missing: number; notMatchable: number; coveragePct: number | null };
  score: { configuration: number; coverage: number | null; overall: number };
}

export interface AuditReportView {
  counts: { tags: number; triggers: number; variables: number; findings: number; clients?: number; transformations?: number };
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  findings: AuditFindingView[];
  /** True if a GA4/Google base Configuration tag is present (hides the "Add GA4 base" card). */
  hasGa4Config?: boolean;
  /** Container-only boundary statement (what a config audit proves vs. can't) — shown in debug. */
  boundary?: string;
  /** Checks that need live verification, never scored as defects — shown in debug. */
  runtimeRequired?: string[];
}

/** ── Workspace Comparison (Container Audit) — the serializable diff of 2+ workspaces ─────────────────── */
export type WsEntityKind = 'tag' | 'trigger' | 'variable' | 'builtInVariable' | 'folder';
/** One field that differs between the two sides of a changed entity. */
export interface FieldChangeView {
  field: string;
  a?: string;
  b?: string;
}
/** One entity's status across a workspace pair. */
export interface EntityDiffView {
  kind: WsEntityKind;
  name: string;
  type?: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  changes?: FieldChangeView[];
}
export interface WorkspaceDiffSummaryView {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  byKind: Record<WsEntityKind, { added: number; removed: number; changed: number; unchanged: number }>;
}
/** base-vs-other pairwise diff. */
export interface PairwiseDiffView {
  aWorkspaceId: string;
  aName: string;
  bWorkspaceId: string;
  bName: string;
  entities: EntityDiffView[];
  summary: WorkspaceDiffSummaryView;
}
/** Merge readiness of a COMMON entity (present in every selected workspace). */
export type MergeStatus = 'safe' | 'review' | 'conflict';
/** One entity consolidated ACROSS all selected workspaces (the common/uncommon tables). */
export interface ConsolidatedEntityView {
  kind: WsEntityKind;
  name: string;
  type?: string;
  /** Workspace names that HAVE this entity. */
  presentIn: string[];
  /** Workspace names that are MISSING it. */
  missingFrom: string[];
  /** Present in every selected workspace. */
  common: boolean;
  /** Its config is identical in every workspace that has it. */
  identical: boolean;
  /** Number of DISTINCT config variants among the workspaces that have it. */
  variants: number;
  /** Fields that differ across the workspaces that have it. */
  differingFields: string[];
  /** safe = identical (mergeable) · review = differs, needs a decision · conflict = 3+ versions / type differs. */
  mergeStatus: MergeStatus;
  /** copy = uncommon, copy to the workspaces missing it · review · none = identical common. */
  suggestedAction: 'copy' | 'review' | 'none';
  notes: string;
  /** Per-workspace flat field map (null = the entity is missing there) — for the side-by-side viewer. */
  perWorkspace: Record<string, Record<string, string> | null>;
}
export interface WorkspaceStatsView {
  workspaces: number;
  totalEntities: number;
  common: number;
  unique: number;
  mergeable: number;
  conflicts: number;
  missing: number;
  byKind: Record<WsEntityKind, { total: number; common: number; unique: number }>;
}
export interface WorkspaceConsolidationView {
  stats: WorkspaceStatsView;
  common: ConsolidatedEntityView[];
  uncommon: ConsolidatedEntityView[];
}

/** One dependency edge in the dependency graph (what an entity needs to work). */
export interface DependencyView {
  kind: 'trigger' | 'variable' | 'builtInVariable';
  name: string;
  /** True when the referenced trigger/variable exists in this workspace (built-ins are always true). */
  present: boolean;
}
/** An entity plus everything it depends on, within one workspace. */
export interface EntityDependenciesView {
  kind: WsEntityKind;
  name: string;
  type?: string;
  dependsOn: DependencyView[];
}
/** A dependency that resolves in some workspaces but is broken in others holding the same entity. */
export interface CrossWorkspaceMissingDepView {
  entity: { kind: WsEntityKind; name: string };
  dependency: { kind: DependencyView['kind']; name: string };
  missingIn: string[];
  presentIn: string[];
}

/** The full multi-workspace comparison result (gtm:compareWorkspaces). */
export interface WorkspaceCompareResultView {
  containerId: string;
  workspaces: Array<{ workspaceId: string; name: string; counts: Record<WsEntityKind, number> }>;
  baseWorkspaceId: string;
  pairs: PairwiseDiffView[];
  /** Cross-workspace consolidation: common (in all) + uncommon (missing from some) + stats. */
  consolidated: WorkspaceConsolidationView;
  /** Per-workspace dependency graph (tag->triggers, entity->{{variables}}). */
  dependencies: Array<{ workspaceId: string; name: string; entities: EntityDependenciesView[] }>;
  /** Dependencies present in some workspaces but broken in others that hold the same entity. */
  missingDependencies: CrossWorkspaceMissingDepView[];
  headline: string;
}

/** Result of discovering a site's pages (suggestions:discover). */
export interface DiscoverResult {
  /** Same-site page URLs found (sitemap or link-crawl). */
  urls: string[];
  /** True if a sitemap was used (complete); false if a link-crawl fallback. */
  viaSitemap: boolean;
  total: number;
  /** GTM container + measurement ids already live on the site (homepage). */
  installed: { containers: string[]; measurementIds: string[] };
  note?: string;
}

/** Result of parsing a pasted plan (suggestions:fromJson). */
export interface ParsedSuggestionsResult {
  suggestions: SuggestedTagView[];
  warnings: string[];
}

/** Per-tag outcome of creating approved suggestions (suggestions:createTags). */
export interface CreateTagOutcome {
  id: string;
  ok: boolean;
  tagName?: string;
  triggerReused?: boolean;
  /** The container already has a tag with this name — skipped, not an error. */
  existing?: boolean;
  error?: string;
}

/** Continuous-monitoring config: auto re-audit the active container on a timer. */
export interface MonitorConfig {
  enabled: boolean;
  /** Minutes between automatic audits (clamped to a sane minimum in main). */
  intervalMinutes: number;
}

export interface MonitorStatus extends MonitorConfig {
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  /** The most recent alert this session, so a view can show it on mount even if
   *  it wasn't open when the alert fired. */
  lastAlert: MonitorAlert | null;
}

/** A renderer-safe finding (no machine fix args) for the monitoring banner. */
export interface MonitorFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  message: string;
}

/** Pushed to the renderer when a scheduled audit finds NEW issues (regressions). */
export interface MonitorAlert {
  at: number;
  accountId?: string;
  containerId?: string;
  containerName?: string;
  workspaceId?: string;
  newFindings: MonitorFinding[];
  resolvedCount: number;
}

// ── GA4 Monitoring ───────────────────────────────────────────────────────────
// A background health monitor for a LIST of GA4 properties: each check sweeps the enabled
// properties sequentially, re-checking data flow, key events, spikes/drops and revenue
// integrity, and (optionally) Slacks new issues per property.

/** One monitored GA4 property. */
export interface Ga4MonitorTarget {
  /** Like "properties/123456". */
  propertyId: string;
  /** Display name (for Slack, the tab list and the alert banner). */
  propertyLabel: string;
  /** Pause/resume this property without removing it from the list. */
  enabled: boolean;
  /** Human label for this property's OWN Slack channel (e.g. "#acme-alerts"), when one is connected.
   *  The webhook URL itself lives encrypted in the OS keychain, keyed per account + property. */
  slackLabel?: string;
  /** The account (mail) this property was added under. Targets only show/run for their own account;
   *  absent on configs from before per-account scoping (stamped lazily with the active account). */
  accountId?: string;
  /** WHAT this property posts to its Slack channel — chosen when connecting/editing the channel.
   *  alerts = new issues the moment they appear; digest = weekly health summary even when healthy;
   *  audit = weekly full-audit executive summary. Seeded from the old global toggles on migration. */
  notify?: { alerts: boolean; digest: boolean; audit: boolean; monthly?: boolean };
  /** When this property's weekly health digest last posted (persisted so restarts don't re-send). */
  lastDigestAt?: number;
  /** When this property's weekly scheduled audit last ran (persisted so restarts don't re-run). */
  lastAuditAt?: number;
  /** When this property's MONTHLY tracking report last posted. Seeded (without sending) on the first
   *  sweep so the first report tells a real month's story, not an empty one. */
  lastMonthlyAt?: number;
  /** Reliability % from the two most recent weekly audits - the monthly report's trust TREND. */
  lastAuditScore?: number;
  prevAuditScore?: number;
  /** Rolling issue history (capped at 50): when each alert opened and closed. Powers the monthly
   *  report's "caught and resolved" story; persisted so restarts don't lose the month. */
  issueLog?: Array<{ id: string; title: string; severity: string; openedAt: number; closedAt?: number }>;
}

/** Persisted config for the GA4 monitor (multi-property; mirrors the GTM MonitorConfig in shape). */
export interface Ga4MonitorConfig {
  /** Master background switch — the timer only runs when this is on AND >=1 target is enabled. */
  enabled: boolean;
  /** Minutes between automatic sweeps (clamped to a sane minimum in main). */
  intervalMinutes: number;
  /** The properties being monitored. Capped in main to keep API quota sane. */
  targets: Ga4MonitorTarget[];
  /** Lookback window (days) for trend + per-event regression detection (shared by all targets). */
  days: number;
  /** LEGACY global toggles — notification choices now live PER TARGET (Ga4MonitorTarget.notify) and
   *  are picked when connecting/editing a property's channel. These persist only to SEED targets
   *  from configs created before per-property preferences existed. */
  slackEnabled: boolean;
  digestEnabled: boolean;
  auditEnabled: boolean;
  /** Human label for the DEFAULT Slack channel + workspace (e.g. "#ga4-alerts · Acme"). Slack does
   *  not expose these from a webhook URL, so the user records them; shown as the connection status. */
  slackLabel: string;
}

export interface Ga4MonitorAlertView {
  id: string;
  kind: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  recommendation?: string;
  /** Structured Slack-format extras (see Ga4MonitorAlert in ga4-monitor.ts). */
  summaryLines?: string[];
  impact?: string;
  actions?: string[];
  plain?: string;
}

export interface Ga4MonitorCheckView {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail: string;
}

/** The result of one monitor run — shown in the tab and (for new alerts) sent to Slack. */
export interface Ga4MonitorRun {
  at: number;
  property: string;
  propertyLabel: string;
  /** The GA4 property's REPORTING timezone: every daily figure in this run is a complete day in this
   *  timezone (realtime is live). '' when the property snapshot could not be read. */
  timeZone?: string;
  health: 'healthy' | 'warning' | 'critical';
  summary: string;
  checks: Ga4MonitorCheckView[];
  alerts: Ga4MonitorAlertView[];
  /** ids of the alerts that are NEW vs the previous run (the set that triggered Slack). */
  newAlertIds: string[];
  /** How many Slack messages were sent this run, and any send error (null when fine/skipped). */
  slackSent: number;
  slackError: string | null;
}

/** Live per-property status: the configured target plus its latest run/error. */
export interface Ga4MonitorTargetStatus extends Ga4MonitorTarget {
  lastRunAt: number | null;
  lastError: string | null;
  /** That property's most recent run so the tab can render on mount even if it wasn't open. */
  lastRun: Ga4MonitorRun | null;
  /** Whether this property has its OWN Slack channel connected (else it uses the default). */
  hasWebhook: boolean;
  /** When this property's alerts last POSTED to Slack (real alert sends only, not tests). */
  lastSlackAt: number | null;
}

export interface Ga4MonitorStatus extends Ga4MonitorConfig {
  running: boolean;
  /** Most recent check time across all targets. */
  lastRunAt: number | null;
  /** Most recent error across all targets (null when the last sweep was clean). */
  lastError: string | null;
  /** Whether the account's DEFAULT Slack webhook is stored (per-property channels override it). */
  hasWebhook: boolean;
  /** Most recent Slack alert POST across all targets (null when none was ever sent). */
  lastSlackAt: number | null;
  /** One entry per configured target, in config order. */
  targetStatuses: Ga4MonitorTargetStatus[];
}

/** How the current outbound connection is classified. `unknown` = we have an IP but not enough signal. */
export type NetworkConnectionType = 'local' | 'vpn' | 'proxy' | 'unknown';

/**
 * The public network location the app's own outbound traffic is using — shown in Settings and before/
 * during an audit so the user can confirm which egress (VPN exit, proxy, or their real ISP) requests
 * originate from. This reflects THIS app's egress; with a full-tunnel OS VPN it is also the route the
 * website audits, form submissions, and click events take (they share the OS routing table).
 */
export interface NetworkLocationView {
  /** Public IP as seen by the geolocation service, or null when the check couldn't reach the network. */
  ip: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2 (e.g. "GB"), used for the flag. */
  countryCode: string | null;
  /** Region / state / province. */
  region: string | null;
  city: string | null;
  /** ISP / organization / carrier string from the geo lookup (used for provider inference). */
  org: string | null;
  /** Autonomous System number, e.g. "AS9009", when the provider returns it. */
  asn: string | null;
  connectionType: NetworkConnectionType;
  /** Best-effort VPN/proxy provider (e.g. "Surfshark", "NordVPN", "Proton VPN"), or null if not identifiable. */
  provider: string | null;
  /** How confident the VPN/provider verdict is. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Human-readable signals behind the verdict, e.g. ["network adapter: Surfshark", "IP org: Datacamp"]. */
  detectedVia: string[];
  /** Whether the check succeeded (`connected`), found no network (`offline`), or errored. */
  status: 'connected' | 'offline' | 'error';
  /** Error/why text when status is not `connected`. */
  detail: string | null;
  /** Epoch ms of when this location was last checked. */
  checkedAt: number;
}

export interface GoogleClientStatus {
  /** Whether a Google OAuth client (id + secret) is configured. */
  configured: boolean;
  /** Where to drop the oauth-client.json if it isn't (shown to the user). */
  configPath: string;
  /** Where the client was loaded from. */
  source: 'env' | 'file' | 'none';
  /** The loaded client_id (public — appears in the auth URL). For diagnostics. */
  clientId?: string;
  /** Whether the client_id has the expected …apps.googleusercontent.com shape. */
  clientIdLooksValid?: boolean;
}
