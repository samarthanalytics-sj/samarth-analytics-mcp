#!/usr/bin/env node
/**
 * THROWAWAY SPIKE — answers ADR-0001's open question:
 *   "Does Stytch vault the Google refresh token and vend fresh Google access
 *    tokens that actually work against the GTM API, with our scopes?"
 *
 * It drives the full B2B Google OAuth *discovery* flow end to end:
 *   1. opens the Stytch discovery-start URL (with our custom_scopes +
 *      provider_access_type=offline + provider_prompt=consent),
 *   2. catches the redirect on http://localhost:3000/callback,
 *   3. exchanges the token (discovery authenticate),
 *   4. creates an organization (so we get a member_id + organization_id),
 *   5. calls get-google-access-token,
 *   6. hits the real GTM API with the returned Google access token,
 *   7. prints PASS/FAIL.
 *
 * No secrets in this file — it reads them from env. Not wired into the app;
 * delete it after the spike. Requires Node 18+ (uses global fetch).
 *
 * SETUP (once, in the Stytch dashboard, TEST environment):
 *   - Configuration → Redirect URLs → add  http://localhost:3000/callback
 *     as BOTH a "Login" and "Discovery" redirect URL.
 *   - API keys → copy the project_id, secret, and public_token.
 *
 * RUN (PowerShell):
 *   $env:STYTCH_PROJECT_ID="project-test-..."
 *   $env:STYTCH_SECRET="secret-test-..."
 *   $env:STYTCH_PUBLIC_TOKEN="public-token-test-..."
 *   node scripts/stytch-spike.mjs
 * Then sign in with a Google account that is a TEST USER on your OAuth app
 * and has access to at least one GTM account.
 */

import http from "node:http";
import { spawn } from "node:child_process";

const BASE = process.env.STYTCH_BASE || "https://test.stytch.com";
const PROJECT_ID = process.env.STYTCH_PROJECT_ID;
const SECRET = process.env.STYTCH_SECRET;
const PUBLIC_TOKEN = process.env.STYTCH_PUBLIC_TOKEN;

if (!PROJECT_ID || !SECRET || !PUBLIC_TOKEN) {
  console.error(
    "Missing env. Set STYTCH_PROJECT_ID, STYTCH_SECRET, STYTCH_PUBLIC_TOKEN.\n" +
      "Find them in the Stytch dashboard → API keys (TEST environment)."
  );
  process.exit(2);
}

const REDIRECT = "http://localhost:3000/authenticate";
const SCOPES =
  "https://www.googleapis.com/auth/tagmanager.readonly " +
  "https://www.googleapis.com/auth/analytics.readonly";

const authHeader =
  "Basic " + Buffer.from(`${PROJECT_ID}:${SECRET}`).toString("base64");

async function api(method, path, body) {
  console.log(`   ↪ ${method} ${BASE}${path}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log(`     HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

// Best-effort extraction so the spike survives minor field-name differences.
function deepFind(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj && obj[key] != null) return obj[key];
  for (const v of Object.values(obj)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function startUrl() {
  // Build manually with encodeURIComponent so the space between scopes becomes
  // %20 (Stytch's required encoding). URLSearchParams would encode it as "+",
  // which Stytch does not decode — that's why the consent screen showed no
  // GTM/Analytics scopes.
  const params = [
    `public_token=${encodeURIComponent(PUBLIC_TOKEN)}`,
    `custom_scopes=${encodeURIComponent(SCOPES)}`,
    `discovery_redirect_url=${encodeURIComponent(REDIRECT)}`,
    `provider_access_type=offline`,
    `provider_prompt=consent`,
  ];
  return `${BASE}/v1/b2b/public/oauth/google/discovery/start?${params.join("&")}`;
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true });
    else if (process.platform === "darwin") spawn("open", [url], { detached: true });
    else spawn("xdg-open", [url], { detached: true });
  } catch {
    /* user can click the printed URL */
  }
}

async function runFlow(token) {
  console.log("\n→ Step 3: discovery authenticate…");
  const disc = await api("POST", "/v1/b2b/oauth/discovery/authenticate", {
    discovery_oauth_token: token,
  });
  if (disc.status !== 200) {
    console.error("  ✗ discovery authenticate failed:", disc.status, disc.json);
    return false;
  }
  const ist = deepFind(disc.json, "intermediate_session_token");
  const email = deepFind(disc.json, "email_address");
  console.log(`  ✓ authenticated ${email ?? "(unknown email)"}`);

  console.log("→ Step 4: create organization…");
  const orgRes = await api("POST", "/v1/b2b/discovery/organizations/create", {
    intermediate_session_token: ist,
    organization_name: "GTM MCP Spike",
    organization_slug: "gtm-mcp-spike-" + Date.now(),
  });
  if (orgRes.status !== 200) {
    console.error("  ✗ org create failed:", orgRes.status, orgRes.json);
    return false;
  }
  const memberId = deepFind(orgRes.json, "member_id");
  const orgId = deepFind(orgRes.json, "organization_id");
  console.log(`  ✓ member_id=${memberId}  organization_id=${orgId}`);
  if (!memberId || !orgId) {
    console.error(
      "  ✗ could not extract member_id/organization_id from org-create response:\n" +
        JSON.stringify(orgRes.json, null, 2)
    );
    return false;
  }

  console.log("→ Step 5: get-google-access-token (the ADR question)…");
  const tok = await api(
    "GET",
    `/v1/b2b/organizations/${orgId}/members/${memberId}/oauth_providers/google?include_refresh_token=true`
  );
  if (tok.status !== 200) {
    console.error("  ✗ get-google-access-token failed:", tok.status, tok.json);
    return false;
  }
  console.log("  raw response:\n" + JSON.stringify(tok.json, null, 2));
  const googleAccessToken = deepFind(tok.json, "access_token");
  const scopes = deepFind(tok.json, "scopes");
  const refresh = deepFind(tok.json, "refresh_token");
  const hasGtm = JSON.stringify(scopes ?? "").includes("tagmanager.readonly");
  console.log(
    `  access_token present: ${Boolean(googleAccessToken)} | ` +
      `tagmanager scope present: ${hasGtm} | ` +
      `refresh_token stored: ${Boolean(refresh)}`
  );

  if (!googleAccessToken) return false;

  console.log("→ Step 6: call the real GTM API with that token…");
  const gtm = await fetch(
    "https://tagmanager.googleapis.com/tagmanager/v2/accounts",
    { headers: { Authorization: `Bearer ${googleAccessToken}` } }
  );
  const gtmBody = await gtm.text();
  console.log(`  GTM /accounts → HTTP ${gtm.status}`);
  console.log("  " + gtmBody.slice(0, 400));

  const pass = gtm.status === 200 && hasGtm;
  console.log(
    `\n${pass ? "✅ PASS" : "❌ FAIL"} — Stytch ${
      pass ? "vaults Google tokens and they work against GTM with our scopes." : "did not return a working GTM-scoped token (see output above)."
    }`
  );
  return pass;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:3000");
  if (url.pathname !== "/authenticate") {
    res.writeHead(404).end("not found");
    return;
  }
  const token = url.searchParams.get("token");
  const type = url.searchParams.get("stytch_token_type");
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>Spike callback received.</h1><p>Return to your terminal.</p>");
  console.log(`\n← callback: stytch_token_type=${type}`);
  if (!token) {
    console.error("No token in callback — check the redirect URL is registered in Stytch.");
    server.close();
    return;
  }
  try {
    await runFlow(token);
  } catch (e) {
    console.error("flow error:", e?.message ?? e);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(3000, () => {
  const url = startUrl();
  console.log("Spike server listening on http://localhost:3000/authenticate");
  console.log("\nOpening the Stytch discovery-start URL in your browser:");
  console.log("\n" + url + "\n");
  console.log("Sign in with a Google TEST USER that can see a GTM account.\n");
  openBrowser(url);
});
