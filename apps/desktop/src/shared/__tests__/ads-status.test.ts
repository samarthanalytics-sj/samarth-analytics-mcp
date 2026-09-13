// Pure tests for the Google Ads connection status mapping.
// Run: tsx src/shared/__tests__/ads-status.test.ts
import { adsStatus, adsStatusLabel, adsUsable, adsNeedsConsent } from '../ads-status';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed += 1;
  else { failed += 1; failures.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

const NO_TOKEN = { ready: false, reason: 'token' as const, message: 'No Google Ads developer token is set.', remedy: 'Add one in Settings.' };
const NO_SCOPE = { ready: false, reason: 'scope' as const, message: 'This Google account has not granted Google Ads access.', remedy: 'Use "Connect Google Ads" to re-consent.' };

// -- the four distinct states ----------------------------------------------------
check('ready -> Connected', adsStatus({ ready: true }, true).state === 'ready');
check('missing developer token is its OWN state', adsStatus(NO_TOKEN, true).state === 'no_developer_token');
check('missing scope is its OWN state', adsStatus(NO_SCOPE, true).state === 'no_scope');
check('an unknown failure is an error, not a guess', adsStatus({ ready: false, reason: 'other', message: 'boom' }, true).state === 'error');

// Signed-out beats everything: telling someone to fix a developer token when they have not signed in
// sends them to the wrong screen entirely.
check('not signed in wins over a token problem', adsStatus(NO_TOKEN, false).state === 'not_signed_in');
check('not signed in wins over ready', adsStatus({ ready: true }, false).state === 'not_signed_in');
check('not signed in says how to fix it', (adsStatus(NO_TOKEN, false).remedy ?? '').toLowerCase().includes('sign in'));

// -- the reason travels, it is not restated --------------------------------------
check('the service message is carried verbatim', adsStatus(NO_TOKEN, true).message === NO_TOKEN.message);
check('the service remedy is carried verbatim', adsStatus(NO_TOKEN, true).remedy === NO_TOKEN.remedy);
check('a reason with no remedy yields no remedy', adsStatus({ ready: false, reason: 'other', message: 'm' }, true).remedy === undefined);
check('ready carries no message at all', adsStatus({ ready: true }, true).message === undefined);

// -- absent / malformed input ----------------------------------------------------
check('a failed CHECK is an error state, not "not connected"', adsStatus(null, true).state === 'error');
check('a failed check still tells the user what to do', Boolean(adsStatus(undefined, true).remedy));
check('a not-ready result with no reason still reports something', Boolean(adsStatus({ ready: false }, true).message));

// -- labels ----------------------------------------------------------------------
check('label: Connected', adsStatusLabel({ state: 'ready' }) === 'Connected');
check('label: Developer token missing', adsStatusLabel({ state: 'no_developer_token' }) === 'Developer token missing');
check('label: Not connected for a scope gap', adsStatusLabel({ state: 'no_scope' }) === 'Not connected');
check('label: Not signed in', adsStatusLabel({ state: 'not_signed_in' }) === 'Not signed in');
check('label: Connection error', adsStatusLabel({ state: 'error' }) === 'Connection error');
check('every state has a non-empty label', (['ready', 'not_signed_in', 'no_developer_token', 'no_scope', 'error'] as const).every((s) => adsStatusLabel({ state: s }).length > 0));

// -- what the UI decides from it -------------------------------------------------
check('only ready is usable', adsUsable({ state: 'ready' }) && !adsUsable({ state: 'no_scope' }) && !adsUsable({ state: 'no_developer_token' }));
// The most common wrong turn: re-consenting does NOT install a developer token, so the consent
// button must not be offered for that failure.
check('re-consent is offered ONLY for a scope gap', adsNeedsConsent({ state: 'no_scope' }));
check('re-consent is NOT offered for a missing developer token', !adsNeedsConsent({ state: 'no_developer_token' }));
check('re-consent is not offered when already connected', !adsNeedsConsent({ state: 'ready' }));

// -- house style -----------------------------------------------------------------
check('no em dashes in any label or remedy',
  !(['ready', 'not_signed_in', 'no_developer_token', 'no_scope', 'error'] as const).some((s) => /[—–]/.test(adsStatusLabel({ state: s })))
  && !/[—–]/.test(adsStatus(null, true).remedy ?? '')
  && !/[—–]/.test(adsStatus(NO_TOKEN, false).remedy ?? ''));

if (failures.length) console.error(failures.join('\n'));
console.log(`ads-status: ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
