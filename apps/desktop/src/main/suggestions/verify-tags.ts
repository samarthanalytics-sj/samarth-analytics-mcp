// PURE evaluator for "Verify tag firing" — no browser, no I/O, unit-testable.
//
// Given, per tag, the interaction the driver performed and the analytics /collect
// hits it captured (verify-driver.ts), decide whether each tag FIRED, and when it
// did not, propose a corrected trigger the user can apply before creating. Reuses
// the same hit brain the runtime synthetic test uses (parseGa4CollectHit /
// classifyCollector) and the trigger-match logic (ctaTriggerFiresOn).

import { parseGa4CollectHit, classifyCollector } from '../../shared/runtime-capture';
import { ctaTriggerFiresOn } from './scan-core';
import type { SuggestedTag } from '../../../../web-audit-mcp/src/agent/tag-suggest/types.js';
import type {
  VerifyTagInput,
  VerifyTagVerdict,
  CapturedHitView,
  DetectedElementView,
} from '../../shared/ipc';

/** What the driver captured for one tag's trigger interaction. */
export interface PerTagCapture {
  tagId: string;
  kind: 'click' | 'submit' | 'navigate' | 'none';
  /** An element/form matching the trigger was found on the page. */
  targetFound: boolean;
  /** The interaction was actually performed. */
  performed: boolean;
  note?: string;
  /** /collect hits captured (and aborted) after this interaction. */
  hits: CapturedHitView[];
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** Which collector family proves a non-GA4 platform's tag fired. */
function platformCollector(platform: string): string {
  if (platform === 'meta_pixel') return 'meta';
  if (platform === 'tiktok_pixel') return 'tiktok';
  // linkedin / reddit / pinterest / google_ads_* / conversion_linker all beacon as 'ad'.
  return 'ad';
}

/** Is this a GA4 tag (event name decodable from the hit) vs a pixel/ads tag? */
function isGa4Platform(platform: string): boolean {
  return platform === 'ga4_event' || platform === 'google_tag';
}

/**
 * Propose a corrected trigger when a tag's trigger matched nothing on the page.
 * Heuristic + honest: binds a click trigger to the closest real control, or
 * loosens an over-strict operator; returns a note only when it can't confidently fix.
 */
function proposeTrigger(
  tag: VerifyTagInput,
  elements: DetectedElementView[],
): { trigger?: VerifyTagInput['trigger']; note: string } {
  const t = tag.trigger;
  const isClick = t.kind === 'link_click' || t.kind === 'all_clicks';

  if (isClick && t.clickTextValue) {
    const target = norm(t.clickTextValue);
    const match = elements.find((e) => {
      const et = norm(e.text);
      // A genuinely DIFFERENT text (not identical to the trigger) that overlaps it.
      return et.length > 0 && et !== target && (et.includes(target) || target.includes(et));
    });
    if (match) {
      const trigger = { ...t, clickTextValue: match.text.trim(), clickTextOperator: 'equals' };
      return {
        trigger,
        note: `No control matched "${t.clickTextValue}". The closest on-page control is "${match.text.trim()}" — match its exact text.`,
      };
    }
    // The exact text exists somewhere in the scan inventory but not on the page we drove:
    // it lives on another page, so verify that tag against its own page.
    const elsewhere = elements.find((e) => norm(e.text) === target);
    if (elsewhere) {
      return { note: `A control with the text "${t.clickTextValue}" exists on the site but not on the page verified — verify this tag against its own page (${elsewhere.page}).` };
    }
    if (t.clickTextOperator === 'equals') {
      return {
        trigger: { ...t, clickTextOperator: 'contains' },
        note: `No control exactly matched "${t.clickTextValue}". Loosen the match from "equals" to "contains".`,
      };
    }
    return { note: `No control matched "${t.clickTextValue}" on the scanned pages.` };
  }

  if (isClick && t.clickUrlValue) {
    const bare = norm(t.clickUrlValue).replace(/^[a-z]+:\/\//, '');
    const match = elements.find((e) => e.href && norm(e.href).includes(bare));
    if (match && match.href) {
      return {
        trigger: { ...t, clickUrlValue: match.href, clickUrlOperator: 'contains' },
        note: `No link matched "${t.clickUrlValue}". A real link on the page is "${match.href}".`,
      };
    }
    return { note: `No link matched "${t.clickUrlValue}" on the scanned pages.` };
  }

  if (t.kind === 'form_submit') {
    return { note: 'No matching form was found. Check the form id/classes, or scope the trigger to the page the form lives on.' };
  }
  return { note: 'No automatic trigger fix is available for this trigger type.' };
}

/** True when the repaired trigger would actually fire on some on-page control (sanity gate). */
function repairFires(trigger: VerifyTagInput['trigger'], elements: DetectedElementView[]): boolean {
  if (!trigger.clickTextValue) return true; // url/other repairs aren't text-checkable here
  return elements.some((e) => ctaTriggerFiresOn(trigger as unknown as SuggestedTag['trigger'], e.text ?? ''));
}

/** Evaluate every tag against what the driver captured. Pure. */
export function evaluateVerify(
  tags: VerifyTagInput[],
  captures: PerTagCapture[],
  elements: DetectedElementView[],
): VerifyTagVerdict[] {
  const byId = new Map(captures.map((c) => [c.tagId, c]));

  return tags.map((tag): VerifyTagVerdict => {
    const cap = byId.get(tag.id);
    const base: VerifyTagVerdict = { tagId: tag.id, tagName: tag.tagName, fired: false };

    if (!cap) {
      return { ...base, reason: 'the tag was not exercised by the driver', interaction: { kind: 'none', targetFound: false, performed: false } };
    }
    const interaction = { kind: cap.kind, targetFound: cap.targetFound, performed: cap.performed, ...(cap.note ? { note: cap.note } : {}) };

    // Trigger matched nothing on the page → it can't fire for a real user either.
    if (!cap.targetFound) {
      const fix = proposeTrigger(tag, elements);
      return {
        ...base,
        reason: `no element on the page matched this trigger (${describeTrigger(tag.trigger)})`,
        interaction,
        ...(fix.trigger && repairFires(fix.trigger, elements) ? { suggestedTrigger: fix.trigger } : {}),
        fixNote: fix.note,
      };
    }
    if (!cap.performed) {
      return { ...base, reason: cap.note ?? 'the interaction could not be performed', interaction };
    }

    // Interaction ran — did the tag's hit fire?
    if (isGa4Platform(tag.platform)) {
      const events = cap.hits
        .filter((h) => classifyCollector(h.url) === 'ga4')
        .flatMap((h) => parseGa4CollectHit({ url: h.url, body: h.body }).map((ev) => ({ ev, hit: h })));
      const want = norm(tag.eventName);
      const hit = events.find(({ ev }) => norm(ev.event) === want);
      if (hit) {
        return { ...base, fired: true, event: hit.ev.event, interaction, evidence: hit.hit };
      }
      if (events.length > 0) {
        const seen = [...new Set(events.map(({ ev }) => ev.event).filter(Boolean))].join(', ') || '(page-level)';
        return { ...base, reason: `the interaction fired GA4 hit(s) [${seen}] but none for "${tag.eventName}" — the tag or its event name may differ`, interaction, evidence: events[0].hit };
      }
      return { ...base, reason: 'the interaction ran but no GA4 hit fired — the tag/trigger may not be in the loaded container, or its condition does not match', interaction };
    }

    // Non-GA4 pixel/ads tag: we can't decode the event name; a hit to that platform's collector proves firing.
    const family = platformCollector(tag.platform);
    const fired = cap.hits.find((h) => classifyCollector(h.url) === family);
    if (fired) return { ...base, fired: true, interaction, evidence: fired };
    return { ...base, reason: `the interaction ran but no ${family} hit fired for this ${tag.platform} tag`, interaction };
  });
}

function describeTrigger(t: VerifyTagInput['trigger']): string {
  if (t.clickTextValue) return `${t.clickTextOperator ?? 'equals'} click text "${t.clickTextValue}"`;
  if (t.clickUrlValue) return `${t.clickUrlOperator ?? 'contains'} click URL "${t.clickUrlValue}"`;
  if (t.formIdValue || t.formClassesValue) return `form ${t.formIdValue ?? t.formClassesValue}`;
  return t.kind;
}
