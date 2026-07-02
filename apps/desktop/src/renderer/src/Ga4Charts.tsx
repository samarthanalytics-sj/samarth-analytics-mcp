// Interactive on-screen GA4 charts: the daily/weekly/monthly trend line + the per-channel multi-line
// chart, rendered as React SVG with a custom hover tooltip (a styled card that follows the cursor and
// shows each series' value for the pointed date/period). The PDF export keeps the static SVG string
// (shared/ga4-visuals-html.ts) — both share the grouping logic so they can't diverge.

import { useRef, useState, type CSSProperties } from 'react';
import type { Ga4VisualsView } from '../../shared/ipc';
import { granularityFor, granLabel, groupSeries, buildTrendInsights, type GPoint, type TrendInsight } from '../../shared/ga4-visuals-html';

const PALETTE = ['#3b82f6', '#06b6d4', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#ec4899'];
const LINE = '#3b82f6';
const PEAK = '#ef4444';
const AXIS = '#94a3b8';
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
    background: 'var(--surface, #fff)',
    border: '1px solid var(--border, #e3e6ea)',
    borderRadius: 8,
    boxShadow: '0 6px 18px rgba(0,0,0,.16)',
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
        <text x={l - 7} y={t + 4} textAnchor="end" fontSize="10" fill={AXIS}>
          {fmt(maxV)}
        </text>
        {area && series[0] && <path d={`M ${x(0)} ${t + ih} L ${series[0].points.map((p, i) => `${x(i)} ${y(p.value)}`).join(' L ')} L ${x(n - 1)} ${t + ih} Z`} fill="url(#ga4ReactArea)" />}
        {series.map((s, si) => (
          <polyline key={si} points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" stroke={s.color} strokeWidth={area ? 2 : 1.8} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {series.map((s, si) => s.points.map((p, i) => <circle key={`${si}-${i}`} cx={x(i)} cy={y(p.value)} r={i === peakIdx && si === 0 ? 3.6 : 2.3} fill={i === peakIdx && si === 0 ? PEAK : s.color} stroke="var(--surface,#fff)" strokeWidth={1} />))}
        {peakIdx >= 0 && series[0]?.points[peakIdx] && (
          <text x={x(peakIdx)} y={y(series[0].points[peakIdx].value) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill={PEAK}>
            {peakLabel}
          </text>
        )}
        {hover !== null && <line x1={x(hover)} y1={t} x2={x(hover)} y2={t + ih} stroke="rgba(148,163,184,.5)" strokeDasharray="3 3" />}
        {hover !== null && series.map((s, si) => (s.points[hover] ? <circle key={`h-${si}`} cx={x(hover)} cy={y(s.points[hover].value)} r={3.5} fill={s.color} stroke="var(--surface,#fff)" strokeWidth={1.5} /> : null))}
        <text x={x(0)} y={H - 9} textAnchor="start" fontSize="10" fill={AXIS}>
          {labels[0]?.label}
        </text>
        <text x={x(n - 1)} y={H - 9} textAnchor="end" fontSize="10" fill={AXIS}>
          {labels[n - 1]?.label}
        </text>
      </svg>
      {hover !== null && labels[hover] && (
        <div style={tip}>
          <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>{labels[hover].label}</div>
          {series.map((s, si) =>
            s.points[hover] ? (
              <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block', flex: '0 0 auto' }} />
                {series.length > 1 && <span>{s.name}</span>}
                <span style={{ marginLeft: 'auto', paddingLeft: 12, fontWeight: 600, color: 'var(--text)' }}>{fmt(s.points[hover].value)}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

const eyebrow: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#2563eb' };
const lbl: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 };

const INSIGHT_TONE: Record<TrendInsight['tone'], { bar: string; bg: string }> = {
  good: { bar: 'var(--c-green, #16a34a)', bg: 'var(--c-green-bg, #f0fdf4)' },
  watch: { bar: 'var(--c-amber, #d97706)', bg: 'var(--c-amber-bg, #fffbeb)' },
  info: { bar: 'var(--c-blue, #2563eb)', bg: 'var(--c-blue-bg, #eff6ff)' },
};

// The deep-insights panel that sits beside the charts: peak, what drove it, concentration, device skew.
function InsightsPanel({ items }: { items: TrendInsight[] }): JSX.Element | null {
  if (!items.length) return null;
  return (
    <div style={{ border: '1px solid var(--border, #e3e6ea)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface, #fff)', boxSizing: 'border-box' }}>
      <div style={lbl}>What the data shows</div>
      {items.map((it, i) => {
        const tone = INSIGHT_TONE[it.tone];
        return (
          <div key={i} style={{ borderLeft: `3px solid ${tone.bar}`, background: tone.bg, borderRadius: '0 6px 6px 0', padding: '7px 10px', margin: '0 0 8px' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: tone.bar, marginBottom: 2 }}>{it.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.45 }}>{it.body}</div>
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
            <span style={{ flex: 1, background: 'rgba(148,163,184,.18)', borderRadius: 5, height: 13, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: PALETTE[i % PALETTE.length], borderRadius: 5 }} />
            </span>
            <span style={{ width: 36, flex: '0 0 36px', textAlign: 'right', color: 'var(--text-muted)' }}>{pct}%</span>
          </div>
        );
      })}
    </>
  );
}

export function Ga4Charts({ visuals: v }: { visuals: Ga4VisualsView }): JSX.Element | null {
  if (!v || (!v.daily?.length && !v.devices?.length && !v.channels?.length)) return null;
  const gran = granularityFor(v.daily?.length ?? 0);
  const anchor = v.daily?.[0]?.date ?? '';
  const trendPoints = groupSeries(v.daily ?? [], gran, anchor);
  const peakLabel = gran === 'day' ? 'peak' : 'busiest';
  // Filter first, THEN assign palette colours by filtered index — matches the PDF (multiLineChartSvg /
  // legendHtml colour after the >=2-points filter) so the on-screen and downloaded colours never diverge.
  const channelSeries: Series[] = (v.channelDaily ?? [])
    .map((c) => ({ name: c.channel || '(not set)', points: groupSeries(c.series, gran, anchor) }))
    .filter((s) => s.points.length >= 2)
    .map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
  const untrusted = v.channelTrusted === false;
  const pillColor = /spike|volatile/i.test(v.trendLabel) ? '#f59e0b' : /upward/i.test(v.trendLabel) ? '#22c55e' : /downward/i.test(v.trendLabel) ? '#ef4444' : '#64748b';
  const cardStyle: CSSProperties = { border: '1px solid var(--border, #e3e6ea)', borderRadius: 10, padding: '12px 14px', background: 'var(--surface, #fff)', flex: 1, minWidth: 0 };
  const insights = buildTrendInsights(v);

  return (
    <div style={{ color: 'var(--text)', lineHeight: 1.5 }}>
      <div style={eyebrow}>Traffic trend</div>
      <h2 style={{ fontSize: 18, margin: '2px 0', color: 'var(--text)' }}>Traffic trend &amp; visualisations</h2>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 380px', minWidth: 300 }}>
          {(v.daily?.length ?? 0) >= 5 && (
            <>
              <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text)' }}>
                <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999, color: '#fff', background: pillColor, marginRight: 8 }}>{v.trendLabel}</span>
                {v.trendSummary} <span style={{ color: 'var(--text-faint)' }}>({granLabel(gran)}; hover a point for its value)</span>
              </div>
              <InteractiveChart series={[{ name: 'Sessions', color: LINE, points: trendPoints }]} area peakLabel={peakLabel} />
            </>
          )}
          {untrusted && (
            <div style={{ fontSize: 11.5, color: 'var(--c-amber, #b45309)', background: 'var(--c-amber-bg, #fef3c7)', border: '1px solid var(--c-amber-border, #fde68a)', borderRadius: 6, padding: '6px 10px', margin: '8px 0' }}>
              ⚠ {(v.channelCaveat ?? 'The channel split is not safe to quote yet (see the Data Trust Matrix).').replace(/—/g, '-')} The channel charts below are greyed for that reason.
            </div>
          )}
          {channelSeries.length >= 2 && (
            <div style={{ opacity: untrusted ? 0.5 : 1 }}>
              <div style={lbl}>Sessions by channel ({granLabel(gran)})</div>
              <InteractiveChart series={channelSeries} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', marginTop: 2 }}>
                {channelSeries.map((s, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span style={{ width: 11, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                    {s.name}
                  </span>
                ))}
              </div>
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
        <div style={cardStyle}>
          <div style={lbl}>Device split</div>
          <Bars rows={v.devices ?? []} />
        </div>
        <div style={{ ...cardStyle, opacity: untrusted ? 0.5 : 1 }}>
          <div style={lbl}>Channel mix (sessions)</div>
          <Bars rows={v.channels ?? []} />
        </div>
      </div>
    </div>
  );
}
