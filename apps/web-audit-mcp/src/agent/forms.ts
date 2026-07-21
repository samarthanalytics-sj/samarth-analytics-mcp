/**
 * Form discovery and privacy analysis.
 *
 * `extractFormsInPage` runs inside the browser and returns raw descriptors
 * only (attributes, labels, checkbox states — never user-entered values).
 * `analyzeForms` is pure Node logic so the PII classification and issue rules
 * are unit-testable without a browser. Forms are never filled or submitted.
 */

import type { PwPage } from './browser.js';

export interface RawFormField {
  tag: string;
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  autocomplete: string;
  required: boolean;
  checked?: boolean;
  /** True when the field is not visible to a real user (display:none / visibility:hidden / off-screen).
   *  A hidden text-style input is almost always an anti-spam HONEYPOT — the fill layer must NOT fill it
   *  (filling one makes the site silently reject the submit). */
  hidden?: boolean;
  /** For a <select> (and later radio groups): the visible option labels, so a "Category"-style field
   *  can be filled with a REAL option value instead of a made-up string. Capped. Placeholder options
   *  ("Please select…") are kept as-is; the fill layer skips them when choosing a value. */
  options?: string[];
}

export interface RawForm {
  index: number;
  action: string;
  method: string;
  /** The form element's own id/name/classes — used to scope the GTM trigger to
   *  THIS form (filter {{Form ID}} / {{Form Classes}}) instead of all forms. */
  formId: string;
  /** The PROVIDER's own form id, from data-form-id (HubSpot and friends put the durable form GUID
   *  there). The DOM `id` of an embedded form is often minted per render, so this is the identity
   *  that survives a reload - see tag-suggest/form-id-stability. Absent when the page exposes none;
   *  optional so the many hand-written RawForm fixtures stay valid. */
  providerFormId?: string;
  formName: string;
  formClasses: string;
  /** The form's visible heading/label (aria-label, a heading/legend inside it, or
   *  the nearest heading in its card) — e.g. "Get a Free Consultation". Used to
   *  NAME the tag for what the user sees, falling back to the form's purpose. */
  title: string;
  fieldCount: number;
  fields: RawFormField[];
  hasPrivacyLink: boolean;
  /** Lower-cased visible text of the form, capped — for keyword scans. */
  text: string;
  /** True when the form is not rendered at scan time (display:none / visibility:hidden — typically a
   *  modal/popup form that opens on a button click, e.g. a "Book a demo" Marketo modal). */
  hidden?: boolean;
}

/** Serialized by Playwright/Electron and executed in the page. Self-contained.
 *  Finds real <form> elements AND "div/JS forms" (a container with input fields
 *  + a submit-like control but no <form> tag — common in React/JS widgets), and
 *  scans same-origin iframes (embedded provider forms). */
export function extractFormsInPage(): RawForm[] {
  const MAX_FORMS = 25;
  const MAX_FIELDS = 50;
  // High-precision submit-intent vocabulary (kept tight to avoid matching
  // pagination/filter buttons). Anchored on the button so we find the right box.
  const SUBMIT_RE = /\b(submit|send|subscribe|sign\s*up|sign\s*me\s*up|get\s+started|register|join\b|request\s+(a\s+)?(quote|demo|info|callback)|contact\s+us|book\s+(a\s+)?(demo|call|meeting)|get\s+(a\s+)?quote|apply\s+(now|today|for)|submit\s+(an?\s+)?application|notify\s+me|get\s+updates|stay\s+(updated|informed))\b/i;
  const TEXTISH = new Set(['text', 'email', 'tel', 'url', 'search', 'password', 'number', 'textarea']);
  const out: RawForm[] = [];

  const fieldOf = (el: Element): RawFormField | null => {
    const input = el as HTMLInputElement;
    const type = (input.type || el.tagName).toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return null;
    let label = '';
    const doc = el.ownerDocument || document;
    if (input.id) {
      try {
        const lab = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (lab) label = (lab.textContent || '').trim();
      } catch {
        /* invalid id */
      }
    }
    if (!label) {
      const closest = el.closest('label');
      if (closest) label = (closest.textContent || '').trim();
    }
    if (!label) label = el.getAttribute('aria-label') || '';
    const field: RawFormField = {
      tag: el.tagName.toLowerCase(),
      type,
      name: input.name || '',
      id: input.id || '',
      label: label.slice(0, 160),
      placeholder: (input.placeholder || '').slice(0, 160),
      autocomplete: input.autocomplete || '',
      required: input.required === true,
      ...(type === 'checkbox' || type === 'radio' ? { checked: input.checked === true } : {}),
    };
    // Honeypot signal: hidden from a real user (display:none / visibility:hidden / opacity:0 / 0-size /
    // positioned off-screen). A 0x0 rect also catches a field inside a display:none ancestor.
    try {
      const view = doc.defaultView;
      if (view) {
        const cs = view.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const offscreen = r.right < -1 || r.left > (view.innerWidth || 9999) + 1000;
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || (r.width === 0 && r.height === 0) || offscreen) {
          field.hidden = true;
        }
      }
    } catch {
      /* best-effort visibility probe */
    }
    if (el.tagName === 'SELECT') {
      const opts = Array.from((el as unknown as HTMLSelectElement).options)
        .map((o) => (o.textContent || (o as HTMLOptionElement).value || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 0)
        .slice(0, 40);
      if (opts.length) field.options = opts;
    }
    return field;
  };
  const fieldsIn = (root: Element): RawFormField[] => {
    const fields: RawFormField[] = [];
    for (const el of Array.from(root.querySelectorAll('input, select, textarea')).slice(0, MAX_FIELDS)) {
      const f = fieldOf(el);
      if (f) fields.push(f);
    }
    return fields;
  };
  // Like fieldsIn, but EXCLUDING fields that belong to a real <form> descendant — those are already
  // captured as native forms in step 1. Without this, a modal wrapper that CONTAINS a <form> plus an
  // outside "Book a demo" button would be re-detected as a second, phantom div-form of the same fields.
  const fieldsOutsideForm = (root: Element): RawFormField[] => {
    const fields: RawFormField[] = [];
    // Cap on COLLECTED fields (not on the raw query) — a 50+-field <form> earlier in document order
    // must not blind the detector to a genuinely separate div-form after it.
    for (const el of Array.from(root.querySelectorAll('input, select, textarea'))) {
      if (fields.length >= MAX_FIELDS) break;
      if (el.closest('form')) continue;
      const f = fieldOf(el);
      if (f) fields.push(f);
    }
    return fields;
  };
  // Not rendered at scan time: display:none (self or ancestor) collapses the box; visibility:hidden is
  // inherited into the computed style. Typically a modal/popup form that opens on a button click.
  const hiddenOf = (el: Element): boolean => {
    try {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      const r = el.getBoundingClientRect();
      // A display:contents box is 0x0 while its children render normally — not hidden.
      if (r.width === 0 && r.height === 0) return view ? view.getComputedStyle(el).display !== 'contents' : true;
      return view ? view.getComputedStyle(el).visibility === 'hidden' : false;
    } catch {
      return false;
    }
  };
  const privacyIn = (root: Element): boolean =>
    Boolean(root.querySelector('a[href*="privacy"], a[href*="datenschutz"], a[href*="confidentialite"], a[href*="privacidad"], a[href*="cookie-policy"]'));

  const headingIn = (root: Element): string => {
    const h = root.querySelector('legend, h1, h2, h3, h4, h5, h6');
    return h ? (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  };
  // The form's visible name: aria-label → a heading/legend inside it → the nearest
  // heading in an ancestor "card" (≤3 levels up; the closest wins, so we get the
  // form's own card heading, not the page <h1>).
  const titleOf = (el: Element): string => {
    const doc = el.ownerDocument || document;
    const al = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (al) return al.slice(0, 60);
    const lbId = el.getAttribute('aria-labelledby');
    if (lbId) {
      try {
        const t = doc.getElementById(lbId);
        const s = t ? (t.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (s) return s.slice(0, 60);
      } catch {
        /* invalid id */
      }
    }
    const inside = headingIn(el);
    if (inside) return inside;
    // Nearest heading ABOVE the form. A React/Tailwind form is often nested several levels below its
    // section heading, so walk up to 6 ancestors and, at each level, take the LAST heading that PRECEDES
    // the form in document order — its own card/section title (e.g. "Stay Updated", "Contact Information")
    // — rather than the first heading in a large ancestor (which would grab the page hero). This is what
    // lets an anonymous form (no id/name, empty title) be matched to its tag by name.
    let node: Element | null = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      let best = '';
      for (const h of Array.from(node.querySelectorAll('legend, h1, h2, h3, h4, h5, h6'))) {
        // el follows h  ⟺  h precedes the form (DOCUMENT_POSITION_FOLLOWING = 4)
        if ((h.compareDocumentPosition(el) & 4) !== 0) {
          const t = (h.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) best = t;
        }
      }
      if (best) return best.slice(0, 60);
    }
    return '';
  };

  const scanDoc = (doc: Document): void => {
    // 1. Real <form> elements.
    for (const form of Array.from(doc.querySelectorAll('form')).slice(0, MAX_FORMS)) {
      if (out.length >= MAX_FORMS) break;
      const fields = fieldsIn(form);
      let action = '';
      try {
        action = new URL(form.getAttribute('action') || '', (doc.location || location).href).href;
      } catch {
        action = form.getAttribute('action') || '';
      }
      out.push({
        index: out.length,
        action,
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        formId: form.getAttribute('id') || '',
        providerFormId: form.getAttribute('data-form-id') || '',
        formName: form.getAttribute('name') || '',
        formClasses: form.getAttribute('class') || '',
        title: titleOf(form),
        fieldCount: fields.length,
        fields,
        hasPrivacyLink: privacyIn(form),
        text: (form.textContent || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
        ...(hiddenOf(form) ? { hidden: true } : {}),
      });
    }
    // 2. div/JS "forms": a non-<form> container with input field(s) + a submit-
    //    like control. Anchored on the submit button → climb to the smallest
    //    ancestor that also holds a text-ish field. Requires a real text input
    //    (not just selects) so filter/search widgets aren't mistaken for forms.
    const seen: Element[] = [];
    // Include <a> + [onclick] — many React/marketing forms use an anchor, a styled <div role=button>,
    // or a bare <div onclick> as the "Send Message" / "Subscribe" control rather than a real <button>.
    for (const btn of Array.from(doc.querySelectorAll('button, [role="button"], a, [onclick], input[type="submit"], input[type="button"]'))) {
      if (out.length >= MAX_FORMS) break;
      if (btn.closest('form')) continue;
      // Include aria-label + title, not just text/value: a footer "Stay Updated" / newsletter subscribe
      // control is often an ICON/arrow button whose intent lives in aria-label ("Subscribe"), so the
      // text-only label was empty and the widget was never anchored → its form tag stayed untested.
      const label = ((btn.textContent || '') + ' ' + ((btn as HTMLInputElement).value || '') + ' ' + (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '')).trim();
      if (!SUBMIT_RE.test(label)) continue;
      // Climb up to 10 ancestors (deeply-nested React layouts put the submit control
      // several wrappers away from the fields) to find the smallest container holding a field.
      let host: Element | null = null;
      let node: Element | null = btn.parentElement;
      for (let i = 0; node && i < 10; i++, node = node.parentElement) {
        if (node.tagName === 'FORM') break;
        if (fieldsOutsideForm(node).length >= 1) {
          host = node;
          break;
        }
      }
      if (!host || host.closest('form')) continue;
      // Skip overlapping hosts (nested clusters resolving to the same widget).
      if (seen.some((h) => h.contains(host!) || host!.contains(h))) continue;
      const fields = fieldsOutsideForm(host);
      if (!fields.some((f) => TEXTISH.has(f.type))) continue;
      seen.push(host);
      out.push({
        index: out.length,
        action: '', // div/JS forms submit via JS — no element action to read
        method: 'js',
        formId: host.getAttribute('id') || '',
        providerFormId: host.getAttribute('data-form-id') || host.querySelector('[data-form-id]')?.getAttribute('data-form-id') || '',
        formName: '',
        formClasses: host.getAttribute('class') || '',
        title: titleOf(host),
        fieldCount: fields.length,
        fields,
        hasPrivacyLink: privacyIn(host),
        text: ((host.textContent || '') + ' ' + label).toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
        ...(hiddenOf(host) ? { hidden: true } : {}),
      });
    }
    // 3. Field-CLUSTER "forms": catch a form whose submit control is a plain <div onClick> (no
    //    <button>/<a>/role — common in React), which step 2's submit anchor can't find. Anchor on a
    //    text-ish field, climb to the smallest container holding >=2 text-ish fields, and accept it
    //    only if it looks form-like (has an email or textarea, or >=3 text-ish fields) so a bare
    //    2-input filter/search bar isn't a false positive.
    const TEXTISH_SEL =
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="image"]):not([type="reset"]), textarea';
    for (const fld of Array.from(doc.querySelectorAll(TEXTISH_SEL))) {
      if (out.length >= MAX_FORMS) break;
      if (fld.closest('form')) continue;
      if (seen.some((h) => h.contains(fld))) continue; // already inside a detected div-form
      let host: Element | null = null;
      let node: Element | null = fld.parentElement;
      for (let i = 0; node && i < 10; i++, node = node.parentElement) {
        if (node.tagName === 'FORM') break;
        if (fieldsOutsideForm(node).filter((f) => TEXTISH.has(f.type)).length >= 2) {
          host = node;
          break;
        }
      }
      if (!host || host.closest('form')) continue;
      if (seen.some((h) => h.contains(host!) || host!.contains(h))) continue;
      const fields = fieldsOutsideForm(host);
      const textish = fields.filter((f) => TEXTISH.has(f.type));
      if (!(textish.some((f) => f.type === 'email' || f.type === 'textarea') || textish.length >= 3)) continue;
      seen.push(host);
      out.push({
        index: out.length,
        action: '',
        method: 'js',
        formId: host.getAttribute('id') || '',
        providerFormId: host.getAttribute('data-form-id') || host.querySelector('[data-form-id]')?.getAttribute('data-form-id') || '',
        formName: '',
        formClasses: host.getAttribute('class') || '',
        title: titleOf(host),
        fieldCount: fields.length,
        fields,
        hasPrivacyLink: privacyIn(host),
        text: (host.textContent || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
        ...(hiddenOf(host) ? { hidden: true } : {}),
      });
    }
  };

  scanDoc(document);
  for (const fr of Array.from(document.querySelectorAll('iframe')).slice(0, 12)) {
    try {
      const d = (fr as HTMLIFrameElement).contentDocument;
      if (d && d.body) scanDoc(d);
    } catch {
      /* cross-origin iframe — inaccessible */
    }
  }
  return out;
}

// ── Pure analysis (unit-testable) ───────────────────────────────────────────

export type PiiCategory =
  | 'email'
  | 'phone'
  | 'name'
  | 'address'
  | 'date_of_birth'
  | 'government_id'
  | 'payment';

const PII_RULES: { category: PiiCategory; re: RegExp; types?: string[]; autocomplete?: RegExp }[] = [
  { category: 'email', re: /\be-?mail\b|courriel/i, types: ['email'], autocomplete: /^email$/i },
  { category: 'phone', re: /\bphone|mobile|telefon|téléphone|telefono|whatsapp\b/i, types: ['tel'], autocomplete: /tel/i },
  { category: 'name', re: /\b(first|last|full|sur|given|family)[\s_-]?name\b|\bf?name\b|\blname\b|nachname|vorname|nombre|apellido/i, autocomplete: /^(name|given-name|family-name)$/i },
  { category: 'address', re: /\baddress|street|city|zip|postal|postcode|plz|adresse\b/i, autocomplete: /address|postal-code/i },
  { category: 'date_of_birth', re: /\b(date.{0,3}of.{0,3}birth|birth.?da(y|te)|dob|geburtsdatum)\b/i, autocomplete: /^bday/i },
  { category: 'government_id', re: /\b(ssn|social.?security|passport|aadhaar|national.?id|tax.?id|pan.?(card|number))\b/i },
  { category: 'payment', re: /\b(card.?number|credit.?card|cvv|cvc|iban|account.?number)\b/i, autocomplete: /^cc-/i },
];

const MARKETING_RE = /newsletter|marketing|promotions?|offers|subscribe|mailing list|updates from|product news|werbung|newslettera/i;
// Newsletter-INTENT verbs on the visible text/button — catches a bare email box whose surrounding copy
// lacks a MARKETING_RE keyword (e.g. a footer "Sign up" / "Get updates" capture) but is still a
// subscription, not a contact form. "join" is scoped to a list/newsletter so "Join our team" /
// "Join the waitlist" (careers/lead) do NOT match.
const NEWSLETTER_VERB_RE =
  /\b(sign\s?up|subscribe|newsletter|join (our |the )?(newsletter|mailing list|email list)|notify me|get updates|stay (updated|informed)|keep me posted|email updates)\b/i;
// Copy that signals a passwordless / magic-link LOGIN (no password field) — a lone email box with this
// copy is authentication, not a subscription.
const MAGIC_LINK_RE = /\b(sign\s?in|log\s?in|login|magic link|login link|passwordless|password-less)\b/i;
// A lone-email capture is NOT a newsletter when the copy is careers / RSVP / waitlist (a lead form).
const NOT_NEWSLETTER_RE = /\b(career|careers|job|apply|application|vacan|recruit|rsvp|wait\s?list)\b/i;
const CONSENT_RE = /privacy|terms|consent|agree|policy|gdpr|datenschutz|i accept|einwilligung|acepto|j'accepte/i;
const SEARCH_RE = /^(q|s|query|search|keyword|term)$/i;
const MESSAGE_RE = /message|comment|enquiry|inquiry|nachricht|consulta/i;

export interface PiiField {
  name: string;
  label: string;
  category: PiiCategory;
}

export interface MarketingCheckbox {
  label: string;
  prechecked: boolean;
}

export type FormPurpose = 'search' | 'login' | 'signup' | 'newsletter' | 'contact' | 'checkout' | 'other';

export interface FormIssue {
  id: string;
  severity: 'low' | 'medium' | 'high';
  finding: string;
  suggestedFix: string;
}

export interface FormAnalysis {
  index: number;
  action: string;
  method: string;
  formId: string;
  formClasses: string;
  title: string;
  purpose: FormPurpose;
  fieldCount: number;
  fields: Pick<RawFormField, 'type' | 'name' | 'label' | 'required'>[];
  piiFields: PiiField[];
  marketingCheckboxes: MarketingCheckbox[];
  hasConsentCheckbox: boolean;
  hasPrivacyLink: boolean;
  issues: FormIssue[];
  /** Not rendered at scan time (a modal/popup form that opens on a click). */
  hidden?: boolean;
}

export function classifyFieldPii(field: RawFormField): PiiCategory | null {
  const hay = `${field.name} ${field.id} ${field.label} ${field.placeholder}`;
  for (const rule of PII_RULES) {
    if (rule.types && rule.types.includes(field.type)) return rule.category;
    if (rule.autocomplete && field.autocomplete && rule.autocomplete.test(field.autocomplete)) return rule.category;
    if (rule.re.test(hay)) return rule.category;
  }
  return null;
}

function guessPurpose(form: RawForm, pii: PiiField[]): FormPurpose {
  const textInputs = form.fields.filter((f) => !['checkbox', 'radio', 'select'].includes(f.type));
  // A lone EMAIL input is a signup/newsletter capture, never a search box (which is type text/search) —
  // so don't let a name like "s"/"q" misroute it to 'search' before the email checks below run.
  if (textInputs.length === 1 && textInputs[0].type !== 'email' && (SEARCH_RE.test(textInputs[0].name) || /search/i.test(form.action))) return 'search';
  const hasPassword = form.fields.some((f) => f.type === 'password');
  if (hasPassword) {
    return /sign.?up|register|create.?account/i.test(form.text + ' ' + form.action) ? 'signup' : 'login';
  }
  if (/checkout|payment|billing/i.test(form.action + ' ' + form.text) || pii.some((p) => p.category === 'payment')) {
    return 'checkout';
  }
  const hasEmail = pii.some((p) => p.category === 'email');
  const hasMessage = form.fields.some((f) => f.tag === 'textarea' || MESSAGE_RE.test(`${f.name} ${f.label}`));
  if (hasEmail && hasMessage) return 'contact';
  // Passwordless / magic-link LOGIN: a lone-ish email box (no password) whose copy says sign in / log in /
  // magic link is authentication — classify as login BEFORE newsletter so the lone-email rule below can't
  // brand it a subscription.
  if (hasEmail && !hasMessage && textInputs.length <= 2 && MAGIC_LINK_RE.test(form.text)) return 'login';
  // A bare email capture (or email+name) is a newsletter subscription when its copy/button carries a
  // marketing or sign-up cue — OR when it is a lone email field (nothing else to collect but an address,
  // the canonical newsletter shape). The !hasMessage guard + textInputs.length <= 2 keep a real CONTACT
  // form (a message/textarea, or >=3 text fields) out; NOT_NEWSLETTER_RE keeps careers/RSVP/waitlist lead
  // captures out even when they are a lone email field.
  if (
    hasEmail &&
    !hasMessage &&
    textInputs.length <= 2 &&
    !NOT_NEWSLETTER_RE.test(form.text) &&
    (MARKETING_RE.test(form.text) || NEWSLETTER_VERB_RE.test(form.text) || textInputs.length === 1)
  ) {
    return 'newsletter';
  }
  if (hasEmail || pii.length > 0) return 'contact';
  return 'other';
}

function registrableHost(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return h;
  } catch {
    return null;
  }
}

function isThirdPartyAction(action: string, pageUrl: string): boolean {
  const a = registrableHost(action);
  const p = registrableHost(pageUrl);
  if (!a || !p || a === p) return false;
  // Same registrable suffix (sub.example.com vs example.com) is first-party.
  return !(a.endsWith(`.${p}`) || p.endsWith(`.${a}`));
}

/** Pure analysis over raw form descriptors extracted from one page. */
export function analyzeForms(rawForms: RawForm[], pageUrl: string): FormAnalysis[] {
  return rawForms.map((form) => {
    const piiFields: PiiField[] = [];
    for (const f of form.fields) {
      if (f.type === 'checkbox' || f.type === 'radio') continue;
      const category = classifyFieldPii(f);
      if (category) piiFields.push({ name: f.name || f.id || f.placeholder || f.type, label: f.label, category });
    }

    const marketingCheckboxes: MarketingCheckbox[] = [];
    let hasConsentCheckbox = false;
    for (const f of form.fields) {
      if (f.type !== 'checkbox') continue;
      const hay = `${f.name} ${f.id} ${f.label}`;
      if (MARKETING_RE.test(hay)) {
        marketingCheckboxes.push({ label: (f.label || f.name).slice(0, 120), prechecked: f.checked === true });
      } else if (CONSENT_RE.test(hay)) {
        hasConsentCheckbox = true;
      }
    }

    const purpose = guessPurpose(form, piiFields);
    const issues: FormIssue[] = [];
    const where = `form #${form.index}${form.action ? ` (action: ${form.action.slice(0, 120)})` : ''}`;

    if (/^http:\/\//i.test(form.action) && piiFields.length > 0) {
      issues.push({
        id: `form_${form.index}_insecure_action`,
        severity: 'high',
        finding: `${where} submits personal data over plain HTTP.`,
        suggestedFix: 'Serve the form and its action endpoint over HTTPS.',
      });
    }
    for (const cb of marketingCheckboxes) {
      if (cb.prechecked) {
        issues.push({
          id: `form_${form.index}_prechecked_marketing`,
          severity: 'high',
          finding: `${where} has a pre-ticked marketing opt-in ("${cb.label}"). GDPR/ePrivacy require unticked, affirmative opt-in.`,
          suggestedFix: 'Render the marketing checkbox unticked by default and record the opt-in with a timestamp.',
        });
      }
    }
    if (
      piiFields.length > 0 &&
      !hasConsentCheckbox &&
      !form.hasPrivacyLink &&
      purpose !== 'search' &&
      purpose !== 'login'
    ) {
      issues.push({
        id: `form_${form.index}_pii_no_notice`,
        severity: 'medium',
        finding: `${where} collects ${piiFields.map((p) => p.category).join(', ')} with no privacy notice link or consent checkbox in the form.`,
        suggestedFix: 'Link the privacy policy at the point of collection (GDPR Art. 13) and add an explicit consent control where the processing relies on consent.',
      });
    }
    if (isThirdPartyAction(form.action, pageUrl) && piiFields.length > 0) {
      issues.push({
        id: `form_${form.index}_third_party_action`,
        severity: 'medium',
        finding: `${where} posts personal data to a third-party domain.`,
        suggestedFix: 'Verify a data-processing agreement covers this processor and disclose it in the privacy notice.',
      });
    }

    return {
      index: form.index,
      action: form.action,
      method: form.method,
      formId: form.formId,
      ...(form.providerFormId ? { providerFormId: form.providerFormId } : {}),
      formClasses: form.formClasses,
      title: form.title,
      purpose,
      fieldCount: form.fieldCount,
      fields: form.fields.map((f) => ({ type: f.type, name: f.name, label: f.label, required: f.required })),
      piiFields,
      marketingCheckboxes,
      hasConsentCheckbox,
      hasPrivacyLink: form.hasPrivacyLink,
      issues,
      ...(form.hidden ? { hidden: true } : {}),
    };
  });
}

/** Convenience: extract + analyze on a settled page. */
export async function scanForms(page: PwPage, pageUrl: string): Promise<FormAnalysis[]> {
  const raw = await page.evaluate<RawForm[]>(extractFormsInPage);
  return analyzeForms(Array.isArray(raw) ? raw : [], pageUrl);
}
