// Pure GA4 data-quality engine. Unlike audit_ga4_property (which checks CONFIG),
// this looks at the actual reporting data over a window and flags problems that
// silently corrupt analytics: traffic landing in the "Unassigned" channel, a
// high share of "(not set)" source/medium, or no data at all. No I/O — the
// data-service fetches the session counts and feeds them in, so the thresholds
// are fully unit-testable.

import type { ScorecardFinding, Severity } from './scorecard';

export interface DataQualityCounts {
  /** Total sessions in the window — an exact no-dimension sessions query (matches the baseline's
   *  session total; the data layer falls back to the channel-group sum only if that query is empty). */
  totalSessions: number;
  /** sessionDefaultChannelGroup → sessions (complete; channel groups are few). */
  channelGroups: Array<{ name: string; sessions: number }>;
  /** sessionSourceMedium → sessions, top-N by sessions (tail is negligible). */
  sourceMediums: Array<{ name: string; sessions: number }>;
  windowDays: number;
  /** YYYY-MM-DD window bounds in the property's timezone (set by the data layer). */
  startDate?: string;
  endDate?: string;
  /** The current date in the property's timezone (YYYY-MM-DD) — set for trailing-N-day windows so the
   *  trend engine can exclude an in-progress final day. Undefined for custom historical ranges. */
  todayYmd?: string;
  // The next three are OPTIONAL best-effort signals: a failed/absent query leaves the field undefined,
  // and each detector SKIPS its check when its field is missing — so older callers keep working and a
  // single flaky query never breaks the whole audit.
  /** hostName → sessions (top-N). Feeds internal/staging-traffic detection. */
  hostnames?: Array<{ name: string; sessions: number }>;
  /** sessionSource → sessions + engagedSessions (top-N). Feeds referral/ghost-spam detection. */
  sources?: Array<{ name: string; sessions: number; engagedSessions: number }>;
  /** newVsReturning → sessions. Feeds identity-fragmentation detection. */
  newVsReturning?: Array<{ name: string; sessions: number }>;
  /** The property's createTime as YYYY-MM-DD (set by the data layer from admin.properties.get). Lets the
   *  fragmentation detector skip brand-new properties, where ~0% returning users is expected, not a defect. */
  propertyCreatedYmd?: string;
}

export interface Ga4DataQualityResult {
  totalSessions: number;
  windowDays: number;
  startDate?: string;
  endDate?: string;
  /** Human-readable span, e.g. "Jan 1 – Jan 28, 2026" (null if dates absent). */
  dateRange: string | null;
  findings: ScorecardFinding[];
}

const DQ = 'data_quality';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Format a YYYY-MM-DD..YYYY-MM-DD span like "Jan 1 – Jan 28, 2026". Pure (no
 *  Date) so it stays unit-testable; returns null if either bound is missing/bad. */
export function formatDateRange(start?: string, end?: string): string | null {
  const parse = (s?: string): { y: number; m: number; d: number } | null => {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return Number.isInteger(y) && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y, m, d } : null;
  };
  const a = parse(start);
  const b = parse(end);
  if (!a || !b) return null;
  const md = (x: { m: number; d: number }) => `${MONTHS[x.m - 1]} ${x.d}`;
  return a.y === b.y ? `${md(a)} – ${md(b)}, ${b.y}` : `${md(a)}, ${a.y} – ${md(b)}, ${b.y}`;
}

/** [startDate, endDate] (YYYY-MM-DD) for the last `days` INCLUSIVE calendar days
 *  ending on todayYmd. Pure + UTC-anchored (DST-immune) so it's unit-testable;
 *  the data layer passes `today` resolved in the GA4 property's timezone, and
 *  these explicit bounds are what gets queried — so displayed == queried. */
export function windowDates(todayYmd: string, days: number): { startDate: string; endDate: string } {
  const [y, m, d] = todayYmd.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = new Date(Date.UTC(y, m - 1, d) - Math.max(0, days - 1) * 86400000);
  const startDate = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
  return { startDate, endDate: todayYmd };
}

function share(part: number, total: number): number {
  // Clamp to 100: the numerator (a channel/source bucket) and the denominator (a separate no-dimension
  // sessions query) come from different GA4 requests, so estimation drift could otherwise print >100%.
  return total > 0 ? Math.min(100, (part / total) * 100) : 0;
}

// A share of total sessions → severity. Below 5% isn't worth flagging.
function severityForShare(pct: number): Severity | null {
  if (pct >= 25) return 'high';
  if (pct >= 10) return 'medium';
  if (pct >= 5) return 'low';
  return null;
}

function sumWhere(rows: Array<{ name: string; sessions: number }>, re: RegExp): number {
  return rows.filter((r) => re.test(r.name)).reduce((s, r) => s + r.sessions, 0);
}

// Known ghost-/referral-spam hosts — hits from these never actually loaded the site; a bot pinged GA4's
// Measurement Protocol directly (or a share-button/SEO-spam script injected the referrer). Curated list.
const REFERRAL_SPAM_RE =
  /(semalt|buttons-for-website|free-?share-?buttons|best-?seo-?offer|darodar|ilovevitaly|econom\.co|success-seo|4webmasters|trafficmonetizer|get-free-traffic-now|sexyali|simple-share-buttons|social-buttons|floating-share-buttons|guardlink|videos-for-your-business)/i;
// Registrable domains (last two dot-labels) of BIG legitimate referrers that routinely show low engaged-
// session ratios — search engines, social/messaging apps, email clients. Their in-app-browser and prefetch
// traffic must NOT be mistaken for ghost bots by the zero-engagement heuristic.
const KNOWN_GOOD_REFERRER_DOMAINS = new Set([
  'google.com', 'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 't.co', 'reddit.com',
  'linkedin.com', 'lnkd.in', 'youtube.com', 'pinterest.com', 'tiktok.com', 'snapchat.com', 'whatsapp.com',
  'telegram.org', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com', 'yandex.com', 'yandex.ru',
  'outlook.com', 'live.com', 'messenger.com', 'quora.com', 'medium.com', 'substack.com', 'gmail.com',
]);

/** True for legitimate low-engagement referrers the ghost heuristic must never flag: mobile-app package
 *  ids (com.google.android.gm, android-app://...) and any host whose registrable domain (last two dot-
 *  labels) is a known big referrer (so mail.google.com→google.com and l.instagram.com→instagram.com are
 *  exempt, and subdomains are covered — unlike an exact-anchored match). Known SPAM still flags separately. */
function isKnownGoodReferrer(name: string): boolean {
  const lower = (name ?? '').trim().toLowerCase();
  if (!lower) return false;
  if (/^com\./i.test(lower) || /^android-app/i.test(lower)) return true; // mobile app package ids
  const labels = lower.split('.');
  if (labels.length >= 2) {
    const registrable = labels.slice(-2).join('.');
    if (KNOWN_GOOD_REFERRER_DOMAINS.has(registrable)) return true;
  }
  return false;
}

/** Referral/ghost spam: known-bad referrer hosts (always flagged), plus a zero-engagement heuristic for
 *  referral-looking sources (a source with ≥5% share and essentially no engaged sessions is almost always a
 *  bot that never rendered a page). Legitimate low-engagement referrers (search/social/email, in-app
 *  browsers) are exempt from the heuristic. Aggregates ALL suspects into ONE finding. Skipped if absent. */
export function detectReferralSpam(
  sources: Array<{ name: string; sessions: number; engagedSessions: number }> | undefined,
  total: number
): ScorecardFinding | null {
  if (!sources || sources.length === 0 || total <= 0) return null;
  const suspects = sources.filter((s) => {
    const name = (s.name ?? '').trim();
    if (!name) return false;
    if (REFERRAL_SPAM_RE.test(name)) return true; // known ghost/referral-spam host — always flag
    // GHOST signature: referral-looking host (has a '.'), meaningful share, ~zero engagement.
    if (!name.includes('.')) return false;
    if (isKnownGoodReferrer(name)) return false; // legit search/social/email/app referrer — not a ghost
    const sh = share(s.sessions, total);
    const engagementRatio = s.sessions > 0 ? s.engagedSessions / s.sessions : 0;
    return sh >= 5 && engagementRatio < 0.02;
  });
  if (suspects.length === 0) return null;
  const suspectSessions = suspects.reduce((sum, s) => sum + s.sessions, 0);
  const sharePct = share(suspectSessions, total);
  const sev = severityForShare(sharePct);
  if (!sev) return null;
  const names = suspects
    .slice()
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 6)
    .map((s) => s.name);
  const more = suspects.length > names.length ? ` and ${suspects.length - names.length} more` : '';
  return {
    severity: sev,
    category: DQ,
    message: `Suspected referral/ghost spam or zero-engagement bot traffic accounts for ${sharePct.toFixed(1)}% of sessions (${Math.min(suspectSessions, total)}/${total}) across ${suspects.length} source(s): ${names.join(', ')}${more}. These have near-zero engagement or match known spam domains and almost certainly never actually loaded the site.`,
    recommendation:
      'Create a GA4 data filter / referral-exclusion (or a hostname-match filter that only admits your real domains) to keep ghost spam out of reports — most of this traffic never hit the site and is inflating session and source counts. Confirm these are not legitimate low-engagement referrers (e.g. in-app browsers) before excluding them.',
  };
}

/** Non-production hostnames polluting the production property: localhost/loopback, raw IPs, *.local, ngrok,
 *  staging/dev/qa subdomains, and GENUINELY EPHEMERAL PaaS previews (Vercel branch/hash previews, Netlify
 *  deploy-previews, Cloudflare Pages hash previews). A stable public PaaS-default host (myapp.vercel.app,
 *  myapp.pages.dev, myapp.web.app) is NOT flagged — many real sites ARE hosted there in production. Skipped
 *  if `hostnames` is absent. NOTE: the pre-existing Unassigned/(not set) findings share this attribution
 *  class but are out of scope here.
 *  The message intentionally leads with a STABLE PREFIX ("Non-production or preview hostnames received ")
 *  so the monitor's dedup id (message.slice(0,24)) does not churn as the flagged share drifts run to run. */
export function detectInternalTraffic(
  hostnames: Array<{ name: string; sessions: number }> | undefined,
  total: number
): ScorecardFinding | null {
  if (!hostnames || hostnames.length === 0 || total <= 0) return null;
  const isNonProd = (raw: string): boolean => {
    const name = (raw ?? '').trim().toLowerCase();
    if (!name) return false;
    // Unambiguous non-production hosts.
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(name)) return true;
    if (/^(staging\.|stage\.|dev\.|test\.|qa\.|uat\.|preview\.|sandbox\.|local\.)/.test(name)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true; // raw IPv4
    if (/\.local$/.test(name)) return true;
    if (/\.ngrok\.[a-z]+$/i.test(name)) return true; // ngrok tunnels are never production
    // GENUINELY EPHEMERAL PaaS previews only (a stable myapp.vercel.app / myapp.pages.dev is NOT matched).
    if (/-git-.+\.vercel\.app$/i.test(name)) return true; // Vercel git-branch preview
    if (/-[a-z0-9]{8,}\.vercel\.app$/i.test(name)) return true; // Vercel deployment-hash preview
    if (/^deploy-preview-\d+--/i.test(name)) return true; // Netlify deploy preview
    if (/--[a-z0-9-]+\.netlify\.app$/i.test(name)) return true; // Netlify branch deploy
    if (/^[0-9a-f]{8}\.[a-z0-9-]+\.pages\.dev$/i.test(name)) return true; // Cloudflare Pages hash preview
    return false;
  };
  const offenders = hostnames.filter((h) => isNonProd(h.name));
  // Guard: a single production hostname is the healthy norm — say nothing.
  if (offenders.length === 0) return null;
  const offSessions = offenders.reduce((s, h) => s + h.sessions, 0);
  const sharePct = share(offSessions, total);
  const sev = severityForShare(sharePct);
  if (!sev) return null;
  const names = offenders
    .slice()
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 8)
    .map((h) => h.name);
  const more = offenders.length > names.length ? ` and ${offenders.length - names.length} more` : '';
  return {
    severity: sev,
    category: DQ,
    message: `Non-production or preview hostnames received ${sharePct.toFixed(1)}% of sessions (${Math.min(offSessions, total)}/${total}): ${names.join(', ')}${more}.`,
    recommendation:
      'If these are not your production domain, the GA4/GTM tag is firing in non-production/preview environments; use a separate GA4 property/stream for non-prod or an internal-traffic / hostname-match filter so only your production domain is counted.',
  };
}

/** Whole days from YYYY-MM-DD `a` to `b` (b - a). Pure + UTC-anchored (DST-immune); null on bad input. */
function daysBetween(a?: string, b?: string): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** Identity fragmentation: over a 2+ week window with real volume, essentially zero returning users means the
 *  same people are minting a fresh anonymous id each visit (Consent Mode denials, short cookie/ITP, no user_id),
 *  inflating "new user" counts. Skipped unless windowDays ≥ 14 and total ≥ 500. Also skipped when the property
 *  is brand new (the window starts < 30 days after createTime — no time for a returning cohort to form), when
 *  both the window start and property createTime are known. */
export function detectUserFragmentation(
  newVsReturning: Array<{ name: string; sessions: number }> | undefined,
  total: number,
  windowDays: number,
  opts: { windowStartYmd?: string; propertyCreatedYmd?: string } = {}
): ScorecardFinding | null {
  if (!newVsReturning || newVsReturning.length === 0) return null;
  if (windowDays < 14 || total < 500) return null;
  // Brand-new property guard: if the window starts less than 30 days after the property was created, there
  // has been no chance for a returning cohort to build up, so ~0% returning is expected, not a defect.
  const ageAtWindowStart = daysBetween(opts.propertyCreatedYmd, opts.windowStartYmd);
  if (ageAtWindowStart !== null && ageAtWindowStart < 30) return null;
  let newSessions = 0;
  let returningSessions = 0;
  for (const b of newVsReturning) {
    const name = (b.name ?? '').trim().toLowerCase();
    if (name === 'new') newSessions += b.sessions;
    else if (name === 'returning') returningSessions += b.sessions;
    // ignore '(not set)' and anything else
  }
  const denom = newSessions + returningSessions;
  if (denom <= 0) return null;
  const returningShare = returningSessions / denom;
  if (returningShare >= 0.02) return null; // some returning users → not fragmented
  const severity: Severity = windowDays >= 28 && returningShare < 0.005 ? 'medium' : 'low';
  return {
    severity,
    category: DQ,
    message: `Over ${windowDays} days, returning users are only ${(returningShare * 100).toFixed(2)}% of sessions (${returningSessions}/${denom}) — essentially everyone is counted as new. If this property is new or you are running a first-touch acquisition campaign, near-zero returning users can be expected. Otherwise this is a classic identity-fragmentation signature: a fresh anonymous id is being minted each visit, so the same people are duplicated as many "new users" and user counts are inflated.`,
    recommendation:
      'Likely Consent Mode denying analytics_storage for most users, a short cookie lifetime/ITP, or no user_id. Verify Consent Mode is not denying analytics_storage for the majority, check the cookie lifetime, and consider setting a User-ID. Treat returning-user metrics and unique-user counts as unreliable until this is fixed.',
  };
}

export function auditGa4DataQuality(counts: DataQualityCounts): Ga4DataQualityResult {
  const findings: ScorecardFinding[] = [];
  const total = counts.totalSessions;
  const days = counts.windowDays;
  const dateRange = formatDateRange(counts.startDate, counts.endDate);
  // e.g. "the last 28 days (Jan 1 – Jan 28, 2026)" — range omitted if unknown.
  const windowText = `the last ${days} days${dateRange ? ` (${dateRange})` : ''}`;
  const base = { totalSessions: total, windowDays: days, startDate: counts.startDate, endDate: counts.endDate, dateRange };

  if (total <= 0) {
    findings.push({
      severity: 'high',
      category: DQ,
      message: `No sessions recorded in ${windowText} — the property may not be collecting data.`,
      recommendation: 'Confirm the GA4 tag fires on the site (Realtime should show traffic) and that the right measurement id is configured.',
    });
    return { ...base, findings };
  }

  const unassigned = sumWhere(counts.channelGroups, /unassigned/i);
  const uShare = share(unassigned, total);
  const uSev = severityForShare(uShare);
  const notSet = sumWhere(counts.sourceMediums, /\(not set\)/i);
  const nShare = share(notSet, total);
  const nSev = severityForShare(nShare);

  // "Unassigned" channel and a "(not set)" source/medium are almost always the SAME sessions losing
  // their referrer/UTM, so when both fire, merge them into one root-cause finding instead of two
  // separate advisories that inflate the count and hide the shared cause.
  const attribFix =
    'Usually social in-app browsers stripping the referrer, tags firing before consent, or redirect loss. Check campaign UTM tagging, Consent Mode and landing-page redirects — and treat this as direct evidence about the true source of any traffic spike.';
  if (uSev && nSev) {
    const sevRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
    const worse: Severity = sevRank[uSev] >= sevRank[nSev] ? uSev : nSev;
    findings.push({
      severity: worse,
      category: DQ,
      message: `Sessions are arriving without usable source data: the "Unassigned" channel is ${uShare.toFixed(1)}% (${Math.min(unassigned, total)}/${total}) and "(not set)" source/medium is ${nShare.toFixed(1)}% (${Math.min(notSet, total)}/${total}). These almost certainly overlap (the same sessions losing referrer/UTM), so source attribution is unreliable for roughly ${Math.round(Math.max(uShare, nShare))}% of traffic.`,
      recommendation: attribFix,
    });
  } else if (uSev) {
    findings.push({
      severity: uSev,
      category: DQ,
      message: `${uShare.toFixed(1)}% of sessions are in the "Unassigned" channel (${Math.min(unassigned, total)}/${total}).`,
      recommendation: 'Unassigned traffic usually means missing/incorrect UTMs or tags firing before consent — check campaign tagging and that the GA4 tag gets referrer/source data.',
    });
  } else if (nSev) {
    findings.push({
      severity: nSev,
      category: DQ,
      message: `${nShare.toFixed(1)}% of sessions have a "(not set)" source/medium (${Math.min(notSet, total)}/${total}).`,
      recommendation: 'A high "(not set)" source/medium share points to sessions starting without referrer/UTM data — often pre-consent tag fires or redirect loss. Verify Consent Mode and landing-page redirects.',
    });
  }

  // Best-effort signals — each SKIPS itself when its source data is absent (older callers / a failed query),
  // so the all-clear below still only fires when nothing at all flagged.
  const spam = detectReferralSpam(counts.sources, total);
  if (spam) findings.push(spam);
  const internal = detectInternalTraffic(counts.hostnames, total);
  if (internal) findings.push(internal);
  const fragmentation = detectUserFragmentation(counts.newVsReturning, total, days, {
    windowStartYmd: counts.startDate,
    propertyCreatedYmd: counts.propertyCreatedYmd,
  });
  if (fragmentation) findings.push(fragmentation);

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      category: DQ,
      message: `No major data-quality issues in ${windowText} (${total} sessions): Unassigned ${uShare.toFixed(1)}%, "(not set)" source/medium ${nShare.toFixed(1)}%.`,
    });
  }

  return { ...base, findings };
}
