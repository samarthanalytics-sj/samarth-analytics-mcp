// Framework-free renderer for the GA4 audit Executive Summary, shared by the renderer (shown via
// dangerouslySetInnerHTML so it picks up the app theme) and the PDF/Word export (the same markup,
// where the CSS-var fallbacks supply print-friendly colours). All dynamic text is HTML-escaped.
//
// Layout follows the "lab report" template: a mono metadata strip, a HERO with the reporting-
// reliability figure as the headline (the honest number leads), the composite DEMOTED to "setup
// completeness - a ceiling, not a grade", and the trust matrix with mono chips. Layout stays
// table-based (never CSS grid) so Word's HTML engine renders the same structure.

import type { Ga4ExecSummaryView, Ga4TrustRowView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// CSS custom property with a print fallback: on-screen the app theme wins; in the export the fallback applies.
const v = (token: string, fallback: string): string => `var(${token}, ${fallback})`;
const TEXT = v('--text', '#17191D');
const MUTED = v('--text-muted', '#5B6069');
const FAINT = v('--text-faint', '#8A8F98');
const SURFACE = v('--surface', '#FFFFFF');
const BORDER = v('--border', '#E3E3DC');
const GREEN = v('--c-green', '#1E7A48');
const RED = v('--c-red', '#A63527');
const AMBER = v('--c-amber', '#9A6206');
const MONO = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

/** Mono uppercase eyebrow — the template's section voice. */
const eyebrow = (t: string, margin = '0 0 10px'): string =>
  `<div style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:${FAINT};margin:${margin}">${esc(t)}</div>`;
const panel = (inner: string, pad = '22px 24px'): string =>
  `<div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:4px;padding:${pad};box-sizing:border-box">${inner}</div>`;
const cardTd = (c: string): string => `<td style="width:50%;vertical-align:top;padding:6px">${c}</td>`;
const innerCard = (t: string, body: string): string =>
  `<div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:4px;padding:16px 18px;height:100%;box-sizing:border-box">${eyebrow(t, '0 0 8px')}${body}</div>`;

export function execSummaryHtml(x: Ga4ExecSummaryView): string {
  // Bands match the pass-gated scale's reachable range (a clean production property tops out near
  // ~45 — collection is at most Partial via the Admin API and consent is never readable).
  const relColor = x.reliabilityPct >= 45 ? GREEN : x.reliabilityPct >= 20 ? AMBER : RED;

  // ── Lab-report metadata strip ──
  const metaItem = (k: string, val: string): string =>
    `<span style="margin-right:22px;white-space:nowrap"><b style="color:${TEXT};font-weight:600">${esc(k)}</b> ${esc(val)}</span>`;
  const meta =
    `<div style="font-family:${MONO};font-size:11.5px;color:${MUTED};letter-spacing:.02em;border-bottom:1px solid ${BORDER};padding-bottom:14px;margin-bottom:26px;line-height:2">` +
    metaItem('Property', `${x.propertyName} (${x.propertyId})`) +
    metaItem('Audit', x.auditId) +
    metaItem('Window', x.dateRange) +
    metaItem('Read-only', 'Admin + Data API') +
    `</div>`;

  // ── HERO: the honest number leads ──
  const hero = panel(
    eyebrow('Can you quote this data today') +
      `<div style="font-family:${MONO};color:${relColor};font-size:72px;line-height:.95;font-weight:600;letter-spacing:-.03em;margin:2px 0 0">${x.reliabilityPct}%</div>` +
      `<div style="font-size:16px;color:${TEXT};margin:12px 0 0;max-width:52ch"><b style="font-weight:600">${esc(x.reliabilityConfidence)}.</b> This share of the property's data is verified safe to quote downstream today; the rest is unconfirmed.</div>` +
      `<div style="font-size:14px;color:${MUTED};margin:12px 0 0;max-width:64ch"><b style="color:${TEXT};font-weight:600">Overall verdict:</b> ${esc(x.verdict)}</div>` +
      `<div style="font-size:12.5px;color:${MUTED};margin:10px 0 0"><b style="color:${TEXT};font-weight:600">Audit window:</b> ${esc(x.dateRange)}</div>`,
    '26px 26px',
  );

  // ── Biggest risk / highest-impact fix (2-wide via a table so Word keeps the columns) ──
  const riskFix =
    `<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;margin-top:8px;table-layout:fixed"><tbody><tr>` +
    cardTd(innerCard('Biggest risk', `<div style="font-size:14px;line-height:1.5;color:${TEXT}">${esc(x.biggestRisk)}</div>`)) +
    cardTd(innerCard('Highest-impact fix', `<div style="font-size:14px;line-height:1.5;color:${TEXT}">${esc(x.highestImpactFix)}</div>`)) +
    `</tr></tbody></table>`;

  // ── Demoted composite: setup completeness, read as a ceiling ──
  const th = `style="text-align:left;font-family:${MONO};font-size:10.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};padding:0 8px 8px 0;border-bottom:1px solid ${BORDER}"`;
  const td = `style="padding:9px 8px 9px 0;border-bottom:1px solid ${BORDER};font-size:13.5px;color:${TEXT};vertical-align:top"`;
  const tdNum = `style="padding:9px 8px 9px 0;border-bottom:1px solid ${BORDER};font-size:13.5px;color:${TEXT};vertical-align:top;font-family:${MONO};white-space:nowrap"`;

  const anyNotVerified = x.categories.some((c) => c.subscore === null);
  const scoreRows = x.categories
    .map((c) => {
      const sub = c.subscore === null ? 'Not Verified' : `${c.subscore}/100`;
      const contrib = c.subscore === null ? '—' : `+${c.contribution.toFixed(1)}`;
      // Effective weight = the renormalised share this category actually carries in the composite
      // (a Not-Verified category carries none — its weight is redistributed, never scored 50 or 100).
      const effW = c.subscore === null ? 'excluded' : `${(c.effectiveWeight * 100).toFixed(0)}%`;
      return `<tr><td ${td}>${esc(c.name)}</td><td ${tdNum}><b>${esc(sub)}</b></td><td ${tdNum}>${c.weight}%</td><td ${tdNum}>${esc(effW)}</td><td ${tdNum}>${esc(contrib)}</td></tr>`;
    })
    .join('');
  const compositeRow = `<tr><td ${td}><b>COMPOSITE</b></td><td ${tdNum}><b>${x.composite ?? '—'}/100</b></td><td ${tdNum}><b>100%</b></td><td ${tdNum}><b>100%</b></td><td ${tdNum}><b>${x.composite ?? '—'}</b></td></tr>`;
  const composite = panel(
    `<h3 style="margin:0 0 4px;font-size:15px;font-weight:600;color:${TEXT}">Setup completeness: ${x.composite ?? '—'} / 100 (Grade ${esc(x.grade)}) — read as a ceiling, not a grade</h3>` +
      `<p style="margin:0 0 14px;font-size:13.5px;color:${MUTED};max-width:70ch">The composite measures how complete the configuration is, not whether the numbers are true. The reliability figure above is the honest headline; this is the ceiling it can reach once the unverified checks run.</p>` +
      `<table style="border-collapse:collapse;width:100%">` +
      `<thead><tr><th ${th}>Category</th><th ${th}>Subscore</th><th ${th}>Weight</th><th ${th}>Eff. weight</th><th ${th}>Contribution</th></tr></thead>` +
      `<tbody>${scoreRows}${compositeRow}</tbody></table>` +
      (anyNotVerified
        ? `<div style="font-size:11.5px;color:${MUTED};margin-top:8px">Not Verified categories are excluded from the composite — never scored 50 or 100 — and their weight is redistributed over the verified categories (the “Eff. weight” column).</div>`
        : '') +
      `<div style="font-size:11px;color:${FAINT};margin-top:6px">Contribution = subscore × weight, renormalised over verified categories. The number is computed by rule, never judged.</div>`,
  );

  // ── Trust matrix: mono chips; SAFE only when every gating check passed ──
  const chip = (verdict: Ga4TrustRowView['verdict']): string => {
    const solid = (bg: string, txt: string): string =>
      `<span style="display:inline-block;white-space:nowrap;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:3px;background:${bg};color:#fff">${txt}</span>`;
    if (verdict === 'safe') return solid(GREEN, 'SAFE TO QUOTE');
    if (verdict === 'caution') return solid(AMBER, 'QUOTE WITH CAUTION');
    if (verdict === 'do_not_quote') return solid(RED, 'DO NOT QUOTE');
    return `<span style="display:inline-block;white-space:nowrap;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:3px;border:1px solid ${BORDER};color:${MUTED}">UNVERIFIED</span>`;
  };
  const mtd = (extra = ''): string => `style="padding:13px 16px;border-bottom:1px solid ${BORDER};vertical-align:top${extra}"`;
  const trustRows = x.trust
    .map(
      (t, i) =>
        `<tr><td ${mtd(i === x.trust.length - 1 ? ';border-bottom:0' : '')}><div style="font-weight:600;font-size:14.5px;color:${TEXT}">${esc(t.metric)}</div><div style="font-size:13px;color:${MUTED};margin-top:3px;max-width:62ch">${esc(t.reason)}</div></td>` +
        `<td ${mtd(`;white-space:nowrap;text-align:right${i === x.trust.length - 1 ? ';border-bottom:0' : ''}`)}>${chip(t.verdict)}</td></tr>`,
    )
    .join('');
  const trustMatrix =
    `<h2 style="font-size:21px;font-weight:600;letter-spacing:-.01em;margin:34px 0 4px;color:${TEXT}">What you can quote, and what you cannot</h2>` +
    `<p style="margin:0 0 14px;font-size:14px;color:${MUTED};max-width:70ch">An unrun check cannot make a metric safe — SAFE means every gating check passed.</p>` +
    `<div style="border:1px solid ${BORDER};border-radius:4px;overflow:hidden;background:${SURFACE}"><table style="border-collapse:collapse;width:100%">${trustRows}</table></div>`;

  return (
    `<section style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};line-height:1.5">` +
    eyebrow('Section 1 · Executive Summary', '0 0 4px') +
    `<h1 style="font-size:24px;font-weight:600;letter-spacing:-.01em;margin:0 0 14px;color:${TEXT}">Executive Summary</h1>` +
    meta +
    hero +
    riskFix +
    `<div style="height:14px"></div>` +
    composite +
    trustMatrix +
    `</section>`
  ).replace(/—/g, '-'); // house style: no em dashes in the report
}
