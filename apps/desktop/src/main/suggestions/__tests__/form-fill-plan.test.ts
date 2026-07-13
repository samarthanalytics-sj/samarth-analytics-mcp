// Pure tests for the raw-forms → fill-plan bridge (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/form-fill-plan.test.ts

import { toFormFillViews, localeOptions, matchFiredContainerTags, classifyFiredContainerTags } from '../form-fill-plan';
import type { RawForm, RawFormField } from '../../../../../web-audit-mcp/src/agent/forms.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const field = (o: Partial<RawFormField>): RawFormField =>
  ({ tag: 'input', type: 'text', name: '', id: '', label: '', placeholder: '', autocomplete: '', required: false, ...o });
const form = (o: Partial<RawForm>): RawForm => {
  const fields = o.fields ?? [];
  return { index: 0, action: '', method: 'post', formId: '', formName: '', formClasses: '', title: '', fieldCount: fields.length, fields, hasPrivacyLink: false, text: '', ...o };
};

// ── a contact form: names + email + category select + textarea + a hidden field ──────────────────
{
  const f = form({
    index: 0, title: 'Get In Touch', action: 'https://site.com/submit', method: 'post',
    fields: [
      field({ type: 'email', name: 'email', label: 'Email', required: true }),
      field({ label: 'First Name', name: 'fname', required: true }),
      field({ label: 'Last Name', name: 'lname' }),
      field({ tag: 'select', type: 'select-one', name: 'topic', label: 'Topic', options: ['Please select', 'Sales', 'Support'] }),
      field({ tag: 'textarea', type: 'textarea', name: 'message', label: 'Message' }),
      field({ type: 'hidden', name: 'csrf' }),
    ],
  });
  const views = toFormFillViews([f], 'https://site.com/contact', 'us', 'run9');
  check('one form in → one form out', views.length === 1);
  const v = views[0];
  const byName = (n: string): (typeof v.fields)[number] | undefined => v.fields.find((x) => x.name === n);
  check('title carried through', v.title === 'Get In Touch');
  check('purpose classified (contact)', v.purpose === 'contact');
  check('hidden field excluded from the plan', !v.fields.some((x) => x.name === 'csrf'));
  check('email filled with the test address (+tag when supplied)', byName('email')?.value === 'test+run9@gmail.com');
  check('first/last names are simple Test values', byName('fname')?.value === 'Test' && byName('lname')?.value === 'Test');
  check('category select picks first real option + carries options', byName('topic')?.value === 'Sales' && (byName('topic')?.options ?? []).includes('Support'));
  check('required flags carried', byName('email')?.required === true && byName('lname')?.required === false);
  check('selector is name-based', byName('email')?.selector === '[name="email"]');
  check('message got the disclaimer text', /test submission/i.test(byName('message')?.value ?? ''));
}

// ── a form with NO fillable fields (only a hidden control) is dropped ─────────────────────────────
{
  const empty = form({ index: 1, fields: [field({ type: 'hidden', name: 'x' })] });
  check('form with no fillable fields → dropped', toFormFillViews([empty], 'https://site.com', 'us', 't').length === 0);
}

// ── title falls back to formId when there's no heading ───────────────────────────────────────────
{
  const noTitle = form({ index: 2, formId: 'mc-embed', fields: [field({ type: 'email', name: 'EMAIL' })] });
  check('title falls back to formId', toFormFillViews([noTitle], 'https://site.com', 'us', 't')[0].title === 'mc-embed');
}

// ── locale picker + unknown-locale fallback ──────────────────────────────────────────────────────
check('localeOptions includes US', localeOptions().some((l) => l.id === 'us'));
{
  const f = form({ index: 0, fields: [field({ type: 'email', name: 'email' })] });
  check('unknown locale id falls back (still fills)', toFormFillViews([f], 'https://site.com', 'zz', 't')[0].fields[0].value.includes('@gmail.com'));
}

// ── Phase 2b: pair fired GA4 events → the container's actual tags (by event name) ────────────────
{
  const tags = [
    { tagName: 'GA4 - Event - Get In Touch Form Tag', eventName: 'get_in_touch_form', platform: 'ga4_event' },
    { tagName: 'GA4 - Event - Contact us Form Tag', eventName: 'contact_us_form', platform: 'ga4_event' },
    { tagName: 'GA4 - Event - CTA Click Tag', eventName: 'cta_click', platform: 'ga4_event' },
  ];
  const matched = matchFiredContainerTags(['get_in_touch_form', 'form_submission'], [], tags);
  check('pairing: GA4 tag matches by event name', matched.length === 1 && matched[0].tagName.includes('Get In Touch'));
  check('pairing: is case-insensitive', matchFiredContainerTags(['GET_IN_TOUCH_FORM'], [], tags).length === 1);
  check('pairing: no match → empty', matchFiredContainerTags(['newsletter_signup'], [], tags).length === 0);
  check('pairing: empty events + no beacons → empty', matchFiredContainerTags([], [], tags).length === 0);
  check('pairing: GA4 tag with no event name → not matched', matchFiredContainerTags(['x'], [], [{ tagName: 'Blank', eventName: '', platform: 'ga4_event' }]).length === 0);
}
{
  // Two GA4 tags share one event name → both named (dedup is by tagName, not event name).
  const tags = [
    { tagName: 'Tag A', eventName: 'generate_lead', platform: 'ga4_event' },
    { tagName: 'Tag B', eventName: 'generate_lead', platform: 'ga4_event' },
  ];
  check('pairing: two GA4 tags on one event → both named', matchFiredContainerTags(['generate_lead'], [], tags).length === 2);
}
{
  // PIXEL tags fire a BEACON, not a GA4 event → matched by the observed beacon vendor.
  const meta = { tagName: 'Meta - Event - Lead Form Tag', eventName: 'Lead', platform: 'meta_pixel' };
  const li = { tagName: 'LinkedIn - Lead Form Tag', eventName: 'Lead', platform: 'linkedin_insight' };
  const tags = [meta, li];
  check('pairing: Meta tag fires on a meta beacon (no GA4 event)', matchFiredContainerTags([], ['meta'], tags).some((m) => m.tagName.includes('Meta')));
  check('pairing: LinkedIn tag fires on its own beacon', matchFiredContainerTags([], ['linkedin'], tags).some((m) => m.tagName.includes('LinkedIn')));
  check('pairing: Meta tag does NOT fire on a LinkedIn-only beacon', !matchFiredContainerTags([], ['linkedin'], [meta]).length);
  check('pixel tag + no beacon → not matched', matchFiredContainerTags([], [], [meta]).length === 0);
}
// ── server-side (CAPI) pixel: no browser beacon but the form relayed to sGTM → serverRelay, not fail ──
// The real-world false negative: on a server-side setup a Meta form tag sends no facebook beacon; the
// form relays to the first-party sGTM (a 'server' beacon). That's expected, NOT a fired vendor beacon
// and NOT a failure — it belongs in serverRelayTags so the UI shows "server-side", not ❌ NOT FIRED.
{
  const meta = { tagName: 'Meta - Event - Contact Us Form Tag', eventName: 'Lead', platform: 'meta_pixel' };
  const ga4 = { tagName: 'GA4 - Event - Contact Us Form Tag', eventName: 'contact_us_form', platform: 'ga4_event' };
  const r = classifyFiredContainerTags(['contact_us_form'], ['server'], [ga4, meta]);
  check('serverRelay: GA4 tag still fires by event name', r.firedTags.some((t) => t.tagName.includes('GA4')));
  check('serverRelay: Meta pixel with only a server relay → serverRelayTags (not fired)', r.serverRelayTags.includes(meta.tagName) && !r.firedTags.some((t) => t.tagName.includes('Meta')));
  // A real facebook beacon alongside the relay still counts as fired, not server-relayed.
  const r2 = classifyFiredContainerTags([], ['server', 'meta'], [meta]);
  check('serverRelay: real meta beacon wins → fired, not serverRelay', r2.firedTags.some((t) => t.tagName.includes('Meta')) && r2.serverRelayTags.length === 0);
  // No relay at all → a pixel with no beacon stays a genuine miss (no server-side excuse).
  const r3 = classifyFiredContainerTags([], [], [meta]);
  check('serverRelay: no beacon + no relay → neither fired nor serverRelay', r3.firedTags.length === 0 && r3.serverRelayTags.length === 0);
}

console.log(`\nform-fill-plan: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 22) { console.error(`expected >= 22 checks, got ${passed}`); process.exit(1); }
