/**
 * Storage-foundation suite: token vault (../token-vault.ts), DB config + store
 * factory (../db/*). Pure-logic + in-memory only — no live DB, no real secret
 * manager, no network.
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
