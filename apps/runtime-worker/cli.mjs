#!/usr/bin/env node
// Local CLI for the runtime capture core — read-only.
//
// Captures one or more URLs and writes the runtime-capture artifact to disk.
// This is the local/CI alternative to running the HTTP worker; both produce the
// same schema the portal audit imports.
//
// Usage:
//   node cli.mjs --url https://example.com [--url https://example.com/checkout] \
//     --output runtime-capture.json [--wait 4000] [--timeout 30000] [--headed] \
//     [--consent ad_storage=denied,analytics_storage=granted]

import { writeFile } from "node:fs/promises";
import { capture, summarizeCapture, PlaywrightMissingError } from "./capture.mjs";

function parseArgs(argv) {
  const out = { urls: [], wait: 4000, timeout: 30000, output: "runtime-capture.json", headed: false, consent: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.urls.push(argv[++i]);
    else if (a === "--output") out.output = argv[++i];
    else if (a === "--wait") out.wait = Number(argv[++i]) || out.wait;
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || out.timeout;
    else if (a === "--headed") out.headed = true;
    else if (a === "--consent") out.consent = argv[++i];
  }
  return out;
}

function parseConsent(raw) {
  if (!raw) return null;
  const consent = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && (v === "granted" || v === "denied")) consent[k] = v;
  }
  return Object.keys(consent).length ? consent : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.urls.length === 0) {
    console.error("Error: at least one --url is required.\n");
    console.error("Usage: node cli.mjs --url https://example.com --output runtime-capture.json");
    process.exit(2);
  }

  try {
    const artifact = await capture(
      { urls: args.urls, consentState: parseConsent(args.consent) },
      { wait: args.wait, timeout: args.timeout, headed: args.headed },
    );
    await writeFile(args.output, JSON.stringify(artifact, null, 2), "utf8");
    const s = summarizeCapture(artifact);
    console.log(`Runtime capture written to ${args.output}`);
    console.log(`  pages: ${s.pages}`);
    console.log(`  tracker groups:`, s.groups);
    console.log(`  console errors: ${s.consoleErrors}, page errors: ${s.pageErrors}`);
  } catch (e) {
    if (e instanceof PlaywrightMissingError) {
      console.error(e.message);
      process.exit(1);
    }
    console.error("Runtime capture failed:", e?.message ?? e);
    process.exit(1);
  }
}

main();
