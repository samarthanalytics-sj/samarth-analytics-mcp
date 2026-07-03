// Pure GA4 traffic-trend engine. Looks at the daily sessions series and classifies the SHAPE of the
// window: a one-day spike, a multi-day burst, a sustained up/down trend, volatile, or steady. When
// it's a spike, it attributes the peak day to the channel that drove it (peak-day channel mix vs the
// window mix). No I/O — the data layer feeds the series in, so the thresholds are unit-testable.

export interface Ga4DayPoint {
  date: string; // GA4 "date" = YYYYMMDD
  sessions: number;
}
export interface Ga4TrendInput {
  dailySessions: Ga4DayPoint[];
  peakDayChannels: Array<{ name: string; sessions: number }> | null;
  windowChannels: Array<{ name: string; sessions: number }>;
  /** The current date in the property's timezone (YYYY-MM-DD or YYYYMMDD). When the last series day
   *  is this in-progress day, its partial count is excluded from spike/trend classification so it
   *  isn't misread as a real drop or spike. */
  todayYmd?: string;
}
export type Ga4TrendPattern = 'one_day_spike' | 'multi_day_spike' | 'uptrend' | 'downtrend' | 'volatile' | 'steady' | 'insufficient';

export interface Ga4TrendResult {
  pattern: Ga4TrendPattern;
  patternLabel: string;
  /** Peak day + how many times the daily average it was. */
  peak: { date: string; sessions: number; xAvg: number } | null;
  /** Index of the peak day in dailySessions (for chart highlighting); -1 if none. */
  peakIndex: number;
  /** The platform that drove the peak (top channel on the peak day) and how concentrated it was. */
  drivingChannel: { name: string; dayShare: number; windowShare: number } | null;
  /** Back-half vs front-half change (rounded %); null if not computable. */
  deltaPct: number | null;
  /** True when the trailing in-progress (partial) day was excluded from classification. */
  partialLastDayExcluded: boolean;
  summary: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (ymd: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? '?'} ${Number(m[3])}` : ymd || '?';
};
const round1 = (n: number): number => Math.round(n * 10) / 10;
const sum = (a: number[]): number => a.reduce((s, v) => s + v, 0);
const avg = (a: number[]): number => (a.length ? sum(a) / a.length : 0);

export function analyzeGa4Trend(input: Ga4TrendInput): Ga4TrendResult {
  const raw = input.dailySessions ?? [];
  // Exclude a trailing in-progress (partial) day from classification: its incomplete count would
  // otherwise read as a false drop/downtrend (or a false low). Only when it still leaves >= 5 days.
  const norm = (d?: string): string => (d ?? '').replace(/-/g, '');
  const lastIsPartial =
    raw.length > 5 && input.todayYmd != null && norm(raw[raw.length - 1]?.date) === norm(input.todayYmd);
  const series = lastIsPartial ? raw.slice(0, -1) : raw;
  const vals = series.map((d) => d.sessions);
  const n = vals.length;
  if (n < 5) {
    return { pattern: 'insufficient', patternLabel: 'Insufficient data', peak: null, peakIndex: -1, drivingChannel: null, deltaPct: null, partialLastDayExcluded: lastIsPartial, summary: 'Not enough days in this window to characterise the traffic trend.' };
  }

  const mean = avg(vals);
  const max = Math.max(...vals);
  const peakIndex = vals.indexOf(max);
  const variance = avg(vals.map((v) => (v - mean) ** 2));
  const std = Math.sqrt(variance);
  const xAvg = mean > 0 ? round1(max / mean) : 0;
  const cv = mean > 0 ? std / mean : 0;
  const half = Math.floor(n / 2);
  const firstAvg = avg(vals.slice(0, half));
  const secondAvg = avg(vals.slice(n - half));
  const delta = firstAvg > 0 ? (secondAvg - firstAvg) / firstAvg : 0;
  const deltaPct = firstAvg > 0 ? Math.round(delta * 100) : null;
  // Spike detection compares the peak to the OTHER days (peak removed) so the outlier can't inflate
  // its own threshold — mean+k*std collapses on short windows (n<8), which mislabels a one-day spike
  // as a trend. A spike = the peak is >= 3.5x the average of the rest AND >= 2x the next-highest day.
  const restVals = vals.filter((_, i) => i !== peakIndex);
  const restMean = restVals.length ? avg(restVals) : 0;
  const rest2nd = restVals.length ? Math.max(...restVals) : 0;
  const highDays = restMean > 0 ? vals.filter((v) => v >= restMean * 2.5).length : 0;
  const peak = peakIndex >= 0 ? { date: series[peakIndex].date, sessions: max, xAvg } : null;

  // Drive attribution: the top channel on the peak day, with its peak-day share vs its window share.
  let drivingChannel: Ga4TrendResult['drivingChannel'] = null;
  const pdc = input.peakDayChannels ?? [];
  if (pdc.length) {
    const top = [...pdc].sort((a, b) => b.sessions - a.sessions)[0];
    const daySum = sum(pdc.map((c) => c.sessions));
    const winSum = sum((input.windowChannels ?? []).map((c) => c.sessions));
    const winRow = (input.windowChannels ?? []).find((c) => c.name === top.name);
    drivingChannel = { name: top.name || '(not set)', dayShare: daySum > 0 ? top.sessions / daySum : 0, windowShare: winRow && winSum > 0 ? winRow.sessions / winSum : 0 };
  }
  const driverText = (): string =>
    drivingChannel
      ? `, driven mainly by ${drivingChannel.name} (${Math.round(drivingChannel.dayShare * 100)}% of that day's traffic vs ${Math.round(drivingChannel.windowShare * 100)}% across the whole window)`
      : '';

  const isSpike = restMean > 0 && max >= restMean * 3.5 && max >= rest2nd * 2;
  let pattern: Ga4TrendPattern;
  let patternLabel: string;
  let summary: string;
  if (isSpike && highDays <= 1) {
    pattern = 'one_day_spike';
    patternLabel = 'One-day spike';
    summary = `Traffic is otherwise flat with a single one-day spike on ${fmtDay(peak!.date)} (${max.toLocaleString('en-US')} sessions, ${xAvg}x the daily average)${driverText()}. This is a one-off, not a sustained increase.`;
  } else if (isSpike && highDays <= 3) {
    pattern = 'multi_day_spike';
    patternLabel = 'Multi-day spike';
    summary = `A short burst of ${highDays} unusually high days, peaking ${fmtDay(peak!.date)} at ${max.toLocaleString('en-US')} sessions (${xAvg}x the daily average)${driverText()}. Confirm whether it is a campaign or junk traffic before treating it as growth.`;
  } else if (deltaPct !== null && delta >= 0.3) {
    pattern = 'uptrend';
    patternLabel = 'Upward trend';
    summary = `A sustained upward trend: the back half of the window averaged ${deltaPct}% higher daily sessions than the front half. Peak ${fmtDay(peak!.date)} at ${max.toLocaleString('en-US')}.`;
  } else if (deltaPct !== null && delta <= -0.3) {
    pattern = 'downtrend';
    patternLabel = 'Downward trend';
    summary = `A sustained decline: the back half of the window averaged ${Math.abs(deltaPct)}% lower daily sessions than the front half. Investigate tracking or seasonality.`;
  } else if (firstAvg === 0 && secondAvg > 0) {
    pattern = 'uptrend';
    patternLabel = 'Upward trend';
    summary = `A sustained upward trend building from a near-zero start, peaking ${fmtDay(peak!.date)} at ${max.toLocaleString('en-US')} sessions.`;
  } else if (cv >= 0.6) {
    pattern = 'volatile';
    patternLabel = 'Volatile';
    summary = `Traffic swings widely day to day with no clear trend (peak ${fmtDay(peak!.date)} at ${max.toLocaleString('en-US')}). Daily figures are noisy; read weekly or monthly aggregates.`;
  } else {
    pattern = 'steady';
    patternLabel = 'Steady';
    summary = `Traffic is steady across the window with no spike or clear trend (peak ${fmtDay(peak!.date)} at ${max.toLocaleString('en-US')}).`;
  }

  if (lastIsPartial) summary += " (today's in-progress day is excluded so it isn't misread as a drop).";
  return { pattern, patternLabel, peak, peakIndex, drivingChannel, deltaPct, partialLastDayExcluded: lastIsPartial, summary };
}
