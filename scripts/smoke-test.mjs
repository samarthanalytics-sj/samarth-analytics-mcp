#!/usr/bin/env node
// Production smoke test — read-only health probe for critical surfaces.
//
// Verifies the two things a deploy must get right before traffic flows:
//   1. Portal HTTP endpoints respond with the expected shape (health,
//      capabilities, oauth/status). These are unauthenticated, read-only
//      descriptors — the probe asserts status + JSON contract, never a secret.
//   2. The MCP server answers a `tools/list` JSON-RPC request over stdio and
//      returns a non-empty tool list (confirms the built server boots and
//      registers tools without needing Google credentials).
//
// Read-only and side-effect-free: it only GETs descriptors and lists tools. It
// never starts an audit, never calls Google, never mutates anything.
//
// Usage:
//   node scripts/smoke-test.mjs --base-url https://portal.example.com
//   node scripts/smoke-test.mjs --base-url http://localhost:3001 --mcp dist/index.js
//   npm run smoke -- --base-url http://localhost:3001
//
// Flags:
//   --base-url <url>   Portal origin to probe. If omitted, HTTP checks are skipped.
//   --mcp <path>       Path to the built MCP entry (e.g. dist/index.js). If
//                      omitted, the MCP tools/list check is skipped.
//   --timeout <ms>     Per-check timeout. Default: 10000.
//
// Exit code is non-zero if any executed check fails; skipped checks do not fail
// the run (so it is usable in environments where only one surface is reachable).

import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = { timeout: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--mcp") out.mcp = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]) || 10000;
  }
  return out;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, raw: text };
  } finally {
    clearTimeout(t);
  }
}

async function checkHttp(baseUrl, timeout) {
  const base = baseUrl.replace(/\/+$/, "");

  // /api/health — liveness; must be 200 and ok:true.
  try {
    const { status, json } = await getJson(`${base}/api/health`, timeout);
    record(
      "GET /api/health",
      status === 200 && json?.ok === true,
      `status=${status} ok=${json?.ok}`,
    );
  } catch (e) {
    record("GET /api/health", false, errName(e));
  }

  // /api/system/capabilities — must be 200, ok:true, and expose readiness.
  try {
    const { status, json } = await getJson(
      `${base}/api/system/capabilities`,
      timeout,
    );
    const shapeOk =
      status === 200 &&
      json?.ok === true &&
      json?.capabilities &&
      json?.readiness &&
      typeof json?.sessionMode === "string";
    record(
      "GET /api/system/capabilities",
      Boolean(shapeOk),
      `status=${status} sessionMode=${json?.sessionMode}`,
    );
    // Secret-leak guard: the descriptor must never echo a secret-looking value.
    if (json) {
      const blob = JSON.stringify(json);
      const leak = /ya29\.|client_secret|"refresh_token"/i.test(blob);
      record(
        "capabilities response contains no secret-shaped value",
        !leak,
        leak ? "possible secret in response" : undefined,
      );
    }
  } catch (e) {
    record("GET /api/system/capabilities", false, errName(e));
  }

  // /api/oauth/status — must respond with JSON (authenticated:false when no session).
  try {
    const { status, json } = await getJson(`${base}/api/oauth/status`, timeout);
    record(
      "GET /api/oauth/status",
      status === 200 && json !== undefined,
      `status=${status}`,
    );
  } catch (e) {
    record("GET /api/oauth/status", false, errName(e));
  }
}

function checkMcpToolsList(mcpPath, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      record("MCP tools/list", ok, detail);
      resolve();
    };

    let child;
    try {
      child = spawn(process.execPath, [mcpPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GTM_MCP_TRANSPORT: "stdio" },
      });
    } catch (e) {
      finish(false, errName(e));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish(false, "timeout waiting for tools/list response");
    }, timeout);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // JSON-RPC over stdio is newline-delimited; scan complete lines.
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
        if (msg.id === 2 && msg.result) {
          const tools = msg.result.tools;
          const ok = Array.isArray(tools) && tools.length > 0;
          clearTimeout(timer);
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          finish(ok, ok ? `${tools.length} tools` : "empty tool list");
          return;
        }
      }
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      finish(false, errName(e));
    });

    // Initialize handshake, then request tools/list.
    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        /* ignore */
      }
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

function errName(e) {
  return e instanceof Error ? `${e.name}: ${e.message}` : "unknown_error";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.baseUrl && !args.mcp) {
    // eslint-disable-next-line no-console
    console.error(
      "smoke-test: nothing to check. Pass --base-url <url> and/or --mcp <path>.",
    );
    process.exit(2);
  }

  // eslint-disable-next-line no-console
  console.log("Smoke test:");

  if (args.baseUrl) {
    if (typeof fetch !== "function") {
      record("HTTP checks", false, "global fetch unavailable (need Node >=18)");
    } else {
      await checkHttp(args.baseUrl, args.timeout);
    }
  }

  if (args.mcp) {
    await checkMcpToolsList(args.mcp, args.timeout);
  }

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(
    `\nsmoke-test: ${results.length - failed.length}/${results.length} checks passed.`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
