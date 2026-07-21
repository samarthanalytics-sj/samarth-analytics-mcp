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
  check('TPM: retryable', i.retryable && isRetryableRateLimit(TPM));
  check('TPM: names the model, so a model switch is verifiable', i.model === 'gpt-4o' && i.summary.includes('gpt-4o'));
  check('TPM: carries the numbers', i.limit === 30000 && i.requested === 30062);
  check('TPM: summary states the limit type', /per-minute tokens limit/i.test(i.summary), i.summary);
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
check('provider label is used, not hardcoded', parseRateLimit(TPM, 'Anthropic').summary.startsWith('Anthropic'));
check('a model given as `model` is picked up', parseRateLimit('Rate limit reached for model `claude-opus-4-8` on tokens per min (TPM): Limit 40000', 'Anthropic').model === 'claude-opus-4-8');
check('no em dashes in any user-facing string (house style)', (() => {
  const all = [TPM, RPM, TPD, QUOTA, ''].map((t) => parseRateLimit(t, 'OpenAI'));
  return !all.some((i) => /[—–]/.test(i.summary + i.advice));
})());

console.log(`\nrate-limit: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
