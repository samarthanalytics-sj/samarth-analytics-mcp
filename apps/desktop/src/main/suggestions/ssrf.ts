// Shared SSRF guard for every scraping engine (Electron / Cheerio / Playwright).
//
// The implementation MOVED to apps/web-audit-mcp/src/utils/safeFetch.ts, which is where its only
// dependency (urlGuard) already lived, and where the web-audit server's own sitemap discovery needs
// it too. This file stays as the re-export so every existing `./ssrf` import here is unchanged.
//
// One guard, not two. A second copy is the kind of thing that gets a fix on one side and keeps
// admitting what it should not on the other.

export {
  requestAllowed,
  safeFetch,
  type SafeFetchResult,
} from '../../../../web-audit-mcp/src/utils/safeFetch.js';
