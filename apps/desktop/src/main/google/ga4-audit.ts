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
  /** collection | retention | conversions | measurement | privacy | integrations | benchmarking */
  category: string;
  message: string;
  recommendation: string;
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
  };
}
