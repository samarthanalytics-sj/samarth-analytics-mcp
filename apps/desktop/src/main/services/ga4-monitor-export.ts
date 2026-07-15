// GA4 monitoring report exports: the SAME latest run the tab shows, as a spreadsheet-ready CSV or a
// print-styled HTML document (the IPC layer turns the HTML into a PDF via Electron printToPDF, the
// same pipeline as the audit exports). Pure and Electron-free so both builders are unit-testable.

import type { Ga4MonitorRun } from '../../shared/ipc';

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CHECK_LABELS: Record<string, string> = { pass: 'Pass', warn: 'Warning', fail: 'Failing', skip: 'Not checked' };
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const fmtWhen = (at: number): string =>
  new Date(at).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One CSV with a metadata preamble, then a flat row per check and per alert. Alerts carry BOTH
 *  voices: the plain consequence line in "What we found", the analyst prose in "Technical detail". */
import { plainDashes } from '../google/gtm-builders';

export function monitorRunToCsv(run: Ga4MonitorRun): string {
  const lines: string[] = [];
  lines.push(['GA4 monitoring report', run.propertyLabel].map(csvCell).join(','));
  lines.push(['Property ID', run.property.replace(/^properties\//, '')].map(csvCell).join(','));
  if (run.timeZone) lines.push(['Reporting timezone', run.timeZone].map(csvCell).join(','));
  lines.push(['Checked at', fmtWhen(run.at)].map(csvCell).join(','));
  lines.push(['Health', cap(run.health)].map(csvCell).join(','));
  lines.push(['Summary', run.summary].map(csvCell).join(','));
  lines.push('');
  lines.push(['Type', 'Status', 'Name', 'What we found', 'Technical detail', 'Recommendation'].join(','));
  for (const a of run.alerts) {
    lines.push(['Alert', cap(a.severity), a.title, a.plain ?? a.detail, a.detail, a.actions?.[0] ?? a.recommendation ?? ''].map(csvCell).join(','));
  }
  for (const c of run.checks) {
    lines.push(['Check', CHECK_LABELS[c.status] ?? c.status, c.label, c.detail, '', ''].map(csvCell).join(','));
  }
  return plainDashes(lines.join('\r\n') + '\r\n');
}

const escHtml = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SEV_COLOR: Record<string, string> = { critical: '#dc2626', high: '#dc2626', medium: '#b45309', low: '#475569', info: '#475569' };
const STATUS_COLOR: Record<string, string> = { pass: '#15803d', warn: '#b45309', fail: '#dc2626', skip: '#64748b' };

/** The run as a self-contained print-styled HTML document (light theme, no scripts). Mirrors the
 *  tab: health verdict up top, each alert with the plain consequence lead + the technical detail
 *  underneath, then the full health-check table so coverage is visible, not only problems. */
export function monitorRunToHtml(run: Ga4MonitorRun): string {
  return plainDashes(monitorRunToHtmlRaw(run));
}

function monitorRunToHtmlRaw(run: Ga4MonitorRun): string {
  const pid = run.property.replace(/^properties\//, '');
  const healthColor = run.health === 'critical' ? '#dc2626' : run.health === 'warning' ? '#b45309' : '#15803d';
  const alertBlocks = run.alerts
    .map((a) => {
      const parts: string[] = [];
      parts.push(`<div class="sev" style="color:${SEV_COLOR[a.severity] ?? '#475569'}">${escHtml(cap(a.severity))}</div>`);
      parts.push(`<div class="lead">${escHtml(a.plain ?? a.title)}</div>`);
      if (a.plain) parts.push(`<div class="tech"><b>${escHtml(a.title)}.</b> ${escHtml(a.detail)}</div>`);
      else parts.push(`<div class="tech">${escHtml(a.detail)}</div>`);
      if (a.summaryLines?.length) parts.push(`<div class="lines">${a.summaryLines.map((l) => escHtml(l)).join('<br/>')}</div>`);
      if (a.impact) parts.push(`<div class="kv"><span>Impact</span>${escHtml(a.impact)}</div>`);
      const actions = a.actions?.length ? a.actions : a.recommendation ? [a.recommendation] : [];
      if (actions.length) parts.push(`<div class="kv"><span>Recommended action</span>${actions.map((x) => escHtml(x)).join('<br/>')}</div>`);
      if (a.actions?.length && a.recommendation) parts.push(`<div class="kv"><span>For whoever fixes it</span>${escHtml(a.recommendation)}</div>`);
      return `<div class="alert">${parts.join('')}</div>`;
    })
    .join('');
  const checkRows = run.checks
    .map(
      (c) =>
        `<tr><td class="st" style="color:${STATUS_COLOR[c.status] ?? '#64748b'}">${escHtml(CHECK_LABELS[c.status] ?? c.status)}</td><td class="ck">${escHtml(c.label)}</td><td>${escHtml(c.detail)}</td></tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escHtml(run.propertyLabel)} - GA4 monitoring</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 36px 44px; font-size: 12.5px; line-height: 1.55; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 26px 0 8px; text-transform: uppercase; letter-spacing: .6px; color: #475569; }
  .meta { color: #64748b; font-size: 11.5px; margin-bottom: 14px; }
  .verdict { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin: 14px 0; }
  .verdict b { color: ${healthColor}; text-transform: uppercase; letter-spacing: .5px; }
  .alert { border: 1px solid #e2e8f0; border-left: 3px solid #cbd5e1; border-radius: 8px; padding: 12px 16px; margin: 10px 0; page-break-inside: avoid; }
  .sev { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
  .lead { font-weight: 600; font-size: 13.5px; margin-bottom: 6px; }
  .tech { color: #475569; margin-bottom: 6px; }
  .lines { font-family: Consolas, monospace; font-size: 12px; background: #f8fafc; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
  .kv { margin-top: 6px; }
  .kv span { display: block; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #64748b; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; color: #64748b; border-bottom: 1px solid #e2e8f0; padding: 6px 10px 6px 0; }
  td { border-bottom: 1px solid #f1f5f9; padding: 7px 10px 7px 0; vertical-align: top; }
  td.st { font-weight: 700; white-space: nowrap; width: 84px; }
  td.ck { font-weight: 600; white-space: nowrap; width: 190px; }
  .foot { margin-top: 26px; color: #94a3b8; font-size: 10.5px; }
</style></head><body>
  <h1>GA4 monitoring report: ${escHtml(run.propertyLabel)}</h1>
  <div class="meta">Property ${escHtml(pid)}${run.timeZone ? ` &middot; reporting timezone ${escHtml(run.timeZone)}` : ''} &middot; checked ${escHtml(fmtWhen(run.at))}</div>
  <div class="verdict"><b>${escHtml(run.health)}</b> - ${escHtml(run.summary)}</div>
  ${run.alerts.length ? `<h2>Open issues (${run.alerts.length})</h2>${alertBlocks}` : '<h2>Open issues</h2><p>None - every check that ran came back clean.</p>'}
  <h2>Health checks (${run.checks.length})</h2>
  <table><thead><tr><th>Status</th><th>Check</th><th>What we found</th></tr></thead><tbody>${checkRows}</tbody></table>
  <div class="foot">Generated by Samarth Analytics GA4 monitoring &middot; daily figures are complete days in the property's reporting timezone; realtime figures are live at check time.</div>
</body></html>`;
}
