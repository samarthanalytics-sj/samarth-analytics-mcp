// Batch Google Ads conversion-action creation from a list of GTM tag names.
//
// The workflow: the user is building several Google Ads conversion tags at once and gives the tag
// names + triggers. This mints ONE conversion action per tag in the selected Ads account, named from
// the tag name with the caller-supplied prefix/suffix stripped off, so the action reads "Book A Demo"
// rather than "GA4 - Event - Book A Demo Click Tag". The action's Conversion ID + Label then flow
// into the GTM tag (built separately by create_gtm_tracking_tag).
//
// PURE + framework-free: naming and the reviewable plan only. The registry owns the live Ads writes.
//
// House style: no em dashes anywhere in this file - every string here can reach the user.

/** Remove the EXACT affixes the caller specified from a tag name, then tidy the result.
 *
 * Matching is case-insensitive and tolerant of surrounding whitespace, because a user typing
 * "strip 'GA4 - Event -'" should not have to reproduce the exact spacing. After removing the affix,
 * a leftover leading/trailing separator (a dash or colon) is cleaned up so "GA4 - Event - Book A Demo"
 * minus "GA4 - Event -" becomes "Book A Demo", not "- Book A Demo".
 */
export function stripAffixes(name: string, opts: { prefix?: string; suffix?: string } = {}): string {
  let out = String(name ?? '').trim();
  const pre = (opts.prefix ?? '').trim();
  const suf = (opts.suffix ?? '').trim();
  if (pre && out.toLowerCase().startsWith(pre.toLowerCase())) {
    out = out.slice(pre.length);
  }
  if (suf && out.toLowerCase().endsWith(suf.toLowerCase())) {
    out = out.slice(0, out.length - suf.length);
  }
  // Tidy a separator the affix left behind, and collapse internal whitespace runs.
  return out.replace(/^[\s:-]+/, '').replace(/[\s:-]+$/, '').replace(/\s+/g, ' ').trim();
}

export interface AdsConversionEntryInput {
  /** The GTM tag this conversion action is for (the affix rule turns it into the action name). */
  tagName: string;
  /** An explicit conversion-action name that wins over the derived one, when the caller has it. */
  conversionName?: string;
  /** Per-entry category override; falls back to the batch default. */
  category?: string;
}

export interface AdsConversionStep {
  tagName: string;
  /** The name the conversion action will be created with (derived or explicit). */
  conversionName: string;
  category: string;
  /** Set when this entry cannot be turned into a create (e.g. the stripped name is empty). */
  blocked?: string;
}

export interface AdsConversionBatchPlan {
  steps: AdsConversionStep[];
  /** Entries that could not be planned (blocked), excluded from the create count. */
  blockedCount: number;
  /** The categorized, human-readable approval text: how many LIVE actions, each by name. */
  text: string;
  empty: boolean;
}

/**
 * Build the reviewable plan: one conversion action per entry, named by the affix rule (or the
 * explicit name). Deterministic; the text is exactly what the single approval card shows, so nothing
 * is created that was not listed.
 */
export function planAdsConversionActions(
  entries: readonly AdsConversionEntryInput[],
  opts: { prefix?: string; suffix?: string; defaultCategory: string }
): AdsConversionBatchPlan {
  const steps: AdsConversionStep[] = entries.map((e) => {
    const conversionName = (e.conversionName ?? '').trim() || stripAffixes(e.tagName, { prefix: opts.prefix, suffix: opts.suffix });
    const category = (e.category ?? '').trim().toUpperCase() || opts.defaultCategory;
    if (!conversionName) {
      return { tagName: e.tagName, conversionName: '', category, blocked: 'the tag name is empty once the prefix/suffix is stripped, so there is no conversion name to use' };
    }
    return { tagName: e.tagName, conversionName, category };
  });

  const creatable = steps.filter((s) => !s.blocked);
  const blocked = steps.filter((s) => s.blocked);

  const lines: string[] = [];
  lines.push(
    creatable.length
      ? `${creatable.length} LIVE Google Ads conversion action${creatable.length === 1 ? '' : 's'} will be created (this is immediate in the ad account and cannot be undone here):`
      : 'No conversion actions can be created from these tag names.'
  );
  for (const s of creatable) {
    lines.push(`  - "${s.conversionName}" (${s.category})  for tag: ${s.tagName}`);
  }
  if (blocked.length) {
    lines.push('');
    lines.push(`Not creatable (${blocked.length}):`);
    for (const s of blocked) lines.push(`  - tag "${s.tagName}": ${s.blocked}`);
  }
  lines.push('');
  lines.push(creatable.length ? `Then each tag's Conversion ID and Label are read back and used to build its GTM tag (in the draft workspace).` : 'Nothing will be created.');

  return { steps, blockedCount: blocked.length, text: lines.join('\n'), empty: creatable.length === 0 };
}
