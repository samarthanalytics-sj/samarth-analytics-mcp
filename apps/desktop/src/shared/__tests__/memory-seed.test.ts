// Pure tests for the Phase 3 auto-seed engine (durable facts derived from a GTM container snapshot). Run:
// tsx src/shared/__tests__/memory-seed.test.ts
import { seedMemoriesFromContainer, attachSupersessions, type SeedTag } from '../memory-seed';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tag = (over: Partial<SeedTag> = {}): SeedTag => ({ name: 't', type: 'gaawe', paused: false, parameter: [], ...over });
const p = (key: string, value: string): Record<string, unknown> => ({ type: 'template', key, value });
const texts = (tags: SeedTag[]): string[] => seedMemoriesFromContainer({ tags }).map((c) => c.text);
const joined = (tags: SeedTag[]): string => texts(tags).join(' | ');

// ── Measurement / tag IDs ────────────────────────────────────────────────────────
check('ids: extracts concrete G- / AW- ids, ignores {{variables}}', (() => {
  const out = joined([
    tag({ type: 'gaawc', parameter: [p('measurementId', 'G-ABC123')] }),
    tag({ type: 'awct', parameter: [p('conversionId', 'x'), p('tagId', 'AW-99887')] }),
    tag({ type: 'gaawe', parameter: [p('measurementId', '{{GA4 Variable}}')] }),
  ]);
  return out.includes('G-ABC123') && out.includes('AW-99887') && !out.includes('{{GA4 Variable}}');
})());
check('ids: no id fact when none are concrete', !joined([tag({ parameter: [p('measurementId', '{{Var}}')] })]).includes('Measurement/tag IDs'));

// ── Vendor platforms ─────────────────────────────────────────────────────────────
check('vendors: detects by type code and by name hint', (() => {
  const out = joined([
    tag({ type: 'awct', name: 'Ads Conversion' }),
    tag({ type: 'cvt_1', name: 'Meta - Event - Purchase Tag' }),
    tag({ type: 'cvt_2', name: 'TikTok Pixel' }),
  ]);
  return out.includes('Google Ads') && out.includes('Meta (Facebook)') && out.includes('TikTok');
})());
check('vendors: GA4/Google-tag are NOT listed as vendors (covered by the IDs fact)', (() => {
  const out = joined([tag({ type: 'gaawc', name: 'GA4 Config', parameter: [p('measurementId', 'G-X1')] })]);
  return !out.includes('platforms set up');
})());
check('vendors: a Custom HTML "SEO Meta Tags" injector is NOT Meta (Facebook)', (() => {
  const out = joined([tag({ type: 'html', name: 'SEO Meta Tags' }), tag({ type: 'html', name: 'Meta Description Injector' })]);
  return !out.includes('Meta (Facebook)');
})());
check('vendors: real Meta pixel names still count (Meta Pixel / fbevents / Facebook)', (() => {
  const out = joined([tag({ type: 'html', name: 'Meta Pixel - Base' })]);
  return out.includes('Meta (Facebook)');
})());

// ── Paused tags are ignored ──────────────────────────────────────────────────────
check('paused: a paused vendor tag is not counted as "in use"', !joined([tag({ type: 'cvt_1', name: 'Meta Pixel', paused: true })]).includes('Meta'));

// ── Server-side relay ────────────────────────────────────────────────────────────
check('sgtm: detects server_container_url and captures the URL', (() => {
  const out = joined([
    tag({
      type: 'googtag',
      name: 'Google Tag',
      parameter: [
        { type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [p('parameter', 'server_container_url'), p('parameterValue', 'https://sgtm.example.com')] }] },
      ],
    }),
  ]);
  return out.includes('Web-to-server (sGTM) relay is configured') && out.includes('https://sgtm.example.com');
})());
check('sgtm: absent when no server_container_url', !joined([tag({ type: 'googtag', parameter: [p('tagId', 'GT-ABC')] })]).includes('sGTM'));
check('sgtm: a Custom HTML tag mentioning the string + an unrelated URL is IGNORED (type gate + structural read)', (() => {
  const out = joined([
    tag({ type: 'html', name: 'Pixel', parameter: [p('html', '<!-- set server_container_url in GTM --> <img src="https://tracker.example.com/px">')] }),
  ]);
  return !out.includes('sGTM');
})());
check('sgtm: a {{variable}} value notes the relay WITHOUT asserting a wrong URL', (() => {
  const out = joined([
    tag({
      type: 'googtag',
      parameter: [{ type: 'list', key: 'configSettingsTable', list: [{ type: 'map', map: [p('parameter', 'server_container_url'), p('parameterValue', '{{sGTM URL}}')] }] }],
    }),
  ]);
  return out.includes('set via a variable') && !out.includes('{{sGTM URL}}') && !out.includes('https://');
})());

// ── Consent Mode ─────────────────────────────────────────────────────────────────
check('consent: noted when a tag is consent-GATED (needed)', joined([tag({ consentSettings: { consentStatus: 'needed' } })]).includes('Consent Mode is in use'));
check('consent: case-insensitive (export-JSON "NEEDED")', joined([tag({ consentSettings: { consentStatus: 'NEEDED' } })]).includes('Consent Mode is in use'));
check('consent: the API default "notSet" (ungated) does NOT claim consent', !joined([tag({ consentSettings: { consentStatus: 'notSet' } })]).includes('Consent Mode'));
check('consent: "notNeeded" (declared-no-consent) does NOT claim consent', !joined([tag({ consentSettings: { consentStatus: 'notNeeded' } })]).includes('Consent Mode'));
check('consent: absent when no tag declares any', !joined([tag({ consentSettings: null })]).includes('Consent Mode'));

// ── Ecommerce funnel ─────────────────────────────────────────────────────────────
check('ecommerce: lists only real funnel events, in funnel order', (() => {
  const out = joined([
    tag({ type: 'gaawe', parameter: [p('eventName', 'purchase')] }),
    tag({ type: 'gaawe', parameter: [p('eventName', 'add_to_cart')] }),
    tag({ type: 'gaawe', parameter: [p('eventName', 'newsletter_signup')] }),
  ]);
  return out.includes('add_to_cart, purchase') && !out.includes('newsletter_signup');
})());

// ── Naming convention ────────────────────────────────────────────────────────────
check('naming: recorded when >= 3 GA4 event tags follow it (and a clear majority)', (() => {
  const t = (n: string): SeedTag => tag({ type: 'gaawe', name: n });
  const out = joined([t('GA4 - Event - Phone Click Tag'), t('GA4 - Event - Email Click Tag'), t('GA4 - Event - Form Tag'), t('legacy tag')]);
  return out.includes('GA4 - Event - <Name>');
})());
check('naming: NOT recorded when the convention is not established', (() => {
  const t = (n: string): SeedTag => tag({ type: 'gaawe', name: n });
  return !joined([t('GA4 - Event - A Tag'), t('random one'), t('another'), t('yet another')]).includes('naming');
})());
check('naming: prefix-only names WITHOUT the "Tag" suffix do not over-claim the full shape', (() => {
  const t = (n: string): SeedTag => tag({ type: 'gaawe', name: n });
  return !joined([t('GA4 - Event - Phone Click'), t('GA4 - Event - Email Click'), t('GA4 - Event - Form Submit')]).includes('GA4 - Event - <Name> Tag');
})());

// ── attachSupersessions (re-seed replaces stale list facts, never piles duplicates) ──
check('supersede: a changed IDs list points at the stale auto note', (() => {
  const [c] = attachSupersessions(
    [{ kind: 'fact', text: 'Measurement/tag IDs configured in this container: G-A1, G-B2.' }],
    [{ id: 'old1', text: 'Measurement/tag IDs configured in this container: G-A1.' }],
  );
  return c.supersedesId === 'old1';
})());
check('supersede: an identical text is NOT a supersession (dedupe handles it upstream)', (() => {
  const [c] = attachSupersessions(
    [{ kind: 'fact', text: 'Ecommerce events tracked in this container: purchase.' }],
    [{ id: 'old2', text: 'Ecommerce events tracked in this container: purchase.' }],
  );
  return c.supersedesId === undefined;
})());
check('supersede: non-list facts and unrelated notes are untouched', (() => {
  const out = attachSupersessions(
    [{ kind: 'fact', text: 'Consent Mode is in use: some tags declare consent settings (consent-gated).' }],
    [{ id: 'x', text: 'purchase fires on order_completed' }],
  );
  return out[0].supersedesId === undefined;
})());

// ── Hygiene: durable only + deterministic ────────────────────────────────────────
check('empty container → no candidates', seedMemoriesFromContainer({ tags: [] }).length === 0);
check('never emits churny counts (no "N tags/triggers/variables")', (() => {
  const out = joined([tag({ type: 'gaawc', parameter: [p('measurementId', 'G-A1')] }), tag({ type: 'cvt_1', name: 'Meta Pixel' })]);
  return !/\b\d+\s+(tags|triggers|variables)\b/.test(out);
})());
check('deterministic: same snapshot → identical output', (() => {
  const tags = [tag({ type: 'gaawc', parameter: [p('measurementId', 'G-A1')] }), tag({ type: 'cvt_1', name: 'Meta Pixel' })];
  return JSON.stringify(seedMemoriesFromContainer({ tags })) === JSON.stringify(seedMemoriesFromContainer({ tags }));
})());
check('all candidates carry a valid kind', seedMemoriesFromContainer({
  tags: [tag({ type: 'gaawc', parameter: [p('measurementId', 'G-A1')] })],
}).every((c) => c.kind === 'fact' || c.kind === 'preference'));

console.log(`\nmemory-seed: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
