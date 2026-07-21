import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import type { GoogleAdsService } from '../google/ads-service';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { AuditHistoryStore } from '../storage/audit-history';
import type { ManifestStore } from '../storage/manifest-store';
import type { MemoryStore } from '../storage/memory-store';
import { selectRelevantMemories, formatMemoriesForPrompt, creditMemoryUse, type Memory, type MemoryProvenance } from '../../shared/chat-memory';
import { containerKindFromUsageContext, type ContainerKind } from '../../shared/tool-scope';
import { gtmPromptSections } from '../../shared/gtm-prompt-sections';
import { boundChatHistory } from '../../shared/context-budget';
import { AUDIT_POINTER } from '../../shared/jit-reference';
import { MEMORY_EXTRACT_SYSTEM, buildExtractionTranscript, parseMemoryCandidates, type MemoryCandidate } from '../../shared/memory-extract';
import { buildToolRegistry } from '../tools/registry';
import type { ConfirmFn } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import { ToolMemoryStore, formatToolMemory } from '../llm/tool-memory';
import { changeJournal } from '../google/change-journal';
import type { ChatMediaPart, ChatReply, ChatStreamEvent, ChatToolCall, ChatTurn, GoogleProduct, GtmContext } from '../../shared/ipc';
import type { LlmTurn } from '../llm/types';
// Shared GA4/GTM creation methodology — the SAME rules the tag-suggestion engine + AI scan follow,
// so chat tag creation stays consistent with what the audit/suggestion surfaces propose. Re-exported
// so the chat-prompt test can assert it is composed into the system prompt.
import { GTM_CREATION_METHODOLOGY, GTM_TRIGGER_VARIABLE_REFERENCE, GTM_DECISION_RULES } from '../../shared/gtm-methodology';
export { GTM_CREATION_METHODOLOGY, GTM_TRIGGER_VARIABLE_REFERENCE, GTM_DECISION_RULES };

/**
 * The "GTM Audit Brain" — an evidence-based, deterministic methodology the model must
 * follow when auditing a container, so audits return findings (not opinions) and never
 * lead with cosmetics or invent runtime verdicts. Exported so it's testable / reusable.
 */
/**
 * Corpus retrieval guidance. The pattern library ships inside the app, so this holds on every install.
 * Written to buy grounding WITHOUT buying false authority: frequency across past containers is evidence
 * of house convention, never evidence of correctness, and never a substitute for reading the live one.
 */
export const CORPUS_PROMPT =
  'HOUSE PATTERNS: lookup_corpus_patterns searches an anonymized library of how tags, triggers and variables were ' +
  'actually built across the operator\'s own past GTM containers. Call it BEFORE proposing an event name, a naming ' +
  'convention, a trigger shape, or a vendor setup, and whenever asked what is typical or standard. Cite the real ' +
  'count it returns ("128 of 561 containers"), never a vague "commonly". These counts describe past work only: they ' +
  'are not industry benchmarks, not proof a pattern is correct, and never a reading of the CURRENT container - read ' +
  'that with the GTM tools. If the library has no match, say so instead of inventing a frequency. ';

// The audit brain is now delivered in TWO parts: this pointer (rule 1, which must arrive before the
// model decides to audit) stays in every GTM prompt, and the reporting methodology (rules 2-11) rides
// on the audit tool RESULT, where the findings it governs actually are. Re-exported under the old
// name so the prompt tests and any other consumer keep working.
export const GTM_AUDIT_METHODOLOGY = AUDIT_POINTER;

/** Naming convention for GA4 tags/triggers the chat creates. Exported for testing. */
export const GA4_TAG_NAMING =
  'GA4 TAG NAMING — unless the user gives an explicit name, name every GA4 event tag you create "GA4 - Event - <Name>[ Click| Form] Tag" and its trigger "<Name>[ Click| Form] Trigger", where <Name> is the event in Title Case and the optional kind word reflects the TRIGGER: "Click" when the tag fires on a click trigger (link_click / all_clicks), "Form" when it fires on a form_submit trigger, and OMIT the word for any other trigger (a Custom Event / dataLayer event such as ecommerce, a pageview, a timer, etc.). Never double the kind word when <Name> already ends in it ("Newsletter Form" → "GA4 - Event - Newsletter Form Tag", not "... Form Form Tag"; "Email Click" → "GA4 - Event - Email Click Tag"). Examples: a "Book a Demo" button click → tag "GA4 - Event - Book A Demo Click Tag" + trigger "Book A Demo Click Trigger"; a newsletter form submit → "GA4 - Event - Newsletter Form Tag" + "Newsletter Form Trigger"; a Custom Event ecommerce add_to_cart → "GA4 - Event - Add To Cart Tag" + "Add To Cart Trigger"; purchase → "GA4 - Event - Purchase Tag" + "Purchase Trigger". Apply this to ALL GA4 tags/triggers you create. CRITICAL — a Custom Event trigger has TWO different fields: its display NAME (e.g. "Purchase Trigger") and its EVENT NAME (the dataLayer value it matches). The EVENT NAME must be the raw event in snake_case exactly as the dataLayer pushes it (purchase, add_to_cart, view_item, begin_checkout, generate_lead, file_download) — NEVER a display label like "Purchase Trigger" or "GA4 - Purchase" (the dataLayer never pushes that, so the trigger would never fire). Use snake_case underscore_words for the event name; the "GA4 - Event - " / "<Name>" formatting is the display name only. ';

/** GA4 ecommerce events → their event parameters (from the GA4 Ecommerce GTM reference),
 *  so the chat builds the matching tag for whatever ecommerce event the user asks for. */
export const GA4_ECOMMERCE_REFERENCE =
  'GA4 ECOMMERCE (GTM) — when the user asks for a standard GA4 ecommerce event tag, build it from this reference: a GA4 Event tag whose event parameters each read a Data Layer Variable on the dataLayer "ecommerce" object, PLUS a Custom Event trigger whose Event Name is the event and that fires on All Custom Events. Each parameter P takes value {{Ecommerce <P>}} read from data-layer key ecommerce.P — create those variables with create_gtm_variable_typed (kind data_layer, dataLayerName ecommerce.P) if they are missing, then reference them. EVENT → PARAMETERS: ' +
  'view_item_list, select_item → items, item_list_id, item_list_name. ' +
  'view_item, add_to_cart, add_to_wishlist, view_cart, remove_from_cart → items, value, currency. ' +
  'begin_checkout → items, value, currency, coupon. ' +
  'add_shipping_info → items, value, currency, coupon, shipping_tier. ' +
  'add_payment_info → items, value, currency, coupon, payment_type. ' +
  'purchase, refund → items, transaction_id, value, tax, shipping, currency, coupon. ' +
  'view_promotion, select_promotion → creative_name, creative_slot, promotion_id, promotion_name, items. ' +
  '(items always maps to {{Ecommerce Items}} / ecommerce.items.) MATCH the user\'s requested event to its row — e.g. "add to cart" → add_to_cart with items+value+currency; "checkout" → begin_checkout with items+value+currency+coupon; "purchase" → purchase with items+transaction_id+value+tax+shipping+currency+coupon. Use the same parameter set for the matching event; do not invent parameters not listed for that event. ';

/** Evidence-based GA4 PROPERTY AUDIT framework — appended to the GA4 system prompt so a
 *  "property audit" produces the same structured, chart-ready, non-templated-prose output on any
 *  model (a faithful condensation of the GA4 Property Audit Brain). Exported for testing. */
/** GA4 write guidance — used only when the GA4 chat has a confirm fn (writes enabled). */
export const GA4_WRITE_GUIDANCE =
  'GA4 WRITES ARE ENABLED — you CAN modify GA4 Admin configuration, not just read it. Available: create/update/delete key events; create/update + ARCHIVE custom dimensions and custom metrics (they have NO hard delete — archive is permanent); create/update/delete data streams, Measurement Protocol secrets, Google Ads links, Firebase links, channel groups, calculated metrics, event-create rules, Display&Video360 / Search Ads 360 / AdSense links, expanded data sets + subproperty filters + rollup source links (360); create/update + ARCHIVE audiences; create/update/delete property and account ACCESS BINDINGS (user permissions); create/update/soft-delete PROPERTIES; update data retention; rename accounts and soft-delete accounts. ' +
  'IMPORTANT DIFFERENCES FROM GTM: GA4 changes apply DIRECTLY to the LIVE property — there is no draft/publish step. So state plainly WHAT you are about to change BEFORE calling the tool, then report exactly what changed after. Creates and updates apply with no approval card; DELETES and ARCHIVES show a two-step approval card (archive/soft-delete is effectively permanent). ' +
  'TO UPDATE / DELETE / ARCHIVE you need the resource\'s FULL name (e.g. "properties/123/keyEvents/456") — call the matching list_ga4_* tool FIRST to get the id, never guess it. Use ARCHIVE (not delete) for custom dimensions, custom metrics, and audiences; use DELETE for key events, data streams, links, MP secrets, and access bindings. ' +
  'ACCESS BINDINGS change who can access the account/property — double-check the exact email and roles (predefinedRoles/viewer|analyst|editor|admin, or predefinedRoles/read) before granting or revoking, and confirm intent with the user first. PROPERTY/ACCOUNT delete is a soft-delete (trash, recoverable for a limited time) but high blast radius — a deleted account takes ALL its properties. For nested/advanced fields not exposed as flat arguments (audience filterClauses, channel groupingRule, event-rule conditions, DV360/SA360 settings), pass a `body` object. Never claim GA4 is read-only or that a change must be made in the GA4 UI when a matching tool exists — call the tool. ';

export const GA4_PROPERTY_AUDIT =
  'GA4 PROPERTY AUDIT — when the user asks to "audit" / "property audit" / "full audit" / review / health-check this GA4 property, run this structured, evidence-based audit (ONE property at a time; never carry assumptions between properties):\n' +
  '1) GATHER REAL VALUES FIRST, before writing any finding: call audit_ga4_property and audit_ga4_data_quality, PLUS get_ga4_data_retention, get_ga4_property_details, get_ga4_google_signals, get_ga4_attribution_settings, get_ga4_enhanced_measurement, list_ga4_key_events, list_ga4_custom_dimensions, list_ga4_custom_metrics, list_ga4_audiences, list_ga4_google_ads_links, list_ga4_bigquery_links, list_ga4_firebase_links, and run_ga4_report over ~90 days WITH a comparison (channel mix, top pages, key-event trend, new vs returning, device). Check the data-retention window first and never run a trend longer than retention. ' +
  '2) EVIDENCE RULES: every finding carries a REAL number or exact config value from THIS property — no generic statements ("events look fine"). If a tool cannot verify something, mark it "Not Verified" (its own state) — never assume a pass or a fail. Separate observed from inferred (label inferences). Rank by impact on decisions/spend, not ease of fix. State data limitations (retention, sampling, thresholding, Google Signals on). ' +
  '3) FIXED WORDS ONLY: area status is exactly one of Pass / Partial / Fail / Not Verified; finding confidence is exactly one of Certain / Likely / Guessing, tied to the evidence. Do NOT invent maturity scores or confidence percentages. ' +
  '4) SEVERITY: Critical (data wrong/missing in a way that misleads decisions or spend, PII, a collection gap) → High → Medium → Low; hygiene is listed LAST and never reported as a data/legal issue. Add to EVERY finding: who is affected (marketing/finance/leadership/product/paid media), the decision or number that becomes unreliable, and an estimated data-loss %. ' +
  '5) CHARTS: render every percentage (parameter coverage, data loss, channel share) as a Unicode bar — filled blocks = round(value/5) out of 20, full block "█" for filled + light "░" for empty, the number printed after the bar — AND include the raw JSON data block behind it (e.g. {"chart":"parameter_coverage","event":"purchase","series":[{"param":"value","pct":100}]}). Never show a chart without the number and the data block. ' +
  '6) DECISION READINESS: for the key business questions (which campaigns generate revenue; abandonment by product/page; CAC by channel; lead quality; LTV; refund/return rate; repeat/churn within 90 days) mark each Answerable / Partial / Not answerable with the data required, then list what the property CANNOT measure at all and the missing input (e.g. LTV — no User-ID/server data). ' +
  '7) OUTPUT this fixed template, with NO free-form prose outside it: header (property + id, date window + comparison + retention, access level, data limitations) -> Executive summary -> Area-status table (Collection, Configuration, Events, Custom definitions, Ecommerce, Attribution, Audiences, Integrations, Consent, Identity, Marketing readiness, Reporting; each = Status + Confidence + evidence note) -> Property baseline (trend vs comparison, peak/low day, channel-mix shift, new vs returning, device split, geo flags) -> Decision-readiness table -> Parameter coverage (Unicode bars + JSON) -> Funnel if ecommerce is in scope (mark missing steps MISSING) -> Findings sorted by severity (each: evidence, observed-vs-inferred, cause + cause-confidence, business risk, data-loss bar + reports affected, fix) -> Not Verified list -> summary counts (Critical/High/Medium/Low + top 3 to fix). Only if the user demands a single headline number, compute it by rule (Pass=2, Partial=1, Fail=0 over SCORED areas only; score = points / (2 x scored areas) x 100, rounded) and ALWAYS print the count of Not Verified areas beside it; otherwise omit it. ';

/** Guidance for "when did data last arrive / when was the last active session" freshness questions, so
 *  the model finds the ACTUAL last active date instead of stopping at an empty 28-day aggregate and
 *  over-alarming. Composed into the GA4 system prompt. Exported for testing. */
export const GA4_DATA_FRESHNESS =
  'DATA FRESHNESS / "WHEN WAS THE LAST …" — when the user asks WHEN data was last recorded, when the last active session / user / event was, whether data is STILL coming in, or "did tracking stop / when did it break", you MUST answer with a SPECIFIC DATE — never stop at a single empty 28-day aggregate and never conclude "no data" from that alone. Do this: ' +
  '(1) FIND THE LAST ACTIVE DAY: call run_ga4_report with dimensions ["date"] and metrics ["sessions","activeUsers","eventCount"], endDate "today" and startDate as far back as the data allows — up to "365daysAgo", but NEVER earlier than the property\'s data-retention window (call get_ga4_data_retention first; a standard property keeps only 2 or 14 months of this data). Read the returned daily rows and report the MOST RECENT date whose metric is > 0 as the last active day, plus how many days ago that was. If EVERY day in the retention window is 0, say data appears to have stopped before <window start> (older than retention — the exact date is unknowable). ' +
  '(2) REAL-TIME IS ONLY THE LAST 30 MINUTES: run_ga4_realtime_report shows current activity only — "0 active users right now" is NORMAL for a low-traffic site, off-hours, or a quiet moment, and is NOT evidence that data stopped. NEVER present an empty realtime result as "no data" or a collection problem; use step 1 for recency. ' +
  '(3) INTERPRET HONESTLY, DO NOT OVER-ALARM: if the last active day is today or yesterday, data is flowing — say so plainly (allow for the normal 1–2 day processing lag on the most recent days). If it is several+ days ago after a healthy history, state that data appears to have stopped around <that date> and that a collection break is POSSIBLE (confidence Likely, runtime-required) — recommend confirming in GA4 DebugView / that the GA4 tag still fires — but do NOT assert "critical, tagging is broken" as fact from reporting numbers alone. Lead with the DATE and the plain finding first; the caveat and any fix come after. ';

/**
 * A system-prompt line telling the model the ACTUAL current date. Without this
 * the model assumes its training-cutoff date (e.g. "October 2023"), which breaks
 * all date reasoning: it mis-years relative dates like "May 1", rejects valid
 * recent dates as "in the future", and answers "what's today" wrong. Pure +
 * exported so it's unit-testable.
 */
export function dateContextLine(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const human = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return (
    `CURRENT DATE: today is ${human} (${iso}). Treat this as "today" for ALL date reasoning and ` +
    `IGNORE any date from your training data. Resolve relative dates ("yesterday", "last month", ` +
    `"May 1", "last 28 days") against this date — e.g. a bare "May 1" means the most recent past May 1. ` +
    `Dates up to today are historical (queryable); only dates AFTER today are "in the future". `
  );
}

// Ties the active account (provider + model + vaulted key) to the LLM gateway and
// the read-only GTM/GA4 tool registry. The model can call tools, which run as the
// active account against Google, to answer questions about that account's setup.
/** House style: no em or en dashes in anything the user sees. Applied to BOTH the streamed deltas and
 *  the final persisted text, from one definition, so the two can never disagree. The same pair is what
 *  the repo's export-boundary tests assert on, and the rule is about what a USER sees, not about source
 *  comments (which carry plenty of them).
 *
 *  The class is [U+2014 EM DASH, U+2013 EN DASH]. Both are single UTF-16 code units, so a streamed
 *  delta can never split one across chunks and a per-chunk replace is safe. */
const stripDashes = (v: string): string => v.replace(/[—–]/g, '-');

export class ChatService {
  constructor(
    private readonly registry: RegistryService,
    private readonly data: GoogleDataService,
    private readonly providerKeys: ProviderKeyStore,
    private readonly history?: AuditHistoryStore,
    /** Called after a chat tool switches the active GTM context, so the UI refreshes. */
    private readonly notifyContextChanged?: () => void,
    /** Records what setup tools create, so re-runs are safe and drift is detectable. */
    private readonly manifests?: ManifestStore,
    /** Per-account "remember what I told you" notes, injected into the system prompt each turn. */
    private readonly memory?: MemoryStore,
    /** Google Ads. Optional: without it the GTM chat simply has no Ads tools, so it falls back to
     *  asking the user for a Conversion ID and Label instead of reading them. */
    private readonly ads?: GoogleAdsService
  ) {}

  /** Bounded, in-memory carry-over of each thread's most recent READ tool results, so a follow-up
   *  question ("how many of those are Ads tags?") is answered from the list already fetched instead
   *  of re-calling the tool. See tool-memory.ts for the bound and the reasoning. */
  private readonly toolMemory = new ToolMemoryStore();
  /** accountId -> containerId -> kind. A container never changes kind, so one list call per account
   *  per session is enough to keep every later turn's tool payload trimmed. */
  private readonly containerKinds = new Map<string, Map<string, ContainerKind | undefined>>();

  /**
   * The active container's kind, for scoping the tool list. Cached per account and BEST-EFFORT: any
   * failure (auth expired, offline, a container we cannot see) resolves to undefined, which sends the
   * full tool list. Never let a size optimization break a turn.
   */
  private async activeContainerKind(accountId?: string, containerId?: string): Promise<ContainerKind | undefined> {
    if (!accountId || !containerId) return undefined;
    let byContainer = this.containerKinds.get(accountId);
    if (!byContainer) {
      try {
        const containers = await this.data.listGtmContainers(accountId);
        byContainer = new Map(containers.map((c) => [c.containerId, containerKindFromUsageContext(c.usageContext)]));
        this.containerKinds.set(accountId, byContainer);
      } catch (e) {
        console.error('[chat] container-kind lookup failed, sending the full tool list:', e instanceof Error ? e.message : e);
        return undefined;
      }
    }
    return byContainer.get(containerId);
  }

  /** Thread identity for the tool-result carry-over: the same account + product + working-client
   *  scoping the renderer uses to key a conversation, so one container's results never leak into
   *  another container's chat. */
  private threadKey(active: { id: string; gtmContext?: GtmContext; ga4Context?: { property?: string } }, product: GoogleProduct): string {
    const scope = product === 'gtm' ? active.gtmContext?.containerId : active.ga4Context?.property;
    return `${active.id}|${product}|${scope ?? 'na'}`;
  }

  /** The REMEMBERED-CONTEXT block for this turn: the account's memories scoped to the active client
   *  (GTM container / GA4 property) and ranked against the message. Empty when there are none.
   *  PRODUCT-GATED: a container-scoped memory only applies in a GTM turn and a property-scoped one only in a
   *  GA4 turn (gtmContext / ga4Context are independent per-account fields, so the inactive product's context
   *  can be stale and point at a DIFFERENT client — using it would leak one client's notes into another's chat). */
  private memoryBlock(active: { id: string; gtmContext?: GtmContext; ga4Context?: { property?: string } }, product: GoogleProduct, message: string): { block: string; used: Memory[] } {
    if (!this.memory) return { block: '', used: [] };
    const all = this.memory.list(active.id);
    if (!all.length) return { block: '', used: [] };
    const ctx = {
      containerId: product === 'gtm' ? active.gtmContext?.containerId : undefined,
      property: product === 'ga4' ? active.ga4Context?.property : undefined,
    };
    const used = selectRelevantMemories(all, ctx, message);
    return { block: formatMemoriesForPrompt(used), used };
  }

  /** Non-streaming: returns the final reply only. */
  chat(history: ChatTurn[], message: string, product: GoogleProduct, media?: ChatMediaPart[]): Promise<ChatReply> {
    return this.run(history, message, product, undefined, undefined, undefined, media);
  }

  /**
   * Streaming: `emit` fires for text chunks + tool calls; resolves with the final
   * reply. `product` scopes the available tools to GTM or GA4. When `confirm` is
   * provided (GTM only), write tools become available and each calls `confirm`.
   */
  chatStream(
    history: ChatTurn[],
    message: string,
    product: GoogleProduct,
    emit: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn,
    signal?: AbortSignal,
    media?: ChatMediaPart[]
  ): Promise<ChatReply> {
    return this.run(history, message, product, emit, confirm, signal, media);
  }

  /** Phase 2b: propose durable memories from a conversation. Runs ONE plain LLM completion (no tools) with
   *  the extraction prompt, then parses/validates/redacts/dedupes the reply against what's already saved.
   *  Proposals are NOT persisted here — the renderer reviews them and the user approves each via memory:add. */
  async suggestMemories(history: ChatTurn[], signal?: AbortSignal): Promise<MemoryCandidate[]> {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect and activate a Google account.');
    if (!active.llm) throw new Error('Choose an LLM provider and model in Settings first.');
    const apiKey = this.providerKeys.getKey(active.llm.provider);
    if (!apiKey) throw new Error(`Add an API key for ${active.llm.provider} in Settings → Providers.`);
    const transcript = buildExtractionTranscript(history);
    if (!transcript.trim()) return [];
    const client = createProvider(active.llm.provider);
    const reply = await client.chatStream(
      { system: MEMORY_EXTRACT_SYSTEM, model: active.llm.model, apiKey, tools: [], messages: [{ role: 'user', text: `Conversation:\n\n${transcript}` }], signal },
      () => {},
    );
    const existing = this.memory ? this.memory.list(active.id) : [];
    return parseMemoryCandidates(reply.text ?? '', existing);
  }

  private async run(
    history: ChatTurn[],
    message: string,
    product: GoogleProduct,
    emit?: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn,
    signal?: AbortSignal,
    media?: ChatMediaPart[]
  ): Promise<ChatReply> {
    const active = this.registry.getActiveView();
    if (!active) throw new Error('No active account. Connect and activate a Google account.');
    if (!active.hasGoogleToken) throw new Error('The active account is not signed in to Google.');
    if (!active.llm) throw new Error('Choose an LLM provider and model in Settings first.');
    const apiKey = this.providerKeys.getKey(active.llm.provider);
    if (!apiKey) {
      throw new Error(`Add an API key for ${active.llm.provider} in Settings → Providers.`);
    }

    const client = createProvider(active.llm.provider);
    // GTM-only: let the model switch the active workspace/container, persisting it to the
    // account and notifying the UI so the GTM-bar dropdown follows. Mutating `active` too
    // keeps later tool calls in the same turn consistent.
    const ctxControl =
      product === 'gtm'
        ? {
            current: () => active.gtmContext,
            set: (ctx: GtmContext): void => {
              active.gtmContext = ctx;
              this.registry.setGtmContext(active.id, ctx);
              this.notifyContextChanged?.();
            },
          }
        : undefined;
    // Both products get write tools (and the confirm flow) when a confirm fn is
    // provided. GTM writes land in a draft workspace; GA4 Admin writes apply to
    // the live property (deletes/archives are approval-gated).
    // The chat memory tools (remember_memory / forget_memory) write to the LOCAL per-account store, scoped
    // to the active client (container in a GTM turn, property in a GA4 turn) — matching how memories inject.
    // Provenance ledger for this turn, keyed by memory id so a note that is BOTH injected and recalled
    // is credited (and usage-logged) exactly once. `creditMemoryUse` returns the ids it newly added.
    const usedMemories = new Map<string, MemoryProvenance>();
    // The usage log is best-effort by design: a provenance side-write must NEVER kill the chat turn
    // (a transient disk-full or AV file-lock on memory-store.json would otherwise abort the answer).
    const logUse = (ids: string[]): void => {
      if (!ids.length) return;
      try {
        this.memory?.recordUse(active.id, ids);
      } catch (e) {
        console.error('[chat] memory usage log failed (continuing):', e instanceof Error ? e.message : e);
      }
    };
    const memoryCtx = this.memory
      ? {
          store: this.memory,
          accountId: active.id,
          // A THUNK, not a snapshot: set_gtm_container can switch the active container mid-turn, and a
          // frozen scope would then recall (and file new notes under) the previous client.
          scope: (): { containerId?: string; property?: string } => ({
            ...(product === 'gtm' && active.gtmContext?.containerId ? { containerId: active.gtmContext.containerId } : {}),
            ...(product === 'ga4' && active.ga4Context?.property ? { property: active.ga4Context.property } : {}),
          }),
          // A mid-turn recall counts as provenance too: re-emit the FULL ledger (the renderer replaces
          // the list on each event) so "N memories used" covers injected + recalled.
          onRecall: (mems: Memory[]): void => {
            const added = creditMemoryUse(usedMemories, mems);
            if (!added.length) return;
            logUse(added);
            emit?.({ type: 'memories', used: [...usedMemories.values()] });
          },
        }
      : undefined;
    // Scope the SENT tool list to what the active container can actually do. Skipped entirely for a
    // GA4 turn (no GTM container in play).
    const containerKind = product === 'gtm'
      ? await this.activeContainerKind(active.gtmContext?.accountId, active.gtmContext?.containerId)
      : undefined;
    const tools = buildToolRegistry(this.data, confirm, product, this.history, ctxControl, this.manifests, memoryCtx, this.ads, containerKind);

    // Tool-result carry-over. An EMPTY history means a brand-new conversation (the user cleared the
    // thread or switched target), so nothing may carry over into it.
    const threadKey = this.threadKey(active, product);
    if (!history.length) this.toolMemory.clear(threadKey);
    const toolMemoryBlock = formatToolMemory(this.toolMemory.get(threadKey));

    // The memories injected into THIS turn — kept for provenance: streamed to the UI ("why did you say
    // that"), recorded in the usage log, and returned on the reply.
    const mem = this.memoryBlock(active, product, message);

    const productLabel = product === 'gtm' ? 'Google Tag Manager (GTM)' : 'Google Analytics 4 (GA4)';
    const system =
      `You are a ${productLabel} assistant for the Google account ${active.email}. ` +
      `Only help with ${productLabel}; if asked about the other product, say to switch the ` +
      'GTM/GA4 selector. ' +
      (product === 'gtm' && confirm
        ? 'You can read the GTM setup and create/edit tags, triggers, and variables in a DRAFT ' +
          'workspace (never published — the user publishes manually in GTM). Always work in a workspace. ' +
          'PREFER the STRUCTURED tools that build correct GTM resources from simple fields, so you ' +
          'never hand-write GTM JSON: use create_gtm_tracking_tag for any tag that fires on an event' +
          '(platform ga4_event / google_tag / google_ads_conversion / custom_html, with a trigger spec — it enables ' +
          'needed built-in variables, reuses a same-named trigger instead of duplicating, and links the ' +
          'tag, all in ONE call), and create_gtm_variable_typed for variables (constant / data_layer ' +
          '/ javascript). Only fall back to the raw create_gtm_tag/trigger/variable tools for advanced ' +
          'cases. APPROVALS ARE DELETE-ONLY: creates and edits (tags, triggers, variables, folders, …) apply ' +
          'DIRECTLY to the draft workspace with no approval card — so state clearly what you are about to ' +
          'create/change BEFORE calling the tool, and report exactly what was created/changed after. Only ' +
          'DELETE tools show an approval card (a two-step confirmation) — never promise an approval prompt ' +
          'for a create or edit. ' +
          'ALREADY-PRESENT: creating a tag/trigger/variable that already exists (same name — or, for a Custom Event trigger, the same dataLayer event) is auto-detected and REUSED — reported as "already present" with no duplicate and NO approval prompt. You can also list_gtm_tags / list_gtm_triggers / list_gtm_variables first to tell the user what already exists. ' +
          'EDITING EXISTING TAGS — use the dedicated edit tools, do NOT hand-build a tag for update_gtm_tag ' +
          '(that is what causes "measurementIdOverride/eventName must not be empty" and "template key" / ' +
          '"unknown entity type" errors): to ADD GA4 event parameters (e.g. user_id, session_id, click_text) ' +
          'to GA4 event tags, call add_ga4_event_parameters (one call per tag); to CHANGE or REPLACE the ' +
          'Measurement ID — including swapping a {{variable}} like {{GA4 Measurement ID}} for {{GA4 Variable}} — ' +
          'on GA4 event tags OR the Google tag, call set_ga4_measurement_id (one call per tag). ' +
          'WHEN THE USER SAYS "ALL GA4 TAGS" / "every GA4 tag", use the BULK tool — ONE call — ' +
          'NOT a per-tag loop: set_ga4_measurement_id_on_all_tags to change the Measurement ID on every GA4 ' +
          'tag, and add_ga4_event_parameters_to_all_tags to add event parameters to every GA4 event tag. ' +
          'Do NOT call set_gtm_tag_paused, delete_gtm_tag/trigger, or any unrelated tool for these requests. ' +
          'set_gtm_tag_paused ONLY pauses or enables a tag — it does NOT change a Measurement ID, event parameters, ' +
          'or any tag config; never use it to edit a GA4 tag. ' +
          'Only use update_gtm_tag for fields with no dedicated tool, and pass ONLY the fields you are changing. ' +
          'TRIGGERS: when you create a trigger (form/link/click), do NOT set "Wait for Tags" (waitForTags) or ' +
          '"Check Validation" (checkValidation) — leave them OFF/unticked by default (simply omit those fields, ' +
          'or set them to boolean "false"). Only enable them (boolean "true", and waitForTagsTimeout for the wait) ' +
          'if the user EXPLICITLY asks to wait for tags or check validation. ' +
          'TIMER TRIGGERS: a Timer trigger (type "timer") MUST carry its interval in MILLISECONDS (e.g. 30 seconds = 30000) and an optional limit (omit for unlimited). Always SUPPLY the interval value — the system files eventName=gtm.timer + interval + limit into the correct GTM trigger fields for you, so exact placement does not matter, but the interval value must be present. Never claim an interval you did not actually pass. ' +
          'REPORTING RESULTS — always be honest about what happened. If a tool call FAILED, tell the user plainly that it failed, QUOTE the error reason, and state clearly whether the overall task was completed or NOT. Never imply success when a write failed, and never go silent after a failure — end your turn with a clear "done" or "not done (because …)". If you retried and still could not do it, say so and suggest the next step. ' +
          gtmPromptSections(containerKind) +
          GA4_TAG_NAMING +
          GA4_ECOMMERCE_REFERENCE +
          GTM_CREATION_METHODOLOGY +
          GTM_TRIGGER_VARIABLE_REFERENCE +
          GTM_DECISION_RULES +
          GTM_AUDIT_METHODOLOGY +
          'CLEANUP — UNUSED TRIGGERS: when the user wants to remove unwanted/orphaned triggers (triggers not linked to any tag), FIRST call list_unused_gtm_triggers to show them (it returns each orphan\'s triggerId + name — a trigger referenced by no tag as a firing OR blocking trigger, and not a Trigger Group member). Then, on the user\'s go-ahead, call delete_unused_gtm_triggers: with NO triggerIds it deletes ALL of them; pass triggerIds to delete only the ones the user selected (the filter). It is destructive (double-confirm) and never deletes a referenced trigger even if its id is passed (it is skipped + reported). Do NOT loop delete_gtm_trigger one-by-one for a cleanup — use the bulk tool. ' +
          'CLEANUP — UNUSED VARIABLES: same pattern for orphaned variables (referenced by no tag, trigger, or other variable): list_unused_gtm_variables to show them, then delete_unused_gtm_variables (all, or a selected variableIds subset; destructive double-confirm). IMPORTANT caveat to state to the user: this is a strong HINT not proof, and UNLIKE triggers the GTM API does NOT refuse to delete a referenced variable — a variable used only in a published version or a field the audit cannot read could be wrongly deleted and silently break that {{reference}}. So advise reviewing before deleting. ' +
          'MONITORING / DRIFT: when the user asks what CHANGED, about regressions, or to monitor the ' +
          'container over time, call audit_gtm_container_changes — it reports NEW vs RESOLVED issues since ' +
          'the last audit (lead with the new ones and offer their fixes). When the user asks what a publish ' +
          'would change, or how the draft differs from what is live, call diff_gtm_workspace_vs_live and ' +
          'summarize the added/removed/modified tags, triggers, and variables. When the user asks what ' +
          'changed between PUBLISHED versions (or "when did X break"), use list_gtm_versions to find the ' +
          'version ids then diff_gtm_versions to compare two of them. ' +
          'SCORECARD: when the user wants an overall health score, grade, or a client-ready summary, call ' +
          'analytics_scorecard (pass ga4Property to fold GA4 into the score); report the overall score + ' +
          'letter grade, the per-section grades, and the ranked top issues. ' +
          'MEASUREMENT-ID CHECK: when the user asks whether the container\'s GA4 ids are correct / point to a ' +
          'real property, call check_gtm_measurement_ids — it flags GA4 ids on tags that match no GA4 stream ' +
          'the user can access (typo / wrong id / different account) and resolves matched ids to their property. ' +
          'REPORT: for a shareable / client-ready report, call generate_analytics_report (pass ga4Property to ' +
          'include GA4) and present the returned Markdown verbatim. Both analytics_scorecard and ' +
          'generate_analytics_report also accept an optional consentReport (a web-audit ' +
          'consent_compliance_audit JSON the user provides) to add a Consent Mode v2 section. '
        : product === 'gtm'
          ? 'You can read the GTM setup (accounts, containers, workspaces, tags), and produce an overall ' +
            'health score with analytics_scorecard (optionally folding in a GA4 property). '
          : 'You can read GA4 (accounts, properties, data streams), run GA4 reports (run_ga4_report + ' +
            'run_ga4_realtime_report), and inspect a property\'s configuration BY NAME: ' +
            'list_ga4_key_events (conversions), list_ga4_audiences (remarketing/segmentation), ' +
            'list_ga4_custom_dimensions, list_ga4_custom_metrics, ' +
            'list_ga4_google_ads_links, get_ga4_attribution_settings, get_ga4_google_signals, ' +
            'list_ga4_measurement_protocol_secrets (names only), list_ga4_bigquery_links, ' +
            'list_ga4_firebase_links, get_ga4_property_details, get_ga4_data_retention, and ' +
            'get_ga4_enhanced_measurement (per web data stream). Use these to answer "what are my key ' +
            'events / custom dimensions / …" — never say you cannot list them. ' +
            'For an overall health score or grade of a GA4 property, call score_ga4_property (0–100 + ' +
            'letter grade). For a shareable / client-ready GA4 report (config + data-quality combined), ' +
            'call generate_ga4_report and present the returned Markdown verbatim. ' +
            'When the user asks to audit, check, review, or "health-check" a GA4 property or its setup, ' +
            'ALWAYS call audit_ga4_property FIRST (never a manual checklist), then present the counts and ' +
            'severity summary and list every finding by severity (high → info) as a table: severity, the ' +
            'issue, and the recommended change. When the user asks about DATA QUALITY, "(not set)", ' +
            'Unassigned traffic, or whether the data looks healthy/accurate, call audit_ga4_data_quality ' +
            '(it inspects the last N days of reporting data — default 28, pass days for another window — not ' +
            'config); lead with the window it reports (its dateRange, e.g. "last 28 days (Jan 1 – Jan 28, ' +
            '2026)") and then present its findings the same way. ' +
            'For metrics over a time range, call run_ga4_report with GA4 relative dates ' +
            '(today, yesterday, NdaysAgo) or explicit YYYY-MM-DD computed from the current date above — ' +
            'never assume the year. GA4 has NO data for dates after today, and the most recent 1–2 days ' +
            'may still be processing (partial); report dates resolve in the property\'s timezone. ' +
            GA4_DATA_FRESHNESS +
            (confirm
              ? GA4_WRITE_GUIDANCE
              : 'GA4 is READ-ONLY — you cannot apply fixes; give the user ' +
                'the exact change to make in the GA4 Admin UI. ') +
            GA4_PROPERTY_AUDIT) +
      (product === 'gtm' && active.gtmContext?.containerId
        ? `The user is working in GTM account ${active.gtmContext.accountId} ` +
          `(${active.gtmContext.accountName ?? ''}), container ${active.gtmContext.containerId} ` +
          `(${active.gtmContext.containerName ?? ''})` +
          (active.gtmContext.workspaceId
            ? `, workspace ${active.gtmContext.workspaceId} (${active.gtmContext.workspaceName ?? ''})`
            : '') +
          '. Use THESE ids for all GTM operations — do not ask which account/container/workspace and ' +
          'do not re-list them unless the user asks to switch. '
        : '') +
      (product === 'ga4' && active.ga4Context?.property
        ? `The user is working in GA4 property ${active.ga4Context.property} ` +
          `("${active.ga4Context.propertyName ?? ''}"${active.ga4Context.accountName ? `, account "${active.ga4Context.accountName}"` : ''}). ` +
          'Use THIS property id for every GA4 tool call (audits, reports, data quality) - do not ask ' +
          'which property and do not re-list properties unless the user asks to switch. '
        : '') +
      mem.block +
      (this.memory
        ? 'MEMORY: you have a persistent, per-client memory (any saved notes appear above under REMEMBERED CONTEXT). ' +
          'When the user tells you to REMEMBER something, or states a durable preference, correction, or decision ' +
          '(e.g. "we use order_completed for purchase", "do not suggest scroll tracking again", "always name tags like X"), ' +
          'call remember_memory to save it (kind: rule for an instruction/correction, else preference / decision / fact / glossary). ' +
          'When the user says to FORGET something ("forget that", "stop applying X"), call forget_memory with a short description. ' +
          'Also save a brief memory when you make a NOTABLE persistent change the user would want on record (e.g. created or deleted a key tag/trigger, with what and when). ' +
          'Be conservative: never remember secrets, API keys, personal data, or transient one-off values. Briefly confirm what you remembered or forgot. ' +
          'To look BEYOND the notes shown above (another client of this account, or something the user says was agreed earlier), call recall_memories with a short query instead of guessing. '
        : '') +
      CORPUS_PROMPT +
      toolMemoryBlock +
      dateContextLine(new Date()) +
      'Call tools when asked; never invent ids. When the user asks to list or count ' +
      'tags, triggers, variables, accounts, containers, or workspaces, the tools already ' +
      'return the COMPLETE paginated set — present EVERY item (a compact table is ideal) and ' +
      'never truncate, sample, or say "and more"; if a count is asked, count the full list. ' +
      'Put any code, install snippet, or multi-line technical output in a fenced ``` code block so it renders as a copyable code box. ' +
      'Be concise and factual. ' +
      'Style: do NOT use em dashes (the "—" character) anywhere in your replies; use commas, colons, parentheses, or a hyphen "-" instead.';

    // Replayed history is bounded: every prior turn used to be re-sent in full on EVERY request, and
    // the tool loop then re-sent that whole array on every step. Oldest turns go first, the newest
    // few are never dropped, and when anything is dropped the model is TOLD - a silently shortened
    // thread would have it answer confidently about messages it can no longer see.
    const bounded = boundChatHistory(history);
    if (bounded.dropped) {
      console.error(`[chat] history bounded: dropped ${bounded.dropped} older turn(s) to fit the request budget`);
    }
    const messages: LlmTurn[] = [
      // History replays each user turn's media too, so follow-up questions keep seeing the doc.
      ...bounded.turns.map((h, i): LlmTurn => {
        // The notice rides on the oldest SURVIVING turn, so it reads as context, not as a user message.
        const text = i === 0 && bounded.notice ? bounded.notice + h.text : h.text;
        return h.role === 'user' && h.media?.length ? { role: 'user', text, media: h.media } : { role: h.role, text };
      }),
      { role: 'user', text: message, ...(media?.length ? { media } : {}) },
    ];

    const toolCalls: ChatToolCall[] = [];
    // Open a fresh change-journal turn so the user can revert this query's GTM writes.
    if (product === 'gtm') changeJournal.beginTurn();
    // A real build is many tool calls: e.g. a Meta Pixel tag = list reads + a trigger + ~8 ecommerce
    // variables + import template + the tag (~13-16). Reasoning models (o4-mini) issue ONE tool call
    // per step, so a low cap truncated multi-item builds mid-flow ("stopped after N steps"). This is a
    // SAFETY ceiling, not a target — a normal turn returns a final answer well before it; it only bites
    // pathological loops. Idempotent precheck (findExistingByName) means a re-run safely resumes.
    const MAX_TOOL_STEPS = 40;
    // Provenance: tell the UI which memories are in this turn's context (before the answer streams), and
    // log the use on each memory.
    {
      const added = creditMemoryUse(usedMemories, mem.used);
      if (added.length) {
        logUse(added);
        emit?.({ type: 'memories', used: [...usedMemories.values()] });
      }
    }

    // Every tool result from THIS turn, folded into the thread's carry-over once the turn ends.
    const turnToolResults: Array<{ name: string; args?: Record<string, unknown>; content?: string; ok: boolean }> = [];

    let result;
    try {
      result = await runChat(client, { system, model: active.llm.model, apiKey, messages, signal }, tools, {
        // House style: never surface an em OR en dash. Stripped from the live stream as a hard guarantee
        // on top of the system-prompt instruction. Safe per chunk because both are single UTF-16 code
        // units, so neither can be split across deltas. The final text is stripped the same way below;
        // the two MUST use the same pattern or the streamed text and the persisted text disagree.
        onDelta: emit ? (delta) => emit({ type: 'text', delta: stripDashes(delta) }) : undefined,
        onToolCall: (call) => {
          toolCalls.push({ name: call.name, args: call.args });
          emit?.({ type: 'tool', name: call.name });
        },
        onToolResult: (r) => {
          turnToolResults.push({ name: r.name, args: r.args, content: r.content, ok: r.ok });
          emit?.({ type: 'tool_result', name: r.name, ok: r.ok, error: r.error });
        },
        // A provider rate-limit retry used to be a silent sleep of up to 60s (x4) inside one fetch,
        // which is what a "Thinking…" hang actually was. Surface it.
        onRetry: emit
          ? (n) =>
              emit({
                type: 'retry',
                provider: n.provider,
                status: n.status,
                attempt: n.attempt,
                maxAttempts: n.maxAttempts,
                delayMs: n.delayMs,
              })
          : undefined,
      }, MAX_TOOL_STEPS);
    } finally {
      // In a finally so a turn that DIED on a rate limit still keeps what it already read: that is
      // exactly the turn whose reads we least want repeated. The key is recomputed because
      // set_gtm_container can switch the working container mid-turn, which would make these results
      // a mix of two clients; in that case they are dropped rather than filed under either one.
      if (this.threadKey(active, product) === threadKey) this.toolMemory.record(threadKey, turnToolResults);
    }

    // Injected + anything the model recalled mid-turn via the memory tool.
    const memoriesUsed = [...usedMemories.values()];
    return { text: stripDashes(result.text), toolCalls, ...(memoriesUsed.length ? { memoriesUsed } : {}) };
  }
}
