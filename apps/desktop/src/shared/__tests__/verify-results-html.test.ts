// Pure tests for the tag-verification results export builder (the numbered "verified tags" list). Run:
// tsx src/shared/__tests__/verify-results-html.test.ts
import { verifyResultsHtml, siteLabel, tagTitle } from '../verify-results-html';
import type { VerifyExportPayload, VerifyExportRow } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const rows: VerifyExportRow[] = [
  { status: 'Fired', tag: 'GA4 - Event - Phone Click Tag', triggerEvent: 'phone_click', trigger: 'Phone Click - Global Trigger', firedVia: 'Tag', signal: 'GTM monitor: success', screenshot: PNG },
  { status: 'Config OK', tag: 'GA4 - Event - Get In Touch Form Tag', triggerEvent: 'form_submission', trigger: 'Get In Touch Form Trigger', firedVia: 'Form' },
  { status: 'Issue', tag: 'Meta - Purchase Tag', triggerEvent: 'gtm.click', trigger: 'Purchase Trigger', firedVia: 'Click' },
  { status: 'Untested', tag: 'GA4 - Event - Careers Apply Tag', triggerEvent: 'apply', trigger: 'Careers Trigger' },
];
const payload = (over: Partial<VerifyExportPayload> = {}): VerifyExportPayload => ({
  url: 'https://www.example.com/',
  authoritative: true,
  counts: { fired: 1, config: 1, server: 0, untested: 1, issues: 1 },
  rows,
  ...over,
});

// ── siteLabel ──────────────────────────────────────────────────────────────────
check('siteLabel strips www + scheme', siteLabel('https://www.example.com/x') === 'example.com');
check('siteLabel of a bad url is empty', siteLabel('not a url') === '');
check('siteLabel of undefined is empty', siteLabel(undefined) === '');

// ── tagTitle: clean human title from a tag name ──────────────────────────────────
check('tagTitle strips "Vendor - Type - " prefix + " Tag" suffix', tagTitle('GA4 - Event - The ChowNow Feed Tag') === 'The ChowNow Feed');
check('tagTitle keeps internal dashes in the friendly part', tagTitle('GA4 - Event - Get A Quote Click - Global Tag') === 'Get A Quote Click - Global');
check('tagTitle leaves a plain name unchanged', tagTitle('My Custom Name') === 'My Custom Name');
check('tagTitle is empty-safe', tagTitle(undefined) === '' && tagTitle('') === '');

// ── verifyResultsHtml: numbered fired-tag list ───────────────────────────────────
const html = verifyResultsHtml(payload());
check('heading shows the host', html.includes('Verified Tags - example.com'));
check('numbered entry uses the clean title', html.includes('1. Phone Click') && html.includes('2. Get In Touch Form'));
check('A. Tag Name line shows the full tag name', html.includes('A. Tag Name : GA4 - Event - Phone Click Tag'));
check('B. Event Name line shows the configured event', html.includes('B. Event Name : phone_click'));
check('C. Trigger Name line shows the trigger', html.includes('C. Trigger Name : Phone Click - Global Trigger'));
check('lists ONLY tags that fired (Fired + Config OK)', html.includes('Phone Click Tag') && html.includes('Get In Touch Form Tag'));
check('EXCLUDES issue + untested tags', !html.includes('Meta - Purchase Tag') && !html.includes('Careers Apply Tag'));
check('embeds the proof screenshot as an <img> data-uri', html.includes(`<img src="${PNG}"`));
check('a fired tag without a screenshot has no img (only the 1 with a shot)', (html.match(/<img /g) || []).length === 1);
check('no status table in the new format', !html.includes('<table'));

// ── Security: never embed a non-image data-uri; escape a malicious tag name ───────
const evil = verifyResultsHtml(payload({
  rows: [{ status: 'Fired', tag: '<img src=x onerror=alert(1)>', triggerEvent: 'e', trigger: 't', screenshot: 'data:text/html,<script>alert(1)</script>' }],
}));
check('rejects a non-image screenshot data-uri (no injection)', !evil.includes('<script>alert(1)</script>') && !evil.includes('data:text/html'));
check('escapes a malicious tag name', evil.includes('&lt;img src=x onerror=alert(1)&gt;') && !evil.includes('<img src=x onerror'));

// ── No fired tags → a friendly note, no numbered entries ─────────────────────────
const none = verifyResultsHtml(payload({ rows: [{ status: 'Issue', tag: 'X Tag', trigger: 't' }, { status: 'Untested', tag: 'Y Tag' }] }));
check('no fired tags -> "No tags fired" note', none.includes('No tags fired in this run') && !none.includes('1. '));

console.log(`\nverify-results-html: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
