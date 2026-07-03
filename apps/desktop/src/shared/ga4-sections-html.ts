// Framework-free renderer for the GA4 audit body sections (2-4 so far), styled as colourful cards to
// match Section 1. Shared by the renderer (dangerouslySetInnerHTML so it themes) and the PDF/Word
// export (CSS-var fallbacks supply print colours). All dynamic text is HTML-escaped; no em dashes.

import type { Ga4SectionsView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const v = (token: string, fallback: string): string => `var(${token}, ${fallback})`;
const TEXT = v('--text', '#1a1a1a');
const MUTED = v('--text-muted', '#5b6472');
const FAINT = v('--text-faint', '#8a93a0');
const SURFACE = v('--surface', '#ffffff');
const BORDER = v('--border', '#e3e6ea');
const BLUE = v('--c-blue', '#2563eb');
const GREEN = v('--c-green', '#16a34a');
const AMBER = v('--c-amber', '#d97706');

// Severity → accent bar colour + badge background.
const SEV: Record<string, { bar: string; bg: string; txt: string }> = {
  critical: { bar: '#dc2626', bg: v('--c-red-bg', '#fef2f2'), txt: 'CRITICAL' },
  high: { bar: '#ea580c', bg: v('--c-amber-bg', '#fff7ed'), txt: 'HIGH' },
  medium: { bar: '#d97706', bg: v('--c-amber-bg', '#fffbeb'), txt: 'MEDIUM' },
  low: { bar: '#2563eb', bg: v('--c-blue-bg', '#eff6ff'), txt: 'LOW' },
  info: { bar: '#64748b', bg: 'rgba(148,163,184,.14)', txt: 'INFO' },
};
const sevOf = (s: string): { bar: string; bg: string; txt: string } => SEV[s] ?? SEV.info;
const badge = (s: { bar: string; bg: string; txt: string }): string =>
  `<span style="display:inline-block;white-space:nowrap;font-size:10px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:999px;background:${s.bg};color:${s.bar}">${s.txt}</span>`;

// Area-status (section 5) chips: a coloured dot + label per coverage status.
const STATUS: Record<string, { dot: string; label: string }> = {
  pass: { dot: '#16a34a', label: 'Pass' },
  partial: { dot: '#d97706', label: 'Partial' },
  fail: { dot: '#dc2626', label: 'Fail' },
  not_verified: { dot: '#94a3b8', label: 'Not Verified' },
};
const statusChip = (key: string): string => {
  const s = STATUS[key] ?? STATUS.not_verified;
  return `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;font-weight:600;color:${TEXT}"><span style="width:9px;height:9px;border-radius:50%;background:${s.dot};display:inline-block;flex:0 0 auto"></span>${s.label}</span>`;
};
// Decision-readiness (section 7) status pill: green when answerable, grey otherwise.
const decisionPill = (status: string): string => {
  const ok = /^answer/i.test(status);
  const c = ok ? GREEN : MUTED;
  const bg = ok ? v('--c-green-bg', '#f0fdf4') : 'rgba(148,163,184,.14)';
  return `<span style="display:inline-block;white-space:nowrap;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${bg};color:${c}">${esc(status)}</span>`;
};
const TH = `style="text-align:left;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${FAINT};padding:6px 10px;border-bottom:2px solid ${BORDER}"`;
const THR = `style="text-align:right;font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${FAINT};padding:6px 10px;border-bottom:2px solid ${BORDER}"`;
const TD = `style="padding:7px 10px;border-bottom:1px solid ${BORDER};font-size:12.5px;color:${TEXT};vertical-align:top"`;
const TDR = `style="padding:7px 10px;border-bottom:1px solid ${BORDER};font-size:12.5px;color:${TEXT};vertical-align:top;text-align:right;font-variant-numeric:tabular-nums"`;
const metaRow = (lbl: string, val: string): string =>
  `<div style="font-size:12.5px;color:${TEXT};margin:3px 0;line-height:1.45"><span style="font-weight:700;color:${MUTED}">${esc(lbl)}:</span> ${esc(val)}</div>`;

const eyebrow = (t: string): string =>
  `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:${BLUE};margin-top:20px">${esc(t)}</div>`;
const h2 = (t: string): string => `<h2 style="font-size:18px;margin:2px 0 6px;color:${TEXT}">${esc(t)}</h2>`;
const card = (inner: string, accent: string): string =>
  `<div style="border:1px solid ${BORDER};border-left:4px solid ${accent};border-radius:10px;padding:12px 14px;background:${SURFACE};margin:6px 0">${inner}</div>`;
const row = (lbl: string, val: string): string =>
  `<div style="font-size:13px;color:${TEXT};margin:4px 0;line-height:1.45"><span style="font-weight:700;color:${MUTED}">${esc(lbl)}:</span> ${esc(val)}</div>`;

// A labelled growth bar (the section-3 "graph"): bar width is |pct| relative to the row set's max.
function growthBar(lbl: string, pct: number | null, maxAbs: number, color: string, unsafe: boolean): string {
  const valTxt = pct === null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct}%${unsafe ? ' *' : ''}`;
  const w = pct === null ? 0 : Math.max(2, Math.round((Math.abs(pct) / maxAbs) * 100));
  return (
    `<div style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12.5px">` +
    `<span style="width:92px;flex:0 0 92px;color:${TEXT}">${esc(lbl)}</span>` +
    `<span style="flex:1;background:rgba(148,163,184,.18);border-radius:5px;height:14px;overflow:hidden"><span style="display:block;height:100%;width:${w}%;background:${color};border-radius:5px"></span></span>` +
    `<span style="width:74px;flex:0 0 74px;text-align:right;color:${MUTED};font-weight:600">${esc(valTxt)}</span>` +
    `</div>`
  );
}

export function ga4SectionsHtml(x: Ga4SectionsView): string {
  // ── Section 2 · What is wrong ──
  let s2 = eyebrow('Section 2') + h2('What is wrong');
  if (x.topFinding) {
    const tf = x.topFinding;
    const sev = sevOf(tf.severity);
    s2 += card(
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">${badge(sev)}<span style="font-weight:700;color:${TEXT};font-size:14px">${esc(tf.area)}</span></div>` +
        `<div style="font-size:14px;font-weight:600;color:${TEXT};margin-bottom:6px;line-height:1.4">${esc(tf.message)}</div>` +
        (tf.evidence ? row('Evidence', tf.evidence) : '') +
        (tf.whyItMatters ? row('Why it matters', tf.whyItMatters) : '') +
        (tf.ifUnconfirmed ? row('If unconfirmed', tf.ifUnconfirmed) : '') +
        (tf.recommendation ? row('Fix', tf.recommendation) : '') +
        (tf.related ? row('Related', tf.related) : ''),
      sev.bar,
    );
  } else if (x.noIssueNote) {
    s2 += card(`<div style="font-size:14px;color:${TEXT}">✅ ${esc(x.noIssueNote)}</div>`, GREEN);
  }

  // ── Section 3 · Outcomes vs traffic ──
  let s3 = eyebrow('Section 3') + h2('Outcomes vs traffic');
  if (x.outcomes) {
    const o = x.outcomes;
    if (o.assessed) {
      const maxAbs = Math.max(1, Math.abs(o.sessionsPct ?? 0), Math.abs(o.keyEventsPct ?? 0), Math.abs(o.revenuePct ?? 0));
      // Verdict-aware caveat from the builder: a FAILED gate reads "not safe to quote"; an
      // UNVERIFIED one reads "confirm before quoting" — never claiming more than the trust matrix.
      const caveat = o.quoteNote ? `<div style="font-size:11.5px;color:${AMBER};margin-top:6px">${esc(o.quoteNote.replace(/—/g, '-'))}</div>` : '';
      s3 += card(
        growthBar('Sessions', o.sessionsPct, maxAbs, BLUE, false) +
          growthBar('Key events', o.keyEventsPct, maxAbs, o.keSafe ? GREEN : AMBER, !o.keSafe) +
          growthBar('Revenue', o.revenuePct, maxAbs, o.revSafe ? GREEN : AMBER, !o.revSafe) +
          `<div style="font-size:13px;color:${TEXT};margin-top:8px;line-height:1.45"><span style="font-weight:700">Read:</span> ${esc(o.read)}</div>` +
          caveat,
        BLUE,
      );
    } else {
      s3 += card(`<div style="font-size:13px;color:${MUTED}">${esc(o.read)}</div>`, BORDER);
    }
    if (o.trendPattern) {
      s3 += `<div style="font-size:12.5px;color:${MUTED};margin:2px 0 0;line-height:1.45"><span style="font-weight:700;color:${TEXT}">Trend pattern:</span> ${esc(o.trendPattern)}</div>`;
    }
  }

  // ── Section 4 · All findings ──
  let s4 = eyebrow('Section 4') + h2('All findings');
  if (!x.findings.length) {
    s4 += card(`<div style="font-size:14px;color:${TEXT}">✅ No config, data-quality or growth issues found for this window.</div>`, GREEN);
  } else {
    s4 += `<div style="font-size:12px;color:${FAINT};margin-bottom:2px">${x.findings.length} item(s) - ${x.actionableCount} to act on, ${x.findings.length - x.actionableCount} advisory. Highest severity first.</div>`;
    s4 += x.findings
      .map((f) => {
        const sev = sevOf(f.severity);
        return card(
          `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${badge(sev)}<span style="font-weight:700;color:${MUTED};font-size:12px">${esc(f.area)}</span></div>` +
            `<div style="font-size:13px;color:${TEXT};margin-bottom:4px;line-height:1.45">${esc(f.message)}</div>` +
            (f.businessRisk && f.businessRisk !== '—' ? `<div style="font-size:12px;color:${MUTED};line-height:1.4"><span style="font-weight:700">Business risk:</span> ${esc(f.businessRisk)}</div>` : '') +
            (f.recommendation && f.recommendation !== '—' ? `<div style="font-size:12px;color:${MUTED};line-height:1.4"><span style="font-weight:700">Fix:</span> ${esc(f.recommendation)}</div>` : ''),
          sev.bar,
        );
      })
      .join('');
  }

  // ── Section 5 · Area status ──
  let s5 = eyebrow('Section 5') + h2('Area status');
  if (x.areas.length) {
    const rows = x.areas
      .map((a) => `<tr><td ${TD}><span style="font-weight:600">${esc(a.area)}</span></td><td ${TD}>${statusChip(a.statusKey)}</td><td ${TD}>${esc(a.confidence)}</td><td ${TD}>${esc(a.evidence)}</td></tr>`)
      .join('');
    s5 +=
      `<div style="border:1px solid ${BORDER};border-radius:10px;background:${SURFACE};overflow:hidden;margin:6px 0">` +
      `<table style="border-collapse:collapse;width:100%"><thead><tr><th ${TH}>Area</th><th ${TH}>Status</th><th ${TH}>Confidence</th><th ${TH}>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ── Section 6 · Property baseline ──
  let s6 = eyebrow('Section 6') + h2('Property baseline');
  if (x.baseline) {
    const b = x.baseline;
    const g = b.growth;
    const growthLine = g
      ? `<div style="font-size:12.5px;color:${TEXT};margin:3px 0"><span style="font-weight:700;color:${MUTED}">Growth signals (vs prior):</span> sessions ${esc(signed(g.sessionsPct))} &middot; key events ${esc(signed(g.keyEventsPct))}${g.keSafe ? '' : ' *'} &middot; revenue ${esc(signed(g.revenuePct))}${g.revSafe ? '' : ' *'}${g.keSafe && g.revSafe ? '' : `<span style="color:${AMBER}"> (* flagged in the data trust matrix)</span>`}</div>`
      : '';
    s6 += card(
      metaRow('Sessions', `${b.sessions} (prior period ${b.priorSessions}${b.trend})`) +
        growthLine +
        metaRow('Peak day', b.peakDay ?? 'Not Verified') +
        metaRow('New vs returning', b.newVsReturning) +
        metaRow('Top markets', b.topMarkets ?? 'Not Verified'),
      BLUE,
    );
  } else {
    s6 += card(`<div style="font-size:13px;color:${MUTED}">Baseline traffic metrics could not be retrieved - Not Verified.</div>`, BORDER);
  }
  // Channel performance table — which channels convert and earn, not just their traffic share.
  if (x.channelPerformance && x.channelPerformance.length) {
    const cRows = x.channelPerformance
      .map(
        (c) =>
          `<tr><td ${TD}><span style="font-weight:600">${esc(c.channel)}</span></td><td ${TDR}>${esc(c.sessions)}</td><td ${TDR}>${esc(c.convRate)}</td><td ${TDR}>${esc(c.revenue)}</td><td ${TDR}>${esc(c.engagement)}</td></tr>`,
      )
      .join('');
    s6 +=
      `<div style="font-size:12px;font-weight:600;color:${MUTED};margin:10px 2px 4px">Channel performance <span style="font-weight:400;color:${FAINT}">(conversion rate and revenue per channel, not just traffic share)</span></div>` +
      `<div style="border:1px solid ${BORDER};border-radius:10px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:420px"><thead><tr><th ${TH}>Channel</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${cRows}</tbody></table></div>`;
  }

  // ── Section 7 · Decision readiness ──
  let s7 = eyebrow('Section 7') + h2('Decision readiness');
  if (x.decisions.length) {
    const rows = x.decisions
      .map((d) => `<tr><td ${TD}><span style="font-weight:600">${esc(d.q)}</span></td><td ${TD}>${decisionPill(d.status)}</td><td ${TD}>${esc(d.note)}</td></tr>`)
      .join('');
    s7 +=
      `<div style="border:1px solid ${BORDER};border-radius:10px;background:${SURFACE};overflow:hidden;margin:6px 0">` +
      `<table style="border-collapse:collapse;width:100%"><thead><tr><th ${TH}>Business question</th><th ${TH}>Status</th><th ${TH}>Missing input</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ── Section 8 · Not verified ──
  let s8 = eyebrow('Section 8') + h2('Not verified');
  const nvItems = x.notVerified.items.map((i) => `<li style="margin:3px 0"><span style="font-weight:600;color:${TEXT}">${esc(i.item)}</span> <span style="color:${MUTED}">- blocks: ${esc(i.blocks)}</span></li>`).join('');
  s8 += card(
    `<div style="font-size:13px;color:${TEXT};margin-bottom:6px"><span style="font-weight:700;color:${AMBER}">Gates sign-off:</span> ${esc(x.notVerified.gate)}.</div>` +
      `<ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.5">${nvItems}</ul>`,
    AMBER,
  );

  // ── Section 9 · Scope & metadata ──
  const sc = x.scope;
  const fc = sc.findings;
  const sevPill = (label: string, n: number, key: string): string => {
    const s = sevOf(key);
    return `<span style="display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:${s.bg};color:${s.bar};margin:0 6px 4px 0">${esc(label)} ${n}</span>`;
  };
  const s9 =
    eyebrow('Section 9') +
    h2('Scope & metadata') +
    card(
      metaRow('Audit ID', sc.auditId) +
        metaRow('Reliability score', `${sc.composite ?? '—'}/100 (Grade ${sc.grade}) · Reporting reliability ${sc.reliabilityPct}%`) +
        metaRow('Window', sc.window) +
        metaRow('Retention', sc.retention) +
        metaRow('Timezone / currency', `${sc.timezone} / ${sc.currency}`) +
        metaRow('Access', 'GA4 Admin + Data API (read-only)') +
        metaRow('Generated', sc.generated) +
        metaRow('Property', sc.property) +
        metaRow('Limitations', sc.limitations) +
        `<div style="margin-top:8px">${sevPill('Critical', fc.critical, 'critical')}${sevPill('High', fc.high, 'high')}${sevPill('Medium', fc.medium, 'medium')}${sevPill('Low', fc.low, 'low')}${sevPill('Info', fc.info, 'info')}</div>` +
        `<div style="font-size:11.5px;color:${FAINT};font-style:italic;margin-top:6px">${esc(sc.footer)}</div>`,
      BORDER,
    );

  return (`<section style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};line-height:1.5">` + s2 + s3 + s4 + s5 + s6 + s7 + s8 + s9 + `</section>`).replace(/—/g, '-');
}

// Signed percentage for the baseline growth line (matches the markdown's trendPctText).
const signed = (p: number | null): string => (p === null ? 'n/a' : `${p >= 0 ? '+' : ''}${p}%`);
