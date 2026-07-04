// Shared IPC DTOs — imported (type-only) by main, preload, and renderer.
//
// IMPORTANT: these are the ONLY account shapes the renderer ever sees. They
// carry no secret bytes and no secret refs — `hasGoogleToken` / `hasApiKey` are
// booleans derived in the main process. Keeping secrets out of these types is
// the type-level guarantee behind "the renderer never receives tokens or keys".

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
}

export interface GtmWorkspaceView {
  workspaceId: string;
  name: string;
  path: string;
}

/** The GTM account/container/workspace the user is currently working in. */
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
  verdict: string;
  biggestRisk: string;
  highestImpactFix: string;
  coverage: { checked: number; partial: number; notVerified: number };
  categories: Ga4ScorecardCategoryView[];
  trust: Ga4TrustRowView[];
}
/** Visualisations payload: the daily sessions trend line + colourful device/channel breakdowns. */
export interface Ga4VisualsView {
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
  } | null;
  /** Section 4 — every finding, highest severity first. */
  findings: Ga4FindingCardView[];
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
  /** Section 6 — AI/LLM referral-traffic performance + its share of all sessions. null = no AI traffic. */
  llmTraffic: { rows: Array<{ source: string; sessions: string; convRate: string; revenue: string; engagement: string }>; share: string } | null;
  /** Section 6 — rule-based "Key insights" bullets (peaks/lows, top performers, the near-100%-conv flag). */
  insights: string[];
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
  };
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
export interface AuditReportView {
  counts: { tags: number; triggers: number; variables: number; findings: number };
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  findings: AuditFindingView[];
  /** True if a GA4/Google base Configuration tag is present (hides the "Add GA4 base" card). */
  hasGa4Config?: boolean;
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
// A background health monitor for a chosen GA4 property: re-checks data flow, key
// events, spikes/drops and revenue integrity on a timer and (optionally) Slacks new issues.

/** Persisted config for the GA4 monitor (single active property, mirrors the GTM MonitorConfig). */
export interface Ga4MonitorConfig {
  enabled: boolean;
  /** Minutes between automatic checks (clamped to a sane minimum in main). */
  intervalMinutes: number;
  /** Property to monitor, like "properties/123456"; null until one is chosen in the tab. */
  propertyId: string | null;
  /** Display name for the property (for Slack + the tab header). */
  propertyLabel: string;
  /** Lookback window (days) for trend + per-event regression detection. */
  days: number;
  /** Post new issues to the active account's Slack webhook (requires a stored webhook). */
  slackEnabled: boolean;
}

export interface Ga4MonitorAlertView {
  id: string;
  kind: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  recommendation?: string;
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

export interface Ga4MonitorStatus extends Ga4MonitorConfig {
  running: boolean;
  lastRunAt: number | null;
  lastError: string | null;
  /** Whether a Slack webhook is stored for the active account (drives the settings UI state). */
  hasWebhook: boolean;
  /** The most recent run so the tab can render on mount even if it wasn't open when it ran. */
  lastRun: Ga4MonitorRun | null;
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
