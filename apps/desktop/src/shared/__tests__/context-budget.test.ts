// Tests for the per-request bounds. The rule these all defend: a cut must never leave the model
// believing it has complete data, because the system prompt tells it to present returned lists in
// full and never say "and more". A silent truncation becomes a confidently wrong answer.
// Run: tsx src/shared/__tests__/context-budget.test.ts
import {
  capToolResult, boundChatHistory, estimateTokens,
  TOOL_RESULT_MAX_CHARS, HISTORY_MAX_CHARS, HISTORY_ALWAYS_KEEP,
} from '../context-budget';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── capToolResult: the common case must be untouched ────────────────────────────
{
  const small = JSON.stringify({ tags: [{ tagId: '1', name: 'GA4 - Purchase' }] });
  const r = capToolResult('list_gtm_tags', small);
  check('cap: an ordinary result passes through byte-for-byte', r.content === small && !r.capped);
  check('cap: empty / missing content is safe', capToolResult('x', '').content === '' && capToolResult('x', undefined as unknown as string).capped === false);
}

// ── capToolResult: a huge object with an array field ────────────────────────────
{
  const tags = Array.from({ length: 4000 }, (_, i) => ({ tagId: String(i), name: `GA4 - Event - Tag number ${i}`, type: 'gaawe' }));
  const big = JSON.stringify({ counts: { tags: tags.length }, tags });
  check('cap: the fixture is genuinely oversized', big.length > TOOL_RESULT_MAX_CHARS * 2);

  const r = capToolResult('list_gtm_tags', big);
  check('cap: oversized result is reduced', r.capped && r.content.length <= TOOL_RESULT_MAX_CHARS);
  check('cap: reports the original size', r.originalChars === big.length);

  // Structure-preserving: the model must still get parseable JSON, not a severed string.
  let parsed: Record<string, unknown> | undefined;
  try { parsed = JSON.parse(r.content) as Record<string, unknown>; } catch { /* stays undefined */ }
  check('cap: the reduced payload is still valid JSON', !!parsed, r.content.slice(-80));
  check('cap: it keeps whole items, not a cut-off one', Array.isArray(parsed?.tags)
    && (parsed?.tags as unknown[]).every((t) => typeof (t as { tagId?: string }).tagId === 'string'));
  check('cap: it keeps the other fields', !!(parsed?.counts));
  check('cap: it keeps as many items as fit, not a token few', ((parsed?.tags as unknown[]) ?? []).length > 50);

  // The honesty contract.
  const notice = String(parsed?._truncated ?? '');
  check('cap: the payload says it was TRUNCATED', /truncated/i.test(notice));
  check('cap: it says by the app, so the model does not blame the API', /by the app/i.test(notice));
  check('cap: it gives shown-of-total with the REAL total', notice.includes(String(tags.length)));
  check('cap: it forbids presenting the list as complete', /never present it as the complete set/i.test(notice));
  check('cap: it forbids inventing the missing rows', /never invent/i.test(notice));
  check('cap: it says what to do instead', /narrower scope or filter/i.test(notice));
}

// ── capToolResult: a bare oversized array ───────────────────────────────────────
{
  const arr = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item ${i}` }));
  const r = capToolResult('list_gtm_variables', JSON.stringify(arr));
  check('cap: a top-level array is reduced and stays valid JSON', (() => {
    if (!r.capped || r.content.length > TOOL_RESULT_MAX_CHARS) return false;
    try { const p = JSON.parse(r.content) as { items?: unknown[]; _truncated?: string }; return Array.isArray(p.items) && !!p._truncated; }
    catch { return false; }
  })());
}

// ── capToolResult: non-JSON falls back to a character cut, still announced ──────
{
  const prose = 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2);
  const r = capToolResult('some_tool', prose);
  check('cap: non-JSON is cut to the budget', r.capped && r.content.length <= TOOL_RESULT_MAX_CHARS);
  check('cap: the cut is announced in the payload', /truncated/i.test(r.content) && /never present it as the complete set/i.test(r.content));
  check('cap: the tool name is named, so the model knows WHICH result is partial', r.content.includes('some_tool'));
}

// ── capToolResult: an ERROR-shaped small result is never mangled ────────────────
check('cap: a short error message is untouched', capToolResult('create_gtm_tag', 'GTM said: invalid parameter').content === 'GTM said: invalid parameter');

// ── boundChatHistory: short threads are untouched ───────────────────────────────
{
  const h = [{ role: 'user' as const, text: 'hi' }, { role: 'assistant' as const, text: 'hello' }];
  const r = boundChatHistory(h);
  check('history: a short thread is passed through unchanged', r.turns.length === 2 && r.dropped === 0 && !r.notice);
  check('history: an empty thread is safe', boundChatHistory([]).turns.length === 0);
}

// ── boundChatHistory: a long thread is trimmed from the OLDEST end ──────────────
{
  const h = Array.from({ length: 60 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn ${i} ` + 'y'.repeat(2000),
  }));
  const r = boundChatHistory(h);
  check('history: a long thread is trimmed', r.dropped > 0 && r.turns.length < h.length);
  check('history: it fits the budget', r.turns.reduce((n, t) => n + t.text.length, 0) <= HISTORY_MAX_CHARS + 4 * 2100);
  check('history: the NEWEST turn always survives', r.turns[r.turns.length - 1].text.startsWith('turn 59'));
  check('history: the most recent few are all kept', r.turns.length >= HISTORY_ALWAYS_KEEP);
  check('history: order is preserved', r.turns.every((t, i) => i === 0 || h.indexOf(t) > h.indexOf(r.turns[i - 1])));

  // The honesty contract again: the model must know the thread is longer than it can see.
  check('history: a notice is produced', !!r.notice);
  check('history: the notice counts what was dropped', String(r.notice).includes(String(r.dropped)));
  check('history: the notice forbids guessing at the missing messages', /ask them to restate it rather than guessing/i.test(String(r.notice)));
}

// ── boundChatHistory: the recent turns are exempt even when huge ────────────────
{
  const h = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, text: `t${i} ` + 'z'.repeat(HISTORY_MAX_CHARS) }));
  const r = boundChatHistory(h);
  check('history: an oversized recent turn is never dropped', r.turns.length >= HISTORY_ALWAYS_KEEP
    && r.turns[r.turns.length - 1].text.startsWith('t5'));
}

// ── boundChatHistory: media rides along with its turn ──────────────────────────
{
  const h: Array<{ role: 'user'; text: string; media?: unknown[] }> = [
    { role: 'user', text: 'old ' + 'q'.repeat(HISTORY_MAX_CHARS), media: [{ kind: 'image' }] },
    ...Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, text: `new ${i}` })),
  ];
  const r = boundChatHistory(h);
  check('history: dropping a turn drops its attachments too', r.dropped === 1 && !r.turns.some((t) => t.media));
}

// ── estimateTokens ──────────────────────────────────────────────────────────────
check('estimate: proportional and safe on empty', estimateTokens('') === 0 && estimateTokens('x'.repeat(340)) === 100);

console.log(`\ncontext-budget: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
