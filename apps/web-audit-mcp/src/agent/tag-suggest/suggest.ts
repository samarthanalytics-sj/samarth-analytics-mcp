// The suggestion mapper: detected forms + elements → SuggestedTag[]. PURE +
// unit-tested. Encodes the "what GTM tag should exist for this?" rules, including
// the key nuance that GA4 Enhanced Measurement already auto-tracks some of these
// (outbound clicks, file downloads) — those are FLAGGED, not blindly pushed, so
// we don't suggest redundant tags. Output is directly creatable via the existing
// create_gtm_tracking_tag tool.

import type { DetectedForm, DetectedElement, SuggestInput, SuggestedTag } from './types.js';

const GA4_VAR = '{{GA4 Measurement ID}}';
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

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
    tagName: `GA4 - ${eventName}`,
    measurementId: GA4_VAR,
    eventName,
    trigger: { name: `Form submit - ${f.purpose}`, kind: 'form_submit' },
  };
}

function elementSuggestion(el: DetectedElement): SuggestedTag | null {
  const base = (eventName: string, conf: SuggestedTag['confidence'], em: boolean) => ({
    id: hashId(el.kind + '|' + el.page + '|' + (el.href ?? el.text ?? '')),
    page: el.page,
    confidence: conf,
    enhancedMeasurementOverlap: em,
    platform: 'ga4_event' as const,
    tagName: `GA4 - ${eventName}`,
    measurementId: GA4_VAR,
    eventName,
  });
  switch (el.kind) {
    case 'email':
      return {
        ...base('email_click', 'high', false),
        label: 'Email link (mailto) → GA4 "email_click"',
        evidence: `mailto link${el.region ? ' in ' + el.region : ''}`,
        trigger: { name: 'Email link click', kind: 'link_click', clickUrlValue: 'mailto:', clickUrlOperator: 'startsWith' },
      };
    case 'phone':
      return {
        ...base('phone_click', 'high', false),
        label: 'Phone link (tel) → GA4 "phone_click"',
        evidence: `tel link${el.region ? ' in ' + el.region : ''}`,
        trigger: { name: 'Phone link click', kind: 'link_click', clickUrlValue: 'tel:', clickUrlOperator: 'startsWith' },
      };
    case 'download':
      return {
        ...base('file_download', 'medium', true), // EM already auto-tracks downloads
        label: 'File download → GA4 "file_download"  ⚠ Enhanced Measurement already covers this',
        evidence: `download link ${el.href ?? ''}`.trim(),
        trigger: { name: 'File download click', kind: 'link_click', clickUrlValue: '\\.(pdf|zip|docx?|xlsx?|pptx?|csv|dmg|exe)(\\?|$)', clickUrlOperator: 'matchRegex' },
      };
    case 'outbound':
      return {
        ...base('outbound_click', 'medium', true), // EM already auto-tracks outbound
        label: 'Outbound link → GA4 "outbound_click"  ⚠ Enhanced Measurement already covers this',
        evidence: `outbound link ${el.href ?? ''}`.trim(),
        trigger: { name: 'Outbound link click', kind: 'link_click' },
      };
    case 'cta':
      return {
        ...base('cta_click', 'low', false),
        label: `CTA "${el.text}" → GA4 "cta_click"`,
        evidence: `button/link text "${el.text}"`,
        eventParameters: [{ name: 'cta_text', value: el.text }],
        trigger: { name: 'CTA click', kind: 'all_clicks' },
      };
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
    // CTAs are distinguished only by their text — keep distinct CTAs distinct;
    // every other kind genuinely collapses to one tag (one mailto:, one regex
    // file_download, one outbound, etc.).
    const disc = s.eventName === 'cta_click' ? (s.eventParameters?.[0]?.value ?? s.label) : '';
    const key = `${s.eventName}|${s.trigger.kind}|${s.trigger.clickUrlValue ?? ''}|${disc}`;
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
