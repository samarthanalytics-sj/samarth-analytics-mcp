/**
 * Pagination helpers for GTM API v2 list endpoints.
 *
 * GTM list endpoints return a `nextPageToken` when more results exist. These
 * helpers transparently follow every page so callers receive the complete set
 * by default, while still allowing callers to bound the work via `maxPages`.
 */

import { z } from 'zod';

/** Default safety ceiling on the number of pages fetched in a single call. */
export const DEFAULT_MAX_PAGES = 50;

/**
 * Reusable Zod fields for paginated list tools. Merge into a tool input
 * schema with `.extend(paginationFields)`. Both fields are optional, so
 * existing callers keep working unchanged — by default every page is fetched.
 */
export const paginationFields = {
  pageToken: z
    .string()
    .optional()
    .describe('Continuation token to resume listing from a previous truncated result.'),
  maxPages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Maximum number of API pages to fetch (default ${DEFAULT_MAX_PAGES}). ` +
        'If more pages remain, the result includes truncated:true and a nextPageToken.'
    ),
};

export interface PaginationOptions {
  /** Optional starting page token. */
  pageToken?: string;
  /**
   * Maximum number of pages to fetch. Defaults to a safe upper bound to avoid
   * unbounded loops against very large accounts. Set higher if needed.
   */
  maxPages?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  /** Number of pages actually fetched. */
  pagesFetched: number;
  /**
   * Set when there were more pages than `maxPages` allowed. Callers can pass
   * this back as `pageToken` to continue, or raise `maxPages`.
   */
  nextPageToken?: string;
  /** True when at least one additional page remained unfetched. */
  truncated: boolean;
}

/**
 * Follow GTM pagination across pages and accumulate the extracted items.
 *
 * @param fetchPage  Calls the GTM list endpoint for a given page token and
 *                   returns the raw response data (the `.data` of the gaxios
 *                   response).
 * @param extract    Pulls the array of items out of a page's response data.
 * @param options    Optional starting token and page ceiling.
 */
export async function paginate<TData, TItem>(
  fetchPage: (pageToken?: string) => Promise<TData>,
  extract: (data: TData) => TItem[] | undefined,
  options: PaginationOptions = {}
): Promise<PaginatedResult<TItem>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const items: TItem[] = [];
  let pageToken: string | undefined = options.pageToken;
  let pagesFetched = 0;

  do {
    const data = await fetchPage(pageToken);
    const pageItems = extract(data) ?? [];
    items.push(...pageItems);
    pagesFetched++;

    pageToken = getNextPageToken(data);

    if (pageToken && pagesFetched >= maxPages) {
      return { items, pagesFetched, nextPageToken: pageToken, truncated: true };
    }
  } while (pageToken);

  return { items, pagesFetched, truncated: false };
}

/**
 * Shape a paginated result into the standard list-tool response body. Keeps
 * the existing `{ <key>: [...], count }` shape and only adds pagination
 * metadata (`nextPageToken`, `truncated`) when the result was actually
 * truncated, so non-truncated responses are unchanged from before.
 */
export function buildListResult<T>(
  key: string,
  result: PaginatedResult<T>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    [key]: result.items,
    count: result.items.length,
  };
  if (result.truncated) {
    body['truncated'] = true;
    body['nextPageToken'] = result.nextPageToken;
  }
  return body;
}

/** Safely read a `nextPageToken` string off an arbitrary response body. */
function getNextPageToken(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'nextPageToken' in data) {
    const token = (data as { nextPageToken?: unknown }).nextPageToken;
    if (typeof token === 'string' && token.length > 0) return token;
  }
  return undefined;
}
