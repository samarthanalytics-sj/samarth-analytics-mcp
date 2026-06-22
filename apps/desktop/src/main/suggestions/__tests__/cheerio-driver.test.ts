// Cheerio static-extraction tests (no network): parse HTML → RawElement/RawForm,
// including the div/JS-form heuristic, then run it through the pure engine.
// Run: tsx apps/desktop/src/main/suggestions/__tests__/cheerio-driver.test.ts

import { extractWithCheerio } from '../cheerio-driver';
import { analyzeForms } from '../../../../../web-audit-mcp/src/agent/forms.js';
import { classifyPageElements, buildSuggestInput, type PageScan } from '../../../../../web-audit-mcp/src/agent/tag-suggest/collect.js';
import { buildSuggestions } from '../../../../../web-audit-mcp/src/agent/tag-suggest/suggest.js';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const BASE = 'https://acme.com/';

// ── real <form> ──────────────────────────────────────────────────────────────
{
  const html = `<html><body><form action="/submit" method="post">
    <label for="e">Email</label><input id="e" type="email" name="email">
    <textarea name="message"></textarea>
    <button type="submit">Send message</button>
  </form></body></html>`;
  const { rawForms } = extractWithCheerio(html, BASE);
  check('real form: detected', rawForms.length === 1);
  check('real form: action resolved absolute', rawForms[0].action === 'https://acme.com/submit');
  check('real form: email + message fields captured', rawForms[0].fields.some((f) => f.type === 'email') && rawForms[0].fields.some((f) => f.tag === 'textarea'));
  const analyzed = analyzeForms(rawForms, BASE);
  check('real form: → contact purpose', analyzed[0].purpose === 'contact');
}

// ── div/JS "form" (no <form> tag) → detected ─────────────────────────────────
{
  const html = `<html><body><div class="nl">
    <label>Email <input type="email" name="email" placeholder="you@co.com"></label>
    <button>Subscribe</button>
  </div></body></html>`;
  const { rawForms } = extractWithCheerio(html, BASE);
  check('div form: detected (no <form> tag)', rawForms.length === 1 && rawForms[0].method === 'js' && rawForms[0].action === '');
  const analyzed = analyzeForms(rawForms, BASE);
  check('div form: → newsletter purpose', analyzed[0].purpose === 'newsletter');
}

// ── filter / select-only widgets are NOT mistaken for forms ──────────────────
{
  const html = `<html><body>
    <div><select name="cat"><option>A</option></select><button>Apply filters</button></div>
    <div><select name="sort"><option>x</option></select><button>Submit</button></div>
  </body></html>`;
  const { rawForms } = extractWithCheerio(html, BASE);
  check('filter widgets ("Apply", select-only "Submit") are NOT div-forms', rawForms.length === 0, `${rawForms.length}`);
}

// ── elements: mailto / outbound / download / provider signal ─────────────────
{
  const html = `<html><body>
    <a href="mailto:hi@acme.com">Email us</a>
    <a href="https://partner.com/x">Partner</a>
    <a href="/guide.pdf">Guide</a>
    <a href="/about">About</a>
    <div class="hs-form"></div>
    <script src="https://js.hsforms.net/forms/embed/v2.js"></script>
  </body></html>`;
  const { raw } = extractWithCheerio(html, BASE);
  const kinds = new Set(classifyPageElements(raw.elements, 'acme.com', '/').map((e) => e.kind));
  check('elements: mailto → email, partner → outbound, pdf → download', kinds.has('email') && kinds.has('outbound') && kinds.has('download'));
  check('elements: internal /about not classified', !classifyPageElements(raw.elements, 'acme.com', '/').some((e) => (e.href ?? '').endsWith('/about')));
  check('signals: HubSpot provider markers captured', raw.signals.selectorsPresent.includes('.hs-form') && raw.signals.scriptSrcs.some((s) => /hsforms/.test(s)));
}

// ── end-to-end: cheerio HTML → suggestions ───────────────────────────────────
{
  const html = `<html><body>
    <a href="tel:+15551234567">Call</a>
    <div class="signup">
      <input type="email" name="email"><input type="password" name="pw">
      <button>Sign up</button>
    </div>
  </body></html>`;
  const { raw, rawForms } = extractWithCheerio(html, BASE);
  const page: PageScan = {
    page: '/',
    signals: raw.signals,
    forms: analyzeForms(rawForms, BASE).map((f) => ({ purpose: f.purpose, action: f.action })),
    elements: classifyPageElements(raw.elements, 'acme.com', '/'),
  };
  const sugs = buildSuggestions(buildSuggestInput([page], 'acme.com'));
  const events = new Set(sugs.map((s) => s.eventName));
  check('end-to-end: tel → phone_click', events.has('phone_click'));
  check('end-to-end: div signup form → signup_form', events.has('signup_form'));
  check('end-to-end: every suggestion carries event parameters', sugs.every((s) => (s.eventParameters?.length ?? 0) > 0));
}

console.log(`\ncheerio-driver: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
