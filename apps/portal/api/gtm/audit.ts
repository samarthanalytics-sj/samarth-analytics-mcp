import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

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

type AuditSourceFlag = "CONFIG" | "RUNTIME" | "SGTM" | "GA4_ADMIN";
type AuditCoverage = "covered" | "partial" | "not_covered";
type AuditConfidence = "high" | "medium" | "low";
type AuditEffort = "S" | "M" | "L";

interface AuditCapabilityFlags {
  CONFIG: boolean;
  RUNTIME: boolean;
  SGTM: boolean;
  GA4_ADMIN: boolean;
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
  capabilityFlags?: AuditCapabilityFlags;
  coverageMatrix?: AuditCoverageItem[];
  executiveSummary?: AuditExecutiveSummary;
  domainMaturity?: AuditDomainMaturity[];
  heatMap?: AuditHeatMapRow[];
  roadmap?: AuditRoadmapItem[];
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
    }>(req);
    const { accountId, containerId, workspaceId, containerPublicId } = body;
    if (!accountId || !containerId || !workspaceId) {
      return sendJson(res, 400, {
        error: "missing_params",
        message:
          "accountId, containerId and workspaceId are required. Use /api/gtm/accounts, /api/gtm/accounts/:id/containers, and the workspaces list to choose them, then retry.",
      });
    }

    try {
      const state = await pullAuditState(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      const summary = runAudit(state, {
        containerPublicId: containerPublicId ?? containerId,
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
}

function fid(seed: string): string {
  return (
    "f_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)
  );
}

function buildCtx(state: AuditState): Ctx {
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

// C. Consent and privacy
function ruleConsentSettings(ctx: Ctx, out: AuditFinding[]) {
  const missing: string[] = [];
  for (const tag of ctx.tags) {
    if (!isMarketingOrAnalyticsTag(tag)) continue;
    const consentStatus = tag.consentSettings?.consentStatus;
    if (!consentStatus || consentStatus === "NOT_SET") {
      missing.push(tag.name ?? "Unnamed tag");
    }
  }
  if (missing.length > 0) {
    pushFinding(out, {
      id: fid(`consent-not-set:${missing.length}`),
      category: "consent",
      severity: "high",
      finding: `${missing.length} marketing/analytics tag(s) have no consent settings configured`,
      affected: missing.slice(0, 20),
      whyItMatters:
        "When consentSettings is NOT_SET the tag will fire regardless of consent state. Consent Mode v2 requires explicit consent checks for marketing/analytics tags in regulated regions.",
      suggestedFix:
        "Set consentSettings to NEEDED (or NOT_NEEDED with justification) for each tag that loads marketing or analytics scripts/pixels.",
      sources: ["CONFIG"],
      parameter: "consentSettings.consentStatus",
      businessImpact:
        "Firing marketing/analytics tags without consent in regulated regions is a compliance risk (GDPR, ePrivacy, CCPA).",
      effort: "M",
    });
  }
}

function ruleConsentSignalsPresent(ctx: Ctx, out: AuditFinding[]) {
  const hasAdStorage = /ad_storage/.test(ctx.textBlob);
  const hasAnalyticsStorage = /analytics_storage/.test(ctx.textBlob);
  const hasConsentEvent =
    /consent[_\s-]?(update|default|granted|denied)/.test(ctx.textBlob);
  if (!hasAdStorage && !hasAnalyticsStorage && !hasConsentEvent) {
    pushFinding(out, {
      id: fid("consent-missing"),
      category: "consent",
      severity: "medium",
      finding: "No Consent Mode v2 signals were found in tag or variable configuration",
      whyItMatters:
        "No references to ad_storage, analytics_storage, or consent default/update were found across tags or variables. A CMP outside GTM may still be supplying consent — this needs manual confirmation.",
      suggestedFix:
        "Confirm a CMP is initialising Consent Mode v2 before marketing/analytics tags fire. If consent is managed inside GTM, add the appropriate signals.",
      needsManualReview: true,
      sources: ["CONFIG"],
      parameter: "ad_storage / analytics_storage / consent",
      businessImpact:
        "Without verified consent signalling, regulated jurisdictions may see non-compliant tag firing.",
      effort: "M",
    });
  }
}

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
  opts: { containerPublicId: string },
): AuditSummary {
  const ctx = buildCtx(state);
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
  // C. Consent & privacy
  ruleConsentSettings(ctx, findings);
  ruleConsentSignalsPresent(ctx, findings);
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
  // Today the portal only has CONFIG. RUNTIME / SGTM / GA4_ADMIN routes are
  // not implemented in the portal; flip these to true when corresponding
  // server-side routes are added.
  //
  // GA4_ADMIN note: the MCP server now ships read-only GA4 Admin tools
  // (ga4_account_summaries_list, ga4_data_streams_list, ga4_custom_dimensions_list,
  // ga4_data_retention_get, etc.) backed by the analytics.readonly scope. The
  // portal flag stays false until a Vercel-safe portal API route calls those
  // GA4 Admin endpoints with the user's token — do NOT set this true without a
  // live route, or the audit will report GA4_ADMIN coverage it cannot deliver.
  const capabilityFlags: AuditCapabilityFlags = {
    CONFIG: true,
    RUNTIME: false,
    SGTM: false,
    GA4_ADMIN: false,
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
    capabilityFlags,
    coverageMatrix,
    executiveSummary,
    domainMaturity,
    heatMap,
    roadmap,
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
      "Server container read tools (clients, transformations, server-side tags)",
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
      "cross-source-recon",
      "Cross-source reconciliation (CONFIG ↔ RUNTIME ↔ SGTM ↔ GA4_ADMIN)",
      ["CONFIG", "RUNTIME"],
      "Requires at least RUNTIME alongside CONFIG to reconcile intent vs reality",
    ),
  ];
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
