// Pure tests for the Google Ads REST row mapper (no network, no Electron).
// Run: tsx apps/desktop/src/main/google/__tests__/ads-map.test.ts
//
// The stakes here are asymmetric: a wrong conversion id/label PAIR produces a tag that fires,
// reports success in Tag Assistant, and records nothing in Google Ads. So most of this file is
// about the pairing, not about field plumbing.

import {
  parseSendTo,
  identityFromSnippets,
  mapConversionAction,
  buildAccountTree,
  resolveConversionCustomer,
  conversionSetupWarnings,
  mapChangeEvent,
  summarizeConversionVolume,
  silentConversionActions,
  auditUtmFindings,
  assembleConversionHealth,
  auditAdsGa4Seam,
  parseUploadOutcome,
  mapUserList,
  mapStructureRow,
  type AdsConversionAction,
} from '../ads-map';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' :: ' + detail : ''}`); }
}

// The real generated event snippet, verbatim in shape: a multi-line gtag script, which is what
// ConversionAction.tag_snippets[].event_snippet actually contains (NOT a bare send_to value).
const eventSnippet = (sendTo: string): string =>
  `<!-- Event snippet for Purchase conversion page -->\n<script>\n  gtag('event', 'conversion', {\n      'send_to': '${sendTo}',\n      'value': 1.0,\n      'currency': 'USD',\n      'transaction_id': ''\n  });\n</script>\n`;

const globalSiteTag = (id: string): string =>
  `<!-- Google tag (gtag.js) -->\n<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>\n<script>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n  gtag('js', new Date());\n  gtag('config', '${id}');\n</script>\n`;

const notes: string[] = [];
const remember = (note: string | undefined): void => { if (note) notes.push(note); };

// ── parseSendTo ──────────────────────────────────────────────────────────────────────────
{
  const bare = parseSendTo('AW-123456789/AbC-dEfGh12_34');
  check('bare send_to yields canonical AW- id', bare?.conversionId === 'AW-123456789', JSON.stringify(bare));
  check('bare send_to yields the label without the id', bare?.conversionLabel === 'AbC-dEfGh12_34', JSON.stringify(bare));

  const full = parseSendTo(eventSnippet('AW-987654321/XyZ_9-aB'));
  check('full multi-line gtag event_snippet parses', full?.conversionId === 'AW-987654321', JSON.stringify(full));
  check('label survives the surrounding quotes and newlines', full?.conversionLabel === 'XyZ_9-aB', JSON.stringify(full));

  // Real labels carry BOTH hyphens and underscores; a charset that stops at either loses half.
  const mixed = parseSendTo("'send_to': 'AW-1/a-b_c-D_2'");
  check('label with hyphens AND underscores kept whole', mixed?.conversionLabel === 'a-b_c-D_2', JSON.stringify(mixed));

  // The Google tag migration serves GT- ids from global_site_tag. A GT- value is never a Google
  // Ads conversion id, so it must not be coerced into one.
  check('GT- only string is not an identity', parseSendTo(globalSiteTag('GT-ABCD123')) === null);
  check('GT- send_to shape is still rejected', parseSendTo("'send_to': 'GT-ABCD123/Label'") === null);
  // A GA4 measurement id shares the "id/label" visual shape but is not AW-.
  check('G- measurement id is not an identity', parseSendTo('G-1A2B3C4D5E/Something') === null);

  check('garbage returns null', parseSendTo('not a snippet at all') === null);
  check('empty string returns null', parseSendTo('') === null);
  check('AW- id with no label returns null', parseSendTo('AW-123456789') === null);
  check('non-string input returns null', parseSendTo(undefined as unknown as string) === null);
}

// ── identityFromSnippets ─────────────────────────────────────────────────────────────────
{
  check('empty array yields no identity', identityFromSnippets([]) === null);
  check('non-array yields no identity', identityFromSnippets(undefined) === null);

  // global_site_tag alone can prove the AW- id but never the label. Half an identity is null.
  const gstOnly = identityFromSnippets([{ type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: globalSiteTag('AW-111222333'), eventSnippet: '' }]);
  check('global_site_tag only yields null (id without a label cannot configure a tag)', gstOnly === null, JSON.stringify(gstOnly));

  // The normal shape: HTML plus AMP entries for the same action, both carrying the same send_to.
  const normal = identityFromSnippets([
    { type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: globalSiteTag('AW-555'), eventSnippet: eventSnippet('AW-555/Lab_1') },
    { type: 'WEBPAGE', pageFormat: 'AMP', globalSiteTag: globalSiteTag('AW-555'), eventSnippet: eventSnippet('AW-555/Lab_1') },
  ]);
  check('two-entry snippet array resolves one identity', normal?.conversionId === 'AW-555' && normal?.conversionLabel === 'Lab_1', JSON.stringify(normal));

  // The invariant: an entry whose global_site_tag advertises the MANAGER id must not contribute
  // that id to a label read from a different entry. Cross-account tracking makes this live data.
  const crossAccount = identityFromSnippets([
    { type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: globalSiteTag('AW-999000111'), eventSnippet: '' },
    { type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: globalSiteTag('AW-222333444'), eventSnippet: eventSnippet('AW-222333444/Own_Label') },
  ]);
  check('id and label come from the SAME entry, never spliced', crossAccount?.conversionId === 'AW-222333444' && crossAccount?.conversionLabel === 'Own_Label', JSON.stringify(crossAccount));

  // snake_case reaches us from proto-shaped fixtures and some client libraries.
  const snake = identityFromSnippets([{ type: 'WEBPAGE', page_format: 'HTML', global_site_tag: globalSiteTag('AW-777'), event_snippet: eventSnippet('AW-777/Sn_ake') }]);
  check('snake_case event_snippet parses identically', snake?.conversionId === 'AW-777' && snake?.conversionLabel === 'Sn_ake', JSON.stringify(snake));
}

// ── mapConversionAction ──────────────────────────────────────────────────────────────────
{
  // A normal WEBPAGE action, in the shape searchStream really returns it (result row wrapper,
  // lowerCamelCase, int64 id as a JSON string).
  const row = {
    conversionAction: {
      resourceName: 'customers/1234567890/conversionActions/876543210',
      id: '876543210',
      name: 'Purchase',
      status: 'ENABLED',
      type: 'WEBPAGE',
      category: 'PURCHASE',
      primaryForGoal: true,
      ownerCustomer: 'customers/1234567890',
      tagSnippets: [
        { type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: globalSiteTag('AW-123456789'), eventSnippet: eventSnippet('AW-123456789/AbC-dEfGh12_34') },
      ],
    },
  };
  const a = mapConversionAction(row);
  remember(a.note);
  check('WEBPAGE action id from the int64-as-string field', a.id === '876543210', a.id);
  check('WEBPAGE action keeps its resource name', a.resourceName === 'customers/1234567890/conversionActions/876543210');
  check('WEBPAGE action name/status/type/category mapped', a.name === 'Purchase' && a.status === 'ENABLED' && a.type === 'WEBPAGE' && a.category === 'PURCHASE');
  check('ownerCustomer parsed to bare digits out of the resource name', a.ownerCustomer === '1234567890', String(a.ownerCustomer));
  check('primaryForGoal carried through', a.primaryForGoal === true);
  check('WEBPAGE action conversionId is canonical', a.conversionId === 'AW-123456789', String(a.conversionId));
  check('WEBPAGE action conversionLabel parsed', a.conversionLabel === 'AbC-dEfGh12_34', String(a.conversionLabel));
  check('WEBPAGE action is taggable with no note', a.taggable === true && a.note === undefined, String(a.note));

  // The same action in snake_case, unwrapped (bare ConversionAction, not a result row).
  const snake = mapConversionAction({
    resource_name: 'customers/1234567890/conversionActions/876543210',
    id: 876543210,
    name: 'Purchase',
    status: 'ENABLED',
    type: 'WEBPAGE',
    category: 'PURCHASE',
    owner_customer: 'customers/1234567890',
    primary_for_goal: true,
    tag_snippets: [{ type: 'WEBPAGE', page_format: 'HTML', global_site_tag: globalSiteTag('AW-123456789'), event_snippet: eventSnippet('AW-123456789/AbC-dEfGh12_34') }],
  });
  remember(snake.note);
  check('snake_case bare action maps identically to camelCase row', JSON.stringify(snake) === JSON.stringify(a), JSON.stringify(snake));

  // UPLOAD_CLICKS: offline conversions have no web snippet at all. Empty tag_snippets is CORRECT
  // data here, not a fetch bug, so the note must say why rather than read as a failure.
  const upload = mapConversionAction({ conversionAction: { resourceName: 'customers/1/conversionActions/2', id: '2', name: 'CRM Sale', status: 'ENABLED', type: 'UPLOAD_CLICKS', category: 'PURCHASE', tagSnippets: [] } });
  remember(upload.note);
  check('UPLOAD_CLICKS is not taggable', upload.taggable === false);
  check('UPLOAD_CLICKS has null id and label', upload.conversionId === null && upload.conversionLabel === null);
  check('UPLOAD_CLICKS note explains the offline origin', /offline/i.test(upload.note ?? ''), String(upload.note));

  // GA4-originated actions are owned by the linked property and are usually status HIDDEN.
  const ga4 = mapConversionAction({ conversionAction: { resourceName: 'customers/1/conversionActions/3', id: '3', name: 'generate_lead (GA4)', status: 'HIDDEN', type: 'GOOGLE_ANALYTICS_4_CUSTOM', category: 'SUBMIT_LEAD_FORM', tagSnippets: [] } });
  remember(ga4.note);
  check('GA4-originated action is not taggable', ga4.taggable === false);
  check('GA4-originated note points at the GA4 event instead', /GA4 event/.test(ga4.note ?? ''), String(ga4.note));
  check('GA4-originated action keeps its HIDDEN status', ga4.status === 'HIDDEN');

  const ga4Purchase = mapConversionAction({ conversionAction: { id: '31', name: 'purchase (GA4)', type: 'GOOGLE_ANALYTICS_4_PURCHASE', status: 'HIDDEN', category: 'PURCHASE', tagSnippets: [] } });
  remember(ga4Purchase.note);
  check('GOOGLE_ANALYTICS_4_PURCHASE is also not taggable', ga4Purchase.taggable === false);

  // A WEBPAGE action whose tagSnippets came back empty: legitimate for a brand-new action that
  // has not generated a snippet yet, so the note must tell the user where to look.
  const emptySnippets = mapConversionAction({ conversionAction: { resourceName: 'customers/1/conversionActions/4', id: '4', name: 'New Lead', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', tagSnippets: [] } });
  remember(emptySnippets.note);
  check('WEBPAGE with empty tagSnippets is not taggable', emptySnippets.taggable === false);
  check('empty tagSnippets note names the missing field', /tag_snippets/.test(emptySnippets.note ?? ''), String(emptySnippets.note));

  // Snippets present but only a global_site_tag: we can name the AW- id but not the label.
  const idOnly = mapConversionAction({ conversionAction: { id: '5', name: 'Half', status: 'ENABLED', type: 'WEBPAGE', category: 'DEFAULT', tagSnippets: [{ type: 'WEBPAGE', globalSiteTag: globalSiteTag('AW-424242'), eventSnippet: '' }] } });
  remember(idOnly.note);
  check('global_site_tag only leaves the action untaggable', idOnly.taggable === false && idOnly.conversionId === null);
  check('global_site_tag only note names the recovered AW- id', (idOnly.note ?? '').includes('AW-424242'), String(idOnly.note));

  // Post Google-tag-migration: the site tag loads a GT- destination. Never report GT- as an id.
  const gtOnly = mapConversionAction({ conversionAction: { id: '6', name: 'Google tag site', status: 'ENABLED', type: 'WEBPAGE', category: 'DEFAULT', tagSnippets: [{ type: 'WEBPAGE', globalSiteTag: globalSiteTag('GT-ABCD123'), eventSnippet: '' }] } });
  remember(gtOnly.note);
  check('GT- site tag never becomes a conversion id', gtOnly.conversionId === null && !(gtOnly.note ?? '').includes('GT-'), String(gtOnly.note));

  // Missing name/status/type must not produce "undefined" strings in the UI.
  const bare = mapConversionAction({ conversionAction: { resourceName: 'customers/1/conversionActions/77' } });
  remember(bare.note);
  check('id recovered from the resource name when the id field is absent', bare.id === '77', bare.id);
  check('missing name falls back to a readable label', bare.name === 'Conversion action 77', bare.name);
  check('missing type/status/category default to UNKNOWN', bare.type === 'UNKNOWN' && bare.status === 'UNKNOWN' && bare.category === 'UNKNOWN');
  check('ownerCustomer and primaryForGoal omitted when absent', bare.ownerCustomer === undefined && bare.primaryForGoal === undefined);

  // Store/app types round out the untaggable table.
  const store = mapConversionAction({ conversionAction: { id: '8', name: 'Store visit', type: 'STORE_VISITS', status: 'ENABLED', category: 'STORE_VISIT', tagSnippets: [] } });
  remember(store.note);
  const app = mapConversionAction({ conversionAction: { id: '9', name: 'App open', type: 'FIREBASE_ANDROID_FIRST_OPEN', status: 'ENABLED', category: 'DEFAULT', tagSnippets: [] } });
  remember(app.note);
  check('STORE_VISITS is not taggable', store.taggable === false);
  check('FIREBASE_ANDROID_FIRST_OPEN is not taggable', app.taggable === false && /app/i.test(app.note ?? ''));

  // Regression: the untaggable table's imported-conversion entry is anchored ^(...)$, so a bare
  // FLOODLIGHT_ alternative matched only the literal string 'FLOODLIGHT_'. The real enum values are
  // FLOODLIGHT_ACTION and FLOODLIGHT_TRANSACTION, and both used to fall through to the generic
  // "confirm the query selected conversion_action.tag_snippets" note, which reads as a broken
  // integration on data that is entirely correct.
  for (const t of ['FLOODLIGHT_ACTION', 'FLOODLIGHT_TRANSACTION']) {
    const fl = mapConversionAction({ conversionAction: { id: '10', name: t, type: t, status: 'ENABLED', category: 'DEFAULT', tagSnippets: [] } });
    remember(fl.note);
    check(`${t} is not taggable`, fl.taggable === false);
    check(`${t} is classified as an imported conversion, not blamed on the query`,
      /originates outside this account/.test(fl.note ?? '') && !/tag_snippets/.test(fl.note ?? ''), String(fl.note));
  }
  // The whole-enum alternatives in that same group must keep working (they rely on the anchors).
  for (const t of ['SEARCH_ADS_360', 'SALESFORCE', 'GOOGLE_HOSTED', 'LEAD_FORM_SUBMIT']) {
    const im = mapConversionAction({ conversionAction: { id: '11', name: t, type: t, status: 'ENABLED', category: 'DEFAULT', tagSnippets: [] } });
    remember(im.note);
    check(`${t} still classified as imported`, im.taggable === false && /originates outside this account/.test(im.note ?? ''), String(im.note));
  }
  // A type that is genuinely unknown must NOT be silently swept into the imported bucket.
  const future = mapConversionAction({ conversionAction: { id: '12', name: 'Future', type: 'SOME_FUTURE_TYPE', status: 'ENABLED', category: 'DEFAULT', tagSnippets: [{ type: 'WEBPAGE', eventSnippet: eventSnippet('AW-1234/Fut_1') }] } });
  check('an unknown type with a real snippet stays taggable', future.taggable === true && future.conversionId === 'AW-1234', JSON.stringify(future));
}

// ── buildAccountTree ─────────────────────────────────────────────────────────────────────
{
  check('empty input yields an empty list', buildAccountTree([]).length === 0);
  check('non-array input does not throw', buildAccountTree(undefined as unknown as unknown[]).length === 0);

  // A manager plus its children, in real searchStream shape: int64 id and level as strings.
  const tree = buildAccountTree(
    [
      { customerClient: { resourceName: 'customers/1000000000/customerClients/1000000000', clientCustomer: 'customers/1000000000', id: '1000000000', descriptiveName: 'Agency MCC', manager: true, level: '0', status: 'ENABLED', currencyCode: 'USD', timeZone: 'America/Los_Angeles' } },
      { customerClient: { clientCustomer: 'customers/2000000000', id: '2000000000', descriptiveName: 'Zeta Client', manager: false, level: '1', status: 'ENABLED', currencyCode: 'EUR', timeZone: 'Europe/Berlin' } },
      { customerClient: { clientCustomer: 'customers/3000000000', id: '3000000000', descriptiveName: 'Alpha Client', manager: false, level: '1', status: 'SUSPENDED' } },
    ],
    '100-000-0000',
  );
  check('manager plus children flattened', tree.length === 3, JSON.stringify(tree.map((t) => t.id)));
  check('managers sort first', tree[0]?.id === '1000000000' && tree[0]?.manager === true);
  check('non-managers sort by name after the managers', tree[1]?.name === 'Alpha Client' && tree[2]?.name === 'Zeta Client', JSON.stringify(tree.map((t) => t.name)));
  check('level parsed from the int64-as-string', tree[0]?.level === 0 && tree[1]?.level === 1);
  check('currency and time zone carried when present', tree[2]?.currencyCode === 'EUR' && tree[2]?.timeZone === 'Europe/Berlin');
  check('currency and time zone omitted when absent', tree[1]?.currencyCode === undefined && tree[1]?.timeZone === undefined);
  check('status carried through', tree[1]?.status === 'SUSPENDED');
  // Dashes are UI formatting only: the login-customer-id header rejects them.
  check('loginCustomerId stamped on every row with dashes stripped', tree.every((t) => t.loginCustomerId === '1000000000'), JSON.stringify(tree.map((t) => t.loginCustomerId)));

  // The same client linked under two managers comes back twice. One row, shallowest link wins,
  // and a blank descriptiveName on the first row must not beat a real name on the second.
  const deduped = buildAccountTree([
    { customerClient: { id: '5000000000', manager: false, level: 2, status: 'ENABLED' } },
    { customerClient: { id: '5000000000', descriptiveName: 'Shared Client', manager: false, level: 1, status: 'ENABLED', currencyCode: 'GBP' } },
  ]);
  check('duplicate client collapses to one row', deduped.length === 1, JSON.stringify(deduped));
  check('shallowest level wins on the merge', deduped[0]?.level === 1, String(deduped[0]?.level));
  check('a real descriptiveName replaces the generated fallback', deduped[0]?.name === 'Shared Client', String(deduped[0]?.name));
  check('fields blank on the first row are filled from the duplicate', deduped[0]?.currencyCode === 'GBP');
  check('loginCustomerId omitted when none was supplied', deduped[0]?.loginCustomerId === undefined);

  // snake_case rows (proto-shaped fixtures) must map the same way.
  const snakeTree = buildAccountTree([
    { customer_client: { client_customer: 'customers/6000000000', id: '6000000000', descriptive_name: 'Snake Co', manager: true, level: 0, status: 'ENABLED', currency_code: 'INR', time_zone: 'Asia/Kolkata' } },
  ], '6000000000');
  check('snake_case customer_client row maps', snakeTree[0]?.name === 'Snake Co' && snakeTree[0]?.manager === true, JSON.stringify(snakeTree));
  check('snake_case currency_code and time_zone map', snakeTree[0]?.currencyCode === 'INR' && snakeTree[0]?.timeZone === 'Asia/Kolkata');

  // No descriptiveName: the fallback must be usable, not "undefined".
  const unnamed = buildAccountTree([{ customerClient: { id: '1234567890', manager: false, level: 1, status: 'ENABLED' } }]);
  check('missing descriptiveName falls back to "Account <id>"', unnamed[0]?.name === 'Account 1234567890', String(unnamed[0]?.name));

  // customerClient.resourceName is customers/{MANAGER}/customerClients/{client}: deriving the id
  // from it would silently list the manager over and over.
  const fromClientCustomer = buildAccountTree([
    { customerClient: { resourceName: 'customers/1000000000/customerClients/7000000000', clientCustomer: 'customers/7000000000', descriptiveName: 'No Id Field', manager: false, level: 1, status: 'ENABLED' } },
  ]);
  check('id falls back to clientCustomer, never to the manager-prefixed resourceName', fromClientCustomer[0]?.id === '7000000000', JSON.stringify(fromClientCustomer));

  const idless = buildAccountTree([{ customerClient: { descriptiveName: 'Nothing usable', manager: false } }]);
  check('a row with no derivable id is dropped, not emitted with a blank id', idless.length === 0);

  // hidden and test_account are SELECTED by GAQL.customerClients (rather than filtered out in the
  // query) precisely so the picker can grey these rows out instead of losing an account the user was
  // looking for. Dropping them in the mapper would make that selection dead weight. test_account
  // matters twice over: a developer token with Test Account Access only can read test accounts and
  // nothing else, which is the DEVELOPER_TOKEN_NOT_APPROVED failure the error module shapes.
  const flagged = buildAccountTree([
    { customerClient: { id: '8000000000', descriptiveName: 'Hidden Test', manager: false, level: 1, status: 'ENABLED', hidden: true, testAccount: true } },
  ]);
  check('hidden survives the mapper', flagged[0]?.hidden === true, JSON.stringify(flagged[0]));
  check('testAccount survives the mapper', flagged[0]?.testAccount === true, JSON.stringify(flagged[0]));
  check('hidden and testAccount default to false rather than undefined',
    unnamed[0]?.hidden === false && unnamed[0]?.testAccount === false, JSON.stringify(unnamed[0]));
  const snakeFlags = buildAccountTree([{ customer_client: { id: '8100000000', manager: false, level: 1, status: 'ENABLED', hidden: true, test_account: true } }]);
  check('snake_case test_account maps', snakeFlags[0]?.testAccount === true && snakeFlags[0]?.hidden === true, JSON.stringify(snakeFlags[0]));

  // hidden belongs to the LINK, so the same client can be hidden under one manager and visible under
  // another: it stays hidden only if every link hides it. test_account belongs to the ACCOUNT, so any
  // row asserting it wins.
  const mergedFlags = buildAccountTree([
    { customerClient: { id: '8200000000', descriptiveName: 'Two Links', manager: false, level: 2, status: 'ENABLED', hidden: true, testAccount: true } },
    { customerClient: { id: '8200000000', descriptiveName: 'Two Links', manager: false, level: 1, status: 'ENABLED', hidden: false, testAccount: false } },
  ]);
  check('hidden under one manager and visible under another resolves to visible',
    mergedFlags[0]?.hidden === false, JSON.stringify(mergedFlags[0]));
  check('testAccount asserted by any row survives the merge',
    mergedFlags[0]?.testAccount === true, JSON.stringify(mergedFlags[0]));
}

// ── resolveConversionCustomer ────────────────────────────────────────────────────────────
{
  // Same-account: conversions are created and managed by the customer we queried.
  const same = resolveConversionCustomer(
    { customer: { resourceName: 'customers/1234567890', id: '1234567890', conversionTrackingSetting: { conversionTrackingId: '1234567890', conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF', googleAdsConversionCustomer: 'customers/1234567890' } } },
    '1234567890',
  );
  check('same-account conversion customer parsed out of the resource name', same.conversionCustomerId === '1234567890', String(same.conversionCustomerId));
  check('same-account is not cross-account', same.isCrossAccount === false);
  check('same-account tracking id carried', same.trackingId === '1234567890');
  check('same-account has no cross-account tracking id', same.crossAccountTrackingId === null);
  check('same-account status carried verbatim', same.status === 'CONVERSION_TRACKING_MANAGED_BY_SELF');

  // Cross-account: the conversion actions live on the manager, so a later query MUST target
  // conversionCustomerId, not the customer we asked about.
  const cross = resolveConversionCustomer(
    { customer: { conversionTrackingSetting: { conversionTrackingId: '1234567890', crossAccountConversionTrackingId: '9998887770', conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER', googleAdsConversionCustomer: 'customers/9998887770' } } },
    '123-456-7890',
  );
  check('cross-account conversion customer differs from the queried customer', cross.conversionCustomerId === '9998887770');
  check('cross-account flagged', cross.isCrossAccount === true);
  check('queried id with UI dashes still compares equal after stripping', resolveConversionCustomer({ customer: { conversionTrackingSetting: { googleAdsConversionCustomer: 'customers/1234567890' } } }, '123-456-7890').isCrossAccount === false);
  check('cross-account tracking id carried', cross.crossAccountTrackingId === '9998887770');

  // MANAGED_BY_ANOTHER_MANAGER is a normal state, not an error: the status is relative to the
  // login-customer-id the request used, so the very same account reads differently per header.
  const other = resolveConversionCustomer({ conversionTrackingSetting: { conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER', googleAdsConversionCustomer: 'customers/5555555555' } }, '1234567890');
  check('MANAGED_BY_ANOTHER_MANAGER resolves normally', other.conversionCustomerId === '5555555555' && other.isCrossAccount === true);
  check('MANAGED_BY_ANOTHER_MANAGER status preserved, not rewritten to an error', other.status === 'CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER');

  // Resource-name-only input (the setting object handed over on its own).
  const bareSetting = resolveConversionCustomer({ googleAdsConversionCustomer: 'customers/4444444444' }, '1234567890');
  check('resource-name-only input still resolves the id', bareSetting.conversionCustomerId === '4444444444', String(bareSetting.conversionCustomerId));
  check('resource-name-only input reports UNKNOWN status rather than throwing', bareSetting.status === 'UNKNOWN');
  check('resource-name-only input has null tracking ids', bareSetting.trackingId === null && bareSetting.crossAccountTrackingId === null);

  // snake_case setting.
  const snake = resolveConversionCustomer({ customer: { conversion_tracking_setting: { conversion_tracking_id: '777', cross_account_conversion_tracking_id: '888', conversion_tracking_status: 'CONVERSION_TRACKING_MANAGED_BY_THIS_MANAGER', google_ads_conversion_customer: 'customers/888' } } }, '777');
  check('snake_case conversion tracking setting maps', snake.conversionCustomerId === '888' && snake.trackingId === '777' && snake.crossAccountTrackingId === '888', JSON.stringify(snake));
  check('snake_case cross-account detected', snake.isCrossAccount === true);

  // proto3 emits 0 for an absent int64: reporting "0" as a tracking id would look like a real
  // account and send the caller chasing a customer that does not exist.
  const zeroed = resolveConversionCustomer({ conversionTrackingSetting: { conversionTrackingId: '0', crossAccountConversionTrackingId: 0, conversionTrackingStatus: 'NOT_CONVERSION_TRACKED' } }, '1234567890');
  check('zero tracking ids report as null', zeroed.trackingId === null && zeroed.crossAccountTrackingId === null);
  check('missing googleAdsConversionCustomer yields null, not cross-account', zeroed.conversionCustomerId === null && zeroed.isCrossAccount === false);

  const empty = resolveConversionCustomer(undefined, '1234567890');
  check('undefined row does not throw', empty.conversionCustomerId === null && empty.status === 'UNKNOWN' && empty.isCrossAccount === false);
}

// ── export-boundary hygiene ──────────────────────────────────────────────────────────────
{
  // Notes render into the UI and into exported reports, both of which ban em/en dashes. The
  // detector is written with escapes on purpose so the banned characters appear nowhere in the
  // repo, not even inside the test that hunts for them.
  const BANNED_DASHES = new RegExp(`[${String.fromCharCode(8212, 8211)}]`);
  const offending = notes.filter((n) => BANNED_DASHES.test(n));
  check('no produced note contains an em dash or en dash', offending.length === 0, offending.join(' | '));
  check('notes were actually collected (the dash check is not vacuous)', notes.length >= 8, String(notes.length));
}

// ── Phase A: full config fields, auto-tagging, and the deterministic setup warnings ──
{
  const full = mapConversionAction({
    conversionAction: {
      resourceName: 'customers/1/conversionActions/9', name: 'Purchase', status: 'ENABLED', type: 'WEBPAGE',
      category: 'PURCHASE', countingType: 'MANY_PER_CLICK',
      attributionModelSettings: { attributionModel: 'GOOGLE_ADS_LAST_CLICK', dataDrivenModelStatus: 'AVAILABLE' },
      clickThroughLookbackWindowDays: '30', viewThroughLookbackWindowDays: 1,
      valueSettings: { defaultValue: 25.5, defaultCurrencyCode: 'usd', alwaysUseDefaultValue: false },
      tagSnippets: [],
    },
  });
  check('full config: counting + attribution + dd status', full.countingType === 'MANY_PER_CLICK' && full.attributionModel === 'GOOGLE_ADS_LAST_CLICK' && full.dataDrivenModelStatus === 'AVAILABLE');
  check('full config: lookback windows accept int64-string AND number', full.clickLookbackDays === 30 && full.viewLookbackDays === 1);
  check('full config: value settings mapped, currency upper-cased', full.defaultValue === 25.5 && full.defaultCurrencyCode === 'USD' && full.alwaysUseDefaultValue === false);
  const snake = mapConversionAction({
    conversion_action: {
      resource_name: 'customers/1/conversionActions/10', name: 'Lead', status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM',
      attribution_model_settings: { attribution_model: 'DATA_DRIVEN' }, click_through_lookback_window_days: '90',
      value_settings: { default_value: '0', always_use_default_value: true }, tag_snippets: [],
    },
  });
  check('full config: snake_case rows read the same fields', snake.attributionModel === 'DATA_DRIVEN' && snake.clickLookbackDays === 90 && snake.defaultValue === 0 && snake.alwaysUseDefaultValue === true);
  const minimal = mapConversionAction({ conversionAction: { resourceName: 'customers/1/conversionActions/11', name: 'Old', status: 'ENABLED', type: 'WEBPAGE', category: 'CONTACT', tagSnippets: [] } });
  check('full config: absent fields stay ABSENT, never 0/empty', !('attributionModel' in minimal) && !('clickLookbackDays' in minimal) && !('defaultValue' in minimal));

  check('auto-tagging: true / false / absent all survive', (() => {
    const on = resolveConversionCustomer({ customer: { autoTaggingEnabled: true, conversionTrackingSetting: {} } }, '1');
    const off = resolveConversionCustomer({ customer: { auto_tagging_enabled: 'false', conversion_tracking_setting: {} } }, '1');
    const unknown = resolveConversionCustomer({ customer: { conversionTrackingSetting: {} } }, '1');
    return on.autoTaggingEnabled === true && off.autoTaggingEnabled === false && unknown.autoTaggingEnabled === undefined;
  })());

  const act = (over: Partial<AdsConversionAction>): AdsConversionAction => ({
    resourceName: 'customers/1/conversionActions/1', id: '1', name: over.name ?? 'A', status: 'ENABLED', type: 'WEBPAGE',
    category: 'SUBMIT_LEAD_FORM', conversionId: null, conversionLabel: null, taggable: false, ...over,
  });
  const dbl = conversionSetupWarnings([
    act({ name: 'GA4 lead import', type: 'GOOGLE_ANALYTICS_4_CUSTOM' }),
    act({ name: 'Website lead', type: 'WEBPAGE' }),
  ]);
  check('warnings: GA4 import + website action, same category, both primary → double-count warning', dbl.length === 1 && dbl[0].includes('double counting') && dbl[0].includes('GA4 lead import') && dbl[0].includes('Website lead'));
  check('warnings: a SECONDARY GA4 import does not fire', conversionSetupWarnings([
    act({ name: 'GA4 import', type: 'GOOGLE_ANALYTICS_4_CUSTOM', primaryForGoal: false }),
    act({ name: 'Website lead' }),
  ]).length === 0);
  check('warnings: different categories do not fire', conversionSetupWarnings([
    act({ name: 'GA4 purchase', type: 'GOOGLE_ANALYTICS_4_CUSTOM', category: 'PURCHASE' }),
    act({ name: 'Website lead' }),
  ]).length === 0);
  check('warnings: paused actions do not fire', conversionSetupWarnings([
    act({ name: 'GA4 import', type: 'GOOGLE_ANALYTICS_4_CUSTOM', status: 'PAUSED' }),
    act({ name: 'Website lead' }),
  ]).length === 0);
  check('warnings: always-use-default with zero/no value → zero-value warning', (() => {
    const w = conversionSetupWarnings([act({ name: 'Zeroed', alwaysUseDefaultValue: true, defaultValue: 0 })]);
    return w.length === 1 && w[0].includes('value 0');
  })());
  check('warnings: always-use-default WITH a real value does not fire', conversionSetupWarnings([
    act({ name: 'Valued', alwaysUseDefaultValue: true, defaultValue: 25 }),
  ]).length === 0);
}

// ── Phase B: change events, conversion volume, UTM findings ──
{
  const ev = mapChangeEvent({
    changeEvent: {
      changeDateTime: '2026-07-20 14:03:22', userEmail: 'ops@acme.com', clientType: 'GOOGLE_ADS_WEB_CLIENT',
      changeResourceType: 'CAMPAIGN_BUDGET', resourceChangeOperation: 'UPDATE',
      changedFields: { paths: ['amount_micros', 'status'] }, changeResourceName: 'customers/1/campaignBudgets/9',
    },
    campaign: { name: 'Brand - Search' },
  });
  check('change event: who/what/when mapped', ev.at === '2026-07-20 14:03:22' && ev.user === 'ops@acme.com' && ev.resourceType === 'CAMPAIGN_BUDGET' && ev.operation === 'UPDATE' && ev.campaignName === 'Brand - Search');
  check('change event: FieldMask paths → changedFields', JSON.stringify(ev.changedFields) === JSON.stringify(['amount_micros', 'status']));
  check('change event: comma-string mask + snake_case row also parse', (() => {
    const e = mapChangeEvent({ change_event: { change_date_time: 'x', changed_fields: 'status, name', resource_change_operation: 'create' } });
    return JSON.stringify(e.changedFields) === JSON.stringify(['status', 'name']) && e.operation === 'CREATE';
  })());

  const volRows = [
    { segments: { date: '2026-07-19', conversionAction: 'customers/1/conversionActions/55', conversionActionName: 'Lead' }, metrics: { allConversions: '3' } },
    { segments: { date: '2026-07-20', conversionAction: 'customers/1/conversionActions/55', conversionActionName: 'Lead' }, metrics: { allConversions: 2 } },
    { segments: { date: '2026-07-20', conversionAction: 'customers/1/conversionActions/77', conversionActionName: 'Purchase' }, metrics: { allConversions: 1 } },
  ];
  const vol = summarizeConversionVolume(volRows);
  check('volume: summed per action, busiest first', vol[0]?.actionId === '55' && vol[0]?.total === 5 && vol[1]?.total === 1);
  check('volume: first/last active day + activeDays', vol[0]?.firstDate === '2026-07-19' && vol[0]?.lastDate === '2026-07-20' && vol[0]?.activeDays === 2);
  const act = (id: string, name: string, status = 'ENABLED'): AdsConversionAction => ({
    resourceName: `customers/1/conversionActions/${id}`, id, name, status, type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM',
    conversionId: null, conversionLabel: null, taggable: false,
  });
  const silent = silentConversionActions([act('55', 'Lead'), act('88', 'Dead form'), act('99', 'Paused one', 'PAUSED')], vol);
  check('silent actions: enabled + zero volume only (paused excluded, active excluded)', silent.length === 1 && silent[0].id === '88');

  const noTagging = auditUtmFindings({ autoTaggingEnabled: false, trackingUrlTemplate: null, finalUrlSuffix: null, campaigns: [] });
  check('utm: auto-tagging off + no manual utm → critical', noTagging.some((f) => f.severity === 'critical' && f.finding.includes('NO gclid and NO UTMs')));
  const partial = auditUtmFindings({
    autoTaggingEnabled: false, trackingUrlTemplate: '{lpurl}?utm_source=google&utm_medium=cpc', finalUrlSuffix: null, campaigns: [],
  });
  check('utm: manual utm missing utm_campaign → warning naming the gap', partial.some((f) => f.severity === 'warning' && f.finding.includes('utm_campaign')));
  const noLpurl = auditUtmFindings({
    autoTaggingEnabled: true, trackingUrlTemplate: null, finalUrlSuffix: null,
    campaigns: [{ id: '1', name: 'Broken', trackingUrlTemplate: 'https://track.example.com/?x=1', finalUrlSuffix: null }],
  });
  check('utm: campaign template without lpurl → critical naming the campaign', noLpurl.some((f) => f.severity === 'critical' && f.finding.includes('"Broken"') && f.finding.includes('{lpurl}')));
  const clean = auditUtmFindings({ autoTaggingEnabled: true, trackingUrlTemplate: null, finalUrlSuffix: null, campaigns: [] });
  check('utm: auto-tagging on + nothing manual → single info, no alarms', clean.length === 1 && clean[0].severity === 'info');
  const manualGclid = auditUtmFindings({ autoTaggingEnabled: true, trackingUrlTemplate: '{lpurl}?gclid={gclid}', finalUrlSuffix: null, campaigns: [] });
  check('utm: manual gclid with auto-tagging on → conflict warning', manualGclid.some((f) => f.severity === 'warning' && f.finding.includes('gclid')));
}

// ── Phase C: conversion-health composite + the Ads↔GA4 seam ──
{
  const act3 = (over: Partial<AdsConversionAction>): AdsConversionAction => ({
    resourceName: 'customers/1/conversionActions/1', id: over.id ?? '1', name: over.name ?? 'A', status: 'ENABLED',
    type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', conversionId: 'AW-1', conversionLabel: 'L', taggable: true, ...over,
  });
  const tracking = { conversionCustomerId: '999', status: 'X', trackingId: null, crossAccountTrackingId: null, isCrossAccount: true };
  const health = assembleConversionHealth({
    tracking,
    actions: [
      act3({ id: '1', name: 'GA4 lead', type: 'GOOGLE_ANALYTICS_4_CUSTOM', taggable: false, conversionLabel: null }),
      act3({ id: '2', name: 'Web lead' }),
      act3({ id: '3', name: 'Unlabelled', conversionLabel: null }),
      act3({ id: '4', name: 'Silent one' }),
    ],
    volume: [{ actionId: '2', name: 'Web lead', total: 5, firstDate: '2026-07-01', lastDate: '2026-07-20', activeDays: 4 }],
    utmFindings: [
      { severity: 'critical', finding: 'no tagging at all' },
      { severity: 'info', finding: 'all clear elsewhere' },
    ],
    changes: [
      { at: '2026-07-19 10:00:00', user: 'x@y.z', clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'CONVERSION_ACTION', operation: 'UPDATE', changedFields: ['status'], resourceName: 'r' },
      { at: '2026-07-18 09:00:00', user: 'x@y.z', clientType: 'GOOGLE_ADS_WEB_CLIENT', resourceType: 'CAMPAIGN', operation: 'REMOVE', changedFields: [], resourceName: 'r2' },
    ],
    performance: [
      { id: 'c1', name: 'Burning', status: 'ENABLED', impressions: 100, clicks: 10, costMicros: 5_000_000, conversions: 0, conversionsValue: 0, allConversions: 0 },
      { id: 'c2', name: 'Fine', status: 'ENABLED', impressions: 100, clicks: 10, costMicros: 5_000_000, conversions: 2, conversionsValue: 10, allConversions: 2 },
    ],
  });
  const areas = new Set(health.map((f) => f.area));
  check('health: folds tagging findings, drops the info all-clear', health.some((f) => f.area === 'tagging' && f.finding === 'no tagging at all') && !health.some((f) => f.finding === 'all clear elsewhere'));
  check('health: double-count surfaces as critical config', health.some((f) => f.area === 'config' && f.severity === 'critical' && f.finding.includes('double counting')));
  check('health: unlabelled website action flagged (GA4 import NOT counted there)', (() => {
    const f = health.find((x) => x.finding.includes('no readable conversion label'));
    return !!f && f.finding.includes('"Unlabelled"') && !f.finding.includes('GA4 lead');
  })());
  check('health: silent actions + burning campaigns under volume', health.some((f) => f.area === 'volume' && f.finding.includes('Silent one')) && health.some((f) => f.area === 'volume' && f.finding.includes('"Burning"') && !f.finding.includes('"Fine"')));
  check('health: conversion-touching change called out with who/when', health.some((f) => f.area === 'changes' && f.finding.includes('x@y.z') && f.finding.includes('CONVERSION_ACTION')));
  check('health: cross-account ownership is INFO, not an alarm', health.some((f) => f.area === 'config' && f.severity === 'info' && f.finding.includes('999')));
  check('health: worst first', health[0].severity === 'critical' && areas.size >= 4);

  const clean = assembleConversionHealth({
    tracking: { ...tracking, isCrossAccount: false, conversionCustomerId: null },
    actions: [act3({ id: '2', name: 'Web lead' })],
    volume: [{ actionId: '2', name: 'Web lead', total: 5, firstDate: '2026-07-01', lastDate: '2026-07-20', activeDays: 4 }],
    utmFindings: [{ severity: 'info', finding: 'auto-tagging on' }],
    changes: [],
    performance: [],
  });
  check('health: clean account → single honest all-clear naming the runtime boundary', clean.length === 1 && clean[0].severity === 'info' && clean[0].finding.includes('runtime'));

  const seamBase = {
    customerId: '123-456-7890',
    actions: [
      act3({ id: '1', name: 'purchase (GA4)', type: 'GOOGLE_ANALYTICS_4_PURCHASE', taggable: false, conversionLabel: null }),
      act3({ id: '2', name: 'stale_event import', type: 'GOOGLE_ANALYTICS_4_CUSTOM', taggable: false, conversionLabel: null }),
    ],
    keyEvents: [{ eventName: 'purchase' }, { eventName: 'generate_lead' }],
  };
  const linked = auditAdsGa4Seam({ ...seamBase, links: [{ customerId: '1234567890', adsPersonalizationEnabled: true, canManageClients: false }] });
  check('seam: direct link recognised (dashed id normalized)', linked.some((f) => f.severity === 'info' && f.finding.includes('linked directly')));
  check('seam: stale import flagged as heuristic, matching one spared', (() => {
    const f = linked.find((x) => x.finding.includes('match NO current key event'));
    return !!f && f.finding.includes('stale_event') && !f.finding.includes('purchase (GA4)') && f.finding.includes('heuristic');
  })());
  check('seam: unimported key event listed as opportunity, not alarm', linked.some((f) => f.severity === 'info' && f.finding.includes('generate_lead')));
  const managerOnly = auditAdsGa4Seam({ ...seamBase, links: [{ customerId: '999', adsPersonalizationEnabled: null, canManageClients: true }] });
  check('seam: manager-level link → warning to confirm, not critical', managerOnly.some((f) => f.severity === 'warning' && f.finding.includes('manager-level')) && !managerOnly.some((f) => f.severity === 'critical' && f.finding.includes('NO Google Ads link')));
  const unlinked = auditAdsGa4Seam({ ...seamBase, links: [] });
  check('seam: no link at all → critical', unlinked.some((f) => f.severity === 'critical' && f.finding.includes('NO Google Ads link')));
}

// ── Phase D/E: upload outcome parsing, user lists, structure rows ──
{
  check('upload outcome: clean 200 → all accepted', (() => {
    const o = parseUploadOutcome({ results: [{}, {}] }, 2);
    return o.accepted === 2 && o.failures.length === 0;
  })());
  check('upload outcome: per-row failure parsed with its index', (() => {
    const o = parseUploadOutcome({
      partialFailureError: {
        code: 3,
        message: 'partial',
        details: [{ errors: [{ message: 'gclid expired', location: { fieldPathElements: [{ fieldName: 'conversions', index: 1 }] } }] }],
      },
    }, 3);
    return o.accepted === 2 && o.failures.length === 1 && o.failures[0].index === 1 && o.failures[0].message === 'gclid expired';
  })());
  check('upload outcome: message-only status → batch-level failure, nothing claimed accepted', (() => {
    const o = parseUploadOutcome({ partialFailureError: { message: 'all bad' } }, 4);
    return o.failures.length === 1 && o.failures[0].index === -1 && o.accepted === 0;
  })());

  const ul = mapUserList({ userList: { id: '9', resourceName: 'customers/1/userLists/9', name: 'Newsletter', type: 'CRM_BASED', membershipStatus: 'OPEN', membershipLifeSpan: '180', sizeForDisplay: '1200', sizeForSearch: 800, readOnly: false, matchRatePercentage: 61 } });
  check('user list: sizes + lifespan + match rate mapped (int64 strings ok)', ul.sizeForDisplay === 1200 && ul.sizeForSearch === 800 && ul.membershipLifeSpanDays === 180 && ul.matchRatePercentage === 61 && ul.type === 'CRM_BASED');

  const kw = mapStructureRow('keywords', {
    campaign: { name: 'Brand' }, adGroup: { name: 'Core' },
    adGroupCriterion: { keyword: { text: 'chownow pos', matchType: 'PHRASE' }, qualityInfo: { qualityScore: 7, creativeQualityScore: 'ABOVE_AVERAGE', postClickQualityScore: 'BELOW_AVERAGE', searchPredictedCtr: 'AVERAGE' } },
  });
  check('structure keywords row: quality trio + names', kw.qualityScore === 7 && kw.landingPageExperience === 'BELOW_AVERAGE' && kw.campaign === 'Brand' && kw.keyword === 'chownow pos');
  const adRow = mapStructureRow('ads', { campaign: { name: 'Brand' }, adGroup: { name: 'Core' }, adGroupAd: { status: 'ENABLED', adStrength: 'GOOD', ad: { id: '345', type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://x.com/a'] } } });
  check('structure ads row: strength + final urls', adRow.adStrength === 'GOOD' && Array.isArray(adRow.finalUrls) && (adRow.finalUrls as string[])[0] === 'https://x.com/a');
}

console.log(`\nads-map: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 60) { console.error(`expected >= 60 checks, got ${passed}`); process.exit(1); }
