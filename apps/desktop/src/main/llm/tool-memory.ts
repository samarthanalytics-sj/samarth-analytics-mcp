// Carrying TOOL RESULTS between chat turns.
//
// THE DEFECT THIS FIXES: a chat turn's history (ChatTurn = role + text + media) has no slot for tool
// calls or tool results, so everything a tool returned is thrown away the moment the turn ends. Ask
// "list all tags" (list_gtm_tags returns 80 tags), then ask "how many of those are Google Ads tags",
// and the model has NO record of the answer it already had: it calls list_gtm_tags again. That is a
// whole extra provider round trip, and every round trip re-sends the ~42k-token floor (tool schemas
// plus system prompt), which is exactly what pushes the account over its tokens-per-minute budget.
//
// THE CHOICE, and why not the alternatives:
//  * Replaying real assistant-tool_use / tool_result turns would be the most native shape, but each
//    provider has its own pairing invariant (OpenAI needs every `tool` message to reference a
//    preceding assistant tool_calls id; Anthropic maps tool results onto a USER turn and wants
//    alternating roles). Synthesising those pairs from a plain text history is easy to get subtly
//    wrong on one provider and 400s the whole chat.
//  * So instead the recent results are folded into the SYSTEM prompt as a plainly-labelled, verbatim
//    block. It is provider-agnostic (no mapper changes at all), and it costs exactly the same tokens
//    as a replayed turn would, since every message is re-sent on every step either way.
//
// THE BOUND (this must never become unbounded history growth, which would make the token-floor
// problem worse, not better): at most MAX_CARRIED_RESULTS entries, each truncated to
// MAX_RESULT_CHARS, and the whole block hard-capped at MAX_BLOCK_CHARS. Worst case is ~12k chars,
// roughly 3k tokens, versus the ~42k-token floor of the single extra step it removes. Oldest entries
// are dropped first. A truncated entry says so, so the model re-calls rather than answering from a
// partial list.

/** One tool result kept for the next turn. */
export interface ToolResultMemo {
  name: string;
  args: Record<string, unknown>;
  content: string;
  /** True when `content` was cut to the per-result cap (the model must re-call for the full set). */
  truncated: boolean;
}

/** How many past tool results ride along. Small on purpose: a follow-up question almost always
 *  refers to the last read, not to something ten calls ago. */
export const MAX_CARRIED_RESULTS = 3;
/** Per-result cap. A container's full tag/trigger/variable list (id + name + type) fits well inside
 *  this; a giant audit blob gets cut and flagged. */
export const MAX_RESULT_CHARS = 8_000;
/** Hard ceiling on the whole injected block, whatever the per-result sizes add up to. */
export const MAX_BLOCK_CHARS = 12_000;

/**
 * Tools whose output is safe to reuse verbatim on a later turn (pure reads). Anything else is a
 * write: its result is a receipt, not a fact worth re-quoting, and after it runs the container has
 * CHANGED, so previously cached reads are stale.
 */
const READ_ONLY_PREFIXES = [
  'list_', 'get_', 'audit_', 'check_', 'diff_', 'score_', 'verify_', 'detect_',
  'lookup_', 'recall_', 'generate_', 'analytics_', 'suggest_', 'rank_', 'monitor_', 'runtime_',
];

export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_PREFIXES.some((p) => name.startsWith(p));
}

/** Cut a result to the per-result cap. PURE. */
export function trimResult(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_RESULT_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_RESULT_CHARS), truncated: true };
}

/**
 * Fold this turn's tool results into the carried set. PURE (returns a new array).
 *
 * A WRITE in the batch drops everything carried so far: once a tag/trigger/variable has been
 * created, edited or deleted, an earlier list of them is wrong, and a wrong-but-confident answer is
 * worse than one extra tool call.
 */
export function foldToolResults(
  carried: ToolResultMemo[],
  turnResults: Array<{ name: string; args?: Record<string, unknown>; content?: string; ok: boolean }>
): ToolResultMemo[] {
  const mutated = turnResults.some((r) => !isReadOnlyToolName(r.name));
  let out = mutated ? [] : [...carried];
  for (const r of turnResults) {
    if (!r.ok || !r.content || !isReadOnlyToolName(r.name)) continue;
    const { content, truncated } = trimResult(r.content);
    // One entry per tool+args: a repeated read replaces its own older copy rather than stacking.
    const key = memoKey(r.name, r.args ?? {});
    out = out.filter((m) => memoKey(m.name, m.args) !== key);
    out.push({ name: r.name, args: r.args ?? {}, content, truncated });
  }
  return out.slice(-MAX_CARRIED_RESULTS);
}

function memoKey(name: string, args: Record<string, unknown>): string {
  try {
    return `${name}(${JSON.stringify(args)})`;
  } catch {
    return name;
  }
}

/**
 * Render the carried results as a system-prompt block. PURE. Returns '' when there is nothing to
 * carry. Newest last (so the most recent read is closest to the instruction), and the whole block is
 * hard-capped: entries that do not fit are dropped, oldest first.
 */
export function formatToolMemory(carried: ToolResultMemo[]): string {
  if (!carried.length) return '';
  const header =
    'RECENT TOOL RESULTS - output you ALREADY fetched earlier in THIS conversation, verbatim. If one of ' +
    'these answers the question (counting, filtering, or re-reading a list you just pulled), ANSWER FROM IT ' +
    'and do NOT call the tool again. Call the tool again only when the entry is marked truncated, when the ' +
    'question needs something the entry does not contain, or when the container may have changed since. ';
  const blocks: string[] = [];
  let used = header.length;
  for (let i = carried.length - 1; i >= 0; i--) {
    const m = carried[i];
    const block =
      `\n${memoKey(m.name, m.args)} ->\n<tool-result${m.truncated ? ' truncated="true"' : ''}>\n${m.content}\n</tool-result>\n` +
      (m.truncated ? '(TRUNCATED: this is only the first part of the result. Re-call the tool if you need the rest.)\n' : '');
    if (used + block.length > MAX_BLOCK_CHARS) break;
    used += block.length;
    blocks.unshift(block);
  }
  if (!blocks.length) return '';
  return header + blocks.join('');
}

/**
 * Per-thread store of carried tool results (main-process only, in memory, never persisted).
 * Threads are keyed the same way the renderer keys a conversation: account + product + the working
 * client (GTM container / GA4 property). Bounded in BOTH directions: MAX_CARRIED_RESULTS per thread,
 * MAX_THREADS threads (oldest-touched evicted), so a long session cannot grow the process's memory.
 */
export class ToolMemoryStore {
  private readonly threads = new Map<string, ToolResultMemo[]>();
  private static readonly MAX_THREADS = 8;

  get(key: string): ToolResultMemo[] {
    return this.threads.get(key) ?? [];
  }

  record(key: string, turnResults: Array<{ name: string; args?: Record<string, unknown>; content?: string; ok: boolean }>): void {
    const next = foldToolResults(this.get(key), turnResults);
    // Re-insert so Map iteration order tracks recency (first key = least recently used).
    this.threads.delete(key);
    if (next.length) this.threads.set(key, next);
    while (this.threads.size > ToolMemoryStore.MAX_THREADS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  clear(key: string): void {
    this.threads.delete(key);
  }
}
