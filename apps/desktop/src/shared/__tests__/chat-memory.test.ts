// Pure tests for the chat-memory engine (redaction, scope, selection, prompt formatting). Run:
// tsx src/shared/__tests__/chat-memory.test.ts
import {
  redactSecrets, normalizeMemoryText, memoryApplies, memoryDedupeKey,
  selectRelevantMemories, formatMemoriesForPrompt, findMemoriesMatching, searchMemories,
  creditMemoryUse, snapshotMemoryText, MEMORY_MAX_LEN, type Memory, type MemoryProvenance,
} from '../chat-memory';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: over.id ?? 'm', kind: over.kind ?? 'fact', text: over.text ?? 'note', scope: over.scope ?? {},
  source: over.source ?? 'manual', pinned: over.pinned ?? false, enabled: over.enabled ?? true,
  createdAt: over.createdAt ?? 1, updatedAt: over.updatedAt ?? 1,
});

// ── redactSecrets — a memory must NEVER persist a credential ────────────────────
check('redact: Google API key', (() => { const r = redactSecrets('key is AIzaSyA1234567890abcdefghijklmnopqrstuvw here'); return r.redacted && !r.text.includes('AIzaSy') && r.text.includes('[redacted]'); })());
check('redact: OAuth access token ya29', (() => { const r = redactSecrets('token ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxxx'); return r.redacted && !r.text.includes('ya29.'); })());
check('redact: Anthropic key', (() => { const r = redactSecrets('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'); return r.redacted && !r.text.includes('sk-ant-'); })());
check('redact: modern OpenAI sk-proj- key (hyphenated prefix)', (() => { const r = redactSecrets('my openai key sk-proj-abcdEFGH1234ijklMNOP5678qrstUVWX90abYZcd_efGH-ijKL'); return r.redacted && !r.text.includes('sk-proj-'); })());
check('redact: does NOT flag ordinary "ask-" prose', (() => { const r = redactSecrets('please ask-me-about-the-longer-configuration-here-thanks'); return !r.text.includes('[redacted]'); })());
check('redact: GTM preview auth', (() => { const r = redactSecrets('snippet gtm_auth=AbCdEf123456 rest'); return r.redacted && !r.text.includes('AbCdEf123456'); })());
check('redact: private key block', (() => { const r = redactSecrets('x -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- y'); return r.redacted && !r.text.includes('MIIabc'); })());
check('redact: secret-ish key=value keeps the key label', (() => { const r = redactSecrets('password: hunter2secret'); return r.redacted && r.text.startsWith('password') && !r.text.includes('hunter2secret'); })());
check('redact: leaves normal GTM ids alone', (() => { const r = redactSecrets('container GTM-ABC123 property 123456789 event phone_click'); return !r.redacted && r.text.includes('GTM-ABC123') && r.text.includes('phone_click'); })());

// ── normalizeMemoryText — control chars, whitespace, redaction, clamp ────────────
check('normalize: collapses whitespace + trims', normalizeMemoryText('  a   b\n\tc  ').text === 'a b c');
check('normalize: strips a control char to a space', normalizeMemoryText('a' + String.fromCharCode(1) + 'b').text === 'a b');
check('normalize: clamps to MEMORY_MAX_LEN', normalizeMemoryText('x'.repeat(MEMORY_MAX_LEN + 50)).text.length === MEMORY_MAX_LEN);
check('normalize: redacts before storing', (() => { const r = normalizeMemoryText('remember AIzaSyA1234567890abcdefghijklmnopqrstuvw'); return r.redacted && !r.text.includes('AIzaSy'); })());
check('normalize: keeps a hyphenated event name intact', normalizeMemoryText('fire add-to-cart on click').text === 'fire add-to-cart on click');

// ── memoryApplies — scope matching ──────────────────────────────────────────────
check('scope: account-wide applies everywhere', memoryApplies(mem({ scope: {} }), { containerId: 'GTM-X' }) === true);
check('scope: container-scoped applies only to its container', memoryApplies(mem({ scope: { containerId: 'GTM-A' } }), { containerId: 'GTM-A' }) === true && memoryApplies(mem({ scope: { containerId: 'GTM-A' } }), { containerId: 'GTM-B' }) === false);
check('scope: property-scoped applies only to its property', memoryApplies(mem({ scope: { property: 'properties/1' } }), { property: 'properties/1' }) === true && memoryApplies(mem({ scope: { property: 'properties/1' } }), { property: 'properties/2' }) === false);

// ── selectRelevantMemories — scope filter + rank (pinned → overlap → recency) ────
{
  const list: Memory[] = [
    mem({ id: 'wide', text: 'always use snake_case event names', scope: {}, updatedAt: 10 }),
    mem({ id: 'other', text: 'client B uses shopify', scope: { containerId: 'GTM-B' }, updatedAt: 20 }),
    mem({ id: 'this', text: 'purchase fires on order_completed', scope: { containerId: 'GTM-A' }, updatedAt: 5 }),
    mem({ id: 'off', text: 'disabled note', scope: {}, enabled: false, updatedAt: 30 }),
    mem({ id: 'pinned', text: 'pinned rule', scope: {}, pinned: true, updatedAt: 1 }),
  ];
  const sel = selectRelevantMemories(list, { containerId: 'GTM-A' }, 'why is purchase not firing');
  const ids = sel.map((m) => m.id);
  check('select: excludes disabled', !ids.includes('off'));
  check('select: excludes other-container scope', !ids.includes('other'));
  check('select: includes account-wide + this-container', ids.includes('wide') && ids.includes('this'));
  check('select: pinned ranks first', ids[0] === 'pinned');
  check('select: keyword overlap (purchase) beats recency', ids.indexOf('this') < ids.indexOf('wide'));
  check('select: respects the limit', selectRelevantMemories(list, { containerId: 'GTM-A' }, 'x', 2).length === 2);
}

// ── formatMemoriesForPrompt — grouping + honest framing ─────────────────────────
{
  const block = formatMemoriesForPrompt([mem({ kind: 'fact', text: 'F' }), mem({ kind: 'rule', text: 'R' })]);
  check('format: empty list → empty string', formatMemoriesForPrompt([]) === '');
  check('format: rules sort before facts', block.indexOf('[rule] R') < block.indexOf('[fact] F'));
  check('format: frames rules as authoritative + facts as verify-me', /RULES and PREFERENCES as authoritative/.test(block) && /VERIFY anything factual/.test(block));
  check('format: uses no em dash', !block.includes('—'));
}

// ── memoryDedupeKey ─────────────────────────────────────────────────────────────
check('dedupe: same kind+scope+text (case-insensitive) → same key', memoryDedupeKey({ kind: 'fact', text: 'Hello', scope: {} }) === memoryDedupeKey({ kind: 'fact', text: 'hello', scope: {} }));
check('dedupe: different scope → different key', memoryDedupeKey({ kind: 'fact', text: 'x', scope: { containerId: 'A' } }) !== memoryDedupeKey({ kind: 'fact', text: 'x', scope: { containerId: 'B' } }));

// ── findMemoriesMatching (the "forget X" matcher) ───────────────────────────────
{
  const list: Memory[] = [
    mem({ id: 'a', text: 'do not suggest scroll tracking for this client' }),
    mem({ id: 'b', text: 'purchase fires on order_completed' }),
    mem({ id: 'c', text: 'client uses shopify' }),
  ];
  check('forget: matches a full substring', findMemoriesMatching(list, 'scroll tracking').map((m) => m.id).join() === 'a');
  check('forget: matches when all significant terms appear', findMemoriesMatching(list, 'shopify client').map((m) => m.id).join() === 'c');
  check('forget: no match → empty', findMemoriesMatching(list, 'facebook pixel').length === 0);
  check('forget: empty query → empty (never removes everything)', findMemoriesMatching(list, '  ').length === 0);
  check('forget: too-vague short query (no term >= 3 chars) → empty (no mass delete)', findMemoriesMatching(list, 'a').length === 0 && findMemoriesMatching(list, 'it').length === 0 && findMemoriesMatching(list, 'do').length === 0);
  check('forget: is case-insensitive', findMemoriesMatching(list, 'ORDER_COMPLETED').map((m) => m.id).join() === 'b');
}

// ── searchMemories — RANKED recall (the retrieval half; `forget` matching stays strict) ─────────
{
  const list: Memory[] = [
    mem({ id: 'a', text: 'we name GA4 events in snake_case', scope: {}, updatedAt: 10 }),
    mem({ id: 'b', text: 'checkout uses order_completed not purchase', scope: { containerId: 'C1' }, updatedAt: 20 }),
    mem({ id: 'c', text: 'client B fires purchase from the thank-you page', scope: { containerId: 'C2' }, updatedAt: 30 }),
    mem({ id: 'd', text: 'muted note about purchase', scope: {}, enabled: false, updatedAt: 40 }),
    mem({ id: 'e', text: 'pinned: never suggest scroll tracking', scope: {}, pinned: true, updatedAt: 5 }),
  ];
  const ids = (hits: ReturnType<typeof searchMemories>): string => hits.map((h) => h.memory.id).join();

  check('recall: partial matches are KEPT and ranked (the strict forget matcher drops them)',
    ids(searchMemories(list, 'purchase checkout')) === 'b,c'
    && ids(findMemoriesMatching(list, 'purchase checkout').map((m) => ({ memory: m, matchedTerms: 0 }))) === 'b');
  check('recall: more matched terms ranks higher', (() => {
    const hits = searchMemories(list, 'purchase checkout');
    return hits[0].memory.id === 'b' && hits[0].matchedTerms === 2 && hits[1].matchedTerms === 1;
  })());
  check('recall: DISABLED memories stay muted', !ids(searchMemories(list, 'purchase')).includes('d'));
  // Equal term counts, so the tiebreak decides: newer note (c, updatedAt 30) before older (b, 20).
  check('recall: scope=all reaches other clients of the account', ids(searchMemories(list, 'purchase', { scope: 'all' })) === 'c,b');
  check('recall: scope=context is the active client + account-wide only',
    ids(searchMemories(list, 'purchase', { scope: 'context', ctx: { containerId: 'C1' } })) === 'b');
  check('recall: scope=account excludes every client-scoped note',
    ids(searchMemories(list, 'events snake_case', { scope: 'account' })) === 'a');
  check('recall: a non-matching query returns nothing (no fallback dump)', searchMemories(list, 'bigquery export').length === 0);
  check('recall: an empty query browses, pinned first', (() => {
    const hits = searchMemories(list, '  ');
    return hits.length === 4 && hits[0].memory.id === 'e';
  })());
  check('recall: limit is honoured', searchMemories(list, '', { limit: 2 }).length === 2);
  check('recall: limit 0 returns nothing', searchMemories(list, '', { limit: 0 }).length === 0);
  check('recall: deterministic for equal scores (id tiebreak)', (() => {
    const same = [mem({ id: 'z', text: 'purchase', updatedAt: 1 }), mem({ id: 'y', text: 'purchase', updatedAt: 1 })];
    return ids(searchMemories(same, 'purchase')) === 'y,z';
  })());

  // The whole point of the tool: analytics notes are full of identifiers, and a user asks about them
  // in plain words. Missing here means the assistant DENIES a rule the user saved.
  const idNotes: Memory[] = [
    mem({ id: 'i1', text: 'we name GA4 events in snake_case' }),
    mem({ id: 'i2', text: 'checkout pushes order_completed to the dataLayer' }),
    mem({ id: 'i3', text: 'the theme fires formSubmission on every form' }),
  ];
  check('recall: plain words match a snake_case identifier', ids(searchMemories(idNotes, 'snake case')) === 'i1');
  check('recall: plain words match a camelCase identifier', ids(searchMemories(idNotes, 'form submission')) === 'i3');
  check('recall: multi-word plain query matches an identifier', ids(searchMemories(idNotes, 'order completed')) === 'i2');
  check('recall: the verbatim identifier still matches', ids(searchMemories(idNotes, 'order_completed')) === 'i2');

  check('recall: an unsearchable query (no tokens) matches nothing rather than everything', (() => {
    // Would otherwise fall through to browse mode and credit every memory as "used".
    return searchMemories(idNotes, '购买').length === 0 && searchMemories(idNotes, 'A/B').length === 0;
  })());

  check('recall: scope=account also excludes PROPERTY-scoped notes, not just container-scoped ones', (() => {
    const list2: Memory[] = [
      mem({ id: 'p1', text: 'retention is 14 months', scope: { property: 'properties/222' } }),
      mem({ id: 'p2', text: 'retention policy account default' }),
    ];
    return ids(searchMemories(list2, 'retention', { scope: 'account' })) === 'p2';
  })());
  check('recall: scope=context matches a GA4 property context', (() => {
    const list2: Memory[] = [
      mem({ id: 'p1', text: 'retention is 14 months', scope: { property: 'properties/222' } }),
      mem({ id: 'p3', text: 'retention is 2 months', scope: { property: 'properties/999' } }),
    ];
    return ids(searchMemories(list2, 'retention', { scope: 'context', ctx: { property: 'properties/222' } })) === 'p1';
  })());
}

// ── creditMemoryUse — the per-turn provenance ledger ("why did you say that") ────────────────────
{
  const led = new Map<string, MemoryProvenance>();
  const a = mem({ id: 'a', text: 'note A', kind: 'rule' });
  const b = mem({ id: 'b', text: 'note B' });

  check('ledger: first credit records the memory', (() => {
    const added = creditMemoryUse(led, [a, b]);
    return added.join() === 'a,b' && led.size === 2 && led.get('a')?.kind === 'rule';
  })());
  check('ledger: a memory injected AND recalled is credited ONCE (no double useCount)', (() => {
    const added = creditMemoryUse(led, [a]);
    return added.length === 0 && led.size === 2;
  })());
  check('ledger: a later recall of a NEW memory returns only that id', (() => {
    const c = mem({ id: 'c', text: 'note C' });
    return creditMemoryUse(led, [a, c]).join() === 'c' && led.size === 3;
  })());
  check('ledger: the snapshot is dash-free and clamped (house style + bounded storage)', (() => {
    const long = mem({ id: 'd', text: `x${'y'.repeat(300)} — dash` });
    creditMemoryUse(led, [long]);
    const rec = led.get('d');
    return !!rec && rec.text.length <= 203 && rec.text.endsWith('...') && !/[—–]/.test(rec.text);
  })());
  check('ledger: snapshotMemoryText leaves a short note intact', snapshotMemoryText('short note') === 'short note');
}

console.log(`\nchat-memory: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
