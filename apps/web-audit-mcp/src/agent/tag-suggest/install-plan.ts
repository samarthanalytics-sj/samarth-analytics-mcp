// Phase 1 of the "measurement installation plan": the STRUCTURED, installable
// companion to a form SuggestedTag's human `note`. PURE — no browser, no MCP, no
// DOM. Given how a form submits (its mechanism) + the dataLayer event the
// suggested trigger fires on, this expresses the SITE-SIDE requirement — "what
// must exist for the trigger to actually fire" — as machine-readable data, and,
// wherever a reliable recipe exists, as an AUTO-CREATABLE GTM Custom HTML
// listener tag rather than the prose "add code to your site".
//
// The design goal: turn today's PROSE recipes (PROVIDER_EVENT_HINT + the note
// block in suggest.ts) into a small, testable model a later phase (Phase 3) can
// render as an installable checklist or even push the listener tags for.
//
// Listener-tag philosophy:
//   * Every listener template is SELF-CONTAINED (no external deps beyond an
//     OPTIONAL jQuery which each jQuery-based recipe guards for), guards
//     window.dataLayer, is safe to run on GTM's "All Pages" trigger, and is
//     wrapped in <script>…</script> so it drops straight into a Custom HTML tag.
//   * When a vendor's exact postMessage/DOM payload is NOT known with confidence,
//     we emit a 'site-code' requirement carrying a clearly-labelled TODO recipe
//     instead of shipping a WRONG listener that would silently never fire.

/** A single site-side requirement for a suggested tag's trigger to fire. */
export type InstallRequirement =
  // A native <form>/<a> element — GTM's built-in Form Submission / Link Click
  // trigger fires as-is, so NOTHING has to change on the site.
  | { kind: 'native'; detail: string }
  // The provider ALREADY pushes the dataLayer event (or GTM's native trigger
  // already sees it) — no listener needed, just point the trigger at it.
  | { kind: 'provider-native'; provider: string; detail: string }
  // An AUTO-CREATABLE GTM Custom HTML listener tag that pushes `event`. The
  // `tag.html` is a complete, self-contained <script> safe to run on All Pages;
  // `tag.fires` names the GTM trigger it should be attached to.
  | {
      kind: 'listener-tag';
      event: string;
      tag: { name: string; html: string; fires: 'all_pages' | 'dom_ready' | 'window_loaded' };
      detail: string;
      /** The custom_event trigger scope this listener MAKES POSSIBLE: the dataLayer {key,value} it
       *  actually pushes, so the trigger can AND `{{dlv - key}} equals value` and reliably fire. Set
       *  ONLY when the pushed value is knowable at scan time and equals the scanned id (the generic
       *  submit delegate, which pushes form_id = the form's own DOM id). Provider listeners push their
       *  OWN internal key/value we can't match, so they omit this and stay page-scoped. */
      dlvScope?: { key: string; value: string };
    }
  // Add a stable HTML attribute (e.g. a unique id on the <form>) so the trigger
  // can scope precisely via {{Form ID}}. A recommendation, not a hard blocker.
  | { kind: 'html-attribute'; selector: string; attribute: string; value: string; detail: string }
  // LAST RESORT: the site's own developer must add JS. Carries the exact snippet
  // + where it goes. Used when no reliable auto-listener recipe exists (an
  // unknown vendor's submit payload, a server-side-only completion, etc.).
  | { kind: 'site-code'; snippet: string; where: string; detail: string };

/** The structured installation plan attached to a form SuggestedTag. */
export interface InstallPlan {
  requires: InstallRequirement[];
  /** One-line, plain-English "what you must do". */
  summary: string;
}

/** How a detected form submits — the single fact that decides its plan:
 *   'native' = a real <form> whose GET/POST GTM's native Form Submission trigger sees;
 *   'embed'  = a cross-origin provider embed (HubSpot/Typeform/…) that submits in an iframe;
 *   'ajax'   = an on-page WordPress plugin form that preventDefaults + submits via AJAX;
 *   'js'     = a div/JS form (may or may not wrap a real <form> element). */
export type FormMechanism = 'native' | 'embed' | 'ajax' | 'js';

// ── Listener-template library ─────────────────────────────────────────────────
// Each template returns the FULL Custom HTML tag body (a single <script>). They
// are intentionally compact. `EVT` is the dataLayer event name the suggested
// custom_event trigger fires on; `SEL` (when used) is the form/button selector.

/** Open a dataLayer-guarding IIFE prologue shared by every template, so
 *  window.dataLayer is always initialised before a push. */
const DL = 'window.dataLayer=window.dataLayer||[];';

/** JSON-safe string literal for embedding an event name / selector inside the
 *  generated script (guards quotes/backslashes so a vendor id with a quote can't
 *  break out of the listener). */
const q = (s: string): string => JSON.stringify(String(s));

/**
 * Vendor-specific listeners. Each returns a self-contained <script> that pushes
 * `event` when the vendor signals a successful submit. Returns null when we do
 * NOT have a confident recipe for that vendor (the caller then emits site-code).
 */
type ListenerFn = (event: string, selector?: string) => string;

const LISTENERS: Partial<Record<string, ListenerFn>> = {
  // HubSpot fires a GLOBAL callback via a window 'message' event; the embed v2
  // posts { type:'hsFormCallback', eventName:'onFormSubmitted', id:<formId> }.
  hubspot: (event) =>
    `<script>(function(){${DL}window.addEventListener("message",function(e){` +
    `var d=e&&e.data;if(d&&d.type==="hsFormCallback"&&d.eventName==="onFormSubmitted"){` +
    `window.dataLayer.push({event:${q(event)},hs_form_id:d.id});}});})();</script>`,

  // Marketo: MktoForms2.whenReady → form.onSuccess. Returning true from onSuccess
  // preserves Marketo's own thankyou redirect; a caller who needs to STForm the
  // redirect (to let the tag fire first) should return false + navigate manually
  // (noted in the requirement detail, not baked into this minimal template).
  marketo: (event) =>
    `<script>(function(){${DL}if(!window.MktoForms2)return;` +
    `MktoForms2.whenReady(function(form){form.onSuccess(function(){` +
    `window.dataLayer.push({event:${q(event)},marketo_form_id:form.getId&&form.getId()});return true;});});})();</script>`,

  // Contact Form 7 fires the 'wpcf7mailsent' DOM event on a successful send.
  contactform7: (event) =>
    `<script>(function(){${DL}document.addEventListener("wpcf7mailsent",function(e){` +
    `window.dataLayer.push({event:${q(event)},form_id:e.detail&&e.detail.contactFormId});},false);})();</script>`,

  // Gravity Forms (AJAX, non-redirect) fires the jQuery 'gform_confirmation_loaded'
  // event with the form id as the 2nd arg. Needs jQuery — guarded.
  gravityforms: (event) =>
    `<script>(function(){${DL}if(!window.jQuery)return;` +
    `jQuery(document).on("gform_confirmation_loaded",function(e,formId){` +
    `window.dataLayer.push({event:${q(event)},form_id:formId});});})();</script>`,

  // Ninja Forms fires the jQuery 'nfFormSubmitResponse' event on submit. Needs
  // jQuery — guarded.
  ninjaforms: (event) =>
    `<script>(function(){${DL}if(!window.jQuery)return;` +
    `jQuery(document).on("nfFormSubmitResponse",function(e,response,formId){` +
    `window.dataLayer.push({event:${q(event)},form_id:formId});});})();</script>`,

  // WPForms (AJAX) dispatches the DOM event 'wpformsAjaxSubmitSuccess' on the
  // form element on a successful submit.
  wpforms: (event) =>
    `<script>(function(){${DL}document.addEventListener("wpformsAjaxSubmitSuccess",function(e){` +
    `var f=e&&e.target;window.dataLayer.push({event:${q(event)},form_id:f&&f.dataset&&f.dataset.formid});},false);})();</script>`,

  // Elementor Pro forms fire the jQuery 'submit_success' event on the document.
  // Needs jQuery (Elementor ships it) — guarded.
  elementor: (event) =>
    `<script>(function(){${DL}if(!window.jQuery)return;` +
    `jQuery(document).on("submit_success",function(){` +
    `window.dataLayer.push({event:${q(event)}});});})();</script>`,

  // Typeform posts { type:'form-submit' } (embed SDK) via window 'message'.
  typeform: (event) =>
    `<script>(function(){${DL}window.addEventListener("message",function(e){` +
    `var d=e&&e.data;if(d&&d.type==="form-submit"){window.dataLayer.push({event:${q(event)},typeform_id:d.formId});}});})();</script>`,

  // Calendly posts { event:'calendly.event_scheduled' } via window 'message'.
  calendly: (event) =>
    `<script>(function(){${DL}window.addEventListener("message",function(e){` +
    `var d=e&&e.data;if(d&&d.event==="calendly.event_scheduled"){window.dataLayer.push({event:${q(event)}});}});})();</script>`,
};

/**
 * The GENERIC native-ish listener: a CAPTURE-PHASE delegated 'submit' listener
 * for a JS/div form that DOES wrap a real <form> element. Fires for any submit
 * matching `selector` (defaults to every <form> when no selector is known),
 * pushing the event + the form's id. Safe on All Pages — the capture-phase
 * delegate catches submits even for forms added after load.
 */
function genericSubmitListener(event: string, selector?: string): string {
  const sel = selector && selector.trim() ? selector.trim() : 'form';
  return (
    `<script>(function(){${DL}document.addEventListener("submit",function(e){` +
    `var f=e.target;if(f&&f.matches&&f.matches(${q(sel)})){` +
    `window.dataLayer.push({event:${q(event)},form_id:f.id||""});}},true);})();</script>`
  );
}

/**
 * The GENERIC div/button listener: a delegated CLICK listener for a form that
 * has NO real <form> element (a pure div + button widget). Fires on a click on
 * anything matching the submit-button `selector`. Bubbling-phase delegation on
 * document, safe on All Pages.
 */
function genericClickListener(event: string, selector: string): string {
  const sel = selector && selector.trim() ? selector.trim() : "[type=submit],button";
  return (
    `<script>(function(){${DL}document.addEventListener("click",function(e){` +
    `var t=e.target&&e.target.closest?e.target.closest(${q(sel)}):null;if(t){` +
    `window.dataLayer.push({event:${q(event)}});}},false);})();</script>`
  );
}

/**
 * Public: the Custom HTML tag body for a provider's success listener, or null
 * when we have no confident recipe (caller emits a site-code TODO instead). Also
 * routes the two GENERIC mechanisms: 'generic-submit' (has a real <form>) and
 * 'generic-click' (div/button, no <form>).
 */
export function formListenerHtml(provider: string, event: string, selector?: string): string | null {
  if (provider === 'generic-submit') return genericSubmitListener(event, selector);
  if (provider === 'generic-click') return genericClickListener(event, selector || '');
  const fn = LISTENERS[provider];
  return fn ? fn(event, selector) : null;
}

/** Providers that submit CROSS-ORIGIN inside an embed but whose exact success
 *  payload we do NOT confidently model — emit a labelled site-code TODO instead
 *  of a wrong listener. (Pardot completes via a redirect; the rest post
 *  vendor-specific messages we don't hardcode.) */
const UNKNOWN_PAYLOAD_VENDORS = new Set<string>([
  'paperform', 'jotform', 'tally', 'pardot', 'formstack', 'googleforms', 'wufoo', 'mailchimp',
]);

/** Human-readable provider name for detail strings / tag names. */
function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    hubspot: 'HubSpot', marketo: 'Marketo', contactform7: 'Contact Form 7',
    gravityforms: 'Gravity Forms', ninjaforms: 'Ninja Forms', wpforms: 'WPForms',
    elementor: 'Elementor', typeform: 'Typeform', calendly: 'Calendly',
    paperform: 'Paperform', jotform: 'JotForm', tally: 'Tally', pardot: 'Pardot',
    formstack: 'Formstack', googleforms: 'Google Forms', wufoo: 'Wufoo',
    mailchimp: 'Mailchimp',
  };
  return map[provider] ?? (provider ? provider[0].toUpperCase() + provider.slice(1) : provider);
}

/** The html-attribute requirement recommending a stable id for {{Form ID}} scoping. */
function stableIdRequirement(): InstallRequirement {
  return {
    kind: 'html-attribute',
    selector: 'form',
    attribute: 'id',
    value: '<a-unique-id>',
    detail:
      'This form has no unique id, so a Form Submission trigger cannot scope to it precisely. ' +
      'Add a stable, unique id attribute to the <form> element and switch the trigger to {{Form ID}} equals that id.',
  };
}

/**
 * Map a form's mechanism → its install requirement(s).
 *
 * @param input.provider          the detected FormProvider vendor (or 'unknown').
 * @param input.mechanism         how the form submits (native/embed/ajax/js).
 * @param input.dlEvent           the dataLayer event the suggested custom_event
 *                                trigger fires on, or null for a native form.
 * @param input.formId            the form's own id, when present (drives scoping).
 * @param input.selector          a CSS selector for the form / submit button (js forms).
 * @param input.formHasNativeForm whether a real <form> element exists (a js form
 *                                may wrap one → generic submit delegate; else →
 *                                generic click delegate on the button).
 */
export function buildFormInstallPlan(input: {
  provider: string;
  mechanism: FormMechanism;
  dlEvent: string | null;
  formId?: string;
  selector?: string;
  formHasNativeForm: boolean;
}): InstallPlan {
  const { provider, mechanism, dlEvent, formId, selector, formHasNativeForm } = input;
  const requires: InstallRequirement[] = [];

  // ── NATIVE: GTM's built-in Form Submission trigger fires as-is ──────────────
  if (mechanism === 'native') {
    requires.push({
      kind: 'native',
      detail:
        "This is a native <form> whose submit GTM's built-in Form Submission trigger detects — " +
        'no site change is needed for the tag to fire.',
    });
    // Recommend a stable id for precise scoping when the form has none.
    if (!formId) requires.push(stableIdRequirement());
    return {
      requires,
      summary: formId
        ? 'Native form — nothing to install.'
        : 'Native form — nothing to install (add a unique id for precise scoping).',
    };
  }

  // ── EMBED / AJAX / JS with a dataLayer event → a listener is required ────────
  const event = dlEvent ?? 'form_submit';

  // Pick the listener source: a known provider recipe, else a generic delegate
  // (submit for a real <form>, click for a div/button), else site-code TODO.
  let html: string | null = null;
  let listenerProvider = provider;

  if (!UNKNOWN_PAYLOAD_VENDORS.has(provider) && LISTENERS[provider]) {
    html = formListenerHtml(provider, event, selector);
  } else if (provider === 'unknown' || (mechanism === 'js' && !LISTENERS[provider])) {
    // No provider recipe: fall back to a generic delegated listener when we can
    // (a js/native-ish form), keyed on whether a real <form> element exists.
    if (formHasNativeForm) {
      listenerProvider = 'generic-submit';
      html = formListenerHtml('generic-submit', event, selector);
    } else if (selector) {
      listenerProvider = 'generic-click';
      html = formListenerHtml('generic-click', event, selector);
    }
  }

  if (html) {
    requires.push({
      kind: 'listener-tag',
      event,
      tag: {
        name:
          listenerProvider.startsWith('generic')
            ? `cust - Form listener (${event})`
            : `cust - ${providerLabel(provider)} form listener`,
        html,
        // All listeners are safe on All Pages (they attach at load and delegate).
        fires: 'all_pages',
      },
      detail:
        listenerProvider.startsWith('generic')
          ? `A Custom HTML tag firing on All Pages adds a delegated ${formHasNativeForm ? 'submit' : 'click'} listener that ` +
            `pushes dataLayer.push({event:"${event}"}) when this form is submitted, so the Custom Event trigger fires.`
          : `${providerLabel(provider)} submits ${mechanism === 'embed' ? 'in an iframe / cross-origin' : 'via AJAX'}, so GTM's ` +
            `native Form Submission trigger will not fire. This auto-creatable Custom HTML listener pushes ` +
            `dataLayer.push({event:"${event}"}) on the provider's success signal, and the tag fires on that Custom Event.` +
            (provider === 'marketo'
              ? ' (If Marketo redirects on success, have onSuccess return false and navigate manually so the tag fires first.)'
              : ''),
      // The generic SUBMIT delegate pushes `form_id: <the form's DOM id>` (guarded by the selector), so
      // the trigger can scope `{{dlv - form_id}} equals <formId>` and match. Provider / generic-click
      // listeners push a different key/value (or none), so they get NO dlvScope and stay page-scoped.
      ...(listenerProvider === 'generic-submit' && formId ? { dlvScope: { key: 'form_id', value: formId } } : {}),
    });
  } else {
    // No confident recipe → a labelled site-code TODO (never a wrong listener).
    const label = providerLabel(provider);
    requires.push({
      kind: 'site-code',
      where:
        mechanism === 'embed'
          ? "the site's page template (near where the embed loads)"
          : "the form's submit / success handler",
      snippet:
        `<script>\n` +
        `  // TODO: ${label} — push this on a SUCCESSFUL submit.\n` +
        `  // Replace the listener below with ${label}'s documented success hook\n` +
        `  // (window 'message' payload, callback, or redirect to a thank-you URL).\n` +
        `  window.dataLayer = window.dataLayer || [];\n` +
        `  // e.g. on success: window.dataLayer.push({ event: ${q(event)} });\n` +
        `</script>`,
      detail:
        `${label} submits ${mechanism === 'embed' ? 'inside a cross-origin embed' : 'without a recipe we can safely auto-generate'}, ` +
        `and its exact success payload is not modelled here, so we do NOT ship a listener that might silently never fire. ` +
        `A developer must push dataLayer.push({event:"${event}"}) on a confirmed submit, then the Custom Event trigger fires.`,
    });
  }

  // For AJAX plugins that DO carry a readable {{Form ID}} on the native form,
  // recommend a stable id so a NON-AJAX fallback (native Form Submission trigger)
  // can scope precisely; for embed/js with no id at all, recommend one too.
  if (!formId && (mechanism === 'ajax' || mechanism === 'js')) {
    requires.push(stableIdRequirement());
  }

  const listenerCount = requires.filter((r) => r.kind === 'listener-tag').length;
  const summary =
    listenerCount > 0
      ? `Auto-create ${listenerCount} Custom HTML listener tag${listenerCount > 1 ? 's' : ''}; no site code needed.`
      : 'A developer must add a dataLayer push on submit (no reliable auto-listener for this provider).';

  return { requires, summary };
}

// ── Generic (non-form) trigger install plan ───────────────────────────────────
// buildFormInstallPlan (above) is the rich, form-specific model. buildTriggerInstallPlan is the
// FALLBACK for every OTHER SuggestedTag kind, so the "How to install" panel is meaningful on every
// suggestion — a reassuring "✓ native, nothing to install" for the triggers GTM fires natively
// (clicks/timer/pageview/video/native-form), and the PRECISE dataLayer contract for a custom_event tag
// whose event the SITE must push (ecommerce funnel + custom interactions). PURE — string-building only.

/** The standard GA4 ecommerce events, whose dataLayer push must carry the GA4 `ecommerce` object
 *  (items[], value, currency, transaction_id for purchase). A custom_event with one of these names gets
 *  the ecommerce-shaped snippet + note. */
const ECOMMERCE_EVENT_NAMES = new Set<string>([
  'view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase',
  'view_item_list', 'select_item', 'view_cart', 'remove_from_cart', 'refund',
]);

/** Human-readable native-trigger detail, per SuggestedTag trigger kind. */
const NATIVE_TRIGGER_DETAIL: Record<string, string> = {
  link_click:
    "GTM's built-in Click - Just Links trigger fires on the link click; no site change needed.",
  all_clicks:
    "GTM's Click - All Elements trigger fires on the click; no site change needed.",
  pageview: "fires on GTM's All Pages / Page View trigger.",
  timer: "fires on GTM's Timer trigger.",
  youtube_video:
    "GTM's built-in YouTube Video trigger fires; enable the YouTube Video built-in variables.",
  form_submit:
    "GTM's built-in Form Submission trigger fires on the native <form> submit.",
};

/** Human label for a native trigger kind, used in the one-line summary ("Native Link Click — …"). */
const NATIVE_TRIGGER_LABEL: Record<string, string> = {
  link_click: 'Link Click',
  all_clicks: 'All-Elements Click',
  pageview: 'Page View',
  timer: 'Timer',
  youtube_video: 'YouTube Video',
  form_submit: 'Form Submission',
};

/**
 * The install plan for a NON-form suggestion, derived purely from its trigger kind (+ the dataLayer
 * event name for a custom_event). This is the generic companion to buildFormInstallPlan:
 *
 *   - NATIVE kinds (link_click / all_clicks / pageview / timer / youtube_video / form_submit) →
 *     a single `native` requirement — GTM's built-in trigger fires as-is, nothing to install.
 *   - custom_event → a `site-code` requirement: GA4/GTM does NOT auto-collect the event, so the site
 *     must push it to the dataLayer. For a standard GA4 ecommerce event the snippet + note require the
 *     GA4 `ecommerce` object; for any other custom event the snippet is the bare event push.
 */
export function buildTriggerInstallPlan(input: { kind: string; eventName?: string; label?: string }): InstallPlan {
  const { kind } = input;

  // ── NATIVE trigger kinds — GTM's built-in trigger fires, no site change ──────
  if (kind in NATIVE_TRIGGER_DETAIL) {
    return {
      requires: [{ kind: 'native', detail: NATIVE_TRIGGER_DETAIL[kind] }],
      summary: `Native ${NATIVE_TRIGGER_LABEL[kind] ?? kind} — nothing to install.`,
    };
  }

  // ── custom_event — the site (or its platform) MUST push this dataLayer event ──
  if (kind === 'custom_event') {
    const event = input.eventName && input.eventName.trim() ? input.eventName.trim() : 'custom_event';
    const isEcommerce = ECOMMERCE_EVENT_NAMES.has(event);
    // A purchase carries transaction_id in addition to items/value/currency; other ecommerce events
    // just need items/value/currency. The snippet shows the shape; the note names the required fields.
    const ecommerceInner =
      event === 'purchase'
        ? ` ecommerce:{ transaction_id:"…", value:0, currency:"USD", items:[…] }`
        : ` ecommerce:{ value:0, currency:"USD", items:[…] }`;
    const snippet = isEcommerce
      ? `<script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:${q(event)},${ecommerceInner}});</script>`
      : `<script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:${q(event)}});</script>`;
    const detail =
      `GA4/GTM does not auto-collect the "${event}" event — your site (or its platform) must push it to the ` +
      `dataLayer when this interaction happens, then this Custom Event trigger fires.` +
      (isEcommerce
        ? ` As a standard GA4 ecommerce event it must include the GA4 ecommerce object (items[], value, currency` +
          (event === 'purchase' ? ', transaction_id' : '') +
          `).`
        : '');
    return {
      requires: [
        {
          kind: 'site-code',
          snippet,
          where: "your site's code where the interaction completes (e.g. the ecommerce/dataLayer layer)",
          detail,
        },
      ],
      summary: `Your site must push the "${event}" dataLayer event (code required).`,
    };
  }

  // ── Unknown kind — treat as native-ish (no known site requirement) so the panel is never empty. ──
  return {
    requires: [{ kind: 'native', detail: `fires on GTM's ${kind} trigger; no site change needed.` }],
    summary: `Native ${kind} — nothing to install.`,
  };
}
