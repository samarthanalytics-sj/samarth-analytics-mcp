// Shared portal types.
// This file is intentionally framework-agnostic and re-used by both
// the React frontend (mock data + UI) and any future Express adapter
// that proxies the MCP server.
//
// Source of truth for the data shapes the portal expects from MCP/GTM.

export type ContainerSource =
  | "google_oauth"
  | "service_account"
  | "spreadsheet_import"
  | "csv_import"
  | "manual_entry";

export type ContainerPlatform =
  | "web"
  | "ios"
  | "android"
  | "amp"
  | "server";

export interface ContainerRecord {
  id: string;
  /** GTM container public id e.g. GTM-XXXXXXX */
  containerId: string;
  client: string;
  industry: string;
  platform: ContainerPlatform;
  accountName: string;
  source: ContainerSource;
  /** 0-100, derived from audit findings */
  healthScore: number;
  /** ISO 8601 */
  lastAuditAt: string | null;
  tagCount: number;
  triggerCount: number;
  variableCount: number;
  notes?: string;
}

export type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";

export type AuditCategory =
  | "ga4"
  | "consent"
  | "pixels"
  | "ecommerce"
  | "server_side"
  | "performance"
  | "naming"
  | "duplication"
  | "data_layer"
  | "dead_config"
  | "data_quality"
  | "publishing"
  | "governance"
  | "privacy"
  | "tool_failure";

/**
 * Sources that produced (or are required to produce) a finding.
 * - CONFIG: GTM API container/workspace reads.
 * - RUNTIME: live browser harness (network hits, dataLayer pushes, tag order).
 * - SGTM: server container reads (clients, transformations, routing).
 * - GA4_ADMIN: GA4 Admin API (dimensions, filters, retention, streams).
 * - DATA_API: GA4 Data API (reported event counts over a date range).
 */
export type AuditSourceFlag =
  | "CONFIG"
  | "RUNTIME"
  | "SGTM"
  | "GA4_ADMIN"
  | "DATA_API";

export type AuditCoverage = "covered" | "partial" | "not_covered";

export type AuditConfidence = "high" | "medium" | "low";

export type AuditEffort = "S" | "M" | "L";

/** Capability detection: which sources the portal can currently read. */
export interface AuditCapabilityFlags {
  CONFIG: boolean;
  RUNTIME: boolean;
  SGTM: boolean;
  GA4_ADMIN: boolean;
  DATA_API?: boolean;
}

// ── Runtime capture (RUNTIME source) ──────────────────────────────────────
// Shape produced by the runtime-worker (apps/runtime-worker) and the local CLI
// harness. Uploaded/pasted on the Audit page to enable the RUNTIME source.
// The portal NEVER infers runtime behaviour without one of these artifacts.

export interface RuntimeTrackerHit {
  url: string;
  method?: string;
  /** Pattern ids matched (e.g. "ga4_collect", "meta_pixel"). */
  matched?: string[];
  /** Vendor groups matched (e.g. "ga4", "meta", "google_ads"). */
  groups?: string[];
  resourceType?: string;
}

export interface RuntimeSgtmCandidate {
  url: string;
  method?: string;
  resourceType?: string;
}

export interface RuntimePageCapture {
  requestedUrl: string;
  finalUrl?: string | null;
  httpStatus?: number | null;
  consoleErrors?: string[];
  consoleWarnings?: string[];
  pageErrors?: string[];
  trackerHits?: RuntimeTrackerHit[];
  sgtmCandidates?: RuntimeSgtmCandidate[];
  networkRequestCount?: number;
  dataLayerBefore?: unknown;
  dataLayerAfter?: unknown;
  /** Event names observed in the dataLayer (push `event` + gtag event calls). */
  dataLayerEvents?: string[];
  /** Distinct top-level dataLayer object keys observed. */
  dataLayerKeys?: string[];
  notes?: string[];
}

/**
 * Runtime capture artifact. Supports the v2 multi-page shape from the worker
 * and tolerates the legacy v1 single-page harness shape (mapped client-side
 * into `pages` on import).
 */
export interface RuntimeCapture {
  schema?: string;
  capturedAt?: string;
  requestedUrls?: string[];
  consentState?: Record<string, string>;
  pages?: RuntimePageCapture[];
  notes?: string[];
  /** Optional summary block the worker adds. */
  summary?: {
    pages?: number;
    groups?: Record<string, number>;
    consoleErrors?: number;
    pageErrors?: number;
  };
}

/** A single row in the coverage matrix. */
export interface AuditCoverageItem {
  /** Stable id, kebab-case. */
  id: string;
  /** What is being covered (e.g. "Tag firing & order"). */
  capability: string;
  /** Which sources are required for full coverage of this capability. */
  requires: AuditSourceFlag[];
  status: AuditCoverage;
  /** When status !== "covered", a one-line note describing what tool/source is needed. */
  toolNeeded?: string;
}

export interface AuditFinding {
  id: string;
  category: AuditCategory;
  /** Short headline (legacy alias for `finding`). */
  title: string;
  /** Evidence-based description of the finding (legacy alias for `whyItMatters`). */
  description: string;
  severity: AuditSeverity;
  /** Element this affects e.g. tag name, trigger id, variable */
  affects?: string[];
  /** Recommended fix summary (legacy alias for `suggestedFix`). */
  recommendation?: string;
  /**
   * Stricter QC fields, populated by the evidence-based auditor.
   * Older clients can keep reading `title` / `description` /
   * `recommendation` / `affects`.
   */
  finding?: string;
  affected?: string[];
  whyItMatters?: string;
  suggestedFix?: string;
  /** True when the rule can only flag for human review (e.g. PII suspicion). */
  needsManualReview?: boolean;
  /** Sources used to produce this finding. */
  sources?: AuditSourceFlag[];
  /** Confidence level of the finding given the sources available. */
  confidence?: AuditConfidence;
  /** Entity that produced this finding (display name + GTM id / path). */
  entity?: { name?: string; id?: string; path?: string };
  /** Specific GTM parameter or admin setting implicated, when known. */
  parameter?: string;
  /** Plain-language description of the business impact if left unfixed. */
  businessImpact?: string;
  /** Rough engineering effort estimate. */
  effort?: AuditEffort;
}

/** A read operation against the GTM API that did not succeed. */
export interface AuditToolFailure {
  /** Short label e.g. "container", "publishedVersion", "workspaces". */
  resource: string;
  /** Friendly message describing the failure. */
  message: string;
  /** HTTP status when available. */
  status?: number;
}

/** Maturity score for a single audit domain, 0-5. */
export interface AuditDomainMaturity {
  domain: string;
  /** 0-5; lower means weaker implementation. Capped at 3 when only CONFIG is available. */
  score: number;
  /** Findings counts by severity contributing to this score. */
  counts: { critical: number; high: number; medium: number; low: number };
  /** Whether this domain depends on a source that is not currently available. */
  capConfidence?: boolean;
}

/** Cell of the risk heat map: severity counts per domain. */
export interface AuditHeatMapRow {
  domain: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface AuditRoadmapItem {
  id: string;
  title: string;
  /** "quick_win" finishes inside a sprint; "structural" needs more design / cross-team effort. */
  type: "quick_win" | "structural";
  effort: AuditEffort;
  rationale: string;
  /** Finding ids that motivated this item. */
  findingIds: string[];
}

export interface AuditExecutiveSummary {
  /** Overall maturity, 0-5, derived from per-domain maturity. */
  overallMaturity: number;
  /** Top three risks by severity + business impact. */
  topRisks: { findingId: string; title: string; severity: AuditSeverity }[];
  /**
   * Whether the current state is safe to publish.
   * CONFIG-only audits will set this to "caution" at best — runtime confirmation is required for "yes".
   */
  publishSafe: "yes" | "caution" | "no";
  /** Plain-language reason for publishSafe state. */
  publishSafeReason: string;
  /** Hard limitation note when only a single source is connected. */
  singleSourceWarning?: string;
}

export interface AuditSummary {
  containerId: string;
  generatedAt: string;
  healthScore: number;
  counts: {
    tags: number;
    triggers: number;
    variables: number;
  };
  findings: AuditFinding[];
  /** GTM container type: "web" or "server" when known. */
  containerType?: string;
  /** Number of open workspaces (1 expected). */
  workspaceCount?: number;
  /** Latest published version id and notes, when readable. */
  publishedVersion?: {
    versionId?: string;
    name?: string;
    notes?: string;
  } | null;
  /** Reads that failed during the audit so gaps are not silently assumed-clean. */
  toolFailures?: AuditToolFailure[];
  /** Sentence summary: e.g. "Checked 47 items: 1 Critical, 3 High, 5 Medium, 2 Low." */
  summary?: string;
  /**
   * GA4 measurement IDs (G-XXXX / GT-XXXX) discovered on GTM GA4 config/event
   * tags. Used by the audit page to auto-match a GA4 property for cross-source
   * reconciliation. Empty when the container has no GA4 tags.
   */
  gtmMeasurementIds?: string[];

  // ── New: capability-aware, source-tagged audit output ────────────────────
  /** Which audit sources are connected/available for this run. */
  capabilityFlags?: AuditCapabilityFlags;
  /** Coverage matrix — what could be checked, what could not, and why. */
  coverageMatrix?: AuditCoverageItem[];
  /** Executive summary block. */
  executiveSummary?: AuditExecutiveSummary;
  /** Maturity per domain, 0-5. */
  domainMaturity?: AuditDomainMaturity[];
  /** Severity heat map rows. */
  heatMap?: AuditHeatMapRow[];
  /** Prioritized roadmap (quick wins → structural fixes). */
  roadmap?: AuditRoadmapItem[];
  /**
   * Consent Mode v2 + runtime proof summary. `coverage` reflects whether the
   * audit had config only, an imported runtime capture, or could reconcile the
   * two. `stateCoverage` reports which declared consent states the capture
   * exercised (denied / granted / partial).
   */
  consentAudit?: {
    coverage: "config_only" | "runtime_imported" | "reconciled";
    runtimeStates: string[];
    stateCoverage: { denied: boolean; granted: boolean; partial: boolean };
    findingCount: number;
  };
}

export type RecommendationGoal =
  | "ga4_ecommerce"
  | "consent_mode_v2"
  | "meta_capi"
  | "lead_tracking"
  | "server_side_tagging"
  | "cross_domain";

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  type: "create_tag" | "create_trigger" | "create_variable" | "update_tag" | "update_dl" | "publish";
  risk: "low" | "medium" | "high";
}

export interface ChangePlan {
  id: string;
  containerId: string;
  goal: RecommendationGoal;
  title: string;
  summary: string;
  createdBy: string;
  createdAt: string;
  steps: PlanStep[];
}

export type ApprovalStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "published";

export interface ApprovalItem {
  id: string;
  planId: string;
  containerId: string;
  client: string;
  title: string;
  goal: RecommendationGoal;
  status: ApprovalStatus;
  submittedBy: string;
  submittedAt: string;
  reviewer?: string;
  reviewedAt?: string;
  reviewNote?: string;
  stepsCount: number;
  riskLevel: "low" | "medium" | "high";
}

export interface OAuthState {
  connected: boolean;
  /** Whether the portal backend has Google OAuth client credentials configured. */
  configured?: boolean;
  email?: string;
  /** Display name from Google id_token / userinfo, when available. */
  userName?: string;
  /** Profile picture URL from Google id_token / userinfo, when available. */
  picture?: string;
  scopes?: string[];
  // Hosted OAuth (server-side token vault) state.
  // When the portal is wired to the MCP backend, `connected: true` means
  // the backend has a valid refresh token for this user.
  expiresAt?: string;
  /** Friendly message when not configured. */
  message?: string;
}

export interface GtmAccountSummary {
  accountId: string;
  name: string;
  path?: string;
}

export interface GtmContainerSummary {
  accountId: string;
  containerId: string;
  publicId: string;
  name: string;
  usageContext?: string[];
  domainName?: string[];
}

export interface GtmWorkspaceSummary {
  accountId: string;
  containerId: string;
  workspaceId: string;
  name: string;
  description?: string;
}

/** A GA4 property (flattened from account summaries) for the audit selector. */
export interface Ga4PropertySummary {
  /** Numeric property id without the "properties/" prefix, e.g. "123456789". */
  propertyId: string;
  displayName: string;
  accountName: string;
  accountId: string;
}

/** A GA4 web data stream, used to auto-match a GTM measurement ID. */
export interface Ga4DataStreamSummary {
  /** Full resource name: properties/123/dataStreams/456. */
  name: string;
  /** Numeric data stream id (last path segment). */
  dataStreamId: string;
  displayName: string;
  type?: string;
  /** Measurement ID (G-XXXXXXX) for web streams. */
  measurementId?: string;
}

// ── Server-side GTM (sGTM) visibility ─────────────────────────────────────
// Shapes returned by /api/gtm/sgtm (action "overview"). Read-only; mirrors the
// honest coverage philosophy used by the audit (per-resource failures are
// surfaced, never assumed-clean).

export interface SgtmClaim {
  key: string;
  value: string;
}

export interface SgtmClientSummary {
  clientId?: string;
  name: string;
  type?: string;
  priority?: number;
  /** Human-readable claim paths / criteria params extracted from the client. */
  claims: SgtmClaim[];
}

export interface SgtmTransformationSummary {
  transformationId?: string;
  name: string;
  type?: string;
}

export interface SgtmZoneSummary {
  zoneId?: string;
  name: string;
}

export interface SgtmTemplateSummary {
  templateId?: string;
  name: string;
  /** Community Template Gallery reference name, when sourced from the gallery. */
  gallery?: string;
}

export interface SgtmGtagConfigSummary {
  gtagConfigId?: string;
  type?: string;
  tagId?: string;
}

export interface SgtmDestinationSummary {
  destinationId?: string;
  name?: string;
}

/** A server resource read that did not succeed (non-404). */
export interface SgtmResourceFailure {
  resource: string;
  message: string;
  status?: number;
}

export interface SgtmContainerInfo {
  containerId?: string;
  name?: string;
  publicId?: string;
  usageContext: string[];
}

export interface SgtmOverview {
  /** True when the selected container's usageContext includes "server". */
  isServer: boolean;
  container: SgtmContainerInfo;
  /** Present only when isServer is false (explanatory message). */
  message?: string;
  clients?: SgtmClientSummary[];
  transformations?: SgtmTransformationSummary[];
  zones?: SgtmZoneSummary[];
  templates?: SgtmTemplateSummary[];
  gtagConfig?: SgtmGtagConfigSummary[];
  destinations?: SgtmDestinationSummary[];
  /** Per-resource read failures so gaps are not silently assumed-clean. */
  failures?: SgtmResourceFailure[];
  /** True when server AND at least one resource read succeeded (or none failed). */
  ok?: boolean;
}

export const GOAL_LABELS: Record<RecommendationGoal, string> = {
  ga4_ecommerce: "GA4 Ecommerce",
  consent_mode_v2: "Consent Mode v2",
  meta_capi: "Meta CAPI",
  lead_tracking: "Lead Tracking",
  server_side_tagging: "Server-side Tagging",
  cross_domain: "Cross-domain Tracking",
};

export const SOURCE_LABELS: Record<ContainerSource, string> = {
  google_oauth: "Google OAuth",
  service_account: "Service account",
  spreadsheet_import: "Spreadsheet",
  csv_import: "CSV import",
  manual_entry: "Manual entry",
};

export const STATUS_LABELS: Record<ApprovalStatus, string> = {
  draft: "Draft",
  pending_review: "Pending Samarth review",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published",
};
