// Tests for reading a provider 429. Two things must hold: the user is told WHICH limit was hit (so a
// model switch is verifiable), and a 429 that retrying cannot clear is not retried four times before
// reporting the wrong cause.
// Run: tsx src/shared/__tests__/rate-limit.test.ts
import { parseRateLimit, isRetryableRateLimit } from '../rate-limit';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// The exact strings OpenAI returns.
const TPM = 'Request too large for gpt-4o in organization org-abc123 on tokens per min (TPM): Limit 30000, Requested 30062. The input or output tokens must be reduced in order to run successfully.';
const RPM = 'Rate limit reached for gpt-4o-mini in organization org-abc123 on requests per min (RPM): Limit 500, Used 500, Requested 1. Please try again in 120ms.';
const TPD = 'Rate limit reached for gpt-4o-mini in organization org-abc123 on tokens per day (TPD): Limit 200000, Used 199420, Requested 1200.';
const QUOTA = 'You exceeded your current quota, please check your plan and billing details.';

// ── Per-minute: the one that waiting actually fixes ─────────────────────────────
{
  const i = parseRateLimit(TPM, 'OpenAI');
  check('TPM: recognised as per-minute', i.scope === 'per-minute' && i.unit === 'tokens');
  // NOTE: this fixture is OpenAI's "Request too large" variant (Requested 30062 > Limit 30000, and the
  // text says the tokens "must be reduced in order to run successfully"). Waiting can never fit it, so
  // it must NOT be retried. An ordinary per-minute squeeze is covered by TPM_SQUEEZE below.
  check('TPM (request too large): NOT retryable, waiting cannot shrink the request', !i.retryable && !isRetryableRateLimit(TPM));
  check('TPM: names the model, so a model switch is verifiable', i.model === 'gpt-4o' && i.summary.includes('gpt-4o'));
  check('TPM: carries the numbers', i.limit === 30000 && i.requested === 30062);
  check('TPM (request too large): summary says the request exceeds the whole limit', /larger than the whole/i.test(i.summary), i.summary);
  check('TPM: numbers are readable in the summary', i.summary.includes('30,000') && i.summary.includes('30,062'), i.summary);
}
{
  const i = parseRateLimit(RPM, 'OpenAI');
  check('RPM: per-minute requests, retryable', i.scope === 'per-minute' && i.unit === 'requests' && i.retryable);
  check('RPM: names the model', i.model === 'gpt-4o-mini');
}

// ── Per-day: retrying cannot clear it ───────────────────────────────────────────
{
  const i = parseRateLimit(TPD, 'OpenAI');
  check('TPD: recognised as a DAILY limit', i.scope === 'per-day');
  check('TPD: NOT retryable (four retries in a minute cannot refill a daily budget)', !i.retryable && !isRetryableRateLimit(TPD));
  check('TPD: says DAILY plainly', /daily/i.test(i.summary), i.summary);
  check('TPD: advice does not tell the user to just wait a moment', /daily reset|different model|tier/i.test(i.advice), i.advice);
  check('TPD: still names the model and numbers', i.model === 'gpt-4o-mini' && i.limit === 200000 && i.used === 199420);
}

// ── Out of credit: a 429 that is not a rate limit at all ───────────────────────
{
  const i = parseRateLimit(QUOTA, 'OpenAI');
  check('quota: recognised as billing, not rate limiting', i.scope === 'quota');
  check('quota: NOT retryable', !i.retryable);
  check('quota: says out of credit, not "rate limit"', /out of credit/i.test(i.summary) && !/per-minute/i.test(i.summary), i.summary);
  check('quota: points at billing', /billing|credit/i.test(i.advice));
  check('quota: says waiting will not help', /will not clear/i.test(i.advice));
}

// ── Unknown phrasing must keep the OLD behaviour ───────────────────────────────
for (const [label, text] of [
  ['empty', ''],
  ['undefined', undefined],
  ['unfamiliar', 'Too many requests, slow down.'],
] as const) {
  const i = parseRateLimit(text, 'OpenAI');
  check(`unknown (${label}): stays retryable, so a new phrasing never becomes a hard failure`, i.retryable);
  check(`unknown (${label}): still produces a usable one-liner`, i.summary.length > 0 && i.summary.includes('OpenAI'));
}

// ── Robustness ──────────────────────────────────────────────────────────────────
check('parses comma-grouped numbers', parseRateLimit('on tokens per min (TPM): Limit 200,000, Used 199,000', 'OpenAI').limit === 200000);
check('provider label is used, not hardcoded', parseRateLimit(RPM, 'Anthropic').summary.startsWith('Anthropic'));
check('a model given as `model` is picked up', parseRateLimit('Rate limit reached for model `claude-opus-4-8` on tokens per min (TPM): Limit 40000', 'Anthropic').model === 'claude-opus-4-8');
check('no em dashes in any user-facing string (house style)', (() => {
  const all = [TPM, RPM, TPD, QUOTA, ''].map((t) => parseRateLimit(t, 'OpenAI'));
  return !all.some((i) => /[—–]/.test(i.summary + i.advice));
})());

// -- Actionable vs self-healing -------------------------------------------------
// The reported case: limit 30,000, used 19,183, this request needed 19,121. The request FITS the
// ceiling; the window simply had not refilled. It clears itself, so a banner quoting the numbers
// mid-answer is noise about something the user cannot act on.
const TPM_SQUEEZE = 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 19183, Requested 19121. Please try again in 17s.';
const squeeze = parseRateLimit(TPM_SQUEEZE, 'OpenAI');
check('ordinary per-minute squeeze is NOT actionable (no banner)', squeeze.actionable === false);
check('ordinary per-minute squeeze is still retried', squeeze.retryable === true && isRetryableRateLimit(TPM_SQUEEZE));
check('ordinary per-minute squeeze is not oversized', squeeze.oversized === false);
check('squeeze numbers are still parsed (for the log, not the banner)', squeeze.limit === 30000 && squeeze.used === 19183 && squeeze.requested === 19121);

// Oversized purely by arithmetic, without OpenAI's "request too large" wording.
const over = parseRateLimit('Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 0, Requested 35200.', 'OpenAI');
check('a request larger than the ceiling is oversized on numbers alone', over.oversized === true && over.actionable === true && over.retryable === false);
check('oversized summary contrasts the request against the limit', /larger than the whole/i.test(over.summary) && over.summary.includes('35,200') && over.summary.includes('30,000'));
check('oversized advice says waiting will not help, and names real levers', /waiting cannot fix this/i.test(over.advice) && /tier/i.test(over.advice) && /new chat/i.test(over.advice));

// Boundaries: equal-to-the-limit fits an empty window, and absent numbers must never be guessed.
check('requested EQUAL to the limit is not oversized', parseRateLimit('on tokens per min (TPM): Limit 30000, Used 29000, Requested 30000', 'OpenAI').oversized === false);
check('missing numbers never infer oversized', (() => {
  const u = parseRateLimit('on tokens per min (TPM): slow down', 'OpenAI');
  return u.oversized === false && u.actionable === false && u.retryable === true;
})());
check('the too-large WORDING alone is enough, even with no numbers', (() => {
  const w = parseRateLimit('Request too large for gpt-4o on tokens per min (TPM): The input or output tokens must be reduced in order to run successfully.', 'OpenAI');
  return w.oversized === true && w.retryable === false && !/undefined|NaN/.test(w.summary);
})());

// The non-recoverable kinds stay visible: each needs the user to do something.
check('per-day is actionable', parseRateLimit(TPD, 'OpenAI').actionable === true);
check('out of credit is actionable', parseRateLimit(QUOTA, 'OpenAI').actionable === true);
check('an unknown 429 stays quiet but retried (old behaviour preserved)', (() => {
  const u = parseRateLimit('some new phrasing nobody has seen', 'OpenAI');
  return u.actionable === false && u.retryable === true;
})());
check('no em dashes in the new strings', !/[—–]/.test(over.summary + over.advice + squeeze.summary + squeeze.advice));

console.log(`\nrate-limit: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
