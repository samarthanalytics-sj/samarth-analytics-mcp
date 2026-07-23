// Pure tests for developer-token precedence: an account's own token beats the shared one, and the
// shared one is what every account without an override uses.
// Run: tsx src/shared/__tests__/ads-token-scope.test.ts
import { resolveAdsToken, describeAdsToken, hasAdsToken } from '../ads-token-scope';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const SHARED = 'ref_shared';
const OWN = 'ref_own';

// -- precedence -------------------------------------------------------------------
check('an account with no override uses the shared token', resolveAdsToken({ accountId: 'a', shared: SHARED }).ref === SHARED);
check('and reports it as shared', resolveAdsToken({ accountId: 'a', shared: SHARED }).source === 'shared');
check('an override WINS over the shared token', resolveAdsToken({ accountId: 'a', perAccount: { a: OWN }, shared: SHARED }).ref === OWN);
check('and reports it as the account\'s own', resolveAdsToken({ accountId: 'a', perAccount: { a: OWN }, shared: SHARED }).source === 'account');
// Someone who sets a token for one client and never sets a shared one is expressing intent.
check('an override works with NO shared token at all', resolveAdsToken({ accountId: 'a', perAccount: { a: OWN } }).ref === OWN);
check('another account is unaffected by a sibling\'s override', resolveAdsToken({ accountId: 'b', perAccount: { a: OWN }, shared: SHARED }).ref === SHARED);
check('nothing configured resolves to nothing', resolveAdsToken({ accountId: 'a' }).ref === null);
check('and reports source none', resolveAdsToken({}).source === 'none');

// -- edges --------------------------------------------------------------------------
check('no accountId falls back to the shared token', resolveAdsToken({ shared: SHARED }).ref === SHARED);
// An override map that does not mention this account must not leak another account's token.
check('no accountId IGNORES every override', resolveAdsToken({ perAccount: { a: OWN } }).ref === null);
check('an empty-string override is treated as unset', resolveAdsToken({ accountId: 'a', perAccount: { a: '' }, shared: SHARED }).ref === SHARED);
check('an empty shared token is treated as unset', resolveAdsToken({ accountId: 'a', shared: '' }).ref === null);
check('an unknown account falls back rather than throwing', resolveAdsToken({ accountId: 'zzz', perAccount: { a: OWN }, shared: SHARED }).ref === SHARED);

// -- usability ----------------------------------------------------------------------
check('a resolved token is usable', hasAdsToken(resolveAdsToken({ shared: SHARED })));
check('no token is not usable', !hasAdsToken(resolveAdsToken({})));

// -- the explanation ----------------------------------------------------------------
const ownText = describeAdsToken(resolveAdsToken({ accountId: 'a', perAccount: { a: OWN }, shared: SHARED }), 'x@y.com');
const sharedText = describeAdsToken(resolveAdsToken({ accountId: 'a', shared: SHARED }), 'x@y.com');
const noneText = describeAdsToken(resolveAdsToken({}));
check('the override text says the shared token is not used', /shared token is not used/i.test(ownText));
check('the shared text says when you would need an override', /different manager/i.test(sharedText));
check('the none text says Ads cannot be reached', /cannot be reached/i.test(noneText));
check('the text names the account it is about', ownText.includes('x@y.com') && sharedText.includes('x@y.com'));
check('an email is optional', describeAdsToken(resolveAdsToken({ shared: SHARED })).length > 0);

// A developer token is a secret. No part of it may reach a UI string, because settings screens get
// screenshotted into support threads.
for (const [label, text] of [['own', ownText], ['shared', sharedText], ['none', noneText]] as Array<[string, string]>) {
  check(`the ${label} description leaks no ref or token`, !text.includes(OWN) && !text.includes(SHARED));
}

// -- house style --------------------------------------------------------------------
check('no em or en dashes', ![ownText, sharedText, noneText].some((t) => /[—–]/.test(t)));

if (failures.length) console.error(failures.join('\n'));
console.log(`ads-token-scope: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
