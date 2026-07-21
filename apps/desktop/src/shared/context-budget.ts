// Bounding what one chat request carries.
//
// A GTM turn's fixed floor (system prompt + tool schemas) is ~32,000 tokens, and the tool loop
// re-sends the WHOLE message array on every step, up to 40 of them. Two things sitting on top of
// that floor had no ceiling at all:
//
//   1. Tool results went to the model in full. `truncForLog` caps the console line at 600 chars, but
//      the model received the complete JSON - a large list or audit response - and then received it
//      again on every later step of the same turn.
//   2. Chat history was never trimmed. Every prior turn's full text (and a user turn's attachments)
//      was replayed on every request, forever.
//
// Both are bounded here, with one rule above all: NEVER let the model believe it has complete data
// when it does not. The system prompt tells it to present a returned list in full and never say "and
// more", so a silent truncation would turn into a confidently wrong answer. Every cut is therefore
// announced IN the payload the model reads, with the real numbers and what to do about it.

/** Rough token estimate. JSON runs denser than prose; 3.4 chars/token matches this app's payloads. */
export const estimateTokens = (s: string): number => Math.round(String(s ?? '').length / 3.4);

/** Per-tool-result ceiling, in characters (~7,000 tokens). Generous on purpose: an ordinary list or
 *  audit passes through untouched, and only a genuinely huge payload - the kind that would be
 *  re-sent dozens of times - gets cut. */
export const TOOL_RESULT_MAX_CHARS = 24_000;

/** History ceiling, in characters (~12,000 tokens), across all replayed turns. */
export const HISTORY_MAX_CHARS = 40_000;
/** The most recent turns are never dropped, even if they alone exceed the budget: without them the
 *  model loses the thing the user is actually talking about. */
export const HISTORY_ALWAYS_KEEP = 4;

export interface CappedResult {
  content: string;
  /** True when the payload was reduced, so callers can log or surface it. */
  capped: boolean;
  originalChars: number;
}

/** Largest array field on a parsed object, by serialized size. */
function biggestArrayKey(obj: Record<string, unknown>): string | undefined {
  let best: { key: string; size: number } | undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v)) continue;
    const size = JSON.stringify(v).length;
    if (!best || size > best.size) best = { key: k, size };
  }
  return best?.key;
}

/** How many leading items of `items` fit in `budget` characters when serialized. */
function fittingCount(items: unknown[], budget: number): number {
  let used = 2; // the enclosing brackets
  for (let i = 0; i < items.length; i += 1) {
    const cost = JSON.stringify(items[i]).length + 1; // + separator
    if (used + cost > budget) return i;
    used += cost;
  }
  return items.length;
}

/**
 * Cap one tool result before it enters the message array.
 *
 * Structure-preserving where possible: for `{ ..., items: [...] }` it keeps as many whole items as
 * fit and records how many were dropped, so the model still receives VALID JSON plus an explicit
 * count. Anything it cannot parse is cut at a character boundary with the same explicit note.
 *
 * The note is written for the model, not for a log: it states the payload was truncated by this app
 * (not by the API), gives shown/total, and tells it to say the list is partial rather than presenting
 * it as complete.
 */
export function capToolResult(name: string, content: string, maxChars = TOOL_RESULT_MAX_CHARS): CappedResult {
  const raw = String(content ?? '');
  if (raw.length <= maxChars) return { content: raw, capped: false, originalChars: raw.length };

  const note = (shown: string, total: string): string =>
    `This ${name} result was TRUNCATED by the app because it was too large to send in full `
    + `(${shown} of ${total}). The data you have is therefore INCOMPLETE: tell the user the list is `
    + 'partial and say how many you are showing, never present it as the complete set, and never '
    + 'invent the missing entries. To see more, call the tool again with a narrower scope or filter.';

  try {
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const keep = fittingCount(parsed, maxChars - 400);
      const trimmed = JSON.stringify({ items: parsed.slice(0, keep), _truncated: note(`${keep} items`, `${parsed.length}`) });
      return { content: trimmed, capped: true, originalChars: raw.length };
    }

    if (parsed && typeof parsed === 'object') {
      const obj = { ...(parsed as Record<string, unknown>) };
      const key = biggestArrayKey(obj);
      if (key) {
        const items = obj[key] as unknown[];
        // Budget for the array = what is left after the object's other fields and the note.
        const rest = { ...obj, [key]: [] };
        const overhead = JSON.stringify(rest).length + 400;
        const keep = fittingCount(items, Math.max(0, maxChars - overhead));
        obj[key] = items.slice(0, keep);
        obj._truncated = note(`${keep} of ${items.length} ${key}`, `${items.length}`);
        const trimmed = JSON.stringify(obj);
        // Only accept the structured cut if it actually fits; otherwise fall through to the raw cut.
        if (trimmed.length <= maxChars) return { content: trimmed, capped: true, originalChars: raw.length };
      }
    }
  } catch {
    // Not JSON: fall through to the character cut.
  }

  const marker = `\n\n[${note(`${maxChars} characters`, `${raw.length}`)}]`;
  return { content: raw.slice(0, Math.max(0, maxChars - marker.length)) + marker, capped: true, originalChars: raw.length };
}

/** A replayed conversation turn, as the chat service holds it. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
  media?: unknown[];
}

export interface BoundedHistory<T> {
  turns: T[];
  /** How many older turns were dropped, for the notice and for logging. */
  dropped: number;
  /** Prepended to the oldest surviving turn when anything was dropped, so the model knows the thread
   *  is longer than what it can see rather than assuming this is the whole conversation. */
  notice?: string;
}

/**
 * Keep the conversation inside a character budget.
 *
 * Drops from the OLDEST end, because recency is what the user is talking about. Two exceptions:
 * the most recent `alwaysKeep` turns are never dropped (they are the immediate context), and when
 * anything is dropped the model is told, so it cannot mistake a trimmed thread for the whole one.
 *
 * Pure: returns the turns to send plus the notice to attach.
 */
export function boundChatHistory<T extends HistoryTurn>(
  history: readonly T[],
  maxChars = HISTORY_MAX_CHARS,
  alwaysKeep = HISTORY_ALWAYS_KEEP,
): BoundedHistory<T> {
  const all = [...(history ?? [])];
  const total = all.reduce((n, h) => n + String(h?.text ?? '').length, 0);
  if (total <= maxChars) return { turns: all, dropped: 0 };

  // Walk backwards, keeping turns while they fit; the last `alwaysKeep` are exempt from the budget.
  const kept: T[] = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const cost = String(all[i]?.text ?? '').length;
    const exempt = all.length - 1 - i < alwaysKeep;
    if (!exempt && used + cost > maxChars) break;
    used += cost;
    kept.unshift(all[i]);
  }

  const dropped = all.length - kept.length;
  if (dropped === 0) return { turns: kept, dropped: 0 };
  return {
    turns: kept,
    dropped,
    notice:
      `[Earlier in this conversation there ${dropped === 1 ? 'was 1 message' : `were ${dropped} messages`} that `
      + 'are no longer included, to keep the request within the model\'s limit. If the user refers to something '
      + 'you cannot see, say so and ask them to restate it rather than guessing what was said.]\n\n',
  };
}
