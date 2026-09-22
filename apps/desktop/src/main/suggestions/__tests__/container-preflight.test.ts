// Pure tests for the container PREFLIGHT decision (no browser).
// Run: tsx apps/desktop/src/main/suggestions/__tests__/container-preflight.test.ts

import { preflightDecision } from '../container-preflight';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── match ────────────────────────────────────────────────────────────────────
check('exact match', preflightDecision('GTM-EXAMPLE2', ['GTM-EXAMPLE2']) === 'match');
check('match among several live containers', preflightDecision('GTM-EXAMPLE2', ['GTM-OTHER1', 'GTM-EXAMPLE2']) === 'match');
check('match is case-insensitive (selected lower)', preflightDecision('gtm-example2', ['GTM-EXAMPLE2']) === 'match');
check('match is case-insensitive (live lower)', preflightDecision('GTM-EXAMPLE2', ['gtm-example2']) === 'match');
check('match tolerates surrounding whitespace', preflightDecision('  GTM-EXAMPLE2  ', [' GTM-EXAMPLE2 ']) === 'match');

// ── mismatch (the ChewBox case: selected is NOT the one live) ───────────────────
check('mismatch: a single DIFFERENT container is live', preflightDecision('GTM-EXAMPLE2', ['GTM-OTHER1']) === 'mismatch');
check('mismatch: multiple live, selected absent', preflightDecision('GTM-EXAMPLE2', ['GTM-OTHER1', 'GTM-ABC1234']) === 'mismatch');
check('mismatch: blank selected but a container is live (never claim a blank matches)', preflightDecision('', ['GTM-OTHER1']) === 'mismatch');
check('mismatch: whitespace-only selected with a live container', preflightDecision('   ', ['GTM-OTHER1']) === 'mismatch');

// ── missing (no container detected) ─────────────────────────────────────────────
check('missing: empty live list', preflightDecision('GTM-EXAMPLE2', []) === 'missing');
check('missing beats mismatch when nothing is live (even if selected blank)', preflightDecision('', []) === 'missing');
check('missing: live list of only blanks is treated as none', preflightDecision('GTM-EXAMPLE2', ['', '  ']) === 'missing');

console.log(`\ncontainer-preflight: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
