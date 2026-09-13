// Pure tests for the tracking contract (event schema registry + dedup model). Run:
//   tsx src/shared/__tests__/tracking-contract.test.ts
import {
  EVENT_CONTRACT, APPROVED_GA4_EVENTS, classifyEventName, validateEventParams,
  DEDUP_MODEL, dedupKeyFor,
} from '../tracking-contract';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── event name classification ────────────────────────────────────────────────
check('name: purchase → recommended', classifyEventName('purchase').kind === 'recommended');
check('name: page_view → auto', classifyEventName('page_view').kind === 'auto');
check('name: my_custom_event → custom', classifyEventName('my_custom_event').kind === 'custom');
check('name: google_signal → reserved (prefix)', classifyEventName('google_signal').kind === 'reserved');
check('name: firebase_x → reserved', classifyEventName('firebase_campaign').kind === 'reserved');
check('name: "Add To Cart" (spaces) → malformed', classifyEventName('Add To Cart').kind === 'malformed');
check('name: "AddToCart" (uppercase) → malformed', classifyEventName('AddToCart').kind === 'malformed');
check('name: "1purchase" (leading digit) → malformed', classifyEventName('1purchase').kind === 'malformed');
check('name: empty → malformed', classifyEventName('').kind === 'malformed');
check('name: over-40-chars → malformed', classifyEventName('a'.repeat(41)).kind === 'malformed');

// ── required / recommended params ────────────────────────────────────────────
const purchaseAll = validateEventParams('purchase', ['transaction_id', 'value', 'currency', 'items']);
check('params: purchase with all required → nothing missing', purchaseAll.known && purchaseAll.missingRequired.length === 0);
const purchaseMissing = validateEventParams('purchase', ['value', 'currency']);
check('params: purchase missing transaction_id + items', purchaseMissing.missingRequired.sort().join(',') === 'items,transaction_id');
const addToCartRec = validateEventParams('add_to_cart', ['items']);
check('params: add_to_cart has required items, recommends value+currency', addToCartRec.missingRequired.length === 0 && addToCartRec.missingRecommended.sort().join(',') === 'currency,value');
const searchMissing = validateEventParams('search', []);
check('params: search requires search_term', searchMissing.missingRequired.join(',') === 'search_term');
const custom = validateEventParams('totally_custom', ['x']);
check('params: unknown event → known:false, nothing enforced', !custom.known && custom.missingRequired.length === 0);
check('params: case-insensitive (PURCHASE + CURRENCY)', validateEventParams('purchase', ['TRANSACTION_ID', 'Value', 'currency', 'ITEMS']).missingRequired.length === 0);

// ── contract shape ───────────────────────────────────────────────────────────
check('contract: purchase is a conversion with transaction_id dedup', EVENT_CONTRACT.purchase.isConversion && EVENT_CONTRACT.purchase.dedupParam === 'transaction_id');
check('contract: generate_lead is a conversion with no dedup key', EVENT_CONTRACT.generate_lead.isConversion && EVENT_CONTRACT.generate_lead.dedupParam === null);
check('contract: the 7 funnel events are all present', ['view_item', 'add_to_cart', 'view_cart', 'begin_checkout', 'add_shipping_info', 'add_payment_info', 'purchase'].every((e) => EVENT_CONTRACT[e]));
check('approved set: includes recommended + auto', APPROVED_GA4_EVENTS.has('purchase') && APPROVED_GA4_EVENTS.has('scroll'));

// ── per-destination dedup model (the key differs per platform) ────────────────
check('dedup: GA4 + Ads dedup by transaction_id', DEDUP_MODEL.ga4.key === 'transaction_id' && DEDUP_MODEL.google_ads.key === 'transaction_id');
check('dedup: Meta/TikTok/Pinterest/Snap/LinkedIn dedup by event_id', ['meta', 'tiktok', 'pinterest', 'snap', 'linkedin'].every((d) => DEDUP_MODEL[d as 'meta'].key === 'event_id'));
check('dedup: GA4 purchase → transaction_id key', dedupKeyFor('ga4', 'purchase') === 'transaction_id');
check('dedup: GA4 add_to_cart → no dedup concern (null)', dedupKeyFor('ga4', 'add_to_cart') === null);
check('dedup: Meta purchase → event_id', dedupKeyFor('meta', 'purchase') === 'event_id');
check('dedup: Meta add_to_cart → event_id (every paired event)', dedupKeyFor('meta', 'add_to_cart') === 'event_id');
check('dedup: Ads add_to_cart → null (only transactions)', dedupKeyFor('google_ads', 'add_to_cart') === null);

console.log(`\ntracking-contract: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
