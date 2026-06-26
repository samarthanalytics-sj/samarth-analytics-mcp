// Shared IPC DTOs — imported (type-only) by main, preload, and renderer.
//
// IMPORTANT: these are the ONLY account shapes the renderer ever sees. They
// carry no secret bytes and no secret refs — `hasGoogleToken` / `hasApiKey` are
// booleans derived in the main process. Keeping secrets out of these types is
// the type-level guarantee behind "the renderer never receives tokens or keys".

export type LlmProvider = 'anthropic' | 'openai' | 'gemini';
export type GoogleProduct = 'gtm' | 'ga4';

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
  workspaceId?: string;
  workspaceName?: string;
}

export interface Ga4AccountView {
  account: string;
  displayName: string;
  propertyCount: number;
}

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
   *  Configuration) — uses tagId, not eventName/eventParameters. */
  platform: 'ga4_event' | 'google_tag';
  tagName: string;
  measurementId: string;
  /** For platform 'google_tag': the Measurement ID (or its {{variable}}). */
  tagId?: string;
  /** For platform 'google_tag': optional gtag config settings. */
  configSettings?: Array<{ name: string; value: string }>;
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  trigger: {
    name: string;
    kind: string;
    clickUrlValue?: string;
    clickUrlOperator?: string;
    clickTextValue?: string;
    clickTextOperator?: string;
    formIdValue?: string;
    formIdOperator?: string;
    formClassesValue?: string;
    formClassesOperator?: string;
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
