/**
 * What an editorial URL looks like.
 *
 * Its own module, with no imports, because two very different things need it: the crawl, which uses
 * it to avoid spending a page budget on blog posts, and page discovery, which uses it to MARK posts
 * so a person can deselect them having seen what they are. Discovery opens no browser, and reaching
 * into scan.ts for this would have pulled Playwright into a path that is only HTTP GETs.
 *
 * One pattern for both. A copy would drift, and the drift shows up as a "skip blogs" button that
 * hides a different set of pages than the crawl would have excluded.
 */

/**
 * Paths that are almost always editorial rather than something to tag.
 *
 * Date segments are included because "/2026/08/" is the most reliable blog marker there is: a site
 * can call its section /insights or /resources, but a dated path is a post.
 */
export const BLOG_RE =
  /(^|\/)(blog|blogs|news|newsroom|article|articles|post|posts|story|stories|press|category|categories|tag|tags|author|authors|archive|archives)(\/|$)|\/(19|20)\d{2}\/\d{1,2}(\/|$)/i;

/**
 * Whether a URL looks editorial.
 *
 * Matched on the PATH only, so a query string cannot smuggle one of these words in and knock out a
 * page someone needs. A string that will not parse as a URL is matched whole, which is the safe
 * direction for a filter that only ever excludes.
 */
export function isBlogLike(url: string): boolean {
  try {
    return BLOG_RE.test(new URL(url).pathname);
  } catch {
    return BLOG_RE.test(url);
  }
}
