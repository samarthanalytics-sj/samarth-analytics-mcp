// Does the selected Google Ads account match the GTM container the tag is about to be written into?
// Run: tsx src/main/google/__tests__/ads-pairing.test.ts

import { canonicalAdsId, extractContainerAdsIds, checkPairing } from '../ads-pairing';
import type { ContainerSnapshot, AuditTag } from '../gtm-builders';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else failures.push(`✗ ${name}${detail ? ': ' + detail : ''}`);
}

const tag = (over: Partial<AuditTag>): AuditTag => ({
  tagId: '1', name: 'T', type: 'awct', firingTriggerId: [], paused: false, parameter: [], ...over,
});
const snap = (tags: AuditTag[]): ContainerSnapshot => ({ tags, triggers: [], variables: [] });
const p = (key: string, value: unknown): Record<string, unknown> => ({ type: 'template', key, value });

// ── canonicalAdsId ───────────────────────────────────────────────────────────
check('canonical: AW- prefixed passes through', canonicalAdsId('AW-123456789') === 'AW-123456789');
check('canonical: bare numeric is canonicalized to AW-', canonicalAdsId('123456789') === 'AW-123456789');
check('canonical: lowercase aw- is accepted', canonicalAdsId('aw-123456789') === 'AW-123456789');
check('canonical: whitespace trimmed', canonicalAdsId('  AW-123456789  ') === 'AW-123456789');
// A {{variable}} proves nothing about WHICH account. Accepting it would make a container full of
// placeholders "match" every account the user could pick, which is worse than no signal at all.
check('canonical: a {{variable}} is REJECTED (proves nothing about which account)', canonicalAdsId('{{Google Ads Conversion ID}}') === null);
check('canonical: a GT- Google tag id is not a conversion id', canonicalAdsId('GT-ABCD123') === null);
check('canonical: a G- measurement id is not a conversion id', canonicalAdsId('G-ABC1234567') === null);
check('canonical: empty / null / undefined are null', canonicalAdsId('') === null && canonicalAdsId(null) === null && canonicalAdsId(undefined) === null);
check('canonical: too short to be a conversion id', canonicalAdsId('12345') === null);
check('canonical: a combined id/label string is not an id on its own', canonicalAdsId('AW-123456789/AbCdEf') === null);

// ── extractContainerAdsIds ───────────────────────────────────────────────────
check('extract: an empty container yields nothing', extractContainerAdsIds(snap([])).length === 0);

const oneAwct = snap([tag({ name: 'Ads - Contact', type: 'awct', parameter: [p('conversionId', '123456789'), p('conversionLabel', 'AbC')] })]);
const e1 = extractContainerAdsIds(oneAwct);
check('extract: an awct tag yields its canonical id and tag name', e1.length === 1 && e1[0].conversionId === 'AW-123456789' && e1[0].tagNames[0] === 'Ads - Contact');

const twoTagsOneId = snap([
  tag({ tagId: '1', name: 'Ads - Contact', type: 'awct', parameter: [p('conversionId', '123456789')] }),
  tag({ tagId: '2', name: 'Ads - Remarketing', type: 'sp', parameter: [p('conversionId', 'AW-123456789')] }),
]);
const e2 = extractContainerAdsIds(twoTagsOneId);
check('extract: two tags sharing an id collapse to ONE entry listing both', e2.length === 1 && e2[0].tagNames.length === 2);
check('extract: awct bare numeric and sp AW- prefixed normalize to the same id', e2[0].conversionId === 'AW-123456789');

const twoIds = snap([
  tag({ tagId: '1', name: 'A', type: 'awct', parameter: [p('conversionId', '111111111')] }),
  tag({ tagId: '2', name: 'B', type: 'awct', parameter: [p('conversionId', '222222222')] }),
]);
check('extract: two distinct ids yield two entries, sorted', (() => { const r = extractContainerAdsIds(twoIds); return r.length === 2 && r[0].conversionId === 'AW-111111111'; })());

// A paused Ads tag is still evidence of which account this container serves.
const pausedOnly = snap([tag({ name: 'Paused Ads', type: 'awct', paused: true, parameter: [p('conversionId', '123456789')] })]);
check('extract: a PAUSED Ads tag still counts as evidence', extractContainerAdsIds(pausedOnly).length === 1);

check('extract: a GA4 event tag is ignored', extractContainerAdsIds(snap([tag({ type: 'gaawe', parameter: [p('measurementId', 'G-ABC1234567')] })])).length === 0);
check('extract: a googtag carrying an AW- id counts', extractContainerAdsIds(snap([tag({ type: 'googtag', name: 'GT', parameter: [p('tagId', 'AW-999999999')] })]))[0]?.conversionId === 'AW-999999999');
check('extract: a googtag carrying a GT- id does NOT count', extractContainerAdsIds(snap([tag({ type: 'googtag', parameter: [p('tagId', 'GT-ABCD123')] })])).length === 0);
check('extract: the server-side ads tag counts', extractContainerAdsIds(snap([tag({ type: 'sgtmadsct', name: 'S', parameter: [p('conversionId', '123456789')] })])).length === 1);
check('extract: a placeholder-only container yields NOTHING (never a false match)', extractContainerAdsIds(snap([tag({ type: 'awct', parameter: [p('conversionId', '{{Google Ads Conversion ID}}')] })])).length === 0);
check('extract: tags with no parameter array do not throw', extractContainerAdsIds(snap([{ tagId: '9', name: 'X', type: 'awct', firingTriggerId: [], paused: false } as unknown as AuditTag])).length === 0);

// ── checkPairing ─────────────────────────────────────────────────────────────
check('pairing: a matching id is a match', checkPairing(oneAwct, 'AW-123456789').verdict === 'match');
check('pairing: the match message names the id', checkPairing(oneAwct, 'AW-123456789').message.includes('AW-123456789'));
check('pairing: the account name is included when supplied', checkPairing(oneAwct, 'AW-123456789', 'Acme Ltd').message.includes('Acme Ltd'));
check('pairing: a bare numeric selection still matches an AW- container id', checkPairing(oneAwct, '123456789').verdict === 'match');

const mism = checkPairing(oneAwct, 'AW-987654321', 'Other Client');
check('pairing: a different id is a mismatch', mism.verdict === 'mismatch');
check('pairing: the mismatch names BOTH ids so the user can tell them apart', mism.message.includes('AW-123456789') && mism.message.includes('AW-987654321'));
// Adding a second Ads account to one container is legitimate, so this must caution, not forbid.
check('pairing: the mismatch is worded as a caution, not an error', /fine if you are deliberately/i.test(mism.message));
check('pairing: mismatch still returns the container ids for the UI to list', mism.containerIds.length === 1);

check('pairing: a container with no Ads tags is no-ads-tags, not a mismatch', checkPairing(snap([]), 'AW-123456789').verdict === 'no-ads-tags');
check('pairing: no selection yields unknown with no message', (() => { const r = checkPairing(oneAwct, null); return r.verdict === 'unknown' && r.message === ''; })());
check('pairing: a placeholder selection yields unknown (never a false verdict)', checkPairing(oneAwct, '{{Google Ads Conversion ID}}').verdict === 'unknown');
check('pairing: selecting an id present among SEVERAL container ids is a match', checkPairing(twoIds, 'AW-222222222').verdict === 'match');

// Repo rule: no em dashes at any user-facing boundary.
const messages = [checkPairing(oneAwct, 'AW-123456789').message, mism.message, checkPairing(snap([]), 'AW-1234567').message];
check('pairing: no em dashes in any message', messages.every((m) => !/[—–]/.test(m)));

if (passed < 30) { console.error(`✗ only ${passed} assertions ran (expected 30+)`); process.exit(1); }
console.log(`\nads-pairing: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
