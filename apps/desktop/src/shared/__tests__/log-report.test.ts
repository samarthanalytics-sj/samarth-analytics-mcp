// Run: tsx apps/desktop/src/shared/__tests__/log-report.test.ts
import { banner, section, logLine, LogTally, RULE } from '../log-report';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1;
  else { failed += 1; fails.push(`x ${name}${detail ? ' - ' + detail : ''}`); }
}

// ── banner ──
{
  const b = banner('App', [['Version', 'v1'], ['Environment', 'Development']]);
  const lines = b.split('\n');
  check('banner opens and closes with the rule', lines[0] === RULE && lines[lines.length - 1] === RULE);
  check('banner shows the title', lines[1] === 'App');
  check('banner aligns Key : Value rows', lines[2] === 'Version     : v1' && lines[3] === 'Environment : Development');
  check('a banner with no rows is just title in a frame', banner('Only').split('\n').length === 3);
}

// ── section ──
check('section frames the title', section('System') === `${RULE}\nSystem\n${RULE}`);

// ── logLine ──
check('a bare level line', logLine('SUCCESS', 'Done') === '[SUCCESS] Done');
check('a level line with indented details', logLine('INFO', 'Platform', ['Node 22', 'Electron 30']) === '[INFO] Platform\n  Node 22\n  Electron 30');
check('every level renders its tag', ['INFO', 'SUCCESS', 'WARNING', 'ERROR'].every((l) => logLine(l as never, 'x').startsWith(`[${l}]`)));

// ── LogTally ──
{
  const t = new LogTally();
  t.note('SUCCESS'); t.note('SUCCESS'); t.note('WARNING'); t.note('INFO');
  check('counts per level', t.count('SUCCESS') === 2 && t.count('WARNING') === 1 && t.count('ERROR') === 0);
  const s = t.summary(['[ok] Build successful', '[ok] Ready']);
  check('summary lists the status checklist', s.includes('[ok] Build successful') && s.includes('[ok] Ready'));
  check('summary shows per-level counts', s.includes('SUCCESS : 2') && s.includes('WARNING : 1') && s.includes('ERROR   : 0'));
  check('summary is framed by the rule', s.startsWith(RULE) && s.endsWith(RULE));
}

console.log(`\nlog-report: ${passed} passed, ${failed} failed`);
if (failed) { console.error(fails.join('\n')); process.exit(1); }
if (passed < 12) { console.error(`expected >= 12 checks, got ${passed}`); process.exit(1); }
