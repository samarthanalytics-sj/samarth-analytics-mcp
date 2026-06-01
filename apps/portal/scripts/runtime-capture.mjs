#!/usr/bin/env node
// Runtime capture harness (RUNTIME source) — read-only.
//
// Loads a page in a headless browser and records the signals the audit needs
// to confirm intent-vs-reality: page URL, console errors, analytics network
// hits (GA4 /g/collect, Meta /tr, Google Ads / Floodlight), and dataLayer
// snapshots before/after load. The output JSON is the artifact the portal's
// RUNTIME coverage consumes — until one is uploaded/connected, RUNTIME stays
// "Not Covered" in the hosted (Vercel) audit.
//
// IMPORTANT
// - Read-only: it navigates and observes. It never submits forms, clicks
//   through funnels, or mutates anything.
// - Do NOT run this in Vercel. Serverless functions have no browser and a hard
//   execution budget; this is a local/CI-worker harness only.
// - Playwright is an OPTIONAL dependency. It is not in package.json to keep the
//   serverless bundle small. Install it locally to actually capture:
//       npm i -D playwright && npx playwright install chromium
//   Without it, this script prints install instructions and exits non-zero,
//   so it never silently produces an empty/fake capture.
//
// Usage:
//   node scripts/runtime-capture.mjs --url https://example.com --output runtime-capture.json
//   npm run runtime:capture -- --url https://example.com --output runtime-capture.json
//
// Flags:
//   --url <url>        (required) Page to load.
//   --output <path>    (optional) Where to write the JSON. Default: runtime-capture.json
//   --wait <ms>        (optional) Extra settle time after load. Default: 4000
//   --timeout <ms>     (optional) Navigation timeout. Default: 30000
//   --headed           (optional) Run with a visible browser window.

import { writeFile } from "node:fs/promises";

// Network patterns the audit cares about. Kept here (not in the bundle) so the
// list can evolve with vendor endpoints without touching serverless code.
const TRACKER_PATTERNS = [
  { id: "ga4_collect", label: "GA4 /g/collect", re: /\/g\/collect(?:\?|$)/i },
  { id: "ua_collect", label: "Universal Analytics /collect", re: /google-analytics\.com\/(?:r\/)?collect/i },
  { id: "gtm_loader", label: "GTM container load", re: /googletagmanager\.com\/gtm\.js|\/gtag\/js/i },
  { id: "meta_pixel", label: "Meta Pixel /tr", re: /facebook\.com\/tr\b|connect\.facebook\.net\/.*\/fbevents\.js/i },
  { id: "google_ads", label: "Google Ads conversion", re: /googleadservices\.com\/pagead\/conversion|googleads\.g\.doubleclick\.net\/pagead/i },
  { id: "floodlight", label: "Floodlight", re: /fls\.doubleclick\.net|ad\.doubleclick\.net\/activity/i },
  { id: "tiktok", label: "TikTok Pixel", re: /analytics\.tiktok\.com\/api|analytics\.tiktok\.com\/i18n\/pixel/i },
  { id: "linkedin", label: "LinkedIn Insight", re: /px\.ads\.linkedin\.com|snap\.licdn\.com/i },
];

function parseArgs(argv) {
  const out = { wait: 4000, timeout: 30000, output: "runtime-capture.json", headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--output") out.output = argv[++i];
    else if (a === "--wait") out.wait = Number(argv[++i]) || out.wait;
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === "--headed") out.headed = true;
  }
  return out;
}

function classify(url) {
  const hits = [];
  for (const p of TRACKER_PATTERNS) if (p.re.test(url)) hits.push(p.id);
  return hits;
}

async function loadPlaywright() {
  try {
    const mod = await import("playwright");
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error("Error: --url is required.\n");
    console.error("Usage: node scripts/runtime-capture.mjs --url https://example.com --output runtime-capture.json");
    process.exit(2);
  }

  const pw = await loadPlaywright();
  if (!pw) {
    console.error(
      [
        "Playwright is not installed — runtime capture cannot run.",
        "",
        "This harness keeps Playwright optional so the Vercel serverless bundle stays small.",
        "To capture locally, install it and a browser, then re-run:",
        "",
        "    npm i -D playwright",
        "    npx playwright install chromium",
        "    npm run runtime:capture -- --url " + args.url,
        "",
        "Note: do NOT run this in Vercel — it requires a real browser and exceeds serverless limits.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const browser = await pw.chromium.launch({ headless: !args.headed });
  const capture = {
    schema: "samarth.runtime-capture/v1",
    capturedAt: new Date().toISOString(),
    requestedUrl: args.url,
    finalUrl: null,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    trackerHits: [],
    networkRequestCount: 0,
    dataLayerBefore: null,
    dataLayerAfter: null,
    notes: [],
  };

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error") capture.consoleErrors.push(msg.text().slice(0, 1000));
      else if (type === "warning") capture.consoleWarnings.push(msg.text().slice(0, 1000));
    });
    page.on("pageerror", (err) => {
      capture.pageErrors.push(String(err?.message ?? err).slice(0, 1000));
    });
    page.on("request", (req) => {
      capture.networkRequestCount++;
      const url = req.url();
      const hits = classify(url);
      if (hits.length > 0) {
        capture.trackerHits.push({
          url: url.slice(0, 2000),
          method: req.method(),
          matched: hits,
          resourceType: req.resourceType(),
        });
      }
    });

    // Snapshot dataLayer as early as possible (before app scripts run).
    await page.addInitScript(() => {
      // eslint-disable-next-line no-undef
      window.__samarth_dl_before = Array.isArray(window.dataLayer)
        ? JSON.parse(JSON.stringify(window.dataLayer))
        : null;
    });

    const resp = await page.goto(args.url, {
      waitUntil: "load",
      timeout: args.timeout,
    });
    capture.finalUrl = page.url();
    if (resp) capture.notes.push(`HTTP ${resp.status()} on initial navigation`);

    // Let async tags fire.
    await page.waitForTimeout(args.wait);

    capture.dataLayerBefore = await page
      .evaluate(() => window.__samarth_dl_before ?? null)
      .catch(() => null);
    capture.dataLayerAfter = await page
      .evaluate(() => {
        try {
          return Array.isArray(window.dataLayer)
            ? JSON.parse(JSON.stringify(window.dataLayer))
            : null;
        } catch {
          return null;
        }
      })
      .catch(() => null);

    if (capture.dataLayerAfter == null) {
      capture.notes.push("No window.dataLayer found — GTM may not be present or uses a custom name.");
    }
  } finally {
    await browser.close();
  }

  await writeFile(args.output, JSON.stringify(capture, null, 2), "utf8");

  const trackerSummary = {};
  for (const h of capture.trackerHits) {
    for (const m of h.matched) trackerSummary[m] = (trackerSummary[m] ?? 0) + 1;
  }
  console.log(`Runtime capture written to ${args.output}`);
  console.log(`  final URL: ${capture.finalUrl}`);
  console.log(`  network requests: ${capture.networkRequestCount}`);
  console.log(`  tracker hits: ${capture.trackerHits.length}`, trackerSummary);
  console.log(`  console errors: ${capture.consoleErrors.length}, page errors: ${capture.pageErrors.length}`);
}

main().catch((e) => {
  console.error("Runtime capture failed:", e?.message ?? e);
  process.exit(1);
});
