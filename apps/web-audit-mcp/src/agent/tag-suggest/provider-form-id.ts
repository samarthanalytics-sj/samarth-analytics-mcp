// Per-vendor DURABLE form identity: what identifies THIS form on the next page load, where that
// value lives, and how GTM must scope on it.
//
// form-id-stability.ts answers a generic question ("is this DOM id the same id next time?"). This
// module answers the vendor-specific one, and the two answers differ in a way that decides whether
// a tag ever fires:
//
//   * a NATIVE form submit is seen by GTM's Form Submission trigger, which reads the <form>
//     element's own id, so the scope is a {{Form ID}} condition;
//   * an EMBED or AJAX form submits inside an iframe or is preventDefaulted, so the tag fires on a
//     dataLayer Custom Event instead. {{Form ID}} does NOT resolve on a pushed event, so the ONLY
//     usable scope is a condition on the key the paired LISTENER really pushes. That key comes from
//     install-plan.ts LISTENER_DLV_KEY, never from a guess here.
//
// The operator matters as much as the value. Contact Form 7's wrapper id carries a placement
// ordinal (wpcf7-f34-p9-o1) that changes when the shortcode is moved or a second copy is added on
// the page, so an `equals` on it is a trigger that silently stops matching; `contains wpcf7-f34` is
// the identity. HubSpot joins a per-render instance GUID to the real form GUID, so only `contains`
// on the trailing GUID survives a re-render.
//
// Where a vendor exposes NO durable identity at scan time, this returns null and says why. Inventing
// one would produce exactly the failure this whole module exists to prevent.

import type { FormProvider } from './types.js';
import { LISTENER_DLV_KEY } from './install-plan.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_G = new RegExp(UUID, 'gi');

/** A {{Form ID}} condition for a NATIVE form submit. */
export interface FormIdCondition {
  operator: 'equals' | 'contains';
  value: string;
}

/** A dataLayer condition for a CUSTOM EVENT trigger, on the key the paired listener really pushes. */
export interface DataLayerCondition {
  key: string;
  value: string;
  operator: 'equals' | 'contains';
}

export interface ProviderFormIdentity {
  vendor: FormProvider;
  /** True when this vendor has a rule here at all (so the caller can tell "no rule" from "rule
   *  found nothing"). */
  known: boolean;
  /** The durable identifier, or null when this scan proves none. */
  value: string | null;
  /** WHERE it was read from, for the evidence line. '' when there is no value. */
  source: string;
  /** How to scope a NATIVE Form Submission trigger, or null when the vendor's identity is not the
   *  <form> element's id (so the generic id ladder should decide instead). */
  formIdCondition: FormIdCondition | null;
  /** How to scope a CUSTOM EVENT trigger, or null when the paired listener pushes no identity. */
  dataLayerCondition: DataLayerCondition | null;
  /** Plain-language reason. Always set when an identity was refused, or when the operator is not
   *  `equals` (an operator choice the operator deserves to understand). */
  note?: string;
  /** Group results only: some instances of the group exposed no identity at all, so a scope built on
   *  this one covers the instances that DID expose it and may not cover the others. */
  partial?: boolean;
}

export interface ProviderFormIdInput {
  vendor: FormProvider;
  /** The form element's own DOM id, as scanned. */
  formId?: string;
  /** The provider's own id attribute (data-form-id / data-formid / data-wpcf7-id), as scanned. */
  providerFormId?: string;
  /** The form element's class attribute, as scanned. */
  formClasses?: string;
  /** The form's action, as scanned. */
  action?: string;
}

interface Norm {
  formId: string;
  providerFormId: string;
  classes: string[];
  action: string;
  /** formId + providerFormId + classes + action, one lowercased haystack for shape matching. */
  hay: string;
}

const none = (vendor: FormProvider, known: boolean, note?: string): ProviderFormIdentity => ({
  vendor,
  known,
  value: null,
  source: '',
  formIdCondition: null,
  dataLayerCondition: null,
  ...(note ? { note } : {}),
});

/** The dataLayer condition for a vendor, built from the key its listener REALLY pushes. Returns
 *  null when that vendor's listener pushes no identity, which is a fact, not an omission. */
function dlCondition(vendor: FormProvider, value: string): DataLayerCondition | null {
  const key = LISTENER_DLV_KEY[vendor];
  return key ? { key, value, operator: 'equals' } : null;
}

/** Every UUID in a string, lowercased, in order. */
function uuidsIn(s: string): string[] {
  return (s.match(UUID_G) ?? []).map((u) => u.toLowerCase());
}

/** The first capture group of `re` against the haystack, or ''. */
function grab(hay: string, re: RegExp): string {
  const m = re.exec(hay);
  return m && m[1] ? m[1] : '';
}

type VendorRule = (n: Norm) => ProviderFormIdentity;

const RULES: Partial<Record<FormProvider, VendorRule>> = {
  // HubSpot: the form GUID. It is in data-form-id on the wrapper and on the <form>, and it is the
  // TRAILING uuid of the DOM id (the LEADING uuid is the per-render instance). The classic embed
  // uses id="hsForm_<formGuid>", where the single uuid IS the form guid.
  hubspot: (n) => {
    const attr = uuidsIn(n.providerFormId)[0] ?? '';
    const ids = uuidsIn(n.formId);
    // 2+ uuids: the LAST is the form GUID, the leading one is minted per render. A single bare uuid
    // is ambiguous (it could be either), so it is only trusted when data-form-id confirms it.
    const trailing = ids.length >= 2 ? ids[ids.length - 1] : '';
    // The classic embed's id is hsForm_<formGuid>, a SINGLE uuid which therefore IS the form GUID.
    // It is only read when the id carries exactly one uuid: hsForm_<instanceGuid>-<formGuid> also
    // starts with hsForm_<uuid>, so reading it there would pick the per-render instance GUID and
    // ship {{dlv - hs_form_id}} equals a value HubSpot never posts again. `trailing` is checked
    // FIRST for exactly that reason.
    const classic = ids.length === 1 ? grab(n.formId, new RegExp(`^hsForm_(${UUID})`, 'i')).toLowerCase() : '';
    const value = attr || trailing || classic;
    if (!value) {
      return none(
        'hubspot',
        true,
        'No HubSpot form GUID was found on this form (no data-form-id, and the DOM id carries no ' +
          'form GUID), so the trigger is not scoped to it. HubSpot mints part of the DOM id on every ' +
          'render, so an exact {{Form ID}} match here would be accepted by GTM and then never fire.',
      );
    }
    const source = attr ? 'data-form-id' : value === trailing ? 'trailing GUID of the DOM id' : 'DOM id hsForm_<GUID>';
    return {
      vendor: 'hubspot',
      known: true,
      value,
      source,
      // NEVER equals: the DOM id carries a per-render instance GUID in front of the form GUID.
      formIdCondition: { operator: 'contains', value },
      dataLayerCondition: dlCondition('hubspot', value),
      note:
        `HubSpot's form GUID is ${value} (read from ${source}). The DOM id around it is generated per ` +
        'page load, so the scope matches the GUID rather than the whole id.',
    };
  },

  // Marketo: the numeric form id in the DOM id mktoForm_<n>. Stable across loads, so `equals` is safe.
  marketo: (n) => {
    const num = grab(n.hay, /mktoform_(\d+)/i);
    if (!num) {
      return none(
        'marketo',
        true,
        'No Marketo form number was found (the form carries no mktoForm_<n> id), so the trigger is ' +
          'not scoped to one form. Marketo renders the id from the form number, so a page showing the ' +
          'form should expose it.',
      );
    }
    return {
      vendor: 'marketo',
      known: true,
      value: num,
      source: `DOM id mktoForm_${num}`,
      formIdCondition: { operator: 'equals', value: `mktoForm_${num}` },
      dataLayerCondition: dlCondition('marketo', num),
    };
  },

  // Contact Form 7: the post id in wpcf7-f<id>-p<page>-o<ordinal>, or data-wpcf7-id on the wrapper.
  // The -o ORDINAL is the form's position among the CF7 forms rendered on that page, so it changes
  // the moment a second form is added above it. NEVER equals.
  contactform7: (n) => {
    const fromId = grab(n.hay, /wpcf7-f(\d+)/i);
    const fromAttr = /^\d+$/.test(n.providerFormId) ? n.providerFormId : '';
    const post = fromId || fromAttr;
    if (!post) {
      return none(
        'contactform7',
        true,
        'No Contact Form 7 post id was found (no wpcf7-f<id> id and no data-wpcf7-id), so the trigger ' +
          'is not scoped to one form.',
      );
    }
    return {
      vendor: 'contactform7',
      known: true,
      value: post,
      source: fromId ? `DOM id wpcf7-f${post}-p<page>-o<ordinal>` : 'data-wpcf7-id',
      // contains, never equals: the trailing -o<ordinal> varies per placement.
      formIdCondition: { operator: 'contains', value: `wpcf7-f${post}` },
      dataLayerCondition: dlCondition('contactform7', post),
      note:
        `Contact Form 7's id ends in a placement ordinal (-o1, -o2) that changes when the form moves ` +
        `or a second CF7 form is added to the page, so the scope is {{Form ID}} contains "wpcf7-f${post}" ` +
        'rather than an exact match that would quietly stop firing.',
    };
  },

  // Gravity Forms: the numeric form id, in the <form> id gform_<n> or the wrapper gform_wrapper_<n>.
  // The <form> element itself is always gform_<n>, so equals on that is exact and stable.
  gravityforms: (n) => {
    const num = grab(n.hay, /gform_(?:wrapper_)?(\d+)/i);
    if (!num) return none('gravityforms', true, 'No Gravity Forms form number was found (no gform_<n> id), so the trigger is not scoped to one form.');
    return {
      vendor: 'gravityforms',
      known: true,
      value: num,
      source: `DOM id gform_${num}`,
      formIdCondition: { operator: 'equals', value: `gform_${num}` },
      dataLayerCondition: dlCondition('gravityforms', num),
    };
  },

  // Ninja Forms: the numeric form id in the container id nf-form-<n>-cont (or nf-form-<n>_wrap).
  // Scoped by the FULL container id, because "contains nf-form-1" would also match nf-form-12.
  ninjaforms: (n) => {
    const num = grab(n.hay, /nf-form-(\d+)[-_]/i);
    if (!num) return none('ninjaforms', true, 'No Ninja Forms form number was found (no nf-form-<n>-cont id), so the trigger is not scoped to one form.');
    return {
      vendor: 'ninjaforms',
      known: true,
      value: num,
      source: `DOM id nf-form-${num}-cont`,
      formIdCondition: { operator: 'equals', value: `nf-form-${num}-cont` },
      dataLayerCondition: dlCondition('ninjaforms', num),
    };
  },

  // WPForms: data-formid (NOT data-form-id, which is why the earlier capture missed it) and the
  // <form> id wpforms-form-<n>.
  wpforms: (n) => {
    const attr = /^\d+$/.test(n.providerFormId) ? n.providerFormId : '';
    const num = attr || grab(n.hay, /wpforms-form-(\d+)/i) || grab(n.hay, /wpforms-(\d+)/i);
    if (!num) return none('wpforms', true, 'No WPForms form number was found (no data-formid and no wpforms-form-<n> id), so the trigger is not scoped to one form.');
    return {
      vendor: 'wpforms',
      known: true,
      value: num,
      source: attr ? 'data-formid' : `DOM id wpforms-form-${num}`,
      formIdCondition: { operator: 'equals', value: `wpforms-form-${num}` },
      dataLayerCondition: dlCondition('wpforms', num),
    };
  },

  // Elementor: the widget id. It lives in the wrapper's data-id and in a hidden form_id input, and
  // the scan reads neither (data-id is far too generic an attribute to capture blindly). Elementor's
  // submit_success event also carries NO form identity, so even a known widget id would not give a
  // dataLayer scope. Both facts are stated rather than papered over.
  elementor: (n) => {
    const widget = grab(n.classes.join(' '), /elementor-element-([0-9a-z]{5,})/i);
    if (!widget) {
      return none(
        'elementor',
        true,
        "Elementor's widget id is in the wrapper's data-id and a hidden form_id input, neither of " +
          'which this scan reads, so the form is not scoped by it. Elementor\'s submit_success event ' +
          'carries no form id either, so the trigger stays page-scoped.',
      );
    }
    return {
      vendor: 'elementor',
      known: true,
      value: widget,
      source: `class elementor-element-${widget}`,
      formIdCondition: null,
      // submit_success pushes no identity, so there is nothing to AND onto the custom event.
      dataLayerCondition: null,
      note:
        `This is Elementor widget ${widget}, but Elementor's submit_success event carries no form id, ` +
        'so the Custom Event trigger cannot be scoped to it and stays page-scoped.',
    };
  },

  // Klaviyo: the form id is the container CLASS klaviyo-form-<id>. That is a class scope, not a
  // {{Form ID}} one, and Klaviyo's success signal is not modelled in install-plan.ts, so there is no
  // dataLayer key to condition on.
  klaviyo: (n) => {
    const id = grab(n.classes.join(' '), /klaviyo-form-([0-9a-z]{3,})/i);
    if (!id) return none('klaviyo', true, 'No Klaviyo form id was found (no klaviyo-form-<id> class), so the trigger is not scoped to one form.');
    return {
      vendor: 'klaviyo',
      known: true,
      value: id,
      source: `class klaviyo-form-${id}`,
      formIdCondition: null,
      dataLayerCondition: null,
      note:
        `Klaviyo identifies this form by the container class klaviyo-form-${id}, not by a {{Form ID}}. ` +
        'Klaviyo\'s submit signal is not modelled here, so scope the trigger on {{Form Classes}} ' +
        `contains "klaviyo-form-${id}" once the site pushes a submit event.`,
    };
  },

  // ActiveCampaign: the numeric form id in the _form_<n> class / id. The embed posts a real form, so
  // the DOM id is stable and the generic {{Form ID}} route works.
  activecampaign: (n) => {
    const num = grab(n.hay, /_form_(\d+)/i);
    if (!num) return none('activecampaign', true, 'No ActiveCampaign form number was found (no _form_<n> class or id), so the trigger is not scoped to one form.');
    return {
      vendor: 'activecampaign',
      known: true,
      value: num,
      source: `class _form_${num}`,
      formIdCondition: { operator: 'contains', value: `_form_${num}` },
      // ActiveCampaign's success payload is not modelled in install-plan.ts, so no key to condition on.
      dataLayerCondition: null,
      note:
        `ActiveCampaign identifies this form as _form_${num}. The scope uses contains because the ` +
        'element id is written _form_<n>_ with a trailing underscore while the class is _form_<n>.',
    };
  },

  // Unbounce: the numeric id in the form container lp-pom-form-<n>. Stable for the life of the page
  // variant. Unbounce posts a real form, so a {{Form ID}} scope is the right one.
  unbounce: (n) => {
    const num = grab(n.hay, /lp-pom-form-(\d+)/i);
    if (!num) return none('unbounce', true, 'No Unbounce form number was found (no lp-pom-form-<n> id), so the trigger is not scoped to one form.');
    return {
      vendor: 'unbounce',
      known: true,
      value: num,
      source: `DOM id lp-pom-form-${num}`,
      formIdCondition: { operator: 'contains', value: `lp-pom-form-${num}` },
      dataLayerCondition: null,
      note:
        `Unbounce renders this form inside lp-pom-form-${num}. The inner <form> is named generically, ` +
        'so the scope matches the container id via contains rather than an exact match.',
    };
  },

  // Webflow: the form NAME, exposed as the id wf-form-<Name> and the data-name attribute. Stable
  // until the form is renamed in the designer, and it is the <form> element's own id, so equals.
  webflow: (n) => {
    const name = grab(n.formId, /^wf-form-(.+)$/i);
    if (!name) return none('webflow', true, 'No Webflow form name was found (no wf-form-<Name> id), so the trigger is not scoped to one form.');
    return {
      vendor: 'webflow',
      known: true,
      value: name,
      source: `DOM id wf-form-${name}`,
      formIdCondition: { operator: 'equals', value: `wf-form-${name}` },
      dataLayerCondition: null,
    };
  },
};

// Vendors we RECOGNISE but which expose no durable per-form identity in the page markup the scan
// reads. Each is listed with the reason, so the suggestion can say WHY it is scoped by page instead
// of silently widening. The alternative, guessing an id, is the failure mode this file exists for.
const NO_DURABLE_ID: Partial<Record<FormProvider, string>> = {
  typeform:
    "Typeform's form id is in the embed attribute (data-tf-live / data-tf-widget) or the iframe URL, " +
    'not on the form itself, so this scan cannot prove which form it is. The trigger stays page-scoped.',
  calendly:
    'A Calendly booking completes inside a cross-origin widget and its event payload carries no form ' +
    'id, so there is nothing to scope on. The trigger stays page-scoped.',
  jotform:
    "JotForm's form id is in the embed script or iframe URL rather than on a readable form element, " +
    'so this scan cannot prove which form it is. The trigger stays page-scoped.',
  formstack:
    "Formstack's form id is in its embed script URL (js.php/<id>) rather than on a readable form " +
    'element, so this scan cannot prove which form it is. The trigger stays page-scoped.',
  paperform:
    "Paperform's form id is in the embed attribute or iframe URL, not on the form itself, so this " +
    'scan cannot prove which form it is. The trigger stays page-scoped.',
  tally: 'A Tally form submits inside a cross-origin iframe and exposes no readable form id, so the trigger stays page-scoped.',
  googleforms: 'A Google Form submits inside a cross-origin iframe and exposes nothing readable, so the trigger stays page-scoped.',
  wufoo: 'A Wufoo form submits inside its embed and exposes no readable form id, so the trigger stays page-scoped.',
  pardot:
    'A Pardot form renders inside an iframe served from pardot.com, so the id is in that URL rather ' +
    'than on a readable form element. The trigger stays page-scoped.',
  mailchimp:
    "Mailchimp's embedded signup form has no per-form id in the markup (its identity is the list in " +
    'the action URL), so the trigger stays page-scoped.',
};

/**
 * The vendor's durable identity for ONE scanned form.
 *
 * `known: false` with everything null means "no vendor rule applies", which tells the caller to fall
 * back to the generic id ladder in form-id-stability.ts. `known: true` with a null value means "we
 * looked and this scan proves nothing", and carries the reason in `note`.
 */
export function providerFormIdentity(input: ProviderFormIdInput): ProviderFormIdentity {
  const vendor = input.vendor;
  const formId = String(input.formId ?? '').trim();
  const providerFormId = String(input.providerFormId ?? '').trim();
  const classes = String(input.formClasses ?? '')
    .split(/\s+/)
    .filter(Boolean);
  const action = String(input.action ?? '').trim();
  const n: Norm = {
    formId,
    providerFormId,
    classes,
    action,
    hay: `${formId} ${providerFormId} ${classes.join(' ')} ${action}`,
  };
  const rule = RULES[vendor];
  if (rule) return rule(n);
  const reason = NO_DURABLE_ID[vendor];
  if (reason) return none(vendor, true, reason);
  return none(vendor, false);
}

/**
 * The identity shared by the forms in a group (the same named form across pages).
 *
 * Instances that expose NOTHING do not veto the group. That is the whole point: one instance
 * rendered without an id used to collapse the entire group down to a page-path scope, which fires
 * for every other form on those pages. The instances that DID resolve still name one real form, and
 * scoping on that is strictly tighter than the page while still firing. The group is marked
 * `partial` so the caller can say the uncovered instance may not fire.
 *
 * Instances that resolve to DIFFERENT values do veto it: that is two different forms wearing one
 * name, and scoping on either would fire the tag for a form the operator did not choose.
 *
 * A unanimous "this vendor exposes nothing durable" IS returned (value null, note set), because the
 * caller needs that reason to explain why the trigger widened. null means there is nothing to say:
 * no vendor rule, or a mixed vendor group.
 */
export function groupFormIdentity(forms: readonly ProviderFormIdInput[]): ProviderFormIdentity | null {
  if (!forms.length) return null;
  const all = forms.map(providerFormIdentity);
  if (!all.every((i) => i.known && i.vendor === all[0].vendor)) return null;
  const resolved = all.filter((i) => i.value !== null);
  if (!resolved.length) return all[0];
  const first = resolved[0];
  for (const next of resolved.slice(1)) {
    if (next.value !== first.value) return null;
    if (JSON.stringify(next.formIdCondition) !== JSON.stringify(first.formIdCondition)) return null;
    if (JSON.stringify(next.dataLayerCondition) !== JSON.stringify(first.dataLayerCondition)) return null;
  }
  return resolved.length === all.length ? first : { ...first, partial: true };
}
