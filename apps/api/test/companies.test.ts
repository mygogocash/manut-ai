import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";

import { describe, expect, it } from "vitest";
import { checkGrants, isValidCompanyId, isValidRole } from "../src/companies";

// Company authority tests. Sessions are minted through the real Apple
// exchange with the committed test JWKS; each user is an Apple subject
// ("alice", "bob", ...), and tenants here are those subjects.

const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = "test-key";
const NONCE = "company-nonce";

let counter = 9000;
const freshCompany = () => `co-${Date.now()}-${counter++}`;

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const strip = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const cut = part.slice(i);
    return cut[0]! >= 128 ? new Uint8Array([0, ...cut]) : cut;
  };
  const rEnc = strip(r);
  const sEnc = strip(s);
  const out = new Uint8Array(2 + 2 + rEnc.length + 2 + sEnc.length);
  out[0] = 0x30;
  out[1] = out.length - 2;
  out[2] = 0x02;
  out[3] = rEnc.length;
  out.set(rEnc, 4);
  out[4 + rEnc.length] = 0x02;
  out[5 + rEnc.length] = sEnc.length;
  out.set(sEnc, 6 + rEnc.length);
  return out;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Session = { token: string; csrf: string };

async function sessionFor(sub: string, device: string): Promise<Session> {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "test-client",
      sub,
      iat: now - 60,
      exp: now + 600,
      nonce: await sha256Hex(NONCE),
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const half = signature.length / 2;
  const token = `${header}.${payload}.${base64Url(derEncode(signature.slice(0, half), signature.slice(half)))}`;
  const response = await SELF.fetch("https://test/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken: token, nonce: NONCE, deviceId: device }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { accessToken: string; csrf: string };
  expect(typeof session.csrf).toBe("string");
  return { token: session.accessToken, csrf: session.csrf };
}

function op(method: string, path: string, body?: unknown) {
  const fetch = path.startsWith("/v1/admin/") ? adminFetch : SELF.fetch.bind(SELF);
  return fetch(`https://test${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/// Authenticated company call. Writes carry the session CSRF unless
/// `csrf: null` is passed to prove they fail closed without it.
function co(
  session: Session,
  method: string,
  path: string,
  body?: unknown,
  opts: { csrf?: string | null; origin?: string } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${session.token}`,
  };
  const csrf = opts.csrf === undefined ? session.csrf : opts.csrf;
  if (csrf) headers["x-csrf"] = csrf;
  if (opts.origin) headers["origin"] = opts.origin;
  return SELF.fetch(`https://test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const T = (sub: string) => `apple:${sub}`;

async function entitle(sub: string, canCreateCompany: boolean) {
  const response = await op("PUT", "/v1/admin/entitlements", { tenant: T(sub), canCreateCompany });
  expect(response.status).toBe(200);
  return response;
}

async function createCompany(session: Session, name: string, id?: string) {
  return co(session, "POST", "/v1/companies", { ...(id ? { id } : {}), name, timezone: "Asia/Bangkok" });
}

describe("company creation entitlement", () => {
  it("creation without the account entitlement is forbidden", async () => {
    const alice = await sessionFor("alice-noent", "dev-1");
    const response = await createCompany(alice, "Noent Co");
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toEqual({ error: "company_create_forbidden" });
  });

  it("entitlement defaults to false and sessions cannot grant it", async () => {
    const read = await op("GET", "/v1/admin/entitlements?tenant=apple:alice-default");
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ canCreateCompany: false });
    const alice = await sessionFor("alice-default", "dev-1");
    const attempt = await co(alice, "PUT", "/v1/admin/entitlements", {
      tenant: "alice-default",
      canCreateCompany: true,
    });
    expect(attempt.status).toBe(403);
  });

  it("an entitled creator becomes owner with full grants", async () => {
    await entitle("alice-owner", true);
    const alice = await sessionFor("alice-owner", "dev-1");
    const id = freshCompany();
    const response = await createCompany(alice, "Owner Co", id);
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      company: { id: string; name: string; policyVersion: number };
      membership: { role: string };
      grants: string[];
      grantRevision: number;
    };
    expect(created.company.id).toBe(id);
    expect(created.company.policyVersion).toBe(1);
    expect(created.membership.role).toBe("owner");
    expect(created.grants).toContain("company.delete");
    expect(created.grants).toContain("members.manage");
    expect(created.grantRevision).toBe(1);
  });

  it("duplicate company creation is rejected", async () => {
    await entitle("alice-dup", true);
    const alice = await sessionFor("alice-dup", "dev-1");
    const id = freshCompany();
    expect((await createCompany(alice, "Dup Co", id)).status).toBe(200);
    const again = await createCompany(alice, "Dup Co", id);
    expect(again.status).toBe(409);
  });

  it("concurrent creates with the same id produce exactly one company", async () => {
    await entitle("alice-race", true);
    const alice = await sessionFor("alice-race", "dev-1");
    const id = freshCompany();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => createCompany(alice, "Race Co", id)),
    );
    const ok = attempts.filter((r) => r.status === 200).length;
    const conflicts = attempts.filter((r) => r.status === 409).length;
    expect({ ok, conflicts }).toEqual({ ok: 1, conflicts: 9 });
    const winner = attempts.find((r) => r.status === 200)!;
    expect(((await winner.json()) as { company: { id: string } }).company.id).toBe(id);
  });

  it("reserved and malformed company ids are rejected", async () => {
    await entitle("alice-ids", true);
    const alice = await sessionFor("alice-ids", "dev-1");
    for (const bad of ["mine", "../x", "a/b", "a?b=c", ""]) {
      const response = await co(alice, "POST", "/v1/companies", {
        id: bad,
        name: "Bad Id Co",
        timezone: "Asia/Bangkok",
      });
      expect(response.status).toBe(400);
    }
  });
});

describe("company isolation", () => {
  it("two users and two companies stay isolated with no fallback", async () => {
    await entitle("alice-iso", true);
    await entitle("bob-iso", true);
    const alice = await sessionFor("alice-iso", "dev-1");
    const bob = await sessionFor("bob-iso", "dev-1");
    const idA = freshCompany();
    const idB = freshCompany();
    expect((await createCompany(alice, "Alice Co", idA)).status).toBe(200);
    expect((await createCompany(bob, "Bob Co", idB)).status).toBe(200);
    // Bob cannot read Alice's company, and learns nothing beyond the refusal.
    const cross = await co(bob, "GET", `/v1/companies/${idA}`);
    expect(cross.status).toBe(403);
    expect(JSON.stringify(await cross.json())).not.toContain("Alice Co");
    // An unknown id is unknown, never another company.
    const unknown = await co(alice, "GET", "/v1/companies/co-never-created-xyz");
    expect(unknown.status).toBe(404);
    // Writes cross the same boundary.
    const patch = await co(bob, "PATCH", `/v1/companies/${idA}`, { name: "Hijacked" });
    expect(patch.status).toBe(403);
  });

  it("mine lists only the caller's memberships", async () => {
    await entitle("alice-mine", true);
    await entitle("bob-mine", true);
    const alice = await sessionFor("alice-mine", "dev-1");
    const bob = await sessionFor("bob-mine", "dev-1");
    const idA = freshCompany();
    expect((await createCompany(alice, "Alice Mine Co", idA)).status).toBe(200);
    const mineA = (await (await co(alice, "GET", "/v1/companies/mine")).json()) as {
      memberships: { companyId: string; name?: string }[];
    };
    expect(mineA.memberships.some((m) => m.companyId === idA && m.name === "Alice Mine Co")).toBe(true);
    const mineB = (await (await co(bob, "GET", "/v1/companies/mine")).json()) as {
      memberships: { companyId: string }[];
    };
    expect(mineB.memberships.some((m) => m.companyId === idA)).toBe(false);
  });
});

describe("roles, ceilings, and fail-closed grants", () => {
  async function companyWithOwner(user: string, name: string) {
    await entitle(user, true);
    const owner = await sessionFor(user, "dev-1");
    const id = freshCompany();
    expect((await createCompany(owner, name, id)).status).toBe(200);
    return { owner, id };
  }

  async function addMember(owner: Session, id: string, sub: string, role: string) {
    return co(owner, "POST", `/v1/companies/${id}/members`, { tenant: T(sub), role });
  }

  async function setGrants(owner: Session, id: string, sub: string, grants: string[]) {
    return co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T(sub), grants });
  }

  it("new members are read-only until explicitly granted, even admins", async () => {
    const { owner, id } = await companyWithOwner("alice-fc", "Failclosed Co");
    expect((await addMember(owner, id, "bob-fc", "admin")).status).toBe(200);
    const bob = await sessionFor("bob-fc", "dev-1");
    expect((await co(bob, "GET", `/v1/companies/${id}`)).status).toBe(200);
    const configure = await co(bob, "PATCH", `/v1/companies/${id}`, { name: "Changed" });
    expect(configure.status).toBe(403);
    expect(((await configure.json()) as { error: string }).error).toBe("grant_required");
  });

  it("operator creates tasks grant but cannot decide approvals or configure", async () => {
    const { owner, id } = await companyWithOwner("alice-op", "Operator Co");
    expect((await addMember(owner, id, "bob-op", "operator")).status).toBe(200);
    expect((await setGrants(owner, id, "bob-op", ["tasks.create"])).status).toBe(200);
    const bob = await sessionFor("bob-op", "dev-1");
    const read = await co(bob, "GET", `/v1/companies/${id}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { grants: string[] }).grants).toEqual(["tasks.create"]);
    expect((await co(bob, "PATCH", `/v1/companies/${id}`, { name: "Changed" })).status).toBe(403);
    expect((await setGrants(bob, id, "bob-op", ["tasks.create"])).status).toBe(403);
  });

  it("approver decides but cannot create tasks or configure", async () => {
    const { owner, id } = await companyWithOwner("alice-ap", "Approver Co");
    expect((await addMember(owner, id, "bob-ap", "approver")).status).toBe(200);
    expect((await setGrants(owner, id, "bob-ap", ["approvals.decide"])).status).toBe(200);
    const bob = await sessionFor("bob-ap", "dev-1");
    expect((await co(bob, "PATCH", `/v1/companies/${id}`, { name: "Changed" })).status).toBe(403);
    expect((await addMember(bob, id, "carol-ap", "viewer")).status).toBe(403);
  });

  it("excessive, unknown, and duplicate advertised grants are rejected", async () => {
    const { owner, id } = await companyWithOwner("alice-ceil", "Ceiling Co");
    expect((await addMember(owner, id, "bob-ceil", "operator")).status).toBe(200);
    const excessive = await setGrants(owner, id, "bob-ceil", ["tasks.create", "agents.configure"]);
    expect(excessive.status).toBe(403);
    expect(((await excessive.json()) as { error: string }).error).toBe("grant_exceeds_ceiling");
    const unknown = await setGrants(owner, id, "bob-ceil", ["tasks.create", "platform.superadmin"]);
    expect(unknown.status).toBe(403);
    const duplicate = await setGrants(owner, id, "bob-ceil", ["tasks.create", "tasks.create"]);
    expect(duplicate.status).toBe(403);
    // Nothing was stored: the member still holds no grants.
    const bob = await sessionFor("bob-ceil", "dev-1");
    expect((await co(bob, "PATCH", `/v1/companies/${id}`, { name: "Changed" })).status).toBe(403);
  });

  it("duplicate memberships and unknown roles are rejected", async () => {
    const { owner, id } = await companyWithOwner("alice-dupm", "Dupmember Co");
    expect((await addMember(owner, id, "bob-dupm", "viewer")).status).toBe(200);
    expect((await addMember(owner, id, "bob-dupm", "viewer")).status).toBe(409);
    expect((await addMember(owner, id, "carol-dupm", "superadmin")).status).toBe(400);
  });

  it("only an owner can seat another owner", async () => {
    const { owner, id } = await companyWithOwner("alice-own", "Owneronly Co");
    expect((await addMember(owner, id, "bob-own", "admin")).status).toBe(200);
    expect((await setGrants(owner, id, "bob-own", ["members.manage"])).status).toBe(200);
    const bob = await sessionFor("bob-own", "dev-1");
    expect((await addMember(bob, id, "carol-own", "owner")).status).toBe(403);
    expect((await addMember(owner, id, "carol-own", "owner")).status).toBe(200);
  });

  it("the last active owner cannot be revoked or demoted", async () => {
    const { owner, id } = await companyWithOwner("alice-last", "Lastowner Co");
    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("alice-last") })).status).toBe(409);
    expect(
      (await co(owner, "PATCH", `/v1/companies/${id}/members`, { tenant: T("alice-last"), role: "admin" })).status,
    ).toBe(409);
    expect((await addMember(owner, id, "bob-last", "owner")).status).toBe(200);
    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("alice-last") })).status).toBe(200);
  });

  it("revocation blocks reads and clears grants", async () => {
    const { owner, id } = await companyWithOwner("alice-rev", "Revoke Co");
    expect((await addMember(owner, id, "bob-rev", "operator")).status).toBe(200);
    expect((await setGrants(owner, id, "bob-rev", ["tasks.create"])).status).toBe(200);
    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("bob-rev") })).status).toBe(200);
    const bob = await sessionFor("bob-rev", "dev-1");
    expect((await co(bob, "GET", `/v1/companies/${id}`)).status).toBe(403);
    const mine = (await (await co(bob, "GET", "/v1/companies/mine")).json()) as {
      memberships: { companyId: string }[];
    };
    expect(mine.memberships.some((m) => m.companyId === id)).toBe(false);
    const members = (await (
      await co(owner, "GET", `/v1/companies/${id}/members`)
    ).json()) as { grants: Record<string, string[]> };
    expect(members.grants[T("bob-rev")]).toEqual([]);
  });

  it("grant changes bump the grant revision; configure bumps policy", async () => {
    const { owner, id } = await companyWithOwner("alice-rev2", "Revision Co");
    expect((await addMember(owner, id, "bob-rev2", "viewer")).status).toBe(200);
    const before = (await (await co(owner, "GET", `/v1/companies/${id}`)).json()) as {
      grantRevision: number;
    };
    const granted = await setGrants(owner, id, "bob-rev2", []);
    expect(granted.status).toBe(200);
    expect(((await granted.json()) as { grantRevision: number }).grantRevision).toBe(before.grantRevision + 1);
    const configured = await co(owner, "PATCH", `/v1/companies/${id}`, { name: "Revision Co 2" });
    expect(configured.status).toBe(200);
    expect(((await configured.json()) as { company: { policyVersion: number } }).company.policyVersion).toBe(2);
  });

  it("deleting a company needs the owner-only grant", async () => {
    const { owner, id } = await companyWithOwner("alice-del", "Delete Co");
    expect((await addMember(owner, id, "bob-del", "admin")).status).toBe(200);
    expect(
      (await setGrants(owner, id, "bob-del", [
        "agents.configure",
        "tasks.create",
        "approvals.decide",
        "members.manage",
        "company.configure",
        "audit.read",
      ])).status,
    ).toBe(200);
    const bob = await sessionFor("bob-del", "dev-1");
    expect((await co(bob, "DELETE", `/v1/companies/${id}`)).status).toBe(403);
    const deleted = await co(owner, "DELETE", `/v1/companies/${id}`);
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { deleted: string; members: string[]; indexFailed: string[] };
    expect(body.deleted).toBe(id);
    expect(body.indexFailed).toEqual([]);
    expect((await co(owner, "GET", `/v1/companies/${id}`)).status).toBe(404);
    const mine = (await (await co(owner, "GET", "/v1/companies/mine")).json()) as {
      memberships: { companyId: string }[];
    };
    expect(mine.memberships.some((m) => m.companyId === id)).toBe(false);
  });
});

describe("company write guards", () => {
  it("writes without CSRF fail closed, and a wrong token is refused", async () => {
    await entitle("alice-csrf", true);
    const alice = await sessionFor("alice-csrf", "dev-1");
    const id = freshCompany();
    expect((await createCompany(alice, "Csrf Co", id)).status).toBe(200);
    const missing = await co(alice, "PATCH", `/v1/companies/${id}`, { name: "Changed" }, { csrf: null });
    expect(missing.status).toBe(403);
    const wrong = await co(alice, "PATCH", `/v1/companies/${id}`, { name: "Changed" }, { csrf: "wrong" });
    expect(wrong.status).toBe(403);
    expect((await co(alice, "GET", `/v1/companies/${id}`)).status).toBe(200);
  });

  it("cross-origin browser writes are refused", async () => {
    await entitle("alice-origin", true);
    const alice = await sessionFor("alice-origin", "dev-1");
    const id = freshCompany();
    expect((await createCompany(alice, "Origin Co", id)).status).toBe(200);
    const cross = await co(alice, "PATCH", `/v1/companies/${id}`, { name: "Changed" }, { origin: "https://evil.test" });
    expect(cross.status).toBe(403);
    const same = await co(alice, "PATCH", `/v1/companies/${id}`, { name: "Origin Co 2" }, { origin: "https://test" });
    expect(same.status).toBe(200);
  });
});

describe("tenant wipe clears company-console state", () => {
  it("wipe removes the entitlement and the membership index", async () => {
    await entitle("alice-wipe", true);
    const alice = await sessionFor("alice-wipe", "dev-1");
    const id = freshCompany();
    expect((await createCompany(alice, "Wipe Co", id)).status).toBe(200);
    const wipe = await SELF.fetch("https://test/v1/tenant/data", {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(wipe.status).toBe(200);
    const entitlement = await op("GET", "/v1/admin/entitlements?tenant=apple:alice-wipe");
    expect(await entitlement.json()).toEqual({ canCreateCompany: false });
    const fresh = await sessionFor("alice-wipe", "dev-2");
    const mine = (await (await co(fresh, "GET", "/v1/companies/mine")).json()) as {
      memberships: unknown[];
    };
    expect(mine.memberships).toEqual([]);
  });
});

describe("company domain rules", () => {
  it("role ceilings hold and fail closed", () => {
    expect(checkGrants("viewer", []).ok).toBe(true);
    expect(checkGrants("operator", ["tasks.create"]).ok).toBe(true);
    expect(checkGrants("operator", ["agents.configure"]).ok).toBe(false);
    expect(checkGrants("owner", ["company.delete"]).ok).toBe(true);
    expect(checkGrants("admin", ["company.delete"]).ok).toBe(false);
    expect(checkGrants("approver", ["approvals.decide"]).ok).toBe(true);
    expect(checkGrants("auditor", ["audit.read"]).ok).toBe(true);
    expect(checkGrants("viewer", ["audit.read"]).ok).toBe(false);
  });

  it("sharing grants follow the OFC-21 matrix (ofc21-cloud-grants-and-scopes)", () => {
    // No invitation issues tasks.create: a Contributor asks for work, only the owner
    // starts it. The ceiling keeps tasks.create for existing members' behavior.
    expect(checkGrants("operator", ["tasks.create", "comments.write", "work.request"]).ok).toBe(true);
    expect(checkGrants("approver", ["approvals.decide", "comments.write"]).ok).toBe(true);
    expect(checkGrants("owner", ["comments.write", "work.request"]).ok).toBe(true);
    expect(checkGrants("admin", ["comments.write", "work.request"]).ok).toBe(true);
    // Above ceiling, refused rather than clamped.
    expect(checkGrants("viewer", ["comments.write"]).ok).toBe(false);
    expect(checkGrants("viewer", ["work.request"]).ok).toBe(false);
    expect(checkGrants("approver", ["work.request"]).ok).toBe(false);
    expect(checkGrants("operator", ["approvals.decide"]).ok).toBe(false);
    expect(checkGrants("auditor", ["comments.write"]).ok).toBe(false);
  });

  it("identifiers reject traversal and injection", () => {
    expect(isValidCompanyId("co-abc_123")).toBe(true);
    for (const bad of ["../x", "a/b", "a?b", "", ".", "a b", "x".repeat(65)]) {
      expect(isValidCompanyId(bad)).toBe(false);
    }
    expect(isValidRole("owner")).toBe(true);
    expect(isValidRole("superadmin")).toBe(false);
  });
});
