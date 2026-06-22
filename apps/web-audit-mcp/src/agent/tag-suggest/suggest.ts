// The suggestion mapper: detected forms + elements → SuggestedTag[]. PURE +
// unit-tested. Encodes the "what GTM tag should exist for this?" rules, including
// the key nuance that GA4 Enhanced Measurement already auto-tracks some of these
// (outbound clicks, file downloads) — those are FLAGGED, not blindly pushed, so
// we don't suggest redundant tags. Output is directly creatable via the existing
// create_gtm_tracking_tag tool.

import type { DetectedForm, DetectedElement, SuggestInput, SuggestedTag } from './types.js';
import { CTA_BY_INTENT } from './cta-intents.js';

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

// Human-readable label for a GA4 event name, used in tag names.
const EVENT_LABEL: Record<string, string> = {
  email_click: 'Email Click',
  phone_click: 'Phone Click',
  file_download: 'File Download',
  outbound_click: 'Outbound Click',
  social_click: 'Social Media Click',
  cta_click: 'CTA Click',
  generate_lead: 'Generate Lead',
  sign_up: 'Sign Up',
  newsletter_signup: 'Newsletter Signup',
  form_submission: 'Form Submission',
};
const eventLabel = (e: string): string => EVENT_LABEL[e] ?? e.split('_').map(cap).join(' ');

// Form purpose → human tag label. Names the tag for WHAT IT IS ("Contact Form")
// rather than only the GA4 event ("Generate Lead").
const FORM_LABEL: Record<string, string> = {
  contact: 'Contact Form',
  signup: 'Signup Form',
  newsletter: 'Newsletter Form',
  other: 'Form Submission',
};

// {{Click URL}} regex for the social-link trigger — HOST-anchored so it mirrors
// collect.ts isSocialHost and fires ONLY on real social hosts (not on a path like
// /facebook.html, a ?ref=facebook.com query, or "microsof[t.co]m"). (?i) makes
// GTM's RE2 matchRegex case-insensitive. Long hosts: the brand must be the
// registrable label before a TLD that ends the host (boundary [/:?#] or end).
const SOCIAL_URL_PATTERN =
  '(?i)://([a-z0-9-]+\\.)*(facebook|instagram|linkedin|youtube|twitter|tiktok|pinterest|snapchat|reddit|threads|tumblr|whatsapp|telegram|discord|vimeo|twitch|mastodon)\\.[a-z]{2,}(\\.[a-z]{2,})?([/:?#]|$)|://(www\\.)?(x\\.com|t\\.co|fb\\.(com|me)|m\\.me|lnkd\\.in|youtu\\.be|wa\\.me|t\\.me|instagr\\.am|pin\\.it)([/:?#]|$)';

// djb2 → base36; stable, no crypto dependency.
function hashId(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Form purpose → GA4 event. Prefer GA4 recommended events where they exist.
const FORM_EVENT: Record<string, string> = {
  contact: 'generate_lead',
  signup: 'sign_up',
  newsletter: 'newsletter_signup',
  // NOT "form_submit": that's the reserved name GA4 Enhanced Measurement's form
  // interactions emits, so reusing it would double-count.
  other: 'form_submission',
};

function formSuggestion(f: DetectedForm): SuggestedTag | null {
  // Skip: search/login submits aren't conversions; checkout is ECOMMERCE — it
  // needs the dataLayer (begin_checkout/purchase), not a form-submit tag, so it's
  // deferred to the v3 ecommerce phase rather than mis-suggested here.
  if (f.purpose === 'search' || f.purpose === 'login' || f.purpose === 'checkout') return null;
  const eventName = FORM_EVENT[f.purpose] ?? 'form_submission';
  const prov = f.provider.vendor !== 'unknown' ? ` (${f.provider.vendor})` : '';
  return {
    id: hashId('form|' + f.page + '|' + f.purpose + '|' + f.action),
    page: f.page,
    label: `${cap(f.purpose)} form${prov} → GA4 "${eventName}" on form submit`,
    evidence: `form purpose=${f.purpose}; provider=${f.provider.vendor} (${f.provider.evidence})`,
    confidence: 'high',
    // GA4 EM "form interactions" is limited/generic; a dedicated lead event is valuable.
    enhancedMeasurementOverlap: false,
    platform: 'ga4_event',
    tagName: `GA4 Event - ${FORM_LABEL[f.purpose] ?? 'Form Submission'}`,
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
    trigger: { name: `Form Submit - ${cap(f.purpose)}`, kind: 'form_submit' },
  };
}

function elementSuggestion(el: DetectedElement): SuggestedTag | null {
  const base = (eventName: string, conf: SuggestedTag['confidence'], em: boolean) => ({
    id: hashId(el.kind + '|' + el.page + '|' + (el.href ?? el.text ?? '')),
    page: el.page,
    confidence: conf,
    enhancedMeasurementOverlap: em,
    platform: 'ga4_event' as const,
    tagName: `GA4 Event - ${eventLabel(eventName)}`,
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
        trigger: { name: 'Link Click - Email', kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
      };
    case 'phone':
      return {
        ...base('phone_click', 'high', false),
        label: 'Phone link (tel) → GA4 "phone_click"',
        evidence: `tel link${el.region ? ' in ' + el.region : ''}`,
        eventParameters: CLICK_PARAMS,
        trigger: { name: 'Link Click - Phone', kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' },
      };
    case 'download':
      return {
        ...base('file_download', 'medium', true), // EM already auto-tracks downloads
        label: 'File download → GA4 "file_download"  ⚠ Enhanced Measurement already covers this',
        evidence: `download link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: { name: 'Link Click - File Download', kind: 'link_click', clickUrlValue: `\\.(${DOWNLOAD_EXT})(\\?|#|$)`, clickUrlOperator: 'matchRegex' },
      };
    case 'outbound':
      return {
        ...base('outbound_click', 'medium', true), // EM already auto-tracks outbound
        label: 'Outbound link → GA4 "outbound_click"  ⚠ Enhanced Measurement already covers this',
        evidence: `outbound link ${el.href ?? ''}`.trim(),
        eventParameters: CLICK_PARAMS,
        trigger: { name: 'Link Click - Outbound', kind: 'link_click' },
      };
    case 'social':
      return {
        ...base('social_click', 'medium', false),
        label: 'Social media link → GA4 "social_click"',
        // A social link IS outbound, so EM's outbound_click also fires — but this
        // dedicated, named event (with the link captured) is what's usually wanted.
        evidence: `social media link ${el.href ?? ''}`.trim() + ' (note: EM also tracks this as an outbound click)',
        eventParameters: CLICK_PARAMS,
        trigger: { name: 'Link Click - Social Media', kind: 'link_click', clickUrlValue: SOCIAL_URL_PATTERN, clickUrlOperator: 'matchRegex' },
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
      const trigName = isSpecific
        ? `All Clicks - ${def.label.replace(/ Click$/, '')}`
        : `All Clicks - CTA: ${el.text.slice(0, 40)}`;
      const trigger: SuggestedTag['trigger'] = isSpecific
        ? { name: trigName, kind: 'all_clicks', clickTextValue: `(?i)${def.pattern}`, clickTextOperator: 'matchRegex' }
        : { name: trigName, kind: 'all_clicks', clickTextValue: el.text, clickTextOperator: 'contains' };
      return {
        ...base(def.event, isSpecific ? 'medium' : 'low', false),
        // Name the tag for what the click IS, not the raw event id.
        tagName: `GA4 Event - ${def.label}`,
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
  const raw: SuggestedTag[] = [
    ...input.forms.map(formSuggestion),
    ...input.elements.map(elementSuggestion),
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
    const key = `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${s.trigger.clickTextValue ?? ''}`;
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
