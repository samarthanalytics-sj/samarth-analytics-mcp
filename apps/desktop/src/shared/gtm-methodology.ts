// Shared GA4/GTM measurement methodology, used by BOTH LLM surfaces so they stay consistent with each
// other AND with the deterministic tag-suggestion engine:
//   - GA4_EVENT_SELECTION: what user intent maps to which GA4 event, and what to skip. Used by the
//     AI-vision tag scan (which PICKS events) and included in the full creation methodology.
//   - GTM_CREATION_METHODOLOGY: the above + how to actually BUILD tags/triggers/variables via the
//     create_gtm_* tools. Used by the chat brain (which CREATES resources).
// The deterministic scanner (buildSuggestions) already implements these rules in code; these strings
// keep the LLM paths aligned with it. Framework-free (pure strings) so both callers can import safely.

export const GA4_EVENT_SELECTION =
  'GA4 EVENT SELECTION — measure user INTENT with GA4 recommended/standard events (raw snake_case names), and skip noise. ' +
  'TRACK: form submissions (a lead/contact/newsletter/signup form → generate_lead or form_submission); key CTA/button clicks ' +
  '(a specific event per intent — book_demo_click, request_quote_click, contact_sales_click, get_started_click, subscribe_click, ' +
  'add_to_cart_click — or a generic cta_click for any other prominent conversion button); email_click (mailto:), phone_click ' +
  '(tel:), file_download (pdf/doc/zip links), outbound_click (external links); video engagement (video_start / video_progress / ' +
  'video_complete); and ecommerce events (view_item, add_to_cart, begin_checkout, purchase, …) on transactional pages. ' +
  'SKIP — these are NOT conversions: primary navigation / menu links, cookie-consent / CMP controls (Accept all, Reject all, ' +
  'Manage preferences), pure UI chrome (menu, close, toggle, pagination next/prev, show more), and social-share widgets unless ' +
  'the user asks. An event NAME is ALWAYS the raw snake_case value the dataLayer/GA4 uses (purchase, add_to_cart, generate_lead, ' +
  'file_download) — never a display label. ';

export const GTM_CREATION_METHODOLOGY =
  GA4_EVENT_SELECTION +
  'GTM CREATION METHODOLOGY — build tags, triggers, and variables ONLY via the create_gtm_* tools (never hand-write GTM API JSON; ' +
  'the builders produce valid resources). OBJECT MODEL + ORDER: a Tag fires on Trigger(s); a Trigger filters on Variables; create ' +
  'dependencies FIRST — variables → triggers → tag. For a standard GA4 event, PREFER create_gtm_tracking_tag: it creates the tag, ' +
  'its trigger, and any missing built-in / data-layer variables together, correctly wired. Before creating, LIST/AUDIT the ' +
  'container to reuse a matching trigger/variable and to avoid duplicate tag names. ' +
  'TRIGGERS by intent: link/CTA click → link_click or all_clicks filtered on {{Click URL}} and/or {{Click Text}} (never an ' +
  'unfiltered all-clicks — it over-fires); form submit → form_submit scoped to ONE form via {{Form ID}} (equals) or a unique ' +
  '{{Form Classes}} (contains), else {{Page Path}} for the single page it lives on, else unscoped ONLY as a deliberate site-wide ' +
  'catch-all — leave waitForTags/checkValidation OFF; a native form trigger does NOT fire for iframe/AJAX forms (instead listen ' +
  'for the provider submit event → push a dataLayer event → fire on a Custom Event trigger); dataLayer event → custom_event whose ' +
  'EVENT NAME is the raw snake_case value the dataLayer pushes (distinct from the trigger display name); pageview; youtube_video; ' +
  'timer (its interval/limit/eventName are TOP-LEVEL trigger fields, not parameter[]). ' +
  'VARIABLES: Data Layer Variable (kind data_layer, dataLayerName = the exact key, e.g. ecommerce.value); constant; built-ins ' +
  '({{Click URL}}, {{Form ID}}, {{Page Path}}, …) are ENABLED, not created — create_gtm_tracking_tag enables the ones its trigger ' +
  'needs; always create a referenced variable BEFORE the trigger/tag that reads it. ' +
  'GA4 EVENT TAG: type gaawe; event parameters go in eventSettingsTable (not eventParameters); measurementId = {{GA4 Measurement ID}}; ' +
  'for ecommerce build the parameters from the GA4 ecommerce reference, each value reading {{Ecommerce <param>}} off the dataLayer. ' +
  'STANDARD EVENT PARAMETERS: a click/CTA tag sends click_text ({{Click Text}}), click_url ({{Click URL}}), page_url ({{Page URL}}), previous_page ({{Referrer}}); a form tag sends form_id ({{Form ID}}), form_name (the form name), page_url, previous_page. ' +
  'TRIGGER CONDITIONS must be EXACT — tell GTM precisely WHEN to fire: a click/CTA trigger matches {{Click Text}} EQUALS the exact button label (not contains, which would also fire on a longer label); scope a page-specific trigger (a form that lives on only one page, or a Thank-You / confirmation page) with {{Page Path}} (or {{Page URL}}) CONTAINS the path fragment — e.g. Page Path contains "/request-demo", or a Thank-You page is Page URL contains "/purchase-successful/". That path condition is how you say "fire ONLY on this page" rather than on every page. ' +
  'GOTCHAS: always go through the builders (container exports use UPPER_SNAKE enums, the API takes camelCase); moving to a folder ' +
  'with an empty array 500s; retry on quota errors; folders, environments, and versions ARE API-supported. ' +
  'WORKFLOW per request: (1) restate the intent + the GA4 event it maps to; (2) audit/list for reusable triggers/variables and dup ' +
  'names; (3) create missing variables, then the trigger, then the tag (or one create_gtm_tracking_tag call); (4) report EXACTLY ' +
  'what was created and that nothing is published; (5) if a trigger cannot reliably fire (iframe/AJAX form, SPA route), say so and ' +
  'give the dataLayer / Custom-Event alternative rather than a tag that silently will not fire. Name tags/triggers per the GA4 ' +
  'naming convention already specified above. ';
