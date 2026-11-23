/// Company membership, role ceilings, and explicit grants. Pure functions over
/// injected state so the same rules qualify in tests and in production.
///
/// Model: one human (an Apple-verified tenant) may belong to many companies.
/// A company role name is only a ceiling: it caps which grants a member may
/// hold, never grants anything by itself. Every write requires the matching
/// explicit grant, and a member with no grants is read-only — including an
/// owner. Company creation additionally requires a separate account-level
/// entitlement (`canCreateCompany`), so tenant membership never implies a
/// right to mint new tenants.

export const COMPANY_ROLES = ["owner", "admin", "operator", "approver", "auditor", "viewer"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

/// Grants understood by the company authority. Adding a grant is a
/// deliberate, separately reviewed change: each new grant needs a ceiling
/// entry below, an enforcement point in `company-object.ts`, and tests.
export const GRANTS = {
  AGENTS_CONFIGURE: "agents.configure",
  TASKS_CREATE: "tasks.create",
  APPROVALS_DECIDE: "approvals.decide",
  MEMBERS_MANAGE: "members.manage",
  COMPANY_CONFIGURE: "company.configure",
  COMPANY_DELETE: "company.delete",
  AUDIT_READ: "audit.read",
  COMMENTS_WRITE: "comments.write",
  WORK_REQUEST: "work.request",
} as const;
export type Grant = (typeof GRANTS)[keyof typeof GRANTS];

const KNOWN_GRANTS = new Set<string>(Object.values(GRANTS));

const OWNER_GRANTS: Grant[] = [
  GRANTS.AGENTS_CONFIGURE,
  GRANTS.TASKS_CREATE,
  GRANTS.APPROVALS_DECIDE,
  GRANTS.MEMBERS_MANAGE,
  GRANTS.COMPANY_CONFIGURE,
  GRANTS.COMPANY_DELETE,
  GRANTS.AUDIT_READ,
  GRANTS.COMMENTS_WRITE,
  GRANTS.WORK_REQUEST,
];

/// Role ceilings: the maximum grant set a member of that role may hold.
/// `company.delete` is owner-only, which is the one grant that keeps `owner`
/// distinct from `admin`. A repeated grant, an unknown grant, or any grant
/// above the ceiling is rejected rather than clamped, so a misconfigured
/// caller learns it asked for too much instead of silently receiving less.
export const ROLE_CEILING: Record<CompanyRole, Grant[]> = {
  owner: OWNER_GRANTS,
  admin: OWNER_GRANTS.filter((grant) => grant !== GRANTS.COMPANY_DELETE),
  operator: [GRANTS.TASKS_CREATE, GRANTS.COMMENTS_WRITE, GRANTS.WORK_REQUEST],
  approver: [GRANTS.APPROVALS_DECIDE, GRANTS.COMMENTS_WRITE],
  auditor: [GRANTS.AUDIT_READ],
  viewer: [],
};

export function isValidRole(role: unknown): role is CompanyRole {
  return typeof role === "string" && (COMPANY_ROLES as readonly string[]).includes(role);
}

/// Company ids travel in paths and storage keys. They must be unguessable
/// enough to avoid enumeration yet safe to embed: letters, digits, dash and
/// underscore only, no dot segments, separators, or query injection.
export function isValidCompanyId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

/// Tenants are opaque Apple-verified subjects. The only structural demand is
/// that they are non-empty bounded strings; anything else is rejected so a
/// missing tenant can never match a stored one.
export function isValidTenant(tenant: unknown): tenant is string {
  return typeof tenant === "string" && tenant.length > 0 && tenant.length <= 256;
}

export type GrantCheck =
  | { ok: true; grants: Grant[] }
  | { ok: false; error: "unknown_grant" | "grant_exceeds_ceiling" | "duplicate_grant" };

/// Validates a requested grant set against the member's role ceiling.
/// Fails closed on unknown, duplicated, or above-ceiling grants.
export function checkGrants(role: CompanyRole, grants: unknown): GrantCheck {
  if (!Array.isArray(grants)) return { ok: false, error: "unknown_grant" };
  const seen = new Set<string>();
  for (const grant of grants) {
    if (typeof grant !== "string" || !KNOWN_GRANTS.has(grant)) return { ok: false, error: "unknown_grant" };
    if (seen.has(grant)) return { ok: false, error: "duplicate_grant" };
    seen.add(grant);
  }
  const ceiling = new Set<string>(ROLE_CEILING[role]);
  for (const grant of seen) {
    if (!ceiling.has(grant)) return { ok: false, error: "grant_exceeds_ceiling" };
  }
  return { ok: true, grants: [...seen] as Grant[] };
}

/// A write is permitted only when the member's explicit grant set contains
/// the required grant. No role implies any grant.
export function hasGrant(grants: readonly string[], required: Grant): boolean {
  return grants.includes(required);
}

/// A member's shared scope (OFC-21, `docs/office-sharing.md`): the ids of the
/// shared items that member may see. `null` is the pre-sharing default and
/// means everything, so members seated before sharing existed keep exactly
/// the access they had. An array, even an empty one, means only those ids.
export type SharedScope = string[] | null;

/// One membership row as `CompanyObject` stores it. `authVersion` is the
/// member's authorization version: it bumps whenever their role, status,
/// grants or shared scope change, so an authorization cached against the old
/// version can tell it is stale.
export type MemberRecord = {
  role: CompanyRole;
  status: "active" | "revoked";
  authVersion: number;
  sharedScope: SharedScope;
};

/// The most ids one member's scope may name. Every member row lives in one
/// stored `members` value, so an unbounded scope on each member would grow
/// that value without limit; a share covers the runs the owner picked by hand.
export const MAX_SHARED_SCOPE = 200;

/// Shared item ids are run ids (UUID strings on the Mac) and will travel in
/// paths, so they follow the same safe shape as company ids.
export function isValidSharedItemId(id: unknown): id is string {
  return isValidCompanyId(id);
}

/// A member row as it may sit in storage. Rows written before sharing carry
/// no `sharedScope`, so the field is read as unknown rather than trusted.
export type StoredMemberRecord = Omit<MemberRecord, "sharedScope"> & { sharedScope?: unknown };

/// Reads a stored member row tolerantly. Rows written before sharing carry no
/// `sharedScope`; absent or `null` reads as the pre-sharing full access. A
/// scope that is present but malformed fails closed: it reads as the ids it
/// still validly names, or none, never as everything.
export function readMember(stored: StoredMemberRecord): MemberRecord {
  const raw = stored.sharedScope;
  const sharedScope: SharedScope =
    raw === undefined || raw === null
      ? null
      : Array.isArray(raw)
        ? raw.filter(isValidSharedItemId)
        : [];
  return {
    ...stored,
    authVersion: Number.isInteger(stored.authVersion) ? stored.authVersion : 0,
    sharedScope,
  };
}

/// Whether a member may see one shared item: an active membership, and the
/// item in their scope (or a pre-sharing `null` scope). A revoked row is never
/// in scope, whatever it still lists, so callers that forget the status check
/// still fail closed. An active owner sees all of the company's shared work
/// (the matrix's "all of it"), whatever their row lists: a member promoted to
/// owner keeps the scope they held, so a later demotion cannot widen it, and
/// the scope route refuses owner rows, so that kept scope must not lock the
/// new owner out of work they now own.
export function inScope(member: Pick<MemberRecord, "role" | "status" | "sharedScope">, itemId: string): boolean {
  if (member.status !== "active" || !isValidSharedItemId(itemId)) return false;
  if (member.role === "owner") return true;
  return member.sharedScope === null || member.sharedScope.includes(itemId);
}

/// The member row after any change to their authority (role, status, grants
/// or scope): the same row with its authorization version moved on.
export function bumpAuthz(member: MemberRecord): MemberRecord {
  return { ...member, authVersion: member.authVersion + 1 };
}

export type ScopeCheck =
  | { ok: true; scope: string[] }
  | { ok: false; error: "invalid_scope" | "duplicate_item" | "scope_too_large" };

/// Validates a requested shared scope. Like grants, a malformed, repeated or
/// oversized list is refused rather than trimmed, so the owner learns what
/// they asked for was not stored. `null` is refused too: full access is the
/// pre-sharing default, never something a share hands out.
export function checkScope(scope: unknown): ScopeCheck {
  if (!Array.isArray(scope)) return { ok: false, error: "invalid_scope" };
  if (scope.length > MAX_SHARED_SCOPE) return { ok: false, error: "scope_too_large" };
  const seen = new Set<string>();
  for (const id of scope) {
    if (!isValidSharedItemId(id)) return { ok: false, error: "invalid_scope" };
    if (seen.has(id)) return { ok: false, error: "duplicate_item" };
    seen.add(id);
  }
  return { ok: true, scope: [...seen] };
}
