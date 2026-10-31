// Shared SSRF guard for every scraping engine (Electron / Cheerio / Playwright).
//
// The implementation MOVED to apps/web-audit-mcp/src/utils/safeFetch.ts, which is where its only
// dependency (urlGuard) already lived, and where the web-audit server's own sitemap discovery needs
// it too. This file stays as the re-export so every existing `./ssrf` import here is unchanged.
//
// One guard, not two. A second copy is the kind of thing that gets a fix on one side and keeps
// admitting what it should not on the other.

import { requestAllowed } from '../../../../web-audit-mcp/src/utils/safeFetch.js';
import { watchLanding, type LandingWatch, type PwPage as LandingPage } from '../../../../web-audit-mcp/src/agent/browser.js';

export {
  requestAllowed,
  safeFetch,
  type SafeFetchResult,
} from '../../../../web-audit-mcp/src/utils/safeFetch.js';

/** A redirect-hop watch on one page; see watchRedirectHops. */
export interface RedirectHopWatch {
  /** A new top-level navigation starts on this page: hops seen before it no longer count. */
  reset(): void;
  /** The refusal note, or null. `resp` is the goto's Playwright Response (or null after the reads). */
  blockedLanding(resp?: unknown): Promise<string | null>;
}

/**
 * Re-check the redirect hops a Playwright route guard never sees.
 *
 * Playwright calls a context.route handler for the FIRST URL of a redirect chain only and follows
 * every later hop itself, so a public URL that 302s to a private, loopback or metadata address is
 * loaded even though every routed request is guarded. (The Electron engine is not affected: its
 * session.webRequest.onBeforeRequest runs again for each hop, and the static engine's safeFetch
 * follows redirects manually.) Register this on the page BEFORE its first goto, then call
 * blockedLanding(resp) right after the goto and again before anything read from the page is kept:
 * it returns a refusal note when any hop the page saw (main frame, iframe or subresource), the
 * response's own chain, or where the page and its frames now are fails the guard; else null. A
 * refusal moves the page to about:blank and holds until reset().
 *
 * The same watchLanding the web-audit server uses, so there is still one guard. The blind GET to the
 * internal address itself still happens; what this guarantees is that nothing from it is read, shown,
 * or clicked.
 */
export function watchRedirectHops(page: object, guard: (rawUrl: string) => Promise<boolean> = requestAllowed): RedirectHopWatch {
  const watch = watchLanding(page as LandingPage, guard);
  return {
    reset: () => watch.reset(),
    blockedLanding: (resp) => watch.blockedLanding((resp ?? null) as Parameters<LandingWatch['blockedLanding']>[0]),
  };
}
