import assert from 'node:assert/strict';
import { auditGa4DataQuality, formatDateRange, windowDates } from '../ga4-data-quality';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log('\nGA4 data-quality audit:');

test('no sessions → a single high "not collecting" finding', () => {
  const r = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28 });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'high');
  assert.match(r.findings[0].message, /not be collecting/);
});

test('Unassigned + (not set) share a root cause → ONE merged finding at the worse severity', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [
      { name: 'Direct', sessions: 600 },
      { name: 'Unassigned', sessions: 300 }, // 30% → high
      { name: 'Organic Search', sessions: 100 },
    ],
    sourceMediums: [
      { name: '(direct) / (none)', sessions: 600 },
      { name: '(not set)', sessions: 120 }, // 12% → medium
      { name: 'google / organic', sessions: 100 },
    ],
    windowDays: 28,
  });
  assert.equal(r.findings.length, 1, 'merged, not two separate advisories');
  const f = r.findings[0];
  assert.equal(f.severity, 'high', 'merged severity = worse of the two (high)');
  assert.match(f.message, /30\.0%/);
  assert.match(f.message, /12\.0%/);
  assert.match(f.message, /without usable source data|overlap/);
  assert.equal(f.category, 'data_quality');
});

test('only one of Unassigned / (not set) flagged → that single finding (no spurious merge)', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Unassigned', sessions: 300 }, { name: 'Direct', sessions: 700 }], // 30% → high
    sourceMediums: [{ name: 'google / organic', sessions: 1000 }], // no (not set)
    windowDays: 28,
  });
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].message, /Unassigned/);
  assert.equal(r.findings[0].severity, 'high');
});

test('shares below 5% produce no problem findings, just an info "looks healthy"', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Direct', sessions: 960 }, { name: 'Unassigned', sessions: 40 }], // 4% → not flagged
    sourceMediums: [{ name: 'google / organic', sessions: 980 }, { name: '(not set)', sessions: 20 }], // 2% → not flagged
    windowDays: 7,
  });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, 'info');
  assert.match(r.findings[0].message, /No major data-quality issues/);
});

test('threshold boundaries: 5% → low, 10% → medium, 25% → high', () => {
  const at = (sessions: number) =>
    auditGa4DataQuality({
      totalSessions: 1000,
      channelGroups: [{ name: 'Unassigned', sessions }, { name: 'Direct', sessions: 1000 - sessions }],
      sourceMediums: [],
      windowDays: 28,
    }).findings.find((f) => /in the "Unassigned" channel/.test(f.message))?.severity;
  assert.equal(at(50), 'low'); // 5%
  assert.equal(at(100), 'medium'); // 10%
  assert.equal(at(250), 'high'); // 25%
  assert.equal(at(49), undefined); // 4.9% → not flagged
});

test('windowDates returns exactly `days` INCLUSIVE full days ending YESTERDAY (DST-immune, cross-month/year)', () => {
  // Ends at today-1: today is a partial day and GA4 processing lags, so only full days are compared.
  assert.deepEqual(windowDates('2026-01-29', 28), { startDate: '2026-01-01', endDate: '2026-01-28' });
  assert.deepEqual(windowDates('2026-03-01', 7), { startDate: '2026-02-22', endDate: '2026-02-28' }); // crosses Feb (28d)
  assert.deepEqual(windowDates('2026-01-03', 7), { startDate: '2025-12-27', endDate: '2026-01-02' }); // crosses year
  assert.deepEqual(windowDates('2026-01-15', 1), { startDate: '2026-01-14', endDate: '2026-01-14' }); // single day
});

test('formatDateRange renders a clean span and tolerates missing/cross-year bounds', () => {
  assert.equal(formatDateRange('2026-01-01', '2026-01-28'), 'Jan 1 – Jan 28, 2026');
  assert.equal(formatDateRange('2025-12-05', '2026-01-01'), 'Dec 5, 2025 – Jan 1, 2026');
  assert.equal(formatDateRange(undefined, '2026-01-28'), null);
  assert.equal(formatDateRange('2026-01-01', undefined), null);
  assert.equal(formatDateRange('garbage', '2026-01-28'), null);
});

test('the date range, when supplied, is shown in findings and echoed on the result', () => {
  const withDates = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Unassigned', sessions: 300 }, { name: 'Direct', sessions: 700 }],
    sourceMediums: [],
    windowDays: 28,
    startDate: '2026-01-01',
    endDate: '2026-01-28',
  });
  assert.equal(withDates.dateRange, 'Jan 1 – Jan 28, 2026');
  assert.equal(withDates.startDate, '2026-01-01');
  // no-data path also carries the range
  const noData = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28, startDate: '2026-01-01', endDate: '2026-01-28' });
  assert.match(noData.findings[0].message, /the last 28 days \(Jan 1 – Jan 28, 2026\)/);
  // healthy-summary path also carries the range
  const healthy = auditGa4DataQuality({ totalSessions: 1000, channelGroups: [{ name: 'Direct', sessions: 1000 }], sourceMediums: [], windowDays: 7, startDate: '2026-01-22', endDate: '2026-01-28' });
  assert.match(healthy.findings[0].message, /\(Jan 22 – Jan 28, 2026\)/);
});

test('without dates, findings fall back to "the last N days" and dateRange is null', () => {
  const r = auditGa4DataQuality({ totalSessions: 0, channelGroups: [], sourceMediums: [], windowDays: 28 });
  assert.equal(r.dateRange, null);
  assert.match(r.findings[0].message, /the last 28 days —/);
  assert.ok(!r.findings[0].message.includes('('), 'no empty parens');
});

// A healthy baseline whose channel/source buckets never trip the Unassigned/(not set) checks — so any
// finding that appears is from the new detectors, not the legacy ones.
const HEALTHY = {
  totalSessions: 1000,
  channelGroups: [{ name: 'Direct', sessions: 1000 }],
  sourceMediums: [{ name: 'google / organic', sessions: 1000 }],
  windowDays: 28,
};

console.log('\nGA4 data-quality — referral/ghost spam:');

test('a KNOWN spam referrer fires a finding at the correct share severity', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'google', sessions: 700, engagedSessions: 500 },
      { name: 'semalt.com', sessions: 300, engagedSessions: 250 }, // 30% → high, known spam even with engagement
    ],
  });
  const f = r.findings.find((x) => /referral\/ghost spam/i.test(x.message));
  assert.ok(f, 'spam finding present');
  assert.equal(f!.severity, 'high', '30% → high');
  assert.equal(f!.category, 'data_quality');
  assert.match(f!.message, /semalt\.com/);
});

test('a high-volume ZERO-engagement referral fires via the ghost heuristic', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'google', sessions: 850, engagedSessions: 600 },
      { name: 'ghostbot.example', sessions: 150, engagedSessions: 1 }, // 15% share, ~0 engagement → medium
    ],
  });
  const f = r.findings.find((x) => /referral\/ghost spam/i.test(x.message));
  assert.ok(f, 'ghost heuristic fired');
  assert.equal(f!.severity, 'medium', '15% → medium');
  assert.match(f!.message, /ghostbot\.example/);
});

test('a LEGIT low-engagement search source (google) does NOT fire the ghost heuristic', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'google', sessions: 500, engagedSessions: 2 }, // low engagement but excluded (search engine, no dot-based referral)
      { name: '(direct)', sessions: 500, engagedSessions: 3 },
    ],
  });
  assert.ok(!r.findings.some((x) => /referral\/ghost spam/i.test(x.message)), 'no spam finding for google/(direct)');
});

test('a non-referral no-dot source with zero engagement is not treated as a ghost host', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'newsletter', sessions: 400, engagedSessions: 0 }, // no '.', so not referral-looking → skipped
      { name: 'google', sessions: 600, engagedSessions: 500 },
    ],
  });
  assert.ok(!r.findings.some((x) => /referral\/ghost/i.test(x.message)), 'no-dot source is not ghost spam');
});

test('mobile app package ids (com.google.android.gm, android-app://…) are NOT flagged as spam', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'com.google.android.gm', sessions: 300, engagedSessions: 0 }, // Gmail app — low engagement but legit
      { name: 'android-app://com.linkedin.android', sessions: 200, engagedSessions: 1 }, // LinkedIn app — legit
      { name: 'google', sessions: 500, engagedSessions: 400 },
    ],
  });
  assert.ok(!r.findings.some((x) => /referral\/ghost/i.test(x.message)), 'app-package referrers are exempt');
});

test('big legit referrers by REGISTRABLE DOMAIN (mail.google.com, l.instagram.com, t.co) are NOT flagged', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'mail.google.com', sessions: 300, engagedSessions: 0 }, // →google.com, exempt even at 0 engagement
      { name: 'l.instagram.com', sessions: 300, engagedSessions: 2 }, // →instagram.com, exempt
      { name: 't.co', sessions: 200, engagedSessions: 1 }, // Twitter link shortener, exempt
      { name: 'google', sessions: 200, engagedSessions: 150 },
    ],
  });
  assert.ok(!r.findings.some((x) => /referral\/ghost/i.test(x.message)), 'subdomains of known-good referrers are exempt');
});

test('a KNOWN spam host still fires even if it looks app/subdomain-ish (known-spam always wins)', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    sources: [
      { name: 'traffic.semalt.com', sessions: 300, engagedSessions: 250 }, // known spam even with engagement + subdomain
      { name: 'google', sessions: 700, engagedSessions: 500 },
    ],
  });
  const f = r.findings.find((x) => /referral\/ghost/i.test(x.message));
  assert.ok(f, 'known spam still flags');
  assert.match(f!.message, /semalt/);
});

console.log('\nGA4 data-quality — internal/non-production traffic:');

test('localhost + staging + a raw IP fire with the correct share severity', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [
      { name: 'www.example.com', sessions: 700 },
      { name: 'localhost', sessions: 120 },
      { name: 'staging.example.com', sessions: 120 },
      { name: '10.0.0.5', sessions: 60 }, // total non-prod = 300 → 30% → high
    ],
  });
  const f = r.findings.find((x) => /Non-production or preview hostnames/.test(x.message));
  assert.ok(f, 'internal-traffic finding present');
  assert.equal(f!.severity, 'high', '30% → high');
  assert.equal(f!.category, 'data_quality');
  assert.match(f!.message, /localhost/);
  assert.match(f!.message, /staging\.example\.com/);
  // Stable leading prefix (so the monitor dedup id, message.slice(0,24), never churns as the share drifts).
  assert.ok(f!.message.startsWith('Non-production or preview hostnames received '), 'stable leading prefix');
});

test('a LONE stable PaaS-default host (myapp.vercel.app) is NOT flagged (real sites host there in prod)', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [
      { name: 'www.example.com', sessions: 500 },
      { name: 'myapp.vercel.app', sessions: 300 }, // stable public prod host → NOT non-prod
      { name: 'myapp.pages.dev', sessions: 100 }, // stable Cloudflare Pages prod host → NOT non-prod
      { name: 'myapp.web.app', sessions: 100 }, // stable Firebase Hosting prod host → NOT non-prod
    ],
  });
  assert.ok(
    !r.findings.some((x) => /Non-production or preview hostnames/.test(x.message)),
    'stable PaaS-default hosts are not flagged as staging pollution'
  );
});

test('a GENUINE ephemeral Vercel git-branch preview DOES fire', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [
      { name: 'www.example.com', sessions: 800 },
      { name: 'myapp-git-main-team.vercel.app', sessions: 200 }, // 20% → medium, ephemeral preview
    ],
  });
  const f = r.findings.find((x) => /Non-production or preview hostnames/.test(x.message));
  assert.ok(f, 'git-branch preview flagged');
  assert.equal(f!.severity, 'medium', '20% → medium');
  assert.match(f!.message, /myapp-git-main-team\.vercel\.app/);
});

test('other ephemeral previews (Vercel hash, Netlify deploy-preview, Cloudflare hash) DO fire', () => {
  const hashVercel = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [{ name: 'www.example.com', sessions: 700 }, { name: 'myapp-a1b2c3d4e5.vercel.app', sessions: 300 }],
  });
  assert.ok(hashVercel.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'Vercel hash preview');
  const netlify = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [{ name: 'www.example.com', sessions: 700 }, { name: 'deploy-preview-42--mysite.netlify.app', sessions: 300 }],
  });
  assert.ok(netlify.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'Netlify deploy preview');
  const netlifyBranch = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [{ name: 'www.example.com', sessions: 700 }, { name: 'feature-x--mysite.netlify.app', sessions: 300 }],
  });
  assert.ok(netlifyBranch.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'Netlify branch deploy');
  const cfPages = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [{ name: 'www.example.com', sessions: 700 }, { name: 'a1b2c3d4.mysite.pages.dev', sessions: 300 }],
  });
  assert.ok(cfPages.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'Cloudflare Pages hash preview');
});

test('a stable Netlify default host (mysite.netlify.app) is NOT flagged', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    hostnames: [{ name: 'www.example.com', sessions: 700 }, { name: 'mysite.netlify.app', sessions: 300 }],
  });
  assert.ok(!r.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'stable netlify.app default not flagged');
});

test('a lone production hostname does NOT fire', () => {
  const r = auditGa4DataQuality({ ...HEALTHY, hostnames: [{ name: 'www.example.com', sessions: 1000 }] });
  assert.ok(!r.findings.some((x) => /Non-production or preview hostnames/.test(x.message)), 'production-only → no finding');
});

console.log('\nGA4 data-quality — identity fragmentation:');

test('returning ≈ 0 over 28 days at real volume fires medium', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    newVsReturning: [
      { name: 'new', sessions: 998 },
      { name: 'returning', sessions: 2 }, // 0.2% → <0.5% and 28d → medium
    ],
  });
  const f = r.findings.find((x) => /identity-fragmentation/i.test(x.message));
  assert.ok(f, 'fragmentation finding present');
  assert.equal(f!.severity, 'medium', '<0.5% over 28d → medium');
  assert.equal(f!.category, 'data_quality');
});

test('a small-but-present returning share (>=2%) fires low, not medium', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    newVsReturning: [
      { name: 'new', sessions: 985 },
      { name: 'returning', sessions: 10 }, // ~1.0% → <2% but >=0.5% → low
    ],
  });
  const f = r.findings.find((x) => /identity-fragmentation/i.test(x.message));
  assert.ok(f, 'fragmentation finding present');
  assert.equal(f!.severity, 'low');
});

test('a HEALTHY 30% returning share does NOT fire', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    newVsReturning: [
      { name: 'new', sessions: 700 },
      { name: 'returning', sessions: 300 },
    ],
  });
  assert.ok(!r.findings.some((x) => /identity-fragmentation/i.test(x.message)), 'healthy returning share → no finding');
});

test('a short window (<14 days) does NOT fire even with ~0 returning', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 7,
    newVsReturning: [
      { name: 'new', sessions: 999 },
      { name: 'returning', sessions: 1 },
    ],
  });
  assert.ok(!r.findings.some((x) => /identity-fragmentation/i.test(x.message)), '<14d → skipped');
});

test('low volume (<500 sessions) does NOT fire even with ~0 returning over 28 days', () => {
  const r = auditGa4DataQuality({
    totalSessions: 400,
    channelGroups: [{ name: 'Direct', sessions: 400 }],
    sourceMediums: [{ name: 'google / organic', sessions: 400 }],
    windowDays: 28,
    newVsReturning: [
      { name: 'new', sessions: 399 },
      { name: 'returning', sessions: 1 },
    ],
  });
  assert.ok(!r.findings.some((x) => /identity-fragmentation/i.test(x.message)), '<500 sessions → skipped');
});

test('a BRAND-NEW property (window starts <30d after createTime) does NOT fire', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    startDate: '2026-01-01', // window starts 10 days after the property was created → too young
    endDate: '2026-01-28',
    propertyCreatedYmd: '2025-12-22',
    newVsReturning: [
      { name: 'new', sessions: 998 },
      { name: 'returning', sessions: 2 },
    ],
  });
  assert.ok(!r.findings.some((x) => /identity-fragmentation/i.test(x.message)), 'new property → expected ~0 returning, skipped');
});

test('an OLD property (window starts >=30d after createTime) DOES fire despite the guard', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    startDate: '2026-01-01', // window starts ~1 year after creation → old enough to expect returning users
    endDate: '2026-01-28',
    propertyCreatedYmd: '2025-01-01',
    newVsReturning: [
      { name: 'new', sessions: 998 },
      { name: 'returning', sessions: 2 },
    ],
  });
  assert.ok(r.findings.some((x) => /identity-fragmentation/i.test(x.message)), 'established property with ~0 returning → fires');
});

test('the message softens with a new-property/first-touch caveat (covers unknown-createTime custom ranges)', () => {
  const r = auditGa4DataQuality({
    ...HEALTHY,
    windowDays: 28,
    newVsReturning: [
      { name: 'new', sessions: 998 },
      { name: 'returning', sessions: 2 },
    ],
  });
  const f = r.findings.find((x) => /identity-fragmentation/i.test(x.message));
  assert.ok(f, 'fires when createTime is unknown (no guard data)');
  assert.match(f!.message, /If this property is new or you are running a first-touch acquisition campaign/);
});

console.log('\nGA4 data-quality — backward compatibility:');

test('with the 3 optional fields ABSENT, the engine behaves exactly as before (all-clear info)', () => {
  const r = auditGa4DataQuality(HEALTHY);
  assert.equal(r.findings.length, 1, 'only the all-clear finding');
  assert.equal(r.findings[0].severity, 'info');
  assert.match(r.findings[0].message, /No major data-quality issues/);
});

test('optional fields absent + a real Unassigned issue → still just the legacy finding', () => {
  const r = auditGa4DataQuality({
    totalSessions: 1000,
    channelGroups: [{ name: 'Unassigned', sessions: 300 }, { name: 'Direct', sessions: 700 }],
    sourceMediums: [],
    windowDays: 28,
  });
  assert.equal(r.findings.length, 1, 'no phantom detector findings when data absent');
  assert.match(r.findings[0].message, /Unassigned/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
