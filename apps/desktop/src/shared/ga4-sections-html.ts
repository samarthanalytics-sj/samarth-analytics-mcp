// Framework-free renderer for the GA4 audit body sections (2-4 so far), styled as colourful cards to
// match Section 1. Shared by the renderer (dangerouslySetInnerHTML so it themes) and the PDF/Word
// export (CSS-var fallbacks supply print colours). All dynamic text is HTML-escaped; no em dashes.

import type { Ga4SectionsView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const v = (token: string, fallback: string): string => `var(${token}, ${fallback})`;
// Lab-report palette (fallbacks apply in the PDF/Word export; on-screen the app theme wins).
const TEXT = v('--text', '#17191D');
const MUTED = v('--text-muted', '#5B6069');
const FAINT = v('--text-faint', '#8A8F98');
const SURFACE = v('--surface', '#FFFFFF');
const BORDER = v('--border', '#E3E3DC');
const BLUE = v('--c-blue', '#26344E');
const GREEN = v('--c-green', '#1E7A48');
const AMBER = v('--c-amber', '#9A6206');
const MONO = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

// Severity → accent bar colour + badge background.
const SEV: Record<string, { bar: string; bg: string; txt: string }> = {
  critical: { bar: '#A63527', bg: v('--c-red-bg', '#FBF1EF'), txt: 'CRITICAL' },
  high: { bar: '#ea580c', bg: v('--c-amber-bg', '#fff7ed'), txt: 'HIGH' },
  medium: { bar: '#9A6206', bg: v('--c-amber-bg', '#fffbeb'), txt: 'MEDIUM' },
  low: { bar: '#26344E', bg: v('--c-blue-bg', '#eff6ff'), txt: 'LOW' },
  info: { bar: '#6A6F78', bg: 'rgba(148,163,184,.14)', txt: 'INFO' },
};
const sevOf = (s: string): { bar: string; bg: string; txt: string } => SEV[s] ?? SEV.info;
const badge = (s: { bar: string; bg: string; txt: string }): string =>
  `<span style="display:inline-block;white-space:nowrap;font-family:${MONO};font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 8px;border-radius:3px;background:${s.bg};color:${s.bar}">${s.txt}</span>`;

// Area-status (section 5) chips: a coloured dot + label per coverage status.
const STATUS: Record<string, { dot: string; label: string }> = {
  pass: { dot: '#1E7A48', label: 'Pass' },
  partial: { dot: '#9A6206', label: 'Partial' },
  fail: { dot: '#A63527', label: 'Fail' },
  not_verified: { dot: '#8A8F98', label: 'Not Verified' },
};
const statusChip = (key: string): string => {
  const s = STATUS[key] ?? STATUS.not_verified;
  return `<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px;font-weight:600;color:${TEXT}"><span style="width:9px;height:9px;border-radius:50%;background:${s.dot};display:inline-block;flex:0 0 auto"></span>${s.label}</span>`;
};
// Decision-readiness (section 7) status chip: solid green when answerable, outlined grey otherwise.
const decisionPill = (status: string): string => {
  const ok = /^answer/i.test(status);
  return ok
    ? `<span style="display:inline-block;white-space:nowrap;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:3px;background:${GREEN};color:#fff">${esc(status)}</span>`
    : `<span style="display:inline-block;white-space:nowrap;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;padding:3px 9px;border-radius:3px;border:1px solid ${v('--border-2', '#CFCFC6')};color:${MUTED}">${esc(status)}</span>`;
};
const TH = `style="text-align:left;font-family:${MONO};font-size:10.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};padding:8px 10px;border-bottom:1px solid ${BORDER}"`;
const THR = `style="text-align:right;font-family:${MONO};font-size:10.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:${FAINT};padding:8px 10px;border-bottom:1px solid ${BORDER}"`;
const TD = `style="padding:9px 10px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};vertical-align:top"`;
const TDR = `style="padding:9px 10px;border-bottom:1px solid ${BORDER};font-size:13px;color:${TEXT};vertical-align:top;text-align:right;font-family:${MONO};font-variant-numeric:tabular-nums"`;
const metaRow = (lbl: string, val: string): string =>
  `<div style="font-size:13px;color:${TEXT};margin:4px 0;line-height:1.5"><span style="font-weight:700;color:${MUTED}">${esc(lbl)}:</span> ${esc(val)}</div>`;
// Heading above each Section-6 breakdown table. `title` is escaped; `sub` is pre-built HTML (callers
// only pass static parentheticals + already-escaped dynamic values), inserted raw.
const tableCaption = (title: string, sub: string): string =>
  `<div style="font-size:15px;font-weight:600;color:${TEXT};margin:18px 2px 6px">${esc(title)} <span style="font-size:12.5px;font-weight:400;color:${FAINT}">${sub}</span></div>`;

const eyebrow = (t: string): string =>
  `<div style="font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:${FAINT};margin-top:30px">${esc(t)}</div>`;
const h2 = (t: string): string => `<h2 style="font-size:21px;font-weight:600;letter-spacing:-.01em;margin:2px 0 8px;color:${TEXT}">${esc(t)}</h2>`;
// page-break-inside:avoid keeps a card from splitting across pages in the printed PDF.
const card = (inner: string, accent: string): string =>
  `<div style="border:1px solid ${BORDER};border-left:3px solid ${accent};border-radius:4px;padding:16px 18px;background:${SURFACE};margin:8px 0;page-break-inside:avoid">${inner}</div>`;
const row = (lbl: string, val: string): string =>
  `<div style="font-size:13px;color:${TEXT};margin:4px 0;line-height:1.45"><span style="font-weight:700;color:${MUTED}">${esc(lbl)}:</span> ${esc(val)}</div>`;

// A labelled growth bar (the section-3 "graph"): bar width is |pct| relative to the row set's max, with
// the real from→to counts shown as the data point next to the percentage.
function growthBar(lbl: string, pct: number | null, maxAbs: number, color: string, unsafe: boolean, from: string | null, to: string | null): string {
  const valTxt = pct === null ? 'n/a' : `${pct >= 0 ? '+' : ''}${pct}%${unsafe ? ' *' : ''}`;
  const w = pct === null ? 0 : Math.max(2, Math.round((Math.abs(pct) / maxAbs) * 100));
  const dp = from && to ? `<div style="font-size:11px;color:${FAINT};font-variant-numeric:tabular-nums;white-space:nowrap">${esc(from)} → ${esc(to)}</div>` : '';
  return (
    `<div style="display:flex;align-items:center;gap:10px;margin:8px 0;font-size:13px">` +
    `<span style="width:84px;flex:0 0 84px;color:${TEXT};font-weight:600">${esc(lbl)}</span>` +
    `<span style="flex:1;background:rgba(148,163,184,.18);border-radius:5px;height:16px;overflow:hidden"><span style="display:block;height:100%;width:${w}%;background:${color};border-radius:5px"></span></span>` +
    `<span style="width:158px;flex:0 0 158px;text-align:right">${dp}<div style="color:${MUTED};font-weight:700;font-size:13px">${esc(valTxt)}</div></span>` +
    `</div>`
  );
}

/** Parse a number back out of one of OUR formatted table cells ("50,000", "INR 2,00,000", "97%", "-").
 *  Only ever applied to values this module's builders formatted, so the round-trip is deterministic. */
const pnum = (s: string): number => {
  const d = String(s ?? '').replace(/[^0-9.]/g, '');
  return d ? Number(d) : 0;
};
const FLAG = '#A63527';
const FLAG_BG = v('--c-red-bg', '#FBF1EF');
const SLATE = '#26344E';
const TRACK = 'var(--surface-2, #EDEDE6)';
/** The template's left-accented interpretation box under a chart. `inner` is pre-escaped HTML. */
const callout = (inner: string, accent = FLAG, bg = FLAG_BG): string =>
  `<div style="margin:12px 0 0;padding:11px 14px;border-left:3px solid ${accent};background:${bg};font-size:13px;color:${TEXT};border-radius:0 3px 3px 0;line-height:1.5">${inner}</div>`;
/** Mono fine-print caption under a chart (the template's .vcap). */
const vcap = (t: string): string => `<div style="font-family:${MONO};font-size:11px;color:${FAINT};line-height:1.55;margin-top:10px">${esc(t)}</div>`;
/** Viz card: declarative title + one-line explainer + chart body (the template's .viz). */
const vizCard = (title: string, sub: string, body: string): string =>
  `<div style="border:1px solid ${BORDER};border-radius:4px;padding:18px 20px 16px;background:${SURFACE};margin:14px 0 8px;page-break-inside:avoid">` +
  `<div style="font-size:15px;font-weight:600;color:${TEXT};margin:0 0 3px">${esc(title)}</div>` +
  (sub ? `<div style="font-size:13px;color:${MUTED};margin:0 0 12px;max-width:70ch">${esc(sub)}</div>` : '') +
  body +
  `</div>`;
/** One horizontal chart bar on a full-width track. `pct` is 0-100 of the track; a flagged row gets the
 *  flag red for both the label and the bar (the template's bar-flag). */
const chartBar = (lbl: string, pct: number, valueText: string, color: string, flagged = false): string => {
  const w = Math.max(0.5, Math.min(100, pct));
  return (
    `<div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12.5px">` +
    `<span style="width:130px;flex:0 0 130px;color:${flagged ? FLAG : TEXT};font-weight:${flagged ? 700 : 600};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(lbl)}</span>` +
    `<span style="flex:1;background:${TRACK};border-radius:3px;height:14px;overflow:hidden"><span style="display:block;height:100%;width:${w}%;background:${flagged ? FLAG : color};border-radius:3px"></span></span>` +
    `<span style="width:120px;flex:0 0 120px;text-align:right;font-family:${MONO};font-size:11.5px;color:${flagged ? FLAG : MUTED};white-space:nowrap">${esc(valueText)}</span>` +
    `</div>`
  );
};

/** Split rows into low/high engagement clusters at the LARGEST gap between consecutive sorted values,
 *  when that gap is wide enough (>= 25 points) to indicate two populations rather than a spread.
 *  Deterministic; null when there is no clear split. Exported for tests. */
export function engagementClusters(rows: Array<{ name: string; pct: number }>): { low: Array<{ name: string; pct: number }>; high: Array<{ name: string; pct: number }>; gap: number } | null {
  if (rows.length < 4) return null;
  const sorted = [...rows].sort((a, b) => a.pct - b.pct);
  let cut = -1;
  let gap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i].pct - sorted[i - 1].pct;
    if (g > gap) {
      gap = g;
      cut = i;
    }
  }
  if (cut < 1 || gap < 25) return null;
  const low = sorted.slice(0, cut);
  const high = sorted.slice(cut);
  // Two populations need a meaningful high cluster and a genuinely low low cluster.
  if (high.length < 2 || low[low.length - 1].pct > 60) return null;
  return { low, high, gap };
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
        (tf.evidence && tf.evidence !== tf.message ? row('Evidence', tf.evidence) : '') +
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
      // Lab-template bar voice: trusted bars in slate; a metric that is not fully trusted gets the
      // SOFT slate + an asterisk, so the eye reads "provisional" before the number does.
      const SLATE = '#26344E';
      const SLATE_SOFT = '#8793A6';
      // Verdict-aware caveat from the builder — rendered as the template's mono fine-print caption. A
      // FAILED gate reads "not safe to quote"; an UNVERIFIED one "confirm before quoting".
      const caveat = o.quoteNote
        ? `<div style="font-family:${MONO};font-size:11px;color:${FAINT};line-height:1.55;margin-top:10px">${esc(o.quoteNote.replace(/—/g, '-'))}</div>`
        : '';
      s3 += `<div style="border:1px solid ${BORDER};border-radius:4px;padding:18px 20px 14px;background:${SURFACE};margin:8px 0;page-break-inside:avoid">` +
        growthBar('Sessions', o.sessionsPct, maxAbs, SLATE, false, o.sessionsFrom, o.sessionsTo) +
        growthBar('Key events', o.keyEventsPct, maxAbs, o.keSafe ? SLATE : SLATE_SOFT, !o.keSafe, o.keyEventsFrom, o.keyEventsTo) +
        growthBar('Revenue', o.revenuePct, maxAbs, o.revSafe ? SLATE : SLATE_SOFT, !o.revSafe, o.revenueFrom, o.revenueTo) +
        // The "Read" is the template's callout: a left-accented interpretation box under the chart.
        `<div style="margin:14px 0 0;padding:11px 14px;border-left:3px solid ${AMBER};background:${v('--c-amber-bg', '#FCF8EF')};font-size:13px;color:${TEXT};border-radius:0 3px 3px 0;line-height:1.5"><b style="font-weight:600">Read:</b> ${esc(o.read)}</div>` +
        caveat +
        `</div>`;
    } else {
      s3 += card(`<div style="font-size:13px;color:${MUTED}">${esc(o.read)}</div>`, BORDER);
    }
    if (o.trendPattern) {
      s3 += `<div style="font-size:12.5px;color:${MUTED};margin:2px 0 0;line-height:1.45"><span style="font-weight:700;color:${TEXT}">Trend pattern:</span> ${esc(o.trendPattern)}</div>`;
    }
    // Restated total (burst excluded): the quotable number while the burst is unexplained - same
    // arithmetic as the concentration finding, so the two can never disagree.
    if (o.restated) {
      s3 += `<div style="margin:10px 0 0;padding:11px 14px;border-left:3px solid ${GREEN};background:${v('--c-green-bg', '#F1F8F3')};font-size:12.5px;color:${TEXT};border-radius:0 3px 3px 0;line-height:1.5"><b style="font-weight:600">Restated (burst excluded):</b> ${esc(o.restated)}</div>`;
    }
    // "What changed by channel": the headline delta decomposed into its top channel movers.
    if (o.drivers && o.drivers.length) {
      const dRows = o.drivers
        .map((d) => `<tr><td ${TD}><span style="font-weight:600">${esc(d.channel)}</span></td><td ${TDR}>${esc(d.from)}</td><td ${TDR}>${esc(d.to)}</td><td ${TDR}>${esc(d.delta)}</td><td ${TDR}>${d.deltaPct === null ? 'new' : `${d.deltaPct >= 0 ? '+' : ''}${d.deltaPct}%`}</td></tr>`)
        .join('');
      s3 +=
        tableCaption('What changed by channel', '(top movers vs the prior period - the headline delta decomposed)') +
        `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
        `<table style="border-collapse:collapse;width:100%;min-width:380px"><thead><tr><th ${TH}>Channel</th><th ${THR}>Prior</th><th ${THR}>Now</th><th ${THR}>Change</th><th ${THR}>%</th></tr></thead><tbody>${dRows}</tbody></table></div>`;
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
        // "Observed" state chip: the finding is graded to its worst branch but leans on a metric the
        // audit could not verify, so it is flagged as not-yet-confirmed rather than shown as fact.
        const stateChip =
          f.state === 'unconfirmed'
            ? `<span style="display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;background:rgba(245,158,11,.14);color:${AMBER};white-space:nowrap">Observed - unconfirmed</span>`
            : '';
        return card(
          `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">${badge(sev)}<span style="font-weight:700;color:${MUTED};font-size:12px">${esc(f.area)}</span>${stateChip}</div>` +
            `<div style="font-size:13px;color:${TEXT};margin-bottom:4px;line-height:1.45">${esc(f.message)}</div>` +
            (f.businessRisk && f.businessRisk !== '—' ? `<div style="font-size:12px;color:${MUTED};line-height:1.4"><span style="font-weight:700">Business risk:</span> ${esc(f.businessRisk)}</div>` : '') +
            (f.recommendation && f.recommendation !== '—' ? `<div style="font-size:12px;color:${MUTED};line-height:1.4"><span style="font-weight:700">Fix:</span> ${esc(f.recommendation)}</div>` : ''),
          sev.bar,
        );
      })
      .join('');
  }
  // "Blocked by verification": checks that could not run this window (unmeasured, not a clean pass).
  // A distinct amber group after the findings so the reader sees the gaps that cap trust.
  if (x.blocked && x.blocked.length) {
    const items = x.blocked
      .map(
        (b) =>
          `<li style="margin:5px 0"><span style="display:inline-block;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;background:rgba(245,158,11,.14);color:${AMBER};margin-right:6px;white-space:nowrap">Blocked</span><span style="font-weight:600;color:${TEXT}">${esc(b.area)}:</span> <span style="color:${TEXT}">${esc(b.message)}</span> <span style="color:${MUTED}"><span style="font-weight:700">Fix:</span> ${esc(b.recommendation)}</span></li>`,
      )
      .join('');
    s4 +=
      `<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${AMBER};margin-top:12px">Blocked by verification</div>` +
      `<div style="font-size:11.5px;color:${MUTED};margin:2px 0 4px">Checks that could not run this window, so any related conclusion is unconfirmed - not a clean pass.</div>` +
      card(`<ul style="margin:0;padding-left:2px;list-style:none;font-size:12.5px;line-height:1.5">${items}</ul>`, AMBER);
  }

  // ── Section 5 · Area status ──
  let s5 = eyebrow('Section 5') + h2('Area status');
  if (x.areas.length) {
    const rows = x.areas
      .map((a) => `<tr><td ${TD}><span style="font-weight:600">${esc(a.area)}</span></td><td ${TD}>${statusChip(a.statusKey)}</td><td ${TD}>${esc(a.confidence)}</td><td ${TD}>${esc(a.evidence)}</td></tr>`)
      .join('');
    s5 +=
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow:hidden;margin:6px 0">` +
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
        metaRow('Top markets', b.topMarkets ?? 'Not Verified') +
        (b.engagement ? metaRow('Engagement', b.engagement) : '') +
        (b.retention ? metaRow('Retention (cohorts)', b.retention) : ''),
      BLUE,
    );
  } else {
    s6 += card(`<div style="font-size:13px;color:${MUTED}">Baseline traffic metrics could not be retrieved - Not Verified.</div>`, BORDER);
  }
  // Key insights — rule-based highlights (peaks/lows, top performers, the near-100%-conv data-quality
  // flag). A green-accented card above the detailed tables so the reader gets the "so what" first.
  if (x.insights && x.insights.length) {
    const items = x.insights.map((i) => `<li style="margin:4px 0">${esc(i)}</li>`).join('');
    s6 +=
      tableCaption('Key insights', '(the notable peaks, lows, and points from the breakdowns below)') +
      // A provisional insight set is amber (caution), not green — the "so what" leans on unverified figures.
      card(`<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.5;color:${TEXT}">${items}</ul>`, x.perfProvisional ? AMBER : GREEN);
  }
  // When conversion/revenue are unverified, flag the performance tables' conv-rate/revenue columns as
  // provisional so a reader doesn't act on "converts best" comparisons as verified fact.
  if (x.perfProvisional) {
    s6 += card(
      `<div style="font-size:12.5px;color:${TEXT};line-height:1.45"><span style="font-weight:700;color:${AMBER}">Provisional:</span> the conversion-rate and revenue columns in the tables below lean on metrics the Data Trust Matrix has not confirmed - treat "converts best" and revenue comparisons as directional until verified.</div>`,
      AMBER,
    );
  }
  // Lab-template provisional voice: when conv/revenue are unverified their VALUES render in the faint
  // ink (the template's .prov), and each table carries a mono footnote — the reader can't miss it.
  const TDP = x.perfProvisional ? TDR.replace(`color:${TEXT}`, `color:${FAINT}`) : TDR;
  const provNote = x.perfProvisional
    ? `<div style="font-family:${MONO};font-size:11px;color:${FAINT};margin:4px 2px 8px;line-height:1.55">*Conversion-rate and revenue values are provisional - not verified (see the Data Trust Matrix).</div>`
    : '';
  // Rows whose ENGAGEMENT sits far below the table's norm are flagged (the template's rowbad): the
  // low-engagement outliers are where non-human / consent-lost traffic concentrates. Deterministic:
  // flagged when engagement < 60% of the table's median engagement.
  const engFlags = (rows: Array<{ engagement: string }>): boolean[] => {
    const vals = rows.map((r) => pnum(r.engagement)).sort((a, b) => a - b);
    const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    return rows.map((r) => median > 0 && pnum(r.engagement) < median * 0.6);
  };
  // Channel performance table — which channels convert and earn, not just their traffic share.
  if (x.channelPerformance && x.channelPerformance.length) {
    const flags = engFlags(x.channelPerformance);
    const cRows = x.channelPerformance
      .map(
        (c, i) =>
          `<tr${flags[i] ? ` style="background:${FLAG_BG}"` : ''}><td ${TD}><span style="font-weight:600;${flags[i] ? `color:${FLAG}` : ''}">${esc(c.channel)}</span></td><td ${TDR}>${esc(c.sessions)}</td><td ${TDP}>${esc(c.convRate)}</td><td ${TDP}>${esc(c.revenue)}</td><td ${TDR}>${esc(c.engagement)}</td></tr>`,
      )
      .join('');
    const flagNote = flags.some(Boolean)
      ? `<div style="font-family:${MONO};font-size:11px;color:${FAINT};margin:4px 2px 0;line-height:1.55">Flagged rows sit far below the table's engagement norm - where bot, proxy, or consent-lost traffic concentrates.</div>`
      : '';
    s6 +=
      tableCaption('Channel performance', '(conversion rate and revenue per channel, not just traffic share)') +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:420px"><thead><tr><th ${TH}>Channel</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${cRows}</tbody></table></div>` + flagNote + provNote;
  }
  // Landing-page table — top entry pages: which convert and which leak. Paths can be long, so the page
  // cell wraps (break-all) and the table scrolls horizontally on narrow screens.
  if (x.landingPages && x.landingPages.length) {
    const lRows = x.landingPages
      .map(
        (p) =>
          `<tr><td ${TD}><span style="font-weight:600;word-break:break-all">${esc(p.page)}</span></td><td ${TDR}>${esc(p.sessions)}</td><td ${TDP}>${esc(p.convRate)}</td><td ${TDP}>${esc(p.revenue)}</td><td ${TDR}>${esc(p.engagement)}</td></tr>`,
      )
      .join('');
    s6 +=
      tableCaption('Landing pages', '(top entry pages: which convert and which leak)') +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:460px"><thead><tr><th ${TH}>Landing page</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${lRows}</tbody></table></div>` + provNote;
  }
  // Product performance table — top products by ITEM revenue: what people view, add, and actually buy.
  if (x.productPerformance && x.productPerformance.rows.length) {
    const pRows = x.productPerformance.rows
      .map(
        (p) =>
          `<tr><td ${TD}><span style="font-weight:600;word-break:break-word">${esc(p.item)}</span></td><td ${TDR}>${esc(p.viewed)}</td><td ${TDR}>${esc(p.addedToCart)}</td><td ${TDR}>${esc(p.purchased)}</td><td ${TDP}>${esc(p.viewToBuy)}</td><td ${TDP}>${esc(p.revenue)}</td></tr>`,
      )
      .join('');
    s6 +=
      tableCaption('Product performance', '(top products by item revenue - what people view, add, and actually buy)') +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:520px"><thead><tr><th ${TH}>Product</th><th ${THR}>Items viewed</th><th ${THR}>Added to cart</th><th ${THR}>Purchased</th><th ${THR}>View&rarr;buy</th><th ${THR}>Item revenue</th></tr></thead><tbody>${pRows}</tbody></table></div>` +
      `<div style="font-family:${MONO};font-size:11px;color:${FAINT};margin:4px 2px 8px;line-height:1.55">${esc(x.productPerformance.caveat)}</div>` +
      provNote;
  }
  // Device performance table — how each device type converts and spends.
  if (x.devicePerformance && x.devicePerformance.length) {
    // Sessions-share vs revenue-share chart (the template's device viz): a device that carries a large
    // share of visits but a tiny share of revenue is flagged - broken tagging/consent on that device,
    // or traffic that was never real. Computed from the SAME rows the table shows.
    const dev = x.devicePerformance.map((d) => ({ name: d.device, sessions: pnum(d.sessions), revenue: pnum(d.revenue) }));
    const sessTotal = dev.reduce((s, d) => s + d.sessions, 0);
    const revTotal = dev.reduce((s, d) => s + d.revenue, 0);
    if (sessTotal > 0 && revTotal > 0 && dev.length >= 2) {
      const rows = dev
        .map((d) => {
          const sPct = Math.round((d.sessions / sessTotal) * 100);
          const rPct = Math.round((d.revenue / revTotal) * 100);
          const flagged = sPct >= 15 && rPct <= sPct / 3;
          return (
            chartBar(d.name, sPct, `${sPct}% of visits`, SLATE, flagged) +
            chartBar('', rPct, `${rPct}% of revenue${x.perfProvisional ? '*' : ''}`, v('--c-green', '#1E7A48'), flagged)
          );
        })
        .join('');
      const flaggedDev = dev.find((d) => {
        const sPct = (d.sessions / sessTotal) * 100;
        const rPct = (d.revenue / revTotal) * 100;
        return sPct >= 15 && rPct <= sPct / 3;
      });
      const read = flaggedDev
        ? callout(
            `<b style="font-weight:600">${esc(flaggedDev.name)}</b> carries ${Math.round((flaggedDev.sessions / sessTotal) * 100)}% of visits but only ${Math.round((flaggedDev.revenue / revTotal) * 100)}% of revenue. Either its tagging/consent is broken, or the traffic was never real - verify in DebugView on that device before quoting device figures.`,
          )
        : '';
      s6 += vizCard(
        'Share of visits vs share of revenue, by device',
        'The two bars per device should roughly match; a wide gap is a tagging, consent, or traffic-quality problem.',
        rows + read + (x.perfProvisional ? vcap('*Revenue is provisional - not verified (see the Data Trust Matrix).') : ''),
      );
    }
    const dRows = x.devicePerformance
      .map(
        (d) =>
          `<tr><td ${TD}><span style="font-weight:600;text-transform:capitalize">${esc(d.device)}</span></td><td ${TDR}>${esc(d.sessions)}</td><td ${TDP}>${esc(d.convRate)}</td><td ${TDP}>${esc(d.revenue)}</td><td ${TDR}>${esc(d.engagement)}</td></tr>`,
      )
      .join('');
    s6 +=
      tableCaption('Device performance', '(how each device type converts and spends)') +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:420px"><thead><tr><th ${TH}>Device</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${dRows}</tbody></table></div>` + provNote;
  }
  // Market performance table — which geographies convert and spend (top markets by sessions).
  if (x.geoPerformance && x.geoPerformance.length) {
    const gFlags = engFlags(x.geoPerformance);
    const gRows = x.geoPerformance
      .map(
        (g, i) =>
          `<tr${gFlags[i] ? ` style="background:${FLAG_BG}"` : ''}><td ${TD}><span style="font-weight:600;${gFlags[i] ? `color:${FLAG}` : ''}">${esc(g.country)}</span></td><td ${TDR}>${esc(g.sessions)}</td><td ${TDP}>${esc(g.convRate)}</td><td ${TDP}>${esc(g.revenue)}</td><td ${TDR}>${esc(g.engagement)}</td></tr>`,
      )
      .join('');
    const gFlagNote = gFlags.some(Boolean)
      ? `<div style="font-family:${MONO};font-size:11px;color:${FAINT};margin:4px 2px 0;line-height:1.55">Flagged rows have engagement far below the property norm - the traffic is suspect.</div>`
      : '';
    s6 +=
      tableCaption('Market performance', '(which geographies convert and spend)') +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:420px"><thead><tr><th ${TH}>Market</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${gRows}</tbody></table></div>` + gFlagNote + provNote;

    // Engagement bimodality (the template's two-populations chart): only rendered when the sorted
    // engagement rates split at a wide gap (>= 25 points) into a low and a high cluster — a pattern
    // that usually means real users mixed with bot, proxy, or consent-lost traffic. Flagged as a
    // pattern to VERIFY, never asserted as fact.
    const clusters = engagementClusters(x.geoPerformance.map((g) => ({ name: g.country, pct: pnum(g.engagement) })));
    if (clusters) {
      const bars =
        clusters.low.map((r) => chartBar(r.name, r.pct, `${r.pct}%`, FLAG, true)).join('') +
        `<div style="border-top:1px dashed ${v('--border-2', '#CFCFC6')};margin:8px 0 6px;text-align:right"><span style="font-family:${MONO};font-size:10.5px;color:${FAINT}">two populations, no overlap</span></div>` +
        clusters.high.map((r) => chartBar(r.name, r.pct, `${r.pct}%`, SLATE, false)).join('');
      s6 += vizCard(
        'Engagement rate by market: two separate populations',
        `Sorted low to high. The ${clusters.gap}-point gap between ${clusters.low[clusters.low.length - 1].name} and ${clusters.high[0].name} is the break; nothing lands in the middle.`,
        bars +
          callout(
            `A split this clean usually means real users mixed with bot, proxy, or consent-lost traffic. The low cluster (${clusters.low.map((r) => esc(r.name)).join(', ')}) is where the fake-traffic risk concentrates. <b style="font-weight:600">Verify the sources of these markets before treating their sessions as real.</b>`,
            AMBER,
            v('--c-amber-bg', '#FCF8EF'),
          ),
      );
    }
  }
  // Campaign performance table — which marketing (utm_campaign-tagged) campaigns convert and earn, with
  // the top campaign + untagged-traffic share in the caption. When there is no tagged campaign traffic
  // the view is null and we show a one-line advisory instead of an empty table.
  if (x.campaignPerformance && x.campaignPerformance.rows.length) {
    const cp = x.campaignPerformance;
    // Key events / purchases / revenue take the provisional ink (TDP) like every other unverified
    // outcome column; sessions and engagement stay normal. Header says "Key events", never "Conversions",
    // and the mandatory caveat renders as this table's own mono footnote — this used to be the one table
    // with no guardrail, where key-event counts could read as sales.
    const cpRows = cp.rows
      .map(
        (c) =>
          `<tr><td ${TD}><span style="font-weight:600">${esc(c.campaign)}</span></td><td ${TDR}>${esc(c.sessions)}</td><td ${TDP}>${esc(c.conversions)}</td><td ${TDP}>${esc(c.purchases)}</td><td ${TDP}>${esc(c.revenue)}</td>${cp.hasCost ? `<td ${TDP}>${esc(c.spend)}</td><td ${TDP}>${esc(c.roas)}</td><td ${TDP}>${esc(c.cac)}</td>` : ''}<td ${TDR}>${esc(c.engagement)}</td></tr>`,
      )
      .join('');
    s6 +=
      tableCaption('Campaign performance', `(which marketing campaigns convert and earn${cp.best ? ` — top: ${esc(cp.best)}` : ''}; untagged traffic ${esc(cp.untaggedShare)})`) +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:${cp.hasCost ? 640 : 500}px"><thead><tr><th ${TH}>Campaign</th><th ${THR}>Sessions</th><th ${THR}>Key events</th><th ${THR}>Purchases</th><th ${THR}>Revenue</th>${cp.hasCost ? `<th ${THR}>Spend</th><th ${THR}>ROAS</th><th ${THR}>CAC</th>` : ''}<th ${THR}>Engagement</th></tr></thead><tbody>${cpRows}</tbody></table></div>` +
      `<div style="font-family:${MONO};font-size:11px;color:${FAINT};margin:4px 2px 8px;line-height:1.55">${esc(cp.caveat)}</div>` +
      provNote;
  }
  // AI/LLM assistant referral traffic — which AI sources convert and earn. A systematic undercount
  // (referrer-stripped visits land in Direct), stated explicitly in the caveat below the table.
  if (x.llmTraffic && x.llmTraffic.rows.length) {
    const lRows = x.llmTraffic.rows
      .map(
        (c) =>
          `<tr><td ${TD}><span style="font-weight:600">${esc(c.source)}</span></td><td ${TDR}>${esc(c.sessions)}</td><td ${TDP}>${esc(c.convRate)}</td><td ${TDP}>${esc(c.revenue)}</td><td ${TDR}>${esc(c.engagement)}</td></tr>`,
      )
      .join('');
    s6 +=
      tableCaption('AI assistant traffic', `(which AI referrers convert and earn — ${esc(x.llmTraffic.share)})`) +
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow-x:auto;margin:2px 0">` +
      `<table style="border-collapse:collapse;width:100%;min-width:420px"><thead><tr><th ${TH}>AI source</th><th ${THR}>Sessions</th><th ${THR}>Conv. rate</th><th ${THR}>Revenue</th><th ${THR}>Engagement</th></tr></thead><tbody>${lRows}</tbody></table></div>` +
      `<div style="font-size:11px;color:${FAINT};margin:4px 2px 0;line-height:1.4">AI-referral traffic is a systematic undercount - visits from AI mobile/in-app browsers and copied links arrive with no referrer and land in Direct.</div>`;
  }
  // Ecommerce funnel — distinct users per step + step conversion. An event-coverage approximation (not a
  // strict sequential path), so a later step can exceed an earlier one; the caveat says so explicitly.
  if (x.funnel && x.funnel.steps.length) {
    // The template's funnel bars: each step as a share of the entry step, with the step holding the
    // biggest drop flagged in red and named in the callout. Computed from the SAME rows the table shows.
    if (x.funnel.steps.length >= 2) {
      const users = x.funnel.steps.map((st) => pnum(st.users));
      let worst = -1;
      let worstDrop = 0;
      for (let i = 1; i < users.length; i++) {
        if (users[i - 1] > 0) {
          const drop = 1 - users[i] / users[i - 1];
          if (drop > worstDrop) {
            worstDrop = drop;
            worst = i;
          }
        }
      }
      // The bar value carries the step-conversion figure too (it used to live in a separate table
      // that duplicated this chart row-for-row; the table is gone, the data is not).
      const bars = x.funnel.steps
        .map((st, i) => chartBar(st.label, pnum(st.pctEntry), `${st.users} · ${st.pctEntry}${st.stepConv && st.stepConv !== '—' ? ` · step conv ${st.stepConv}` : ''}`, SLATE, i === worst && worstDrop >= 0.5))
        .join('');
      const read =
        worst > 0 && worstDrop >= 0.5
          ? callout(
              `<b style="font-weight:600">${Math.round(worstDrop * 100)} of every 100</b> who reach ${esc(x.funnel.steps[worst - 1].label)} leave before ${esc(x.funnel.steps[worst].label)} - that single step is where the most is lost.`,
            )
          : '';
      s6 += vizCard(
        'Purchase funnel: users per step',
        `Each step as a share of the entry step; overall view-to-purchase is ${x.funnel.overall}.`,
        bars + read + vcap('Event-coverage approximation, not a strict sequential path - a later step can exceed an earlier one (saved carts, express checkout, or a missing step tag).'),
      );
    }
  }

  // ── Section 7 · Decision readiness ──
  let s7 = eyebrow('Section 7') + h2('Decision readiness');
  if (x.decisions.length) {
    const rows = x.decisions
      .map((d) => `<tr><td ${TD}><span style="font-weight:600">${esc(d.q)}</span></td><td ${TD}>${decisionPill(d.status)}</td><td ${TD}>${esc(d.note)}</td></tr>`)
      .join('');
    s7 +=
      `<div style="border:1px solid ${BORDER};border-radius:4px;background:${SURFACE};overflow:hidden;margin:6px 0">` +
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
        metaRow('Setup completeness', `${sc.composite ?? '—'}/100 (Grade ${sc.grade}) · Reporting reliability ${sc.reliabilityPct}%`) +
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
