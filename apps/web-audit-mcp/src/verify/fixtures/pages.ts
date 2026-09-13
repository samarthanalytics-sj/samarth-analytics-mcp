/**
 * Deterministic, offline HTML fixtures for the capture-layer browser tests.
 *
 * Each page pushes to dataLayer and issues GET/POST /g/collect-shaped requests
 * (and other tracker beacons) to real public hostnames — which the capture's
 * fixture route fulfils in-memory (204), so nothing hits the network. The page
 * itself is served from the synthetic public host `verify-fixture.test`, which
 * passes the SSRF guard (not private/loopback) yet never resolves via DNS
 * because interception precedes the network.
 */

import type { FixtureProvider } from '../capture/capture.js';

export const FIXTURE_HOST = 'verify-fixture.test';
export const fixtureUrl = (path: string): string => `https://${FIXTURE_HOST}${path}`;

// A GA4 GET beacon helper + consent default, shared by pages.
const ga4Helper = `
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  function ga4(qs){ var i = new Image(); i.src = 'https://www.google-analytics.com/g/collect?' + qs; }
  function ga4post(qs, body){ fetch('https://www.google-analytics.com/g/collect?' + qs, { method:'POST', body: body, keepalive:true }).catch(function(){}); }
`;

function page(bodyScript: string, opts: { banner?: boolean } = {}): string {
  const banner = opts.banner
    ? '<div id="cmp"><button id="cmp-accept">Accept all</button><button id="cmp-reject">Reject</button></div>'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
<script>${ga4Helper}</script></head>
<body>
${banner}
<button id="hero">CTA</button>
<a id="out" href="https://shop.example.com/checkout">Shop</a>
<script>${bodyScript}</script>
</body></html>`;
}

const PAGES: Record<string, string> = {
  // Everything should Pass.
  '/clean': page(`
    gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
    dataLayer.push({ event: 'page_view' });
    ga4('v=2&tid=G-CLEAN&cid=1&en=page_view&ep.page_type=home&gcs=G100');
    ga4post('v=2&tid=G-CLEAN&cid=1&gcs=G100', 'en=view_item&ep.item=SKU1&epn.value=5\\nen=add_to_cart&epn.value=10&pr1=id1');
    (new Image()).src = 'https://www.clarity.ms/tag/abcd';
    document.getElementById('hero').addEventListener('click', function(){ ga4('v=2&tid=G-CLEAN&cid=1&en=cta_click&gcs=G111'); });
    // Cross-domain linker decorates the outbound href on load; click is neutralised.
    var out = document.getElementById('out'); out.href = out.href + '?_gl=1*abc123';
    out.addEventListener('click', function(e){ e.preventDefault(); });
  `),

  // Clarity never loads → tracker_present clarity Fail.
  '/missing-tracker': page(`
    ga4('v=2&tid=G-MT&cid=1&en=page_view&ep.page_type=home&gcs=G100');
  `),

  // page_view fires with the wrong ep.page_type → param_validation Partial.
  '/wrong-param': page(`
    ga4('v=2&tid=G-WP&cid=1&en=page_view&ep.page_type=blog&gcs=G100');
  `),

  // purchase fires twice → duplicate_event Fail. Distinct cache-buster (_c) so
  // the browser issues two real requests instead of serving the 2nd from cache.
  '/duplicate': page(`
    ga4('v=2&tid=G-DUP&cid=1&en=purchase&ep.transaction_id=T1&gcs=G111&_c=1');
    ga4('v=2&tid=G-DUP&cid=1&en=purchase&ep.transaction_id=T1&gcs=G111&_c=2');
  `),

  // A GA4 hit fires BEFORE the consent click with analytics granted → consent_mode Fail.
  '/pre-consent': page(`
    gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
    ga4('v=2&tid=G-PC&cid=1&en=page_view&gcs=G111');
    document.getElementById('cmp-accept').addEventListener('click', function(){
      gtag('consent','update',{ad_storage:'granted',analytics_storage:'granted',ad_user_data:'granted',ad_personalization:'granted'});
      ga4('v=2&tid=G-PC&cid=1&en=page_view&gcs=G111');
    });
  `, { banner: true }),

  // Outbound link is NOT decorated → cross_domain_linker Fail.
  '/missing-gl': page(`
    ga4('v=2&tid=G-GL&cid=1&en=page_view&gcs=G100');
    document.getElementById('out').addEventListener('click', function(e){ e.preventDefault(); });
  `),
};

/** A FixtureProvider serving the pages above; null (→ 204) for everything else. */
export function fixtureProvider(): FixtureProvider {
  return {
    resolve(url: string) {
      try {
        const u = new URL(url);
        if (u.hostname === FIXTURE_HOST && Object.prototype.hasOwnProperty.call(PAGES, u.pathname)) {
          return { status: 200, contentType: 'text/html; charset=utf-8', body: PAGES[u.pathname] };
        }
      } catch {
        // fall through
      }
      return null;
    },
  };
}
