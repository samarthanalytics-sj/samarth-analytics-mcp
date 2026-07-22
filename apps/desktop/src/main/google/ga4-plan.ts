// GA4 SETUP PLAN - the audit's config findings turned into a selectable, one-click-applicable
// checklist (the GA4 mirror of the server container's plan/select/apply flow). PURE: reads the
// same Ga4PropertySnapshot the config audit reads, so plan and audit can never disagree.
//
// Honesty rules: an item is `executable` only when a write tool can truly apply it; decisions with
// business/privacy weight (attribution model, Google Signals) are never pre-selected; states this
// snapshot cannot read are SAID to be unread, not guessed; clean states appear as `ok` rows so the
// user sees what was verified, not only what is broken.

import type { Ga4PropertySnapshot } from './ga4-audit';

export interface Ga4PlanItem {
  id: string;
  category: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: 'issue' | 'ok';
  name: string;
  description: string;
  /** Optional value keys the apply step will use when provided (e.g. searchQueryParameter). */
  requires: string[];
  defaultSelected: boolean;
  executable: boolean;
}

export interface Ga4Plan {
  items: Ga4PlanItem[];
  detected: { property: string; displayName: string; retention: string | null; webStreams: number };
}

/** The numeric stream id from a full resource name ("properties/1/dataStreams/9" -> "9"). */
export const streamIdOf = (name: string): string => name.split('/').pop() ?? name;

export function buildGa4Plan(s: Ga4PropertySnapshot): Ga4Plan {
  const items: Ga4PlanItem[] = [];
  const push = (i: Ga4PlanItem): void => { items.push(i); };

  // ── Data retention ──
  if (s.dataRetention === null) {
    push({ id: 'retention', category: 'info', status: 'issue', name: 'Data retention (unread)', description: 'Retention settings could not be read - nothing to apply.', requires: [], defaultSelected: false, executable: false });
  } else if (s.dataRetention.eventDataRetention === 'TWO_MONTHS') {
    push({ id: 'retention_14', category: 'high', status: 'issue', name: 'Extend data retention 2 → 14 months', description: 'Event data currently expires after 2 months (the default), capping every explore/comparison window. 14 months is the free maximum.', requires: [], defaultSelected: true, executable: true });
  } else {
    push({ id: 'retention', category: 'info', status: 'ok', name: `Data retention: ${s.dataRetention.eventDataRetention}`, description: 'Already beyond the 2-month default.', requires: [], defaultSelected: false, executable: false });
  }
  if (s.dataRetention && !s.dataRetention.resetOnNewActivity) {
    push({ id: 'retention_reset', category: 'low', status: 'issue', name: 'Reset retention on new activity', description: 'Returning users currently age out even while active - enable reset-on-new-activity so active users keep their history.', requires: [], defaultSelected: true, executable: true });
  }

  // ── Enhanced measurement per WEB stream ──
  for (const st of s.dataStreams.filter((d) => d.type === 'WEB_DATA_STREAM')) {
    const sid = streamIdOf(st.name);
    const label = st.displayName || sid;
    if (st.enhancedMeasurementEnabled === false) {
      push({ id: `em_master:${sid}`, category: 'high', status: 'issue', name: `Enable enhanced measurement ("${label}")`, description: 'The master switch is OFF - scrolls, outbound clicks, site search, downloads, video and form interactions are not being measured on this stream.', requires: [], defaultSelected: true, executable: true });
      continue; // sub-toggles are meaningless while the master is off
    }
    const em = st.enhancedMeasurement;
    if (!em) continue; // sub-toggles unread - claim nothing
    if (!em.siteSearchEnabled) {
      push({ id: `em_site_search:${sid}`, category: 'medium', status: 'issue', name: `Enable site search ("${label}")`, description: 'Site-search tracking is OFF - what visitors search for is not captured. Optionally set the query parameter below if the site does not use the defaults (q, s, search, query, keyword).', requires: ['searchQueryParameter'], defaultSelected: true, executable: true });
    }
    if (!em.pageChangesEnabled) {
      push({ id: `em_page_changes:${sid}`, category: 'medium', status: 'issue', name: `Enable SPA page changes ("${label}")`, description: 'History-based page views are OFF - on a single-page site, navigation past the first page is invisible.', requires: [], defaultSelected: true, executable: true });
    }
    if (!em.formInteractionsEnabled) {
      push({ id: `em_form_interactions:${sid}`, category: 'low', status: 'issue', name: `Enable form interactions ("${label}")`, description: 'form_start / form_submit auto-events are OFF.', requires: [], defaultSelected: false, executable: true });
    }
    if (em.siteSearchEnabled && em.pageChangesEnabled && em.formInteractionsEnabled) {
      push({ id: `em_ok:${sid}`, category: 'info', status: 'ok', name: `Enhanced measurement fully on ("${label}")`, description: 'Master switch + site search + SPA page changes + form interactions all enabled.', requires: [], defaultSelected: false, executable: false });
    }
    // Email redaction: the snapshot does not read redaction state, so this is offered as an
    // idempotent hardening step, never claimed as currently off.
    push({ id: `email_redaction:${sid}`, category: 'low', status: 'issue', name: `Turn on email redaction ("${label}")`, description: 'Redact email addresses from URLs device-side before hits are sent (current state is not read by this audit; applying is idempotent and safe).', requires: [], defaultSelected: false, executable: true });
  }

  // ── Attribution ──
  if (s.attribution) {
    if (s.attribution.reportingAttributionModel !== 'PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN') {
      push({ id: 'attribution_data_driven', category: 'medium', status: 'issue', name: 'Switch attribution to data-driven', description: `Currently ${s.attribution.reportingAttributionModel}. Data-driven attribution is Google's recommended model - NOTE: changing it re-states historical conversion credit in reports, so select this deliberately.`, requires: [], defaultSelected: false, executable: true });
    } else {
      push({ id: 'attribution', category: 'info', status: 'ok', name: 'Attribution: data-driven', description: 'Already on the recommended model.', requires: [], defaultSelected: false, executable: false });
    }
  }

  // ── Google Signals (privacy decision - never pre-selected) ──
  if (s.googleSignals && s.googleSignals !== 'GOOGLE_SIGNALS_ENABLED') {
    push({ id: 'google_signals_on', category: 'info', status: 'issue', name: 'Enable Google Signals', description: 'Off - no demographics or cross-device reporting. Enabling activates Google-account-based collection: confirm your privacy disclosures cover it before selecting.', requires: [], defaultSelected: false, executable: true });
  }

  // ── Key events (needs a human choice of WHICH events - advisory only) ──
  if (s.keyEvents !== null && s.keyEvents.length === 0) {
    push({ id: 'key_events', category: 'high', status: 'issue', name: 'No key events (conversions) marked', description: 'Nothing is marked as a conversion, so Ads bidding and conversion reports are empty. Pick the real conversion events (e.g. purchase, generate_lead) - the chat can mark them (create_ga4_key_event).', requires: [], defaultSelected: false, executable: false });
  }

  return {
    items,
    detected: {
      property: s.property,
      displayName: s.displayName,
      retention: s.dataRetention?.eventDataRetention ?? null,
      webStreams: s.dataStreams.filter((d) => d.type === 'WEB_DATA_STREAM').length,
    },
  };
}
