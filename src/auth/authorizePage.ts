/**
 * Static authorization page for Stytch Connected Apps (Phase 3, slice 2).
 *
 * Served at GET /oauth/authorize — this is the "Authorization URL" configured in
 * the Stytch dashboard. Stytch redirects the user's browser here during the
 * OAuth flow; the page mounts Stytch's B2B IdentityProvider component, which
 * handles login (Google, brokered by Stytch) + the consent screen, then returns
 * the user to Stytch to complete authorization.
 *
 * ⚠️ VERIFY IN BROWSER: the exact @stytch/vanilla-js B2B mount call below could
 * not be confirmed against the live SDK and is the one part of slice 2 that
 * cannot be unit-tested server-side. Confirm the CDN path and the IdP mount API
 * for the installed SDK version during the first live run. The public token is
 * safe to embed (it is the publishable client token, never the secret).
 */
export function renderAuthorizePage(opts: { publicToken: string }): string {
  const token = (opts.publicToken ?? '').replace(/["<>]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize — Samarth GTM MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0b1220; color: #f4f7fb;
           display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    .card { width: 100%; max-width: 440px; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    #stytch-idp { background: #fff; border-radius: 10px; min-height: 120px; }
    .hint { color: #9aa8c0; font-size: 13px; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize access to your Google Tag Manager</h1>
    <div id="stytch-idp"></div>
    <p class="hint">Sign in to grant an MCP client read access to your GTM &amp; GA4 via Samarth Analytics.</p>
  </div>
  <script type="module">
    import { StytchB2BUIClient } from "https://cdn.jsdelivr.net/npm/@stytch/vanilla-js/dist/index.b2b.js";
    const client = new StytchB2BUIClient("${token}");
    // VERIFY: confirm the IdP mount API for the installed @stytch/vanilla-js B2B
    // version (mountIdentityProvider vs. a component-config call).
    try {
      client.mountIdentityProvider({ elementId: "#stytch-idp" });
    } catch (e) {
      document.getElementById("stytch-idp").innerHTML =
        '<p style="color:#b00;padding:16px">Stytch IdP mount failed — verify the SDK API. ' +
        (e && e.message ? e.message : '') + '</p>';
    }
  </script>
</body>
</html>`;
}
