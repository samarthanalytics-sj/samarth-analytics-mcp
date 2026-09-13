// GA4 FIX GUIDE - for every audit finding, BOTH ways to resolve it:
//   1. `planIdPrefix` - the ga4-plan item that fixes it in ONE CLICK (only when a write tool truly
//      applies it). Matched against Ga4PlanItem.id as an exact id OR an `id:<streamId>` prefix, because
//      per-stream items are suffixed with the stream id.
//   2. `steps` - the manual how-to, written as the exact GA4 Admin path a human follows. ALWAYS present,
//      so a finding is never a dead end: even the ones no API can touch tell you what to do.
//
// Honesty rules (the reason this is a separate, testable table rather than inline strings):
// - A finding gets a planIdPrefix ONLY if an executable plan item genuinely applies it. Anything the
//   GA4 Admin API cannot change (event naming, PII being SENT, BigQuery project links, which events are
//   conversions) is `where: 'site'|'ga4-ui'` with steps and NO fix button - never a button that no-ops.
// - `where` says who has to act, so the UI can say "we can do this" vs "you (or your developer) must".
//
// PURE: no I/O, no GA4 calls. Keyed by Ga4Finding.checkId.

/** Who has to perform the fix. Drives the UI wording and whether a one-click button can exist at all. */
export type Ga4FixWhere =
  | 'auto'    // an executable plan item applies it from here
  | 'ga4-ui'  // a human must do it in the GA4 admin UI (no API, or needs a human decision)
  | 'site';   // site / GTM / developer change - not a GA4 config setting at all

export interface Ga4FixGuide {
  /** Plan item id (exact, or the prefix of an `id:<streamId>` item) that applies this in one click. */
  planIdPrefix?: string;
  where: Ga4FixWhere;
  /** Ordered manual steps - the documentation half. Always non-empty. */
  steps: string[];
  /** Official Google documentation for the setting. */
  docUrl?: string;
}

const G = 'https://support.google.com/analytics/answer/';

export const GA4_FIX_GUIDE: Record<string, Ga4FixGuide> = {
  no_data_streams: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin (gear icon, bottom left) and confirm you are in the right property.',
      'Go to Data collection and modification > Data streams, then click Add stream > Web.',
      'Enter the site URL and a stream name, then click Create stream.',
      'Copy the Measurement ID (G-XXXXXXX) and install the Google tag on the site (or set it on your GTM GA4 Configuration tag).',
    ],
    docUrl: `${G}9304153`,
  },
  retention_two_months: {
    planIdPrefix: 'retention_14',
    where: 'auto',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data retention.',
      'Set "Event data retention" to 14 months.',
      'Click Save. This affects exploration/report windows only, not standard reports.',
    ],
    docUrl: `${G}7667196`,
  },
  retention_360_under: {
    // The plan's retention_14 item sets 14 months, which is BELOW the 50-month 360 maximum, so it is
    // not the fix for this finding. Manual only, deliberately.
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data retention.',
      'Set "Event data retention" to 50 months (available on Google Analytics 360 properties).',
      'Click Save.',
    ],
    docUrl: `${G}7667196`,
  },
  retention_no_reset: {
    planIdPrefix: 'retention_reset',
    where: 'auto',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data retention.',
      'Turn ON "Reset user data on new activity" so returning users keep their history.',
      'Click Save.',
    ],
    docUrl: `${G}7667196`,
  },
  no_key_events: {
    // The API can mark a key event, but WHICH events are conversions is a business decision, so the
    // plan item is advisory (executable:false) and this stays manual on purpose.
    where: 'ga4-ui',
    steps: [
      'Decide which events are real conversions for this business (e.g. purchase, generate_lead, sign_up).',
      'Open GA4 Admin > Data display > Key events.',
      'Click "Mark as key event" for each, or use "New key event" if the event has not been received yet.',
      'Confirm each one starts counting within 24 hours.',
    ],
    docUrl: `${G}9267568`,
  },
  em_master_off: {
    planIdPrefix: 'em_master',
    where: 'auto',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data streams and select the web stream.',
      'Toggle "Enhanced measurement" ON.',
      'Open its settings (gear) and confirm the individual events you want are enabled.',
    ],
    docUrl: `${G}9216061`,
  },
  em_subtoggles_off: {
    // Covers site search / SPA page changes / form interactions - the plan has one item per toggle,
    // all sharing this prefix family; the renderer offers whichever ones this property is missing.
    planIdPrefix: 'em_site_search',
    where: 'auto',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data streams and select the web stream.',
      'Click the gear on "Enhanced measurement".',
      'Turn on the missing toggles: Site search, Page changes based on browser history (for single-page sites), and Form interactions.',
      'For site search, set the query parameter if your site does not use q, s, search, query or keyword.',
    ],
    docUrl: `${G}9216061`,
  },
  attribution_last_click: {
    planIdPrefix: 'attribution_data_driven',
    where: 'auto',
    steps: [
      'Open GA4 Admin > Data display > Attribution settings.',
      'Set "Reporting attribution model" to Data-driven.',
      'Click Save. NOTE: this re-states historical conversion credit in reports, so agree it with stakeholders first.',
    ],
    docUrl: `${G}10596866`,
  },
  signals_off_with_ads: {
    planIdPrefix: 'google_signals_on',
    where: 'auto',
    steps: [
      'Confirm your privacy policy and consent banner cover Google-account-based collection.',
      'Open GA4 Admin > Data collection and modification > Data collection.',
      'Turn on Google signals data collection.',
    ],
    docUrl: `${G}9445345`,
  },
  lookback_short: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data display > Attribution settings.',
      'Set the "Acquisition conversion events" lookback to 30 days and "All other conversion events" to 90 days.',
      'Click Save.',
    ],
    docUrl: `${G}10596866`,
  },
  industry_category_unset: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Property settings > Property details.',
      'Choose the closest Industry category.',
      'Click Save. This only affects benchmarking comparisons.',
    ],
    docUrl: `${G}9304153`,
  },
  currency_unset: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Property settings > Property details.',
      'Set "Currency displayed as" to the currency your revenue is reported in.',
      'Click Save. Existing rows are converted at the historical rate, so set this before you rely on revenue.',
    ],
    docUrl: `${G}9796179`,
  },
  pii_custom_dimension: {
    where: 'site',
    steps: [
      'Stop SENDING the value first: remove the email/phone/name from the parameter in your GTM tag or gtag call. Archiving the dimension alone does not stop collection.',
      'If you need the field for joins, send a hashed or pseudonymous id instead of the raw value.',
      'Then open GA4 Admin > Data display > Custom definitions and archive the offending dimension.',
      'Note GA4 cannot retroactively delete already-collected values; open a data-deletion request if the exposure is material.',
    ],
    docUrl: `${G}9267568`,
  },
  param_naming: {
    where: 'site',
    steps: [
      'Decide the correct spelling and use lowercase snake_case on BOTH sides.',
      'Either fix the tag so it sends the registered parameter name, or register a new definition under the name actually being sent.',
      'A definition\'s parameter name is immutable, so re-registering means: create the correctly named one, then archive the old one.',
      'Confirm data arrives on the new definition before archiving the old.',
    ],
    docUrl: `${G}10075209`,
  },
  no_custom_defs: {
    where: 'ga4-ui',
    steps: [
      'List the event parameters your tags already send that you want to report on.',
      'Open GA4 Admin > Data display > Custom definitions > Create custom dimension.',
      'Register each parameter with a clear name and the right scope (Event or User).',
      'Only register parameters you actually send - slots are capped at 50 event / 25 user.',
    ],
    docUrl: `${G}10075209`,
  },
  event_dim_slots: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data display > Custom definitions.',
      'Identify event-scoped dimensions with no recent data (the audit lists dead ones separately).',
      'Archive the unused ones to free slots before you hit the 50 cap.',
    ],
    docUrl: `${G}10075209`,
  },
  user_dim_slots: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data display > Custom definitions.',
      'Archive unused user-scoped dimensions before you hit the 25 cap.',
    ],
    docUrl: `${G}10075209`,
  },
  multiple_web_streams: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data collection and modification > Data streams.',
      'Confirm whether the extra web streams are genuinely separate sites.',
      'If they are duplicates, remove or repurpose the extra stream and keep ONE stream per site so sessions are not split.',
    ],
    docUrl: `${G}9304153`,
  },
  no_ads_links: {
    where: 'ga4-ui',
    steps: [
      'Make sure you have Edit access on the GA4 property and Admin access on the Google Ads account.',
      'Open GA4 Admin > Product links > Google Ads links > Link.',
      'Choose the Ads account, enable personalized advertising and auto-tagging, then Submit.',
    ],
    docUrl: `${G}9379420`,
  },
  no_bigquery: {
    where: 'ga4-ui',
    steps: [
      'Create (or pick) a Google Cloud project and enable the BigQuery API on it.',
      'Open GA4 Admin > Product links > BigQuery links > Link.',
      'Select the project, choose the data location, and enable a Daily and/or Streaming export.',
      'Confirm the first export lands within 24 hours (daily) or minutes (streaming).',
    ],
    docUrl: `${G}9823238`,
  },
  bigquery_no_export: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Product links > BigQuery links and open the existing link.',
      'Enable Daily and/or Streaming export (a link with neither exports nothing).',
      'Confirm tables appear in the linked BigQuery dataset.',
    ],
    docUrl: `${G}9823238`,
  },
  no_audiences: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data display > Audiences > New audience.',
      'Build the audiences you actually want to remarket to (e.g. purchasers, cart abandoners, key-event completers).',
      'Confirm they are shared to the linked Google Ads account.',
      'Audiences only collect from creation onwards, so create them before a campaign needs them.',
    ],
    docUrl: `${G}9267572`,
  },
  only_default_audiences: {
    where: 'ga4-ui',
    steps: [
      'Open GA4 Admin > Data display > Audiences.',
      'Add audiences beyond the All Users / Purchasers defaults that match how you actually segment.',
      'Confirm they are shared to Google Ads if you use them for remarketing.',
    ],
    docUrl: `${G}9267572`,
  },
};

/** The guide for a finding, or null when the check has no entry (defensive - the UI then shows text only). */
export function fixGuideFor(checkId: string | undefined): Ga4FixGuide | null {
  if (!checkId) return null;
  return GA4_FIX_GUIDE[checkId] ?? null;
}

/**
 * Does this plan item apply that guide's fix? Plan ids are either exact (`retention_14`) or suffixed
 * with the stream id (`em_site_search:123`), so match on the prefix boundary - never a bare
 * startsWith, which would let `retention_1` match `retention_14`.
 */
export function planItemMatches(planId: string, prefix: string): boolean {
  return planId === prefix || planId.startsWith(`${prefix}:`);
}
