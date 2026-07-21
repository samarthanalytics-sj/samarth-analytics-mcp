// Pure tests for the corpus pattern miner (normalization, redaction, k-anonymity, leak scan) PLUS a
// guard over the COMMITTED artifact (corpus/gtm-pattern-library.json): schema, leak-scan clean, bounded
// size. Run: tsx src/shared/__tests__/corpus-patterns.test.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  normEnum, classifyValue, keepKnowledgeValue, minePatternLibrary, scanForLeaks,
  MIN_CONTAINERS, type CorpusExport, type PatternLibrary,
} from '../corpus-patterns';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── normEnum (the UPPER_SNAKE export vs camelCase API split) ─────────────────────
check('normEnum: CUSTOM_EVENT → customEvent', normEnum('CUSTOM_EVENT') === 'customEvent');
check('normEnum: NOT_SET → notSet', normEnum('NOT_SET') === 'notSet');
check('normEnum: EQUALS → equals', normEnum('EQUALS') === 'equals');
check('normEnum: already-camel passes through', normEnum('customEvent') === 'customEvent');
check('normEnum: empty/undefined → ""', normEnum(undefined) === '');

// ── classifyValue (value redaction) ──────────────────────────────────────────────
check('classify: concrete measurement id → <id>', classifyValue('G-AB12CD34') === '<id>' && classifyValue('AW-99887766') === '<id>');
check('classify: url → <url>', classifyValue('https://acme-client.com/x') === '<url>');
check('classify: email → <email>', classifyValue('ceo@acme.com') === '<email>');
check('classify: number → <num>', classifyValue('12345') === '<num>');
check('classify: page path → <path>', classifyValue('/contact.htm') === '<path>');
check('classify: free text → <text>', classifyValue('Buy Now') === '<text>');
check('classify: booleans kept', classifyValue('true') === 'true' && classifyValue('false') === 'false');
check('classify: BUILT-IN var ref kept verbatim', classifyValue('{{Page Path}}') === '{{Page Path}}');
check('classify: CUSTOM var ref anonymized', classifyValue('{{Acme GA4 ID}}') === '{{var}}');

// ── keepKnowledgeValue (the only path where raw values survive — TOKEN ALLOWLIST) ─
check('knowledge: a generic event name survives', keepKnowledgeValue('purchase') === 'purchase');
check('knowledge: generic multi-word names survive', keepKnowledgeValue('form_submit') === 'form_submit'
  && keepKnowledgeValue('pdf_download_click') === 'pdf_download_click'
  && keepKnowledgeValue('formSubmit') === 'formSubmit');
check('knowledge: a BRANDED name is dropped (allowlist, not blocklist)', keepKnowledgeValue('TK_Form_GetInformationGalpin') === undefined
  && keepKnowledgeValue('detmold_group_member_click') === undefined
  && keepKnowledgeValue('book_call_rhiannon_click') === undefined);
check('knowledge: one unknown token poisons the whole value', keepKnowledgeValue('purchase_zorbex') === undefined);
check('knowledge: a variable ref does not survive', keepKnowledgeValue('{{Event}}') === undefined);
check('knowledge: an id does not', keepKnowledgeValue('G-AB12CD34') === undefined);
check('knowledge: an embedded long digit run does not (container/account id)', keepKnowledgeValue('evt_1880666761') === undefined);
check('knowledge: overlong values do not', keepKnowledgeValue('x'.repeat(61)) === undefined);

// ── Mining: extraction + k-anonymity + cvt-id normalization ─────────────────────
const exportWith = (over: { tagType?: string; eventName?: string; consent?: string; event?: string; pid?: string }): CorpusExport => ({
  containerVersion: {
    container: { publicId: over.pid ?? 'GTM-XXXX' },
    tag: [{
      name: 'T',
      type: over.tagType ?? 'gaawe',
      parameter: [
        { type: 'TEMPLATE', key: 'measurementId', value: 'G-SECRET99' },
        ...(over.eventName ? [{ type: 'TEMPLATE', key: 'eventName', value: over.eventName }] : []),
      ],
      firingTriggerId: ['7', '2147479553'],
      consentSettings: { consentStatus: over.consent ?? 'NOT_SET' },
    }],
    trigger: [{
      triggerId: '7',
      name: 'Trg',
      type: 'CUSTOM_EVENT',
      customEventFilter: [{ type: 'EQUALS', parameter: [
        { type: 'TEMPLATE', key: 'arg0', value: '{{_event}}' },
        { type: 'TEMPLATE', key: 'arg1', value: over.event ?? 'form_submit' },
      ] }],
      filter: [{ type: 'CONTAINS', parameter: [
        { type: 'TEMPLATE', key: 'arg0', value: '{{Page Path}}' },
        { type: 'TEMPLATE', key: 'arg1', value: '/secret-client-page' },
      ] }],
    }],
    variable: [{ name: 'dlv - currency', type: 'v', parameter: [{ type: 'TEMPLATE', key: 'name', value: 'ecommerce.currency' }] }],
  },
});

{
  const lib = minePatternLibrary([exportWith({ pid: 'GTM-AAAA' }), exportWith({ pid: 'GTM-BBBB' })], '2026-07-20');
  check('mine: tag pattern extracted with normalized consent + trigger kinds', (() => {
    const t = lib.tagPatterns[0];
    return t && t.type === 'gaawe' && t.consent === 'notSet' && JSON.stringify(t.triggerKinds) === JSON.stringify(['builtIn', 'customEvent']);
  })(), JSON.stringify(lib.tagPatterns[0] ?? null));
  check('mine: trigger pattern carries the custom-event NAME + redacted condition', (() => {
    const t = lib.triggerPatterns[0];
    return t && t.type === 'customEvent' && t.event === 'form_submit' && t.conditions.join() === '{{Page Path}} contains <path>';
  })(), JSON.stringify(lib.triggerPatterns[0] ?? null));
  check('mine: variable keyPath kept as knowledge', lib.variablePatterns[0]?.keyPath === 'ecommerce.currency');
  check('mine: counts containers vs occurrences', lib.tagPatterns[0]?.containers === 2 && lib.tagPatterns[0]?.occurrences === 2);
  check('mine: the raw G- id never reaches the artifact', !JSON.stringify(lib).includes('G-SECRET99'));
  check('mine: the client page path never reaches the artifact', !JSON.stringify(lib).includes('secret-client-page'));
}

check('mine: k-anonymity — a single-container pattern is dropped', (() => {
  const lib = minePatternLibrary([exportWith({ event: 'search', pid: 'GTM-AAAA' }), exportWith({ pid: 'GTM-BBBB' })], '2026-07-20');
  return !JSON.stringify(lib).includes('"search"') && MIN_CONTAINERS === 2;
})());

check('mine: DUPLICATE export files of the same container count as ONE (k keyed by publicId)', (() => {
  // Two files, same publicId (e.g. "GTM-X_workspace5.json" and "GTM-X_workspace5 (1).json"):
  // containers must dedupe to 1, so every pattern falls below MIN_CONTAINERS and is dropped.
  const lib = minePatternLibrary([exportWith({ pid: 'GTM-SAME' }), exportWith({ pid: 'GTM-SAME' })], '2026-07-20');
  return lib.containersScanned === 2 && lib.tagPatterns.length === 0 && lib.triggerPatterns.length === 0;
})());

check('mine: exports MISSING a publicId still count as distinct containers (file fallback)', (() => {
  const strip = (e: CorpusExport): CorpusExport => { delete (e.containerVersion as { container?: unknown }).container; return e; };
  const lib = minePatternLibrary([strip(exportWith({})), strip(exportWith({}))], '2026-07-20');
  return lib.tagPatterns[0]?.containers === 2;
})());

check('mine: cvt_<containerId>_<n> template types collapse to "cvt" (the id is a client identifier)', (() => {
  const lib = minePatternLibrary([exportWith({ tagType: 'cvt_188066676_309', pid: 'GTM-AAAA' }), exportWith({ tagType: 'cvt_188066676_309', pid: 'GTM-BBBB' })], '2026-07-20');
  return lib.tagPatterns[0]?.type === 'cvt' && !JSON.stringify(lib).includes('188066676');
})());

check('mine: deterministic — same corpus, identical artifact', (() => {
  const a = minePatternLibrary([exportWith({ pid: 'GTM-AAAA' }), exportWith({ consent: 'NEEDED', pid: 'GTM-BBBB' })], '2026-07-20');
  const b = minePatternLibrary([exportWith({ pid: 'GTM-AAAA' }), exportWith({ consent: 'NEEDED', pid: 'GTM-BBBB' })], '2026-07-20');
  return JSON.stringify(a) === JSON.stringify(b);
})());

check('mine: malformed exports (non-array fields) never crash', (() => {
  const bad = { containerVersion: { tag: { not: 'an array' }, trigger: null, variable: 42 } } as unknown as CorpusExport;
  const lib = minePatternLibrary([bad, exportWith({ pid: 'GTM-AAAA' }), exportWith({ pid: 'GTM-BBBB' })], '2026-07-20');
  return lib.containersScanned === 3 && lib.tagPatterns.length > 0;
})());

// ── Leak scan ────────────────────────────────────────────────────────────────────
check('leak: catches a concrete id / url / email / digit run', (() => {
  return scanForLeaks('x G-AB12CD34 x').length > 0
    && scanForLeaks('see https://acme.com').length > 0
    && scanForLeaks('mail me a@b.co').length > 0
    && scanForLeaks('id 188066676123').length > 0;
})());
check('leak: measurement id match is CASE-INSENSITIVE (redaction side is)', scanForLeaks('x g-ab12cd34 x').length > 0
  && scanForLeaks('x gtm-nrw45b6 x').length > 0);
check('leak: separator-broken digit run (phone/account number)', scanForLeaks('call +1 (415) 555-0199 now').length > 0);
check('leak: clean text passes', scanForLeaks('{"type":"gaawe","eventName":"purchase","paramKeys":["eventName"]}').length === 0);

// ── The COMMITTED artifact: schema + leak-clean + bounded ────────────────────────
{
  const artifactPath = join(__dirname, '..', 'corpus', 'gtm-pattern-library.json');
  check('artifact: committed file exists', existsSync(artifactPath));
  if (existsSync(artifactPath)) {
    const raw = readFileSync(artifactPath, 'utf8');
    const lib = JSON.parse(raw) as PatternLibrary;
    check('artifact: schema v1 with real corpus counts', lib.version === 1 && lib.containersScanned >= 500 && lib.minContainers >= 2);
    check('artifact: all three pattern kinds populated', lib.tagPatterns.length > 100 && lib.triggerPatterns.length > 50 && lib.variablePatterns.length > 20);
    check('artifact: every pattern meets the k-anonymity threshold', [...lib.tagPatterns, ...lib.triggerPatterns, ...lib.variablePatterns].every((p) => p.containers >= lib.minContainers));
    check('artifact: LEAK SCAN CLEAN (no ids/urls/emails/digit runs)', scanForLeaks(raw).length === 0, JSON.stringify(scanForLeaks(raw)[0] ?? null));
    check('artifact: bounded size (< 2 MB)', raw.length < 2 * 1024 * 1024, `${raw.length} bytes`);
    check('artifact: minedAt is a date only (no timestamp)', /^\d{4}-\d{2}-\d{2}$/.test(lib.minedAt));
  }
}

console.log(`\ncorpus-patterns: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
