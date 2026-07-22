// GoogleAdsService: the network-touching Ads layer, exercised entirely against a hand-written fake
// transport (apps/desktop has no mocking library, so every Google fake in this repo is an object literal
// passed as a parameter). Run: tsx src/main/google/__tests__/ads-service.test.ts

import { GoogleAdsService, AdsError, type AdsRequest } from '../ads-service';
import { GOOGLE_ADS_SCOPE } from '../oauth';
import { DESKTOP_GOOGLE_SCOPES } from '../oauth';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else failures.push(`✗ ${name}${detail ? ': ' + detail : ''}`);
}

const ADS_SCOPES = [...new Set([...DESKTOP_GOOGLE_SCOPES, GOOGLE_ADS_SCOPE])].join(' ');
/** What an account that signed in before Google Ads support carries. */
const LEGACY_SCOPES = DESKTOP_GOOGLE_SCOPES.filter((s) => s !== GOOGLE_ADS_SCOPE).join(' ');
const noSleep = async (): Promise<void> => {};

interface Call { url: string; method: string; headers: Record<string, string>; data?: unknown }

/** Routes by substring, like the fakeFetch(routes) pattern in network-location.test.ts. Matches against
 *  the URL *and* the GAQL query body, because every search shares one searchStream URL and only the
 *  query distinguishes them: routing on the URL alone silently serves the wrong fixture. */
function fake(routes: Array<{ match: string; reply: unknown | (() => unknown) }>): { request: AdsRequest; calls: Call[] } {
  const calls: Call[] = [];
  const request: AdsRequest = async (opts) => {
    calls.push({ url: opts.url, method: opts.method, headers: opts.headers, data: opts.data });
    const query = String((opts.data as { query?: string } | undefined)?.query ?? '');
    for (const r of routes) {
      if (opts.url.includes(r.match) || (query !== '' && query.includes(r.match))) {
        const body = typeof r.reply === 'function' ? (r.reply as () => unknown)() : r.reply;
        if (body instanceof Error) throw body;
        return { data: body };
      }
    }
    throw new Error(`no fake route for ${opts.url}`);
  };
  return { request, calls };
}

function svc(routes: Parameters<typeof fake>[0], over: { token?: string | null; scope?: string | null } = {}): { s: GoogleAdsService; calls: Call[] } {
  const f = fake(routes);
  const s = new GoogleAdsService({
    auth: async () => ({ request: f.request, scope: over.scope === undefined ? ADS_SCOPES : over.scope }),
    developerToken: () => (over.token === undefined ? 'dev-token-123' : over.token),
    sleep: noSleep,
  });
  return { s, calls: f.calls };
}

const ACCESSIBLE = { resourceNames: ['customers/111-111-1111'] };
const CLIENT_ROWS = [{ results: [
  { customerClient: { id: '1111111111', descriptiveName: 'Acme Ltd', level: '0', manager: false, status: 'ENABLED', currencyCode: 'GBP' } },
] }];
const SNIPPET = "gtag('event', 'conversion', {'send_to': 'AW-123456789/AbC-dEfGh12_34'});";
const ACTION_ROWS = [{ results: [
  { conversionAction: {
    resourceName: 'customers/1111111111/conversionActions/55', id: '55', name: 'Contact Form',
    status: 'ENABLED', type: 'WEBPAGE', category: 'SUBMIT_LEAD_FORM', primaryForGoal: true,
    tagSnippets: [{ type: 'WEBPAGE', pageFormat: 'HTML', globalSiteTag: '<script></script>', eventSnippet: SNIPPET }],
  } },
] }];
const TRACKING_SELF = [{ results: [
  { customer: { id: '1111111111', conversionTrackingSetting: {
    conversionTrackingId: '123456789', googleAdsConversionCustomer: 'customers/1111111111', conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF',
  } } },
] }];
const TRACKING_CROSS = [{ results: [
  { customer: { id: '1111111111', conversionTrackingSetting: {
    conversionTrackingId: '123456789', crossAccountConversionTrackingId: '999888777',
    googleAdsConversionCustomer: 'customers/9999999999', conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_ANOTHER_MANAGER',
  } } },
] }];

async function main(): Promise<void> {
  // ── readiness: both preconditions fail as a 403 at call time, so they are checked up front ──
  {
    const { s } = svc([], { token: null });
    const r = await s.readiness();
    check('readiness: no developer token is reported, not thrown', r.ready === false && r.reason?.code === 'DEVELOPER_TOKEN_MISSING');
    check('readiness: the no-token remedy names the MANAGER account requirement', /MANAGER/.test(r.reason?.remedy ?? ''));
  }
  {
    // A token minted BEFORE adwords joined the default scope set. Built by subtraction rather than by
    // reusing DESKTOP_GOOGLE_SCOPES, which now CONTAINS adwords and would assert the opposite.
    const { s } = svc([], { scope: LEGACY_SCOPES });
    const r = await s.readiness();
    check('readiness: a token without the adwords scope is caught BEFORE any call', r.ready === false && r.reason?.code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    check('readiness: the scope remedy reassures that GTM/GA4 access is unaffected', /unaffected/i.test(r.reason?.remedy ?? ''));
  }
  {
    const { s } = svc([{ match: 'listAccessibleCustomers', reply: ACCESSIBLE }]);
    check('readiness: token + scope present is ready', (await s.readiness()).ready === true);
  }

  // A missing precondition must not reach the network at all.
  {
    const { s, calls } = svc([{ match: 'listAccessibleCustomers', reply: ACCESSIBLE }], { token: null });
    let threw: unknown = null;
    try { await s.listAccounts(); } catch (e) { threw = e; }
    check('guard: no developer token throws AdsError', threw instanceof AdsError);
    check('guard: no developer token makes ZERO network calls', calls.length === 0);
  }
  {
    const { s, calls } = svc([{ match: 'listAccessibleCustomers', reply: ACCESSIBLE }], { scope: '' });
    let threw: AdsError | null = null;
    try { await s.listAccounts(); } catch (e) { threw = e as AdsError; }
    check('guard: a scope gap throws with scopeGap set (drives a re-connect, not a retry)', threw?.scopeGap === true);
    check('guard: a scope gap makes ZERO network calls', calls.length === 0);
  }

  // ── headers ──
  {
    const { s, calls } = svc([
      { match: 'listAccessibleCustomers', reply: ACCESSIBLE },
      { match: 'googleAds:searchStream', reply: CLIENT_ROWS },
    ]);
    await s.listAccounts();
    const streamCall = calls.find((c) => c.url.includes('searchStream'));
    check('headers: every request carries the developer-token header', calls.every((c) => c.headers['developer-token'] === 'dev-token-123'));
    check('headers: the tree walk sets login-customer-id to the account queried THROUGH', streamCall?.headers['login-customer-id'] === '1111111111');
    check('url: dashes are stripped from the customer id in the path', streamCall?.url.includes('/customers/1111111111/') === true);
  }

  // ── listAccounts ──
  {
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: ACCESSIBLE },
      { match: 'googleAds:searchStream', reply: CLIENT_ROWS },
    ]);
    const accounts = await s.listAccounts();
    check('listAccounts: resolves the seed into a named account', accounts.length === 1 && accounts[0].name === 'Acme Ltd' && accounts[0].id === '1111111111');
  }
  {
    // Two seeds resolving to the SAME client (reachable through two managers) must yield one row.
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: { resourceNames: ['customers/1111111111', 'customers/2222222222'] } },
      { match: 'googleAds:searchStream', reply: CLIENT_ROWS },
    ]);
    const accounts = await s.listAccounts();
    check('listAccounts: the same client reached twice is deduped to one row', accounts.filter((a) => a.id === '1111111111').length === 1);
  }
  {
    // One dead branch must not empty the picker.
    let n = 0;
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: { resourceNames: ['customers/1111111111', 'customers/2222222222'] } },
      { match: 'googleAds:searchStream', reply: (): unknown => {
        n += 1;
        if (n === 1) return Object.assign(new Error('denied'), { response: { status: 403, data: { error: { code: 403, message: 'denied', details: [{ '@type': 'x/GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: 'no' }] }] } } } });
        return CLIENT_ROWS;
      } },
    ]);
    const accounts = await s.listAccounts();
    check('listAccounts: a permission-denied branch is isolated, the rest still resolve', accounts.length === 1);
  }
  {
    const { s } = svc([{ match: 'listAccessibleCustomers', reply: { resourceNames: [] } }]);
    check('listAccounts: no accessible customers returns an empty list, not an error', (await s.listAccounts()).length === 0);
  }

  // ── conversion actions + the id/label pair ──
  {
    const { s } = svc([
      { match: 'conversion_tracking_setting', reply: TRACKING_SELF },
      { match: 'googleAds:searchStream', reply: ACTION_ROWS },
    ]);
    const { actions, conversionCustomer } = await s.listConversionActions('111-111-1111');
    check('listConversionActions: maps the action', actions.length === 1 && actions[0].name === 'Contact Form');
    check('listConversionActions: id and label are parsed out of the SAME snippet', actions[0].conversionId === 'AW-123456789' && actions[0].conversionLabel === 'AbC-dEfGh12_34');
    check('listConversionActions: a WEBPAGE action with a snippet is taggable', actions[0].taggable === true);
    check('listConversionActions: same-account tracking is not flagged cross-account', conversionCustomer.isCrossAccount === false);
  }
  {
    // The query routes by substring, so the tracking query must be matched FIRST; this asserts the
    // service really does resolve the conversion customer before listing.
    const { s } = svc([
      { match: 'conversion_tracking_setting', reply: TRACKING_CROSS },
      { match: 'googleAds:searchStream', reply: ACTION_ROWS },
    ]);
    const { conversionCustomer } = await s.listConversionActions('1111111111');
    check('cross-account: a manager-owned conversion customer is detected', conversionCustomer.isCrossAccount === true && conversionCustomer.conversionCustomerId === '9999999999');
    check('cross-account: MANAGED_BY_ANOTHER_MANAGER is a state, never an error', conversionCustomer.status.includes('ANOTHER_MANAGER'));
  }
  {
    const { s } = svc([
      { match: 'conversion_tracking_setting', reply: TRACKING_SELF },
      { match: 'googleAds:searchStream', reply: [{ results: [] }] },
    ]);
    const { actions } = await s.listConversionActions('1111111111');
    check('listConversionActions: an account with zero actions is an empty list, not an error', actions.length === 0);
  }
  {
    // searchStream answers with an ARRAY of chunks; rows must be flattened across all of them.
    const { s } = svc([
      { match: 'conversion_tracking_setting', reply: TRACKING_SELF },
      { match: 'googleAds:searchStream', reply: [{ results: [ACTION_ROWS[0].results[0]] }, { results: [ACTION_ROWS[0].results[0]] }] },
    ]);
    const { actions } = await s.listConversionActions('1111111111');
    check('searchStream: rows are flattened across every chunk', actions.length === 2);
  }

  // ── create ──
  {
    let streamCalls = 0;
    const { s, calls } = svc([
      { match: 'conversionActions:mutate', reply: { results: [{ resourceName: 'customers/1111111111/conversionActions/55' }] } },
      { match: 'googleAds:searchStream', reply: (): unknown => { streamCalls += 1; return ACTION_ROWS; } },
    ]);
    const made = await s.createConversionAction('1111111111', { name: 'Contact Form', category: 'SUBMIT_LEAD_FORM' });
    check('create: returns the action WITH its id and label', made.conversionId === 'AW-123456789' && made.conversionLabel === 'AbC-dEfGh12_34');
    check('create: re-reads the action, because mutate never returns the label', streamCalls === 1);
    const mutate = calls.find((c) => c.url.includes(':mutate'));
    check('create: the mutate body is a real create (validateOnly false)', (mutate?.data as { validateOnly?: boolean })?.validateOnly === false);
    const q = String((calls.find((c) => c.url.includes('searchStream'))?.data as { query?: string })?.query ?? '');
    check('create: the re-read filter uses AND, not a second WHERE (which is a syntax error)', q.includes('AND conversion_action.resource_name') && q.split('WHERE').length === 2);
  }
  {
    const { s, calls } = svc([{ match: 'conversionActions:mutate', reply: {} }]);
    const err = await s.validateConversionAction('1111111111', { name: 'Dup', category: 'SUBMIT_LEAD_FORM' });
    check('validate: a clean dry run returns null', err === null);
    check('validate: the dry run sets validateOnly true, so nothing is written', (calls[0]?.data as { validateOnly?: boolean })?.validateOnly === true);
  }
  {
    const dup = Object.assign(new Error('dup'), { response: { status: 400, data: { error: { code: 400, message: 'dup', details: [{ '@type': 'x/GoogleAdsFailure', errors: [{ errorCode: { conversionActionError: 'DUPLICATE_NAME' }, message: 'name exists' }] }] } } } });
    const { s } = svc([{ match: 'conversionActions:mutate', reply: dup }]);
    const err = await s.validateConversionAction('1111111111', { name: 'Dup', category: 'SUBMIT_LEAD_FORM' });
    check('validate: a duplicate name comes back as info, not a throw', err !== null && err.code === 'DUPLICATE_NAME');
  }

  // ── retry policy: branch on retryable, never on the message text ──
  {
    let n = 0;
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: (): unknown => {
        n += 1;
        if (n === 1) return Object.assign(new Error('quota'), { response: { status: 429, data: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } } } });
        return ACCESSIBLE;
      } },
      { match: 'googleAds:searchStream', reply: CLIENT_ROWS },
    ]);
    const accounts = await s.listAccounts();
    check('retry: a quota failure is retried and then succeeds', n === 2 && accounts.length === 1);
  }
  {
    // The load-bearing case: a NON-retryable error whose wire text happens to say "quota exceeded" must
    // NOT be retried. Message-driven retry would back off ~14s on something that can never succeed.
    let n = 0;
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: (): unknown => {
        n += 1;
        return Object.assign(new Error('prohibited'), { response: { status: 403, data: { error: { code: 403, message: 'Quota exceeded for this account.', details: [{ '@type': 'x/GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_PROHIBITED' }, message: 'Quota exceeded for this account.' }] }] } } } });
      } },
    ]);
    let threw: AdsError | null = null;
    try { await s.listAccounts(); } catch (e) { threw = e as AdsError; }
    check('retry: a NON-retryable error is not retried even when its text mentions quota', n === 1);
    check('retry: the prohibited-token error surfaces its real code', threw?.info.code === 'DEVELOPER_TOKEN_PROHIBITED');
    check('retry: the prohibited-token remedy is honest that there is no in-app fix', /Cloud project/i.test(threw?.info.remedy ?? ''));
  }
  {
    const notApproved = Object.assign(new Error('x'), { response: { status: 403, data: { error: { code: 403, message: 'not approved', details: [{ '@type': 'x/GoogleAdsFailure', errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'test access' }] }] } } } });
    const { s } = svc([
      { match: 'listAccessibleCustomers', reply: ACCESSIBLE },
      { match: 'googleAds:searchStream', reply: notApproved },
    ]);
    let threw: AdsError | null = null;
    try { await s.listAccounts(); } catch (e) { threw = e as AdsError; }
    // This is the Test-token trap: listAccessibleCustomers succeeds against production ids while every
    // follow-up call fails, so the name-resolution call is the real probe.
    check('test-token trap: the follow-up failure surfaces DEVELOPER_TOKEN_NOT_APPROVED', threw?.info.code === 'DEVELOPER_TOKEN_NOT_APPROVED');
    check('test-token trap: the remedy points at applying for Basic access', /Basic/i.test(threw?.info.remedy ?? ''));
  }

  // ── secrets must never ride out in an error ──
  {
    const leaky = Object.assign(new Error('boom'), {
      config: { headers: { 'developer-token': 'LEAKED_DEV_TOKEN', Authorization: 'Bearer LEAKED_BEARER' } },
      response: { status: 500, data: { error: { code: 500, message: 'server error' } } },
    });
    const { s } = svc([{ match: 'listAccessibleCustomers', reply: leaky }], {});
    let threw: AdsError | null = null;
    try { await s.listAccounts(); } catch (e) { threw = e as AdsError; }
    const dump = JSON.stringify({ m: threw?.message, i: threw?.info });
    check('secrets: the developer token never reaches the surfaced error', !dump.includes('LEAKED_DEV_TOKEN'));
    check('secrets: the bearer token never reaches the surfaced error', !dump.includes('LEAKED_BEARER'));
  }

  // Repo rule: no em dashes at any user-facing boundary.
  {
    const { s } = svc([], { token: null });
    const r = await s.readiness();
    check('no em dashes in the readiness messages', !/[—–]/.test(`${r.reason?.message} ${r.reason?.remedy}`));
  }

  // ── Phase A: a custom date range reaches the WIRE as BETWEEN, and the label reports it ──
  {
    const { s, calls } = svc([{ match: 'FROM campaign', reply: [{ results: [] }] }]);
    const r = await s.campaignPerformance('1111111111', { startDate: '2026-04-01', endDate: '2026-06-30' });
    const query = String((calls[0]?.data as { query?: string } | undefined)?.query ?? '');
    check('perf range: the wire query carries the BETWEEN clause', query.includes("segments.date BETWEEN '2026-04-01' AND '2026-06-30'"));
    check('perf range: windowLabel + custom flag report what ran', r.custom && r.windowLabel === '2026-04-01 to 2026-06-30');
  }
  {
    const { s, calls } = svc([{ match: 'FROM campaign', reply: [{ results: [] }] }]);
    const r = await s.campaignPerformance('1111111111', { days: 14 });
    const query = String((calls[0]?.data as { query?: string } | undefined)?.query ?? '');
    check('perf range: a days window still uses DURING and the honest label', query.includes('DURING LAST_14_DAYS') && !r.custom && r.windowLabel === 'last 14 days, excluding today');
  }

  if (passed < 32) { console.error(`✗ only ${passed} assertions ran (expected 32+)`); process.exit(1); }
  console.log(`\nads-service: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
}

void main();
