// Content tests for the Google Ads developer-token guidance. This is user-facing copy shown in two
// places from one source, so what is pinned here is the things that make it CORRECT, not its wording.
// Run: tsx src/shared/__tests__/ads-onboarding.test.ts
import {
  ADS_ACCESS_DOCS,
  ADS_ACCESS_LEVELS,
  ADS_ACCESS_SUMMARY,
  ADS_API_CENTER_PATH,
  ADS_TOKEN_INSTALL_STEPS,
  ADS_TOKEN_STEPS,
} from '../ads-onboarding';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const ALL_TEXT = [
  ...ADS_TOKEN_STEPS.flatMap((s) => [s.title, s.detail, s.warning ?? '']),
  ...ADS_TOKEN_INSTALL_STEPS.flatMap((s) => [s.title, s.detail, s.warning ?? '']),
  ...ADS_ACCESS_LEVELS.flatMap((l) => [l.level, l.limit, l.meaning]),
  ADS_ACCESS_SUMMARY,
].join(' ');

// -- the steps are complete and ordered ------------------------------------------
check('there are steps for getting the token', ADS_TOKEN_STEPS.length >= 4);
check('there are steps for installing it here', ADS_TOKEN_INSTALL_STEPS.length >= 2);
check('every step has a title and a detail', [...ADS_TOKEN_STEPS, ...ADS_TOKEN_INSTALL_STEPS].every((s) => s.title.trim() && s.detail.trim()));
// The manager-account requirement has to come FIRST: someone who starts in a regular account will
// hunt for a menu item that does not exist there.
check('the manager (MCC) requirement is the FIRST step', /manager/i.test(ADS_TOKEN_STEPS[0].title));
check('the API Center path is named', ALL_TEXT.includes(ADS_API_CENTER_PATH));
check('the install steps name Settings > Providers', ADS_TOKEN_INSTALL_STEPS.some((s) => /Settings > Providers/i.test(s.title + s.detail)));
check('the install steps cover the per-account consent', ADS_TOKEN_INSTALL_STEPS.some((s) => /connect google ads/i.test(s.title + s.detail)));

// -- the Test-token trap ---------------------------------------------------------
// Verified behaviour: with a Test-level token the account list SUCCEEDS and every follow-up fails,
// so "the connection test passed" is not evidence. If this warning is ever dropped, the guidance
// actively misleads.
const warnings = [...ADS_TOKEN_STEPS, ...ADS_TOKEN_INSTALL_STEPS].filter((s) => s.warning);
check('at least one step carries a warning', warnings.length >= 1);
check('the warning is on the "apply for Basic" step', ADS_TOKEN_STEPS.some((s) => /basic/i.test(s.title) && Boolean(s.warning)));
check('the warning says a passing test is not proof', warnings.some((s) => /not proof|still succeeds|succeeds with one/i.test(s.warning ?? '')));

// -- access levels ---------------------------------------------------------------
check('all three levels are described', ADS_ACCESS_LEVELS.length === 3);
check('the levels are Test, Basic, Standard in order', ADS_ACCESS_LEVELS.map((l) => l.level).join(',') === 'Test,Basic,Standard');
check('every level states a limit and what it means', ADS_ACCESS_LEVELS.every((l) => l.limit.trim() && l.meaning.trim()));
// The load-bearing fact: Test is not a smaller Basic, it cannot touch a real account at all.
check('Test does NOT work here', ADS_ACCESS_LEVELS.find((l) => l.level === 'Test')?.worksHere === false);
check('Basic DOES work here', ADS_ACCESS_LEVELS.find((l) => l.level === 'Basic')?.worksHere === true);
check('Standard works here too', ADS_ACCESS_LEVELS.find((l) => l.level === 'Standard')?.worksHere === true);
check('exactly one level is unusable', ADS_ACCESS_LEVELS.filter((l) => !l.worksHere).length === 1);
check('the summary names Basic as the minimum', /basic/i.test(ADS_ACCESS_SUMMARY));
check('the summary warns about Test', /test/i.test(ADS_ACCESS_SUMMARY));

// -- honesty about the numbers ---------------------------------------------------
// Quotas change. The app must link to Google rather than presenting its own copy as authoritative.
check('the official docs are linked', ADS_ACCESS_DOCS.startsWith('https://developers.google.com/google-ads/api/'));
check('the Basic figure is hedged, not stated as exact', /about|approximately|~/i.test(ADS_ACCESS_LEVELS.find((l) => l.level === 'Basic')?.limit ?? ''));
// Do not oversell Standard: it changes nothing for this app, and sending someone through a second
// review they do not need is a worse outcome than a slightly less impressive table.
check('Standard is not presented as required', /basic already covers|changes nothing/i.test(ADS_ACCESS_LEVELS.find((l) => l.level === 'Standard')?.meaning ?? ''));

// -- house style -----------------------------------------------------------------
check('no em or en dashes in any user-visible string', !/[—–]/.test(ALL_TEXT), ALL_TEXT.match(/.{0,30}[—–].{0,30}/)?.[0]);
check('no smart quotes', !/[‘’“”]/.test(ALL_TEXT));
check('the token is called a secret somewhere', /secret|password/i.test(ALL_TEXT));

if (failures.length) console.error(failures.join('\n'));
console.log(`ads-onboarding: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
