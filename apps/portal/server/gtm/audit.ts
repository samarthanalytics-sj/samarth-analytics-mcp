/**
 * GTM QC / audit rules for the portal.
 *
 * Read-only inspection of a workspace's tags/triggers/variables/folders/
 * built-in variables. Adapted from src/tools/audit.ts in the MCP package,
 * but expanded with the QC ruleset the portal needs:
 *   - GA4 measurement ID / event name completeness
 *   - duplicate GA4 config / event patterns
 *   - consent mode (ad_storage / analytics_storage) references
 *   - ecommerce / dataLayer-related gaps
 *   - naming convention warnings (untitled / generic)
 *   - Custom HTML tag flag for manual review
 *
 * Returns a portal-shaped AuditSummary (see shared/portal-types.ts).
 */

import crypto from "node:crypto";
import type {
  GtmBuiltInVariable,
  GtmFolder,
  GtmTag,
  GtmTrigger,
  GtmVariable,
  WorkspaceContents,
} from "./api";
import type {
  AuditCategory,
  AuditFinding,
  AuditSeverity,
  AuditSummary,
} from "../../shared/portal-types";

function fid(seed: string): string {
  return "f_" + crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10);
}

interface Ctx {
  tags: GtmTag[];
  triggers: GtmTrigger[];
  variables: GtmVariable[];
  folders: GtmFolder[];
  builtIns: GtmBuiltInVariable[];
  triggerIdSet: Set<string>;
  variableIdSet: Set<string>;
  builtInTypes: Set<string>;
  variableRefRegex: RegExp;
  textBlob: string;
}

function buildCtx(contents: WorkspaceContents): Ctx {
  const triggerIdSet = new Set(contents.triggers.map((t) => t.triggerId ?? "").filter(Boolean));
  const variableIdSet = new Set(contents.variables.map((v) => v.variableId ?? "").filter(Boolean));
  const builtInTypes = new Set(contents.builtInVariables.map((b) => b.type ?? "").filter(Boolean));

  const variableRefRegex = /\{\{([^}]+)\}\}/g;
  const textBlob = collectTextBlob(contents);

  return {
    tags: contents.tags,
    triggers: contents.triggers,
    variables: contents.variables,
    folders: contents.folders,
    builtIns: contents.builtInVariables,
    triggerIdSet,
    variableIdSet,
    builtInTypes,
    variableRefRegex,
    textBlob,
  };
}

function collectTextBlob(c: WorkspaceContents): string {
  const parts: string[] = [];
  for (const t of c.tags) {
    parts.push(t.name ?? "", t.type ?? "");
    for (const p of t.parameter ?? []) {
      parts.push(p.key ?? "", p.value ?? "");
    }
  }
  for (const v of c.variables) {
    parts.push(v.name ?? "", v.type ?? "");
    for (const p of v.parameter ?? []) {
      parts.push(p.key ?? "", p.value ?? "");
    }
  }
  return parts.join("\n").toLowerCase();
}

// ── Rule helpers ─────────────────────────────────────────────────────────

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

// ── Rules ────────────────────────────────────────────────────────────────

function ruleTagsNoFiringTriggers(ctx: Ctx, out: AuditFinding[]) {
  for (const tag of ctx.tags) {
    const has =
      (tag.firingTriggerId?.length ?? 0) > 0 || (tag.firingRuleId?.length ?? 0) > 0;
    if (!has) {
      const name = tag.name ?? "Unnamed tag";
      out.push({
        id: fid(`no-trigger:${tag.tagId}`),
        category: "ga4",
        severity: "high",
        title: `Tag has no firing triggers`,
        description: `Tag "${name}" (type: ${tag.type ?? "unknown"}) has no firing trigger configured, so it will never fire in production.`,
        affects: [name],
        recommendation: "Attach an appropriate firing trigger, or delete the tag if it is no longer needed.",
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
        recommendation: "Unpause the tag if it is still required, otherwise remove it.",
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
    const measurementId = tagParam(tag, "tagId") ?? tagParam(tag, "measurementId");
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
    const configRef = tagParam(tag, "measurementId") ?? tagParam(tag, "measurementIdOverride");
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
  byKey.forEach((arr: GtmTag[], key: string) => {
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
  counts.forEach((c: number, n: string) => {
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
    for (const tid of [...(tag.firingTriggerId ?? []), ...(tag.blockingTriggerId ?? [])]) {
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
  // Find variable references in tag/variable parameters via {{Name}} syntax,
  // and variableId fields where present.
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
  // Triggers can reference variables in filter values too — best-effort
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
      recommendation: "Review the script body, confirm it respects consent, and prefer first-class tag templates when available.",
    });
  }
}

function ruleConsentMode(ctx: Ctx, out: AuditFinding[]) {
  const hasAdStorage = /ad_storage/.test(ctx.textBlob);
  const hasAnalyticsStorage = /analytics_storage/.test(ctx.textBlob);
  const hasConsentEvent = /consent[_\s-]?(update|default|granted|denied)/.test(ctx.textBlob);
  if (!hasAdStorage && !hasAnalyticsStorage) {
    out.push({
      id: fid(`consent-missing`),
      category: "consent",
      severity: "high",
      title: `No Consent Mode signals detected`,
      description: `No references to ad_storage or analytics_storage were found across tags or variables. Consent Mode v2 is required for EEA traffic and recommended elsewhere.`,
      recommendation: "Implement Consent Mode v2 default/update signals before personalisation/ad tags fire.",
    });
  } else if (!hasAdStorage || !hasAnalyticsStorage) {
    out.push({
      id: fid(`consent-partial`),
      category: "consent",
      severity: "medium",
      title: `Partial Consent Mode coverage`,
      description: `Only one of ad_storage / analytics_storage was referenced. A complete Consent Mode v2 implementation needs both, plus ad_user_data and ad_personalization.`,
      recommendation: "Add the missing consent signals (ad_storage, analytics_storage, ad_user_data, ad_personalization).",
    });
  } else if (!hasConsentEvent) {
    out.push({
      id: fid(`consent-no-update`),
      category: "consent",
      severity: "low",
      title: `Consent signals present but no update event detected`,
      description: `ad_storage / analytics_storage were referenced but no consent update/default event was found in tag or variable text.`,
      recommendation: "Confirm a Consent Mode default and update event is wired up (often via the Consent Mode template).",
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
      (v) => /ecommerce/i.test(v.name ?? "") || /ecommerce/i.test(JSON.stringify(v.parameter ?? "")),
    );
    if (!ecommerceVariable) {
      out.push({
        id: fid(`ecommerce-no-var`),
        category: "ecommerce",
        severity: "medium",
        title: `Ecommerce events without an ecommerce DataLayer variable`,
        description: `GA4 ecommerce event tags are present but no Data Layer variable named or referencing "ecommerce" was found. Ecommerce events typically need an items[] array sourced from the dataLayer.`,
        recommendation: "Add a Data Layer Variable for ecommerce (or items) and pass it as event parameters.",
      });
    }
  } else if (!referencesEcommerceObject) {
    out.push({
      id: fid(`ecommerce-none`),
      category: "data_layer",
      severity: "info",
      title: `No ecommerce / dataLayer references detected`,
      description: `No tags or variables reference ecommerce or dataLayer. If this container is for an ecommerce site, ecommerce events are likely missing.`,
      recommendation: "If this is an ecommerce site, implement GA4 ecommerce events (purchase, add_to_cart, etc.).",
    });
  }
}

function ruleNamingConventions(ctx: Ctx, out: AuditFinding[]) {
  const generic = (n?: string) => looksGeneric((n ?? "").toString());
  const flagged: string[] = [];
  for (const t of ctx.tags) if (generic(t.name)) flagged.push(`Tag: ${t.name ?? "(blank)"}`);
  for (const t of ctx.triggers) if (generic(t.name)) flagged.push(`Trigger: ${t.name ?? "(blank)"}`);
  for (const v of ctx.variables) if (generic(v.name)) flagged.push(`Variable: ${v.name ?? "(blank)"}`);
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

  const empties = ctx.folders.filter((f) => (counts.get(f.folderId ?? "") ?? 0) === 0);
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

// ── Public API ───────────────────────────────────────────────────────────

const SEVERITY_WEIGHT: Record<AuditSeverity, number> = {
  critical: 25,
  high: 12,
  medium: 5,
  low: 2,
  info: 0,
};

export function computeHealthScore(findings: AuditFinding[]): number {
  let score = 100;
  for (const f of findings) score -= SEVERITY_WEIGHT[f.severity];
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface AuditOptions {
  containerPublicId: string;
}

export function runAudit(
  contents: WorkspaceContents,
  opts: AuditOptions,
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

  findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);

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

export type { AuditCategory, AuditFinding };
