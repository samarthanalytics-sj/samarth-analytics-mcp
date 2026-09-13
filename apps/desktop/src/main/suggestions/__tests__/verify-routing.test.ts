// Pure tests for the multi-page verify router (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-routing.test.ts

import { routeTagsToPages, elementMatchesTrigger, isHomePage, normalizeVerifyPages, isGlobalClickTag, expandTagsOverPages } from '../verify-routing';
import type { VerifyTagInput, DetectedElementView } from '../../../shared/ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const tag = (over: Partial<VerifyTagInput> = {}): VerifyTagInput => ({
  id: 't1', tagName: 'CTA', eventName: 'cta_click', platform: 'ga4_event',
  trigger: { name: 'CTA', kind: 'link_click', clickTextValue: 'View Open Positions', clickTextOperator: 'equals' },
  ...over,
});
const el = (page: string, text: string, href?: string): DetectedElementView =>
  ({ page, kind: 'cta', text, ...(href ? { href } : {}) } as DetectedElementView);

const BASE = 'https://site.com';

// ── isHomePage ───────────────────────────────────────────────────────────────────
check('isHomePage "/"', isHomePage('/'));
check('isHomePage ""', isHomePage(''));
check('isHomePage "site-wide"', isHomePage('site-wide'));
check('isHomePage undefined', isHomePage(undefined));
check('isHomePage absolute root URL', isHomePage('https://site.com/', BASE));
check('isHomePage NOT a subpage path', !isHomePage('/careers'));
check('isHomePage NOT an absolute subpage', !isHomePage('https://site.com/careers', BASE));

// ── elementMatchesTrigger ─────────────────────────────────────────────────────────
check('text equals matches', elementMatchesTrigger(tag().trigger, el('/careers', 'View Open Positions')));
check('text equals is case-insensitive', elementMatchesTrigger(tag().trigger, el('/careers', 'view open positions')));
check('text equals does NOT match a different label', !elementMatchesTrigger(tag().trigger, el('/careers', 'Apply Now')));
// Decorated on-page labels still EQUALS-match after normalization (arrow glyph, nbsp, extra whitespace).
check('text equals matches a label with a trailing arrow glyph', elementMatchesTrigger(tag().trigger, el('/careers', 'View Open Positions →')));
check('text equals matches a label with nbsp + extra spaces', elementMatchesTrigger(tag().trigger, el('/careers', '  View Open   Positions ')));
// equals-then-contains fallback: an equals trigger matches a label carrying extra words.
check('text equals falls back to contains for an extra-word label', elementMatchesTrigger(tag().trigger, el('/careers', 'View Open Positions Today')));
check('text equals still rejects an unrelated label', !elementMatchesTrigger(tag().trigger, el('/careers', 'Read the blog')));
{
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Free Audit', clickTextOperator: 'contains' } });
  check('text contains matches a superset label', elementMatchesTrigger(t.trigger, el('/', 'Get a Free Audit')));
}
{
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: 'linkedin.com', clickUrlOperator: 'contains' } });
  check('url contains matches href', elementMatchesTrigger(t.trigger, el('/', 'Follow', 'https://linkedin.com/company/x')));
  check('url contains does not match other href', !elementMatchesTrigger(t.trigger, el('/', 'Tweet', 'https://twitter.com/x')));
}
{
  // Both text AND url set → both must match.
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Apply', clickTextOperator: 'equals', clickUrlValue: '/jobs', clickUrlOperator: 'contains' } });
  check('text+url both match', elementMatchesTrigger(t.trigger, el('/careers', 'Apply', 'https://site.com/jobs/1')));
  check('text+url fails when url differs', !elementMatchesTrigger(t.trigger, el('/careers', 'Apply', 'https://site.com/about')));
}
check('non-click trigger never matches', !elementMatchesTrigger({ name: 'p', kind: 'pageview' } as VerifyTagInput['trigger'], el('/', 'x')));
{
  // startsWith text — the operator the old ctaTriggerFiresOn-based matcher missed (must mirror the driver).
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Download', clickTextOperator: 'startsWith' } });
  check('text startsWith matches a prefix label', elementMatchesTrigger(t.trigger, el('/', 'Download the checklist')));
  check('text startsWith does not match a mid-string label', !elementMatchesTrigger(t.trigger, el('/', 'Free Download')));
}
{
  // url startsWith (absolute value)
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: 'https://site.com/jobs', clickUrlOperator: 'startsWith' } });
  check('url startsWith matches (absolute value)', elementMatchesTrigger(t.trigger, el('/careers', 'Apply', 'https://site.com/jobs/1')));
}
{
  // #2 regression: the inventory href is ABSOLUTE, but a GTM {{Click URL}} trigger is often written as
  // a site-relative PATH. Both equals + startsWith on a path must still match (via the derived path
  // candidate), else the tag under-routes and is falsely "not firing".
  const abs = 'https://site.com/careers';
  const eq = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: '/careers', clickUrlOperator: 'equals' } });
  check('url equals a PATH matches an absolute inventory href', elementMatchesTrigger(eq.trigger, el('/', 'Careers', abs)));
  const sw = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: '/care', clickUrlOperator: 'startsWith' } });
  check('url startsWith a PATH matches an absolute inventory href', elementMatchesTrigger(sw.trigger, el('/', 'Careers', abs)));
  const ew = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: '.pdf', clickUrlOperator: 'endsWith' } });
  check('url endsWith matches', elementMatchesTrigger(ew.trigger, el('/', 'Guide', 'https://site.com/x/guide.pdf')));
  // And a mismatching path must NOT match.
  check('url equals a different path does not match', !elementMatchesTrigger(eq.trigger, el('/', 'About', 'https://site.com/about')));
}
{
  // #2 end-to-end: a path-based click-URL tag routes to the page it lives on (was broken pre-fix).
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: '/careers', clickUrlOperator: 'equals' } });
  const els = [el('/', 'Home'), el('/team', 'Careers', 'https://site.com/careers')];
  const [r] = routeTagsToPages([t], els, BASE);
  check('path-based click-URL tag routes to its page', r.page === '/team');
}

// ── routeTagsToPages ──────────────────────────────────────────────────────────────
{
  // CTA lives ONLY on /careers → route the tag there.
  const els = [el('/', 'Home'), el('/careers', 'View Open Positions')];
  const [r] = routeTagsToPages([tag()], els, BASE);
  check('routes an off-homepage CTA to its page', r.page === '/careers');
}
{
  // CTA is in the nav (on homepage too) → keep the homepage (minimal navigation).
  const els = [el('/', 'View Open Positions'), el('/careers', 'View Open Positions')];
  const [r] = routeTagsToPages([tag()], els, BASE);
  check('keeps homepage when the CTA is also on the homepage', isHomePage(r.page));
}
{
  // CTA on NO crawled page → left untouched (engine will mark it inconclusive).
  const els = [el('/', 'Home'), el('/about', 'Our Team')];
  const [r] = routeTagsToPages([tag()], els, BASE);
  check('leaves an unfound CTA untouched', r.page === undefined);
}
{
  // A tag already scoped to a concrete page is respected, never overridden.
  const t = tag({ page: '/pricing' });
  const els = [el('/careers', 'View Open Positions')];
  const [r] = routeTagsToPages([t], els, BASE);
  check('respects a concrete existing page', r.page === '/pricing');
}
{
  // Non-click tags are never re-pointed.
  const ce = tag({ id: 'ce', trigger: { name: 'F', kind: 'custom_event', eventName: 'form_submission' } });
  const [r] = routeTagsToPages([ce], [el('/careers', 'x')], BASE);
  check('custom_event tag is not re-pointed', r.page === undefined);
}
{
  // Empty inventory → identity.
  const same = routeTagsToPages([tag()], [], BASE);
  check('empty inventory → tags unchanged', same[0].page === undefined);
}
{
  // Click-URL tag routes by href to the page it lives on.
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: '/whitepaper.pdf', clickUrlOperator: 'contains' } });
  const els = [el('/', 'Home'), el('/resources', 'Download', 'https://site.com/whitepaper.pdf')];
  const [r] = routeTagsToPages([t], els, BASE);
  check('routes a click-URL tag to its page', r.page === '/resources');
}

// ── normalizeVerifyPages: the "pages to verify" list → same-origin absolute URLs ────────────────────
{
  const T = 'https://www.example.com/';
  check('normalizeVerifyPages: resolves relative + keeps absolute same-origin',
    JSON.stringify(normalizeVerifyPages(['/contact', 'https://www.example.com/pricing'], T))
      === JSON.stringify(['https://www.example.com/contact', 'https://www.example.com/pricing']));
  check('normalizeVerifyPages: drops off-origin URLs',
    JSON.stringify(normalizeVerifyPages(['https://evil.com/x', '/ok'], T)) === JSON.stringify(['https://www.example.com/ok']));
  check('normalizeVerifyPages: trims blanks and dedupes (order preserved)',
    JSON.stringify(normalizeVerifyPages(['  /a  ', '', '/a', '/b'], T)) === JSON.stringify(['https://www.example.com/a', 'https://www.example.com/b']));
  check('normalizeVerifyPages: drops unparseable entries', normalizeVerifyPages(['http://', 'ht tp://x'], T).every((u) => u.startsWith('https://www.example.com')) );
  check('normalizeVerifyPages: empty for empty/non-array input',
    normalizeVerifyPages([], T).length === 0 && normalizeVerifyPages(undefined, T).length === 0 && normalizeVerifyPages('x', T).length === 0);
  check('normalizeVerifyPages: empty when target itself is unparseable', normalizeVerifyPages(['/a'], 'not a url').length === 0);
}

// ── isGlobalClickTag / expandTagsOverPages: dedupe site-wide CTAs to ONE page ─────────────────────
const elR = (page: string, text: string, href: string | undefined, region: string): DetectedElementView =>
  ({ page, kind: 'cta', text, ...(href ? { href } : {}), region } as DetectedElementView);
{
  // A footer CTA → global (site chrome, repeats on every page).
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Email us', clickTextOperator: 'equals' } });
  check('footer CTA → global', isGlobalClickTag(t.trigger, [elR('/', 'Email us', 'mailto:hi@site.com', 'footer')]));
}
{
  // A header nav CTA → global.
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Contact', clickTextOperator: 'equals' } });
  check('header CTA → global', isGlobalClickTag(t.trigger, [elR('/', 'Contact', '/contact', 'header')]));
}
{
  // Same href on 2+ pages (no chrome region) → global (a repeated control).
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickUrlValue: 'wa.me/123', clickUrlOperator: 'contains' } });
  const els = [elR('/a', 'WhatsApp', 'https://wa.me/123', ''), elR('/b', 'WhatsApp', 'https://wa.me/123', '')];
  check('href repeated on 2 pages → global', isGlobalClickTag(t.trigger, els));
}
{
  // Same control on ONE main-content page → NOT global (page-specific, keep per-page coverage).
  const t = tag({ trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Download Checklist', clickTextOperator: 'equals' } });
  check('single-page main CTA → not global', !isGlobalClickTag(t.trigger, [elR('/free-audit', 'Download Checklist', '/x.pdf', 'main')]));
}
check('no inventory → not global (safe fallback)', !isGlobalClickTag(tag().trigger, []));
check('custom_event → never global', !isGlobalClickTag({ name: 'F', kind: 'custom_event', eventName: 'form_submission' } as VerifyTagInput['trigger'], [elR('/', 'x', '/x', 'footer')]));
{
  // expandTagsOverPages: a global click tag drives ONCE; a page-specific tag drives on every page.
  const pages = ['https://site.com/a', 'https://site.com/b', 'https://site.com/c'];
  const globalTag = tag({ id: 'g', tagName: 'Email Click', trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Email us', clickTextOperator: 'equals' } });
  const pageTag = tag({ id: 'p', tagName: 'Checklist', trigger: { name: 'x', kind: 'link_click', clickTextValue: 'Download Checklist', clickTextOperator: 'equals' } });
  const els = [elR('/', 'Email us', 'mailto:hi@site.com', 'footer'), elR('/free-audit', 'Download Checklist', '/x.pdf', 'main')];
  const out = expandTagsOverPages([globalTag, pageTag], pages, els);
  const gRows = out.filter((r) => r.id === 'g');
  const pRows = out.filter((r) => r.id === 'p');
  check('global tag driven ONCE (first page)', gRows.length === 1 && gRows[0].page === pages[0]);
  check('page-specific tag driven on every page', pRows.length === 3);
  check('expand output keeps id / name / trigger', gRows[0].name === 'Email Click' && gRows[0].trigger.kind === 'link_click');
}
{
  // A custom_event tag is never "global" → driven on every page (unchanged coverage).
  const ce = tag({ id: 'ce', tagName: 'Scroll', trigger: { name: 'S', kind: 'custom_event', eventName: 'custom_scroll_depth' } });
  check('custom_event tag driven on every page (not deduped)', expandTagsOverPages([ce], ['https://site.com/a', 'https://site.com/b'], [elR('/', 'x', '/x', 'footer')]).length === 2);
}
check('no inventory → replicate on every page (fallback = old behavior)', expandTagsOverPages([tag({ id: 'z', tagName: 'Z' })], ['https://site.com/a', 'https://site.com/b'], []).length === 2);
check('empty pages → empty output', expandTagsOverPages([tag()], [], []).length === 0);

console.log(`\nverify-routing: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 49) { console.error(`expected >= 49 checks, got ${passed}`); process.exit(1); }
