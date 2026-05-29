import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

/**
 * /api/gtm/audit
 *
 * Fully self-contained: no imports outside of `node:*`. The QC audit
 * ruleset lives in this file so the route is guaranteed to bundle on
 * Vercel and never fails with "Audit module failed to load." Reliability
 * over DRY — the canonical engine still lives at
 * `apps/portal/server/gtm/audit.ts` for the local Express server.
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
}

interface GtmTrigger {
  triggerId?: string;
  name?: string;
  type?: string;
  filter?: unknown[];
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

interface WorkspaceContents {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  folders: GtmFolder[];
  builtInVariables: GtmBuiltInVariable[];
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
  | "data_layer";

interface AuditFinding {
  id: string;
  category: AuditCategory;
  title: string;
  description: string;
  severity: AuditSeverity;
  affects?: string[];
  recommendation?: string;
}

interface AuditSummary {
  containerId: string;
  generatedAt: string;
  healthScore: number;
  counts: { tags: number; triggers: number; variables: number };
  findings: AuditFinding[];
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
        message: "accountId, containerId and workspaceId are required.",
      });
    }

    try {
      const contents = await fetchWorkspaceContents(
        token,
        accountId,
        containerId,
        workspaceId,
      );
      const summary = runAudit(contents, {
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
  triggerIdSet: Set<string>;
  builtInTypes: Set<string>;
  textBlob: string;
}

function fid(seed: string): string {
  return (
    "f_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)
  );
}

function buildCtx(contents: WorkspaceContents): Ctx {
  const triggerIdSet = new Set(
    contents.triggers.map((t) => t.triggerId ?? "").filter(Boolean),
  );
  const builtInTypes = new Set(
    contents.builtInVariables.map((b) => b.type ?? "").filter(Boolean),
  );
  return {
    tags: contents.tags,
    triggers: contents.triggers,
    variables: contents.variables,
    folders: contents.folders,
    builtIns: contents.builtInVariables,
    triggerIdSet,
    builtInTypes,
    textBlob: collectTextBlob(contents),
  };
}

function collectTextBlob(c: WorkspaceContents): string {
  const parts: string[] = [];
  for (const t of c.tags) {
    parts.push(t.name ?? "", t.type ?? "");
    for (const p of t.parameter ?? []) parts.push(p.key ?? "", p.value ?? "");
  }
  for (const v of c.variables) {
    parts.push(v.name ?? "", v.type ?? "");
    for (const p of v.parameter ?? []) parts.push(p.key ?? "", p.value ?? "");
  }
  return parts.join("\n").toLowerCase();
}

function tagParam(tag: GtmTag, key: string): string | undefined {
  return tag.parameter?.find((p) => p.key === key)?.value;
}

function isGA4Config(tag: GtmTag): boolean {
  return tag.type === "gaawc" || tag.type === "googtag";
}
function isGA4Event(tag: GtmTag): boolean {
  return tag.type === "gaawe";
}

function looksGeneric(name: string): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (!n) return true;
  if (n === "unnamed" || n === "untitled") return true;
  if (/^untitled\s*(tag|trigger|variable)?(\s*\d+)?$/i.test(n)) return true;
  if (/^(new\s+)?(tag|trigger|variable)\s*\d*$/i.test(n)) return true;
  if (/^copy\s+of\s+/i.test(n)) return true;
  return false;
}

function ruleTagsNoFiringTriggers(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    const has =
      (tag.firingTriggerId?.length ?? 0) > 0 ||
      (tag.firingRuleId?.length ?? 0) > 0;
    if (!has) {
      const name = tag.name ?? "Unnamed tag";
      out.push({
        id: fid(`no-trigger:${tag.tagId}`),
        category: "ga4",
        severity: "high",
        title: `Tag has no firing triggers`,
        description: `Tag "${name}" (type: ${tag.type ?? "unknown"}) has no firing trigger configured, so it will never fire in production.`,
        affects: [name],
        recommendation:
          "Attach an appropriate firing trigger, or delete the tag if it is no longer needed.",
      });
    }
  }
}

function rulePausedTags(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (tag.paused) {
      const name = tag.name ?? "Unnamed tag";
      out.push({
        id: fid(`paused:${tag.tagId}`),
        category: "ga4",
        severity: "medium",
        title: `Paused tag`,
        description: `Tag "${name}" is paused and will not fire even when its trigger matches.`,
        affects: [name],
        recommendation:
          "Unpause the tag if it is still required, otherwise remove it.",
      });
    }
  }
}

function ruleBrokenReferences(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    const name = tag.name ?? "Unnamed tag";
    for (const tid of tag.firingTriggerId ?? []) {
      if (!ctx.triggerIdSet.has(tid)) {
        out.push({
          id: fid(`broken-fire:${tag.tagId}:${tid}`),
          category: "ga4",
          severity: "high",
          title: `Tag references a missing firing trigger`,
          description: `Tag "${name}" references firing trigger id "${tid}" which does not exist in this workspace.`,
          affects: [name],
          recommendation: "Re-attach a valid trigger or remove the dangling reference.",
        });
      }
    }
    for (const tid of tag.blockingTriggerId ?? []) {
      if (!ctx.triggerIdSet.has(tid)) {
        out.push({
          id: fid(`broken-block:${tag.tagId}:${tid}`),
          category: "ga4",
          severity: "medium",
          title: `Tag references a missing blocking trigger`,
          description: `Tag "${name}" references blocking trigger id "${tid}" which does not exist.`,
          affects: [name],
          recommendation: "Remove the dangling blocking-trigger reference.",
        });
      }
    }
  }
}

function ruleGA4ConfigCount(ctx: Ctx, out: AuditFinding[]) {
  const configTags = ctx.tags.filter(isGA4Config);
  if (configTags.length > 1) {
    out.push({
      id: fid(`ga4-config-count:${configTags.length}`),
      category: "duplication",
      severity: "high",
      title: `Multiple GA4 Config / Google Tag entries`,
      description: `Found ${configTags.length} GA4 Config / Google Tag entries. A container should typically have exactly one. Multiple config tags cause duplicate sessions, pageviews, and events.`,
      affects: configTags.map((t) => t.name ?? "Unnamed"),
      recommendation: "Consolidate down to a single Google tag / GA4 Configuration tag.",
    });
  }
}

function ruleGA4MissingMeasurementId(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (!isGA4Config(tag)) continue;
    const measurementId =
      tagParam(tag, "tagId") ?? tagParam(tag, "measurementId");
    const name = tag.name ?? "GA4 config";
    if (!measurementId || !/^G-/i.test(measurementId)) {
      out.push({
        id: fid(`ga4-mid:${tag.tagId}`),
        category: "ga4",
        severity: "critical",
        title: `GA4 Config tag missing valid Measurement ID`,
        description: `Tag "${name}" does not have a recognizable GA4 Measurement ID (G-XXXXXXX).`,
        affects: [name],
        recommendation: "Set a valid GA4 Measurement ID on the configuration tag.",
      });
    }
  }
}

function ruleGA4EventCompleteness(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (!isGA4Event(tag)) continue;
    const name = tag.name ?? "GA4 event";
    const eventName = tagParam(tag, "eventName");
    if (!eventName) {
      out.push({
        id: fid(`ga4-event-name:${tag.tagId}`),
        category: "ga4",
        severity: "high",
        title: `GA4 Event tag missing event name`,
        description: `Tag "${name}" has no event_name parameter set; it will send blank events to GA4.`,
        affects: [name],
        recommendation: "Set an event_name (e.g. purchase, sign_up, generate_lead).",
      });
    }
    const configRef =
      tagParam(tag, "measurementId") ?? tagParam(tag, "measurementIdOverride");
    if (!configRef) {
      out.push({
        id: fid(`ga4-event-config:${tag.tagId}`),
        category: "ga4",
        severity: "medium",
        title: `GA4 Event tag missing measurement ID reference`,
        description: `Tag "${name}" does not reference a measurement ID. Verify the linked Google Tag / measurement ID is correct.`,
        affects: [name],
        recommendation: "Confirm the measurement ID or measurement ID override is set.",
      });
    }
  }
}

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
      out.push({
        id: fid(`ga4-dup-event:${key}`),
        category: "duplication",
        severity: "high",
        title: `Duplicate GA4 event tags`,
        description: `${arr.length} GA4 Event tags share the same event_name and firing triggers. They will produce duplicate events in GA4.`,
        affects: arr.map((t) => t.name ?? "Unnamed"),
        recommendation: "Keep one canonical event tag and delete or repurpose the duplicates.",
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
      out.push({
        id: fid(`dup-name:${n}`),
        category: "duplication",
        severity: "medium",
        title: `Duplicate tag name "${n}"`,
        description: `Tag name "${n}" is used ${c} times. Unique names make audits and debugging much easier.`,
        affects: [n],
        recommendation: "Rename the duplicates so each tag has a unique, descriptive name.",
      });
    }
  });
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
      out.push({
        id: fid(`unused-trigger:${id}`),
        category: "performance",
        severity: "info",
        title: `Trigger not used by any tag`,
        description: `Trigger "${name}" is not referenced by any tag or variable.`,
        affects: [name],
        recommendation: "Remove unused triggers to keep the workspace tidy.",
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
  for (const tag of ctx.tags) {
    for (const p of tag.parameter ?? []) collect(p.value);
  }
  for (const v of ctx.variables) {
    for (const p of v.parameter ?? []) collect(p.value);
  }
  for (const t of ctx.triggers) {
    collect(JSON.stringify(t.filter ?? []));
  }
  for (const v of ctx.variables) {
    const name = (v.name ?? "").trim();
    if (!name) continue;
    if (!namesUsed.has(name.toLowerCase())) {
      out.push({
        id: fid(`unused-var:${v.variableId}`),
        category: "performance",
        severity: "info",
        title: `User-defined variable not referenced`,
        description: `Variable "${name}" does not appear to be referenced by any tag, trigger, or other variable.`,
        affects: [name],
        recommendation: "Confirm the variable is still needed; delete if it has no readers.",
      });
    }
  }
}

function ruleCustomHtmlForReview(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    if (tag.type !== "html") continue;
    const name = tag.name ?? "Custom HTML tag";
    out.push({
      id: fid(`custom-html:${tag.tagId}`),
      category: "performance",
      severity: "medium",
      title: `Custom HTML tag — manual review required`,
      description: `Tag "${name}" runs arbitrary JavaScript inside the GTM container. Custom HTML tags should be reviewed for security, consent compliance, and performance impact.`,
      affects: [name],
      recommendation:
        "Review the script body, confirm it respects consent, and prefer first-class tag templates when available.",
    });
  }
}

function ruleConsentMode(ctx: Ctx, out: AuditFinding[]) {
  const hasAdStorage = /ad_storage/.test(ctx.textBlob);
  const hasAnalyticsStorage = /analytics_storage/.test(ctx.textBlob);
  const hasConsentEvent = /consent[_\s-]?(update|default|granted|denied)/.test(
    ctx.textBlob,
  );
  if (!hasAdStorage && !hasAnalyticsStorage) {
    out.push({
      id: fid(`consent-missing`),
      category: "consent",
      severity: "high",
      title: `No Consent Mode signals detected`,
      description: `No references to ad_storage or analytics_storage were found across tags or variables. Consent Mode v2 is required for EEA traffic and recommended elsewhere.`,
      recommendation:
        "Implement Consent Mode v2 default/update signals before personalisation/ad tags fire.",
    });
  } else if (!hasAdStorage || !hasAnalyticsStorage) {
    out.push({
      id: fid(`consent-partial`),
      category: "consent",
      severity: "medium",
      title: `Partial Consent Mode coverage`,
      description: `Only one of ad_storage / analytics_storage was referenced. A complete Consent Mode v2 implementation needs both, plus ad_user_data and ad_personalization.`,
      recommendation:
        "Add the missing consent signals (ad_storage, analytics_storage, ad_user_data, ad_personalization).",
    });
  } else if (!hasConsentEvent) {
    out.push({
      id: fid(`consent-no-update`),
      category: "consent",
      severity: "low",
      title: `Consent signals present but no update event detected`,
      description: `ad_storage / analytics_storage were referenced but no consent update/default event was found in tag or variable text.`,
      recommendation:
        "Confirm a Consent Mode default and update event is wired up (often via the Consent Mode template).",
    });
  }
}

function ruleEcommerce(ctx: Ctx, out: AuditFinding[]) {
  const hasEcommerceEventTag = ctx.tags.some(
    (t) =>
      isGA4Event(t) &&
      /(purchase|add_to_cart|begin_checkout|view_item|select_item|view_cart|add_to_wishlist)/i.test(
        tagParam(t, "eventName") ?? "",
      ),
  );
  const referencesEcommerceObject = /ecommerce|dataLayer/.test(ctx.textBlob);
  if (hasEcommerceEventTag) {
    const ecommerceVariable = ctx.variables.some(
      (v) =>
        /ecommerce/i.test(v.name ?? "") ||
        /ecommerce/i.test(JSON.stringify(v.parameter ?? "")),
    );
    if (!ecommerceVariable) {
      out.push({
        id: fid(`ecommerce-no-var`),
        category: "ecommerce",
        severity: "medium",
        title: `Ecommerce events without an ecommerce DataLayer variable`,
        description: `GA4 ecommerce event tags are present but no Data Layer variable named or referencing "ecommerce" was found. Ecommerce events typically need an items[] array sourced from the dataLayer.`,
        recommendation:
          "Add a Data Layer Variable for ecommerce (or items) and pass it as event parameters.",
      });
    }
  } else if (!referencesEcommerceObject) {
    out.push({
      id: fid(`ecommerce-none`),
      category: "data_layer",
      severity: "info",
      title: `No ecommerce / dataLayer references detected`,
      description: `No tags or variables reference ecommerce or dataLayer. If this container is for an ecommerce site, ecommerce events are likely missing.`,
      recommendation:
        "If this is an ecommerce site, implement GA4 ecommerce events (purchase, add_to_cart, etc.).",
    });
  }
}

function ruleNamingConventions(ctx: Ctx, out: AuditFinding[]) {
  const generic = (n?: string) => looksGeneric((n ?? "").toString());
  const flagged: string[] = [];
  for (const t of ctx.tags) if (generic(t.name)) flagged.push(`Tag: ${t.name ?? "(blank)"}`);
  for (const t of ctx.triggers)
    if (generic(t.name)) flagged.push(`Trigger: ${t.name ?? "(blank)"}`);
  for (const v of ctx.variables)
    if (generic(v.name)) flagged.push(`Variable: ${v.name ?? "(blank)"}`);
  if (flagged.length > 0) {
    out.push({
      id: fid(`naming:${flagged.length}`),
      category: "naming",
      severity: "low",
      title: `${flagged.length} entit${flagged.length === 1 ? "y has" : "ies have"} generic or untitled names`,
      description: `Generic names like "Untitled Tag", "Tag 1", or "Copy of …" make audits harder. Use descriptive names (e.g. "GA4 — purchase").`,
      affects: flagged.slice(0, 10),
      recommendation: "Adopt a consistent naming convention such as `[Platform] - [Event] - [Context]`.",
    });
  }
}

function ruleBuiltInVariables(ctx: Ctx, out: AuditFinding[]) {
  const recommended = ["event", "pageUrl", "pageHostname", "pagePath", "referrer"];
  const missing = recommended.filter((r) => !ctx.builtInTypes.has(r));
  if (missing.length > 0) {
    out.push({
      id: fid(`builtin:${missing.join(",")}`),
      category: "ga4",
      severity: "info",
      title: `Recommended built-in variables not enabled`,
      description: `These built-in variables are commonly needed: ${missing.join(", ")}.`,
      affects: missing,
      recommendation: "Enable the missing built-in variables under Variables → Configure.",
    });
  }
}

function ruleEmptyFolders(ctx: Ctx, out: AuditFinding[]) {
  const counts = new Map<string, number>();
  for (const f of ctx.folders) counts.set(f.folderId ?? "", 0);
  const tally = (id?: string) => {
    if (!id) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const t of ctx.tags) tally(t.parentFolderId);
  for (const t of ctx.triggers) tally(t.parentFolderId);
  for (const v of ctx.variables) tally(v.parentFolderId);
  const empties = ctx.folders.filter(
    (f) => (counts.get(f.folderId ?? "") ?? 0) === 0,
  );
  if (empties.length > 0) {
    out.push({
      id: fid(`empty-folders:${empties.length}`),
      category: "performance",
      severity: "info",
      title: `${empties.length} empty folder${empties.length === 1 ? "" : "s"}`,
      description: `Empty folders are clutter — they make the workspace harder to navigate.`,
      affects: empties.map((f) => f.name ?? "Unnamed folder"),
      recommendation: "Delete unused folders.",
    });
  }
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
  for (const f of findings) score -= SEVERITY_WEIGHT[f.severity];
  return Math.max(0, Math.min(100, Math.round(score)));
}

function runAudit(
  contents: WorkspaceContents,
  opts: { containerPublicId: string },
): AuditSummary {
  const ctx = buildCtx(contents);
  const findings: AuditFinding[] = [];

  ruleTagsNoFiringTriggers(ctx, findings);
  rulePausedTags(ctx, findings);
  ruleBrokenReferences(ctx, findings);
  ruleGA4ConfigCount(ctx, findings);
  ruleGA4MissingMeasurementId(ctx, findings);
  ruleGA4EventCompleteness(ctx, findings);
  ruleDuplicateGA4Events(ctx, findings);
  ruleDuplicateTagNames(ctx, findings);
  ruleUnusedTriggers(ctx, findings);
  ruleUnusedVariables(ctx, findings);
  ruleCustomHtmlForReview(ctx, findings);
  ruleConsentMode(ctx, findings);
  ruleEcommerce(ctx, findings);
  ruleNamingConventions(ctx, findings);
  ruleBuiltInVariables(ctx, findings);
  ruleEmptyFolders(ctx, findings);

  findings.sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );

  return {
    containerId: opts.containerPublicId,
    generatedAt: new Date().toISOString(),
    healthScore: computeHealthScore(findings),
    counts: {
      tags: contents.tags.length,
      triggers: contents.triggers.length,
      variables: contents.variables.length,
    },
    findings,
  };
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

async function fetchWorkspaceContents(
  token: string,
  accountId: string,
  containerId: string,
  workspaceId: string,
): Promise<WorkspaceContents> {
  const base = `/accounts/${encodeURIComponent(accountId)}/containers/${encodeURIComponent(
    containerId,
  )}/workspaces/${encodeURIComponent(workspaceId)}`;
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
  return {
    tags: tagsRes.tag ?? [],
    triggers: triggersRes.trigger ?? [],
    variables: variablesRes.variable ?? [],
    folders: foldersRes.folder ?? [],
    builtInVariables: bivRes.builtInVariable ?? [],
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
