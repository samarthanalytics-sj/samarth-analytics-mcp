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
check('exact match', preflightDecision('GTM-TCZW2WCF', ['GTM-TCZW2WCF']) === 'match');
check('match among several live containers', preflightDecision('GTM-TCZW2WCF', ['GTM-TG6Q92', 'GTM-TCZW2WCF']) === 'match');
check('match is case-insensitive (selected lower)', preflightDecision('gtm-tczw2wcf', ['GTM-TCZW2WCF']) === 'match');
check('match is case-insensitive (live lower)', preflightDecision('GTM-TCZW2WCF', ['gtm-tczw2wcf']) === 'match');
check('match tolerates surrounding whitespace', preflightDecision('  GTM-TCZW2WCF  ', [' GTM-TCZW2WCF ']) === 'match');

// ── mismatch (the ChowNow case: selected is NOT the one live) ───────────────────
check('mismatch: a single DIFFERENT container is live', preflightDecision('GTM-TCZW2WCF', ['GTM-TG6Q92']) === 'mismatch');
check('mismatch: multiple live, selected absent', preflightDecision('GTM-TCZW2WCF', ['GTM-TG6Q92', 'GTM-ABC1234']) === 'mismatch');
check('mismatch: blank selected but a container is live (never claim a blank matches)', preflightDecision('', ['GTM-TG6Q92']) === 'mismatch');
check('mismatch: whitespace-only selected with a live container', preflightDecision('   ', ['GTM-TG6Q92']) === 'mismatch');

// ── missing (no container detected) ─────────────────────────────────────────────
check('missing: empty live list', preflightDecision('GTM-TCZW2WCF', []) === 'missing');
check('missing beats mismatch when nothing is live (even if selected blank)', preflightDecision('', []) === 'missing');
check('missing: live list of only blanks is treated as none', preflightDecision('GTM-TCZW2WCF', ['', '  ']) === 'missing');

console.log(`\ncontainer-preflight: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
