/**
 * MCP PROMPT: one guided flow to create a server-side (sGTM) container.
 *
 * Registered as an MCP prompt (prompts/list) so it shows in the client's "prompts" tab. Unlike the
 * desktop chat brain's system prompt, an MCP prompt is a user-selectable template the client injects.
 * The MCP server exposes only GENERIC create tools (containers_create, clients_create, variables_create,
 * triggers_create, tags_create, built_in_variables_enable) — no typed server builders — so this prompt
 * hands the assistant the ordered recipe PLUS the exact resource shapes (types + parameter arrays).
 * Shapes corpus-validated against real server containers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const argsSchema = {
  accountId: z.string().optional().describe('GTM account ID to create the server container in (ask the user if omitted).'),
  containerName: z.string().optional().describe('Name for the new SERVER container, e.g. "example.com - Server".'),
  measurementId: z.string().optional().describe('GA4 Measurement ID (G-XXXXXXX) the server relays to. Omit to derive it from the web container or ask.'),
  adsConversionId: z.string().optional().describe('Google Ads conversion ID (AW-XXXXXXXX) — only if you also want a server Ads conversion tag.'),
};

function buildRecipe(a: { accountId?: string; containerName?: string; measurementId?: string; adsConversionId?: string }): string {
  const acct = a.accountId?.trim() ? `account ${a.accountId.trim()}` : 'the account the user names (ask if unknown)';
  const cname = a.containerName?.trim() ? `"${a.containerName.trim()}"` : 'the name the user gives (e.g. "<site> - Server")';
  const mid = a.measurementId?.trim() ? a.measurementId.trim() : 'G-XXXXXXX (ask the user, or derive it from their web container\'s GA4 tag)';
  const adsBlock = a.adsConversionId?.trim()
    ? `\n   - GOOGLE ADS CONVERSION — type "sgtmadsct", firing on a per-event conversion trigger (e.g. purchase): parameter [ {"type":"template","key":"conversionId","value":"${a.adsConversionId.trim()}"}, {"type":"template","key":"conversionLabel","value":"<AW conversion label>"}, {"type":"boolean","key":"enableConversionLinker","value":"true"} ].\n   - CONVERSION LINKER — type "sgtmadscl", parameter [], firing on the all-events (GA4-client) trigger.`
    : '';

  return [
    'Set up a server-side (sGTM) GTM container end to end. Work through these steps IN ORDER, one MCP tool call per create, and report the new id after each create so the next step can reference it. Every write needs confirm=true (and GTM_MCP_ENABLE_WRITES=true on the server).',
    '',
    `Target: ${acct}. New container name: ${cname}. GA4 Measurement ID to relay: ${mid}.`,
    '',
    '1. CREATE THE SERVER CONTAINER — containers_create in the account with usageContext ["server"] and the name above. Save the new containerId + its default workspaceId. (The tagging-server HOST — Cloud Run / App Engine / Stape — is provisioned by the USER outside GTM; its URL goes on the container later as taggingServerUrls. The API does NOT deploy the host.)',
    '',
    '2. ENABLE BUILT-INS — built_in_variables_enable in the new workspace for the server essentials: Client Name and Event Name (types: clientName, eventName).',
    '',
    '3. CREATE THE GA4 CLIENT — clients_create, which claims incoming GA4/gtag requests:',
    '   { "name":"GA4", "type":"gaaw_client", "parameter":[ {"type":"boolean","key":"activateDefaultPaths","value":"true"}, {"type":"boolean","key":"activateGtagSupport","value":"true"} ] }',
    '',
    '4. CREATE VARIABLES (variables_create) the tags read:',
    '   - Event Data (the server data layer) — type "ed", reads one keyPath off the incoming event:',
    '     { "name":"ed - transaction_id", "type":"ed", "parameter":[ {"type":"template","key":"keyPath","value":"transaction_id"}, {"type":"boolean","key":"setDefaultValue","value":"false"} ] }  (repeat for value, currency, items, x-ga-mp2-user_properties.email, …)',
    '   - Constant — type "c" (fixed ids/tokens): { "name":"const - ads conversion id", "type":"c", "parameter":[ {"type":"template","key":"value","value":"AW-XXXXXXXX"} ] }',
    '   - Request Header — type "rh" (geo/device the tagging host injects): { "name":"X-Geo-Country", "type":"rh", "parameter":[ {"type":"template","key":"headerName","value":"X-Geo-Country"} ] }',
    '',
    '5. CREATE TRIGGERS (triggers_create), type "customEvent". A PER-EVENT trigger (the dominant pattern) fires on ONE event, scoped to the GA4 client:',
    '   { "name":"ga4 - purchase", "type":"customEvent", "customEventFilter":[ {"type":"equals","parameter":[ {"type":"template","key":"arg0","value":"{{_event}}"}, {"type":"template","key":"arg1","value":"purchase"} ]} ], "filter":[ {"type":"equals","parameter":[ {"type":"template","key":"arg0","value":"{{Client Name}}"}, {"type":"template","key":"arg1","value":"GA4"} ]} ] }',
    '   For a BASE/relay trigger (fires on ALL events for the GA4 client), replace the customEventFilter with {"type":"matchRegex","parameter":[ {"type":"template","key":"arg0","value":"{{_event}}"}, {"type":"template","key":"arg1","value":".*"} ]} and keep the Client Name filter.',
    '',
    '6. CREATE TAGS (tags_create) — each with firingTriggerId = the id of the trigger it fires on:',
    '   - GA4 BASE (relays every event) — type "sgtmgaaw", NO eventName so it inherits each incoming event_name; fire on the all-events trigger:',
    '     name "GA4 - Server", parameter [ {"type":"template","key":"measurementId","value":"' + mid + '"}, {"type":"template","key":"epToIncludeDropdown","value":"all"}, {"type":"template","key":"upToIncludeDropdown","value":"all"} ].',
    '   - GA4 PER-EVENT — the base parameters PLUS {"type":"template","key":"eventName","value":"purchase"}; fire on the ga4 - purchase trigger.' + adsBlock,
    '',
    '7. WIRE THE HOST (after the user deploys the tagging server) — set the server URL on the SERVER container (taggingServerUrls), then point the web container at it (the web Google tag\'s server_container_url = the https server URL). Confirm the host answers before relying on it.',
    '',
    'THIRD-PARTY CAPI (Meta / TikTok / etc.) tags are gallery templates (type cvt_…) the user imports in the GTM UI — create their Event Data variables here, then map them into the imported tag.',
    '',
    'Before finishing, verify the client claims requests and every server tag has a firing trigger (not paused). Read-only by default: nothing is written unless writes are enabled and you pass confirm=true.',
  ].join('\n');
}

export function registerServerSidePrompts(server: McpServer): void {
  server.registerPrompt(
    'setup_server_side_container',
    {
      title: 'Set up a server-side GTM container',
      description:
        'One guided flow to create a server-side (sGTM) container: the SERVER container + GA4 client + built-ins + Event-Data/Constant/Request-Header variables + per-event triggers + GA4 (and optional Google Ads) server tags, in the correct order with the exact resource shapes. Optional args: accountId, containerName, measurementId, adsConversionId.',
      argsSchema,
    },
    (args) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: buildRecipe(args) },
        },
      ],
    })
  );
}
