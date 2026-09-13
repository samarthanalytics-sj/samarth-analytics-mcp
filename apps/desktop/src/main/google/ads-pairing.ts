// Does this GTM container belong to the Google Ads account the user just picked?
//
// There is no authoritative join between the two products. GTM's accounts.containers.lookup accepts a
// destinationId of the form AW-123456789, but it is a weak primary signal: a destination is linked to
// exactly ONE container at a time, it only resolves containers the signed-in user can access, and a
// hand-built awct tag creates no destination link at all (GTM's runtime auto-load of the Google tag is a
// network request, not a container change). For the common case, someone built the tag by hand, lookup
// finds nothing.
//
// The container itself is the stronger evidence: if it already carries Google Ads tags whose conversion
// id matches the selected account, the two demonstrably belong together. This module reads that evidence
// and returns a VERDICT for the UI to show. It never decides anything on the user's behalf, because the
// failure it guards against (an operator with ten client tabs open picking the wrong client) writes a
// tag into someone else's container and is invisible until conversions go missing.
//
// PURE: snapshot in, verdict out. No I/O, no Electron.

import type { ContainerSnapshot } from './gtm-builders';

/** The GTM tag types that carry a Google Ads conversion id, and where it lives.
 *  awct  = Google Ads Conversion Tracking (bare numeric id + label)
 *  awcc  = Google Ads Call Conversion       (bare numeric id + label)
 *  sp    = Google Ads Remarketing           (id, AW- prefix kept)
 *  googtag = the Google tag, whose tagId may be an AW- id serving Ads
 *  sgtmadsct / sgtmadsremarket = the server-side equivalents */
const ADS_TAG_TYPES = new Set(['awct', 'awcc', 'sp', 'googtag', 'sgtmadsct', 'sgtmadsremarket']);

/** Parameter keys that can hold a conversion id across those types. */
const ID_KEYS = new Set(['conversionId', 'tagId', 'measurementId']);

/** Canonical 'AW-<digits>' form, or null when the value is not an Ads conversion id.
 *  A {{variable}} reference is deliberately rejected: it proves nothing about WHICH account, and a
 *  container full of {{Google Ads Conversion ID}} placeholders would otherwise "match" every account. */
export function canonicalAdsId(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw.includes('{{')) return null;
  // GT- is a Google tag id, never a conversion id; G- is a GA4 measurement id.
  const m = /^AW-(\d{6,})$/i.exec(raw) ?? /^(\d{6,})$/.exec(raw);
  return m ? `AW-${m[1]}` : null;
}

export interface ContainerAdsId {
  /** Canonical 'AW-123456789'. */
  conversionId: string;
  /** The tags that carry it, for a message the user can act on. */
  tagNames: string[];
}

/** Every distinct Google Ads conversion id already present in the container, with the tags carrying it.
 *  Paused tags are INCLUDED: a paused Ads tag is still evidence of which account the container serves. */
export function extractContainerAdsIds(snap: ContainerSnapshot): ContainerAdsId[] {
  const byId = new Map<string, Set<string>>();
  for (const t of snap.tags ?? []) {
    if (!ADS_TAG_TYPES.has(t.type)) continue;
    for (const p of t.parameter ?? []) {
      const key = String((p as { key?: unknown }).key ?? '');
      if (!ID_KEYS.has(key)) continue;
      const id = canonicalAdsId((p as { value?: unknown }).value);
      if (!id) continue;
      const names = byId.get(id) ?? new Set<string>();
      names.add(t.name);
      byId.set(id, names);
    }
  }
  return [...byId.entries()]
    .map(([conversionId, names]) => ({ conversionId, tagNames: [...names].sort() }))
    .sort((a, b) => a.conversionId.localeCompare(b.conversionId));
}

export type PairingVerdict = 'match' | 'mismatch' | 'no-ads-tags' | 'unknown';

export interface PairingCheck {
  verdict: PairingVerdict;
  /** Ready-to-show sentence. Empty for 'unknown'. */
  message: string;
  /** Every Ads id found in the container (so the UI can list them on a mismatch). */
  containerIds: ContainerAdsId[];
}

/**
 * Compare the container's existing Google Ads ids against the one the user is about to use.
 *
 * 'mismatch' is the verdict that earns its keep, and it is deliberately worded as a caution rather than
 * an error: adding a SECOND Ads account to a container is legitimate (an agency running two accounts for
 * one site, or a cross-account migration where Google's own guidance is to leave the old tag in place
 * until the conversion window passes). So it warns and lets the user proceed.
 */
export function checkPairing(snap: ContainerSnapshot, selectedConversionId: string | null | undefined, accountName?: string): PairingCheck {
  const containerIds = extractContainerAdsIds(snap);
  const selected = canonicalAdsId(selectedConversionId);
  if (!selected) return { verdict: 'unknown', message: '', containerIds };
  if (containerIds.length === 0) {
    return {
      verdict: 'no-ads-tags',
      message: 'This container has no Google Ads tags yet, so there is nothing to check this against.',
      containerIds,
    };
  }
  const hit = containerIds.find((c) => c.conversionId === selected);
  if (hit) {
    const who = accountName ? ` (${accountName})` : '';
    return {
      verdict: 'match',
      message: `This container already has Google Ads tags for ${selected}${who}, so it is the right one.`,
      containerIds,
    };
  }
  const others = containerIds.map((c) => c.conversionId).join(', ');
  const who = accountName ? `${accountName} (${selected})` : selected;
  return {
    verdict: 'mismatch',
    message:
      `This container's existing Google Ads tags use ${others}, but you selected ${who}. ` +
      'That is fine if you are deliberately adding a second account; otherwise check you have the right container.',
    containerIds,
  };
}
