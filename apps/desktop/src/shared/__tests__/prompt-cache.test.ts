// Pure tests for prompt caching: when a cache breakpoint is worth spending, the exact request shape
// it produces, and the three providers' usage parsers.
// Run: tsx src/shared/__tests__/prompt-cache.test.ts
import {
  MIN_CACHEABLE_CHARS,
  cacheablePrefixChars,
  shouldCachePrefix,
  anthropicSystem,
  anthropicCacheUsage,
  openaiCacheUsage,
  geminiCacheUsage,
  addCacheUsage,
  formatCacheUsage,
  type AnthropicTextBlock,
} from '../prompt-cache';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const tool = (name: string, size = 400): { name: string; description: string; inputSchema: unknown } => ({
  name,
  description: 'd'.repeat(size),
  inputSchema: { type: 'object', properties: {} },
});
/** A GTM-web-sized request: ~40k of system prompt, 20 tools. */
const BIG_SYSTEM = 's'.repeat(40_000);
const TOOLS = Array.from({ length: 20 }, (_, i) => tool(`tool_${i}`));

// -- prefix sizing ---------------------------------------------------------------
check('prefix counts system + every tool', cacheablePrefixChars('abc', [tool('t', 10)]) === 3 + 1 + 10 + JSON.stringify({ type: 'object', properties: {} }).length);
check('prefix of no tools is just the system', cacheablePrefixChars('abcde', []) === 5);
check('prefix tolerates a tool with no description', cacheablePrefixChars('', [{ name: 'x', inputSchema: {} }]) === 1 + 2);

// -- the spend decision ----------------------------------------------------------
check('a real GTM turn is worth caching', shouldCachePrefix(BIG_SYSTEM, TOOLS));
check('a GA4-sized system is worth caching', shouldCachePrefix('s'.repeat(13_869), TOOLS));
// The economics: a request with no tools cannot loop, so its prefix is written and never read,
// which costs 25% MORE than not caching. Never mark one - this is the memory-extract pass.
check('NO tools -> never marked, however big', !shouldCachePrefix('s'.repeat(500_000), []));
check('tiny prefix with tools -> not marked', !shouldCachePrefix('hi', [tool('t', 5)]));
check('exactly at the minimum -> marked', shouldCachePrefix('s'.repeat(MIN_CACHEABLE_CHARS), [tool('t', 0)]));
check('one char under the minimum -> not marked',
  !shouldCachePrefix('s'.repeat(MIN_CACHEABLE_CHARS - 1 - 1 - JSON.stringify({ type: 'object', properties: {} }).length), [tool('t', 0)]));

// -- the request shape -----------------------------------------------------------
const marked = anthropicSystem(BIG_SYSTEM, true);
check('marked system is a block array', Array.isArray(marked));
check('marked system carries ONE ephemeral breakpoint',
  Array.isArray(marked) && marked.length === 1 && marked[0].cache_control?.type === 'ephemeral');
check('marked system keeps the text intact', Array.isArray(marked) && marked[0].text === BIG_SYSTEM);
// An ineligible request must be byte-identical to what shipped before this feature existed.
check('unmarked system is the PLAIN STRING', anthropicSystem(BIG_SYSTEM, false) === BIG_SYSTEM);
check('unmarked system is not an array', !Array.isArray(anthropicSystem('x', false)));

// -- where the breakpoints go --------------------------------------------------
// The prompt is [fixed instructions][per-message context]. Providers match the LONGEST COMMON
// PREFIX, so a breakpoint at the very end survives only within a turn; one at the end of the fixed
// half survives ACROSS turns, which is the whole point of the reordering.
const STATIC = 'S'.repeat(40_000);
const BIG_TAIL = 'v'.repeat(1_340); // a real situational block: context + date + a few memories
const SMALL_TAIL = 'v'.repeat(200);

const twoBlocks = anthropicSystem(STATIC + BIG_TAIL, true, STATIC) as AnthropicTextBlock[];
check('split at the boundary gives two blocks', Array.isArray(twoBlocks) && twoBlocks.length === 2);
check('block 1 is exactly the fixed half', twoBlocks[0].text === STATIC);
check('block 2 is exactly the per-message half', twoBlocks[1].text === BIG_TAIL);
check('the fixed half is marked (this is the cross-turn hit)', twoBlocks[0].cache_control?.type === 'ephemeral');
check('a worthwhile tail is marked too (the within-turn hit)', twoBlocks[1].cache_control?.type === 'ephemeral');
check('reassembling the blocks reproduces the prompt EXACTLY', twoBlocks.map((b) => b.text).join('') === STATIC + BIG_TAIL);

const smallTail = anthropicSystem(STATIC + SMALL_TAIL, true, STATIC) as AnthropicTextBlock[];
check('a trivial tail still splits', Array.isArray(smallTail) && smallTail.length === 2);
check('a trivial tail is NOT given its own breakpoint', smallTail[1].cache_control === undefined);
check('the fixed half is marked regardless of tail size', smallTail[0].cache_control?.type === 'ephemeral');

// Guard: a caller that passes a staticPart which is not really a prefix must never produce a
// breakpoint claiming a boundary the text does not have.
const lying = anthropicSystem('AAAABBBB', true, 'XXXX') as AnthropicTextBlock[];
check('a non-prefix staticPart falls back to one block', Array.isArray(lying) && lying.length === 1);
check('the fallback still carries the whole prompt', lying[0].text === 'AAAABBBB');
check('the fallback is still cached as one unit', lying[0].cache_control?.type === 'ephemeral');

const whole = anthropicSystem(STATIC, true, STATIC) as AnthropicTextBlock[];
check('staticPart covering everything gives one block, not an empty second', whole.length === 1);

const noSplit = anthropicSystem(STATIC + BIG_TAIL, true) as AnthropicTextBlock[];
check('no staticPart -> the old single-breakpoint shape', noSplit.length === 1 && noSplit[0].cache_control?.type === 'ephemeral');
check('an uncacheable request ignores staticPart entirely', anthropicSystem(STATIC + BIG_TAIL, false, STATIC) === STATIC + BIG_TAIL);

// -- Anthropic usage -------------------------------------------------------------
const aStart = {
  type: 'message_start',
  message: { usage: { input_tokens: 120, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 } },
};
check('anthropic reads cache hit', anthropicCacheUsage(aStart)?.read === 20_000);
check('anthropic reads fresh input', anthropicCacheUsage(aStart)?.input === 120);
check('anthropic reports a cache WRITE',
  anthropicCacheUsage({ type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 20_417 } } })?.written === 20_417);
check('anthropic ignores other stream events', anthropicCacheUsage({ type: 'content_block_delta', delta: { text: 'hi' } }) === null);
check('anthropic ignores a message_start with no usage', anthropicCacheUsage({ type: 'message_start', message: {} }) === null);
check('anthropic missing cache fields read as 0',
  anthropicCacheUsage({ type: 'message_start', message: { usage: { input_tokens: 9 } } })?.read === 0);

// -- OpenAI usage ----------------------------------------------------------------
const oUsage = { choices: [], usage: { prompt_tokens: 20_438, prompt_tokens_details: { cached_tokens: 19_968 } } };
check('openai reads cached_tokens', openaiCacheUsage(oUsage)?.read === 19_968);
check('openai derives fresh input by subtraction', openaiCacheUsage(oUsage)?.input === 20_438 - 19_968);
check('openai reports no writes (it never charges for one)', openaiCacheUsage(oUsage)?.written === 0);
check('openai ignores ordinary delta chunks', openaiCacheUsage({ choices: [{ delta: { content: 'hi' } }] }) === null);
check('openai handles a cache miss', openaiCacheUsage({ usage: { prompt_tokens: 900 } })?.input === 900);
// Defends the subtraction: a provider reporting more cached than total must not yield a negative.
check('openai never returns negative input',
  openaiCacheUsage({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 } } })?.input === 0);

// -- Gemini usage ----------------------------------------------------------------
check('gemini reads cachedContentTokenCount',
  geminiCacheUsage({ usageMetadata: { promptTokenCount: 12_000, cachedContentTokenCount: 8_000 } })?.read === 8_000);
check('gemini derives fresh input',
  geminiCacheUsage({ usageMetadata: { promptTokenCount: 12_000, cachedContentTokenCount: 8_000 } })?.input === 4_000);
check('gemini ignores chunks with no usageMetadata', geminiCacheUsage({ candidates: [] }) === null);

// -- garbage in ------------------------------------------------------------------
for (const [label, v] of [['null', null], ['undefined', undefined], ['string', 'x'], ['number', 5]] as Array<[string, unknown]>) {
  check(`parsers survive ${label}`,
    anthropicCacheUsage(v) === null && openaiCacheUsage(v) === null && geminiCacheUsage(v) === null);
}
check('non-numeric counts do not leak NaN',
  openaiCacheUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 'lots' } } })?.read === 0);
check('negative counts are floored at 0',
  anthropicCacheUsage({ type: 'message_start', message: { usage: { input_tokens: -5 } } })?.input === 0);

// -- summing across steps --------------------------------------------------------
const s1 = { read: 0, written: 20_417, input: 21 };
const s2 = { read: 20_417, written: 0, input: 7_330 };
check('sum adds every field', addCacheUsage(s1, s2)?.read === 20_417 && addCacheUsage(s1, s2)?.written === 20_417);
check('sum with nothing on the left', addCacheUsage(undefined, s2) === s2);
check('sum with nothing on the right', addCacheUsage(s1, undefined) === s1);
check('sum of two nothings is nothing', addCacheUsage(undefined, undefined) === undefined);

// -- the log line ----------------------------------------------------------------
check('log reports the hit rate', formatCacheUsage({ read: 50, written: 0, input: 50 }).includes('50%'));
check('log names all three buckets', formatCacheUsage(s2).includes('cached') && formatCacheUsage(s2).includes('written') && formatCacheUsage(s2).includes('fresh'));
check('log survives no usage', formatCacheUsage(undefined) === 'no usage reported');
// A zero total must not divide by zero and print NaN%.
check('log survives an all-zero report', !formatCacheUsage({ read: 0, written: 0, input: 0 }).includes('NaN'));
check('house style: no em dashes in the log line', !/[—–]/.test(formatCacheUsage(s2)));

if (failures.length) console.error(failures.join('\n'));
console.log(`prompt-cache: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
