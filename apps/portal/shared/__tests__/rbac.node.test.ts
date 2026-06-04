/**
 * Role-matrix + authorization invariant suite for ../rbac.ts.
 *
 * Pure-logic, table-driven, deterministic. No I/O, no env. These encode the
 * multi-tenant RBAC contract:
 *   - tenant isolation: a principal can never act on another org,
 *   - role monotonicity: higher roles are supersets of lower ones,
 *   - the matrix grants no portal-publishable capability (guardrail),
 *   - role-assignment cannot escalate privilege.
 *
 * Run: npx tsx apps/portal/shared/__tests__/rbac.node.test.ts
 */

import assert from "node:assert";
import {
  ROLE_ORDER,
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
  authorize,
  can,
  assertCan,
  roleCan,
  roleAtLeast,
  compareRoles,
  canAssignRole,
  AuthorizationError,
  type Permission,
  type Principal,
} from "../rbac";
import type { MembershipRole } from "../production-types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

const ORG = "org-1";
const OTHER = "org-2";
function principal(role: MembershipRole, orgId = ORG): Principal {
  return { userId: "u1", orgId, role };
}

const ROLES: MembershipRole[] = ["viewer", "member", "admin", "owner"];

// ── A. matrix shape ─────────────────────────────────────────────────────────

test("A01 ROLE_ORDER lists all four roles low→high", () => {
  assert.deepEqual([...ROLE_ORDER], ["viewer", "member", "admin", "owner"]);
});
test("A02 every role has a permission set", () => {
  for (const r of ROLES) assert.ok(ROLE_PERMISSIONS[r] instanceof Set);
});
test("A03 viewer is read-only (no mutating permission)", () => {
  for (const p of ROLE_PERMISSIONS.viewer) {
    assert.ok(
      p.endsWith(":read"),
      `viewer should only have :read perms, found ${p}`,
    );
  }
});
test("A04 ALL_PERMISSIONS equals the owner set (owner is the superset)", () => {
  assert.strictEqual(ALL_PERMISSIONS, ROLE_PERMISSIONS.owner);
});

// ── B. role monotonicity (higher ⊇ lower) ───────────────────────────────────

test("B01 each role is a superset of the one below it", () => {
  for (let i = 1; i < ROLE_ORDER.length; i++) {
    const lower = ROLE_PERMISSIONS[ROLE_ORDER[i - 1]];
    const higher = ROLE_PERMISSIONS[ROLE_ORDER[i]];
    for (const p of lower) {
      assert.ok(
        higher.has(p),
        `${ROLE_ORDER[i]} missing ${p} held by ${ROLE_ORDER[i - 1]}`,
      );
    }
  }
});
test("B02 owner ⊇ admin ⊇ member ⊇ viewer in size", () => {
  assert.ok(ROLE_PERMISSIONS.owner.size >= ROLE_PERMISSIONS.admin.size);
  assert.ok(ROLE_PERMISSIONS.admin.size >= ROLE_PERMISSIONS.member.size);
  assert.ok(ROLE_PERMISSIONS.member.size >= ROLE_PERMISSIONS.viewer.size);
});
test("B03 only owner has org:update and org:delete", () => {
  for (const r of ROLES) {
    const expected = r === "owner";
    assert.strictEqual(roleCan(r, "org:update"), expected, `${r} org:update`);
    assert.strictEqual(roleCan(r, "org:delete"), expected, `${r} org:delete`);
  }
});

// ── C. specific role capabilities (the matrix as a table) ───────────────────

const MATRIX: Array<[MembershipRole, Permission, boolean]> = [
  ["viewer", "audit:read", true],
  ["viewer", "audit:run", false],
  ["viewer", "project:create", false],
  ["viewer", "approval:submit", false],
  ["member", "audit:run", true],
  ["member", "project:create", true],
  ["member", "capture:request", true],
  ["member", "approval:submit", true],
  ["member", "approval:decide", false],
  ["member", "connection:connect", false],
  ["member", "member:remove", false],
  ["admin", "approval:decide", true],
  ["admin", "connection:connect", true],
  ["admin", "connection:disconnect", true],
  ["admin", "member:remove", true],
  ["admin", "audit:delete", true],
  ["admin", "org:update", false],
  ["owner", "org:update", true],
  ["owner", "org:delete", true],
  ["owner", "approval:decide", true],
];

for (const [role, perm, expected] of MATRIX) {
  test(`C ${role} ${perm} → ${expected}`, () => {
    assert.strictEqual(roleCan(role, perm), expected);
  });
}

// ── D. guardrail: no portal-grantable publish capability ────────────────────

test("D01 no permission ends in :publish (publish stays MCP-guardrailed)", () => {
  for (const p of ALL_PERMISSIONS) {
    assert.ok(!p.endsWith(":publish"), `unexpected publish permission ${p}`);
  }
});

// ── E. tenant isolation via authorize() ─────────────────────────────────────

test("E01 admin can act within their own org", () => {
  assert.ok(can(principal("admin"), "approval:decide", ORG));
});
test("E02 admin CANNOT act on another org (cross_tenant)", () => {
  const d = authorize(principal("admin", ORG), "approval:decide", OTHER);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "cross_tenant");
});
test("E03 null principal is denied (no_principal)", () => {
  const d = authorize(null, "audit:read", ORG);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "no_principal");
});
test("E04 insufficient role is denied (insufficient_role)", () => {
  const d = authorize(principal("viewer"), "audit:run", ORG);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "insufficient_role");
});
test("E05 cross-tenant takes precedence over role check", () => {
  // An owner of org-1 acting on org-2 is cross_tenant, not allowed-by-role.
  const d = authorize(principal("owner", ORG), "org:delete", OTHER);
  assert.strictEqual(d.reason, "cross_tenant");
});

// ── F. assertCan throwing guard ─────────────────────────────────────────────

test("F01 assertCan passes for an authorized principal", () => {
  assert.doesNotThrow(() => assertCan(principal("member"), "audit:run", ORG));
});
test("F02 assertCan throws AuthorizationError when denied", () => {
  assert.throws(
    () => assertCan(principal("viewer"), "audit:run", ORG),
    (e: unknown) =>
      e instanceof AuthorizationError && e.reason === "insufficient_role",
  );
});
test("F03 assertCan throws with cross_tenant for wrong org", () => {
  assert.throws(
    () => assertCan(principal("owner", ORG), "org:delete", OTHER),
    (e: unknown) => e instanceof AuthorizationError && e.reason === "cross_tenant",
  );
});

// ── G. role comparison helpers ───────────────────────────────────────────────

test("G01 compareRoles orders by privilege", () => {
  assert.ok(compareRoles("owner", "viewer") > 0);
  assert.ok(compareRoles("viewer", "owner") < 0);
  assert.strictEqual(compareRoles("admin", "admin"), 0);
});
test("G02 roleAtLeast is inclusive", () => {
  assert.ok(roleAtLeast("admin", "admin"));
  assert.ok(roleAtLeast("owner", "member"));
  assert.ok(!roleAtLeast("member", "admin"));
});

// ── H. role-assignment escalation guard ──────────────────────────────────────

test("H01 viewer/member cannot assign roles at all", () => {
  assert.ok(!canAssignRole("viewer", "viewer"));
  assert.ok(!canAssignRole("member", "viewer"));
});
test("H02 admin can assign roles strictly below admin", () => {
  assert.ok(canAssignRole("admin", "member"));
  assert.ok(canAssignRole("admin", "viewer"));
});
test("H03 admin CANNOT assign admin or owner (no self/up escalation)", () => {
  assert.ok(!canAssignRole("admin", "admin"));
  assert.ok(!canAssignRole("admin", "owner"));
});
test("H04 owner can assign any role (incl. ownership transfer)", () => {
  for (const r of ROLES) assert.ok(canAssignRole("owner", r), `owner→${r}`);
});

// ── run summary ──────────────────────────────────────────────────────────--

const total = passed + failed;
console.log(`\nRBAC — role-matrix + authorization suite`);
console.log(`  cases run:    ${total}`);
console.log(`  passed:       ${passed}`);
console.log(`  failed:       ${failed}`);
if (failed > 0) {
  console.error(`\nFailures:`);
  for (const ff of failures) console.error(`  ✗ ${ff}`);
  process.exit(1);
}
if (total < 30) {
  console.error(`\n✗ Expected at least 30 RBAC cases, only ${total} ran.`);
  process.exit(1);
}
console.log(`\n✓ All ${total} RBAC cases passed (>= 30 required).`);
