// PURE evaluator for "Verify tag firing" — no browser, no I/O, unit-testable.
//
// Given, per tag, the interaction the driver performed and the analytics /collect
// hits it captured (verify-driver.ts), decide whether each tag FIRED, and when it
// did not, propose a corrected trigger the user can apply before creating. Reuses
// the same hit brain the runtime synthetic test uses (parseGa4CollectHit /
// classifyCollector) and the trigger-match logic (ctaTriggerFiresOn).

import { parseGa4CollectHit, classifyCollector, beaconPlatform, beaconHost, isKnownAdPlatform } from '../../shared/runtime-capture';
import { ctaTriggerFiresOn } from './scan-core';
import { isFormEventName } from './form-tag-match';
import { monitorVerdicts, type MonitorEvent } from './tag-monitor';
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
  kind: 'click' | 'submit' | 'navigate' | 'custom_event' | 'none';
  /** An element/form matching the trigger was found on the page. */
  targetFound: boolean;
  /** The interaction was actually performed. */
  performed: boolean;
  /** For a custom_event FORM tag: whether we could supply its form-specific condition (customEventData)
   *  when we pushed the event. False = we pushed a BARE event that can't satisfy its form_name filter, so
   *  a non-fire is "we didn't reproduce its trigger" (inconclusive), not "it's broken". Undefined for
   *  interactions that need no condition (a click, a scroll/CTA custom event, a pageview) → treated true. */
  conditionSupplied?: boolean;
  note?: string;
  /** /collect hits captured (and aborted) after this interaction. */
  hits: CapturedHitView[];
  /** A JPEG data-URI screenshot taken right after the interaction (the driven control ringed) — visual
   *  proof of what was exercised. Best-effort; absent for un-driven / screenshot-capped tags. */
  screenshot?: string;
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();

/** A literal Measurement ID (G-/GT-/AW-/DC-/UA-XXXX) — not a {{variable}} — for tid attribution. */
function literalTid(mid: string | undefined): string | undefined {
  const m = (mid ?? '').trim();
  return /^(G|GT|AW|DC|UA)-[A-Z0-9-]+$/i.test(m) ? m.toUpperCase() : undefined;
}
/** The tid= on a GA4 collect hit URL. */
function hitTid(url: string): string | undefined {
  try {
    const t = new URL(url).searchParams.get('tid');
    return t ? t.toUpperCase() : undefined;
  } catch {
    return undefined;
  }
}
/** GA4-decodable collectors: direct GA4 and first-party server-side GTM (/g/collect, same payload). */
function isGa4CollectorHit(url: string): boolean {
  const c = classifyCollector(url);
  return c === 'ga4' || c === 'server';
}
/** GA4 events the BASE config tag + Enhanced Measurement emit on their own (not a specific event tag) —
 *  page_view, session lifecycle, and the EM auto-events. When we're verifying a NON-matching event tag,
 *  one of these appearing in its capture window is NOT that tag firing "the wrong event": it's the
 *  container's baseline noise (amplified because we force-grant consent). We must not charge it to the
 *  tag being checked, or every event tag on a GA4 site reads as "fired [page_view] but none for <event>". */
const GA4_AUTO_EVENTS = new Set([
  'page_view', 'session_start', 'first_visit', 'user_engagement', 'scroll', 'click',
  'view_search_results', 'file_download', 'form_start', 'form_submit', 'video_start',
  'video_progress', 'video_complete',
]);
/** A GA4 tag whose Event Name is a {{variable}} (or empty) — its runtime en= is resolved dynamically, so
 *  a LITERAL name comparison can never match and must not be reported as "wrong event name". */
const isDynamicEventName = (name: string | undefined): boolean => !name || /^\{\{.+\}\}$/.test(name.trim());

/** The SPECIFIC beacon platform that proves a non-GA4 tag fired (Phase A: precise per-platform
 *  attribution). 'ad' = we don't know the exact destination for this tag type → any recognised
 *  ad/pixel beacon counts. */
export function expectedBeaconPlatform(platform: string): string {
  switch (platform) {
    case 'meta_pixel': return 'meta';
    case 'tiktok_pixel': return 'tiktok';
    case 'linkedin_insight': return 'linkedin';
    case 'reddit_pixel': return 'reddit';
    case 'pinterest_tag': return 'pinterest';
    case 'snap_pixel': return 'snapchat';
    case 'hotjar': return 'hotjar';
    case 'google_ads_conversion':
    case 'google_ads_remarketing':
    case 'google_ads_call_conversion':
    case 'conversion_linker': return 'google_ads';
    default: return 'ad';
  }
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

  // Attach the interaction screenshot (if any) to whatever verdict we produce, without threading it
  // through every return path below.
  const withShot = (v: VerifyTagVerdict): VerifyTagVerdict => {
    const shot = byId.get(v.tagId)?.screenshot;
    return shot ? { ...v, screenshot: shot } : v;
  };
  return tags.map((tag): VerifyTagVerdict => withShot(evaluateOne(tag, byId, elements)));
}

/** AUTHORITATIVE verdicts from GTM's own Monitor stream (addEventCallback via the injected GTM Monitor
 *  tag): a tag GTM fired on any driven event is `fired` (status success = clean; failure/exception/
 *  timeout = fired-but-errored); a tag GTM never fired did NOT fire. Ground truth from the container
 *  itself — no beacon inference, no dual-container ambiguity — and it carries the exact events + status,
 *  which is what the Tag-Assistant-style firing panel renders. PURE. */
export function verdictsFromMonitor(tags: VerifyTagInput[], events: MonitorEvent[], perTag: PerTagCapture[] = [], opts: { scopedPages?: number } = {}): VerifyTagVerdict[] {
  // When the operator scoped the run to an explicit "Pages to verify" list, a tag left untested is almost
  // always one whose CTA/form lives on a DIFFERENT page — not a scan-budget miss. Say so plainly.
  const scopeHint = opts.scopedPages && opts.scopedPages > 0
    ? ` You verified only ${opts.scopedPages === 1 ? 'this 1 page' : `these ${opts.scopedPages} pages`} (your “Pages to verify” list), so this tag’s trigger lives on a page you didn’t include — add that page to the list, or clear the box to verify the whole site.`
    : '';
  // Form tags ARE included now: the driver verifies them by a REAL form submit (never a synthetic push),
  // so the monitor stream authoritatively reports which form tags fired on the real form_submission. A form
  // tag that fired → fired; one whose form wasn't submitted (no matching form, or a Skip run) → its
  // form_submission event never happened → INCONCLUSIVE ("verified only by a real submit"), never a false
  // "not firing". This is what lets the Forms section + the table agree with Tag Assistant.
  const reportable = tags;
  const byId = monitorVerdicts(reportable.map((t) => t.id), events);
  const capById = new Map(perTag.map((c) => [c.tagId, c] as const));
  // Every dataLayer event that ACTUALLY happened during the drive, per the monitor stream. A
  // custom-event tag whose event is not in this set was never really tested: GTM cannot fire a tag
  // whose event never happened (e.g. a form that announces itself with its OWN event name, which
  // only the real submit produces). Calling that "not firing" is a false alarm with wrong advice.
  const seenEvents = new Set(events.map((e) => e.event).filter(Boolean));
  return reportable.map((tag): VerifyTagVerdict => {
    const m = byId.get(tag.id);
    // Carry the tag's CONFIGURED GA4 event name (e.g. "phone_click") onto every verdict so the results
    // table + exports show the event we actually send, not just the dataLayer trigger event.
    const base = { tagId: tag.id, tagName: tag.tagName, verifiedByMonitor: true, ...(tag.eventName ? { eventName: tag.eventName } : {}) } as const;
    if (m && m.fired) {
      const clean = m.status === 'success';
      return {
        ...base,
        fired: true,
        monitorStatus: m.status,
        ...(m.onEvents.length ? { monitorEvents: m.onEvents, event: m.onEvents[0] } : {}),
        ...(m.maxExecutionMs != null ? { monitorExecutionMs: m.maxExecutionMs } : {}),
        ...(clean ? {} : { reason: `GTM fired this tag but it reported "${m.status}" — the tag ran with an error; check its configuration.` }),
        interaction: { kind: 'none', targetFound: true, performed: true },
      };
    }
    // NOT in the monitor report. The monitor is authoritative about what GTM fired ON THE EVENTS WE DROVE
    // — but "GTM didn't fire it" is only a real problem when we actually REPRODUCED its trigger. A tag
    // whose CTA lives on a page beyond the scan budget, or a form tag whose exact form-submit event we
    // couldn't push (no matching form → empty condition), was simply never exercised. Flatly calling those
    // "not firing" is a false negative — they DO fire in Tag Assistant when the real action supplies the
    // trigger/condition. Split them into INCONCLUSIVE ("untested here") vs a genuine non-fire.
    const cap = capById.get(tag.id);
    const isFormTag = tag.trigger.kind === 'custom_event' && isFormEventName(tag.trigger.eventName ?? tag.eventName ?? '');
    // conditionSupplied is undefined for interactions that need no condition (a click, a scroll/CTA custom
    // event, a pageview) → treat as supplied. Only a form tag we pushed with an EMPTY condition is false.
    const conditionOk = cap?.conditionSupplied ?? true;
    const expectedEvent = tag.trigger.kind === 'custom_event' ? (tag.trigger.eventName ?? tag.eventName ?? '') : '';
    const eventHappened = !expectedEvent || seenEvents.has(expectedEvent);
    const exercised = Boolean(cap?.targetFound && cap?.performed) && conditionOk && eventHappened;
    if (!exercised) {
      const why = cap && cap.targetFound === false
        ? 'we couldn’t find the button/link this tag listens to on the pages we drove — it may live on a page we didn’t scan'
        : !eventHappened
          ? `this tag waits for the event “${expectedEvent}”, and that event never happened during this run — the page only sends it on the real action${isFormTag ? ' (the real form submit)' : ''}`
          : isFormTag
            ? 'we couldn’t reproduce this tag’s exact form-submit event here (its form wasn’t among the ones we found), so its condition was never met'
            : 'we couldn’t exercise this tag’s trigger on the pages we drove';
      return {
        ...base,
        fired: false,
        inconclusive: true,
        reason: `${why} — that is NOT evidence it’s broken.${scopeHint} The real test is the “verify by real submit” step below (for forms) or a real interaction in GTM Preview.`,
        interaction: { kind: 'none', targetFound: cap?.targetFound ?? false, performed: cap?.performed ?? false },
      };
    }
    const sawWhat = expectedEvent ? `the event “${expectedEvent}” happened` : 'we drove its trigger';
    return {
      ...base,
      fired: false,
      reason: `GTM did not fire this tag even though ${sawWhat} — and GTM itself reported this run, so the container was definitely loaded. The problem is in the tag’s trigger conditions: a form name / id, page path, or other filter doesn’t match what the page actually sent. Open the trigger in GTM and compare it with the dataLayer log above.`,
      interaction: { kind: 'none', targetFound: true, performed: true },
    };
  });
}

function evaluateOne(tag: VerifyTagInput, byId: Map<string, PerTagCapture>, elements: DetectedElementView[]): VerifyTagVerdict {
  {
    const cap = byId.get(tag.id);
    const base: VerifyTagVerdict = { tagId: tag.id, tagName: tag.tagName, fired: false, ...(tag.eventName ? { eventName: tag.eventName } : {}) };

    if (!cap) {
      return { ...base, reason: 'the tag was not exercised by the driver', interaction: { kind: 'none', targetFound: false, performed: false } };
    }
    const interaction = { kind: cap.kind, targetFound: cap.targetFound, performed: cap.performed, ...(cap.note ? { note: cap.note } : {}) };
    // EVERY distinct host the interaction beaconed to — so the user always sees what network activity
    // fired, even for a tag type we can't decode. Phase A of "verify all tag types".
    const observedBeacons = [...new Set(cap.hits.map((h) => beaconHost(h.url)).filter(Boolean))];
    const withBeacons = <T extends object>(v: T): T => (observedBeacons.length ? { ...v, observedBeacons } : v);

    // The trigger matched no element on the page we drove. This is the single biggest source of
    // FALSE "not firing": a click trigger for a CTA that lives on ANOTHER page (careers, blog, a
    // service page) can't be exercised from the one URL we drove — that is not evidence the tag is
    // broken. Only when we can bind a CONFIDENT on-page repair do we treat it as actionable; else
    // it's inconclusive ("couldn't auto-test here"), never "not firing".
    if (!cap.targetFound) {
      const fix = proposeTrigger(tag, elements);
      const repair = fix.trigger && repairFires(fix.trigger, elements) ? fix.trigger : undefined;
      return {
        ...base,
        ...(repair ? {} : { inconclusive: true }),
        reason: `no element on the page we drove matched this trigger (${describeTrigger(tag.trigger)})`,
        interaction,
        ...(repair ? { suggestedTrigger: repair } : {}),
        fixNote: fix.note,
      };
    }
    if (!cap.performed) {
      return { ...base, reason: cap.note ?? 'the interaction could not be performed', interaction };
    }

    // Interaction ran — did the tag's hit fire?
    if (isGa4Platform(tag.platform)) {
      // When the tag has a literal Measurement ID, require the hit's tid= to match, so two GA4 tags
      // firing the same event on DIFFERENT properties (incl. a page's own live GA4 running alongside our
      // injected preview) are attributed correctly. A {{variable}} measurementId can't be pinned to a
      // literal property here, so it falls back to event-name matching; sound cross-property attribution
      // for variable-id tags needs run-wide property evidence and is handled by the reconcile pass.
      const wantTid = literalTid(tag.measurementId);
      const events = cap.hits
        .filter((h) => isGa4CollectorHit(h.url))
        .filter((h) => !wantTid || hitTid(h.url) === wantTid)
        .flatMap((h) => parseGa4CollectHit({ url: h.url, body: h.body }).map((ev) => ({ ev, hit: h })));
      const want = norm(tag.eventName);
      const hit = events.find(({ ev }) => norm(ev.event) === want);
      if (hit) {
        return withBeacons({ ...base, fired: true, ...(cap.kind === 'custom_event' ? { synthetic: true } : {}), event: hit.ev.event, interaction, evidence: hit.hit });
      }
      // A {{variable}} / empty Event Name can never equal a resolved runtime en=, so a literal-name
      // "wrong event" verdict is meaningless. Surface what DID fire (to this property) for alignment,
      // but mark it inconclusive — not "firing the wrong event".
      if (isDynamicEventName(tag.eventName)) {
        const obs = [...new Set(events.map(({ ev }) => ev.event).filter((e): e is string => Boolean(e)))];
        return withBeacons({ ...base, inconclusive: true, reason: `this tag's Event Name is ${tag.eventName ? 'a {{variable}}' : 'empty'}, so it can't be verified by a literal event-name match — ${obs.length ? `the interaction fired: [${obs.join(', ')}]; align the tag to the intended one` : 'no GA4 hit fired to this container’s property'}`, interaction, ...(obs.length ? { observedEvents: obs } : {}) });
      }
      // The tag's own event didn't fire. Only report "fired the WRONG event" when a NON-baseline event
      // was seen (a sibling tag or a genuinely mis-named tag) — never for the base config's page_view or
      // Enhanced-Measurement auto-events, which aren't this tag firing. Otherwise fall through to the
      // honest "no hit for this tag" branch below (so a whole page of EM/page_view noise no longer reads
      // as every tag "firing the wrong event").
      const attributable = events.filter(({ ev }) => !GA4_AUTO_EVENTS.has(norm(ev.event)));
      if (attributable.length > 0) {
        const observedEvents = [...new Set(attributable.map(({ ev }) => ev.event).filter((e): e is string => Boolean(e)))];
        const seen = observedEvents.join(', ') || '(page-level)';
        // The trigger fired a GA4 hit, just not under this tag's event name — surface the observed
        // event name(s) so the UI can offer "align the tag's Event Name to <observed>".
        return withBeacons({ ...base, reason: `the interaction fired GA4 hit(s) [${seen}] but none for "${tag.eventName}" — the tag or its event name may differ`, interaction, evidence: attributable[0].hit, ...(observedEvents.length ? { observedEvents } : {}) });
      }
      if (cap.kind === 'custom_event') {
        // We pushed a synthetic dataLayer event (e.g. `form_submission`) plus any form-specific data
        // we could resolve from the trigger's conditions (form_name/form_id/…). If it STILL didn't
        // fire, a further condition we can't synthesize applies. For a FORM tag that's expected — a
        // synthetic push can't reproduce the real form's own data/values, so it's verified by a REAL
        // submit (the "Forms — verified by a real submit" section, or GTM Preview), not here. For a
        // non-form custom event it likely needs a specific page / Custom JS variable / blocking
        // trigger. Either way it's inconclusive, NOT proof it's broken.
        const formTag = isFormEventName(tag.trigger.eventName ?? '');
        const how = formTag
          ? `this is a FORM tag — a synthetic push can't reproduce the real form's own data, so it's verified by a REAL submit: use the "Forms — verified by a real submit" section below (it submits each matched form for real and re-checks this tag), or submit the form in GTM Preview. If the tag is still a DRAFT, paste your GTM Preview snippet above so it loads`
          : `it likely needs a further condition we can't synthesize (a specific page, a Custom JS variable, or a blocking trigger); verify it with a real submit in GTM Preview`;
        return withBeacons({ ...base, inconclusive: true, reason: `we pushed a synthetic "${tag.trigger.eventName ?? 'custom'}" dataLayer event (with any resolvable form data), but this tag still didn't fire — ${how}`, interaction });
      }
      return withBeacons({ ...base, reason: 'the interaction ran but no GA4 hit fired — the tag/trigger may not be in the loaded container, or its condition does not match', interaction });
    }

    // Non-GA4 pixel/ads tag: we can't decode an event name, so a beacon to the tag's OWN platform
    // proves it fired. Match on the SPECIFIC platform (linkedin ≠ reddit ≠ meta …) so two ad tags on
    // one interaction aren't both credited; when the tag type is unknown ('ad'), any recognised
    // ad/pixel beacon counts.
    const want = expectedBeaconPlatform(tag.platform);
    const fired = cap.hits.find((h) => {
      const bp = beaconPlatform(h.url);
      return bp === want || (want === 'ad' && isKnownAdPlatform(bp));
    });
    if (fired) return withBeacons({ ...base, fired: true, ...(cap.kind === 'custom_event' ? { synthetic: true } : {}), event: beaconPlatform(fired.url), interaction, evidence: fired });
    // SERVER-SIDE destination: the interaction relayed to a FIRST-PARTY server container (a /g/collect
    // on the site's own domain, classified 'server'), but no browser beacon reached this tag's vendor.
    // For a pixel fed SERVER-SIDE via the Conversion API (e.g. Meta CAPI through sGTM), the browser
    // NEVER calls facebook.com/tr — a missing browser beacon is EXPECTED, not proof it's broken. So a
    // specific-vendor pixel whose interaction fired the server relay is inconclusive ("relayed
    // server-side"), NOT "not firing" — the biggest false-negative on server-side setups.
    const sawServerRelay = cap.hits.some((h) => classifyCollector(h.url) === 'server');
    const specificVendor = want !== 'ad' && cap.kind !== 'custom_event';
    if (specificVendor && sawServerRelay) {
      return withBeacons({ ...base, inconclusive: true, serverRelay: true, reason: `no browser-side ${want} beacon fired, but this interaction relayed to your first-party server container (sGTM) — if ${want} is sent server-side via the Conversion API, the browser never calls the vendor directly and this is expected; confirm the server leg in sGTM Preview / the vendor's Events Manager. If you meant to run a browser pixel, check the tag isn't paused or consent-gated (ad_storage)`, interaction });
    }
    // A GENERIC 'ad' tag is an undecodable Custom Template / Custom HTML we mapped by fallback: no
    // recognised beacon doesn't prove it's broken (it may be server-side, a non-pixel template, or a
    // beacon host we don't classify) → inconclusive. A SPECIFIC vendor (meta/tiktok/…) whose element
    // was clicked but produced no beacon (and no server relay) IS a genuine failure. custom_event
    // pushes stay inconclusive.
    const undecodable = want === 'ad' || cap.kind === 'custom_event';
    return withBeacons({ ...base, ...(undecodable ? { inconclusive: true } : {}), reason: `the interaction ran but no ${want === 'ad' ? 'ad/pixel' : want} beacon fired for this ${tag.platform} tag${observedBeacons.length ? ` (it did beacon to: ${observedBeacons.join(', ')})` : ''}`, interaction });
  }
}

function describeTrigger(t: VerifyTagInput['trigger']): string {
  if (t.clickTextValue) return `${t.clickTextOperator ?? 'equals'} click text "${t.clickTextValue}"`;
  if (t.clickUrlValue) return `${t.clickUrlOperator ?? 'contains'} click URL "${t.clickUrlValue}"`;
  if (t.formIdValue || t.formClassesValue) return `form ${t.formIdValue ?? t.formClassesValue}`;
  return t.kind;
}
