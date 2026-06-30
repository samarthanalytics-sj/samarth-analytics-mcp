// Framework-free renderer for the GA4 audit visualisations: a colourful daily-sessions LINE CHART
// (SVG, peak day marked) plus colour-coded device + channel bars. Shared by the renderer (shown via
// dangerouslySetInnerHTML so it themes) and the PDF export (Chromium renders SVG). NOT used in the
// Word export (Word's HTML engine doesn't render SVG). All dynamic text is HTML-escaped.

import type { Ga4VisualsView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Remove the Property-baseline Unicode "Device split" / "Channel mix" code blocks from the report
 *  markdown. Used on the surfaces that ALSO render the colourful visuals panel (on-screen + PDF) so
 *  the same data isn't shown twice; the .md and Word downloads keep the Unicode bars (no panel). */
export function stripDuplicateCharts(md: string): string {
  return md
    .replace(/\*\*Device split\*\*\s*```[\s\S]*?```\s*/g, '')
    .replace(/\*\*Channel mix \(sessions\)\*\*\s*```[\s\S]*?```\s*/g, '');
}

const TEXT = 'var(--text, #1a1a1a)';
const MUTED = 'var(--text-muted, #5b6472)';
const FAINT = 'var(--text-faint, #8a93a0)';
const BORDER = 'var(--border, #e3e6ea)';
const SURFACE = 'var(--surface, #ffffff)';

// Bright, theme-agnostic palette (reads on light and dark backgrounds).
const PALETTE = ['#3b82f6', '#06b6d4', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899'];
const LINE = '#3b82f6';
const PEAK = '#ef4444';
const AXIS = '#94a3b8';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (ymd: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}` : ymd || '?';
};
const label = (t: string): string =>
  `<div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:${FAINT};margin-bottom:4px">${esc(t)}</div>`;

// Adaptive grouping: keep the chart readable (and meaningful) as the window grows. Up to ~6 weeks is
// shown per day; up to ~7 months per week; longer windows roll up to months. Daily values are summed
// into each bucket. The bucket label is what the hover tooltip and axis show.
export type Gran = 'day' | 'week' | 'month';
export interface GPoint {
  label: string;
  value: number;
}
export const granularityFor = (n: number): Gran => (n <= 45 ? 'day' : n <= 210 ? 'week' : 'month');
export const granLabel = (g: Gran): string => (g === 'day' ? 'daily' : g === 'week' ? 'weekly' : 'monthly');

// YYYYMMDD <-> epoch-day, using Date.UTC (a pure function, no clock) so the bucketing is deterministic.
const dayNum = (ymd: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : 0;
};
const ymdFromNum = (epochDay: number): string => {
  const d = new Date(epochDay * 86400000);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
};

// Bucket the daily series by CALENDAR period (not array position — GA4 omits zero-session days, so
// array index ≠ calendar day). `anchor` is the shared first date so weekly buckets line up across the
// trend and per-channel charts.
export function groupSeries(daily: Array<{ date: string; sessions: number }>, gran: Gran, anchor: string): GPoint[] {
  if (gran === 'day') return daily.map((d) => ({ label: fmtDay(d.date), value: d.sessions }));
  if (gran === 'month') {
    const out: GPoint[] = [];
    const idx = new Map<string, number>();
    for (const d of daily) {
      const key = d.date.slice(0, 6); // YYYYMM
      const label = `${MONTHS[Number(key.slice(4, 6)) - 1] ?? '?'} ${key.slice(0, 4)}`;
      if (!idx.has(key)) {
        idx.set(key, out.length);
        out.push({ label, value: 0 });
      }
      out[idx.get(key) as number].value += d.sessions;
    }
    return out;
  }
  // weekly: fixed 7-CALENDAR-day buckets from the shared anchor, labelled by the bucket's start date.
  const anchorDay = anchor ? dayNum(anchor) : daily[0] ? dayNum(daily[0].date) : 0;
  const buckets = new Map<number, number>();
  for (const d of daily) {
    const wi = Math.floor((dayNum(d.date) - anchorDay) / 7);
    buckets.set(wi, (buckets.get(wi) ?? 0) + d.sessions);
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((wi) => ({ label: `Wk ${fmtDay(ymdFromNum(anchorDay + wi * 7))}`, value: buckets.get(wi) as number }));
}

// A visible data-point dot at each value, plus a larger transparent target carrying a native <title>
// tooltip ("label: N sessions") so pointing at a point shows its value (works on-screen and in the PDF
// viewer; harmless where unsupported).
const X_AT = (i: number, n: number, l: number, iw: number): number => l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);

function dots(points: GPoint[], x: (i: number) => number, y: (v: number) => number, color: string, prefix: string, peakIdx: number, hoverR: number): string {
  return points
    .map((p, i) => {
      const cx = x(i).toFixed(1);
      const cy = y(p.value).toFixed(1);
      const isPeak = i === peakIdx;
      const tip = `${prefix ? esc(prefix) + ' · ' : ''}${esc(p.label)}: ${Math.round(p.value).toLocaleString('en-US')} sessions`;
      return (
        `<circle cx="${cx}" cy="${cy}" r="${isPeak ? 3.6 : 2.3}" style="fill:${isPeak ? PEAK : color};stroke:${SURFACE};stroke-width:1"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${hoverR.toFixed(1)}" fill="transparent" pointer-events="all"><title>${tip}</title></circle>`
      );
    })
    .join('');
}
// Hover-target radius: half the point spacing (capped at 9) so adjacent targets never overlap.
const hoverRadius = (n: number, iw: number): number => Math.max(4, Math.min(9, n <= 1 ? 9 : iw / (n - 1) / 2));

// Single trend line: area + line + data-point dots. The busiest point is marked (label depends on
// granularity: "peak" for a daily chart that matches the day-based summary, "busiest" once grouped).
function lineChartSvg(points: GPoint[], peakLabel: string): string {
  const n = points.length;
  if (!n) return '';
  const W = 720;
  const H = 210;
  const l = 48;
  const r = 14;
  const t = 16;
  const b = 30;
  const iw = W - l - r;
  const ih = H - t - b;
  const maxV = Math.max(1, ...points.map((p) => p.value));
  const x = (i: number): number => X_AT(i, n, l, iw);
  const y = (v: number): number => t + ih - (v / maxV) * ih;
  const peakIdx = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  const poly = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `M ${x(0).toFixed(1)} ${(t + ih).toFixed(1)} L ` + points.map((p, i) => `${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' L ') + ` L ${x(n - 1).toFixed(1)} ${(t + ih).toFixed(1)} Z`;
  const xlab = (i: number, anchor: string): string =>
    points[i] ? `<text x="${x(i).toFixed(1)}" y="${H - 9}" text-anchor="${anchor}" style="font-size:10px;fill:${AXIS}">${esc(points[i].label)}</text>` : '';
  const peakMark = `<text x="${x(peakIdx).toFixed(1)}" y="${(y(points[peakIdx].value) - 8).toFixed(1)}" text-anchor="middle" style="font-size:10px;font-weight:700;fill:${PEAK}">${esc(peakLabel)}</text>`;
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:720px;display:block;margin:8px 0" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sessions trend">` +
    `<defs><linearGradient id="ga4area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${LINE};stop-opacity:.28"/><stop offset="1" style="stop-color:${LINE};stop-opacity:.02"/></linearGradient></defs>` +
    `<line x1="${l}" y1="${(t + ih).toFixed(1)}" x2="${W - r}" y2="${(t + ih).toFixed(1)}" style="stroke:rgba(148,163,184,.35);stroke-width:1"/>` +
    `<text x="${l - 7}" y="${(t + 4).toFixed(1)}" text-anchor="end" style="font-size:10px;fill:${AXIS}">${maxV.toLocaleString('en-US')}</text>` +
    `<path d="${area}" style="fill:url(#ga4area);stroke:none"/>` +
    `<polyline points="${poly}" style="fill:none;stroke:${LINE};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>` +
    dots(points, x, y, LINE, '', peakIdx, hoverRadius(n, iw)) +
    peakMark +
    xlab(0, 'start') +
    (peakIdx > 0 && peakIdx < n - 1 ? xlab(peakIdx, 'middle') : '') +
    xlab(n - 1, 'end') +
    `</svg>`
  );
}

interface ChannelPoints {
  channel: string;
  points: GPoint[];
}

// Multi-line chart: one coloured line per channel (shared axis), with data-point dots per channel.
function multiLineChartSvg(grouped: ChannelPoints[]): string {
  const series = grouped.filter((c) => c.points && c.points.length >= 2);
  if (series.length < 2) return '';
  const n = Math.max(...series.map((c) => c.points.length));
  const W = 720;
  const H = 200;
  const l = 48;
  const r = 14;
  const t = 14;
  const b = 26;
  const iw = W - l - r;
  const ih = H - t - b;
  const maxV = Math.max(1, ...series.flatMap((c) => c.points.map((p) => p.value)));
  const x = (i: number): number => X_AT(i, n, l, iw);
  const y = (v: number): number => t + ih - (v / maxV) * ih;
  const body = series
    .map((c, ci) => {
      const color = PALETTE[ci % PALETTE.length];
      const poly = c.points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
      return `<polyline points="${poly}" style="fill:none;stroke:${color};stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;opacity:.95"/>` + dots(c.points, x, y, color, c.channel || '(not set)', -1, hoverRadius(n, iw));
    })
    .join('');
  const first = series[0].points;
  const xlab = (i: number, anchor: string): string =>
    first[i] ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" style="font-size:10px;fill:${AXIS}">${esc(first[i].label)}</text>` : '';
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:720px;display:block;margin:8px 0" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sessions by channel">` +
    `<line x1="${l}" y1="${(t + ih).toFixed(1)}" x2="${W - r}" y2="${(t + ih).toFixed(1)}" style="stroke:rgba(148,163,184,.35);stroke-width:1"/>` +
    `<text x="${l - 7}" y="${(t + 4).toFixed(1)}" text-anchor="end" style="font-size:10px;fill:${AXIS}">${maxV.toLocaleString('en-US')}</text>` +
    body +
    xlab(0, 'start') +
    xlab(n - 1, 'end') +
    `</svg>`
  );
}

function legendHtml(grouped: ChannelPoints[]): string {
  // Same filter as multiLineChartSvg (>= 2) so legend swatch colours line up with the plotted lines.
  const series = grouped.filter((c) => c.points && c.points.length >= 2);
  if (!series.length) return '';
  return (
    `<div style="display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:2px">` +
    series
      .map((c, i) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${MUTED}"><span style="width:11px;height:3px;border-radius:2px;background:${PALETTE[i % PALETTE.length]};display:inline-block"></span>${esc(c.channel || '(not set)')}</span>`)
      .join('') +
    `</div>`
  );
}

function barList(rows: Ga4VisualsView['devices']): string {
  const total = rows.reduce((s, r) => s + r.sessions, 0) || 1;
  const top = [...rows].sort((a, b) => b.sessions - a.sessions).slice(0, 8);
  if (!top.length) return `<div style="font-size:12px;color:${MUTED}">Not available.</div>`;
  return top
    .map((row, i) => {
      const raw = Math.round((row.sessions / total) * 100);
      const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
      const color = PALETTE[i % PALETTE.length];
      return (
        `<div style="display:flex;align-items:center;gap:8px;margin:5px 0;font-size:12px">` +
        `<span style="width:120px;flex:0 0 120px;color:${TEXT};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(row.name || '(not set)')}</span>` +
        `<span style="flex:1;background:rgba(148,163,184,.18);border-radius:5px;height:13px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:${color};border-radius:5px"></span></span>` +
        `<span style="width:36px;flex:0 0 36px;text-align:right;color:${MUTED}">${pct}%</span>` +
        `</div>`
      );
    })
    .join('');
}

const pillColor = (lbl: string): string =>
  /spike|volatile/i.test(lbl) ? '#f59e0b' : /upward/i.test(lbl) ? '#22c55e' : /downward/i.test(lbl) ? '#ef4444' : '#64748b';

// ── Deep insights read directly off the chart data ──────────────────────────────────────────────
// Deterministic, pure: what the peak was, which channel drove the rise, how concentrated the traffic
// is, and the device skew. Shared by the on-screen React panel and the PDF so they never disagree.
export interface TrendInsight {
  tone: 'good' | 'watch' | 'info';
  title: string;
  body: string;
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);
const fmtN = (n: number): string => Math.round(n).toLocaleString('en-US');

export function buildTrendInsights(v: Ga4VisualsView): TrendInsight[] {
  const out: TrendInsight[] = [];
  const daily = v.daily ?? [];
  const finiteVals = daily.map((d) => d.sessions).filter((n) => Number.isFinite(n));
  const channels = [...(v.channels ?? [])].sort((a, b) => b.sessions - a.sessions);
  const total = channels.reduce((s, c) => s + c.sessions, 0);

  // 1) Peak: the SAME peak day the chart marks (v.peakIndex into the same daily array), with its
  // multiple of the daily average. Guard the index and fall back to the finite argmax if it is off.
  let peakDayLabel: string | null = null;
  if (daily.length >= 5 && finiteVals.length) {
    const avg = mean(finiteVals);
    const inRange = v.peakIndex >= 0 && v.peakIndex < daily.length && Number.isFinite(daily[v.peakIndex]?.sessions);
    const pi = inRange
      ? v.peakIndex
      : daily.reduce((best, d, i) => (Number.isFinite(d.sessions) && d.sessions > (daily[best]?.sessions ?? -Infinity) ? i : best), 0);
    const peak = daily[pi];
    if (peak && Number.isFinite(peak.sessions)) {
      peakDayLabel = fmtDay(peak.date);
      const mult = avg > 0 ? peak.sessions / avg : 0;
      out.push({
        tone: 'info',
        title: 'Peak',
        body: `${peakDayLabel} hit ${fmtN(peak.sessions)} sessions${avg > 0 ? `, ${mult.toFixed(1)}x the window's daily average (${fmtN(avg)}/day)` : ''}.`,
      });
    }
  }

  // 2) What drove it: the PEAK-DAY driving channel — the same signal the chart marker and the trend
  // summary use, so the panel can never contradict them. dayShare vs windowShare shows whether that
  // channel spiked on the peak day (dayShare >> windowShare) or just rode a broad lift.
  const dc = v.drivingChannel;
  if (dc && dc.name) {
    const dayPct = Math.round(dc.dayShare * 100);
    const winPct = Math.round(dc.windowShare * 100);
    const concentrated = dayPct - winPct >= 10;
    out.push({
      tone: 'info',
      title: 'What drove it',
      body: `${dc.name} led the peak day${peakDayLabel ? ` (${peakDayLabel})` : ''} at ${dayPct}% of that day's traffic${winPct > 0 ? ` vs ${winPct}% across the window` : ''}${concentrated ? ' - it spiked, it did not just ride a broad lift' : ''}.`,
    });
  }

  // 3) Channel concentration: one dominant channel is a single point of failure for the whole number.
  if (channels.length && total > 0) {
    const top = channels[0];
    const topShare = Math.round((top.sessions / total) * 100);
    const second = channels[1] ? `${channels[1].name || '(not set)'} ${Math.round((channels[1].sessions / total) * 100)}%` : '';
    if (topShare >= 55) {
      out.push({ tone: 'watch', title: 'Concentration risk', body: `${top.name || '(not set)'} is ${topShare}% of sessions${second ? ` (then ${second})` : ''} - one channel moves the whole number. Watch it closely or diversify.` });
    } else {
      out.push({ tone: 'good', title: 'Channel mix', body: `Reasonably spread - ${top.name || '(not set)'} leads at ${topShare}%${second ? `, then ${second}` : ''}.` });
    }
  }

  // 4) Device skew.
  const devs = [...(v.devices ?? [])].sort((a, b) => b.sessions - a.sessions);
  const devTotal = devs.reduce((s, d) => s + d.sessions, 0);
  if (devs.length && devTotal > 0) {
    const top = devs[0];
    const dShare = Math.round((top.sessions / devTotal) * 100);
    out.push({
      tone: dShare >= 90 ? 'watch' : 'info',
      title: 'Device',
      body: `${dShare}% ${top.name || 'unknown'}${dShare >= 90 ? ` - almost entirely ${top.name || 'one device'}; prioritise that experience` : ''}.`,
    });
  }

  // 5) Trust caveat.
  if (v.channelTrusted === false) {
    out.push({ tone: 'watch', title: 'Caveat', body: 'A material share of sessions lack source data, so the channel split is not safe to quote yet (see the Data Trust Matrix).' });
  }
  // House style: no em dashes, even via interpolated channel/device names (normalised at the source so
  // the React panel and the PDF agree without each re-stripping).
  return out.map((it) => ({ ...it, title: it.title.replace(/—/g, '-'), body: it.body.replace(/—/g, '-') }));
}

const INSIGHT_TONE: Record<TrendInsight['tone'], { bar: string; bg: string }> = {
  good: { bar: 'var(--c-green, #16a34a)', bg: 'var(--c-green-bg, #f0fdf4)' },
  watch: { bar: 'var(--c-amber, #d97706)', bg: 'var(--c-amber-bg, #fffbeb)' },
  info: { bar: 'var(--c-blue, #2563eb)', bg: 'var(--c-blue-bg, #eff6ff)' },
};

function insightsPanelHtml(v: Ga4VisualsView): string {
  const items = buildTrendInsights(v);
  if (!items.length) return '';
  const rows = items
    .map((it) => {
      const tone = INSIGHT_TONE[it.tone];
      return (
        `<div style="border-left:3px solid ${tone.bar};background:${tone.bg};border-radius:0 6px 6px 0;padding:7px 10px;margin:0 0 8px">` +
        `<div style="font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:${tone.bar};margin-bottom:2px">${esc(it.title)}</div>` +
        `<div style="font-size:12.5px;color:${TEXT};line-height:1.45">${esc(it.body)}</div></div>`
      );
    })
    .join('');
  return `<div style="border:1px solid ${BORDER};border-radius:10px;padding:12px 14px;background:${SURFACE};box-sizing:border-box">${label('What the data shows')}${rows}</div>`;
}

export function ga4VisualsHtml(v: Ga4VisualsView): string {
  if (!v || (!v.daily?.length && !v.devices?.length && !v.channels?.length)) return '';
  const cardTd = (inner: string): string =>
    `<td style="width:50%;vertical-align:top;padding:6px"><div style="border:1px solid ${BORDER};border-radius:10px;padding:12px 14px;background:${SURFACE}">${inner}</div></td>`;
  // Adaptive grouping: as the window grows the daily series rolls up to weekly, then monthly, so the
  // chart stays readable and each point carries a hover tooltip with its value for that date/period.
  const gran = granularityFor(v.daily?.length ?? 0);
  const anchor = v.daily?.[0]?.date ?? '';
  const trendPoints = groupSeries(v.daily ?? [], gran, anchor);
  // "peak" only when the chart is daily (matches the day-based summary text); once grouped the marker
  // is the busiest week/month, so it says "busiest" rather than contradicting the named peak day.
  const peakLabel = gran === 'day' ? 'peak' : 'busiest';
  // Only show the trend pill/summary/line chart when there are enough days to characterise it (>=5),
  // matching the markdown report's section-3 guard so the two surfaces never disagree.
  const trend = (v.daily?.length ?? 0) >= 5
    ? `<div style="margin-top:6px;font-size:13px;color:${TEXT};line-height:1.5">` +
      `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.3px;padding:2px 9px;border-radius:999px;color:#fff;background:${pillColor(v.trendLabel)};margin-right:8px">${esc(v.trendLabel)}</span>` +
      `${esc(v.trendSummary)} <span style="color:${FAINT}">(${granLabel(gran)}; hover a point for its value)</span></div>` +
      lineChartSvg(trendPoints, peakLabel)
    : '';
  // Channel attribution is not safe to quote → grey the channel charts and show a caveat, so only the
  // fully-trusted data (sessions trend, device split) is foregrounded.
  const untrusted = v.channelTrusted === false;
  const greyOpen = untrusted ? '<div style="opacity:.5">' : '';
  const greyClose = untrusted ? '</div>' : '';
  const caveat = untrusted
    ? `<div style="font-size:11.5px;color:var(--c-amber,#b45309);background:var(--c-amber-bg,#fef3c7);border:1px solid var(--c-amber-border,#fde68a);border-radius:6px;padding:6px 10px;margin:8px 0">⚠ Channel attribution is not safe to quote yet - a material share of sessions lack source data (see the Data Trust Matrix). The channel charts below are greyed for that reason.</div>`
    : '';
  const channelGrouped: ChannelPoints[] = (v.channelDaily ?? []).map((c) => ({ channel: c.channel, points: groupSeries(c.series, gran, anchor) }));
  const byChannelChart = multiLineChartSvg(channelGrouped);
  const byChannel = byChannelChart ? greyOpen + label(`Sessions by channel (${granLabel(gran)})`) + byChannelChart + legendHtml(channelGrouped) + greyClose : '';
  const chartsBlock = trend + caveat + byChannel;
  // Charts on the left, the deep-insights panel on the right (matching the on-screen layout). When
  // there is nothing to say, the charts take the full width instead of leaving an empty column.
  const insights = insightsPanelHtml(v);
  const chartsAndInsights = insights
    ? `<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;table-layout:fixed"><tbody><tr>` +
      `<td style="width:60%;vertical-align:top;padding-right:12px">${chartsBlock}</td>` +
      `<td style="width:40%;vertical-align:top">${insights}</td>` +
      `</tr></tbody></table>`
    : chartsBlock;
  return (
    `<section style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};line-height:1.5">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#2563eb">Traffic trend</div>` +
    `<h2 style="font-size:18px;margin:2px 0 2px;color:${TEXT}">Traffic trend &amp; visualisations</h2>` +
    chartsAndInsights +
    `<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;margin-top:8px;table-layout:fixed"><tbody><tr>` +
    cardTd(label('Device split') + barList(v.devices ?? [])) +
    cardTd(greyOpen + label('Channel mix (sessions)') + barList(v.channels ?? []) + greyClose) +
    `</tr></tbody></table>` +
    `</section>`
  ).replace(/—/g, '-');
}
