/**
 * Truncation notice for export artifacts.
 *
 * What broke: this object was built inline in export.ts and spread into the `full` branch only.
 * `summary` is the DEFAULT format and the one that also prints a stats block, so the most
 * authoritative-looking artifact was the only one that never admitted it was short: a caller got
 * `stats.tags: 50` with nothing anywhere saying 50 was a floor. `names_only` had the same gap.
 *
 * Pulling it out here is what lets a test assert "every format carries it", and it removes the
 * per-branch structural weakness that produced the bug in the first place - the envelope is now built
 * once at the single return, so a fourth format cannot reintroduce it.
 */

import type { PaginatedResult } from './pagination.js';

/** Spread into an export artifact. EMPTY when nothing was truncated, so a complete export stays
 *  byte-identical to what callers saw before. */
export interface TruncationNotice {
  incomplete?: true;
  truncatedCollections?: string[];
  /** Per collection, so a caller can resume the ones that were short. A single scalar token cannot
   *  express five independently-paginated collections, which is why the tool takes no pageToken. */
  nextPageTokens?: Record<string, string>;
  warning?: string;
}

export function buildTruncationNotice(
  collections: Record<string, PaginatedResult<unknown>>
): TruncationNotice {
  const short = Object.keys(collections).filter((name) => collections[name].truncated);
  if (short.length === 0) return {};

  const nextPageTokens: Record<string, string> = {};
  for (const name of short) {
    const token = collections[name].nextPageToken;
    if (token) nextPageTokens[name] = token;
  }

  return {
    incomplete: true,
    truncatedCollections: short,
    nextPageTokens,
    warning:
      `This export is INCOMPLETE: ${short.join(', ')} hit the page ceiling, so entities are missing. ` +
      'Any count reported for those collections is a floor, not a total. Do not use it as a backup. ' +
      'Re-run with a higher maxPages, or fetch the named collections directly with tags_list / ' +
      'triggers_list / variables_list / folders_list / built_in_variables_list, passing the matching ' +
      'token from nextPageTokens as pageToken.',
  };
}
