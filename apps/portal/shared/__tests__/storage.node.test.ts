/**
 * Storage-foundation suite: token vault (../token-vault.ts), DB config + store
 * factory (../db/*), and the session-cookie parsing + browser-bound OAuth state
 * the Express server uses (../../server/gtm). Pure-logic + in-memory only — no
 * live DB, no real secret manager, no network.
 *
 * Encodes the security contract:
 *   - the in-memory vault is INERT unless explicitly enabled (no accidental
 *     real-token storage in prod),
 *   - metadata never carries token bytes,
 *   - token refs are opaque/unguessable,
 *   - the store factory returns null with no DATABASE_URL (stateless fallback)
 *     and a skeleton that fails loud (never silent empty data) when configured.
 *
 * Run: npx tsx apps/portal/shared/__tests__/storage.node.test.ts
 */

import assert from "node:assert";
import {
  InMemoryTokenVault,
  TokenVaultDisabledError,
  metadataOf,
  newTokenRef,
  detectVaultProvider,
  type StoredToken,
} from "../token-vault";
import { loadDbConfig, isDatabaseConfigured } from "../db/config";
import {
  createProductionStore,
  PostgresStore,
  StoreNotWiredError,
} from "../db/index";
import crypto from "node:crypto";
import { parseCookies } from "../../server/gtm/vercel-helpers";
import {
  consumeOAuthState,
  getSession,
  newOAuthState,
  setSession,
  SESSION_MAX_AGE_MS,
  type SessionTokens,
} from "../../server/gtm/oauth";
import {
  decodeSessionCookie,
  encodeSessionCookie,
} from "../../server/gtm/session-cookie";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) {
      // Tests here are sync-or-awaited individually; guard against stray async.
      throw new Error("use runAsync for async tests");
    }
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const asyncTests: Array<[string, () => Promise<void>]> = [];
function testAsync(name: string, fn: () => Promise<void>): void {
  asyncTests.push([name, fn]);
}

const TOKEN: StoredToken = {
  accessToken: "ya29.SECRET-ACCESS",
  refreshToken: "1//SECRET-REFRESH",
  accessExpiresAt: 1_900_000_000_000,
  scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
};

// ── A. metadata never carries bytes ──────────────────────────────────────────

test("A01 metadataOf omits token bytes", () => {
  const md = metadataOf("tok_abc", TOKEN);
  const json = JSON.stringify(md);
  assert.ok(!json.includes("SECRET-ACCESS"), "access token leaked into metadata");
  assert.ok(!json.includes("SECRET-REFRESH"), "refresh token leaked into metadata");
});
test("A02 metadataOf surfaces hasRefresh + scopes + expiry only", () => {
  const md = metadataOf("tok_abc", TOKEN);
  assert.strictEqual(md.tokenRef, "tok_abc");
  assert.strictEqual(md.hasRefresh, true);
  assert.strictEqual(md.accessExpiresAt, TOKEN.accessExpiresAt);
  assert.deepEqual(md.scopes, TOKEN.scopes);
});
test("A03 hasRefresh is false when no refresh token", () => {
  const md = metadataOf("tok_x", { accessToken: "a" });
  assert.strictEqual(md.hasRefresh, false);
  assert.deepEqual(md.scopes, []);
  assert.strictEqual(md.accessExpiresAt, null);
});

// ── B. token refs are opaque + unguessable ───────────────────────────────────

test("B01 newTokenRef is prefixed and long", () => {
  const ref = newTokenRef();
  assert.ok(ref.startsWith("tok_"));
  assert.ok(ref.length >= 4 + 48, "expected >= 24 random bytes hex-encoded");
});
test("B02 newTokenRef is unique across many calls", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(newTokenRef());
  assert.strictEqual(seen.size, 1000);
});
test("B03 newTokenRef honours a custom prefix", () => {
  assert.ok(newTokenRef("sess").startsWith("sess_"));
});

// ── C. in-memory vault is inert unless enabled ───────────────────────────────

testAsync("C01 disabled vault refuses to store bytes", async () => {
  const vault = new InMemoryTokenVault(); // not enabled
  await assert.rejects(() => vault.store(TOKEN), TokenVaultDisabledError);
  assert.strictEqual(vault.size, 0);
});
testAsync("C02 disabled vault resolves nothing", async () => {
  const vault = new InMemoryTokenVault();
  assert.strictEqual(await vault.get("anything"), null);
});
testAsync("C03 enabled vault stores and resolves bytes", async () => {
  const vault = new InMemoryTokenVault({ allowInMemoryTokens: true });
  const md = await vault.store(TOKEN);
  assert.ok(md.tokenRef.startsWith("tok_"));
  const got = await vault.get(md.tokenRef);
  assert.strictEqual(got?.accessToken, TOKEN.accessToken);
  assert.strictEqual(got?.refreshToken, TOKEN.refreshToken);
});
testAsync("C04 stored bytes are copied (caller mutation can't change them)", async () => {
  const vault = new InMemoryTokenVault({ allowInMemoryTokens: true });
  const mutable: StoredToken = { accessToken: "orig", scopes: ["a"] };
  const md = await vault.store(mutable);
  mutable.accessToken = "tampered";
  mutable.scopes!.push("b");
  const got = await vault.get(md.tokenRef);
  assert.strictEqual(got?.accessToken, "orig");
  assert.deepEqual(got?.scopes, ["a"]);
});
testAsync("C05 delete is idempotent", async () => {
  const vault = new InMemoryTokenVault({ allowInMemoryTokens: true });
  const md = await vault.store(TOKEN);
  await vault.delete(md.tokenRef);
  await vault.delete(md.tokenRef); // again — no throw
  assert.strictEqual(await vault.get(md.tokenRef), null);
});

// ── D. vault provider detection (presence only) ──────────────────────────────

test("D01 no vault env → none (signed-cookie default)", () => {
  assert.strictEqual(detectVaultProvider({}), "none");
});
test("D02 supabase vars → supabase_vault", () => {
  assert.strictEqual(
    detectVaultProvider({ SUPABASE_SERVICE_ROLE_KEY: "x" }),
    "supabase_vault",
  );
});
test("D03 explicit memory opt-in → memory", () => {
  assert.strictEqual(
    detectVaultProvider({ TOKEN_VAULT_ALLOW_MEMORY: "true" }),
    "memory",
  );
});
test("D04 detection reads presence, not value (no secret needed)", () => {
  assert.strictEqual(detectVaultProvider({ VAULT_ADDR: "x" }), "hashicorp_vault");
});

// ── E. DB config (presence only) ─────────────────────────────────────────────

test("E01 no DATABASE_URL → driver none", () => {
  const cfg = loadDbConfig({});
  assert.strictEqual(cfg.driver, "none");
  assert.strictEqual(cfg.connectionString, undefined);
  assert.strictEqual(isDatabaseConfigured({}), false);
});
test("E02 DATABASE_URL → driver postgres", () => {
  const cfg = loadDbConfig({ DATABASE_URL: "postgres://localhost/db" });
  assert.strictEqual(cfg.driver, "postgres");
  assert.strictEqual(cfg.connectionString, "postgres://localhost/db");
  assert.ok(isDatabaseConfigured({ DATABASE_URL: "postgres://x/y" }));
});
test("E03 PORTAL_DATABASE_URL is an accepted alias", () => {
  assert.strictEqual(
    loadDbConfig({ PORTAL_DATABASE_URL: "postgres://x/y" }).driver,
    "postgres",
  );
});
test("E04 ssl defaults true and can be disabled", () => {
  assert.strictEqual(loadDbConfig({ DATABASE_URL: "p://x" }).ssl, true);
  assert.strictEqual(
    loadDbConfig({ DATABASE_URL: "p://x", DATABASE_SSL: "false" }).ssl,
    false,
  );
});
test("E05 pool max + statement timeout parse with sane defaults", () => {
  const cfg = loadDbConfig({ DATABASE_URL: "p://x" });
  assert.ok(cfg.poolMax > 0);
  assert.ok(cfg.statementTimeoutMs > 0);
  const tuned = loadDbConfig({ DATABASE_URL: "p://x", DATABASE_POOL_MAX: "12" });
  assert.strictEqual(tuned.poolMax, 12);
});

// ── F. store factory + skeleton ──────────────────────────────────────────────

test("F01 factory returns null with no DB (stateless fallback)", () => {
  assert.strictEqual(createProductionStore(loadDbConfig({})), null);
});
test("F02 factory returns a PostgresStore when configured", () => {
  const store = createProductionStore(
    loadDbConfig({ DATABASE_URL: "postgres://localhost/db" }),
  );
  assert.ok(store instanceof PostgresStore);
});
test("F03 PostgresStore.describe() exposes no secret", () => {
  const store = new PostgresStore(
    loadDbConfig({ DATABASE_URL: "postgres://user:pw@host/db" }),
  );
  const desc = store.describe();
  assert.ok(!JSON.stringify(desc).includes("pw"), "connection secret leaked");
  assert.strictEqual(desc.driver, "postgres");
});

testAsync("F04 skeleton methods fail LOUD (never silent empty data)", async () => {
  const store = createProductionStore(
    loadDbConfig({ DATABASE_URL: "postgres://localhost/db" }),
  )!;
  await assert.rejects(() => store.getOrgBySlug("acme"), StoreNotWiredError);
  await assert.rejects(() => store.listAuditRuns("org-1"), StoreNotWiredError);
  await assert.rejects(
    () => store.listGtmContainers("org-1", "acct-1"),
    StoreNotWiredError,
  );
});

// ── G. session cookie parsing (server/gtm, used by the Express server) ──────

test("G01 parseCookies keeps a malformed %-escape raw instead of throwing", () => {
  // Regression: decodeURIComponent threw URIError on `x=%E0`, so one bad cookie
  // 500'd every Express session route (getSid → parseCookies).
  let out: Record<string, string> = {};
  assert.doesNotThrow(() => {
    out = parseCookies("x=%E0; samarth_portal_sid=abc%20def; other=ok");
  });
  assert.strictEqual(out.x, "%E0");
  assert.strictEqual(out.samarth_portal_sid, "abc def");
  assert.strictEqual(out.other, "ok");
});

// ── H. Express OAuth state is bound to the browser that started sign-in ─────

test("H01 a state minted in another browser is rejected (login CSRF)", () => {
  // Regression: the callback only checked a process-global map, so a state the
  // attacker minted at /api/oauth/start completed sign-in in a victim's browser.
  const attackerState = newOAuthState();
  const victimState = newOAuthState();
  assert.strictEqual(consumeOAuthState(attackerState, undefined), false, "no state cookie");
  assert.strictEqual(consumeOAuthState(attackerState, victimState), false, "victim's own cookie");
  assert.strictEqual(consumeOAuthState(attackerState, ""), false, "empty cookie");
});
test("H02 the state matching this browser's cookie is accepted once", () => {
  const state = newOAuthState();
  assert.strictEqual(consumeOAuthState(state, state), true);
  assert.strictEqual(consumeOAuthState(state, state), false, "state must be single-use");
});
test("H03 a state this server never minted is rejected even with a matching cookie", () => {
  const forged = "f".repeat(48);
  assert.strictEqual(consumeOAuthState(forged, forged), false);
});

// ── J. session cookie: sealed tokens + server-enforced absolute lifetime ────
// Regression: the cookie was signed-only base64 JSON (refresh token readable by
// anyone holding it) with no issued-at, so a copied cookie minted new access
// tokens forever and a refresh never let the session age out.

const SESSION_TEST_SECRET = "storage-suite-session-secret-0123456789";
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION: SessionTokens = {
  accessToken: "ya29.SESSION-ACCESS",
  refreshToken: "1//SESSION-REFRESH",
  expiresAt: Date.now() + 3_600_000,
  email: "someone@example.com",
  scopes: ["https://www.googleapis.com/auth/tagmanager.readonly"],
};

function withSessionSecret<T>(fn: () => T): T {
  const prev = process.env.PORTAL_SESSION_SECRET;
  process.env.PORTAL_SESSION_SECRET = SESSION_TEST_SECRET;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PORTAL_SESSION_SECRET;
    else process.env.PORTAL_SESSION_SECRET = prev;
  }
}

test("J01 a minted session cookie round-trips and is stamped with iat", () => {
  withSessionSecret(() => {
    const before = Date.now();
    const out = decodeSessionCookie(encodeSessionCookie(SESSION));
    assert.ok(out, "fresh cookie must decode");
    assert.strictEqual(out.accessToken, SESSION.accessToken);
    assert.strictEqual(out.refreshToken, SESSION.refreshToken);
    assert.ok(typeof out.iat === "number" && out.iat >= before && out.iat <= Date.now());
  });
});
test("J02 the cookie does not expose the tokens (sealed, not just signed)", () => {
  withSessionSecret(() => {
    const value = encodeSessionCookie(SESSION);
    const [version, body, extra] = value.split(".");
    assert.strictEqual(version, "v1e");
    assert.strictEqual(extra, undefined);
    const decoded = Buffer.from(body, "base64url").toString("latin1");
    for (const secret of [SESSION.refreshToken!, SESSION.accessToken, SESSION.email!]) {
      assert.ok(!value.includes(secret), `cookie value leaks ${secret}`);
      assert.ok(!decoded.includes(secret), `cookie body decodes to ${secret}`);
    }
  });
});
test("J03 a correctly sealed cookie older than the absolute lifetime is rejected", () => {
  withSessionSecret(() => {
    const now = Date.now();
    const stale = encodeSessionCookie({ ...SESSION, iat: now - SESSION_MAX_AGE_MS - 60_000 });
    assert.strictEqual(decodeSessionCookie(stale), null);
    const old = encodeSessionCookie({ ...SESSION, iat: now - 31 * DAY_MS });
    assert.strictEqual(decodeSessionCookie(old), null);
    const future = encodeSessionCookie({ ...SESSION, iat: now + DAY_MS });
    assert.strictEqual(decodeSessionCookie(future), null, "iat from the future");
    const inside = encodeSessionCookie({ ...SESSION, iat: now - 29 * DAY_MS });
    assert.ok(decodeSessionCookie(inside), "a 29-day-old session is still valid");
  });
});
test("J04 rotating the cookie on refresh keeps the original iat (no extension)", () => {
  withSessionSecret(() => {
    const iat = Date.now() - 20 * DAY_MS;
    const tokens = decodeSessionCookie(encodeSessionCookie({ ...SESSION, iat }))!;
    const rotated = decodeSessionCookie(
      encodeSessionCookie({ ...tokens, accessToken: "ya29.NEW", expiresAt: Date.now() + 3_600_000 }),
    );
    assert.ok(rotated);
    assert.strictEqual(rotated.iat, iat);
    assert.strictEqual(rotated.accessToken, "ya29.NEW");
  });
});
test("J05 tampered, foreign-secret and legacy signed-only v1 cookies are rejected", () => {
  withSessionSecret(() => {
    const value = encodeSessionCookie(SESSION);
    const [version, body] = value.split(".");
    const flipped = body.slice(0, 20) + (body[20] === "A" ? "B" : "A") + body.slice(21);
    assert.strictEqual(decodeSessionCookie(`${version}.${flipped}`), null, "tampered");
    assert.strictEqual(decodeSessionCookie(`${version}.`), null, "empty body");
    assert.strictEqual(decodeSessionCookie(`v2.${body}`), null, "wrong version");
    const legacyPayload = `v1.${Buffer.from(
      JSON.stringify({ ...SESSION, iat: Date.now() }),
    ).toString("base64url")}`;
    const legacySig = crypto
      .createHmac("sha256", SESSION_TEST_SECRET)
      .update(legacyPayload)
      .digest("base64url");
    assert.strictEqual(decodeSessionCookie(`${legacyPayload}.${legacySig}`), null, "legacy v1");
  });
  const minted = withSessionSecret(() => encodeSessionCookie(SESSION));
  const prev = process.env.PORTAL_SESSION_SECRET;
  process.env.PORTAL_SESSION_SECRET = "a-different-session-secret-9876543210";
  try {
    assert.strictEqual(decodeSessionCookie(minted), null, "foreign secret");
  } finally {
    if (prev === undefined) delete process.env.PORTAL_SESSION_SECRET;
    else process.env.PORTAL_SESSION_SECRET = prev;
  }
});
test("J06 the Express in-memory session also expires after the absolute lifetime", () => {
  setSession("sid-fresh", { ...SESSION, iat: Date.now() - DAY_MS });
  assert.ok(getSession("sid-fresh"), "a 1-day-old session is valid");
  setSession("sid-stale", { ...SESSION, iat: Date.now() - 31 * DAY_MS });
  assert.strictEqual(getSession("sid-stale"), null, "a 31-day-old session is rejected");
  assert.strictEqual(getSession("sid-stale"), null, "and stays gone");
  setSession("sid-no-iat", { ...SESSION });
  assert.strictEqual(getSession("sid-no-iat"), null, "a session without iat is rejected");
});

// ── runner ────────────────────────────────────────────────────────────────--

async function main() {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      failures.push(`${name}: ${(e as Error).message}`);
    }
  }

  const total = passed + failed;
  console.log(`\nStorage foundation — token vault + DB config/factory suite`);
  console.log(`  cases run:    ${total}`);
  console.log(`  passed:       ${passed}`);
  console.log(`  failed:       ${failed}`);
  if (failed > 0) {
    console.error(`\nFailures:`);
    for (const ff of failures) console.error(`  ✗ ${ff}`);
    process.exit(1);
  }
  if (total < 20) {
    console.error(`\n✗ Expected at least 20 storage cases, only ${total} ran.`);
    process.exit(1);
  }
  console.log(`\n✓ All ${total} storage cases passed (>= 20 required).`);
}

void main();
