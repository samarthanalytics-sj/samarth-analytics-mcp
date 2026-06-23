import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { AuditHistoryStore } from '../storage/audit-history';
import { buildToolRegistry } from '../tools/registry';
import type { ConfirmFn } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import { changeJournal } from '../google/change-journal';
import type { ChatReply, ChatStreamEvent, ChatToolCall, ChatTurn, GoogleProduct } from '../../shared/ipc';
import type { LlmTurn } from '../llm/types';

/**
 * The "GTM Audit Brain" — an evidence-based, deterministic methodology the model must
 * follow when auditing a container, so audits return findings (not opinions) and never
 * lead with cosmetics or invent runtime verdicts. Exported so it's testable / reusable.
 */
export const GTM_AUDIT_METHODOLOGY =
  'AUDIT METHODOLOGY (GTM Audit Brain) — when the user asks to audit / check / review / "health-check" the container or its setup, follow this method exactly; return findings, not opinions: ' +
  '(1) ALWAYS call audit_gtm_container FIRST for the deterministic findings — never audit from memory or a generic checklist. ' +
  '(2) OPEN with the boundary statement: a container-only audit proves CONFIGURATION, not firing behaviour, dataLayer reality, PII in hits, or consent timing — those need runtime verification (GA4 DebugView / Tag Assistant, a network capture of /collect requests, and the live CMP). ' +
  '(3) Tag EVERY finding with a confidence level — [Certain] = provable from the container; [Likely] = strong inference needing one cheap confirmation; [Guessing / runtime-required] = needs runtime evidence you do not have. Never count a [Guessing/runtime-required] item as a confirmed defect. ' +
  '(4) ORDER by impact, not category: Critical (active data corruption or a legal violation — e.g. a double-firing purchase/conversion tag, PII sent to GA4/Ads, tags able to fire before the consent default) → High → Medium → Low. Hygiene (naming, paused, orphaned, folders) is LISTED last, NEVER leads, and is NEVER reported as a data or legal issue. If a container is messy but functionally sound, say so plainly. ' +
  '(5) Each finding has FOUR parts: what is wrong (one sentence) · impact (data / legal / security, quantified where possible) · evidence (the exact tag/trigger/variable/parameter name) · fix (the specific action). When a finding carries a ready-to-run `fix` ({tool,args} with ids filled in), OFFER to apply it and — once the user approves — CALL that exact tool (never tell the user to fix it manually in the GTM UI when a fix tool exists); each fix needs approval, deletes need two. ' +
  '(6) FALSE-POSITIVE GUARDS: a denied consent signal correctly BLOCKING a tag is correct behaviour, not a violation; a tag that does not fire where it was never meant to is not broken; classify a tag by its actual destination ID, not a guessed brand; a hygiene issue is never a data/legal issue; if you cannot prove it from the evidence in hand, mark it runtime-required rather than inventing a verdict. ' +
  '(7) CONSENT MODE v2 needs ALL FOUR signals (ad_storage, analytics_storage, ad_user_data, ad_personalization) with a denied-by-default Consent Initialization — flag missing signals as Critical, but consent TIMING/firing-order is runtime-required. ' +
  '(8) END with an explicit list of the runtime-required checks not yet verified, so nobody assumes they passed. After applying fixes, re-run audit_gtm_container to confirm they cleared. ';

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
export class ChatService {
  constructor(
    private readonly registry: RegistryService,
    private readonly data: GoogleDataService,
    private readonly providerKeys: ProviderKeyStore,
    private readonly history?: AuditHistoryStore
  ) {}

  /** Non-streaming: returns the final reply only. */
  chat(history: ChatTurn[], message: string, product: GoogleProduct): Promise<ChatReply> {
    return this.run(history, message, product);
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
    signal?: AbortSignal
  ): Promise<ChatReply> {
    return this.run(history, message, product, emit, confirm, signal);
  }

  private async run(
    history: ChatTurn[],
    message: string,
    product: GoogleProduct,
    emit?: (event: ChatStreamEvent) => void,
    confirm?: ConfirmFn,
    signal?: AbortSignal
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
    // GA4 is read-only; only GTM gets write tools (and thus the confirm flow).
    const tools = buildToolRegistry(this.data, product === 'gtm' ? confirm : undefined, product, this.history);

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
          'tag, all in ONE approval), and create_gtm_variable_typed for variables (constant / data_layer ' +
          '/ javascript). Only fall back to the raw create_gtm_tag/trigger/variable tools for advanced ' +
          'cases. The user must approve each change. ' +
          'EDITING EXISTING TAGS — use the dedicated edit tools, do NOT hand-build a tag for update_gtm_tag ' +
          '(that is what causes "measurementIdOverride/eventName must not be empty" and "template key" / ' +
          '"unknown entity type" errors): to ADD GA4 event parameters (e.g. user_id, session_id, click_text) ' +
          'to GA4 event tags, call add_ga4_event_parameters (one call per tag); to CHANGE or REPLACE the ' +
          'Measurement ID — including swapping a {{variable}} like {{GA4 Measurement ID}} for {{GA4 Variable}} — ' +
          'on GA4 event tags OR the Google tag, call set_ga4_measurement_id (one call per tag). ' +
          'WHEN THE USER SAYS "ALL GA4 TAGS" / "every GA4 tag", use the BULK tool — ONE call, ONE approval — ' +
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
          GTM_AUDIT_METHODOLOGY +
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
            'GA4 is READ-ONLY — you cannot apply fixes; give the user ' +
            'the exact change to make in the GA4 Admin UI. ') +
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
      dateContextLine(new Date()) +
      'Call tools when asked; never invent ids. When the user asks to list or count ' +
      'tags, triggers, variables, accounts, containers, or workspaces, the tools already ' +
      'return the COMPLETE paginated set — present EVERY item (a compact table is ideal) and ' +
      'never truncate, sample, or say "and more"; if a count is asked, count the full list. ' +
      'Be concise and factual.';

    const messages: LlmTurn[] = [
      ...history.map((h): LlmTurn => ({ role: h.role, text: h.text })),
      { role: 'user', text: message },
    ];

    const toolCalls: ChatToolCall[] = [];
    // Open a fresh change-journal turn so the user can revert this query's GTM writes.
    if (product === 'gtm') changeJournal.beginTurn();
    const result = await runChat(client, { system, model: active.llm.model, apiKey, messages, signal }, tools, {
      onDelta: emit ? (delta) => emit({ type: 'text', delta }) : undefined,
      onToolCall: (call) => {
        toolCalls.push({ name: call.name, args: call.args });
        emit?.({ type: 'tool', name: call.name });
      },
    });

    return { text: result.text, toolCalls };
  }
}
