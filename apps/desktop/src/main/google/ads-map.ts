/**
 * Pure mapping layer for the Google Ads API (REST, pinned at v24). Raw searchStream JSON
 * goes in, app DTOs come out. Nothing here does I/O, because the one thing this feature
 * can get catastrophically wrong (pairing a conversion id with the wrong label) has to be
 * provable from literals in a test rather than from a live account nobody can reproduce.
 *
 * CASING: REST responses are lowerCamelCase (conversionAction.tagSnippets,
 * customerClient.descriptiveName) while GAQL, the .proto files, and every code sample on
 * developers.google.com are snake_case (conversion_action.tag_snippets). Rows also reach us
 * second-hand from fixtures and from client libraries that keep the proto casing, so every
 * field read here accepts BOTH spellings. Reading two keys is cheaper than being wrong once.
 *
 * INT64: proto3 JSON encodes int64/uint64 as a STRING, so customerClient.id arrives as
 * "1234567890" and level as "1" even though the proto declares them numeric. Both forms are
 * accepted and normalized here.
 */

// ── low-level readers ────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

function toSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** Read `camelName` from an object, falling back to its snake_case spelling. See CASING above. */
function get(obj: unknown, camelName: string): unknown {
  const rec = asRecord(obj);
  if (!rec) return undefined;
  const direct = rec[camelName];
  if (direct !== undefined && direct !== null) return direct;
  const alt = rec[toSnake(camelName)];
  return alt === null ? undefined : alt;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function optionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

/**
 * Normalize a customer id to bare digits. Google prints ids as 123-456-7890 in the UI, but
 * the `login-customer-id` header and every `customers/{id}` path segment reject the dashes,
 * so a stray formatted id copied from the UI would 400 the whole request.
 */
function digits(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== 'string') return null;
  const only = value.replace(/[^0-9]/g, '');
  return only.length > 0 ? only : null;
}

/**
 * Pull the customer id out of a `customers/{id}` resource name. Bare digits are accepted too
 * so a caller that already unwrapped the name does not silently get null.
 */
function customerIdFromResourceName(resourceName: string | null): string | null {
  if (!resourceName) return null;
  const trimmed = resourceName.trim();
  const match = /^customers\/(\d+)/.exec(trimmed);
  if (match) return match[1];
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

// ── DTOs ─────────────────────────────────────────────────────────────────────────────────

export interface AdsAccount {
  id: string;
  name: string;
  manager: boolean;
  level: number;
  status: string;
  /** Hidden in the manager's account tree. Carried so the picker can grey it out rather than
   *  drop it: an account the user is looking for must never silently vanish from the list. */
  hidden: boolean;
  /** A Google Ads TEST account. Load-bearing, not decoration: a developer token that only has
   *  Test Account Access can read these and nothing else, and hitting a production account with
   *  one is the DEVELOPER_TOKEN_NOT_APPROVED failure. Showing the flag up front beats explaining
   *  that error after the fact. */
  testAccount: boolean;
  currencyCode?: string;
  timeZone?: string;
  /** The manager id this account must be reached THROUGH, if any. */
  loginCustomerId?: string;
}

export interface AdsConversionAction {
  resourceName: string;
  id: string;
  name: string;
  status: string;
  type: string;
  category: string;
  ownerCustomer?: string;
  primaryForGoal?: boolean;
  /** ONE_PER_CLICK / MANY_PER_CLICK - how repeat conversions inside a click's window count. */
  countingType?: string;
  /** Attribution + windows + value settings - the config a conversion audit reads. Present only when
   *  the API returned them (older fixtures and minimal rows simply omit them). */
  attributionModel?: string;
  dataDrivenModelStatus?: string;
  clickLookbackDays?: number;
  viewLookbackDays?: number;
  defaultValue?: number;
  defaultCurrencyCode?: string;
  alwaysUseDefaultValue?: boolean;
  /** Parsed from THIS action's own tag snippet. null when the action has no web snippet. */
  conversionId: string | null;
  conversionLabel: string | null;
  /** False when this action can never drive a GTM awct tag (no snippet: upload/app/store/GA4 types). */
  taggable: boolean;
  /** Human explanation when taggable is false, or when the snippet parsed oddly. */
  note?: string;
}

export interface ConversionCustomer {
  conversionCustomerId: string | null;
  status: string;
  trackingId: string | null;
  crossAccountTrackingId: string | null;
  /** True when conversion actions live on a DIFFERENT customer than the one queried. */
  isCrossAccount: boolean;
  /** customer.auto_tagging_enabled - whether ad clicks carry a GCLID at all. undefined when the row
   *  predates this field (old fixtures) so "unknown" is never reported as "off". */
  autoTaggingEnabled?: boolean;
}

// ── conversion identity (the high-risk part) ─────────────────────────────────────────────

/**
 * The `send_to` value is the ONLY place the conversion label exists. ConversionAction has no
 * label field: Google resolves the pair into the generated event snippet and nothing else.
 * Anchored on `AW-<digits>/` so a Google tag destination id (GT-XXXXXXX) or a GA4 measurement
 * id (G-XXXXXXX) can never be mistaken for a conversion id.
 *
 * The label charset is deliberately [A-Za-z0-9_-]: real labels routinely contain both hyphens
 * and underscores (for example AbC-dEfGh12_34), and stopping at the surrounding quote is what
 * lets the same regex run against a whole multi-line gtag event snippet.
 */
const SEND_TO_RE = /AW-(\d+)\/([A-Za-z0-9_-]+)/;

/** Recovers just the AW- id from a global site tag. See identityFromSnippets for why that is not enough. */
const GLOBAL_SITE_TAG_AW_RE = /AW-(\d+)/;

export function parseSendTo(sendTo: string): { conversionId: string; conversionLabel: string } | null {
  if (typeof sendTo !== 'string') return null;
  const match = SEND_TO_RE.exec(sendTo);
  if (!match) return null;
  // Canonical 'AW-123456789' form: the API's own snippet writes it that way, and a GTM awct
  // tag's conversionId field expects the prefix, so re-adding it downstream is a known trap.
  return { conversionId: `AW-${match[1]}`, conversionLabel: match[2] };
}

/**
 * Last-resort id recovery from a global_site_tag. Never returns a GT- value: the Google tag
 * migration means global_site_tag may load `gtag/js?id=GT-XXXXXXX`, and a GT- destination is
 * NOT a Google Ads conversion id. Putting one in an awct tag yields a tag that fires and
 * records nothing.
 */
function recoverGlobalSiteTagId(tagSnippets: unknown): string | null {
  if (!Array.isArray(tagSnippets)) return null;
  for (const snippet of tagSnippets) {
    const globalSiteTag = str(get(snippet, 'globalSiteTag'));
    if (!globalSiteTag) continue;
    const match = GLOBAL_SITE_TAG_AW_RE.exec(globalSiteTag);
    if (match) return `AW-${match[1]}`;
  }
  return null;
}

/**
 * Resolve one conversion action's id + label from its own tag_snippets array.
 *
 * CRITICAL INVARIANT: both halves come from the SAME event_snippet of the SAME action. Under
 * cross-account conversion tracking a client account can legitimately have its own AW- id and
 * its manager's id live at the same time, so an id taken from one snippet and a label taken
 * from another form a pair Google accepts, fires on, and silently never records. That is why
 * this returns a single object parsed in one shot instead of two independently-sourced fields.
 *
 * Only an event_snippet can yield an identity. The global_site_tag fallback
 * (recoverGlobalSiteTagId, used by mapConversionAction for a diagnostic note) can prove which
 * AW- id the page carries but never the label, and an id with no label cannot configure an
 * awct tag, so half an identity is reported as null rather than handed to a caller that would
 * fill in the rest by guessing.
 */
export function identityFromSnippets(tagSnippets: unknown): { conversionId: string; conversionLabel: string } | null {
  if (!Array.isArray(tagSnippets)) return null;
  for (const snippet of tagSnippets) {
    const eventSnippet = str(get(snippet, 'eventSnippet'));
    if (!eventSnippet) continue;
    const identity = parseSendTo(eventSnippet);
    if (identity) return identity;
  }
  return null;
}

// ── conversion actions ───────────────────────────────────────────────────────────────────

/**
 * Conversion action types that can NEVER carry a website event snippet, so an empty
 * tag_snippets is correct data rather than a fetch bug. Ordered most-specific-first and
 * matched against the enum NAME, which is what proto3 JSON emits for enums.
 *
 * Each entry carries the reason because the UI shows it next to the action: "not taggable"
 * with no explanation reads as a broken integration and generates support tickets.
 */
const UNTAGGABLE_TYPES: ReadonlyArray<{ match: RegExp; note: string }> = [
  {
    match: /^UPLOAD_(CLICKS|CALLS)$/,
    note: 'Offline conversion: it is recorded by uploading clicks or calls to Google Ads, so it has no website snippet and no conversion label.',
  },
  {
    match: /^(STORE_VISITS|STORE_SALES|STORE_SALES_DIRECT_UPLOAD)$/,
    note: 'Store conversion: it is measured from store visits or merchant data uploads, not from a page event, so there is nothing to tag.',
  },
  {
    match: /^(FIREBASE_|THIRD_PARTY_APP_ANALYTICS_|GOOGLE_PLAY_|ANDROID_)/,
    note: 'App conversion: it is measured by the mobile app SDK, not on the website.',
  },
  {
    // WEBSITE_CALL is deliberately NOT here. The other call types are counted by Google from the ad
    // itself and have no website snippet, but a "calls from a website" action DOES publish one: the
    // call-reporting snippet carrying send_to, which is exactly what the GTM awcc (Google Ads Call
    // Conversion) tag consumes to swap the displayed number. Excluding it made the two halves of
    // this app unable to meet - the tag builder existed while the reader refused to hand it a label.
    match: /^(AD_CALL|CLICK_TO_CALL|SMART_CAMPAIGN_)/,
    note: 'Call conversion from ads: it is counted by Google from the call itself, not by a Google Ads conversion tag you can fire from GTM.',
  },
  {
    // FLOODLIGHT_ is spelled out as a prefix WITH a trailing wildcard on purpose. The real enum
    // values are FLOODLIGHT_ACTION and FLOODLIGHT_TRANSACTION; a bare 'FLOODLIGHT_' alternative
    // inside an anchored ^(...)$ group matches only the literal string 'FLOODLIGHT_', which no
    // account ever returns, so both Floodlight types fell through to the generic branch and the UI
    // told the user to "confirm the query selected conversion_action.tag_snippets" about data that
    // was perfectly correct. The other alternatives here are whole enum values, so they keep the
    // anchors.
    match: /^(FLOODLIGHT_[A-Z_]+|SEARCH_ADS_360|SALESFORCE|GOOGLE_HOSTED|LEAD_FORM_SUBMIT)$/,
    note: 'Imported conversion: it originates outside this account, so Google Ads generates no snippet for it.',
  },
  {
    match: /^(GOOGLE_ANALYTICS_4_|UNIVERSAL_ANALYTICS_)/,
    note: 'Analytics-imported conversion: it is owned by the linked Analytics property (which is why it is often status HIDDEN in Google Ads) and has no Google Ads snippet. Fire the underlying GA4 event instead.',
  },
  {
    match: /^WEBPAGE_CODELESS$/,
    note: 'Codeless website conversion: Google measures it without an individually coded event snippet, so there is no label to read.',
  },
];

export function mapConversionAction(row: unknown): AdsConversionAction {
  // Accept either a searchStream result row ({ conversionAction: {...} }) or a bare
  // ConversionAction, because callers hand us both depending on how far they unwrapped.
  const action = asRecord(get(row, 'conversionAction')) ?? asRecord(row) ?? {};

  const resourceName = str(get(action, 'resourceName')) ?? '';
  const idFromResource = /conversionActions\/(\d+)/.exec(resourceName);
  const id = digits(get(action, 'id')) ?? idFromResource?.[1] ?? '';
  const type = (str(get(action, 'type')) ?? 'UNKNOWN').toUpperCase();

  const tagSnippets = get(action, 'tagSnippets');
  const identity = identityFromSnippets(tagSnippets);
  const untaggable = UNTAGGABLE_TYPES.find((entry) => entry.match.test(type));

  let taggable = identity !== null;
  let note: string | undefined;

  if (untaggable) {
    // The type table wins over a parsed identity here: an app or Analytics-owned action can
    // occasionally still expose a snippet, but wiring it to an awct tag records nothing.
    taggable = false;
    note = identity
      ? `${untaggable.note} A conversion id was still readable from its snippet, but this action type cannot be driven by a Google Ads conversion tag.`
      : untaggable.note;
  } else if (!identity) {
    const recovered = recoverGlobalSiteTagId(tagSnippets);
    if (recovered) {
      note = `The site tag on this action reports ${recovered}, but no event snippet carries a send_to, so the conversion label is unknown. Copy the label from this action's event snippet in Google Ads.`;
    } else if (!Array.isArray(tagSnippets) || tagSnippets.length === 0) {
      note = 'Google Ads returned no tag snippets for this action, so no conversion id or label could be read. Confirm the query selected conversion_action.tag_snippets and that this action uses a website snippet.';
    } else {
      note = 'The tag snippets on this action contain no send_to of the form AW-<id>/<label>, so the conversion id and label could not be read.';
    }
  }

  const ownerCustomer = customerIdFromResourceName(str(get(action, 'ownerCustomer')));
  const primaryForGoal = optionalBool(get(action, 'primaryForGoal'));

  // Attribution + windows + value settings. Doubles arrive as numbers, int64s as strings; a value
  // that cannot be read is simply absent rather than 0 (0 is a meaningful default value).
  const countingType = str(get(action, 'countingType'))?.toUpperCase();
  const ams = asRecord(get(action, 'attributionModelSettings'));
  const attributionModel = str(get(ams, 'attributionModel'))?.toUpperCase();
  const dataDrivenModelStatus = str(get(ams, 'dataDrivenModelStatus'))?.toUpperCase();
  const clickLookbackDays = toInt(get(action, 'clickThroughLookbackWindowDays'));
  const viewLookbackDays = toInt(get(action, 'viewThroughLookbackWindowDays'));
  const vs = asRecord(get(action, 'valueSettings'));
  const rawDefault = get(vs, 'defaultValue');
  const defaultValue =
    typeof rawDefault === 'number' && Number.isFinite(rawDefault)
      ? rawDefault
      : typeof rawDefault === 'string' && rawDefault.trim() !== '' && Number.isFinite(Number(rawDefault))
        ? Number(rawDefault)
        : undefined;
  const defaultCurrencyCode = str(get(vs, 'defaultCurrencyCode'))?.toUpperCase();
  const alwaysUseDefaultValue = optionalBool(get(vs, 'alwaysUseDefaultValue'));

  return {
    resourceName,
    id,
    name: str(get(action, 'name')) ?? (id ? `Conversion action ${id}` : 'Unnamed conversion action'),
    status: (str(get(action, 'status')) ?? 'UNKNOWN').toUpperCase(),
    type,
    category: (str(get(action, 'category')) ?? 'UNKNOWN').toUpperCase(),
    ...(ownerCustomer ? { ownerCustomer } : {}),
    ...(primaryForGoal === undefined ? {} : { primaryForGoal }),
    ...(countingType ? { countingType } : {}),
    ...(attributionModel ? { attributionModel } : {}),
    ...(dataDrivenModelStatus ? { dataDrivenModelStatus } : {}),
    ...(clickLookbackDays !== null ? { clickLookbackDays } : {}),
    ...(viewLookbackDays !== null ? { viewLookbackDays } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(defaultCurrencyCode ? { defaultCurrencyCode } : {}),
    ...(alwaysUseDefaultValue !== undefined ? { alwaysUseDefaultValue } : {}),
    conversionId: identity?.conversionId ?? null,
    conversionLabel: identity?.conversionLabel ?? null,
    taggable,
    ...(note ? { note } : {}),
  };
}

/**
 * Config warnings computable from the action LIST alone - no metrics needed.
 *
 * The classic paid-for finding: a GA4-IMPORTED conversion and a WEBSITE (WEBPAGE) action of the
 * same category BOTH counting as primary records each real conversion twice in the "Conversions"
 * column and in Smart Bidding. `primary_for_goal` defaults to true when absent, so undefined is
 * treated as primary. Also flags always-use-default-value with NO default value set - the API
 * accepts it and every conversion then records as zero.
 */
export function conversionSetupWarnings(actions: AdsConversionAction[]): string[] {
  const isPrimary = (a: AdsConversionAction): boolean => a.primaryForGoal !== false && a.status === 'ENABLED';
  const out: string[] = [];
  const ga4 = actions.filter((a) => /^GOOGLE_ANALYTICS_4_/.test(a.type) && isPrimary(a));
  const web = actions.filter((a) => a.type === 'WEBPAGE' && isPrimary(a));
  for (const g of ga4) {
    for (const w of web) {
      if (g.category !== w.category || g.category === 'UNKNOWN') continue;
      out.push(
        `Possible double counting: the GA4-imported action "${g.name}" and the website action "${w.name}" are BOTH primary in category ${g.category}, so each real conversion can be recorded twice (in reporting AND in Smart Bidding). Make one of them secondary in Google Ads (Goals > Conversions > edit > "Secondary action").`,
      );
    }
  }
  for (const a of actions) {
    if (a.alwaysUseDefaultValue === true && (a.defaultValue === undefined || a.defaultValue === 0) && a.status === 'ENABLED') {
      out.push(
        `"${a.name}" is set to ALWAYS use its default value, but no non-zero default value is configured - every conversion it records has value 0. Set a default value, or stop forcing it.`,
      );
    }
  }
  return out;
}

// ── account tree ─────────────────────────────────────────────────────────────────────────

/**
 * Flatten customer_client rows into the account list the picker renders.
 *
 * Dedupes on id: one client can be linked under two managers in the same hierarchy, so the
 * same account legitimately comes back twice (with different `level` values) and would
 * otherwise show up as a duplicate row the user cannot tell apart.
 *
 * `loginCustomerId` is stamped onto EVERY row, including the queried account itself. Google
 * only requires the header for manager-mediated requests but accepts it otherwise, so a
 * caller can send it unconditionally instead of re-deriving which accounts need it.
 */
export function buildAccountTree(rows: unknown[], loginCustomerId?: string): AdsAccount[] {
  const login = loginCustomerId ? digits(loginCustomerId) : null;
  const byId = new Map<string, AdsAccount>();
  const hasRealName = new Set<string>();

  for (const row of Array.isArray(rows) ? rows : []) {
    const client = asRecord(get(row, 'customerClient')) ?? asRecord(get(row, 'customer')) ?? asRecord(row);
    if (!client) continue;

    // Never derive the id from customerClient.resourceName: that is
    // customers/{manager}/customerClients/{client}, so its first segment is the MANAGER.
    const id = digits(get(client, 'id')) ?? customerIdFromResourceName(str(get(client, 'clientCustomer')));
    if (!id) continue;

    const descriptiveName = str(get(client, 'descriptiveName'));
    const currencyCode = str(get(client, 'currencyCode'));
    const timeZone = str(get(client, 'timeZone'));
    const account: AdsAccount = {
      id,
      name: descriptiveName ?? `Account ${id}`,
      manager: optionalBool(get(client, 'manager')) ?? false,
      level: toInt(get(client, 'level')) ?? 0,
      status: (str(get(client, 'status')) ?? 'UNKNOWN').toUpperCase(),
      hidden: optionalBool(get(client, 'hidden')) ?? false,
      testAccount: optionalBool(get(client, 'testAccount')) ?? false,
      ...(currencyCode ? { currencyCode } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(login ? { loginCustomerId: login } : {}),
    };

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, account);
      if (descriptiveName) hasRealName.add(id);
      continue;
    }
    // Merge the duplicate rather than dropping it: keep the shallowest link (level counts hops
    // from the queried customer) and let a later row fill any field the first one left blank.
    if (account.level < existing.level) existing.level = account.level;
    if (!existing.currencyCode && account.currencyCode) existing.currencyCode = account.currencyCode;
    if (!existing.timeZone && account.timeZone) existing.timeZone = account.timeZone;
    if (descriptiveName && !hasRealName.has(id)) {
      existing.name = descriptiveName;
      hasRealName.add(id);
    }
    existing.manager = existing.manager || account.manager;
    // hidden is a property of the LINK, not of the account: the same client can be hidden under one
    // manager and visible under another, so it stays hidden only if every link hides it. Erring
    // toward visible is the safe direction, since the cost of greying out an account the user wanted
    // is worse than showing one they had tucked away.
    existing.hidden = existing.hidden && account.hidden;
    // test_account is a property of the ACCOUNT itself, so any row asserting it is authoritative.
    existing.testAccount = existing.testAccount || account.testAccount;
  }

  return [...byId.values()].sort((a, b) => {
    if (a.manager !== b.manager) return a.manager ? -1 : 1;
    const byName = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    return byName !== 0 ? byName : a.id.localeCompare(b.id);
  });
}

// ── conversion tracking ownership ────────────────────────────────────────────────────────

/**
 * Work out WHERE this customer's conversion actions actually live.
 *
 * google_ads_conversion_customer is a RESOURCE NAME string ('customers/{id}'), unlike
 * conversion_tracking_id and cross_account_conversion_tracking_id which are int64 (and so
 * arrive as JSON strings of digits). Treating the resource name as an id is the classic bug
 * here: you end up querying conversion actions on a customer named "customers".
 *
 * conversion_tracking_status is RELATIVE to the login-customer-id used for the request, not
 * absolute. The same account reports CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER through the
 * manager that owns its conversions and CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER
 * through any other manager. MANAGED_BY_ANOTHER_MANAGER is therefore a normal, healthy state
 * and is never surfaced as an error: it just means the caller should re-query the conversion
 * actions on conversionCustomerId instead.
 */
export function resolveConversionCustomer(row: unknown, queriedCustomerId: string): ConversionCustomer {
  // Accept a full result row, a bare Customer, or the ConversionTrackingSetting on its own.
  const wrapped = asRecord(get(row, 'customer')) ?? asRecord(row);
  const setting = asRecord(get(wrapped, 'conversionTrackingSetting')) ?? wrapped ?? {};

  const conversionCustomerId = customerIdFromResourceName(str(get(setting, 'googleAdsConversionCustomer')));
  const queried = digits(queriedCustomerId);

  // A conversion tracking id of 0 is the "unset" sentinel proto3 emits for an absent int64,
  // never a real account, so it is reported as null instead of a plausible-looking "0".
  const trackingIdRaw = digits(get(setting, 'conversionTrackingId'));
  const crossAccountRaw = digits(get(setting, 'crossAccountConversionTrackingId'));

  // auto_tagging_enabled lives on the CUSTOMER, not inside conversion_tracking_setting.
  const autoTaggingEnabled = optionalBool(get(wrapped, 'autoTaggingEnabled'));

  return {
    conversionCustomerId,
    status: (str(get(setting, 'conversionTrackingStatus')) ?? 'UNKNOWN').toUpperCase(),
    trackingId: trackingIdRaw && trackingIdRaw !== '0' ? trackingIdRaw : null,
    crossAccountTrackingId: crossAccountRaw && crossAccountRaw !== '0' ? crossAccountRaw : null,
    isCrossAccount: conversionCustomerId !== null && queried !== null && conversionCustomerId !== queried,
    ...(autoTaggingEnabled === undefined ? {} : { autoTaggingEnabled }),
  };
}

/** One campaign as the chat needs it. Money is kept in MICROS exactly as the API returns it and is
 *  converted at the presentation boundary only: rounding to a currency unit here would quietly lose
 *  the fractional bids that Ads reports, and a number that has already been divided is impossible to
 *  tell from one that has not. */
export interface AdsCampaign {
  id: string;
  name: string;
  status: string;
  channelType: string;
  channelSubType?: string;
  startDate?: string;
  endDate?: string;
  biddingStrategyType?: string;
  budget?: {
    id: string;
    amountMicros: number;
    /** A shared budget backs SEVERAL campaigns, so its amount is not this campaign's alone. */
    shared: boolean;
  };
}

export function mapCampaign(row: unknown): AdsCampaign {
  const c = asRecord(get(row, 'campaign')) ?? asRecord(row) ?? {};
  const b = asRecord(get(row, 'campaignBudget'));
  const amount = b ? toInt(get(b, 'amountMicros')) : null;
  const budgetId = b ? digits(get(b, 'id')) : null;
  return {
    id: digits(get(c, 'id')) ?? '',
    name: str(get(c, 'name')) ?? '',
    status: (str(get(c, 'status')) ?? 'UNKNOWN').toUpperCase(),
    channelType: (str(get(c, 'advertisingChannelType')) ?? 'UNKNOWN').toUpperCase(),
    ...(str(get(c, 'advertisingChannelSubType')) ? { channelSubType: (str(get(c, 'advertisingChannelSubType')) as string).toUpperCase() } : {}),
    ...(str(get(c, 'startDate')) ? { startDate: str(get(c, 'startDate')) as string } : {}),
    ...(str(get(c, 'endDate')) ? { endDate: str(get(c, 'endDate')) as string } : {}),
    ...(str(get(c, 'biddingStrategyType')) ? { biddingStrategyType: (str(get(c, 'biddingStrategyType')) as string).toUpperCase() } : {}),
    ...(budgetId !== null && amount !== null
      ? { budget: { id: budgetId, amountMicros: amount, shared: optionalBool(get(b, 'explicitlyShared')) === true } }
      : {}),
  };
}

/** Per-campaign metrics over a window. Every count is a plain number; only cost is in micros. */
export interface AdsCampaignPerformance {
  id: string;
  name: string;
  status: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  allConversions: number;
}

/** Google Ads returns metrics as STRINGS for int64 fields and numbers for doubles, so every metric
 *  goes through one coercion. A metric that cannot be read becomes 0, never NaN: NaN propagates
 *  silently through a sum and turns a whole report into "NaN" without ever raising an error. */
const metric = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function mapCampaignPerformance(row: unknown): AdsCampaignPerformance {
  const c = asRecord(get(row, 'campaign')) ?? {};
  const m = asRecord(get(row, 'metrics')) ?? {};
  return {
    id: digits(get(c, 'id')) ?? '',
    name: str(get(c, 'name')) ?? '',
    status: (str(get(c, 'status')) ?? 'UNKNOWN').toUpperCase(),
    impressions: metric(get(m, 'impressions')),
    clicks: metric(get(m, 'clicks')),
    costMicros: metric(get(m, 'costMicros')),
    conversions: metric(get(m, 'conversions')),
    conversionsValue: metric(get(m, 'conversionsValue')),
    allConversions: metric(get(m, 'allConversions')),
  };
}

/** Sum the campaign-day rows a metrics query returns into ONE row per campaign. A GAQL query that
 *  names a metric is date-ranged, so a 30-day window returns up to 30 rows per campaign; reporting
 *  those as campaigns would multiply the account's campaign count by the window length. */
export function sumCampaignPerformance(rows: AdsCampaignPerformance[]): AdsCampaignPerformance[] {
  const byId = new Map<string, AdsCampaignPerformance>();
  for (const r of rows) {
    const prev = byId.get(r.id);
    if (!prev) { byId.set(r.id, { ...r }); continue; }
    prev.impressions += r.impressions;
    prev.clicks += r.clicks;
    prev.costMicros += r.costMicros;
    prev.conversions += r.conversions;
    prev.conversionsValue += r.conversionsValue;
    prev.allConversions += r.allConversions;
  }
  return [...byId.values()].sort((a, b) => b.costMicros - a.costMicros);
}

// ── change history (Phase B) ─────────────────────────────────────────────────────────────

export interface AdsChangeEvent {
  /** 'YYYY-MM-DD HH:mm:ss' as the API reports it (account timezone). */
  at: string;
  /** Who made the change - an email, or Google automation. */
  user: string;
  /** GOOGLE_ADS_WEB_CLIENT / GOOGLE_ADS_API / GOOGLE_ADS_SCRIPTS ... - the surface it came from. */
  clientType: string;
  /** What KIND of resource changed (CAMPAIGN, CAMPAIGN_BUDGET, CONVERSION_ACTION, AD_GROUP, ...). */
  resourceType: string;
  /** CREATE / UPDATE / REMOVE. */
  operation: string;
  /** The exact fields touched (from the API field mask), e.g. ['status', 'cpc_bid_micros']. */
  changedFields: string[];
  resourceName: string;
  /** The campaign the change belongs to, when the API attributes one. */
  campaignName?: string;
}

/** One change_event row → the app DTO. changed_fields is a protobuf FieldMask: REST encodes it as
 *  {paths:[...]} or as a comma-joined string depending on the transcoder - both are accepted. */
export function mapChangeEvent(row: unknown): AdsChangeEvent {
  const ev = asRecord(get(row, 'changeEvent')) ?? asRecord(row) ?? {};
  const mask = get(ev, 'changedFields');
  const changedFields = Array.isArray((mask as { paths?: unknown[] } | null)?.paths)
    ? (mask as { paths: unknown[] }).paths.map((p) => str(p)).filter((p): p is string => p !== null)
    : typeof mask === 'string'
      ? mask.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
  const campaignName = str(get(asRecord(get(row, 'campaign')), 'name'));
  return {
    at: str(get(ev, 'changeDateTime')) ?? '',
    user: str(get(ev, 'userEmail')) ?? 'unknown',
    clientType: (str(get(ev, 'clientType')) ?? 'UNKNOWN').toUpperCase(),
    resourceType: (str(get(ev, 'changeResourceType')) ?? 'UNKNOWN').toUpperCase(),
    operation: (str(get(ev, 'resourceChangeOperation')) ?? 'UNKNOWN').toUpperCase(),
    changedFields,
    resourceName: str(get(ev, 'changeResourceName')) ?? '',
    ...(campaignName ? { campaignName } : {}),
  };
}

// ── conversion volume (Phase B) ──────────────────────────────────────────────────────────

export interface ConversionVolumeSummary {
  /** Numeric conversion-action id (from segments.conversion_action's resource name). */
  actionId: string;
  name: string;
  total: number;
  /** First / last day WITH at least one conversion inside the queried range. */
  firstDate: string;
  lastDate: string;
  /** How many distinct days recorded at least one conversion. */
  activeDays: number;
}

/** Collapse per-action-per-day rows into one summary per action, busiest first. A row only exists
 *  where a conversion was recorded, so absence from this list over the range IS the signal. */
export function summarizeConversionVolume(rows: unknown[]): ConversionVolumeSummary[] {
  const byId = new Map<string, ConversionVolumeSummary>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const seg = asRecord(get(row, 'segments')) ?? {};
    const m = asRecord(get(row, 'metrics')) ?? {};
    const resource = str(get(seg, 'conversionAction')) ?? '';
    const actionId = /conversionActions\/(\d+)/.exec(resource)?.[1] ?? (resource || 'unknown');
    const date = str(get(seg, 'date')) ?? '';
    const nRaw = get(m, 'allConversions');
    const n = typeof nRaw === 'number' ? nRaw : typeof nRaw === 'string' ? Number(nRaw) : 0;
    const count = Number.isFinite(n) ? n : 0;
    const prev = byId.get(actionId);
    if (!prev) {
      byId.set(actionId, {
        actionId,
        name: str(get(seg, 'conversionActionName')) ?? actionId,
        total: count,
        firstDate: count > 0 ? date : '',
        lastDate: count > 0 ? date : '',
        activeDays: count > 0 ? 1 : 0,
      });
      continue;
    }
    prev.total += count;
    if (count > 0) {
      prev.activeDays += 1;
      if (date && (prev.firstDate === '' || date < prev.firstDate)) prev.firstDate = date;
      if (date && date > prev.lastDate) prev.lastDate = date;
    }
  }
  return [...byId.values()].sort((a, b) => b.total - a.total);
}

/** ENABLED actions that recorded NOTHING over the range - the "tag may be dead" list. The caller
 *  must present it honestly: zero can also mean no ads ran, which this data cannot distinguish. */
export function silentConversionActions(
  actions: AdsConversionAction[],
  volume: ConversionVolumeSummary[],
): Array<{ id: string; name: string; type: string }> {
  const seen = new Set(volume.filter((v) => v.total > 0).map((v) => v.actionId));
  return actions
    .filter((a) => a.status === 'ENABLED' && !seen.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, type: a.type }));
}

// ── UTM setup audit (Phase B) ────────────────────────────────────────────────────────────

export interface UtmCampaignRow {
  id: string;
  name: string;
  trackingUrlTemplate: string | null;
  finalUrlSuffix: string | null;
}

export interface UtmSetup {
  autoTaggingEnabled?: boolean;
  trackingUrlTemplate: string | null;
  finalUrlSuffix: string | null;
  campaigns: UtmCampaignRow[];
}

/** customer row → the account-level half of UtmSetup. */
export function mapUtmCustomer(row: unknown): Omit<UtmSetup, 'campaigns'> {
  const c = asRecord(get(row, 'customer')) ?? asRecord(row) ?? {};
  const autoTaggingEnabled = optionalBool(get(c, 'autoTaggingEnabled'));
  return {
    ...(autoTaggingEnabled === undefined ? {} : { autoTaggingEnabled }),
    trackingUrlTemplate: str(get(c, 'trackingUrlTemplate')),
    finalUrlSuffix: str(get(c, 'finalUrlSuffix')),
  };
}

/** campaign row → the per-campaign template/suffix. */
export function mapUtmCampaign(row: unknown): UtmCampaignRow {
  const c = asRecord(get(row, 'campaign')) ?? asRecord(row) ?? {};
  return {
    id: digits(get(c, 'id')) ?? '',
    name: str(get(c, 'name')) ?? '',
    trackingUrlTemplate: str(get(c, 'trackingUrlTemplate')),
    finalUrlSuffix: str(get(c, 'finalUrlSuffix')),
  };
}

export interface UtmFinding {
  severity: 'critical' | 'warning' | 'info';
  finding: string;
}

const hasUtm = (s: string | null): boolean => /utm_/i.test(s ?? '');
const UTM_LIST_CAP = 5;
const utmNameList = (rows: UtmCampaignRow[]): string =>
  rows.slice(0, UTM_LIST_CAP).map((c) => `"${c.name}"`).join(', ') + (rows.length > UTM_LIST_CAP ? ` (+${rows.length - UTM_LIST_CAP} more)` : '');

/**
 * Deterministic UTM findings from account + campaign tagging config vs auto-tagging. Conservative by
 * design: every rule is provable from the config alone - anything needing landing-page or GA4
 * evidence is out of scope here and belongs to the runtime checks.
 */
export function auditUtmFindings(setup: UtmSetup): UtmFinding[] {
  const out: UtmFinding[] = [];
  const templates = [
    { where: 'account', tpl: setup.trackingUrlTemplate, suffix: setup.finalUrlSuffix },
    ...setup.campaigns.map((c) => ({ where: `campaign "${c.name}"`, tpl: c.trackingUrlTemplate, suffix: c.finalUrlSuffix })),
  ];
  const anyManualUtm = templates.some((t) => hasUtm(t.tpl) || hasUtm(t.suffix));

  if (setup.autoTaggingEnabled === false && !anyManualUtm) {
    out.push({
      severity: 'critical',
      finding:
        'Auto-tagging is OFF and no tracking template or final URL suffix carries utm_ parameters anywhere - ad clicks arrive with NO gclid and NO UTMs, so this traffic lands in untagged/direct buckets in GA4. Enable auto-tagging (recommended) or add utm_source/utm_medium/utm_campaign via a tracking template.',
    });
  }
  if (setup.autoTaggingEnabled === false && anyManualUtm) {
    for (const t of templates) {
      const joined = `${t.tpl ?? ''} ${t.suffix ?? ''}`;
      if (!/utm_/i.test(joined)) continue;
      const missing = ['utm_source', 'utm_medium', 'utm_campaign'].filter((k) => !joined.toLowerCase().includes(k));
      if (missing.length) {
        out.push({
          severity: 'warning',
          finding: `Manual UTM tagging on the ${t.where} is missing ${missing.join(' + ')} - results without them cannot be tied to a campaign and land in partially-tagged buckets.`,
        });
      }
    }
  }
  // A template that never re-emits the landing page URL sends the click into the void: GTM/GA4 never
  // load. {lpurl} variants ({lpurl}, {unescapedlpurl}, {escapedlpurl+2} ...) all contain "lpurl".
  const broken = setup.campaigns.filter((c) => c.trackingUrlTemplate && !/lpurl/i.test(c.trackingUrlTemplate));
  if (broken.length) {
    out.push({
      severity: 'critical',
      finding: `${broken.length} campaign tracking template(s) do not contain an {lpurl} landing-page insert (${utmNameList(broken)}) - clicks are billed but may never reach the landing page with its parameters intact.`,
    });
  }
  if (setup.trackingUrlTemplate && !/lpurl/i.test(setup.trackingUrlTemplate)) {
    out.push({
      severity: 'critical',
      finding: 'The ACCOUNT-level tracking template does not contain an {lpurl} landing-page insert - it applies to every campaign without its own template.',
    });
  }
  if (setup.autoTaggingEnabled === true && templates.some((t) => /gclid=/i.test(`${t.tpl ?? ''} ${t.suffix ?? ''}`))) {
    out.push({
      severity: 'warning',
      finding: 'Auto-tagging is ON but a tracking template/suffix also sets gclid= manually - the two can conflict; remove the manual gclid.',
    });
  }
  if (setup.autoTaggingEnabled === true && out.length === 0 && !anyManualUtm) {
    out.push({ severity: 'info', finding: 'Auto-tagging is ON with no manual templates - clicks carry a gclid and GA4 attributes them automatically. Nothing to fix at account/campaign level.' });
  }
  return out;
}

// ── conversion health composite (Phase C) ────────────────────────────────────────────────

export interface HealthFinding {
  severity: 'critical' | 'warning' | 'info';
  /** Which lens produced it: tagging | config | volume | changes | seam. */
  area: string;
  finding: string;
}

const SEV_RANK: Record<HealthFinding['severity'], number> = { critical: 0, warning: 1, info: 2 };
const capNames = (names: string[], cap: number): string =>
  names.slice(0, cap).map((n) => `"${n}"`).join(', ') + (names.length > cap ? ` (+${names.length - cap} more)` : '');

export interface ConversionHealthInputs {
  tracking: ConversionCustomer;
  actions: AdsConversionAction[];
  volume: ConversionVolumeSummary[];
  utmFindings: UtmFinding[];
  /** Change events inside (roughly) the same window, newest first. */
  changes: AdsChangeEvent[];
  /** Per-campaign performance summed over the window. */
  performance: AdsCampaignPerformance[];
  /** Audiences, when fetched: OPEN lists stuck at size 0 are a remarketing-tag/upload finding. */
  userLists?: AdsUserList[];
}

/**
 * The composite: every deterministic conversion-health finding the reads can prove, ordered worst
 * first. Findings, not rows - each says what is wrong, why it matters, and what to do. Anything
 * needing runtime evidence (does the tag FIRE on the page) is explicitly out of scope: that is the
 * GTM tab's verify job, and the caller's note says so.
 */
export function assembleConversionHealth(i: ConversionHealthInputs): HealthFinding[] {
  const out: HealthFinding[] = [];

  // Tagging plumbing (auto-tagging / UTMs) - fold the UTM audit in under its own area.
  for (const f of i.utmFindings) {
    if (f.severity === 'info') continue; // the composite reports problems; the dedicated tool keeps the all-clear
    out.push({ severity: f.severity, area: 'tagging', finding: f.finding });
  }

  // Config: double counting + forced zero values (classify the shared warnings by content).
  for (const w of conversionSetupWarnings(i.actions)) {
    out.push({ severity: w.includes('double counting') ? 'critical' : 'warning', area: 'config', finding: w });
  }

  // Config: an ENABLED website action whose snippet/label never materialized cannot be tagged.
  const unlabelled = i.actions.filter((a) => a.status === 'ENABLED' && a.type === 'WEBPAGE' && a.taggable && !a.conversionLabel);
  if (unlabelled.length) {
    out.push({
      severity: 'warning',
      area: 'config',
      finding: `${unlabelled.length} enabled website action(s) have no readable conversion label (${capNames(unlabelled.map((a) => a.name), 5)}) - a GTM tag cannot be built for them until Google publishes their event snippet.`,
    });
  }

  // Volume: enabled actions that recorded nothing in the window.
  const silent = silentConversionActions(i.actions, i.volume);
  if (silent.length) {
    out.push({
      severity: 'warning',
      area: 'volume',
      finding:
        `${silent.length} enabled action(s) recorded ZERO conversions in the window (${capNames(silent.map((x) => x.name), 8)}). ` +
        'Zero can mean a dead tag OR simply no ads served - cross-check each against the GTM container (does the tag exist and fire?) before calling it broken.',
    });
  }

  // Volume: money spent with nothing measured.
  const burning = i.performance.filter((p) => p.costMicros > 0 && p.allConversions === 0);
  if (burning.length) {
    out.push({
      severity: 'warning',
      area: 'volume',
      finding:
        `${burning.length} campaign(s) spent in the window with ZERO recorded conversions (${capNames(burning.map((p) => p.name), 5)}). ` +
        'For performance campaigns that is spend without measurement; for awareness campaigns it may be intended - ask which before recommending changes.',
    });
  }

  // Changes: anything that touched conversion measurement recently correlates with drops.
  const convChanges = i.changes.filter((c) => c.resourceType.includes('CONVERSION'));
  if (convChanges.length) {
    const latest = convChanges[0];
    out.push({
      severity: 'warning',
      area: 'changes',
      finding:
        `${convChanges.length} change(s) touched conversion measurement in the window - latest: ${latest.operation} on ${latest.resourceType} by ${latest.user} at ${latest.at}` +
        `${latest.changedFields.length ? ` (fields: ${latest.changedFields.join(', ')})` : ''}. Correlate these dates against any conversion drop before blaming the tags.`,
    });
  }
  const removals = i.changes.filter((c) => c.operation === 'REMOVE' && !c.resourceType.includes('CONVERSION'));
  if (removals.length) {
    out.push({
      severity: 'info',
      area: 'changes',
      finding: `${removals.length} REMOVE operation(s) in the window (campaigns/ads/etc.) - relevant if a specific campaign's conversions stopped.`,
    });
  }

  // Audiences: an OPEN list that never populated means the remarketing tag / upload feeding it is dead.
  const emptyLists = (i.userLists ?? []).filter(
    (u) => u.membershipStatus === 'OPEN' && (u.sizeForDisplay ?? 0) === 0 && (u.sizeForSearch ?? 0) === 0,
  );
  if (emptyLists.length) {
    out.push({
      severity: 'warning',
      area: 'audience',
      finding:
        `${emptyLists.length} open audience list(s) have size 0 (${capNames(emptyLists.map((u) => u.name), 5)}) - ` +
        'whatever should populate them (a remarketing tag in GTM, or Customer Match uploads) is not doing so. Sizes lag by hours-days, so a list created THIS week may just be young.',
    });
  }

  // Ownership: cross-account is healthy, but the operator must know where edits land.
  if (i.tracking.isCrossAccount && i.tracking.conversionCustomerId) {
    out.push({
      severity: 'info',
      area: 'config',
      finding: `Conversion tracking is owned by manager ${i.tracking.conversionCustomerId} (cross-account) - a normal setup; edits to shared actions affect every client of that manager.`,
    });
  }

  if (!out.some((f) => f.severity !== 'info')) {
    out.push({
      severity: 'info',
      area: 'summary',
      finding: 'No config-level conversion problems detected: tagging, action config, volume and recent changes all look consistent. Whether the tags actually FIRE on the site is runtime evidence - verify from the GTM tab.',
    });
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
}

// ── the Ads ↔ GA4 seam (Phase C) ─────────────────────────────────────────────────────────

export interface AdsGa4SeamInput {
  /** Bare digits of the Ads account being audited. */
  customerId: string;
  /** The GA4 property's Google Ads links. */
  links: Array<{ customerId: string; adsPersonalizationEnabled: boolean | null; canManageClients: boolean | null }>;
  actions: AdsConversionAction[];
  keyEvents: Array<{ eventName: string }>;
}

/** Does an imported action's name plausibly correspond to a GA4 key event? Ads names GA4 imports
 *  with the event name in them (exact shape varies by era), so substring either way is the honest
 *  test - anything stricter produces false "stale" alarms. */
function importMatchesKeyEvent(actionName: string, keyEvents: Array<{ eventName: string }>): boolean {
  const a = actionName.toLowerCase();
  return keyEvents.some((k) => {
    const e = k.eventName.toLowerCase();
    return e.length > 0 && (a.includes(e) || e.includes(a));
  });
}

/**
 * The seam audit: is THIS Ads account linked to THIS GA4 property, and do the GA4-imported
 * conversion actions still line up with the property's key events. The classic paid-for finding
 * (GA4 import + website tag both primary) lives in conversionSetupWarnings and is folded in here
 * too, because the seam is where clients actually experience it.
 */
export function auditAdsGa4Seam(i: AdsGa4SeamInput): HealthFinding[] {
  const out: HealthFinding[] = [];
  const me = i.customerId.replace(/\D/g, '');
  const direct = i.links.find((l) => l.customerId.replace(/\D/g, '') === me);
  const managerLink = i.links.find((l) => l.canManageClients === true);

  if (direct) {
    out.push({ severity: 'info', area: 'seam', finding: `The GA4 property is linked directly to Ads account ${me}.` });
    if (direct.adsPersonalizationEnabled === false) {
      out.push({ severity: 'info', area: 'seam', finding: 'Ads personalization is DISABLED on the link - GA4 audiences will not be usable for remarketing/personalization in this account (measurement import is unaffected).' });
    }
  } else if (managerLink) {
    out.push({
      severity: 'warning',
      area: 'seam',
      finding: `No DIRECT link between this GA4 property and Ads account ${me}, but a manager-level link exists (customer ${managerLink.customerId.replace(/\D/g, '')}, canManageClients) - it may cover this account. Confirm in GA4 Admin > Google Ads links before relying on imports.`,
    });
  } else {
    out.push({
      severity: 'critical',
      area: 'seam',
      finding: `This GA4 property has NO Google Ads link to account ${me} - GA4 key events cannot be imported as conversions, audiences cannot be shared, and GA4's Ads reporting stays empty. Create the link in GA4 Admin (or from the Ads side).`,
    });
  }

  const imported = i.actions.filter((a) => /^GOOGLE_ANALYTICS_4_/.test(a.type));
  const stale = imported.filter((a) => a.status === 'ENABLED' && i.keyEvents.length > 0 && !importMatchesKeyEvent(a.name, i.keyEvents));
  if (stale.length) {
    out.push({
      severity: 'warning',
      area: 'seam',
      finding:
        `${stale.length} GA4-imported conversion action(s) match NO current key event on this property (${capNames(stale.map((a) => a.name), 5)}) - ` +
        'the key event behind them may have been renamed or removed, leaving the import counting nothing. Verify in GA4 Admin > Key events (name matching is heuristic, so confirm before deleting anything).',
    });
  }

  if ((direct || managerLink) && i.keyEvents.length > 0) {
    const unimported = i.keyEvents.filter((k) => !imported.some((a) => importMatchesKeyEvent(a.name, [k])));
    if (unimported.length) {
      out.push({
        severity: 'info',
        area: 'seam',
        finding: `${unimported.length} GA4 key event(s) are not imported into Ads (${capNames(unimported.map((k) => k.eventName), 5)}) - an opportunity IF they represent conversions Ads should optimize toward; importing everything is not a goal in itself.`,
      });
    }
  }

  for (const w of conversionSetupWarnings(i.actions)) {
    if (w.includes('double counting')) out.push({ severity: 'critical', area: 'seam', finding: w });
  }
  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
}

// ── diagnostic reads (Phase F2) ──────────────────────────────────────────────────────────

export interface UploadClientSummary {
  /** Which uploader: GOOGLE_ADS_API / GOOGLE_ADS_WEB_CLIENT / a partner integration name. */
  client: string;
  status: string;
  /** 0..1 - the share of uploaded events Google accepted/matched. */
  successRatio: number | null;
  totalEventCount: number | null;
  successfulEventCount: number | null;
  lastUploadDateTime: string | null;
}

export function mapUploadClientSummary(row: unknown): UploadClientSummary {
  const s = asRecord(get(row, 'offlineConversionUploadClientSummary')) ?? asRecord(row) ?? {};
  const ratioRaw = get(s, 'successRatio');
  const ratio = typeof ratioRaw === 'number' ? ratioRaw : typeof ratioRaw === 'string' ? Number(ratioRaw) : NaN;
  return {
    client: (str(get(s, 'client')) ?? 'UNKNOWN').toUpperCase(),
    status: (str(get(s, 'status')) ?? 'UNKNOWN').toUpperCase(),
    successRatio: Number.isFinite(ratio) ? ratio : null,
    totalEventCount: toInt(get(s, 'totalEventCount')),
    successfulEventCount: toInt(get(s, 'successfulEventCount')),
    lastUploadDateTime: str(get(s, 'lastUploadDateTime')),
  };
}

export interface AdsRecommendation {
  resourceName: string;
  type: string;
  campaign: string | null;
}

export function mapRecommendation(row: unknown): AdsRecommendation {
  const r = asRecord(get(row, 'recommendation')) ?? asRecord(row) ?? {};
  return {
    resourceName: str(get(r, 'resourceName')) ?? '',
    type: (str(get(r, 'type')) ?? 'UNKNOWN').toUpperCase(),
    campaign: str(get(r, 'campaign')),
  };
}

export interface BudgetPacingRow {
  campaign: string;
  status: string;
  dailyBudgetMicros: number;
  sharedBudget: boolean;
  avgDailySpendMicros: number;
  /** avg daily spend / daily budget. >= 0.9 reads as budget-capped, <= 0.2 as underspending. */
  paceRatio: number;
  verdict: 'capped' | 'healthy' | 'underspending';
}

/** Join campaign config (daily budgets) with summed performance over a window into per-campaign
 *  pacing. Campaigns without a readable budget or with zero spend AND zero budget are skipped -
 *  a verdict fabricated from missing data is worse than no row. PURE. */
export function assessBudgetPacing(campaigns: AdsCampaign[], perf: AdsCampaignPerformance[], windowDays: number): BudgetPacingRow[] {
  const days = Math.max(1, Math.floor(windowDays));
  const spendById = new Map(perf.map((p) => [p.id, p.costMicros] as const));
  const out: BudgetPacingRow[] = [];
  for (const c of campaigns) {
    if (!c.budget || c.budget.amountMicros <= 0) continue;
    if (c.status !== 'ENABLED') continue;
    const avg = (spendById.get(c.id) ?? 0) / days;
    const ratio = avg / c.budget.amountMicros;
    out.push({
      campaign: c.name,
      status: c.status,
      dailyBudgetMicros: c.budget.amountMicros,
      sharedBudget: c.budget.shared,
      avgDailySpendMicros: Math.round(avg),
      paceRatio: Math.round(ratio * 100) / 100,
      verdict: ratio >= 0.9 ? 'capped' : ratio <= 0.2 ? 'underspending' : 'healthy',
    });
  }
  return out.sort((a, b) => b.paceRatio - a.paceRatio);
}

// ── upload results (Phase D) ─────────────────────────────────────────────────────────────

export interface UploadOutcome {
  /** Rows the API accepted (total minus per-row failures). */
  accepted: number;
  total: number;
  /** Per-row failures parsed from partial_failure_error - index into the submitted batch + reason. */
  failures: Array<{ index: number; message: string }>;
}

/**
 * Parse an upload response's partial_failure_error into per-row outcomes. The upload endpoints run
 * with partialFailure=true (they REQUIRE it), so a 200 response can still contain per-row rejections
 * buried in a google.rpc.Status - treating a 200 as "all uploaded" silently loses conversions. The
 * row index rides in each error's GoogleAdsFailure location fieldPathElements; when it is absent the
 * failure is reported at index -1 (batch-level) rather than guessed.
 */
export function parseUploadOutcome(data: unknown, total: number): UploadOutcome {
  const status = asRecord(get(asRecord(data), 'partialFailureError'));
  const failures: Array<{ index: number; message: string }> = [];
  if (status) {
    const details = get(status, 'details');
    for (const d of Array.isArray(details) ? details : []) {
      const errors = get(asRecord(d), 'errors');
      for (const e of Array.isArray(errors) ? errors : []) {
        const rec = asRecord(e) ?? {};
        const message = str(get(rec, 'message')) ?? 'rejected';
        const parts = get(asRecord(get(rec, 'location')), 'fieldPathElements');
        let index = -1;
        for (const p of Array.isArray(parts) ? parts : []) {
          const idx = toInt(get(asRecord(p), 'index'));
          if (idx !== null) { index = idx; break; }
        }
        failures.push({ index, message });
      }
    }
    // A status with a message but no parsed details still means SOMETHING failed - report it.
    if (failures.length === 0) {
      const msg = str(get(status, 'message'));
      if (msg) failures.push({ index: -1, message: msg });
    }
  }
  const failedRows = new Set(failures.filter((f) => f.index >= 0).map((f) => f.index)).size;
  const batchLevel = failures.some((f) => f.index < 0);
  return { accepted: batchLevel && failedRows === 0 ? 0 : Math.max(0, total - failedRows), total, failures };
}

// ── audiences / user lists (Phase D) ─────────────────────────────────────────────────────

export interface AdsUserList {
  id: string;
  resourceName: string;
  name: string;
  type: string;
  membershipStatus: string;
  membershipLifeSpanDays: number | null;
  sizeForDisplay: number | null;
  sizeForSearch: number | null;
  readOnly: boolean;
  matchRatePercentage: number | null;
}

export function mapUserList(row: unknown): AdsUserList {
  const u = asRecord(get(row, 'userList')) ?? asRecord(row) ?? {};
  const id = digits(get(u, 'id')) ?? '';
  const size = (v: unknown): number | null => toInt(v);
  return {
    id,
    resourceName: str(get(u, 'resourceName')) ?? '',
    name: str(get(u, 'name')) ?? (id ? `User list ${id}` : 'Unnamed list'),
    type: (str(get(u, 'type')) ?? 'UNKNOWN').toUpperCase(),
    membershipStatus: (str(get(u, 'membershipStatus')) ?? 'UNKNOWN').toUpperCase(),
    membershipLifeSpanDays: toInt(get(u, 'membershipLifeSpan')),
    sizeForDisplay: size(get(u, 'sizeForDisplay')),
    sizeForSearch: size(get(u, 'sizeForSearch')),
    readOnly: optionalBool(get(u, 'readOnly')) ?? false,
    matchRatePercentage: toInt(get(u, 'matchRatePercentage')),
  };
}

// ── structure rows (Phase E) ─────────────────────────────────────────────────────────────

/** One row of get_google_ads_structure, shaped per view; only the fields that view carries. */
export function mapStructureRow(view: 'keywords' | 'search_terms' | 'landing_pages' | 'ads', row: unknown): Record<string, unknown> {
  const campaign = str(get(asRecord(get(row, 'campaign')), 'name'));
  const adGroup = str(get(asRecord(get(row, 'adGroup')), 'name'));
  const m = asRecord(get(row, 'metrics')) ?? {};
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  if (view === 'keywords') {
    const crit = asRecord(get(row, 'adGroupCriterion')) ?? {};
    const kw = asRecord(get(crit, 'keyword')) ?? {};
    const q = asRecord(get(crit, 'qualityInfo')) ?? {};
    return {
      campaign, adGroup,
      keyword: str(get(kw, 'text')) ?? '',
      matchType: (str(get(kw, 'matchType')) ?? 'UNKNOWN').toUpperCase(),
      qualityScore: toInt(get(q, 'qualityScore')),
      adRelevance: str(get(q, 'creativeQualityScore')) ?? null,
      landingPageExperience: str(get(q, 'postClickQualityScore')) ?? null,
      expectedCtr: str(get(q, 'searchPredictedCtr')) ?? null,
    };
  }
  if (view === 'search_terms') {
    const st = asRecord(get(row, 'searchTermView')) ?? {};
    return {
      campaign,
      searchTerm: str(get(st, 'searchTerm')) ?? '',
      status: (str(get(st, 'status')) ?? 'UNKNOWN').toUpperCase(),
      impressions: num(get(m, 'impressions')),
      clicks: num(get(m, 'clicks')),
      conversions: num(get(m, 'conversions')),
      costMicros: num(get(m, 'costMicros')),
    };
  }
  if (view === 'landing_pages') {
    const lp = asRecord(get(row, 'landingPageView')) ?? {};
    return {
      url: str(get(lp, 'unexpandedFinalUrl')) ?? '',
      clicks: num(get(m, 'clicks')),
      costMicros: num(get(m, 'costMicros')),
      conversions: num(get(m, 'conversions')),
      conversionsValue: num(get(m, 'conversionsValue')),
    };
  }
  const aga = asRecord(get(row, 'adGroupAd')) ?? {};
  const ad = asRecord(get(aga, 'ad')) ?? {};
  const finalUrls = get(ad, 'finalUrls');
  return {
    campaign, adGroup,
    adId: digits(get(ad, 'id')) ?? '',
    type: (str(get(ad, 'type')) ?? 'UNKNOWN').toUpperCase(),
    status: (str(get(aga, 'status')) ?? 'UNKNOWN').toUpperCase(),
    adStrength: str(get(aga, 'adStrength')) ?? null,
    finalUrls: Array.isArray(finalUrls) ? finalUrls.map((u) => str(u)).filter(Boolean) : [],
  };
}
