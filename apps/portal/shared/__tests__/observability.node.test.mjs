/**
 * Standalone Node test for the observability redaction + log-record helpers.
 * Run: node apps/portal/shared/__tests__/observability.node.test.mjs
 *
 * Mirrors the runtime behaviour of apps/portal/shared/observability.ts without
 * importing TS (kept dependency-free like the other .node.test.mjs files in
 * this repo). If the .ts logic changes, update this mirror.
 */

import assert from "node:assert";

// ── inlined logic (mirror of observability.ts) ──────────────────────────────

const LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40 };
const levelRank = (l) => LEVEL_RANK[l];

const REDACT_KEY_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "credential",
  "client_secret",
  "clientsecret",
  "refresh",
  "access_token",
  "id_token",
  "apikey",
  "api_key",
  "private_key",
  "email",
];
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

const keyIsSensitive = (key) =>
  REDACT_KEY_FRAGMENTS.some((f) => key.toLowerCase().includes(f));

function valueLooksSensitive(value) {
  if (value.length < 12) return false;
  if (/^ya29\./.test(value)) return true;
  if (/^bearer\s+\S+/i.test(value)) return true;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value))
    return true;
  return false;
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string")
    return valueLooksSensitive(value) ? REDACTED : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = keyIsSensitive(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

function buildRecord(record, now = new Date()) {
  const { fields, ...rest } = record;
  const serialized = { ts: now.toISOString(), ...rest };
  if (fields !== undefined) serialized.fields = redact(fields);
  return serialized;
}

function formatLine(record) {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      subsystem: record.subsystem,
      event: record.event,
      message: record.message,
      errorName: "log_serialization_failed",
    });
  }
}

function minLevel(env) {
  const raw = (env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error")
    return raw;
  return "info";
}

function logEvent(record, sink, env = process.env) {
  try {
    if (levelRank(record.level) < levelRank(minLevel(env))) return;
    sink(record.level, formatLine(buildRecord(record)));
  } catch {
    /* never throw */
  }
}

function safeErrorName(err) {
  if (err instanceof Error && typeof err.name === "string" && err.name)
    return err.name;
  return "UnknownError";
}

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ok ${name}`);
}

// ── redaction: keys ────────────────────────────────────────────────────────
check("redacts values under sensitive key names (case-insensitive)", () => {
  const out = redact({
    accessToken: "abc",
    ACCESS_TOKEN: "def",
    client_secret: "shh",
    refreshToken: "r",
    sessionCookie: "c",
    Authorization: "Bearer x",
    apiKey: "k",
    email: "a@b.com",
  });
  for (const k of Object.keys(out)) {
    assert.strictEqual(out[k], REDACTED, `${k} should be redacted`);
  }
});

check("keeps non-sensitive keys intact", () => {
  const out = redact({ route: "/api/gtm/audit", count: 3, ok: true });
  assert.strictEqual(out.route, "/api/gtm/audit");
  assert.strictEqual(out.count, 3);
  assert.strictEqual(out.ok, true);
});

// ── redaction: values ────────────────────────────────────────────────────────
check("redacts token-shaped values even under innocuous keys", () => {
  const out = redact({
    note: "ya29.a0ARrdaM-longtokenvalue1234567890",
    jwt: "abcdefghij.klmnopqrst.uvwxyz12345",
    auth: "Bearer sometokenvalue123",
  });
  assert.strictEqual(out.note, REDACTED);
  assert.strictEqual(out.jwt, REDACTED);
  assert.strictEqual(out.auth, REDACTED);
});

check("does not redact ordinary short strings / urls / ids", () => {
  const out = redact({
    message: "audit completed",
    url: "https://example.com/page",
    orgId: "org-123",
    short: "ok",
  });
  assert.strictEqual(out.message, "audit completed");
  assert.strictEqual(out.url, "https://example.com/page");
  assert.strictEqual(out.orgId, "org-123");
});

// ── redaction: nesting ─────────────────────────────────────────────────────
check("redacts nested objects and arrays", () => {
  const out = redact({
    user: { email: "x@y.com", id: "u1" },
    connections: [{ refresh_token: "r" }, { ok: true }],
  });
  assert.strictEqual(out.user.email, REDACTED);
  assert.strictEqual(out.user.id, "u1");
  assert.strictEqual(out.connections[0].refresh_token, REDACTED);
  assert.strictEqual(out.connections[1].ok, true);
});

check("a sensitive container key redacts the whole subtree", () => {
  const out = redact({ tokens: [{ refresh_token: "r" }] });
  assert.strictEqual(out.tokens, REDACTED);
});

check("does not mutate the input object", () => {
  const input = { secret: "s", nested: { token: "t" } };
  redact(input);
  assert.strictEqual(input.secret, "s");
  assert.strictEqual(input.nested.token, "t");
});

check("truncates beyond max depth instead of recursing forever", () => {
  let deep = { ok: true };
  for (let i = 0; i < 10; i++) deep = { child: deep };
  const out = redact(deep);
  // Walk down; eventually hit the truncation sentinel.
  let cur = out;
  let sawTruncation = false;
  for (let i = 0; i < 10 && cur && typeof cur === "object"; i++) {
    if (cur.child === "[TRUNCATED]") sawTruncation = true;
    cur = cur.child;
  }
  assert.ok(sawTruncation, "deep nesting should be truncated");
});

// ── record building ──────────────────────────────────────────────────────────
check("buildRecord adds ISO timestamp and redacts fields", () => {
  const rec = buildRecord(
    {
      level: "info",
      subsystem: "audit",
      event: "audit.run.succeeded",
      message: "done",
      fields: { accessToken: "abc", durationMs: 42 },
    },
    new Date("2026-06-04T00:00:00.000Z"),
  );
  assert.strictEqual(rec.ts, "2026-06-04T00:00:00.000Z");
  assert.strictEqual(rec.fields.accessToken, REDACTED);
  assert.strictEqual(rec.fields.durationMs, 42);
});

check("buildRecord omits fields when none provided", () => {
  const rec = buildRecord({
    level: "info",
    subsystem: "system",
    event: "system.startup",
    message: "up",
  });
  assert.ok(!("fields" in rec));
});

// ── level threshold ──────────────────────────────────────────────────────────
check("minLevel defaults to info and parses LOG_LEVEL", () => {
  assert.strictEqual(minLevel({}), "info");
  assert.strictEqual(minLevel({ LOG_LEVEL: "debug" }), "debug");
  assert.strictEqual(minLevel({ LOG_LEVEL: "WARN" }), "warn");
  assert.strictEqual(minLevel({ LOG_LEVEL: "bogus" }), "info");
});

check("logEvent drops records below threshold", () => {
  const lines = [];
  const sink = (_lvl, line) => lines.push(line);
  logEvent(
    { level: "debug", subsystem: "cache", event: "cache.hit", message: "h" },
    sink,
    { LOG_LEVEL: "info" },
  );
  assert.strictEqual(lines.length, 0, "debug should be dropped at info");
  logEvent(
    { level: "error", subsystem: "cache", event: "cache.error", message: "e" },
    sink,
    { LOG_LEVEL: "info" },
  );
  assert.strictEqual(lines.length, 1, "error should pass at info");
});

check("logEvent never emits a secret", () => {
  const lines = [];
  const sink = (_lvl, line) => lines.push(line);
  logEvent(
    {
      level: "error",
      subsystem: "oauth",
      event: "oauth.callback.failed",
      message: "exchange failed",
      fields: {
        refresh_token: "super-secret-refresh",
        access_token: "ya29.realtoken1234567890",
      },
    },
    sink,
    { LOG_LEVEL: "info" },
  );
  assert.strictEqual(lines.length, 1);
  assert.ok(!lines[0].includes("super-secret-refresh"));
  assert.ok(!lines[0].includes("ya29.realtoken1234567890"));
  assert.ok(lines[0].includes(REDACTED));
});

check("logEvent never throws on a circular field", () => {
  const lines = [];
  const sink = (_lvl, line) => lines.push(line);
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() =>
    logEvent(
      {
        level: "error",
        subsystem: "system",
        event: "system.shutdown",
        message: "x",
        fields: { circular },
      },
      sink,
      { LOG_LEVEL: "info" },
    ),
  );
});

// ── error name safety ──────────────────────────────────────────────────────
check("safeErrorName returns only the class name, never the message", () => {
  const err = new TypeError("token=ya29.secret leaked in message");
  assert.strictEqual(safeErrorName(err), "TypeError");
  assert.strictEqual(safeErrorName("a string"), "UnknownError");
  assert.strictEqual(safeErrorName(null), "UnknownError");
});

// eslint-disable-next-line no-console
console.log(`\nobservability: ${passed} checks passed.`);
