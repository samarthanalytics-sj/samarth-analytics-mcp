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
  /** Whether a screenshot of this row's page exists to open. Never assumed from `page` alone: a
   *  capture can fail, and an offered picture that 404s is worse than one that was never offered. */
  hasImage?: boolean;
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
    if (v) out.push({ variable, operator: op(operator, fallback), value: v });
  };

  // custom_event keys on the pushed event name, which is the condition that matters most for it.
  const kind = String(t.kind ?? t.type ?? '');
  if (kind === 'custom_event' && typeof t.eventName === 'string' && t.eventName.trim()) {
    out.push({ variable: 'Event name', operator: 'equals', value: t.eventName.trim() });
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
  const lookup = t.lookupTable as { name?: unknown; texts?: unknown } | undefined;
  if (lookup && typeof lookup.name === 'string') {
    const texts = Array.isArray(lookup.texts) ? lookup.texts.map(String) : [];
    out.push({
      variable: lookup.name,
      operator: 'equals',
      value: texts.length ? `true (for: ${texts.join(', ')})` : 'true',
    });
  }

  for (const c of Array.isArray(t.dataLayerConditions) ? t.dataLayerConditions : []) {
    const cond = c as { key?: unknown; value?: unknown; operator?: unknown };
    if (typeof cond.key === 'string' && cond.key.trim()) {
      out.push({
        variable: `dlv - ${cond.key.trim()}`,
        operator: op(cond.operator),
        value: String(cond.value ?? ''),
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
      ...(typeof raw.page === 'string' && images?.has(raw.page) ? { hasImage: true } : {}),
      ...(raw.enhancedMeasurementOverlap === true ? { enhancedMeasurementOverlap: true } : {}),
    };
  });
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
export function imageForRow(scan: StoredScan, rowId: string): Buffer | null {
  const row = scan.suggestions.find((s) => s.id === rowId);
  const page = (row as unknown as { page?: unknown } | undefined)?.page;
  if (typeof page !== 'string') return null;
  return scan.images.get(page) ?? null;
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

export interface CreateResult {
  outcomes: CreateTagOutcome[];
  created: number;
  existing: number;
  failed: number;
}

/** Create the selected suggestions as DRAFT tags, then count the outcomes for the summary line. */
export async function createSelected(
  execute: ToolExecute,
  ids: { accountId: string; containerId: string; workspaceId: string },
  tags: SuggestedTagView[],
  onProgress?: (done: number, total: number) => void,
): Promise<CreateResult> {
  const outcomes = await createSuggestedTags(execute, ids, tags, onProgress ? { onProgress } : {});
  return {
    outcomes,
    created: outcomes.filter((o) => o.ok).length,
    existing: outcomes.filter((o) => !o.ok && o.existing).length,
    failed: outcomes.filter((o) => !o.ok && !o.existing).length,
  };
}
