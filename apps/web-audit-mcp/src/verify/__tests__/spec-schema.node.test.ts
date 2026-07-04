/** Spec schema + hash tests. Run: tsx apps/web-audit-mcp/src/verify/__tests__/spec-schema.node.test.ts */

import { validateSpec, specHash, SpecValidationError } from '../spec-schema.js';
import { harness } from './_helpers.js';

const { check, done } = harness('spec-schema');

function rejects(label: string, input: unknown): void {
  let threw = false;
  try {
    validateSpec(input);
  } catch (err) {
    threw = err instanceof SpecValidationError;
  }
  check(label, threw);
}

const good = {
  url: 'https://example.com',
  measurementIds: ['G-XXXX'],
  expectedTrackers: ['ga4', 'clarity'],
  consent: { acceptSelector: '#ok', checkPreConsent: true },
  checks: [
    { id: 'pv', type: 'event_fired', tracker: 'ga4', event: 'page_view', phase: 'post_consent', params: { 'ep.page_type': 'home' } },
    { id: 'cta', type: 'event_on_interaction', event: 'cta_click', action: { click: '#hero-cta' } },
    { id: 'clr', type: 'tracker_present', tracker: 'clarity' },
    { id: 'ln', type: 'cross_domain_linker', expectedDomains: ['shop.example.com'] },
  ],
};

check('valid spec parses', validateSpec(good).checks.length === 4);
check('valid: normalized url kept', validateSpec(good).url === 'https://example.com');

rejects('reject: missing url', { checks: [{ id: 'a', type: 'event_fired', event: 'x' }] });
rejects('reject: bad url', { url: 'not-a-url', checks: [{ id: 'a', type: 'event_fired', event: 'x' }] });
rejects('reject: empty checks', { url: 'https://e.com', checks: [] });
rejects('reject: event_fired without event', { url: 'https://e.com', checks: [{ id: 'a', type: 'event_fired' }] });
rejects('reject: param_validation without params', { url: 'https://e.com', checks: [{ id: 'a', type: 'param_validation', event: 'x' }] });
rejects('reject: event_on_interaction without action', { url: 'https://e.com', checks: [{ id: 'a', type: 'event_on_interaction', event: 'x' }] });
rejects('reject: tracker_present without tracker', { url: 'https://e.com', checks: [{ id: 'a', type: 'tracker_present' }] });
rejects('reject: linker without domains', { url: 'https://e.com', checks: [{ id: 'a', type: 'cross_domain_linker' }] });
rejects('reject: unknown top-level key', { url: 'https://e.com', bogus: 1, checks: [{ id: 'a', type: 'event_fired', event: 'x' }] });
rejects('reject: unknown check type', { url: 'https://e.com', checks: [{ id: 'a', type: 'made_up', event: 'x' }] });
rejects('reject: duplicate check id', {
  url: 'https://e.com',
  checks: [{ id: 'dup', type: 'event_fired', event: 'x' }, { id: 'dup', type: 'event_fired', event: 'y' }],
});

// ── specHash determinism ──────────────────────────────────────────────────────
const a = { url: 'https://e.com', checks: [{ id: 'x', type: 'event_fired', event: 'page_view' }], measurementIds: ['G-1'] };
const b = { measurementIds: ['G-1'], checks: [{ event: 'page_view', type: 'event_fired', id: 'x' }], url: 'https://e.com' };
check('specHash: key-order independent', specHash(a) === specHash(b));
check('specHash: value change → different hash', specHash(a) !== specHash({ ...a, url: 'https://other.com' }));
check('specHash: sha256 length', specHash(a).length === 64);
// An explicit undefined optional field must hash identically to omitting it
// (both validate to the same VerifySpec).
check(
  'specHash: explicit undefined optional === omitted',
  specHash({ url: 'https://e.com', measurementIds: undefined, checks: a.checks }) ===
    specHash({ url: 'https://e.com', checks: a.checks }),
);

done(17);
