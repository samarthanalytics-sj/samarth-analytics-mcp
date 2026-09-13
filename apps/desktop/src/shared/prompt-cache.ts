// Prompt caching: the request prefix (tools + system prompt) is byte-identical on every step of a
// tool loop, and it is BIG - measured at ~9,400 tokens of system prompt plus 2,900-14,600 of tool
// schemas on a GTM turn. Re-sending it unchanged 3 or 6 times is where most of a turn's input cost
// goes. Providers can hold that prefix and charge a fraction to re-read it.
//
// PURE + framework-free: the eligibility decision and the response parsers live here so they can be
// tested without a network. The provider clients only apply what these functions return.
//
// The three providers need three different things:
//   Anthropic - EXPLICIT. Nothing is cached unless the request carries a cache_control breakpoint.
//               This is the one that needs real work, and the one with real economics (below).
//   OpenAI    - AUTOMATIC for prompts over ~1024 tokens. There is no opt-in; the only thing we can
//               do wrong is destabilise the prefix. We read back the hit count to prove it works.
//   Gemini    - IMPLICIT on 2.5 models, same story as OpenAI.

/** Anthropic's cache prefix is ordered tools -> system -> messages, so ONE breakpoint at the end of
 *  the system prompt covers the tool schemas too. That is the whole stable prefix in one marker. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Smallest prefix Anthropic will cache is 1024 tokens on most models and 2048 on Haiku. Below it
 *  the breakpoint is simply ignored, so this bar exists to avoid asking for something pointless -
 *  set against the Haiku minimum at a deliberately pessimistic 3.5 chars/token. */
export const MIN_CACHEABLE_CHARS = 7168;

/** Size of what a breakpoint at the end of the system prompt would actually cover. */
export function cacheablePrefixChars(system: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): number {
  const toolChars = tools.reduce(
    (n, t) => n + t.name.length + (t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length,
    0,
  );
  return (system ?? '').length + toolChars;
}

/**
 * Whether to spend a cache breakpoint on this request.
 *
 * THE ECONOMICS, because this is not a free win: Anthropic bills a cache WRITE at 1.25x the normal
 * input rate and a READ at 0.1x. A prefix that is written and never read costs 25% MORE than not
 * caching at all. So the question is not "is this prefix big" but "will this request be followed by
 * another one carrying the same prefix".
 *
 * A request with NO tools cannot loop - it is a single completion (the memory-extract and
 * memory-suggest passes are exactly this), so its prefix is guaranteed never to be re-read and
 * marking it is a guaranteed loss. A request WITH tools is a step in the agent loop, which in this
 * app almost always runs at least twice: the model calls a tool, the result comes back, and the
 * whole prefix is re-sent. From step 2 onward every read is 0.1x.
 *
 * Turn cost against no caching, taking the write premium into account:
 *   1 step  1.25x   (the loss case: a tool-bearing request that answers without calling anything)
 *   2 steps 0.68x
 *   3 steps 0.48x
 *   6 steps 0.29x
 */
export function shouldCachePrefix(system: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>): boolean {
  if (!tools.length) return false;
  return cacheablePrefixChars(system, tools) >= MIN_CACHEABLE_CHARS;
}

/** A second breakpoint only earns its keep if the volatile tail is big enough to be worth caching
 *  within a turn. Below this the tail just rides as fresh input on each step, which costs less than
 *  the bookkeeping of another cache entry. */
export const SECOND_BREAKPOINT_MIN_CHARS = 1000;

/**
 * The `system` field for an Anthropic request.
 *
 * Providers match the LONGEST COMMON PREFIX, so where the breakpoint sits decides what survives
 * between turns. With one marker at the very end, ANY change (a different memory selected for this
 * message, a new day, tool-result carry-over) misses the whole prompt. So when the caller tells us
 * where the fixed instructions end, the first breakpoint goes THERE:
 *
 *   [ fixed instructions ]* [ per-message context ]*
 *                         ^                       ^
 *                         |                       one entry per turn, re-read across the tool loop
 *                         survives across turns, and across accounts on the same product
 *
 * Returns the PLAIN STRING when caching does not apply, so an ineligible request is byte-identical
 * to what we sent before any of this existed.
 */
export function anthropicSystem(system: string, cache: boolean, staticPart?: string): string | AnthropicTextBlock[] {
  if (!cache) return system;
  const mark = { type: 'ephemeral' } as const;
  // A staticPart that is not really a prefix is a caller bug. Never send a breakpoint that claims a
  // boundary the text does not have; fall back to caching the prompt as one unit.
  if (!staticPart || !system.startsWith(staticPart) || staticPart.length === system.length) {
    return [{ type: 'text', text: system, cache_control: mark }];
  }
  const situational = system.slice(staticPart.length);
  if (situational.length < SECOND_BREAKPOINT_MIN_CHARS) {
    // Mark the stable half only. The short tail is fresh input on every step, which is cheaper than
    // a second entry, and the big half still survives from turn to turn.
    return [
      { type: 'text', text: staticPart, cache_control: mark },
      { type: 'text', text: situational },
    ];
  }
  return [
    { type: 'text', text: staticPart, cache_control: mark },
    { type: 'text', text: situational, cache_control: mark },
  ];
}

/** What a provider reported about cache use on one request. All counts are input tokens. */
export interface CacheUsage {
  /** Read from the cache at a fraction of the input rate. This is the saving. */
  read: number;
  /** Written to the cache. Anthropic bills these at a premium; the other two do not expose it. */
  written: number;
  /** Ordinary uncached input tokens. */
  input: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** Anthropic reports usage on the `message_start` event of a stream. */
export function anthropicCacheUsage(event: unknown): CacheUsage | null {
  const u = (event as { type?: string; message?: { usage?: Record<string, unknown> } });
  if (u?.type !== 'message_start' || !u.message?.usage) return null;
  const usage = u.message.usage;
  return {
    read: num(usage.cache_read_input_tokens),
    written: num(usage.cache_creation_input_tokens),
    input: num(usage.input_tokens),
  };
}

/** OpenAI reports usage on a final chunk, and only when stream_options.include_usage is set. The
 *  chunk carries an empty `choices` array, which the stream accumulator already ignores. */
export function openaiCacheUsage(chunk: unknown): CacheUsage | null {
  const usage = (chunk as { usage?: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } })?.usage;
  if (!usage || typeof usage.prompt_tokens !== 'number') return null;
  const read = num(usage.prompt_tokens_details?.cached_tokens);
  return { read, written: 0, input: Math.max(0, num(usage.prompt_tokens) - read) };
}

/** Gemini reports usageMetadata on stream chunks; the last one carries the totals. */
export function geminiCacheUsage(chunk: unknown): CacheUsage | null {
  const m = (chunk as { usageMetadata?: { promptTokenCount?: unknown; cachedContentTokenCount?: unknown } })?.usageMetadata;
  if (!m || typeof m.promptTokenCount !== 'number') return null;
  const read = num(m.cachedContentTokenCount);
  return { read, written: 0, input: Math.max(0, num(m.promptTokenCount) - read) };
}

export function addCacheUsage(a: CacheUsage | undefined, b: CacheUsage | undefined): CacheUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { read: a.read + b.read, written: a.written + b.written, input: a.input + b.input };
}

/** One log line. Reports the HIT RATE against total input, because "12,000 cached" means nothing
 *  without knowing what the whole request was. */
export function formatCacheUsage(u: CacheUsage | undefined): string {
  if (!u) return 'no usage reported';
  const total = u.read + u.written + u.input;
  if (total === 0) return 'no input tokens reported';
  const pct = Math.round((u.read / total) * 100);
  const n = (v: number): string => v.toLocaleString('en-US');
  return `${n(total)} input tokens: ${n(u.read)} cached (${pct}%), ${n(u.written)} written, ${n(u.input)} fresh`;
}
