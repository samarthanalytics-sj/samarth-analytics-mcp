// Styled HTML for the GTM container-audit PDF export — mirrors the audit panel's UI: one severity-
// coloured card per finding with the vendor icon, the tag name, the blue tag-type label, the message,
// and the recommendation box, under a proper report header (scope, generated time, severity summary).
// Pure string building (no I/O, no DOM) so it is unit-testable and safe to run in the main process.

import type { AuditReportView, AuditFindingView } from './ipc';
import { detectTagBrand, tagBrandSvg, gtmTypeLabel } from './tag-brand';

export interface GtmAuditHtmlMeta {
  account?: string;
  container?: string;
  workspace?: string;
  generatedAt?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Print-safe (light) severity palette: pill fg/bg + the card's left accent.
const SEV: Record<string, { fg: string; bg: string; bar: string; label: string }> = {
  critical: { fg: '#b91c1c', bg: '#fee2e2', bar: '#dc2626', label: 'CRITICAL' },
  high: { fg: '#c2410c', bg: '#ffedd5', bar: '#ea580c', label: 'HIGH' },
  medium: { fg: '#a16207', bg: '#fef3c7', bar: '#d97706', label: 'MEDIUM' },
  low: { fg: '#1d4ed8', bg: '#dbeafe', bar: '#3b82f6', label: 'LOW' },
  info: { fg: '#4b5563', bg: '#f3f4f6', bar: '#9ca3af', label: 'INFO' },
};
const sevOf = (s: string): (typeof SEV)[string] => SEV[s] ?? SEV.info;

const badge = (sev: string): string => {
  const s = sevOf(sev);
  return `<span style="display:inline-block;flex-shrink:0;font-size:10px;font-weight:700;letter-spacing:.5px;padding:3px 9px;border-radius:999px;background:${s.bg};color:${s.fg};margin-top:2px">${s.label}</span>`;
};

function findingCard(f: AuditFindingView): string {
  const s = sevOf(f.severity);
  const isTag = f.resource?.kind === 'tag';
  const icon = isTag ? `${tagBrandSvg(detectTagBrand(f.resource?.type, f.resource?.name), 14)} ` : '';
  const typeLabel = f.resource
    ? isTag && f.resource.type
      ? gtmTypeLabel(f.resource.type)
      : f.resource.kind
    : f.category;
  const title = f.resource ? `${icon}<span style="font-weight:700;color:#1a1a1a">${esc(f.resource.name)}</span>` : icon;
  return (
    `<div style="border:1px solid #e5e7eb;border-left:4px solid ${s.bar};border-radius:8px;padding:11px 14px;margin:10px 0;page-break-inside:avoid">` +
    `<div style="display:flex;align-items:flex-start;gap:10px">` +
    badge(f.severity) +
    `<div style="flex:1;min-width:0">` +
    `<div style="font-size:13.5px;line-height:1.4">${title} <span style="font-weight:700;color:#2563eb;font-size:11.5px">(${esc(typeLabel)})</span></div>` +
    `<div style="font-size:12.5px;color:#374151;margin-top:4px;line-height:1.5">${esc(f.message)}</div>` +
    (f.recommendation
      ? `<div style="font-size:12px;color:#374151;background:#f8fafc;border:1px solid #eef2f7;border-radius:6px;padding:7px 10px;margin-top:7px;line-height:1.5">${esc(f.recommendation)}</div>`
      : '') +
    `</div></div></div>`
  );
}

/** The full styled report body (header + summary + one card per finding), ready to hand to
 *  reportHtmlDocument() as `execHtml`. Mirrors what the audit panel shows on screen. */
export function gtmAuditHtml(report: AuditReportView, meta: GtmAuditHtmlMeta = {}): string {
  const parts: string[] = [];

  // ── Header: title + scope + generated time ──
  parts.push(`<h1 style="font-size:24px;font-weight:700;border-bottom:2px solid #2563eb;padding-bottom:7px;margin:0 0 6px">GTM Container Audit${meta.container ? ` — ${esc(meta.container)}` : ''}</h1>`);
  const scope: string[] = [];
  if (meta.account) scope.push(`<b>Account:</b> ${esc(meta.account)}`);
  if (meta.container) scope.push(`<b>Container:</b> ${esc(meta.container)}`);
  if (meta.workspace) scope.push(`<b>Workspace:</b> ${esc(meta.workspace)}`);
  if (meta.generatedAt) scope.push(`<b>Generated:</b> ${esc(meta.generatedAt)}`);
  if (scope.length) parts.push(`<div style="font-size:12.5px;color:#4b5563;margin:0 0 12px">${scope.join(' &nbsp;·&nbsp; ')}</div>`);

  // ── Summary strip: severity pills + what was scanned ──
  const sevOrder: Array<keyof AuditReportView['summary']> = ['critical', 'high', 'medium', 'low', 'info'];
  const pills = sevOrder
    .filter((k) => (report.summary[k] ?? 0) > 0)
    .map((k) => {
      const s = sevOf(k);
      return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:3px 11px;border-radius:999px;background:${s.bg};color:${s.fg}">${report.summary[k]} ${s.label.toLowerCase()}</span>`;
    })
    .join(' ');
  parts.push(
    `<div style="border:1px solid #e5e7eb;border-radius:8px;background:#f8fafc;padding:10px 14px;margin:0 0 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">` +
      `<span style="font-size:13px;font-weight:700;color:#1a1a1a">${report.counts.findings} finding${report.counts.findings === 1 ? '' : 's'}</span>` +
      (pills ? `<span style="display:inline-flex;gap:6px;flex-wrap:wrap">${pills}</span>` : '') +
      `<span style="flex:1"></span>` +
      `<span style="font-size:11.5px;color:#6b7280">Scanned ${report.counts.tags} tags · ${report.counts.triggers} triggers · ${report.counts.variables} variables</span>` +
      `</div>`
  );

  // ── Findings, in the panel's order (worst first) ──
  if (!report.findings.length) {
    parts.push(`<div style="border:1px solid #d1fae5;border-radius:8px;background:#ecfdf5;color:#065f46;padding:12px 14px;font-size:13px">No findings — this workspace looks clean.</div>`);
  } else {
    for (const f of report.findings) parts.push(findingCard(f));
  }

  parts.push(`<div style="font-size:11px;color:#9ca3af;margin-top:16px">Read-only audit — apply fixes from the app or in Google Tag Manager; nothing was changed or published.</div>`);
  return parts.join('\n');
}
