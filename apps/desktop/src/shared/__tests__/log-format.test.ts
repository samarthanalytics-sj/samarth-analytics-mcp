// Run: tsx apps/desktop/src/shared/__tests__/log-format.test.ts
import { toTerminalSafe, installReadableConsole } from '../log-format';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; fails.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── toTerminalSafe ──
check('arrow -> ascii', toTerminalSafe('[tool] → create_gtm_tag') === '[tool] -> create_gtm_tag');
check('check mark -> [ok]', toTerminalSafe('[tool] ✓ done') === '[tool] [ok] done');
check('cross -> [x]', toTerminalSafe('[tool] ✗ FAILED') === '[tool] [x] FAILED');
check('middle dot -> hyphen', toTerminalSafe('65 tags · 65 triggers') === '65 tags - 65 triggers');
check('em/en dash -> hyphen', toTerminalSafe('a — b – c') === 'a - b - c');
check('ellipsis -> three dots', toTerminalSafe('Thinking…') === 'Thinking...');
check('plain ascii is untouched', toTerminalSafe('[chat] step 1 ok') === '[chat] step 1 ok');
check('the exact mojibake glyphs no longer appear', !/[→✓✗·—…]/.test(toTerminalSafe('→✓✗·—…')));

// ── installReadableConsole: transliterate + collapse consecutive duplicates ──
{
  const out: string[] = [];
  const fake = {
    log: (...a: unknown[]) => out.push(a.join(' ')),
    error: (...a: unknown[]) => out.push(a.join(' ')),
    warn: (...a: unknown[]) => out.push(a.join(' ')),
    info: (...a: unknown[]) => out.push(a.join(' ')),
  };
  const restore = installReadableConsole(fake);
  fake.error('[tool] → create ✓');
  fake.error('[gtm-containers] 9 containers');
  fake.error('[gtm-containers] 9 containers');
  fake.error('[gtm-containers] 9 containers');
  fake.error('[chat] done');
  restore();
  fake.error('after restore ✓'); // restored: not transliterated by our wrapper

  check('glyphs are transliterated through the wrapper', out[0] === '[tool] -> create [ok]');
  check('a run of identical lines prints ONCE', out[1] === '[gtm-containers] 9 containers' && out[2] !== '[gtm-containers] 9 containers');
  check('the collapse marker reports the repeat count', out[2] === '  (last line repeated 2x)');
  check('the next distinct line prints normally', out[3] === '[chat] done');
  check('restore() puts the original console back', out[out.length - 1] === 'after restore ✓');
}

console.log(`\nlog-format: ${passed} passed, ${failed} failed`);
if (failed) { console.error(fails.join('\n')); process.exit(1); }
if (passed < 13) { console.error(`expected >= 13 checks, got ${passed}`); process.exit(1); }
