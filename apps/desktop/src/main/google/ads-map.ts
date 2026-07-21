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
    match: /^(AD_CALL|CLICK_TO_CALL|WEBSITE_CALL|SMART_CAMPAIGN_)/,
    note: 'Call conversion: it is counted by Google from the call itself, not by a Google Ads conversion tag you can fire from GTM.',
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

  return {
    resourceName,
    id,
    name: str(get(action, 'name')) ?? (id ? `Conversion action ${id}` : 'Unnamed conversion action'),
    status: (str(get(action, 'status')) ?? 'UNKNOWN').toUpperCase(),
    type,
    category: (str(get(action, 'category')) ?? 'UNKNOWN').toUpperCase(),
    ...(ownerCustomer ? { ownerCustomer } : {}),
    ...(primaryForGoal === undefined ? {} : { primaryForGoal }),
    conversionId: identity?.conversionId ?? null,
    conversionLabel: identity?.conversionLabel ?? null,
    taggable,
    ...(note ? { note } : {}),
  };
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

  return {
    conversionCustomerId,
    status: (str(get(setting, 'conversionTrackingStatus')) ?? 'UNKNOWN').toUpperCase(),
    trackingId: trackingIdRaw && trackingIdRaw !== '0' ? trackingIdRaw : null,
    crossAccountTrackingId: crossAccountRaw && crossAccountRaw !== '0' ? crossAccountRaw : null,
    isCrossAccount: conversionCustomerId !== null && queried !== null && conversionCustomerId !== queried,
  };
}
