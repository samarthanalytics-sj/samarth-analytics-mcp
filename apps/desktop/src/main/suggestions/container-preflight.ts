// Pure decision helper for the Tag-verification container PREFLIGHT gate.
//
// Before driving Tag Assistant, we detect which GTM container is actually booted on the live URL
// (verify-driver.detectLiveContainers) and compare it to the container the operator SELECTED. This
// module is the pure comparison so it is unit-testable with no browser. The renderer uses the verdict
// to decide: proceed straight into verification (match), or show a Proceed/Cancel gate (missing /
// mismatch) that, on Proceed, injects the selected container into the driven session only.

/** match = the selected container is live on the page; missing = no GTM container detected at all;
 *  mismatch = a GTM container is live but not the selected one (a DIFFERENT container is installed). */
export type PreflightDecision = 'match' | 'missing' | 'mismatch';

/** Compare the SELECTED container id to the containers detected live on the page. Case-insensitive and
 *  whitespace-tolerant. `missing` when nothing was detected (so the gate leads with "no container found"
 *  rather than a misleading mismatch); `match` when the selected id is among the live ones; else
 *  `mismatch`. An empty/blank selected id with live containers present is a `mismatch` (we can never
 *  claim a blank selection matches), which the caller guards against by requiring a selected container. */
export function preflightDecision(selected: string, live: readonly string[]): PreflightDecision {
  const want = (selected || '').trim().toUpperCase();
  const ids = live.map((s) => (s || '').trim().toUpperCase()).filter(Boolean);
  if (ids.length === 0) return 'missing';
  return ids.includes(want) ? 'match' : 'mismatch';
}
