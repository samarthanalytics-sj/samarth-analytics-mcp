// Production database domain models.
//
// FORWARD-LOOKING foundation: these TypeScript interfaces mirror the durable
// Postgres schema in `infra/database/0001_init.sql`. They are types only — no
// database driver is imported and nothing here connects to a live DB. They give
// the future production store (and any repository layer) a typed contract that
// already lines up with `portal-types.ts` (the product shapes) and the SQL.
//
// Framework-free and dependency-free on purpose: safe to import from the
// Vercel serverless `api/**` routes (it is erased at compile time when used via
// `import type`) and from the Node worker.
//
// Keep these in sync with:
//   - infra/database/0001_init.sql  (column names / nullability / enums)
//   - apps/portal/shared/portal-types.ts  (product-facing shapes)

import type {
  AuditCategory,
  AuditConfidence,
  AuditEffort,
  AuditSeverity,
  AuditSourceFlag,
  ApprovalStatus,
  RecommendationGoal,
} from "./portal-types";

/** Branded id helpers — all primary keys are UUID strings in Postgres. */
export type Uuid = string;
/** ISO-8601 timestamp string (TIMESTAMPTZ serialized). */
export type IsoTimestamp = string;

// ── Tenancy ────────────────────────────────────────────────────────────────

export type OrgPlan = "free" | "pro" | "enterprise" | (string & {});

export interface Organization {
  id: Uuid;
  slug: string;
  name: string;
  plan: OrgPlan;
  settings: Record<string, unknown>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface User {
  id: Uuid;
  googleSub: string | null;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp | null;
}

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

export interface Membership {
  id: Uuid;
  orgId: Uuid;
  userId: Uuid;
  role: MembershipRole;
  createdAt: IsoTimestamp;
}

// ── Auth / token vault metadata (NO RAW TOKENS) ─────────────────────────────

/**
 * Metadata about an OAuth grant. The access/refresh token bytes are NEVER held
 * here — `tokenRef` is an opaque pointer into an external secret manager / KMS
 * vault resolvable only by the backend service identity.
 */
export interface OAuthConnection {
  id: Uuid;
  orgId: Uuid;
  userId: Uuid;
  provider: "google";
  /** Opaque secret-manager reference. Never a token value. */
  tokenRef: string;
  scopes: string[];
  accessExpiresAt: IsoTimestamp | null;
  hasRefresh: boolean;
  revokedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// ── GTM / GA4 discovery snapshots (warm cache) ──────────────────────────────

export interface GtmAccountSnapshot {
  id: Uuid;
  orgId: Uuid;
  accountId: string;
  name: string;
  path: string | null;
  fetchedAt: IsoTimestamp;
}

export interface GtmContainerSnapshot {
  id: Uuid;
  orgId: Uuid;
  accountId: string;
  containerId: string;
  publicId: string | null;
  name: string;
  usageContext: string[];
  domainName: string[];
  fetchedAt: IsoTimestamp;
}

export interface GtmWorkspaceSnapshot {
  id: Uuid;
  orgId: Uuid;
  accountId: string;
  containerId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  fetchedAt: IsoTimestamp;
}

export interface Ga4PropertySnapshot {
  id: Uuid;
  orgId: Uuid;
  propertyId: string;
  displayName: string;
  accountId: string | null;
  accountName: string | null;
  fetchedAt: IsoTimestamp;
}

export interface Ga4DataStreamSnapshot {
  id: Uuid;
  orgId: Uuid;
  propertyId: string;
  dataStreamId: string;
  displayName: string;
  streamType: string | null;
  measurementId: string | null;
  fetchedAt: IsoTimestamp;
}

// ── Projects ────────────────────────────────────────────────────────────────

export interface Project {
  id: Uuid;
  orgId: Uuid;
  name: string;
  client: string | null;
  industry: string | null;
  accountId: string | null;
  containerId: string | null;
  workspaceId: string | null;
  ga4PropertyId: string | null;
  createdBy: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  archivedAt: IsoTimestamp | null;
}

// ── Audit runs + findings ────────────────────────────────────────────────────

export type AuditRunKind = "container" | "consent" | "sgtm";
export type AuditRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SeverityCounts = Partial<Record<AuditSeverity, number>>;

export interface AuditRun {
  id: Uuid;
  orgId: Uuid;
  projectId: Uuid | null;
  kind: AuditRunKind;
  containerId: string | null;
  status: AuditRunStatus;
  capabilityFlags: AuditSourceFlag[];
  healthScore: number | null;
  runtimeCaptureId: Uuid | null;
  severityCounts: SeverityCounts;
  /** Full engine output, or null when offloaded to object storage. */
  result: unknown | null;
  error: string | null;
  requestedBy: Uuid | null;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
}

export interface AuditFindingRow {
  id: Uuid;
  orgId: Uuid;
  auditRunId: Uuid;
  findingKey: string;
  category: AuditCategory;
  severity: AuditSeverity;
  confidence: AuditConfidence | null;
  sources: AuditSourceFlag[];
  title: string;
  whyItMatters: string | null;
  suggestedFix: string | null;
  businessImpact: string | null;
  effort: AuditEffort | null;
  needsManualReview: boolean;
  detail: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

// ── Runtime captures + worker jobs ───────────────────────────────────────────

export type WorkerJobKind = "runtime_capture";
export type WorkerJobStatus =
  | "queued"
  | "leased"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkerJob {
  id: Uuid;
  orgId: Uuid;
  kind: WorkerJobKind;
  status: WorkerJobStatus;
  payload: Record<string, unknown>;
  priority: number;
  attempts: number;
  maxAttempts: number;
  leaseExpiresAt: IsoTimestamp | null;
  leasedBy: string | null;
  lastError: string | null;
  auditRunId: Uuid | null;
  requestedBy: Uuid | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
}

export interface RuntimeCaptureRow {
  id: Uuid;
  orgId: Uuid;
  workerJobId: Uuid | null;
  schemaVersion: string | null;
  capturedAt: IsoTimestamp | null;
  requestedUrls: string[];
  /** Inline artifact (PII-sensitive) — null when offloaded to artifactUri. */
  artifact: unknown | null;
  artifactUri: string | null;
  expiresAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

// ── Approval queue ────────────────────────────────────────────────────────────

export type ApprovalRiskLevel = "low" | "medium" | "high";

export interface ApprovalRequest {
  id: Uuid;
  orgId: Uuid;
  projectId: Uuid | null;
  containerId: string | null;
  title: string;
  goal: RecommendationGoal | null;
  status: ApprovalStatus;
  riskLevel: ApprovalRiskLevel | null;
  plan: Record<string, unknown>;
  stepsCount: number;
  submittedBy: Uuid | null;
  submittedAt: IsoTimestamp | null;
  reviewer: Uuid | null;
  reviewedAt: IsoTimestamp | null;
  reviewNote: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * The repository contract the future production store will implement. Declared
 * here (not implemented) so route/worker code can be written against a stable
 * interface today and wired to a real driver (pg / drizzle / supabase-js) later
 * without touching call sites. Every method is org-scoped by the first arg.
 */
export interface ProductionStore {
  // Tenancy / identity
  getOrgBySlug(slug: string): Promise<Organization | null>;
  upsertUserByGoogleSub(
    user: Pick<User, "googleSub" | "email" | "displayName" | "pictureUrl">,
  ): Promise<User>;

  // Discovery snapshots (warm cache)
  listGtmContainers(orgId: Uuid, accountId: string): Promise<GtmContainerSnapshot[]>;
  upsertGtmContainers(orgId: Uuid, rows: GtmContainerSnapshot[]): Promise<void>;

  // Audit lifecycle
  createAuditRun(
    run: Omit<AuditRun, "id" | "createdAt" | "startedAt" | "finishedAt">,
  ): Promise<AuditRun>;
  getAuditRun(orgId: Uuid, id: Uuid): Promise<AuditRun | null>;
  listAuditRuns(orgId: Uuid, projectId?: Uuid): Promise<AuditRun[]>;
  insertFindings(orgId: Uuid, rows: AuditFindingRow[]): Promise<void>;

  // Worker queue
  enqueueJob(
    job: Omit<WorkerJob, "id" | "createdAt" | "updatedAt" | "finishedAt">,
  ): Promise<WorkerJob>;
  leaseNextJob(workerId: string, leaseSeconds: number): Promise<WorkerJob | null>;
  completeJob(id: Uuid, captureId: Uuid | null): Promise<void>;
  failJob(id: Uuid, error: string): Promise<void>;

  // Approvals
  listApprovals(orgId: Uuid, status?: ApprovalStatus): Promise<ApprovalRequest[]>;
}
