// Reading a provider's 429 so the app can say WHICH limit was hit, and whether waiting can clear it.
//
// Every 429 used to be treated the same: retry up to 4 times with a backoff, and show
// "Rate limited by OpenAI, retrying in 15s". That is right for a per-MINUTE cap, which really does
// self-heal in seconds. It is wrong, and misleading, for the other two:
//
//   per-DAY caps (TPD / RPD)  - four retries inside a minute cannot clear a daily budget. The user
//                               waits ~30s to be told the same thing, with no idea it will still be
//                               there tomorrow morning unless they change tier.
//   insufficient_quota        - OpenAI returns 429 when an account is out of CREDIT. Retrying is
//                               pointless and the "rate limit" wording sends the user to the rate
//                               limit page when the actual fix is billing.
//
// So the message is parsed once, and the answer drives both the retry decision and the wording.
// Anything unrecognised stays RETRYABLE, which is the old behaviour: an unknown 429 must not become
// a hard failure just because this parser has not seen its phrasing.

export type RateLimitScope = 'per-minute' | 'per-day' | 'quota' | 'unknown';
export type RateLimitUnit = 'tokens' | 'requests' | 'unknown';

export interface RateLimitInfo {
  scope: RateLimitScope;
  unit: RateLimitUnit;
  /** The account's ceiling, when the provider states it. */
  limit?: number;
  /** How much of the window was already used. */
  used?: number;
  /** What this request needed. */
  requested?: number;
  /** The model the limit applies to, which is how the user checks a model switch took effect. */
  model?: string;
  /** Can waiting a few seconds clear this? Drives whether we retry at all. */
  retryable: boolean;
  /**
   * The request ON ITS OWN is bigger than the whole per-window ceiling, so no amount of waiting can
   * ever fit it: an empty bucket still is not big enough. Worth telling the user about, unlike the
   * ordinary case where the window simply has not refilled yet and clears itself in seconds.
   */
  oversized: boolean;
  /**
   * Is this worth putting in front of the user at all? False for the ordinary per-minute squeeze, which
   * resolves on its own within a minute and only produces noise mid-answer. True whenever the user has
   * to DO something: an oversized request, a daily cap, or exhausted credit.
   */
  actionable: boolean;
  /** One line for the retry banner: names the limit, the model and the numbers. */
  summary: string;
  /** What the user should actually do about it. */
  advice: string;
}

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const n = Number(String(s).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/** "on tokens per min (TPM)" / "per day (TPD)" / "requests per min (RPM)" / a billing exhaustion. */
export function parseRateLimit(reason: string | undefined, provider = 'the provider'): RateLimitInfo {
  const text = String(reason ?? '');

  // Out of credit. OpenAI sends this as a 429 even though nothing is rate limited.
  if (/insufficient_quota|exceeded your current quota|check your plan and billing/i.test(text)) {
    return {
      scope: 'quota', unit: 'unknown', retryable: false, oversized: false, actionable: true,
      summary: `${provider} rejected the request because the account is out of credit, not because of a rate limit.`,
      advice: 'Add credit or check the billing details on the provider account. Waiting will not clear this.',
    };
  }

  const perDay = /per day|\bTPD\b|\bRPD\b/i.test(text);
  const perMin = /per min|\bTPM\b|\bRPM\b/i.test(text);
  const unit: RateLimitUnit = /tokens?\b/i.test(text) ? 'tokens' : /requests?\b/i.test(text) ? 'requests' : 'unknown';
  const model = /\bfor\s+([A-Za-z0-9._-]+)\s+in\s+organization/i.exec(text)?.[1]
    ?? /\bfor\s+model\s+`?([A-Za-z0-9._-]+)`?/i.exec(text)?.[1];
  const limit = num(/Limit\s+([\d,_]+)/i.exec(text)?.[1]);
  const used = num(/Used\s+([\d,_]+)/i.exec(text)?.[1]);
  const requested = num(/Requested\s+([\d,_]+)/i.exec(text)?.[1]);

  const unitWord = unit === 'unknown' ? '' : ` ${unit}`;
  const on = model ? ` on ${model}` : '';
  const nums = [
    limit != null ? `limit ${limit.toLocaleString('en-US')}` : '',
    used != null ? `used ${used.toLocaleString('en-US')}` : '',
    requested != null ? `this request needed ${requested.toLocaleString('en-US')}` : '',
  ].filter(Boolean).join(', ');
  const tail = nums ? ` (${nums})` : '';

  if (perDay) {
    return {
      scope: 'per-day', unit, limit, used, requested, model, retryable: false, oversized: false, actionable: true,
      summary: `${provider} DAILY${unitWord} limit reached${on}${tail}.`,
      advice: 'A daily budget does not refill by waiting a few seconds. Use a different model, raise the account tier, or continue after the daily reset.',
    };
  }
  if (perMin) {
    // The one per-minute case that never clears: the request alone exceeds the ceiling. Retrying spends
    // the whole backoff budget to fail identically, so stop and say what actually has to change.
    // Two independent signals. OpenAI's own wording for this case is 'Request too large ... The input
    // or output tokens must be reduced in order to run successfully', which says outright that waiting
    // is not the remedy; the numeric check catches providers that phrase it differently.
    const saysTooLarge = /request too large|must be reduced in order to run/i.test(text);
    const tooBig = saysTooLarge || (limit != null && requested != null && requested > limit);
    if (tooBig) {
      return {
        scope: 'per-minute', unit, limit, used, requested, model, retryable: false, oversized: true, actionable: true,
        summary: requested != null && limit != null
          ? `This single request (${requested.toLocaleString('en-US')}${unitWord}) is larger than the whole ${provider} per-minute limit of ${limit.toLocaleString('en-US')}${on}.`
          : `This single request is larger than the whole ${provider} per-minute limit${on}.`,
        advice: 'Waiting cannot fix this, an empty bucket is still too small. Raise the account tier, switch to a model with a higher per-minute limit, or shorten the conversation (start a new chat) so the request is smaller.',
      };
    }
    return {
      scope: 'per-minute', unit, limit, used, requested, model, retryable: true, oversized: false, actionable: false,
      summary: `${provider} per-minute${unitWord} limit reached${on}${tail}.`,
      advice: 'This clears within a minute. The app is waiting it out; a model with a higher per-minute limit avoids it.',
    };
  }
  return {
    scope: 'unknown', unit, limit, used, requested, model, retryable: true, oversized: false, actionable: false,
    summary: `${provider} rate limit reached${on}${tail}.`,
    advice: 'The app is retrying. If it keeps happening, check the provider account limits.',
  };
}

/** Should a 429 carrying this message be retried at all? Unknown phrasings keep the old behaviour. */
export function isRetryableRateLimit(reason: string | undefined): boolean {
  return parseRateLimit(reason).retryable;
}
