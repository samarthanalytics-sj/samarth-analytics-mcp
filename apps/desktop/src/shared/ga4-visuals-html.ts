// Framework-free renderer for the GA4 audit visualisations: a colourful daily-sessions LINE CHART
// (SVG, peak day marked) plus colour-coded device + channel bars. Shared by the renderer (shown via
// dangerouslySetInnerHTML so it themes) and the PDF export (Chromium renders SVG). NOT used in the
// Word export (Word's HTML engine doesn't render SVG). All dynamic text is HTML-escaped.

import type { Ga4VisualsView } from './ipc';

const esc = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

function lineChartSvg(daily: Ga4VisualsView['daily'], peakIndex: number): string {
  const n = daily.length;
  if (!n) return '';
  const W = 720;
  const H = 210;
  const l = 48;
  const r = 14;
  const t = 16;
  const b = 30;
  const iw = W - l - r;
  const ih = H - t - b;
  const maxV = Math.max(1, ...daily.map((d) => d.sessions));
  const x = (i: number): number => l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number): number => t + ih - (v / maxV) * ih;
  const pts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.sessions).toFixed(1)}`).join(' ');
  const area =
    `M ${x(0).toFixed(1)} ${(t + ih).toFixed(1)} L ` +
    daily.map((d, i) => `${x(i).toFixed(1)} ${y(d.sessions).toFixed(1)}`).join(' L ') +
    ` L ${x(n - 1).toFixed(1)} ${(t + ih).toFixed(1)} Z`;
  const xlab = (i: number, anchor: string): string =>
    daily[i] ? `<text x="${x(i).toFixed(1)}" y="${H - 9}" text-anchor="${anchor}" style="font-size:10px;fill:${AXIS}">${esc(fmtDay(daily[i].date))}</text>` : '';
  let peakMark = '';
  if (peakIndex >= 0 && peakIndex < n) {
    const px = x(peakIndex);
    const py = y(daily[peakIndex].sessions);
    peakMark =
      `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.6" style="fill:${PEAK};stroke:${SURFACE};stroke-width:1.5"/>` +
      `<text x="${px.toFixed(1)}" y="${(py - 8).toFixed(1)}" text-anchor="middle" style="font-size:10px;font-weight:700;fill:${PEAK}">peak</text>`;
  }
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:720px;display:block;margin:8px 0" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily sessions trend">` +
    `<defs><linearGradient id="ga4area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${LINE};stop-opacity:.28"/><stop offset="1" style="stop-color:${LINE};stop-opacity:.02"/></linearGradient></defs>` +
    `<line x1="${l}" y1="${(t + ih).toFixed(1)}" x2="${W - r}" y2="${(t + ih).toFixed(1)}" style="stroke:rgba(148,163,184,.35);stroke-width:1"/>` +
    `<text x="${l - 7}" y="${(t + 4).toFixed(1)}" text-anchor="end" style="font-size:10px;fill:${AXIS}">${maxV.toLocaleString('en-US')}</text>` +
    `<path d="${area}" style="fill:url(#ga4area);stroke:none"/>` +
    `<polyline points="${pts}" style="fill:none;stroke:${LINE};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>` +
    peakMark +
    xlab(0, 'start') +
    (peakIndex > 0 && peakIndex < n - 1 ? xlab(peakIndex, 'middle') : '') +
    xlab(n - 1, 'end') +
    `</svg>`
  );
}

// Multi-line chart: one coloured line per channel, sharing the date axis. Returns '' if there isn't
// enough to plot. A legend is rendered separately by the caller.
function multiLineChartSvg(channelDaily: Ga4VisualsView['channelDaily']): string {
  const series = (channelDaily ?? []).filter((c) => c.series && c.series.length >= 2);
  if (series.length < 2) return '';
  const n = Math.max(...series.map((c) => c.series.length));
  const W = 720;
  const H = 200;
  const l = 48;
  const r = 14;
  const t = 14;
  const b = 26;
  const iw = W - l - r;
  const ih = H - t - b;
  const maxV = Math.max(1, ...series.flatMap((c) => c.series.map((p) => p.sessions)));
  const x = (i: number): number => l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number): number => t + ih - (v / maxV) * ih;
  const lines = series
    .map((c, ci) => {
      const color = PALETTE[ci % PALETTE.length];
      const pts = c.series.map((p, i) => `${x(i).toFixed(1)},${y(p.sessions).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" style="fill:none;stroke:${color};stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round;opacity:.95"/>`;
    })
    .join('');
  const first = series[0].series;
  const xlab = (i: number, anchor: string): string =>
    first[i] ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" style="font-size:10px;fill:${AXIS}">${esc(fmtDay(first[i].date))}</text>` : '';
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:720px;display:block;margin:8px 0" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily sessions by channel">` +
    `<line x1="${l}" y1="${(t + ih).toFixed(1)}" x2="${W - r}" y2="${(t + ih).toFixed(1)}" style="stroke:rgba(148,163,184,.35);stroke-width:1"/>` +
    `<text x="${l - 7}" y="${(t + 4).toFixed(1)}" text-anchor="end" style="font-size:10px;fill:${AXIS}">${maxV.toLocaleString('en-US')}</text>` +
    lines +
    xlab(0, 'start') +
    xlab(n - 1, 'end') +
    `</svg>`
  );
}

function legendHtml(channelDaily: Ga4VisualsView['channelDaily']): string {
  // Same filter as multiLineChartSvg (>= 2) so legend swatch colours line up with the plotted lines.
  const series = (channelDaily ?? []).filter((c) => c.series && c.series.length >= 2);
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

export function ga4VisualsHtml(v: Ga4VisualsView): string {
  if (!v || (!v.daily?.length && !v.devices?.length && !v.channels?.length)) return '';
  const cardTd = (inner: string): string =>
    `<td style="width:50%;vertical-align:top;padding:6px"><div style="border:1px solid ${BORDER};border-radius:10px;padding:12px 14px;background:${SURFACE}">${inner}</div></td>`;
  // Only show the trend pill/summary/line chart when there are enough days to characterise it (>=5),
  // matching the markdown report's section-3 guard so the two surfaces never disagree.
  const trend = (v.daily?.length ?? 0) >= 5
    ? `<div style="margin-top:6px;font-size:13px;color:${TEXT};line-height:1.5">` +
      `<span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:.3px;padding:2px 9px;border-radius:999px;color:#fff;background:${pillColor(v.trendLabel)};margin-right:8px">${esc(v.trendLabel)}</span>` +
      `${esc(v.trendSummary)}</div>` +
      lineChartSvg(v.daily, v.peakIndex)
    : '';
  const byChannelChart = multiLineChartSvg(v.channelDaily ?? []);
  const byChannel = byChannelChart ? label('Sessions by channel') + byChannelChart + legendHtml(v.channelDaily ?? []) : '';
  return (
    `<section style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT};line-height:1.5">` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#2563eb">Traffic trend</div>` +
    `<h2 style="font-size:18px;margin:2px 0 2px;color:${TEXT}">Traffic trend &amp; visualisations</h2>` +
    trend +
    byChannel +
    `<table role="presentation" style="border-collapse:separate;border-spacing:0;width:100%;margin-top:8px;table-layout:fixed"><tbody><tr>` +
    cardTd(label('Device split') + barList(v.devices ?? [])) +
    cardTd(label('Channel mix (sessions)') + barList(v.channels ?? [])) +
    `</tr></tbody></table>` +
    `</section>`
  ).replace(/—/g, '-');
}
