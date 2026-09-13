// Planning the conversion actions to create for a batch of ticked Google Ads rows.
//
// Creating a conversion action is an IMMEDIATELY LIVE write to the advertiser's Google Ads account,
// with no draft stage - unlike the GTM half of this app, which only ever touches a draft workspace.
// Doing several at once therefore has to be decided BEFORE anything is sent: what will be created,
// under what names, in which account. That is what this builds, so the confirmation the operator sees
// is the exact plan that runs, and so the naming/dedupe rules are testable without touching an
// account.
//
// PURE. The renderer executes the plan; nothing here calls Google.
import { conversionActionNameFromTag } from './tag-template';

/** The row fields this planner needs. A subset of SuggestedTagView so tests need no fixtures. */
export interface AdsPlanRow {
  id: string;
  platform: string;
  tagName: string;
  eventName?: string;
  page?: string;
  measurementId?: string;
  conversionLabel?: string;
}

export interface AdsPlanItem {
  /** The suggestion row this action is for. */
  rowId: string;
  /** The tag it came from, shown in the confirmation. */
  tagName: string;
  /** The conversion action name to create. */
  actionName: string;
  /** A Google Ads conversion category value (see CONVERSION_CATEGORIES). */
  category: string;
}

export interface AdsPlanSkip {
  rowId: string;
  tagName: string;
  reason: string;
}

export interface AdsBulkPlan {
  create: AdsPlanItem[];
  /** Rows that were ticked but need nothing, or cannot be handled. Surfaced, never silently dropped. */
  skipped: AdsPlanSkip[];
}

/** Values that mean "no real id yet" - the seeded variables that nothing provisions. */
const PLACEHOLDERS = new Set(['{{google ads conversion id}}', '{{google ads conversion label}}']);
const isPlaceholder = (v: string | undefined): boolean => {
  const s = String(v ?? '').trim();
  return s === '' || PLACEHOLDERS.has(s.toLowerCase());
};

/**
 * Pick the conversion category from what the tag actually tracks.
 *
 * Only confident mappings; everything else takes the same default the single-row picker uses, and the
 * operator sees the category in the confirmation before anything is created.
 */
export function categoryForRow(row: Pick<AdsPlanRow, 'tagName' | 'eventName'>): string {
  const hay = `${row.eventName ?? ''} ${row.tagName ?? ''}`.toLowerCase();
  if (/\bphone|call|tel\b/.test(hay)) return 'PHONE_CALL_LEAD';
  if (/\bbook|appointment|demo|consultation|schedule\b/.test(hay)) return 'BOOK_APPOINTMENT';
  if (/\bquote|estimate|pricing\b/.test(hay)) return 'REQUEST_QUOTE';
  if (/\bsign.?up|register|subscribe|newsletter\b/.test(hay)) return 'SIGNUP';
  if (/\bpurchase|order.?complete|checkout.?complete\b/.test(hay)) return 'PURCHASE';
  if (/\bemail|contact|chat|whatsapp\b/.test(hay)) return 'CONTACT';
  return 'SUBMIT_LEAD_FORM';
}

/**
 * What to create for the ticked rows.
 *
 * Only google_ads_conversion rows that still hold a placeholder are planned: a row that already has a
 * real id and label is left alone (creating a second action would split its reporting), and a
 * remarketing row is skipped because it needs no label and creating an action would not fix it.
 *
 * Names come from the tag name (the same derivation the single-row picker seeds), and duplicates are
 * disambiguated rather than silently creating two identically named actions.
 */
export function planAdsConversionActions(rows: readonly AdsPlanRow[]): AdsBulkPlan {
  const create: AdsPlanItem[] = [];
  const skipped: AdsPlanSkip[] = [];
  const used = new Map<string, number>();

  for (const row of rows ?? []) {
    const tagName = String(row?.tagName ?? '').trim();
    if (row?.platform === 'google_ads_remarketing') {
      skipped.push({ rowId: row.id, tagName, reason: 'Remarketing tags have no conversion label, so there is nothing to create.' });
      continue;
    }
    if (row?.platform !== 'google_ads_conversion') {
      skipped.push({ rowId: row.id, tagName, reason: 'Not a Google Ads conversion tag.' });
      continue;
    }
    if (!isPlaceholder(row.measurementId) && !isPlaceholder(row.conversionLabel)) {
      skipped.push({ rowId: row.id, tagName, reason: 'Already has a real Conversion ID and Label.' });
      continue;
    }
    const base = conversionActionNameFromTag(tagName);
    if (!base) {
      skipped.push({ rowId: row.id, tagName, reason: 'Could not derive an action name from the tag name. Use the per-row picker to name it.' });
      continue;
    }
    // Two rows can legitimately reduce to the same name (the same CTA on two pages). Number them so
    // the operator can tell them apart in Google Ads instead of finding two identical entries.
    const key = base.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    create.push({
      rowId: row.id,
      tagName,
      actionName: n === 1 ? base : `${base} (${n})`,
      category: categoryForRow(row),
    });
  }
  return { create, skipped };
}
