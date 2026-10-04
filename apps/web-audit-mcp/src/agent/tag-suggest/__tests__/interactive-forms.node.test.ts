/**
 * Interactive form discovery — pure helper tests (no browser).
 * Run: tsx apps/web-audit-mcp/src/agent/tag-suggest/__tests__/interactive-forms.node.test.ts
 */
import { formSignature, MAX_INTERACTIVE_CLICKS, ctaRank, selectCtas, type CtaFacts } from '../interactive-forms.js';
import type { FormAnalysis } from '../../forms.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const form = (over: Partial<FormAnalysis> = {}): FormAnalysis => ({
  index: 0, action: '', method: 'js', formId: '', formClasses: '', title: 'Start your free trial',
  purpose: 'contact', fieldCount: 2,
  fields: [{ type: 'email', name: 'email', label: '', required: true }, { type: 'text', name: 'name', label: '', required: false }],
  piiFields: [], marketingCheckboxes: [], hasConsentCheckbox: false, hasPrivacyLink: false, issues: [],
  ...over,
});

// Same shape → same signature (so a revealed form already in the baseline is deduped, not re-added).
check('formSignature: identical forms share a signature', formSignature(form()) === formSignature(form()));
// Field ORDER must not matter (a re-scan can return fields in a different order).
check('formSignature: field order does not change the signature',
  formSignature(form()) === formSignature(form({ fields: [
    { type: 'text', name: 'name', label: '', required: false }, { type: 'email', name: 'email', label: '', required: true },
  ] })));
// Different purpose / field set → different signature (a genuinely new modal form is kept).
check('formSignature: a different purpose is distinct', formSignature(form()) !== formSignature(form({ purpose: 'newsletter' })));
check('formSignature: a different field set is distinct', formSignature(form()) !== formSignature(form({ fieldCount: 1, fields: [{ type: 'email', name: 'email', label: '', required: true }] })));
check('formSignature: a different title is distinct', formSignature(form()) !== formSignature(form({ title: 'Book a demo' })));
// The click cap is a small, positive bound.
check('MAX_INTERACTIVE_CLICKS is a small positive cap', Number.isInteger(MAX_INTERACTIVE_CLICKS) && MAX_INTERACTIVE_CLICKS > 0 && MAX_INTERACTIVE_CLICKS <= 12, String(MAX_INTERACTIVE_CLICKS));

// ── which controls may be clicked (ctaRank / selectCtas) ─────────────────────────────────────────────
// The page only REPORTS facts; these pure rules decide. A wrong "yes" here is a click on a live site.
const cta = (over: Partial<CtaFacts> = {}): CtaFacts => ({
  tag: 'BUTTON', role: '', type: '', href: null, label: '', attrs: {},
  inForm: false, nearFields: false, inNav: false, inCmp: false, ...over,
});

// A modal opener that should be clicked.
check('ctaRank: a standalone "Book a demo" dialog opener is a candidate',
  ctaRank(cta({ label: 'Book a demo', attrs: { 'aria-haspopup': 'dialog' } })) === 0);
check('ctaRank: an intent label alone is enough on a <button>', ctaRank(cta({ label: 'Start free trial' })) === 0);

// N19: a JS/div form's own submit control (no <form>, no type) must never be clicked.
check('ctaRank: <div><input type=email><button>Subscribe</button></div> is NOT a candidate (div-form submit)',
  ctaRank(cta({ label: 'Subscribe', nearFields: true })) === null);
check('ctaRank: a "Request a callback" control beside formless fields is NOT a candidate',
  ctaRank(cta({ label: 'Request a callback', nearFields: true, attrs: { 'data-toggle': 'modal' } })) === null);
check('ctaRank: a control inside a <form> is NOT a candidate', ctaRank(cta({ label: 'Book a demo', inForm: true })) === null);
check('ctaRank: <button form="f">Request a quote</button> (form-owned, outside it) is NOT a candidate',
  ctaRank(cta({ label: 'Request a quote', inForm: true })) === null);
check('ctaRank: type=submit / reset / image are never candidates',
  ['submit', 'reset', 'image'].every((type) => ctaRank(cta({ label: 'Get started', type })) === null));

// N24: purchase / cart / destructive / account controls are never clicked, even when they declare a modal.
check('ctaRank: <button aria-controls="cart-drawer">Add to cart</button> is NOT a candidate',
  ctaRank(cta({ label: 'Add to cart', attrs: { 'aria-controls': 'cart-drawer' } })) === null);
check('ctaRank: a data-toggle=modal "Buy now" is NOT a candidate',
  ctaRank(cta({ label: 'Buy now', attrs: { 'data-toggle': 'modal' } })) === null);
check('ctaRank: checkout / pay / delete / log out / apply coupon are never candidates',
  ['Checkout', 'Pay now', 'Delete account', 'Log out', 'Apply coupon', 'Cancel subscription', 'Submit']
    .every((label) => ctaRank(cta({ label, attrs: { 'aria-haspopup': 'dialog' } })) === null));
check('ctaRank: a modal attribute no longer stands in for intent (bare aria-controls, no label)',
  ctaRank(cta({ label: 'FAQ', attrs: { 'aria-controls': 'faq1' } })) === null);

// N22: navigation, tabs, accordions and menu toggles are not form openers.
check('ctaRank: a nav aria-haspopup "Products" toggle is NOT a candidate',
  ctaRank(cta({ label: 'Products', inNav: true, attrs: { 'aria-haspopup': 'true', 'aria-controls': 'm1' } })) === null);
check('ctaRank: a "Products" menu toggle outside nav is NOT a candidate either (aria-haspopup=true is a menu)',
  ctaRank(cta({ label: 'Products', attrs: { 'aria-haspopup': 'true', 'aria-controls': 'm1' } })) === null);
check('ctaRank: a collapse toggle with no intent label is NOT a candidate',
  ctaRank(cta({ label: 'What is included?', attrs: { 'data-bs-toggle': 'collapse', 'aria-controls': 'faq1' } })) === null);
check('ctaRank: a collapse toggle is NOT a candidate even when its text says "request a quote"',
  ctaRank(cta({ label: 'How do I request a quote?', attrs: { 'data-bs-toggle': 'collapse', 'aria-controls': 'faq2' } })) === null);
check('ctaRank: a tab (inside a tablist) is NOT a candidate', ctaRank(cta({ label: 'Contact', role: 'tab', inNav: true, attrs: { 'aria-controls': 'p2' } })) === null);
check('ctaRank: a consent-banner control is NOT a candidate', ctaRank(cta({ label: 'Customize', inCmp: true, attrs: { 'aria-haspopup': 'dialog' } })) === null);

// N20(a): a javascript: href that IS the action is never clicked; a no-op one (onclick opener) may be.
check('ctaRank: <a href="javascript:...submit()">Request a demo</a> is NOT a candidate',
  ctaRank(cta({ tag: 'A', href: "javascript:document.getElementById('demo').submit()", label: 'Request a demo' })) === null);
check('ctaRank: <a href="javascript:void(0)">Book a demo</a> (onclick opener) is a candidate',
  ctaRank(cta({ tag: 'A', href: 'javascript:void(0)', label: 'Book a demo' })) === 0);
check('ctaRank: <a href="#">Get started</a> is a candidate', ctaRank(cta({ tag: 'A', href: '#', label: 'Get started' })) === 0);
check('ctaRank: a real link with an intent label is NOT a candidate (its page is the crawler\'s)',
  ctaRank(cta({ tag: 'A', href: '/contact', label: 'Contact us' })) === null);
check('ctaRank: a real link that declares a modal is a candidate',
  ctaRank(cta({ tag: 'A', href: '/demo', label: 'Book a demo', attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': '#demo' } })) === 0);
check('ctaRank: an unlabelled data-bs-toggle=modal control ranks after intent labels',
  ctaRank(cta({ attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': '#m' } })) === 1);
check('ctaRank: a plain <div> without dialog markup is never a candidate', ctaRank(cta({ tag: 'DIV', label: 'Book a demo' })) === null);

// N22: ranking before the cap — six header toggles and icon buttons must not crowd out the CTA.
{
  const header: CtaFacts[] = ['Products', 'Solutions', 'Resources', 'Company', 'Pricing', 'Language'].map((label, i) =>
    cta({ label, inNav: true, attrs: { 'aria-haspopup': 'true', 'aria-controls': `m${i}` } }));
  const demo = cta({ label: 'Book a demo' });
  const picked = selectCtas([...header, demo]);
  check('selectCtas: nav toggles first in the document do not use up the budget before "Book a demo"',
    picked.length === 1 && picked[0] === header.length, JSON.stringify(picked));

  const iconOpeners: CtaFacts[] = Array.from({ length: 8 }, (_, i) => cta({ attrs: { 'data-bs-toggle': 'modal', 'data-bs-target': `#m${i}` } }));
  const order = selectCtas([...iconOpeners, demo]);
  check('selectCtas: "Book a demo" outranks unlabelled modal openers that come before it',
    order[0] === iconOpeners.length && order.length === MAX_INTERACTIVE_CLICKS, JSON.stringify(order));

  const sameTarget = selectCtas([cta({ attrs: { 'data-toggle': 'modal', 'data-target': '#x' } }), cta({ attrs: { 'data-toggle': 'modal', 'data-target': '#x' } })]);
  check('selectCtas: two unlabelled openers of the same dialog are clicked once (empty labels are deduped)', sameTarget.length === 1);
  const twice = selectCtas([cta({ label: 'Book a demo' }), cta({ label: '  Book  a demo ' })]);
  check('selectCtas: one click per distinct label', twice.length === 1);
  const many = selectCtas(Array.from({ length: 10 }, (_, i) => cta({ label: `Request quote ${i}` })));
  check('selectCtas: never more than MAX_INTERACTIVE_CLICKS', many.length === MAX_INTERACTIVE_CLICKS);
  const unsafe = selectCtas([cta({ label: 'Subscribe', nearFields: true }), cta({ label: 'Add to cart', attrs: { 'aria-controls': 'cart' } })]);
  check('selectCtas: a page with only unsafe controls clicks nothing', unsafe.length === 0);
}

console.log(`\nInteractive-forms: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
