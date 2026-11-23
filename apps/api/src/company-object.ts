import { DurableObject } from "cloudflare:workers";
import { readJsonBody } from "./body";
import {
  GRANTS,
  ROLE_CEILING,
  bumpAuthz,
  checkGrants,
  checkScope,
  hasGrant,
  inScope,
  isValidCompanyId,
  isValidRole,
  isValidSharedItemId,
  isValidTenant,
  readMember,
  type CompanyRole,
  type Grant,
  type MemberRecord,
  type StoredMemberRecord,
} from "./companies";
import {
  MAX_SHARED_ITEMS,
  SHARED_INDEX_KEY,
  SHARED_RECORD_MAX_BYTES,
  checkSharedRecord,
  sharedKey,
  type StoredSharedRun,
} from "./shared-items";
import {
  COMMENT_MAX_BYTES,
  MAX_COMMENTS_PER_RUN,
  checkComment,
  commentCountKey,
  commentKey,
  type StoredComment,
} from "./shared-comments";

const MAX_BODY_BYTES = 256 * 1024;

/// The one answer for a shared run the caller may not read, whether it was
/// never published, was withdrawn, or is outside their scope. Identical
/// bytes, so a probe cannot tell a hidden run from an absent one, and no
/// title, state or name rides along (`docs/office-sharing.md`: "Not shared").
function notShared(): Response {
  return Response.json({ error: "not_shared" }, { status: 404 });
}

export type CompanyRecordJSON = {
  id: string;
  name: string;
  timezone: string;
  ownerTenant: string;
  policyVersion: number;
  createdAt: string;
  updatedAt: string;
};

/// One membership row, read through `readMember` so rows stored before
/// sharing load with the pre-sharing full-access scope. `authVersion` bumps
/// whenever the member's role, status, grants or shared scope change, so
/// cached authorization versions can detect they are stale.
export type MemberRecordJSON = MemberRecord;

/// Per-company authority: the company record, memberships, explicit grants,
/// the grant revision that future dispatch checks bind approvals to, the
/// shared run records the owner publishes (`shared-items.ts`), and the
/// comments people write on them (`shared-comments.ts`).
/// Addressed `c:${companyId}` (`companyStub` in the worker). A company id
/// that was never created holds no record, so an unknown id answers
/// `company_unknown` — it never resolves to a different company.
///
/// Every route takes the caller from the `x-tenant` header, which only the
/// worker sets from a verified session (or the tenantless operator path via
/// `x-operator`). A client-supplied company id is a requested scope, never
/// proof of membership: each route re-checks it.
export class CompanyObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === "/create") return this.create(request);
    if (request.method === "GET" && path === "/get") return this.get(request);
    if (request.method === "PATCH" && path === "/configure") return this.configure(request);
    if (request.method === "DELETE" && path === "/delete") return this.remove(request);
    if (request.method === "GET" && path === "/members") return this.listMembers(request);
    if (request.method === "POST" && path === "/members") return this.addMember(request);
    if (request.method === "PATCH" && path === "/members") return this.updateMember(request);
    if (request.method === "POST" && path === "/grants") return this.setGrants(request);
    if (request.method === "POST" && path === "/revoke") return this.revoke(request);
    if (request.method === "PATCH" && path === "/scope") return this.setScope(request);
    if (request.method === "GET" && path === "/shared") return this.listShared(url, request);
    if (request.method === "GET" && path === "/shared-item") return this.readShared(url, request);
    if (request.method === "PUT" && path === "/shared-item") return this.publishShared(url, request);
    if (request.method === "DELETE" && path === "/shared-item") return this.withdrawShared(url, request);
    if (request.method === "GET" && path === "/shared-comments") return this.listComments(url, request);
    if (request.method === "POST" && path === "/shared-comments") return this.addComment(url, request);
    if (request.method === "POST" && path === "/tasks-index") return this.indexTask(request);
    if (request.method === "GET" && path === "/tasks-index") return this.readTaskIndex(url, request);
    if (request.method === "POST" && path === "/tasks-prune") return this.pruneTaskIndex(request);
    if (request.method === "POST" && path === "/connections-allow") return this.setAllowedConnections(request);
    if (request.method === "GET" && path === "/template") return this.exportTemplate(request);
    if (request.method === "POST" && path === "/template-import") return this.importTemplate(request);
    if (request.method === "POST" && path === "/dispatch-check") return this.dispatchCheck(request);
    return new Response("Method Not Allowed", { status: 405 });
  }

  private caller(request: Request): string | null {
    if (request.headers.get("x-operator") === "1") return null;
    const tenant = request.headers.get("x-tenant") ?? "";
    return isValidTenant(tenant) ? tenant : null;
  }

  private async load(): Promise<{
    company: CompanyRecordJSON | undefined;
    members: Record<string, MemberRecordJSON>;
    grants: Record<string, Grant[]>;
    grantRevision: number;
    /// Connection ids this company's actions may use. Absent means
    /// unrestricted (the pre-allowlist default); an empty array denies all.
    allowedConnections?: string[];
  }> {
    const [company, stored, grants, grantRevision, allowedConnections] = await Promise.all([
      this.ctx.storage.get<CompanyRecordJSON>("company"),
      this.ctx.storage.get<Record<string, StoredMemberRecord>>("members"),
      this.ctx.storage.get<Record<string, Grant[]>>("grants"),
      this.ctx.storage.get<number>("grantRevision"),
      this.ctx.storage.get<string[]>("allowedConnections"),
    ]);
    const members: Record<string, MemberRecordJSON> = {};
    for (const [tenant, row] of Object.entries(stored ?? {})) members[tenant] = readMember(row);
    return {
      company,
      members,
      grants: grants ?? {},
      grantRevision: grantRevision ?? 0,
      ...(allowedConnections === undefined ? {} : { allowedConnections }),
    };
  }

  private async bumpGrants(
    members: Record<string, MemberRecordJSON>,
    grants: Record<string, Grant[]>,
    revision: number,
  ): Promise<number> {
    const next = revision + 1;
    await Promise.all([
      this.ctx.storage.put("members", members),
      this.ctx.storage.put("grants", grants),
      this.ctx.storage.put("grantRevision", next),
    ]);
    return next;
  }

  /// Creates the company and seats the creator as an active owner holding the
  /// full owner ceiling. The worker asserts the account-level
  /// company-creation entitlement before forwarding (`x-entitled`), so this
  /// object never mints a company on an unentitled caller's word alone. The
  /// existence check and the writes run in one storage transaction, so two
  /// concurrent creates with the same id produce exactly one company and one
  /// `company_exists` — never two winners.
  private async create(request: Request): Promise<Response> {
    if (request.headers.get("x-entitled") !== "1") {
      return Response.json({ error: "company_create_forbidden" }, { status: 403 });
    }
    const tenant = request.headers.get("x-tenant") ?? "";
    if (!isValidTenant(tenant)) return Response.json({ error: "tenant_required" }, { status: 400 });
    const parsed = await readJsonBody<{ id?: unknown; name?: unknown; timezone?: unknown }>(
      request,
      MAX_BODY_BYTES,
    );
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const id = body.id ?? crypto.randomUUID();
    if (!isValidCompanyId(id)) return Response.json({ error: "invalid_company_id" }, { status: 400 });
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const timezone =
      body.timezone === undefined
        ? "UTC"
        : typeof body.timezone === "string" && body.timezone.length > 0 && body.timezone.length <= 64
          ? body.timezone
          : null;
    if (timezone === null) return Response.json({ error: "invalid_request" }, { status: 400 });
    const now = new Date().toISOString();
    const company: CompanyRecordJSON = {
      id,
      name: body.name.trim(),
      timezone,
      ownerTenant: tenant,
      policyVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const members: Record<string, MemberRecordJSON> = {
      [tenant]: { role: "owner", status: "active", authVersion: 1, sharedScope: null },
    };
    const grants: Record<string, Grant[]> = { [tenant]: [...ROLE_CEILING.owner] };
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<CompanyRecordJSON>("company");
      if (existing) return Response.json({ error: "company_exists" }, { status: 409 });
      await txn.put("company", company);
      await txn.put("members", members);
      await txn.put("grants", grants);
      await txn.put("grantRevision", 1);
      return Response.json({ company, membership: members[tenant], grants: grants[tenant], grantRevision: 1 });
    });
  }

  /// Reads the company for an active member. Non-members learn nothing beyond
  /// the refusal: no record fields leak, and an unknown id is
  /// indistinguishable from a forbidden one at this layer's status choice —
  /// both answer without company content (404 for never-created, 403 for
  /// created-but-not-yours).
  private async get(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return Response.json({
      company: state.company,
      membership: member,
      grants: state.grants[tenant!] ?? [],
      grantRevision: state.grantRevision,
      ...(state.allowedConnections === undefined ? {} : { allowedConnections: state.allowedConnections }),
    });
  }

  private async configure(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.COMPANY_CONFIGURE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.COMPANY_CONFIGURE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ name?: unknown; timezone?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (body.name === undefined && body.timezone === undefined) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const next = { ...state.company };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      next.name = body.name.trim();
    }
    if (body.timezone !== undefined) {
      if (typeof body.timezone !== "string" || !body.timezone || body.timezone.length > 64) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      next.timezone = body.timezone;
    }
    next.policyVersion += 1;
    next.updatedAt = new Date().toISOString();
    await this.ctx.storage.put("company", next);
    return Response.json({ company: next });
  }

  /// Deletes the company record, memberships, and grants. Owner-only via the
  /// `company.delete` grant. Returns the member list so the worker can scrub
  /// the per-tenant membership index it maintains in AuthObject. Published
  /// shared run records and the comments on them live in this object too, so
  /// they go with it: deleting the company deletes its shared records
  /// (`docs/office-sharing.md`), and it does so whether or not `officeSharing`
  /// is on.
  private async remove(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.COMPANY_DELETE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.COMPANY_DELETE }, { status: 403 });
    }
    const members = Object.keys(state.members);
    await this.ctx.storage.deleteAll();
    return Response.json({ deleted: state.company.id, members });
  }

  private async listMembers(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return Response.json({
      members: state.members,
      grants: state.grants,
      grantRevision: state.grantRevision,
    });
  }

  /// Seats a new member with no grants: fail-closed by construction, so a
  /// separate reviewed grant call is what authorizes anything. Rejects
  /// duplicate active memberships and unknown roles.
  private async addMember(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; role?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { tenant: target, role } = parsed.value;
    if (!isValidTenant(target) || !isValidRole(role)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const current = state.members[target];
    if (current && current.status === "active") {
      return Response.json({ error: "member_exists" }, { status: 409 });
    }
    // Only an owner may seat another owner: an admin must not mint its own
    // superior.
    if (role === "owner" && member.role !== "owner") {
      return Response.json({ error: "owner_required" }, { status: 403 });
    }
    // A re-seated member keeps the scope their revoked row held, so revoking
    // and re-adding someone never widens what they may see; a first seat gets
    // the pre-sharing full access, as every member did before sharing.
    const members = {
      ...state.members,
      [target]: {
        role,
        status: "active",
        authVersion: (current?.authVersion ?? 0) + 1,
        sharedScope: current?.sharedScope ?? null,
      } as MemberRecordJSON,
    };
    const grants = { ...state.grants, [target]: [] as Grant[] };
    const grantRevision = await this.bumpGrants(members, grants, state.grantRevision);
    return Response.json({ membership: members[target], grants: [], grantRevision });
  }

  /// Changes role or status. Revoking here keeps the membership row as a
  /// tombstone; `POST /revoke` is the same transition as a dedicated route.
  /// Only an owner may touch an owner's row, and the last active owner can
  /// never be removed or demoted, so a company cannot be orphaned.
  private async updateMember(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; role?: unknown; status?: unknown }>(
      request,
      MAX_BODY_BYTES,
    );
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { tenant: target, role, status } = parsed.value;
    if (!isValidTenant(target)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const current = state.members[target];
    if (!current) return Response.json({ error: "member_unknown" }, { status: 404 });
    if (role !== undefined && !isValidRole(role)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (status !== undefined && status !== "active" && status !== "revoked") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (current.role === "owner" && member.role !== "owner") {
      return Response.json({ error: "owner_required" }, { status: 403 });
    }
    if (role === "owner" && member.role !== "owner") {
      return Response.json({ error: "owner_required" }, { status: 403 });
    }
    const nextRole = (role ?? current.role) as CompanyRole;
    const nextStatus = (status ?? current.status) as "active" | "revoked";
    if (current.role === "owner" && current.status === "active" && (nextRole !== "owner" || nextStatus !== "active")) {
      const otherOwners = Object.entries(state.members).filter(
        ([id, rec]) => id !== target && rec.role === "owner" && rec.status === "active",
      );
      if (otherOwners.length === 0) {
        return Response.json({ error: "last_owner" }, { status: 409 });
      }
    }
    // Spread the current row so a role change keeps the member's shared
    // scope: rebuilding it would drop the scope and read back as full access.
    const members = {
      ...state.members,
      [target]: bumpAuthz({ ...current, role: nextRole, status: nextStatus }),
    };
    // A revocation or role change invalidates previously issued grants: drop
    // grants that no longer fit the ceiling, including all of them when the
    // member is revoked.
    const grants = { ...state.grants };
    if (nextStatus !== "active") {
      grants[target] = [];
    } else if (nextRole !== current.role) {
      const ceiling = new Set<string>(ROLE_CEILING[nextRole]);
      grants[target] = (grants[target] ?? []).filter((grant) => ceiling.has(grant));
    }
    const grantRevision = await this.bumpGrants(members, grants, state.grantRevision);
    return Response.json({ membership: members[target], grants: grants[target] ?? [], grantRevision });
  }

  /// Replaces a member's grant set. Grants must fit the member's role
  /// ceiling; excessive advertised grants are rejected, never clamped.
  private async setGrants(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown; grants?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { tenant: target, grants: requested } = parsed.value;
    if (!isValidTenant(target)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const current = state.members[target];
    if (!current || current.status !== "active") {
      return Response.json({ error: "member_unknown" }, { status: 404 });
    }
    // Granting to an owner is itself an owner-level act.
    if (current.role === "owner" && member.role !== "owner") {
      return Response.json({ error: "owner_required" }, { status: 403 });
    }
    const checked = checkGrants(current.role, requested);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 403 });
    const grants = { ...state.grants, [target]: checked.grants };
    // A change of grants is a change of access, so it moves the member's
    // authorization version as well as the company's grant revision.
    const members = { ...state.members, [target]: bumpAuthz(current) };
    const grantRevision = await this.bumpGrants(members, grants, state.grantRevision);
    return Response.json({ grants: checked.grants, grantRevision });
  }

  /// Revokes a member: status tombstoned, grants cleared, revision bumped so
  /// any approval bound to the old revision fails its next check. The last
  /// active owner cannot be revoked.
  private async revoke(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { tenant: target } = parsed.value;
    if (!isValidTenant(target)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const current = state.members[target];
    if (!current || current.status !== "active") {
      return Response.json({ error: "member_unknown" }, { status: 404 });
    }
    if (current.role === "owner") {
      if (member.role !== "owner") return Response.json({ error: "owner_required" }, { status: 403 });
      const otherOwners = Object.entries(state.members).filter(
        ([id, rec]) => id !== target && rec.role === "owner" && rec.status === "active",
      );
      if (otherOwners.length === 0) {
        return Response.json({ error: "last_owner" }, { status: 409 });
      }
    }
    const members = {
      ...state.members,
      [target]: bumpAuthz({ ...current, status: "revoked" }),
    };
    const grants = { ...state.grants, [target]: [] as Grant[] };
    const grantRevision = await this.bumpGrants(members, grants, state.grantRevision);
    return Response.json({ membership: members[target], grantRevision });
  }

  /// Replaces one member's shared scope: the ids of the shared items they may
  /// see (`docs/office-sharing.md`). The worker only routes here while
  /// `officeSharing` is on. Choosing what is shared is the owner's act, so the
  /// caller must be an active owner and, like every membership write, hold
  /// `members.manage`; the operator key never reaches it, because member
  /// routes do not honor `x-operator`. An owner's row is never scoped here:
  /// the owner sees all of the company's shared work, and `inScope` ignores
  /// any scope an owner kept from before a promotion. The change moves the
  /// member's authorization version and the company's grant revision, so an
  /// approval or cached authorization from before it fails its next check.
  private async setScope(request: Request): Promise<Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasGrant(state.grants[tenant!] ?? [], GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    if (member.role !== "owner") return Response.json({ error: "owner_required" }, { status: 403 });
    const parsed = await readJsonBody<{ tenant?: unknown; sharedScope?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { tenant: target, sharedScope } = parsed.value;
    if (!isValidTenant(target)) return Response.json({ error: "invalid_request" }, { status: 400 });
    const current = state.members[target];
    if (!current || current.status !== "active") {
      return Response.json({ error: "member_unknown" }, { status: 404 });
    }
    if (current.role === "owner") return Response.json({ error: "owner_not_scoped" }, { status: 409 });
    const checked = checkScope(sharedScope);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const members = { ...state.members, [target]: bumpAuthz({ ...current, sharedScope: checked.scope }) };
    const grantRevision = await this.bumpGrants(members, { ...state.grants }, state.grantRevision);
    return Response.json({ membership: members[target], grantRevision });
  }

  private async activeMember(request: Request): Promise<{
    company: CompanyRecordJSON;
    tenant: string;
    member: MemberRecordJSON;
    members: Record<string, MemberRecordJSON>;
    grants: Grant[];
    grantRevision: number;
  } | Response> {
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const tenant = this.caller(request);
    const member = tenant ? state.members[tenant] : undefined;
    if (!member || member.status !== "active") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    return {
      company: state.company,
      tenant: tenant!,
      member,
      members: state.members,
      grants: state.grants[tenant!] ?? [],
      grantRevision: state.grantRevision,
    };
  }

  /// Lists the published shared runs the caller may read, a cursor page at a
  /// time in first-published order. The worker only routes here while
  /// `officeSharing` is on. Reading needs no grant, since viewing is the
  /// floor of every access, but it does need an active membership and, for
  /// anyone but an owner, each run in the caller's shared scope (`inScope`),
  /// re-checked on every read so a narrowed scope or a revocation holds from
  /// the very next one. The total counts only what the caller may see, so a
  /// page says nothing about the runs outside their scope.
  private async listShared(url: URL, request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (!Number.isInteger(cursor) || cursor < 0) {
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    }
    const index = (await this.ctx.storage.get<string[]>(SHARED_INDEX_KEY)) ?? [];
    const visible = index.filter((runId) => inScope(auth.member, runId));
    const page = visible.slice(cursor, cursor + limit);
    const stored =
      page.length > 0
        ? await this.ctx.storage.get<StoredSharedRun>(page.map(sharedKey))
        : new Map<string, StoredSharedRun>();
    const items = page
      .map((runId) => stored.get(sharedKey(runId)))
      .filter((item): item is StoredSharedRun => item !== undefined);
    const next = cursor + page.length < visible.length ? String(cursor + page.length) : null;
    return Response.json({ items, nextCursor: next, total: visible.length });
  }

  /// Reads one published shared run under the same rules as the list. A run
  /// outside the caller's scope answers exactly like one that was never
  /// published (`notShared`), and the scope is checked before storage is
  /// read, so the answer cannot even depend on whether the record exists.
  private async readShared(url: URL, request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const runId = url.searchParams.get("run") ?? "";
    if (!inScope(auth.member, runId)) return notShared();
    const item = await this.ctx.storage.get<StoredSharedRun>(sharedKey(runId));
    return item ? Response.json({ item }) : notShared();
  }

  /// Publishing and withdrawing a run's shared copy are the owner's act, so
  /// the caller must be an active owner holding `company.configure`. The
  /// operator key never qualifies: `caller` reads it as nobody, so it can
  /// neither publish nor read shared work. Returns the refusal, or null.
  private async sharedPublisher(request: Request): Promise<Response | null> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    if (!hasGrant(auth.grants, GRANTS.COMPANY_CONFIGURE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.COMPANY_CONFIGURE }, { status: 403 });
    }
    if (auth.member.role !== "owner") return Response.json({ error: "owner_required" }, { status: 403 });
    return null;
  }

  /// Publishes one run's shared record, or replaces it (Update shared copy).
  /// The body passes `checkSharedRecord` whole or is refused whole, and what
  /// is stored is rebuilt from the checked fields, so nothing outside the
  /// schema can be stored by riding along. The record and the index change
  /// in one transaction, so a list never names a record that is not there.
  /// A replacement keeps the first `publishedAt`. Nothing here logs the body.
  private async publishShared(url: URL, request: Request): Promise<Response> {
    const refused = await this.sharedPublisher(request);
    if (refused) return refused;
    const runId = url.searchParams.get("run") ?? "";
    if (!isValidSharedItemId(runId)) return Response.json({ error: "invalid_shared_item_id" }, { status: 400 });
    const parsed = await readJsonBody<unknown>(request, SHARED_RECORD_MAX_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const checked = checkSharedRecord(parsed.value, runId);
    if (!checked.ok) return Response.json({ error: checked.error, field: checked.field }, { status: 400 });
    return this.ctx.storage.transaction(async (txn) => {
      const index = (await txn.get<string[]>(SHARED_INDEX_KEY)) ?? [];
      const listed = index.includes(runId);
      if (!listed && index.length >= MAX_SHARED_ITEMS) {
        return Response.json({ error: "shared_items_full", limit: MAX_SHARED_ITEMS }, { status: 409 });
      }
      const existing = await txn.get<StoredSharedRun>(sharedKey(runId));
      const now = new Date().toISOString();
      const item: StoredSharedRun = { ...checked.record, publishedAt: existing?.publishedAt ?? now, updatedAt: now };
      await txn.put(sharedKey(runId), item);
      if (!listed) await txn.put(SHARED_INDEX_KEY, [...index, runId]);
      return Response.json({ item });
    });
  }

  /// Withdraws a run's shared copy: the record is deleted at once, not
  /// hidden, and its id leaves the index in the same transaction, so the
  /// next read by anyone answers `not_shared`. Withdrawing a run that is not
  /// published succeeds too (`deleted: false`), so a retry after a lost reply
  /// is safe. Members' scopes are left as they are: a scope says what a
  /// person may see, and changing it is the owner's separate act on
  /// `PATCH /scope`. The run's comments are left too: the sharing doc puts
  /// comments under the retention rules still to be decided, not under
  /// Withdraw, and while the run is not published nobody can read or add to
  /// them (`listComments`, `addComment`).
  private async withdrawShared(url: URL, request: Request): Promise<Response> {
    const refused = await this.sharedPublisher(request);
    if (refused) return refused;
    const runId = url.searchParams.get("run") ?? "";
    if (!isValidSharedItemId(runId)) return Response.json({ error: "invalid_shared_item_id" }, { status: 400 });
    return this.ctx.storage.transaction(async (txn) => {
      const index = (await txn.get<string[]>(SHARED_INDEX_KEY)) ?? [];
      const deleted = await txn.delete(sharedKey(runId));
      if (index.includes(runId)) await txn.put(SHARED_INDEX_KEY, index.filter((id) => id !== runId));
      return Response.json({ withdrawn: runId, deleted });
    });
  }

  /// Adds one comment to a shared run. The worker only routes here while
  /// `officeSharing` is on. The caller must be an active member holding
  /// `comments.write`, checked before anything about the run, so that refusal
  /// says nothing about which runs exist. The run must then be in the
  /// caller's shared scope and published: one outside the scope, never
  /// published or withdrawn answers `notShared`, the same bytes a read gets.
  /// A revoked member is refused with the plain `forbidden` by
  /// `activeMember`, and re-seating them restores no grant.
  ///
  /// The body is the text alone (`checkComment`); who wrote it is stamped
  /// from the verified session as a person. The write touches only this
  /// run's comments and their count, in one transaction, never a task, a
  /// proposal, an approval or the grant revision, so a comment neither starts
  /// work nor unsettles an approval already bound to that revision. Nothing
  /// here logs the text.
  private async addComment(url: URL, request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    if (!hasGrant(auth.grants, GRANTS.COMMENTS_WRITE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.COMMENTS_WRITE }, { status: 403 });
    }
    const runId = url.searchParams.get("run") ?? "";
    if (!inScope(auth.member, runId)) return notShared();
    const parsed = await readJsonBody<unknown>(request, COMMENT_MAX_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const checked = checkComment(parsed.value);
    if (!checked.ok) return Response.json({ error: checked.error, field: checked.field }, { status: 400 });
    return this.ctx.storage.transaction(async (txn) => {
      if (!(await txn.get<StoredSharedRun>(sharedKey(runId)))) return notShared();
      const count = (await txn.get<number>(commentCountKey(runId))) ?? 0;
      if (count >= MAX_COMMENTS_PER_RUN) {
        return Response.json({ error: "comments_full", limit: MAX_COMMENTS_PER_RUN }, { status: 409 });
      }
      const comment: StoredComment = {
        id: crypto.randomUUID(),
        runId,
        authorKind: "person",
        memberId: auth.tenant,
        text: checked.text,
        createdAt: new Date().toISOString(),
      };
      await txn.put(commentKey(runId, count + 1), comment);
      await txn.put(commentCountKey(runId), count + 1);
      return Response.json({ comment });
    });
  }

  /// Lists one shared run's comments, oldest first, a cursor page at a time.
  /// Reading needs no grant, like reading the run, but it does need an
  /// active membership and the run in the caller's scope and published,
  /// re-checked on every read, so a narrowed scope, a withdrawal or a
  /// revocation holds from the very next one. The scope is checked before
  /// storage is read, so an out-of-scope answer cannot depend on whether the
  /// run or its comments exist.
  private async listComments(url: URL, request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const runId = url.searchParams.get("run") ?? "";
    if (!inScope(auth.member, runId)) return notShared();
    const limit = Number(url.searchParams.get("limit") ?? "20");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    if (!Number.isInteger(cursor) || cursor < 0) {
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    }
    if (!(await this.ctx.storage.get<StoredSharedRun>(sharedKey(runId)))) return notShared();
    const total = (await this.ctx.storage.get<number>(commentCountKey(runId))) ?? 0;
    const end = Math.min(total, cursor + limit);
    const keys: string[] = [];
    for (let seq = cursor + 1; seq <= end; seq++) keys.push(commentKey(runId, seq));
    const stored = keys.length > 0 ? await this.ctx.storage.get<StoredComment>(keys) : new Map<string, StoredComment>();
    const comments = keys
      .map((key) => stored.get(key))
      .filter((comment): comment is StoredComment => comment !== undefined);
    return Response.json({ comments, nextCursor: end < total ? String(end) : null, total });
  }

  /// Indexes a company task for the company-scoped list. Synchronous by
  /// design, like the tenant task index: a task the index misses is a task
  /// the list cannot prove complete.
  private async indexTask(request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const parsed = await readJsonBody<{ taskId?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { taskId } = parsed.value;
    if (typeof taskId !== "string" || !taskId || taskId.length > 256) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const key = "company-tasks";
    const ids = (await this.ctx.storage.get<string[]>(key)) ?? [];
    if (!ids.includes(taskId)) {
      await this.ctx.storage.put(key, [...ids, taskId]);
      return Response.json({ indexed: true, total: ids.length + 1 });
    }
    return Response.json({ indexed: true, total: ids.length });
  }

  /// Company-scoped cursor page over the task index. The index is already
  /// company-scoped, so no further filtering happens here; the worker
  /// resolves each id to its task document for members. The total is the
  /// index size — a snapshot count, never a claim about task states.
  private async readTaskIndex(url: URL, request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const limitRaw = url.searchParams.get("limit") ?? "20";
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    const cursorRaw = url.searchParams.get("cursor") ?? "0";
    const cursor = Number(cursorRaw);
    if (!Number.isInteger(cursor) || cursor < 0) {
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    }
    const ids = (await this.ctx.storage.get<string[]>("company-tasks")) ?? [];
    const page = ids.slice(cursor, cursor + limit);
    const next = cursor + page.length < ids.length ? String(cursor + page.length) : null;
    return Response.json({ taskIds: page, nextCursor: next, total: ids.length });
  }

  /// Removes task ids from the company index after a tenant wipe deletes the
  /// tasks themselves. Worker-internal (`x-authority`): the worker verified
  /// the tenant session for the wipe before calling. Idempotent — absent ids
  /// are simply already gone — so a retried wipe prunes cleanly. Without
  /// this, wiped tasks would linger in company lists as unavailable stubs.
  private async pruneTaskIndex(request: Request): Promise<Response> {
    if (request.headers.get("x-authority") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ taskIds?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { taskIds } = parsed.value;
    if (!Array.isArray(taskIds) || !taskIds.every((id) => typeof id === "string")) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const ids = (await this.ctx.storage.get<string[]>("company-tasks")) ?? [];
    const doomed = new Set(taskIds as string[]);
    const kept = ids.filter((id) => !doomed.has(id));
    if (kept.length !== ids.length) {
      await this.ctx.storage.put("company-tasks", kept);
    }
    return Response.json({ pruned: ids.length - kept.length });
  }

  /// Replaces the connection allowlist: the connection ids this company's
  /// exact actions may use. Requires members.manage. `null` lifts the
  /// restriction back to unrestricted; an empty array denies everything.
  /// Deliberately outside the grant revision: the list is a live policy
  /// re-checked at propose, decide, and dispatch time, so tightening it
  /// takes effect without invalidating unrelated approvals — and refusals
  /// name the connection, not a stale revision.
  private async setAllowedConnections(request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    if (!hasGrant(auth.grants, GRANTS.MEMBERS_MANAGE)) {
      return Response.json({ error: "grant_required", grant: GRANTS.MEMBERS_MANAGE }, { status: 403 });
    }
    const parsed = await readJsonBody<{ connectionIds?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { connectionIds } = parsed.value;
    if (connectionIds === null || connectionIds === undefined) {
      await this.ctx.storage.delete("allowedConnections");
      return Response.json({ allowedConnections: null });
    }
    if (
      !Array.isArray(connectionIds) ||
      connectionIds.length > 100 ||
      !connectionIds.every(
        (id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256,
      )
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const allowed = [...new Set(connectionIds)];
    await this.ctx.storage.put("allowedConnections", allowed);
    return Response.json({ allowedConnections: allowed });
  }

  /// Exports the company configuration for reuse. Deliberately narrow: the
  /// profile plus the distinct active roles. No tenant ids, no grants, no
  /// secrets, no membership rows — an import carries structure only, and
  /// authority is always re-granted by a human afterwards.
  private async exportTemplate(request: Request): Promise<Response> {
    const auth = await this.activeMember(request);
    if (auth instanceof Response) return auth;
    const roles = [...new Set(Object.values(auth.members).filter((m) => m.status === "active").map((m) => m.role))].sort();
    return Response.json({
      version: 1,
      company: { name: auth.company.name, timezone: auth.company.timezone },
      roles,
    });
  }

  /// Creates a company from a template. Like create, the worker asserts the
  /// account entitlement first (`x-entitled`); the creator becomes owner with
  /// full grants, and nothing else is restored — members and grants are
  /// always re-established by reviewed human action in the new company.
  private async importTemplate(request: Request): Promise<Response> {
    if (request.headers.get("x-entitled") !== "1") {
      return Response.json({ error: "company_create_forbidden" }, { status: 403 });
    }
    const tenant = request.headers.get("x-tenant") ?? "";
    if (!isValidTenant(tenant)) return Response.json({ error: "tenant_required" }, { status: 400 });
    const parsed = await readJsonBody<{ template?: unknown; name?: unknown; id?: unknown }>(
      request,
      MAX_BODY_BYTES,
    );
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { template, name, id } = parsed.value as {
      template?: { version?: unknown; company?: { name?: unknown; timezone?: unknown }; roles?: unknown };
      name?: unknown;
      id?: unknown;
    };
    if (!template || template.version !== 1 || !template.company) {
      return Response.json({ error: "invalid_template" }, { status: 400 });
    }
    const roles = Array.isArray(template.roles) ? template.roles : [];
    if (!roles.every(isValidRole)) return Response.json({ error: "invalid_template" }, { status: 400 });
    const companyId = id ?? crypto.randomUUID();
    if (companyId === "mine" || !isValidCompanyId(companyId)) {
      return Response.json({ error: "invalid_company_id" }, { status: 400 });
    }
    const companyName =
      name === undefined ? template.company.name : name;
    if (typeof companyName !== "string" || !companyName.trim() || companyName.length > 120) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    let timezone = "UTC";
    if (template.company.timezone !== undefined) {
      if (
        typeof template.company.timezone !== "string" ||
        !template.company.timezone ||
        template.company.timezone.length > 64
      ) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      timezone = template.company.timezone;
    }
    // Import targets a fresh object address (the worker addresses by the new
    // id), so an existing record here means a re-imported id colliding with a
    // live company: refuse rather than merge.
    const existing = await this.ctx.storage.get<CompanyRecordJSON>("company");
    if (existing) return Response.json({ error: "company_exists" }, { status: 409 });
    const now = new Date().toISOString();
    const company: CompanyRecordJSON = {
      id: companyId,
      name: companyName.trim(),
      timezone,
      ownerTenant: tenant,
      policyVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const members: Record<string, MemberRecordJSON> = {
      [tenant]: { role: "owner", status: "active", authVersion: 1, sharedScope: null },
    };
    const grants: Record<string, Grant[]> = { [tenant]: [...ROLE_CEILING.owner] };
    // Same atomicity as create: a re-imported id colliding with a live
    // company refuses rather than merging, exactly once.
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<CompanyRecordJSON>("company");
      if (existing) return Response.json({ error: "company_exists" }, { status: 409 });
      await txn.put("company", company);
      await txn.put("members", members);
      await txn.put("grants", grants);
      await txn.put("grantRevision", 1);
      return Response.json({ company, membership: members[tenant], grants: grants[tenant], grantRevision: 1 });
    });
  }
  /// Pre-dispatch authority check for company tasks, called by the worker
  /// (never by clients) after it reads the authoritative proposal from the
  /// task ledger. Verifies the approval was granted at the current revision,
  /// the approver is still an entitled member, and the target revision the
  /// approval bound still matches what dispatch would act on. The
  /// `x-authority` header marks worker-internal calls, like `x-wipe` and
  /// `x-admin` elsewhere: only the worker can reach this object.
  private async dispatchCheck(request: Request): Promise<Response> {
    if (request.headers.get("x-authority") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const state = await this.load();
    if (!state.company) return Response.json({ error: "company_unknown" }, { status: 404 });
    const parsed = await readJsonBody<{
      grantRevision?: unknown;
      approverTenant?: unknown;
      connectionId?: unknown;
      expectedTargetRevision?: unknown;
      currentTargetRevision?: unknown;
    }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (!Number.isInteger(body.grantRevision)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (body.grantRevision !== state.grantRevision) {
      return Response.json(
        { error: "grant_changed", current: state.grantRevision },
        { status: 409 },
      );
    }
    const approver = typeof body.approverTenant === "string" ? body.approverTenant : "";
    const member = state.members[approver];
    if (!approver || !member || member.status !== "active") {
      return Response.json({ error: "approver_not_member" }, { status: 403 });
    }
    if (!hasGrant(state.grants[approver] ?? [], GRANTS.APPROVALS_DECIDE)) {
      return Response.json(
        { error: "approval_grant_required", grant: GRANTS.APPROVALS_DECIDE },
        { status: 403 },
      );
    }
    // Live connection policy: when the company restricts which connections
    // its actions may use, the proposal's connection must still be allowed.
    // Checked live (not bound to the revision) so tightening the list takes
    // effect on already-approved proposals too.
    if (state.allowedConnections !== undefined) {
      if (typeof body.connectionId !== "string" || !state.allowedConnections.includes(body.connectionId)) {
        return Response.json({ error: "connection_not_allowed" }, { status: 403 });
      }
    }
    // The concurrency precondition: when the approval bound a target
    // revision, dispatch must name the same one. The worker reads the bound
    // value from the authoritative proposal, so equality here means the
    // target did not move under the approval. Targets without revision
    // support carry no bound value and skip this check openly.
    if (body.expectedTargetRevision !== undefined) {
      if (typeof body.expectedTargetRevision !== "string" || typeof body.currentTargetRevision !== "string") {
        return Response.json({ error: "target_revision_required" }, { status: 400 });
      }
      if (body.currentTargetRevision !== body.expectedTargetRevision) {
        return Response.json({ error: "target_changed" }, { status: 409 });
      }
    }
    return Response.json({ ok: true, grantRevision: state.grantRevision });
  }
}
