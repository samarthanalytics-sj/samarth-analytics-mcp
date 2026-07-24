// Pure tests for the Google Ads REST shape layer (no network, no auth, no Electron).
// Run: cd apps/desktop && npx tsx src/main/google/__tests__/ads-rest.test.ts

import {
  ADS_API_VERSION,
  ADS_BASE,
  normalizeCustomerId,
  listAccessibleCustomersUrl,
  searchStreamUrl,
  mutateConversionActionsUrl,
  adsHeaders,
  GAQL,
  createConversionActionBody,
  defaultCountingType,
  CONVERSION_CATEGORIES,
  isYmdDate,
  perfDateClause,
  clampChangeLimit,
  hashEmail,
  hashPhone,
  isAdsDateTime,
  buildClickConversionsBody,
  buildConversionAdjustmentsBody,
  buildCustomerMatchJobBody,
  buildCustomerMatchOpsBody,
  STRUCTURE_GAQL,
  USER_LISTS_GAQL,
  buildCampaignStatusBody,
  buildCampaignBudgetBody,
  buildConversionActionUpdateBody,
  buildNegativeKeywordsBody,
  buildUserListCreateBody,
  campaignByIdGaql,
  budgetByIdGaql,
  UPLOAD_DIAGNOSTICS_GAQL,
  RECOMMENDATIONS_GAQL,
  EC_LEADS_GAQL,
} from '../ads-rest';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' - ' + detail : ''}`); }
}

const createOf = (body: Record<string, unknown>): Record<string, unknown> => {
  const ops = body.operations as Array<Record<string, unknown>>;
  return (ops[0]?.create ?? {}) as Record<string, unknown>;
};

// ── customer id normalization ───────────────────────────────────────────────────────────────────
{
  check('dashed id loses its dashes', normalizeCustomerId('123-456-7890') === '1234567890');
  check('already-bare id is untouched', normalizeCustomerId('1234567890') === '1234567890');
  check('spaces around and inside are stripped', normalizeCustomerId(' 123 456 7890 ') === '1234567890');
  // The Ads UI separates digit groups with U+00A0, which survives a copy-paste and then fails the
  // request as an AUTH error rather than a parse error. JS \s must be catching it.
  check('non-breaking space is stripped', normalizeCustomerId('123 456 7890') === '1234567890');
  check('mixed dashes and spaces', normalizeCustomerId(' 123- 456 -7890') === '1234567890');
  check('empty stays empty', normalizeCustomerId('') === '');
  check('a dash-only string collapses to empty (not to a lone dash)', normalizeCustomerId('---') === '');
}

// ── URL shapes ──────────────────────────────────────────────────────────────────────────────────
{
  check('version constant is v24', ADS_API_VERSION === 'v24', ADS_API_VERSION);
  check('base has no trailing slash', ADS_BASE === 'https://googleads.googleapis.com', ADS_BASE);

  const list = listAccessibleCustomersUrl();
  check('listAccessibleCustomers exact URL',
    list === 'https://googleads.googleapis.com/v24/customers:listAccessibleCustomers', list);
  check('listAccessibleCustomers carries the version segment', list.includes(`/${ADS_API_VERSION}/`));
  check('listAccessibleCustomers has no customer in the path', !/customers\/\d/.test(list), list);

  const ss = searchStreamUrl('123-456-7890');
  check('searchStream exact URL with dashes stripped',
    ss === 'https://googleads.googleapis.com/v24/customers/1234567890/googleAds:searchStream', ss);
  check('searchStream version segment', ss.includes('/v24/'));
  check('searchStream customer id is bare digits', ss.includes('/customers/1234567890/'), ss);
  check('searchStream is the streaming verb, not :search',
    ss.endsWith('googleAds:searchStream'), ss);
  check('searchStream accepts an already-bare id unchanged',
    searchStreamUrl('1234567890') === ss);

  const mu = mutateConversionActionsUrl('123-456-7890');
  check('conversionActions:mutate exact URL',
    mu === 'https://googleads.googleapis.com/v24/customers/1234567890/conversionActions:mutate', mu);
  check('mutate version segment', mu.includes('/v24/'));
  check('mutate customer id is bare digits', mu.includes('/customers/1234567890/'), mu);
  check('mutate uses lowerCamel resource segment (conversionActions, not conversion_actions)',
    mu.includes('/conversionActions:mutate') && !mu.includes('conversion_actions'), mu);
}

// ── headers ─────────────────────────────────────────────────────────────────────────────────────
{
  const bare = adsHeaders('DEV-TOKEN-123');
  check('developer-token present with the exact lowercase key', bare['developer-token'] === 'DEV-TOKEN-123');
  check('Content-Type is application/json', bare['Content-Type'] === 'application/json');
  // Sending login-customer-id as '' is rejected by the API, so absence must mean the key is gone,
  // not present-and-blank. `in` catches the case a value-only check would miss.
  check('login-customer-id key is absent entirely when not supplied',
    !('login-customer-id' in bare), JSON.stringify(bare));
  check('no extra keys leak in when unsupplied', Object.keys(bare).length === 2, Object.keys(bare).join(','));

  const mgr = adsHeaders('DEV-TOKEN-123', '111-222-3333');
  check('login-customer-id present and normalized', mgr['login-customer-id'] === '1112223333', mgr['login-customer-id']);
  check('login-customer-id uses the exact lowercase key Google requires',
    Object.keys(mgr).includes('login-customer-id'));
  check('developer-token still present alongside login-customer-id', mgr['developer-token'] === 'DEV-TOKEN-123');
  check('blank string login id is treated as absent, not blank',
    !('login-customer-id' in adsHeaders('t', '   ')), JSON.stringify(adsHeaders('t', '   ')));
  check('no Authorization header is fabricated here (the token layer owns it)',
    !Object.keys(mgr).some((k) => k.toLowerCase() === 'authorization'));
}

// ── GAQL ────────────────────────────────────────────────────────────────────────────────────────
{
  const all = [GAQL.customerClients, GAQL.conversionTrackingSetting, GAQL.conversionActions];
  check('no GAQL string is multi-line', all.every((q) => !/[\r\n]/.test(q)));
  check('no GAQL string ends with a semicolon', all.every((q) => !q.trim().endsWith(';')));
  check('every GAQL string has a FROM clause', all.every((q) => / FROM /.test(q)));

  check('customerClients selects from customer_client', GAQL.customerClients.includes('FROM customer_client'));
  check('customerClients caps the walk at level <= 1',
    GAQL.customerClients.includes('WHERE customer_client.level <= 1'), GAQL.customerClients);
  for (const f of ['client_customer', 'id', 'descriptive_name', 'currency_code', 'time_zone', 'level', 'manager', 'status', 'hidden', 'test_account']) {
    check(`customerClients selects customer_client.${f}`, GAQL.customerClients.includes(`customer_client.${f}`));
  }

  check('conversionTrackingSetting selects from customer', GAQL.conversionTrackingSetting.includes('FROM customer'));
  for (const f of ['conversion_tracking_id', 'cross_account_conversion_tracking_id', 'google_ads_conversion_customer', 'accepted_customer_data_terms', 'conversion_tracking_status']) {
    check(`conversionTrackingSetting selects conversion_tracking_setting.${f}`,
      GAQL.conversionTrackingSetting.includes(`customer.conversion_tracking_setting.${f}`));
  }

  check('conversionActions selects from conversion_action', GAQL.conversionActions.includes('FROM conversion_action'));
  for (const f of ['resource_name', 'id', 'name', 'status', 'type', 'category', 'owner_customer', 'primary_for_goal', 'tag_snippets']) {
    check(`conversionActions selects conversion_action.${f}`, GAQL.conversionActions.includes(`conversion_action.${f}`));
  }
  // tag_snippets is the ONLY carrier of the conversion label anywhere in the API. Losing it from
  // this SELECT silently turns the reuse picker into a list of unusable names.
  check('conversionActions cannot lose tag_snippets', GAQL.conversionActions.includes('conversion_action.tag_snippets'));
  // Selecting include_in_conversions_metric makes the API return ONLY primary actions, hiding every
  // secondary one. Regression guard: it must never be added back to this SELECT.
  check('conversionActions never selects include_in_conversions_metric',
    !GAQL.conversionActions.includes('include_in_conversions_metric'), GAQL.conversionActions);
  check('conversionActions is a config read with no metrics or segments',
    !/metrics\.|segments\./.test(GAQL.conversionActions));
}

// ── createConversionActionBody ──────────────────────────────────────────────────────────────────
{
  const body = createConversionActionBody({ name: '  Lead Form Submit  ', category: 'SUBMIT_LEAD_FORM' }, false);
  const c = createOf(body);
  check('one create operation is emitted', (body.operations as unknown[]).length === 1);
  check('name is trimmed', c.name === 'Lead Form Submit', String(c.name));
  // Only WEBPAGE makes Google mint a tag snippet, and without a snippet there is no id/label pair
  // for the GTM awct tag to use.
  check('type is WEBPAGE', c.type === 'WEBPAGE', String(c.type));
  check('status is ENABLED', c.status === 'ENABLED', String(c.status));
  check('category passes through', c.category === 'SUBMIT_LEAD_FORM');
  check('countingType is defaulted from the category', c.countingType === 'ONE_PER_CLICK', String(c.countingType));
  check('partialFailure false keeps the batch transactional', body.partialFailure === false);
  check('validateOnly false honored', body.validateOnly === false);
  check('no valueSettings key when none supplied', !('valueSettings' in c), JSON.stringify(c));
  // Rule-based attribution models are rejected outright and DATA_DRIVEN fails on an action with no
  // history, so this key must never appear at create time.
  check('attributionModelSettings is never emitted', !('attributionModelSettings' in c), JSON.stringify(c));
  check('attributionModelSettings absent from the serialized body too',
    !JSON.stringify(body).includes('attributionModelSettings'));

  const vo = createConversionActionBody({ name: 'Dry run', category: 'PURCHASE' }, true);
  check('validateOnly true honored', vo.validateOnly === true);
  check('validateOnly true still ships the same create shape',
    createOf(vo).type === 'WEBPAGE' && createOf(vo).status === 'ENABLED');
  check('purchase category defaults to MANY_PER_CLICK', createOf(vo).countingType === 'MANY_PER_CLICK');
  check('validateOnly true still emits attributionModelSettings nowhere',
    !JSON.stringify(vo).includes('attributionModelSettings'));

  const override = createConversionActionBody(
    { name: 'Override', category: 'SUBMIT_LEAD_FORM', countingType: 'many_per_click' }, false);
  check('explicit countingType overrides the editorial default and is upper-cased',
    createOf(override).countingType === 'MANY_PER_CLICK', String(createOf(override).countingType));

  const lower = createConversionActionBody({ name: 'x', category: ' purchase ' }, false);
  check('category is trimmed and upper-cased', createOf(lower).category === 'PURCHASE', String(createOf(lower).category));

  const valued = createConversionActionBody(
    { name: 'v', category: 'PURCHASE', valueSettings: { defaultValue: 12.5, defaultCurrencyCode: 'inr', alwaysUseDefaultValue: false } },
    false);
  const vs = createOf(valued).valueSettings as Record<string, unknown>;
  check('valueSettings.defaultValue passes through as a number', vs.defaultValue === 12.5);
  check('defaultCurrencyCode is upper-cased', vs.defaultCurrencyCode === 'INR');
  check('alwaysUseDefaultValue false is preserved, not dropped as falsy', vs.alwaysUseDefaultValue === false);

  const partial = createConversionActionBody(
    { name: 'p', category: 'PURCHASE', valueSettings: { defaultCurrencyCode: '  ' } }, false);
  check('an all-blank valueSettings object is omitted rather than sent empty',
    !('valueSettings' in createOf(partial)), JSON.stringify(createOf(partial)));

  check('body is JSON-serializable with no undefined holes',
    !JSON.stringify(createConversionActionBody({ name: 'j', category: 'CONTACT' }, false)).includes('undefined'));
}

// ── counting-type mapping ───────────────────────────────────────────────────────────────────────
{
  // Written out independently of the module so a silent edit to either table gets caught.
  const expected: Record<string, string> = {
    SUBMIT_LEAD_FORM: 'ONE_PER_CLICK',
    SIGNUP: 'ONE_PER_CLICK',
    CONTACT: 'ONE_PER_CLICK',
    PHONE_CALL_LEAD: 'ONE_PER_CLICK',
    BOOK_APPOINTMENT: 'ONE_PER_CLICK',
    REQUEST_QUOTE: 'ONE_PER_CLICK',
    DOWNLOAD: 'ONE_PER_CLICK',
    PURCHASE: 'MANY_PER_CLICK',
    ADD_TO_CART: 'MANY_PER_CLICK',
    BEGIN_CHECKOUT: 'MANY_PER_CLICK',
    SUBSCRIBE_PAID: 'MANY_PER_CLICK',
  };
  for (const [cat, want] of Object.entries(expected)) {
    check(`defaultCountingType(${cat}) is ${want}`, defaultCountingType(cat) === want, defaultCountingType(cat));
  }
  check('lookup is case and whitespace insensitive', defaultCountingType('  submit_lead_form ') === 'ONE_PER_CLICK');
  // An unknown category must land on the API's own default so we never quietly disagree with the server.
  check('unknown category falls back to the API default MANY_PER_CLICK',
    defaultCountingType('SOME_FUTURE_CATEGORY') === 'MANY_PER_CLICK');
  check('empty category does not throw and falls back', defaultCountingType('') === 'MANY_PER_CLICK');

  check('dropdown is non-empty', CONVERSION_CATEGORIES.length > 0);
  check('dropdown values are unique',
    new Set(CONVERSION_CATEGORIES.map((x) => x.value)).size === CONVERSION_CATEGORIES.length);
  for (const c of CONVERSION_CATEGORIES) {
    check(`dropdown ${c.value}: counting agrees with defaultCountingType`,
      c.counting === defaultCountingType(c.value), `${c.counting} vs ${defaultCountingType(c.value)}`);
    check(`dropdown ${c.value}: counting matches the independent table`,
      c.counting === expected[c.value], c.counting);
    check(`dropdown ${c.value}: has a human label that is not the raw enum`,
      c.label.length > 0 && c.label !== c.value);
    check(`dropdown ${c.value}: value is UPPER_SNAKE`, /^[A-Z][A-Z_]*$/.test(c.value));
  }
  // DOWNLOAD is only legal on a GOOGLE_PLAY_DOWNLOAD action, and everything created here is WEBPAGE,
  // so offering it in the create form would hand the user a guaranteed API rejection.
  check('DOWNLOAD is kept out of the create dropdown (WEBPAGE-only module)',
    !CONVERSION_CATEGORIES.some((x) => x.value === 'DOWNLOAD'));
  check('DOWNLOAD still maps, for categories read back off existing actions',
    defaultCountingType('DOWNLOAD') === 'ONE_PER_CLICK');
}

// ── house style: no em dashes anywhere in the exported surface ───────────────────────────────────
{
  // Written as escapes on purpose: this file must not contain the characters it is banning.
  const EM = String.fromCharCode(0x2014);
  const EN = String.fromCharCode(0x2013);
  const surface: string[] = [
    ADS_API_VERSION,
    ADS_BASE,
    listAccessibleCustomersUrl(),
    searchStreamUrl('123-456-7890'),
    mutateConversionActionsUrl('123-456-7890'),
    JSON.stringify(adsHeaders('t', '1')),
    GAQL.customerClients,
    GAQL.conversionTrackingSetting,
    GAQL.conversionActions,
    JSON.stringify(CONVERSION_CATEGORIES),
    JSON.stringify(createConversionActionBody(
      { name: 'n', category: 'PURCHASE', valueSettings: { defaultValue: 1, defaultCurrencyCode: 'USD' } }, true)),
    ...CONVERSION_CATEGORIES.map((c) => c.label),
    ...CONVERSION_CATEGORIES.map((c) => defaultCountingType(c.value)),
  ];
  check('no exported string contains an em dash', surface.every((s) => !s.includes(EM)),
    surface.filter((s) => s.includes(EM)).join(' | '));
  check('no exported string contains an en dash either', surface.every((s) => !s.includes(EN)),
    surface.filter((s) => s.includes(EN)).join(' | '));
}

// ── Phase A: full conversion-action config fields + auto-tagging + custom date ranges ──
{
  const q = GAQL.conversionActions;
  check('conversionActions selects the attribution model', q.includes('conversion_action.attribution_model_settings.attribution_model'));
  check('conversionActions selects the data-driven model status', q.includes('conversion_action.attribution_model_settings.data_driven_model_status'));
  check('conversionActions selects BOTH lookback windows', q.includes('conversion_action.click_through_lookback_window_days') && q.includes('conversion_action.view_through_lookback_window_days'));
  check('conversionActions selects the value settings', q.includes('conversion_action.value_settings.default_value') && q.includes('conversion_action.value_settings.default_currency_code') && q.includes('conversion_action.value_settings.always_use_default_value'));
  check('conversionActions still does NOT select include_in_conversions_metric (it hides secondary actions)', !q.includes('include_in_conversions_metric'));
  check('conversionTrackingSetting selects auto_tagging_enabled', GAQL.conversionTrackingSetting.includes('customer.auto_tagging_enabled'));

  check('isYmdDate accepts YYYY-MM-DD only', isYmdDate('2026-07-01') && !isYmdDate('2026-7-1') && !isYmdDate('01-07-2026') && !isYmdDate('') && !isYmdDate(undefined));
  const custom = perfDateClause({ startDate: '2026-04-01', endDate: '2026-06-30' });
  check('perfDateClause: valid range → BETWEEN, custom-labelled', custom.custom && custom.clause === "segments.date BETWEEN '2026-04-01' AND '2026-06-30'" && custom.label === '2026-04-01 to 2026-06-30');
  check('perfDateClause: single-day range is allowed (start == end)', perfDateClause({ startDate: '2026-07-21', endDate: '2026-07-21' }).custom);
  check('perfDateClause: start AFTER end falls back to the trailing window', !perfDateClause({ startDate: '2026-06-30', endDate: '2026-04-01' }).custom);
  check('perfDateClause: half a range falls back', !perfDateClause({ startDate: '2026-04-01' }).custom && !perfDateClause({ endDate: '2026-04-01' }).custom);
  check('perfDateClause: malformed date falls back', !perfDateClause({ startDate: '2026/04/01', endDate: '2026-06-30' }).custom);
  check('perfDateClause: no range → clamped trailing window with the honest label', perfDateClause({ days: 10 }).clause.includes('DURING LAST_7_DAYS') && perfDateClause({}).label === 'last 30 days, excluding today');
  check('campaignPerformance embeds the BETWEEN clause for a custom range', GAQL.campaignPerformance({ startDate: '2026-04-01', endDate: '2026-06-30' }).includes("BETWEEN '2026-04-01' AND '2026-06-30'"));
  check('campaignPerformance still uses DURING for a days window', GAQL.campaignPerformance({ days: 14 }).includes('DURING LAST_14_DAYS'));
}

// ── Phase B: change history, conversion volume, UTM setup ──
{
  const ce = GAQL.changeEvents('2026-07-10', '2026-07-22', 500);
  check('changeEvents: selects the who/what/when set', ['change_event.change_date_time', 'change_event.user_email', 'change_event.client_type', 'change_event.change_resource_type', 'change_event.resource_change_operation', 'change_event.changed_fields', 'change_event.change_resource_name'].every((f) => ce.includes(f)));
  check('changeEvents: finite date predicate on BOTH ends', ce.includes(">= '2026-07-10'") && ce.includes("<= '2026-07-22 23:59:59'"));
  check('changeEvents: end-of-day suffix keeps the newest changes (datetime field)', ce.includes('23:59:59'));
  check('changeEvents: ordered newest first WITH a LIMIT', ce.includes('ORDER BY change_event.change_date_time DESC') && ce.endsWith('LIMIT 500'));
  check('clampChangeLimit: nonsense (NaN/0/negative) → default 200, cap 10000', clampChangeLimit(NaN) === 200 && clampChangeLimit(0) === 200 && clampChangeLimit(-5) === 200 && clampChangeLimit(99999) === 10000 && clampChangeLimit(50) === 50);

  const cv = GAQL.conversionVolume({ startDate: '2026-07-01', endDate: '2026-07-21' });
  check('conversionVolume: segments by date + action with all_conversions', ['segments.date', 'segments.conversion_action', 'segments.conversion_action_name', 'metrics.all_conversions'].every((f) => cv.includes(f)));
  check('conversionVolume: reuses the perf date clause (BETWEEN here)', cv.includes("BETWEEN '2026-07-01' AND '2026-07-21'"));

  check('utmCustomer: auto-tagging + account template/suffix', ['customer.auto_tagging_enabled', 'customer.tracking_url_template', 'customer.final_url_suffix'].every((f) => GAQL.utmCustomer.includes(f)));
  check('utmCampaigns: per-campaign template/suffix, ENABLED only', GAQL.utmCampaigns.includes('campaign.tracking_url_template') && GAQL.utmCampaigns.includes("campaign.status = 'ENABLED'"));
}

// ── Phase D: uploads (hashing, datetime, bodies) + Phase E structure GAQL ──
{
  // Known SHA-256 vector so a hashing regression is caught by value, not by shape.
  check('hashEmail: known vector', hashEmail('test@example.com') === '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b');
  check('hashEmail: trims, lowercases, strips gmail dots', hashEmail('  John.Doe@Gmail.com ') === hashEmail('johndoe@gmail.com') && hashEmail('a.b@company.com') !== hashEmail('ab@company.com'));
  check('hashPhone: formatting stripped to E.164 before hashing', hashPhone('+1 (415) 555-1234') === hashPhone('+14155551234'));
  check('isAdsDateTime: requires the timezone offset', isAdsDateTime('2026-07-23 14:30:00+05:30') && !isAdsDateTime('2026-07-23 14:30:00') && !isAdsDateTime('2026-07-23T14:30:00+05:30'));

  const consent = { adUserData: 'GRANTED', adPersonalization: 'DENIED' } as const;
  const body = buildClickConversionsBody(
    [
      { gclid: 'Cj0K', conversionActionResource: 'customers/1/conversionActions/55', conversionDateTime: '2026-07-23 10:00:00+05:30', conversionValue: 25, currencyCode: 'inr', orderId: 'o-1' },
      { email: 'Lead@Example.com', conversionActionResource: 'customers/1/conversionActions/55', conversionDateTime: '2026-07-23 10:00:00+05:30' },
    ],
    consent,
  );
  const json = JSON.stringify(body);
  check('click conversions: partialFailure FORCED true', (body as { partialFailure?: boolean }).partialFailure === true);
  check('click conversions: consent rides on EVERY row', (json.match(/"adUserData":"GRANTED"/g) ?? []).length === 2);
  check('click conversions: currency upper-cased, value + orderId kept', json.includes('"currencyCode":"INR"') && json.includes('"conversionValue":25') && json.includes('"orderId":"o-1"'));
  check('click conversions: email row carries the HASH, never the plaintext', json.includes(hashEmail('lead@example.com')) && !/example\.com/i.test(json.replace(/"hashedEmail":"[a-f0-9]{64}"/g, '')));

  const adj = buildConversionAdjustmentsBody([
    { conversionActionResource: 'customers/1/conversionActions/55', adjustmentType: 'RETRACTION', adjustmentDateTime: '2026-07-23 11:00:00+05:30', orderId: 'o-1' },
    { conversionActionResource: 'customers/1/conversionActions/55', adjustmentType: 'RESTATEMENT', adjustmentDateTime: '2026-07-23 11:00:00+05:30', gclid: 'Cj0K', conversionDateTime: '2026-07-20 09:00:00+05:30', restatedValue: 99.5, currencyCode: 'inr' },
  ]);
  const adjJson = JSON.stringify(adj);
  check('adjustments: retraction by orderId; restatement carries value + gclidDateTimePair', adjJson.includes('"orderId":"o-1"') && adjJson.includes('"adjustedValue":99.5') && adjJson.includes('"gclidDateTimePair"') && adjJson.includes('"currencyCode":"INR"'));
  check('adjustments: partialFailure forced true', (adj as { partialFailure?: boolean }).partialFailure === true);

  const job = buildCustomerMatchJobBody('customers/1/userLists/9', consent);
  check('customer match: job type + consent in metadata', JSON.stringify(job).includes('CUSTOMER_MATCH_USER_LIST') && JSON.stringify(job).includes('"adPersonalization":"DENIED"'));
  const ops = buildCustomerMatchOpsBody([{ email: 'a@b.com' }, { phone: '+14155551234' }, {}]);
  check('customer match ops: empty member dropped, partial failure enabled, hashes only', (ops.operations as unknown[]).length === 2 && (ops as { enablePartialFailure?: boolean }).enablePartialFailure === true && !JSON.stringify(ops).includes('a@b.com'));

  check('structure keywords: quality components, NO metrics (config read)', STRUCTURE_GAQL.keywords({}).includes('quality_info.post_click_quality_score') && !STRUCTURE_GAQL.keywords({}).includes('metrics.'));
  check('structure search_terms: date clause + click order + cap', STRUCTURE_GAQL.search_terms({ days: 7 }).includes('DURING LAST_7_DAYS') && STRUCTURE_GAQL.search_terms({}).includes('LIMIT 500'));
  check('structure landing_pages: unexpanded url + conversions', STRUCTURE_GAQL.landing_pages({}).includes('landing_page_view.unexpanded_final_url'));
  check('structure ads: strength + final urls, removed excluded', STRUCTURE_GAQL.ads({}).includes('ad_group_ad.ad_strength') && STRUCTURE_GAQL.ads({}).includes("!= 'REMOVED'"));
  check('user lists: sizes + membership + match rate', ['size_for_display', 'size_for_search', 'membership_status', 'match_rate_percentage'].every((f) => USER_LISTS_GAQL.includes(f)));
}

// ── Phase F: reversible writes (status, budget, action patch, negatives, list create) ──
{
  const st = buildCampaignStatusBody('customers/1/campaigns/7', 'PAUSED', true);
  check('campaign status: masked to status only, validateOnly honoured', JSON.stringify(st).includes('"updateMask":"status"') && JSON.stringify(st).includes('"status":"PAUSED"') && (st as { validateOnly?: boolean }).validateOnly === true && (st as { partialFailure?: boolean }).partialFailure === false);
  const bg = buildCampaignBudgetBody('customers/1/campaignBudgets/9', 50_000_000.4, false);
  check('budget: amount rounded to integer micros, masked to amountMicros', JSON.stringify(bg).includes('"amountMicros":50000000') && JSON.stringify(bg).includes('"updateMask":"amountMicros"'));
  const patch = buildConversionActionUpdateBody('customers/1/conversionActions/55', { primaryForGoal: false, defaultValue: 25, defaultCurrencyCode: 'inr' }, false);
  const pj = JSON.stringify(patch);
  check('action patch: mask covers EXACTLY the supplied fields', pj.includes('"updateMask":"primaryForGoal,valueSettings.defaultValue,valueSettings.defaultCurrencyCode"'));
  check('action patch: secondary + value set, currency upper-cased, nothing else touched', pj.includes('"primaryForGoal":false') && pj.includes('"defaultValue":25') && pj.includes('"INR"') && !pj.includes('countingType') && !pj.includes('"status"'));
  const negs = buildNegativeKeywordsBody('customers/1/campaigns/7', [{ text: ' free stuff ', matchType: 'PHRASE' }], false);
  const nj = JSON.stringify(negs);
  check('negatives: negative=true criteria on the campaign, text trimmed', nj.includes('"negative":true') && nj.includes('"text":"free stuff"') && nj.includes('"matchType":"PHRASE"') && nj.includes('customers/1/campaigns/7'));
  const ul = buildUserListCreateBody('Newsletter leads', 720, false);
  check('user list: CRM CONTACT_INFO list, lifespan capped at 540', JSON.stringify(ul).includes('CONTACT_INFO') && JSON.stringify(ul).includes('"membershipLifeSpan":540'));
  check('user list: default lifespan 180', JSON.stringify(buildUserListCreateBody('X', undefined, false)).includes('"membershipLifeSpan":180'));
  check('by-id lookups embed the bare id', campaignByIdGaql('7-7').includes('campaign.id = 77') && budgetByIdGaql('9').includes('campaign_budget.id = 9'));
}

// ── Phase F2: diagnostic-read GAQL ──
{
  check('upload diagnostics: per-client summary fields', ['offline_conversion_upload_client_summary.client', '.success_ratio', '.total_event_count', '.successful_event_count', '.last_upload_date_time'].every((f) => UPLOAD_DIAGNOSTICS_GAQL.includes(f)));
  check('recommendations: active only, capped, NO impact metrics fetched', RECOMMENDATIONS_GAQL.includes('recommendation.dismissed = FALSE') && RECOMMENDATIONS_GAQL.includes('LIMIT 100') && !RECOMMENDATIONS_GAQL.includes('impact'));
  check('EC-for-leads probe is its OWN query (degrades alone if the field is unsupported)', EC_LEADS_GAQL.includes('enhanced_conversions_for_leads_enabled') && EC_LEADS_GAQL.trim().startsWith('SELECT'));
}

// ── Phase G: WEBSITE_CALL conversion actions (number swap) ──
{
  const web = createConversionActionBody({ name: 'Lead', category: 'SUBMIT_LEAD_FORM' }, false);
  check('type still defaults to WEBPAGE when nothing is asked for', JSON.stringify(web).includes('"type":"WEBPAGE"'));
  const call = createConversionActionBody({ name: 'Calls', category: 'PHONE_CALL_LEAD', type: 'WEBSITE_CALL' }, false);
  check('WEBSITE_CALL is forwarded so a number-swap action can be created', JSON.stringify(call).includes('"type":"WEBSITE_CALL"'));
  check('WEBSITE_CALL keeps the lead counting default', JSON.stringify(call).includes('"countingType":"ONE_PER_CLICK"'));
  const bogus = createConversionActionBody({ name: 'X', category: 'CONTACT', type: 'UPLOAD_CLICKS' as unknown as 'WEBPAGE' }, false);
  check('an untaggable type is NOT forwarded, it falls back to WEBPAGE', JSON.stringify(bogus).includes('"type":"WEBPAGE"'));
  check('the dry-run flag still rides along for a call action', createConversionActionBody({ name: 'X', category: 'PHONE_CALL_LEAD', type: 'WEBSITE_CALL' }, true).validateOnly === true);
}

console.log(`\ndesktop ads-rest: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
// Count floor: guards against an import or a whole block being silently dropped.
if (passed < 150) { console.error(`expected at least 140 assertions, ran ${passed}`); process.exit(1); }
