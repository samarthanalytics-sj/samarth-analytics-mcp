// Runtime capture core (RUNTIME source) — read-only.
//
// Loads one or more pages in headless Chromium and records the signals the
// audit needs to confirm intent-vs-reality:
//   - visited URLs (requested + final after redirects)
//   - analytics network hits, grouped by vendor (GA4 /g/collect, Meta /tr,
//     Google Ads / Floodlight, sGTM endpoint candidates, etc.)
//   - dataLayer snapshots (before app scripts run + after settle) and the
//     event names observed
//   - console errors / warnings and uncaught page errors
//   - timestamps
//
// IMPORTANT
// - Read-only: it navigates and observes. It never submits forms, clicks
//   through funnels, or mutates anything. The optional `actions` list only
//   supports a tiny, safe allow-list (wait, scroll) — never typing/submitting.
// - Playwright is an OPTIONAL dependency. If it is not installed, capture()
//   throws a PlaywrightMissingError so callers can surface install steps and
//   NEVER silently produce an empty/fake capture.
//
// This module is shared by the HTTP worker (server.mjs) and the CLI wrapper.

export const CAPTURE_SCHEMA = "samarth.runtime-capture/v2";

// Network patterns the audit cares about. The `group` is what the portal
// reconciliation reads; the `id` stays stable for finer matching.
export const TRACKER_PATTERNS = [
  { id: "ga4_collect", group: "ga4", label: "GA4 /g/collect", re: /\/g\/collect(?:\?|$)/i },
  { id: "ua_collect", group: "ga4", label: "Universal Analytics /collect", re: /google-analytics\.com\/(?:r\/)?collect/i },
  { id: "gtm_loader", group: "gtm", label: "GTM container load", re: /googletagmanager\.com\/gtm\.js|\/gtag\/js/i },
  { id: "meta_pixel", group: "meta", label: "Meta Pixel /tr", re: /facebook\.com\/tr\b|connect\.facebook\.net\/.*\/fbevents\.js/i },
  { id: "google_ads", group: "google_ads", label: "Google Ads conversion", re: /googleadservices\.com\/pagead\/conversion|googleads\.g\.doubleclick\.net\/pagead/i },
  { id: "floodlight", group: "floodlight", label: "Floodlight", re: /fls\.doubleclick\.net|ad\.doubleclick\.net\/activity/i },
  { id: "tiktok", group: "tiktok", label: "TikTok Pixel", re: /analytics\.tiktok\.com\/api|analytics\.tiktok\.com\/i18n\/pixel/i },
  { id: "linkedin", group: "linkedin", label: "LinkedIn Insight", re: /px\.ads\.linkedin\.com|snap\.licdn\.com/i },
];

export class PlaywrightMissingError extends Error {
  constructor() {
    super(
      [
        "Playwright is not installed — runtime capture cannot run.",
        "",
        "Install it and a browser, then retry:",
        "    npm i playwright   # (or: npm i -D playwright)",
        "    npx playwright install chromium",
        "",
        "Note: do NOT run this on Vercel — it requires a real browser and exceeds serverless limits.",
        "Deploy the worker to Render / Fly / Railway / a VPS instead.",
      ].join("\n"),
    );
    this.name = "PlaywrightMissingError";
  }
}

export async function loadPlaywright() {
  try {
    const mod = await import("playwright");
    return mod.chromium ? mod : null;
  } catch {
    return null;
  }
}

function classify(url) {
  const ids = [];
  const groups = new Set();
  for (const p of TRACKER_PATTERNS) {
    if (p.re.test(url)) {
      ids.push(p.id);
      groups.add(p.group);
    }
  }
  return { ids, groups: [...groups] };
}

// A server-side GTM endpoint cannot be identified by a fixed hostname (it is the
// client's own domain), so we treat any first-party-looking request whose path
// contains the sGTM collect/markers as a candidate. The portal reconciliation
// uses these candidates only as hints (medium confidence), never as proof.
function isSgtmCandidate(url) {
  return /\/g\/collect|\/gtm\/|\/gtag\/|\/mp\/collect|\/server\//i.test(url) &&
    !/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/i.test(url);
}

function extractDataLayerEventNames(dataLayer) {
  if (!Array.isArray(dataLayer)) return [];
  const names = [];
  for (const entry of dataLayer) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const ev = entry.event;
      if (typeof ev === "string" && ev) names.push(ev);
    }
    // GA4 gtag pushes are arguments arrays: ["event", "<name>", {...}]
    if (Array.isArray(entry) && entry[0] === "event" && typeof entry[1] === "string") {
      names.push(entry[1]);
    }
  }
  return names;
}

function extractDataLayerKeys(dataLayer) {
  if (!Array.isArray(dataLayer)) return [];
  const keys = new Set();
  for (const entry of dataLayer) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const k of Object.keys(entry)) keys.add(k);
    }
  }
  return [...keys];
}

/**
 * Capture one page. Returns a per-page record (PageCapture).
 * @param {import('playwright').BrowserContext} context
 */
async function capturePage(context, url, opts) {
  const page = await context.newPage();
  const record = {
    requestedUrl: url,
    finalUrl: null,
    httpStatus: null,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    trackerHits: [],
    sgtmCandidates: [],
    networkRequestCount: 0,
    dataLayerBefore: null,
    dataLayerAfter: null,
    dataLayerEvents: [],
    dataLayerKeys: [],
    notes: [],
  };

  page.on("console", (msg) => {
    const type = msg.type();
    if (type === "error") record.consoleErrors.push(msg.text().slice(0, 1000));
    else if (type === "warning") record.consoleWarnings.push(msg.text().slice(0, 1000));
  });
  page.on("pageerror", (err) => {
    record.pageErrors.push(String(err?.message ?? err).slice(0, 1000));
  });
  page.on("request", (req) => {
    record.networkRequestCount++;
    const reqUrl = req.url();
    const { ids, groups } = classify(reqUrl);
    if (ids.length > 0) {
      record.trackerHits.push({
        url: reqUrl.slice(0, 2000),
        method: req.method(),
        matched: ids,
        groups,
        resourceType: req.resourceType(),
      });
    } else if (isSgtmCandidate(reqUrl)) {
      record.sgtmCandidates.push({
        url: reqUrl.slice(0, 2000),
        method: req.method(),
        resourceType: req.resourceType(),
      });
    }
  });

  // Snapshot dataLayer as early as possible (before app scripts run).
  await page.addInitScript(() => {
    try {
      window.__samarth_dl_before = Array.isArray(window.dataLayer)
        ? JSON.parse(JSON.stringify(window.dataLayer))
        : null;
    } catch {
      window.__samarth_dl_before = null;
    }
  });

  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: opts.timeout });
    record.finalUrl = page.url();
    if (resp) {
      record.httpStatus = resp.status();
      record.notes.push(`HTTP ${resp.status()} on initial navigation`);
    }

    await runSafeActions(page, opts.actions);
    await page.waitForTimeout(opts.wait);

    record.dataLayerBefore = await page
      .evaluate(() => window.__samarth_dl_before ?? null)
      .catch(() => null);
    record.dataLayerAfter = await page
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

    record.dataLayerEvents = extractDataLayerEventNames(record.dataLayerAfter);
    record.dataLayerKeys = extractDataLayerKeys(record.dataLayerAfter);

    if (record.dataLayerAfter == null) {
      record.notes.push("No window.dataLayer found — GTM may not be present or uses a custom name.");
    }
  } catch (e) {
    record.notes.push(`Navigation/observation error: ${String(e?.message ?? e).slice(0, 300)}`);
  } finally {
    await page.close().catch(() => {});
  }

  return record;
}

// Tiny, safe action allow-list. Read-only by design: no clicking links, typing,
// or form submission — only passive waits and scrolling to trigger lazy tags.
async function runSafeActions(page, actions) {
  if (!Array.isArray(actions)) return;
  for (const action of actions.slice(0, 20)) {
    const type = action && typeof action === "object" ? action.type : action;
    try {
      if (type === "scroll") {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else if (type === "wait") {
        const ms = Math.min(Number(action?.ms) || 1000, 10000);
        await page.waitForTimeout(ms);
      }
      // Any other action type is intentionally ignored (read-only guarantee).
    } catch {
      // ignore action failures; capture is best-effort
    }
  }
}

/**
 * Run a full capture across one or more URLs.
 *
 * @param {object} input
 * @param {string[]} input.urls               Pages to load (required, >=1).
 * @param {Record<string,string>} [input.consentState]  Consent defaults injected
 *        as a dataLayer gtag('consent','default', …) before navigation. Keys like
 *        ad_storage / analytics_storage with "granted" | "denied".
 * @param {Array} [input.actions]             Safe action list (wait/scroll only).
 * @param {object} [opts]
 * @param {number} [opts.wait=4000]           Settle time after load (ms).
 * @param {number} [opts.timeout=30000]       Navigation timeout (ms).
 * @param {boolean} [opts.headed=false]       Visible browser window.
 * @returns {Promise<object>} capture artifact (schema CAPTURE_SCHEMA).
 */
export async function capture(input, opts = {}) {
  const urls = (input?.urls ?? []).filter((u) => typeof u === "string" && u.trim());
  if (urls.length === 0) {
    throw new Error("capture() requires at least one URL in `urls`.");
  }
  const wait = Number(opts.wait) || 4000;
  const timeout = Number(opts.timeout) || 30000;
  const headed = Boolean(opts.headed);
  const consentState =
    input?.consentState && typeof input.consentState === "object"
      ? input.consentState
      : null;
  const actions = Array.isArray(input?.actions) ? input.actions : undefined;

  const pw = await loadPlaywright();
  if (!pw) throw new PlaywrightMissingError();

  const browser = await pw.chromium.launch({ headless: !headed });
  const artifact = {
    schema: CAPTURE_SCHEMA,
    capturedAt: new Date().toISOString(),
    requestedUrls: urls,
    consentState: consentState ?? undefined,
    pages: [],
    notes: [],
  };

  try {
    const context = await browser.newContext();

    // Inject Consent Mode defaults before any page script runs, when provided.
    if (consentState) {
      const safeConsent = {};
      for (const [k, v] of Object.entries(consentState)) {
        if (typeof k === "string" && (v === "granted" || v === "denied")) {
          safeConsent[k] = v;
        }
      }
      if (Object.keys(safeConsent).length > 0) {
        await context.addInitScript((consent) => {
          window.dataLayer = window.dataLayer || [];
          function gtag() {
            window.dataLayer.push(arguments);
          }
          gtag("consent", "default", consent);
        }, safeConsent);
        artifact.notes.push(
          `Injected Consent Mode default: ${JSON.stringify(safeConsent)}`,
        );
      }
    }

    for (const url of urls.slice(0, 25)) {
      const rec = await capturePage(context, url, { wait, timeout, actions });
      artifact.pages.push(rec);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return artifact;
}

/** Compact, human-readable tracker summary across all pages. */
export function summarizeCapture(artifact) {
  const groups = {};
  let consoleErrors = 0;
  let pageErrors = 0;
  for (const page of artifact.pages ?? []) {
    for (const h of page.trackerHits ?? []) {
      for (const g of h.groups ?? []) groups[g] = (groups[g] ?? 0) + 1;
    }
    consoleErrors += (page.consoleErrors ?? []).length;
    pageErrors += (page.pageErrors ?? []).length;
  }
  return { pages: (artifact.pages ?? []).length, groups, consoleErrors, pageErrors };
}
