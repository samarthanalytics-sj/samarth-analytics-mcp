// Pure tests for the runtime-capture engine (GA4 /g/collect parsing, collector classification,
// synthetic dataLayer payloads, and the capture evaluation). No browser, no network. Run:
//   tsx src/shared/__tests__/runtime-capture.test.ts
import {
  parseGa4CollectHit,
  classifyCollector,
  evaluateRuntimeCapture,
  syntheticDataLayerEvent,
} from '../runtime-capture';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── parseGa4CollectHit: a realistic single-event /g/collect URL ────────────────
const purchaseUrl =
  'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=purchase&ep.currency=USD&epn.value=99.9&ep.transaction_id=T-9&pr1=id123~nmWidget';
{
  const events = parseGa4CollectHit({ url: purchaseUrl });
  check('parse: single URL → one event', events.length === 1, `got ${events.length}`);
  check('parse: event name is purchase', events[0]?.event === 'purchase');
  check('parse: ep.currency captured', events[0]?.params.currency === 'USD');
  check('parse: epn.value captured (as string)', events[0]?.params.value === '99.9');
  check('parse: ep.transaction_id captured', events[0]?.params.transaction_id === 'T-9');
  check('parse: pr1 present → hasItems true', events[0]?.hasItems === true);
}

// ── parseGa4CollectHit: a BATCHED request — extra events live in the POST body ─
{
  const url = 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=view_item&ep.currency=USD&pr1=id1';
  // Two more events, one group per line, each an &-joined param string (no leading '?').
  const body = 'en=add_to_cart&ep.currency=USD&pr1=id1\nen=begin_checkout&epn.value=5&pr1=id1&pr2=id2';
  const events = parseGa4CollectHit({ url, body });
  check('batch: URL + 2 body lines → 3 events', events.length === 3, `got ${events.length}`);
  check('batch: event names in order', events.map((e) => e.event).join(',') === 'view_item,add_to_cart,begin_checkout');
  check('batch: begin_checkout has items (pr1/pr2)', events[2]?.hasItems === true);
  check('batch: begin_checkout value param', events[2]?.params.value === '5');
}

// ── parseGa4CollectHit: robustness ─────────────────────────────────────────────
check('parse: non-GA4 / garbage url → []', parseGa4CollectHit({ url: 'not a url' }).length === 0);
check('parse: url with no en and no ep → []', parseGa4CollectHit({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-1' }).length === 0);
check('parse: null body is tolerated', parseGa4CollectHit({ url: purchaseUrl, body: null }).length === 1);

// ── classifyCollector: each host ───────────────────────────────────────────────
check('classify: google-analytics.com /g/collect → ga4', classifyCollector('https://www.google-analytics.com/g/collect?en=x') === 'ga4');
check('classify: region1.google-analytics.com /g/collect → ga4', classifyCollector('https://region1.google-analytics.com/g/collect?en=x') === 'ga4');
check('classify: google-analytics.com /collect (MP) → ga4', classifyCollector('https://www.google-analytics.com/collect?v=1') === 'ga4');
check('classify: facebook.com/tr → meta', classifyCollector('https://www.facebook.com/tr?id=1&ev=Purchase') === 'meta');
check('classify: analytics.tiktok.com/api → tiktok', classifyCollector('https://analytics.tiktok.com/api/v2/pixel') === 'tiktok');
check('classify: unrelated host → null', classifyCollector('https://example.com/page') === null);
check('classify: GA host but wrong path → null', classifyCollector('https://www.google-analytics.com/analytics.js') === null);
check('classify: serverUrl host → server', classifyCollector('https://sgtm.example.com/g/collect?en=purchase', 'sgtm.example.com') === 'server');
check('classify: subdomain of serverUrl host → server', classifyCollector('https://a.sgtm.example.com/x', 'sgtm.example.com') === 'server');
// PATH-BASED: a GA4 /g/collect on ANY host (a self-hosted sGTM) is caught even with NO serverHost —
// so a synthetic event can't slip a real server-side hit past us.
check('classify: /g/collect on any host → server (no serverHost)', classifyCollector('https://metrics.acme.com/g/collect?en=purchase') === 'server');
check('classify: first-party /g/collect → server', classifyCollector('https://sgtm.example.com/g/collect?en=x') === 'server');
// Other ad-tech conversion beacons fire on the SAME synthetic events → captured + aborted as 'ad'.
check('classify: doubleclick → ad', classifyCollector('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?guid=ON') === 'ad');
check('classify: googleadservices → ad', classifyCollector('https://www.googleadservices.com/pagead/conversion/123/') === 'ad');
check('classify: google.com/pagead → ad', classifyCollector('https://www.google.com/pagead/1p-conversion/123/') === 'ad');
check('classify: pinterest ct → ad', classifyCollector('https://ct.pinterest.com/v3/?tid=1&event=checkout') === 'ad');
check('classify: snap tr → ad', classifyCollector('https://tr.snapchat.com/p?pid=1') === 'ad');
check('classify: linkedin px → ad', classifyCollector('https://px.ads.linkedin.com/collect?fmt=gif') === 'ad');
check('classify: bing bat → ad', classifyCollector('https://bat.bing.com/action/0?ti=1') === 'ad');
check('classify: reddit alb → ad', classifyCollector('https://alb.reddit.com/rp.gif?id=1') === 'ad');
check('classify: cross-site non-tracking asset → null', classifyCollector('https://cdn.example.com/logo.png') === null);

// ── evaluateRuntimeCapture ─────────────────────────────────────────────────────
{
  // A purchase hit that is MISSING currency (has transaction_id, value, items) → missingRequired = [currency].
  const purchaseMissingCurrency =
    'https://www.google-analytics.com/g/collect?v=2&en=purchase&ep.transaction_id=T-1&epn.value=10&pr1=id1';
  // A clean view_item hit (has items).
  const viewItem = 'https://www.google-analytics.com/g/collect?v=2&en=view_item&pr1=id1';
  const captured = [{ url: purchaseMissingCurrency }, { url: viewItem }];
  const report = evaluateRuntimeCapture(captured, ['view_item', 'purchase', 'add_to_cart']);

  const view = report.events.find((e) => e.event === 'view_item')!;
  const purchase = report.events.find((e) => e.event === 'purchase')!;
  const addToCart = report.events.find((e) => e.event === 'add_to_cart')!;

  check('eval: view_item fired', view.ga4Fired === true && view.missingRequired.length === 0);
  check('eval: view_item destination ga4', view.destinations.join(',') === 'ga4');
  check('eval: purchase fired but missing currency', purchase.ga4Fired === true && purchase.missingRequired.join(',') === 'currency');
  check('eval: add_to_cart never fired', addToCart.ga4Fired === false && addToCart.destinations.length === 0);
  check('eval: summary fired=2 notFired=1', report.summary.fired === 2 && report.summary.notFired === 1);
  check('eval: summary missingParams=1', report.summary.missingParams === 1);
  check('eval: collectorsSeen = [ga4]', report.collectorsSeen.join(',') === 'ga4');
}

// ── evaluateRuntimeCapture: Meta/TikTok collectors attributed to expected events ─
{
  const ga4Purchase = 'https://www.google-analytics.com/g/collect?v=2&en=purchase&ep.transaction_id=T&ep.currency=USD&epn.value=1&pr1=id1';
  const meta = 'https://www.facebook.com/tr?id=1&ev=Purchase';
  const tiktok = 'https://analytics.tiktok.com/api/v2/pixel';
  const report = evaluateRuntimeCapture([{ url: ga4Purchase }, { url: meta }, { url: tiktok }], ['purchase']);
  const purchase = report.events.find((e) => e.event === 'purchase')!;
  check('eval: purchase destinations ga4+meta+tiktok', purchase.destinations.join(',') === 'ga4,meta,tiktok');
  check('eval: purchase has all required params', purchase.missingRequired.length === 0);
  check('eval: collectorsSeen ordered ga4,meta,tiktok', report.collectorsSeen.join(',') === 'ga4,meta,tiktok');
}

// ── evaluateRuntimeCapture: nothing captured ───────────────────────────────────
{
  const report = evaluateRuntimeCapture([], ['purchase', 'view_item']);
  check('eval: empty capture → all notFired', report.summary.fired === 0 && report.summary.notFired === 2);
  check('eval: empty capture → collectorsSeen empty', report.collectorsSeen.length === 0);
}

// ── syntheticDataLayerEvent ────────────────────────────────────────────────────
{
  const purchase = syntheticDataLayerEvent('purchase');
  const ecom = purchase.ecommerce as Record<string, unknown>;
  check('synthetic: purchase has event name', purchase.event === 'purchase');
  check('synthetic: purchase transaction_id is SYNTHETIC', ecom?.transaction_id === 'SYNTHETIC_TEST_TXN');
  check('synthetic: purchase value=1 currency=USD', ecom?.value === 1 && ecom?.currency === 'USD');
  const items = ecom?.items as Array<Record<string, unknown>>;
  check('synthetic: purchase has one synthetic item', Array.isArray(items) && items.length === 1 && items[0].item_id === 'SYNTHETIC_SKU');
  check('synthetic: item is priced 1 x qty 1', items?.[0]?.price === 1 && items?.[0]?.quantity === 1);

  // add_to_cart requires only items; value/currency are recommended → still synthesized? No: only required.
  const addToCart = syntheticDataLayerEvent('add_to_cart');
  const acEcom = addToCart.ecommerce as Record<string, unknown>;
  check('synthetic: add_to_cart has items', Array.isArray(acEcom?.items) && (acEcom.items as unknown[]).length === 1);
  check('synthetic: add_to_cart has no value (not required)', acEcom?.value === undefined);

  // search requires search_term (top-level, not ecommerce).
  const search = syntheticDataLayerEvent('search');
  check('synthetic: search has top-level search_term', typeof search.search_term === 'string' && (search.search_term as string).length > 0);
  check('synthetic: search has no ecommerce', search.ecommerce === undefined);

  // unknown/custom event → just the name.
  const custom = syntheticDataLayerEvent('totally_custom');
  check('synthetic: custom event → name only, no ecommerce', custom.event === 'totally_custom' && custom.ecommerce === undefined);

  // deterministic: two calls are identical.
  check('synthetic: deterministic', JSON.stringify(syntheticDataLayerEvent('purchase')) === JSON.stringify(syntheticDataLayerEvent('purchase')));
}

console.log(`\nruntime-capture: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
