// Pure tests for the GTM preview NAVIGATION helpers (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/verify-preview-nav.test.ts
//
// The bug these guard: a page that already embeds a container loads its LIVE gtm.js on page.goto and
// claims window.google_tag_manager[id]; a second loader we INJECT for the same id is deduped away, so a
// preview/monitor tag never runs ("0 fired"). The fix rides the env-preview params (gtm_auth /
// gtm_preview / gtm_cookies_win) on the NAVIGATION URL so the SITE'S own gtm.js serves our version.
// previewParamsFromLoader extracts them from the loader src; withPreviewParams merges them into a page
// URL (preserving any existing query). These two are the whole mechanism, so they are unit-tested here.

import { buildLoaderSrc, isPreviewLoader, previewParamsFromLoader, withPreviewParams } from '../verify-driver';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// A realistic "Latest" environment preview snippet (what mintWorkspacePreview → buildEnvironmentSnippet
// returns, and what monitor mode feeds the driver as containerSnippet).
const PREVIEW_SNIPPET =
  "<script>(function(w,d,s,l,i){...j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl+" +
  "'&gtm_auth=abc123DEF&gtm_preview=env-5&gtm_cookies_win=x';...})(window,document,'script','dataLayer','GTM-NKZD4BVB');</script>";
const PLAIN_SNIPPET = "<script>...'https://www.googletagmanager.com/gtm.js?id='+i+dl;...'GTM-NKZD4BVB');</script>";

// ── previewParamsFromLoader: extracts the env params from a preview loader ─────────
{
  const previewSrc = buildLoaderSrc(PREVIEW_SNIPPET);
  check('sanity: preview snippet builds a preview loader', isPreviewLoader(previewSrc));
  const params = previewParamsFromLoader(previewSrc);
  check('preview loader → params object', params !== null);
  check('extracts gtm_auth', params?.gtm_auth === 'abc123DEF');
  check('extracts gtm_preview (env-N)', params?.gtm_preview === 'env-5');
  check('extracts gtm_cookies_win', params?.gtm_cookies_win === 'x');

  // A plain published-container loader carries no preview auth → null (so we never touch the nav URL).
  const plainSrc = buildLoaderSrc(PLAIN_SNIPPET);
  check('sanity: plain snippet is NOT a preview loader', !isPreviewLoader(plainSrc));
  check('plain loader → null params', previewParamsFromLoader(plainSrc) === null);
  check('null loader → null params', previewParamsFromLoader(null) === null);

  // gtm_cookies_win defaults to 'x' when the loader omits it (still a valid preview).
  const noCookiesWin = 'https://www.googletagmanager.com/gtm.js?id=GTM-NKZD4BVB&gtm_auth=t0k&gtm_preview=env-9';
  const p2 = previewParamsFromLoader(noCookiesWin);
  check('missing gtm_cookies_win defaults to x', p2?.gtm_cookies_win === 'x' && p2?.gtm_auth === 't0k' && p2?.gtm_preview === 'env-9');
}

// ── withPreviewParams: merges params onto the navigation URL ───────────────────────
{
  const params = { gtm_auth: 'abc123DEF', gtm_preview: 'env-5', gtm_cookies_win: 'x' };

  // Bare page URL (no query) — params appended, site's gtm.js will read them at bootstrap.
  const u1 = new URL(withPreviewParams('https://example.com/contact', params));
  check('bare url gains gtm_auth', u1.searchParams.get('gtm_auth') === 'abc123DEF');
  check('bare url gains gtm_preview', u1.searchParams.get('gtm_preview') === 'env-5');
  check('bare url gains gtm_cookies_win', u1.searchParams.get('gtm_cookies_win') === 'x');

  // Existing query is PRESERVED, not clobbered (the "?"-doubling footgun).
  const u2 = new URL(withPreviewParams('https://example.com/p?utm_source=x&ref=abc', params));
  check('existing query preserved: utm_source', u2.searchParams.get('utm_source') === 'x');
  check('existing query preserved: ref', u2.searchParams.get('ref') === 'abc');
  check('preview params still added alongside', u2.searchParams.get('gtm_preview') === 'env-5');
  check('no doubled question mark', (withPreviewParams('https://example.com/p?a=1', params).match(/\?/g) || []).length === 1);

  // null params (non-preview mode) → URL untouched, so the beacon "Verify firing" path is unaffected.
  check('null params → url unchanged', withPreviewParams('https://example.com/x?a=1', null) === 'https://example.com/x?a=1');

  // A hash fragment survives the merge.
  check('hash fragment preserved', new URL(withPreviewParams('https://example.com/p#section', params)).hash === '#section');

  // An unparseable url falls back to the raw string (never throws mid-drive).
  check('unparseable url falls back to raw', withPreviewParams('not a url', params) === 'not a url');
}

console.log(`\nverify-preview-nav: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 18) { console.error(`expected >= 18 checks, got ${passed}`); process.exit(1); }
