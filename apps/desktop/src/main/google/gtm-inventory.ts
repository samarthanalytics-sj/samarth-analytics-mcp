// Container INVENTORY: the three human-readable audit tables (Tag Audit, Trigger Audit, Variable Audit)
// derived deterministically from a container snapshot, so the chat renders them from real data instead
// of paraphrasing the JSON (which is where the model invents firing options, conditions, and usage).
// Pure — snapshot in, tables out. Attached to the audit_gtm_container result; the reporting methodology
// (jit-reference AUDIT_REPORTING_METHODOLOGY) tells the model to render these first.

import { isBuiltinTriggerId, type ContainerSnapshot, type AuditTag, type AuditTrigger, type AuditVariable } from './gtm-builders';

export interface InventoryTagRow {
  name: string;
  type: string;
  firingTriggers: string;
  firingOption: string;
}
export interface InventoryTriggerRow {
  name: string;
  type: string;
  conditions: string;
  usage: 'Used' | 'Unused';
}
export interface InventoryVariableRow {
  name: string;
  type: string;
  value: string;
}
export interface ContainerInventory {
  tags: InventoryTagRow[];
  triggers: InventoryTriggerRow[];
  variables: InventoryVariableRow[];
}

// GTM resource `type` code → the label the GTM UI shows, so the tables read like GTM, not the API.
const TAG_TYPE: Record<string, string> = {
  gaawe: 'GA4 Event',
  gaawc: 'Google Tag',
  googtag: 'Google Tag',
  html: 'Custom HTML',
  img: 'Custom Image',
  gclidw: 'Google Ads Linker',
  awct: 'Google Ads Conversion',
  sp: 'Google Ads Remarketing',
  flc: 'Floodlight Counter',
  fls: 'Floodlight Sales',
  sgtmgaaw: 'GA4 (server)',
  cvt_template: 'Custom Template',
};
const TRIGGER_TYPE: Record<string, string> = {
  pageview: 'Page View',
  domReady: 'DOM Ready',
  windowLoaded: 'Window Loaded',
  init: 'Initialization',
  consentInit: 'Consent Initialization',
  click: 'All Elements Click',
  linkClick: 'Link Click',
  formSubmission: 'Form Submission',
  customEvent: 'Custom Event',
  elementVisibility: 'Element Visibility',
  historyChange: 'History Change',
  jsError: 'JavaScript Error',
  scrollDepth: 'Scroll Depth',
  youTubeVideo: 'YouTube Video',
  timer: 'Timer',
  triggerGroup: 'Trigger Group',
};
const VARIABLE_TYPE: Record<string, string> = {
  c: 'Constant',
  jsm: 'Custom JavaScript',
  smm: 'Lookup Table',
  remm: 'RegEx Table',
  v: 'Data Layer Variable',
  j: 'JavaScript Variable',
  k: '1st-Party Cookie',
  aev: 'Auto-Event Variable',
  u: 'URL',
  f: 'HTTP Referrer',
  d: 'DOM Element',
  vis: 'Element Visibility',
  gtes: 'Google Tag: Event Settings',
  gtcs: 'Google Tag: Configuration Settings',
  awup: 'User-Provided Data',
  gtcc: 'Google Consent Mode',
};
// GTM condition `type` → the operator wording the trigger UI shows.
const OP_TEXT: Record<string, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matchRegex: 'matches regex',
  cssSelector: 'matches CSS selector',
  urlMatches: 'matches',
  less: 'less than',
  lessOrEquals: 'less than or equal to',
  greater: 'greater than',
  greaterOrEquals: 'greater than or equal to',
};
const FIRING_OPTION: Record<string, string> = {
  oncePerEvent: 'Once per event',
  oncePerLoad: 'Once per load',
  unlimited: 'Unlimited',
};

const asList = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);

/** The `value` of the parameter named `key` in a GTM parameter list, or ''. */
function paramVal(params: Array<Record<string, unknown>>, key: string): string {
  const p = params.find((x) => x?.key === key);
  return p && p.value != null ? String(p.value) : '';
}

/** A condition variable reference read for humans: {{Click Text}} → "Click Text"; {{_event}} → "Event". */
function friendlyArg(raw: string): string {
  const inner = raw.replace(/^\{\{|\}\}$/g, '').trim();
  if (inner === '_event') return 'Event';
  return inner || raw;
}

/** One GTM filter entry → "Click Text equals Start free trial" (+ " (case-insensitive)" when set). */
function conditionText(entry: Record<string, unknown>): string {
  const type = String(entry?.type ?? '');
  const params = asList(entry?.parameter);
  const arg0 = friendlyArg(paramVal(params, 'arg0'));
  const arg1 = paramVal(params, 'arg1');
  const op = OP_TEXT[type] ?? type;
  const ci = paramVal(params, 'ignore_case') === 'true' ? ' (case-insensitive)' : '';
  return `${arg0} ${op} ${arg1}${ci}`.trim();
}

/** All of a trigger's conditions (event match + auto-event + generic filters) joined with " AND ". */
function triggerConditions(t: AuditTrigger): string {
  const entries = [...asList(t.customEventFilter), ...asList(t.autoEventFilter), ...asList(t.filter)];
  const parts = entries.map(conditionText).filter(Boolean);
  if (parts.length) return parts.join(' AND ');
  switch (t.type) {
    case 'click': return 'None (all clicks)';
    case 'linkClick': return 'None (all link clicks)';
    case 'formSubmission': return 'None (all form submits)';
    case 'pageview': return 'All pages';
    case 'domReady': return 'DOM Ready (all pages)';
    case 'windowLoaded': return 'Window Loaded (all pages)';
    default: return 'None';
  }
}

/** Best-effort human "Value / Configuration" for a variable, WITHOUT inventing config: the literal for a
 *  Constant, the source key for data-layer/cookie/JS globals, else '' (the Type column carries meaning). */
function variableValue(v: AuditVariable): string {
  const params = asList(v.parameter);
  switch (v.type) {
    case 'c': return paramVal(params, 'value');
    case 'v': { const n = paramVal(params, 'name'); return n ? `dataLayer: ${n}` : ''; }
    case 'k': { const n = paramVal(params, 'name'); return n ? `cookie: ${n}` : ''; }
    case 'j': return paramVal(params, 'name');
    case 'u': { const c = paramVal(params, 'component'); return c ? `URL: ${c.toLowerCase()}` : 'URL'; }
    default: return '';
  }
}

/** Collect every triggerReference value anywhere in a value tree (Trigger Group members). */
function collectTriggerRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) collectTriggerRefs(v, into); return; }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.type === 'triggerReference' && o.value != null) into.add(String(o.value));
    for (const v of Object.values(o)) collectTriggerRefs(v, into);
  }
}

/** Trigger ids referenced by any tag (firing OR blocking) or any Trigger Group — anything NOT here is Unused. */
function referencedTriggerIds(snapshot: ContainerSnapshot): Set<string> {
  const used = new Set<string>();
  for (const t of snapshot.tags) {
    for (const id of t.firingTriggerId ?? []) used.add(id);
    for (const id of t.blockingTriggerId ?? []) used.add(id);
  }
  for (const tr of snapshot.triggers) collectTriggerRefs(tr.parameter, used);
  return used;
}

/** Resolve a tag's firingTriggerId list to human trigger names (built-in ids → "All Pages (Initialization)"). */
function firingTriggerNames(tag: AuditTag, byId: Map<string, AuditTrigger>): string {
  const names = (tag.firingTriggerId ?? []).map((id) => {
    if (isBuiltinTriggerId(id)) return 'All Pages (Initialization)';
    return byId.get(id)?.name ?? `Trigger ${id}`;
  });
  return names.length ? names.join(', ') : '(no trigger)';
}

/** Build the three inventory tables from a container snapshot. PURE. */
export function buildContainerInventory(snapshot: ContainerSnapshot): ContainerInventory {
  const byId = new Map(snapshot.triggers.map((t) => [t.triggerId, t]));
  const used = referencedTriggerIds(snapshot);

  const tags: InventoryTagRow[] = snapshot.tags.map((t) => ({
    name: t.name,
    type: TAG_TYPE[t.type] ?? t.type,
    firingTriggers: firingTriggerNames(t, byId),
    firingOption: (t.tagFiringOption ? FIRING_OPTION[t.tagFiringOption] : undefined) ?? 'Once per event',
  }));

  const triggers: InventoryTriggerRow[] = snapshot.triggers.map((t) => ({
    name: t.name,
    type: TRIGGER_TYPE[t.type] ?? t.type,
    conditions: triggerConditions(t),
    usage: used.has(t.triggerId) ? 'Used' : 'Unused',
  }));

  const variables: InventoryVariableRow[] = snapshot.variables.map((v) => ({
    name: v.name,
    type: VARIABLE_TYPE[v.type] ?? v.type,
    value: variableValue(v),
  }));

  return { tags, triggers, variables };
}
