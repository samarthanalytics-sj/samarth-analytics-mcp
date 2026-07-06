// PURE mapper: a GTM container SNAPSHOT (the audited tags + triggers) → the verify
// engine's VerifyTagInput[]. This is what lets "Verify firing" run against the tags
// that ALREADY EXIST in the container (the Container-audit panel), by translating
// GTM's native tag/trigger config into the driver's trigger shape.
//
// No browser, no I/O — unit-testable. Best-effort + defensive: a tag whose trigger
// can't be mapped to a drivable interaction is skipped (returned in `skipped`).

import type { ContainerSnapshot, AuditTag, AuditTrigger } from '../google/gtm-builders';
import type { VerifyTagInput } from '../../shared/ipc';

type Rec = Record<string, unknown>;

/** Read a condition/param arg (arg0 = the {{variable}}, arg1 = the value). */
function argOf(cond: Rec, key: string): string | undefined {
  const params = Array.isArray(cond.parameter) ? (cond.parameter as Rec[]) : [];
  const p = params.find((x) => x.key === key);
  return p && typeof p.value === 'string' ? p.value : undefined;
}

/** GTM condition type → the verify driver's operator (falls back to equals). */
function opOf(cond: Rec): string {
  const t = typeof cond.type === 'string' ? cond.type : 'equals';
  const known = ['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex', 'cssSelector'];
  return known.includes(t) ? t : 'equals';
}

/** A tag parameter value by key (GTM Tag.parameter = [{type,key,value}, …]). */
function tagParam(tag: AuditTag, key: string): string | undefined {
  const p = tag.parameter.find((x) => x.key === key);
  return p && typeof p.value === 'string' ? (p.value as string) : undefined;
}

/** First non-empty (present + non-whitespace) value. GA4 event tags ship an EMPTY
 *  measurementId tagReference plus measurementIdOverride holding the real G-XXXX, so a
 *  bare ?? chain over tagParam (which returns '' not undefined) would shadow the real id. */
function firstNonEmpty(...vals: Array<string | undefined>): string | undefined {
  for (const v of vals) if (v && v.trim()) return v;
  return undefined;
}

/** True if a GTM condition is NEGATED. GTM stores "does not equal / contain" as the base
 *  condition type PLUS a {type:boolean, key:'negate', value:'true'} parameter — NOT a distinct
 *  type. The driver only does POSITIVE matching, so a negated condition can't be faithfully
 *  driven and its trigger is skipped rather than mapped to an inverted positive match. */
function isNegated(cond: Rec): boolean {
  const params = Array.isArray(cond.parameter) ? (cond.parameter as Rec[]) : [];
  return params.some((p) => p.key === 'negate' && (p.value === true || String(p.value).toLowerCase() === 'true'));
}

/** Map a GTM trigger type to the verify trigger kind, or null if not drivable here. */
function kindOf(type: string): VerifyTagInput['trigger']['kind'] | null {
  const t = type.toLowerCase();
  if (t === 'linkclick') return 'link_click';
  if (t === 'click') return 'all_clicks';
  if (t === 'formsubmission' || t === 'formsubmit') return 'form_submit';
  if (t === 'customevent') return 'custom_event';
  if (['pageview', 'domready', 'windowloaded', 'init', 'consentinit', 'serverpageview'].includes(t)) return 'pageview';
  return null; // scrollDepth, timer, elementVisibility, historyChange, youTubeVideo, jsError, triggerGroup …
}

/** Built-in trigger ids (All Pages / Init / DOM Ready / …) live in the 2147479xxx range and are not
 *  returned by triggers.list — a tag firing on one is treated as a pageview. */
function isBuiltinTriggerId(id: string): boolean {
  return /^21474795\d{2}$/.test(id) || Number(id) >= 2147479553;
}

/** Build a verify trigger from a GTM trigger's conditions. Returns null when the trigger can't be
 *  driven faithfully (unsupported type, negated condition, or no locatable target) — the caller
 *  then records the tag in `skipped` instead of emitting a trigger that yields a wrong verdict. */
function triggerFrom(trig: AuditTrigger): VerifyTagInput['trigger'] | null {
  const kind = kindOf(trig.type);
  if (!kind) return null;

  // The driver has no negation support (it drives the element that POSITIVELY matches), so any
  // negated condition ("does not equal/contain") would invert the verdict — skip the whole trigger.
  const allConds = [...(trig.filter ?? []), ...(trig.autoEventFilter ?? []), ...(trig.customEventFilter ?? [])] as Rec[];
  if (allConds.some(isNegated)) return null;

  const out: VerifyTagInput['trigger'] = { name: trig.name, kind };

  // Click/form conditions live in filter + autoEventFilter; custom-event name in customEventFilter.
  const conds = [...(trig.filter ?? []), ...(trig.autoEventFilter ?? [])] as Rec[];
  for (const c of conds) {
    const variable = (argOf(c, 'arg0') ?? '').toLowerCase();
    const value = argOf(c, 'arg1');
    if (value === undefined) continue;
    const op = opOf(c);
    if (variable.includes('click text')) {
      out.clickTextValue = value;
      out.clickTextOperator = op;
    } else if (variable.includes('click url')) {
      out.clickUrlValue = value;
      out.clickUrlOperator = op;
    } else if (variable.includes('form id')) {
      out.formIdValue = value;
      out.formIdOperator = op;
    } else if (variable.includes('form classes')) {
      out.formClassesValue = value;
      out.formClassesOperator = op;
    } else if (variable.includes('page path')) {
      out.pagePathValue = value;
      out.pagePathOperator = op;
    } else if (variable.includes('page url')) {
      out.pageUrlValue = value;
      out.pageUrlOperator = op;
    }
  }

  if (kind === 'custom_event') {
    // customEventFilter: arg0 = {{_event}}, arg1 = the dataLayer event name.
    const cef = (trig.customEventFilter ?? []) as Rec[];
    const ev = cef.map((c) => argOf(c, 'arg1')).find((v) => v && v !== '.*');
    if (ev) out.eventName = ev;
    if (!out.eventName) return null; // no concrete dataLayer event name to push → can't drive it
  }

  // Click triggers need a text/URL the driver can locate on the page. A click scoped ONLY by
  // {{Click ID}}/{{Click Classes}}/{{Click Element}} or by page (no Click Text/URL) has no
  // locatable target — skip it rather than report a guaranteed false NOT-FIRED.
  if ((kind === 'link_click' || kind === 'all_clicks') && !out.clickTextValue && !out.clickUrlValue) {
    return null;
  }
  return out;
}

/** Route a page-scoped trigger to its own page so a page-specific click/form/pageview is driven
 *  there — not on the homepage (where its target is absent → false NOT-FIRED). Only exact/prefix
 *  path scopes are usable for navigation; a "contains" URL fragment is too ambiguous to route. */
function pageFromTrigger(trigger: VerifyTagInput['trigger']): string | undefined {
  const usable = (op?: string): boolean => op === undefined || op === 'equals' || op === 'startsWith';
  if (trigger.pagePathValue && usable(trigger.pagePathOperator)) {
    const p = trigger.pagePathValue.trim();
    if (p.startsWith('/')) return p;
  }
  if (trigger.pageUrlValue && usable(trigger.pageUrlOperator)) {
    const v = trigger.pageUrlValue.trim();
    if (v.startsWith('/')) return v;
    try {
      const u = new URL(v);
      if (u.pathname && u.pathname !== '/') return u.pathname;
    } catch {
      /* not a full URL and not a path — can't route */
    }
  }
  return undefined;
}

/** GA4/base tag types this MVP can verify. Others (Meta template, Ads, Floodlight, …) are skipped. */
function platformOf(type: string): VerifyTagInput['platform'] | null {
  if (type === 'gaawe') return 'ga4_event';
  if (type === 'googtag' || type === 'gaawc') return 'google_tag';
  return null;
}

export interface ContainerVerifyResult {
  tags: VerifyTagInput[];
  /** Tags that couldn't be turned into a drivable verification, with the reason. */
  skipped: Array<{ tagId: string; name: string; reason: string }>;
}

/**
 * Translate the container snapshot into verifiable tags. Each GA4/base tag is paired with the FIRST
 * of its firing triggers that maps to a drivable interaction (click/form/custom-event/pageview). A
 * firing trigger that is a built-in id (All Pages, etc.) is treated as pageview.
 */
export function snapshotToVerifyInputs(snapshot: ContainerSnapshot): ContainerVerifyResult {
  const triggerById = new Map(snapshot.triggers.map((t) => [t.triggerId, t]));
  const tags: VerifyTagInput[] = [];
  const skipped: ContainerVerifyResult['skipped'] = [];

  for (const tag of snapshot.tags) {
    const platform = platformOf(tag.type);
    if (!platform) {
      skipped.push({ tagId: tag.tagId, name: tag.name, reason: `tag type "${tag.type}" not verifiable in this MVP` });
      continue;
    }
    if (tag.paused) {
      skipped.push({ tagId: tag.tagId, name: tag.name, reason: 'tag is paused' });
      continue;
    }

    // Pick the first firing trigger that maps to a drivable kind (built-ins → pageview).
    let trigger: VerifyTagInput['trigger'] | null = null;
    for (const tid of tag.firingTriggerId ?? []) {
      const trig = triggerById.get(tid);
      if (!trig) {
        if (isBuiltinTriggerId(tid)) trigger = { name: 'All Pages', kind: 'pageview' };
        if (trigger) break;
        continue;
      }
      const mapped = triggerFrom(trig);
      if (mapped) {
        trigger = mapped;
        break;
      }
    }
    if (!trigger) {
      skipped.push({ tagId: tag.tagId, name: tag.name, reason: 'no firing trigger maps to a drivable interaction (click/form/custom-event/pageview)' });
      continue;
    }

    const eventName = platform === 'ga4_event' ? tagParam(tag, 'eventName') ?? '' : 'page_view';
    // GA4 event tags ship an EMPTY measurementId tagReference + measurementIdOverride with the real
    // G-XXXX; google tags carry it under tagId. Skip empty values so the real id (used for tid=
    // attribution) isn't shadowed by the placeholder.
    const measurementId = firstNonEmpty(
      tagParam(tag, 'measurementId'),
      tagParam(tag, 'measurementIdOverride'),
      tagParam(tag, 'tagId'),
    );
    const page = pageFromTrigger(trigger);

    tags.push({
      id: tag.tagId,
      tagName: tag.name,
      eventName,
      platform,
      ...(measurementId ? { measurementId } : {}),
      ...(page ? { page } : {}),
      trigger,
    });
  }
  return { tags, skipped };
}
