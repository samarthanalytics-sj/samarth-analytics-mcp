// Multi-tenant RBAC enforcement primitives.
//
// FORWARD-LOOKING foundation: pure, dependency-free authorization helpers that
// define the role → permission matrix for org/project/audit/approval/connection
// operations. This file imports no driver, opens no connection, and reads no
// env — it is a deterministic policy module safe to import from the Vercel
// serverless `api/**` routes (erased under `import type` where only types are
// used) and from the Node worker.
//
// The unit RBAC keys on is a `memberships` row (see infra/database/0001_init.sql
// and `MembershipRole` in production-types.ts): a (user, org, role) tuple. The
// caller resolves the membership for the active org out of band (cookie session
// today; DB-backed session later) and passes the resulting role + org id here.
//
// Guardrail alignment: authorization here governs PORTAL workflow actions only.
// It NEVER grants a GTM/GA4 write — publishing stays gated by the MCP server's
// GTM_MCP_ENABLE_PUBLISH guardrail regardless of what this matrix allows. The
// most an org owner can do through the portal is move an approval_request to
// `approved`; the actual publish is still a separate, guardrailed step.

import type { MembershipRole } from "./production-types";

/** Roles in privilege order (lowest → highest). Mirrors the SQL CHECK constraint. */
export const ROLE_ORDER: readonly MembershipRole[] = [
  "viewer",
  "member",
  "admin",
  "owner",
] as const;

/**
 * Every action the portal can authorize. Grouped by resource. Read actions are
 * suffixed `:read`, mutations by their verb. There is intentionally no
 * `*:publish` action — publishing is not a portal-grantable capability (see the
 * guardrail note above); the closest portal action is `approval:decide`.
 */
export type Permission =
  // Organization administration
  | "org:read"
  | "org:update" // rename, plan, settings
  | "org:delete"
  | "member:read"
  | "member:invite"
  | "member:update_role"
  | "member:remove"
  // Projects (saved audit targets)
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:archive"
  // Audit runs + findings
  | "audit:read"
  | "audit:run"
  | "audit:delete"
  // Runtime captures
  | "capture:read"
  | "capture:request"
  | "capture:delete"
  // OAuth connections (metadata only — never token bytes)
  | "connection:read"
  | "connection:connect"
  | "connection:disconnect"
  // Approval workflow (decision does NOT publish)
  | "approval:read"
  | "approval:submit"
  | "approval:decide";

/**
 * Role → permission matrix. Higher roles are supersets of lower ones by design,
 * but the matrix is written out explicitly per role rather than via inheritance
 * so an audit reading this file sees exactly what each role can do without
 * having to compute a closure. The test suite asserts the monotonicity
 * invariant (a higher role never has fewer permissions than a lower one).
 *
 *   viewer  — read-only across the org. Cannot run audits or mutate anything.
 *   member  — viewer + can run audits, request captures, manage projects, and
 *             submit change plans for review. Cannot approve or administer.
 *   admin   — member + connection management, member management (except owner
 *             transfer), approval decisions, and deletes.
 *   owner   — admin + destructive org-level actions (org:update/delete).
 */
const VIEWER: Permission[] = [
  "org:read",
  "member:read",
  "project:read",
  "audit:read",
  "capture:read",
  "connection:read",
  "approval:read",
];

const MEMBER: Permission[] = [
  ...VIEWER,
  "project:create",
  "project:update",
  "project:archive",
  "audit:run",
  "capture:request",
  "approval:submit",
];

const ADMIN: Permission[] = [
  ...MEMBER,
  "member:invite",
  "member:update_role",
  "member:remove",
  "audit:delete",
  "capture:delete",
  "connection:connect",
  "connection:disconnect",
  "approval:decide",
];

const OWNER: Permission[] = [...ADMIN, "org:update", "org:delete"];

export const ROLE_PERMISSIONS: Record<MembershipRole, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

/** The set of all known permissions (derived from the owner role, the superset). */
export const ALL_PERMISSIONS: ReadonlySet<Permission> = ROLE_PERMISSIONS.owner;

/**
 * A principal as the portal knows it for a single org context. `role` is the
 * membership role for `orgId`; `userId` is the acting user. A principal with no
 * membership in the target org is represented by passing `null` to `can()`'s
 * principal-resolution path (see `authorize`).
 */
export interface Principal {
  userId: string;
  orgId: string;
  role: MembershipRole;
}

/** True when `role` is granted `permission` by the matrix. */
export function roleCan(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Core authorization check. A principal may act iff:
 *   1. it is non-null (the user has a membership in some org), AND
 *   2. the action targets the SAME org the principal is scoped to (tenant
 *      isolation — a member of org A can never act on org B), AND
 *   3. the principal's role grants the permission.
 *
 * Returns a structured decision so callers can log/deny uniformly.
 */
export interface AuthzDecision {
  allowed: boolean;
  /** Stable machine reason, present when denied. */
  reason?: "no_principal" | "cross_tenant" | "insufficient_role";
}

export function authorize(
  principal: Principal | null | undefined,
  permission: Permission,
  targetOrgId: string,
): AuthzDecision {
  if (!principal) return { allowed: false, reason: "no_principal" };
  if (principal.orgId !== targetOrgId) {
    return { allowed: false, reason: "cross_tenant" };
  }
  if (!roleCan(principal.role, permission)) {
    return { allowed: false, reason: "insufficient_role" };
  }
  return { allowed: true };
}

/** Boolean convenience wrapper over `authorize`. */
export function can(
  principal: Principal | null | undefined,
  permission: Permission,
  targetOrgId: string,
): boolean {
  return authorize(principal, permission, targetOrgId).allowed;
}

/**
 * Throwing guard for imperative call sites (route handlers). Throws an
 * `AuthorizationError` carrying the deny reason; callers map it to a 403/404.
 * (Prefer 404 for `cross_tenant` to avoid leaking existence across tenants.)
 */
export class AuthorizationError extends Error {
  readonly reason: NonNullable<AuthzDecision["reason"]>;
  constructor(reason: NonNullable<AuthzDecision["reason"]>) {
    super(`authorization denied: ${reason}`);
    this.name = "AuthorizationError";
    this.reason = reason;
  }
}

export function assertCan(
  principal: Principal | null | undefined,
  permission: Permission,
  targetOrgId: string,
): asserts principal is Principal {
  const decision = authorize(principal, permission, targetOrgId);
  if (!decision.allowed) {
    throw new AuthorizationError(decision.reason ?? "insufficient_role");
  }
}

/** Compare two roles by privilege. Negative if a < b, 0 if equal, positive if a > b. */
export function compareRoles(a: MembershipRole, b: MembershipRole): number {
  return ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b);
}

/** True when `role` is at least as privileged as `min`. */
export function roleAtLeast(role: MembershipRole, min: MembershipRole): boolean {
  return compareRoles(role, min) >= 0;
}

/**
 * Guard for the one privileged operation the matrix can't express positionally:
 * a role may only assign/modify a membership role that is strictly below its
 * own (an admin cannot mint another owner or admin; only an owner can grant
 * admin). Returns whether `actorRole` may set a membership to `targetRole`.
 */
export function canAssignRole(
  actorRole: MembershipRole,
  targetRole: MembershipRole,
): boolean {
  if (!roleCan(actorRole, "member:update_role")) return false;
  // Owners may assign any role (including transferring ownership). Everyone else
  // may only assign roles strictly below their own.
  if (actorRole === "owner") return true;
  return compareRoles(actorRole, targetRole) > 0;
}
