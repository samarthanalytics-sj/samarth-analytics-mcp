// Pure tests for the chat-memory engine (redaction, scope, selection, prompt formatting). Run:
// tsx src/shared/__tests__/chat-memory.test.ts
import {
  redactSecrets, normalizeMemoryText, memoryApplies, memoryDedupeKey,
  selectRelevantMemories, formatMemoriesForPrompt, findMemoriesMatching, MEMORY_MAX_LEN, type Memory,
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

console.log(`\nchat-memory: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
