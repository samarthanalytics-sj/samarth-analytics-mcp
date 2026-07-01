import type { RegistryService } from './registry-service';
import type { GoogleDataService } from '../google/data-service';
import type { ProviderKeyStore } from '../storage/provider-keys';
import type { AuditHistoryStore } from '../storage/audit-history';
import { buildToolRegistry } from '../tools/registry';
import type { ConfirmFn } from '../tools/registry';
import { createProvider, runChat } from '../llm/gateway';
import { changeJournal } from '../google/change-journal';
import type { ChatReply, ChatStreamEvent, ChatToolCall, ChatTurn, GoogleProduct, GtmContext } from '../../shared/ipc';
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
export const GTM_AUDIT_METHODOLOGY =
  'AUDIT METHODOLOGY (GTM Audit Brain) — when the user asks to audit / check / review / "health-check" the container or its setup, follow this method exactly; return findings, not opinions: ' +
  '(1) ALWAYS call audit_gtm_container FIRST for the deterministic findings — never audit from memory or a generic checklist. ' +
  '(2) OPEN with the boundary statement: a container-only audit proves CONFIGURATION, not firing behaviour, dataLayer reality, PII in hits, or consent timing — those need runtime verification (GA4 DebugView / Tag Assistant, a network capture of /collect requests, and the live CMP). ' +
  '(3) Tag EVERY finding with a confidence level — [Certain] = provable from the container; [Likely] = strong inference needing one cheap confirmation; [Guessing / runtime-required] = needs runtime evidence you do not have. Never count a [Guessing/runtime-required] item as a confirmed defect. ' +
  '(4) ORDER by impact, not category: Critical (active data corruption or a legal violation — e.g. a double-firing purchase/conversion tag, PII sent to GA4/Ads, tags able to fire before the consent default) → High → Medium → Low. Hygiene (naming, paused, orphaned, folders) is LISTED last, NEVER leads, and is NEVER reported as a data or legal issue. If a container is messy but functionally sound, say so plainly. ' +
  '(5) Each finding has FOUR parts: what is wrong (one sentence) · impact (data / legal / security, quantified where possible) · evidence (the exact tag/trigger/variable/parameter name) · fix (the specific action). When a finding carries a ready-to-run `fix` ({tool,args} with ids filled in), OFFER to apply it and — once the user approves — CALL that exact tool (never tell the user to fix it manually in the GTM UI when a fix tool exists); each fix needs approval, deletes need two. ' +
  '(6) FALSE-POSITIVE GUARDS: a denied consent signal correctly BLOCKING a tag is correct behaviour, not a violation; a tag that does not fire where it was never meant to is not broken; classify a tag by its actual destination ID, not a guessed brand; a hygiene issue is never a data/legal issue; if you cannot prove it from the evidence in hand, mark it runtime-required rather than inventing a verdict. NEVER report GTM\'s "Cannot detect the Google tag" warning as a defect — a {{variable}} Measurement/Tag ID is BEST PRACTICE (A3), not a fault; only an EMPTY id (Certain, High) or an id that resolves to nothing at runtime is the finding (a variable id is runtime-required, a hardcoded id with no matching Google tag is verify-only). ' +
  '(7) CONSENT: Consent Mode v2 needs ALL FOUR signals (ad_storage, analytics_storage, ad_user_data, ad_personalization) with a denied-by-default Consent Initialization — flag missing signals as Critical, but consent TIMING/firing-order is runtime-required. CUSTOM HTML has NO built-in Consent Mode (B6): detect an advertising pixel by a STRONG signal (the pixel init/fire — fbq(\'init\'/\'track\', ttq.load(, _linkedin_partner_id, pintrk(, snaptr(, twq(, rdt(, uetq) — a bare DOMAIN reference alone is only "possible, review" [Guessing]; the short tokens twq(/rdt(/uetq also need their domain to co-occur. Then evaluate its CONSENT GATE: consentStatus notSet/absent = UNGATED, notNeeded = declared-no-consent, needed-without-ad_storage = wrong-types — all three are NO valid gate → Critical for EU/UK/AU (else High), [Certain] the gate is missing (firing-before-consent stays runtime-required, keep the two claims separate). needed WITH ad_storage but missing ad_user_data/ad_personalization = partial → Medium. needed WITH all required ad types = correctly GATED → emit NOTHING (do not flag a denied-pass). Google tags (GA4/Ads/Floodlight/Linker) DO have built-in consent, so notSet on them is [Likely], not certain; never skip a non-Google marketing tag\'s missing consent gate as "nothing to check". DEDUP every finding by check+resource (no finding twice for one tag/variable), and an UNUSED item cannot also be a runtime risk — unused wins, suppress the risk finding. ' +
  '(8) SEVERITY nuance: a paused tag is Low, BUT a paused conversion (Ads) or GA4/Google CONFIG tag is High — a silent tracking gap. A tag with an empty destination id (no Measurement/Tag/Conversion id) is High — it looks active but sends nothing. A {{variable}} Measurement ID that a Google/Configuration tag in the container DECLARES is fine ("Google tag found"); one that NO Google tag declares is GTM\'s "Cannot detect the Google tag" case → HIGH [Likely], events may not be collected (point the tag at the id the Google tag uses, or add a Google tag for it). ' +
  '(9) MORE CHECKS — present with the same discipline: DOUBLE-COUNTING (a manual GA4 event tag for an event Enhanced Measurement also auto-tracks — page_view/scroll/click/file_download/form_submit/video_* — is [Likely]; EM lives on the web stream, confirm before scoring), DESTINATION MISMATCH (a GA4 event tag whose Measurement ID differs from the page\'s Google tag splits data), PURCHASE DEDUP (a purchase/conversion sent twice inflates revenue — runtime-required, not provable from the export), CUSTOM JS VARIABLES (jsm run wherever referenced — review for DOM/cookie/PII access), UNRECOGNISED TAG TYPE (flagged for manual review, never skipped silently), and SERVER-SIDE mixed transport (tags not all sharing the transport URL split attribution). ' +
  '(10) SCORING is deterministic + versioned: Critical −30, High −12, Medium −4, Low −1; info and runtime-required score 0. Report the number AND keep runtime-required items in their own "needs verification" list, never as scored defects. ' +
  '(11) END with that explicit runtime-required list so nobody assumes those checks passed. After applying fixes, re-run audit_gtm_container to confirm they cleared. ';

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
export const GA4_PROPERTY_AUDIT =
  'GA4 PROPERTY AUDIT — when the user asks to "audit" / "property audit" / "full audit" / review / health-check this GA4 property, run this structured, evidence-based audit (ONE property at a time; never carry assumptions between properties):\n' +
  '1) GATHER REAL VALUES FIRST, before writing any finding: call audit_ga4_property and audit_ga4_data_quality, PLUS get_ga4_data_retention, get_ga4_property_details, get_ga4_google_signals, get_ga4_attribution_settings, get_ga4_enhanced_measurement, list_ga4_key_events, list_ga4_custom_dimensions, list_ga4_custom_metrics, list_ga4_audiences, list_ga4_google_ads_links, list_ga4_bigquery_links, list_ga4_firebase_links, and run_ga4_report over ~90 days WITH a comparison (channel mix, top pages, key-event trend, new vs returning, device). Check the data-retention window first and never run a trend longer than retention. ' +
  '2) EVIDENCE RULES: every finding carries a REAL number or exact config value from THIS property — no generic statements ("events look fine"). If a tool cannot verify something, mark it "Not Verified" (its own state) — never assume a pass or a fail. Separate observed from inferred (label inferences). Rank by impact on decisions/spend, not ease of fix. State data limitations (retention, sampling, thresholding, Google Signals on). ' +
  '3) FIXED WORDS ONLY: area status is exactly one of Pass / Partial / Fail / Not Verified; finding confidence is exactly one of Certain / Likely / Guessing, tied to the evidence. Do NOT invent maturity scores or confidence percentages. ' +
  '4) SEVERITY: Critical (data wrong/missing in a way that misleads decisions or spend, PII, a collection gap) → High → Medium → Low; hygiene is listed LAST and never reported as a data/legal issue. Add to EVERY finding: who is affected (marketing/finance/leadership/product/paid media), the decision or number that becomes unreliable, and an estimated data-loss %. ' +
  '5) CHARTS: render every percentage (parameter coverage, data loss, channel share) as a Unicode bar — filled blocks = round(value/5) out of 20, full block "█" for filled + light "░" for empty, the number printed after the bar — AND include the raw JSON data block behind it (e.g. {"chart":"parameter_coverage","event":"purchase","series":[{"param":"value","pct":100}]}). Never show a chart without the number and the data block. ' +
  '6) DECISION READINESS: for the key business questions (which campaigns generate revenue; abandonment by product/page; CAC by channel; lead quality; LTV; refund/return rate; repeat/churn within 90 days) mark each Answerable / Partial / Not answerable with the data required, then list what the property CANNOT measure at all and the missing input (e.g. LTV — no User-ID/server data). ' +
  '7) OUTPUT this fixed template, with NO free-form prose outside it: header (property + id, date window + comparison + retention, access level, data limitations) -> Executive summary -> Area-status table (Collection, Configuration, Events, Custom definitions, Ecommerce, Attribution, Audiences, Integrations, Consent, Identity, Marketing readiness, Reporting; each = Status + Confidence + evidence note) -> Property baseline (trend vs comparison, peak/low day, channel-mix shift, new vs returning, device split, geo flags) -> Decision-readiness table -> Parameter coverage (Unicode bars + JSON) -> Funnel if ecommerce is in scope (mark missing steps MISSING) -> Findings sorted by severity (each: evidence, observed-vs-inferred, cause + cause-confidence, business risk, data-loss bar + reports affected, fix) -> Not Verified list -> summary counts (Critical/High/Medium/Low + top 3 to fix). Only if the user demands a single headline number, compute it by rule (Pass=2, Partial=1, Fail=0 over SCORED areas only; score = points / (2 x scored areas) x 100, rounded) and ALWAYS print the count of Not Verified areas beside it; otherwise omit it. ';

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
    private readonly history?: AuditHistoryStore,
    /** Called after a chat tool switches the active GTM context, so the UI refreshes. */
    private readonly notifyContextChanged?: () => void
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
    // GA4 is read-only; only GTM gets write tools (and thus the confirm flow).
    const tools = buildToolRegistry(this.data, product === 'gtm' ? confirm : undefined, product, this.history, ctxControl);

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
          'ALREADY-PRESENT: creating a tag/trigger/variable that already exists (same name — or, for a Custom Event trigger, the same dataLayer event) is auto-detected and REUSED — reported as "already present" with no duplicate and NO approval prompt. You can also list_gtm_tags / list_gtm_triggers / list_gtm_variables first to tell the user what already exists. ' +
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
          'TIMER TRIGGERS: a Timer trigger (type "timer") MUST carry its interval in MILLISECONDS (e.g. 30 seconds = 30000) and an optional limit (omit for unlimited). Always SUPPLY the interval value — the system files eventName=gtm.timer + interval + limit into the correct GTM trigger fields for you, so exact placement does not matter, but the interval value must be present. Never claim an interval you did not actually pass. ' +
          'REPORTING RESULTS — always be honest about what happened. If a tool call FAILED, tell the user plainly that it failed, QUOTE the error reason, and state clearly whether the overall task was completed or NOT. Never imply success when a write failed, and never go silent after a failure — end your turn with a clear "done" or "not done (because …)". If you retried and still could not do it, say so and suggest the next step. ' +
          'CAPABILITIES — NEVER claim an action is impossible or "UI-only" when you have a tool for it. Before saying the GTM API or this tooling "doesn\'t support" something, CHECK YOUR TOOL LIST and call the tool. You CAN, via tools: write a server container\'s Tagging Server URL (set_server_container_tagging_url), delete a server-side client (delete_gtm_client), UPDATE a trigger in place incl. its Custom Event "Event name" (update_gtm_trigger — never delete+recreate a trigger to change its event name, and you can\'t delete one tags reference), create/rename/delete folders, create/list environments, create clients/transformations/server tags. If a matching tool exists, CALL IT — do not tell the user to do it in the GTM UI or that it is unsupported. The ONLY genuinely user-side steps are deploying/provisioning the tagging-server HOST (Cloud Run/App Engine/Stape) and publishing. ' +
          'SERVER-SIDE GTM (sGTM): the API can build server containers — to set up server-side tagging from a web container, call bootstrap_server_side_tagging: it creates a SERVER container and adds a COMPLETE, firing GA4 setup — a GA4 client (gaaw_client) + a Custom Event trigger scoped to "Client Name equals GA4" (the Google/Stape pattern — it also enables the Client Name built-in) + a GA4 server tag (sgtmgaaw) that fires on that trigger and relays to a GA4 Measurement ID (Event Name left blank so it inherits each incoming event_name). No separate trigger step is needed. When the user says "set up a server container for THIS web container", pass webContainerId = the active GTM container id and it derives that web container\'s GA4 Measurement ID automatically (no need to ask for it); otherwise pass measurementId directly. For pieces: create_server_container, create_gtm_client (GA4 client = type gaaw_client), create_gtm_transformation, list_gtm_clients / list_gtm_transformations; server tags: use create_server_tag with platform ga4 / ads_conversion / ads_conversion_linker / ads_remarketing (builds the correct sgtmgaaw / sgtmadsct / sgtmadscl / sgtmadsremarket shape). For a SERVER trigger, ALWAYS use create_server_trigger (name + optional clientName to scope to "Client Name equals <client>") — do NOT hand-build a server trigger with create_gtm_trigger; a customEvent trigger needs a specific {{_event}} match-all filter that is easy to get wrong. Server DATA: read fields off the incoming event with create_gtm_variable_typed kind "event_data" (keyPath, e.g. "items"). TRANSFORMATIONS ARE OPTIONAL — they are NOT part of the GA4 baseline (1 client + 1 GA4 server tag + 1 event trigger is the working minimum). Do NOT build a transformation, and do NOT ask the user for a parameter allow-list, as if it were a required step. After the baseline is in place, ASK the user whether they want a transformation at all — now, later, or not — and only build one (create_gtm_transformation; allowParams keeps ONLY the listed params and DROPS the rest, so warn it will lose unlisted fields) if they say yes. Its only real use is reshaping/redacting params (e.g. stripping PII) across all tags at once. META PIXEL WEB TAGS: to create a Meta/Facebook pixel event tag, use create_meta_pixel_tag (pixelId, event, optional objectProperties/firingTriggerId — name OPTIONAL, defaults to "Meta - Event - <Event> Tag"). It imports the template + sets the event fields CORRECTLY: a Meta STANDARD event (ViewContent, AddToCart, Purchase, Lead, Donate, InitiateCheckout, …) → eventName=standard + standardEventName; anything else → CUSTOM (eventName=custom + customEventName). Do NOT hand-build the cvt_ Meta tag and do NOT set only standardEventName (that leaves the event as the default PageView). ALWAYS pass objectProperties matching the event\'s standard Meta object properties: Purchase → content_ids, contents, content_type, value, currency, num_items, order_id, event_id; ViewContent → content_ids, contents, content_type, content_name, content_category, value, currency; AddToCart / InitiateCheckout → content_ids, contents, content_type, value, currency, num_items; AddToWishlist / AddPaymentInfo / CustomizeProduct → content_ids, contents, content_type, value, currency; Lead → value, currency, content_name, content_category; Search → search_string, content_ids, content_category; CompleteRegistration → registration_method, content_name, status, value, currency; Contact / SubmitApplication → content_name, content_category; Schedule → content_name, value, currency; Donate / Subscribe / StartTrial → value, currency (+ predicted_ltv for Subscribe/StartTrial); FindLocation → location, search_string. For any other event use that event\'s standard Meta object properties. Source each value from the container\'s matching variable (call list_gtm_variables, e.g. {{Ecommerce Value}}, {{Ecommerce Currency}}, {{Ecommerce Items}}); skip a property if no variable exists for it. Name tags "Meta - Event - <Event> Tag". For the trigger, create/identify it first and pass its firingTriggerId. ' +
          'OTHER PIXEL TAGS via COMMUNITY TEMPLATES (web): to create a TikTok/LinkedIn/Snap pixel WEB tag, PREFER the official community template over a Custom HTML tag — the API CAN import gallery templates. Call import_gallery_template with the platform\'s GitHub owner/repository: Meta = facebook / GoogleTagManager-WebTemplate-For-FacebookPixel; TikTok = tiktok / gtm-template-pixel; LinkedIn = linkedin / linkedin-gtm-community-template; Snap = Snapchat / snapchat-google-tag-manager; Pinterest = pinterest / ws-gtm-template. It returns the template\'s tag TYPE code (cvt_…); then build the tag with create_gtm_tag using that type + the template\'s OWN field keys (these DIFFER per template — do NOT reuse Meta\'s pixelId/standardEventName). Field keys verified against the live templates: TikTok (gtm-template-pixel) = pixel_code (Pixel ID) + event (SELECT — the TikTok event itself; map purchase→CompletePayment, add_to_cart→AddToCart, view_item→ViewContent, begin_checkout→InitiateCheckout, generate_lead→SubmitForm; others AddToWishlist/AddPaymentInfo/PlaceAnOrder/Download/CompleteRegistration/Subscribe/ClickButton/Search; NO custom-event field). Pinterest (ws-gtm-template) = tagId (Tag ID) + eventName (SELECT, LOWERCASE: pagevisit, viewcategory, viewcontent, addtocart, checkout [=purchase], search, signup, lead, …; for a custom event set eventName="ADE" + adeEventName="<name>"; optional em = hashed email for Enhanced Match). LinkedIn (linkedin-gtm-community-template) = partnerId (Partner ID) only — that\'s the base Insight Tag; LinkedIn conversions are configured in Campaign Manager (optional conversionId/eventId). Use list_gtm_templates to find an already-imported template + its type. If a create is rejected, the field keys are wrong for that template version — check it. Only fall back to Custom HTML if the user asks for it. ' +
          'META CAPI (Conversions API): to create a Meta/Facebook CAPI SERVER tag use create_meta_capi_server_tag (pixelId, accessToken, event — usually {{Facebook Pixel ID}} / {{Facebook Api Token}} variables). It imports the Stape template + sets the EMQ-tuned config (action source website, Event Enhancement/gtmeec ON, generate _fbp ON). EVENT MATCH QUALITY: the more user-data (PII) the CAPI tag sends, the higher the score (email + click-ID are highest priority; phone/country/external_id medium; name/city/zip low). So for CAPI, FIRST run create_meta_emq_variables (email_address, phone_number, fbp, fbc, event_id, …) so those variables exist to map into the tag\'s user-data. What you CAN do: check the web container with detect_meta_web_tags (is a Meta pixel / ecommerce purchase tag present?), and if so create the supporting Event Data variables with create_meta_emq_variables (fbp, fbc, event_id, value, currency, transaction_id, raw user_data for hashing) so the user just maps them into the CAPI tag. Do NOT claim you built the CAPI tag — only the variables. Consent on a server tag uses the SAME set_gtm_tag_consent as web tags. To CHECK a server container, call audit_server_container (a client must claim requests; server tags need their id + a firing trigger and must not be paused; a tagging URL must be set) — apply the same boundary discipline as the web audit — and verify_server_endpoint to confirm the deployed host actually answers (GET /healthy). IMPORTANT — separate config from deployment: the container\'s Tagging Server URL (taggingServerUrls) IS writable via the API — call set_server_container_tagging_url to record the server URL on the SERVER container (this clears the audit\'s "No tagging server URL" finding); do NOT tell the user it can only be set in the GTM UI. BUT writing the URL does NOT deploy the tagging-server HOST (Cloud Run / App Engine) — the user still provisions/deploys that themselves, and the host must be live (confirm with verify_server_endpoint; never claim the server is live until /healthy returns ok). The web→server link is a DIFFERENT call: set_web_server_container_url (the web Google tag id + the https server URL) points the web container at the server. ' +
          'TIKTOK EVENTS API (server-side): to forward events to TikTok server-side, use create_tiktok_capi_server_tag (Stape stape-io/tiktok-tag, match-quality-tuned: Event Enhancement + generate _ttp ON). Pass pixelId + accessToken (the TikTok Events Manager access token — usually {{variables}}) + event. This is the SERVER Events API tag and is DISTINCT from the TikTok WEB pixel (tiktok/gtm-template-pixel) — it uses different field keys (pixelId/accessToken/eventName, NOT the web pixel_code/event), so never hand-build it with the web keys. Standard TikTok events: Purchase, AddToCart, ViewContent, InitiateCheckout, CompleteRegistration, SubmitForm, Search, AddToWishlist, AddPaymentInfo, PlaceAnOrder, Download, Subscribe, Contact, ClickButton; GA4 names are mapped automatically (purchase→Purchase — NOT the legacy CompletePayment, which the template marks "Use Purchase instead"; add_to_cart→AddToCart, view_item→ViewContent, begin_checkout→InitiateCheckout, generate_lead→SubmitForm, sign_up→CompleteRegistration, file_download→Download); an unrecognised event becomes a TikTok custom event. MATCH QUALITY (TikTok\'s EMQ analogue): pass userData rows for advanced matching — name one of email/phone/external_id/ttclid/ttp/ip/user_agent/first_name/last_name/city/state/country/zip_code, values usually {{variables}} (email + phone + ttclid are highest-value; ttclid/ttp/ip/user_agent auto-collect from the incoming event when omitted). For deduplication with the web TikTok pixel, send the SAME eventId on both. ALWAYS pass eventProperties for the event (source each value from the container\'s matching variable; skip a property if no variable exists): Purchase → contents, content_type, value, currency, order_id (from {{transaction_id}}), description; ViewContent → content_type, contents, value, currency, description; AddToCart / AddToWishlist / AddPaymentInfo → contents, content_type, value, currency; InitiateCheckout → contents, content_type, value, currency, num_items; Search → query, content_type; Subscribe → value, currency, subscription_type; CompleteRegistration → registration_method; SubmitForm → form_name, value; Contact → contact_method; Download → file_name, file_type. Commerce keys (contents/content_type/value/currency/num_items/order_id/description/query) populate the TikTok customDataList; other keys go to additional properties — the tool routes them. Like Meta CAPI, this tag needs a SERVER trigger — create_server_trigger scoped to the client that claims the events — and pass its firingTriggerId. ' +
          'ENVIRONMENTS: the GTM API DOES manage environments — to create a Test/preview environment and return its install snippet (the container snippet plus gtm_auth, gtm_preview=env-<id>, gtm_cookies_win), call create_gtm_environment; to list existing environments with their tokens + snippets, list_gtm_environments. Never tell the user environments can only be set up in the GTM UI. Present the head and body install snippets each in their OWN fenced ``` code block (the head <script> and the body <noscript> separately) so they render as copyable code boxes — never inline a snippet as paragraph text. ' +
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
            'GA4 is READ-ONLY — you cannot apply fixes; give the user ' +
            'the exact change to make in the GA4 Admin UI. ' +
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
      dateContextLine(new Date()) +
      'Call tools when asked; never invent ids. When the user asks to list or count ' +
      'tags, triggers, variables, accounts, containers, or workspaces, the tools already ' +
      'return the COMPLETE paginated set — present EVERY item (a compact table is ideal) and ' +
      'never truncate, sample, or say "and more"; if a count is asked, count the full list. ' +
      'Put any code, install snippet, or multi-line technical output in a fenced ``` code block so it renders as a copyable code box. ' +
      'Be concise and factual. ' +
      'Style: do NOT use em dashes (the "—" character) anywhere in your replies; use commas, colons, parentheses, or a hyphen "-" instead.';

    const messages: LlmTurn[] = [
      ...history.map((h): LlmTurn => ({ role: h.role, text: h.text })),
      { role: 'user', text: message },
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
    const result = await runChat(client, { system, model: active.llm.model, apiKey, messages, signal }, tools, {
      // House style: never surface em dashes. Strip them from the live stream (a "—" is a single code
      // unit, so it can't span chunks) as a hard guarantee on top of the system-prompt instruction.
      onDelta: emit ? (delta) => emit({ type: 'text', delta: delta.replace(/—/g, '-') }) : undefined,
      onToolCall: (call) => {
        toolCalls.push({ name: call.name, args: call.args });
        emit?.({ type: 'tool', name: call.name });
      },
      onToolResult: emit ? (r) => emit({ type: 'tool_result', name: r.name, ok: r.ok, error: r.error }) : undefined,
    }, MAX_TOOL_STEPS);

    return { text: result.text.replace(/—/g, '-'), toolCalls };
  }
}
