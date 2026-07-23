// Pure REST-shape layer for the Google Ads API: URLs, headers, GAQL strings and request bodies.
// Deliberately I/O-free so every shape below is assertable from a literal in the test file; the
// transport (fetch, OAuth bearer, retry, quota backoff) lives in the caller.
//
// Google pins the API version in the URL PATH rather than a header, and every version has a
// published sunset date after which requests hard-fail, so the constant below is the single place
// to bump. v24 is current at the time of writing.

// node:crypto is used ONLY for SHA-256 hashing of upload identifiers (deterministic compute, no
// I/O) - the "I/O-free" rule above still holds: nothing here touches network or disk.
import { createHash } from 'node:crypto';

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
  changeEvents: (startDate: string, endDate: string, limit: number) => string;
  conversionVolume: (range: PerfRange) => string;
  utmCustomer: string;
  utmCampaigns: string;
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

  // "Who changed what, right before the drop". change_event HARD-REQUIRES a finite date predicate on
  // change_date_time AND a LIMIT, and only covers the LAST 30 DAYS - all three constraints are
  // enforced HERE (clamped dates arrive from the service, the limit is clamped below) so a caller
  // can never assemble the query the API rejects. The end date gets 23:59:59 appended because
  // change_date_time is a DATETIME: a bare end date would exclude everything after midnight of that
  // day, silently dropping the most recent (most interesting) changes.
  changeEvents: (startDate: string, endDate: string, limit: number): string =>
    'SELECT change_event.change_date_time, change_event.user_email, change_event.client_type, change_event.change_resource_type, change_event.resource_change_operation, change_event.changed_fields, change_event.change_resource_name, campaign.name ' +
    `FROM change_event WHERE change_event.change_date_time >= '${startDate}' AND change_event.change_date_time <= '${endDate} 23:59:59' ` +
    `ORDER BY change_event.change_date_time DESC LIMIT ${clampChangeLimit(limit)}`,

  // Conversions per ACTION per DAY. Segmenting by conversion_action means a row exists only where at
  // least one conversion was recorded - an enabled action with NO row over the range is the "tag may
  // be dead" signal (or simply no ads ran; the caller must say which it cannot distinguish).
  conversionVolume: (range: PerfRange): string =>
    'SELECT segments.date, segments.conversion_action, segments.conversion_action_name, metrics.all_conversions ' +
    `FROM campaign WHERE ${perfDateClause(range).clause}`,

  // UTM plumbing, account level: auto-tagging + the account-wide tracking template / suffix.
  utmCustomer:
    'SELECT customer.id, customer.auto_tagging_enabled, customer.tracking_url_template, customer.final_url_suffix FROM customer',

  // UTM plumbing, campaign level: per-campaign template/suffix overrides. Ad-level templates exist
  // too but are deliberately NOT read here (thousands of rows on a big account); the audit says so.
  utmCampaigns:
    "SELECT campaign.id, campaign.name, campaign.status, campaign.tracking_url_template, campaign.final_url_suffix FROM campaign WHERE campaign.status = 'ENABLED'",
};

/** change_event refuses LIMIT-less queries and caps at 10000; default is a readable page. */
export function clampChangeLimit(limit: number): number {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 200;
  return Math.min(10_000, Math.max(1, n > 0 ? n : 200));
}

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

/* ── Phase D: data-in uploads (offline conversions, adjustments, customer match) ──────────
 * All uploads are LIVE writes to the advertising account. Unlike conversionActions:mutate above,
 * the upload endpoints REQUIRE partial_failure=true - the API rejects a transactional batch - so
 * per-row failures are a first-class result the caller must surface, never swallow. */

/** SHA-256 hex of a NORMALIZED email (trim, lowercase, and for gmail/googlemail strip dots in the
 *  local part - Google's documented normalization; a hash of the un-normalized form never matches). */
export function hashEmail(email: string): string {
  let e = String(email ?? '').trim().toLowerCase();
  const m = /^([^@]+)@(gmail|googlemail)\.com$/.exec(e);
  if (m) e = `${m[1].replace(/\./g, '')}@${m[2]}.com`;
  return createHash('sha256').update(e).digest('hex');
}

/** SHA-256 hex of an E.164 phone number ("+" + digits). Anything else is normalized to digits with a
 *  leading +; a number without a country code cannot be safely guessed, so it is hashed as given
 *  (Google will simply not match it - honest failure beats a fabricated country code). */
export function hashPhone(phone: string): string {
  const digitsOnly = String(phone ?? '').replace(/[^\d+]/g, '');
  const e164 = digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`;
  return createHash('sha256').update(e164).digest('hex');
}

/** 'yyyy-MM-dd HH:mm:ss±HH:mm' - the upload endpoints REQUIRE the timezone offset; a bare local
 *  datetime is rejected (or worse, silently attributed to the wrong day). */
export function isAdsDateTime(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(s);
}

/** EEA/DMA consent that MUST ride on every uploaded record. The tool schema requires the caller to
 *  state it explicitly - defaulting it would fabricate a legal signal. */
export interface AdsConsent {
  adUserData: 'GRANTED' | 'DENIED' | 'UNSPECIFIED';
  adPersonalization: 'GRANTED' | 'DENIED' | 'UNSPECIFIED';
}

export function uploadClickConversionsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}:uploadClickConversions`;
}
export function uploadConversionAdjustmentsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}:uploadConversionAdjustments`;
}
export function offlineUserDataJobsUrl(customerId: string, suffix: 'create' | '' = ''): string {
  const base = `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/offlineUserDataJobs`;
  return suffix === 'create' ? `${base}:create` : base;
}
export function offlineUserDataJobOpUrl(jobResourceName: string, op: 'addOperations' | 'run'): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/${jobResourceName}:${op}`;
}

export interface ClickConversionInput {
  /** The click id from auto-tagging; OR omit and provide email/phone (enhanced conversions for leads). */
  gclid?: string;
  /** Plain email/phone - hashed HERE with Google's normalization; the plaintext never leaves the app. */
  email?: string;
  phone?: string;
  conversionActionResource: string;
  conversionDateTime: string;
  conversionValue?: number;
  currencyCode?: string;
  orderId?: string;
}

/** :uploadClickConversions body. partialFailure is FORCED true (the endpoint requires it). */
export function buildClickConversionsBody(conversions: ClickConversionInput[], consent: AdsConsent): Record<string, unknown> {
  return {
    conversions: conversions.map((c) => ({
      ...(c.gclid ? { gclid: c.gclid } : {}),
      conversionAction: c.conversionActionResource,
      conversionDateTime: c.conversionDateTime,
      ...(typeof c.conversionValue === 'number' && Number.isFinite(c.conversionValue) ? { conversionValue: c.conversionValue } : {}),
      ...(c.currencyCode ? { currencyCode: c.currencyCode.trim().toUpperCase() } : {}),
      ...(c.orderId ? { orderId: c.orderId } : {}),
      ...(c.email || c.phone
        ? {
            userIdentifiers: [
              ...(c.email ? [{ hashedEmail: hashEmail(c.email) }] : []),
              ...(c.phone ? [{ hashedPhoneNumber: hashPhone(c.phone) }] : []),
            ],
          }
        : {}),
      consent,
    })),
    partialFailure: true,
  };
}

export interface ConversionAdjustmentInput {
  conversionActionResource: string;
  adjustmentType: 'RETRACTION' | 'RESTATEMENT';
  adjustmentDateTime: string;
  /** Identify the original conversion: by order id (preferred), or gclid + its conversionDateTime. */
  orderId?: string;
  gclid?: string;
  conversionDateTime?: string;
  /** RESTATEMENT only: the corrected value. */
  restatedValue?: number;
  currencyCode?: string;
}

/** :uploadConversionAdjustments body. partialFailure forced true, same as conversions. */
export function buildConversionAdjustmentsBody(adjustments: ConversionAdjustmentInput[]): Record<string, unknown> {
  return {
    conversionAdjustments: adjustments.map((a) => ({
      conversionAction: a.conversionActionResource,
      adjustmentType: a.adjustmentType,
      adjustmentDateTime: a.adjustmentDateTime,
      ...(a.orderId ? { orderId: a.orderId } : {}),
      ...(a.gclid && a.conversionDateTime
        ? { gclidDateTimePair: { gclid: a.gclid, conversionDateTime: a.conversionDateTime } }
        : {}),
      ...(a.adjustmentType === 'RESTATEMENT' && typeof a.restatedValue === 'number' && Number.isFinite(a.restatedValue)
        ? { restatementValue: { adjustedValue: a.restatedValue, ...(a.currencyCode ? { currencyCode: a.currencyCode.trim().toUpperCase() } : {}) } }
        : {}),
    })),
    partialFailure: true,
  };
}

/** offlineUserDataJobs:create body for a Customer Match list refresh. Consent lives in the JOB
 *  metadata (per-job, not per-identifier). */
export function buildCustomerMatchJobBody(userListResource: string, consent: AdsConsent): Record<string, unknown> {
  return {
    job: {
      type: 'CUSTOMER_MATCH_USER_LIST',
      customerMatchUserListMetadata: { userList: userListResource, consent },
    },
  };
}

/** :addOperations body - hashed identifiers only; enablePartialFailure so one bad row is reported
 *  rather than sinking the batch. */
export function buildCustomerMatchOpsBody(members: Array<{ email?: string; phone?: string }>): Record<string, unknown> {
  return {
    operations: members
      .map((m) => ({
        create: {
          userIdentifiers: [
            ...(m.email ? [{ hashedEmail: hashEmail(m.email) }] : []),
            ...(m.phone ? [{ hashedPhoneNumber: hashPhone(m.phone) }] : []),
          ],
        },
      }))
      .filter((op) => op.create.userIdentifiers.length > 0),
    enablePartialFailure: true,
  };
}

/* ── Phase E: structure reads, one GAQL per view ─────────────────────────────────────────── */

export type AdsStructureView = 'keywords' | 'search_terms' | 'landing_pages' | 'ads';

export const STRUCTURE_GAQL: Record<AdsStructureView, (range: PerfRange) => string> = {
  // Quality score + its three components are ATTRIBUTES (no date range needed); metrics would turn
  // rows into keyword-days, so this stays a pure config/quality read.
  keywords: () =>
    'SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ' +
    'ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score, ' +
    'ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr ' +
    "FROM keyword_view WHERE ad_group_criterion.status != 'REMOVED' LIMIT 500",
  // Search terms are metric rows, so they take the shared date clause. Privacy thresholds hide
  // low-volume terms - the tool note says so, or totals get chased against campaign clicks forever.
  search_terms: (range) =>
    'SELECT search_term_view.search_term, search_term_view.status, campaign.name, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros ' +
    `FROM search_term_view WHERE ${perfDateClause(range).clause} ORDER BY metrics.clicks DESC LIMIT 500`,
  landing_pages: (range) =>
    'SELECT landing_page_view.unexpanded_final_url, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    `FROM landing_page_view WHERE ${perfDateClause(range).clause} ORDER BY metrics.clicks DESC LIMIT 500`,
  ads: () =>
    'SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.ad_strength, ad_group_ad.ad.final_urls ' +
    "FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' LIMIT 500",
};

/* ── Phase F: reversible account writes (campaign status, budget, negatives, list create,
 * conversion-action update). Every mutate here supports validateOnly (dry-run first, like the
 * conversion-action create) and partialFailure:false (transactional - a bad op fails loudly).
 * The SERVICE reads the previous value before each update so the tool can hand back a ready-made
 * revert call; a write whose old value was never captured is a write that cannot be undone. */

export function mutateCampaignsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/campaigns:mutate`;
}
export function mutateCampaignBudgetsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/campaignBudgets:mutate`;
}
export function mutateCampaignCriteriaUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/campaignCriteria:mutate`;
}
export function mutateUserListsUrl(customerId: string): string {
  return `${ADS_BASE}/${ADS_API_VERSION}/customers/${normalizeCustomerId(customerId)}/userLists:mutate`;
}

/** Single-campaign / single-budget lookups - the previous-value read every reversible write does. */
export function campaignByIdGaql(campaignId: string): string {
  return `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id = ${normalizeCustomerId(campaignId)}`;
}
export function budgetByIdGaql(budgetId: string): string {
  return `SELECT campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign_budget WHERE campaign_budget.id = ${normalizeCustomerId(budgetId)}`;
}

/** Campaign status flip (ENABLED <-> PAUSED). The mask names ONLY status, so nothing else can drift. */
export function buildCampaignStatusBody(campaignResource: string, status: 'ENABLED' | 'PAUSED', validateOnly: boolean): Record<string, unknown> {
  return {
    operations: [{ update: { resourceName: campaignResource, status }, updateMask: 'status' }],
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}

/** Daily budget amount update (micros). */
export function buildCampaignBudgetBody(budgetResource: string, amountMicros: number, validateOnly: boolean): Record<string, unknown> {
  return {
    operations: [{ update: { resourceName: budgetResource, amountMicros: Math.round(amountMicros) }, updateMask: 'amountMicros' }],
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}

/** The targeted conversion-action update - EXACTLY the fields our own audit findings tell the user
 *  to change (primary/secondary, counting, status, default value), nothing else. The mask is built
 *  from the fields actually supplied, so an omitted field can never be clobbered. */
export interface ConversionActionPatch {
  primaryForGoal?: boolean;
  countingType?: 'ONE_PER_CLICK' | 'MANY_PER_CLICK';
  status?: 'ENABLED' | 'PAUSED';
  defaultValue?: number;
  defaultCurrencyCode?: string;
}
export function buildConversionActionUpdateBody(actionResource: string, patch: ConversionActionPatch, validateOnly: boolean): Record<string, unknown> {
  const update: Record<string, unknown> = { resourceName: actionResource };
  const mask: string[] = [];
  if (patch.primaryForGoal !== undefined) { update.primaryForGoal = patch.primaryForGoal; mask.push('primaryForGoal'); }
  if (patch.countingType) { update.countingType = patch.countingType; mask.push('countingType'); }
  if (patch.status) { update.status = patch.status; mask.push('status'); }
  if (patch.defaultValue !== undefined || patch.defaultCurrencyCode) {
    update.valueSettings = {
      ...(patch.defaultValue !== undefined ? { defaultValue: patch.defaultValue } : {}),
      ...(patch.defaultCurrencyCode ? { defaultCurrencyCode: patch.defaultCurrencyCode.trim().toUpperCase() } : {}),
    };
    if (patch.defaultValue !== undefined) mask.push('valueSettings.defaultValue');
    if (patch.defaultCurrencyCode) mask.push('valueSettings.defaultCurrencyCode');
  }
  return {
    operations: [{ update, updateMask: mask.join(',') }],
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}

/** Campaign-level negative keywords. Transactional: one bad keyword fails the batch loudly. */
export function buildNegativeKeywordsBody(campaignResource: string, keywords: Array<{ text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }>, validateOnly: boolean): Record<string, unknown> {
  return {
    operations: keywords.map((k) => ({
      create: { campaign: campaignResource, negative: true, keyword: { text: k.text.trim(), matchType: k.matchType } },
    })),
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}

/** A CRM-based Customer Match list (CONTACT_INFO uploads - emails/phones), the target the
 *  upload_google_ads_customer_match tool needs when none exists yet. */
export function buildUserListCreateBody(name: string, membershipLifeSpanDays: number | undefined, validateOnly: boolean): Record<string, unknown> {
  const days = Number.isFinite(membershipLifeSpanDays) ? Math.min(540, Math.max(0, Math.floor(membershipLifeSpanDays as number))) : 180;
  return {
    operations: [{ create: { name: name.trim(), membershipLifeSpan: days, crmBasedUserList: { uploadKeyType: 'CONTACT_INFO' } } }],
    partialFailure: false,
    validateOnly: Boolean(validateOnly),
  };
}

/** Audiences / user lists - sizes + membership status so remarketing-tag population is verifiable. */
export const USER_LISTS_GAQL =
  'SELECT user_list.id, user_list.name, user_list.type, user_list.membership_status, user_list.membership_life_span, ' +
  'user_list.size_for_display, user_list.size_for_search, user_list.read_only, user_list.match_rate_percentage ' +
  'FROM user_list ORDER BY user_list.name';
