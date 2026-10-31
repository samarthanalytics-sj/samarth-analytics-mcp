#!/usr/bin/env node
// Full-surface smoke test — invokes EVERY registered MCP tool once over stdio.
//
// Complements scripts/smoke-test.mjs (which only checks tools/list): this
// script calls each tool with minimal schema-valid arguments and asserts the
// server returns a structured JSON-RPC response for every single one — no
// crash, no hang, no unhandled rejection.
//
// Safe by construction (see buildSmokeChildEnv):
//   - Every guardrail flag (GTM_MCP_ENABLE_* AND GA4_MCP_ENABLE_*) is pinned to
//     "false" and every Google/OAuth credential variable to "", rather than
//     only deleted: the server runs `import 'dotenv/config'`, and dotenv fills
//     in any DELETED key from a .env but never overrides one that is set.
//   - The child runs in an empty temp directory with DOTENV_CONFIG_PATH aimed
//     at a file that does not exist, so a developer .env (and the default
//     ./.gtm-mcp-tokens.json) is never read; GTM_MCP_TOKEN_FILE and
//     GOOGLE_APPLICATION_CREDENTIALS point at nonexistent files, so neither the
//     token file nor Application Default Credentials can authenticate.
//   - If the server still reports loading credentials (or never logs that it is
//     ready, so that cannot be ruled out), the run aborts before calling a
//     single tool.
// Every tool therefore fails at the auth or guardrail layer BEFORE any network
// call to Google, even though gated tools receive confirm:true.
//
// Expected outcome per tool: an in-band tool error (isError: true) with an
// auth/guardrail message, or a JSON-RPC error for schema rejection. A timeout,
// transport crash, or malformed response is a FAILURE.
//
// Usage:
//   node scripts/smoke-all-tools.mjs [--mcp dist/index.js] [--timeout 15000]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every guardrail flag the server reads (src/utils/guardrails.ts). */
export const GUARDRAIL_FLAGS = [
  "GTM_MCP_ENABLE_WRITES",
  "GTM_MCP_ENABLE_PUBLISH",
  "GTM_MCP_ENABLE_DELETES",
  "GA4_MCP_ENABLE_WRITES",
  "GA4_MCP_ENABLE_DELETES",
];

/** Every credential variable the server reads (src/auth/googleAuth.ts, tokenSource.ts). */
export const CREDENTIAL_VARS = [
  "GOOGLE_ACCESS_TOKEN",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_KEY_FILE",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SAMARTH_GOOGLE_OAUTH_CLIENT_ID",
  "SAMARTH_GOOGLE_OAUTH_CLIENT_SECRET",
];

/**
 * The child server's environment: no credentials, every write/publish/delete
 * flag off, and nothing that dotenv or ADC could re-populate from disk.
 * `sandbox` is an empty directory the child runs in.
 */
export function buildSmokeChildEnv(baseEnv, sandbox) {
  const env = { ...baseEnv, GTM_MCP_TRANSPORT: "stdio" };
  for (const key of Object.keys(env)) {
    if (/^(GOOGLE_|SAMARTH_|GTM_MCP_ENABLE_|GA4_MCP_ENABLE_|DOTENV_)/i.test(key)) delete env[key];
  }
  for (const key of GUARDRAIL_FLAGS) env[key] = "false";
  for (const key of CREDENTIAL_VARS) env[key] = "";
  env.DRY_RUN = "true";
  env.DOTENV_CONFIG_PATH = path.join(sandbox, "no.env");
  env.GTM_MCP_TOKEN_FILE = path.join(sandbox, "no-tokens.json");
  // google-auth-library tries this path before the gcloud well-known file and
  // fails outright when it does not exist, so ADC can never authenticate.
  env.GOOGLE_APPLICATION_CREDENTIALS = path.join(sandbox, "no-adc.json");
  return env;
}

function parseArgs(argv) {
  const out = { mcp: "dist/index.js", timeout: 15000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mcp") out.mcp = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 15000;
  }
  return out;
}

// Build a minimal argument object satisfying a tool's JSON Schema.
function synthesizeArgs(schema) {
  if (!schema || schema.type !== "object" || !schema.properties) return {};
  const args = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!required.has(key)) continue;
    args[key] = synthesizeValue(key, prop);
  }
  return args;
}

function synthesizeValue(key, prop) {
  if (!prop || typeof prop !== "object") return "1";
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  if (prop.const !== undefined) return prop.const;
  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case "boolean":
      return true; // confirm gates: true still blocked by guardrail env flags
    case "number":
    case "integer":
      return prop.minimum ?? 1;
    case "array": {
      const min = prop.minItems ?? 0;
      if (min <= 0) return [];
      const item = synthesizeValue(key, prop.items ?? { type: "string" });
      return Array.from({ length: min }, () => item);
    }
    case "object": {
      const nested = {};
      for (const req of prop.required ?? []) {
        nested[req] = synthesizeValue(req, prop.properties?.[req]);
      }
      return nested;
    }
    default: {
      // Strings: honor obvious format hints; ids of "1" are schema-valid and
      // fail safely at auth, never reaching Google.
      if (/url/i.test(key)) return "https://example.com";
      if (/email/i.test(key)) return "smoke@example.com";
      if (/date/i.test(key)) return "2024-01-01";
      return "1";
    }
  }
}

function classify(detail) {
  if (/disabled|confirm|guardrail/i.test(detail)) return "guardrail";
  if (/auth|credential|token|oauth|consent|login|sign in|unauthenticated/i.test(detail))
    return "auth";
  if (/invalid|required|expected|must be/i.test(detail)) return "validation";
  return "other";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mcpPath = path.resolve(args.mcp);

  // Sanitized child env in an empty sandbox cwd (see buildSmokeChildEnv).
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-all-"));
  process.on("exit", () => fs.rmSync(sandbox, { recursive: true, force: true }));
  const env = buildSmokeChildEnv(process.env, sandbox);

  const child = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: sandbox,
    env,
  });

  let stderrTail = "";
  // The server logs which credentials it loaded. Any of these means the
  // sandbox leaked and tool calls could reach Google, so the run must stop.
  let credentialsLoaded = null;
  // The stdio server logs this once connected, AFTER buildGoogleAuth has logged
  // which credentials it loaded (src/index.ts). stderr is a separate pipe from
  // stdout, so the credential line can be read after the initialize answer; but
  // stderr itself is ordered, so once this line is read, any credential line
  // logged before it has been read too.
  const READY_LINE = "[samarth-gtm-mcp] Server ready on stdio transport";
  let serverReady = false;
  let onReady = null;
  child.stderr.on("data", (c) => {
    stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
    const m = /\[auth\] Using (OAuth2 user credentials|service account credentials)/.exec(stderrTail);
    if (m && !credentialsLoaded) credentialsLoaded = m[1];
    if (!serverReady && stderrTail.includes(READY_LINE)) {
      serverReady = true;
      onReady?.();
    }
  });
  function waitForReady(timeoutMs) {
    if (serverReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        onReady = null;
        resolve(false);
      }, timeoutMs);
      onReady = () => {
        clearTimeout(timer);
        onReady = null;
        resolve(true);
      };
    });
  }

  let crashed = null;
  child.on("exit", (code, signal) => {
    if (!shuttingDown) crashed = { code, signal };
  });
  let shuttingDown = false;

  // Newline-delimited JSON-RPC plumbing with per-request promises.
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter.resolve(msg);
      }
    }
  });

  let nextId = 1;
  function rpc(method, params, timeoutMs) {
    const id = nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("timeout"));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // Handshake.
  await rpc(
    "initialize",
    {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-all-tools", version: "1.0.0" },
    },
    args.timeout,
  );
  notify("notifications/initialized");

  let toolsCalled = 0;
  function abortIfCredentialsLoaded() {
    if (credentialsLoaded) {
      shuttingDown = true;
      child.kill("SIGTERM");
      console.error(
        `smoke-all-tools: ABORTED - the server loaded ${credentialsLoaded} despite the sanitized ` +
          "environment, so tool calls could reach Google. " +
          (toolsCalled === 0 ? "No tool was called." : `Stopped after ${toolsCalled} tool call(s).`),
      );
      process.exit(1);
    }
  }

  // buildGoogleAuth runs (and logs) before the server answers initialize, but on
  // stderr, which may be read after that answer. Wait for the ready line logged
  // after it, then check; fail closed if it never comes.
  const ready = await waitForReady(args.timeout);
  abortIfCredentialsLoaded();
  if (!ready) {
    shuttingDown = true;
    child.kill("SIGTERM");
    console.error(
      `smoke-all-tools: ABORTED - the server never logged "${READY_LINE}" within ${args.timeout} ms, ` +
        "so whether it loaded credentials is unknown. No tool was called.",
    );
    process.exit(1);
  }

  // Collect the full tool list (paginate if the server ever does).
  const tools = [];
  let cursor;
  do {
    const res = await rpc("tools/list", cursor ? { cursor } : {}, args.timeout);
    tools.push(...(res.result?.tools ?? []));
    cursor = res.result?.nextCursor;
  } while (cursor);

  console.log(`Smoke-testing ${tools.length} tools (sanitized env, no credentials):\n`);

  const failures = [];
  const counts = { ok: 0, auth: 0, guardrail: 0, validation: 0, other: 0 };

  for (const tool of tools) {
    if (crashed) break;
    // Re-checked before every call: a credential line read at any point stops the run.
    abortIfCredentialsLoaded();
    toolsCalled++;
    const callArgs = synthesizeArgs(tool.inputSchema);
    let outcome;
    let detail = "";
    try {
      const res = await rpc(
        "tools/call",
        { name: tool.name, arguments: callArgs },
        args.timeout,
      );
      if (res.error) {
        // JSON-RPC-level error (e.g. schema rejection) — still a structured,
        // non-crashing response. Acceptable for a smoke test.
        outcome = "validation";
        detail = String(res.error.message ?? "").slice(0, 120);
      } else if (res.result) {
        const text = res.result.content?.[0]?.text ?? "";
        if (res.result.isError) {
          outcome = classify(text);
          detail = text.replace(/\s+/g, " ").slice(0, 120);
        } else {
          outcome = "ok";
          detail = text.replace(/\s+/g, " ").slice(0, 80);
        }
      } else {
        outcome = "FAIL";
        detail = "malformed response (no result, no error)";
      }
    } catch (e) {
      outcome = "FAIL";
      detail = e.message === "timeout" ? "TIMEOUT — handler hung" : e.message;
    }

    if (outcome === "FAIL" || crashed) {
      failures.push({ name: tool.name, detail });
      console.log(`  FAIL ${tool.name} — ${detail}`);
    } else {
      counts[outcome]++;
      console.log(`  ok   ${tool.name} [${outcome}] ${detail}`);
    }
  }

  if (crashed) {
    console.error(
      `\nFATAL: server process exited mid-run (code=${crashed.code} signal=${crashed.signal})`,
    );
    if (stderrTail) console.error(`stderr tail:\n${stderrTail}`);
  }

  shuttingDown = true;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }

  const total = tools.length;
  const passed = total - failures.length;
  console.log(
    `\nsmoke-all-tools: ${passed}/${total} tools responded cleanly` +
      ` (ok=${counts.ok} auth=${counts.auth} guardrail=${counts.guardrail}` +
      ` validation=${counts.validation} other=${counts.other})`,
  );
  if (failures.length > 0) {
    console.log(`failures: ${failures.map((f) => f.name).join(", ")}`);
  }
  process.exit(failures.length === 0 && !crashed ? 0 : 1);
}

// Run only when executed directly, so tests can import buildSmokeChildEnv.
// realpath on both sides: the ESM loader resolves symlinks, argv[1] does not.
function isMainModule() {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main().catch((e) => {
    console.error(`smoke-all-tools: fatal — ${e?.message ?? e}`);
    process.exit(1);
  });
}
