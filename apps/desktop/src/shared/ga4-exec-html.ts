// Framework-free renderer for the GA4 audit Executive Summary, shared by the renderer (shown via
// dangerouslySetInnerHTML so it picks up the app theme) and the PDF/Word export (the same markup,
// where the CSS-var fallbacks supply print-friendly colours). All dynamic text is HTML-escaped.

import type { Ga4ExecSummaryView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// CSS custom property with a print fallback: on-screen the app theme wins; in the export the fallback applies.
const v = (token: string, fallback: string): string => `var(${token}, ${fallback})`;
const TEXT = v('--text', '#1a1a1a');
const MUTED = v('--text-muted', '#5b6472');
const FAINT = v('--text-faint', '#8a93a0');
const SURFACE = v('--surface', '#ffffff');
const BORDER = v('--border', '#e3e6ea');
const BLUE = v('--c-blue', '#2563eb');
const GREEN = v('--c-green', '#16a34a');
const GREEN_BG = v('--c-green-bg', '#dcfce7');
const RED = v('--c-red', '#dc2626');
const RED_BG = v('--c-red-bg', '#fee2e2');
const AMBER = v('--c-amber', '#d97706');

const label = (t: string): string =>
  `<div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${FAINT};margin-bottom:6px">${esc(t)}</div>`;
const card = (inner: string): string =>
  `<div style="border:1px solid ${BORDER};border-radius:10px;padding:14px 16px;background:${SURFACE};height:100%;box-sizing:border-box">${inner}</div>`;
// One card in a 2-wide table row (td padding supplies the inter-card gap).
const cardTd = (c: string): string => `<td style="width:50%;vertical-align:top;padding:6px">${c}</td>`;

export function execSummaryHtml(x: Ga4ExecSummaryView): string {
  const relColor = x.reliabilityPct >= 75 ? GREEN : x.reliabilityPct >= 45 ? AMBER : RED;

  const verdictCard = card(label('Overall verdict') + `<div style="font-size:16px;font-weight:600;line-height:1.4;color:${TEXT}">${esc(x.verdict)}</div>`);
  const reliabilityCard = card(
    label('Reporting reliability') +
      `<div style="font-size:42px;font-weight:800;line-height:1;color:${relColor}">${x.reliabilityPct}%</div>` +
      `<div style="font-size:12px;color:${MUTED};margin-top:6px">${esc(x.reliabilityConfidence)}. How much of the data on this property can be trusted for downstream reporting today.</div>`,
  );
  const riskCard = card(label('Biggest risk') + `<div style="font-size:14px;line-height:1.45;color:${TEXT}">${esc(x.biggestRisk)}</div>`);
  const fixCard = card(label('Highest-impact fix') + `<div style="font-size:14px;line-height:1.45;color:${TEXT}">${esc(x.highestImpactFix)}</div>`);

  const th = `style="text-align:left;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${FAINT};padding:6px 10px;border-bottom:2px solid ${BORDER}"`;
  const td = `style="padding:7px 10px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};vertical-align:top"`;

  const scoreRows = x.categories
    .map((c) => {
      const sub = c.subscore === null ? 'Not Verified' : `${c.subscore}/100`;
      const contrib = c.subscore === null ? '—' : `+${c.contribution.toFixed(1)}`;
      return `<tr><td ${td}>${esc(c.name)}</td><td ${td}><b>${esc(sub)}</b></td><td ${td}>${c.weight}%</td><td ${td}>${esc(contrib)}</td></tr>`;
    })
    .join('');
  const compositeRow = `<tr><td ${td}><b>COMPOSITE</b></td><td ${td}><b>${x.composite ?? '—'}/100</b></td><td ${td}><b>100%</b></td><td ${td}><b>${x.composite ?? '—'}</b></td></tr>`;
  const scorecard =
    `<table style="border-collapse:collapse;width:100%;margin-top:8px">` +
    `<thead><tr><th ${th}>Category</th><th ${th}>Subscore</th><th ${th}>Weight</th><th ${th}>Contribution</th></tr></thead>` +
    `<tbody>${scoreRows}${compositeRow}</tbody></table>`;

  const badge = (safe: boolean): string => {
    const [bg, fg, txt] = safe ? [GREEN_BG, GREEN, 'SAFE TO QUOTE'] : [RED_BG, RED, 'DO NOT QUOTE'];
    return `<span style="display:inline-block;white-space:nowrap;font-size:10.5px;font-weight:700;letter-spacing:.4px;padding:3px 9px;border-radius:999px;background:${bg};color:${fg}">${txt}</span>`;
  };
  const trustRows = x.trust
    .map(
      (t) =>
        `<tr><td ${td}><b>${esc(t.metric)}</b></td><td ${td}>${badge(t.safe)}</td><td ${td}>${esc(t.reason)}</td></tr>`,
    )
    .join('');
  const trustMatrix =
    `<table style="border-collapse:collapse;width:100%;margin-top:8px">` +
    `<thead><tr><th ${th}>Metric</th><th ${th}>Quote?</th><th ${th}>Why</th></tr></thead>` +
    `<tbody>${trustRows}</tbody></table>`;

  const sectionHead = (t: string): string =>
    `<div style="font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:${BLUE};margin:22px 0 2px">${esc(t)}</div>`;

  return (
    `<section style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};line-height:1.5">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${BLUE}">Section 1 · Executive Summary</div>` +
    `<h1 style="font-size:26px;margin:4px 0 2px;color:${TEXT}">Executive Summary</h1>` +
    `<div style="font-size:13px;color:${MUTED};margin-bottom:6px">${esc(x.propertyName)} (${esc(x.propertyId)}) · Audit ${esc(x.auditId)} · Reliability score ${x.composite ?? '—'}/100 (Grade ${esc(x.grade)})</div>` +
    // 2×2 cards via a <table> (not CSS grid) so Word's HTML engine — which ignores display:grid —
    // still renders two columns; Chromium (PDF + on-screen) renders it identically.
    `<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;margin-top:8px;table-layout:fixed"><tbody>` +
    `<tr>${cardTd(verdictCard)}${cardTd(reliabilityCard)}</tr>` +
    `<tr>${cardTd(riskCard)}${cardTd(fixCard)}</tr>` +
    `</tbody></table>` +
    sectionHead('Per-category scorecard · how the composite is computed') +
    scorecard +
    `<div style="font-size:11px;color:${FAINT};margin-top:6px">Contribution = subscore × weight, renormalised over verified categories; Not-Verified categories are excluded and their weight redistributed. The number is computed by rule, never judged.</div>` +
    sectionHead('Data trust matrix · what to quote from this audit') +
    trustMatrix +
    `</section>`
  ).replace(/—/g, '-'); // house style: no em dashes in the report
}
