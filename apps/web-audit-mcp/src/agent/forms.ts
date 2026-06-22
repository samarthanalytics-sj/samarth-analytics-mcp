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
}

export interface RawForm {
  index: number;
  action: string;
  method: string;
  /** The form element's own id/name/classes — used to scope the GTM trigger to
   *  THIS form (filter {{Form ID}} / {{Form Classes}}) instead of all forms. */
  formId: string;
  formName: string;
  formClasses: string;
  fieldCount: number;
  fields: RawFormField[];
  hasPrivacyLink: boolean;
  /** Lower-cased visible text of the form, capped — for keyword scans. */
  text: string;
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
  const SUBMIT_RE = /\b(submit|send|subscribe|sign\s*up|sign\s*me\s*up|get\s+started|register|join\b|request\s+(a\s+)?(quote|demo|info|callback)|contact\s+us|book\s+(a\s+)?(demo|call|meeting)|get\s+(a\s+)?quote)\b/i;
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
    return {
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
  };
  const fieldsIn = (root: Element): RawFormField[] => {
    const fields: RawFormField[] = [];
    for (const el of Array.from(root.querySelectorAll('input, select, textarea')).slice(0, MAX_FIELDS)) {
      const f = fieldOf(el);
      if (f) fields.push(f);
    }
    return fields;
  };
  const privacyIn = (root: Element): boolean =>
    Boolean(root.querySelector('a[href*="privacy"], a[href*="datenschutz"], a[href*="confidentialite"], a[href*="privacidad"], a[href*="cookie-policy"]'));

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
        formName: form.getAttribute('name') || '',
        formClasses: form.getAttribute('class') || '',
        fieldCount: fields.length,
        fields,
        hasPrivacyLink: privacyIn(form),
        text: (form.textContent || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
      });
    }
    // 2. div/JS "forms": a non-<form> container with input field(s) + a submit-
    //    like control. Anchored on the submit button → climb to the smallest
    //    ancestor that also holds a text-ish field. Requires a real text input
    //    (not just selects) so filter/search widgets aren't mistaken for forms.
    const seen: Element[] = [];
    for (const btn of Array.from(doc.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))) {
      if (out.length >= MAX_FORMS) break;
      if (btn.closest('form')) continue;
      const label = ((btn.textContent || '') + ' ' + ((btn as HTMLInputElement).value || '')).trim();
      if (!SUBMIT_RE.test(label)) continue;
      let host: Element | null = null;
      let node: Element | null = btn.parentElement;
      for (let i = 0; node && i < 6; i++, node = node.parentElement) {
        if (node.tagName === 'FORM') break;
        if (fieldsIn(node).length >= 1) {
          host = node;
          break;
        }
      }
      if (!host || host.closest('form')) continue;
      // Skip overlapping hosts (nested clusters resolving to the same widget).
      if (seen.some((h) => h.contains(host!) || host!.contains(h))) continue;
      const fields = fieldsIn(host);
      if (!fields.some((f) => TEXTISH.has(f.type))) continue;
      seen.push(host);
      out.push({
        index: out.length,
        action: '', // div/JS forms submit via JS — no element action to read
        method: 'js',
        formId: host.getAttribute('id') || '',
        formName: '',
        formClasses: host.getAttribute('class') || '',
        fieldCount: fields.length,
        fields,
        hasPrivacyLink: privacyIn(host),
        text: ((host.textContent || '') + ' ' + label).toLowerCase().replace(/\s+/g, ' ').slice(0, 1500),
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
  purpose: FormPurpose;
  fieldCount: number;
  fields: Pick<RawFormField, 'type' | 'name' | 'label' | 'required'>[];
  piiFields: PiiField[];
  marketingCheckboxes: MarketingCheckbox[];
  hasConsentCheckbox: boolean;
  hasPrivacyLink: boolean;
  issues: FormIssue[];
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
  if (textInputs.length === 1 && (SEARCH_RE.test(textInputs[0].name) || /search/i.test(form.action))) return 'search';
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
  if (hasEmail && form.fieldCount <= 3 && MARKETING_RE.test(form.text)) return 'newsletter';
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
      formClasses: form.formClasses,
      purpose,
      fieldCount: form.fieldCount,
      fields: form.fields.map((f) => ({ type: f.type, name: f.name, label: f.label, required: f.required })),
      piiFields,
      marketingCheckboxes,
      hasConsentCheckbox,
      hasPrivacyLink: form.hasPrivacyLink,
      issues,
    };
  });
}

/** Convenience: extract + analyze on a settled page. */
export async function scanForms(page: PwPage, pageUrl: string): Promise<FormAnalysis[]> {
  const raw = await page.evaluate<RawForm[]>(extractFormsInPage);
  return analyzeForms(Array.isArray(raw) ? raw : [], pageUrl);
}
