// Pure builders that construct valid Google Tag Manager API v2 resources from
// simple inputs, so the LLM supplies fields and OUR code guarantees the correct
// shape (type codes, parameter keys, the eventParameters list-of-maps, etc.).
// No I/O — fully unit-testable.

type Param = Record<string, unknown>;
const tpl = (key: string, value: string): Param => ({ type: 'template', key, value });
const boolean = (key: string, value: boolean): Param => ({ type: 'boolean', key, value: String(value) });
const integer = (key: string, value: string): Param => ({ type: 'integer', key, value });

export interface GtmTagResource {
  name: string;
  type: string;
  parameter: Param[];
  firingTriggerId?: string[];
}
export interface GtmTriggerResource {
  name: string;
  type: string;
  filter?: Param[];
  autoEventFilter?: Param[];
  customEventFilter?: Param[];
}
export interface GtmVariableResource {
  name: string;
  type: string;
  parameter: Param[];
}

/* ───────────── Tags ───────────── */

export interface Ga4EventInput {
  name: string;
  measurementId: string; // G-XXXX (or {{Variable}})
  eventName: string;
  eventParameters?: Array<{ name: string; value: string }>;
  firingTriggerId?: string[];
}
export function buildGa4EventTag(o: Ga4EventInput): GtmTagResource {
  // GTM requires an (empty) measurementId tagReference plus measurementIdOverride
  // holding the actual G-XXXX / {{variable}}. Verified against a reference GTM
  // MCP server's templates.
  const parameter: Param[] = [
    { type: 'tagReference', key: 'measurementId', value: '' },
    tpl('measurementIdOverride', o.measurementId),
    tpl('eventName', o.eventName),
  ];
  if (o.eventParameters?.length) {
    parameter.push({
      type: 'list',
      key: 'eventParameters',
      list: o.eventParameters.map((p) => ({ type: 'map', map: [tpl('name', p.name), tpl('value', p.value)] })),
    });
  }
  return { name: o.name, type: 'gaawe', parameter, ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}) };
}

export interface GoogleAdsConversionInput {
  name: string;
  conversionId: string; // AW-XXXX
  conversionLabel: string;
  firingTriggerId?: string[];
}
export function buildGoogleAdsConversionTag(o: GoogleAdsConversionInput): GtmTagResource {
  return {
    name: o.name,
    type: 'awct',
    parameter: [tpl('conversionId', o.conversionId), tpl('conversionLabel', o.conversionLabel)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

export interface CustomHtmlInput {
  name: string;
  html: string; // platform snippet (Facebook/LinkedIn/TikTok pixels, etc.)
  firingTriggerId?: string[];
}
export function buildCustomHtmlTag(o: CustomHtmlInput): GtmTagResource {
  return {
    name: o.name,
    type: 'html',
    parameter: [tpl('html', o.html), boolean('supportDocumentWrite', false)],
    ...(o.firingTriggerId ? { firingTriggerId: o.firingTriggerId } : {}),
  };
}

/* ───────────── Triggers ───────────── */

const FILTER_OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex', 'greater', 'less']);
function condition(variable: string, op: string, value: string): Param {
  return {
    type: FILTER_OPS.has(op) ? op : 'contains',
    parameter: [tpl('arg0', variable), tpl('arg1', value)],
  };
}

export type TriggerKind = 'link_click' | 'all_clicks' | 'custom_event' | 'pageview' | 'form_submit';
export interface TriggerInput {
  name: string;
  kind: TriggerKind;
  /** For link_click/all_clicks: filter on {{Click URL}}. */
  clickUrlValue?: string;
  clickUrlOperator?: string;
  /** For custom_event: the dataLayer event name. */
  eventName?: string;
}
export function buildTrigger(o: TriggerInput): GtmTriggerResource {
  switch (o.kind) {
    case 'link_click':
    case 'all_clicks': {
      // Click/auto-event triggers filter the clicked element via autoEventFilter
      // (NOT `filter`). Verified against the reference GTM MCP server.
      const t: GtmTriggerResource = { name: o.name, type: o.kind === 'link_click' ? 'linkClick' : 'click' };
      if (o.clickUrlValue) t.autoEventFilter = [condition('{{Click URL}}', o.clickUrlOperator ?? 'contains', o.clickUrlValue)];
      return t;
    }
    case 'custom_event':
      return {
        name: o.name,
        type: 'customEvent',
        customEventFilter: [condition('{{_event}}', 'equals', o.eventName ?? '')],
      };
    case 'form_submit':
      return { name: o.name, type: 'formSubmission' };
    case 'pageview':
    default:
      return { name: o.name, type: 'pageview' };
  }
}

/** Built-in variables a trigger needs (so we can auto-enable them). */
export function triggerBuiltInVars(o: TriggerInput): string[] {
  if ((o.kind === 'link_click' || o.kind === 'all_clicks') && o.clickUrlValue) return ['clickUrl'];
  return [];
}

/* ───────────── Variables ───────────── */

export type VariableKind = 'constant' | 'data_layer' | 'javascript';
export interface VariableInput {
  name: string;
  kind: VariableKind;
  value?: string; // constant
  dataLayerName?: string; // data_layer
  javascript?: string; // javascript (custom JS)
}
export function buildVariable(o: VariableInput): GtmVariableResource {
  switch (o.kind) {
    case 'constant':
      return { name: o.name, type: 'c', parameter: [tpl('value', o.value ?? '')] };
    case 'data_layer':
      return {
        name: o.name,
        type: 'v',
        parameter: [tpl('name', o.dataLayerName ?? ''), integer('dataLayerVersion', '2')],
      };
    case 'javascript':
    default:
      return { name: o.name, type: 'jsm', parameter: [tpl('javascript', o.javascript ?? '')] };
  }
}

/* ───────────── Container audit ───────────── */

export interface AuditTag {
  tagId: string;
  name: string;
  type: string;
  firingTriggerId: string[];
  /** Exception/blocking triggers — a trigger listed here IS in use. */
  blockingTriggerId?: string[];
  paused: boolean;
  parameter: Array<Record<string, unknown>>;
  /** Consent Mode v2 settings, when present on the tag. consentType is a
   *  parameter list that may itself reference {{variables}}. */
  consentSettings?: { consentStatus?: string; consentType?: unknown } | null;
}
export interface AuditTrigger {
  triggerId: string;
  name: string;
  type: string;
  /** Condition filters + generic parameters — scanned for {{variable}} references. */
  filter?: Array<Record<string, unknown>>;
  autoEventFilter?: Array<Record<string, unknown>>;
  customEventFilter?: Array<Record<string, unknown>>;
  parameter?: Array<Record<string, unknown>>;
}
export interface AuditVariable {
  variableId: string;
  name: string;
  type: string;
  /** Variable config — scanned for {{variable}} references to other variables. */
  parameter?: Array<Record<string, unknown>>;
}

/**
 * A machine-applicable fix for a finding: call `tool` with `args`. The audit
 * fills the resource id (tagId/triggerId/variableId); the registry injects the
 * workspace ids (accountId/containerId/workspaceId) before returning, so the
 * model can apply the fix in one call once the user approves.
 */
export interface AuditFix {
  tool: string;
  args: Record<string, unknown>;
}
export interface AuditFinding {
  severity: 'high' | 'medium' | 'low' | 'info';
  /** Coarse grouping: firing | paused | ga4 | deprecated | consent | security | performance | unused | naming. */
  category: string;
  message: string;
  /** The GTM resource the finding is about, when it targets one. */
  resource?: { kind: 'tag' | 'trigger' | 'variable'; id: string; name: string };
  /** What to change to resolve it (always present, human-readable). */
  recommendation: string;
  /** True when `fix` is a ready-to-run tool call the model can apply on approval. */
  autoFixable: boolean;
  fix?: AuditFix;
}
export interface ContainerSnapshot {
  tags: AuditTag[];
  triggers: AuditTrigger[];
  variables: AuditVariable[];
}
export interface AuditReport {
  counts: { tags: number; triggers: number; variables: number; findings: number };
  summary: { high: number; medium: number; low: number; info: number };
  findings: AuditFinding[];
}

// GTM tag types that send data to ad/analytics platforms and therefore should
// declare Consent Mode v2 settings: GA4 event, the Google tag, Google Ads
// conversion/remarketing, Conversion Linker, Floodlight counter/sales, plus the
// major third-party trackers (Microsoft Ads UET, LinkedIn Insight, Hotjar).
// (Grounded in a corpus of 562 real containers — googtag (826) and baut (448)
// were common data-senders the set previously missed.)
const CONSENT_RELEVANT_TYPES = new Set([
  'gaawe', 'googtag', 'awct', 'sp', 'gclidw', 'flc', 'fls', 'baut', 'bzi', 'hjtc',
]);

// consentStatus arrives UPPER_SNAKE in container EXPORT JSON ("NOT_SET") but
// camelCase from the live API ("notSet") — normalize so the audit is identical
// on both. → 'notset' | 'needed' | 'notneeded' | '' (absent/unknown).
export function normConsent(status: unknown): string {
  return typeof status === 'string' ? status.replace(/_/g, '').toLowerCase() : '';
}

// Pull every {{Variable Name}} token out of any nested value into `into`.
const VAR_REF = /\{\{([^}]+)\}\}/g;
function refsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(VAR_REF)) into.add(m[1].trim());
  } else if (Array.isArray(value)) {
    for (const v of value) refsIn(v, into);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) refsIn(v, into);
  }
}

export function auditContainer(s: ContainerSnapshot): AuditReport {
  const findings: AuditFinding[] = [];
  const measurementIds = new Set<string>();

  for (const t of s.tags) {
    const resource = { kind: 'tag' as const, id: t.tagId, name: t.name };

    if (!t.firingTriggerId || t.firingTriggerId.length === 0) {
      findings.push({
        severity: 'high',
        category: 'firing',
        resource,
        message: `Tag "${t.name}" has no firing trigger — it will never fire.`,
        recommendation: 'Attach a firing trigger so the tag can fire (add one in GTM or via create_gtm_tag_with_trigger).',
        autoFixable: false,
      });
    }
    if (t.paused) {
      findings.push({
        severity: 'medium',
        category: 'paused',
        resource,
        message: `Tag "${t.name}" is paused.`,
        recommendation: 'Unpause it if it should be live.',
        autoFixable: true,
        fix: { tool: 'set_gtm_tag_paused', args: { tagId: t.tagId, paused: false, name: t.name } },
      });
    }
    if (t.type === 'gaawe') {
      const midParam = t.parameter.find(
        (p) => (p.key === 'measurementId' || p.key === 'measurementIdOverride') && p.value
      );
      const mid = midParam ? String(midParam.value) : '';
      if (!mid) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" has no measurement ID.`,
          recommendation: 'Set its Measurement ID (a G-XXXXXXX value or a {{GA4 Measurement ID}} variable).',
          autoFixable: false,
        });
      } else if (mid.startsWith('G-')) {
        measurementIds.add(mid);
      }
      const hasEventName = t.parameter.some((p) => p.key === 'eventName' && p.value);
      if (!hasEventName) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `GA4 event tag "${t.name}" has no event name.`,
          recommendation: 'Set the GA4 event name (e.g. "purchase", "generate_lead", "page_view").',
          autoFixable: false,
        });
      }
    }
    if (t.type === 'googtag') {
      // The Google tag loads gtag.js and configures GA4/Ads — it needs a tag ID
      // (G-/AW-/GT-…). (Corpus: googtag is the 4th-most-common tag type, 826.)
      const hasTagId = t.parameter.some((p) => (p.key === 'tagId' || p.key === 'tag_id') && p.value);
      if (!hasTagId) {
        findings.push({
          severity: 'high',
          category: 'ga4',
          resource,
          message: `Google tag "${t.name}" has no tag ID — it can't configure GA4/Ads.`,
          recommendation: 'Set its Tag ID (a G-XXXXXXX / AW-XXXXXX / GT-XXXXXX value or a {{variable}}).',
          autoFixable: false,
        });
      }
    }
    if (t.type === 'ua') {
      // Universal Analytics: 758 such tags in the corpus, all now inert.
      findings.push({
        severity: 'medium',
        category: 'deprecated',
        resource,
        message: `Tag "${t.name}" is a Universal Analytics tag — UA stopped collecting data on 1 July 2023, so it reports nothing and only adds page weight.`,
        recommendation: 'Remove it, or migrate the measurement to a GA4 event tag (gaawe) or the Google tag (googtag).',
        autoFixable: false,
      });
    }
    if (t.type === 'html') {
      findings.push({
        severity: 'info',
        category: 'security',
        resource,
        message: `Tag "${t.name}" is Custom HTML — review the snippet for security/PII.`,
        recommendation: 'Prefer a native template where one exists; ensure the HTML contains no secrets or unvetted third-party script.',
        autoFixable: false,
      });
      const htmlParam = t.parameter.find((p) => p.key === 'html');
      if (htmlParam && /document\.write/.test(String(htmlParam.value))) {
        findings.push({
          severity: 'medium',
          category: 'performance',
          resource,
          message: `Custom HTML tag "${t.name}" uses document.write — it can block rendering.`,
          recommendation: 'Replace document.write with DOM insertion, or enable "Support document.write" only if truly required.',
          autoFixable: false,
        });
      }
    }
    // Consent Mode v2: ad/analytics tags should declare their consent. Only the
    // 'notSet' (or absent) state is unconfigured — 'needed' and the deliberate
    // 'notNeeded' are both valid, configured choices and must NOT be flagged.
    if (CONSENT_RELEVANT_TYPES.has(t.type)) {
      const status = normConsent(t.consentSettings?.consentStatus);
      if (!status || status === 'notset') {
        findings.push({
          severity: 'medium',
          category: 'consent',
          resource,
          message: `Tag "${t.name}" has no Consent Mode v2 settings (consent status is not set).`,
          recommendation: 'In the tag\'s "Consent Settings", declare the consent types it requires (e.g. ad_storage, analytics_storage), or "No additional consent required" if it genuinely needs none.',
          autoFixable: false,
        });
      }
    }
  }

  if (measurementIds.size > 1) {
    findings.push({
      severity: 'medium',
      category: 'ga4',
      message: `Multiple GA4 measurement IDs are in use (${[...measurementIds].join(', ')}).`,
      recommendation: 'Confirm this is intentional; most setups send to one property, ideally via a single {{GA4 Measurement ID}} variable.',
      autoFixable: false,
    });
  }

  // Unused triggers — referenced by no tag as either a FIRING or a BLOCKING
  // (exception) trigger. Both link a tag to a trigger, so both count as "used".
  const usedTriggers = new Set(
    s.tags.flatMap((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])])
  );
  for (const tr of s.triggers) {
    if (!usedTriggers.has(tr.triggerId)) {
      findings.push({
        severity: 'low',
        category: 'unused',
        resource: { kind: 'trigger', id: tr.triggerId, name: tr.name },
        message: `Trigger "${tr.name}" isn't used by any tag.`,
        recommendation: 'Delete it if it is not needed — unused triggers add clutter and unnecessary listeners.',
        autoFixable: true,
        fix: { tool: 'delete_gtm_trigger', args: { triggerId: tr.triggerId, name: tr.name } },
      });
    }
  }

  // Unused variables — referenced by no tag, trigger, or other variable. We scan
  // every {{variable}}-bearing field we capture (tag parameters + consentSettings,
  // all trigger filters + generic parameters, variable parameters). This is
  // ADVISORY ONLY (no auto-fix): the workspace snapshot can't see published
  // versions, and GTM has more variable-bearing fields than we capture, so a
  // "no references found" result is a strong hint — not proof — that a variable
  // is safe to delete. Deleting is left to the user via delete_gtm_variable.
  const refs = new Set<string>();
  for (const t of s.tags) {
    refsIn(t.parameter, refs);
    refsIn(t.consentSettings?.consentType, refs);
  }
  for (const tr of s.triggers) {
    refsIn(tr.filter, refs);
    refsIn(tr.autoEventFilter, refs);
    refsIn(tr.customEventFilter, refs);
    refsIn(tr.parameter, refs);
  }
  for (const v of s.variables) refsIn(v.parameter, refs);
  for (const v of s.variables) {
    if (!refs.has(v.name)) {
      findings.push({
        severity: 'low',
        category: 'unused',
        resource: { kind: 'variable', id: v.variableId, name: v.name },
        message: `Variable "${v.name}" appears unused — no tag, trigger, or variable in this workspace references it.`,
        recommendation: 'Review it in GTM and delete it (delete_gtm_variable) if truly unused — first confirm it is not relied on by a published version or a field this audit does not inspect.',
        autoFixable: false,
      });
    }
  }

  // Duplicate names.
  const dupes = (
    items: Array<{ name: string }>,
    severity: AuditFinding['severity'],
    noun: string
  ): void => {
    const counts = new Map<string, number>();
    for (const i of items) counts.set(i.name, (counts.get(i.name) ?? 0) + 1);
    for (const [name, count] of counts) {
      if (count > 1) {
        findings.push({
          severity,
          category: 'naming',
          message: `Duplicate ${noun} name "${name}" (${count} ${noun}s).`,
          recommendation: `Rename or remove duplicates so each ${noun} is uniquely identifiable.`,
          autoFixable: false,
        });
      }
    }
  };
  dupes(s.tags, 'medium', 'tag');
  dupes(s.triggers, 'low', 'trigger');

  const summary = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) summary[f.severity]++;

  return {
    counts: {
      tags: s.tags.length,
      triggers: s.triggers.length,
      variables: s.variables.length,
      findings: findings.length,
    },
    summary,
    findings,
  };
}
