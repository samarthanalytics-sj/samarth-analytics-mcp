// Tests for the "Create into" id hints. The bug these lock down: the GA4 Measurement ID line was
// rendered unconditionally, so selecting ONLY Google Ads told the user to "edit a row to a real
// G-XXXX id" when that row's id field actually holds their Conversion ID. Wrong advice, not noise.
// Run: tsx src/shared/__tests__/platform-id-hints.test.ts
import { platformIdHints, PLATFORM_ID_HINTS } from '../platform-id-hints';
import type { SuggestPlatform } from '../ipc';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const vars = (p: SuggestPlatform[]): string => platformIdHints(p).flatMap((h) => h.variables).join(' ');
const only = (p: SuggestPlatform[]): string => platformIdHints(p).map((h) => h.platform).join(',');

// ── The reported bug ────────────────────────────────────────────────────────────
check('google_ads alone shows ONLY the Ads conversion variables', (() => {
  const v = vars(['google_ads']);
  return v.includes('{{Google Ads Conversion ID}}') && v.includes('{{Google Ads Conversion Label}}')
    && !v.includes('Measurement ID') && !v.includes('Pixel');
})(), vars(['google_ads']));
check('google_ads alone never mentions a G-XXXX id (that field holds the Conversion ID)',
  !platformIdHints(['google_ads']).some((h) => /G-XXXX/.test(h.action)));

// ── The rest of the requested behaviour ────────────────────────────────────────
check('meta alone shows ONLY the Meta Pixel ID', vars(['meta']) === '{{Meta Pixel ID}}');
check('meta + google_ads shows BOTH, and nothing else', (() => {
  const v = vars(['meta', 'google_ads']);
  return v.includes('{{Meta Pixel ID}}') && v.includes('{{Google Ads Conversion ID}}') && !v.includes('Measurement ID');
})(), vars(['meta', 'google_ads']));
check('ga4 alone still shows the Measurement ID', vars(['ga4']) === '{{GA4 Measurement ID}}');
check('ga4 + google_ads shows both', (() => {
  const v = vars(['ga4', 'google_ads']);
  return v.includes('{{GA4 Measurement ID}}') && v.includes('{{Google Ads Conversion ID}}');
})());
check('no selection shows nothing', platformIdHints([]).length === 0 && platformIdHints(undefined).length === 0);

// ── Order is stable regardless of click order ──────────────────────────────────
check('order follows the chips, not the order they were clicked',
  only(['google_ads', 'meta']) === only(['meta', 'google_ads']) && only(['meta', 'google_ads']) === 'meta,google_ads');

// ── Every platform is covered, and each hint is usable ─────────────────────────
const ALL: SuggestPlatform[] = ['ga4', 'meta', 'google_ads', 'tiktok', 'linkedin', 'reddit', 'pinterest'];
check('every platform has a hint (a new platform cannot ship without one)',
  ALL.every((p) => !!PLATFORM_ID_HINTS[p]) && Object.keys(PLATFORM_ID_HINTS).length === ALL.length);
check('selecting everything returns one hint per platform, none duplicated',
  platformIdHints(ALL).length === ALL.length && new Set(platformIdHints(ALL).map((h) => h.platform)).size === ALL.length);
for (const p of ALL) {
  const h = PLATFORM_ID_HINTS[p];
  check(`${p}: has a label, at least one {{variable}}, and an action`,
    !!h.label && h.variables.length > 0 && h.variables.every((v) => /^\{\{.+\}\}$/.test(v)) && /\.$/.test(h.action));
  check(`${p}: its hint mentions only ITS OWN platform variables`,
    !platformIdHints([p]).some((x) => x.platform !== p));
}
// House style: these strings render straight into the UI.
check('no em dashes in any hint (house style)',
  !ALL.some((p) => /[—–]/.test(PLATFORM_ID_HINTS[p].action + PLATFORM_ID_HINTS[p].label)));

console.log(`\nplatform-id-hints: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
