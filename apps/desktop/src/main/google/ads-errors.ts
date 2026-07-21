// Pure error shaping for the Google Ads API (REST, v24). Give it a caught `unknown`, get back a line
// that is safe to SHOW a user, safe to LOG, and safe to hand to withQuotaRetry. No I/O, no electron,
// no clock: everything here is a function of its argument.
//
// Four things make an Ads failure different from every other Google error this app already handles,
// and each one is a bug we would otherwise ship:
//
// 1. The actionable cause lives in the response BODY, never in `.message`. The transport reports a
//    bland "The caller does not have permission" while the enum that tells you what to DO
//    (DEVELOPER_TOKEN_PROHIBITED and friends) sits in error.details[] under a GoogleAdsFailure.
//    quota-retry.ts regex-tests the top-level `.message` ONLY, so an unshaped Ads quota error can
//    never trigger backoff. Every message built here folds the identifying token back INTO the
//    message string for exactly that reason, and the test asserts the quota case against the real
//    QUOTA_RE rather than a copy of it.
// 2. The developer-token errors are split across two enum FAMILIES: DEVELOPER_TOKEN_INVALID is an
//    AuthenticationError, while DEVELOPER_TOKEN_NOT_APPROVED and DEVELOPER_TOKEN_PROHIBITED are
//    AuthorizationErrors. Keying off the family is a trap, so we key off the enum VALUE and treat the
//    family name as a label (plus a coarse fallback when Google adds a value we do not know yet).
// 3. SECURITY: a gaxios failure carries the entire request config, and EVERY Ads request carries a
//    `developer-token` header plus an Authorization bearer. This module therefore never reads
//    e.config, e.request, or any headers at all: the redaction is structural, not a filter someone
//    can forget to apply. The string scrub below is the second belt, for the case where a server or a
//    client library echoes the token back inside the message text (the official Python client did
//    exactly that, googleads/google-ads-python#126).
// 4. A missing Ads SCOPE arrives as a 403 with a google.rpc.ErrorInfo reason and no GoogleAdsFailure
//    at all. It is NOT invalid_grant, so the app's existing auth-expired chokepoint never sees it,
//    and the user is left staring at "permission denied" on an account they own. isAdsScopeGap()
//    exists so a caller can route that one case to "re-connect and approve Google Ads".

/** One shaped Google Ads failure. Everything on it is display-safe and log-safe. */
export interface AdsErrorInfo {
  /** The Google Ads error enum when identifiable, e.g. 'DEVELOPER_TOKEN_NOT_APPROVED', else ''.
   *  Transport failures report their node errno here (ECONNREFUSED etc.) and a scope gap reports the
   *  google.rpc.ErrorInfo reason, because both are just as machine-checkable as an Ads enum. */
  code: string;
  /** HTTP status, 0 when unknown. */
  status: number;
  /** Readable one-line message, safe to show a user and safe to log. */
  message: string;
  /** What the user should DO about it, when there is a concrete action. */
  remedy?: string;
  retryable: boolean;
}

/** Shown when the failure carries nothing we can parse. Never blame the user for an unknown. */
const GENERIC = 'The Google Ads API request failed for an unknown reason.';

/** A one-line message stays readable in a toast and in a log line, so cap and flatten the free text
 *  that came off the wire: proxies and captive portals happily return kilobytes of HTML. */
const MAX_DETAIL = 240;

// Second-belt redaction (see note 3): only fires on text we lifted out of a body, never on headers,
// which we do not read. Keyed on the label before the value so a normal sentence ("the developer
// token is invalid") is left alone: a real secret is 8+ opaque characters, "is" is not.
const SECRET_SCRUBS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]'],
  [
    /((?:developer|access|refresh|id)[-_ ]?token|authorization)(\s*["']?\s*[:=]\s*|\s+)["']?([A-Za-z0-9._~+/=-]{8,})/gi,
    '$1 [redacted]',
  ],
];

// Node/undici transport errnos. These mean "the request never reached Google", which is transient by
// definition, so they are the one class we retry without a body to prove it.
const TRANSPORT_CODES =
  /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|EPROTO|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

// google.rpc.Code names, mapped to the HTTP status they are served as. Used ONLY as a last resort:
// the numeric status is always preferred when the transport gave us one.
const STATUS_TEXT_TO_HTTP: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ABORTED: 409,
  ALREADY_EXISTS: 409,
  RESOURCE_EXHAUSTED: 429,
  INTERNAL: 500,
  DATA_LOSS: 500,
  UNIMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** searchStream over REST answers with an ARRAY of chunks, so a failed stream body is
 *  `[{ "error": { ... } }]` rather than the object every other endpoint returns. Unwrap either. */
function firstRecord(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) {
    for (const item of v) {
      const r = asRecord(item);
      if (r) return r;
    }
    return undefined;
  }
  return asRecord(v);
}

function scrub(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_SCRUBS) out = out.replace(re, replacement);
  return out;
}

function cleanText(text: string): string {
  const flat = scrub(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL - 3)}...` : flat;
}

/** Every place a body could be hiding on a thrown value, widest-first. We touch `response.data` but
 *  never `response.headers` or `config`, which is what keeps the developer token out of the output. */
function candidateBodies(e: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const push = (v: unknown): void => {
    const r = firstRecord(v);
    if (r) out.push(r);
  };
  const rec = asRecord(e);
  if (!rec) return out;
  push(asRecord(rec.response)?.data);
  push(rec.data);
  push(rec.body);
  push(rec.error);
  push(rec);
  // Some wrappers stringify the body into the message instead of keeping it structured.
  const msg = asString(rec.message).trim();
  if (msg.startsWith('{') || msg.startsWith('[')) {
    try {
      push(JSON.parse(msg));
    } catch {
      /* not JSON after all, ignore */
    }
  }
  return out;
}

/** The `{ code, message, status, details[] }` envelope, whether it arrived wrapped in `error` (the
 *  normal REST shape) or bare (how Google's own docs print the GoogleAdsFailure sample). */
function envelopeOf(e: unknown): Record<string, unknown> | undefined {
  for (const body of candidateBodies(e)) {
    const wrapped = firstRecord(body.error);
    if (wrapped) return wrapped;
    if (Array.isArray(body.details)) return body;
  }
  return undefined;
}

/** First GoogleAdsError inside the GoogleAdsFailure detail. A failure can carry many errors (one per
 *  bad operation); the first is the one worth putting in a one-line message. */
function failureError(env: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const details = env?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const detail = asRecord(d);
    if (!detail || !Array.isArray(detail.errors)) continue;
    // @type is absent on some hand-rolled and proxied bodies, so accept a missing type but reject a
    // type that is explicitly something else (ErrorInfo, DebugInfo, Help, and friends).
    const type = asString(detail['@type']);
    if (type && !type.includes('GoogleAdsFailure')) continue;
    for (const item of detail.errors) {
      const err = asRecord(item);
      if (err) return err;
    }
  }
  return undefined;
}

/** errorCode is a oneof: exactly one family key is populated, e.g. `{ authorizationError: 'X' }`. */
function enumOf(err: Record<string, unknown> | undefined): { family: string; value: string } {
  const codeObj = asRecord(err?.errorCode);
  if (codeObj) {
    for (const [family, value] of Object.entries(codeObj)) {
      if (typeof value === 'string' && value) return { family, value };
    }
  }
  return { family: '', value: '' };
}

/** google.rpc.ErrorInfo.reason, e.g. ACCESS_TOKEN_SCOPE_INSUFFICIENT or RATE_LIMIT_EXCEEDED. */
function reasonOf(env: Record<string, unknown> | undefined): string {
  const details = env?.details;
  if (!Array.isArray(details)) return '';
  for (const d of details) {
    const reason = asString(asRecord(d)?.reason);
    if (reason) return reason;
  }
  return '';
}

const toStatus = (v: unknown): number => {
  const n = typeof v === 'number' ? v : /^\d+$/.test(asString(v)) ? Number(asString(v)) : NaN;
  // The envelope's `code` is the HTTP status in the wrapped form but a gRPC canonical code (3 =
  // INVALID_ARGUMENT) in the bare form Google's docs print, so anything under 100 is not a status.
  return Number.isFinite(n) && n >= 100 && n <= 599 ? n : 0;
};

function httpStatusOf(e: unknown, env: Record<string, unknown> | undefined): number {
  const rec = asRecord(e);
  return (
    toStatus(asRecord(rec?.response)?.status) ||
    toStatus(rec?.status) ||
    toStatus(rec?.code) || // gaxios parks the status here as a numeric string on some versions
    toStatus(env?.code) ||
    STATUS_TEXT_TO_HTTP[asString(env?.status).toUpperCase()] ||
    0
  );
}

function transportCodeOf(e: unknown): string {
  const rec = asRecord(e);
  const direct = asString(rec?.code).toUpperCase();
  if (TRANSPORT_CODES.test(direct)) return direct;
  const cause = asString(asRecord(rec?.cause)?.code).toUpperCase();
  if (TRANSPORT_CODES.test(cause)) return cause;
  const m = /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b/.exec(
    asString(rec?.message),
  );
  return m?.[1] ?? '';
}

const SCOPE_GAP_RE = /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient_scope/i;

/**
 * True when the token itself is fine but it was never granted the Google Ads scope. Distinct from an
 * expired/revoked token (which the app's auth-expired path already handles via invalid_grant) because
 * the fix is different: re-consent for one more scope, not a full re-login.
 */
export function isAdsScopeGap(e: unknown): boolean {
  try {
    const env = envelopeOf(e);
    if (reasonOf(env) === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') return true;
    const haystack = [
      asString(env?.message),
      asString(failureError(env)?.message),
      asString(asRecord(e)?.message),
      typeof e === 'string' ? e : '',
    ].join(' ');
    return SCOPE_GAP_RE.test(haystack);
  } catch {
    return false;
  }
}

/** Turn any thrown value into a shaped, display-safe, log-safe Ads failure. Never throws. */
export function adsErrorInfo(e: unknown): AdsErrorInfo {
  try {
    return shape(e);
  } catch {
    // This module runs when something already went wrong; a bug in the parser must not replace the
    // real failure with a stack trace of its own.
    return { code: '', status: 0, message: GENERIC, retryable: false };
  }
}

function shape(e: unknown): AdsErrorInfo {
  const rec = asRecord(e);
  const env = envelopeOf(e);
  const failure = failureError(env);
  const { family, value } = enumOf(failure);
  const status = httpStatusOf(e, env);
  const detail = cleanText(
    asString(failure?.message) || asString(env?.message) || asString(rec?.message) || (typeof e === 'string' ? e : ''),
  );
  const suffix = detail ? ` Google said: ${detail}` : '';

  // Scope gap first: it carries no GoogleAdsFailure, so the enum switch below would never see it.
  if (isAdsScopeGap(e)) {
    return {
      code: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      status: status || 403,
      message:
        'The connected Google account has not granted access to the Google Ads API (ACCESS_TOKEN_SCOPE_INSUFFICIENT). The sign-in is valid, it just does not cover Google Ads.',
      remedy:
        'Re-connect this Google account in Settings and approve the Google Ads permission when the consent screen asks for it.',
      retryable: false,
    };
  }

  switch (value) {
    case 'DEVELOPER_TOKEN_INVALID':
      return {
        code: value,
        status: status || 401,
        message: `Google Ads rejected the developer token (DEVELOPER_TOKEN_INVALID): it is wrong, or the developer-token header was not sent at all.${suffix}`,
        remedy:
          'Re-enter the developer token in Settings, copied straight from the Google Ads API Center, with no surrounding spaces or quotes.',
        retryable: false,
      };

    case 'DEVELOPER_TOKEN_NOT_APPROVED':
      return {
        code: value,
        status: status || 403,
        message: `This developer token still has Test Account Access only, and the request touched a production Google Ads account (DEVELOPER_TOKEN_NOT_APPROVED).${suffix}`,
        remedy:
          'Apply for Basic access in the Google Ads API Center (Tools, API Center) and retry once it is granted. Until then the token can only read test accounts.',
        retryable: false,
      };

    case 'DEVELOPER_TOKEN_PROHIBITED':
      return {
        code: value,
        status: status || 403,
        message: `This Google Cloud project is permanently paired to a different manager account's developer token (DEVELOPER_TOKEN_PROHIBITED).${suffix}`,
        remedy:
          'There is no in-app fix: the project to token pairing is permanent once the first call is made. Using this developer token requires a NEW Google Cloud project with new OAuth credentials.',
        retryable: false,
      };

    case 'USER_PERMISSION_DENIED':
    case 'INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION':
      return {
        code: value,
        status: status || 403,
        message: `The signed-in Google account cannot reach that Google Ads customer (${value}).${suffix}`,
        remedy:
          'If the account sits under a manager account, set login-customer-id to the MANAGER account id (digits only, dashes stripped) and keep the customer id in the path. Otherwise grant this Google account access to the account in Google Ads.',
        retryable: false,
      };

    case 'CUSTOMER_NOT_ENABLED':
    case 'INCOMPLETE_SIGNUP':
      return {
        code: value,
        status: status || 403,
        message: `That Google Ads account is not in an enabled state: it is cancelled, suspended, or its signup was never finished (${value}).${suffix}`,
        remedy:
          'Reactivate the account (or finish signup, including billing) in the Google Ads UI, then retry. Nothing can be read from it until it is enabled.',
        retryable: false,
      };

    // QuotaError.ACCESS_PROHIBITED lives in the quota family but retrying it forever is pointless: it
    // means this account is not allowed to call the API at all. Deliberately worded so it does NOT
    // match quota-retry's QUOTA_RE.
    case 'ACCESS_PROHIBITED':
      return {
        code: value,
        status: status || 403,
        message: `Google Ads is refusing API access for this account (ACCESS_PROHIBITED). Retrying will not help.${suffix}`,
        remedy: 'Check that the account is allowed to use the Google Ads API, then contact Google Ads support if it is.',
        retryable: false,
      };

    case 'NOT_ADS_USER':
      return {
        code: value,
        status: status || 401,
        message: `The signed-in Google account is not linked to any Google Ads account (NOT_ADS_USER).${suffix}`,
        remedy:
          'Re-connect in Settings using the Google account that has Google Ads access, or have someone invite this account in Google Ads under Admin, Access and security.',
        retryable: false,
      };

    default:
      break;
  }

  // Quota: fold RESOURCE_EXHAUSTED into the message on purpose so quota-retry.ts, which only tests the
  // top-level message, actually backs off. RESOURCE_TEMPORARILY_EXHAUSTED does NOT contain the literal
  // QUOTA_RE looks for, which is precisely why the token is spelled out rather than interpolated.
  const isQuota =
    family === 'quotaError' ||
    value === 'RESOURCE_EXHAUSTED' ||
    value === 'RESOURCE_TEMPORARILY_EXHAUSTED' ||
    status === 429 ||
    asString(env?.status).toUpperCase() === 'RESOURCE_EXHAUSTED';
  if (isQuota) {
    return {
      code: value || 'RESOURCE_EXHAUSTED',
      status: status || 429,
      message: `Google Ads API rate limit hit (RESOURCE_EXHAUSTED${value && value !== 'RESOURCE_EXHAUSTED' ? `, ${value}` : ''}).${suffix}`,
      remedy:
        'Wait a moment and retry; the app backs off automatically. If it keeps happening, cut the request rate or batch operations into fewer calls.',
      retryable: true,
    };
  }

  // Expired / invalid / revoked credentials. The enum family is the reliable signal when present, and
  // a bare 401 is the fallback for the many ways Google can phrase this outside a GoogleAdsFailure.
  const isAuth =
    status === 401 ||
    /^OAUTH_TOKEN_/.test(value) ||
    family === 'authenticationError' ||
    asString(env?.status).toUpperCase() === 'UNAUTHENTICATED' ||
    /invalid authentication credentials|invalid[_ ]grant|access token/i.test(detail);
  if (isAuth) {
    return {
      code: value,
      status: status || 401,
      message: `Google rejected the credentials for the Google Ads API${value ? ` (${value})` : ''}: the access token is missing, expired, or revoked.${suffix}`,
      remedy: 'Re-connect the Google account in Settings to get a fresh token, then retry.',
      retryable: false,
    };
  }

  // Transport: nothing parseable came back because nothing reached Google. Always retryable.
  const transport = transportCodeOf(e);
  if (transport) {
    return {
      code: transport,
      status: 0,
      message: `The Google Ads API could not be reached (${transport}).`,
      remedy: 'Check the network connection, VPN, or proxy, then retry.',
      retryable: true,
    };
  }

  // 5xx and the transient server-side enums: worth another attempt, unlike everything above.
  if (status >= 500 || value === 'TRANSIENT_ERROR' || value === 'DEADLINE_EXCEEDED' || value === 'INTERNAL_ERROR') {
    return {
      code: value,
      status,
      message: `Google Ads API server error${status ? ` (HTTP ${status})` : ''}${value ? ` (${value})` : ''}.${suffix}`,
      remedy: 'This one is on the Google side. Retry in a moment; if it persists, retry with a smaller request.',
      retryable: true,
    };
  }

  // Recognised the shape but not the cause: still show the real reason (scrubbed and capped), still
  // refuse to guess a remedy, and never claim it is retryable.
  if (detail || value || status) {
    return {
      code: value,
      status,
      message: `Google Ads API request failed${status ? ` (HTTP ${status})` : ''}${value ? ` (${value})` : ''}.${suffix}`,
      retryable: false,
    };
  }

  return { code: '', status: 0, message: GENERIC, retryable: false };
}
