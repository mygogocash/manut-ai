import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_SHARED_SCOPE,
  bumpAuthz,
  checkScope,
  inScope,
  readMember,
  type MemberRecord,
} from "../src/companies";

// Member shared scope and the officeSharing flag (OFC-21, #460,
// docs/office-sharing.md). Sessions are minted through the real Apple
// exchange with the committed test JWKS, like companies.test.ts; each user is
// an Apple subject and tenants are `apple:<subject>`.

const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = "test-key";
const NONCE = "scope-nonce";

const RUN_A = "0b0c6a52-5f7e-4f5e-9d39-1c2b3a4d5e6f";
const RUN_B = "1c1d7b63-6a8f-4a6f-8e4a-2d3c4b5e6f70";
const RUN_C = "2d2e8c74-7b9a-4b7a-9f5b-3e4d5c6f7a81";

let counter = 0;
const freshCompany = () => `scope-${Date.now()}-${counter++}`;

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

async function sessionFor(sub: string): Promise<Session> {
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
    body: JSON.stringify({ provider: "apple", identityToken: token, nonce: NONCE, deviceId: "dev-1" }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as { accessToken: string; csrf: string };
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
function co(session: Session, method: string, path: string, body?: unknown, opts: { csrf?: string | null } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${session.token}`,
  };
  const csrf = opts.csrf === undefined ? session.csrf : opts.csrf;
  if (csrf) headers["x-csrf"] = csrf;
  return SELF.fetch(`https://test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const T = (sub: string) => `apple:${sub}`;

async function sharing(on: boolean) {
  expect((await op("PUT", "/v1/admin/flags", { officeSharing: on })).status).toBe(200);
}

async function companyWithOwner(sub: string) {
  expect((await op("PUT", "/v1/admin/entitlements", { tenant: T(sub), canCreateCompany: true })).status).toBe(200);
  const owner = await sessionFor(sub);
  const id = freshCompany();
  const created = await co(owner, "POST", "/v1/companies", { id, name: "Scope Co", timezone: "Asia/Bangkok" });
  expect(created.status).toBe(200);
  return { owner, id };
}

async function addMember(owner: Session, id: string, sub: string, role: string) {
  const response = await co(owner, "POST", `/v1/companies/${id}/members`, { tenant: T(sub), role });
  expect(response.status).toBe(200);
}

function setScope(caller: Session, id: string, sub: string, sharedScope: unknown, opts: { csrf?: string | null } = {}) {
  return co(caller, "PATCH", `/v1/companies/${id}/scope`, { tenant: T(sub), sharedScope }, opts);
}

type MembersView = { members: Record<string, MemberRecord>; grantRevision: number };

async function members(owner: Session, id: string): Promise<MembersView> {
  const response = await co(owner, "GET", `/v1/companies/${id}/members`);
  expect(response.status).toBe(200);
  return (await response.json()) as MembersView;
}

/// Rewrites the stored member rows the way `main` wrote them before sharing:
/// role, status and authVersion, with no `sharedScope` key at all.
async function makeLegacy(id: string) {
  const ns = (env as unknown as { COMPANY: DurableObjectNamespace }).COMPANY;
  await runInDurableObject(ns.get(ns.idFromName(`c:${id}`)) as never, async (_instance: unknown, state: {
    storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
  }) => {
    const rows = (await state.storage.get<Record<string, Record<string, unknown>>>("members")) ?? {};
    for (const row of Object.values(rows)) delete row.sharedScope;
    await state.storage.put("members", rows);
  });
}

describe("the officeSharing flag", () => {
  it("is off by default, and only the operator turns it on", async () => {
    // wrangler.test.json sets no OFFICE_SHARING, like every deployed config,
    // and nothing in this file has written the dynamic record yet.
    const initial = (await (await op("GET", "/v1/admin/flags")).json()) as { officeSharing?: boolean };
    expect(initial.officeSharing).toBe(false);
    expect((await op("PUT", "/v1/admin/flags", { officeSharing: "yes" })).status).toBe(400);
    const { owner } = await companyWithOwner("alice-flag");
    const bySession = await co(owner, "PUT", "/v1/admin/flags", { officeSharing: true });
    expect(bySession.status).toBe(403);
    await sharing(true);
    expect(((await (await op("GET", "/v1/admin/flags")).json()) as { officeSharing?: boolean }).officeSharing).toBe(true);
    await sharing(false);
    expect(((await (await op("GET", "/v1/admin/flags")).json()) as { officeSharing?: boolean }).officeSharing).toBe(false);
  });

  it("while off, the scope route refuses before reading anything and stores nothing", async () => {
    const { owner, id } = await companyWithOwner("alice-off");
    await addMember(owner, id, "bob-off", "viewer");
    const before = await members(owner, id);
    const refused = await setScope(owner, id, "bob-off", [RUN_A]);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "feature_disabled", feature: "officeSharing" });
    // Neither the CSRF guard nor the body is reached: a missing token and a
    // body that is not JSON get the same refusal.
    const unguarded = await co(owner, "PATCH", `/v1/companies/${id}/scope`, "not json", { csrf: null });
    expect(unguarded.status).toBe(403);
    expect(((await unguarded.json()) as { feature?: string }).feature).toBe("officeSharing");
    const after = await members(owner, id);
    expect(after.grantRevision).toBe(before.grantRevision);
    expect(after.members[T("bob-off")]).toEqual(before.members[T("bob-off")]);
    expect(after.members[T("bob-off")]?.sharedScope).toBeNull();
  });
});

describe("member shared scope", () => {
  beforeAll(async () => {
    await sharing(true);
  });
  afterAll(async () => {
    await sharing(false);
  });

  it("a legacy member stored without a scope keeps full access", async () => {
    const { owner, id } = await companyWithOwner("alice-legacy");
    await addMember(owner, id, "bob-legacy", "operator");
    expect(
      (await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("bob-legacy"), grants: ["tasks.create"] }))
        .status,
    ).toBe(200);
    await makeLegacy(id);
    const bob = await sessionFor("bob-legacy");
    const read = await co(bob, "GET", `/v1/companies/${id}`);
    expect(read.status).toBe(200);
    const view = (await read.json()) as { membership: MemberRecord; grants: string[] };
    expect(view.membership.sharedScope).toBeNull();
    expect(view.grants).toEqual(["tasks.create"]);
    for (const run of [RUN_A, RUN_B, RUN_C]) expect(inScope(view.membership, run)).toBe(true);
    // The owner's legacy row still administers the company as before.
    const listed = await members(owner, id);
    expect(listed.members[T("alice-legacy")]?.sharedScope).toBeNull();
    expect((await co(owner, "PATCH", `/v1/companies/${id}`, { name: "Scope Co 2" })).status).toBe(200);
  });

  it("a member given a scope sees only the listed ids", async () => {
    const { owner, id } = await companyWithOwner("alice-scoped");
    await addMember(owner, id, "bob-scoped", "viewer");
    const set = await setScope(owner, id, "bob-scoped", [RUN_A, RUN_B]);
    expect(set.status).toBe(200);
    expect(((await set.json()) as { membership: MemberRecord }).membership.sharedScope).toEqual([RUN_A, RUN_B]);
    const bob = await sessionFor("bob-scoped");
    const view = (await (await co(bob, "GET", `/v1/companies/${id}`)).json()) as { membership: MemberRecord };
    expect(view.membership.sharedScope).toEqual([RUN_A, RUN_B]);
    expect(inScope(view.membership, RUN_A)).toBe(true);
    expect(inScope(view.membership, RUN_B)).toBe(true);
    expect(inScope(view.membership, RUN_C)).toBe(false);
    // An empty scope is a real scope: nothing is shared with them.
    expect((await setScope(owner, id, "bob-scoped", [])).status).toBe(200);
    const emptied = (await (await co(bob, "GET", `/v1/companies/${id}`)).json()) as { membership: MemberRecord };
    expect(emptied.membership.sharedScope).toEqual([]);
    expect(inScope(emptied.membership, RUN_A)).toBe(false);
  });

  it("a scope change bumps the member's authorization version and the grant revision", async () => {
    const { owner, id } = await companyWithOwner("alice-bump");
    await addMember(owner, id, "bob-bump", "viewer");
    const before = await members(owner, id);
    const version = before.members[T("bob-bump")]!.authVersion;
    const set = await setScope(owner, id, "bob-bump", [RUN_A]);
    expect(set.status).toBe(200);
    const body = (await set.json()) as { membership: MemberRecord; grantRevision: number };
    expect(body.grantRevision).toBe(before.grantRevision + 1);
    expect(body.membership.authVersion).toBe(version + 1);
    const after = await members(owner, id);
    expect(after.grantRevision).toBe(before.grantRevision + 1);
    expect(after.members[T("bob-bump")]?.authVersion).toBe(version + 1);
    // Nobody else's version moves.
    expect(after.members[T("alice-bump")]?.authVersion).toBe(before.members[T("alice-bump")]?.authVersion);
  });

  it("a grant change bumps the member's authorization version as well as the grant revision", async () => {
    const { owner, id } = await companyWithOwner("alice-gbump");
    await addMember(owner, id, "bob-gbump", "operator");
    const before = await members(owner, id);
    const granted = await co(owner, "POST", `/v1/companies/${id}/grants`, {
      tenant: T("bob-gbump"),
      grants: ["comments.write"],
    });
    expect(granted.status).toBe(200);
    const after = await members(owner, id);
    expect(after.grantRevision).toBe(before.grantRevision + 1);
    expect(after.members[T("bob-gbump")]?.authVersion).toBe(before.members[T("bob-gbump")]!.authVersion + 1);
  });

  it("a role change, and a revoke followed by a re-seat, never widen the scope", async () => {
    const { owner, id } = await companyWithOwner("alice-keep");
    await addMember(owner, id, "bob-keep", "viewer");
    expect((await setScope(owner, id, "bob-keep", [RUN_A])).status).toBe(200);
    const promoted = await co(owner, "PATCH", `/v1/companies/${id}/members`, { tenant: T("bob-keep"), role: "approver" });
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { membership: MemberRecord }).membership.sharedScope).toEqual([RUN_A]);
    expect((await co(owner, "POST", `/v1/companies/${id}/revoke`, { tenant: T("bob-keep") })).status).toBe(200);
    const revoked = (await members(owner, id)).members[T("bob-keep")]!;
    expect(revoked.status).toBe("revoked");
    expect(inScope(revoked, RUN_A)).toBe(false);
    await addMember(owner, id, "bob-keep", "viewer");
    const reseated = (await members(owner, id)).members[T("bob-keep")]!;
    expect(reseated.status).toBe("active");
    expect(reseated.sharedScope).toEqual([RUN_A]);
    // Promoted to owner, the kept scope no longer limits them (owners see all
    // of it, and the scope route refuses owner rows); demoted again, it does.
    const asOwner = await co(owner, "PATCH", `/v1/companies/${id}/members`, { tenant: T("bob-keep"), role: "owner" });
    expect(asOwner.status).toBe(200);
    const ownerRow = ((await asOwner.json()) as { membership: MemberRecord }).membership;
    expect(ownerRow.sharedScope).toEqual([RUN_A]);
    expect(inScope(ownerRow, RUN_B)).toBe(true);
    const demoted = await co(owner, "PATCH", `/v1/companies/${id}/members`, { tenant: T("bob-keep"), role: "viewer" });
    expect(demoted.status).toBe(200);
    const viewerRow = ((await demoted.json()) as { membership: MemberRecord }).membership;
    expect(viewerRow.sharedScope).toEqual([RUN_A]);
    expect(inScope(viewerRow, RUN_B)).toBe(false);
    // A first seat still gets the pre-sharing full access.
    await addMember(owner, id, "carol-keep", "viewer");
    expect((await members(owner, id)).members[T("carol-keep")]?.sharedScope).toBeNull();
  });

  it("only an active owner holding members.manage sets a scope, and never on an owner's row", async () => {
    const { owner, id } = await companyWithOwner("alice-who");
    await addMember(owner, id, "bob-who", "viewer");
    await addMember(owner, id, "dan-who", "admin");
    expect(
      (await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("dan-who"), grants: ["members.manage"] }))
        .status,
    ).toBe(200);
    await addMember(owner, id, "erin-who", "owner");
    expect(
      (await co(owner, "POST", `/v1/companies/${id}/grants`, { tenant: T("erin-who"), grants: [] })).status,
    ).toBe(200);
    const before = await members(owner, id);

    const admin = await sessionFor("dan-who");
    const byAdmin = await setScope(admin, id, "bob-who", [RUN_A]);
    expect(byAdmin.status).toBe(403);
    expect(((await byAdmin.json()) as { error: string }).error).toBe("owner_required");

    const ungrantedOwner = await sessionFor("erin-who");
    const byUngranted = await setScope(ungrantedOwner, id, "bob-who", [RUN_A]);
    expect(byUngranted.status).toBe(403);
    expect(((await byUngranted.json()) as { error: string }).error).toBe("grant_required");

    const viewer = await sessionFor("bob-who");
    expect((await setScope(viewer, id, "bob-who", [RUN_A, RUN_B, RUN_C])).status).toBe(403);

    // The operator key administers flags and entitlements, never members.
    expect((await op("PATCH", `/v1/companies/${id}/scope`, { tenant: T("bob-who"), sharedScope: [RUN_A] })).status).toBe(
      401,
    );

    const ownerRow = await setScope(owner, id, "erin-who", [RUN_A]);
    expect(ownerRow.status).toBe(409);
    expect(((await ownerRow.json()) as { error: string }).error).toBe("owner_not_scoped");
    expect((await setScope(owner, id, "nobody-who", [RUN_A])).status).toBe(404);

    // An outsider learns nothing beyond the refusal.
    const outsider = await sessionFor("mallory-who");
    const byOutsider = await setScope(outsider, id, "bob-who", [RUN_A]);
    expect(byOutsider.status).toBe(403);
    expect(JSON.stringify(await byOutsider.json())).not.toContain("Scope Co");

    const after = await members(owner, id);
    expect(after.grantRevision).toBe(before.grantRevision);
    expect(after.members[T("bob-who")]?.sharedScope).toBeNull();
  });

  it("malformed, repeated, oversized and null scopes are refused, and nothing is stored", async () => {
    const { owner, id } = await companyWithOwner("alice-bad");
    await addMember(owner, id, "bob-bad", "viewer");
    const before = await members(owner, id);
    const tooMany = Array.from({ length: MAX_SHARED_SCOPE + 1 }, (_, i) => `run-${i}`);
    const cases: [unknown, string][] = [
      [null, "invalid_scope"],
      ["all", "invalid_scope"],
      [["../x"], "invalid_scope"],
      [[RUN_A, 7], "invalid_scope"],
      [[RUN_A, RUN_A], "duplicate_item"],
      [tooMany, "scope_too_large"],
    ];
    for (const [scope, error] of cases) {
      const response = await setScope(owner, id, "bob-bad", scope);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    const after = await members(owner, id);
    expect(after.grantRevision).toBe(before.grantRevision);
    expect(after.members[T("bob-bad")]).toEqual(before.members[T("bob-bad")]);
  });

  it("scope writes need the session CSRF token like every company write", async () => {
    const { owner, id } = await companyWithOwner("alice-csrf-scope");
    await addMember(owner, id, "bob-csrf-scope", "viewer");
    const missing = await setScope(owner, id, "bob-csrf-scope", [RUN_A], { csrf: null });
    expect(missing.status).toBe(403);
    expect(((await missing.json()) as { error: string }).error).toBe("csrf_required");
    expect((await members(owner, id)).members[T("bob-csrf-scope")]?.sharedScope).toBeNull();
  });
});

describe("shared scope rules", () => {
  const active = (sharedScope: MemberRecord["sharedScope"]): MemberRecord => ({
    role: "viewer",
    status: "active",
    authVersion: 3,
    sharedScope,
  });

  it("reads rows stored before sharing as full access, and a malformed scope as less", () => {
    const legacy = readMember({ role: "viewer", status: "active", authVersion: 2 });
    expect(legacy).toEqual({ role: "viewer", status: "active", authVersion: 2, sharedScope: null });
    expect(readMember({ role: "viewer", status: "active", authVersion: 2, sharedScope: null }).sharedScope).toBeNull();
    expect(readMember({ role: "viewer", status: "active", authVersion: 2, sharedScope: "all" }).sharedScope).toEqual([]);
    expect(readMember({ role: "viewer", status: "active", authVersion: 2, sharedScope: {} }).sharedScope).toEqual([]);
    expect(
      readMember({ role: "viewer", status: "active", authVersion: 2, sharedScope: [RUN_A, 4, "../x", RUN_B] })
        .sharedScope,
    ).toEqual([RUN_A, RUN_B]);
    expect(readMember({ role: "viewer", status: "active", authVersion: Number.NaN }).authVersion).toBe(0);
  });

  it("keeps a revoked row and an invalid id out of scope", () => {
    expect(inScope(active(null), RUN_A)).toBe(true);
    expect(inScope(active([RUN_A]), RUN_A)).toBe(true);
    expect(inScope(active([RUN_A]), RUN_B)).toBe(false);
    expect(inScope({ role: "viewer", status: "revoked", sharedScope: null }, RUN_A)).toBe(false);
    expect(inScope({ role: "viewer", status: "revoked", sharedScope: [RUN_A] }, RUN_A)).toBe(false);
    expect(inScope({ role: "owner", status: "revoked", sharedScope: null }, RUN_A)).toBe(false);
    expect(inScope(active(null), "../x")).toBe(false);
    expect(inScope(active(null), "")).toBe(false);
  });

  it("moves only the authorization version", () => {
    const before = active([RUN_A]);
    expect(bumpAuthz(before)).toEqual({ ...before, authVersion: 4 });
    expect(before.authVersion).toBe(3);
  });

  it("validates a requested scope without trimming it", () => {
    expect(checkScope([RUN_A, RUN_B])).toEqual({ ok: true, scope: [RUN_A, RUN_B] });
    expect(checkScope([])).toEqual({ ok: true, scope: [] });
    expect(checkScope(null)).toEqual({ ok: false, error: "invalid_scope" });
    expect(checkScope(undefined)).toEqual({ ok: false, error: "invalid_scope" });
    expect(checkScope([RUN_A, "a/b"])).toEqual({ ok: false, error: "invalid_scope" });
    expect(checkScope([RUN_A, RUN_A])).toEqual({ ok: false, error: "duplicate_item" });
    expect(checkScope(Array.from({ length: MAX_SHARED_SCOPE }, (_, i) => `run-${i}`)).ok).toBe(true);
    expect(checkScope(Array.from({ length: MAX_SHARED_SCOPE + 1 }, (_, i) => `run-${i}`))).toEqual({
      ok: false,
      error: "scope_too_large",
    });
  });
});
