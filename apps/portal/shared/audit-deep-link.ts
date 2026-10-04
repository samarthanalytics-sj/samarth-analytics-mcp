/**
 * Deep links from the Containers page into the Audit page
 * (`/audit?a=<accountId>&c=<publicId>`). Framework-free so the link format,
 * the read-back and the cascade's preselection rule can be regression-tested
 * without a browser.
 *
 * The portal routes on the hash (wouter `useHashLocation`). An in-app
 * `<Link href="/audit?a=…&c=…">` click lands as `?a=…&c=…#/audit`, so the
 * query lives in `location.search`, not in the hash. The same link opened in a
 * new tab arrives as `#/audit?a=…&c=…` instead; `hoistHashQuery` moves that
 * query into the search so both entry points look the same to the router.
 */

const ACCOUNT_PARAM = "a";
const CONTAINER_PARAM = "c";

export interface AuditDeepLink {
  accountId?: string;
  publicId?: string;
}

/** The Containers page's "Audit" link for one container. */
export function auditDeepLinkHref(container: {
  accountId: string;
  publicId: string;
}): string {
  const params = new URLSearchParams();
  params.set(ACCOUNT_PARAM, container.accountId);
  params.set(CONTAINER_PARAM, container.publicId);
  return `/audit?${params.toString()}`;
}

/** The deep-link target in a `location.search` string, or undefined. */
export function readAuditDeepLink(search: string): AuditDeepLink | undefined {
  const params = new URLSearchParams(search);
  const accountId = params.get(ACCOUNT_PARAM)?.trim() || undefined;
  const publicId = params.get(CONTAINER_PARAM)?.trim() || undefined;
  return accountId || publicId ? { accountId, publicId } : undefined;
}

/**
 * `search` without the deep-link keys (other params kept), as `?…` or "".
 * The search string survives later hash navigations, so the Audit page strips
 * the keys once read; otherwise they would re-apply on every return to /audit.
 */
export function stripAuditDeepLink(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(ACCOUNT_PARAM);
  params.delete(CONTAINER_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/**
 * Move a query embedded in the hash (`#/audit?a=1&c=GTM-X`, which is what a
 * `<Link>` opened in a new tab produces) into the search, where in-app
 * navigation puts it. No route matches a hash path containing `?`. Keys from
 * the hash replace same-named search keys. Returns null when the hash carries
 * no query.
 */
export function hoistHashQuery(
  search: string,
  hash: string,
): { search: string; hash: string } | null {
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(search);
  const hashParams = new URLSearchParams(hash.slice(q + 1));
  hashParams.forEach((_value, key) => params.delete(key));
  hashParams.forEach((value, key) => params.append(key, value));
  const rest = params.toString();
  const path = hash.slice(0, q);
  return { search: rest ? `?${rest}` : "", hash: path.length > 1 ? path : "#/" };
}

/**
 * The option the GTM cascade auto-picks for an empty tier of a non-empty
 * list: the deep-linked one when it is in the loaded list, else the page's
 * `preferred` option, else the first. A stale or foreign link id falls
 * through and never blocks the auto-pick.
 */
export function pickAutoSelected<T>(
  list: readonly T[],
  isLinked: ((item: T) => boolean) | undefined,
  preferred?: T,
): T {
  return (isLinked ? list.find(isLinked) : undefined) ?? preferred ?? list[0];
}
