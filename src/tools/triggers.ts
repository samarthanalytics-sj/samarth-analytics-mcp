/**
 * GTM Triggers tools — full CRUD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { paginate, paginationFields, buildListResult } from '../utils/pagination.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { workspaceScope as wsBase } from '../utils/schemas.js';
import { gtmParameterArray } from '../utils/paramSchema.js';
import { mergeParametersByKey } from '../utils/tagParams.js';
import type { tagmanager_v2 } from 'googleapis';

/**
 * A GTM trigger condition.
 *
 * The arg0/arg1 contract is stated here rather than only in the guided prompts. It used to live
 * only in the ecommerce and server-side prompts, so a plain "create a click trigger on Click URL"
 * conversation saw a `key` field with no description, guessed one, and got back
 * `filter[0].parameter[0]: Parameter key is unknown` — an error that says nothing about what the
 * key should have been.
 */
const conditionSchema = z
  .array(
    z.object({
      type: z.string().describe('Condition type: contains, cssSelector, endsWith, equals, greater, greaterOrEquals, less, lessOrEquals, matchRegex, startsWith, urlMatches.'),
      parameter: z
        .array(
          z.object({
            type: z.string().describe('Almost always "template".'),
            key: z
              .string()
              .optional()
              .describe(
                'MUST be "arg0" or "arg1" — GTM accepts no other key here, and anything else fails ' +
                  'with "Parameter key is unknown". arg0 is the LEFT side (the variable being tested), ' +
                  'arg1 is the RIGHT side (the value compared against).',
              ),
            value: z
              .string()
              .optional()
              .describe(
                'For arg0, a variable reference in double braces, e.g. "{{Click URL}}", "{{_event}}", ' +
                  '"{{Page Path}}". For arg1, the literal to compare, e.g. "mailto:". A built-in ' +
                  'variable referenced in arg0 must be ENABLED in the workspace first — see ' +
                  'built_in_variables_enable (Click URL is "clickUrl", Click Text "clickText", ' +
                  'Form ID "formId", and so on).',
              ),
          }),
        )
        .describe(
          'EXACTLY TWO entries, keyed arg0 then arg1. Example, a link click on a mailto: address: ' +
            '[{"type":"template","key":"arg0","value":"{{Click URL}}"},' +
            '{"type":"template","key":"arg1","value":"mailto:"}] with condition type "contains".',
        ),
    })
  )
  .optional();

const paramSchema = z
  .object({ type: z.string(), key: z.string().optional(), value: z.string().optional() })
  .optional();

/**
 * A GTM scalar field that must be sent as a one-entry Parameter, accepting the plain value too.
 *
 * `waitForTags` is conceptually a boolean and GTM insists on
 * `{type:"boolean", value:"true"}`. Callers send `waitForTags: true`, which is the obvious
 * reading of the name, and the API answers "Expected object, received boolean at waitForTags".
 * Observed twice in one tag-creation turn: two failed writes and two wasted model round trips
 * before the same request succeeded, on an account where a round trip is ~6,000 of 30,000 tokens
 * per minute.
 *
 * Describing the shape harder did not work; it was already documented here. So accept the natural
 * form and convert it, the way normalizeTriggerType already repairs `all_clicks` into `click`.
 * A correctly shaped Parameter passes through untouched.
 */
function scalarParam(gtmType: 'boolean' | 'template', description: string) {
  return z
    .union([z.boolean(), z.number(), z.string(), paramSchema.unwrap()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === 'object') return v;
      return { type: gtmType, value: String(v) };
    })
    .describe(description);
}

export function registerTriggerTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'triggers_list',
    {
      description: 'List all GTM triggers in a workspace. Automatically follows pagination to return all triggers.',
      inputSchema: wsBase.extend(paginationFields),
    },
    async ({ accountId, containerId, workspaceId, pageToken, maxPages }) => {
      try {
        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
        const result = await paginate(
          (token) => client.accounts.containers.workspaces.triggers.list({ parent, pageToken: token }).then((r) => r.data),
          (data) => data.trigger,
          { pageToken, maxPages }
        );
        return jsonResult(buildListResult('triggers', result, { accountId, containerId, workspaceId }));
      } catch (err) {
        return errorResult('triggers_list', err);
      }
    }
  );

  server.registerTool(
    'triggers_get',
    {
      description: 'Get a specific GTM trigger.',
      inputSchema: wsBase.extend({ triggerId: z.string() }),
    },
    async ({ accountId, containerId, workspaceId, triggerId }) => {
      try {
        const client = getClient();
        const res = await client.accounts.containers.workspaces.triggers.get({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_get', err);
      }
    }
  );

  server.registerTool(
    'triggers_create',
    {
      description: '[WRITE] Create a GTM trigger. Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Trigger name.'),
        type: z.string().describe('Trigger type (e.g. "click", "pageview", "customEvent", "domReady", "windowLoaded", "historyChange", "jsError", "scrollDepth", "elementVisibility", "timer", "youTubeVideo", "formSubmission", "linkClick").'),
        filter: conditionSchema.describe('Conditions that must be met for the trigger to fire ("fires on SOME …").'),
        customEventFilter: conditionSchema.describe('Used for custom event triggers.'),
        autoEventFilter: conditionSchema.describe('Conditions for auto-event triggers (legacy; most scopes use `filter`).'),
        eventName: paramSchema.describe('Custom event name (for customEvent type).'),
        interval: paramSchema.describe('Timer trigger: firing interval in MILLISECONDS as a single Parameter {type:"template", value:"5000"} (no key). This is a dedicated TOP-LEVEL GTM field — do NOT put it in `parameter`.'),
        intervalSeconds: paramSchema.describe('Timer trigger: firing interval in SECONDS as a single Parameter (no key). Top-level GTM field. Use interval (ms) OR intervalSeconds, not both.'),
        limit: paramSchema.describe('Timer trigger: max number of times the timer fires, as a single Parameter {type:"template", value:"3"} (no key). Dedicated TOP-LEVEL GTM field — do NOT put it in `parameter`.'),
        parameter: gtmParameterArray.describe('Trigger settings as a parameter list — e.g. a YouTube Video trigger\'s captureStart/progressThresholdsPercent, scroll thresholds, element-visibility selector. NOTE: a timer\'s interval/limit are the separate top-level `interval`/`limit` fields, NOT here.'),
        waitForTags: scalarParam('boolean', 'Form/link trigger: send a plain boolean (true/false). A Parameter {type:"boolean", value:"true"} is also accepted.'),
        checkValidation: scalarParam('boolean', 'Form/link trigger: send a plain boolean (true/false). A Parameter object is also accepted.'),
        waitForTagsTimeout: scalarParam('template', 'Form/link trigger: timeout in milliseconds. Send a plain number (e.g. 2000). A Parameter object is also accepted.'),
        notes: z.string().optional(),
        parentFolderId: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, name, type, filter, customEventFilter, autoEventFilter, eventName, interval, intervalSeconds, limit, parameter, waitForTags, checkValidation, waitForTagsTimeout, notes, parentFolderId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create trigger "${name}" (type: ${type})`);
        }
        const client = getClient();
        const res = await client.accounts.containers.workspaces.triggers.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: { name, type, filter, customEventFilter, autoEventFilter, eventName, interval, intervalSeconds, limit, parameter, waitForTags, checkValidation, waitForTagsTimeout, notes, parentFolderId } as tagmanager_v2.Schema$Trigger,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_create', err);
      }
    }
  );

  server.registerTool(
    'triggers_update',
    {
      description:
        '[WRITE] Update a GTM trigger (read-modify-write — omitted fields are preserved; `parameter` is merged by key). Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        triggerId: z.string(),
        name: z.string().optional(),
        type: z.string().optional(),
        filter: conditionSchema,
        customEventFilter: conditionSchema,
        autoEventFilter: conditionSchema,
        eventName: paramSchema,
        interval: paramSchema.describe('Timer trigger: firing interval in ms as a single Parameter. Top-level GTM field — not in `parameter`.'),
        intervalSeconds: paramSchema.describe('Timer trigger: firing interval in seconds as a single Parameter. Top-level GTM field.'),
        limit: paramSchema.describe('Timer trigger: max fire count as a single Parameter. Top-level GTM field — not in `parameter`.'),
        parameter: gtmParameterArray,
        waitForTags: scalarParam('boolean', 'Form/link trigger: plain boolean, or a Parameter object.'),
        checkValidation: scalarParam('boolean', 'Form/link trigger: plain boolean, or a Parameter object.'),
        waitForTagsTimeout: scalarParam('template', 'Form/link trigger: timeout in milliseconds as a plain number, or a Parameter object.'),
        notes: z.string().optional(),
        fingerprint: z.string().optional(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, triggerId, confirm, fingerprint, ...updates }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would update trigger ${triggerId}`);
        }
        const client = getClient();
        const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`;
        // GTM's update is a full replace — fetch, overlay only the provided fields, and
        // merge `parameter` by key so the rest of the trigger isn't wiped.
        const existing = (await client.accounts.containers.workspaces.triggers.get({ path })).data;
        const merged: tagmanager_v2.Schema$Trigger = { ...existing };
        for (const [k, v] of Object.entries(updates)) {
          if (v === undefined) continue;
          if (k === 'parameter') {
            merged.parameter = mergeParametersByKey(existing.parameter ?? [], v as tagmanager_v2.Schema$Parameter[]);
          } else {
            (merged as Record<string, unknown>)[k] = v;
          }
        }
        const res = await client.accounts.containers.workspaces.triggers.update({
          path,
          fingerprint: fingerprint ?? existing.fingerprint ?? undefined,
          requestBody: merged,
        });
        return jsonResult(res.data);
      } catch (err) {
        return errorResult('triggers_update', err);
      }
    }
  );

  server.registerTool(
    'triggers_delete',
    {
      description: '[DELETE] Delete a GTM trigger. Requires GTM_MCP_ENABLE_DELETES=true and confirm=true.',
      inputSchema: wsBase.extend({
        triggerId: z.string(),
        confirm: z.boolean(),
      }),
    },
    async ({ accountId, containerId, workspaceId, triggerId, confirm }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('delete', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would delete trigger ${triggerId}`);
        }
        const client = getClient();
        await client.accounts.containers.workspaces.triggers.delete({
          path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        });
        return textResult(`Trigger ${triggerId} deleted successfully.`);
      } catch (err) {
        return errorResult('triggers_delete', err);
      }
    }
  );
}
