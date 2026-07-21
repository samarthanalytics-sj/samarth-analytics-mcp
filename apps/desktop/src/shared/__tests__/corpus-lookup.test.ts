// Pure tests for corpus retrieval (the "R" in RAG over the shipped pattern library): tokenized
// matching, ranking, filters, derived shares, and the honesty guarantees of the result envelope.
// Run: tsx src/shared/__tests__/corpus-lookup.test.ts
import {
  lookupCorpusPatterns, lookupTerms, describeTag, describeTrigger, describeVariable,
  LOOKUP_DEFAULT_LIMIT, LOOKUP_MAX_LIMIT,
} from '../corpus-lookup';
import type { PatternLibrary, TagPattern, TriggerPattern, VariablePattern } from '../corpus-patterns';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tag = (o: Partial<TagPattern>): TagPattern => ({
  type: 'gaawe', brand: 'ga4', paramKeys: ['eventName', 'measurementId'], consent: 'notSet',
  triggerKinds: ['customEvent'], containers: 10, occurrences: 20, ...o,
});
const trig = (o: Partial<TriggerPattern>): TriggerPattern => ({
  type: 'customEvent', conditions: [], containers: 10, occurrences: 20, ...o,
});
const vari = (o: Partial<VariablePattern>): VariablePattern => ({
  type: 'v', paramKeys: ['name'], containers: 10, occurrences: 20, ...o,
});

const LIB: PatternLibrary = {
  version: 1,
  minedAt: '2026-07-21',
  containersScanned: 500,
  minContainers: 2,
  tagPatterns: [
    tag({ eventName: 'form_submit', containers: 120, occurrences: 300 }),
    tag({ eventName: 'purchase', containers: 200, occurrences: 260 }),
    tag({ eventName: 'purchase', type: 'html', brand: 'meta', paramKeys: ['html'], containers: 40, occurrences: 44, triggerKinds: ['customEvent'] }),
    tag({ type: 'awct', brand: 'gads', eventName: undefined, paramKeys: ['conversionId'], containers: 90, occurrences: 130, triggerKinds: ['builtIn'] }),
    tag({ eventName: 'view_item', containers: 30, occurrences: 33 }),
  ],
  triggerPatterns: [
    trig({ event: 'form_submit', containers: 150, occurrences: 400 }),
    trig({ type: 'linkClick', conditions: ['{{Click URL}} contains <text>'], containers: 80, occurrences: 90 }),
    trig({ event: 'purchase', containers: 60, occurrences: 70 }),
  ],
  variablePatterns: [
    vari({ keyPath: 'ecommerce.currency', containers: 70, occurrences: 75 }),
    vari({ keyPath: 'form_id', containers: 25, occurrences: 28 }),
  ],
  vendorStats: [
    { brand: 'ga4', containers: 450 },
    { brand: 'meta', containers: 150 },
    { brand: 'tiktok', containers: 60 },
  ],
};

// ── Tokenizer: the thing that makes "form submit" find form_submit / formSubmit ──
check('terms: underscores split', JSON.stringify(lookupTerms('form_submit')) === JSON.stringify(['form', 'submit']));
check('terms: camelCase splits', JSON.stringify(lookupTerms('formSubmission')) === JSON.stringify(['form', 'submission']));
check('terms: spaces + punctuation split', JSON.stringify(lookupTerms('Form Submit!')) === JSON.stringify(['form', 'submit']));
check('terms: digits survive, 1-char noise dropped', JSON.stringify(lookupTerms('ga4 a x')) === JSON.stringify(['ga4']));
check('terms: dotted key path splits', JSON.stringify(lookupTerms('ecommerce.currency')) === JSON.stringify(['ecommerce', 'currency']));

// ── Matching ────────────────────────────────────────────────────────────────────
{
  const r = lookupCorpusPatterns(LIB, { query: 'form submit' });
  check('search: a plain-words query finds the underscored pattern', r.hits.length > 0 && r.hits[0].eventName === 'form_submit');
  check('search: both the tag and the trigger surface', r.hits.some((h) => h.kind === 'tag') && r.hits.some((h) => h.kind === 'trigger'), JSON.stringify(r.hits.map((h) => h.kind)));
  check('search: nothing unrelated leaks in', r.hits.every((h) => (h.eventName ?? h.keyPath ?? '').includes('form')), JSON.stringify(r.hits.map((h) => h.pattern)));
}
check('search: prefix match on a >= 4-char term (purchase → purchases)', lookupCorpusPatterns(
  { ...LIB, tagPatterns: [tag({ eventName: 'purchases_completed', containers: 5 })], triggerPatterns: [], variablePatterns: [] },
  { query: 'purchase' },
).hits.length === 1);
check('search: a short term does NOT prefix-match (no "ga" → "gaawe" noise)', lookupCorpusPatterns(
  { ...LIB, tagPatterns: [tag({ eventName: undefined, paramKeys: [] })], triggerPatterns: [], variablePatterns: [], vendorStats: [] },
  { query: 'ga' },
).hits.length === 0);
check('search: an unmatched query returns nothing plus an honest note', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'zorbex quantum widget' });
  return r.hits.length === 0 && r.matched === 0 && !!r.note && !r.vendors;
})());
check('search: an empty query browses the most common patterns', (() => {
  const r = lookupCorpusPatterns(LIB, { query: '' });
  return r.hits.length === LOOKUP_DEFAULT_LIMIT - 2 // 10 patterns exist in the fixture
    && r.hits[0].containers === 200;
})(), JSON.stringify(lookupCorpusPatterns(LIB, { query: '' }).hits.map((h) => h.containers)));

// ── Ranking ─────────────────────────────────────────────────────────────────────
check('rank: a name hit outranks a type-only hit', (() => {
  // "purchase" matches two tags by name; the awct tag matches nothing and must not appear.
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', kind: 'tag' });
  return r.hits[0].eventName === 'purchase' && r.hits.every((h) => h.eventName === 'purchase');
})());
check('rank: equal scores break on container count (most practiced first)', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', kind: 'tag' });
  return r.hits[0].containers === 200 && r.hits[1].containers === 40;
})());
check('rank: deterministic across repeated calls', (() => {
  const a = JSON.stringify(lookupCorpusPatterns(LIB, { query: 'purchase' }));
  const b = JSON.stringify(lookupCorpusPatterns(LIB, { query: 'purchase' }));
  return a === b;
})());

// ── Filters ─────────────────────────────────────────────────────────────────────
check('filter: kind=trigger returns only triggers', lookupCorpusPatterns(LIB, { query: 'form', kind: 'trigger' }).hits.every((h) => h.kind === 'trigger'));
check('filter: kind=variable returns only variables', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'currency', kind: 'variable' });
  return r.hits.length === 1 && r.hits[0].kind === 'variable' && r.hits[0].keyPath === 'ecommerce.currency';
})());
check('filter: brand restricts tags and suppresses trigger/variable noise', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', brand: 'meta' });
  return r.hits.length === 1 && r.hits[0].brand === 'meta' && r.hits[0].kind === 'tag';
})());
check('filter: an unknown brand returns nothing rather than everything', lookupCorpusPatterns(LIB, { query: 'purchase', brand: 'nosuchvendor' }).hits.length === 0);
check('filter: kind=vendor returns adoption rows without a query', (() => {
  const r = lookupCorpusPatterns(LIB, { kind: 'vendor' });
  return r.vendors?.length === 3 && r.vendors[0].brand === 'ga4' && r.hits.length === 0;
})());
check('vendors: only attach in "all" mode when the query names one', (() => {
  const named = lookupCorpusPatterns(LIB, { query: 'tiktok' });
  const notNamed = lookupCorpusPatterns(LIB, { query: 'purchase' });
  return named.vendors?.length === 1 && named.vendors[0].brand === 'tiktok' && !notNamed.vendors;
})());

// ── Limits ──────────────────────────────────────────────────────────────────────
check('limit: respected, and the overflow is disclosed not hidden', (() => {
  const r = lookupCorpusPatterns(LIB, { query: '', limit: 2 });
  return r.hits.length === 2 && r.matched === 10 && (r.note ?? '').includes('10 patterns matched');
})());
check('limit: clamped to the max', lookupCorpusPatterns(LIB, { query: '', limit: 9999 }).hits.length <= LOOKUP_MAX_LIMIT);
check('limit: a garbage limit falls back to the default, never 0 or NaN', (() => {
  const r = lookupCorpusPatterns(LIB, { query: '', limit: Number.NaN });
  return r.hits.length === 10;
})());

// ── Honesty of the envelope ─────────────────────────────────────────────────────
check('honest: source names the corpus and disclaims benchmark status', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase' });
  return r.source.includes('500') && r.source.includes('your own') && /not industry benchmarks/i.test(r.source);
})());
check('honest: raw counts pass through untouched', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', kind: 'tag' });
  return r.hits[0].containers === 200 && r.hits[0].occurrences === 260;
})());
check('honest: share is derived from the real denominator', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', kind: 'tag' });
  return r.hits[0].containerShare === 40; // 200 of 500
})());
check('honest: a zero denominator cannot produce a bogus share', (() => {
  const r = lookupCorpusPatterns({ ...LIB, containersScanned: 0 }, { query: 'purchase', kind: 'tag' });
  return r.hits.every((h) => h.containerShare === 0);
})());
check('honest: minedAt + minContainers are reported so the model can date the evidence', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase' });
  return r.minedAt === '2026-07-21' && r.minContainers === 2;
})());

// ── Descriptions (fed to the model; house style forbids em dashes) ──────────────
check('describe: tag reads as a sentence with event + firing', describeTag(tag({ eventName: 'purchase' })) === 'GA4 Event tag sending "purchase", fired by customEvent, consent notSet');
check('describe: trigger with conditions (and the label\'s em dash flattened)',
  describeTrigger(trig({ type: 'linkClick', conditions: ['{{Click URL}} contains <text>'] }))
  === 'Click - Just Links trigger where {{Click URL}} contains <text>');
check('describe: trigger without conditions says so',
  describeTrigger(trig({ event: 'form_submit' })) === 'customEvent trigger on "form_submit" (no conditions)');
check('describe: variable uses the friendly type label', describeVariable(vari({ keyPath: 'ecommerce.currency' })) === 'Data Layer Variable variable "ecommerce.currency"');
check('describe: NO em dash survives from the GTM type labels', (() => {
  const all = [
    ...LIB.tagPatterns.map(describeTag),
    ...LIB.triggerPatterns.map(describeTrigger),
    ...LIB.variablePatterns.map(describeVariable),
    describeTrigger(trig({ type: 'linkClick' })), // label is "Click — Just Links"
    describeTrigger(trig({ type: 'click' })),
  ].join(' ');
  return !/[—–]/.test(all);
})());
check('describe: the whole result payload is em-dash free', !/[—–]/.test(JSON.stringify(lookupCorpusPatterns(
  { ...LIB, triggerPatterns: [trig({ type: 'linkClick', conditions: [] }), trig({ type: 'click', conditions: [] })] },
  { query: 'click' },
))));

// ── Inflections: a plural query must not read as "the corpus has nothing" ───────
check('inflection: plural query finds the singular pattern', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchases', kind: 'tag' });
  return r.hits.length === 2 && r.hits.every((h) => h.eventName === 'purchase');
})());
check('inflection: singular query still finds a longer pattern name', lookupCorpusPatterns(
  { ...LIB, tagPatterns: [tag({ eventName: 'purchases_completed', containers: 5 })], triggerPatterns: [], variablePatterns: [] },
  { query: 'purchase' },
).hits.length === 1);
check('inflection: a short token cannot prefix-match its way into everything', (() => {
  // "for" (3 chars) must NOT match "form_submit": below the 4-char floor in both directions.
  const r = lookupCorpusPatterns(LIB, { query: 'for', kind: 'trigger' });
  return r.hits.length === 0;
})());

// ── Frequency blending: a rare coincidence must not permanently bury a common pattern ──
check('rank: a widely used pattern outranks a rare one in the SAME relevance band', (() => {
  const lib: PatternLibrary = {
    ...LIB,
    tagPatterns: [tag({ eventName: 'purchase', containers: 3 }), tag({ eventName: 'purchase', type: 'html', brand: 'meta', containers: 300 })],
    triggerPatterns: [], variablePatterns: [], vendorStats: [],
  };
  return lookupCorpusPatterns(lib, { query: 'purchase' }).hits[0].containers === 300;
})());
check('rank: relevance still beats frequency ACROSS bands', (() => {
  // A name match on a 3-container pattern must still outrank a paramKey-only match on a 300-container one.
  const lib: PatternLibrary = {
    ...LIB,
    tagPatterns: [
      tag({ eventName: 'checkout_start', containers: 3, paramKeys: [] }),
      tag({ eventName: undefined, containers: 300, paramKeys: ['checkout_start'] }),
    ],
    triggerPatterns: [], variablePatterns: [], vendorStats: [],
  };
  const hits = lookupCorpusPatterns(lib, { query: 'checkout_start' }).hits;
  return hits[0].containers === 3 && hits[1].containers === 300;
})());
check('rank: a vendor term is name-strength (a brand tag beats an incidental key-path match)', (() => {
  const lib: PatternLibrary = {
    ...LIB,
    tagPatterns: [tag({ type: 'html', brand: 'meta', eventName: undefined, containers: 121, paramKeys: ['html'] })],
    triggerPatterns: [],
    variablePatterns: [vari({ keyPath: 'formMetaData.formCampaign', containers: 3 })],
    vendorStats: [{ brand: 'meta', containers: 150 }],
  };
  const hits = lookupCorpusPatterns(lib, { query: 'meta pixel' }).hits;
  return hits[0].kind === 'tag' && hits[0].brand === 'meta';
})(), JSON.stringify(lookupCorpusPatterns({ ...LIB, tagPatterns: [tag({ type: 'html', brand: 'meta', eventName: undefined, containers: 121, paramKeys: ['html'] })], triggerPatterns: [], variablePatterns: [vari({ keyPath: 'formMetaData.formCampaign', containers: 3 })], vendorStats: [] }, { query: 'meta pixel' }).hits.map((h) => h.pattern)));

// ── Brand filter ────────────────────────────────────────────────────────────────
check('brand: an EXPLICIT kind is not voided by a brand filter', (() => {
  const withBrand = lookupCorpusPatterns(LIB, { query: 'form submit', kind: 'trigger', brand: 'ga4' });
  const without = lookupCorpusPatterns(LIB, { query: 'form submit', kind: 'trigger' });
  return withBrand.matched === without.matched && withBrand.matched > 0;
})());
check('brand: a synonym resolves to the library key', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', brand: 'facebook' });
  return r.brand === 'meta' && r.hits.length === 1 && r.hits[0].brand === 'meta';
})());
check('brand: an UNKNOWN vendor says so instead of asserting absence', (() => {
  const r = lookupCorpusPatterns(LIB, { query: 'purchase', brand: 'nosuchvendor' });
  return r.hits.length === 0 && /not a vendor key/i.test(r.note ?? '') && !/No pattern in the library matched/.test(r.note ?? '');
})());
check('brand: the applied filter is echoed so an empty result is attributable', lookupCorpusPatterns(LIB, { query: 'x', brand: 'Meta' }).brand === 'meta');

// ── Untokenizable query: must not silently become "everything matched" ──────────
check('guard: a non-empty query with no searchable term returns nothing, not the whole library', (() => {
  const r = lookupCorpusPatterns(LIB, { query: '购买 转化' });
  return r.matched === 0 && r.hits.length === 0 && /no searchable term/i.test(r.note ?? '');
})());
check('guard: the untokenizable note does NOT tell the model the pattern is absent', !/No pattern in the library matched/.test(lookupCorpusPatterns(LIB, { query: 'A/B' }).note ?? ''));

// ── Truncation honesty ──────────────────────────────────────────────────────────
check('truncation: a QUERIED overflow is never CLAIMED to be the most common (ranking is relevance-first)', (() => {
  const note = lookupCorpusPatterns(LIB, { query: 'purchase form currency', limit: 1 }).note ?? '';
  // The claim "the N most common are returned" would be false here; the note may still warn against it.
  return note.includes('closest to the query') && !/most common are returned/.test(note) && /NOT purely by frequency/.test(note);
})());
check('truncation: an EMPTY-query overflow is genuinely frequency-ordered, so "most common" is true', (() => {
  const r = lookupCorpusPatterns(LIB, { query: '', limit: 2 });
  return (r.note ?? '').includes('most common') && r.hits[0].containers >= r.hits[1].containers;
})());

// ── Limits (a fixture big enough to actually exercise the cap) ──────────────────
check('limit: the max is really enforced, not just nominally', (() => {
  const many: PatternLibrary = {
    ...LIB,
    tagPatterns: Array.from({ length: 80 }, (_, i) => tag({ eventName: `purchase_${i}`, containers: 80 - i })),
    triggerPatterns: [], variablePatterns: [], vendorStats: [],
  };
  const r = lookupCorpusPatterns(many, { query: '', limit: 9999 });
  return r.hits.length === LOOKUP_MAX_LIMIT && r.matched === 80;
})());

// ── Share precision ─────────────────────────────────────────────────────────────
check('share: a k=2 pattern in a 500-container corpus is not rounded to 0%', (() => {
  const lib: PatternLibrary = { ...LIB, tagPatterns: [tag({ eventName: 'purchase', containers: 2 })], triggerPatterns: [], variablePatterns: [], vendorStats: [] };
  return lookupCorpusPatterns(lib, { query: 'purchase' }).hits[0].containerShare === 0.4;
})());

// ── Robustness (a malformed/empty library must not throw) ────────────────────────
check('robust: an empty library returns an empty, honest result', (() => {
  const r = lookupCorpusPatterns({ ...LIB, tagPatterns: [], triggerPatterns: [], variablePatterns: [], vendorStats: [] }, { query: 'purchase' });
  return r.hits.length === 0 && r.matched === 0 && !!r.note;
})());

console.log(`\ncorpus-lookup: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
