// The audit's deterministic ANTI-LIE detectors, extracted so the GA4 MONITOR can run the exact same
// code on a schedule. Design rule: the monitor and the audit must return the SAME verdict on the same
// property - a monitor that says "all healthy" while the audit grades the property broken is lying to
// the customer. Shared input shapes + shared detectors make disagreement structurally impossible.
// Everything here is pure and unit-testable; no I/O.

import type { Ga4Baseline } from './data-service';
import type { DataQualityCounts } from './ga4-data-quality';
import type { Ga4CampaignReport } from './ga4-campaigns';
import type { Ga4PropertySnapshot } from './ga4-audit';
import { findChannelSpike, groupSeries, granularityFor } from '../../shared/ga4-visuals-html';
import { engagementClusters } from '../../shared/ga4-sections-html';

/** One confirmed anti-lie finding. Structurally compatible with the report's FindingRow AND mappable
 *  to a monitor alert (stable category = stable alert id). */
export interface AntiLieFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** concentration | referral_leakage | invalid_traffic | pii | self_referral | thresholding | attribution_mismatch */
  category: string;
  area: string;
  message: string;
  recommendation?: string;
  /** Consequence-first one-liner for the ALERT reader (a store owner): leads with the money or the
   *  decision at stake, no GA4 jargon. The analyst `message` stays for the report; renderers fall
   *  back to it when this is absent. */
  plain?: string;
  state: 'confirmed';
  businessRisk?: string;
}

// Payment gateways / PSPs whose referrals indicate missing referral exclusions: the buyer bounces to
// the gateway and back, GA4 re-attributes the purchase to the gateway, and referral/Direct inflate.
const GATEWAY_RE = /(razorpay|paypal|stripe|payu\b|cashfree|braintree|klarna|ccavenue|billdesk|instamojo|paytm|phonepe|mollie|adyen|worldpay|2checkout|payoneer|checkout\.com)/i;

// Campaign names that indicate PAID media (ad-platform shapes: Shopping/PMax/Search/Display formats and
// the bare numeric IDs Google Ads reports when a campaign was never given a name), vs channel-group names
// GA4 classifies as paid. Used to cross-check the two revenue pictures against each other.
const PAID_CAMPAIGN_RE = /(shopping|perf(ormance)?[\s_-]*max|p-?max|search|display|video|discovery|demand[\s_-]*gen|remarketing|retargeting|adv\+|^\d{6,}$)/i;
const PAID_CHANNEL_RE = /^(paid[\s_]|cross[\s_-]*network|display$)/i;

// PII reaching GA4 in page URLs: an email address anywhere in the path/query (raw or %40-encoded),
// or a personal-data query parameter with a value. Matched against the landing pages the audit
// already fetched; the finding always shows MASKED examples so the report never re-leaks the PII.
const PII_EMAIL_RE = /[a-z0-9._%+-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/i;
const PII_PARAM_RE = /[?&](email|e-?mail|phone|tel|mobile|first_?name|last_?name|full_?name|address|postcode|zip_?code)=([^&#]+)/i;
/** The RESTATED window total once a single-bucket channel burst is excluded: plain arithmetic
 *  (window sessions minus that channel's peak-bucket sessions), clearly labeled - the number a
 *  reader may quote while the burst is unexplained. Same spike detector as the finding and the
 *  evidence chart, so all three agree. null when no spike fires. PURE. */
export function restatedWithoutSpike(baseline: Ga4Baseline): { channel: string; peakLabel: string; excluded: number; sessions: number; restatedDeltaPct: number | null; headlineDeltaPct: number | null } | null {
  if (!baseline.channelDaily?.length) return null;
  const gran = granularityFor(baseline.dailySessions?.length ?? 0);
  const anchor = baseline.dailySessions?.[0]?.date ?? '';
  const spike = findChannelSpike(baseline.channelDaily.map((c) => ({ channel: c.channel, points: groupSeries(c.series, gran, anchor) })));
  if (!spike) return null;
  const restated = Math.max(0, baseline.sessions - spike.peakValue);
  const d = (cur: number): number | null => (baseline.priorSessions > 0 ? Math.round(((cur - baseline.priorSessions) / baseline.priorSessions) * 100) : null);
  return { channel: spike.channel, peakLabel: spike.peakLabel, excluded: spike.peakValue, sessions: restated, restatedDeltaPct: d(restated), headlineDeltaPct: d(baseline.sessions) };
}

export const maskPii = (page: string): string =>
  page
    .replace(new RegExp(PII_EMAIL_RE.source, 'gi'), '***@***')
    .replace(new RegExp(PII_PARAM_RE.source, 'gi'), (_m, key: string) => `?${key}=***`);

/** Anti-lie checks computed straight off the reporting data (both DETERMINISTIC, state confirmed):
 *  1. Concentration — one bucket (week/month) holding most of a channel that carries a meaningful
 *     share of all sessions: the headline session count and prior-period comparison then describe an
 *     event, not the business. Same detector the evidence chart uses, so chart and finding agree.
 *  2. Payment-gateway referral leakage — a PSP showing up as a referral source means referral
 *     exclusions are missing and purchase attribution is being re-assigned to the gateway.
 *  3. Campaign vs channel revenue reconciliation — paid-looking campaigns claiming revenue that no
 *     paid channel shows means the report contains two irreconcilable revenue pictures.
 *  4. Invalid-traffic signature — market engagement splitting into two clean populations (the same
 *     bimodality detector the Section-6 evidence chart uses): the low cluster is where bot/proxy/junk
 *     traffic concentrates, and when it carries a material session share it inflates the totals.
 *  5. PII reaching GA4 — email addresses or personal-data query params in page URLs, campaign
 *     names, or source strings violate Google's terms and create GDPR/DPDP exposure; the report
 *     shows MASKED examples, never the PII itself.
 *  6. Self-referrals — the site's OWN domain as a referral source: sessions are being split
 *     mid-visit (broken cross-domain linking / missing referral exclusion) and re-attributed.
 *  7. Data-thresholding exposure — Google Signals + small daily traffic means GA4 silently withholds
 *     rows below its privacy thresholds, so breakdowns under-count vs totals. */
export function antiLieFindings(baseline: Ga4Baseline | null, dqCounts: DataQualityCounts | null, campaigns?: Ga4CampaignReport | null, snapshot?: Ga4PropertySnapshot | null): AntiLieFinding[] {
  const out: AntiLieFinding[] = [];
  // The spike result is held so the reconciliation finding below can cross-reference it: untagged paid
  // campaigns landing in Direct/organic buckets produce BOTH the single-bucket spike and the revenue
  // mismatch, and a reader must see them as one root cause, not two unrelated problems.
  let spike: ReturnType<typeof findChannelSpike> = null;
  let spikePeriod = 'week';
  if (baseline && baseline.channelDaily?.length) {
    const gran = granularityFor(baseline.dailySessions?.length ?? 0);
    const anchor = baseline.dailySessions?.[0]?.date ?? '';
    spike = findChannelSpike(baseline.channelDaily.map((c) => ({ channel: c.channel, points: groupSeries(c.series, gran, anchor) })));
    if (spike) {
      const period = gran === 'day' ? 'day' : gran === 'week' ? 'week' : 'month';
      spikePeriod = period;
      const span = spike.periods === 2 ? `two adjacent ${period}s` : `a single ${period}`;
      // The restated total: the same arithmetic the reader is being told to do, done for them.
      const restated = Math.max(0, baseline.sessions - spike.peakValue);
      const sgn = (x: number): string => `${x >= 0 ? '+' : ''}${x}%`;
      const rd = baseline.priorSessions > 0 ? Math.round(((restated - baseline.priorSessions) / baseline.priorSessions) * 100) : null;
      const hd = baseline.priorSessions > 0 ? Math.round(((baseline.sessions - baseline.priorSessions) / baseline.priorSessions) * 100) : null;
      const restatedTxt = ` Restated without that bucket: ${restated.toLocaleString('en-US')} sessions${rd !== null && hd !== null ? ` (${sgn(rd)} vs prior, instead of the headline ${sgn(hd)})` : ''} - the quotable window total while the burst is unexplained.`;
      out.push({
        severity: 'high',
        category: 'concentration',
        area: 'Data quality',
        message: `${spike.peakSharePct}% of ${spike.channel} sessions arrived in ${span} (${spike.peakLabel}: ${spike.peakValue.toLocaleString('en-US')} vs ${spike.restValue.toLocaleString('en-US')} across every other ${period}), and ${spike.channel} is ${spike.channelSharePct}% of all sessions - that is an event (a bot burst, a scrape, or an untagged campaign), not a channel baseline, and it distorts the headline session count and the prior-period comparison.${restatedTxt}`,
        recommendation: `Identify what drove ${spike.channel} in ${spike.peakLabel} (source/medium + landing pages for that traffic); segment or exclude it before quoting ${spike.channel} numbers or window totals.`,
        plain: `Most of your ${spike.channel} traffic (${spike.peakSharePct}%) arrived in ${span}: the headline visitor numbers describe a one-off event, not your normal business. Without that burst you had ${restated.toLocaleString('en-US')} visits${rd !== null ? ` (${sgn(rd)} vs the prior period)` : ''} - use that number until the burst is explained.`,
        state: 'confirmed',
        businessRisk: 'Headline sessions and trend comparisons describe a one-off event, not the business',
      });
    }
  }
  const gateways = (dqCounts?.sourceMediums ?? []).filter((r) => / referral$/i.test(r.name) && GATEWAY_RE.test(r.name));
  if (gateways.length) {
    const total = gateways.reduce((s, g) => s + g.sessions, 0);
    out.push({
      severity: 'medium',
      category: 'referral_leakage',
      area: 'Data quality',
      message: `Payment-gateway referral leakage: ${gateways.map((g) => `${g.name} (${g.sessions.toLocaleString('en-US')} sessions)`).join(', ')} - buyers bouncing back from the payment page start a NEW session attributed to the gateway, so purchases are re-attributed away from the real channel and referral/Direct inflate (${total.toLocaleString('en-US')} sessions affected).`,
      recommendation: 'Add the gateway domains to "List unwanted referrals" (Admin > Data streams > Configure tag settings) so the purchase keeps its original attribution.',
      plain: 'Some of your sales are being credited to your payment provider instead of the marketing that earned them, so your best channels look weaker than they really are.',
      state: 'confirmed',
      businessRisk: 'Purchases credited to the payment gateway instead of the channel that earned them',
    });
  }
  // 4. Invalid-traffic signature: engagement bimodality across markets, computed by the SAME
  // engagementClusters detector as the Section-6 evidence chart so the finding and the chart can
  // never disagree. Only fires when the low cluster carries a material share of the listed sessions
  // (>= 3%, HIGH at >= 10%) - a couple of stray low-engagement visitors are not a bot wave.
  if (baseline?.geoPerformance && baseline.geoPerformance.length >= 4) {
    const rows = baseline.geoPerformance.map((g) => ({ name: g.country || '(not set)', pct: Math.round(g.engagementRate * 100), sessions: g.sessions }));
    const clusters = engagementClusters(rows);
    if (clusters) {
      const lowNames = new Set(clusters.low.map((r) => r.name));
      const lowSessions = rows.filter((r) => lowNames.has(r.name)).reduce((sum, r) => sum + r.sessions, 0);
      const total = rows.reduce((sum, r) => sum + r.sessions, 0);
      const sharePct = total > 0 ? (lowSessions / total) * 100 : 0;
      if (sharePct >= 3) {
        const highMin = Math.min(...clusters.high.map((r) => r.pct));
        out.push({
          severity: sharePct >= 10 ? 'high' : 'medium',
          category: 'invalid_traffic',
          area: 'Data quality',
          message: `Suspected invalid traffic: ${clusters.low.map((r) => `${r.name} (${r.pct}% engagement)`).join(', ')} sit ${clusters.gap} points below your other markets (${highMin}%+) - a split this clean separates real users from bot/proxy/junk traffic, and those markets carry ${lowSessions.toLocaleString('en-US')} sessions (${sharePct.toFixed(1)}% of the listed markets' total). Sessions excluding these markets: ${Math.max(0, baseline.sessions - lowSessions).toLocaleString('en-US')} (headline ${baseline.sessions.toLocaleString('en-US')}).`,
          recommendation: `Check the source/medium and hostnames behind ${clusters.low.map((r) => r.name).join(', ')}; if it is bot or proxy traffic, exclude it (internal-traffic rules or a segment) before quoting session totals or market comparisons.`,
          plain: `About ${lowSessions.toLocaleString('en-US')} visits (${sharePct.toFixed(1)}% of your listed markets) look like bot or junk traffic that cannot buy: your visitor totals are inflated by traffic that is not customers.`,
          state: 'confirmed',
          businessRisk: 'Session totals and market comparisons inflated by traffic that cannot buy',
        });
      }
    }
  }

  // 5. PII reaching GA4 - in page URLs, campaign names, or traffic sources. Deterministic regex over
  // data the audit already fetched. Google's GA terms PROHIBIT sending PII; beyond the ToS risk this
  // is GDPR/DPDP exposure and may require a data-deletion request. Campaign/source strings matter as
  // much as URLs: email tools that interpolate the recipient address into utm_campaign/utm_source
  // send one PII row per recipient. Examples are MASKED - the report must not repeat the PII.
  {
    const pageHits = (baseline?.landingPages ?? []).filter((lp) => PII_EMAIL_RE.test(lp.page) || PII_PARAM_RE.test(lp.page));
    const campHits = (campaigns?.taggedCampaigns ?? []).filter((c) => PII_EMAIL_RE.test(c.campaign));
    const srcHits = (dqCounts?.sourceMediums ?? []).filter((r) => PII_EMAIL_RE.test(r.name));
    if (pageHits.length || campHits.length || srcHits.length) {
      const sessions = [...pageHits, ...campHits, ...srcHits].reduce((sum, h) => sum + h.sessions, 0);
      const vectors = [pageHits.length ? 'page URLs' : '', campHits.length ? 'campaign names' : '', srcHits.length ? 'traffic sources' : ''].filter(Boolean).join(' and ');
      const parts: string[] = [];
      if (pageHits.length) parts.push(`${pageHits.length} of your top landing pages carry an email address or a personal-data query parameter (masked examples: ${pageHits.slice(0, 3).map((h) => `"${maskPii(h.page)}"`).join(', ')})`);
      if (campHits.length) parts.push(`${campHits.length === 1 ? 'a campaign name contains an email address' : `${campHits.length} campaign names contain email addresses`} (masked: ${campHits.slice(0, 3).map((h) => `"${maskPii(h.campaign)}"`).join(', ')})`);
      if (srcHits.length) parts.push(`${srcHits.length === 1 ? 'a traffic source carries an email address' : `${srcHits.length} traffic sources carry email addresses`} (masked: ${srcHits.slice(0, 3).map((h) => `"${maskPii(h.name)}"`).join(', ')})`);
      out.push({
        severity: 'high',
        category: 'pii',
        area: 'Privacy',
        message: `PII is being sent to GA4 in ${vectors}: ${parts.join('; ')}; ${sessions.toLocaleString('en-US')} sessions affected. Google's Analytics terms prohibit sending PII, and this is GDPR/DPDP exposure - the collected values may need a data-deletion request.`,
        recommendation: `Redact PII before the hit is sent: strip or hash personal-data query parameters in the tag (GTM URL-scrubbing variable or a redact rule), fix the site flows that put emails/phones in URLs${campHits.length || srcHits.length ? ', and rename campaigns/sources so a recipient address is never interpolated into UTM values (use a list or campaign id instead)' : ''}, then submit a GA4 data-deletion request for the affected ranges.`,
        plain: 'Customer emails or personal details are leaking into your analytics: that is a privacy and Google-terms problem, and the leaked history may need to be deleted.',
        state: 'confirmed',
        businessRisk: 'Google ToS violation + GDPR/DPDP exposure; historical data may need deletion',
      });
    }
  }

  // 6. Self-referrals: the site's OWN domain appearing as a referral source. The domain comes from
  // the web data streams' defaultUri; subdomains of it count too. Every self-referral session is a
  // visit that got SPLIT mid-journey (cross-domain linker broken or referral exclusion missing) and
  // re-attributed away from the channel that earned it.
  if (snapshot && dqCounts?.sourceMediums?.length) {
    const ownDomains = (snapshot.dataStreams ?? [])
      .map((d) => d.defaultUri || '')
      .filter(Boolean)
      .map((u) => {
        try { return new URL(u).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
      })
      .filter(Boolean);
    if (ownDomains.length) {
      const selfRefs = dqCounts.sourceMediums.filter((r) => {
        const m = /^(.*?) \/ referral$/i.exec(r.name);
        if (!m) return false;
        const src = m[1].trim().replace(/^www\./i, '').toLowerCase();
        return ownDomains.some((d) => src === d || src.endsWith(`.${d}`));
      });
      if (selfRefs.length) {
        const total = selfRefs.reduce((sum, g) => sum + g.sessions, 0);
        const sharePct = (dqCounts.totalSessions || 0) > 0 ? (total / dqCounts.totalSessions) * 100 : 0;
        out.push({
          severity: sharePct >= 2 ? 'high' : 'medium',
          category: 'self_referral',
          area: 'Data quality',
          message: `Self-referrals: ${selfRefs.map((g) => `${g.name} (${g.sessions.toLocaleString('en-US')} sessions)`).join(', ')} - your own site is showing up as a traffic source, which means sessions are being SPLIT mid-visit (broken cross-domain linking or a missing referral exclusion) and the second half of each visit is re-attributed to yourself (${total.toLocaleString('en-US')} sessions, ${sharePct.toFixed(1)}% of the window).`,
          recommendation: 'Add your own domain(s) to "List unwanted referrals" (Admin > Data streams > Configure tag settings), and if the journey crosses subdomains/domains (checkout, account, payment), configure cross-domain measurement in "Configure your domains" so the session survives the hop.',
          plain: 'Your own website is showing up as a traffic source: customer visits are being split in two mid-journey, so the marketing that actually brought the sale loses the credit.',
          state: 'confirmed',
          businessRisk: 'Sessions double-counted and conversions re-attributed to your own site instead of the real channel',
        });
      }
    }
  }

  // 7. Data-thresholding exposure: Google Signals + small daily traffic. GA4 withholds rows below its
  // privacy thresholds in that configuration, so breakdowns silently under-count vs the totals. LOW -
  // it is a documented platform behavior, but a reader comparing segment sums to totals must know.
  if (snapshot?.googleSignals === 'GOOGLE_SIGNALS_ENABLED' && baseline && baseline.dailySessions.length > 0) {
    const avgDaily = baseline.sessions / baseline.dailySessions.length;
    if (avgDaily > 0 && avgDaily < 300) {
      out.push({
        severity: 'low',
        category: 'thresholding',
        area: 'Data quality',
        message: `Reports are likely THRESHOLDED: Google Signals is enabled and daily traffic is small (~${Math.round(avgDaily)} sessions/day) - GA4 withholds rows below its privacy thresholds in this configuration, so demographic and low-volume breakdowns silently under-count and segment sums will not match totals.`,
        recommendation: 'For auditing, switch Reporting identity to "Device-based" (Admin > Reporting identity) to see unthresholded rows - it is reversible and does not delete data - or read small-segment numbers as floors, not counts.',
        state: 'confirmed',
        businessRisk: 'Breakdown tables silently under-count; small segments look emptier than they are',
      });
    }
  }

  // 3. Paid-campaign revenue vs paid-channel revenue. Numerator: tagged campaigns whose NAME is an ad-
  // platform shape (Shopping/PMax/Search/... or a bare numeric Google Ads ID) — email/newsletter UTMs
  // legitimately land in non-paid channels and must not trip this. Fires when the paid channels show
  // less than HALF of what those campaigns claim: the two revenue pictures then cannot both be quoted.
  if (campaigns && baseline?.channelPerformance?.length) {
    const paidCamps = campaigns.taggedCampaigns.filter((c) => c.revenue > 0 && PAID_CAMPAIGN_RE.test(c.campaign));
    const campRev = paidCamps.reduce((s, c) => s + c.revenue, 0);
    const paidChanRev = baseline.channelPerformance.filter((c) => PAID_CHANNEL_RE.test(c.channel)).reduce((s, c) => s + c.revenue, 0);
    if (campRev > 0 && paidChanRev < campRev / 2) {
      const cur = campaigns.currencyCode ? `${campaigns.currencyCode} ` : '';
      const m = (x: number): string => `${cur}${Math.round(x).toLocaleString('en-US')}`;
      // For the plain line: "your ads look Nx less profitable" - the one number an owner repeats.
      const ratio = paidChanRev > 0 ? campRev / paidChanRev : null;
      const ratioTxt = ratio && ratio >= 2 ? `about ${Math.round(ratio)}x` : 'far';
      // Auditable numerator: name the counted campaigns (top 3 + a count of the rest) so a reader can
      // re-add the total; zero-revenue campaigns (e.g. traffic-only campaigns) are never counted.
      const names = paidCamps.slice(0, 3).map((c) => `"${c.campaign}"`).join(', ') + (paidCamps.length > 3 ? ` + ${paidCamps.length - 3} more` : '');
      const topNonPaid = baseline.channelPerformance.filter((c) => !PAID_CHANNEL_RE.test(c.channel)).slice().sort((a, b) => b.revenue - a.revenue)[0];
      const landing = topNonPaid && topNonPaid.revenue > paidChanRev
        ? ` The likeliest explanation: that paid traffic is arriving without paid tagging and landing mislabeled in "${topNonPaid.channel}" (${m(topNonPaid.revenue)}, currently the top revenue channel); the alternative is that the campaign view counts ad-platform-attributed revenue while the channel view uses GA4 session attribution.`
        : ' Either the campaign view counts ad-platform-attributed revenue while the channel view uses GA4 session attribution, or paid traffic is being classified into non-paid channels.';
      // Same root cause as the single-bucket spike when both fired: untagged paid traffic produces the
      // spike AND the mismatch. Say so, or the reader treats them as two unrelated problems.
      const spikeLink = spike
        ? ` This is likely the same root cause as the ${spike.channel} ${spike.periods === 2 ? `two-${spikePeriod}` : `single-${spikePeriod}`} concentration flagged above - untagged campaign bursts land in ${spike.channel}/organic buckets, producing both that spike and this revenue mismatch.`
        : '';
      out.push({
        severity: 'high',
        category: 'attribution_mismatch',
        area: 'Data quality',
        message: `Campaign and channel revenue do not reconcile: ${paidCamps.length} paid-format campaign(s) with recorded revenue (${names}) claim ${m(campRev)}, but all paid channels combined show only ${m(paidChanRev)}.${landing} Either way this report contains two revenue pictures that cannot both be true as stated.${spikeLink}`,
        recommendation: 'Verify Google Ads auto-tagging (gclid) and the GA4-Google Ads link, add utm_medium=cpc/paid to ad links so paid sessions leave the organic/direct buckets, and quote revenue from ONE attribution view until the two reconcile.',
        plain: `Your ads look ${ratioTxt} less profitable than they are: campaigns brought in about ${m(campRev)}, but only ${m(paidChanRev)} of it is credited to paid ads. The rest is filed as free traffic, so your ad reports understate what the ads actually earned.`,
        state: 'confirmed',
        businessRisk: 'Paid-media budget and ROAS decisions made on revenue attributed to the wrong channel',
      });
    }
  }
  return out;
}
