/**
 * Typed, one-call builders: the tools the desktop chat has and the website chat did not.
 *
 * Every other write tool in this server is a thin wrapper over one GTM API call, which makes the
 * CALLER responsible for the resource shape. For a model that means re-deriving GTM's conventions
 * on every turn, and the conventions are not guessable: a GA4 event tag needs a `measurementId`
 * tagReference AND a `measurementIdOverride`, event parameters live in an `eventSettingsTable` list
 * of maps keyed parameter/parameterValue, a click trigger's conditions are keyed arg0/arg1, and a
 * built-in variable referenced before it is enabled silently resolves to nothing.
 *
 * Measured consequences of leaving that to the model, from one real "create a GA4 email_click tag"
 * turn on the hosted chat: four list calls, a gallery-template import that 404ed, two rejected
 * trigger writes, and a Data Layer Variable created for a value nothing pushes to the dataLayer, so
 * the finished tag reports an empty email address. Eight model round trips at roughly 6,000 tokens
 * each, against an account limited to 30,000 tokens per minute.
 *
 * These tools take the fields a person would state and let OUR code build the resource, using the
 * same builders the desktop assistant uses (src/shared/gtm-builders.ts). One call enables the
 * built-in variables the tag and trigger reference, reuses or creates the named trigger, and
 * creates the tag pointing at it.
 *
 * Guardrails are unchanged: writes still require GTM_MCP_ENABLE_WRITES and confirm=true, and this
 * file creates nothing a caller could not already create by hand with tags_create + triggers_create
 * + built_in_variables_enable. It removes the guesswork, not the gate.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GtmClient } from '../utils/gtmClient.js';
import { checkGuardrails, getGuardrailConfig } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult } from '../utils/toolResponse.js';
import { paginate } from '../utils/pagination.js';
import {
  buildGa4EventTag,
  buildTrigger,
  buildVariable,
  triggerBuiltInVars,
  builtInVarsForTemplates,
  type TriggerInput,
  type TriggerKind,
  type VariableKind,
} from '../shared/gtm-builders.js';
import type { tagmanager_v2 } from 'googleapis';

const wsBase = z.object({
  accountId: z.string().describe('The GTM account ID.'),
  containerId: z.string().describe('The GTM container ID.'),
  workspaceId: z.string().describe('The GTM workspace ID.'),
});

/**
 * Measurement ids that are obviously stand-ins.
 *
 * GTM accepts them happily and the tag then reports to nothing, so a placeholder produces a tag
 * that looks created and is dead. A {{variable}} reference is fine: it has no literal id to check.
 *
 * Detecting one is NOT a reason to hand the problem back to the user. Doing that turned a
 * fourteen-second job into three turns: refused, user re-sent the same id, refused again, user
 * invented a different one. A guard that cannot be satisfied is a wall. So detection now leads to
 * either resolving the real id from the container without a round trip, or, when the caller has
 * confirmed the id is deliberate, honouring it.
 */
const PLACEHOLDER_IDS = /^(G-)?(X{3,}|1234567890?|0{6,}|XXXXXXX|ABCDEFG)$/i;

function isPlaceholderMeasurementId(id: string): boolean {
  const v = id.trim();
  if (!v || v.startsWith('{{')) return false;
  if (PLACEHOLDER_IDS.test(v)) return true;
  // G-123456789 and friends: the shape is right but the body is a counting sequence.
  const body = v.replace(/^G-/i, '');
  return /^(0123456789|123456789\d?|1234567890)$/.test(body);
}

/**
 * The measurement id already configured in this container, read off its Google tag.
 *
 * This is the answer to "what should the id have been", and the container knows it, so asking the
 * user costs a round trip to learn something we could have looked up. Returns null when the
 * container has no Google tag to read, which is a real situation in an empty workspace and the one
 * case where the caller genuinely has to be asked.
 */
async function measurementIdFromContainer(client: GtmClient, parent: string): Promise<string | null> {
  try {
    const tags = await paginate(
      (token) => client.accounts.containers.workspaces.tags.list({ parent, pageToken: token }).then((r) => r.data),
      (data) => data.tag,
      {},
    );
    for (const tag of tags.items) {
      // googtag carries it as `tagId`; a gaawe carries the override it was built with.
      const key = tag.type === 'googtag' ? 'tagId' : tag.type === 'gaawe' ? 'measurementIdOverride' : null;
      if (!key) continue;
      const found = (tag.parameter ?? []).find((p) => p.key === key)?.value;
      if (found && /^G-[A-Z0-9]+$/i.test(found) && !isPlaceholderMeasurementId(found)) return found;
    }
    return null;
  } catch {
    // A read failure here must not fail the write path; fall back to asking.
    return null;
  }
}

const triggerSchema = z
  .object({
    name: z.string().describe('Trigger name. An existing trigger with this name is REUSED, not duplicated.'),
    kind: z
      .string()
      .describe(
        'pageview | link_click | all_clicks | form_submit | custom_event | dom_ready | window_loaded | ' +
          'history_change | scroll_depth | element_visibility | youtube_video | js_error | timer. ' +
          'Use link_click for <a> clicks (outbound links, downloads, mailto:, tel:) and all_clicks for any element.',
      ),
    clickUrlValue: z.string().optional().describe('Scope a click trigger by {{Click URL}}, e.g. "mailto:" or "tel:".'),
    clickUrlOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default contains.'),
    clickTextValue: z.string().optional().describe('Scope a click trigger by {{Click Text}}, e.g. an exact CTA label.'),
    clickTextOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default equals.'),
    pagePathValue: z.string().optional().describe('Scope to a page by {{Page Path}}.'),
    pagePathOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex.'),
    eventName: z.string().optional().describe('For kind "custom_event": the dataLayer event name, e.g. "generate_lead".'),
    formIdValue: z.string().optional().describe('For kind "form_submit": scope to one form by {{Form ID}}.'),
    intervalMs: z.string().optional().describe('For kind "timer": firing interval in milliseconds. REQUIRED for timer.'),
    limit: z.string().optional().describe('For kind "timer": how many times it may fire.'),
  })
  .describe('The trigger this tag fires on. Reused by name when it already exists, otherwise created.');

interface CreatedTrigger {
  triggerId: string;
  name: string;
  reused: boolean;
}

/**
 * Finds a trigger by name, so a second tag on the same event does not create a second trigger.
 *
 * Paginated, because "not found" here is acted on by CREATING one. An unpaginated read would miss
 * an existing trigger that happened to fall on the second page and quietly duplicate it, which is
 * the precise failure this reuse check exists to prevent.
 */
async function findOrCreateTrigger(
  client: GtmClient,
  parent: string,
  input: TriggerInput,
): Promise<CreatedTrigger> {
  const existing = await paginate(
    (token) => client.accounts.containers.workspaces.triggers.list({ parent, pageToken: token }).then((r) => r.data),
    (data) => data.trigger,
    {},
  );
  const match = existing.items.find((t) => t.name === input.name);
  if (match?.triggerId) {
    return { triggerId: match.triggerId, name: match.name ?? input.name, reused: true };
  }
  const built = buildTrigger(input);
  const created = await client.accounts.containers.workspaces.triggers.create({
    parent,
    requestBody: built as tagmanager_v2.Schema$Trigger,
  });
  return {
    triggerId: created.data.triggerId ?? '',
    name: created.data.name ?? input.name,
    reused: false,
  };
}

export function registerTypedBuilderTools(server: McpServer, getClient: () => GtmClient): void {
  server.registerTool(
    'create_gtm_tracking_tag',
    {
      description:
        '[WRITE] PREFERRED way to create a GA4 event tag that fires on an event. Builds a CORRECT GTM ' +
        'resource from plain fields, so you never hand-write GTM JSON. ONE call: enables the built-in ' +
        'variables the tag and trigger reference, reuses or creates the named trigger, and creates the ' +
        'tag linked to it in the draft workspace. Use this instead of tags_create + triggers_create + ' +
        'built_in_variables_enable, which needs three round trips and gets the shapes wrong. ' +
        'eventParameters values may reference built-in variables ({{Click URL}}, {{Click Text}}, ' +
        '{{Page URL}}, {{Form ID}}) and those are enabled automatically. ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        tagName: z.string().describe('Name for the tag, e.g. "GA4 Event - Email Click".'),
        measurementId: z
          .string()
          .describe(
            'The GA4 Measurement ID, e.g. "G-ABC123XYZ", or a {{variable}} reference. Read the real id ' +
              'from the container\'s Google tag (type "googtag", parameter "tagId") rather than inventing ' +
              'one: an obvious placeholder is refused, because GTM would accept it and the tag would ' +
              'report to nothing.',
          ),
        eventName: z.string().describe('The GA4 event name, snake_case, e.g. "email_click".'),
        eventParameters: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional()
          .describe(
            'Event parameters as plain name/value pairs, e.g. ' +
              '[{"name":"click_text","value":"{{Click Text}}"}]. They are placed in the eventSettingsTable ' +
              'list-of-maps shape GTM requires; do NOT build that structure yourself.',
          ),
        trigger: triggerSchema,
        builtInVariables: z
          .array(z.string())
          .optional()
          .describe('Extra built-in variable types to enable beyond the ones inferred, e.g. ["formElement"].'),
        allowPlaceholderId: z
          .boolean()
          .optional()
          .describe(
            'Set true ONLY when the user has been told the Measurement ID looks like a placeholder and ' +
              'has confirmed they want it anyway, e.g. a test container. Without it, a placeholder id is ' +
              'first resolved from the container and only refused if the container has none.',
          ),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({
      accountId, containerId, workspaceId,
      tagName, measurementId, eventName, eventParameters, trigger, builtInVariables, allowPlaceholderId, confirm,
    }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);

        const triggerInput = { ...trigger, kind: trigger.kind as TriggerKind } as TriggerInput;
        if (triggerInput.kind === 'timer' && !String(triggerInput.intervalMs ?? '').trim()) {
          return textResult(
            'trigger.kind "timer" requires trigger.intervalMs (the interval in milliseconds, e.g. "30000"). ' +
              'A timer with no interval never fires.',
          );
        }

        // Exactly the built-ins this tag needs: the trigger's own, plus any referenced by a parameter
        // VALUE. A {{Click Text}} that is never enabled resolves to nothing, so the tag ships with a
        // blank parameter and nothing says why.
        const referenced = [
          eventName,
          ...(eventParameters ?? []).map((p) => p.value),
        ];
        const builtIns = Array.from(
          new Set([
            ...triggerBuiltInVars(triggerInput),
            ...builtInVarsForTemplates(referenced),
            ...(builtInVariables ?? []),
          ]),
        );

        if (dryRun) {
          return textResult(
            `[DRY RUN] Would create GA4 event tag "${tagName}" (${eventName}) on trigger ` +
              `"${trigger.name}" (${trigger.kind}) in workspace ${workspaceId}` +
              (builtIns.length ? `, enabling built-in variables: ${builtIns.join(', ')}` : ''),
          );
        }

        const client = getClient();
        const parent = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;

        /**
         * A placeholder id is resolved here, not handed back.
         *
         * Refusing and asking cost three turns for one fourteen-second job, and the third only
         * succeeded because a different made-up id happened not to match the pattern. The container
         * already knows the right answer, so read it. Only an empty container, with no Google tag
         * to read, genuinely has to ask.
         */
        let effectiveMeasurementId = measurementId;
        let measurementIdNote: string | undefined;
        if (isPlaceholderMeasurementId(measurementId) && !allowPlaceholderId) {
          const real = await measurementIdFromContainer(client, parent);
          if (real) {
            effectiveMeasurementId = real;
            measurementIdNote =
              `"${measurementId}" looked like a placeholder, so the Measurement ID configured in this ` +
              `container (${real}) was used instead. Say so in your answer.`;
          } else {
            return textResult(
              `Not creating "${tagName}": "${measurementId}" looks like a placeholder Measurement ID, and ` +
                'this workspace has no Google tag to read the real one from, so there is nothing to fall ' +
                'back to. GTM would accept the id and the tag would report to nothing. Ask the user for ' +
                'their real G- id. If they confirm they DO want this exact id anyway (a test container, ' +
                'for example), call again with allowPlaceholderId: true and it will be created as asked.',
            );
          }
        }

        // Best-effort: a built-in that is already enabled is not an error worth failing the tag over.
        let enabledVariables: string[] = [];
        if (builtIns.length) {
          try {
            await client.accounts.containers.workspaces.built_in_variables.create({
              parent,
              type: builtIns,
            });
            enabledVariables = builtIns;
          } catch {
            enabledVariables = builtIns;
          }
        }

        const trig = await findOrCreateTrigger(client, parent, triggerInput);

        const tag = buildGa4EventTag({
          name: tagName,
          measurementId: effectiveMeasurementId,
          eventName,
          eventParameters,
          firingTriggerId: trig.triggerId ? [trig.triggerId] : undefined,
        });
        const created = await client.accounts.containers.workspaces.tags.create({
          parent,
          requestBody: tag as tagmanager_v2.Schema$Tag,
        });

        return jsonResult({
          tag: { tagId: created.data.tagId, name: created.data.name, type: created.data.type },
          trigger: trig,
          enabledVariables,
          measurementId: effectiveMeasurementId,
          workspace: { accountId, containerId, workspaceId },
          note: 'Created in the DRAFT workspace. Nothing is published.',
          // Present only when the id sent was not the id used. A silent substitution would be
          // worse than the refusal it replaced.
          ...(measurementIdNote ? { measurementIdNote } : {}),
        });
      } catch (err) {
        return errorResult('create_gtm_tracking_tag', err);
      }
    },
  );

  server.registerTool(
    'create_gtm_variable_typed',
    {
      description:
        '[WRITE] Create a GTM variable by KIND rather than by GTM\'s internal type code, so the right ' +
        'shape is guaranteed. kind: ' +
        '"constant" (a fixed reused value, e.g. a Measurement ID); ' +
        '"data_layer" (read a key the SITE pushes to the dataLayer, dot-notation for nested, e.g. ' +
        'ecommerce.value) - only correct when the site actually pushes that key; ' +
        '"javascript" (Custom JavaScript: a function(){...} that COMPUTES a value, and the right choice ' +
        'for deriving something from the page or the click, e.g. extracting the address out of a mailto: ' +
        '{{Click URL}} - a data_layer variable CANNOT do this and would report blank); ' +
        '"event_data" and "request_header" (SERVER containers only). ' +
        'Requires GTM_MCP_ENABLE_WRITES=true and confirm=true.',
      inputSchema: wsBase.extend({
        name: z.string().describe('Variable name as it will be referenced, e.g. "JS - Email Address".'),
        kind: z
          .string()
          .describe('constant | data_layer | javascript | event_data | request_header'),
        value: z.string().optional().describe('For kind "constant": the fixed value.'),
        dataLayerName: z.string().optional().describe('For kind "data_layer": the dataLayer key, e.g. "ecommerce.value".'),
        javascript: z
          .string()
          .optional()
          .describe(
            'For kind "javascript": the full function, e.g. ' +
              '"function() { var u = {{Click URL}} || \'\'; return u.indexOf(\'mailto:\') === 0 ? ' +
              'u.replace(\'mailto:\', \'\').split(\'?\')[0] : undefined; }". Any {{variable}} it reads must be enabled.',
          ),
        keyPath: z.string().optional().describe('For kind "event_data" (server): the event-data key to read.'),
        defaultValue: z.string().optional().describe('For kind "event_data": value when the key is absent.'),
        headerName: z.string().optional().describe('For kind "request_header" (server): the HTTP header to read.'),
        confirm: z.boolean().describe('Must be true to confirm this write operation.'),
      }),
    },
    async ({
      accountId, containerId, workspaceId,
      name, kind, value, dataLayerName, javascript, keyPath, defaultValue, headerName, confirm,
    }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);
        if (dryRun) {
          return textResult(`[DRY RUN] Would create ${kind} variable "${name}" in workspace ${workspaceId}`);
        }

        // buildVariable throws on an off-enum kind rather than falling through, because the old
        // fallthrough produced an EMPTY Custom JavaScript variable: a resolves-to-nothing landmine
        // the user only discovers later in GTM.
        const built = buildVariable({
          name,
          kind: kind as VariableKind,
          value,
          dataLayerName,
          javascript,
          keyPath,
          defaultValue,
          headerName,
        });

        const client = getClient();
        const created = await client.accounts.containers.workspaces.variables.create({
          parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
          requestBody: built as tagmanager_v2.Schema$Variable,
        });
        return jsonResult({
          variable: { variableId: created.data.variableId, name: created.data.name, type: created.data.type },
          reference: `{{${created.data.name ?? name}}}`,
          workspace: { accountId, containerId, workspaceId },
        });
      } catch (err) {
        return errorResult('create_gtm_variable_typed', err);
      }
    },
  );
}
