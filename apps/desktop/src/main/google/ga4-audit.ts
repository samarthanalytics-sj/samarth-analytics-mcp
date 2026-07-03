// Pure GA4 property configuration audit. No I/O — fully unit-testable. GA4 is
// READ-ONLY by design, so every finding is advisory (recommend a change for the
// user to make in the GA4 UI); there are no auto-fixes.

export interface Ga4DataStreamConfig {
  name: string;
  displayName: string;
  /** WEB_DATA_STREAM | ANDROID_APP_DATA_STREAM | IOS_APP_DATA_STREAM */
  type: string;
  /** Enhanced measurement MASTER on/off for WEB streams; null = unknown / not a web stream. */
  enhancedMeasurementEnabled: boolean | null;
  /** Enhanced-measurement SUB-toggles (web streams only; null when the master is off/unread). Only the
   *  high-value ones that silently drop whole behavior categories when off. */
  enhancedMeasurement?: {
    siteSearchEnabled: boolean;
    pageChangesEnabled: boolean; // SPA / history-based page views
    formInteractionsEnabled: boolean;
  } | null;
}

/** Reporting attribution config — the model + lookback windows that reshape every channel-credit number. */
export interface Ga4AttributionConfig {
  reportingAttributionModel: string;
  /** Acquisition-conversion lookback window enum (e.g. ..._30_DAYS / _7_DAYS). */
  acquisitionLookback: string;
  /** Other-conversion lookback window enum (e.g. ..._90_DAYS / _30_DAYS). */
  otherLookback: string;
}
/** BigQuery export link summary — presence + which exports are actually on. */
export interface Ga4BigQueryLinkConfig {
  project: string;
  dailyExportEnabled: boolean;
  streamingExportEnabled: boolean;
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
  /** GA360 vs standard — determines the retention cap (14mo standard, 50mo 360). '' = unread. */
  serviceLevel?: string;
  /** Reporting attribution model + lookback windows; null = unread. */
  attribution?: Ga4AttributionConfig | null;
  /** BigQuery export links; [] = none configured, null = unread. */
  bigQueryLinks?: Ga4BigQueryLinkConfig[] | null;
  /** Number of configured audiences (remarketing/segmentation); null = unread. */
  audiences?: number | null;
}

export interface Ga4Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  /** collection | retention | conversions | measurement | privacy | integrations | benchmarking | customdef | attribution */
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

/** Human label for a GA4 retention enum (TWO_MONTHS → "2 months"). */
const RETENTION_MONTHS: Record<string, number> = {
  TWO_MONTHS: 2, FOURTEEN_MONTHS: 14, TWENTY_FIVE_MONTHS: 25, THIRTY_EIGHT_MONTHS: 38, FIFTY_MONTHS: 50,
};
function retentionLabel(e: string): string {
  const m = RETENTION_MONTHS[e];
  return m ? `${m} month${m === 1 ? '' : 's'}` : e || 'unknown';
}
/** Lowercase a SCREAMING_SNAKE enum into readable words. */
const prettyEnum = (e: string): string => (e || '').toLowerCase().replace(/_/g, ' ').trim();

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

  // Retention is service-level aware: the cap is 14 months on standard properties but 50 months on
  // Google Analytics 360, so a 360 property sitting below 50mo is under-retained even at 14mo.
  const is360 = (s.serviceLevel ?? '') === 'GOOGLE_ANALYTICS_360';
  if (s.dataRetention) {
    const ret = s.dataRetention.eventDataRetention;
    if (is360 && ret !== 'FIFTY_MONTHS' && ret !== '') {
      findings.push({
        severity: ret === 'TWO_MONTHS' ? 'medium' : 'low',
        category: 'retention',
        message: `Event data retention is ${retentionLabel(ret)} on a Google Analytics 360 property — 360 supports up to 50 months, so exploration/report data is discarded earlier than it needs to be.`,
        recommendation: 'Increase it to 50 months in Admin → Data settings → Data retention (the max for 360 properties).',
      });
    } else if (!is360 && ret === 'TWO_MONTHS') {
      findings.push({
        severity: 'medium',
        category: 'retention',
        message: 'Event data retention is 2 months (the default) — exploration/report data older than 2 months is discarded.',
        recommendation: 'Increase it to 14 months in Admin → Data settings → Data retention (the max for standard properties).',
      });
    }
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

  // Under-instrumentation: a property that actively measures conversions (has key events) but has
  // ZERO custom dimensions AND ZERO custom metrics is limited to GA4's default fields — item
  // attributes, user properties and marketing parameters never reach reports/explorations. Absence
  // of config is not the same as a clean pass, so flag it (gated on key events so a brochure site
  // with nothing to measure isn't nagged).
  const activelyMeasuring = (s.keyEvents?.length ?? 0) > 0;
  if (s.customDimensions !== null && dims.length === 0 && s.customMetrics.length === 0 && activelyMeasuring) {
    findings.push({
      severity: 'low',
      category: 'customdef',
      message: 'No custom dimensions or metrics are configured, yet the property marks key events — analysis is limited to GA4 default fields (no item attributes, user properties or marketing parameters in reports).',
      recommendation: 'Register custom dimensions/metrics for the event and user parameters you already send so they appear in reports and explorations.',
    });
  }

  // Attribution model + lookback silently reshape every channel-credit number in the report, so grade
  // them (data-driven cross-channel is GA4's recommended default).
  if (s.attribution) {
    const model = s.attribution.reportingAttributionModel;
    if (model && !/DATA_DRIVEN/i.test(model) && /LAST_CLICK/i.test(model)) {
      findings.push({
        severity: 'low',
        category: 'attribution',
        message: `Reporting attribution uses a last-click model (${prettyEnum(model)}) — it credits only the final channel, under-crediting the channels that started the journey and skewing every channel-credit number in this report.`,
        recommendation: 'Switch to "Data-driven" in Admin → Attribution settings unless last-click is a deliberate policy.',
      });
    }
    const other = s.attribution.otherLookback;
    if (other && !/90_DAYS/i.test(other)) {
      findings.push({
        severity: 'info',
        category: 'attribution',
        message: `The conversion lookback for non-acquisition events is ${prettyEnum(other)} (max is 90 days) — conversions from touchpoints older than that window get no credit.`,
        recommendation: 'Set the lookback to 90 days in Admin → Attribution settings unless your consideration cycle is genuinely shorter.',
      });
    }
  }

  // Enhanced-measurement SUB-toggles: the master can be ON while high-value sub-features are OFF, so
  // whole interaction categories go unmeasured on a property that looks configured.
  for (const stream of s.dataStreams) {
    if (stream.type === 'WEB_DATA_STREAM' && stream.enhancedMeasurementEnabled === true && stream.enhancedMeasurement) {
      const off: string[] = [];
      if (!stream.enhancedMeasurement.siteSearchEnabled) off.push('site search');
      if (!stream.enhancedMeasurement.pageChangesEnabled) off.push('SPA page changes (history events)');
      if (!stream.enhancedMeasurement.formInteractionsEnabled) off.push('form interactions');
      if (off.length) {
        findings.push({
          severity: 'low',
          category: 'measurement',
          message: `Enhanced measurement is ON for web stream "${stream.displayName}" but ${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} off — those interactions are not auto-collected despite the stream looking configured.`,
          recommendation: `Enable ${off.join(', ')} in the web stream's Enhanced measurement settings (or collect them via custom events).`,
        });
      }
    }
  }

  // BigQuery export: absence caps every advanced/unsampled analysis; a link with no export enabled is a
  // silent failure. null = unread (not flagged).
  if (Array.isArray(s.bigQueryLinks)) {
    if (s.bigQueryLinks.length === 0) {
      findings.push({
        severity: 'info',
        category: 'integrations',
        message: 'No BigQuery export is configured — raw, unsampled event-level data is unavailable, and BigQuery is the standard escape hatch from GA4 report sampling and the data-retention limit.',
        recommendation: 'Link a BigQuery project in Admin → Product links → BigQuery links if you need event-level data or hit sampling/retention limits.',
      });
    } else {
      const dead = s.bigQueryLinks.filter((l) => !l.dailyExportEnabled && !l.streamingExportEnabled);
      if (dead.length) {
        findings.push({
          severity: 'low',
          category: 'integrations',
          message: `A BigQuery link exists but no export is enabled${dead.some((l) => l.project) ? ` (${dead.map((l) => l.project).filter(Boolean).join(', ')})` : ''} — the link is configured yet silently sends no data.`,
          recommendation: 'Enable daily and/or streaming export on the BigQuery link, or remove it if unused.',
        });
      }
    }
  }

  // Audiences: none while Ads is linked + key events marked is a missed remarketing-activation.
  if (typeof s.audiences === 'number' && s.audiences === 0 && (s.keyEvents?.length ?? 0) > 0 && (s.googleAdsLinks ?? 0) > 0) {
    findings.push({
      severity: 'info',
      category: 'integrations',
      message: 'No audiences are configured while Google Ads is linked — you cannot build remarketing lists or audience-triggered events from GA4 behavior.',
      recommendation: 'Create audiences (e.g. cart abandoners, high-value users) in Admin → Audiences to activate remarketing to the linked Ads account.',
    });
  }

  // Reporting currency unset → revenue can be reported inconsistently. (A wrong-but-set currency vs
  // actual revenue is cross-checked in the report, which has the revenue figure.)
  if (s.currencyCode === '') {
    findings.push({
      severity: 'info',
      category: 'collection',
      message: 'No reporting currency is set on the property — monetary values may be reported inconsistently.',
      recommendation: 'Set the reporting currency in Admin → Property details.',
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
  // Data collection: a stream existing is necessary but NOT sufficient for "collection is healthy".
  // Internal-traffic filters, hostname allow-listing, bot filtering and actual double-tagging are not
  // verifiable via the config API, so a configured stream is at most Partial (Fail if none exist).
  const collectionStatus: Ga4AreaStatus['status'] = s.dataStreams.length === 0 ? 'fail' : 'partial';
  // Custom definitions: zero configured isn't a clean pass — nothing was verified, and on a property
  // marking key events it's under-instrumentation → Partial. null = sub-resource couldn't be read.
  const customDefStatus: Ga4AreaStatus['status'] =
    s.customDimensions === null
      ? 'not_verified'
      : dims.length === 0 && s.customMetrics.length === 0
        ? 'partial'
        : areaStatus(['customdef']);
  const hasWebStream = s.dataStreams.some((d) => d.type === 'WEB_DATA_STREAM');
  const integrationsVerified =
    s.googleAdsLinks !== null || s.googleSignals !== null || Array.isArray(s.bigQueryLinks) || typeof s.audiences === 'number';
  const areas: Ga4AreaStatus[] = [
    { area: 'Data collection', status: collectionStatus },
    { area: 'Data retention', status: areaOf(['retention'], s.dataRetention !== null) },
    { area: 'Key events', status: areaOf(['conversions'], s.keyEvents !== null) },
    { area: 'Enhanced measurement', status: areaOf(['measurement'], hasWebStream) },
    { area: 'Custom definitions', status: customDefStatus },
    { area: 'Attribution', status: areaOf(['attribution'], s.attribution != null) },
    { area: 'Privacy (PII)', status: areaOf(['privacy'], s.customDimensions !== null) },
    { area: 'Integrations', status: areaOf(['integrations'], integrationsVerified) },
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
