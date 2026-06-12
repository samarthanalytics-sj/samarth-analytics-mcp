#!/usr/bin/env node
// Full-surface smoke test — invokes EVERY registered MCP tool once over stdio.
//
// Complements scripts/smoke-test.mjs (which only checks tools/list): this
// script calls each tool with minimal schema-valid arguments and asserts the
// server returns a structured JSON-RPC response for every single one — no
// crash, no hang, no unhandled rejection.
//
// Safe by construction:
//   - The child runs with a sanitized env: all Google/OAuth credentials and
//     GTM_MCP_ENABLE_* flags are stripped, and GTM_MCP_TOKEN_FILE points at a
//     nonexistent path. Every tool therefore fails at the auth or guardrail
//     layer BEFORE any network call to Google.
//   - Write/publish/delete tools are additionally blocked by the read-only
//     guardrail defaults, so even with credentials present nothing mutates.
//
// Expected outcome per tool: an in-band tool error (isError: true) with an
// auth/guardrail message, or a JSON-RPC error for schema rejection. A timeout,
// transport crash, or malformed response is a FAILURE.
//
// Usage:
//   node scripts/smoke-all-tools.mjs [--mcp dist/index.js] [--timeout 15000]

import { spawn } from "node:child_process";
import path from "node:path";

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

  // Sanitized child env: no credentials, no write flags, dead token path.
  const env = { ...process.env, GTM_MCP_TRANSPORT: "stdio" };
  for (const key of Object.keys(env)) {
    if (/^(GOOGLE_|SAMARTH_|GTM_MCP_ENABLE_)/i.test(key)) delete env[key];
  }
  env.GTM_MCP_TOKEN_FILE = path.join(
    process.cwd(),
    "nonexistent-smoke-tokens",
    "no-tokens.json",
  );

  const child = spawn(process.execPath, [mcpPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  let stderrTail = "";
  child.stderr.on("data", (c) => {
    stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
  });

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

main().catch((e) => {
  console.error(`smoke-all-tools: fatal — ${e?.message ?? e}`);
  process.exit(1);
});
