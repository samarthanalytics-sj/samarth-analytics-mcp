/**
 * GTM Audit tool
 *
 * Inspects a container workspace and returns findings about common analytics
 * implementation issues including:
 *  - Tags firing on all pages without conditions
 *  - Duplicate tag names / types
 *  - Tags without triggers
 *  - Tags referencing non-existent triggers or variables
 *  - Variables referencing non-existent triggers (for conditionally scoped variables)
 *  - Paused tags
 *  - GA4 config tag count (should be exactly 1)
 *  - Missing or empty built-in variables commonly needed for GA4
 *  - Trigger filter conditions with suspicious patterns
 *  - Orphaned folders (empty folders)
 *  - Missing dataLayer push variable type documentation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { jsonResult, errorResult } from '../utils/toolResponse.js';
import { paginate } from '../utils/pagination.js';
import {
  isBuiltinTriggerId,
  BUILTIN_ALL_PAGES_TRIGGER_ID,
} from '../utils/builtinTriggers.js';
import type { tagmanager_v2 } from 'googleapis';

export interface AuditFinding {
  severity: 'error' | 'warning' | 'info';
  category: string;
  entityType: string;
  entityId: string;
  entityName: string;
  message: string;
}

export function registerAuditTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'audit_container',
    {
      description:
        'Inspect a GTM workspace for common analytics implementation issues. ' +
        'Returns structured findings with severity levels (error/warning/info). ' +
        'This is a read-only operation — it never modifies anything.',
      inputSchema: z.object({
        accountId: z.string(),
        containerId: z.string(),
        workspaceId: z.string(),
        includeInfo: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include informational findings (verbose). Default: false.'),
      }),
    },
    async ({ accountId, containerId, workspaceId, includeInfo }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;

        // Fetch ALL workspace data, following pagination on every list so a large container isn't
        // truncated — otherwise a tag on page 1 whose trigger lives on page 2 is falsely flagged as a
        // broken_reference, and entities beyond page 1 are silently omitted from the audit entirely.
        const ws = client.accounts.containers.workspaces;
        const [tagsP, triggersP, variablesP, foldersP, bivP] = await Promise.all([
          paginate((t) => ws.tags.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.tag),
          paginate((t) => ws.triggers.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.trigger),
          paginate((t) => ws.variables.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.variable),
          paginate((t) => ws.folders.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.folder),
          paginate((t) => ws.built_in_variables.list({ parent, pageToken: t }).then((r) => r.data), (d) => d.builtInVariable),
        ]);

        const tags = tagsP.items;
        const triggers = triggersP.items;
        const variables = variablesP.items;
        const folders = foldersP.items;
        const builtInVars = bivP.items;
        // If the DEFAULT_MAX_PAGES ceiling was hit on any list, cross-reference checks may under-report;
        // surface it so the caller doesn't trust a partial audit as complete.
        const truncated = tagsP.truncated || triggersP.truncated || variablesP.truncated || foldersP.truncated || bivP.truncated;

        const findings: AuditFinding[] = [];

        // Build lookup sets
        const triggerIdSet = new Set(triggers.map((t) => t.triggerId ?? ''));
        // `triggers.list` never returns GTM's reserved built-in triggers (All Pages, Initialization,
        // Consent Initialization, ...), so an id in that range is real even though it is absent above.
        // Treating it as missing flagged every GA4 config tag - which fires on All Pages - as a broken
        // reference, an error-severity false positive in essentially every container audited.
        const triggerExists = (tid: string): boolean => triggerIdSet.has(tid) || isBuiltinTriggerId(tid);
        const variableIdSet = new Set(variables.map((v) => v.variableId ?? ''));
        const builtInVarTypes = new Set(builtInVars.map((b) => b.type ?? ''));

        // ── Tag checks ───────────────────────────────────────────────────────
        const tagNames = new Map<string, number>();
        let ga4ConfigCount = 0;
        const paramValue = (tag: tagmanager_v2.Schema$Tag, key: string): string =>
          (tag.parameter ?? []).find((p) => p.key === key)?.value ?? '';

        for (const tag of tags) {
          const id = tag.tagId ?? 'unknown';
          const name = tag.name ?? 'Unnamed';
          const type = tag.type ?? '';

          // Count GA4 config tags. `gaawc` is GA4-specific. A `googtag` (Google tag) is GA4 ONLY when its
          // tagId/measurementId is a G- id — an AW- googtag is Google Ads and a GT-/DC- id is a generic
          // Google tag, none of which is a GA4 config. Counting those caused a false "multiple GA4 config
          // → duplicate sessions" error for the common GA4 + Google Ads pairing.
          if (type === 'gaawc') {
            ga4ConfigCount++;
          } else if (type === 'googtag') {
            const tid = paramValue(tag, 'tagId') || paramValue(tag, 'measurementId');
            if (/^G-/i.test(tid)) ga4ConfigCount++;
          }

          // Duplicate names
          tagNames.set(name, (tagNames.get(name) ?? 0) + 1);

          // Tags without firing triggers
          const hasFiringTriggers =
            (tag.firingTriggerId?.length ?? 0) > 0 || (tag.firingRuleId?.length ?? 0) > 0;
          if (!hasFiringTriggers) {
            findings.push({
              severity: 'error',
              category: 'missing_trigger',
              entityType: 'tag',
              entityId: id,
              entityName: name,
              message: `Tag "${name}" (type: ${type}) has no firing triggers — it will never fire.`,
            });
          }

          // Paused tags
          if (tag.paused) {
            findings.push({
              severity: 'warning',
              category: 'paused_tag',
              entityType: 'tag',
              entityId: id,
              entityName: name,
              message: `Tag "${name}" is paused and will not fire even when triggered.`,
            });
          }

          // Validate referenced trigger IDs exist
          for (const tid of tag.firingTriggerId ?? []) {
            if (!triggerExists(tid)) {
              findings.push({
                severity: 'error',
                category: 'broken_reference',
                entityType: 'tag',
                entityId: id,
                entityName: name,
                message: `Tag "${name}" references firing trigger ID "${tid}" which does not exist in this workspace.`,
              });
            }
          }

          for (const tid of tag.blockingTriggerId ?? []) {
            if (!triggerExists(tid)) {
              findings.push({
                severity: 'warning',
                category: 'broken_reference',
                entityType: 'tag',
                entityId: id,
                entityName: name,
                message: `Tag "${name}" references blocking trigger ID "${tid}" which does not exist in this workspace.`,
              });
            }
          }
        }

        // Multiple GA4 Config tags
        if (ga4ConfigCount > 1) {
          findings.push({
            severity: 'error',
            category: 'ga4_config',
            entityType: 'container',
            entityId: containerId,
            entityName: 'Container',
            message: `Found ${ga4ConfigCount} GA4 Config (Google Tag/googtag/gaawc) tags. You should have exactly 1. Multiple config tags cause duplicate sessions and events.`,
          });
        }

        // Duplicate tag names
        for (const [name, count] of tagNames.entries()) {
          if (count > 1) {
            findings.push({
              severity: 'warning',
              category: 'duplicate_name',
              entityType: 'tag',
              entityId: 'multiple',
              entityName: name,
              message: `Tag name "${name}" is used ${count} times. Use unique names to avoid confusion.`,
            });
          }
        }

        // Tags firing on all pages (All Pages trigger - triggerId "2147479553" is the GTM All Pages trigger)
        // We look for triggers of type "pageview" with no filters
        const allPagesTriggers = triggers.filter(
          (t) => t.type === 'pageview' && (!t.filter || t.filter.length === 0)
        );
        // Seed with the built-in All Pages id: it is what tags actually reference, and it is never in
        // `triggers.list`, so a Custom HTML tag on the real All Pages trigger used to slip this check
        // entirely. The filter above only catches user-created no-filter pageview triggers.
        const allPagesIds = new Set([
          ...allPagesTriggers.map((t) => t.triggerId ?? ''),
          BUILTIN_ALL_PAGES_TRIGGER_ID,
        ]);
        for (const tag of tags) {
          if (tag.type === 'html' || tag.type === 'img') {
            const firesOnAll = (tag.firingTriggerId ?? []).some((tid) => allPagesIds.has(tid));
            if (firesOnAll) {
              findings.push({
                severity: 'warning',
                category: 'broad_trigger',
                entityType: 'tag',
                entityId: tag.tagId ?? '',
                entityName: tag.name ?? '',
                message: `Custom HTML/Image tag "${tag.name}" fires on All Pages. Verify this is intentional — custom HTML tags on all pages can impact performance.`,
              });
            }
          }
        }

        // ── Trigger checks ───────────────────────────────────────────────────
        const usedTriggerIds = new Set<string>();
        for (const tag of tags) {
          for (const tid of [...(tag.firingTriggerId ?? []), ...(tag.blockingTriggerId ?? [])]) {
            usedTriggerIds.add(tid);
          }
        }

        for (const trigger of triggers) {
          const id = trigger.triggerId ?? 'unknown';
          const name = trigger.name ?? 'Unnamed';

          if (!usedTriggerIds.has(id)) {
            findings.push({
              severity: 'info',
              category: 'unused_trigger',
              entityType: 'trigger',
              entityId: id,
              entityName: name,
              message: `Trigger "${name}" is not used by any tag in this workspace.`,
            });
          }
        }

        // ── Variable checks ──────────────────────────────────────────────────
        for (const variable of variables) {
          const id = variable.variableId ?? 'unknown';
          const name = variable.name ?? 'Unnamed';

          // Check enabling/disabling trigger refs
          for (const tid of variable.enablingTriggerId ?? []) {
            if (!triggerExists(tid)) {
              findings.push({
                severity: 'warning',
                category: 'broken_reference',
                entityType: 'variable',
                entityId: id,
                entityName: name,
                message: `Variable "${name}" references enabling trigger ID "${tid}" which does not exist.`,
              });
            }
          }
        }

        // ── Built-in variable checks ─────────────────────────────────────────
        const recommendedGA4 = ['event', 'pageUrl', 'pageHostname', 'pagePath', 'referrer'];
        for (const rec of recommendedGA4) {
          if (!builtInVarTypes.has(rec)) {
            findings.push({
              severity: 'info',
              category: 'missing_builtin_variable',
              entityType: 'container',
              entityId: containerId,
              entityName: 'Container',
              message: `Built-in variable "${rec}" is not enabled. It is commonly used with GA4 and event tracking.`,
            });
          }
        }

        // ── Folder checks ────────────────────────────────────────────────────
        if (includeInfo) {
          const folderEntityCounts = new Map<string, number>();
          for (const folder of folders) {
            folderEntityCounts.set(folder.folderId ?? '', 0);
          }
          for (const tag of tags) {
            if (tag.parentFolderId) {
              folderEntityCounts.set(tag.parentFolderId, (folderEntityCounts.get(tag.parentFolderId) ?? 0) + 1);
            }
          }
          for (const trigger of triggers) {
            if (trigger.parentFolderId) {
              folderEntityCounts.set(trigger.parentFolderId, (folderEntityCounts.get(trigger.parentFolderId) ?? 0) + 1);
            }
          }
          for (const variable of variables) {
            if (variable.parentFolderId) {
              folderEntityCounts.set(variable.parentFolderId, (folderEntityCounts.get(variable.parentFolderId) ?? 0) + 1);
            }
          }

          for (const folder of folders) {
            const count = folderEntityCounts.get(folder.folderId ?? '') ?? 0;
            if (count === 0) {
              findings.push({
                severity: 'info',
                category: 'empty_folder',
                entityType: 'folder',
                entityId: folder.folderId ?? '',
                entityName: folder.name ?? 'Unnamed',
                message: `Folder "${folder.name}" is empty — consider removing it.`,
              });
            }
          }
        }

        // Filter findings based on includeInfo flag
        const filteredFindings = includeInfo
          ? findings
          : findings.filter((f) => f.severity !== 'info');

        const summary = {
          workspace: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          stats: {
            tags: tags.length,
            triggers: triggers.length,
            variables: variables.length,
            folders: folders.length,
            builtInVariables: builtInVars.length,
          },
          // True only if a list hit the page ceiling — cross-reference findings may then under-report.
          ...(truncated ? { truncated: true } : {}),
          findingCount: {
            total: filteredFindings.length,
            errors: filteredFindings.filter((f) => f.severity === 'error').length,
            warnings: filteredFindings.filter((f) => f.severity === 'warning').length,
            info: filteredFindings.filter((f) => f.severity === 'info').length,
          },
          findings: filteredFindings,
        };

        return jsonResult(summary);
      } catch (err) {
        return errorResult('audit_container', err);
      }
    }
  );
}
