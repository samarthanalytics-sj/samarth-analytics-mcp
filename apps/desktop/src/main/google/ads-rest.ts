// Pure REST-shape layer for the Google Ads API: URLs, headers, GAQL strings and request bodies.
// Deliberately I/O-free so every shape below is assertable from a literal in the test file; the
// transport (fetch, OAuth bearer, retry, quota backoff) lives in the caller.
//
// Google pins the API version in the URL PATH rather than a header, and every version has a
// published sunset date after which requests hard-fail, so the constant below is the single place
// to bump. v24 is current at the time of writing.

export const ADS_API_VERSION = 'v24';
export const ADS_BASE = 'https://googleads.googleapis.com';

/**
 * Customer ids travel as bare digits in both URL paths and headers.
 *
 * The Google Ads UI renders them dashed ("123-456-7890") and a copy-paste out of that UI regularly
 * drags a U+00A0 non-breaking space along with it. A dashed or space-bearing id in the
 * `login-customer-id` header does not fail with a parse error, it fails as an authorization error,
 * which sends you hunting for a permissions problem that does not exist. So every id is normalized
 * at the boundary instead of trusting whatever the renderer handed us.
 */
export function normalizeCustomerId(id: string): string {
  // JS \s already covers U+00A0, which is exactly the character the Ads UI puts between digit groups.
  return String(id ?? '').replace(/[\s-]/g, '');
}

/**
 * The one Ads endpoint with no customer in the path. It answers "which accounts can these
 * credentials touch directly", and note it deliberately ignores `login-customer-id`: the list is a
 * property of the OAuth user, not of the manager you are acting through.
 */
export function listAccessibleCustomersUrl(): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers:listAccessibleCustomers`;
}

/** Every GAQL read goes through searchStream: one request, one streamed array, no page tokens. */
export function searchStreamUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/googleAds:searchStream`;
}

/** The customer id in the path is the account that will OWN the conversion action. */
export function mutateConversionActionsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/conversionActions:mutate`;
}

/**
 * Headers common to every Ads call. The Authorization bearer is added by the token layer, not here,
 * so this stays pure and no access token can leak into a test fixture.
 *
 * Header names are lowercase on purpose: HTTP header names are case-insensitive, but these two are
 * transcoded into gRPC metadata keys on Google's side, and metadata keys are NOT.
 */
export function adsHeaders(developerToken: string, loginCustomerId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'developer-token': developerToken,
    'Content-Type': 'application/json',
  };
  const login = normalizeCustomerId(loginCustomerId ?? '');
  // An empty login-customer-id is NOT the same as an absent one. Sending '' is rejected outright,
  // so a manager id the user never picked must never reach the wire as a blank header.
  if (login) headers['login-customer-id'] = login;
  return headers;
}

export const GAQL: {
  customerClients: string;
  conversionTrackingSetting: string;
  conversionActions: string;
  campaigns: string;
  campaignPerformance: (range: PerfRange) => string;
} = {
  // The MCC hierarchy walk. `level <= 1` means "this account plus its direct children": going
  // deeper returns the whole sub-tree of every manager under a large MCC, which is thousands of
  // rows the picker cannot use. `hidden` and `test_account` are selected rather than filtered out
  // in GAQL so the UI can grey them out and explain the omission instead of silently losing an
  // account the user was looking for.
  customerClients:
    'SELECT customer_client.client_customer, customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.level, customer_client.manager, customer_client.status, customer_client.hidden, customer_client.test_account FROM customer_client WHERE customer_client.level <= 1',

  // Reads where a given account's conversions actually live. Three of these are easy to confuse:
  // google_ads_conversion_customer is a RESOURCE NAME string ('customers/{id}') while
  // conversion_tracking_id and cross_account_conversion_tracking_id are int64, so a caller that
  // compares them without stripping the prefix always concludes they differ. conversion_tracking_status
  // is relative to the login-customer-id the request was made under, meaning the same account can
  // legitimately report a different status through a different manager.
  // auto_tagging_enabled rides in the SAME query: it lives on the customer, and "is GCLID present at
  // all" belongs to the same tracking-setup question as "who owns the conversions".
  conversionTrackingSetting:
    'SELECT customer.id, customer.descriptive_name, customer.auto_tagging_enabled, customer.conversion_tracking_setting.conversion_tracking_id, customer.conversion_tracking_setting.cross_account_conversion_tracking_id, customer.conversion_tracking_setting.google_ads_conversion_customer, customer.conversion_tracking_setting.accepted_customer_data_terms, customer.conversion_tracking_setting.conversion_tracking_status FROM customer',

  // Everything the reuse picker needs. tag_snippets is the payload that matters: the conversion
  // LABEL has no field of its own anywhere in the API, it exists only inside
  // tag_snippets[].event_snippet as a resolved send_to of the form 'AW-123456789/AbC-dEfGh12_34',
  // and the conversion id is the AW- number in that same string. Both halves must be read out of
  // the SAME snippet entry of the SAME action: under cross-account conversion tracking a client can
  // have its own id and its manager's id live simultaneously, and an id/label pair assembled from
  // two sources records nothing at all while reporting success.
  //
  // Two omissions are load-bearing:
  //  - conversion_action.include_in_conversions_metric is NOT selected. Including it makes the API
  //    return only primary actions, silently hiding every secondary one (primary_for_goal = false),
  //    which is precisely the set a reuse picker must still be able to show.
  //  - no metrics or segments, so this stays a config read that needs no date range.
  // tag_snippets is legitimately empty for UPLOAD_CLICKS, app, store-visit and GA4-originated
  // actions (the latter usually arrive with status HIDDEN), so the caller must treat an empty
  // array as "not taggable from the web", never as an error.
  // The FULL config read: attribution model (+ data-driven status), the two lookback windows, and the
  // value settings ride along so a config audit needs no second query. include_in_conversions_metric
  // stays deliberately UNSELECTED (see the omissions note above) - primary_for_goal is the field.
  conversionActions:
    "SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.owner_customer, conversion_action.primary_for_goal, conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model, conversion_action.attribution_model_settings.data_driven_model_status, conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days, conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code, conversion_action.value_settings.always_use_default_value, conversion_action.tag_snippets FROM conversion_action WHERE conversion_action.status != 'REMOVED'",

  // Campaign CONFIG only - no metrics, so it needs no date range and cannot be mistaken for
  // performance. REMOVED campaigns are excluded because they can outnumber the live ones many times
  // over in a long-running account; PAUSED ones are kept, since "why is this paused" is a real
  // question. The budget arrives in MICROS of the account currency (1,000,000 = 1 unit) and is
  // SHARED: one budget can back several campaigns, so its amount is not that campaign's spend.
  campaigns:
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.start_date, campaign.end_date, campaign.bidding_strategy_type, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name",

  // Campaign PERFORMANCE over a window. Separate from the config read because the moment a GAQL
  // query names a metric it becomes date-ranged, and rows then represent campaign-days rather than
  // campaigns. The date clause comes from perfDateClause: an explicit BETWEEN for a custom range,
  // else DURING LAST_N (which excludes today, whose data is still accruing and would read as a
  // collapse in every trend). cost_micros is micros of the account currency.
  campaignPerformance: (range: PerfRange): string =>
    'SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.all_conversions ' +
    `FROM campaign WHERE campaign.status != 'REMOVED' AND ${perfDateClause(range).clause}`,
};

/** A performance window: either a trailing `days` count, or an explicit inclusive date range. */
export interface PerfRange {
  days?: number;
  startDate?: string;
  endDate?: string;
}

/** Strict YYYY-MM-DD. GAQL's BETWEEN takes quoted dates in exactly this shape; anything else is a
 *  query error, so a malformed date must fall back rather than reach the wire. */
export function isYmdDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * The segments.date clause for a performance query, plus the human label the tool reports - decided
 * in ONE place so the query and the wording can never disagree.
 *
 * A custom range is honoured only when it is fully valid (both dates YYYY-MM-DD, start <= end);
 * anything else falls back to the fixed trailing window (see clampWindow) instead of erroring, so a
 * model that sends a sloppy range still gets a truthful, labelled answer. BETWEEN is inclusive, and
 * unlike DURING LAST_N it CAN include today - the caller's note must say today's data is partial.
 */
export function perfDateClause(range: PerfRange): { clause: string; label: string; custom: boolean } {
  const { startDate, endDate } = range;
  if (isYmdDate(startDate) && isYmdDate(endDate) && startDate <= endDate) {
    return {
      clause: `segments.date BETWEEN '${startDate}' AND '${endDate}'`,
      label: `${startDate} to ${endDate}`,
      custom: true,
    };
  }
  const n = clampWindow(range.days ?? 30);
  return { clause: `segments.date DURING LAST_${n}_DAYS`, label: `last ${n} days, excluding today`, custom: false };
}

/** Google Ads only accepts a fixed set of LAST_N_DAYS windows; anything else is a query error rather
 *  than a nearest match, so snap to the closest supported one instead of passing the number through. */
export function clampWindow(days: number): 7 | 14 | 30 {
  const allowed: Array<7 | 14 | 30> = [7, 14, 30];
  const n = Number.isFinite(days) ? days : 30;
  return allowed.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best), 30);
}

export interface CreateConversionActionInput {
  name: string;
  category: string;
  countingType?: string;
  valueSettings?: { defaultValue?: number; defaultCurrencyCode?: string; alwaysUseDefaultValue?: boolean };
}

// Google's editorial guidance, restated as data. A lead is one human no matter how many times they
// resubmit the form after a single click, whereas a purchase can genuinely repeat inside the same
// click's conversion window. The API enforces NONE of this: it accepts either counting type for any
// category and defaults brand new actions to MANY_PER_CLICK. So this is a suggestion the create
// form must pre-select and the user must be free to override, not a validation rule.
const ONE_PER_CLICK_CATEGORIES = new Set<string>([
  'SUBMIT_LEAD_FORM',
  'SIGNUP',
  'CONTACT',
  'PHONE_CALL_LEAD',
  'BOOK_APPOINTMENT',
  'REQUEST_QUOTE',
  'DOWNLOAD',
]);
const MANY_PER_CLICK_CATEGORIES = new Set<string>(['PURCHASE', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'SUBSCRIBE_PAID']);

export function defaultCountingType(category: string): string {
  const key = String(category ?? '').trim().toUpperCase();
  if (ONE_PER_CLICK_CATEGORIES.has(key)) return 'ONE_PER_CLICK';
  if (MANY_PER_CLICK_CATEGORIES.has(key)) return 'MANY_PER_CLICK';
  // Unrecognized category (a newly added enum, or one read back off an existing action): fall back
  // to what the API itself would have chosen, so we never quietly disagree with the server default.
  return 'MANY_PER_CLICK';
}

// What the create form's dropdown renders. DOWNLOAD is intentionally absent even though it is in
// the counting map above: Google restricts the DOWNLOAD category to conversion actions of type
// GOOGLE_PLAY_DOWNLOAD, and everything this module creates is type WEBPAGE, so offering it would
// hand the user a combination the API rejects. It stays in the map because an existing app action
// read back through GAQL can legitimately carry it.
export const CONVERSION_CATEGORIES: Array<{ value: string; label: string; counting: string }> = [
  { value: 'SUBMIT_LEAD_FORM', label: 'Submit lead form', counting: 'ONE_PER_CLICK' },
  { value: 'CONTACT', label: 'Contact', counting: 'ONE_PER_CLICK' },
  { value: 'PHONE_CALL_LEAD', label: 'Phone call lead', counting: 'ONE_PER_CLICK' },
  { value: 'BOOK_APPOINTMENT', label: 'Book appointment', counting: 'ONE_PER_CLICK' },
  { value: 'REQUEST_QUOTE', label: 'Request quote', counting: 'ONE_PER_CLICK' },
  { value: 'SIGNUP', label: 'Sign-up', counting: 'ONE_PER_CLICK' },
  { value: 'PURCHASE', label: 'Purchase', counting: 'MANY_PER_CLICK' },
  { value: 'ADD_TO_CART', label: 'Add to cart', counting: 'MANY_PER_CLICK' },
  { value: 'BEGIN_CHECKOUT', label: 'Begin checkout', counting: 'MANY_PER_CLICK' },
  { value: 'SUBSCRIBE_PAID', label: 'Subscribe (paid)', counting: 'MANY_PER_CLICK' },
];

/**
 * Drops sub-fields the user left blank rather than sending them as null/0. Note the trap this does
 * NOT solve: alwaysUseDefaultValue true with no defaultValue records every conversion as zero, and
 * the API accepts it happily, so the form has to catch that before it gets here.
 */
function valueSettingsBody(
  v: CreateConversionActionInput['valueSettings'],
): Record<string, unknown> | null {
  if (!v) return null;
  const out: Record<string, unknown> = {};
  if (typeof v.defaultValue === 'number' && Number.isFinite(v.defaultValue)) out.defaultValue = v.defaultValue;
  if (typeof v.defaultCurrencyCode === 'string' && v.defaultCurrencyCode.trim()) {
    out.defaultCurrencyCode = v.defaultCurrencyCode.trim().toUpperCase();
  }
  if (typeof v.alwaysUseDefaultValue === 'boolean') out.alwaysUseDefaultValue = v.alwaysUseDefaultValue;
  return Object.keys(out).length ? out : null;
}

export function createConversionActionBody(
  input: CreateConversionActionInput,
  validateOnly: boolean,
): Record<string, unknown> {
  const category = String(input.category ?? '').trim().toUpperCase();
  const create: Record<string, unknown> = {
    name: String(input.name ?? '').trim(),
    // WEBPAGE is the only type that makes Google mint a tag snippet, and the snippet is the entire
    // point: the GTM awct tag cannot be built without the conversion id and label that only
    // tag_snippets carries. UPLOAD_CLICKS and the app types produce an action whose tag_snippets is
    // permanently empty, so nothing in GTM could ever fire it.
    type: 'WEBPAGE',
    category,
    status: 'ENABLED',
    countingType: input.countingType
      ? String(input.countingType).trim().toUpperCase()
      : defaultCountingType(category),
  };
  const vs = valueSettingsBody(input.valueSettings);
  if (vs) create.valueSettings = vs;

  // attributionModelSettings is omitted on purpose and must stay omitted. Rule-based models are
  // rejected outright by the API, and DATA_DRIVEN fails on a brand new action because it has no
  // conversion history to model from. Letting Google apply its own default is the only shape that
  // creates cleanly; attribution can be changed later, once the action has data.
  return {
    operations: [{ create }],
    // false makes the batch transactional: a bad operation fails the whole call loudly instead of
    // half-succeeding and leaving the user to reconcile which action actually exists.
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}
