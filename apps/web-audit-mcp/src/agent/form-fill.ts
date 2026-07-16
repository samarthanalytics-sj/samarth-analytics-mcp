/**
 * PURE form-fill planning (no browser, unit-testable).
 *
 * Given a form's OWN fields (RawFormField from forms.ts — "Option 2": fetched from the real form,
 * not a fixed name/email/phone set), classify each field's role and produce a fill plan of
 * locale-appropriate test values the operator can review + edit before a real submit. This is the
 * data layer for real-submit tag verification; it fills NOTHING and submits NOTHING on its own.
 *
 * Location: a LocaleProfile supplies valid values per role. US is the default; UK/AUS/etc. are added
 * to LOCALES later with the right phone/postcode/region formats.
 */

import type { RawFormField } from './forms.js';

export type FieldRole =
  | 'given_name' | 'family_name' | 'full_name'
  | 'email' | 'phone' | 'website'
  | 'street' | 'city' | 'state' | 'postal' | 'country'
  | 'company' | 'job_title'
  | 'subject' | 'message'
  | 'consent' | 'marketing_opt_in'
  | 'select' | 'number' | 'date'
  | 'honeypot'
  | 'other';

/** One field's fill instruction — the row the review UI shows and the driver later applies. */
export interface FillPlanItem {
  /** A stable selector to fill (name-based, else id-based). */
  selector: string;
  name: string;
  label: string;
  type: string;
  role: FieldRole;
  required: boolean;
  /** The value to enter — locale default, user-editable. For a checkbox: 'true' = check. */
  value: string;
  /** For a <select>/radio: the real options, so the UI can offer them and the fill picks a valid one. */
  options?: string[];
}

/** A location's valid test values. `data` covers the text roles; email/consent/select are computed. */
export interface LocaleProfile {
  id: string;
  label: string;
  /** How this locale's country reads in a country field/select (matched case-insensitively). */
  country: string;
  data: Record<FieldRole, string>;
}

// Simple, uniform test values (operator preference): text = "Test", numbers = 1234567890, longer
// message/comment fields = "test form please ignore". Format-critical fields stay valid so the form still
// submits: email is computed (test@gmail.com), website is a real URL, country/select pick a real option.
const US_DATA: Record<FieldRole, string> = {
  given_name: 'Test',
  family_name: 'Test',
  full_name: 'Test',
  email: '', // computed — see buildFillPlan (default test@gmail.com)
  phone: '1234567890',
  website: 'https://example.com', // a URL field needs a valid URL, not "Test"
  street: 'Test',
  city: 'Test',
  state: 'Test',
  postal: '1234567890',
  country: 'United States', // kept valid so a country <select> matches a real option
  company: 'Test',
  job_title: 'Test',
  subject: 'Test',
  message: 'test form please ignore', // textarea / comments / longer-text fields
  consent: '', // checkbox — 'true' applied by valueForRole
  marketing_opt_in: '', // leave unchecked
  select: '', // pick a real option at fill time
  number: '1234567890',
  date: '2025-01-01',
  honeypot: '', // anti-spam trap — MUST stay empty or the submit is silently rejected
  other: 'Test',
};

export const US_LOCALE: LocaleProfile = { id: 'us', label: 'United States', country: 'United States', data: US_DATA };

/** Registry of supported locations. US now; UK/AUS/etc. added here later. */
export const LOCALES: Record<string, LocaleProfile> = { us: US_LOCALE };
export const DEFAULT_LOCALE_ID = 'us';

export function localeById(id: string | undefined): LocaleProfile {
  return (id && LOCALES[id.toLowerCase()]) || US_LOCALE;
}

const isSelect = (f: RawFormField): boolean => f.tag === 'select' || /^select/.test(f.type);

/** Classify a field's fill role from its type + autocomplete + name/label/placeholder. Reuses the
 *  same signals as the PII classifier but resolves finer roles (first vs last name, city vs state vs
 *  postal vs country) so the locale can supply the RIGHT value. */
export function classifyFieldRole(field: RawFormField): FieldRole {
  const type = (field.type || '').toLowerCase();
  const ac = (field.autocomplete || '').toLowerCase();
  const hay = `${field.name} ${field.id} ${field.label} ${field.placeholder}`.toLowerCase();
  const has = (re: RegExp): boolean => re.test(hay);

  // Honeypot (anti-spam) fields must be left EMPTY — filling one makes the site's spam guard silently
  // reject the submit, so the form fires form_start but never form_submission (its tags never fire).
  // Detect by well-known honeypot names OR by a text-style field that's hidden from real users
  // (display:none / visibility:hidden / off-screen — a text box a human can't see is a trap).
  const nameHoneypot = /honey.?pot|(^|[^a-z0-9])hp([^a-z0-9]|$)|gotcha|bot[-_]?field|botcheck/.test(`${field.name} ${field.id} ${field.label}`.toLowerCase());
  const textish = field.tag === 'textarea' || ['', 'text', 'email', 'tel', 'url', 'search', 'number', 'password'].includes(type);
  if (nameHoneypot || (field.hidden === true && textish)) return 'honeypot';

  if (type === 'checkbox') {
    return has(/newsletter|marketing|subscribe|offers?|promo|updates|mailing/) ? 'marketing_opt_in' : 'consent';
  }

  // Strongest → weakest. autocomplete wins, then type, then name/label keywords.
  if (ac === 'email' || type === 'email') return 'email';
  if (/tel/.test(ac) || type === 'tel' || has(/\bphone|mobile|telephone|whatsapp\b/)) return 'phone';
  if (ac === 'given-name' || has(/\b(first|given|vor)[\s_-]?name\b|\bfname\b/)) return 'given_name';
  if (ac === 'family-name' || has(/\b(last|sur|family|nach)[\s_-]?name\b|\blname\b/)) return 'family_name';
  if (ac === 'organization' || has(/\bcompany\b|\bbusiness\b|organi[sz]ation|\bemployer\b/)) return 'company';
  if (ac === 'organization-title' || has(/job[\s_-]?title|\bposition\b|\bdesignation\b/)) return 'job_title';
  if (ac === 'name' || has(/\bfull[\s_-]?name\b|\byour[\s_-]?name\b|\bcontact[\s_-]?name\b|\bname\b/)) return 'full_name';
  if (type === 'url' || ac === 'url' || has(/\bwebsite\b|\burl\b/)) return 'website';
  if (/street-address|address-line/.test(ac) || has(/\bstreet\b|address[\s_-]?line|\baddress\b/)) return 'street';
  if (ac === 'address-level2' || has(/\bcity\b|\btown\b|\bsuburb\b/)) return 'city';
  if (ac === 'address-level1' || has(/\bstate\b|\bprovince\b|\bregion\b|\bcounty\b/)) return 'state';
  if (/postal-code/.test(ac) || has(/\bzip\b|\bpostal\b|postcode|\bplz\b/)) return 'postal';
  if (ac === 'country' || ac === 'country-name' || has(/\bcountry\b/)) return 'country';
  if (has(/\bsubject\b|\btopic\b|regarding/)) return 'subject';
  if (type === 'textarea' || field.tag === 'textarea' || has(/message|comment|enquiry|inquiry|\bnote\b|details/)) return 'message';
  if (isSelect(field)) return 'select';
  if (type === 'number') return 'number';
  if (type === 'date') return 'date';
  return 'other';
}

/** A placeholder <option> like "Please select", "-- Choose --", or an empty one — never a real value. */
function isPlaceholderOption(o: string): boolean {
  return !o.trim() || /^(-+\s*)?(please\s+)?(select|choose|pick|none|--)/i.test(o.trim());
}

/** Pick the option that matches the intended value (country/state), else the first real option. */
function chooseOption(options: string[], want: string): string {
  if (want) {
    const w = want.toLowerCase();
    const hit = options.find((o) => { const l = o.toLowerCase(); return l.includes(w) || w.includes(l); });
    if (hit) return hit;
  }
  return options.find((o) => !isPlaceholderOption(o)) ?? options[0] ?? '';
}

function valueForRole(role: FieldRole, field: RawFormField, locale: LocaleProfile, email: string): string {
  if (role === 'honeypot') return ''; // never fill an anti-spam trap
  if (role === 'consent') return 'true'; // tick required privacy/terms boxes
  if (role === 'marketing_opt_in') return ''; // leave promo opt-ins unchecked
  const base = role === 'email' ? email : (locale.data[role] ?? '');
  if (field.options && field.options.length) return chooseOption(field.options, base);
  return base || locale.data.other;
}

function cssEscapeAttr(v: string): string {
  return v.replace(/(["\\])/g, '\\$1');
}

/** A stable selector for filling: name first (survives re-render better than a generated id), then id. */
export function selectorFor(field: RawFormField): string {
  if (field.name) return `[name="${cssEscapeAttr(field.name)}"]`;
  if (field.id) return `#${cssEscapeAttr(field.id)}`;
  return field.tag || field.type || '*';
}

/** Build the review-and-fill plan for one form's fields, in a chosen location (default US).
 *  `emailTag` makes the test email traceable + unique per run (e.g. a run id / timestamp). PURE. */
export function buildFillPlan(
  fields: RawFormField[],
  locale: LocaleProfile = US_LOCALE,
  opts: { emailTag?: string } = {},
): FillPlanItem[] {
  // Default test email is a plain, editable test@gmail.com (the user asked for simple test values). The
  // emailTag can still make it traceable/unique if a caller opts in, but the default is the simple address.
  const tag = (opts.emailTag || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
  const email = tag ? `test+${tag}@gmail.com` : 'test@gmail.com';
  return fields
    .map((f) => {
      const role = classifyFieldRole(f);
      return {
        selector: selectorFor(f),
        name: f.name,
        label: (f.label || f.placeholder || f.name || f.type).slice(0, 120),
        type: f.type,
        role,
        required: f.required === true,
        value: valueForRole(role, f, locale, email),
        ...(f.options && f.options.length ? { options: f.options } : {}),
      };
    })
    // Drop honeypots from the plan: not shown, not filled → they submit empty and the spam guard passes.
    .filter((item) => item.role !== 'honeypot');
}
