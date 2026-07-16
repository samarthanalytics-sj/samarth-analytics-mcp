// Pure tests for the chat-memory auto-suggest extraction (parser + transcript builder). Run:
// tsx src/shared/__tests__/memory-extract.test.ts
import { parseMemoryCandidates, buildExtractionTranscript, MEMORY_EXTRACT_SYSTEM, MEMORY_SUGGEST_LIMIT } from '../memory-extract';
import type { Memory } from '../chat-memory';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: over.id ?? 'm', kind: over.kind ?? 'fact', text: over.text ?? 'note', scope: over.scope ?? {},
  source: 'manual', pinned: false, enabled: true, createdAt: 1, updatedAt: 1, ...over,
});

// ── parseMemoryCandidates ────────────────────────────────────────────────────────
check('parse: plain JSON array', (() => {
  const r = parseMemoryCandidates('[{"kind":"rule","text":"always snake_case"},{"kind":"fact","text":"client uses shopify"}]');
  return r.length === 2 && r[0].kind === 'rule' && r[1].text === 'client uses shopify';
})());
check('parse: tolerates a ```json fence + surrounding prose', (() => {
  const r = parseMemoryCandidates('Here you go:\n```json\n[{"kind":"preference","text":"prefer server-side Meta"}]\n```\nDone.');
  return r.length === 1 && r[0].kind === 'preference';
})());
check('parse: malformed JSON → [] (never throws)', parseMemoryCandidates('not json at all').length === 0);
check('parse: tolerates trailing prose that contains brackets', (() => {
  const r = parseMemoryCandidates('[{"kind":"rule","text":"always snake_case"}] want more [details]?');
  return r.length === 1 && r[0].text === 'always snake_case';
})());
check('parse: a bracket inside a string value does not break the boundary', (() => {
  const r = parseMemoryCandidates('[{"kind":"fact","text":"client uses [square] widgets"}]');
  return r.length === 1 && r[0].text === 'client uses [square] widgets';
})());
check('parse: non-array JSON → []', parseMemoryCandidates('{"kind":"fact","text":"x"}').length === 0);
check('parse: unknown kind falls back to fact', parseMemoryCandidates('[{"kind":"bogus","text":"y"}]')[0].kind === 'fact');
check('parse: empty / whitespace text is skipped', parseMemoryCandidates('[{"kind":"fact","text":"   "},{"kind":"fact","text":"keep"}]').length === 1);
check('parse: a secret in a candidate is redacted', (() => {
  const r = parseMemoryCandidates('[{"kind":"fact","text":"key is AIzaSyA1234567890abcdefghijklmnopqrstuvw"}]');
  return r.length === 1 && !r[0].text.includes('AIzaSy') && r[0].text.includes('[redacted]');
})());
check('parse: drops candidates already saved (dedupe vs existing, scope-agnostic)', (() => {
  const existing = [mem({ kind: 'rule', text: 'always snake_case', scope: { containerId: 'GTM-A' } })];
  const r = parseMemoryCandidates('[{"kind":"rule","text":"Always snake_case"},{"kind":"fact","text":"fresh"}]', existing);
  return r.length === 1 && r[0].text === 'fresh';
})());
check('parse: de-dupes within the batch', parseMemoryCandidates('[{"kind":"fact","text":"dup"},{"kind":"fact","text":"dup"}]').length === 1);
check('parse: caps at the limit', parseMemoryCandidates(JSON.stringify(Array.from({ length: 20 }, (_v, i) => ({ kind: 'fact', text: `n${i}` })))).length === MEMORY_SUGGEST_LIMIT);

// ── buildExtractionTranscript ─────────────────────────────────────────────────────
check('transcript: labels roles + skips empty turns', (() => {
  const t = buildExtractionTranscript([{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }, { role: 'assistant', text: 'hello' }]);
  return t.includes('User: hi') && t.includes('Assistant: hello') && !/Assistant: \n/.test(t);
})());
check('transcript: keeps the MOST RECENT within budget', (() => {
  const long = Array.from({ length: 50 }, (_v, i) => ({ role: 'user' as const, text: `msg-${i} ${'x'.repeat(200)}` }));
  const t = buildExtractionTranscript(long, 1000);
  return t.includes('msg-49') && !t.includes('msg-0 ');
})());
check('transcript: empty history → empty string', buildExtractionTranscript([]) === '');

// ── MEMORY_EXTRACT_SYSTEM ─────────────────────────────────────────────────────────
check('system: forbids secrets + PII', /NEVER include secrets/i.test(MEMORY_EXTRACT_SYSTEM) && /personal data/i.test(MEMORY_EXTRACT_SYSTEM));
check('system: demands a JSON array + conservative', /JSON array/i.test(MEMORY_EXTRACT_SYSTEM) && /CONSERVATIVE/i.test(MEMORY_EXTRACT_SYSTEM));
check('system: uses no em dash', !MEMORY_EXTRACT_SYSTEM.includes('—'));

console.log(`\nmemory-extract: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
