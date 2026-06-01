import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import {
  runConsentAudit,
  type ConsentAuditResult,
  type ConsentConfigInput,
  type ConsentFinding,
  type ConsentStateLabel,
  type RuntimeConsentEvent,
  type RuntimeCookie,
  type RuntimeHit as ConsentRuntimeHit,
  type RuntimeInput as ConsentRuntimeInput,
  type RuntimePage as ConsentRuntimePage,
} from "../../shared/consent-audit";

/**
 * /api/gtm/audit
 *
 * Evidence-based GTM QC auditor. Read-only against the GTM API v2.
 * Self-contained (no imports outside of `node:*`) so the route always
 * bundles on Vercel. The canonical engine still lives at
 * `apps/portal/server/gtm/audit.ts` for the Express dev server.
 *
 * Design rules:
 * - Only report what the configuration shows. No claims about runtime
 *   behavior (does a tag actually fire, double-fire, send correct data).
 * - If a tool call fails, record it in `toolFailures` and (where it
 *   matters) raise a Low/Medium finding so gaps are not silent.
 * - When uncertain, mark `needsManualReview: true` instead of guessing.
 */

const COOKIE_VERSION = "v1";
const SESSION_COOKIE = "samarth_portal_sid";

interface SessionTokensShape {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  scopes?: string[];
}

interface OAuthClientShape {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ── GTM v2 subset types ──────────────────────────────────────────────────

interface GtmParameter {
  type?: string;
  key?: string;
  value?: string;
  list?: GtmParameter[];
  map?: GtmParameter[];
}

interface GtmTag {
  tagId?: string;
  name?: string;
  type?: string;
  paused?: boolean;
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  firingRuleId?: string[];
  parameter?: GtmParameter[];
  parentFolderId?: string;
  consentSettings?: { consentStatus?: string; consentType?: { value?: string } };
}

interface GtmTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: unknown[];
  customEventFilter?: unknown[];
  parentFolderId?: string;
}

interface GtmVariable {
  variableId?: string;
  name?: string;
  type?: string;
  enablingTriggerId?: string[];
  parameter?: GtmParameter[];
  parentFolderId?: string;
}

interface GtmFolder {
  folderId?: string;
  name?: string;
}

interface GtmBuiltInVariable {
  type?: string;
  name?: string;
}

interface GtmClient {
  clientId?: string;
  name?: string;
  type?: string;
  parameter?: GtmParameter[];
}

interface GtmWorkspace {
  workspaceId?: string;
  name?: string;
  description?: string;
}

interface GtmContainer {
  containerId?: string;
  name?: string;
  publicId?: string;
  usageContext?: string[];
  domainName?: string[];
}

interface GtmVersionHeader {
  containerVersionId?: string;
  name?: string;
  deleted?: boolean;
}

interface GtmVersion {
  containerVersionId?: string;
  name?: string;
  notes?: string;
  fingerprint?: string;
}

// ── GA4 Admin API subset types ───────────────────────────────────────────

interface Ga4DataStream {
  name?: string; // properties/123/dataStreams/456
  type?: string;
  displayName?: string;
  webStreamData?: { measurementId?: string; defaultUri?: string };
  androidAppStreamData?: { packageName?: string };
  iosAppStreamData?: { bundleId?: string };
}
interface Ga4CustomDimension {
  parameterName?: string;
  displayName?: string;
  scope?: string;
}
interface Ga4CustomMetric {
  parameterName?: string;
  displayName?: string;
  scope?: string;
}
interface Ga4DataRetention {
  eventDataRetention?: string;
  resetUserDataOnNewActivity?: boolean;
}
interface Ga4GoogleAdsLink {
  customerId?: string;
  adsPersonalizationEnabled?: boolean;
}
interface Ga4EnhancedMeasurement {
  streamEnabled?: boolean;
}

/** Result of the optional GA4 Admin cross-source read. */
interface Ga4AdminState {
  propertyId: string;
  dataStreams: Ga4DataStream[];
  customDimensions: Ga4CustomDimension[];
  customMetrics: Ga4CustomMetric[];
  dataRetention: Ga4DataRetention | null;
  googleAdsLinks: Ga4GoogleAdsLink[];
  /** dataStreamId → enhanced measurement (web streams only). */
  enhancedMeasurement: Record<string, Ga4EnhancedMeasurement>;
  /** GA4 Admin reads that failed — surfaced so coverage is not over-claimed. */
  failures: AuditToolFailure[];
  /** True when at least one GA4 Admin call succeeded for this property. */
  ok: boolean;
}

// ── Runtime capture (RUNTIME source) ─────────────────────────────────────
// Parsed/normalized from an uploaded runtime-worker artifact. The audit NEVER
// fabricates these — RUNTIME stays Not Covered unless a capture is provided.
interface RuntimeTrackerHit {
  url?: string;
  method?: string;
  matched?: string[];
  groups?: string[];
  /** Parsed query params (v3 captures stamp gcs/gcd/tid/en/…). */
  query?: Record<string, string>;
  /** ms since navigation start, when the capture recorded ordering. */
  tMs?: number;
}
interface RuntimePageCapture {
  requestedUrl?: string;
  finalUrl?: string | null;
  /** Declared Consent Mode state this page was captured under (v3). */
  consentState?: ConsentStateLabel;
  consoleErrors?: string[];
  pageErrors?: string[];
  trackerHits?: RuntimeTrackerHit[];
  sgtmCandidates?: { url?: string }[];
  dataLayerEvents?: string[];
  dataLayerKeys?: string[];
  /** Consent default/update events observed in the dataLayer (v3). */
  consentEvents?: RuntimeConsentEvent[];
  /** Cookies observed, optionally with first-seen timing (v3). */
  cookies?: RuntimeCookie[];
  /** ms since navigation start of the first GA4 hit (v3). */
  firstMeasurementTMs?: number;
}
interface RuntimeState {
  capturedAt?: string;
  pages: RuntimePageCapture[];
  /** Distinct declared consent states present across pages (v3). */
  states: ConsentStateLabel[];
  /** True when the artifact parsed into at least one page. */
  ok: boolean;
}

// ── Server-side GTM context (SGTM source) ────────────────────────────────
// Optional reads of a selected server container, used to reconcile web GA4
// transport against the server endpoint and surface server clients/transforms.
interface SgtmContextState {
  accountId: string;
  containerId: string;
  isServer: boolean;
  /** Server container domain(s) / public id, used to match transport_url. */
  domainNames: string[];
  publicId?: string;
  clientTypes: string[];
  clientNames: string[];
  transformationNames: string[];
  failures: AuditToolFailure[];
  /** True when the container is server AND at least one read succeeded. */
  ok: boolean;
}

// ── GA4 Data API (DATA_API source) ───────────────────────────────────────
// Optional reporting read: event counts over the last N days, used to flag
// GTM-configured GA4 events that report zero activity.
interface DataApiState {
  propertyId: string;
  /** eventName → eventCount over the window. */
  eventCounts: Record<string, number>;
  windowDays: number;
  failures: AuditToolFailure[];
  /** True when the report read succeeded. */
  ok: boolean;
}

// ── Audit result types (mirror shared/portal-types.ts) ───────────────────

type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";

type AuditCategory =
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

type AuditSourceFlag =
  | "CONFIG"
  | "RUNTIME"
  | "SGTM"
  | "GA4_ADMIN"
  | "DATA_API";
type AuditCoverage = "covered" | "partial" | "not_covered";
type AuditConfidence = "high" | "medium" | "low";
type AuditEffort = "S" | "M" | "L";

interface AuditCapabilityFlags {
  CONFIG: boolean;
  RUNTIME: boolean;
  SGTM: boolean;
  GA4_ADMIN: boolean;
  DATA_API: boolean;
}

interface AuditCoverageItem {
  id: string;
  capability: string;
  requires: AuditSourceFlag[];
  status: AuditCoverage;
  toolNeeded?: string;
}

interface AuditFinding {
  id: string;
  category: AuditCategory;
  title: string;
  description: string;
  severity: AuditSeverity;
  affects?: string[];
  recommendation?: string;
  finding?: string;
  affected?: string[];
  whyItMatters?: string;
  suggestedFix?: string;
  needsManualReview?: boolean;
  sources?: AuditSourceFlag[];
  confidence?: AuditConfidence;
  entity?: { name?: string; id?: string; path?: string };
  parameter?: string;
  businessImpact?: string;
  effort?: AuditEffort;
}

interface AuditToolFailure {
  resource: string;
  message: string;
  status?: number;
}

interface AuditDomainMaturity {
  domain: string;
  score: number;
  counts: { critical: number; high: number; medium: number; low: number };
  capConfidence?: boolean;
}

interface AuditHeatMapRow {
  domain: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface AuditRoadmapItem {
  id: string;
  title: string;
  type: "quick_win" | "structural";
  effort: AuditEffort;
  rationale: string;
  findingIds: string[];
}

interface AuditExecutiveSummary {
  overallMaturity: number;
  topRisks: { findingId: string; title: string; severity: AuditSeverity }[];
  publishSafe: "yes" | "caution" | "no";
  publishSafeReason: string;
  singleSourceWarning?: string;
}

interface AuditSummary {
  containerId: string;
  generatedAt: string;
  healthScore: number;
  counts: { tags: number; triggers: number; variables: number };
  findings: AuditFinding[];
  containerType?: string;
  workspaceCount?: number;
  publishedVersion?: { versionId?: string; name?: string; notes?: string } | null;
  toolFailures?: AuditToolFailure[];
  summary?: string;
  gtmMeasurementIds?: string[];
  capabilityFlags?: AuditCapabilityFlags;
  coverageMatrix?: AuditCoverageItem[];
  executiveSummary?: AuditExecutiveSummary;
  domainMaturity?: AuditDomainMaturity[];
  heatMap?: AuditHeatMapRow[];
  roadmap?: AuditRoadmapItem[];
  /** Consent Mode v2 + runtime proof summary (see shared/consent-audit.ts). */
  consentAudit?: {
    coverage: "config_only" | "runtime_imported" | "reconciled";
    runtimeStates: string[];
    stateCoverage: { denied: boolean; granted: boolean; partial: boolean };
    findingCount: number;
  };
}

interface AuditState {
  contents: WorkspaceContents;
  container: GtmContainer | null;
  workspaces: GtmWorkspace[];
  publishedVersion: GtmVersion | null;
  clients: GtmClient[];
  toolFailures: AuditToolFailure[];
}

interface WorkspaceContents {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  folders: GtmFolder[];
  builtInVariables: GtmBuiltInVariable[];
  templates: unknown[];
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }

    const secret =
      process.env.PORTAL_SESSION_SECRET ?? process.env.SESSION_SECRET ?? "";
    if (secret.length < 16) {
      return sendJson(res, 500, {
        error: "config_error",
        message: "PORTAL_SESSION_SECRET must be set on Vercel.",
      });
    }

    const client = resolveOAuthClient();
    if (!client) return sendJson(res, 503, { error: "oauth_not_configured" });

    const token = await getValidAccessToken(req, res, client, secret);
    if (!token) return sendJson(res, 401, { error: "not_connected" });

    const body = await readJsonBody<{
      accountId?: string;
      containerId?: string;
      workspaceId?: string;
      containerPublicId?: string;
      ga4PropertyId?: string;
      runtimeCapture?: unknown;
      serverContext?: {
        accountId?: string;
        containerId?: string;
        workspaceId?: string;
      };
      enableDataApi?: boolean;
    }>(req);
    const { accountId, containerId, workspaceId, containerPublicId } = body;
    const ga4PropertyId =
      typeof body.ga4PropertyId === "string" && body.ga4PropertyId.trim()
        ? body.ga4PropertyId.trim()
        : undefined;
    if (!accountId || !containerId || !workspaceId) {
      return sendJson(res, 400, {
        error: "missing_params",
        message:
          "accountId, containerId and workspaceId are required. Use /api/gtm/accounts, /api/gtm/accounts/:id/containers, and the workspaces list to choose them, then retry.",
      });
    }

    // Parse an uploaded runtime capture (RUNTIME source). Never fabricated —
    // null unless the caller supplies a parseable artifact.
    const runtime = parseRuntimeCapture(body.runtimeCapture);

    // Optional server-side context (SGTM source). Only used when the caller
    // selected a server account/container/workspace distinct from a stub.
    const sc = body.serverContext;
    const hasServerContext = Boolean(
      sc && sc.accountId && sc.containerId && sc.workspaceId,
    );

    try {
      const state = await pullAuditState(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      // Optional GA4 Admin cross-source read. Failures never abort the audit —
      // they are recorded so the audit can mark GA4_ADMIN Partial / Not Covered.
      const ga4 = ga4PropertyId
        ? await pullGa4AdminState(token, ga4PropertyId)
        : null;

      // Optional server container reads (SGTM). Best-effort; failures recorded.
      const sgtm = hasServerContext
        ? await pullSgtmContext(
            token,
            sc!.accountId!,
            sc!.containerId!,
            sc!.workspaceId!,
          )
        : null;

      // Optional GA4 Data API report (DATA_API). Only when a property was
      // selected AND the caller opted in. Failures never abort the audit.
      const dataApi =
        ga4PropertyId && body.enableDataApi === true
          ? await pullDataApiState(token, ga4PropertyId)
          : null;

      const summary = runAudit(state, {
        containerPublicId: containerPublicId ?? containerId,
        ga4,
        runtime,
        sgtm,
        dataApi,
      });
      return sendJson(res, 200, summary);
    } catch (e) {
      return sendGtmError(res, e, "Failed to run GTM audit");
    }
  } catch (e) {
    console.error(
      "[portal] /api/gtm/audit: unrecoverable error:",
      safeErrorName(e),
    );
    return sendJson(res, 500, {
      error: "internal_error",
      message: "/api/gtm/audit handler failed",
      detail: safeErrorName(e),
    });
  }
}

// ── Audit engine ─────────────────────────────────────────────────────────

interface Ctx {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  folders: GtmFolder[];
  builtIns: GtmBuiltInVariable[];
  clients: GtmClient[];
  container: GtmContainer | null;
  workspaces: GtmWorkspace[];
  publishedVersion: GtmVersion | null;
  triggerIdSet: Set<string>;
  triggerById: Map<string, GtmTrigger>;
  builtInTypes: Set<string>;
  textBlob: string;
  ga4: Ga4AdminState | null;
  runtime: RuntimeState | null;
  sgtm: SgtmContextState | null;
  dataApi: DataApiState | null;
}

function fid(seed: string): string {
  return (
    "f_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)
  );
}

function buildCtx(
  state: AuditState,
  ga4: Ga4AdminState | null,
  runtime: RuntimeState | null = null,
  sgtm: SgtmContextState | null = null,
  dataApi: DataApiState | null = null,
): Ctx {
  const triggerIdSet = new Set(
    state.contents.triggers.map((t) => t.triggerId ?? "").filter(Boolean),
  );
  const triggerById = new Map<string, GtmTrigger>();
  for (const t of state.contents.triggers) {
    if (t.triggerId) triggerById.set(t.triggerId, t);
  }
  const builtInTypes = new Set(
    state.contents.builtInVariables.map((b) => b.type ?? "").filter(Boolean),
  );
  return {
    tags: state.contents.tags,
    triggers: state.contents.triggers,
    variables: state.contents.variables,
    folders: state.contents.folders,
    builtIns: state.contents.builtInVariables,
    clients: state.clients,
    container: state.container,
    workspaces: state.workspaces,
    publishedVersion: state.publishedVersion,
    triggerIdSet,
    triggerById,
    builtInTypes,
    textBlob: collectTextBlob(state.contents),
    ga4,
    runtime,
    sgtm,
    dataApi,
  };
}

function collectTextBlob(c: WorkspaceContents): string {
  const parts: string[] = [];
  for (const t of c.tags) {
    parts.push(t.name ?? "", t.type ?? "");
    for (const p of t.parameter ?? []) walkParam(p, parts);
  }
  for (const v of c.variables) {
    parts.push(v.name ?? "", v.type ?? "");
    for (const p of v.parameter ?? []) walkParam(p, parts);
  }
  return parts.join("\n").toLowerCase();
}

function walkParam(p: GtmParameter, sink: string[]): void {
  if (p.key) sink.push(p.key);
  if (p.value) sink.push(p.value);
  for (const child of p.list ?? []) walkParam(child, sink);
  for (const child of p.map ?? []) walkParam(child, sink);
}

function tagParam(tag: GtmTag, key: string): string | undefined {
  return tag.parameter?.find((p) => p.key === key)?.value;
}

// Heuristics that match a wide set of GTM tag types. We are deliberately
// conservative: only label families we can identify with confidence.

function isGA4Config(tag: GtmTag): boolean {
  // gaawc = GA4 Configuration (legacy); googtag = Google tag (current).
  return tag.type === "gaawc" || tag.type === "googtag";
}
function isGA4Event(tag: GtmTag): boolean {
  return tag.type === "gaawe";
}
function isMarketingOrAnalyticsTag(tag: GtmTag): boolean {
  const t = (tag.type ?? "").toLowerCase();
  if (!t) return false;
  // GA4 / UA / Google Ads conversions / Floodlight / Meta-pixel templates /
  // generic marketing pixel image tags.
  if (
    [
      "gaawc",
      "gaawe",
      "googtag",
      "ua",
      "awct", // Google Ads conversion tracking
      "sp", // Google Ads remarketing
      "flc", // Floodlight counter
      "fls", // Floodlight sales
      "img", // image pixel
    ].includes(t)
  ) {
    return true;
  }
  // Custom-template tags whose names hint at marketing/analytics platforms
  // — flagged only as "needs manual review" by callers.
  return false;
}

const ALL_PAGES_TRIGGER_TYPE = "pageview";

// ── Rules ────────────────────────────────────────────────────────────────

// A. Dead / orphaned config
function ruleTagsNoFiringTriggers(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    const has =
      (tag.firingTriggerId?.length ?? 0) > 0 ||
      (tag.firingRuleId?.length ?? 0) > 0;
    if (!has) {
      const name = tag.name ?? "Unnamed tag";
      pushFinding(out, {
        id: fid(`no-trigger:${tag.tagId}`),
        category: "dead_config",
        severity: "high",
        finding: "Tag has no firing trigger attached",
        affected: [name],
        whyItMatters:
          "Without a firing trigger the tag is dormant and serves no purpose in this workspace.",
        suggestedFix:
          "Attach an appropriate firing trigger or delete the tag if it is no longer needed.",
        sources: ["CONFIG"],
        entity: tagEntity(tag),
        parameter: "firingTriggerId",
        businessImpact:
          "Dead configuration accumulates and hides the true tag inventory, making future debugging slower.",
        effort: "S",
      });
    }
  }
}

function ruleUnusedTriggers(ctx: Ctx, out: AuditFinding[]) {
  const used = new Set<string>();
  for (const tag of ctx.tags) {
    for (const tid of [
      ...(tag.firingTriggerId ?? []),
      ...(tag.blockingTriggerId ?? []),
    ]) {
      used.add(tid);
    }
  }
  for (const v of ctx.variables) {
    for (const tid of v.enablingTriggerId ?? []) used.add(tid);
  }
  for (const t of ctx.triggers) {
    const id = t.triggerId ?? "";
    if (!id) continue;
    if (!used.has(id)) {
      const name = t.name ?? "Unnamed trigger";
      pushFinding(out, {
        id: fid(`unused-trigger:${id}`),
        category: "dead_config",
        severity: "low",
        finding: "Trigger is not referenced by any tag or variable",
        affected: [name],
        whyItMatters:
          "Unused triggers add clutter and obscure what the container is actually doing.",
        suggestedFix:
          "Remove the trigger if it is truly unused. Confirm first that nothing depends on it.",
        sources: ["CONFIG"],
        entity: triggerEntity(t),
        businessImpact: "Container clutter slows onboarding of new contributors.",
        effort: "S",
      });
    }
  }
}

function ruleUnusedVariables(ctx: Ctx, out: AuditFinding[]) {
  const namesUsed = new Set<string>();
  const collect = (s?: string) => {
    if (!s) return;
    const re = /\{\{([^}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      namesUsed.add(m[1].trim().toLowerCase());
    }
  };
  const walk = (p?: GtmParameter) => {
    if (!p) return;
    collect(p.value);
    for (const c of p.list ?? []) walk(c);
    for (const c of p.map ?? []) walk(c);
  };
  for (const tag of ctx.tags) {
    for (const p of tag.parameter ?? []) walk(p);
  }
  for (const v of ctx.variables) {
    for (const p of v.parameter ?? []) walk(p);
  }
  for (const t of ctx.triggers) {
    collect(JSON.stringify(t.filter ?? []));
    collect(JSON.stringify(t.customEventFilter ?? []));
  }
  for (const v of ctx.variables) {
    const name = (v.name ?? "").trim();
    if (!name) continue;
    if (!namesUsed.has(name.toLowerCase())) {
      pushFinding(out, {
        id: fid(`unused-var:${v.variableId}`),
        category: "dead_config",
        severity: "low",
        finding: "User-defined variable is not referenced",
        affected: [name],
        whyItMatters:
          "The variable is not read by any tag, trigger, or other variable in this workspace.",
        suggestedFix:
          "Delete the variable if it is no longer needed. Mark as 'needs manual review' if cross-workspace use is possible.",
        needsManualReview: true,
        sources: ["CONFIG"],
        entity: variableEntity(v),
        businessImpact: "Dead variables make refactoring riskier — engineers cannot tell what is safe to remove.",
        effort: "S",
      });
    }
  }
}

function rulePausedTags(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (tag.paused) {
      const name = tag.name ?? "Unnamed tag";
      pushFinding(out, {
        id: fid(`paused:${tag.tagId}`),
        category: "dead_config",
        severity: "medium",
        finding: "Paused tag still present in the workspace",
        affected: [name],
        whyItMatters:
          "Paused tags never publish but stay in the container, hiding the real configuration.",
        suggestedFix:
          "Unpause the tag if it is still required, otherwise delete it.",
        sources: ["CONFIG"],
        entity: tagEntity(tag),
        parameter: "paused",
        businessImpact:
          "Paused-but-present tags create ambiguity about which behaviours are live in production.",
        effort: "S",
      });
    }
  }
}

function ruleBrokenReferences(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    const name = tag.name ?? "Unnamed tag";
    for (const tid of tag.firingTriggerId ?? []) {
      if (!ctx.triggerIdSet.has(tid)) {
        pushFinding(out, {
          id: fid(`broken-fire:${tag.tagId}:${tid}`),
          category: "dead_config",
          severity: "high",
          finding: "Tag references a firing trigger that does not exist",
          affected: [name],
          whyItMatters: `Firing trigger id "${tid}" is not defined in this workspace. The tag's firing rule is incomplete.`,
          suggestedFix: "Re-attach a valid trigger or remove the dangling reference.",
          sources: ["CONFIG"],
          entity: tagEntity(tag),
          parameter: "firingTriggerId",
          businessImpact: "Broken references can silently disable measurement for important events.",
          effort: "S",
        });
      }
    }
    for (const tid of tag.blockingTriggerId ?? []) {
      if (!ctx.triggerIdSet.has(tid)) {
        pushFinding(out, {
          id: fid(`broken-block:${tag.tagId}:${tid}`),
          category: "dead_config",
          severity: "medium",
          finding: "Tag references a blocking trigger that does not exist",
          affected: [name],
          whyItMatters: `Blocking trigger id "${tid}" is not defined in this workspace.`,
          suggestedFix: "Remove the dangling blocking-trigger reference.",
          sources: ["CONFIG"],
          entity: tagEntity(tag),
          parameter: "blockingTriggerId",
          businessImpact: "Dangling references confuse audits and reviews.",
          effort: "S",
        });
      }
    }
  }
}

// B. GA4 integrity
function ruleGA4ConfigCount(ctx: Ctx, out: AuditFinding[]) {
  const configTags = ctx.tags.filter(isGA4Config);
  if (configTags.length === 0) {
    // Only emit if any GA4 event tag exists — otherwise this is not a GA4
    // container and the finding would be a false positive.
    if (ctx.tags.some(isGA4Event)) {
      pushFinding(out, {
        id: fid("ga4-config-missing"),
        category: "ga4",
        severity: "high",
        finding: "GA4 event tags exist but no Google tag / GA4 Configuration tag was found",
        whyItMatters:
          "GA4 event tags rely on a configured Google tag (or GA4 Configuration tag) to set the measurement ID and initialise GA4.",
        suggestedFix:
          "Add a Google tag with the correct measurement ID, or confirm the measurement ID is set via measurementIdOverride on every event tag.",
        sources: ["CONFIG"],
        parameter: "tagId / measurementId",
        businessImpact:
          "Without a base Google tag, GA4 events may not be initialised and reporting can be incomplete.",
        effort: "S",
      });
    }
    return;
  }
  if (configTags.length > 1) {
    pushFinding(out, {
      id: fid(`ga4-config-count:${configTags.length}`),
      category: "duplication",
      severity: "high",
      finding: `Container has ${configTags.length} Google tag / GA4 Configuration tags (one expected)`,
      affected: configTags.map((t) => t.name ?? "Unnamed"),
      whyItMatters:
        "Multiple Google tag / GA4 Configuration tags configured in the same container is unusual; runtime behaviour depends on their triggers but the configuration alone signals possible duplication.",
      suggestedFix:
        "Consolidate down to one Google tag where possible, or document why both are needed.",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact: "Duplicate base tags can cause double page_view counts in GA4.",
      effort: "M",
    });
  }
}

function ruleGA4MeasurementIdsConsistent(ctx: Ctx, out: AuditFinding[]) {
  const ids = new Set<string>();
  const offenders: string[] = [];
  for (const tag of ctx.tags) {
    if (!isGA4Config(tag) && !isGA4Event(tag)) continue;
    const id =
      tagParam(tag, "tagId") ??
      tagParam(tag, "measurementId") ??
      tagParam(tag, "measurementIdOverride");
    if (!id) continue;
    if (/^G-/i.test(id) || /^GT-/i.test(id)) {
      ids.add(id.toUpperCase());
    } else if (id.startsWith("{{")) {
      // Variable reference — track separately, do not flag as inconsistent.
      ids.add(id);
    } else {
      offenders.push(`${tag.name ?? "(unnamed)"} → ${id}`);
    }
  }
  if (offenders.length > 0) {
    pushFinding(out, {
      id: fid(`ga4-mid-shape:${offenders.length}`),
      category: "ga4",
      severity: "high",
      finding: "GA4 tag has a measurement ID that does not look like G-XXXXXXX or GT-XXXXXXX",
      affected: offenders,
      whyItMatters:
        "GA4 measurement IDs always start with G-. A different shape will not be accepted by GA4 and hits will not land.",
      suggestedFix:
        "Replace the value with a valid G-XXXXXXX measurement ID or a variable that resolves to one.",
      sources: ["CONFIG"],
      parameter: "measurementId / tagId",
      businessImpact: "Hits with an invalid measurement ID will be dropped — analytics data is lost.",
      effort: "S",
    });
  }
  if (ids.size > 1) {
    pushFinding(out, {
      id: fid(`ga4-mid-mixed:${Array.from(ids).sort().join(",")}`),
      category: "ga4",
      severity: "medium",
      finding: "Multiple distinct GA4 measurement IDs referenced across tags",
      affected: Array.from(ids),
      whyItMatters:
        "GA4 tags in this container point to more than one measurement ID. This may be intentional (multi-property streaming) but is often a mistake.",
      suggestedFix:
        "Confirm each measurement ID is intentional; otherwise standardise on one.",
      needsManualReview: true,
      sources: ["CONFIG"],
      parameter: "measurementId / tagId",
      businessImpact: "Data may be split across properties, fragmenting reporting.",
      effort: "M",
    });
  }
}

function ruleGA4EventCompleteness(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    const name = tag.name ?? "GA4 event";
    const eventName = tagParam(tag, "eventName");
    if (!eventName) {
      pushFinding(out, {
        id: fid(`ga4-event-name:${tag.tagId}`),
        category: "ga4",
        severity: "high",
        finding: "GA4 Event tag is missing the event_name parameter",
        affected: [name],
        whyItMatters:
          "Without an event_name GTM cannot send a labelled GA4 event.",
        suggestedFix:
          "Set an event_name (e.g. purchase, sign_up, generate_lead).",
        sources: ["CONFIG"],
        entity: tagEntity(tag),
        parameter: "eventName",
        businessImpact: "Event will not be recorded as a distinct event in GA4 reporting.",
        effort: "S",
      });
    }
    const configRef =
      tagParam(tag, "measurementId") ?? tagParam(tag, "measurementIdOverride");
    if (!configRef) {
      pushFinding(out, {
        id: fid(`ga4-event-config:${tag.tagId}`),
        category: "ga4",
        severity: "low",
        finding: "GA4 Event tag has no measurementIdOverride set",
        affected: [name],
        whyItMatters:
          "Without an override, the event tag relies on the Google tag's measurement ID. This is usually fine, but worth confirming when multiple Google tags exist.",
        suggestedFix:
          "If multiple Google tags are present, set measurementIdOverride explicitly.",
        needsManualReview: true,
        sources: ["CONFIG"],
        entity: tagEntity(tag),
        parameter: "measurementIdOverride",
        businessImpact: "Possible misrouting of events between GA4 properties when multiple base tags exist.",
        effort: "S",
      });
    }
  }
}

function ruleGA4AllPages(ctx: Ctx, out: AuditFinding[]) {
  // Flag GA4 *event* tags (not config) bound to an All Pages / pageview
  // trigger — that pattern is rarely correct.
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    const name = tag.name ?? "GA4 event";
    const usesAllPages = (tag.firingTriggerId ?? []).some((tid) => {
      const trig = ctx.triggerById.get(tid);
      return trig?.type === ALL_PAGES_TRIGGER_TYPE;
    });
    if (usesAllPages) {
      pushFinding(out, {
        id: fid(`ga4-event-allpages:${tag.tagId}`),
        category: "ga4",
        severity: "medium",
        finding: "GA4 Event tag fires on an All Pages / pageview trigger",
        affected: [name],
        whyItMatters:
          "GA4 Configuration tags already send page_view on All Pages. A GA4 event tag bound to All Pages duplicates page_view or sends a custom event on every navigation.",
        suggestedFix:
          "Confirm this is intentional. Otherwise switch to a specific Custom Event trigger.",
        needsManualReview: true,
        sources: ["CONFIG"],
        entity: tagEntity(tag),
        parameter: "firingTriggerId",
        businessImpact: "Inflated event counts cause downstream reporting errors and noisy attribution.",
        effort: "M",
      });
    }
  }
}

// C. Consent Mode v2 — see runConsentAudit() / shared/consent-audit.ts. The
// CONFIG, RUNTIME, and reconciliation consent rules now live in that pure,
// separately-tested module and are invoked from runAudit().

// D. Data quality
function ruleHardcodedIds(ctx: Ctx, out: AuditFinding[]) {
  const offenders: string[] = [];
  for (const tag of ctx.tags) {
    const name = tag.name ?? "Unnamed tag";
    for (const p of tag.parameter ?? []) {
      const v = p.value;
      if (!v || typeof v !== "string") continue;
      // Hardcoded GA4 MID
      if (/^G-[A-Z0-9]{6,}$/i.test(v.trim())) {
        offenders.push(`${name} → ${p.key ?? "?"} = ${v}`);
      }
      // Hardcoded GTM container id
      if (/^GTM-[A-Z0-9]{4,}$/i.test(v.trim())) {
        offenders.push(`${name} → ${p.key ?? "?"} = ${v}`);
      }
      // Google Ads conversion id (AW-XXXXXXXXX)
      if (/^AW-\d{6,}$/i.test(v.trim())) {
        offenders.push(`${name} → ${p.key ?? "?"} = ${v}`);
      }
    }
  }
  // De-duplicate
  const unique = Array.from(new Set(offenders));
  if (unique.length > 0) {
    pushFinding(out, {
      id: fid(`hardcoded-ids:${unique.length}`),
      category: "data_quality",
      severity: "low",
      finding: "Hardcoded IDs found in tag parameters",
      affected: unique.slice(0, 20),
      whyItMatters:
        "Hardcoded measurement IDs, conversion IDs, or container IDs make it hard to swap environments and easy to point at the wrong property.",
      suggestedFix:
        "Move IDs into a Constant or Lookup variable and reference {{Variable Name}} from the tag.",
      sources: ["CONFIG"],
      businessImpact: "Increases risk of pointing production tags at the wrong account during environment swaps.",
      effort: "M",
    });
  }
}

function ruleDataLayerNoDefault(ctx: Ctx, out: AuditFinding[]) {
  const offenders: string[] = [];
  for (const v of ctx.variables) {
    if (v.type !== "v") continue; // Data Layer Variable
    const hasDefault =
      (v.parameter ?? []).some(
        (p) => p.key === "defaultValue" && typeof p.value === "string" && p.value.length > 0,
      ) ||
      (v.parameter ?? []).some((p) => p.key === "setDefaultValue" && p.value === "true");
    if (!hasDefault) offenders.push(v.name ?? "Unnamed DL variable");
  }
  if (offenders.length > 0) {
    pushFinding(out, {
      id: fid(`dl-no-default:${offenders.length}`),
      category: "data_layer",
      severity: "low",
      finding: `${offenders.length} Data Layer variable(s) have no default value set`,
      affected: offenders.slice(0, 20),
      whyItMatters:
        "A missing default means consumers receive `undefined` when the key is absent from the dataLayer. Downstream tags may send empty event parameters.",
      suggestedFix:
        "Set a sensible default (often empty string, 0, or 'not_set') on each Data Layer variable.",
      sources: ["CONFIG"],
      parameter: "defaultValue",
      businessImpact: "Empty event params reduce GA4 dimension fill rates and harm reporting.",
      effort: "S",
    });
  }
}

function rulePiiManualReview(ctx: Ctx, out: AuditFinding[]) {
  const PII_RE = /(email|e-mail|phone|tel|first_?name|last_?name|full_?name|ssn|dob|date_?of_?birth|address)/i;
  const offenders: string[] = [];
  for (const v of ctx.variables) {
    const name = v.name ?? "";
    const blob = `${name} ${JSON.stringify(v.parameter ?? [])}`;
    if (PII_RE.test(blob)) offenders.push(`Variable: ${name || "(unnamed)"}`);
  }
  for (const tag of ctx.tags) {
    const blob = `${tag.name ?? ""} ${JSON.stringify(tag.parameter ?? [])}`;
    if (PII_RE.test(blob)) offenders.push(`Tag: ${tag.name ?? "(unnamed)"}`);
  }
  const unique = Array.from(new Set(offenders));
  if (unique.length > 0) {
    pushFinding(out, {
      id: fid(`pii-review:${unique.length}`),
      category: "privacy",
      severity: "medium",
      finding: "Possible PII references found in tag or variable configuration",
      affected: unique.slice(0, 20),
      whyItMatters:
        "Names like email/phone/first_name suggest PII may be read from URL params, dataLayer, or cookies. Sending PII to analytics platforms is usually a policy violation.",
      suggestedFix:
        "Manually review each item. Confirm values are hashed or removed before they reach downstream tools.",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact:
        "Sending raw PII to analytics or ads platforms is a privacy/compliance violation in most jurisdictions.",
      effort: "M",
    });
  }
}

// E. Duplicates and double-counting
function ruleDuplicateGA4Events(ctx: Ctx, out: AuditFinding[]) {
  const byKey = new Map<string, GtmTag[]>();
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    const eventName = (tagParam(tag, "eventName") ?? "").trim().toLowerCase();
    if (!eventName) continue;
    const triggers = (tag.firingTriggerId ?? []).slice().sort().join("|");
    const key = `${eventName}::${triggers}`;
    const arr = byKey.get(key) ?? [];
    arr.push(tag);
    byKey.set(key, arr);
  }
  byKey.forEach((arr, key) => {
    if (arr.length > 1) {
      pushFinding(out, {
        id: fid(`ga4-dup-event:${key}`),
        category: "duplication",
        severity: "high",
        finding: `${arr.length} GA4 Event tags share the same event_name and firing triggers`,
        affected: arr.map((t) => t.name ?? "Unnamed"),
        whyItMatters:
          "Tags configured identically on the same triggers send the same payload. Configuration overlap is a strong signal of double-counting risk.",
        suggestedFix:
          "Keep one canonical event tag and delete or repurpose the duplicates.",
        sources: ["CONFIG"],
        parameter: "eventName + firingTriggerId",
        businessImpact: "Double-counted events distort revenue and conversion KPIs.",
        effort: "S",
      });
    }
  });
}

function ruleDuplicateTagNames(ctx: Ctx, out: AuditFinding[]) {
  const counts = new Map<string, number>();
  for (const tag of ctx.tags) {
    const n = (tag.name ?? "").trim();
    if (!n) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  counts.forEach((c, n) => {
    if (c > 1) {
      pushFinding(out, {
        id: fid(`dup-name:${n}`),
        category: "naming",
        severity: "low",
        finding: `Tag name "${n}" is used ${c} times`,
        affected: [n],
        whyItMatters:
          "Duplicate names make it hard to identify which tag is which during debugging.",
        suggestedFix: "Rename the duplicates so each tag has a unique, descriptive name.",
        sources: ["CONFIG"],
        businessImpact: "Slower debugging and risk of editing the wrong tag.",
        effort: "S",
      });
    }
  });
}

function ruleDuplicateConversionPages(ctx: Ctx, out: AuditFinding[]) {
  // Multiple Google Ads conversion linker tags with the same conversion_id +
  // overlapping triggers.
  type ConvKey = { id: string; triggers: string };
  const groups = new Map<string, GtmTag[]>();
  for (const tag of ctx.tags) {
    if (tag.type !== "awct") continue;
    const id = (tagParam(tag, "conversionId") ?? "").trim();
    if (!id) continue;
    const triggers = (tag.firingTriggerId ?? []).slice().sort().join("|");
    const key = `${id}::${triggers}`;
    const arr = groups.get(key) ?? [];
    arr.push(tag);
    groups.set(key, arr);
  }
  groups.forEach((arr, key) => {
    if (arr.length > 1) {
      pushFinding(out, {
        id: fid(`ads-conv-dup:${key}`),
        category: "duplication",
        severity: "high",
        finding: `${arr.length} Google Ads conversion tags share the same conversion_id and firing triggers`,
        affected: arr.map((t) => t.name ?? "Unnamed"),
        whyItMatters:
          "Configuration overlap between conversion tags is a strong signal of double-counted conversions.",
        suggestedFix:
          "Keep one conversion tag per conversion_id/trigger combination.",
        sources: ["CONFIG"],
        parameter: "conversionId + firingTriggerId",
        businessImpact: "Inflated Google Ads conversions break ROAS optimisation and bidding.",
        effort: "S",
      });
    }
  });
}

// F. Naming and structure (kept conservative — only flag if folders are
// used elsewhere, signalling that folders are part of the team's convention)
function ruleFolderConsistency(ctx: Ctx, out: AuditFinding[]) {
  if (ctx.folders.length === 0) return;
  const orphans = ctx.tags.filter((t) => !t.parentFolderId);
  if (orphans.length === 0) return;
  if (orphans.length === ctx.tags.length) return; // folders unused — no signal
  pushFinding(out, {
    id: fid(`folder-orphans:${orphans.length}`),
    category: "governance",
    severity: "low",
    finding: `${orphans.length} tag(s) are not placed in any folder, but folders are used elsewhere`,
    affected: orphans.slice(0, 20).map((t) => t.name ?? "Unnamed"),
    whyItMatters:
      "Mixed folder usage suggests the team intended a structure but new tags drifted outside it, making maintenance harder.",
    suggestedFix: "Place the orphan tags in the appropriate folder.",
    sources: ["CONFIG"],
    businessImpact: "Slower handovers and audits — orphaned tags break the team's organisation conventions.",
    effort: "S",
  });
}

// G. Server-side only
function ruleServerSideClients(ctx: Ctx, out: AuditFinding[]) {
  const isServer = (ctx.container?.usageContext ?? []).some(
    (u) => u.toLowerCase() === "server",
  );
  if (!isServer) return;
  if (ctx.clients.length === 0) {
    pushFinding(out, {
      id: fid("ss-no-clients"),
      category: "server_side",
      severity: "high",
      finding: "Server container has no Clients configured",
      whyItMatters:
        "A server container without Clients cannot claim incoming requests, so no tags will run.",
      suggestedFix: "Add the appropriate Client (e.g. GA4 client, Google Tag Manager: Web Container).",
      sources: ["CONFIG"],
      businessImpact: "No server-side measurement is happening at all.",
      effort: "M",
    });
    return;
  }
  const hasGa4Client = ctx.clients.some((c) =>
    /ga4|google[\s_-]?analytics/i.test(`${c.name ?? ""} ${c.type ?? ""}`),
  );
  const hasGa4OutTags = ctx.tags.some((t) => (t.type ?? "").toLowerCase().includes("ga4"));
  if (hasGa4OutTags && !hasGa4Client) {
    pushFinding(out, {
      id: fid("ss-no-ga4-client"),
      category: "server_side",
      severity: "medium",
      finding: "GA4 outbound tags exist but no GA4 Client appears to be configured",
      whyItMatters:
        "Without a GA4 Client the server container cannot accept GA4 hits from the web container.",
      suggestedFix: "Add a GA4 Client (or confirm one is provided by a template).",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact: "GA4 events from the web container may not reach the server container at all.",
      effort: "M",
    });
  }
}

// H. Publishing state
function rulePublishingState(ctx: Ctx, out: AuditFinding[]) {
  if (ctx.workspaces.length > 1) {
    pushFinding(out, {
      id: fid(`ws-multi:${ctx.workspaces.length}`),
      category: "governance",
      severity: "low",
      finding: `${ctx.workspaces.length} open workspaces in this container`,
      affected: ctx.workspaces.map((w) => w.name ?? "Unnamed workspace"),
      whyItMatters:
        "Multiple open workspaces increase the risk of conflicting edits and stale changes shipping.",
      suggestedFix:
        "Merge, publish, or abandon stale workspaces. Keep one active workspace per work-in-progress.",
      sources: ["CONFIG"],
      businessImpact: "Higher chance of stale or conflicting changes shipping to production.",
      effort: "S",
    });
  }
  if (ctx.publishedVersion && !ctx.publishedVersion.notes) {
    pushFinding(out, {
      id: fid(`pubver-no-notes:${ctx.publishedVersion.containerVersionId}`),
      category: "governance",
      severity: "low",
      finding: "Latest published version has no release notes",
      affected: [
        ctx.publishedVersion.name ??
          `version ${ctx.publishedVersion.containerVersionId ?? "?"}`,
      ],
      whyItMatters:
        "Release notes are the audit trail for what was published and why. Empty notes make rollbacks and reviews harder.",
      suggestedFix:
        "Add a short note to each new version describing what changed and why.",
      sources: ["CONFIG"],
      parameter: "notes",
      businessImpact: "Audit trail gaps slow incident response and rollbacks.",
      effort: "S",
    });
  }
}

// Tool failures surfaced as findings so users know the audit is incomplete.
function ruleToolFailures(state: AuditState, out: AuditFinding[]) {
  for (const tf of state.toolFailures) {
    pushFinding(out, {
      id: fid(`tool-fail:${tf.resource}`),
      category: "tool_failure",
      severity: severityForResource(tf.resource),
      finding: `Could not read ${tf.resource} from the GTM API`,
      whyItMatters: tf.message,
      suggestedFix:
        "Re-run the audit. If the failure persists, confirm the account has access to this resource.",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact: "Audit coverage is incomplete; findings should not be assumed clean for this area.",
      effort: "S",
    });
  }
}

// I. Performance — Custom HTML count and document.write detection (CONFIG-only)
function rulePerformance(ctx: Ctx, out: AuditFinding[]) {
  const customHtml = ctx.tags.filter((t) => t.type === "html");
  if (customHtml.length >= 8) {
    pushFinding(out, {
      id: fid(`perf-customhtml-count:${customHtml.length}`),
      category: "performance",
      severity: "medium",
      finding: `Container has ${customHtml.length} Custom HTML tags`,
      affected: customHtml.slice(0, 20).map((t) => t.name ?? "Unnamed"),
      whyItMatters:
        "Large numbers of Custom HTML tags are a configuration risk: they bypass GTM's template sandbox, are harder to review, and can slow page load when bound to All Pages.",
      suggestedFix:
        "Audit each Custom HTML tag, migrate to certified templates where possible, and constrain triggers narrowly.",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact: "Higher risk of XSS, slower pages, and harder code review.",
      effort: "L",
    });
  }
  const docWriteOffenders: GtmTag[] = [];
  for (const t of customHtml) {
    const html = (t.parameter ?? []).find((p) => p.key === "html")?.value ?? "";
    if (/document\.write/i.test(html)) docWriteOffenders.push(t);
  }
  if (docWriteOffenders.length > 0) {
    pushFinding(out, {
      id: fid(`perf-docwrite:${docWriteOffenders.length}`),
      category: "performance",
      severity: "high",
      finding: `${docWriteOffenders.length} Custom HTML tag(s) use document.write`,
      affected: docWriteOffenders.map((t) => t.name ?? "Unnamed"),
      whyItMatters:
        "document.write breaks the document after page load, can blank pages, and is blocked by modern browsers when called from third-party scripts.",
      suggestedFix:
        "Replace document.write with createElement / appendChild or migrate to a tag template.",
      sources: ["CONFIG"],
      parameter: "html",
      businessImpact: "User-visible page breakage and worse performance metrics.",
      effort: "M",
    });
  }
  if (ctx.tags.length >= 100) {
    pushFinding(out, {
      id: fid(`perf-total-tags:${ctx.tags.length}`),
      category: "performance",
      severity: "low",
      finding: `Container has ${ctx.tags.length} tags`,
      whyItMatters:
        "Large containers are slower to load and harder to audit. The risk depends on how many fire on All Pages, which is a runtime question.",
      suggestedFix:
        "Review for retired tags, paused tags awaiting deletion, and consolidate where possible.",
      needsManualReview: true,
      sources: ["CONFIG"],
      businessImpact: "Slower page loads and worse Core Web Vitals.",
      effort: "L",
    });
  }
}

// J. Ads Conversion Linker — flag Ads conversion tags without a Conversion Linker in the container.
function ruleConversionLinker(ctx: Ctx, out: AuditFinding[]) {
  const hasAdsConversions = ctx.tags.some((t) => t.type === "awct");
  if (!hasAdsConversions) return;
  const hasLinker = ctx.tags.some((t) => t.type === "gclidw");
  if (!hasLinker) {
    pushFinding(out, {
      id: fid("ads-no-linker"),
      category: "pixels",
      severity: "high",
      finding: "Google Ads conversion tags found but no Conversion Linker tag",
      whyItMatters:
        "Conversion Linker is required to store first-party gclid cookies so conversions attribute correctly under modern browser ITP / cookie limits.",
      suggestedFix:
        "Add a Conversion Linker tag fired on All Pages so click identifiers persist before conversion tags fire.",
      sources: ["CONFIG"],
      businessImpact: "Without a Conversion Linker, Google Ads conversion attribution will degrade significantly.",
      effort: "S",
    });
  }
}

// ── K. Cross-source: GTM CONFIG ↔ GA4 Admin ──────────────────────────────
// These rules only run when a GA4 property was selected and at least one GA4
// Admin read succeeded. Every finding cites Source(s): CONFIG + GA4_ADMIN.
// No runtime claims are made — this reconciles configuration intent against
// the GA4 property's registered settings.

/** Collect distinct GA4 measurement IDs (G-/GT-) referenced in GTM config. */
function gtmGa4MeasurementIds(ctx: Ctx): Set<string> {
  const ids = new Set<string>();
  for (const tag of ctx.tags) {
    if (!isGA4Config(tag) && !isGA4Event(tag)) continue;
    const id =
      tagParam(tag, "tagId") ??
      tagParam(tag, "measurementId") ??
      tagParam(tag, "measurementIdOverride");
    if (!id) continue;
    if (/^G-/i.test(id) || /^GT-/i.test(id)) ids.add(id.toUpperCase());
  }
  return ids;
}

/** Collect event parameter keys configured on GA4 event tags in GTM. */
function gtmGa4EventParamKeys(ctx: Ctx): Set<string> {
  const keys = new Set<string>();
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    for (const p of tag.parameter ?? []) {
      // GA4 event tags carry their custom params under an "eventParameters"
      // list of {name, value} maps. Walk the structure and collect names.
      if (p.key === "eventParameters" || p.key === "userProperties") {
        for (const entry of p.list ?? []) {
          const nameParam = (entry.map ?? []).find((m) => m.key === "name");
          const name = (nameParam?.value ?? "").trim();
          if (name && !name.startsWith("{{")) keys.add(name.toLowerCase());
        }
      }
    }
  }
  return keys;
}

function ruleCrossMeasurementIds(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4 || ga4.dataStreams.length === 0) return;
  const streamIds = new Set<string>();
  for (const s of ga4.dataStreams) {
    const mid = s.webStreamData?.measurementId;
    if (mid) streamIds.add(mid.toUpperCase());
  }
  if (streamIds.size === 0) return; // app-only property; nothing to reconcile
  const gtmIds = gtmGa4MeasurementIds(ctx);
  if (gtmIds.size === 0) return;

  const orphanGtm = Array.from(gtmIds).filter((id) => !streamIds.has(id));
  if (orphanGtm.length > 0) {
    pushFinding(out, {
      id: fid(`x-mid-mismatch:${orphanGtm.sort().join(",")}`),
      category: "ga4",
      severity: "high",
      finding:
        "GTM references GA4 measurement ID(s) that do not match any data stream on the selected GA4 property",
      affected: orphanGtm,
      whyItMatters:
        "The Google tag / GA4 event tags in this container send to measurement IDs that are not present as web data streams on the GA4 property you selected. Either the wrong property was selected, or hits are flowing to a different property than expected.",
      suggestedFix:
        "Confirm the GTM measurement ID matches a web data stream on the intended GA4 property. If it should match, re-select the correct property; otherwise correct the measurement ID in GTM.",
      sources: ["CONFIG", "GA4_ADMIN"],
      parameter: "measurementId",
      businessImpact:
        "Data may be landing in the wrong GA4 property or being dropped — reporting and attribution break silently.",
      effort: "M",
    });
  }
}

function ruleCrossCustomDimensions(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4) return;
  // Only run when we successfully read custom dimensions/metrics. An empty list
  // after a successful read is meaningful (none registered); a failed read is
  // already surfaced as a tool failure, so skip in that case.
  const cdFailed = ga4.failures.some((f) => f.resource === "ga4_custom_dimensions");
  const cmFailed = ga4.failures.some((f) => f.resource === "ga4_custom_metrics");
  if (cdFailed && cmFailed) return;

  const registered = new Set<string>();
  for (const d of ga4.customDimensions) {
    if (d.parameterName) registered.add(d.parameterName.toLowerCase());
  }
  for (const m of ga4.customMetrics) {
    if (m.parameterName) registered.add(m.parameterName.toLowerCase());
  }
  const sent = gtmGa4EventParamKeys(ctx);
  if (sent.size === 0) return;

  // GA4 collects a set of automatically-handled params that never need
  // registration as custom dimensions. Don't flag those.
  const AUTO = new Set([
    "page_location",
    "page_title",
    "page_referrer",
    "language",
    "screen_resolution",
    "value",
    "currency",
    "transaction_id",
    "items",
    "coupon",
    "tax",
    "shipping",
  ]);

  const unregistered = Array.from(sent).filter(
    (k) => !registered.has(k) && !AUTO.has(k),
  );
  if (unregistered.length > 0) {
    pushFinding(out, {
      id: fid(`x-unreg-params:${unregistered.sort().join(",").slice(0, 80)}`),
      category: "ga4",
      severity: "medium",
      finding:
        "GTM sends event parameters that are not registered as GA4 custom dimensions/metrics",
      affected: unregistered.slice(0, 20),
      whyItMatters:
        "These parameters are configured on GA4 event tags in GTM but have no matching registered custom dimension or metric on the GA4 property. Unregistered event-scoped parameters are collected but are NOT available in standard reports or explorations beyond the realtime/DebugView window.",
      suggestedFix:
        "Register each business-relevant parameter as a GA4 custom dimension (event scope) or custom metric so it is reportable. Confirm naming matches exactly (case-sensitive in GA4).",
      needsManualReview: true,
      sources: ["CONFIG", "GA4_ADMIN"],
      parameter: "eventParameters",
      businessImpact:
        "Parameters that are sent but unregistered cannot be used in reports — the data is effectively invisible to analysts.",
      effort: "M",
    });
  }
}

function ruleCrossDataRetention(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4 || !ga4.dataRetention) return;
  const retention = ga4.dataRetention.eventDataRetention;
  if (!retention) return;
  // GA4 default is TWO_MONTHS; FOURTEEN_MONTHS (or longer on 360) is usually
  // wanted for year-over-year and longer lookback explorations.
  if (/two_months|2_months/i.test(retention)) {
    pushFinding(out, {
      id: fid("x-retention-2mo"),
      category: "data_quality",
      severity: "medium",
      finding: "GA4 event data retention is set to 2 months",
      affected: [`eventDataRetention=${retention}`],
      whyItMatters:
        "With 2-month retention, user-level and event-level data in explorations is dropped after ~60 days. Standard aggregated reports are unaffected, but any exploration, cohort, or custom-funnel analysis needing a longer lookback will be incomplete.",
      suggestedFix:
        "If the client needs explorations or year-over-year analysis, increase event data retention to 14 months (Admin → Data Settings → Data Retention). Confirm this is acceptable under the client's data-retention/privacy policy first.",
      needsManualReview: true,
      sources: ["GA4_ADMIN"],
      parameter: "dataRetentionSettings.eventDataRetention",
      businessImpact:
        "Limited retention silently caps the depth of behavioural analysis available to the client.",
      effort: "S",
    });
  }
}

function ruleCrossGoogleAdsLinks(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4) return;
  const adsFailed = ga4.failures.some((f) => f.resource === "ga4_google_ads_links");
  if (adsFailed) return;
  const hasAdsTagsInGtm = ctx.tags.some(
    (t) => t.type === "awct" || t.type === "sp" || t.type === "gclidw",
  );
  if (!hasAdsTagsInGtm) return;
  if (ga4.googleAdsLinks.length === 0) {
    pushFinding(out, {
      id: fid("x-ads-link-missing"),
      category: "pixels",
      severity: "medium",
      finding:
        "GTM has Google Ads tags but the GA4 property has no Google Ads link",
      whyItMatters:
        "Google Ads conversion/remarketing tags are configured in GTM, but the selected GA4 property has no linked Google Ads account. Without a GA4 ↔ Ads link you lose GA4-based audiences, imported conversions, and cross-tool reporting.",
      suggestedFix:
        "Link the Google Ads account in GA4 (Admin → Product Links → Google Ads) so audiences and conversions can flow between GA4 and Ads. Confirm the correct Ads customer ID.",
      needsManualReview: true,
      sources: ["CONFIG", "GA4_ADMIN"],
      parameter: "googleAdsLinks",
      businessImpact:
        "Missing the GA4 ↔ Ads link blocks GA4 audience activation and conversion import, weakening campaign optimisation.",
      effort: "S",
    });
  }
}

function ruleCrossEnhancedMeasurement(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4) return;
  // Detect manual page_view configuration in GTM: a Google tag with
  // send_page_view=false, or GA4 event tags sending event_name=page_view.
  let manualPageView = false;
  for (const tag of ctx.tags) {
    if (isGA4Config(tag)) {
      const sendPv = tagParam(tag, "sendPageView") ?? tagParam(tag, "send_page_view");
      if (sendPv && /false/i.test(sendPv)) manualPageView = true;
    }
    if (isGA4Event(tag)) {
      const ev = (tagParam(tag, "eventName") ?? "").trim().toLowerCase();
      if (ev === "page_view") manualPageView = true;
    }
  }
  // Find any web stream with enhanced measurement that has streamEnabled.
  const emValues = Object.values(ga4.enhancedMeasurement);
  if (emValues.length === 0) return;
  const anyEnhancedOn = emValues.some((e) => e.streamEnabled);
  if (manualPageView && anyEnhancedOn) {
    pushFinding(out, {
      id: fid("x-enhanced-vs-manual-pv"),
      category: "ga4",
      severity: "low",
      finding:
        "GA4 enhanced measurement is enabled while GTM appears to send page_view manually",
      whyItMatters:
        "Enhanced measurement (which includes its own page-view handling) is enabled on a GA4 web stream, while GTM config suggests page_view is also being managed manually (send_page_view=false or a manual page_view event). Whether this double-counts depends on runtime behaviour, which CONFIG + GA4_ADMIN alone cannot confirm.",
      suggestedFix:
        "Manually review page_view handling: decide whether enhanced measurement or the GTM tag owns page_view, and disable the other to avoid duplicate page_view hits.",
      needsManualReview: true,
      sources: ["CONFIG", "GA4_ADMIN"],
      parameter: "enhancedMeasurement / send_page_view",
      businessImpact:
        "If both paths fire, page_view is double-counted, inflating sessions and engagement metrics.",
      effort: "M",
    });
  }
}

// Surface GA4 Admin read failures as findings so coverage gaps are not silent.
function ruleGa4ToolFailures(ctx: Ctx, out: AuditFinding[]) {
  const ga4 = ctx.ga4;
  if (!ga4) return;
  for (const tf of ga4.failures) {
    pushFinding(out, {
      id: fid(`ga4-tool-fail:${tf.resource}`),
      category: "tool_failure",
      severity: "low",
      finding: `Could not read ${tf.resource} from the GA4 Admin API`,
      whyItMatters: tf.message,
      suggestedFix:
        "Re-run the audit. If it persists, confirm the account has GA4 access to this property and that the analytics.readonly scope was granted (reconnect Google if needed).",
      needsManualReview: true,
      sources: ["GA4_ADMIN"],
      businessImpact:
        "GA4_ADMIN coverage is incomplete for this area; do not assume it is clean.",
      effort: "S",
    });
  }
}

// ── L. Cross-source: GTM CONFIG ↔ RUNTIME capture ────────────────────────
// Every rule below requires a parsed runtime capture (ctx.runtime?.ok). They
// only assert what was OBSERVED in the capture — never a site-wide claim, and
// never an inference when no capture is present.

/** GA4 event names configured on GTM GA4 Event tags (lower-cased, distinct). */
function configuredGa4EventNames(ctx: Ctx): Set<string> {
  const names = new Set<string>();
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    const ev = (tagParam(tag, "eventName") ?? "").trim().toLowerCase();
    // Skip dynamic event names ({{...}}) — they cannot be matched by literal.
    if (ev && !ev.includes("{{")) names.add(ev);
  }
  return names;
}

/** Custom-event trigger event names configured in the container (lower-cased). */
function configuredCustomEventNames(ctx: Ctx): Set<string> {
  const names = new Set<string>();
  type Filter = { parameter?: GtmParameter[] };
  for (const t of ctx.triggers) {
    if ((t.type ?? "").toLowerCase() !== "customevent") continue;
    // The event name lives in a filter comparing {{_event}} against a literal.
    const filters = (t.customEventFilter ?? t.filter ?? []) as Filter[];
    for (const f of filters) {
      for (const p of f.parameter ?? []) {
        // GTM stores the matched value in the "arg1" parameter of the filter;
        // "arg0" is the {{_event}} reference.
        if (
          p.key === "arg1" &&
          typeof p.value === "string" &&
          p.value &&
          !p.value.includes("{{")
        ) {
          names.add(p.value.trim().toLowerCase());
        }
      }
    }
  }
  return names;
}

/** Aggregate all observed dataLayer event names across captured pages. */
function observedDataLayerEvents(runtime: RuntimeState): Set<string> {
  const out = new Set<string>();
  for (const page of runtime.pages) {
    for (const ev of page.dataLayerEvents ?? []) {
      if (typeof ev === "string" && ev) out.add(ev.trim().toLowerCase());
    }
  }
  return out;
}

function ruleRuntimeGa4PageViews(ctx: Ctx, out: AuditFinding[]) {
  const rt = ctx.runtime;
  if (!rt?.ok) return;
  for (const page of rt.pages) {
    const ga4Hits = (page.trackerHits ?? []).filter((h) =>
      (h.groups ?? []).includes("ga4"),
    ).length;
    const where = page.finalUrl || page.requestedUrl || "(page)";
    if (ga4Hits === 0) {
      pushFinding(out, {
        id: fid(`rt-ga4-zero:${where}`),
        category: "ga4",
        severity: "high",
        finding: "No GA4 collect hit observed on a captured page",
        affected: [where],
        whyItMatters:
          "The runtime capture recorded zero GA4 /g/collect requests for this page load. If GA4 is expected here, page_view is not being sent.",
        suggestedFix:
          "Confirm the GA4 configuration tag fires on this page and that consent / network conditions allow the hit.",
        sources: ["RUNTIME"],
        confidence: "high",
        entity: { path: where },
        businessImpact:
          "Missing page_view hits mean lost traffic data and broken downstream reporting/attribution for this page.",
        effort: "M",
      });
    } else if (ga4Hits > 1) {
      pushFinding(out, {
        id: fid(`rt-ga4-multi:${where}:${ga4Hits}`),
        category: "duplication",
        severity: "medium",
        finding: `${ga4Hits} GA4 collect hits observed on a single page load`,
        affected: [where],
        whyItMatters:
          "Multiple GA4 collect requests on one load can indicate duplicate configuration tags or double page_view firing.",
        suggestedFix:
          "Review whether more than one GA4 configuration/page_view path is firing; consolidate to a single source of page_view.",
        sources: ["RUNTIME"],
        confidence: "medium",
        entity: { path: where },
        businessImpact:
          "Duplicate hits inflate sessions/users and distort engagement metrics.",
        effort: "M",
      });
    }
  }
}

function ruleRuntimeConsoleErrors(ctx: Ctx, out: AuditFinding[]) {
  const rt = ctx.runtime;
  if (!rt?.ok) return;
  for (const page of rt.pages) {
    const errs = page.pageErrors ?? [];
    const consoleErrs = page.consoleErrors ?? [];
    const where = page.finalUrl || page.requestedUrl || "(page)";
    const total = errs.length + consoleErrs.length;
    if (total === 0) continue;
    const sample = [...errs, ...consoleErrs].slice(0, 5);
    pushFinding(out, {
      id: fid(`rt-console:${where}:${total}`),
      category: "data_quality",
      severity: errs.length > 0 ? "medium" : "low",
      finding: `${total} JavaScript error${total === 1 ? "" : "s"} observed during page load`,
      affected: [where],
      whyItMatters:
        "Uncaught page errors and console errors observed at runtime can interrupt tag execution and dataLayer pushes.",
      suggestedFix:
        "Investigate the errors below; ensure analytics scripts are not throwing before tags fire. Sample: " +
        sample.map((s) => s.slice(0, 160)).join(" | "),
      sources: ["RUNTIME"],
      confidence: "high",
      entity: { path: where },
      businessImpact:
        "Script errors can silently drop analytics/marketing events on affected pages.",
      effort: "M",
    });
  }
}

function ruleRuntimeConfiguredEventsNotObserved(ctx: Ctx, out: AuditFinding[]) {
  const rt = ctx.runtime;
  if (!rt?.ok) return;
  const observed = observedDataLayerEvents(rt);
  // Only meaningful if we actually observed SOME dataLayer events; otherwise
  // GTM may use a custom dataLayer name and absence proves nothing.
  if (observed.size === 0) return;
  const configured = configuredCustomEventNames(ctx);
  const missing = Array.from(configured).filter((name) => !observed.has(name));
  if (missing.length === 0) return;
  pushFinding(out, {
    id: fid(`rt-cfg-events-missing:${missing.sort().join(",")}`),
    category: "data_layer",
    severity: "medium",
    finding: `${missing.length} configured custom-event trigger name${missing.length === 1 ? "" : "s"} not observed in captured dataLayer`,
    affected: missing,
    whyItMatters:
      "These custom-event names drive GTM triggers but were not seen in the dataLayer on the captured page(s). They may simply not fire on these specific pages — this is not a site-wide claim.",
    suggestedFix:
      "Capture the page(s)/flows where these events are expected to fire and re-check, or confirm the dataLayer push exists.",
    needsManualReview: true,
    sources: ["CONFIG", "RUNTIME"],
    confidence: "medium",
    businessImpact:
      "Triggers that never receive their event do nothing; dependent tags stay dormant on these pages.",
    effort: "M",
  });
}

// (Runtime Consent Mode signal checks moved to shared/consent-audit.ts and are
// invoked via runConsentAudit() in runAudit.)

// ── M. Cross-source: GTM CONFIG ↔ sGTM server container ───────────────────
// Requires a selected server container (ctx.sgtm?.ok). Reconciles the web
// container's GA4 transport target against the chosen server endpoint and
// surfaces server clients/transformations for manual review.

function tagTransportUrl(tag: GtmTag): string | undefined {
  return (
    tagParam(tag, "serverContainerUrl") ??
    tagParam(tag, "server_container_url") ??
    tagParam(tag, "transportUrl") ??
    tagParam(tag, "transport_url")
  );
}

function ruleSgtmTransportMatch(ctx: Ctx, out: AuditFinding[]) {
  const sg = ctx.sgtm;
  if (!sg?.ok) return;
  const serverHosts = sg.domainNames
    .map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  for (const tag of ctx.tags) {
    if (!isGA4Config(tag) && !isGA4Event(tag)) continue;
    const transport = tagTransportUrl(tag);
    if (!transport || transport.includes("{{")) continue;
    let host = "";
    try {
      host = new URL(transport).hostname.toLowerCase();
    } catch {
      continue;
    }
    const matches =
      serverHosts.length === 0 ||
      serverHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!matches) {
      pushFinding(out, {
        id: fid(`sgtm-transport-mismatch:${tag.tagId}:${host}`),
        category: "server_side",
        severity: "medium",
        finding:
          "GA4 tag transport_url does not match the selected server container domain",
        affected: [tag.name ?? "Unnamed GA4 tag"],
        whyItMatters:
          `This tag sends to "${host}", which is not among the selected server container's domain(s) (${serverHosts.join(", ") || "none configured"}). The web and server containers may be misaligned.`,
        suggestedFix:
          "Confirm the transport_url points at the intended sGTM endpoint, or select the correct server container for this audit.",
        sources: ["CONFIG", "SGTM"],
        confidence: "medium",
        entity: { name: tag.name, id: tag.tagId },
        parameter: "transport_url",
        businessImpact:
          "Misrouted server-side transport can silently drop server events or split data across endpoints.",
        effort: "M",
      });
    }
  }
}

function ruleSgtmGa4ClientPresence(ctx: Ctx, out: AuditFinding[]) {
  const sg = ctx.sgtm;
  if (!sg?.ok) return;
  const hasGa4Client = sg.clientTypes.some((t) =>
    /gaaw|ga4|google/i.test(t),
  );
  // Does the web container route GA4 to a server? (any transport_url present)
  const webRoutesToServer = ctx.tags.some(
    (t) => (isGA4Config(t) || isGA4Event(t)) && Boolean(tagTransportUrl(t)),
  );
  if (webRoutesToServer && !hasGa4Client) {
    pushFinding(out, {
      id: fid("sgtm-no-ga4-client"),
      category: "server_side",
      severity: "high",
      finding:
        "Web GA4 tags route to a server container, but no GA4 client was found there",
      whyItMatters:
        "The web container sets a server transport_url, yet the selected server container has no GA4/GAAW client to receive those requests.",
      suggestedFix:
        "Add a GA4 client to the server container, or confirm the correct server container is selected.",
      sources: ["CONFIG", "SGTM"],
      confidence: "medium",
      businessImpact:
        "Server-bound GA4 hits with no matching client are dropped — total data loss for server-side GA4.",
      effort: "M",
    });
  }
}

function ruleSgtmTransformations(ctx: Ctx, out: AuditFinding[]) {
  const sg = ctx.sgtm;
  if (!sg?.ok) return;
  if (sg.transformationNames.length === 0) return;
  pushFinding(out, {
    id: fid(`sgtm-transforms:${sg.transformationNames.length}`),
    category: "server_side",
    severity: "low",
    finding: `${sg.transformationNames.length} server-side transformation${sg.transformationNames.length === 1 ? "" : "s"} present`,
    affected: sg.transformationNames.slice(0, 20),
    whyItMatters:
      "Transformations rewrite event data server-side before it reaches destinations. They can affect PII, ecommerce, and GA4 parameters in ways CONFIG alone cannot verify.",
    suggestedFix:
      "Manually review each transformation to confirm it does not strip required parameters or leak PII.",
    needsManualReview: true,
    sources: ["CONFIG", "SGTM"],
    confidence: "medium",
    businessImpact:
      "An over-broad transformation can silently drop ecommerce fields or alter attribution.",
    effort: "M",
  });
}

function ruleSgtmFailures(ctx: Ctx, out: AuditFinding[]) {
  const sg = ctx.sgtm;
  if (!sg) return;
  for (const tf of sg.failures) {
    pushFinding(out, {
      id: fid(`sgtm-fail:${tf.resource}`),
      category: "tool_failure",
      severity: "low",
      finding: `Could not read ${tf.resource} from the server container`,
      whyItMatters: tf.message,
      suggestedFix:
        "Confirm the selected account/container/workspace is correct and that your Google account has access.",
      needsManualReview: true,
      sources: ["SGTM"],
      businessImpact:
        "SGTM coverage is incomplete for this area; do not assume it is clean.",
      effort: "S",
    });
  }
}

// ── N. Cross-source: GTM CONFIG ↔ GA4 Data API ───────────────────────────
// Requires ctx.dataApi?.ok. Flags GTM-configured GA4 event names that report
// zero events over the window. Source is DATA_API (reported counts), never
// RUNTIME.

function ruleDataApiZeroEvents(ctx: Ctx, out: AuditFinding[]) {
  const da = ctx.dataApi;
  if (!da?.ok) return;
  const configured = configuredGa4EventNames(ctx);
  if (configured.size === 0) return;
  const reported = new Set(
    Object.keys(da.eventCounts).map((n) => n.trim().toLowerCase()),
  );
  const zero = Array.from(configured).filter((name) => !reported.has(name));
  if (zero.length === 0) return;
  pushFinding(out, {
    id: fid(`da-zero-events:${zero.sort().join(",")}`),
    category: "ga4",
    severity: "medium",
    finding: `${zero.length} GTM-configured GA4 event${zero.length === 1 ? "" : "s"} reported zero events in the last ${da.windowDays} days`,
    affected: zero,
    whyItMatters:
      "These event names are configured on GTM GA4 Event tags but the GA4 Data API reports no occurrences in the recent window. They may be broken, mis-named, or simply rarely triggered.",
    suggestedFix:
      "Confirm whether these events should be firing. If they should, debug the trigger/tag; if retired, remove the tag.",
    needsManualReview: true,
    sources: ["CONFIG", "DATA_API"],
    confidence: "medium",
    businessImpact:
      "Configured-but-never-reported events indicate broken tracking or dead configuration.",
    effort: "M",
  });
}

function ruleDataApiFailures(ctx: Ctx, out: AuditFinding[]) {
  const da = ctx.dataApi;
  if (!da) return;
  for (const tf of da.failures) {
    pushFinding(out, {
      id: fid(`da-fail:${tf.resource}`),
      category: "tool_failure",
      severity: "low",
      finding: `Could not read ${tf.resource} from the GA4 Data API`,
      whyItMatters: tf.message,
      suggestedFix:
        "Confirm the property id is correct and that the analytics.readonly scope (which covers the Data API) was granted.",
      needsManualReview: true,
      sources: ["DATA_API"],
      businessImpact:
        "DATA_API coverage is incomplete; do not assume reported-event checks ran.",
      effort: "S",
    });
  }
}

function severityForResource(resource: string): AuditSeverity {
  // Workspace contents being unreadable is the only fatal case (we already
  // throw before audit runs). Container/version metadata are nice-to-have.
  if (resource === "publishedVersion" || resource === "workspaces") return "low";
  if (resource === "container" || resource === "clients") return "medium";
  return "low";
}

// ── Findings helpers ─────────────────────────────────────────────────────

function pushFinding(
  out: AuditFinding[],
  f: {
    id: string;
    category: AuditCategory;
    severity: AuditSeverity;
    finding: string;
    affected?: string[];
    whyItMatters: string;
    suggestedFix: string;
    needsManualReview?: boolean;
    sources?: AuditSourceFlag[];
    confidence?: AuditConfidence;
    entity?: { name?: string; id?: string; path?: string };
    parameter?: string;
    businessImpact?: string;
    effort?: AuditEffort;
  },
): void {
  // Populate legacy aliases so older clients keep rendering correctly.
  out.push({
    id: f.id,
    category: f.category,
    severity: f.severity,
    title: f.finding,
    description: f.whyItMatters,
    affects: f.affected,
    recommendation: f.suggestedFix,
    finding: f.finding,
    affected: f.affected,
    whyItMatters: f.whyItMatters,
    suggestedFix: f.suggestedFix,
    needsManualReview: f.needsManualReview ?? false,
    sources: f.sources ?? ["CONFIG"],
    confidence: f.confidence ?? defaultConfidence(f.sources, f.needsManualReview),
    entity: f.entity,
    parameter: f.parameter,
    businessImpact: f.businessImpact,
    effort: f.effort,
  });
}

function defaultConfidence(
  sources: AuditSourceFlag[] | undefined,
  needsManualReview: boolean | undefined,
): AuditConfidence {
  if (needsManualReview) return "low";
  const s = sources ?? ["CONFIG"];
  // CONFIG-only findings are at most "medium" confidence — configuration
  // intent is not observed runtime behaviour.
  if (s.length === 1 && s[0] === "CONFIG") return "medium";
  if (s.includes("RUNTIME") || s.includes("SGTM") || s.includes("GA4_ADMIN")) return "high";
  return "medium";
}

function tagEntity(tag: GtmTag): { name?: string; id?: string; path?: string } {
  return {
    name: tag.name,
    id: tag.tagId,
    path: tag.tagId ? `tags/${tag.tagId}` : undefined,
  };
}

function variableEntity(v: GtmVariable): { name?: string; id?: string; path?: string } {
  return {
    name: v.name,
    id: v.variableId,
    path: v.variableId ? `variables/${v.variableId}` : undefined,
  };
}

function triggerEntity(t: GtmTrigger): { name?: string; id?: string; path?: string } {
  return {
    name: t.name,
    id: t.triggerId,
    path: t.triggerId ? `triggers/${t.triggerId}` : undefined,
  };
}

const SEVERITY_WEIGHT: Record<AuditSeverity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0,
};

function computeHealthScore(findings: AuditFinding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.needsManualReview) {
      // Manual-review items count for half — they are not confirmed defects.
      score -= Math.max(1, Math.floor(SEVERITY_WEIGHT[f.severity] / 2));
    } else {
      score -= SEVERITY_WEIGHT[f.severity];
    }
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ── Consent Mode v2 engine bridge ─────────────────────────────────────────
// The Consent Mode v2 + runtime proof logic lives in the pure, separately
// tested module shared/consent-audit.ts. Here we adapt the audit's Ctx/Runtime
// into that module's plain-data inputs, run it, and map its findings back into
// the route's AuditFinding shape. CONFIG-only consent rules from that engine
// REPLACE the older inline ruleConsentSettings/ruleConsentSignalsPresent so a
// container is never double-flagged.

function toConsentConfigInput(ctx: Ctx): ConsentConfigInput {
  return {
    tags: ctx.tags as unknown as ConsentConfigInput["tags"],
    triggers: ctx.triggers as unknown as ConsentConfigInput["triggers"],
    variables: ctx.variables as unknown as ConsentConfigInput["variables"],
    textBlob: ctx.textBlob,
    usageContexts: (ctx.container?.usageContext ?? []).map((u) => u.toLowerCase()),
  };
}

function toConsentRuntimeInput(rt: RuntimeState | null): ConsentRuntimeInput | null {
  if (!rt?.ok) return null;
  const pages: ConsentRuntimePage[] = rt.pages.map((p) => ({
    requestedUrl: p.requestedUrl,
    finalUrl: p.finalUrl,
    consentState: p.consentState,
    consoleErrors: p.consoleErrors,
    pageErrors: p.pageErrors,
    trackerHits: (p.trackerHits ?? []) as unknown as ConsentRuntimeHit[],
    dataLayerEvents: p.dataLayerEvents,
    dataLayerKeys: p.dataLayerKeys,
    consentEvents: p.consentEvents,
    cookies: p.cookies,
    firstMeasurementTMs: p.firstMeasurementTMs,
  }));
  return { capturedAt: rt.capturedAt, pages, states: rt.states, ok: true };
}

function consentFindingToAudit(f: ConsentFinding): AuditFinding {
  return {
    id: fid(`consent:${f.id}`),
    category: "consent",
    title: f.finding,
    description: f.whyItMatters,
    severity: f.severity,
    finding: f.finding,
    affected: f.affected,
    whyItMatters: f.whyItMatters,
    suggestedFix:
      f.evidence && f.evidence.length
        ? `${f.suggestedFix} Evidence: ${f.evidence.join(" | ")}`
        : f.suggestedFix,
    needsManualReview: f.needsManualReview,
    sources: f.sources,
    confidence: f.confidence,
    entity: f.entity,
    parameter: f.parameter,
    businessImpact: f.businessImpact,
    effort: f.effort,
  };
}

function buildSummary(findings: AuditFinding[], itemsChecked: number): string {
  const counts: Record<AuditSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const f of findings) counts[f.severity] += 1;
  const parts = [
    `Checked ${itemsChecked} item${itemsChecked === 1 ? "" : "s"}`,
    `${counts.critical} Critical`,
    `${counts.high} High`,
    `${counts.medium} Medium`,
    `${counts.low + counts.info} Low`,
  ];
  return `${parts[0]}: ${parts.slice(1).join(", ")}.`;
}

function runAudit(
  state: AuditState,
  opts: {
    containerPublicId: string;
    ga4: Ga4AdminState | null;
    runtime?: RuntimeState | null;
    sgtm?: SgtmContextState | null;
    dataApi?: DataApiState | null;
  },
): AuditSummary {
  const runtime = opts.runtime ?? null;
  const sgtm = opts.sgtm ?? null;
  const dataApi = opts.dataApi ?? null;
  const ctx = buildCtx(state, opts.ga4, runtime, sgtm, dataApi);
  const findings: AuditFinding[] = [];

  // A. Dead / orphaned config
  ruleTagsNoFiringTriggers(ctx, findings);
  ruleUnusedTriggers(ctx, findings);
  ruleUnusedVariables(ctx, findings);
  rulePausedTags(ctx, findings);
  ruleBrokenReferences(ctx, findings);
  // B. GA4 integrity
  ruleGA4ConfigCount(ctx, findings);
  ruleGA4MeasurementIdsConsistent(ctx, findings);
  ruleGA4EventCompleteness(ctx, findings);
  ruleGA4AllPages(ctx, findings);
  // C. Consent Mode v2 + runtime proof engine (pure module — see
  // shared/consent-audit.ts). Covers CONFIG-only checks, and (when a capture
  // was imported) RUNTIME-only and CONFIG+RUNTIME reconciliation checks.
  const consentResult: ConsentAuditResult = runConsentAudit(
    toConsentConfigInput(ctx),
    toConsentRuntimeInput(runtime),
  );
  for (const cf of consentResult.findings) findings.push(consentFindingToAudit(cf));
  // D. Data quality
  ruleHardcodedIds(ctx, findings);
  ruleDataLayerNoDefault(ctx, findings);
  rulePiiManualReview(ctx, findings);
  // E. Duplicates
  ruleDuplicateGA4Events(ctx, findings);
  ruleDuplicateTagNames(ctx, findings);
  ruleDuplicateConversionPages(ctx, findings);
  // F. Naming / structure
  ruleFolderConsistency(ctx, findings);
  // G. Server-side
  ruleServerSideClients(ctx, findings);
  // H. Publishing state
  rulePublishingState(ctx, findings);
  // I. Performance
  rulePerformance(ctx, findings);
  // J. Conversion Linker
  ruleConversionLinker(ctx, findings);
  // K. Cross-source: GTM CONFIG ↔ GA4 Admin (only when a property was read).
  ruleCrossMeasurementIds(ctx, findings);
  ruleCrossCustomDimensions(ctx, findings);
  ruleCrossDataRetention(ctx, findings);
  ruleCrossGoogleAdsLinks(ctx, findings);
  ruleCrossEnhancedMeasurement(ctx, findings);
  ruleGa4ToolFailures(ctx, findings);
  // L. Cross-source: CONFIG ↔ RUNTIME (only when a capture was uploaded).
  ruleRuntimeGa4PageViews(ctx, findings);
  ruleRuntimeConsoleErrors(ctx, findings);
  ruleRuntimeConfiguredEventsNotObserved(ctx, findings);
  // (Consent Mode signal checks for runtime are handled by runConsentAudit above.)
  // M. Cross-source: CONFIG ↔ SGTM (only when a server container was selected).
  ruleSgtmTransportMatch(ctx, findings);
  ruleSgtmGa4ClientPresence(ctx, findings);
  ruleSgtmTransformations(ctx, findings);
  ruleSgtmFailures(ctx, findings);
  // N. Cross-source: CONFIG ↔ DATA_API (only when a Data API report was run).
  ruleDataApiZeroEvents(ctx, findings);
  ruleDataApiFailures(ctx, findings);
  // Tool failures — surface gaps.
  ruleToolFailures(state, findings);

  findings.sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );

  const itemsChecked =
    state.contents.tags.length +
    state.contents.triggers.length +
    state.contents.variables.length +
    state.contents.folders.length +
    state.contents.builtInVariables.length +
    state.clients.length;

  const containerType = (state.container?.usageContext ?? []).join(",") || undefined;

  // ── Capability detection ───────────────────────────────────────────────
  // CONFIG is always present (we read the GTM workspace). The other sources
  // are true ONLY when the caller supplied the matching input AND at least one
  // read/parse succeeded:
  //   RUNTIME   — an uploaded runtime capture parsed into >=1 page.
  //   SGTM      — a server container was selected and is server + readable.
  //   GA4_ADMIN — a GA4 property was selected and >=1 Admin read succeeded.
  //   DATA_API  — a GA4 property was selected, Data API opted in, report ok.
  // A source whose reads all fail stays false, so the audit never claims
  // coverage it could not deliver.
  const capabilityFlags: AuditCapabilityFlags = {
    CONFIG: true,
    RUNTIME: runtime?.ok ?? false,
    SGTM: sgtm?.ok ?? false,
    GA4_ADMIN: opts.ga4?.ok ?? false,
    DATA_API: dataApi?.ok ?? false,
  };

  const coverageMatrix = buildCoverageMatrix(capabilityFlags, ctx);
  const domainMaturity = buildDomainMaturity(findings, capabilityFlags);
  const heatMap = buildHeatMap(findings);
  const executiveSummary = buildExecutiveSummary(
    findings,
    domainMaturity,
    capabilityFlags,
    state,
  );
  const roadmap = buildRoadmap(findings);

  return {
    containerId: opts.containerPublicId,
    generatedAt: new Date().toISOString(),
    healthScore: computeHealthScore(findings),
    counts: {
      tags: state.contents.tags.length,
      triggers: state.contents.triggers.length,
      variables: state.contents.variables.length,
    },
    findings,
    containerType,
    workspaceCount: state.workspaces.length || undefined,
    publishedVersion: state.publishedVersion
      ? {
          versionId: state.publishedVersion.containerVersionId,
          name: state.publishedVersion.name,
          notes: state.publishedVersion.notes,
        }
      : null,
    toolFailures: state.toolFailures.length ? state.toolFailures : undefined,
    summary: buildSummary(findings, itemsChecked),
    gtmMeasurementIds: Array.from(gtmGa4MeasurementIds(ctx)),
    capabilityFlags,
    coverageMatrix,
    executiveSummary,
    domainMaturity,
    heatMap,
    roadmap,
    consentAudit: {
      coverage: consentResult.coverage,
      runtimeStates: consentResult.runtimeStates,
      stateCoverage: consentResult.stateCoverage,
      findingCount: consentResult.findings.length,
    },
  };
}

// ── Capability-aware output builders ─────────────────────────────────────

const DOMAINS: { key: string; label: string; categories: AuditCategory[] }[] = [
  { key: "ga4", label: "GA4 architecture", categories: ["ga4"] },
  { key: "consent", label: "Consent Mode v2", categories: ["consent"] },
  { key: "privacy", label: "Privacy & PII", categories: ["privacy"] },
  { key: "server_side", label: "Server-side", categories: ["server_side"] },
  { key: "pixels", label: "Vendor pixels", categories: ["pixels"] },
  { key: "ecommerce", label: "Ecommerce", categories: ["ecommerce"] },
  { key: "data_layer", label: "Data layer", categories: ["data_layer"] },
  { key: "data_quality", label: "Data quality", categories: ["data_quality"] },
  { key: "duplication", label: "Duplication", categories: ["duplication"] },
  { key: "performance", label: "Performance", categories: ["performance"] },
  { key: "governance", label: "Governance", categories: ["governance", "publishing", "naming"] },
  { key: "dead_config", label: "Dead config", categories: ["dead_config"] },
];

// Domain weights — heavier on safety/compliance/architecture domains.
const DOMAIN_WEIGHT: Record<string, number> = {
  ga4: 1.4,
  consent: 1.5,
  privacy: 1.4,
  server_side: 1.3,
  pixels: 1.1,
  ecommerce: 1.0,
  data_layer: 1.0,
  data_quality: 1.0,
  duplication: 1.0,
  performance: 0.9,
  governance: 0.7,
  dead_config: 0.6,
};

function buildCoverageMatrix(
  flags: AuditCapabilityFlags,
  ctx: Ctx,
): AuditCoverageItem[] {
  const isServer = (ctx.container?.usageContext ?? []).some(
    (u) => u.toLowerCase() === "server",
  );
  const row = (
    id: string,
    capability: string,
    requires: AuditSourceFlag[],
    toolNeeded?: string,
  ): AuditCoverageItem => {
    const hasAll = requires.every((r) => flags[r]);
    const hasSome = requires.some((r) => flags[r]);
    let status: AuditCoverage = "not_covered";
    if (hasAll) status = requires.length === 1 ? "covered" : "partial";
    else if (hasSome) status = "partial";
    return {
      id,
      capability,
      requires,
      status,
      toolNeeded: status === "covered" ? undefined : toolNeeded,
    };
  };
  return [
    row(
      "config-inventory",
      "GTM config inventory (tags, triggers, variables, built-ins, versions)",
      ["CONFIG"],
      "GTM API access (currently CONFIG-only)",
    ),
    row(
      "tag-firing-order",
      "Tag firing & order at runtime",
      ["RUNTIME"],
      "Runtime browser harness (e.g. Puppeteer/Playwright capture of dataLayer + network)",
    ),
    row(
      "datalayer-pushes",
      "Live dataLayer pushes & event sequence",
      ["RUNTIME"],
      "Runtime browser harness",
    ),
    row(
      "pixel-capi-dedup",
      "Meta Pixel ↔ CAPI deduplication (eventID)",
      ["RUNTIME", "SGTM"],
      "Runtime capture + sGTM logs + Meta Events Manager (final proof is manual)",
    ),
    row(
      "consent-runtime",
      "Consent state matrix at runtime (granted/denied paths)",
      ["RUNTIME"],
      "Runtime harness toggling consent states",
    ),
    row(
      "ecommerce-runtime",
      "Ecommerce events shape vs spec (purchase, items[], value)",
      ["RUNTIME"],
      "Runtime capture of purchase/view_item flows",
    ),
    row(
      "sgtm-clients",
      "sGTM clients, transformations, and routing",
      ["SGTM"],
      // When a server container is selected for the audit, its clients,
      // transformations and routing ARE folded in (SGTM flag true → covered).
      // Otherwise this stays Not Covered — open the Server-side panel or select
      // a server container in the audit to enable it.
      flags.SGTM
        ? undefined
        : isServer
          ? "Select this server container under 'Server-side reconciliation' in the audit to fold its clients/transformations in (or open the Server-side panel)"
          : "Select a server container under 'Server-side reconciliation', or open the Server-side panel; this web container is not a server container",
    ),
    row(
      isServer ? "sgtm-config-server-only" : "sgtm-server-config",
      "Server container CONFIG-visible checks",
      ["CONFIG"],
      isServer ? undefined : "This container is not a server container",
    ),
    row(
      "ga4-admin-dimensions",
      "GA4 custom dimensions & metrics",
      ["GA4_ADMIN"],
      "GA4 Admin API access",
    ),
    row(
      "ga4-admin-filters",
      "GA4 data filters, referral exclusions, retention, data streams",
      ["GA4_ADMIN"],
      "GA4 Admin API access",
    ),
    row(
      "ga4-data-api-events",
      "GA4 reported event volumes (configured events with zero activity)",
      ["DATA_API"],
      "Enable the GA4 Data API check (requires a selected GA4 property)",
    ),
    // Cross-source reconciliation. When GA4_ADMIN is connected we genuinely
    // reconcile GTM CONFIG against the GA4 property (measurement IDs, custom
    // dimensions, retention, Ads links, enhanced measurement) — so require
    // CONFIG + GA4_ADMIN, which yields "partial" coverage. RUNTIME is still
    // needed for the full intent-vs-reality picture, hence never "covered".
    crossSourceReconRow(flags),
  ];
}

// Cross-source reconciliation row. Requires every connected source so adding
// more sources tightens (never loosens) the requirement. With all four
// non-CONFIG sources connected this still yields "partial" (>1 require), which
// is honest: full intent-vs-reality proof for some checks (e.g. Pixel/CAPI
// dedup) remains manual.
function crossSourceReconRow(flags: AuditCapabilityFlags): AuditCoverageItem {
  const requires: AuditSourceFlag[] = ["CONFIG"];
  if (flags.RUNTIME) requires.push("RUNTIME");
  if (flags.SGTM) requires.push("SGTM");
  if (flags.GA4_ADMIN) requires.push("GA4_ADMIN");
  if (flags.DATA_API) requires.push("DATA_API");

  const connected = requires.filter((r) => r !== "CONFIG");
  const missing: string[] = [];
  if (!flags.RUNTIME) missing.push("RUNTIME (upload a runtime capture)");
  if (!flags.SGTM) missing.push("SGTM (select a server container)");
  if (!flags.GA4_ADMIN) missing.push("GA4_ADMIN (select a GA4 property)");
  if (!flags.DATA_API) missing.push("DATA_API (enable the GA4 Data API check)");

  // hasAll is always true here (we only push connected sources), so status is
  // "partial" whenever any non-CONFIG source is connected, else "not_covered".
  const status: AuditCoverage =
    connected.length === 0 ? "not_covered" : "partial";

  return {
    id: "cross-source-recon",
    capability:
      "Cross-source reconciliation (CONFIG ↔ RUNTIME ↔ SGTM ↔ GA4_ADMIN ↔ DATA_API)",
    requires,
    status,
    toolNeeded:
      missing.length > 0
        ? `Add ${missing.join(", ")} for fuller intent-vs-reality coverage`
        : undefined,
  };
}

function severityFor(f: AuditFinding): "critical" | "high" | "medium" | "low" {
  if (f.severity === "info") return "low";
  return f.severity;
}

function buildHeatMap(findings: AuditFinding[]): AuditHeatMapRow[] {
  const out: AuditHeatMapRow[] = [];
  for (const d of DOMAINS) {
    const cells: AuditHeatMapRow = {
      domain: d.label,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const f of findings) {
      if (!d.categories.includes(f.category)) continue;
      cells[severityFor(f)] += 1;
    }
    if (cells.critical + cells.high + cells.medium + cells.low > 0) {
      out.push(cells);
    }
  }
  return out;
}

function buildDomainMaturity(
  findings: AuditFinding[],
  flags: AuditCapabilityFlags,
): AuditDomainMaturity[] {
  // Maturity is 5 minus a weighted penalty per finding, clamped to [0, 5].
  // CONFIG-only audits cap maturity at 3 for runtime-sensitive domains.
  const out: AuditDomainMaturity[] = [];
  const SEV_PENALTY = { critical: 2.0, high: 1.0, medium: 0.5, low: 0.2 };
  const RUNTIME_SENSITIVE = new Set([
    "ga4",
    "consent",
    "pixels",
    "ecommerce",
    "server_side",
  ]);
  for (const d of DOMAINS) {
    let penalty = 0;
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings) {
      if (!d.categories.includes(f.category)) continue;
      const sev = severityFor(f);
      counts[sev] += 1;
      penalty += SEV_PENALTY[sev];
    }
    let score = Math.max(0, Math.min(5, 5 - penalty));
    const capConfidence =
      RUNTIME_SENSITIVE.has(d.key) && (!flags.RUNTIME || !flags.GA4_ADMIN);
    if (capConfidence) score = Math.min(score, 3);
    out.push({
      domain: d.label,
      score: Math.round(score * 10) / 10,
      counts,
      capConfidence,
    });
  }
  return out;
}

function buildExecutiveSummary(
  findings: AuditFinding[],
  domainMaturity: AuditDomainMaturity[],
  flags: AuditCapabilityFlags,
  state: AuditState,
): AuditExecutiveSummary {
  const weighted = domainMaturity.reduce(
    (acc, d) => {
      const key = DOMAINS.find((x) => x.label === d.domain)?.key ?? "";
      const w = DOMAIN_WEIGHT[key] ?? 1.0;
      acc.sum += d.score * w;
      acc.wsum += w;
      return acc;
    },
    { sum: 0, wsum: 0 },
  );
  const overallMaturity = weighted.wsum
    ? Math.round((weighted.sum / weighted.wsum) * 10) / 10
    : 0;

  const sortedBySev = [...findings]
    .filter((f) => !f.needsManualReview || f.severity === "critical" || f.severity === "high")
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);
  const topRisks = sortedBySev.slice(0, 3).map((f) => ({
    findingId: f.id,
    title: f.finding ?? f.title,
    severity: f.severity,
  }));

  const onlyConfig = flags.CONFIG && !flags.RUNTIME && !flags.SGTM && !flags.GA4_ADMIN;
  const hasCriticalOrHigh = findings.some(
    (f) => (f.severity === "critical" || f.severity === "high") && !f.needsManualReview,
  );
  let publishSafe: "yes" | "caution" | "no" = "yes";
  let publishSafeReason = "No high-severity configuration findings detected.";
  if (hasCriticalOrHigh) {
    publishSafe = "no";
    publishSafeReason =
      "High or critical-severity configuration findings exist. Resolve them before publishing.";
  } else if (onlyConfig) {
    publishSafe = "caution";
    publishSafeReason =
      "Config-only audit: runtime behaviour (tag firing, consent, ecommerce, Pixel/CAPI dedup) has not been verified. Validate in a runtime harness before publishing.";
  }
  if (state.toolFailures.length > 0 && publishSafe === "yes") {
    publishSafe = "caution";
    publishSafeReason =
      "Some GTM API reads failed; clean result on incomplete reads is not a clean audit.";
  }

  const singleSourceWarning = onlyConfig
    ? "Only CONFIG is connected. Cross-source reconciliation is Not Covered. A clean result from a single source is not a clean audit."
    : undefined;

  return {
    overallMaturity,
    topRisks,
    publishSafe,
    publishSafeReason,
    singleSourceWarning,
  };
}

function buildRoadmap(findings: AuditFinding[]): AuditRoadmapItem[] {
  const items: AuditRoadmapItem[] = [];
  // Quick wins: S-effort, high or medium severity.
  const quickWins = findings.filter(
    (f) =>
      (f.effort === "S" || !f.effort) &&
      (f.severity === "high" || f.severity === "medium") &&
      !f.needsManualReview,
  );
  if (quickWins.length > 0) {
    items.push({
      id: fid(`roadmap-quickwins:${quickWins.length}`),
      title: `Resolve ${quickWins.length} quick-win finding${quickWins.length === 1 ? "" : "s"}`,
      type: "quick_win",
      effort: "S",
      rationale:
        "Small, high-leverage fixes (config tweaks, attaching triggers, removing dead config) that can land in a single workspace cycle.",
      findingIds: quickWins.map((f) => f.id).slice(0, 20),
    });
  }
  // Structural: M/L effort or many findings in one domain.
  const structural = findings.filter(
    (f) => f.effort === "M" || f.effort === "L",
  );
  if (structural.length > 0) {
    items.push({
      id: fid(`roadmap-structural:${structural.length}`),
      title: `Plan ${structural.length} structural change${structural.length === 1 ? "" : "s"}`,
      type: "structural",
      effort: structural.some((f) => f.effort === "L") ? "L" : "M",
      rationale:
        "Larger changes (consent rollout, server-side migration, ID-management refactor, performance reduction) that need design and cross-team coordination.",
      findingIds: structural.map((f) => f.id).slice(0, 20),
    });
  }
  return items;
}

// ── HTTP/transport helpers ───────────────────────────────────────────────

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const maybeParsed = (req as IncomingMessage & { body?: unknown }).body;
  if (maybeParsed !== undefined && maybeParsed !== null) {
    if (typeof maybeParsed === "string") {
      try {
        return JSON.parse(maybeParsed) as T;
      } catch {
        return {} as T;
      }
    }
    return maybeParsed as T;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    return {} as T;
  }
}

async function pullAuditState(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<AuditState> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const containerBase = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}`;
  const toolFailures: AuditToolFailure[] = [];

  // Workspace contents are required. If they fail, throw — the audit is
  // meaningless without them.
  const [tagsRes, triggersRes, variablesRes, foldersRes, bivRes] =
    await Promise.all([
      gtmFetch<{ tag?: GtmTag[] }>(token, `${base}/tags`),
      gtmFetch<{ trigger?: GtmTrigger[] }>(token, `${base}/triggers`),
      gtmFetch<{ variable?: GtmVariable[] }>(token, `${base}/variables`),
      gtmFetch<{ folder?: GtmFolder[] }>(token, `${base}/folders`),
      gtmFetch<{ builtInVariable?: GtmBuiltInVariable[] }>(
        token,
        `${base}/built_in_variables`,
      ),
    ]);

  const contents: WorkspaceContents = {
    tags: tagsRes.tag ?? [],
    triggers: triggersRes.trigger ?? [],
    variables: variablesRes.variable ?? [],
    folders: foldersRes.folder ?? [],
    builtInVariables: bivRes.builtInVariable ?? [],
    templates: [],
  };

  // Best-effort: templates (not always present).
  try {
    const tplRes = await gtmFetch<{ template?: unknown[] }>(
      token,
      `${base}/templates`,
    );
    contents.templates = tplRes.template ?? [];
  } catch (e) {
    if (e instanceof GtmApiError && e.status !== 404) {
      toolFailures.push({
        resource: "templates",
        message: e.message,
        status: e.status,
      });
    }
  }

  // Container metadata (for type / usageContext).
  let container: GtmContainer | null = null;
  try {
    container = await gtmFetch<GtmContainer>(token, containerBase);
  } catch (e) {
    toolFailures.push({
      resource: "container",
      message:
        e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  }

  // Workspaces in this container.
  let workspaces: GtmWorkspace[] = [];
  try {
    const wsRes = await gtmFetch<{ workspace?: GtmWorkspace[] }>(
      token,
      `${containerBase}/workspaces`,
    );
    workspaces = wsRes.workspace ?? [];
  } catch (e) {
    toolFailures.push({
      resource: "workspaces",
      message: e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  }

  // Latest published version: version_headers?latest=true returns the
  // latest published version header.
  let publishedVersion: GtmVersion | null = null;
  try {
    const headerRes = await gtmFetch<GtmVersionHeader>(
      token,
      `${containerBase}/version_headers:latest`,
    );
    const versionId = headerRes.containerVersionId;
    if (versionId) {
      try {
        publishedVersion = await gtmFetch<GtmVersion>(
          token,
          `${containerBase}/versions/${encodeURIComponent(versionId)}`,
        );
      } catch (e) {
        toolFailures.push({
          resource: "publishedVersion",
          message: e instanceof GtmApiError ? e.message : safeErrorName(e),
          status: e instanceof GtmApiError ? e.status : undefined,
        });
      }
    }
  } catch (e) {
    // 404 just means nothing published — not a failure.
    if (e instanceof GtmApiError && e.status !== 404) {
      toolFailures.push({
        resource: "publishedVersion",
        message: e.message,
        status: e.status,
      });
    }
  }

  // Server-side clients (only meaningful for server containers).
  let clients: GtmClient[] = [];
  const isServer = (container?.usageContext ?? []).some(
    (u) => u.toLowerCase() === "server",
  );
  if (isServer) {
    try {
      const cRes = await gtmFetch<{ client?: GtmClient[] }>(
        token,
        `${base}/clients`,
      );
      clients = cRes.client ?? [];
    } catch (e) {
      if (e instanceof GtmApiError && e.status !== 404) {
        toolFailures.push({
          resource: "clients",
          message: e.message,
          status: e.status,
        });
      }
    }
  }

  return {
    contents,
    container,
    workspaces,
    publishedVersion,
    clients,
    toolFailures,
  };
}

// ── GA4 Admin cross-source read ──────────────────────────────────────────
// Read-only. Every individual read is wrapped so one failure cannot abort the
// audit; failures are recorded and surfaced as low-severity findings. `ok` is
// set when at least one read succeeds, which gates the GA4_ADMIN capability.

const GA4_ADMIN_V1BETA = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_ADMIN_V1ALPHA = "https://analyticsadmin.googleapis.com/v1alpha";

class Ga4AdminApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GA4 Admin API ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function ga4AdminFetch<T>(token: string, url: string): Promise<T> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Ga4AdminApiError(r.status, text);
  }
  return (await r.json()) as T;
}

/** Paginated list helper. Caps at 5 pages; GA4 admin collections are small. */
async function ga4AdminList<T>(
  token: string,
  baseUrl: string,
  field: string,
): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 5; i++) {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await ga4AdminFetch<Record<string, unknown>>(
      token,
      url.toString(),
    );
    const items = (data[field] as T[] | undefined) ?? [];
    out.push(...items);
    const next = data.nextPageToken;
    if (typeof next === "string" && next) pageToken = next;
    else break;
  }
  return out;
}

async function pullGa4AdminState(
  token: string,
  rawPropertyId: string,
): Promise<Ga4AdminState> {
  const propertyId = rawPropertyId.startsWith("properties/")
    ? rawPropertyId
    : `properties/${rawPropertyId}`;
  const failures: AuditToolFailure[] = [];
  let okCount = 0;

  const record = (resource: string, e: unknown) => {
    failures.push({
      resource,
      message: e instanceof Ga4AdminApiError ? e.message : safeErrorName(e),
      status: e instanceof Ga4AdminApiError ? e.status : undefined,
    });
  };

  let dataStreams: Ga4DataStream[] = [];
  try {
    dataStreams = await ga4AdminList<Ga4DataStream>(
      token,
      `${GA4_ADMIN_V1BETA}/${propertyId}/dataStreams`,
      "dataStreams",
    );
    okCount++;
  } catch (e) {
    record("ga4_data_streams", e);
  }

  let customDimensions: Ga4CustomDimension[] = [];
  try {
    customDimensions = await ga4AdminList<Ga4CustomDimension>(
      token,
      `${GA4_ADMIN_V1BETA}/${propertyId}/customDimensions`,
      "customDimensions",
    );
    okCount++;
  } catch (e) {
    record("ga4_custom_dimensions", e);
  }

  let customMetrics: Ga4CustomMetric[] = [];
  try {
    customMetrics = await ga4AdminList<Ga4CustomMetric>(
      token,
      `${GA4_ADMIN_V1BETA}/${propertyId}/customMetrics`,
      "customMetrics",
    );
    okCount++;
  } catch (e) {
    record("ga4_custom_metrics", e);
  }

  let dataRetention: Ga4DataRetention | null = null;
  try {
    dataRetention = await ga4AdminFetch<Ga4DataRetention>(
      token,
      `${GA4_ADMIN_V1BETA}/${propertyId}/dataRetentionSettings`,
    );
    okCount++;
  } catch (e) {
    record("ga4_data_retention", e);
  }

  let googleAdsLinks: Ga4GoogleAdsLink[] = [];
  try {
    googleAdsLinks = await ga4AdminList<Ga4GoogleAdsLink>(
      token,
      `${GA4_ADMIN_V1BETA}/${propertyId}/googleAdsLinks`,
      "googleAdsLinks",
    );
    okCount++;
  } catch (e) {
    record("ga4_google_ads_links", e);
  }

  // Enhanced measurement is per web data stream and lives on v1alpha. Only
  // probe web streams we actually found; cap the number of probes to stay
  // inside the serverless time budget.
  const enhancedMeasurement: Record<string, Ga4EnhancedMeasurement> = {};
  const webStreams = dataStreams
    .filter((s) => s.webStreamData?.measurementId)
    .slice(0, 10);
  for (const s of webStreams) {
    const streamName = s.name; // properties/123/dataStreams/456
    if (!streamName) continue;
    const streamId = streamName.split("/").pop() ?? streamName;
    try {
      const em = await ga4AdminFetch<Ga4EnhancedMeasurement>(
        token,
        `${GA4_ADMIN_V1ALPHA}/${streamName}/enhancedMeasurementSettings`,
      );
      enhancedMeasurement[streamId] = em;
      okCount++;
    } catch (e) {
      record(`ga4_enhanced_measurement:${streamId}`, e);
    }
  }

  return {
    propertyId,
    dataStreams,
    customDimensions,
    customMetrics,
    dataRetention,
    googleAdsLinks,
    enhancedMeasurement,
    failures,
    ok: okCount > 0,
  };
}

// ── Server-side GTM context read (SGTM source) ───────────────────────────
// Read-only reads of a selected SERVER container: metadata (to confirm it is a
// server container and learn its domain/public id) plus the workspace clients
// and transformations. Every read is wrapped so a single failure cannot abort
// the audit. `ok` requires the container to actually be a server container AND
// at least one read to have succeeded — otherwise SGTM stays Not Covered.
async function pullSgtmContext(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<SgtmContextState> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
  const containerBase = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}`;
  const failures: AuditToolFailure[] = [];
  let okCount = 0;

  const record = (resource: string, e: unknown) => {
    if (e instanceof GtmApiError && e.status === 404) return;
    failures.push({
      resource,
      message: e instanceof GtmApiError ? e.message : safeErrorName(e),
      status: e instanceof GtmApiError ? e.status : undefined,
    });
  };

  let container: GtmContainer | null = null;
  try {
    container = await gtmFetch<GtmContainer>(token, containerBase);
    okCount++;
  } catch (e) {
    record("server_container", e);
  }

  const usageContext = container?.usageContext ?? [];
  const isServer = usageContext.some((u) => u.toLowerCase() === "server");
  const domainNames = (container?.domainName ?? []).filter(Boolean);

  const clientTypes: string[] = [];
  const clientNames: string[] = [];
  const transformationNames: string[] = [];

  // Only read clients/transformations when the container is actually a server
  // container — these endpoints are meaningless (and 404) otherwise.
  if (isServer) {
    try {
      const cRes = await gtmFetch<{ client?: GtmClient[] }>(
        token,
        `${base}/clients`,
      );
      for (const c of cRes.client ?? []) {
        if (c.type) clientTypes.push(c.type);
        if (c.name) clientNames.push(c.name);
      }
      okCount++;
    } catch (e) {
      record("server_clients", e);
    }

    try {
      const tRes = await gtmFetch<{ transformation?: { name?: string }[] }>(
        token,
        `${base}/transformations`,
      );
      for (const t of tRes.transformation ?? []) {
        if (t.name) transformationNames.push(t.name);
      }
      okCount++;
    } catch (e) {
      record("server_transformations", e);
    }
  }

  return {
    accountId,
    containerId,
    isServer,
    domainNames,
    publicId: container?.publicId,
    clientTypes,
    clientNames,
    transformationNames,
    failures,
    ok: isServer && okCount > 0,
  };
}

// ── GA4 Data API report read (DATA_API source) ───────────────────────────
// Read-only runReport against the analyticsdata endpoint: event counts over
// the last 7 days keyed by eventName. Used only to flag GTM-configured GA4
// events that report zero activity. A failure records a tool failure and
// leaves DATA_API Not Covered — counts are never fabricated.
const GA4_DATA_V1BETA = "https://analyticsdata.googleapis.com/v1beta";
const DATA_API_WINDOW_DAYS = 7;

async function pullDataApiState(
  token: string,
  rawPropertyId: string,
): Promise<DataApiState> {
  const numericId = rawPropertyId.startsWith("properties/")
    ? rawPropertyId.slice("properties/".length)
    : rawPropertyId;
  const failures: AuditToolFailure[] = [];
  const eventCounts: Record<string, number> = {};
  let ok = false;

  try {
    const r = await fetch(
      `${GA4_DATA_V1BETA}/properties/${encodeURIComponent(numericId)}:runReport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          dimensions: [{ name: "eventName" }],
          metrics: [{ name: "eventCount" }],
          dateRanges: [
            { startDate: `${DATA_API_WINDOW_DAYS}daysAgo`, endDate: "today" },
          ],
          limit: 250,
        }),
      },
    );
    if (!r.ok) {
      const text = await r.text();
      failures.push({
        resource: "ga4_run_report",
        message: text.slice(0, 300) || `HTTP ${r.status}`,
        status: r.status,
      });
    } else {
      const json = (await r.json()) as {
        rows?: {
          dimensionValues?: { value?: string }[];
          metricValues?: { value?: string }[];
        }[];
      };
      for (const row of json.rows ?? []) {
        const name = row.dimensionValues?.[0]?.value;
        const count = Number(row.metricValues?.[0]?.value ?? "0");
        if (name) eventCounts[name] = Number.isFinite(count) ? count : 0;
      }
      ok = true;
    }
  } catch (e) {
    failures.push({
      resource: "ga4_run_report",
      message: safeErrorName(e),
    });
  }

  return {
    propertyId: numericId,
    eventCounts,
    windowDays: DATA_API_WINDOW_DAYS,
    failures,
    ok,
  };
}

// ── Runtime capture parsing (RUNTIME source) ─────────────────────────────
// Accepts the worker's v2 multi-page artifact and tolerates the legacy v1
// single-page harness shape. Returns null when nothing parseable was given —
// the audit then leaves RUNTIME Not Covered (never fabricated).
function parseRuntimeCapture(raw: unknown): RuntimeState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const normalizePage = (p: Record<string, unknown>): RuntimePageCapture => {
    const hits = Array.isArray(p.trackerHits)
      ? (p.trackerHits as Record<string, unknown>[]).map((h) => {
          const matched = Array.isArray(h.matched)
            ? (h.matched as unknown[]).filter(
                (m): m is string => typeof m === "string",
              )
            : [];
          // Legacy v1 had only `matched` ids; derive groups for GA4 so runtime
          // rules still work. Newer artifacts include explicit `groups`.
          const groups = Array.isArray(h.groups)
            ? (h.groups as unknown[]).filter(
                (g): g is string => typeof g === "string",
              )
            : matched
                .map((id) =>
                  id.includes("ga4") || id.includes("collect") || id === "ua_collect"
                    ? "ga4"
                    : id.includes("meta")
                      ? "meta"
                      : id,
                )
                .filter(Boolean);
          const query =
            h.query && typeof h.query === "object" && !Array.isArray(h.query)
              ? Object.fromEntries(
                  Object.entries(h.query as Record<string, unknown>)
                    .filter(([, v]) => typeof v === "string")
                    .map(([k, v]) => [k, v as string]),
                )
              : undefined;
          return {
            url: typeof h.url === "string" ? h.url : undefined,
            method: typeof h.method === "string" ? h.method : undefined,
            matched,
            groups,
            query,
            tMs: typeof h.tMs === "number" ? h.tMs : undefined,
          };
        })
      : [];
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const consentEvents: RuntimeConsentEvent[] = Array.isArray(p.consentEvents)
      ? (p.consentEvents as Record<string, unknown>[]).map((e) => {
          const fields =
            e.fields && typeof e.fields === "object" && !Array.isArray(e.fields)
              ? (Object.fromEntries(
                  Object.entries(e.fields as Record<string, unknown>).filter(
                    ([, v]) => v === "granted" || v === "denied",
                  ),
                ) as RuntimeConsentEvent["fields"])
              : undefined;
          return {
            kind: typeof e.kind === "string" ? e.kind : undefined,
            tMs: typeof e.tMs === "number" ? e.tMs : undefined,
            fields,
          };
        })
      : [];
    const cookies: RuntimeCookie[] = Array.isArray(p.cookies)
      ? (p.cookies as unknown[]).map((c) => {
          if (typeof c === "string") return { name: c };
          const obj = (c ?? {}) as Record<string, unknown>;
          return {
            name: typeof obj.name === "string" ? obj.name : undefined,
            tMs: typeof obj.tMs === "number" ? obj.tMs : undefined,
          };
        })
      : [];
    return {
      requestedUrl:
        typeof p.requestedUrl === "string" ? p.requestedUrl : undefined,
      finalUrl: typeof p.finalUrl === "string" ? p.finalUrl : null,
      consentState:
        typeof p.consentState === "string" ? p.consentState : undefined,
      consoleErrors: strArr(p.consoleErrors),
      pageErrors: strArr(p.pageErrors),
      trackerHits: hits,
      sgtmCandidates: Array.isArray(p.sgtmCandidates)
        ? (p.sgtmCandidates as { url?: string }[])
        : [],
      dataLayerEvents: strArr(p.dataLayerEvents),
      dataLayerKeys: strArr(p.dataLayerKeys),
      consentEvents,
      cookies,
      firstMeasurementTMs:
        typeof p.firstMeasurementTMs === "number"
          ? p.firstMeasurementTMs
          : undefined,
    };
  };

  let pages: RuntimePageCapture[] = [];
  if (Array.isArray(obj.states)) {
    // v3 grouped-by-state artifact: states: [{ state, pages: [...] }, ...].
    for (const block of obj.states as Record<string, unknown>[]) {
      const stateLabel =
        typeof block.state === "string" ? block.state : undefined;
      const blockPages = Array.isArray(block.pages)
        ? (block.pages as Record<string, unknown>[])
        : [];
      for (const p of blockPages) {
        const np = normalizePage(p);
        // Block-level state is the default; a page may override it.
        if (!np.consentState && stateLabel) np.consentState = stateLabel;
        pages.push(np);
      }
    }
  } else if (Array.isArray(obj.pages)) {
    pages = (obj.pages as Record<string, unknown>[]).map(normalizePage);
    // A top-level consentState/declaredConsentState applies to all pages that
    // do not declare their own (v2 single-state captures).
    const topState =
      typeof obj.declaredConsentState === "string"
        ? (obj.declaredConsentState as string)
        : typeof obj.consentStateLabel === "string"
          ? (obj.consentStateLabel as string)
          : undefined;
    if (topState) {
      for (const p of pages) if (!p.consentState) p.consentState = topState;
    }
  } else if (typeof obj.requestedUrl === "string" || obj.trackerHits) {
    // Legacy v1 single-page artifact — wrap it. Derive dataLayer events from
    // dataLayerAfter if event names were not pre-extracted.
    const single = normalizePage(obj);
    if ((single.dataLayerEvents ?? []).length === 0 && Array.isArray(obj.dataLayerAfter)) {
      const evs: string[] = [];
      for (const entry of obj.dataLayerAfter as unknown[]) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const ev = (entry as Record<string, unknown>).event;
          if (typeof ev === "string") evs.push(ev);
        }
      }
      single.dataLayerEvents = evs;
    }
    pages = [single];
  }

  if (pages.length === 0) return null;
  const states = Array.from(
    new Set(
      pages
        .map((p) => p.consentState)
        .filter((s): s is ConsentStateLabel => typeof s === "string" && s.length > 0),
    ),
  );
  return {
    capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : undefined,
    pages,
    states,
    ok: true,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  } catch {
    try {
      res.statusCode = 500;
      res.end(`{"error":"internal_error","message":"serialize_failed"}`);
    } catch {
      /* nothing else to do */
    }
  }
}

function safeErrorName(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : "unknown_error";
}

class GtmApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`GTM API ${status}: ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

function sendGtmError(
  res: ServerResponse,
  err: unknown,
  fallback: string,
): void {
  if (err instanceof GtmApiError) {
    const status = err.status === 401 || err.status === 403 ? err.status : 502;
    return sendJson(res, status, {
      error:
        status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : "gtm_api_error",
      message: err.message,
    });
  }
  console.error("[portal] GTM error:", safeErrorName(err));
  return sendJson(res, 500, { error: "internal_error", message: fallback });
}

function resolveOAuthClient(): OAuthClientShape | null {
  const clientId =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_OAUTH_CLIENT_ID ??
    process.env.GOOGLE_CLIENT_ID;
  const clientSecret =
    process.env.PORTAL_GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET;
  const explicit =
    process.env.PORTAL_GOOGLE_OAUTH_REDIRECT_URI ??
    process.env.GOOGLE_OAUTH_REDIRECT_URI;
  const publicUrl = process.env.PORTAL_PUBLIC_URL;
  const redirectUri = explicit
    ? explicit
    : publicUrl
      ? `${publicUrl.replace(/\/$/, "")}/api/oauth/callback`
      : undefined;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const rawV = part.slice(idx + 1).trim();
    let v = rawV;
    try {
      v = decodeURIComponent(rawV);
    } catch {
      v = rawV;
    }
    if (k) out[k] = v;
  }
  return out;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4;
  const padded = pad ? input + "=".repeat(4 - pad) : input;
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signPayload(payload: string, secret: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", secret).update(payload).digest(),
  );
}

function safeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function decodeSessionCookie(
  value: string | undefined,
  secret: string,
): SessionTokensShape | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, body, sig] = parts;
  if (version !== COOKIE_VERSION) return null;
  let expected: string;
  try {
    expected = signPayload(`${version}.${body}`, secret);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = base64UrlDecode(body).toString("utf8");
    const parsed = JSON.parse(json) as Partial<SessionTokensShape> | null;
    if (!parsed || typeof parsed.accessToken !== "string") return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken:
        typeof parsed.refreshToken === "string"
          ? parsed.refreshToken
          : undefined,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
    };
  } catch {
    return null;
  }
}

function encodeSessionCookie(
  tokens: SessionTokensShape,
  secret: string,
): string {
  const payload = `${COOKIE_VERSION}.${base64UrlEncode(JSON.stringify(tokens))}`;
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

function setSessionCookie(res: ServerResponse, value: string): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
  ];
  if (process.env.NODE_ENV === "production" || process.env.VERCEL) {
    parts.push("Secure");
  }
  const existing = res.getHeader("Set-Cookie");
  const next = parts.join("; ");
  if (!existing) res.setHeader("Set-Cookie", next);
  else if (Array.isArray(existing))
    res.setHeader("Set-Cookie", [...existing, next]);
  else res.setHeader("Set-Cookie", [String(existing), next]);
}

async function refreshAccessToken(
  client: OAuthClientShape,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Token refresh failed (${r.status}): ${text}`);
  }
  const data = (await r.json()) as { access_token: string; expires_in: number };
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

async function getValidAccessToken(
  req: IncomingMessage,
  res: ServerResponse,
  client: OAuthClientShape,
  secret: string,
): Promise<string | null> {
  const cookies = parseCookies(req.headers?.cookie);
  const tokens = decodeSessionCookie(cookies[SESSION_COOKIE], secret);
  if (!tokens) return null;
  if (tokens.accessToken && Date.now() < tokens.expiresAt) {
    return tokens.accessToken;
  }
  if (!tokens.refreshToken) return null;
  try {
    const { accessToken, expiresAt } = await refreshAccessToken(
      client,
      tokens.refreshToken,
    );
    const updated: SessionTokensShape = { ...tokens, accessToken, expiresAt };
    setSessionCookie(res, encodeSessionCookie(updated, secret));
    return accessToken;
  } catch {
    return null;
  }
}

async function gtmFetch<T>(accessToken: string, path: string): Promise<T> {
  const r = await fetch(
    `https://tagmanager.googleapis.com/tagmanager/v2${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
  );
  if (!r.ok) {
    const text = await r.text();
    throw new GtmApiError(r.status, text);
  }
  return (await r.json()) as T;
}
