/**
 * HTTP-level backstop for every GTM and GA4 API request.
 *
 * WHY. googleapis builds each URL from a method template such as `{+path}:quick_preview` and expands
 * `{+path}` as a RESERVED string: '/', ':', '?', '&', '=' and '#' in an argument go into the URL raw.
 * A containerId of '2/versions/5:publish#' therefore turned the read-only workspace_quick_preview
 * into `POST .../containers/2/versions/5:publish` (the '#' turns the real `/workspaces/3:quick_preview`
 * suffix into a fragment, which is never sent): a live publish with every write/publish flag off.
 * The tool schemas now refuse such ids (utils/schemas.ts). This adapter is the second line: it sits
 * in front of the network for every client built by gtmClient.ts / ga4Client.ts, so a field the
 * schemas miss still cannot reach a different endpoint.
 *
 * WHAT IT CHECKS, against the request exactly as gaxios is about to send it:
 *   - no '#' anywhere (no template produces a fragment);
 *   - the only query is the one gaxios appended from the request's own params (no template has a
 *     query, so anything else was smuggled in through a path argument);
 *   - the path is plain segments of [A-Za-z0-9_-] with no empty segment, so no '%XX', no '.' / '..'
 *     traversal;
 *   - at most one ':verb', only in the LAST segment;
 *   - no ':verb' at all on PUT / PATCH / DELETE: every such template in tagmanager v2,
 *     analyticsadmin v1beta/v1alpha and analyticsdata v1beta is a bare `{+name}`.
 * Every POST template with a path argument has its own suffix (`:verb` or `/collection`) after the
 * argument, so a smuggled ':verb', '?' or '#' always shows up as one of the above. (A GET can still
 * be pointed at a different read; a GET cannot change anything.)
 *
 * A refused request rejects with an error named 'AbortError' because it is one: it is aborted
 * before it is sent, and that is the one error gaxios's retry logic never retries (a refusal is
 * permanent, retrying it would only add backoff delays).
 */

import type { GlobalOptions, GaxiosPromise } from 'googleapis/build/src/apis/tagmanager/index.js';

type Adapter = NonNullable<GlobalOptions['adapter']>;
type RequestOptions = Parameters<Adapter>[0];

/** The slice of the gaxios request options the check reads. */
export interface GuardedRequest {
  url?: string | URL;
  method?: string;
  params?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paramsSerializer?: (params: any) => string;
}

const PATH_CHARS = /^[A-Za-z0-9_\-/:]+$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const VERB = /^[A-Za-z_]+$/;
const NO_VERB_METHODS = new Set(['PUT', 'PATCH', 'DELETE']);

/**
 * Why this request must not be sent, or null when it is exactly what a googleapis method template
 * produces from well-formed arguments. Pure, for tests.
 */
export function googleRequestProblem(opts: GuardedRequest): string | null {
  const raw = opts.url === undefined ? '' : String(opts.url);
  if (!raw) return 'it has no URL';
  if (raw.includes('#')) return 'its URL contains "#"';

  // Strip exactly the query gaxios appended from the request's own params. What is left is the
  // expanded method template, which never carries a query of its own.
  let base = raw;
  const params = opts.params;
  if (params && typeof params === 'object' && Object.keys(params as object).length > 0) {
    const serialize = opts.paramsSerializer ?? ((p: Record<string, string>) => new URLSearchParams(p).toString());
    let query = serialize(params as Record<string, string>);
    if (query.startsWith('?')) query = query.slice(1);
    const appended = `?${query}`;
    if (!raw.endsWith(appended)) return 'its URL carries a query that is not its own parameters';
    base = raw.slice(0, raw.length - appended.length);
  }
  if (base.includes('?')) return 'its URL path contains "?"';

  let path: string;
  try {
    const u = new URL(base);
    path = base.slice(u.origin.length);
  } catch {
    return 'its URL cannot be parsed';
  }
  if (!path.startsWith('/') || !PATH_CHARS.test(path)) {
    return 'its URL path contains characters no id has (only letters, digits, "_", "-", "/" and one ":verb" are allowed)';
  }
  const segments = path.slice(1).split('/');
  const last = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const colon = seg.indexOf(':');
    if (colon === -1) {
      if (!SEGMENT.test(seg)) return 'its URL path has an empty segment';
      continue;
    }
    if (i !== last) return 'its URL path has a ":" before the last segment';
    const head = seg.slice(0, colon);
    const verb = seg.slice(colon + 1);
    if (!SEGMENT.test(head) || !VERB.test(verb)) return 'its URL path has more than one ":verb" or an empty segment';
  }
  const method = (opts.method ?? 'GET').toUpperCase();
  if (NO_VERB_METHODS.has(method) && path.includes(':')) {
    return `a ${method} request carries a ":verb", which no ${method} method of these APIs has`;
  }
  return null;
}

/** The error a refused request rejects with. See the header for why it is named AbortError. */
export class GoogleRequestRefused extends Error {
  readonly refused = true;
  constructor(problem: string) {
    super(
      `Refused to send this Google API request: ${problem}. ` +
        'An id argument most likely contained "/", ":", "?" or "#"; pass the plain numeric id.'
    );
    this.name = 'AbortError';
  }
}

/** gaxios adapter: refuse a malformed request, otherwise hand it to the default adapter unchanged. */
export function guardGoogleRequest<T>(
  opts: RequestOptions,
  defaultAdapter: (options: RequestOptions) => GaxiosPromise<T>
): GaxiosPromise<T> {
  const problem = googleRequestProblem(opts as GuardedRequest);
  if (problem) return Promise.reject(new GoogleRequestRefused(problem));
  return defaultAdapter(opts);
}

/** Spread into a googleapis factory call next to the retry options. */
export function buildRequestGuardOptions(): { adapter: Adapter } {
  return { adapter: guardGoogleRequest };
}
