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
    '), so the single-product rule above is relaxed for exactly those platforms: their tools are available here and you should complete cross-platform workflows end to end in THIS chat instead of telling the user to switch. ';

  if (product === 'gtm' && on.includes('ga4')) {
    out +=
      'GA4 CONNECTED - creating GA4 events end to end: ' +
      '(1) Resolve the Measurement ID from the SELECTED GA4 property (see CURRENT CONTEXT): call list_ga4_data_streams for that property and use the WEB stream\'s measurementId (G-XXXXXXX). ' +
      'Never invent a Measurement ID and never assume an id already in the container belongs to this property; if no GA4 property is selected, ask the user to pick one (or list_ga4_properties and confirm). ' +
      '(2) Build the tag: create_gtm_tracking_tag platform ga4_event with that measurementId, the event name and the trigger. ' +
      (writes
        ? '(3) If the event should count as a conversion in GA4, OFFER to register it as a key event on the property with create_ga4_key_event (the event name must match exactly); that is a LIVE GA4 Admin change, so say so before calling. '
        : '(3) GA4 Admin writes are unavailable in this session, so to make the event a key event give the user the exact GA4 Admin step instead. ') +
      'Close by stating the GTM side is a DRAFT (the user publishes manually) while any GA4 Admin change is already live. ';
  }
  if (product === 'gtm' && on.includes('ads')) {
    out +=
      'GOOGLE ADS CONNECTED - conversion tags without copy-paste: ' +
      'list_google_ads_conversion_actions on the selected Ads account (list_google_ads_accounts first if none is selected) and REUSE a matching action when one exists' +
      (writes ? ', or create one with create_google_ads_conversion_action when nothing fits (that write is LIVE in the Ads account, not a draft - name the account and the action before calling; Google assigns the Label on creation)' : '') +
      '. Then build the tag: create_gtm_tracking_tag platform google_ads_conversion with the action\'s conversionId and conversionLabel as LITERAL values, never {{variables}} and never invented ones. ' +
      'Also check list_gtm_tags for a Conversion Linker (type gclidw) and offer to add one if missing. ';
  }
  if (product === 'ga4' && on.includes('gtm')) {
    out +=
      'GTM CONNECTED - wiring GA4 events into the site: ' +
      'the GTM tools act on the user\'s working GTM container (see CURRENT CONTEXT; if none is selected, ask or use set_gtm_container). ' +
      'To create a GA4 event end to end: resolve THIS property\'s Measurement ID (list_ga4_data_streams, the WEB stream\'s measurementId), then create_gtm_tracking_tag platform ga4_event with that id, the event name and a trigger. ' +
      (writes ? 'Offer create_ga4_key_event when the event should count as a conversion (a LIVE GA4 change; the GTM tag stays a draft the user publishes). ' : '') +
      'Never claim the event is collecting until the container is published and the tag verified. ';
  }
  if (product === 'ads' && on.includes('gtm')) {
    out +=
      'GTM CONNECTED - building the conversion tag here: ' +
      'after choosing (or creating) the conversion action, build its GTM tag yourself: create_gtm_tracking_tag platform google_ads_conversion in the user\'s working GTM container (see CURRENT CONTEXT; ask or use set_gtm_container if none is selected), passing the action\'s conversionId and conversionLabel as LITERAL values, never {{variables}} and never invented ones - a null conversionLabel means Google published no snippet, say so instead of fabricating one. ' +
      'Also check list_gtm_tags for a Conversion Linker (type gclidw) and offer to add one if missing. ' +
      'Be explicit about the asymmetry: Ads changes are LIVE immediately, GTM changes land in a DRAFT workspace the user publishes manually. ';
  }

  return out;
}
