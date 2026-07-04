/**
 * GA4 collect parser tests. Run: tsx apps/web-audit-mcp/src/verify/__tests__/ga4-hits.node.test.ts
 */

import { parseCollectRequest, isGa4CollectRequest, isLegacyCollect } from '../ga4-hits.js';
import { harness } from './_helpers.js';

const { check, done } = harness('ga4-hits');

// ── endpoint detection ────────────────────────────────────────────────────────
check('detect: /g/collect is GA4', isGa4CollectRequest('https://www.google-analytics.com/g/collect?v=2'));
check('detect: region subdomain', isGa4CollectRequest('https://region1.google-analytics.com/g/collect?v=2'));
check('detect: legacy /collect', isGa4CollectRequest('https://www.google-analytics.com/collect?v=1'));
check('detect: legacy flag', isLegacyCollect('https://www.google-analytics.com/collect?v=1'));
check('detect: g/collect not legacy', !isLegacyCollect('https://www.google-analytics.com/g/collect?v=2'));
check('detect: non-collect', !isGa4CollectRequest('https://example.test/page'));
check('parse: non-collect yields []', parseCollectRequest({ url: 'https://example.test/page', tRelativeMs: 0 }).length === 0);

// ── GET single hit, full param set ────────────────────────────────────────────
const getUrl =
  'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC&cid=123.456&sid=9988&en=page_view' +
  '&ep.page_type=home&epn.value=9.99&up.plan=pro&upn.age=42&gcs=G111&gcd=13l3l3l3l5' +
  '&dl=https%3A%2F%2Fex.test%2F&dr=https%3A%2F%2Fref.test%2F&_et=1234';
const getHits = parseCollectRequest({ url: getUrl, method: 'GET', tRelativeMs: 812 });
check('GET: one hit', getHits.length === 1);
const g = getHits[0];
check('GET: en', g.en === 'page_view');
check('GET: v/tid/cid/sid', g.v === '2' && g.tid === 'G-ABC' && g.cid === '123.456' && g.sid === '9988');
check('GET: ep string full-key', g.params['ep.page_type'] === 'home');
check('GET: epn kept', g.params['epn.value'] === '9.99');
check('GET: up + upn', g.params['up.plan'] === 'pro' && g.params['upn.age'] === '42');
check('GET: gcs/gcd', g.gcs === 'G111' && g.gcd === '13l3l3l3l5');
check('GET: dl decoded', g.dl === 'https://ex.test/');
check('GET: dr decoded', g.dr === 'https://ref.test/');
check('GET: _et numeric', g.etMs === 1234);
check('GET: transport + tRelativeMs', g.transport === 'GET' && g.tRelativeMs === 812);
check('GET: not legacy', g.legacy === false);

// ── batched POST: common params in query, events in body lines ─────────────────
const postBody = 'en=view_item&ep.item=SKU1&epn.value=5\nen=add_to_cart&epn.value=10&pr1=id123';
const postHits = parseCollectRequest({
  url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-XYZ&cid=1&gcs=G100',
  method: 'POST',
  postData: postBody,
  tRelativeMs: 500,
});
check('POST: two batched events', postHits.length === 2);
check('POST: first event name', postHits[0].en === 'view_item');
check('POST: second event name', postHits[1].en === 'add_to_cart');
check('POST: tid inherited from query', postHits[0].tid === 'G-XYZ' && postHits[1].tid === 'G-XYZ');
check('POST: gcs inherited', postHits[0].gcs === 'G100' && postHits[1].gcs === 'G100');
check('POST: transport POST', postHits[0].transport === 'POST');
check('POST: items detected', postHits[1].hasItems === true);
check('POST: params per line', postHits[1].params['epn.value'] === '10');

// ── query event + body events combine ──────────────────────────────────────────
const combined = parseCollectRequest({
  url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-1&en=page_view',
  method: 'POST',
  postData: 'en=scroll',
  tRelativeMs: 10,
});
check('combined: query event + body event = 2', combined.length === 2);
check('combined: order (query first)', combined[0].en === 'page_view' && combined[1].en === 'scroll');

// ── legacy collect ──────────────────────────────────────────────────────────────
const legacy = parseCollectRequest({ url: 'https://www.google-analytics.com/collect?v=1&tid=UA-1&t=pageview', tRelativeMs: 5 });
check('legacy: captured', legacy.length >= 1);
check('legacy: flagged', legacy[0].legacy === true);

// ── param-only collect (no event) still recorded ───────────────────────────────
const paramOnly = parseCollectRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-9', tRelativeMs: 1 });
check('param-only: one hit with empty en', paramOnly.length === 1 && paramOnly[0].en === '');

// ── robustness ──────────────────────────────────────────────────────────────────
check('robust: garbled body ignored', parseCollectRequest({ url: 'https://www.google-analytics.com/g/collect?v=2', method: 'POST', postData: '\n\n   \n', tRelativeMs: 0 }).length === 1);

done(28);
