// The suggestion mapper: detected forms + elements → SuggestedTag[]. PURE +
// unit-tested. Encodes the "what GTM tag should exist for this?" rules, including
// the key nuance that GA4 Enhanced Measurement already auto-tracks some of these
// (outbound clicks, file downloads) — those are FLAGGED, not blindly pushed, so
// we don't suggest redundant tags. Output is directly creatable via the existing
// create_gtm_tracking_tag tool.

import type { DetectedForm, DetectedElement, SuggestInput, SuggestedTag, FormProvider } from './types.js';
import { CTA_BY_INTENT } from './cta-intents.js';
import { buildSocialUrlPattern } from './social.js';

const GA4_VAR = '{{GA4 Measurement ID}}';
// Event-parameter VALUES are GTM built-in variables, so the tag captures the
// actual clicked link / submitted form at runtime (not a value baked in at scan
// time). The create flow enables whichever of these the parameters reference.
const CLICK_URL = '{{Click URL}}';
const CLICK_TEXT = '{{Click Text}}';
const FORM_ID = '{{Form ID}}';
const FORM_URL = '{{Form URL}}';
const FORM_TEXT = '{{Form Text}}'; // the submit-button text ≈ GA4 form_submit_text
// Page context on every suggested event. GA4 ALREADY auto-collects the full
// page_location + page_title on every event, so we add the path and the referrer
// ("previous page") rather than duplicating those.
const PAGE_PARAMS = [
  { name: 'page_path', value: '{{Page Path}}' },
  { name: 'page_referrer', value: '{{Referrer}}' },
];
/** Standard GA4 click params — what was clicked, its text, and page context. */
const CLICK_PARAMS = [
  { name: 'link_url', value: CLICK_URL },
  { name: 'link_text', value: CLICK_TEXT },
  ...PAGE_PARAMS,
];
// Single source of truth for "what's a downloadable file" — the collector's
// detection regex and this GTM trigger filter are both built from it, so a
// detected download always matches the tag we suggest for it.
export const DOWNLOAD_EXT = 'pdf|zip|docx?|xlsx?|pptx?|csv|dmg|exe|rar|7z|mp4|mp3|pkg|apk';
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// GTM rejects some characters in resource names (notably ":"), which fails tag
// creation ("name contains invalid character"). Strip them so a name built from
// scraped page text (a CTA label) is always creatable. Mirrors gtm-builders
// sanitizeName (defence-in-depth at the create boundary).
const clean = (s: string): string => s.replace(/[<>:]/g, ' ').replace(/\s{2,}/g, ' ').trim();
// Naming convention: tags read "GA4 Event - <Name> Tag"; triggers read
// "<Action> Trigger" (no "All Clicks -"/"Link Click -" prefix, no "Click" suffix).
const tagNameOf = (label: string): string => clean(`GA4 Event - ${label} Tag`);
const trigNameOf = (action: string): string => clean(`${action} Trigger`);

// Human-readable label for a GA4 event name, used in tag names (elements only —
// forms use FORM_LABEL, CTAs use their intent label).
const EVENT_LABEL: Record<string, string> = {
  email_click: 'Email Click',
  phone_click: 'Phone Click',
  file_download: 'File Download',
  outbound_click: 'Outbound Click',
  social_click: 'Social Media Click',
  cta_click: 'CTA Click',
};
const eventLabel = (e: string): string => EVENT_LABEL[e] ?? e.split('_').map(cap).join(' ');

// Form purpose → human tag/trigger label ("Contact Form", "Newsletter Form").
const FORM_LABEL: Record<string, string> = {
  contact: 'Contact Form',
  signup: 'Signup Form',
  newsletter: 'Newsletter Form',
  other: 'Form Submission',
};

// djb2 → base36; stable, no crypto dependency.
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Form purpose → GA4 event. Descriptive, form-specific event names.
const FORM_EVENT: Record<string, string> = {
  contact: 'contact_form',
  signup: 'signup_form',
  newsletter: 'newsletter_form',
  // NOT "form_submit": that's the reserved name GA4 Enhanced Measurement's form
  // interactions emits, so reusing it would double-count.
  other: 'form_submission',
};

// Providers whose form submits inside an iframe / via AJAX — GTM's NATIVE Form
// Submission trigger won't fire for these; they need a Custom Event listener.
const EMBED_PROVIDERS = new Set<FormProvider>(['hubspot', 'paperform', 'typeform', 'marketo', 'pardot']);
const PROVIDER_EVENT_HINT: Partial<Record<FormProvider, string>> = {
  hubspot: 'HubSpot fires a global submit callback (hsFormCallback / window message)',
  paperform: 'Paperform posts a window message on submit',
  typeform: 'Typeform posts a window message on submit',
  marketo: 'Marketo fires MktoForms2().onSuccess',
  pardot: 'Pardot redirects to a thank-you/completion URL on submit',
};

// Framework/wrapper classes shared by EVERY form of a stack — useless (harmful)
// for scoping a trigger to ONE form. Never used as a {{Form Classes}} filter.
const GENERIC_FORM_CLASS = /^(form|form-(wrapper|container|inner|inline|horizontal|vertical|group|control|row|inputs?|fields?|signin|signup|stacked)|wpforms-(form|container|validate)|wpcf7(-form)?|gform_wrapper|hs-form|hbspt-form|mc4wp-form|mc-field-group|needs-validation|was-validated|elementor-form|nf-form|frm-show-form|et_pb_contact_form)$/i;

/** A class that reliably scopes to ONE form — i.e. a form-ish class carrying a
 *  numeric instance id (gform_1, mktoForm_521, form-42). Bare/wrapper classes are
 *  rejected (they're shared across all forms of a stack → would over-fire).
 *  Returns null if none → the caller warns "fires on every form". */
function pickFormClass(classes?: string): string | null {
  if (!classes) return null;
  for (const c of classes.split(/\s+/).filter(Boolean)) {
    if (GENERIC_FORM_CLASS.test(c)) continue;
    if (/form/i.test(c) && /\d/.test(c) && c.length >= 5) return c;
  }
  return null;
}

/** Stable per-form signature (purpose + field shape + action) — two forms with
 *  the SAME id but different signatures are DIFFERENT forms sharing a non-unique
 *  id, so that id can't scope a trigger. NEVER includes entered values. */
function formSignature(f: DetectedForm): string {
  const fields = (f.fields ?? [])
    .map((x) => `${x.type}:${x.name}`)
    .sort()
    .join(',');
  return `${f.purpose}|${fields}|${f.action}`;
}

interface FormScopeCtx {
  nonUniqueIds: Set<string>;
  nonUniqueClasses: Set<string>;
}

function formSuggestion(f: DetectedForm, ctx: FormScopeCtx): SuggestedTag | null {
  // Skip: search/login submits aren't conversions; checkout is ECOMMERCE — it
  // needs the dataLayer (begin_checkout/purchase), not a form-submit tag, so it's
  // deferred to the v3 ecommerce phase rather than mis-suggested here.
  if (f.purpose === 'search' || f.purpose === 'login' || f.purpose === 'checkout') return null;
  const eventName = FORM_EVENT[f.purpose] ?? 'form_submission';
  const formLabel = FORM_LABEL[f.purpose] ?? 'Form Submission';
  const prov = f.provider.vendor !== 'unknown' ? ` (${f.provider.vendor})` : '';

  // Scope the trigger to THIS form via its id (preferred) or an instance-unique
  // class — but ONLY if that id/class isn't shared with another form (else it
  // would fire for both). Otherwise it stays unscoped (fires on every form).
  const trigger: SuggestedTag['trigger'] = { name: trigNameOf(formLabel), kind: 'form_submit' };
  const rawClass = pickFormClass(f.formClasses);
  const idUnique = !!f.formId && !ctx.nonUniqueIds.has(f.formId);
  const classUnique = !!rawClass && !ctx.nonUniqueClasses.has(rawClass);
  let usedClass: string | null = null;
  if (idUnique) {
    trigger.formIdValue = f.formId;
    trigger.formIdOperator = 'equals';
  } else if (classUnique) {
    trigger.formClassesValue = rawClass!;
    trigger.formClassesOperator = 'contains';
    usedClass = rawClass;
  }

  // Flag the cases where the trigger won't fire / won't scope correctly.
  // Pardot's form-HANDLER mode is a native <form> POST the native trigger handles
  // — only its iframe-embed mode (method 'js' / no native form) needs a listener.
  const isEmbed =
    EMBED_PROVIDERS.has(f.provider.vendor) &&
    !(f.provider.vendor === 'pardot' && (f.method === 'post' || f.method === 'get'));
  let note: string | undefined;
  if (isEmbed) {
    note = `${cap(f.provider.vendor)} submits in an iframe / via AJAX — GTM's native Form Submission trigger usually won't fire. Track it with a Custom Event trigger: ${PROVIDER_EVENT_HINT[f.provider.vendor] ?? 'listen for the provider submit event'} → push a dataLayer event → fire this tag on it.`;
  } else if (f.method === 'js') {
    note = `JS/div form (no native <form> submit) — GTM's Form Submission trigger may not fire. Use an All-Clicks trigger on the submit button, or a Custom Event from the form's submit handler.`;
  } else if ((f.formId && !idUnique) || (rawClass && !classUnique)) {
    const what = f.formId && !idUnique ? `id "#${f.formId}"` : `class ".${rawClass}"`;
    note = `Another form on the site shares this ${what}, so this trigger will also fire for that form (double-counting). Give each <form> a unique id to scope it.`;
  } else if (!trigger.formIdValue && !trigger.formClassesValue) {
    note = `This form has no id or unique class, so the trigger fires on EVERY form submit on the page. Add an id to the <form> to scope it.`;
  }

  // Field signature (type/name only — never values) for the evidence line.
  const sig = (f.fields ?? [])
    .filter((x) => !['checkbox', 'radio', 'select', 'hidden'].includes(x.type))
    .map((x) => x.name || x.type)
    .filter(Boolean)
    .slice(0, 8);

  return {
    id: hashId('form|' + f.page + '|' + f.purpose + '|' + (f.formId || f.action)),
    page: f.page,
    label: `${cap(f.purpose)} form${prov} → GA4 "${eventName}" on form submit`,
    evidence:
      `form purpose=${f.purpose}; provider=${f.provider.vendor} (${f.provider.evidence})` +
      (trigger.formIdValue ? `; id=#${f.formId}` : usedClass ? `; class=.${usedClass}` : '') +
      (sig.length ? `; fields: ${sig.join(', ')}` : ''),
    ...(note ? { note } : {}),
    confidence: 'high',
    // GA4 EM "form interactions" is limited/generic; a dedicated lead event is valuable.
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: tagNameOf(formLabel),
    measurementId: GA4_VAR,
    eventName,
    // Capture which form + where it submits, via the form built-in variables.
    // (GTM has no built-in "Form Name" variable — form_text is the submit-button
    // text; a true form_name would need a Custom JS variable.)
    eventParameters: [
      { name: 'form_id', value: FORM_ID },
      { name: 'form_destination', value: FORM_URL },
      { name: 'form_text', value: FORM_TEXT },
      ...PAGE_PARAMS,
    ],
    trigger,
  };
}

/** Find form ids / classes that are shared by DIFFERENT forms (different
 *  signatures) — those can't scope a trigger to one form. */
function nonUniqueFormScopes(forms: DetectedForm[]): FormScopeCtx {
  const idSigs = new Map<string, Set<string>>();
  const classSigs = new Map<string, Set<string>>();
  for (const f of forms) {
    const s = formSignature(f);
    if (f.formId) {
      if (!idSigs.has(f.formId)) idSigs.set(f.formId, new Set());
      idSigs.get(f.formId)!.add(s);
    }
    const c = pickFormClass(f.formClasses);
    if (c) {
      if (!classSigs.has(c)) classSigs.set(c, new Set());
      classSigs.get(c)!.add(s);
    }
  }
  return {
    nonUniqueIds: new Set([...idSigs].filter(([, s]) => s.size > 1).map(([k]) => k)),
    nonUniqueClasses: new Set([...classSigs].filter(([, s]) => s.size > 1).map(([k]) => k)),
  };
}

function elementSuggestion(el: DetectedElement, socialPattern: string): SuggestedTag | null {
  const base = (eventName: string, conf: SuggestedTag['confidence'], em: boolean) => ({
    id: hashId(el.kind + '|' + el.page + '|' + (el.href ?? el.text ?? '')),
    page: el.page,
    confidence: conf,
    enhancedMeasurementOverlap: em,
    platform: 'ga4_event' as const,
    tagName: tagNameOf(eventLabel(eventName)),
    measurementId: GA4_VAR,
    eventName,
  });
  switch (el.kind) {
    case 'email':
      return {
        ...base('email_click', 'high', false),
        label: 'Email link (mailto) → GA4 "email_click"',
        evidence: `mailto link${el.region ? ' in ' + el.region : ''}`,
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Email'), kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
      };
    case 'phone':
      return {
        ...base('phone_click', 'high', false),
        label: 'Phone link (tel) → GA4 "phone_click"',
        evidence: `tel link${el.region ? ' in ' + el.region : ''}`,
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Phone'), kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' },
      };
    case 'download':
      return {
        ...base('file_download', 'medium', true), // EM already auto-tracks downloads
        label: 'File download → GA4 "file_download"  ⚠ Enhanced Measurement already covers this',
        evidence: `download link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('File Download'), kind: 'link_click', clickUrlValue: `\\.(${DOWNLOAD_EXT})(\\?|#|$)`, clickUrlOperator: 'matchRegex' },
      };
    case 'outbound':
      return {
        ...base('outbound_click', 'medium', true), // EM already auto-tracks outbound
        label: 'Outbound link → GA4 "outbound_click"  ⚠ Enhanced Measurement already covers this',
        evidence: `outbound link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: { name: trigNameOf('Outbound'), kind: 'link_click' },
      };
    case 'social':
      return {
        ...base('social_click', 'medium', false),
        label: 'Social media link → GA4 "social_click"',
        // A social link IS outbound, so EM's outbound_click also fires — but this
        // dedicated, named event (with the link captured) is what's usually wanted.
        evidence: `social media link ${el.href ?? ''}`.trim() + ' (note: EM also tracks this as an outbound click)',
        eventParameters: CLICK_PARAMS,
        // Fires ONLY on the social networks actually found on the site.
        trigger: { name: trigNameOf('Social Media'), kind: 'link_click', clickUrlValue: socialPattern, clickUrlOperator: 'matchRegex' },
      };
    case 'cta': {
      const def = CTA_BY_INTENT[el.intent ?? 'generic'];
      const isSpecific = def.intent !== 'generic';
      // Named intent → the trigger fires on {{Click Text}} matching the SAME
      // case-insensitive, word-bounded pattern that classified it, so detection
      // and the live GTM trigger always agree (every variant fires, none over-fire,
      // case doesn't matter). All variants of an intent share this pattern, so they
      // collapse to ONE tag. Generic → the element's own literal text (a
      // case-preserved 'contains', so two distinct generic CTAs stay distinct).
      const trigName = isSpecific ? trigNameOf(def.label.replace(/ Click$/, '')) : trigNameOf(el.text.slice(0, 40));
      const trigger: SuggestedTag['trigger'] = isSpecific
        ? { name: trigName, kind: 'all_clicks', clickTextValue: `(?i)${def.pattern}`, clickTextOperator: 'matchRegex' }
        : { name: trigName, kind: 'all_clicks', clickTextValue: el.text, clickTextOperator: 'contains' };
      return {
        ...base(def.event, isSpecific ? 'medium' : 'low', false),
        // Name the tag for what the click IS, not the raw event id.
        tagName: tagNameOf(def.label),
        label: `${def.label} "${el.text}" → GA4 "${def.event}"`,
        evidence: `button/link text "${el.text}"` + (isSpecific ? ` (intent: ${el.intent})` : ''),
        // cta_text is the DYNAMIC clicked text ({{Click Text}}), not the value
        // baked in at scan time; link_url captures the href when the CTA is a link.
        eventParameters: [
          { name: 'cta_text', value: CLICK_TEXT },
          { name: 'link_url', value: CLICK_URL },
          ...PAGE_PARAMS,
        ],
        trigger,
      };
    }
  }
}

const CONF = { high: 0, medium: 1, low: 2 } as const;

export function buildSuggestions(input: SuggestInput): SuggestedTag[] {
  const scopeCtx = nonUniqueFormScopes(input.forms);
  // Social trigger fires on ONLY the networks actually linked from the site.
  const presentNetworks = new Set(
    input.elements.filter((e) => e.kind === 'social' && e.socialNetwork).map((e) => e.socialNetwork as string),
  );
  const socialPattern = buildSocialUrlPattern(presentNetworks);
  const raw: SuggestedTag[] = [
    ...input.forms.map((f) => formSuggestion(f, scopeCtx)),
    ...input.elements.map((e) => elementSuggestion(e, socialPattern)),
  ].filter((x): x is SuggestedTag => x !== null);

  // Site-wide dedup: the same tag (event + trigger filter + kind) seen on multiple
  // pages — e.g. a footer email link on every page — collapses to ONE suggestion
  // marked "site-wide", instead of N copies.
  const byKey = new Map<string, SuggestedTag>();
  for (const s of raw) {
    // CTAs are distinguished by their click-text filter — keep distinct CTAs
    // distinct; every other kind genuinely collapses to one tag (one mailto:,
    // one regex file_download, one outbound, etc.). The eventParameters are now
    // all GTM-variable refs (identical across instances), so the trigger filter
    // is the discriminator, not the parameter value.
    const key = `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${s.trigger.clickTextValue ?? ''}|${s.trigger.formIdValue ?? ''}|${s.trigger.formClassesValue ?? ''}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...s });
    else if (seen.page !== s.page) seen.page = 'site-wide';
  }

  // Rank: confidence (high→low), then real-value (non-EM-overlap first), then label.
  return [...byKey.values()].sort(
    (a, b) =>
      CONF[a.confidence] - CONF[b.confidence] ||
      Number(a.enhancedMeasurementOverlap) - Number(b.enhancedMeasurementOverlap) ||
      a.label.localeCompare(b.label)
  );
}
