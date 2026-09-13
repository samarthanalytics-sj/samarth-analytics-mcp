// Pure tests for the runtime-capture engine (GA4 /g/collect parsing, collector classification,
// synthetic dataLayer payloads, and the capture evaluation). No browser, no network. Run:
//   tsx src/shared/__tests__/runtime-capture.test.ts
import {
  parseGa4CollectHit,
  classifyCollector,
  beaconPlatform,
  beaconHost,
  isKnownAdPlatform,
  evaluateRuntimeCapture,
  syntheticDataLayerEvent,
  describeHit,
  buildNetworkLog,
  summarizeDataLayer,
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
// TikTok's WEB pixel uses the /i18n/pixel path, not /api — must still classify as tiktok so it is
// aborted on a real submit AND named in the network log (was falling through to 'other' before).
check('classify: analytics.tiktok.com/i18n/pixel → tiktok', classifyCollector('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=abc&event=CompleteRegistration') === 'tiktok');
check('classify: analytics-sg.tiktok.com (regional) → tiktok', classifyCollector('https://analytics-sg.tiktok.com/i18n/pixel/track') === 'tiktok');
check('classify: business-api.tiktok.com/open_api → tiktok', classifyCollector('https://business-api.tiktok.com/open_api/v1.3/event/track/') === 'tiktok');
check('classify: www.tiktok.com content page (not tracking) → null', classifyCollector('https://www.tiktok.com/@user/video/123') === null);
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

// ── beaconPlatform: NAMES the specific ad/pixel destination (Phase A) ───────────
check('beacon: GA4 → ga4', beaconPlatform('https://www.google-analytics.com/g/collect?en=x') === 'ga4');
check('beacon: meta → meta', beaconPlatform('https://www.facebook.com/tr?id=1') === 'meta');
check('beacon: LinkedIn → linkedin', beaconPlatform('https://px.ads.linkedin.com/collect?pid=1') === 'linkedin');
check('beacon: Pinterest → pinterest', beaconPlatform('https://ct.pinterest.com/v3/?tid=1') === 'pinterest');
check('beacon: Reddit → reddit', beaconPlatform('https://alb.reddit.com/rp.gif?id=1') === 'reddit');
check('beacon: Snap → snapchat', beaconPlatform('https://tr.snapchat.com/p?pid=1') === 'snapchat');
check('beacon: TikTok web pixel (/i18n/pixel) → tiktok', beaconPlatform('https://analytics.tiktok.com/i18n/pixel/events.js?event=Purchase') === 'tiktok');
check('beacon: Bing → bing', beaconPlatform('https://bat.bing.com/action/0?ti=1') === 'bing');
check('beacon: DoubleClick → google_ads', beaconPlatform('https://ad.doubleclick.net/ddm/activity/src=1') === 'google_ads');
check('beacon: google.com/pagead → google_ads', beaconPlatform('https://www.google.com/pagead/1p-conversion/123') === 'google_ads');
check('beacon: Hotjar → hotjar', beaconPlatform('https://in.hotjar.com/api/v2/x') === 'hotjar');
check('beacon: unknown host → other:<host>', beaconPlatform('https://track.acme-pixel.io/e?id=1') === 'other:track.acme-pixel.io');
check('beacon: garbage url → other', beaconPlatform('not a url') === 'other');
check('beaconHost: extracts the host', beaconHost('https://ct.pinterest.com/v3/?x=1') === 'ct.pinterest.com');
check('isKnownAdPlatform: linkedin yes, ga4/other no', isKnownAdPlatform('linkedin') && !isKnownAdPlatform('ga4') && !isKnownAdPlatform('other:x'));
// Distinct platforms → distinct labels: two ad tags on one interaction are attributable, not both "ad".
check('beacon: LinkedIn ≠ Reddit (per-platform attribution)', beaconPlatform('https://px.ads.linkedin.com/collect') !== beaconPlatform('https://alb.reddit.com/rp.gif'));

// ── describeHit: DevTools-Network-style summary of a captured call ───────────────
{
  const meta = describeHit('https://www.facebook.com/tr?id=123&ev=PageView&eid=abc123def456');
  check('describe: Meta pixel vendor', meta.vendor === 'meta');
  check('describe: Meta endpoint', meta.endpoint === 'www.facebook.com/tr');
  check('describe: Meta params (ev + id)', /ev=PageView/.test(meta.params) && /id=123/.test(meta.params));
}
{
  const ga4 = describeHit('https://www.google-analytics.com/g/collect?v=2&tid=G-1&en=form_submission');
  check('describe: GA4 vendor', ga4.vendor === 'ga4');
  check('describe: GA4 params (en + tid)', /en=form_submission/.test(ga4.params) && /tid=G-1/.test(ga4.params));
}
{
  // First-party sGTM relay — a /g/collect on a NON-Google host.
  const s = describeHit('https://sgtm.samarthanalytics.com/g/collect?v=2&tid=G-1&en=form_submission');
  check('describe: first-party sGTM → vendor sgtm', s.vendor === 'sgtm');
  check('describe: sGTM endpoint keeps host+path', s.endpoint === 'sgtm.samarthanalytics.com/g/collect');
}
{
  const li = describeHit('https://px.ads.linkedin.com/collect?pid=99');
  check('describe: LinkedIn vendor', li.vendor === 'linkedin');
  const tt = describeHit('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C1&event=Purchase');
  check('describe: TikTok web pixel vendor', tt.vendor === 'tiktok');
  check('describe: TikTok params show event', /event=Purchase/.test(tt.params));
  const other = describeHit('https://site.com/api/leads');
  check('describe: non-analytics → other', other.vendor === 'other');
}
{
  // buildNetworkLog de-dups identical calls.
  const log = buildNetworkLog([
    { url: 'https://www.facebook.com/tr?id=1&ev=Lead' },
    { url: 'https://www.facebook.com/tr?id=1&ev=Lead' },
    { url: 'https://sgtm.samarthanalytics.com/g/collect?v=2&tid=G-1&en=x' },
  ]);
  check('networkLog: de-dups identical hits', log.length === 2);
  check('networkLog: keeps distinct vendors', log.some((h) => h.vendor === 'meta') && log.some((h) => h.vendor === 'sgtm'));
}

// ── summarizeDataLayer: the dataLayer inspector rows ────────────────────────────
{
  const rows = summarizeDataLayer([
    { event: 'gtm.js', params: { 'gtm.start': 123, 'gtm.uniqueEventId': 1 } },
    { event: 'form_submission', params: { form_name: 'get_in_touch', form_id: 'gform_1', 'gtm.elementId': 'x', eventCallback: 'fn' } },
    { event: 'form_submission', params: { form_name: 'get_in_touch', form_id: 'gform_1' } }, // dup of the above (after noise stripped)
    { event: '', params: { config: 'G-1' } }, // no event → skipped
    { event: 'cta_click', params: { link_text: 'Get a Free Audit', link_url: 'https://x/audit' }, synthetic: true },
  ]);
  const names = rows.map((r) => r.event);
  check('dataLayer: skips pushes with no event name', !names.includes(''));
  check('dataLayer: keeps real event names', names.includes('gtm.js') && names.includes('form_submission') && names.includes('cta_click'));
  const fs = rows.find((r) => r.event === 'form_submission');
  check('dataLayer: surfaces trigger params (form_name/form_id)', /form_name=get_in_touch/.test(fs?.params ?? '') && /form_id=gform_1/.test(fs?.params ?? ''));
  check('dataLayer: strips GTM-internal + callback noise keys', !/gtm\.|eventCallback/.test(fs?.params ?? ''));
  check('dataLayer: de-dups identical event+params', rows.filter((r) => r.event === 'form_submission').length === 1);
  check('dataLayer: gtm.js with only-noise params → empty params', rows.find((r) => r.event === 'gtm.js')?.params === '');
  check('dataLayer: marks synthetic (verifier-pushed) events', rows.find((r) => r.event === 'cta_click')?.synthetic === true);
}

console.log(`\nruntime-capture: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
