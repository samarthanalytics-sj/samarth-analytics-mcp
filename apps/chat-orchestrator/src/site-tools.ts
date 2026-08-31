/**
 * Reading the user's OWN WEBSITE from the chat, so a trigger is built from what is on the page
 * rather than from a plausible-sounding guess.
 *
 * The chat could already create a tag and a trigger. What it could not do was find out what the
 * site actually contains, so every click trigger it proposed was built from whatever the user had
 * typed into the message: a class name they half-remembered, a button label with different casing,
 * a form id that belonged to a different form. GTM accepts all of those. The tag is created, it
 * looks configured, and it collects nothing until somebody audits it weeks later. That failure is
 * the whole reason this file exists.
 *
 * The engine is NOT reimplemented here. These tools call the same web-audit MCP that the Tag
 * suggestions page calls, which is the same one the desktop app drives, so a selector the chat
 * proposes and a selector the suggestions page proposes are the same selector. The trigger ladder
 * itself lives in apps/web-audit-mcp/src/agent/tag-suggest/trigger-strategy.ts.
 *
 * THREE THINGS THIS FILE IS CAREFUL ABOUT:
 *
 *  1. IT NEVER INVENTS A CONDITION. The engine returns an empty strategy when nothing durable was
 *     found, and that is passed through as "no durable signal", not smoothed over. A guessed
 *     condition is indistinguishable from a working one until the data is checked.
 *
 *  2. IT SAYS WHICH CONDITIONS SURVIVE CREATION. create_gtm_tracking_tag carries the plain
 *     condition fields and drops a lookup-table or dataLayer scope, because those need companion
 *     user variables it does not create. A click trigger stripped of its scope does not fire less,
 *     it fires on EVERY click, so a dropped condition is reported rather than quietly lost.
 *
 *  3. IT FITS IN A CHAT TURN. A scan owns a whole request on the suggestions page and may run for
 *     twenty minutes over 200 pages. Here it is one step inside a turn that has its own budget, so
 *     the page count is small by default, the deadline is minutes rather than tens of minutes, and
 *     running out points at the page that can do the big scan instead of failing blankly.
 */

import { DeadlineError } from './deadline.js';
import { ScanError, type ScanResult, type SiteScanner } from './scan-client.js';
import { gtmTriggerType, installSummary, triggerConditions } from './suggestions.js';
import type { ToolDef } from './types.js';

export const SITE_PAGES_LIST = 'site_pages_list';
export const SITE_SCAN_TRIGGERS = 'site_scan_triggers';

/** Is this one of the orchestrator's own site tools rather than something on the MCP server? */
export function isSiteTool(name: string): boolean {
  return name === SITE_PAGES_LIST || name === SITE_SCAN_TRIGGERS;
}

/**
 * Pages a chat scan opens when the caller does not say.
 *
 * Small on purpose. The engine dedupes site-wide, so the header CTA, the footer phone link and the
 * contact form are all found from a handful of representative pages; the pages beyond that mostly
 * re-find what is already in the list. Five pages is roughly twenty seconds of browser time, which
 * a chat turn can absorb.
 */
export const CHAT_DEFAULT_PAGES = 5;

/**
 * The most a chat scan will open, whatever was asked for.
 *
 * Not the scanner's own ceiling of 200: that one exists to bound a request that has nothing else to
 * do. Here the scan shares a turn with the model calls before and after it, and a scan that eats
 * the whole budget leaves the user with a timeout instead of an answer. Anything larger belongs on
 * the Tag suggestions page, and the refusal below says so rather than silently clamping.
 */
export const CHAT_MAX_PAGES = 15;

/**
 * How long a chat scan may run before it is abandoned.
 *
 * Under the 240s turn budget with room for the model call that reads the result. A scan that
 * overruns is not retried with the same numbers: the message tells the user to name fewer pages or
 * use the suggestions page, because repeating a 170-second failure is the expensive way to learn
 * nothing.
 */
export const CHAT_SCAN_TIMEOUT_MS = 170_000;

/** A discovery is a few HTTP GETs, so it is bounded far tighter than the scan. */
export const CHAT_DISCOVER_TIMEOUT_MS = 30_000;

/**
 * The most suggestions in one result, before the character budget gets a say.
 *
 * A ceiling on top of the budget rather than instead of it. Twenty-five rows is already more than
 * anyone acts on in one turn, and the budget alone would happily return sixty short ones.
 */
export const MAX_SUGGESTIONS_RETURNED = 25;

/**
 * Characters a scan result may occupy, when the caller does not say.
 *
 * Measured, not guessed: a real two-page scan of a marketing site produced 22 suggestions and
 * 23,912 characters against a 16,000 character tool-result cap. Nothing warned, because the cap is
 * applied downstream by capToolResult, which cuts the JSON in the middle of an object. The model
 * then gets a truncation notice attached to unparseable text and has to guess what was in it.
 *
 * So the packing happens HERE, where the rows are still whole, and what did not fit is counted.
 */
export const DEFAULT_RESULT_BUDGET_CHARS = 14_000;

/** Prose fields are capped per row: they are context for the model, not documents. */
const MAX_PROSE = 240;

/** Trim to a length without ending mid-word, and say when something was cut. */
function short(text: string, max = MAX_PROSE): string {
  const s = text.trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/\s+\S*$/, '')}...`;
}

/** How many page URLs a listing prints before it starts counting instead. */
export const MAX_PAGES_LISTED = 120;

/**
 * The tool definitions the model sees.
 *
 * The descriptions carry the operating rules rather than leaving them to the system prompt, because
 * this is the text the model reads at the moment it is deciding whether to guess a selector or go
 * and look at one.
 */
export function siteToolDefs(): ToolDef[] {
  return [
    {
      name: SITE_PAGES_LIST,
      description:
        'List the pages of a public website WITHOUT opening a browser, by reading its sitemap and ' +
        'falling back to a fast link crawl. Cheap and quick. Use it before ' +
        SITE_SCAN_TRIGGERS +
        ' when the user names a site but not which pages matter, so they can pick the few worth ' +
        'scanning. READ sitemapStatus before saying anything about a sitemap: "none" means the site ' +
        'published none, "unreachable" means it would not answer and absence is NOT established.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The site to list, e.g. "https://example.com".' },
          crawlOnly: {
            type: 'boolean',
            description: 'Skip the sitemap and crawl links instead. Only when the sitemap is known to be wrong.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      isWrite: false,
      isDelete: false,
      isDestructive: false,
    } as ToolDef,
    {
      name: SITE_SCAN_TRIGGERS,
      description:
        'Open a public website in a real browser and read what is actually on its pages: forms (with ' +
        'the provider detected), buttons and CTAs, mailto:/tel: links, downloads, outbound links and ' +
        'embedded video. Returns, for each thing worth tracking, the GA4 event and the EXACT GTM ' +
        'trigger conditions to fire it on, chosen from the real id, class, href or text on the page, ' +
        'plus ready-to-send arguments for create_gtm_tracking_tag. ' +
        'USE THIS BEFORE BUILDING ANY CLICK OR FORM TRIGGER FOR A SITE YOU HAVE NOT READ. A trigger ' +
        'built on a guessed class or form id is accepted by GTM, looks correct, and never fires. ' +
        'It scans the live public site, not the GTM container, so it needs no Google access and ' +
        'changes nothing. Keep the page count small; it opens a browser per page.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The site or page to scan, e.g. "https://example.com".' },
          pages: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Scan exactly these page URLs and do not crawl. Use the ones the user chose, or ones ' +
              `${SITE_PAGES_LIST} returned. Maximum ${CHAT_MAX_PAGES}.`,
          },
          maxPages: {
            type: 'number',
            description: `How many pages to crawl when \`pages\` is not given. Default ${CHAT_DEFAULT_PAGES}, maximum ${CHAT_MAX_PAGES}.`,
          },
          skipBlog: {
            type: 'boolean',
            description: 'Do not spend the page budget on blog, news and article paths.',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      isWrite: false,
      isDelete: false,
      isDestructive: false,
    } as ToolDef,
  ];
}

/** One suggestion, reduced to what a chat turn can act on. */
export interface ChatSuggestion {
  id: string;
  page: string;
  what: string;
  evidence: string;
  confidence: string;
  /** GA4 Enhanced Measurement already collects this, so creating a tag would double-count. */
  alreadyAutoTracked?: boolean;
  trigger: {
    name: string;
    gtmType: string;
    conditions: Array<{ variable: string; operator: string; value: string }>;
    /**
     * Conditions the engine chose that create_gtm_tracking_tag cannot carry.
     *
     * Present only when there are some, and the model is told to mention them: the tag is created
     * without them, and the trigger is then WIDER than the one described here.
     */
    droppedOnCreate?: Array<{ variable: string; operator: string; value: string }>;
  };
  /** What must be true on the site itself before this trigger can ever fire. */
  siteSetup?: {
    summary: string;
    firesAsIs: boolean;
    listenerTagAvailable: boolean;
    needsDeveloper: boolean;
  };
  note?: string;
  /**
   * Event parameters the engine wanted that were left out of createWith.args.
   *
   * Each of these reads a companion Lookup Table variable the engine would create alongside the tag.
   * Nothing in this chat can create one: create_gtm_variable_typed builds constants, dataLayer,
   * Custom JavaScript and the two server kinds, not a lookup table. A tag shipped with the reference
   * anyway is accepted by GTM and records the parameter BLANK, which is the failure that looks most
   * like success. So the parameter is dropped and named here instead.
   */
  omittedParameters?: Array<{ name: string; wouldRead: string }>;
  /** Ready to send, minus the ids and confirm. Null when this tool cannot build that platform. */
  createWith: { tool: string; args: Record<string, unknown> } | null;
  cannotCreate?: string;
}

/** Platforms create_gtm_tracking_tag will actually build. Anything else is refused by that tool. */
const CREATABLE = new Set(['ga4_event', 'google_tag', 'custom_html']);

/**
 * Turn one engine suggestion into the compact, creatable form.
 *
 * PURE, so the mapping is testable without a browser. The single most important line here is the
 * `carried === false` split: those conditions are shown, and shown separately, because a create
 * that drops them produces a trigger that fires on everything.
 */
export function toChatSuggestion(raw: Record<string, unknown>, index: number): ChatSuggestion {
  const trigger = (raw.trigger ?? {}) as Record<string, unknown>;
  const all = triggerConditions(trigger);
  const kept = all.filter((c) => c.carried).map((c) => ({ variable: c.variable, operator: c.operator, value: c.value }));
  const dropped = all.filter((c) => !c.carried).map((c) => ({ variable: c.variable, operator: c.operator, value: c.value }));

  const platform = String(raw.platform ?? 'ga4_event');
  const install = installSummary(raw.install);
  const { kept: params, omitted } = splitEventParameters(raw);

  // Everything create_gtm_tracking_tag reads, and nothing else. Built by copying the engine's own
  // trigger object rather than re-deriving it: re-deriving is how an operator gets swapped for a
  // plausible one and a word-boundary regex quietly becomes a `contains`.
  const args: Record<string, unknown> = {
    tagName: String(raw.tagName ?? ''),
    platform,
    ...(raw.measurementId ? { measurementId: raw.measurementId } : {}),
    ...(raw.tagId ? { tagId: raw.tagId } : {}),
    ...(raw.configSettings ? { configSettings: raw.configSettings } : {}),
    ...(raw.eventName ? { eventName: raw.eventName } : {}),
    ...(params.length ? { eventParameters: params } : {}),
    trigger: creatableTrigger(trigger),
  };

  return {
    id: String(raw.id ?? `s${index + 1}`),
    page: String(raw.page ?? ''),
    what: short(String(raw.label ?? raw.tagName ?? 'Untitled suggestion')),
    evidence: short(String(raw.evidence ?? '')),
    confidence: String(raw.confidence ?? 'medium'),
    ...(raw.enhancedMeasurementOverlap === true ? { alreadyAutoTracked: true } : {}),
    trigger: {
      name: String(trigger.name ?? ''),
      gtmType: gtmTriggerType(trigger.kind ?? trigger.type) ?? 'unknown',
      conditions: kept,
      ...(dropped.length ? { droppedOnCreate: dropped } : {}),
    },
    ...(install
      ? {
          siteSetup: {
            summary: short(install.summary),
            firesAsIs: install.firesAsIs,
            listenerTagAvailable: install.listenerAvailable,
            needsDeveloper: install.needsSiteCode,
          },
        }
      : {}),
    ...(raw.note ? { note: short(String(raw.note), 300) } : {}),
    ...(omitted.length ? { omittedParameters: omitted } : {}),
    ...(CREATABLE.has(platform)
      ? { createWith: { tool: 'create_gtm_tracking_tag', args } }
      : {
          createWith: null,
          cannotCreate:
            `This is a ${platform} tag. create_gtm_tracking_tag builds GA4, Google tag and Custom HTML ` +
            'tags only, so it cannot be created from this chat. Say so rather than building it as GA4: ' +
            "that would produce a GA4 tag pointing at another platform's id.",
        }),
  };
}

/**
 * Separate the event parameters that will WORK from the ones that would arrive blank.
 *
 * The engine can pair a parameter with a companion Lookup Table variable, so one multi-page form tag
 * records a different form name per page. That pairing is only true if something creates the lookup
 * variable, and on this path nothing does. GTM accepts `{{Lookup - X Form Name}}` whether or not the
 * variable exists, and an absent one resolves to nothing, so the tag reports the parameter empty
 * and looks entirely correct in the interface.
 *
 * PURE. Reads eventParamLookups to know which references are the engine's own inventions; a
 * reference to anything else is left alone, because the model is separately required to confirm a
 * variable exists before writing it.
 */
export function splitEventParameters(raw: Record<string, unknown>): {
  kept: Array<{ name: string; value: string }>;
  omitted: Array<{ name: string; wouldRead: string }>;
} {
  const params = Array.isArray(raw.eventParameters)
    ? (raw.eventParameters as Array<{ name?: unknown; value?: unknown }>)
    : [];
  const lookups = Array.isArray(raw.eventParamLookups)
    ? (raw.eventParamLookups as Array<{ variableName?: unknown }>)
    : [];
  const uncreatable = new Set(
    lookups.map((l) => String(l.variableName ?? '').trim()).filter(Boolean),
  );

  const kept: Array<{ name: string; value: string }> = [];
  const omitted: Array<{ name: string; wouldRead: string }> = [];
  for (const p of params) {
    const name = String(p.name ?? '').trim();
    const value = String(p.value ?? '');
    if (!name) continue;
    const referenced = [...value.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
    const missing = referenced.find((r) => uncreatable.has(r));
    if (missing) omitted.push({ name, wouldRead: `{{${missing}}}` });
    else kept.push({ name, value });
  }
  return { kept, omitted };
}

/**
 * The trigger fields create_gtm_tracking_tag declares, copied straight through.
 *
 * An allowlist rather than a spread, because the engine's trigger object also carries lookupTable
 * and dataLayerConditions, which that tool's schema does not declare and zod silently strips. Sending
 * them anyway would put fields in the model's context that look like they will be applied and will
 * not, and the resulting trigger is wider than the one the model just described to the user.
 */
function creatableTrigger(trigger: Record<string, unknown>): Record<string, unknown> {
  const FIELDS = [
    'name', 'clickUrlValue', 'clickUrlOperator', 'clickUrlIgnoreCase',
    'clickTextValue', 'clickTextOperator', 'clickTextIgnoreCase',
    'clickElementValue', 'clickElementOperator', 'clickIdValue', 'clickIdOperator',
    'clickClassesValue', 'clickClassesOperator', 'pagePathValue', 'pagePathOperator',
    'pageUrlValue', 'pageUrlOperator', 'eventName', 'formIdValue', 'formIdOperator',
    'formClassesValue', 'formClassesOperator', 'intervalMs', 'limit',
  ];
  const out: Record<string, unknown> = {};
  // `kind` is the field name that tool's schema uses; the engine writes `kind` too, but a payload
  // that ever arrives with `type` instead must not lose its trigger type.
  const kind = trigger.kind ?? trigger.type;
  if (kind) out.kind = String(kind);
  for (const f of FIELDS) {
    const v = trigger[f];
    if (v !== undefined && v !== null && v !== '') out[f] = v;
  }
  return out;
}

/**
 * Order the list so the useful rows survive the cap.
 *
 * Anything GA4 already collects by itself sinks: creating a tag for it is a double count, so it is
 * the first thing worth losing when only 25 rows fit. Otherwise the engine's own ranking is kept,
 * which is why this is a stable sort on two keys rather than a re-score.
 */
export function rankSuggestions(list: readonly ChatSuggestion[]): ChatSuggestion[] {
  const rank = (s: ChatSuggestion): number =>
    (s.alreadyAutoTracked ? 2 : 0) + ({ high: 0, medium: 1, low: 1 }[s.confidence] ?? 1);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/**
 * As many suggestions as fit, best first, and an honest count of what did not.
 *
 * Rows are added whole. A row half in and half out is worse than a row left out: the model reads a
 * trigger with three conditions where the page said four, and builds it.
 */
function pack(all: readonly ChatSuggestion[], budgetChars: number): ChatSuggestion[] {
  const shown: ChatSuggestion[] = [];
  let used = 0;
  for (const s of all.slice(0, MAX_SUGGESTIONS_RETURNED)) {
    const size = JSON.stringify(s).length + 1;
    // The first row always goes in, however big: returning zero suggestions from a scan that found
    // some would read as "nothing worth tracking here", which is a different and wrong answer.
    if (shown.length > 0 && used + size > budgetChars) break;
    shown.push(s);
    used += size;
  }
  return shown;
}

/** The whole result of a chat scan, ready to be JSON-stringified into a tool message. */
export function toChatScanResult(
  result: ScanResult,
  budgetChars: number = DEFAULT_RESULT_BUDGET_CHARS,
): Record<string, unknown> {
  const all = rankSuggestions(result.suggestions.map((s, i) => toChatSuggestion(s, i)));
  const shown = pack(all, budgetChars);

  return {
    site: result.site,
    pagesScanned: result.scanned ?? result.pages?.length ?? 0,
    pagesRead: (result.pages ?? []).map((p) => p.page).slice(0, MAX_PAGES_LISTED),
    suggestionsFound: all.length,
    suggestionsReturned: shown.length,
    ...(all.length > shown.length
      ? {
          truncated:
            `${all.length - shown.length} further suggestion(s) were found and are NOT in this list; ` +
            'the ones here are the highest-confidence, with anything GA4 already collects by itself ' +
            'ranked last. Say the list is partial, and scan fewer pages or ask the user which area to ' +
            'focus on rather than presenting these as everything on the site.',
        }
      : {}),
    suggestions: shown,
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
    ...(result.notScanned?.length
      ? { notScanned: result.notScanned.slice(0, 20) }
      : {}),
    howToUse:
      'Each suggestion carries the trigger conditions read from the page. Do NOT rewrite them: the ' +
      'operators are chosen deliberately (a word-boundary matchRegex on {{Click Classes}}, a CSS ' +
      'selector on {{Click Element}} so a click on an inner icon still counts). To build one, call ' +
      'create_gtm_tracking_tag with createWith.args plus accountId, containerId, workspaceId and ' +
      'confirm: true. Where trigger.droppedOnCreate is present, those conditions will NOT be applied ' +
      'and the trigger will be wider than described; tell the user before creating it. Where ' +
      'omittedParameters is present, those event parameters were left out because they would read a ' +
      'Lookup Table variable nothing here can create, and including them would record blanks. Where ' +
      'siteSetup.needsDeveloper is true, the tag is correct but silent until someone adds the site ' +
      'code, so say that rather than reporting it as working.',
  };
}

/** What a page listing returns. Kept flat, because the model reads it to ask the user to choose. */
export function toChatPagesResult(
  result: { site: string; pages: { url: string; source: string }[]; total: number; sitemapStatus: string; viaCrawl: boolean; note?: string },
): Record<string, unknown> {
  const urls = result.pages.map((p) => p.url);
  return {
    site: result.site,
    total: result.total,
    sitemapStatus: result.sitemapStatus,
    foundVia: result.viaCrawl ? 'link crawl' : 'sitemap',
    pages: urls.slice(0, MAX_PAGES_LISTED),
    ...(urls.length > MAX_PAGES_LISTED
      ? { truncated: `${urls.length - MAX_PAGES_LISTED} more page(s) were found but are not listed here.` }
      : {}),
    ...(result.note ? { note: result.note } : {}),
    nextStep:
      `Ask the user which pages matter, then call ${SITE_SCAN_TRIGGERS} with those exact URLs in ` +
      '`pages`. Do not scan everything: each page opens a browser.',
  };
}

/** Clamp a requested page count into what a chat turn can afford, without silently accepting more. */
export function clampPages(requested: unknown): number {
  const n = Math.trunc(Number(requested));
  if (!Number.isFinite(n) || n <= 0) return CHAT_DEFAULT_PAGES;
  return Math.min(n, CHAT_MAX_PAGES);
}

export interface SiteToolOutcome {
  ok: boolean;
  text: string;
}

/**
 * Run one site tool and return the text that becomes the tool message.
 *
 * Every failure path returns a SENTENCE, not a stack: the model relays this to the user, and
 * "scanner_unavailable" tells them nothing they can act on. A failure that the user can fix (the
 * scanner is not built, the site would not answer, the scan overran) says what to do instead.
 */
export async function runSiteTool(
  scanner: SiteScanner,
  name: string,
  args: Record<string, unknown>,
  /**
   * The caller's own tool-result cap, so the packing here and the truncation downstream agree.
   *
   * Ten percent is left spare. capToolResult counts the whole message, and the envelope around the
   * suggestions (the site, the page list, the warnings, the usage note) is not free.
   */
  resultCapChars?: number,
): Promise<SiteToolOutcome> {
  const url = String(args.url ?? '').trim();
  if (!url) {
    return { ok: false, text: 'No url was given. Ask the user which website to look at.' };
  }

  try {
    if (name === SITE_PAGES_LIST) {
      const result = await scanner.discover(url, {
        ...(args.crawlOnly === true ? { crawlOnly: true } : {}),
        timeoutMs: CHAT_DISCOVER_TIMEOUT_MS,
      });
      return { ok: true, text: JSON.stringify(toChatPagesResult(result)) };
    }

    // A chosen page list is honoured as given, but still capped: the cap exists because of the turn
    // budget, and a list of 80 URLs spends it just as surely as a crawl of 80 pages would.
    const chosen = Array.isArray(args.pages)
      ? args.pages.map(String).filter((p) => p.trim()).slice(0, CHAT_MAX_PAGES)
      : [];
    const requestedPages = Array.isArray(args.pages) ? args.pages.length : 0;

    const result = await scanner.scan(url, {
      ...(chosen.length ? { pages: chosen } : { maxPages: clampPages(args.maxPages) }),
      ...(args.skipBlog === true ? { skipBlog: true } : {}),
      timeoutMs: CHAT_SCAN_TIMEOUT_MS,
    });

    const budget = Number.isFinite(resultCapChars) && (resultCapChars as number) > 0
      ? Math.floor((resultCapChars as number) * 0.9)
      : DEFAULT_RESULT_BUDGET_CHARS;
    const body = toChatScanResult(result, budget);
    if (requestedPages > chosen.length) {
      body.pagesDropped =
        `${requestedPages - chosen.length} of the ${requestedPages} pages asked for were NOT scanned: a ` +
        `chat scan opens at most ${CHAT_MAX_PAGES}. Say so, and point the user at the Tag suggestions ` +
        'page for a larger scan.';
    }
    return { ok: true, text: JSON.stringify(body) };
  } catch (err) {
    if (err instanceof DeadlineError) {
      return {
        ok: false,
        text:
          'The scan ran past the time a chat turn allows and was stopped, so nothing was read. Do not ' +
          'retry it with the same page count. Scan fewer pages, or tell the user the Tag suggestions ' +
          'page can run a larger scan without this limit.',
      };
    }
    if (err instanceof ScanError) return { ok: false, text: err.message };
    return {
      ok: false,
      text: `The site could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
