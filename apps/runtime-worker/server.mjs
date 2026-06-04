#!/usr/bin/env node
// Samarth runtime capture worker — read-only HTTP server.
//
// Exposes POST /capture which loads pages in headless Chromium and returns the
// structured runtime-capture artifact the portal audit consumes. This service
// is intentionally separate from the Vercel-hosted portal because a real
// browser cannot run inside a serverless function. Deploy it to Render / Fly /
// Railway / a VPS (see README).
//
// SECURITY (all opt-in via env):
//   RUNTIME_WORKER_TOKEN     If set, every request must send
//                            `Authorization: Bearer <token>`. Strongly
//                            recommended for any internet-exposed deployment.
//   RUNTIME_WORKER_ALLOWLIST Comma-separated host suffixes the worker is
//                            allowed to load (e.g. "example.com,shop.example").
//                            When unset, ANY http(s) URL is allowed — only do
//                            this for a private/internal deployment.
//   RUNTIME_WORKER_MAX_URLS  Max URLs per request (default 10, hard cap 25).
//   RUNTIME_WORKER_MAX_WAIT  Max per-page settle time in ms (default 8000).
//   RUNTIME_WORKER_TIMEOUT   Max navigation timeout in ms (default 30000).
//   PORT                     Listen port (default 8080).
//
// The worker never writes to GTM/GA4 and never persists captures — it returns
// the JSON to the caller and forgets it.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { capture, captureConsentStates, summarizeCapture, loadPlaywright, PlaywrightMissingError } from "./capture.mjs";
import { urlAllowed as guardUrlAllowed } from "./url-guard.mjs";

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = (process.env.RUNTIME_WORKER_TOKEN ?? "").trim();
const ALLOWLIST = (process.env.RUNTIME_WORKER_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const MAX_URLS = Math.min(Number(process.env.RUNTIME_WORKER_MAX_URLS) || 10, 25);
const MAX_WAIT = Number(process.env.RUNTIME_WORKER_MAX_WAIT) || 8000;
const NAV_TIMEOUT = Number(process.env.RUNTIME_WORKER_TIMEOUT) || 30000;
const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

function tokenOk(req) {
  if (!TOKEN) return true; // auth disabled
  const header = req.headers["authorization"] ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

// SSRF admission check. Delegates to the hardened, unit-tested guard in
// url-guard.mjs (covers loopback/RFC-1918/link-local + the cloud metadata IP,
// IPv6 private ranges, IPv4-mapped IPv6, and decimal/octal/hex IP encodings).
// The same guard is re-applied to every in-browser navigation in capture.mjs so
// a redirect from an allowlisted page to an internal host is still blocked.
function urlAllowed(rawUrl) {
  return guardUrlAllowed(rawUrl, ALLOWLIST);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/health" || url === "/healthz")) {
    const pw = await loadPlaywright();
    return sendJson(res, 200, {
      ok: true,
      service: "samarth-runtime-worker",
      playwrightAvailable: Boolean(pw),
      authRequired: Boolean(TOKEN),
      allowlist: ALLOWLIST.length ? ALLOWLIST : "open (no allowlist set)",
    });
  }

  if (url === "/capture") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return sendJson(res, 405, { error: "method_not_allowed" });
    }
    if (!tokenOk(req)) {
      return sendJson(res, 401, {
        error: "unauthorized",
        message: "Missing or invalid bearer token.",
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: "bad_request", message: String(e.message ?? e) });
    }

    const urls = Array.isArray(body.urls)
      ? body.urls.filter((u) => typeof u === "string" && u.trim())
      : [];
    if (urls.length === 0) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "`urls` must be a non-empty array of http(s) URLs.",
      });
    }
    if (urls.length > MAX_URLS) {
      return sendJson(res, 400, {
        error: "too_many_urls",
        message: `At most ${MAX_URLS} URLs per request.`,
      });
    }
    for (const u of urls) {
      const check = urlAllowed(u);
      if (!check.ok) {
        return sendJson(res, 400, {
          error: "url_not_allowed",
          message: `${u}: ${check.reason}`,
        });
      }
    }

    const wait = Math.min(Number(body.wait) || 4000, MAX_WAIT);
    const timeout = Math.min(Number(body.timeout) || NAV_TIMEOUT, NAV_TIMEOUT);

    try {
      // Multi-state proof capture when `consentStates` is supplied; otherwise a
      // single-state (or no-consent) capture for backwards compatibility.
      const wantsMultiState =
        Array.isArray(body.consentStates) && body.consentStates.length > 0;
      const artifact = wantsMultiState
        ? await captureConsentStates(
            { urls, consentStates: body.consentStates, actions: body.actions },
            { wait, timeout },
          )
        : await capture(
            { urls, consentState: body.consentState, actions: body.actions },
            { wait, timeout },
          );
      return sendJson(res, 200, {
        ...artifact,
        summary: summarizeCapture(artifact),
      });
    } catch (e) {
      if (e instanceof PlaywrightMissingError) {
        return sendJson(res, 503, {
          error: "playwright_missing",
          message: e.message,
        });
      }
      console.error("[runtime-worker] capture failed:", e?.message ?? e);
      return sendJson(res, 500, {
        error: "capture_failed",
        message: String(e?.message ?? e).slice(0, 500),
      });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[runtime-worker] listening on :${PORT}`);
  console.log(`[runtime-worker] auth ${TOKEN ? "REQUIRED" : "DISABLED (set RUNTIME_WORKER_TOKEN)"}`);
  console.log(
    `[runtime-worker] allowlist: ${ALLOWLIST.length ? ALLOWLIST.join(", ") : "OPEN (set RUNTIME_WORKER_ALLOWLIST)"}`,
  );
});
