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
  paused: boolean;
  parameter: Array<Record<string, unknown>>;
}
export interface AuditTrigger {
  triggerId: string;
  name: string;
  type: string;
}
export interface AuditVariable {
  variableId: string;
  name: string;
  type: string;
}
export interface AuditFinding {
  severity: 'high' | 'medium' | 'low' | 'info';
  message: string;
}
export interface ContainerSnapshot {
  tags: AuditTag[];
  triggers: AuditTrigger[];
  variables: AuditVariable[];
}
export interface AuditReport {
  counts: { tags: number; triggers: number; variables: number };
  findings: AuditFinding[];
}

export function auditContainer(s: ContainerSnapshot): AuditReport {
  const findings: AuditFinding[] = [];

  for (const t of s.tags) {
    if (!t.firingTriggerId || t.firingTriggerId.length === 0) {
      findings.push({ severity: 'high', message: `Tag "${t.name}" has no firing trigger — it will never fire.` });
    }
    if (t.paused) findings.push({ severity: 'medium', message: `Tag "${t.name}" is paused.` });
    if (t.type === 'gaawe') {
      const hasMid = t.parameter.some(
        (p) => (p.key === 'measurementId' || p.key === 'measurementIdOverride') && p.value
      );
      if (!hasMid) findings.push({ severity: 'high', message: `GA4 event tag "${t.name}" has no measurement ID.` });
    }
    if (t.type === 'html') {
      findings.push({ severity: 'info', message: `Tag "${t.name}" is Custom HTML — review the snippet for security/PII.` });
    }
  }

  const usedTriggers = new Set(s.tags.flatMap((t) => t.firingTriggerId ?? []));
  for (const tr of s.triggers) {
    if (!usedTriggers.has(tr.triggerId)) {
      findings.push({ severity: 'low', message: `Trigger "${tr.name}" isn't used by any tag.` });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const t of s.tags) nameCounts.set(t.name, (nameCounts.get(t.name) ?? 0) + 1);
  for (const [name, count] of nameCounts) {
    if (count > 1) findings.push({ severity: 'medium', message: `Duplicate tag name "${name}" (${count} tags).` });
  }

  return {
    counts: { tags: s.tags.length, triggers: s.triggers.length, variables: s.variables.length },
    findings,
  };
}
