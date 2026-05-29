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
  | "tool_failure";

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
