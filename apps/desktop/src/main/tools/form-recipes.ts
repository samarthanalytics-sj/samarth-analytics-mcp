// Ready-to-create GTM "recipe" for tracking an AJAX WordPress form plugin END TO END: a Custom HTML
// LISTENER tag (fires on the plugin's own submit event and dataLayer.pushes a Custom Event) + a GA4
// event tag that fires on that Custom Event. This is what makes the Custom-Event trigger our scanner
// recommends for CF7 / Gravity / Ninja / WPForms / Elementor actually FIRE — a plain form-submit
// trigger never does (these plugins preventDefault + submit via AJAX).
//
// PURE data: the chat tool hands `listenerTag`/`ga4Tag` straight to create_gtm_tracking_tag (which
// already supports platform 'custom_html' + 'ga4_event' on a custom_event trigger). Draft-only, gated.
// Listener snippets use each plugin's documented submit hook (the canonical GTM-community pattern).

export type AjaxFormProvider = 'contactform7' | 'gravityforms' | 'ninjaforms' | 'wpforms' | 'elementor';

export const AJAX_FORM_PROVIDERS_LIST: AjaxFormProvider[] = ['contactform7', 'gravityforms', 'ninjaforms', 'wpforms', 'elementor'];

interface ListenerSpec {
  label: string;
  /** dataLayer event the listener pushes (what the GA4 tag's Custom Event trigger matches). */
  event: string;
  requiresJquery: boolean;
  /** Human description of the plugin's submit hook. */
  hook: string;
  html: (dlEvent: string) => string;
}

const DL = 'window.dataLayer = window.dataLayer || [];';

const LISTENERS: Record<AjaxFormProvider, ListenerSpec> = {
  contactform7: {
    label: 'Contact Form 7',
    event: 'cf7submission',
    requiresJquery: false,
    hook: 'the wpcf7mailsent DOM event (fired on a successful submit)',
    html: (ev) =>
      `<script>\ndocument.addEventListener('wpcf7mailsent', function(e){\n  ${DL}\n  window.dataLayer.push({ event: '${ev}', form_id: e.detail && e.detail.contactFormId });\n}, false);\n</script>`,
  },
  gravityforms: {
    label: 'Gravity Forms',
    event: 'gravityFormSubmission',
    requiresJquery: true,
    hook: 'the gform_confirmation_loaded jQuery event (AJAX-enabled, non-redirect forms)',
    html: (ev) =>
      `<script>\n(function($){\n  $(document).on('gform_confirmation_loaded', function(e, formId){\n    ${DL}\n    window.dataLayer.push({ event: '${ev}', form_id: formId });\n  });\n})(jQuery);\n</script>`,
  },
  ninjaforms: {
    label: 'Ninja Forms',
    event: 'ninjaFormSubmission',
    requiresJquery: true,
    hook: 'the nfFormSubmitResponse jQuery event',
    html: (ev) =>
      `<script>\n(function($){\n  $(document).on('nfFormSubmitResponse', function(e, response, id){\n    ${DL}\n    window.dataLayer.push({ event: '${ev}', form_id: id });\n  });\n})(jQuery);\n</script>`,
  },
  wpforms: {
    label: 'WPForms',
    event: 'wpformsSubmission',
    requiresJquery: true,
    hook: 'the wpformsAjaxSubmitSuccess jQuery event (AJAX-enabled forms)',
    html: (ev) =>
      `<script>\n(function($){\n  $(document).on('wpformsAjaxSubmitSuccess', function(e){\n    ${DL}\n    window.dataLayer.push({ event: '${ev}' });\n  });\n})(jQuery);\n</script>`,
  },
  elementor: {
    label: 'Elementor',
    event: 'elementorFormSubmission',
    requiresJquery: true,
    hook: 'the submit_success jQuery event (Elementor Pro forms)',
    html: (ev) =>
      `<script>\n(function($){\n  $(document).on('submit_success', function(e){\n    ${DL}\n    window.dataLayer.push({ event: '${ev}' });\n  });\n})(jQuery);\n</script>`,
  },
};

export interface FormTrackingRecipe {
  provider: AjaxFormProvider;
  providerLabel: string;
  /** The dataLayer Custom Event the whole recipe hinges on. */
  dataLayerEvent: string;
  requiresJquery: boolean;
  /** Step-by-step, for the chat assistant to relay. */
  guide: string[];
  /** Pass straight to create_gtm_tracking_tag — create this FIRST (it must load before a submit). */
  listenerTag: { platform: 'custom_html'; tagName: string; html: string; trigger: { name: string; kind: 'pageview' } };
  /** Pass straight to create_gtm_tracking_tag — fires on the listener's Custom Event. */
  ga4Tag: {
    platform: 'ga4_event';
    tagName: string;
    eventName: string;
    measurementId?: string;
    trigger: { name: string; kind: 'custom_event'; eventName: string };
  };
}

/**
 * Build the complete two-tag recipe for an AJAX form plugin, or null if the provider isn't one we
 * have a listener for. `eventName` is the GA4 event to send (default form_submission); `measurementId`
 * is the G-XXXX (or {{variable}}) for the GA4 tag.
 */
export function formTrackingRecipe(provider: string, opts: { eventName?: string; measurementId?: string } = {}): FormTrackingRecipe | null {
  const spec = LISTENERS[provider as AjaxFormProvider];
  if (!spec) return null;
  const ga4Event = (opts.eventName ?? '').trim() || 'form_submission';
  const dlEvent = spec.event;
  const listenerTag = {
    platform: 'custom_html' as const,
    tagName: `cHTML - ${spec.label} listener`,
    html: spec.html(dlEvent),
    trigger: { name: 'All Pages', kind: 'pageview' as const },
  };
  const ga4Tag = {
    platform: 'ga4_event' as const,
    tagName: `GA4 - Event - ${spec.label} form submission`,
    eventName: ga4Event,
    ...(opts.measurementId && opts.measurementId.trim() ? { measurementId: opts.measurementId.trim() } : {}),
    trigger: { name: `custom - ${dlEvent}`, kind: 'custom_event' as const, eventName: dlEvent },
  };
  const guide = [
    `${spec.label} submits via AJAX, so GTM's native Form Submission trigger won't fire — set up TWO tags:`,
    `1) Listener (Custom HTML, All Pages): "${listenerTag.tagName}" — listens for ${spec.hook} and dataLayer.pushes { event: "${dlEvent}" }.${spec.requiresJquery ? ' Requires jQuery on the site.' : ''} Create this FIRST.`,
    `2) GA4 event tag "${ga4Tag.tagName}" firing on a Custom Event trigger where Event = "${dlEvent}", sending the "${ga4Event}" event.`,
    `Create BOTH with create_gtm_tracking_tag (pass the listenerTag then the ga4Tag object). Draft-only — review + publish in GTM, and confirm a real submit in GTM Preview.`,
  ];
  return { provider: provider as AjaxFormProvider, providerLabel: spec.label, dataLayerEvent: dlEvent, requiresJquery: spec.requiresJquery, guide, listenerTag, ga4Tag };
}
