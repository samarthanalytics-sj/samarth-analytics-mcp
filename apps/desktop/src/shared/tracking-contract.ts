// The TRACKING CONTRACT — one source of truth for what a correct GA4 / pixel implementation looks
// like: the approved GA4 event names, the required + recommended parameters per event, the
// deduplication key per event, and the per-destination dedup model. Builders and audits both read
// from this so the definition of "correct" lives in ONE place and cannot drift across the codebase.
//
// Framework-free + pure (no I/O, no GTM types) so the renderer, the builders, the audits, and the
// unit tests all share it. Parameter/required sets follow Google's "Recommended events" reference.

export type EventCategory = 'ecommerce' | 'lead' | 'engagement' | 'auth' | 'page' | 'search';

export interface EventSchema {
  event: string;
  category: EventCategory;
  /** A GA4 conversion / key event by default (drives "is this a revenue/lead event" checks). */
  isConversion: boolean;
  /** Parameters the event is not meaningfully usable without. */
  requiredParams: string[];
  /** Parameters strongly suggested by Google but not strictly required. */
  recommendedParams: string[];
  /** The parameter that identifies a UNIQUE occurrence for dedup, or null if the event has none.
   *  For GA4 this is transaction_id (purchase/refund); most events have no natural dedup key. */
  dedupParam: string | null;
}

const ec = (
  event: string,
  required: string[],
  recommended: string[],
  opts?: { conversion?: boolean; dedupParam?: string | null },
): EventSchema => ({
  event,
  category: 'ecommerce',
  isConversion: opts?.conversion ?? false,
  requiredParams: required,
  recommendedParams: recommended,
  dedupParam: opts?.dedupParam ?? null,
});

/** The GA4 recommended-event schema (the funnel + common web conversions). `items` is the ecommerce
 *  item array; value+currency travel together (GA4 ignores value without currency). */
export const EVENT_CONTRACT: Record<string, EventSchema> = {
  // ── ecommerce funnel ──────────────────────────────────────────────────────
  view_item_list: ec('view_item_list', ['items'], ['item_list_id', 'item_list_name']),
  view_item: ec('view_item', ['items'], ['value', 'currency']),
  select_item: ec('select_item', ['items'], ['item_list_id', 'item_list_name']),
  add_to_wishlist: ec('add_to_wishlist', ['items'], ['value', 'currency']),
  add_to_cart: ec('add_to_cart', ['items'], ['value', 'currency']),
  remove_from_cart: ec('remove_from_cart', ['items'], ['value', 'currency']),
  view_cart: ec('view_cart', ['items'], ['value', 'currency']),
  begin_checkout: ec('begin_checkout', ['items'], ['value', 'currency', 'coupon']),
  add_shipping_info: ec('add_shipping_info', ['items'], ['value', 'currency', 'coupon', 'shipping_tier']),
  add_payment_info: ec('add_payment_info', ['items'], ['value', 'currency', 'coupon', 'payment_type']),
  purchase: ec('purchase', ['transaction_id', 'value', 'currency', 'items'], ['tax', 'shipping', 'coupon'], { conversion: true, dedupParam: 'transaction_id' }),
  refund: ec('refund', ['transaction_id'], ['value', 'currency', 'items'], { dedupParam: 'transaction_id' }),
  view_promotion: ec('view_promotion', ['items'], ['promotion_id', 'promotion_name', 'creative_name', 'creative_slot']),
  select_promotion: ec('select_promotion', ['items'], ['promotion_id', 'promotion_name', 'creative_name', 'creative_slot']),
  // ── non-ecommerce conversions + engagement ────────────────────────────────
  generate_lead: { event: 'generate_lead', category: 'lead', isConversion: true, requiredParams: [], recommendedParams: ['value', 'currency'], dedupParam: null },
  sign_up: { event: 'sign_up', category: 'auth', isConversion: true, requiredParams: [], recommendedParams: ['method'], dedupParam: null },
  login: { event: 'login', category: 'auth', isConversion: false, requiredParams: [], recommendedParams: ['method'], dedupParam: null },
  search: { event: 'search', category: 'search', isConversion: false, requiredParams: ['search_term'], recommendedParams: [], dedupParam: null },
  select_content: { event: 'select_content', category: 'engagement', isConversion: false, requiredParams: [], recommendedParams: ['content_type', 'item_id'], dedupParam: null },
  share: { event: 'share', category: 'engagement', isConversion: false, requiredParams: [], recommendedParams: ['method', 'content_type', 'item_id'], dedupParam: null },
};

/** Automatically-collected + Enhanced-Measurement GA4 events — valid names that are NOT custom (no
 *  schema is enforced, they're collected by GA4/gtag itself). Used to tell "unknown custom event"
 *  apart from "a real GA4 event we just don't list params for". */
export const AUTO_GA4_EVENTS: ReadonlySet<string> = new Set([
  'page_view', 'session_start', 'first_visit', 'user_engagement', 'scroll', 'click',
  'view_search_results', 'file_download', 'form_start', 'form_submit',
  'video_start', 'video_progress', 'video_complete',
]);

/** Every GA4 event name this contract recognises (recommended + auto/EM). */
export const APPROVED_GA4_EVENTS: ReadonlySet<string> = new Set([
  ...Object.keys(EVENT_CONTRACT),
  ...AUTO_GA4_EVENTS,
]);

/** GA4 forbids event names with these prefixes (reserved for Google/Firebase). */
export const RESERVED_GA4_EVENT_PREFIXES = ['google_', 'ga_', 'firebase_'] as const;
/** A GA4 event name is invalid if it isn't snake_case-ish: must start with a letter, be alphanumeric
 *  + underscore only, and be at most 40 characters. Spaces and uppercase are the common mistakes. */
const GA4_EVENT_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

export type EventNameKind = 'recommended' | 'auto' | 'custom' | 'reserved' | 'malformed';
export interface EventNameClassification {
  kind: EventNameKind;
  message: string;
}

/** Classify a GA4 event name against the contract + GA4's naming rules. `recommended`/`auto` are
 *  first-class GA4 events; `custom` is allowed but unschematised; `reserved` + `malformed` are defects
 *  (GA4 will reject or silently drop them). PURE. */
export function classifyEventName(raw: string): EventNameClassification {
  const name = (raw ?? '').trim();
  if (!name) return { kind: 'malformed', message: 'Empty event name.' };
  const lower = name.toLowerCase();
  if (RESERVED_GA4_EVENT_PREFIXES.some((p) => lower.startsWith(p))) {
    return { kind: 'reserved', message: `"${name}" uses a reserved prefix (google_/ga_/firebase_) — GA4 rejects it.` };
  }
  if (!GA4_EVENT_NAME_RE.test(name)) {
    const why = /\s/.test(name) ? 'contains spaces' : /[A-Z]/.test(name) ? 'has uppercase letters' : name.length > 40 ? 'is longer than 40 characters' : 'is not snake_case (letters, digits, underscore; must start with a letter)';
    return { kind: 'malformed', message: `"${name}" ${why} — GA4 event names must be snake_case, start with a letter, and be ≤40 chars.` };
  }
  if (Object.prototype.hasOwnProperty.call(EVENT_CONTRACT, name)) return { kind: 'recommended', message: `"${name}" is a GA4 recommended event.` };
  if (AUTO_GA4_EVENTS.has(name)) return { kind: 'auto', message: `"${name}" is a GA4 auto-collected / Enhanced-Measurement event.` };
  return { kind: 'custom', message: `"${name}" is a valid custom event (no recommended-event schema to enforce).` };
}

export interface ParamValidation {
  event: string;
  /** True when the event is in EVENT_CONTRACT (so required/recommended are meaningful). */
  known: boolean;
  missingRequired: string[];
  missingRecommended: string[];
}

/** Validate that the given present parameter names cover an event's required + recommended set.
 *  For an unknown/custom event, `known:false` and nothing is missing (no schema to enforce). PURE. */
export function validateEventParams(event: string, presentParams: Iterable<string>): ParamValidation {
  const schema = EVENT_CONTRACT[(event ?? '').trim().toLowerCase()];
  if (!schema) return { event, known: false, missingRequired: [], missingRecommended: [] };
  const present = new Set([...presentParams].map((p) => (p ?? '').trim().toLowerCase()));
  return {
    event: schema.event,
    known: true,
    missingRequired: schema.requiredParams.filter((p) => !present.has(p)),
    missingRecommended: schema.recommendedParams.filter((p) => !present.has(p)),
  };
}

// ── Per-destination deduplication model ──────────────────────────────────────
// The KEY that de-duplicates a browser event against a server event DIFFERS per destination — a common
// mistake is to assume event_id is universal. It is NOT: GA4 and Google Ads dedup by transaction_id;
// only the pixel/CAPI destinations use an explicit event_id.

export type Destination = 'ga4' | 'google_ads' | 'meta' | 'tiktok' | 'pinterest' | 'snap' | 'linkedin';
export type DedupKeyKind = 'event_id' | 'transaction_id' | 'none';

export interface DedupModel {
  destination: Destination;
  key: DedupKeyKind;
  note: string;
}

export const DEDUP_MODEL: Record<Destination, DedupModel> = {
  ga4: { destination: 'ga4', key: 'transaction_id', note: 'GA4 deduplicates purchases by transaction_id; it has no first-class event_id.' },
  google_ads: { destination: 'google_ads', key: 'transaction_id', note: 'Google Ads deduplicates conversions by transaction_id (order id), not an event_id.' },
  meta: { destination: 'meta', key: 'event_id', note: 'Meta deduplicates Pixel↔CAPI by event_id (with _fbp as a secondary signal).' },
  tiktok: { destination: 'tiktok', key: 'event_id', note: 'TikTok deduplicates Pixel↔Events API by event_id.' },
  pinterest: { destination: 'pinterest', key: 'event_id', note: 'Pinterest deduplicates tag↔CAPI by event_id.' },
  snap: { destination: 'snap', key: 'event_id', note: 'Snap deduplicates by client_dedup_id / event_id.' },
  linkedin: { destination: 'linkedin', key: 'event_id', note: 'LinkedIn deduplicates Insight↔CAPI by eventId.' },
};

/** The dedup key a destination needs for a given GA4 event, or null when that event has no dedup
 *  concern for that destination (e.g. a non-purchase event for GA4/Ads which only dedup transactions). */
export function dedupKeyFor(destination: Destination, event: string): DedupKeyKind | null {
  const model = DEDUP_MODEL[destination];
  if (model.key === 'transaction_id') {
    // GA4 / Ads only care about transaction dedup — and only for the transaction-bearing events.
    return EVENT_CONTRACT[(event ?? '').trim().toLowerCase()]?.dedupParam === 'transaction_id' ? 'transaction_id' : null;
  }
  return model.key; // event_id destinations dedup every server↔browser paired event
}
