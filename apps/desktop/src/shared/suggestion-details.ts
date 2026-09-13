// Per-suggestion "Details" panel content: turn the engine's compact evidence string
// ("form purpose=contact; provider=hubspot (class hsForm_); data-form-id=GUID; fields: email, name")
// into labelled lines a user can read, with the form vendor's proper product name. PURE - the
// renderer's DetailsChip/DetailsPanel render what this returns, and nothing here guesses: every line
// comes from what the scan actually recorded, unknown segments pass through verbatim.

/** Vendor slug (FormProvider in the scan engine) → the product name a user would recognise. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  hubspot: 'HubSpot Forms',
  typeform: 'Typeform',
  paperform: 'Paperform',
  mailchimp: 'Mailchimp',
  gravityforms: 'Gravity Forms',
  contactform7: 'Contact Form 7',
  wpforms: 'WPForms',
  ninjaforms: 'Ninja Forms',
  elementor: 'Elementor Forms',
  marketo: 'Marketo Forms',
  pardot: 'Pardot (Account Engagement)',
  salesforce: 'Salesforce Web-to-Lead',
  calendly: 'Calendly',
  jotform: 'Jotform',
  formstack: 'Formstack',
  tally: 'Tally',
  googleforms: 'Google Forms',
  wufoo: 'Wufoo',
  klaviyo: 'Klaviyo',
  activecampaign: 'ActiveCampaign',
  unbounce: 'Unbounce',
  webflow: 'Webflow Forms',
  embed: 'Embedded form (iframe)',
  unknown: 'Standard HTML form',
};

export function providerDisplayName(slug: string): string {
  const key = String(slug ?? '').trim().toLowerCase();
  return PROVIDER_NAMES[key] ?? (key ? key : 'Standard HTML form');
}

export interface DetailLine {
  /** Friendly label; '' for a free-text line that has no key. */
  label: string;
  value: string;
}

/** Does this label carry the vendor's own durable form identifier (the thing a HubSpot/Gravity/CF7
 *  trigger is scoped on)? Used by the panel to highlight that line. */
export function isProviderFormIdLabel(label: string): boolean {
  // Covers the durable-id sources provider-form-id.ts emits: data-form-id / data-formid /
  // data-wpcf7-id attributes, "DOM id gform_2 / wpforms-form-12 / mktoForm_521" style sources,
  // and bare GUID mentions. "Form type" / "Form class" deliberately do NOT match.
  return /form.?id|formid|data-form|wpcf7|gform|guid|^dom id/i.test(label);
}

/**
 * Parse one suggestion's evidence string into labelled lines.
 *
 * The engine joins segments with '; ' (field lists use ', ', so the split is safe). Known keys get
 * friendly labels; a generic `key=value` segment keeps its key (this is how the vendor's durable
 * form id arrives, e.g. "data-form-id=<guid>" or "DOM id gform_2=2" - split on the LAST '=' because
 * sources may contain spaces but values are bare ids); anything else passes through as free text.
 */
export function parseSuggestionEvidence(evidence: string): DetailLine[] {
  const text = String(evidence ?? '').trim();
  if (!text) return [];
  const out: DetailLine[] = [];
  for (const raw of text.split('; ')) {
    const seg = raw.trim();
    if (!seg) continue;
    let m: RegExpExecArray | null;
    if ((m = /^form purpose=(.+)$/.exec(seg))) {
      out.push({ label: 'Form type', value: m[1].charAt(0).toUpperCase() + m[1].slice(1) });
    } else if ((m = /^provider=([a-z0-9_]+)(?:\s*\((.+)\))?$/i.exec(seg))) {
      const name = providerDisplayName(m[1]);
      out.push({ label: 'Provider', value: m[2] ? `${name} (detected via ${m[2]})` : name });
    } else if ((m = /^fields:\s*(.+)$/.exec(seg))) {
      out.push({ label: 'Fields', value: m[1] });
      // A quote character or a stray `required=` INSIDE a field name means the site's own attribute
      // quoting is broken (seen live: name="industry” required=" with a typographer's quote) - the
      // browser then treats the junk as part of the name, and the backend receives a field that no
      // longer matches what it expects. Real finding, not a scan bug: say so.
      if (/["“”]|required=/.test(m[1])) {
        out.push({
          label: 'Warning',
          value: 'A field name contains quote characters or a stray attribute (broken quoting in the site\'s HTML). The browser submits it under that mangled name, so the backend may never receive that field - worth reporting to the site owner.',
        });
      }
    } else if ((m = /^id=#(.+)$/.exec(seg))) {
      out.push({ label: 'Form DOM id', value: `#${m[1]}` });
    } else if ((m = /^class=\.(.+)$/.exec(seg))) {
      out.push({ label: 'Form class', value: `.${m[1]}` });
    } else if ((m = /^page=(.+)$/.exec(seg))) {
      out.push({ label: 'Scoped to page', value: m[1] });
    } else if ((m = /^method=(.+)$/.exec(seg))) {
      out.push({ label: 'Method', value: m[1].toUpperCase() });
    } else if ((m = /^query key="(.+)"$/.exec(seg))) {
      out.push({ label: 'Query key', value: m[1] });
    } else if (/^hidden/i.test(seg)) {
      out.push({ label: 'Visibility', value: seg });
    } else if (seg.includes('=') && !seg.includes(' → ')) {
      // Generic key=value (the vendor's durable form id lands here). Split on the LAST '=': the
      // source side may contain spaces ("trailing GUID of the DOM id"), the value side never does.
      const at = seg.lastIndexOf('=');
      const key = seg.slice(0, at).trim();
      const value = seg.slice(at + 1).trim();
      if (key && value) out.push({ label: isProviderFormIdLabel(key) ? `Provider form ID (${key})` : key, value });
      else out.push({ label: '', value: seg });
    } else {
      out.push({ label: '', value: seg });
    }
  }
  return out;
}
