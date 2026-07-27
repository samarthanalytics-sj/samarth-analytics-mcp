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

/** An existing conversion action in the account, for reuse matching. */
export interface ExistingConversionAction {
  id: string;
  name: string;
  taggable: boolean;
  conversionId: string | null;
  conversionLabel: string | null;
}

export interface AdsConversionStep {
  tagName: string;
  /** The name the conversion action will be created with (or the reused action's name). */
  conversionName: string;
  category: string;
  /** create = mint a new (LIVE) action; reuse = an existing action already matches this name. */
  mode: 'create' | 'reuse';
  /** For a reuse step: the matched action's id + the id/label the tag will use. */
  reuseId?: string;
  conversionId?: string | null;
  conversionLabel?: string | null;
  /** Set when this entry cannot be turned into a create/reuse (e.g. the stripped name is empty). */
  blocked?: string;
}

export interface AdsConversionBatchPlan {
  steps: AdsConversionStep[];
  createCount: number;
  reuseCount: number;
  /** Entries that could not be planned (blocked), excluded from the counts. */
  blockedCount: number;
  /** The categorized, human-readable approval text: how many LIVE actions to create, how many to
   *  reuse (no write), each by name. */
  text: string;
  /** True when nothing applicable remains (no creates and no reuses). */
  empty: boolean;
}

/** A taggable existing action that carries a usable id + label - the only kind worth reusing. */
const usableForReuse = (a: ExistingConversionAction, name: string): boolean =>
  a.taggable && Boolean(a.conversionId) && Boolean(a.conversionLabel) &&
  a.name.trim().toLowerCase() === name.trim().toLowerCase();

/**
 * Build the reviewable plan: one conversion action per entry, named by the affix rule (or the
 * explicit name). When `reuse` is on, an entry whose name already matches a taggable existing action
 * (with a usable id + label) REUSES it instead of minting a duplicate; otherwise it is a create.
 * Deterministic; the text is exactly what the single approval card shows, so nothing is created that
 * was not listed.
 */
export function planAdsConversionActions(
  entries: readonly AdsConversionEntryInput[],
  opts: { prefix?: string; suffix?: string; defaultCategory: string; reuse?: boolean; existingActions?: readonly ExistingConversionAction[] }
): AdsConversionBatchPlan {
  const existing = opts.existingActions ?? [];
  const steps: AdsConversionStep[] = entries.map((e) => {
    const conversionName = (e.conversionName ?? '').trim() || stripAffixes(e.tagName, { prefix: opts.prefix, suffix: opts.suffix });
    const category = (e.category ?? '').trim().toUpperCase() || opts.defaultCategory;
    if (!conversionName) {
      return { tagName: e.tagName, conversionName: '', category, mode: 'create', blocked: 'the tag name is empty once the prefix/suffix is stripped, so there is no conversion name to use' };
    }
    if (opts.reuse) {
      const match = existing.find((a) => usableForReuse(a, conversionName));
      if (match) {
        return { tagName: e.tagName, conversionName, category, mode: 'reuse', reuseId: match.id, conversionId: match.conversionId, conversionLabel: match.conversionLabel };
      }
    }
    return { tagName: e.tagName, conversionName, category, mode: 'create' };
  });

  const creates = steps.filter((s) => !s.blocked && s.mode === 'create');
  const reuses = steps.filter((s) => !s.blocked && s.mode === 'reuse');
  const blocked = steps.filter((s) => s.blocked);

  const lines: string[] = [];
  lines.push(
    creates.length
      ? `${creates.length} LIVE Google Ads conversion action${creates.length === 1 ? '' : 's'} will be created (this is immediate in the ad account and cannot be undone here):`
      : reuses.length
        ? 'No new conversion actions will be created.'
        : 'No conversion actions can be created or reused from these tag names.'
  );
  for (const s of creates) lines.push(`  - "${s.conversionName}" (${s.category})  for tag: ${s.tagName}`);
  if (reuses.length) {
    lines.push('');
    lines.push(`${reuses.length} existing conversion action${reuses.length === 1 ? '' : 's'} will be REUSED (no new write):`);
    for (const s of reuses) lines.push(`  - "${s.conversionName}" (id ${s.reuseId})  for tag: ${s.tagName}`);
  }
  if (blocked.length) {
    lines.push('');
    lines.push(`Not applied (${blocked.length}):`);
    for (const s of blocked) lines.push(`  - tag "${s.tagName}": ${s.blocked}`);
  }
  lines.push('');
  lines.push(
    creates.length || reuses.length
      ? `Then each tag's Conversion ID and Label (read back from the Ads account) are used to build its GTM tag (in the draft workspace).`
      : 'Nothing will be applied.'
  );

  return { steps, createCount: creates.length, reuseCount: reuses.length, blockedCount: blocked.length, text: lines.join('\n'), empty: creates.length === 0 && reuses.length === 0 };
}
