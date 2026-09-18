import assert from 'node:assert/strict';
import { buildServerCoverage } from '../server-coverage';
import type { AuditTag, AuditTrigger, ContainerSnapshot, ServerContainerSnapshot } from '../gtm-builders';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const tag = (over: Partial<AuditTag>): AuditTag => ({
  tagId: 't', name: 'Tag', type: 'gaawe', firingTriggerId: ['1'], blockingTriggerId: [], paused: false,
  parameter: [], consentSettings: null, ...over,
} as AuditTag);
const evTrigger = (id: string, event: string): AuditTrigger => ({
  triggerId: id, name: `ce - ${event}`, type: 'customEvent',
  customEventFilter: [{ type: 'equals', parameter: [{ key: 'arg0', value: '{{_event}}' }, { key: 'arg1', value: event }] }],
  filter: [], autoEventFilter: [], parameter: [],
} as unknown as AuditTrigger);
const clientTrigger = (id: string): AuditTrigger => ({
  triggerId: id, name: 'All GA4 events', type: 'always', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [],
} as unknown as AuditTrigger);

const web = (over: Partial<ContainerSnapshot> = {}): ContainerSnapshot => ({
  tags: [
    tag({ tagId: 'w1', name: 'GA4 - Config', type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC1234' }] }),
    tag({ tagId: 'w2', name: 'GA4 - Purchase', type: 'gaawe', firingTriggerId: ['10'], parameter: [{ type: 'template', key: 'eventName', value: 'purchase' }, { type: 'template', key: 'measurementIdOverride', value: 'G-ABC1234' }] }),
    tag({ tagId: 'w3', name: 'Meta - Event - Lead Tag', type: 'html', firingTriggerId: ['11'], parameter: [{ type: 'template', key: 'html', value: '<script>fbq("track","Lead")</script>' }] }),
  ],
  triggers: [evTrigger('10', 'purchase'), evTrigger('11', 'generate_lead')],
  variables: [],
  ...over,
});

const server = (over: Partial<ServerContainerSnapshot> = {}): ServerContainerSnapshot => ({
  taggingServerUrls: ['https://sgtm.example.com'],
  clients: [{ clientId: 'c1', name: 'GA4', type: 'gaaw_client' }],
  tags: [
    tag({ tagId: 's1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-ABC1234' }] }),
    tag({ tagId: 's2', name: 'Meta CAPI - Lead', type: 'cvt_x_1', firingTriggerId: ['91'], parameter: [{ type: 'template', key: 'pixelId', value: '123456789012345' }, { type: 'template', key: 'accessToken', value: 'EAAx' }] }),
  ],
  triggers: [clientTrigger('90'), evTrigger('91', 'generate_lead')],
  variables: [],
  transformations: [],
  ...over,
});

const AUDIT_OK = { critical: 0, high: 0, medium: 0, low: 0 };

console.log('\nserver-coverage:');

test('healthy pair: GA4 covered via client+relay, Meta covered per event, 100% coverage', () => {
  const r = buildServerCoverage(web(), server(), AUDIT_OK);
  const ga4 = r.rows.find((x) => x.platform === 'ga4')!;
  assert.equal(ga4.status, 'covered');
  assert.ok(/relay/i.test(ga4.by ?? ''), 'relay named');
  const meta = r.rows.find((x) => x.platform === 'meta')!;
  assert.equal(meta.status, 'covered');
  assert.ok(/Meta CAPI - Lead/.test(meta.by ?? ''), 'covering server tag named');
  assert.equal(r.summary.coveragePct, 100);
  assert.equal(r.score.configuration, 100);
  assert.equal(r.score.overall, 100);
  assert.equal(r.ga4.idsMatch, true, 'G-ABC on both sides');
});

test('no GA4 client → every web GA4 event reads missing, with the fix', () => {
  const r = buildServerCoverage(web(), server({ clients: [] }), AUDIT_OK);
  const ga4 = r.rows.find((x) => x.platform === 'ga4')!;
  assert.equal(ga4.status, 'missing');
  assert.ok(/GA4 client/.test(ga4.recommendation ?? ''));
});

test('web Meta event with no matching server trigger → missing, with the clone template attached', () => {
  const srv = server({ triggers: [clientTrigger('90'), evTrigger('91', 'some_other_event')] });
  const r = buildServerCoverage(web(), srv, AUDIT_OK);
  const meta = r.rows.find((x) => x.platform === 'meta')!;
  assert.equal(meta.status, 'missing');
  assert.deepEqual(meta.template, { tagId: 's2', name: 'Meta CAPI - Lead' }, 'clone source = the existing Meta server tag');
  assert.ok(/Create one from "Meta CAPI - Lead"/.test(meta.recommendation ?? ''), meta.recommendation);
  // ...and the server's unmatched event surfaces as unused.
  assert.deepEqual(r.unusedServer, [{ tag: 'Meta CAPI - Lead', platform: 'meta', event: 'some_other_event' }]);
  assert.equal(r.summary.coveragePct, 50);
});

test('no same-platform server tag at all → no template; the chat-builder tool is the recommendation', () => {
  const none = buildServerCoverage(web(), server({ tags: [], triggers: [] }), AUDIT_OK);
  const meta = none.rows.find((x) => x.platform === 'meta')!;
  assert.equal(meta.status, 'missing');
  assert.equal(meta.template, undefined);
  assert.ok(/create_meta_capi_server_tag/.test(meta.recommendation ?? ''), meta.recommendation);
});

test('an all-events server tag covers a pixel with no extractable event name', () => {
  const w = web({
    tags: [tag({ tagId: 'w4', name: 'TikTok Pixel', type: 'html', firingTriggerId: ['12'], parameter: [{ type: 'template', key: 'html', value: 'ttq.track' }] })],
    triggers: [{ triggerId: '12', name: 'All clicks', type: 'click', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as never],
  });
  const srv = server({
    tags: [tag({ tagId: 's3', name: 'TikTok Events API', type: 'cvt_x_2', firingTriggerId: ['90'], parameter: [] })],
    triggers: [clientTrigger('90')],
  });
  const r = buildServerCoverage(w, srv, AUDIT_OK);
  assert.equal(r.rows[0].status, 'covered');
  assert.ok(/all-events/.test(r.rows[0].by ?? ''));
});

test('not_matchable pixels are honest: excluded from the coverage % and carry a manual-check note', () => {
  const w = web({
    tags: [tag({ tagId: 'w4', name: 'Pinterest Pixel', type: 'html', firingTriggerId: ['12'], parameter: [{ type: 'template', key: 'html', value: 'pintrk("track")' }] })],
    triggers: [{ triggerId: '12', name: 'All clicks', type: 'click', customEventFilter: [], filter: [], autoEventFilter: [], parameter: [] } as never],
  });
  const r = buildServerCoverage(w, server({ tags: [], triggers: [] }), AUDIT_OK);
  assert.equal(r.rows[0].status, 'not_matchable');
  assert.ok(/verify it manually/i.test(r.rows[0].recommendation ?? ''));
  assert.equal(r.summary.coveragePct, null, 'nothing matchable -> no fake percentage');
  assert.equal(r.score.overall, r.score.configuration, 'overall falls back to configuration alone');
});

test('web wiring: not_wired when the Google tag has no server_container_url; wired when hosts match; mismatch otherwise', () => {
  assert.equal(buildServerCoverage(web(), server(), AUDIT_OK).webWiring.status, 'not_wired');
  const wired = web({
    tags: [
      tag({ tagId: 'w1', name: 'GA4 - Config', type: 'googtag', parameter: [
        { type: 'template', key: 'tagId', value: 'G-ABC1234' },
        { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [{ type: 'template', key: 'parameter', value: 'server_container_url' }, { type: 'template', key: 'parameterValue', value: 'https://sgtm.example.com' }] }] },
      ] as never }),
    ],
    triggers: [],
  });
  assert.equal(buildServerCoverage(wired, server(), AUDIT_OK).webWiring.status, 'wired');
  assert.equal(buildServerCoverage(wired, server({ taggingServerUrls: ['https://other.example.org'] }), AUDIT_OK).webWiring.status, 'url_mismatch');
});

test('measurement-id mismatch is reported, and the health score reflects audit findings', () => {
  const srv = server({
    tags: [tag({ tagId: 's1', name: 'GA4 Relay', type: 'sgtmgaaw', firingTriggerId: ['90'], parameter: [{ type: 'template', key: 'measurementId', value: 'G-OTHER999' }] })],
    triggers: [clientTrigger('90')],
  });
  const r = buildServerCoverage(web(), srv, { critical: 1, high: 1, medium: 2, low: 3 });
  assert.equal(r.ga4.idsMatch, false, 'web vs server ids differ');
  assert.equal(r.score.configuration, 100 - 25 - 10 - 6 - 3);
});

// ── Platforms beyond the original four: native types, shape-recognised server tags, ordering ──
test('native Microsoft UET (baut) and LinkedIn Insight (bzi) web tags are classified by TYPE, and X / Snap / Reddit pixels by snippet', () => {
  const w = web({
    tags: [
      tag({ tagId: 'w1', name: 'Bing UET', type: 'baut', firingTriggerId: ['1'], parameter: [{ type: 'template', key: 'tagId', value: '25015051' }] }),
      tag({ tagId: 'w2', name: 'Insight', type: 'bzi', firingTriggerId: ['2'], parameter: [{ type: 'template', key: 'id', value: '6850978' }] }),
      // No "linkedin" in the name; loads from snap.licdn.com -> must be LinkedIn, never Snapchat.
      tag({ tagId: 'w3', name: 'Site pixel', type: 'html', firingTriggerId: ['3'], parameter: [{ type: 'template', key: 'html', value: '<script src="https://snap.licdn.com/li.lms-analytics/insight.min.js"></script>' }] }),
      tag({ tagId: 'w4', name: 'X pixel', type: 'html', firingTriggerId: ['4'], parameter: [{ type: 'template', key: 'html', value: "<script>twq('config','o1abc')</script>" }] }),
      tag({ tagId: 'w5', name: 'Snap Pixel', type: 'html', firingTriggerId: ['5'], parameter: [{ type: 'template', key: 'html', value: "<script>snaptr('init','ab12')</script>" }] }),
      tag({ tagId: 'w6', name: 'Reddit Pixel', type: 'html', firingTriggerId: ['6'], parameter: [{ type: 'template', key: 'html', value: "<script>rdt('init','t2_x')</script>" }] }),
    ],
    triggers: [evTrigger('1', 'purchase'), evTrigger('2', 'sign_up'), evTrigger('3', 'generate_lead'), evTrigger('4', 'purchase'), evTrigger('5', 'purchase'), evTrigger('6', 'sign_up')],
  });
  const r = buildServerCoverage(w, server(), AUDIT_OK);
  const platformOf = (webTag: string) => r.rows.find((x) => x.webTag === webTag)?.platform;
  assert.equal(platformOf('Bing UET'), 'microsoft');
  assert.equal(platformOf('Insight'), 'linkedin');
  assert.equal(platformOf('Site pixel'), 'linkedin', 'snap.licdn.com is LinkedIn, not Snapchat');
  assert.equal(platformOf('X pixel'), 'x');
  assert.equal(platformOf('Snap Pixel'), 'snapchat');
  assert.equal(platformOf('Reddit Pixel'), 'reddit');
  // With no server handler, each row is missing and recommends the platform's own tool.
  const uet = r.rows.find((x) => x.webTag === 'Bing UET')!;
  assert.equal(uet.status, 'missing');
  assert.ok(/create_microsoft_capi_server_tag/.test(uet.recommendation ?? ''), uet.recommendation);
  const xrow = r.rows.find((x) => x.webTag === 'X pixel')!;
  assert.ok(/create_x_capi_server_tag/.test(xrow.recommendation ?? ''), 'X has a typed builder (Tier-1): its tool is recommended');
});

test('a server CAPI tag is matched to its platform by parameter SHAPE (Reddit template), so an unnamed server tag still covers the web event', () => {
  const w = web({
    tags: [tag({ tagId: 'w6', name: 'Reddit Pixel', type: 'html', firingTriggerId: ['6'], parameter: [{ type: 'template', key: 'html', value: "<script>rdt('init','t2_x')</script>" }] })],
    triggers: [evTrigger('6', 'sign_up')],
  });
  const srv = server({
    // Deliberately NOT named "Reddit": only its accountId + accessToken + actionSource shape says so.
    tags: [tag({ tagId: 's9', name: 'Server conversions', type: 'cvt_R1', firingTriggerId: ['91'], parameter: [
      { type: 'template', key: 'accountId', value: 't2_x' }, { type: 'template', key: 'accessToken', value: 'tok' }, { type: 'template', key: 'actionSource', value: 'WEBSITE' },
    ] })],
    triggers: [evTrigger('91', 'sign_up')],
  });
  const r = buildServerCoverage(w, srv, AUDIT_OK);
  const row = r.rows.find((x) => x.webTag === 'Reddit Pixel')!;
  assert.equal(row.platform, 'reddit');
  assert.equal(row.status, 'covered', 'the shape-recognised server tag covers the event');
  assert.ok(/Server conversions/.test(row.by ?? ''), row.by);
});

test('Tier-1 platforms: web pixels classified by name/snippet, a shape-matched Spotify server tag covers its event, X recommends its typed tool', () => {
  const H = (id: string, name: string, trig: string, html: string) =>
    tag({ tagId: id, name, type: 'html', firingTriggerId: [trig], parameter: [{ type: 'template', key: 'html', value: html }] });
  const w = web({
    tags: [
      H('w1', 'X pixel', '1', "<script>twq('config','o1abc')</script>"),
      H('w2', 'Quora Pixel', '2', "<script>qp('init','QP1')</script>"),
      H('w3', 'AdRoll', '3', '<script>adroll_adv_id = "A"; adroll_pix_id = "P";</script>'),
      H('w4', 'Nextdoor', '4', "<script>ndp('init','N')</script>"),
      H('w5', 'Yelp conversion', '5', '<script src="https://www.yelp.com/ads/pixel.js"></script>'),
      H('w6', 'Spotify Ads', '6', '<script src="https://pixel.spotify.com/v1/sp.js"></script>'),
      H('w7', 'Yahoo Ads conversion', '7', "<script>var yahoo_retargeting_id = 'Y';</script>"),
      H('w8', 'RTB House', '8', '<script src="https://creativecdn.com/tags?id=pr_x"></script>'),
    ],
    triggers: [evTrigger('1', 'purchase'), evTrigger('2', 'purchase'), evTrigger('3', 'purchase'), evTrigger('4', 'purchase'), evTrigger('5', 'purchase'), evTrigger('6', 'purchase'), evTrigger('7', 'purchase'), evTrigger('8', 'purchase')],
  });
  const srv = server({
    // Unnamed Spotify server tag: only authToken + connectionId say what it is.
    tags: [tag({ tagId: 's1', name: 'Server conversions', type: 'cvt_S1', firingTriggerId: ['91'], parameter: [
      { type: 'template', key: 'authToken', value: 't' }, { type: 'template', key: 'connectionId', value: 'c' },
    ] })],
    triggers: [evTrigger('91', 'purchase')],
  });
  const r = buildServerCoverage(w, srv, AUDIT_OK);
  const row = (webTag: string) => r.rows.find((x) => x.webTag === webTag)!;
  assert.equal(row('X pixel').platform, 'x');
  assert.equal(row('Quora Pixel').platform, 'quora');
  assert.equal(row('AdRoll').platform, 'adroll');
  assert.equal(row('Nextdoor').platform, 'nextdoor');
  assert.equal(row('Yelp conversion').platform, 'yelp');
  assert.equal(row('Spotify Ads').platform, 'spotify');
  assert.equal(row('Yahoo Ads conversion').platform, 'lineyahoo');
  assert.equal(row('RTB House').platform, 'rtbhouse');
  assert.equal(row('Spotify Ads').status, 'covered', 'the shape-recognised Spotify server tag covers the web event');
  assert.equal(row('X pixel').status, 'missing');
  assert.ok(/create_x_capi_server_tag/.test(row('X pixel').recommendation ?? ''), row('X pixel').recommendation);
  assert.ok(/create_rtb_house_server_tag/.test(row('RTB House').recommendation ?? ''), row('RTB House').recommendation);
});

test('analytics + affiliate web tags classify to their generic platforms (Piwik PRO before Matomo) and recommend the gallery import', () => {
  const H = (id: string, name: string, trig: string, html: string) =>
    tag({ tagId: id, name, type: 'html', firingTriggerId: [trig], parameter: [{ type: 'template', key: 'html', value: html }] });
  const names: Array<[string, string, string]> = [
    ['Mixpanel', "<script>mixpanel.init('t')</script>", 'mixpanel'],
    ['Site analytics', "<script>var _paq = window._paq || []; _paq.push(['setSiteId', '1']);</script>", 'matomo'],
    ['Piwik PRO', '<script src="https://a.containers.piwik.pro/containers/x.js"></script>', 'piwikpro'],
    ['Piano Analytics', '<script>pa.setConfigurations({site: 1})</script>', 'piano'],
    ['Plausible', '<script data-domain="e.com" src="https://plausible.io/js/script.js"></script>', 'plausible'],
    ['Umami', '<script data-website-id="u" src="https://cloud.umami.is/script.js"></script>', 'umami'],
    ['Pirsch', '<script src="https://api.pirsch.io/pa.js"></script>', 'pirsch'],
    ['Snowplow', "<script>snowplow('newTracker','sp','https://c.example.com')</script>", 'snowplow'],
    ['Klaviyo', '<script src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=P"></script>', 'klaviyo'],
    ['Awin', '<script src="https://www.dwin1.com/1.js"></script>', 'awin'],
    ['Commission Junction', '<script src="https://www.mczbf.com/tags/1/tag.js"></script>', 'cj'],
    ['Impact Radius', '<script src="https://utt.impactcdn.com/A1.js"></script>', 'impact'],
    ['Rakuten', '<script src="https://tag.rmp.rakuten.com/1.ct.js?ranMID=1"></script>', 'rakuten'],
    ['ShareASale', '<img src="https://www.shareasale.com/sale.cfm?merchantID=1">', 'shareasale'],
    ['Tradedoubler', '<img src="https://tbs.tradedoubler.com/report?organization=1">', 'tradedoubler'],
    ['Webgains', "<script>ITCVRQ('set','cvr.programId',1)</script>", 'webgains'],
    ['Admitad', "<script>ADMITAD.Invoice.campaign_code='a'</script>", 'admitad'],
    ['Adtraction', '<script>ADT.Tag.tp = 1</script>', 'adtraction'],
    ['Affiliate Future', '<script src="https://scripts.affiliatefuture.com/AFFunctions.js"></script>', 'affiliatefuture'],
    ['Effinity', '<img src="https://track.effiliation.com/servlet/effi.track?effi_id=1">', 'effinity'],
    ['Refersion', '<script src="https://a.refersion.com/tracker/v3/pub_a.js"></script>', 'refersion'],
    ['Tapfiliate', "<script>tap('create','1')</script>", 'tapfiliate'],
    ['Everflow', '<script>EF.conversion({aid:1})</script>', 'everflow'],
    ['Voluum', '<img src="https://trk.example.com/postback?cid=1">', 'voluum'],
  ];
  const w = web({
    tags: names.map(([name, html], i) => H(`w${i}`, name, String(i + 1), html)),
    triggers: names.map((_, i) => evTrigger(String(i + 1), 'purchase')),
  });
  const r = buildServerCoverage(w, server({ tags: [], triggers: [] }), AUDIT_OK);
  for (const [name, , platform] of names) {
    const row = r.rows.find((x) => x.webTag === name)!;
    assert.ok(row, `row for ${name}`);
    assert.equal(row.platform, platform, name);
    assert.equal(row.status, 'missing', name);
    assert.ok(/import_gallery_template \(stape-io\/[a-z0-9-]+\) \+ create_tag/.test(row.recommendation ?? ''), `${name}: ${row.recommendation}`);
  }
});

test('cross-container: web and server both feeding ONE property is critical, and correct wiring is silent', () => {
  // A googtag carries its transport URL inside configSettingsTable, not as a flat parameter.
  const wiredConfig = (url: string) => tag({
    tagId: 'w1', name: 'GA4 - Config', type: 'googtag',
    parameter: [
      { type: 'template', key: 'tagId', value: 'G-ABC1234' },
      { type: 'list', key: 'configSettingsTable', list: [
        { type: 'map', map: [
          { type: 'template', key: 'parameter', value: 'server_container_url' },
          { type: 'template', key: 'parameterValue', value: url },
        ] },
      ] },
    ],
  } as never);
  const xc = (r: ReturnType<typeof buildServerCoverage>, id: string) => r.crossContainer.filter((f) => f.checkId === id);

  // Default fixture: the web Google tag has no transport URL, and the server relays the SAME id.
  const parallel = buildServerCoverage(web(), server(), AUDIT_OK);
  assert.equal(xc(parallel, 'web_server_ga4_parallel').length, 1, 'both legs feed G-ABC1234');
  assert.equal(xc(parallel, 'web_server_ga4_parallel')[0].severity, 'critical');
  assert.equal(xc(parallel, 'web_server_ga4_parallel')[0].autoFixable, false, 'which leg to keep is a judgement call');
  assert.match(xc(parallel, 'web_server_ga4_parallel')[0].message, /counted twice/);

  // Pointed at the tagging server: the web hits flow THROUGH the server, so there is no doubling.
  const wired = buildServerCoverage(web({ tags: [wiredConfig('https://sgtm.example.com')] }), server(), AUDIT_OK);
  assert.equal(xc(wired, 'web_server_ga4_parallel').length, 0, 'wired correctly says nothing');

  // Pointed somewhere else entirely: the server never receives them, so both legs still fire.
  const mismatch = buildServerCoverage(web({ tags: [wiredConfig('https://other.example.com')] }), server(), AUDIT_OK);
  assert.equal(xc(mismatch, 'web_server_ga4_parallel').length, 1, 'a mismatched transport host still doubles');

  // No server relay at all: nothing is duplicated, whatever the web side does.
  const noRelay = buildServerCoverage(web(), server({ tags: [] }), AUDIT_OK);
  assert.equal(xc(noRelay, 'web_server_ga4_parallel').length, 0);
});

test('cross-container: a second Google tag config without the transport URL bypasses the server', () => {
  const cfg = (tagId: string, name: string, url?: string) => tag({
    tagId, name, type: 'googtag',
    parameter: [
      { type: 'template', key: 'tagId', value: 'G-ABC1234' },
      ...(url ? [{ type: 'list', key: 'configSettingsTable', list: [
        { type: 'map', map: [
          { type: 'template', key: 'parameter', value: 'server_container_url' },
          { type: 'template', key: 'parameterValue', value: url },
        ] },
      ] }] : []),
    ],
  } as never);
  const xc = (r: ReturnType<typeof buildServerCoverage>) => r.crossContainer.filter((f) => f.checkId === 'duplicate_web_ga4_config');

  // One wired, one not: whichever loads last wins, so traffic bypasses the server unpredictably.
  const mixed = buildServerCoverage(
    web({ tags: [cfg('w1', 'GA4 - Config', 'https://sgtm.example.com'), cfg('w9', 'GA4 (CMS plugin)')] }),
    server(), AUDIT_OK,
  );
  assert.equal(xc(mixed).length, 1);
  assert.equal(xc(mixed)[0].severity, 'high');
  assert.match(xc(mixed)[0].message, /GA4 \(CMS plugin\)/, 'names the offending tag');

  // Two configs that are BOTH wired are redundant but not a server-side data problem.
  const bothWired = buildServerCoverage(
    web({ tags: [cfg('w1', 'A', 'https://sgtm.example.com'), cfg('w9', 'B', 'https://sgtm.example.com')] }),
    server(), AUDIT_OK,
  );
  assert.equal(xc(bothWired).length, 0, 'no bypass, so no finding');

  // A single config is never a duplicate, wired or not.
  assert.equal(xc(buildServerCoverage(web({ tags: [cfg('w1', 'A')] }), server(), AUDIT_OK)).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
