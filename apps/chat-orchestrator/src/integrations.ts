/**
 * Cross-platform chat integrations: which OTHER product a chat may connect, and what that unlocks.
 *
 * Ported from the desktop's shared/chat-integrations.ts, reduced to the GTM<->GA4 pairing. The
 * desktop also offers Google Ads, and that half deliberately does NOT come across: this MCP server
 * registers no Google Ads tools at all (the desktop's Ads capability lives in its own registry), so
 * an Ads chip here would promise a workflow whose tools do not exist and the model would call one
 * mid-task. It can be added the day Ads tools land in the MCP, not before.
 *
 * PURE. Shared by the request boundary (sanitizing what the browser sent), tool scoping, and the
 * system prompt - one definition, because the moment the chips, the tool filter and the prompt
 * disagree about what "GA4 connected" means, the model is either promised tools it cannot see or
 * handed tools the user never opted into.
 *
 * OPT-IN PER REQUEST: nothing here activates until the user turns a chip on. A GTM chat with no
 * chip has exactly the tools it has always had.
 */
import type { Product } from './config.js';

/** Which platforms each chat may connect. */
export const INTEGRATION_OPTIONS: Record<Product, readonly Product[]> = {
  gtm: ['ga4'],
  ga4: ['gtm'],
};

export const INTEGRATION_LABEL: Record<Product, string> = {
  gtm: 'GTM',
  ga4: 'GA4',
};

/** One sentence per chip, for its tooltip. */
export const INTEGRATION_HINT: Record<Product, Partial<Record<Product, string>>> = {
  gtm: {
    ga4: 'Create GA4 events end to end: the selected GA4 property supplies the Measurement ID for the GA4 tags this chat builds.',
  },
  ga4: {
    gtm: 'Build the GTM side too: create the GA4 event tag in your working container using this property\'s Measurement ID.',
  },
};

/**
 * Request-boundary coercion: keep only what this product may actually connect, deduped, in the
 * canonical order. Anything else off the wire (junk strings, the product itself, a platform the
 * other product offers) is dropped rather than trusted, because the result picks tool sets.
 */
export function sanitizeIntegrations(product: Product, raw: unknown): Product[] {
  const allowed = INTEGRATION_OPTIONS[product] ?? [];
  const wanted = new Set(Array.isArray(raw) ? raw.map((v) => String(v)) : []);
  return allowed.filter((p) => wanted.has(p));
}

/**
 * A CONNECTED platform grants its WORKFLOW, not its whole administrative surface.
 *
 * The user connected a platform to FINISH A TASK (build this tag, register this key event), not to
 * administer it from a chat whose prompt and context belong to a different product. So a connected
 * platform contributes all of its READ tools plus only the writes named here. The destructive and
 * account-level surface stays where its guidance lives: that platform's own chat.
 *
 * A chat's PRIMARY product is untouched by this - a GA4 chat still owns the whole GA4 surface.
 */
/*
 * NAMES ARE THIS SERVER'S, NOT THE DESKTOP'S. The desktop registry calls these
 * `create_gtm_tracking_tag` and `create_ga4_key_event`; this MCP server uses noun_verb
 * (`tags_create`, `ga4_create_key_event`). Copying the desktop list verbatim produced an allowlist
 * that matched nothing, which fails silently: every connected write is simply withheld and the
 * prompt cheerfully names tools that were never offered. The assertion below exists so that can
 * never happen again unnoticed.
 */
export const CONNECTED_WRITE_ALLOWLIST: Record<Product, readonly string[]> = {
  // GTM connected to a GA4 chat: build and adjust the tag that carries the measurement.
  // Deliberately absent: every *_delete, publishing, and workspace/environment/permission
  // administration - a GA4 chat is not where you administer a container.
  gtm: [
    'tags_create',
    'tags_update',
    'tags_add_ga4_event_parameters',
    'triggers_create',
    'triggers_update',
    'variables_create',
    'variables_update',
    'built_in_variables_enable',
  ],
  // GA4 connected to a GTM chat: register what the new event needs to REPORT correctly.
  // Deliberately absent: every ga4_delete_* and ga4_archive_* (archiving is irreversible),
  // property and account administration, data retention, and access bindings.
  ga4: ['ga4_create_key_event', 'ga4_create_custom_dimension', 'ga4_create_custom_metric'],
};

/**
 * May a CONNECTED (non-primary) platform's write tool be offered here?
 *
 * Reads never reach this - they are always allowed - so a `false` means "belongs to that platform's
 * own chat".
 */
export function connectedWriteAllowed(platform: Product, toolName: string): boolean {
  return (CONNECTED_WRITE_ALLOWLIST[platform] ?? []).includes(toolName);
}

/**
 * The system-prompt block for the enabled integrations.
 *
 * Empty string when none are on, so a single-product prompt stays byte-identical to what it always
 * was, which keeps it prompt-cache friendly. `writes` mirrors whether write tools are actually
 * offered: without it the guidance must not promise creates it cannot perform.
 */
export function buildIntegrationPrompt(
  product: Product,
  integrations: readonly Product[],
  writes: boolean,
): string {
  const on = sanitizeIntegrations(product, integrations as unknown);
  if (!on.length) return '';

  let out =
    'CROSS-PLATFORM INTEGRATIONS: the user has CONNECTED additional platforms to this chat (' +
    on.map((p) => INTEGRATION_LABEL[p]).join(', ') +
    '), so the single-product rule above is relaxed for exactly those platforms: their tools are available here and you should complete cross-platform workflows end to end in THIS chat instead of telling the user to switch. ' +
    // The model must not offer a connected platform's admin surface: those tools are genuinely
    // absent here, so promising them produces an "Unknown tool" mid-workflow.
    'SCOPE OF A CONNECTED PLATFORM: you have all of its READ tools plus only the writes its workflow ' +
    'needs. A connected platform\'s DESTRUCTIVE and ACCOUNT-LEVEL tools (deleting or archiving ' +
    'anything, property or account administration) are NOT available in this chat by design. If the ' +
    'user asks for one, say plainly that it lives in that platform\'s own chat and point them at the ' +
    'product selector, rather than attempting a tool you do not have. ';

  if (product === 'gtm' && on.includes('ga4')) {
    out +=
      'GA4 CONNECTED - creating GA4 events end to end: ' +
      '(1) Resolve the Measurement ID from the SELECTED GA4 property (see CURRENT CONTEXT): call ga4_data_streams_list for that property and use the WEB stream\'s measurementId (G-XXXXXXX). ' +
      'Never invent a Measurement ID and never assume an id already in the container belongs to this property; if no GA4 property is selected, ask the user to pick one (or ga4_properties_list and confirm). ' +
      '(2) Build the tag with tags_create: a GA4 event tag (type gaawe) carrying that measurementId, the event name, and the trigger (triggers_create first if the trigger does not exist yet). ' +
      (writes
        ? '(3) If the event should count as a conversion in GA4, OFFER to register it as a key event with ga4_create_key_event (the event name must match the tag exactly); that is a LIVE GA4 Admin change, so say so before calling. ' +
          'If the event carries parameters the user wants to report on, OFFER ga4_create_custom_dimension for each (event-scoped, matching the parameter name) - without one the parameter is collected but not reportable, which is the single most common "why can I not see it in GA4" cause. '
        : '(3) GA4 Admin writes are unavailable in this session, so to make the event a key event give the user the exact GA4 Admin step instead. ') +
      'Close by stating the GTM side is a DRAFT (the user publishes manually) while any GA4 Admin change is already live. ';
  }

  if (product === 'ga4' && on.includes('gtm')) {
    out +=
      'GTM CONNECTED - wiring GA4 events into the site: ' +
      'the GTM tools act on the user\'s working GTM container (see CURRENT CONTEXT; if none is selected, ask the user to pick one). ' +
      'To create a GA4 event end to end: resolve THIS property\'s Measurement ID (ga4_data_streams_list, the WEB stream\'s measurementId), then tags_create a GA4 event tag (type gaawe) with that id, the event name and a trigger (triggers_create if needed). ' +
      (writes
        ? 'Offer ga4_create_key_event when the event should count as a conversion, and ga4_create_custom_dimension for any event parameter the user wants to REPORT on (collected is not the same as reportable). Both are LIVE GA4 changes; the GTM tag stays a draft the user publishes. '
        : '') +
      'Never claim the event is collecting until the container is published and the tag verified. ';
  }

  return out;
}

/**
 * Cross-checks the allowlist against the tools the server actually registered.
 *
 * An allowlist entry that matches no real tool is invisible: the write is simply never offered, the
 * prompt still describes the workflow, and the model reports it cannot do something the UI promised.
 * That is exactly what happened when these names were ported from the desktop registry, which uses
 * a different naming convention. Called once at startup so a rename shows up in the log rather than
 * in a user's conversation.
 */
export function checkAllowlistAgainstServer(registered: readonly string[]): string[] {
  const known = new Set(registered);
  const missing: string[] = [];
  for (const list of Object.values(CONNECTED_WRITE_ALLOWLIST)) {
    for (const name of list) if (!known.has(name)) missing.push(name);
  }
  return missing;
}
