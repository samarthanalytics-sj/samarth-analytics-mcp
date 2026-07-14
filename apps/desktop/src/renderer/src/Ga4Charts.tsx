// Interactive on-screen GA4 charts: the daily/weekly/monthly trend line + the per-channel multi-line
// chart, rendered as React SVG with a custom hover tooltip (a styled card that follows the cursor and
// shows each series' value for the pointed date/period). The PDF export keeps the static SVG string
// (shared/ga4-visuals-html.ts) — both share the grouping logic AND the lab-report template language
// (mono eyebrows, 4px cards, muted palette, callout-voice insights) so the two surfaces read the same.

import { useRef, useState, type CSSProperties } from 'react';
import type { Ga4VisualsView } from '../../shared/ipc';
import { granularityFor, granLabel, groupSeries, buildTrendInsights, findChannelSpike, type Gran, type GPoint, type TrendInsight } from '../../shared/ga4-visuals-html';

// Lab-report palette — identical to shared/ga4-visuals-html.ts so on-screen and PDF colours never diverge.
const PALETTE = ['#4F7BD1', '#1FA5B8', '#2E9E5E', '#D98A38', '#8E63C4', '#A63527', '#9A6206', '#6A6F78'];
const LINE = '#4F7BD1';
const PEAK = '#A63527';
const AXIS = '#8A8F98';
const MONO = `ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

interface Series {
  name: string;
  color: string;
  points: GPoint[];
}

function InteractiveChart({ series, area, peakLabel }: { series: Series[]; area?: boolean; peakLabel?: string }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = 720;
  const H = 210;
  const l = 48;
  const r = 14;
  const t = 16;
  const b = 30;
  const iw = W - l - r;
  const ih = H - t - b;
  const n = Math.max(1, ...series.map((s) => s.points.length));
  const maxV = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)));
  const x = (i: number): number => l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number): number => t + ih - (v / maxV) * ih;
  const peakIdx = peakLabel && series[0] ? series[0].points.reduce((best, p, i) => (p.value > series[0].points[best].value ? i : best), 0) : -1;
  const labels = series[0]?.points ?? [];

  const onMove = (e: React.MouseEvent): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((vbX - l) / (n <= 1 ? 1 : iw / (n - 1)))));
    setHover(i);
  };

  const tip: CSSProperties = {
    position: 'absolute',
    top: 4,
    left: `${(x(hover ?? 0) / W) * 100}%`,
    transform: hover !== null && x(hover) > W / 2 ? 'translateX(-100%)' : 'none',
    marginLeft: hover !== null && x(hover) > W / 2 ? -10 : 10,
    background: 'var(--surface, #FFFFFF)',
    border: '1px solid var(--border, #E3E3DC)',
    borderRadius: 4,
    boxShadow: '0 4px 14px rgba(0,0,0,.12)',
    padding: '7px 10px',
    fontSize: 12,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: 5,
  };

  return (
    <div ref={ref} style={{ position: 'relative', maxWidth: 720, margin: '8px 0' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }} role="img" aria-label="Sessions chart">
        <defs>
          <linearGradient id="ga4ReactArea" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={LINE} stopOpacity={0.28} />
            <stop offset="1" stopColor={LINE} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <line x1={l} y1={t + ih} x2={W - r} y2={t + ih} stroke="rgba(148,163,184,.35)" />
        <text x={l - 7} y={t + 4} textAnchor="end" fontSize="10" fontFamily={MONO} fill={AXIS}>
          {fmt(maxV)}
        </text>
        {area && series[0] && <path d={`M ${x(0)} ${t + ih} L ${series[0].points.map((p, i) => `${x(i)} ${y(p.value)}`).join(' L ')} L ${x(n - 1)} ${t + ih} Z`} fill="url(#ga4ReactArea)" />}
        {series.map((s, si) => (
          <polyline key={si} className="draw-line" style={{ '--dash': 2200, animationDelay: `${si * 0.12}s` } as CSSProperties} points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={area ? 2 : 1.8} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((s, si) => s.points.map((p, i) => <circle key={`${si}-${i}`} cx={x(i)} cy={y(p.value)} r={i === peakIdx && si === 0 ? 3.6 : 2.3} fill={i === peakIdx && si === 0 ? PEAK : s.color} stroke="var(--surface,#FFFFFF)" strokeWidth={1} />))}
        {peakIdx >= 0 && series[0]?.points[peakIdx] && (
          <text x={x(peakIdx)} y={y(series[0].points[peakIdx].value) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fontFamily={MONO} fill={PEAK}>
            {peakLabel}
          </text>
        )}
        {hover !== null && <line x1={x(hover)} y1={t} x2={x(hover)} y2={t + ih} stroke="rgba(148,163,184,.5)" strokeDasharray="3 3" />}
        {hover !== null && series.map((s, si) => (s.points[hover] ? <circle key={`h-${si}`} cx={x(hover)} cy={y(s.points[hover].value)} r={3.5} fill={s.color} stroke="var(--surface,#FFFFFF)" strokeWidth={1.5} /> : null))}
        <text x={x(0)} y={H - 9} textAnchor="start" fontSize="10" fontFamily={MONO} fill={AXIS}>
          {labels[0]?.label}
        </text>
        <text x={x(n - 1)} y={H - 9} textAnchor="end" fontSize="10" fontFamily={MONO} fill={AXIS}>
          {labels[n - 1]?.label}
        </text>
      </svg>
      {hover !== null && labels[hover] && (
        <div style={tip}>
          <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>{labels[hover].label}</div>
          {series.map((s, si) =>
            s.points[hover] ? (
              <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block', flex: '0 0 auto' }} />
                {series.length > 1 && <span>{s.name}</span>}
                <span style={{ marginLeft: 'auto', paddingLeft: 12, fontFamily: MONO, fontWeight: 600, color: 'var(--text)' }}>{fmt(s.points[hover].value)}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

// Template primitives — the same voice ga4-visuals-html.ts / ga4-sections-html.ts use.
const eyebrow: CSSProperties = { fontFamily: MONO, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-faint, #8A8F98)' };
const lbl: CSSProperties = { fontFamily: MONO, fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--text-faint, #8A8F98)', marginBottom: 6 };
const card: CSSProperties = { border: '1px solid var(--border, #E3E3DC)', borderRadius: 4, padding: '16px 18px 12px', background: 'var(--surface, #FFFFFF)', boxSizing: 'border-box' };
const vizTitle: CSSProperties = { fontSize: 15, fontWeight: 600, color: 'var(--text)', margin: '0 0 3px' };
const vizSub: CSSProperties = { fontSize: 13, color: 'var(--text-muted, #5B6069)', margin: '0 0 12px', maxWidth: '70ch' };
const vcap: CSSProperties = { fontFamily: MONO, fontSize: 11, color: 'var(--text-faint, #8A8F98)', lineHeight: 1.55, marginTop: 4 };

const INSIGHT_TONE: Record<TrendInsight['tone'], { bar: string; bg: string }> = {
  good: { bar: 'var(--c-green, #1E7A48)', bg: 'var(--c-green-bg, #F4FAF6)' },
  watch: { bar: 'var(--c-amber, #9A6206)', bg: 'var(--c-amber-bg, #FCF8EF)' },
  info: { bar: 'var(--c-blue, #26344E)', bg: 'var(--c-blue-bg, #F1F3F6)' },
};

// The deep-insights panel that sits beside the charts: peak, what drove it, concentration, device skew.
// Each insight is a template callout — left accent bar, mono eyebrow title, square-ish corners.
function InsightsPanel({ items }: { items: TrendInsight[] }): JSX.Element | null {
  if (!items.length) return null;
  return (
    <div style={{ ...card, padding: '14px 16px' }}>
      <div style={lbl}>What the data shows</div>
      {items.map((it, i) => {
        const tone = INSIGHT_TONE[it.tone];
        return (
          <div key={i} style={{ borderLeft: `3px solid ${tone.bar}`, background: tone.bg, borderRadius: '0 3px 3px 0', padding: '9px 12px', margin: '0 0 8px' }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.07em', textTransform: 'uppercase', color: tone.bar, marginBottom: 2 }}>{it.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>{it.body}</div>
          </div>
        );
      })}
    </div>
  );
}

function Bars({ rows }: { rows: Array<{ name: string; sessions: number }> }): JSX.Element {
  const total = rows.reduce((s, x) => s + x.sessions, 0) || 1;
  const top = [...rows].sort((a, b) => b.sessions - a.sessions).slice(0, 8);
  if (!top.length) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not available.</div>;
  return (
    <>
      {top.map((row, i) => {
        const pct = Math.max(0, Math.min(100, Math.round((row.sessions / total) * 100)));
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0', fontSize: 12 }}>
            <span style={{ width: 120, flex: '0 0 120px', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name || '(not set)'}</span>
            <span style={{ flex: 1, background: 'var(--surface-2, #EDEDE6)', borderRadius: 3, height: 13, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: PALETTE[i % PALETTE.length], borderRadius: 3 }} />
            </span>
            <span style={{ width: 40, flex: '0 0 40px', textAlign: 'right', fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>{pct}%</span>
          </div>
        );
      })}
    </>
  );
}

// The spike-decomposition evidence card the PDF already renders (spikeDecompositionHtml): the spiking
// channel's busiest bucket vs every other bucket combined, with the red "event, not a baseline" read.
// Driven by the SAME findChannelSpike detector as the concentration finding, so they can never disagree.
function SpikeCard({ grouped, gran }: { grouped: Array<{ channel: string; points: GPoint[] }>; gran: Gran }): JSX.Element | null {
  const spike = findChannelSpike(grouped);
  if (!spike) return null;
  const period = gran === 'day' ? 'day' : gran === 'week' ? 'week' : 'month';
  const maxV = Math.max(spike.peakValue, spike.restValue, 1);
  const bar = (label: string, val: number, color: string, pct: number, mutedVal: boolean): JSX.Element => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '7px 0', fontSize: 12.5 }}>
      <span style={{ width: 170, flex: '0 0 170px', color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ flex: 1, background: 'var(--surface-2, #EDEDE6)', borderRadius: 3, height: 16, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.max(1, Math.round((val / maxV) * 100))}%`, background: color, borderRadius: 3 }} />
      </span>
      <span style={{ width: 130, flex: '0 0 130px', textAlign: 'right', fontFamily: MONO, fontSize: 11.5, color: mutedVal ? 'var(--text-muted)' : PEAK, whiteSpace: 'nowrap' }}>
        {fmt(val)} · {pct}%
      </span>
    </div>
  );
  return (
    <div style={{ ...card, marginTop: 10 }}>
      <div style={vizTitle}>Where the {spike.channel} traffic actually came from</div>
      <div style={vizSub}>The channel's total for the window, split by its busiest {period} against every other {period} combined.</div>
      {bar(`${spike.periods === 2 ? `Busiest ${period}s` : `Busiest ${period}`} (${spike.peakLabel})`, spike.peakValue, PEAK, spike.peakSharePct, false)}
      {bar(`All other ${period}s`, spike.restValue, '#26344E', 100 - spike.peakSharePct, true)}
      <div style={{ margin: '12px 0 0', padding: '11px 14px', borderLeft: `3px solid ${PEAK}`, background: 'var(--c-red-bg, #FBF1EF)', fontSize: 13, color: 'var(--text)', borderRadius: '0 3px 3px 0', lineHeight: 1.5 }}>
        <b style={{ fontWeight: 600 }}>{spike.periods === 2 ? `Two adjacent ${period}s are` : `One ${period} is`} {spike.peakSharePct}% of {spike.channel}</b> ({spike.channelSharePct}% of all sessions in the window). That is an event, not a channel baseline - identify that traffic's source before quoting {spike.channel} numbers or the total session count.
      </div>
      <div style={{ ...vcap, marginTop: 10 }}>
        {spike.peakLabel}: {fmt(spike.peakValue)} sessions · all other {period}s combined: {fmt(spike.restValue)}. Computed from the same series as the chart above.
      </div>
    </div>
  );
}

export function Ga4Charts({ visuals: v }: { visuals: Ga4VisualsView }): JSX.Element | null {
  if (!v || (!v.daily?.length && !v.devices?.length && !v.channels?.length)) return null;
  const gran = granularityFor(v.daily?.length ?? 0);
  const anchor = v.daily?.[0]?.date ?? '';
  const trendPoints = groupSeries(v.daily ?? [], gran, anchor);
  const peakLabel = gran === 'day' ? 'peak' : 'busiest';
  const channelGrouped = (v.channelDaily ?? []).map((c) => ({ channel: c.channel || '(not set)', points: groupSeries(c.series, gran, anchor) }));
  // Filter first, THEN assign palette colours by filtered index — matches the PDF (multiLineChartSvg /
  // legendHtml colour after the >=2-points filter) so the on-screen and downloaded colours never diverge.
  const channelSeries: Series[] = channelGrouped
    .filter((s) => s.points.length >= 2)
    .map((s, i) => ({ name: s.channel, points: s.points, color: PALETTE[i % PALETTE.length] }));
  const untrusted = v.channelTrusted === false;
  // Trend-pattern chip in the lab voice: mono uppercase, square corners, muted status colours.
  const pillColor = /spike|volatile/i.test(v.trendLabel) ? '#9A6206' : /upward/i.test(v.trendLabel) ? '#1E7A48' : /downward/i.test(v.trendLabel) ? '#A63527' : '#6A6F78';
  const insights = buildTrendInsights(v);

  return (
    <div style={{ color: 'var(--text)', lineHeight: 1.5 }}>
      <div style={eyebrow}>The evidence</div>
      <h2 style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 10px', color: 'var(--text)' }}>Traffic trend &amp; visualisations</h2>
      {(v.metrics?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '0 0 12px' }}>
          {v.metrics!.map((m) => {
            const up = (m.deltaPct ?? 0) > 0.05;
            const down = (m.deltaPct ?? 0) < -0.05;
            const col = up ? '#1E7A48' : down ? '#A63527' : 'var(--text-faint)';
            const arrow = up ? '\u25B2' : down ? '\u25BC' : '\u00B7';
            const fmtDelta = (p: number): string => `${p >= 0 ? '+' : '-'}${Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 2)}%`;
            return (
              <div key={m.label} style={{ ...card, flex: '1 1 160px', minWidth: 150, padding: '12px 14px' }}>
                <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{m.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, margin: '2px 0', color: 'var(--text)' }}>{m.value}</div>
                {m.deltaPct == null ? (
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>no prior-window data</div>
                ) : (
                  <div style={{ fontSize: 12.5 }}>
                    <span style={{ color: col, fontWeight: 700 }}>{arrow} {fmtDelta(m.deltaPct)}</span>
                    <span style={{ color: 'var(--text-faint)' }}> vs prior ({m.prior})</span>
                  </div>
                )}
                {m.verdict !== 'safe' && m.verdict !== 'caution' && (
                  <div style={{ fontSize: 10.5, color: 'var(--c-amber, #9A6206)', marginTop: 2 }}>
                    {m.verdict === 'do_not_quote' ? 'not safe to quote (see Data Trust Matrix)' : 'unverified - treat with caution'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 300 }}>
          {(v.daily?.length ?? 0) >= 5 && (
            <div style={card}>
              <div style={vizTitle}>Sessions over the window ({granLabel(gran)})</div>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '0 0 4px' }}>
                <span style={{ display: 'inline-block', fontFamily: MONO, fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: 3, color: '#fff', background: pillColor, marginRight: 8 }}>{v.trendLabel}</span>
                {v.trendSummary}
              </div>
              <InteractiveChart series={[{ name: 'Sessions', color: LINE, points: trendPoints }]} area peakLabel={peakLabel} />
              <div style={vcap}>Hover a point for its exact value. Peak is marked in red.</div>
            </div>
          )}
          {untrusted && (
            <div style={{ fontSize: 11.5, color: 'var(--c-amber, #9A6206)', background: 'var(--c-amber-bg, #FCF8EF)', border: '1px solid var(--c-amber-border, #EAD9AE)', borderRadius: 4, padding: '6px 10px', margin: '8px 0' }}>
              ⚠ {(v.channelCaveat ?? 'The channel split is not safe to quote yet (see the Data Trust Matrix).').replace(/—/g, '-')} The channel charts below are greyed for that reason.
            </div>
          )}
          {channelSeries.length >= 2 && (
            <div style={{ opacity: untrusted ? 0.5 : 1 }}>
              <div style={{ ...card, marginTop: 10 }}>
                <div style={vizTitle}>Sessions by channel ({granLabel(gran)})</div>
                <div style={vizSub}>One line per channel on a shared axis - a spike that belongs to a single channel shows up here.</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', margin: '0 0 6px' }}>
                  {channelSeries.map((s, i) => (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 11, color: 'var(--text-muted)' }}>
                      <span style={{ width: 16, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                      {s.name}
                    </span>
                  ))}
                </div>
                <InteractiveChart series={channelSeries} />
              </div>
              <SpikeCard grouped={channelGrouped} gran={gran} />
            </div>
          )}
        </div>
        {insights.length > 0 && (
          <div style={{ flex: '1 1 280px', minWidth: 260 }}>
            <InsightsPanel items={insights} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        <div style={{ ...card, flex: 1, minWidth: 0 }}>
          <div style={lbl}>Device split</div>
          <Bars rows={v.devices ?? []} />
        </div>
        <div style={{ ...card, flex: 1, minWidth: 0, opacity: untrusted ? 0.5 : 1 }}>
          <div style={lbl}>Channel mix (sessions)</div>
          <Bars rows={v.channels ?? []} />
        </div>
      </div>
    </div>
  );
}
