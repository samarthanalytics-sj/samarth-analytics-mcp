// Pure GA4 property configuration audit. No I/O — fully unit-testable. GA4 is
// READ-ONLY by design, so every finding is advisory (recommend a change for the
// user to make in the GA4 UI); there are no auto-fixes.

export interface Ga4DataStreamConfig {
  name: string;
  displayName: string;
  /** WEB_DATA_STREAM | ANDROID_APP_DATA_STREAM | IOS_APP_DATA_STREAM */
  type: string;
  /** Enhanced measurement on/off for WEB streams; null = unknown / not a web stream. */
  enhancedMeasurementEnabled: boolean | null;
}
export interface Ga4CustomDimensionConfig {
  parameterName: string;
  displayName: string;
  scope: string;
}
export interface Ga4PropertySnapshot {
  property: string;
  displayName: string;
  timeZone: string;
  currencyCode: string;
  industryCategory: string;
  dataRetention: { eventDataRetention: string; resetOnNewActivity: boolean } | null;
  // null on these means "could not be read" — distinct from an empty list, so a
  // failed sub-resource read is never reported as a real "zero" misconfiguration.
  keyEvents: Array<{ eventName: string }> | null;
  customDimensions: Ga4CustomDimensionConfig[] | null;
  customMetrics: Array<{ parameterName: string; displayName: string }>;
  dataStreams: Ga4DataStreamConfig[];
  googleAdsLinks: number | null;
  /** Google Signals state (e.g. GOOGLE_SIGNALS_ENABLED / _DISABLED); null = unread. */
  googleSignals: string | null;
}

export interface Ga4Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  /** collection | retention | conversions | measurement | privacy | integrations | benchmarking | customdef */
  category: string;
  message: string;
  recommendation: string;
}
/** Per-area coverage so the audit shows WHAT it checked, not only the problems.
 *  pass = checked, clean · partial = a low/medium issue · fail = a high issue ·
 *  not_verified = the backing config sub-resource couldn't be read (no access). */
export interface Ga4AreaStatus {
  area: string;
  status: 'pass' | 'partial' | 'fail' | 'not_verified';
}
export interface Ga4AuditReport {
  counts: {
    dataStreams: number;
    keyEvents: number;
    customDimensions: number;
    customMetrics: number;
    findings: number;
  };
  summary: { high: number; medium: number; low: number; info: number };
  findings: Ga4Finding[];
  /** Coverage table (Pass/Partial/Fail/Not Verified per area). */
  areas: Ga4AreaStatus[];
}

// Tokens that strongly indicate personal data in a custom dimension. GA4's terms
// prohibit sending PII. `user_id` is explicitly NOT PII (a pseudonymous id) and
// bare "name" is too broad (event_name, page_name…), so they are excluded.
const PII_RE =
  /\b(e-?mail|phone|tel(?:ephone)?|first.?name|last.?name|full.?name|fname|lname|surname|street|address|zip|postal.?code|ssn|social.?security|dob|date.?of.?birth|passport|national.?id)\b/i;

function piiMatch(text: string): string | null {
  // `_` and `.` are word characters to \b, which would hide the GA4-normal
  // snake_case names (user_email, phone_number) the check exists to catch.
  // Split them into words first so token boundaries are real.
  const m = text.replace(/[_.]+/g, ' ').match(PII_RE);
  return m ? m[0] : null;
}

export function auditGa4(s: Ga4PropertySnapshot): Ga4AuditReport {
  const findings: Ga4Finding[] = [];

  if (s.dataStreams.length === 0) {
    findings.push({
      severity: 'high',
      category: 'collection',
      message: 'This GA4 property has no data streams — it is not collecting any data.',
      recommendation: 'Create a Web (or App) data stream in Admin → Data streams and install the tag.',
    });
  }

  if (s.dataRetention && s.dataRetention.eventDataRetention === 'TWO_MONTHS') {
    findings.push({
      severity: 'medium',
      category: 'retention',
      message: 'Event data retention is 2 months (the default) — exploration/report data older than 2 months is discarded.',
      recommendation: 'Increase it to 14 months in Admin → Data settings → Data retention (the max for standard properties).',
    });
  }

  if (s.keyEvents !== null && s.keyEvents.length === 0) {
    findings.push({
      severity: 'medium',
      category: 'conversions',
      message: 'No key events (conversions) are marked — the property is not measuring conversion outcomes.',
      recommendation: 'Mark your important events (purchase, generate_lead, sign_up…) as key events in Admin → Key events.',
    });
  }

  for (const stream of s.dataStreams) {
    if (stream.type === 'WEB_DATA_STREAM' && stream.enhancedMeasurementEnabled === false) {
      findings.push({
        severity: 'low',
        category: 'measurement',
        message: `Enhanced measurement is OFF on web stream "${stream.displayName}" — page views, scrolls, outbound clicks and site search are not auto-collected.`,
        recommendation: 'Enable Enhanced measurement on the web stream unless you collect those events manually.',
      });
    }
  }

  for (const dim of s.customDimensions ?? []) {
    const hit = piiMatch(dim.displayName) ?? piiMatch(dim.parameterName);
    if (hit) {
      findings.push({
        severity: 'high',
        category: 'privacy',
        message: `Custom dimension "${dim.displayName || dim.parameterName}" looks like it may capture PII ("${hit}"). GA4's terms prohibit sending personally identifiable information.`,
        recommendation: 'Remove or hash/anonymize this dimension; never send email, phone, name, or address to GA4.',
      });
    }
  }

  if (s.googleAdsLinks === 0) {
    findings.push({
      severity: 'info',
      category: 'integrations',
      message: 'No Google Ads links — GA4 conversions are not imported to Ads and remarketing audiences cannot be built.',
      recommendation: 'Link Google Ads in Admin → Product links → Google Ads links if you run paid campaigns.',
    });
  }

  // Google Signals disabled while Ads is linked: a missed cross-device /
  // remarketing integration. Info + neutral — enabling Signals is a
  // consent-gated, privacy-sensitive choice, not a clear-cut fix.
  if (s.googleSignals === 'GOOGLE_SIGNALS_DISABLED' && (s.googleAdsLinks ?? 0) > 0) {
    findings.push({
      severity: 'info',
      category: 'integrations',
      message: 'Google Signals is disabled while Google Ads is linked — cross-device conversions and remarketing/demographics from signed-in Google users are unavailable.',
      recommendation: 'Consider enabling Google Signals in Admin → Data settings → Data collection, with appropriate user consent. Not required.',
    });
  }

  const industry = s.industryCategory;
  if (!industry || industry === 'INDUSTRY_CATEGORY_UNSPECIFIED') {
    findings.push({
      severity: 'info',
      category: 'benchmarking',
      message: 'Industry category is not set — benchmarking comparisons are unavailable.',
      recommendation: 'Set the industry category in Admin → Property details.',
    });
  }

  // Custom-definition slot usage — you cannot create more once the cap is hit, so warn near it.
  const dims = s.customDimensions ?? [];
  const eventDims = dims.filter((d) => d.scope === 'EVENT').length;
  const userDims = dims.filter((d) => d.scope === 'USER').length;
  if (eventDims >= 45) {
    findings.push({
      severity: 'low',
      category: 'customdef',
      message: `${eventDims} of 50 event-scoped custom dimension slots are in use.`,
      recommendation: 'Archive unused event-scoped custom dimensions before you hit the 50-slot cap (you cannot create more once it is full).',
    });
  }
  if (userDims >= 22) {
    findings.push({
      severity: 'low',
      category: 'customdef',
      message: `${userDims} of 25 user-scoped custom dimension slots are in use.`,
      recommendation: 'Archive unused user-scoped custom dimensions before you hit the 25-slot cap.',
    });
  }

  // More than one WEB stream usually means the same site double-counts users/sessions.
  const webStreams = s.dataStreams.filter((d) => d.type === 'WEB_DATA_STREAM').length;
  if (webStreams > 1) {
    findings.push({
      severity: 'info',
      category: 'collection',
      message: `${webStreams} web data streams are configured — the same site sending to more than one stream double-counts users and sessions.`,
      recommendation: 'Keep one web stream per site; remove or repurpose extra streams unless they are genuinely separate sites.',
    });
  }

  // A retention timer that does NOT reset on activity expires a returning user's earliest data.
  if (s.dataRetention && s.dataRetention.resetOnNewActivity === false) {
    findings.push({
      severity: 'low',
      category: 'retention',
      message: "User-data retention does not reset on new activity — a returning user's earliest data still expires on the original timer.",
      recommendation: 'Enable "Reset user data on new activity" in Admin → Data settings → Data retention so active users are retained.',
    });
  }

  // Per-area coverage (Pass / Partial / Fail / Not Verified) — so the audit reports WHAT it checked,
  // not only the problems. not_verified = the backing config sub-resource couldn't be read.
  const areaStatus = (categories: string[]): Ga4AreaStatus['status'] => {
    const fs = findings.filter((f) => categories.includes(f.category));
    if (fs.some((f) => f.severity === 'high')) return 'fail';
    if (fs.some((f) => f.severity === 'medium' || f.severity === 'low')) return 'partial';
    return 'pass';
  };
  const areaOf = (categories: string[], verified: boolean): Ga4AreaStatus['status'] =>
    verified ? areaStatus(categories) : 'not_verified';
  const areas: Ga4AreaStatus[] = [
    { area: 'Data collection', status: areaOf(['collection', 'measurement'], true) },
    { area: 'Data retention', status: areaOf(['retention'], s.dataRetention !== null) },
    { area: 'Key events', status: areaOf(['conversions'], s.keyEvents !== null) },
    { area: 'Custom definitions', status: areaOf(['customdef'], s.customDimensions !== null) },
    { area: 'Privacy (PII)', status: areaOf(['privacy'], s.customDimensions !== null) },
    { area: 'Integrations', status: areaOf(['integrations'], s.googleAdsLinks !== null || s.googleSignals !== null) },
    { area: 'Benchmarking', status: areaOf(['benchmarking'], true) },
  ];

  const summary = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;

  return {
    counts: {
      dataStreams: s.dataStreams.length,
      keyEvents: s.keyEvents?.length ?? 0,
      customDimensions: s.customDimensions?.length ?? 0,
      customMetrics: s.customMetrics.length,
      findings: findings.length,
    },
    summary,
    findings,
    areas,
  };
}
