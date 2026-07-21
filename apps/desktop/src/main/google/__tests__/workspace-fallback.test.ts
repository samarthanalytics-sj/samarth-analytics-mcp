// Is the target GTM workspace still writable, and where should the user go if not?
//
// A workspace goes read-only permanently once a container version is created from it, which this app
// does itself during "Auto: create preview & verify". GTM then drops it from the workspace list and
// mints a replacement, so presence in the list IS the writability test.
// Run: tsx src/main/google/__tests__/workspace-fallback.test.ts

import { decideWorkspaceFallback, type GtmWorkspaceView } from '../data-service';

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else failures.push(`✗ ${name}${detail ? ': ' + detail : ''}`);
}

const ws = (workspaceId: string, name: string): GtmWorkspaceView => ({ workspaceId, name, path: `x/workspaces/${workspaceId}` });

// ── still writable ───────────────────────────────────────────────────────────
const live = [ws('44', 'Default Workspace'), ws('45', 'Feature work')];
const ok44 = decideWorkspaceFallback(live, '44');
check('present in the list = writable', ok44.writable === true);
check('writable reports no fallback (nothing to move to)', ok44.fallbackId === null && ok44.fallbackName === null);
check('a second present workspace is also writable', decideWorkspaceFallback(live, '45').writable === true);

// ── submitted: dropped from the list ─────────────────────────────────────────
// This is the exact shape of the reported failure: the user sat on 44, submitted it (directly or via
// the app's own preview), and GTM replaced it with 46.
const afterSubmit = [ws('45', 'Default Workspace'), ws('46', 'Default Workspace')];
const gone = decideWorkspaceFallback(afterSubmit, '44');
check('absent from the list = NOT writable', gone.writable === false);
check('fallback is the NEWEST workspace (highest id), which is the replacement GTM minted', gone.fallbackId === '46');
check('fallback carries its name for the message', gone.fallbackName === 'Default Workspace');

// The replacement usually REUSES the old name, which is why the message must also quote the id: telling
// someone on "Default Workspace" to switch to "Default Workspace" reads as nonsense on its own.
check('a same-named replacement is still offered (the id disambiguates it)', gone.fallbackName === 'Default Workspace' && gone.fallbackId === '46');

// ── prefer a non-default workspace when one exists ───────────────────────────
const mixed = [ws('40', 'Default Workspace'), ws('41', 'Ads work'), ws('39', 'Old')];
const pick = decideWorkspaceFallback(mixed, '99');
check('prefers a non-default workspace over Default Workspace', pick.fallbackName === 'Ads work' && pick.fallbackId === '41');

// Numeric, not lexicographic: '9' must not beat '10'.
const numeric = [ws('9', 'A'), ws('10', 'B')];
check('newest is chosen NUMERICALLY, so 10 beats 9', decideWorkspaceFallback(numeric, '99').fallbackId === '10');

// ── degenerate inputs must not throw ─────────────────────────────────────────
const empty = decideWorkspaceFallback([], '44');
check('an empty container yields not-writable with no fallback', empty.writable === false && empty.fallbackId === null);
check('the caller can tell "no fallback" apart and say "create a new workspace"', empty.fallbackName === null);
const onlyDefault = decideWorkspaceFallback([ws('50', 'Default Workspace')], '44');
check('only a Default Workspace present: it is still offered rather than nothing', onlyDefault.fallbackId === '50');
check('a null-ish list does not throw', decideWorkspaceFallback(undefined as unknown as GtmWorkspaceView[], '44').writable === false);
// Name matching must be trimmed + case-insensitive, or a stray " default workspace " defeats the preference.
const spaced = [ws('60', '  DEFAULT workspace '), ws('61', 'Real work')];
check('the Default Workspace check is trimmed and case-insensitive', decideWorkspaceFallback(spaced, '99').fallbackId === '61');

// An id that differs only by whitespace is NOT the same workspace: ids come straight from the API on
// both sides, so an exact match is correct and a loose one would wrongly report a dead workspace live.
check('workspace id matching is exact', decideWorkspaceFallback([ws('44', 'A')], ' 44').writable === false);

if (passed < 14) { console.error(`✗ only ${passed} assertions ran (expected 14+)`); process.exit(1); }
console.log(`\nworkspace-fallback: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
