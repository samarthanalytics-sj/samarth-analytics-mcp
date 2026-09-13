// Tests for attaching saved notes to audit findings. The invariant that makes this safe to ship at
// all: annotation is STRICTLY ADDITIVE. A note may never downgrade, suppress, reorder or reword a
// finding, because a sentence typed months ago cannot prove runtime behaviour.
// Run: tsx src/shared/__tests__/audit-annotations.test.ts
import {
  annotateFindings, annotationFor, annotationLabel,
  type AnnotationMemory, type AnnotatableFinding,
} from '../audit-annotations';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const mem = (text: string, over: Partial<AnnotationMemory> = {}): AnnotationMemory =>
  ({ id: over.id ?? 'm1', kind: over.kind ?? 'decision', text, enabled: over.enabled ?? true, updatedAt: over.updatedAt ?? 1 });

/** A full finding, so the additive invariant can be checked field by field. */
const finding = (over: Partial<AnnotatableFinding> = {}): AnnotatableFinding & Record<string, unknown> => ({
  severity: 'critical',
  confidence: 'certain',
  checkId: 'B6-ad-pixel-consent',
  category: over.category ?? 'consent',
  message: over.message ?? 'Custom HTML advertising pixel has no consent gate.',
  resource: over.resource ?? { kind: 'tag', id: '12', name: 'Meta Pixel Purchase', type: 'html' },
  recommendation: 'Gate it on ad_storage, ad_user_data and ad_personalization.',
  autoFixable: false,
});

// ── THE invariant ───────────────────────────────────────────────────────────────
{
  const f = finding();
  const out = annotateFindings([f], [mem('the Meta Pixel Purchase tag is ungated on purpose, we do not operate in the EU')]);
  check('annotation attaches a note', !!out[0].userNote);
  check('severity is untouched', out[0].severity === 'critical');
  check('confidence is untouched', out[0].confidence === 'certain');
  check('the message is untouched', out[0].message === f.message);
  check('the recommendation is untouched', out[0].recommendation === f.recommendation);
  check('the checkId and resource are untouched', out[0].checkId === f.checkId && out[0].resource?.id === '12');
  check('ONLY userNote is added, nothing else changes', (() => {
    const { userNote, ...rest } = out[0] as Record<string, unknown> & { userNote?: unknown };
    return !!userNote && JSON.stringify(rest) === JSON.stringify(f);
  })());
  check('the input finding is not mutated', (f as Record<string, unknown>).userNote === undefined);
}
check('the finding COUNT never changes, however many notes match', (() => {
  const fs = [finding(), finding({ category: 'paused', message: 'Tag is paused.' }), finding({ category: 'naming' })];
  const out = annotateFindings(fs, [mem('everything about consent and paused tags is intentional')]);
  return out.length === 3;
})());
check('order is preserved', (() => {
  const fs = [finding({ message: 'a' }), finding({ message: 'b' }), finding({ message: 'c' })];
  return annotateFindings(fs, [mem('unrelated')]).map((x) => x.message).join() === 'a,b,c';
})());
check('no notes leaves every finding intact', (() => {
  const fs = [finding()];
  const out = annotateFindings(fs, []);
  return out.length === 1 && !out[0].userNote && out[0].severity === 'critical';
})());

// ── Matching: by resource name ──────────────────────────────────────────────────
check('a note naming the resource attaches', annotationFor(finding(), [mem('Meta Pixel Purchase is deliberate')])?.basis === 'named');
check('a note naming a DIFFERENT resource does not', annotationFor(
  finding(), [mem('the LinkedIn Insight tag is deliberate')]) === undefined);
check('a partial name is not enough (every distinctive word must appear)', annotationFor(
  finding(), [mem('purchase is fine')]) === undefined);
check('generic words alone never match a resource', annotationFor(
  finding({ resource: { kind: 'tag', id: '1', name: 'Form Tag' } , category: 'other' }), [mem('tags are fine')]) === undefined);
check('resource matching ignores case and punctuation', !!annotationFor(finding(), [mem('“meta pixel purchase” was signed off')]));

// ── Matching: by topic ──────────────────────────────────────────────────────────
check('a consent note attaches to a consent finding as a topic match',
  annotationFor(finding(), [mem('our CMP blocks everything before consent, checked in June')])?.basis === 'topic');
check('a paused note attaches to a paused finding',
  annotationFor(finding({ category: 'paused', resource: { kind: 'tag', id: '9', name: 'Old Tag' } }), [mem('those paused tags are kept on purpose')])?.basis === 'topic');
check('an unrelated topic does not attach',
  annotationFor(finding({ category: 'naming' }), [mem('our CMP blocks everything before consent')]) === undefined);

// ── Which note wins ─────────────────────────────────────────────────────────────
check('a resource-named note beats a topic note', (() => {
  const a = annotationFor(finding(), [
    mem('consent is handled globally', { id: 'topic' }),
    mem('Meta Pixel Purchase is intentional', { id: 'named' }),
  ]);
  return a?.memoryId === 'named' && a.basis === 'named';
})());
check('among equals, the most recently updated wins (that is what they last believed)', (() => {
  const a = annotationFor(finding(), [
    mem('Meta Pixel Purchase was a mistake', { id: 'old', updatedAt: 10 }),
    mem('Meta Pixel Purchase is intentional now', { id: 'new', updatedAt: 20 }),
  ]);
  return a?.memoryId === 'new';
})());
check('a muted note is ignored', annotationFor(finding(), [mem('Meta Pixel Purchase is intentional', { enabled: false })]) === undefined);
check('an empty note is ignored', annotationFor(finding(), [mem('   ')]) === undefined);

// ── Acknowledgement, and the honesty it must carry ─────────────────────────────
for (const phrase of ['on purpose', 'intentional', 'by design', 'deliberately', 'we know', 'signed off', 'accepted']) {
  check(`"${phrase}" reads as a deliberate decision`,
    annotationFor(finding(), [mem(`Meta Pixel Purchase is ${phrase} for now`)])?.acknowledged === true);
}
check('a plain observation is NOT an acknowledgement',
  annotationFor(finding(), [mem('Meta Pixel Purchase fires on the thank-you page')])?.acknowledged === false);
check('an acknowledged note STILL says the finding stands at full severity',
  /still reported at full severity/i.test(annotationLabel({ text: 'x', basis: 'named', acknowledged: true })));
check('the label never implies the finding was dismissed',
  !/dismiss|ignore|resolved|closed/i.test(annotationLabel({ text: 'x', basis: 'named', acknowledged: true })));
check('a non-acknowledged note is introduced as context', /your note/i.test(annotationLabel({ text: 'x', basis: 'topic', acknowledged: false })));
check('no em dashes in operator-facing labels (house style)',
  !/[—–]/.test(annotationLabel({ text: 'x', basis: 'named', acknowledged: true }) + annotationLabel({ text: 'x', basis: 'topic', acknowledged: false })));

console.log(`\naudit-annotations: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
