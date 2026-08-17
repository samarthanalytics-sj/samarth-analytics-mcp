/**
 * Server state and the create path for the Tag suggestions page.
 *
 * The browser never sends a tool name or tool arguments. It sends a scan id and the ids of the rows
 * the user ticked, and the arguments are rebuilt HERE from this process's own copy of the scan. That
 * is the same rule /v1/audit/fix follows, and for the same reason: an endpoint that executed a tool
 * name and argument bag posted by a browser would be an open write endpoint against whatever Google
 * account the caller is signed in as.
 *
 * Creation itself reuses createSuggestedTags, the identical loop the desktop app runs, so the
 * throttling, the quota backoff and the "already exists" handling behave the same on both surfaces.
 */

import { randomUUID } from 'node:crypto';
import { createSuggestedTags } from '../../desktop/src/main/suggestions/create-suggested-tags.js';
import type { CreateTagOutcome, SuggestedTagView } from '../../desktop/src/shared/ipc';
import type { ScanResult } from './scan-client.js';

/** How long a scan stays available to create from. */
export const SCAN_TTL_MS = 30 * 60_000;
/** How many scans to keep in memory at once, oldest evicted first. */
export const MAX_SCANS = 200;

export interface StoredScan {
  id: string;
  userId: string;
  site: string;
  createdAt: number;
  suggestions: SuggestedTagView[];
  warnings: string[];
  /**
   * Page path -> screenshot bytes.
   *
   * Held here rather than sent with the list. A ten-page scan is megabytes of image, the table shows
   * 47 rows, and almost none of them get opened: shipping every picture to render a list of names
   * would be paid on every scan for a view that is rarely used. The rows say WHICH page they have a
   * picture of, and the picture itself is fetched when one is opened.
   */
  images: Map<string, Buffer>;
}

/**
 * Rows as the page shows them. Deliberately not the whole suggestion: the browser gets what it needs
 * to render and choose, and the payload the tool will receive stays on the server.
 */
export interface SuggestionRow {
  id: string;
  tagName: string;
  platform: string;
  eventName?: string;
  page?: string;
  trigger?: unknown;
  /**
   * What kind of interaction fires this: click, form submit, scroll, and so on.
   *
   * Sent as its own field rather than left for the browser to infer from the tag name. Names like
   * "GA4 - Event - Contact Form Tag" read as a form and usually are, but "Get Your Free GA4
   * Implementation Consultation Form Tag" is a CTA click on a page about forms, and a reader
   * skimming 47 rows cannot tell those apart from the name.
   */
  triggerKind?: string;
  /** The trigger's name, as it will appear in GTM. */
  triggerName?: string;
  /** The GTM trigger type, in GTM's own wording ("Click - Just Links"). */
  triggerType?: string;
  /** Every condition the trigger will carry, so the table can show what it FIRES ON rather than only
   *  what someone named it. */
  conditions?: TriggerCondition[];
  /** What the SITE needs before this tag can fire. Absent when the engine attached no plan. */
  install?: InstallSummary;
  /** True when GA4 Enhanced Measurement already tracks this, so creating it would double-count. */
  enhancedMeasurementOverlap?: boolean;
  /** Where the thing this tag tracks sits on the page, in the screenshot's own coordinates, so the
   *  viewer can ring it. Absent when the scan could not identify exactly one element. */
  rect?: { x: number; y: number; w: number; h: number };
  /** For a site-wide row: the page the screenshot and rect belong to. */
  proofPage?: string;
  /** Whether a screenshot of this row's page exists to open. Never assumed from `page` alone: a
   *  capture can fail, and an offered picture that 404s is worse than one that was never offered. */
  hasImage?: boolean;
  /**
   * A person changed this row after the scan produced it.
   *
   * Shown in the table rather than kept quiet. Every other row can be checked against the site by
   * rescanning; an edited one cannot, and someone reading the table an hour later has no other way
   * to tell which rows are the scanner's findings and which are somebody's typing.
   */
  edited?: boolean;
}

/**
 * The GTM trigger type, named the way GTM names it.
 *
 * "Click" is what the Type column says because it is scannable; this is what someone types into GTM
 * to find the same thing. Both are shown, in different places, on purpose.
 */
const GTM_TRIGGER_TYPE: Record<string, string> = {
  link_click: 'Click - Just Links',
  all_clicks: 'Click - All Elements',
  form_submit: 'Form Submission',
  custom_event: 'Custom Event',
  pageview: 'Page View',
  youtube_video: 'YouTube Video',
  scroll: 'Scroll Depth',
  element_visibility: 'Element Visibility',
  timer: 'Timer',
};

export function gtmTriggerType(kind: unknown): string | undefined {
  const key = String(kind ?? '').trim();
  return key ? (GTM_TRIGGER_TYPE[key] ?? key.replace(/_/g, ' ')) : undefined;
}

/**
 * What has to exist on the SITE before a suggested tag can fire.
 *
 * The engine computes this per suggestion and nothing surfaced it, so a row that could never fire
 * looked exactly like one that fires the moment it is created. The Contact Form row on a real scan
 * is a Custom Event on form_submit: created as-is it is correct, permanent and silent, because
 * nothing on the site pushes that event.
 */
export interface InstallSummary {
  /** Plain-English "what you must do", from the engine. */
  summary: string;
  /** Each requirement, reduced to what a reader needs: what kind it is and what it says. */
  requires: Array<{ kind: string; detail: string }>;
  /**
   * Nothing has to change on the site: every requirement is a native element or a provider that
   * already pushes the event.
   */
  firesAsIs: boolean;
  /** A GTM Custom HTML listener tag exists that would satisfy this without touching the site. */
  listenerAvailable: boolean;
  /** A developer has to add code. No tag creation makes this row fire. */
  needsSiteCode: boolean;
}

/** Requirement kinds that mean the site is already fine as it stands. */
const SATISFIED_KINDS = new Set(['native', 'provider-native']);

export function installSummary(install: unknown): InstallSummary | undefined {
  const plan = install as { summary?: unknown; requires?: unknown } | undefined;
  const list = Array.isArray(plan?.requires) ? (plan?.requires as Record<string, unknown>[]) : [];
  if (!plan || list.length === 0) return undefined;

  const requires = list.map((r) => ({
    kind: String(r.kind ?? ''),
    detail: String(r.detail ?? ''),
  }));
  return {
    summary: typeof plan.summary === 'string' ? plan.summary : '',
    requires,
    firesAsIs: requires.every((r) => SATISFIED_KINDS.has(r.kind)),
    listenerAvailable: requires.some((r) => r.kind === 'listener-tag'),
    needsSiteCode: requires.some((r) => r.kind === 'site-code'),
  };
}

/** One row of a GTM trigger's condition table: variable, operator, value. */
export interface TriggerCondition {
  variable: string;
  operator: string;
  value: string;
  /**
   * This condition can be changed from the table, and the change reaches GTM.
   *
   * Absent means read-only, and the two reasons for that are different. A lookup-table or dataLayer
   * condition is read-only because the create path here cannot carry it at all (see `carried`); the
   * custom_event name is read-only because a listener tag pushes that exact string, so renaming one
   * without the other leaves a trigger waiting for an event nothing sends.
   */
  editable?: boolean;
  /**
   * The operators GTM offers for THIS condition, sent with it rather than known by the browser.
   *
   * One list, on the server, next to the validation that enforces it. A copy in the page would be a
   * second list to keep in step, and the failure when they drift is a dropdown offering a choice
   * the server refuses.
   */
  operators?: Array<{ key: string; label: string }>;
  /**
   * False when creating this row from the website drops the condition.
   *
   * Not a detail: a click trigger stripped of its {{Click Element}} scope does not fire less, it
   * fires on EVERY click. The table showed all of these identically, so a condition that survives
   * and one that is discarded looked the same right up until the container was wrong.
   */
  carried: boolean;
}

/** GTM's own wording for a filter operator. */
const OPERATOR_LABEL: Record<string, string> = {
  equals: 'equals',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matchRegex: 'matches RegEx',
  cssSelector: 'matches CSS selector',
};

/** Operator keys, with the wording to show for each. The browser sends the key, never the label. */
export const OPERATORS: Array<{ key: string; label: string }> = Object.entries(OPERATOR_LABEL).map(
  ([key, label]) => ({ key, label }),
);

/** What GTM offers on a plain string condition. cssSelector is not here: it is element-only. */
const TEXT_OPERATORS = ['equals', 'contains', 'startsWith', 'endsWith', 'matchRegex'];

/**
 * The condition rows an edit may change, and the trigger fields each one writes back to.
 *
 * Keyed by the variable name the table prints, because that is what the browser can refer to: it is
 * sent the flattened condition list, not the trigger object, and this map is the only thing that
 * turns "Click Text" back into clickTextValue/clickTextOperator. Nothing outside this map is
 * writable, so a request naming any other field changes nothing.
 */
export const EDITABLE_CONDITIONS: Record<
  string,
  { value: string; operator: string; operators: string[] }
> = {
  'Click URL': { value: 'clickUrlValue', operator: 'clickUrlOperator', operators: TEXT_OPERATORS },
  'Click Text': { value: 'clickTextValue', operator: 'clickTextOperator', operators: TEXT_OPERATORS },
  'Click Element': {
    value: 'clickElementValue',
    operator: 'clickElementOperator',
    operators: ['cssSelector', 'equals', 'contains', 'matchRegex'],
  },
  'Click ID': { value: 'clickIdValue', operator: 'clickIdOperator', operators: TEXT_OPERATORS },
  'Click Classes': {
    value: 'clickClassesValue',
    operator: 'clickClassesOperator',
    operators: ['contains', 'equals', 'matchRegex'],
  },
  'Form ID': { value: 'formIdValue', operator: 'formIdOperator', operators: TEXT_OPERATORS },
  'Form Classes': {
    value: 'formClassesValue',
    operator: 'formClassesOperator',
    operators: ['contains', 'equals', 'matchRegex'],
  },
  'Page Path': { value: 'pagePathValue', operator: 'pagePathOperator', operators: TEXT_OPERATORS },
  'Page URL': { value: 'pageUrlValue', operator: 'pageUrlOperator', operators: TEXT_OPERATORS },
};

const op = (v: unknown, fallback = 'equals'): string =>
  OPERATOR_LABEL[String(v ?? '')] ?? OPERATOR_LABEL[fallback];

/**
 * Flatten a suggestion's trigger into the condition rows GTM would show.
 *
 * The table used to print the trigger's NAME and nothing else. "Get In Touch Form Trigger" tells you
 * what someone called it, not what it fires on, and the difference between a form trigger scoped to
 * one form id and one scoped to a page path is the difference between a tag that works and a tag
 * that fires on every form on the site. All of it was already in the payload, unread.
 */
export function triggerConditions(trigger: unknown): TriggerCondition[] {
  const t = (trigger ?? {}) as Record<string, unknown>;
  const out: TriggerCondition[] = [];
  const pair = (variable: string, value: unknown, operator: unknown, fallback = 'equals'): void => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) return;
    const field = EDITABLE_CONDITIONS[variable];
    out.push({
      variable,
      operator: op(operator, fallback),
      value: v,
      editable: true,
      carried: true,
      operators: field.operators.map((key) => ({ key, label: OPERATOR_LABEL[key] ?? key })),
    });
  };

  // custom_event keys on the pushed event name, which is the condition that matters most for it.
  //
  // Carried, but not editable. The listener tag created alongside this row pushes this exact string,
  // and the two are generated together; renaming one here would leave a trigger listening for an
  // event that nothing on the site ever sends, and the tag would look perfectly correct in GTM.
  const kind = String(t.kind ?? t.type ?? '');
  if (kind === 'custom_event' && typeof t.eventName === 'string' && t.eventName.trim()) {
    out.push({ variable: 'Event name', operator: 'equals', value: t.eventName.trim(), carried: true });
  }

  pair('Click URL', t.clickUrlValue, t.clickUrlOperator, 'contains');
  pair('Click Text', t.clickTextValue, t.clickTextOperator);
  pair('Click Element', t.clickElementValue, t.clickElementOperator, 'cssSelector');
  pair('Click ID', t.clickIdValue, t.clickIdOperator);
  pair('Click Classes', t.clickClassesValue, t.clickClassesOperator, 'matchRegex');
  pair('Form ID', t.formIdValue, t.formIdOperator);
  pair('Form Classes', t.formClassesValue, t.formClassesOperator);
  pair('Page Path', t.pagePathValue, t.pagePathOperator);
  pair('Page URL', t.pageUrlValue, t.pageUrlOperator);

  // A lookup table is one condition in GTM (the variable returns "true"), but the texts behind it are
  // the actual scope, so they are named rather than hidden behind the variable's name.
  //
  // NOT carried. It needs a companion Lookup Table variable created alongside the trigger, and the
  // MCP's create tool only enables BUILT-IN variables. A trigger pointing at a user variable that
  // was never created is accepted by GTM and never fires.
  const lookup = t.lookupTable as { name?: unknown; texts?: unknown } | undefined;
  if (lookup && typeof lookup.name === 'string') {
    const texts = Array.isArray(lookup.texts) ? lookup.texts.map(String) : [];
    out.push({
      variable: lookup.name,
      operator: 'equals',
      value: texts.length ? `true (for: ${texts.join(', ')})` : 'true',
      carried: false,
    });
  }

  // Also not carried, and for the same reason: each needs its own `dlv - <key>` Data Layer Variable
  // provisioned first, which the desktop does and this path does not.
  for (const c of Array.isArray(t.dataLayerConditions) ? t.dataLayerConditions : []) {
    const cond = c as { key?: unknown; value?: unknown; operator?: unknown };
    if (typeof cond.key === 'string' && cond.key.trim()) {
      out.push({
        variable: `dlv - ${cond.key.trim()}`,
        operator: op(cond.operator),
        value: String(cond.value ?? ''),
        carried: false,
      });
    }
  }
  return out;
}

/** GTM trigger types as a person describes them. Unknown kinds pass through rather than vanish. */
const TRIGGER_KIND_LABEL: Record<string, string> = {
  link_click: 'Click',
  all_clicks: 'Click',
  form_submit: 'Form',
  custom_event: 'Custom event',
  pageview: 'Pageview',
  youtube_video: 'Video',
  scroll: 'Scroll',
  element_visibility: 'Visibility',
  timer: 'Timer',
};

export function triggerKindLabel(type: unknown): string | undefined {
  const key = String(type ?? '').trim();
  if (!key) return undefined;
  return TRIGGER_KIND_LABEL[key] ?? key.replace(/_/g, ' ');
}

/** Give every suggestion a stable id, since the browser refers to rows by id alone. */
function withIds(list: Record<string, unknown>[]): SuggestedTagView[] {
  return list.map((s, i) => ({ ...(s as object), id: typeof s.id === 'string' && s.id ? s.id : `s${i + 1}` }) as SuggestedTagView);
}

export function toRows(list: SuggestedTagView[], images?: ReadonlyMap<string, Buffer>): SuggestionRow[] {
  return list.map((s) => {
    const raw = s as unknown as Record<string, unknown>;
    // The engine writes `kind`; create_gtm_tracking_tag's own schema calls the same thing `type`.
    // Read both: the first version of this read only `type` and every row came back blank.
    const trigger = (s.trigger ?? {}) as { kind?: unknown; type?: unknown };
    const kind = triggerKindLabel(trigger.kind ?? trigger.type);
    const conditions = triggerConditions(s.trigger);
    const triggerName = (trigger as { name?: unknown }).name;
    const gtmType = gtmTriggerType(trigger.kind ?? trigger.type);
    return {
      id: s.id,
      tagName: s.tagName,
      platform: String(s.platform),
      ...(s.eventName ? { eventName: s.eventName } : {}),
      ...(typeof raw.page === 'string' ? { page: raw.page } : {}),
      ...(s.trigger ? { trigger: s.trigger } : {}),
      ...(kind ? { triggerKind: kind } : {}),
      ...(typeof triggerName === 'string' && triggerName ? { triggerName } : {}),
      ...(gtmType ? { triggerType: gtmType } : {}),
      ...(conditions.length ? { conditions } : {}),
      ...(installSummary(raw.install) ? { install: installSummary(raw.install) } : {}),
      ...(raw.rect ? { rect: raw.rect as SuggestionRow['rect'] } : {}),
      ...(typeof raw.proofPage === 'string' ? { proofPage: raw.proofPage } : {}),
      ...(images?.has(proofPageOf(raw) ?? '') ? { hasImage: true } : {}),
      ...(raw.enhancedMeasurementOverlap === true ? { enhancedMeasurementOverlap: true } : {}),
      ...(raw.edited === true ? { edited: true } : {}),
    };
  });
}

/**
 * A change to one scanned row, as the browser may express it.
 *
 * Deliberately not "here is the new suggestion". Every field is named, validated and written into
 * THIS process's copy of the scan, which is what keeps /v1/suggestions/create unable to build a tag
 * the scan never produced. An edit widens what the user may change; it does not widen what the
 * endpoint can be talked into creating.
 */
export interface RowEdit {
  tagName?: string;
  eventName?: string;
  triggerName?: string;
  /** Condition changes, keyed by the variable name the table shows. An empty value removes it. */
  conditions?: Array<{ variable: string; operator?: string; value?: string }>;
}

export interface EditResult {
  row: SuggestedTagView;
  /** What changed, in words, for the log and for the response. */
  changed: string[];
  /** What was asked for and refused, each with the reason to show. */
  rejected: string[];
}

/** GTM's own ceiling on a name. Longer is refused by the API, after the round trip. */
const MAX_NAME = 255;

/**
 * GA4's rules for an event name: start with a letter, then letters, digits and underscores, 40 max.
 *
 * Enforced here rather than left to GTM, because GTM does not enforce it. A tag named with a space
 * or a leading digit is created happily, fires happily, and GA4 discards the event on receipt. The
 * only symptom is a report that stays empty.
 */
const GA4_EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** GA4 drops anything under these prefixes as reserved. */
const GA4_RESERVED_PREFIX = /^(ga_|google_|firebase_)/i;

/**
 * Apply an edit to one suggestion, returning a new row.
 *
 * Field by field, and anything not recognised is REPORTED rather than ignored. A silent no-op on a
 * misspelled field is the failure this whole page keeps hitting in other forms: the screen says the
 * change was saved, the container disagrees, and nothing in between said so.
 */
export function applyRowEdit(row: SuggestedTagView, edit: RowEdit): EditResult {
  const changed: string[] = [];
  const rejected: string[] = [];
  const next = { ...row, trigger: { ...row.trigger } } as SuggestedTagView;

  const name = edit.tagName?.trim();
  if (name !== undefined && name !== row.tagName) {
    if (!name) rejected.push('A tag needs a name.');
    else if (name.length > MAX_NAME) rejected.push(`That tag name is ${name.length} characters; GTM allows ${MAX_NAME}.`);
    else {
      next.tagName = name;
      changed.push(`tag name -> "${name}"`);
    }
  }

  const event = edit.eventName?.trim();
  if (event !== undefined && event !== row.eventName) {
    // Only GA4 gets GA4's rules. Meta, TikTok and the rest use their own standard event names, and
    // "Lead" or "AddToCart" is correct there and would fail a lowercase-only check.
    const ga4 = row.platform === 'ga4_event';
    if (!event) rejected.push('An event name is required.');
    else if (ga4 && !GA4_EVENT_NAME.test(event)) {
      rejected.push(
        `"${event}" is not a valid GA4 event name. Use a letter first, then letters, digits or ` +
          'underscores, up to 40 characters. GA4 discards events it cannot parse, so the tag would ' +
          'fire and report nothing.',
      );
    } else if (ga4 && GA4_RESERVED_PREFIX.test(event)) {
      rejected.push(`"${event}" starts with a prefix GA4 reserves (ga_, google_, firebase_) and would be dropped.`);
    } else if (event.length > MAX_NAME) rejected.push('That event name is too long.');
    else {
      next.eventName = event;
      changed.push(`event name -> "${event}"`);
    }
  }

  const triggerName = edit.triggerName?.trim();
  if (triggerName !== undefined && triggerName !== row.trigger?.name) {
    if (!triggerName) rejected.push('A trigger needs a name.');
    else if (triggerName.length > MAX_NAME) rejected.push('That trigger name is too long.');
    else {
      next.trigger.name = triggerName;
      changed.push(`trigger name -> "${triggerName}"`);
    }
  }

  const trigger = next.trigger as unknown as Record<string, unknown>;
  for (const c of edit.conditions ?? []) {
    const field = EDITABLE_CONDITIONS[c.variable];
    if (!field) {
      rejected.push(`"${c.variable}" cannot be edited here.`);
      continue;
    }
    // Only conditions the scan already put on this trigger. Adding one would mean the row fires on
    // something no page was ever checked against, which is a suggestion the scan did not make.
    if (!String(trigger[field.value] ?? '').trim()) {
      rejected.push(`This trigger has no ${c.variable} condition to change.`);
      continue;
    }
    if (c.operator !== undefined) {
      if (!field.operators.includes(c.operator)) {
        rejected.push(`"${c.operator}" is not an operator GTM offers for ${c.variable}.`);
        continue;
      }
      if (c.operator !== trigger[field.operator]) {
        trigger[field.operator] = c.operator;
        changed.push(`${c.variable} operator -> ${OPERATOR_LABEL[c.operator] ?? c.operator}`);
      }
    }
    if (c.value !== undefined) {
      const value = c.value.trim();
      if (value === String(trigger[field.value] ?? '').trim()) continue;
      trigger[field.value] = value;
      // Named as a removal, because that is what it does to the tag: a click trigger with its
      // {{Click Element}} scope cleared fires on every click on the site, not on fewer of them.
      changed.push(value ? `${c.variable} -> "${value}"` : `${c.variable} condition removed`);
    }
  }

  if (changed.length) (next as unknown as Record<string, unknown>).edited = true;
  return { row: next, changed, rejected };
}

/**
 * In-memory, and that is a deliberate limit rather than a shortcut: a scan is a working set for the
 * next few minutes, not a record. A restart loses it, and the page's answer to that is to scan
 * again, which is cheap and always current. Persisting it would mean storing a crawl of a customer's
 * site in a database that exists to hold their chat history.
 */
export class ScanStore {
  private readonly scans = new Map<string, StoredScan>();

  put(userId: string, result: ScanResult): StoredScan {
    this.purge();
    const images = new Map<string, Buffer>();
    for (const img of result.pageImages ?? []) {
      if (img?.page && img.image) images.set(img.page, Buffer.from(img.image, 'base64'));
    }
    const record: StoredScan = {
      id: randomUUID(),
      userId,
      site: result.site,
      createdAt: Date.now(),
      suggestions: withIds(result.suggestions),
      warnings: result.warnings,
      images,
    };
    this.scans.set(record.id, record);
    return record;
  }

  /**
   * A scan belongs to the user who ran it. The id is a random UUID, but ownership is checked anyway:
   * an unguessable id is not an authorisation model, and this one is handed to a browser.
   */
  get(userId: string, scanId: string): StoredScan | null {
    const found = this.scans.get(scanId);
    if (!found || found.userId !== userId) return null;
    if (Date.now() - found.createdAt > SCAN_TTL_MS) {
      this.scans.delete(scanId);
      return null;
    }
    return found;
  }

  /**
   * Change one row of a stored scan in place, so the create path sees the edit without being told.
   *
   * Written back into the store rather than carried on the create request. If the browser sent its
   * edits at create time, the endpoint would be taking a tag payload from a browser by another
   * route, and the whole reason this module holds the scan is that it does not do that. This way
   * /v1/suggestions/create is unchanged: it still builds from the server's own copy.
   *
   * The scan's TTL is NOT extended. An edit is not a reason to keep a crawl of someone's site in
   * memory longer, and a scan old enough to expire is old enough to be worth re-running anyway.
   */
  editRow(userId: string, scanId: string, rowId: string, edit: RowEdit): EditResult | null {
    const scan = this.get(userId, scanId);
    if (!scan) return null;
    const index = scan.suggestions.findIndex((s) => s.id === rowId);
    if (index < 0) return null;
    const result = applyRowEdit(scan.suggestions[index], edit);
    // Only on a real change. Rewriting the array for an edit that turned out to be a no-op would
    // stamp the row "edited" for nothing.
    if (result.changed.length) scan.suggestions[index] = result.row;
    return result;
  }

  private purge(): void {
    const cutoff = Date.now() - SCAN_TTL_MS;
    for (const [id, s] of this.scans) if (s.createdAt < cutoff) this.scans.delete(id);
    while (this.scans.size >= MAX_SCANS) {
      const oldest = this.scans.keys().next().value;
      if (oldest === undefined) break;
      this.scans.delete(oldest);
    }
  }

  get size(): number {
    return this.scans.size;
  }
}

/**
 * The screenshot for one row, by row id.
 *
 * Looked up through the ROW rather than by page path from the request, so a caller cannot ask this
 * scan for a page it never scanned, and cannot probe which paths exist on someone's site.
 */
/**
 * The page a row's proof belongs to: its own, or the example page chosen for a site-wide row.
 *
 * A site-wide row has no page of its own, which is why it had no picture at all. The scan now names
 * the page it measured the element on, so the footer email link can be shown where it was found.
 */
function proofPageOf(row: unknown): string | undefined {
  const r = row as { page?: unknown; proofPage?: unknown } | undefined;
  const proof = typeof r?.proofPage === 'string' ? r.proofPage : undefined;
  const page = typeof r?.page === 'string' ? r.page : undefined;
  return proof ?? (page === 'site-wide' ? undefined : page);
}

export function imageForRow(scan: StoredScan, rowId: string): Buffer | null {
  const page = proofPageOf(scan.suggestions.find((s) => s.id === rowId));
  return page ? (scan.images.get(page) ?? null) : null;
}

/**
 * Pick the ticked rows out of a stored scan, in the order the scan produced them.
 *
 * Unknown ids are reported rather than skipped. Silently creating four tags when five were ticked is
 * the kind of wrong that only shows up later, in a container someone else has to debug.
 */
export function selectRows(
  scan: StoredScan,
  ids: readonly string[],
): { selected: SuggestedTagView[]; unknown: string[] } {
  const wanted = new Set(ids);
  const selected = scan.suggestions.filter((s) => wanted.has(s.id));
  const found = new Set(selected.map((s) => s.id));
  return { selected, unknown: [...wanted].filter((id) => !found.has(id)) };
}

/**
 * Ask the tool to resolve the id from the container, unless the user named one.
 *
 * The scanner cannot know a measurement id, so it emits the reference "{{GA4 Measurement ID}}" as a
 * stand-in. create_gtm_tracking_tag passes a {{variable}} through untouched, and deliberately so: a
 * chat caller who types one has chosen a variable that exists. Here nobody chose it. If the
 * container has no variable by that name, GTM accepts the tag and it reports to nothing, which is
 * the one outcome worth engineering against, because it looks like success.
 *
 * So an unresolved reference is turned into the literal placeholder the tool already knows how to
 * handle: it reads the real id off the container's Google tag, or refuses and says the workspace has
 * none. That reuses one tested resolution path instead of adding a second one here.
 */
const VARIABLE_REFERENCE = /^\s*\{\{.+\}\}\s*$/;
/** Recognised by isPlaceholderMeasurementId in the MCP, which triggers the container lookup. */
const RESOLVE_FROM_CONTAINER = 'G-XXXXXXXXXX';

export function withMeasurementId(list: SuggestedTagView[], measurementId?: string): SuggestedTagView[] {
  const id = (measurementId ?? '').trim();
  if (id) return list.map((s) => ({ ...s, measurementId: id }));
  return list.map((s) =>
    VARIABLE_REFERENCE.test(String(s.measurementId ?? ''))
      ? { ...s, measurementId: RESOLVE_FROM_CONTAINER }
      : s,
  );
}

export type ToolExecute = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * The platforms the MCP's create tool can actually build.
 *
 * It builds GA4 event tags and Custom HTML tags. It does NOT build Meta, TikTok, LinkedIn, Reddit,
 * Pinterest or Google Ads tags: the desktop app does that through its own registry. Sending one here
 * used to produce a GA4 tag carrying that platform's id, because the schema had no platform field
 * and zod dropped the key, so the row reported "Created" and the tag pointed at nothing usable.
 *
 * The scan offers those platforms, so this list is what keeps the offer honest at the point of
 * writing rather than at the point of scanning.
 */
export const CREATABLE_PLATFORMS = new Set(['ga4_event', 'custom_html']);

export interface Creatable {
  /** Rows this deployment can create. */
  supported: SuggestedTagView[];
  /** Rows it cannot, each with the reason to show. */
  unsupported: Array<{ id: string; platform: string; reason: string }>;
}

/** Split a selection into what can be created here and what cannot, before anything is written. */
export function splitCreatable(list: SuggestedTagView[]): Creatable {
  const supported: SuggestedTagView[] = [];
  const unsupported: Creatable['unsupported'] = [];
  for (const s of list) {
    const platform = String(s.platform ?? '');
    if (CREATABLE_PLATFORMS.has(platform)) supported.push(s);
    else {
      unsupported.push({
        id: s.id,
        platform,
        reason:
          `Creating ${platform.replace(/_/g, ' ')} tags from the website is not supported yet. ` +
          'The scan finds them, and the desktop app can create them.',
      });
    }
  }
  return { supported, unsupported };
}

/**
 * Conditions that will not survive the create, per row.
 *
 * Computed before anything is written and reported with the result, because the difference is not
 * cosmetic: a click trigger that loses its scope fires on every click in the container, and a
 * dataLayer-scoped form trigger that loses its scope fires for every form on the site. Both look
 * like a successful create.
 *
 * These are the lookup-table and dataLayer conditions, which need a companion USER variable created
 * alongside the trigger. The desktop app provisions those; the MCP's create tool enables built-in
 * variables only, so pointing a trigger at one here would produce a trigger GTM accepts and never
 * fires. Reported rather than half-built.
 */
export function droppedConditions(list: SuggestedTagView[]): Array<{ id: string; tagName: string; conditions: string[] }> {
  const out: Array<{ id: string; tagName: string; conditions: string[] }> = [];
  for (const s of list) {
    const conditions = triggerConditions(s.trigger)
      .filter((c) => !c.carried)
      .map((c) => `${c.variable} ${c.operator} ${c.value}`);
    if (conditions.length) out.push({ id: s.id, tagName: s.tagName, conditions });
  }
  return out;
}

/**
 * The Custom HTML listener tags a selection needs, deduped by tag name.
 *
 * A listener is per SITE behaviour, not per tag: three forms behind the same Calendly embed need one
 * listener between them, and creating it three times would leave three copies pushing the same event
 * on every page.
 */
export function listenerTagsFor(list: SuggestedTagView[]): Array<{
  tagName: string;
  html: string;
  fires: string;
  forRows: string[];
}> {
  const byName = new Map<string, { tagName: string; html: string; fires: string; forRows: string[] }>();
  for (const s of list) {
    const install = (s as unknown as { install?: { requires?: unknown } }).install;
    const requires = Array.isArray(install?.requires) ? (install?.requires as Record<string, unknown>[]) : [];
    for (const r of requires) {
      if (r.kind !== 'listener-tag') continue;
      const tag = r.tag as { name?: unknown; html?: unknown; fires?: unknown } | undefined;
      const name = typeof tag?.name === 'string' ? tag.name : '';
      const html = typeof tag?.html === 'string' ? tag.html : '';
      if (!name || !html) continue;
      const existing = byName.get(name);
      if (existing) existing.forRows.push(s.id);
      else byName.set(name, { tagName: name, html, fires: String(tag?.fires ?? 'all_pages'), forRows: [s.id] });
    }
  }
  return [...byName.values()];
}

/** The install plan's `fires` value as a GTM trigger this tool understands. */
export function listenerTrigger(fires: string): { name: string; kind: string } {
  if (fires === 'dom_ready') return { name: 'DOM Ready', kind: 'dom_ready' };
  if (fires === 'window_loaded') return { name: 'Window Loaded', kind: 'window_loaded' };
  return { name: 'All Pages', kind: 'pageview' };
}

export interface CreateResult {
  outcomes: CreateTagOutcome[];
  created: number;
  existing: number;
  failed: number;
  /** Listener tags created for the rows that needed one, each with what happened. */
  listeners: Array<{ tagName: string; ok: boolean; existing?: boolean; error?: string }>;
}

/**
 * Create the selected suggestions as DRAFT tags.
 *
 * Listeners go FIRST, and that order is the point rather than tidiness: a GA4 tag on a Custom Event
 * trigger does nothing until something pushes that event, so creating the listener afterwards leaves
 * a window where the container looks complete and reports nothing. Same reason the form recipes in
 * the desktop say "create this FIRST".
 *
 * A listener that fails does NOT stop its GA4 tag being created. The tag is still correct, and a
 * half-built pair someone can finish by hand beats nothing at all, as long as the failure is
 * reported, which it is.
 */
export async function createSelected(
  execute: ToolExecute,
  ids: { accountId: string; containerId: string; workspaceId: string },
  tags: SuggestedTagView[],
  onProgress?: (done: number, total: number) => void,
): Promise<CreateResult> {
  const listeners: CreateResult['listeners'] = [];
  for (const listener of listenerTagsFor(tags)) {
    try {
      const raw = await execute('create_gtm_tracking_tag', {
        ...ids,
        platform: 'custom_html',
        tagName: listener.tagName,
        html: listener.html,
        trigger: listenerTrigger(listener.fires),
      });
      const out = JSON.parse(raw) as { alreadyExists?: boolean };
      listeners.push({ tagName: listener.tagName, ok: out?.alreadyExists !== true, existing: out?.alreadyExists === true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      listeners.push({
        tagName: listener.tagName,
        ok: false,
        ...(/duplicate name|already exists/i.test(message) ? { existing: true } : { error: message }),
      });
    }
  }

  const outcomes = await createSuggestedTags(execute, ids, tags, onProgress ? { onProgress } : {});
  return {
    outcomes,
    created: outcomes.filter((o) => o.ok).length,
    existing: outcomes.filter((o) => !o.ok && o.existing).length,
    failed: outcomes.filter((o) => !o.ok && !o.existing).length,
    listeners,
  };
}
