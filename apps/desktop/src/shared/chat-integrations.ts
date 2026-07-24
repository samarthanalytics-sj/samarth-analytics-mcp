// Cross-platform chat integrations: which OTHER products a chat can optionally connect, and the
// system-prompt guidance each connection adds.
//
// PURE + framework-free, shared by the renderer (the chips above the composer), the IPC boundary
// (sanitizing what the renderer sent), and the chat service (tool scoping + prompt). One definition,
// because the moment the chips, the tool filter and the prompt disagree about what "GA4 connected"
// means, the model is promised tools it cannot see (or sees tools the user never opted into).
//
// The model is DELIBERATELY opt-in per thread: nothing here activates until the user turns a chip
// on. A GTM chat without the Google Ads chip has no Ads tools at all; with it, the Ads reads plus
// the conversion-action create appear and the prompt explains the cross-platform workflow.
//
// House style: no em dashes anywhere in this file - every string here is model/user-visible.

import type { GoogleProduct } from './ipc';

/** Which platforms each chat may connect. The asymmetry is the product decision, not an accident:
 *  a GTM chat can reach BOTH data destinations (GA4 and Google Ads), while the GA4 and Ads chats
 *  each connect only GTM (the delivery mechanism for their tags) - never each other. */
export const INTEGRATION_OPTIONS: Record<GoogleProduct, readonly GoogleProduct[]> = {
  gtm: ['ga4', 'ads'],
  ga4: ['gtm'],
  ads: ['gtm'],
};

export const INTEGRATION_LABEL: Record<GoogleProduct, string> = {
  gtm: 'GTM',
  ga4: 'GA4',
  ads: 'Google Ads',
};

/** What turning each chip on unlocks - the tooltip on the chip, one sentence, plain words. */
export const INTEGRATION_HINT: Record<GoogleProduct, Record<string, string>> = {
  gtm: {
    ga4: 'Create GA4 events end to end: the selected GA4 property supplies the Measurement ID for the GTM GA4 tags this chat builds.',
    ads: 'Create or reuse a Google Ads conversion action and build its GTM conversion tag from the real Conversion ID and Label, no copy-paste.',
  },
  ga4: {
    gtm: 'Build the GTM side too: create the GA4 event tag in your working GTM container using this property\'s Measurement ID.',
  },
  ads: {
    gtm: 'Build the GTM side too: create the Google Ads conversion tag in your working GTM container from the action\'s Conversion ID and Label.',
  },
};

/**
 * IPC-boundary coercion: keep only the platforms this product may actually connect, deduped, in the
 * canonical option order. Anything else from the wire (junk strings, the product itself, a platform
 * another product offers) is dropped rather than trusted - the result picks tool sets.
 */
export function sanitizeIntegrations(product: GoogleProduct, raw: unknown): GoogleProduct[] {
  const allowed = INTEGRATION_OPTIONS[product] ?? [];
  const wanted = new Set(Array.isArray(raw) ? raw.map((v) => String(v)) : []);
  return allowed.filter((p) => wanted.has(p));
}

/**
 * A CONNECTED platform grants its WORKFLOW, not its whole administrative surface.
 *
 * This is the same judgement the Google Ads pairing has always made - a GTM chat gets the Ads reads
 * and the conversion-action create, never the campaign/budget/upload tools - generalized to every
 * pairing. The reasoning is that the user connected a platform to FINISH A TASK (build this tag,
 * mint this action), not to administer it from a chat whose whole prompt, context bar and memory
 * scope belong to a different product. The destructive and account-level surface stays where its
 * guidance lives: the platform's own chat.
 *
 * Concretely, a connected platform contributes:
 *   - all of its READ tools (the reads are what make the workflow automatic), and
 *   - only the write tools named below.
 * A chat's PRIMARY product is never touched by this: a GA4 chat still owns the whole GA4 surface.
 */
export const CONNECTED_WRITE_ALLOWLIST: Record<GoogleProduct, readonly string[]> = {
  // GTM connected to a GA4 or Ads chat: build and adjust the tag that carries the measurement.
  // Deliberately absent: every delete_* / delete_unused_* (destructive cleanup is a GTM-chat job,
  // and "tidy my container" is not the workflow anyone connected GTM for), plus workspace and
  // environment administration.
  gtm: [
    'create_gtm_tracking_tag',
    'create_gtm_tag_with_trigger',
    'create_gtm_tag',
    'create_gtm_trigger',
    'create_gtm_variable',
    'create_gtm_variable_typed',
    'enable_gtm_builtin_variables',
    'update_gtm_tag',
    'update_gtm_trigger',
    'set_gtm_tag_paused',
    'set_gtm_tag_consent',
    'set_ga4_measurement_id',
    'add_ga4_event_parameters',
  ],
  // GA4 connected to a GTM chat: register what the new event needs to REPORT correctly.
  // Deliberately absent: every delete/archive (archiving a custom dimension is irreversible),
  // property and account administration, access bindings, data retention, and the link tools.
  ga4: [
    'create_ga4_key_event',
    'create_ga4_custom_dimension',
    'create_ga4_custom_metric',
  ],
  // Ads connected to a GTM chat: mint the conversion action the tag needs. Unchanged from the
  // original pairing rule. Deliberately absent: anything that moves money or data (campaign
  // status, budgets, negative keywords, the three uploads) and edits to an existing action.
  ads: ['create_google_ads_conversion_action'],
};

/** May a CONNECTED (non-primary) platform's write tool be offered in this chat? Reads never reach
 *  this - they are always allowed - so a `false` here means "belongs to that platform's own chat". */
export function connectedWriteAllowed(platform: GoogleProduct, toolName: string): boolean {
  return (CONNECTED_WRITE_ALLOWLIST[platform] ?? []).includes(toolName);
}

/** What a session can actually honor. Google Ads is optional in the chat service (no developer
 *  token, or a caller that never wired it), and without the service its tools are simply absent
 *  from the registry. A chip the session cannot honor must be dropped BEFORE the prompt is built,
 *  or the model reads a whole workflow for tools that do not exist and calls one mid-task. */
export interface IntegrationAvailability {
  /** Whether a Google Ads service is wired for this session. */
  ads: boolean;
}

/** Requested (already sanitized) minus whatever this session cannot honor. */
export function availableIntegrations(requested: readonly GoogleProduct[], have: IntegrationAvailability): GoogleProduct[] {
  return requested.filter((p) => (p === 'ads' ? have.ads : true));
}

/**
 * The system-prompt block for the enabled integrations. Empty string when none are on, so the
 * single-product prompt stays byte-identical to what it always was (prompt-cache friendly).
 * `writes` mirrors the confirm-fn presence: without it the guidance must not promise creates.
 */
export function buildIntegrationPrompt(product: GoogleProduct, integrations: readonly GoogleProduct[], writes: boolean): string {
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
    'anything, property/account administration, campaign and budget changes, data uploads) are NOT ' +
    'available in this chat by design. If the user asks for one, say plainly that it lives in that ' +
    'platform\'s own chat and point them at the selector, rather than attempting a tool you do not have. ';

  if (product === 'gtm' && on.includes('ga4')) {
    out +=
      'GA4 CONNECTED - creating GA4 events end to end: ' +
      '(1) Resolve the Measurement ID from the SELECTED GA4 property (see CURRENT CONTEXT): call list_ga4_data_streams for that property and use the WEB stream\'s measurementId (G-XXXXXXX). ' +
      'Never invent a Measurement ID and never assume an id already in the container belongs to this property; if no GA4 property is selected, ask the user to pick one (or list_ga4_properties and confirm). ' +
      '(2) Build the tag: create_gtm_tracking_tag platform ga4_event with that measurementId, the event name and the trigger. ' +
      (writes
        ? '(3) If the event should count as a conversion in GA4, OFFER to register it as a key event on the property with create_ga4_key_event (the event name must match exactly); that is a LIVE GA4 Admin change, so say so before calling. ' +
          'If the event carries parameters the user wants to report on, OFFER create_ga4_custom_dimension for each (event-scoped, matching the parameter name) - without one the parameter is collected but not reportable, which is the single most common "why can I not see it in GA4" cause. '
        : '(3) GA4 Admin writes are unavailable in this session, so to make the event a key event give the user the exact GA4 Admin step instead. ') +
      'VERIFY, do not assume: after building GA4 tags, check_gtm_measurement_ids flags any GA4 id in the container that matches no stream the user can access (typo, wrong property, another account) - run it when the container already had GA4 tags. ' +
      'COMBINED REPORTING: analytics_scorecard and generate_analytics_report both accept ga4Property, so with GA4 connected you can produce ONE container-plus-property score or report instead of two partial ones. ' +
      'Close by stating the GTM side is a DRAFT (the user publishes manually) while any GA4 Admin change is already live. ';
  }
  if (product === 'gtm' && on.includes('ads')) {
    out +=
      'GOOGLE ADS CONNECTED - conversion tags without copy-paste: ' +
      'list_google_ads_conversion_actions on the selected Ads account (list_google_ads_accounts first if none is selected) and REUSE a matching action when one exists' +
      (writes ? ', or create one with create_google_ads_conversion_action when nothing fits (that write is LIVE in the Ads account, not a draft - name the account and the action before calling; Google assigns the Label on creation)' : '') +
      '. Then build the tag: create_gtm_tracking_tag platform google_ads_conversion with the action\'s conversionId and conversionLabel as LITERAL values, never {{variables}} and never invented ones. ' +
      'Also check list_gtm_tags for a Conversion Linker (type gclidw) and offer to add one if missing. ' +
      'taggable=false on an action means it can NEVER fire from GTM (offline import, app, store visit, Analytics-imported): report its `note` and do not build a tag for it. ' +
      'BEFORE building, check the container for an EXISTING tag carrying that same conversionId+Label (list_gtm_tags) and say so rather than creating a second one that double-counts. ' +
      'WORTH OFFERING once the tag exists: audit_google_ads_conversion_health surfaces config problems this pairing can then fix here (a missing label, an action that never fires, double counting). ';
  }
  // Both destinations connected to a GTM chat: the seam between them is only auditable when the
  // chat can see BOTH, which is exactly this case and nowhere else.
  if (product === 'gtm' && on.includes('ga4') && on.includes('ads')) {
    out +=
      'GA4 AND ADS BOTH CONNECTED - the seam between them is now auditable from here: audit_google_ads_ga4_link (pass the selected property and customer id) reports whether the property is linked to the Ads account, whether GA4-imported conversion actions still match current key events, and the classic double-count where a GA4 import AND a website tag are both primary. Offer it when the user asks why conversions disagree between GA4 and Ads, and prefer it over reasoning from the two sides separately. ';
  }
  if (product === 'ga4' && on.includes('gtm')) {
    out +=
      'GTM CONNECTED - wiring GA4 events into the site: ' +
      'the GTM tools act on the user\'s working GTM container (see CURRENT CONTEXT; if none is selected, ask or use set_gtm_container). ' +
      'To create a GA4 event end to end: resolve THIS property\'s Measurement ID (list_ga4_data_streams, the WEB stream\'s measurementId), then create_gtm_tracking_tag platform ga4_event with that id, the event name and a trigger. ' +
      (writes ? 'Offer create_ga4_key_event when the event should count as a conversion, and create_ga4_custom_dimension for any event parameter the user wants to REPORT on (collected is not the same as reportable). Both are LIVE GA4 changes; the GTM tag stays a draft the user publishes. ' : '') +
      'VERIFY: check_gtm_measurement_ids flags GA4 ids in the container that match no stream the user can access, which is the fastest way to catch a tag pointing at the wrong property. ' +
      'Never claim the event is collecting until the container is published and the tag verified. ';
  }
  if (product === 'ads' && on.includes('gtm')) {
    out +=
      'GTM CONNECTED - building the conversion tag here: ' +
      'after choosing (or creating) the conversion action, build its GTM tag yourself: create_gtm_tracking_tag platform google_ads_conversion in the user\'s working GTM container (see CURRENT CONTEXT; ask or use set_gtm_container if none is selected), passing the action\'s conversionId and conversionLabel as LITERAL values, never {{variables}} and never invented ones - a null conversionLabel means Google published no snippet, say so instead of fabricating one. ' +
      'Also check list_gtm_tags for a Conversion Linker (type gclidw) and offer to add one if missing. ' +
      'taggable=false means the action can NEVER fire from GTM (offline import, app, store visit, Analytics-imported): report its `note` instead of building a tag. ' +
      'BEFORE building, list_gtm_tags and check whether a tag already carries that conversionId+Label - a second one double-counts. ' +
      'Be explicit about the asymmetry: Ads changes are LIVE immediately, GTM changes land in a DRAFT workspace the user publishes manually. ';
  }

  return out;
}
