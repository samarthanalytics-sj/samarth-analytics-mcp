// Pure tests for the Google Ads error shaper. No network, no fixtures on disk.
// Run: npx tsx apps/desktop/src/main/google/__tests__/ads-errors.test.ts
//
// The two assertions that matter most are not the pretty strings: (1) the quota message is tested
// against the REAL QUOTA_RE imported from quota-retry, so the two files cannot drift apart and
// silently lose backoff, and (2) a gaxios error carrying a developer token and a bearer in its
// config.headers must not leak either one into anything we show or log.

import { adsErrorInfo, isAdsScopeGap } from '../ads-errors';
import { QUOTA_RE } from '../quota-retry';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else failures.push(`x ${name}${detail ? ': ' + detail : ''}`);
}

const EM_DASH = String.fromCharCode(0x2014);
const V = 'v24';

// Fake secrets. Shaped like the real things so a naive "looks like a token" scrub would be tempted.
const FAKE_DEV_TOKEN = 'zz1AbCdEfGhIjKlMnOpQr';
const FAKE_BEARER = 'ya29.FAKEfakeFAKEfake-not-real-0123456789';

/** The wrapped REST envelope Google actually returns, with a GoogleAdsFailure detail. */
const adsFailure = (
  httpStatus: number,
  statusText: string,
  topMessage: string,
  errorCode: Record<string, string>,
  errMessage: string,
): unknown => ({
  message: `Request failed with status code ${httpStatus}`,
  response: {
    status: httpStatus,
    data: {
      error: {
        code: httpStatus,
        message: topMessage,
        status: statusText,
        details: [
          {
            '@type': `type.googleapis.com/google.ads.googleads.${V}.errors.GoogleAdsFailure`,
            errors: [{ errorCode, message: errMessage }],
            requestId: 'Kl748ALLigZZjqVCuANPZA',
          },
        ],
      },
    },
  },
});

const allInfos: Array<{ message: string; remedy?: string }> = [];
const shaped = (e: unknown): ReturnType<typeof adsErrorInfo> => {
  const info = adsErrorInfo(e);
  allInfos.push(info);
  return info;
};

// -- DEVELOPER_TOKEN_INVALID (AuthenticationError family, unlike its two siblings) ------------------
{
  const info = shaped(
    adsFailure(401, 'UNAUTHENTICATED', 'Request is missing required authentication credential.', { authenticationError: 'DEVELOPER_TOKEN_INVALID' }, 'The developer token is invalid.'),
  );
  check('DEVELOPER_TOKEN_INVALID code', info.code === 'DEVELOPER_TOKEN_INVALID', info.code);
  check('DEVELOPER_TOKEN_INVALID says the header may be missing', /developer-token header/i.test(info.message), info.message);
  check('DEVELOPER_TOKEN_INVALID remedy points at Settings', /Settings/.test(info.remedy ?? ''), info.remedy);
  check('DEVELOPER_TOKEN_INVALID not retryable', info.retryable === false);
}

// -- DEVELOPER_TOKEN_NOT_APPROVED: test-account-only token used on production ----------------------
{
  const info = shaped(
    adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, 'The developer token is only approved for use with test accounts.'),
  );
  check('DEVELOPER_TOKEN_NOT_APPROVED code', info.code === 'DEVELOPER_TOKEN_NOT_APPROVED', info.code);
  check('DEVELOPER_TOKEN_NOT_APPROVED names Test Account Access', /test account access/i.test(info.message), info.message);
  check('DEVELOPER_TOKEN_NOT_APPROVED remedy = apply for Basic in the API Center', /Basic access/.test(info.remedy ?? '') && /API Center/.test(info.remedy ?? ''), info.remedy);
  check('DEVELOPER_TOKEN_NOT_APPROVED status 403', info.status === 403, String(info.status));
}

// -- DEVELOPER_TOKEN_PROHIBITED: the permanent project/token pairing, no in-app fix ----------------
{
  const info = shaped(
    adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { authorizationError: 'DEVELOPER_TOKEN_PROHIBITED' }, "Developer token is not allowed with project '1234567890'."),
  );
  check('DEVELOPER_TOKEN_PROHIBITED code', info.code === 'DEVELOPER_TOKEN_PROHIBITED', info.code);
  check('DEVELOPER_TOKEN_PROHIBITED explains the permanent pairing', /permanently paired/i.test(info.message), info.message);
  check('DEVELOPER_TOKEN_PROHIBITED remedy states plainly that a new Cloud project is needed', /no in-app fix/i.test(info.remedy ?? '') && /Cloud project/i.test(info.remedy ?? ''), info.remedy);
  // A permission failure must never look like a quota failure, or withQuotaRetry would sit in a
  // backoff loop on an error that can never succeed.
  check('DEVELOPER_TOKEN_PROHIBITED does NOT match QUOTA_RE', !QUOTA_RE.test(info.message), info.message);
}

// -- USER_PERMISSION_DENIED: the login-customer-id case -------------------------------------------
{
  const info = shaped(
    adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission to access customer."),
  );
  check('USER_PERMISSION_DENIED code', info.code === 'USER_PERMISSION_DENIED', info.code);
  check('USER_PERMISSION_DENIED remedy names login-customer-id', /login-customer-id/.test(info.remedy ?? ''), info.remedy);
  check('USER_PERMISSION_DENIED remedy says manager account, dashes stripped', /manager account/i.test(info.remedy ?? '') && /dashes stripped/i.test(info.remedy ?? ''), info.remedy);
}

// -- CUSTOMER_NOT_ENABLED: cancelled or suspended account -----------------------------------------
{
  const info = shaped(
    adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { authorizationError: 'CUSTOMER_NOT_ENABLED' }, 'The customer account cannot be accessed because it is not in an enabled state.'),
  );
  check('CUSTOMER_NOT_ENABLED code', info.code === 'CUSTOMER_NOT_ENABLED', info.code);
  check('CUSTOMER_NOT_ENABLED says cancelled or suspended', /cancelled/i.test(info.message) && /suspended/i.test(info.message), info.message);
  check('CUSTOMER_NOT_ENABLED remedy = reactivate in the Google Ads UI', /Google Ads UI/i.test(info.remedy ?? ''), info.remedy);
}

// -- Quota. RESOURCE_TEMPORARILY_EXHAUSTED does NOT contain the literal QUOTA_RE looks for, which is
//    exactly the trap this test exists to catch.
{
  const info = shaped(
    adsFailure(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, 'Too many requests. Retry in 30 seconds.'),
  );
  check('quota is retryable', info.retryable === true);
  check('quota keeps the real enum as the code', info.code === 'RESOURCE_TEMPORARILY_EXHAUSTED', info.code);
  check('quota message MATCHES the real QUOTA_RE from quota-retry', QUOTA_RE.test(info.message), info.message);
  check('quota status 429', info.status === 429, String(info.status));
  check('quota remedy tells the user it backs off', /retry/i.test(info.remedy ?? ''), info.remedy);
}
{
  const info = shaped(
    adsFailure(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', { quotaError: 'RESOURCE_EXHAUSTED' }, 'A system frequency limit has been exceeded.'),
  );
  check('plain RESOURCE_EXHAUSTED also matches QUOTA_RE and is retryable', QUOTA_RE.test(info.message) && info.retryable, info.message);
}
// QuotaError.ACCESS_PROHIBITED sits in the quota family but retrying is futile: it must NOT be
// worded in a way that trips the backoff regex.
{
  const info = shaped(
    adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { quotaError: 'ACCESS_PROHIBITED' }, 'This account is not allowed to use the Google Ads API.'),
  );
  check('ACCESS_PROHIBITED is NOT retryable', info.retryable === false);
  check('ACCESS_PROHIBITED does NOT match QUOTA_RE', !QUOTA_RE.test(info.message), info.message);
}

// -- 401 / expired access token -------------------------------------------------------------------
{
  const info = shaped({
    message: 'Request failed with status code 401',
    response: {
      status: 401,
      data: { error: { code: 401, message: 'Request had invalid authentication credentials. Expected OAuth 2 access token.', status: 'UNAUTHENTICATED' } },
    },
  });
  check('bare 401 is treated as a credentials failure', /credentials/i.test(info.message), info.message);
  check('401 remedy = re-connect the Google account', /re-connect/i.test(info.remedy ?? '') && /Google account/i.test(info.remedy ?? ''), info.remedy);
  check('401 is not retryable', info.retryable === false);
}
{
  const info = shaped(
    adsFailure(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.', { authenticationError: 'OAUTH_TOKEN_EXPIRED' }, 'The OAuth access token has expired.'),
  );
  check('OAUTH_TOKEN_EXPIRED code kept', info.code === 'OAUTH_TOKEN_EXPIRED', info.code);
  check('OAUTH_TOKEN_EXPIRED remedy = re-connect', /re-connect/i.test(info.remedy ?? ''), info.remedy);
}

// -- Missing Ads scope: a 403 ErrorInfo, NOT invalid_grant ----------------------------------------
{
  const scopeErr = {
    message: 'Request failed with status code 403',
    response: {
      status: 403,
      data: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
              domain: 'googleapis.com',
              metadata: { service: 'googleads.googleapis.com', method: 'google.ads.googleads.v24.services.GoogleAdsService.Search' },
            },
          ],
        },
      },
    },
  };
  const info = shaped(scopeErr);
  check('scope gap: isAdsScopeGap true', isAdsScopeGap(scopeErr) === true);
  check('scope gap code', info.code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', info.code);
  check('scope gap remedy = re-connect and approve Google Ads', /approve the Google Ads permission/i.test(info.remedy ?? ''), info.remedy);
  // The app's auth-expired chokepoint keys on invalid_grant, so this must never masquerade as one.
  check('scope gap never claims invalid_grant', !/invalid_grant/i.test(info.message), info.message);
  const plainText = shaped(new Error('Request had insufficient authentication scopes.'));
  check('scope gap detected from message text alone', isAdsScopeGap(new Error('Request had insufficient authentication scopes.')) && plainText.code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
  check('isAdsScopeGap false for a token-prohibited failure', isAdsScopeGap(adsFailure(403, 'PERMISSION_DENIED', 'The caller does not have permission', { authorizationError: 'DEVELOPER_TOKEN_PROHIBITED' }, 'x')) === false);
  check('isAdsScopeGap survives junk', isAdsScopeGap(null) === false && isAdsScopeGap(undefined) === false && isAdsScopeGap(42) === false);
}

// -- Transport failures with no parseable body ----------------------------------------------------
for (const errno of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']) {
  const info = shaped(Object.assign(new Error(`connect ${errno} 142.250.180.10:443`), { code: errno }));
  check(`${errno} is retryable`, info.retryable === true);
  check(`${errno} message says the API could not be reached`, /could not be reached/i.test(info.message), info.message);
  check(`${errno} status 0 and code kept`, info.status === 0 && info.code === errno, `${info.status} ${info.code}`);
}
{
  // undici parks the errno on .cause, which is where a fetch-based client puts it.
  const info = shaped(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  check('transport errno read off .cause', info.code === 'ENOTFOUND' && info.retryable, `${info.code}`);
}

// -- SECURITY: the whole reason this module never touches config/headers --------------------------
{
  const gaxiosLike = {
    message: 'Request failed with status code 403',
    code: '403',
    config: {
      url: `https://googleads.googleapis.com/${V}/customers/1234567890/googleAds:search`,
      method: 'POST',
      headers: {
        'developer-token': FAKE_DEV_TOKEN,
        authorization: `Bearer ${FAKE_BEARER}`,
        'login-customer-id': '9876543210',
      },
    },
    request: { responseURL: `https://googleads.googleapis.com/${V}/customers/1234567890/googleAds:search` },
    response: {
      status: 403,
      headers: { 'www-authenticate': `Bearer ${FAKE_BEARER}` },
      data: {
        error: {
          code: 403,
          message: 'The caller does not have permission',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': `type.googleapis.com/google.ads.googleads.${V}.errors.GoogleAdsFailure`,
              errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_PROHIBITED' }, message: "Developer token is not allowed with project '1234567890'." }],
              requestId: 'Kl748ALLigZZjqVCuANPZA',
            },
          ],
        },
      },
    },
  };
  const info = shaped(gaxiosLike);
  check('headers case still classifies correctly', info.code === 'DEVELOPER_TOKEN_PROHIBITED', info.code);
  check('message does not leak the developer token', !info.message.includes(FAKE_DEV_TOKEN), info.message);
  check('message does not leak the bearer', !info.message.includes(FAKE_BEARER), info.message);
  check('remedy does not leak the developer token', !(info.remedy ?? '').includes(FAKE_DEV_TOKEN), info.remedy);
  check('remedy does not leak the bearer', !(info.remedy ?? '').includes(FAKE_BEARER), info.remedy);
  // Strongest form: nothing anywhere in the returned object, so logging JSON.stringify(info) is safe.
  const serialised = JSON.stringify(info);
  check('nothing in the whole AdsErrorInfo leaks either secret', !serialised.includes(FAKE_DEV_TOKEN) && !serialised.includes(FAKE_BEARER), serialised);
  check('no Authorization value echoed at all', !/Bearer\s+ya29/i.test(serialised), serialised);
}
{
  // Second belt: a client library that echoes the token INTO the message (googleads/google-ads-python#126).
  const info = shaped(
    adsFailure(401, 'UNAUTHENTICATED', `Developer token ${FAKE_DEV_TOKEN} is invalid.`, { authenticationError: 'DEVELOPER_TOKEN_INVALID' }, `developer-token: ${FAKE_DEV_TOKEN} was rejected.`),
  );
  check('a token echoed inside the body message is scrubbed', !info.message.includes(FAKE_DEV_TOKEN), info.message);
  check('the scrub leaves a readable marker', /redacted/i.test(info.message), info.message);
}
{
  // Third shape of the same hazard: a wrapper that stringifies the ENTIRE request (headers and all)
  // into the thrown message, and a curl-style echo. Both arrive as free text on a path this module
  // does read, so the structural "never touch config/headers" rule alone does not cover them: the
  // scrub has to hold, including for JSON punctuation ("developer-token":"...") rather than prose.
  const wholeRequest = new Error(
    JSON.stringify({
      message: 'Request failed with status code 403',
      config: { headers: { 'developer-token': FAKE_DEV_TOKEN, authorization: `Bearer ${FAKE_BEARER}` } },
    }),
  );
  const jsonEcho = shaped(wholeRequest);
  check('a token echoed as a JSON header pair is scrubbed', !JSON.stringify(jsonEcho).includes(FAKE_DEV_TOKEN), jsonEcho.message);
  check('a bearer echoed as a JSON header pair is scrubbed', !JSON.stringify(jsonEcho).includes(FAKE_BEARER), jsonEcho.message);

  const curlEcho = shaped({ message: `-H 'developer-token: ${FAKE_DEV_TOKEN}' -H 'Authorization: Bearer ${FAKE_BEARER}'` });
  check('a curl-style header echo is scrubbed', !JSON.stringify(curlEcho).includes(FAKE_DEV_TOKEN) && !JSON.stringify(curlEcho).includes(FAKE_BEARER), curlEcho.message);
}

// -- Junk inputs: never throw --------------------------------------------------------------------
{
  const cases: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'a string'],
    ['{}', {}],
  ];
  for (const [label, input] of cases) {
    let threw = false;
    let info = adsErrorInfo({});
    try {
      info = adsErrorInfo(input);
    } catch {
      threw = true;
    }
    allInfos.push(info);
    check(`adsErrorInfo(${label}) does not throw`, !threw);
    check(`adsErrorInfo(${label}) is not retryable`, info.retryable === false);
    check(`adsErrorInfo(${label}) has a non-empty message`, info.message.length > 0, info.message);
  }
  check('adsErrorInfo(undefined) status 0 with no code', adsErrorInfo(undefined).status === 0 && adsErrorInfo(undefined).code === '');
  check('adsErrorInfo({}) status 0 with no code', adsErrorInfo({}).status === 0 && adsErrorInfo({}).code === '');
}

// -- Shape quirks that are real on this API -------------------------------------------------------
{
  // searchStream over REST answers with an ARRAY of chunks, so the failure body is array-wrapped.
  const info = shaped({
    response: {
      status: 403,
      data: [
        {
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED',
            details: [{ '@type': `type.googleapis.com/google.ads.googleads.${V}.errors.GoogleAdsFailure`, errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: 'No access.' }] }],
          },
        },
      ],
    },
  });
  check('array-wrapped searchStream body is unwrapped', info.code === 'USER_PERMISSION_DENIED', info.code);
}
{
  // Google's own docs print the bare envelope whose `code` is a gRPC canonical code (3), not an HTTP
  // status. Treating 3 as a status would produce nonsense like "HTTP 3".
  const info = shaped({
    code: 3,
    message: 'The request was invalid.',
    details: [{ '@type': `type.googleapis.com/google.ads.googleads.${V}.errors.GoogleAdsFailure`, errors: [{ errorCode: { fieldError: 'REQUIRED' }, message: 'The required field was not present.' }] }],
  });
  check('gRPC canonical code 3 is not mistaken for an HTTP status', info.status === 0, String(info.status));
  check('unknown enum still surfaces the real reason', info.code === 'REQUIRED' && /required field/i.test(info.message), info.message);
  check('unknown enum is not retryable and offers no invented remedy', info.retryable === false && info.remedy === undefined);
}
{
  const info = shaped({ response: { status: 503, data: { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } } } });
  check('5xx is retryable', info.retryable === true && info.status === 503, `${info.status}`);
}
{
  // A proxy or captive portal can return kilobytes of HTML with newlines. One line, capped.
  const info = shaped({ response: { status: 403, data: { error: { message: `<html>\n<body>\n${'blocked by policy '.repeat(80)}</body>\n</html>`, status: 'PERMISSION_DENIED' } } } });
  check('message stays one line', !/[\r\n]/.test(info.message), info.message);
  check('message is capped', info.message.length < 400, String(info.message.length));
}

// -- Repo rule: no em dashes anywhere we emit -----------------------------------------------------
{
  const offenders = allInfos.filter((i) => i.message.includes(EM_DASH) || (i.remedy ?? '').includes(EM_DASH));
  check('no shaped message or remedy contains an em dash', offenders.length === 0, JSON.stringify(offenders.slice(0, 2)));
}

console.log(`\nads-errors: ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
if (passed < 45) {
  console.error(`ads-errors: expected at least 45 checks, only ran ${passed}`);
  process.exit(1);
}
