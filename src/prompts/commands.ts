/**
 * MCP PROMPTS: short, verb-style "slash commands" for the everyday flows — /audit, /report,
 * /create-tag, /debug, /explain. Registered as MCP prompts (prompts/list) so any client renders them
 * as slash commands in its prompts menu. Each prompt hands the assistant an ordered recipe that drives
 * the server's EXISTING tools (audit_container, ga4_run_report, tags_create, triggers_create, the
 * *_list/*_get read tools, …) — it never invents tools. Read-only by default; every write is draft-only
 * and needs confirm=true (and the relevant GTM_MCP_ENABLE_* / GA4_MCP_ENABLE_* env flag).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const one = (text: string): { messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } => ({
  messages: [{ role: 'user', content: { type: 'text', text } }],
});

const target = (account?: string, container?: string): string => {
  if (container?.trim()) return `the container ${container.trim()}${account?.trim() ? ` in account ${account.trim()}` : ''}`;
  if (account?.trim()) return `a container in account ${account.trim()} (list them with containers_list and confirm which one)`;
  return 'the container the user names (if unknown, run accounts_list then containers_list and ask which one)';
};

// ── /audit ────────────────────────────────────────────────────────────────────
function auditRecipe(a: { account?: string; container?: string }): string {
  return [
    `Run a full GTM container audit on ${target(a.account, a.container)}.`,
    '',
    // containers_lookup accepts ONLY destinationId (a linked G-/AW- destination id); the GTM API's
    // separate tagId parameter is not exposed by that tool. This step used to say "if given a public
    // GTM-XXXXXXX id use containers_lookup", which can never resolve the very id the argsSchema
    // invites, so the audit stalled. Resolve a public id by matching publicId in containers_list.
    '1. Resolve the target: accounts_list → containers_list, and when you were given a public GTM-XXXXXXX id pick the container whose publicId matches it (do NOT use containers_lookup for that: it only accepts destinationId, a linked G-/AW- destination id, not a GTM-XXXXXXX container id). audit_container needs ALL THREE ids - accountId, containerId AND workspaceId (it audits ONE workspace, it does NOT auto-pick the latest) - so also run workspaces_list and choose the working workspace (usually "Default Workspace"). Confirm the three ids with the user.',
    '2. Call audit_container with accountId + containerId + workspaceId (pass includeInfo=true for the verbose info-level findings). It is READ-ONLY. Each finding has a severity (error | warning | info) and a category — the categories are exactly: missing_trigger (tag with no firing trigger), paused_tag, broken_reference (references a variable/trigger that no longer exists), ga4_config, duplicate_name, broad_trigger, unused_trigger, missing_builtin_variable, empty_folder.',
    '3. Summarise: a one-line verdict + the counts of error / warning / info, then the findings grouped by category. Lead with the errors — missing_trigger and broken_reference first (they stop tags firing), then ga4_config, then the warnings.',
    '4. For each notable finding give the one-line why + the concrete fix. Do NOT change anything unless the user explicitly asks (writes are gated behind GTM_MCP_ENABLE_WRITES and need confirm=true).',
    '',
    'Note: audit_container does NOT check Consent Mode or security — for a Consent Mode v2 / consent-banner audit use the web-audit MCP or the desktop app\'s Container-audit tab. Nothing is modified by this command.',
  ].join('\n');
}

// ── /report ───────────────────────────────────────────────────────────────────
function reportRecipe(a: { property?: string; dateRange?: string; metrics?: string }): string {
  const range = a.dateRange?.trim() || 'the last 28 days';
  const prop = a.property?.trim() ? `GA4 property ${a.property.trim()}` : 'the GA4 property the user names (if unknown, run ga4_account_summaries_list and ask which property)';
  const mets = a.metrics?.trim() ? a.metrics.trim() : 'sessions, totalUsers, and conversions (keyEvents)';
  return [
    `Run a GA4 report for ${prop} over ${range}.`,
    '',
    `1. Resolve the property: if not given, ga4_account_summaries_list (or ga4_properties_list) → confirm the property id (properties/NNNNNNN) with the user.`,
    `2. Call ga4_run_report (read-only GA4 Data API). Its date args are startDate + endDate (NOT dateRanges) — GA4 relative forms like "28daysAgo"/"7daysAgo"/"today" or absolute "YYYY-MM-DD"; set them to cover ${range}. Pass metrics [${mets}] and a sensible breakdown dimension — default sessionDefaultChannelGroup (traffic by channel). Add "date" as a dimension if the user wants a trend.`,
    '3. If the user cares about conversions, also list the property\'s key events with ga4_key_events_list so the "conversions" number is interpreted against the right events.',
    '4. Summarise: the headline totals, the top channels/rows, and any obvious movement. Round numbers, no fabricated metrics — report only what the API returned. For live numbers use ga4_run_realtime_report instead.',
    '',
    'Read-only: this only reads reporting data, it never changes GA4 config.',
  ].join('\n');
}

// ── /create-tag ─────────────────────────────────────────────────────────────────
function createTagRecipe(a: { description?: string; account?: string; container?: string }): string {
  const what = a.description?.trim() ? `"${a.description.trim()}"` : 'the interaction the user wants to track (ask them: which event / click / form / page)';
  return [
    `Create a GA4 event tag (draft only) for ${what} in ${target(a.account, a.container)}.`,
    '',
    'Follow the standard build methodology, one MCP tool call per resource:',
    '1. Pick the GA4 EVENT NAME that captures the user intent — a raw snake_case recommended/standard event (e.g. generate_lead for a contact/lead form, add_to_cart, sign_up, phone_click, email_click). Confirm it with the user.',
    '2. Decide the TRIGGER kind from what fires it: a link/element click (Click - Just Links / All Elements, filtered by {{Click Text}} or {{Click URL}}), a native <form> submit (Form Submission scoped by {{Form ID}}), a page view, or a custom_event the site pushes to the dataLayer. Enable any built-in variables the trigger reads with built_in_variables_enable.',
    '3. Create the trigger with triggers_create (or reuse an existing one from triggers_list). For a custom_event trigger scope it with a {{dlv - <key>}} Data Layer Variable (create it with variables_create) — the built-in {{Form ID}}/{{Click Text}} do NOT resolve on a manual dataLayer.push.',
    '4. Create the tag with tags_create: type gaawe (GA4 event), the Measurement ID variable, eventName from step 1, and firingTriggerId = ["<the trigger id>"] (an ARRAY). Do NOT try to put GA4 event parameters in tags_create\'s generic `parameter` list — GA4 event params live in the tag\'s nested eventSettingsTable and top-level params are ignored.',
    '5. Add the GA4 event parameters with tags_add_ga4_event_parameters (page_url, form_id, click_text, …) — that is the tool that writes them into eventSettingsTable while keeping eventName/measurementId intact.',
    '6. Verify the tag has a firing trigger and is not paused; report the new ids.',
    '',
    'IMPORTANT: this is a WRITE. It only runs as a DRAFT in the current workspace, never publishes, requires GTM_MCP_ENABLE_WRITES=true and confirm=true on every create. If writes are disabled, produce the exact plan (tag + trigger + variables) instead and tell the user to enable writes.',
  ].join('\n');
}

// ── /debug ───────────────────────────────────────────────────────────────────
function debugRecipe(a: { tag?: string; symptom?: string; account?: string; container?: string }): string {
  const subject = a.tag?.trim() ? `the tag "${a.tag.trim()}"` : 'the tag/trigger the user says is misbehaving (ask which one)';
  const sym = a.symptom?.trim() ? ` Reported symptom: "${a.symptom.trim()}".` : '';
  return [
    `Diagnose why ${subject} is not working in ${target(a.account, a.container)}.${sym} This is a READ-ONLY investigation — change nothing.`,
    '',
    '1. Get the container picture: audit_container (needs accountId + containerId + workspaceId) for the structural issues it detects — missing_trigger (no firing trigger), paused_tag, broken_reference (a missing/renamed variable or trigger), ga4_config. These are the most common root causes. (It does NOT check Consent Mode — that is step 5, a manual check.)',
    '2. Find the tag: tags_list → tags_get for the specific one. Check: is it PAUSED? Does it have a firingTriggerId (a tag with no trigger never fires)? Are there blockingTriggerId exceptions?',
    '3. Inspect its trigger(s): triggers_get for each firing trigger. Do its filters/conditions actually match the real interaction (exact click text, form id, event name — event names must match EXACTLY, never URL-encoded)? A custom_event trigger only fires if the site really pushes that dataLayer event.',
    '4. Check referenced variables exist and resolve: variables_list / variables_get for every {{variable}} the tag or trigger uses (a missing/renamed variable silently breaks it).',
    '5. Consider Consent Mode: a tag gated on ad_storage/analytics_storage will not fire until consent is granted.',
    '',
    'Report the SINGLE most likely cause first, with the evidence you saw, then the concrete fix (and note it is a draft-only write needing confirm=true + GTM_MCP_ENABLE_WRITES). To prove firing end-to-end, point the user at the desktop app\'s Tag verification tab.',
  ].join('\n');
}

// ── /explain ──────────────────────────────────────────────────────────────────
function explainRecipe(a: { topic?: string; account?: string; container?: string }): string {
  const topic = a.topic?.trim();
  if (!topic) {
    return 'Explain a GTM or GA4 concept, or a specific resource, in plain terms. Ask the user what they want explained — a concept (e.g. "custom_event trigger", "Consent Mode v2", "Lookup Table variable", "server-side tagging") or a specific tag/trigger/variable/container in their account. Then follow the guidance below.';
  }
  return [
    `Explain "${topic}" clearly and concretely.`,
    '',
    `If it is a CONCEPT (a trigger type, variable type, Consent Mode, sGTM, a GA4 idea): explain what it is, when/why you use it, and a short concrete GTM/GA4 example. Keep it plain — no jargon dumps.`,
    `If it names a SPECIFIC resource in the user's container (a tag / trigger / variable / container in ${target(a.account, a.container)}): fetch it read-only — tags_get / triggers_get / variables_get / containers_get (resolve ids via the matching *_list first) — then explain what it does, exactly when it fires (its trigger + conditions), what data it sends, and anything notable or risky about its config.`,
    '',
    'Read-only: never modify anything. End with one practical takeaway or next step.',
  ].join('\n');
}

export function registerCommandPrompts(server: McpServer): void {
  server.registerPrompt(
    'audit',
    {
      title: 'Audit a GTM container',
      description: 'Run a read-only GTM container audit and summarise the findings by severity (error/warning/info) + category (missing_trigger, paused_tag, broken_reference, ga4_config, duplicate_name, broad_trigger, unused_trigger, missing_builtin_variable, empty_folder). Optional args: account, container (a GTM-XXXXXXX id or name).',
      argsSchema: {
        account: z.string().optional().describe('GTM account id (optional — the assistant will list accounts if omitted).'),
        container: z.string().optional().describe('Container to audit: a public GTM-XXXXXXX id or its name (optional).'),
      },
    },
    (args) => one(auditRecipe(args)),
  );

  server.registerPrompt(
    'report',
    {
      title: 'Run a GA4 report',
      description: 'Run a read-only GA4 report (sessions / users / conversions by channel, default last 28 days) and summarise it. Optional args: property (properties/NNNNNNN), dateRange, metrics (comma-separated).',
      argsSchema: {
        property: z.string().optional().describe('GA4 property id (properties/NNNNNNN) — optional; the assistant will list properties if omitted.'),
        dateRange: z.string().optional().describe('Date range, e.g. "last 28 days", "2026-01-01..2026-01-31" (optional).'),
        metrics: z.string().optional().describe('Comma-separated GA4 metrics, e.g. "sessions,totalUsers,conversions" (optional).'),
      },
    },
    (args) => one(reportRecipe(args)),
  );

  server.registerPrompt(
    'create-tag',
    {
      title: 'Create a GA4 event tag',
      description: 'Guide the end-to-end creation of a GA4 event tag (event name → trigger → variables → tag), DRAFT-ONLY and gated behind GTM_MCP_ENABLE_WRITES + confirm=true. Optional args: description (what to track), account, container.',
      argsSchema: {
        description: z.string().optional().describe('What to track, e.g. "contact form submit", "add to cart button", "phone number click" (optional).'),
        account: z.string().optional().describe('GTM account id (optional).'),
        container: z.string().optional().describe('Container to create the tag in (optional).'),
      },
    },
    (args) => one(createTagRecipe(args)),
  );

  server.registerPrompt(
    'debug',
    {
      title: 'Debug a tag that is not firing',
      description: 'A read-only diagnostic flow to find why a tag is not firing: audit → tag config (paused? trigger?) → trigger conditions → referenced variables → Consent Mode, then the single most likely cause + fix. Optional args: tag, symptom, account, container.',
      argsSchema: {
        tag: z.string().optional().describe('The tag (or trigger) that is misbehaving (optional).'),
        symptom: z.string().optional().describe('What is wrong, e.g. "never fires", "fires twice", "no GA4 hit" (optional).'),
        account: z.string().optional().describe('GTM account id (optional).'),
        container: z.string().optional().describe('Container to debug (optional).'),
      },
    },
    (args) => one(debugRecipe(args)),
  );

  server.registerPrompt(
    'explain',
    {
      title: 'Explain a GTM/GA4 concept or resource',
      description: 'Explain a GTM/GA4 concept in plain terms, OR fetch a specific tag/trigger/variable/container (read-only) and explain what it does and when it fires. Optional args: topic, account, container.',
      argsSchema: {
        topic: z.string().optional().describe('A concept (e.g. "Consent Mode v2", "custom_event trigger") or a specific resource name/id (optional).'),
        account: z.string().optional().describe('GTM account id, when explaining a specific resource (optional).'),
        container: z.string().optional().describe('Container, when explaining a specific resource (optional).'),
      },
    },
    (args) => one(explainRecipe(args)),
  );
}
