/** Human-readable secondary formatter (JSON stays the primary output). */

import type { CheckResult, Status, VerifyReport } from '../types.js';

const ICON: Record<Status, string> = {
  Pass: 'PASS',
  Partial: 'PART',
  Fail: 'FAIL',
  'Not Verified': 'N/V ',
};

function line(r: CheckResult): string {
  const head = `  [${ICON[r.status]}] ${r.id} (${r.type})`;
  return r.reason ? `${head}\n         ${r.reason}` : head;
}

/** Render a report as a compact text summary. */
export function formatHuman(report: VerifyReport): string {
  const counts: Record<Status, number> = { Pass: 0, Partial: 0, Fail: 0, 'Not Verified': 0 };
  for (const c of report.checks) counts[c.status] += 1;

  const out: string[] = [];
  out.push(`Tag Verification — ${report.url}`);
  out.push(`engine ${report.engineVersion}  spec ${report.specHash.slice(0, 12)}…`);
  out.push(`OVERALL: ${report.overall}   (Pass ${counts.Pass} · Partial ${counts.Partial} · Fail ${counts.Fail} · Not Verified ${counts['Not Verified']})`);
  out.push('');
  for (const c of report.checks) out.push(line(c));
  if (report.notes && report.notes.length > 0) {
    out.push('');
    out.push('notes:');
    for (const n of report.notes) out.push(`  - ${n}`);
  }
  return out.join('\n');
}
