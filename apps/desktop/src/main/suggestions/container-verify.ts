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

/** Build a verify trigger from a GTM trigger's conditions. Returns null if the type isn't drivable. */
function triggerFrom(trig: AuditTrigger): VerifyTagInput['trigger'] | null {
  const kind = kindOf(trig.type);
  if (!kind) return null;
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
  }
  return out;
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
    const measurementId = tagParam(tag, 'measurementId') ?? tagParam(tag, 'measurementIdOverride') ?? tagParam(tag, 'tagId');

    tags.push({
      id: tag.tagId,
      tagName: tag.name,
      eventName,
      platform,
      ...(measurementId ? { measurementId } : {}),
      trigger,
    });
  }
  return { tags, skipped };
}
