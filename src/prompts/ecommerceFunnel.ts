/**
 * MCP PROMPT: one guided flow to install the full GA4 ecommerce funnel in a WEB container —
 * plus Consent Mode v2 defaults — and verify the result. The MCP server exposes only GENERIC
 * create tools, so (like setup_server_side_container) this prompt hands the assistant the
 * ordered recipe with the exact resource shapes. Shapes corpus-validated against 562 real
 * GTM exports: GA4 event tags forward ecommerce natively via sendEcommerceData=true +
 * getEcommerceDataFrom=dataLayer (10/10 sampled ecommerce tags), and consent-default tags
 * fire on the built-in Consent Initialization trigger id 2147479572 (2/2).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const FUNNEL_EVENTS = ['view_item', 'add_to_cart', 'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'] as const;

const argsSchema = {
  accountId: z.string().optional().describe('GTM account ID (ask the user if omitted).'),
  containerId: z.string().optional().describe('The WEB container ID to install the funnel in.'),
  measurementId: z.string().optional().describe('GA4 Measurement ID (G-XXXXXXX). Omit to derive it from the container\'s Google tag or ask.'),
  events: z.string().optional().describe(`Comma-separated funnel events. Omit for the standard funnel: ${FUNNEL_EVENTS.join(', ')}.`),
};

function buildRecipe(a: { accountId?: string; containerId?: string; measurementId?: string; events?: string }): string {
  const scope =
    a.accountId?.trim() && a.containerId?.trim()
      ? `account ${a.accountId.trim()}, WEB container ${a.containerId.trim()}`
      : 'the account + WEB container the user names (ask if unknown)';
  const mid = a.measurementId?.trim() ? a.measurementId.trim() : "G-XXXXXXX (derive it from the container's Google tag via tags_list, or ask)";
  const events = a.events?.trim()
    ? a.events.split(',').map((e) => e.trim()).filter(Boolean)
    : [...FUNNEL_EVENTS];

  return [
    'Install the FULL GA4 ecommerce funnel + Consent Mode v2 defaults in a WEB GTM container, then verify it. Work IN ORDER, one MCP tool call per create; report each new id. Every write needs confirm=true (and GTM_MCP_ENABLE_WRITES=true on the server). All creates are in a draft workspace — nothing is published.',
    '',
    `Target: ${scope}. GA4 Measurement ID: ${mid}. Funnel events (in order): ${events.join(' → ')}.`,
    '',
    '1. INVENTORY FIRST — tags_list / triggers_list / variables_list on the workspace. SKIP any piece that already exists by name (re-running this recipe must complete a partial install, never duplicate). Confirm a Google tag (type "googtag") exists — if not, create it first (type "googtag", parameter [ {"type":"template","key":"tagId","value":"' + (a.measurementId?.trim() || 'G-XXXXXXX') + '"} ], firing on the built-in All Pages trigger id "2147479553").',
    '',
    '2. ECOMMERCE VARIABLES (variables_create) — the dataLayer reads downstream Ads/Meta tags use. One per key: ecommerce.value, ecommerce.currency, ecommerce.items, ecommerce.transaction_id, ecommerce.coupon:',
    '   { "name":"dlv - ecommerce.value", "type":"v", "parameter":[ {"type":"template","key":"name","value":"ecommerce.value"}, {"type":"integer","key":"dataLayerVersion","value":"2"} ] }',
    '',
    '3. PER-EVENT TRIGGERS (triggers_create) — one Custom Event trigger per funnel event:',
    '   { "name":"CE - purchase", "type":"customEvent", "customEventFilter":[ {"type":"equals","parameter":[ {"type":"template","key":"arg0","value":"{{_event}}"}, {"type":"template","key":"arg1","value":"purchase"} ]} ] }',
    '',
    '4. PER-EVENT GA4 TAGS (tags_create) — type "gaawe", firing on that event\'s trigger (firingTriggerId is an ARRAY: ["<triggerId>"]). Forward the WHOLE dataLayer ecommerce object NATIVELY — do NOT hand-map items/value/currency as event parameters:',
    '   name "GA4 - Event - Purchase Tag", parameter [ {"type":"tagReference","key":"measurementId","value":""}, {"type":"template","key":"measurementIdOverride","value":"' + mid + '"}, {"type":"template","key":"eventName","value":"purchase"}, {"type":"boolean","key":"sendEcommerceData","value":"true"}, {"type":"template","key":"getEcommerceDataFrom","value":"dataLayer"} ]',
    '',
    '5. CONSENT MODE v2 DEFAULTS (tags_create) — a Custom HTML tag firing on the BUILT-IN "Consent Initialization - All Pages" trigger (id "2147479572" — do NOT create a trigger for this), so defaults are set before ANY tag runs. Denied-by-default (GDPR-safe); the user\'s CMP later upgrades via gtag(\'consent\',\'update\',…):',
    '   name "Consent Mode - Defaults", type "html", firingTriggerId ["2147479572"], parameter [ {"type":"template","key":"html","value":"<script>\\nwindow.dataLayer = window.dataLayer || [];\\nfunction gtag(){dataLayer.push(arguments);}\\ngtag(\'consent\', \'default\', {\\n  ad_storage: \'denied\',\\n  analytics_storage: \'denied\',\\n  ad_user_data: \'denied\',\\n  ad_personalization: \'denied\',\\n  functionality_storage: \'granted\',\\n  security_storage: \'granted\',\\n  wait_for_update: 500\\n});\\n</script>"}, {"type":"boolean","key":"supportDocumentWrite","value":"false"} ]',
    '   Tell the user this sets DEFAULTS only — they still need a CMP/consent banner for the update call.',
    '',
    '6. VERIFY — re-run tags_list + triggers_list and confirm, for EVERY funnel event: the tag exists, is not paused, has its firing trigger, and carries sendEcommerceData=true; and that the consent tag fires on 2147479572. Report a pass/fail checklist. Remind the user: the SITE must push the matching dataLayer events (view_item, add_to_cart, …, purchase with the ecommerce object) — GTM only listens; and to QA in Preview mode before publishing.',
    '',
    'To also relay this funnel SERVER-SIDE, run the setup_server_side_container prompt afterwards (it creates the server container, GA4 client, per-event triggers and server tags).',
  ].join('\n');
}

export function registerEcommerceFunnelPrompts(server: McpServer): void {
  server.registerPrompt(
    'setup_ecommerce_funnel',
    {
      title: 'Install the GA4 ecommerce funnel (web)',
      description:
        'One guided flow to install the full GA4 ecommerce funnel in a WEB container: per-event Custom Event triggers + GA4 event tags with native ecommerce forwarding (sendEcommerceData), the dlv - ecommerce.* variables, and a Consent Mode v2 defaults tag on Consent Initialization — then a verification checklist. Optional args: accountId, containerId, measurementId, events (comma-separated).',
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
