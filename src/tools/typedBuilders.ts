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
import { checkGuardrails, getGuardrailConfig, formatGoogleError } from '../utils/guardrails.js';
import { jsonResult, textResult, errorResult, errorText } from '../utils/toolResponse.js';
import { paginate } from '../utils/pagination.js';
import {
  buildGa4EventTag,
  buildGoogleTag,
  buildTrigger,
  buildVariable,
  triggerBuiltInVars,
  builtInVarsForTemplates,
  sanitizeName,
  tpl,
  boolean,
  type GtmTagResource,
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
 *
 * A {{Variable}} tagId counts as an answer. This file recommends exactly that setup (one Constant
 * holding the Measurement ID, every GA4 tag pointing at it), and a variable reference is valid as
 * the GA4 tag's measurementIdOverride. The old resolver accepted only a literal G- id, so the very
 * container it told people to build resolved to null and got refused with "no Google tag to read
 * the real one from" while a perfectly usable reference sat in it. A literal still wins when the
 * container has one.
 */
async function measurementIdFromContainer(client: GtmClient, parent: string): Promise<string | null> {
  try {
    const tags = await paginate(
      (token) => client.accounts.containers.workspaces.tags.list({ parent, pageToken: token }).then((r) => r.data),
      (data) => data.tag,
      {},
    );
    let variableHeld: string | null = null;
    for (const tag of tags.items) {
      // googtag carries it as `tagId`; a gaawe carries the override it was built with.
      const key = tag.type === 'googtag' ? 'tagId' : tag.type === 'gaawe' ? 'measurementIdOverride' : null;
      if (!key) continue;
      const found = (tag.parameter ?? []).find((p) => p.key === key)?.value?.trim();
      if (!found) continue;
      if (/^\{\{.+\}\}$/.test(found)) {
        if (!variableHeld) variableHeld = found;
        continue;
      }
      if (/^G-[A-Z0-9]+$/i.test(found) && !isPlaceholderMeasurementId(found)) return found;
    }
    return variableHeld;
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
    clickUrlIgnoreCase: z.boolean().optional().describe('For a matchRegex {{Click URL}} condition: match case-insensitively.'),
    clickTextValue: z.string().optional().describe('Scope a click trigger by {{Click Text}}, e.g. an exact CTA label.'),
    clickTextOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default equals.'),
    clickTextIgnoreCase: z.boolean().optional().describe('For a matchRegex {{Click Text}} condition: match case-insensitively.'),
    // The conditions below are what scope a click trigger to ONE element. Without them a
    // link_click/all_clicks trigger fires on every link or every click on the site, so a schema that
    // omits them does not merely lose precision, it changes what the tag does.
    //
    // They were missing here while buildTrigger and triggerBuiltInVars supported all of them, and
    // zod strips what it does not declare. Anything sending these - the tag scanner does, for every
    // CTA it pins to a selector or an id - had them silently dropped and got the unscoped trigger.
    // Same failure as the missing `platform` field: the call reports success and the tag is wrong.
    clickElementValue: z.string().optional().describe('Scope a click trigger by {{Click Element}}, normally a CSS selector.'),
    clickElementOperator: z.string().optional().describe('cssSelector | equals | contains | matchRegex. Default cssSelector.'),
    clickIdValue: z.string().optional().describe('Scope a click trigger by {{Click ID}}, the element\'s id attribute.'),
    clickIdOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default equals.'),
    clickClassesValue: z.string().optional().describe('Scope a click trigger by {{Click Classes}}.'),
    clickClassesOperator: z.string().optional().describe('equals | contains | matchRegex. Default contains.'),
    pagePathValue: z.string().optional().describe('Scope to a page by {{Page Path}}.'),
    pagePathOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex.'),
    pageUrlValue: z.string().optional().describe('Scope by {{Page URL}}, e.g. a "?thanks=1" success page.'),
    pageUrlOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default contains.'),
    eventName: z.string().optional().describe('For kind "custom_event": the dataLayer event name, e.g. "generate_lead".'),
    formIdValue: z.string().optional().describe('For kind "form_submit": scope to one form by {{Form ID}}.'),
    formIdOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default equals.'),
    formClassesValue: z.string().optional().describe('For kind "form_submit": scope by {{Form Classes}}.'),
    formClassesOperator: z.string().optional().describe('equals | contains | matchRegex. Default contains.'),
    intervalMs: z.string().optional().describe('For kind "timer": firing interval in milliseconds. REQUIRED for timer.'),
    limit: z.string().optional().describe('For kind "timer": how many times it may fire.'),
    // element_visibility and scroll_depth were advertised in the `kind` list while NONE of their
    // settings were declared here, and zod strips what it does not declare. An element_visibility
    // call arrived with its selector removed, so buildTrigger emitted elementSelector "" and the
    // trigger watched nothing: created, reported as success, and dead. Same class of failure as the
    // missing click fields above.
    visibilitySelector: z
      .string()
      .optional()
      .describe('For kind "element_visibility": CSS selector of the element to watch, e.g. "#gform_confirmation_message". REQUIRED unless visibilityElementId is given.'),
    visibilityElementId: z
      .string()
      .optional()
      .describe('For kind "element_visibility": the element\'s id attribute, as an alternative to visibilitySelector.'),
    visibilityMinPercent: z.string().optional().describe('For kind "element_visibility": minimum percent of the element on screen before it fires. Default 50.'),
    visibilityFiringFrequency: z.string().optional().describe('For kind "element_visibility": ONCE | ONCE_PER_ELEMENT | MANY_PER_ELEMENT. Default ONCE.'),
    visibilityObserveDomChanges: z
      .boolean()
      .optional()
      .describe('For kind "element_visibility": keep watching for elements added AFTER page load (an AJAX confirmation message). Default true.'),
    visibilityMinOnScreenMs: z.string().optional().describe('For kind "element_visibility": require the element to stay on screen for N milliseconds first.'),
    scrollPercentages: z.string().optional().describe('For kind "scroll_depth": vertical percent thresholds, e.g. "25, 50, 75, 90". This is the default.'),
    scrollPixels: z.string().optional().describe('For kind "scroll_depth": vertical PIXEL thresholds instead of percentages.'),
    scrollHorizontalPercentages: z.string().optional().describe('For kind "scroll_depth": horizontal percent thresholds. Off unless supplied.'),
    pageHostnameValue: z.string().optional().describe('Scope by {{Page Hostname}}. ANDed into the filter of any filter-capable kind.'),
    pageHostnameOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default equals.'),
    referrerValue: z.string().optional().describe('Scope by {{Referrer}}. ANDed into the filter of any filter-capable kind.'),
    referrerOperator: z.string().optional().describe('equals | contains | startsWith | endsWith | matchRegex. Default contains.'),
  })
  .describe('The trigger this tag fires on. Reused by name when it already exists, otherwise created.');

/**
 * The kinds buildTrigger can actually build.
 *
 * `kind` is a free-form string on the wire (an enum in the JSON schema would refuse the whole call
 * with a schema error instead of a sentence the model can act on), so it has to be checked here.
 * buildTrigger's default branch returns an unscoped All Pages pageview trigger, which means an
 * off-enum kind like "click" or "form" used to produce a tag firing on EVERY page load while the
 * tool reported success and echoed the kind it was asked for.
 */
const TRIGGER_KINDS: readonly TriggerKind[] = [
  'pageview', 'link_click', 'all_clicks', 'form_submit', 'custom_event', 'dom_ready', 'window_loaded',
  'history_change', 'scroll_depth', 'element_visibility', 'youtube_video', 'js_error', 'timer',
];

function isTriggerKind(value: string): value is TriggerKind {
  return (TRIGGER_KINDS as readonly string[]).includes(value);
}

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
  // Match on the SANITIZED name, because that is the name buildTrigger stores. Matching on the raw
  // input name meant "Click: Apply Now" was created as "Click Apply Now" (sanitizeName strips ':')
  // and never found again, so the second tag on that trigger tried to create it a second time and
  // GTM rejected the whole call with a duplicate-name 400 the caller could not explain.
  const wanted = sanitizeName(input.name).toLowerCase();
  const match = existing.items.find((t) => (t.name ?? '').toLowerCase() === wanted);
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
        platform: z
          .string()
          .optional()
          .describe(
            'What KIND of tag to build. "ga4_event" (the default) builds a GA4 event tag from ' +
              'measurementId + eventName. "google_tag" builds the BASE Google tag (googtag) from ' +
              '`tagId`, the one that loads gtag.js and configures GA4 - a container needs exactly one, ' +
              'firing on All Pages. "custom_html" builds a Custom HTML tag from `html`, which is ' +
              'how a dataLayer LISTENER is installed for forms GTM cannot see natively (an AJAX or ' +
              'cross-origin embed). Any OTHER value is REFUSED rather than quietly built as GA4: a Meta ' +
              'or Ads tag asked for here would otherwise come out as a GA4 tag pointing at that ' +
              "platform's id, which looks created and is wrong.",
          ),
        html: z
          .string()
          .optional()
          .describe('For platform "custom_html": the complete tag body, a single self-contained <script>.'),
        tagId: z
          .string()
          .optional()
          .describe(
            'For platform "google_tag": the id this base tag configures, e.g. "G-ABC123XYZ", or a ' +
              '{{Variable}} holding it. Referencing a Constant is the recommended setup: one variable ' +
              'holds the Measurement ID and every GA4 tag points at it, so changing containers or ' +
              'properties is one edit rather than one per tag.',
          ),
        configSettings: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional()
          .describe('For platform "google_tag": config settings, e.g. [{"name":"send_page_view","value":"false"}].'),
        measurementId: z
          .string()
          .optional()
          .describe(
            'The GA4 Measurement ID, e.g. "G-ABC123XYZ", or a {{variable}} reference. Read the real id ' +
              'from the container\'s Google tag (type "googtag", parameter "tagId") rather than inventing ' +
              'one: an obvious placeholder is refused, because GTM would accept it and the tag would ' +
              'report to nothing.',
          ),
        eventName: z
          .string()
          .optional()
          .describe('The GA4 event name, snake_case, e.g. "email_click". Required for platform "ga4_event".'),
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
      tagName, platform, html, tagId, configSettings, measurementId, eventName, eventParameters, trigger, builtInVariables, allowPlaceholderId, confirm,
    }) => {
      try {
        const config = getGuardrailConfig();
        const { dryRun } = checkGuardrails('write', confirm, config);

        /**
         * Refuse a platform this tool cannot build, rather than building the wrong thing.
         *
         * The schema used to have no platform field at all, and callers were passing one: the
         * suggestion engine emits meta_pixel, google_ads_conversion and the rest. Zod strips unknown
         * keys, so those arrived here as a GA4 event tag whose measurementId was a Meta pixel id.
         * That is created, correct-looking, and wrong. The desktop app builds those; this tool does
         * not, and now says so.
         */
        const kindOfTag = (platform ?? 'ga4_event').trim() || 'ga4_event';
        if (kindOfTag !== 'ga4_event' && kindOfTag !== 'custom_html' && kindOfTag !== 'google_tag') {
          return textResult(
            `Not creating "${tagName}": this tool builds "ga4_event", "google_tag" and "custom_html" tags, not ` +
              `"${kindOfTag}". Building it as GA4 anyway would produce a tag pointing at another ` +
              "platform's id, which looks created and reports nowhere.",
          );
        }
        if (kindOfTag === 'custom_html' && !String(html ?? '').trim()) {
          return textResult(`Not creating "${tagName}": platform "custom_html" needs \`html\`, the tag body.`);
        }
        if (kindOfTag === 'ga4_event' && (!String(measurementId ?? '').trim() || !String(eventName ?? '').trim())) {
          return textResult(
            `Not creating "${tagName}": a GA4 event tag needs both measurementId and eventName.`,
          );
        }
        if (kindOfTag === 'google_tag' && !String(tagId ?? '').trim()) {
          return textResult(
            `Not creating "${tagName}": platform "google_tag" needs \`tagId\` - the G-/AW-/GT- id it ` +
              'configures, or a {{Variable}} holding one.',
          );
        }

        /**
         * Refuse a trigger kind this tool cannot build, rather than building the wrong thing.
         *
         * `kind` used to be cast straight to TriggerKind with no check, and buildTrigger's default
         * branch answers an unknown kind with an unscoped All Pages pageview trigger. So a caller
         * sending the real GTM type name ("click") or a paraphrase ("form", "page_view") got a
         * trigger of type pageview with NO filter, the tag bound to it, and a success response
         * echoing the kind it asked for: once published, the event fires on every page load. The
         * variable tool below refuses an off-enum kind for exactly this reason.
         */
        const requestedKind = String(trigger.kind ?? '').trim();
        if (!isTriggerKind(requestedKind)) {
          return textResult(
            `Not creating "${tagName}": trigger.kind "${trigger.kind}" is not one this tool builds. Use one of: ` +
              `${TRIGGER_KINDS.join(', ')}. Building it anyway would create an unscoped All Pages trigger, so the ` +
              'tag would fire on every page load instead of on the event you asked for.',
          );
        }
        const triggerInput = { ...trigger, kind: requestedKind } as TriggerInput;
        if (triggerInput.kind === 'timer' && !String(triggerInput.intervalMs ?? '').trim()) {
          return textResult(
            'trigger.kind "timer" requires trigger.intervalMs (the interval in milliseconds, e.g. "30000"). ' +
              'A timer with no interval never fires.',
          );
        }
        // Same reasoning as the timer guard: with neither target set buildTrigger emits an empty
        // elementSelector and the trigger is created watching nothing.
        if (
          triggerInput.kind === 'element_visibility' &&
          !String(triggerInput.visibilitySelector ?? '').trim() &&
          !String(triggerInput.visibilityElementId ?? '').trim()
        ) {
          return textResult(
            'trigger.kind "element_visibility" requires trigger.visibilitySelector (a CSS selector) or ' +
              'trigger.visibilityElementId. With neither, the trigger is created watching no element and never fires.',
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
            `[DRY RUN] Would create ${kindOfTag === 'custom_html' ? 'Custom HTML' : kindOfTag === 'google_tag' ? 'Google' : 'GA4 event'} tag ` +
              `"${tagName}" (${kindOfTag === 'google_tag' ? String(tagId) : (eventName ?? 'no event')}) on trigger ` +
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
        let effectiveMeasurementId = measurementId ?? '';
        let measurementIdNote: string | undefined;
        if (kindOfTag === 'ga4_event' && isPlaceholderMeasurementId(effectiveMeasurementId) && !allowPlaceholderId) {
          const real = await measurementIdFromContainer(client, parent);
          if (real) {
            effectiveMeasurementId = real;
            measurementIdNote =
              `"${measurementId}" looked like a placeholder, so the Measurement ID configured in this ` +
              `container (${real}) was used instead. Say so in your answer.`;
          } else {
            return textResult(
              `Not creating "${tagName}": "${measurementId}" looks like a placeholder Measurement ID, and ` +
                'no usable one could be read from this workspace\'s Google or GA4 tags either, so there is ' +
                'nothing to fall back to. GTM would accept the id and the tag would report to nothing. Ask the user for ' +
                'their real G- id. If they confirm they DO want this exact id anyway (a test container, ' +
                'for example), call again with allowPlaceholderId: true and it will be created as asked.',
            );
          }
        }

        // Best-effort: a built-in that is already enabled is not an error worth failing the tag over.
        let enabledVariables: string[] = [];
        let builtInVariablesWarning: string | undefined;
        if (builtIns.length) {
          try {
            await client.accounts.containers.workspaces.built_in_variables.create({
              parent,
              type: builtIns,
            });
            enabledVariables = builtIns;
          } catch (err) {
            // Every type goes in ONE request, so a rejection means NONE were enabled. Reporting
            // them as enabled anyway (what this catch used to do) told the caller {{Click URL}}
            // resolved when the trigger condition in fact reads undefined and never fires, and a
            // single bad extra type in builtInVariables sank the inferred ones silently.
            enabledVariables = [];
            builtInVariablesWarning =
              `Built-in variables were NOT enabled (${builtIns.join(', ')}): ${formatGoogleError(err)}. ` +
              'Any {{...}} the trigger or tag references stays unresolved until they are enabled, so check ' +
              'the type names and enable them with built_in_variables_enable.';
          }
        }

        const trig = await findOrCreateTrigger(client, parent, triggerInput);

        const firingTriggerId = trig.triggerId ? [trig.triggerId] : undefined;
        const tag =
          kindOfTag === 'custom_html'
            ? ({
                name: sanitizeName(tagName),
                type: 'html',
                parameter: [
                  tpl('html', String(html)),
                  // GTM defaults this on, and document.write in a listener breaks pages loaded
                  // asynchronously. A listener never needs it.
                  boolean('supportDocumentWrite', false),
                ],
                ...(firingTriggerId ? { firingTriggerId } : {}),
              } as GtmTagResource)
            : kindOfTag === 'google_tag'
              ? buildGoogleTag({
                  name: tagName,
                  tagId: String(tagId),
                  ...(configSettings?.length ? { configSettings } : {}),
                  ...(firingTriggerId ? { firingTriggerId } : {}),
                })
              : buildGa4EventTag({
                  name: tagName,
                  measurementId: effectiveMeasurementId,
                  eventName: String(eventName),
                  eventParameters,
                  firingTriggerId,
                });
        let created;
        try {
          created = await client.accounts.containers.workspaces.tags.create({
            parent,
            requestBody: tag as tagmanager_v2.Schema$Tag,
          });
        } catch (err) {
          // The trigger write already happened. The bare error used to mention only the tag, so a
          // model retrying under a different trigger name left a second orphan behind in the
          // workspace. Say what exists now.
          const leftBehind = trig.reused
            ? `The trigger "${trig.name}" (id ${trig.triggerId}) already existed and was reused, so nothing was left behind.`
            : `A trigger "${trig.name}" (id ${trig.triggerId}) WAS created by this call and is still in workspace ` +
              `${workspaceId}. Retry with the SAME trigger.name so it is reused, or remove it with triggers_delete; ` +
              'a different name creates a second one.';
          return errorText(`create_gtm_tracking_tag failed: ${formatGoogleError(err)}\n\n${leftBehind}`);
        }

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
          // Present only when the built-in enable call was rejected, so "enabledVariables: []" is
          // never left looking like nothing needed enabling.
          ...(builtInVariablesWarning ? { builtInVariablesWarning } : {}),
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

        /**
         * The same landmine one level down from the off-enum guard below: an IN-enum kind whose own
         * required field is missing still built a variable, with an empty parameter. GTM accepts it,
         * the tool hands back {{name}} as if it were usable, and every tag bound to it reports blank
         * until someone opens GTM and looks. Refuse before the write instead.
         */
        const missingField =
          kind === 'javascript' && !String(javascript ?? '').trim()
            ? { field: 'javascript', what: 'the full function body, e.g. "function() { ... }"' }
            : kind === 'data_layer' && !String(dataLayerName ?? '').trim()
              ? { field: 'dataLayerName', what: 'the dataLayer key to read, e.g. "ecommerce.value"' }
              : kind === 'event_data' && !String(keyPath ?? '').trim()
                ? { field: 'keyPath', what: 'the event-data key to read' }
                : kind === 'request_header' && !String(headerName ?? '').trim()
                  ? { field: 'headerName', what: 'the HTTP header to read' }
                  : null;
        if (missingField) {
          return textResult(
            `Not creating variable "${name}": kind "${kind}" needs \`${missingField.field}\`, ${missingField.what}. ` +
              'Without it the variable is created empty and every tag bound to it reports blank.',
          );
        }

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
