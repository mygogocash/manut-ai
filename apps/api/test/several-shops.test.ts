import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import worker from "../src/index";
import type { PeopleRecord } from "../src/people-store";
import { tenantDelete, tenantStub } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  accept,
  admin,
  asSession,
  call,
  auditEntries,
  bindings,
  decide,
  invite,
  inviteToken,
  ownerConsents,
  plantRequest,
  proposeReply,
  setFlags,
  setupShop,
  shopTask,
  signIn,
  storedRequest,
  stubLine,
  type Joined,
  type Shop,
  type SignedIn,
} from "./people-fixtures";

// Several shops (docs/several-shops.md; docs/pilot-api.md, "Several shops"), through the real Worker and objects. One
// person signed in with Apple owns two pilot shops, each linked by the operator with a one-use code from the person's
// own session, and helps at a third, joined through an invite. Each shop session reads and decides only its own shop,
// with the role that shop's record gives it; unlinking and removal end that shop's sessions and no others; and no
// route takes the shop or the role from the request where the session decides it. The global fetch counts LINE pushes
// and answers everything else 599, so nothing leaves the test.

const DAY = 24 * 60 * 60 * 1000;
const DECLINE = { optionId: "decline", seenRevision: 1 };
const APPROVE = { optionId: "approve", seenRevision: 1 };
let line: ReturnType<typeof stubLine>;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Role = "owner" | "helper";
type Listed = { shops: { id: string; name: string; ownerName: string; role: Role }[]; error?: string };
type Opened = { shop: { id: string; name: string; ownerName: string }; role: Role;
  session: { accessToken: string; expiresAt: string }; account?: { id: string }; helper?: { id: string; name: string };
  error?: string };
type Headers = { authorization?: string };

function authStub() {
  return bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
}

/// A link code from `person`'s own signed-in session, as the app shows it for the owner to send their operator.
async function ownerCode(person: SignedIn): Promise<string> {
  const made = await asSession<{ code: string; expiresAt: string }>(person.headers, "POST", "/v1/shops/owner-code");
  expect(made.status).toBe(200);
  return made.body.code;
}

/// The operator enters a code on a shop.
function linkOwner(shop: { tenant: string }, code: unknown) {
  return admin<{ tenant: string; ownerAccount: { id: string; linkedAt: string }; error?: string }>("POST",
    "/v1/admin/shops/owner", { tenant: shop.tenant, code });
}

/// `person`'s account linked as `shop`'s owner with a fresh code: the account's id.
async function linkAsOwner(shop: Shop, person: SignedIn): Promise<string> {
  const linked = await linkOwner(shop, await ownerCode(person));
  expect(linked.status).toBe(200);
  return linked.body.ownerAccount.id;
}

function unlinkOwner(shop: Shop) {
  return admin<{ tenant: string; unlinked: string; sessionsEnded: number; error?: string }>("POST",
    "/v1/admin/shops/owner/unlink", { tenant: shop.tenant });
}

function myShops(person: { headers: Headers }) {
  return asSession<Listed>(person.headers, "GET", "/v1/shops");
}

function openShop(person: { headers: Headers }, shop: string) {
  return asSession<Opened>(person.headers, "POST", "/v1/shops/session", { shop });
}

/// A shop session for `shop`, which the shop's record must give as `role`: the headers that carry it.
async function shopSession(person: SignedIn, shop: Shop, role: Role): Promise<{ authorization: string }> {
  const opened = await openShop(person, shop.tenant);
  expect(opened.status).toBe(200);
  expect(opened.body.role).toBe(role);
  return { authorization: `Bearer ${opened.body.session.accessToken}` };
}

/// The ids of the requests a session lists as open.
async function openIds(headers: Headers): Promise<string[]> {
  const listed = await asSession<{ approvals: { record: { request: { id: string } } }[] }>(headers, "GET",
    "/v1/approvals?state=open");
  expect(listed.status).toBe(200);
  return listed.body.approvals.map((entry) => entry.record.request.id).sort();
}

/// The Worker's bindings with one object namespace answering 500 to the requests `fails` picks, as if that object could
/// not be reached, and passing every other request to the real object.
function failingWhere(name: "AUTH" | "TENANT", fails: (request: Request) => boolean): typeof bindings {
  const namespace = bindings[name];
  return { ...bindings, [name]: {
    idFromName: (id: string) => namespace.idFromName(id),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return fails(request) ? Response.json({ error: "fixture" }, { status: 500 }) : stub.fetch(request);
      } };
    },
  } as unknown as DurableObjectNamespace };
}

/// A request to the Worker with other bindings, as the operator console (with Access) or a signed-in app sends it.
async function callWith(target: typeof bindings, path: string, init: { method?: string; headers?: Headers; body?: unknown;
  operator?: boolean }) {
  const context = createExecutionContext();
  if (init.operator) {
    Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => undefined },
      configurable: true });
  }
  const headers = { "content-type": "application/json", ...(init.operator ? { authorization: "Bearer test-key" } : {}),
    ...init.headers };
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: init.method ?? "GET", headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/// Fon, signed in with Apple: the operator linked her account as the owner of Baan Mali and of Khao Hom, and Ran Pa
/// Noi's owner invited her as a helper, which she accepted.
async function fonsShops() {
  const fonEmail = `fon-${crypto.randomUUID()}@example.test`;
  const fon = await signIn(fonEmail);
  const mali = await setupShop("Baan Mali");
  const khaoHom = await setupShop("Khao Hom");
  const paNoi = await setupShop("Ran Pa Noi");
  const maliAccount = await linkAsOwner(mali, fon);
  const khaoHomAccount = await linkAsOwner(khaoHom, fon);
  const made = await invite(paNoi, "Fon", { kind: "email", address: fonEmail });
  expect(made.status).toBe(200);
  const joined = await accept(fon, inviteToken(made.body.inviteUrl));
  expect(joined.status).toBe(200);
  const body = joined.body as unknown as Joined;
  return { fon, fonEmail, mali, khaoHom, paNoi, maliAccount, khaoHomAccount, helperId: body.helper.id,
    joinedSession: { authorization: `Bearer ${body.session.accessToken}` } };
}

describe("one person in several shops", () => {
  it("lists the shops they own and the one they help, each with its role", async () => {
    const { fon, mali, khaoHom, paNoi } = await fonsShops();
    expect(await myShops(fon)).toEqual({ status: 200, body: { shops: [
      { id: mali.tenant, name: "Baan Mali", ownerName: "Fon", role: "owner" },
      { id: khaoHom.tenant, name: "Khao Hom", ownerName: "Fon", role: "owner" },
      { id: paNoi.tenant, name: "Ran Pa Noi", ownerName: "Fon", role: "helper" },
    ] } });
    // Someone else who signs in is in no shop.
    expect(await myShops(await signIn())).toEqual({ status: 200, body: { shops: [] } });
  });

  it("fails the whole list rather than leave out a shop it cannot read", async () => {
    const { fon, khaoHom } = await fonsShops();
    const cannotReadKhaoHom = failingWhere("TENANT", (request) => {
      const url = new URL(request.url);
      return url.pathname === "/people" && url.searchParams.get("tenant") === khaoHom.tenant;
    });
    expect(await callWith(cannotReadKhaoHom, "/v1/shops", { headers: fon.headers })).toEqual({ status: 503,
      body: { error: "shops_unavailable" } });
    const cannotReadIndex = failingWhere("AUTH", (request) => new URL(request.url).pathname === "/identity-shops");
    expect(await callWith(cannotReadIndex, "/v1/shops", { headers: fon.headers })).toEqual({ status: 503,
      body: { error: "shops_unavailable" } });
  });

  it("opens each shop with a session for that shop alone, as the role its record gives", async () => {
    const { fon, mali, paNoi, maliAccount, helperId } = await fonsShops();
    const asOwner = await openShop(fon, mali.tenant);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toMatchObject({ shop: { id: mali.tenant, name: "Baan Mali", ownerName: "Fon" }, role: "owner",
      account: { id: maliAccount } });
    expect(asOwner.body.session.accessToken.startsWith("mos1.")).toBe(true);
    expect(Date.parse(asOwner.body.session.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY);
    const asHelper = await openShop(fon, paNoi.tenant);
    expect(asHelper.status).toBe(200);
    expect(asHelper.body).toMatchObject({ shop: { id: paNoi.tenant, name: "Ran Pa Noi" }, role: "helper",
      helper: { id: helperId, name: "Fon" } });
    expect(asHelper.body.session.accessToken.startsWith("mhs1.")).toBe(true);
    // A session names one shop, and only that shop's record holding its hash makes it work: moved to another shop
    // Fon owns, it is no one's.
    const [prefix, , secret] = asOwner.body.session.accessToken.split(".");
    const khaoHom = (await myShops(fon)).body.shops.find((shop) => shop.name === "Khao Hom")!.id;
    const moved = `${prefix}.${btoa(khaoHom).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${secret}`;
    expect(await asSession({ authorization: `Bearer ${moved}` }, "GET", "/v1/approvals?state=open")).toEqual({
      status: 401, body: { error: "unauthorized" } });
  });

  it("reads and decides each shop only through that shop's session, with the role that shop gives", async () => {
    const { fon, mali, khaoHom, paNoi, maliAccount, helperId } = await fonsShops();
    const maliTask = await shopTask(mali.tenant);
    const maliRefund = await plantRequest(mali.tenant, maliTask, "money");
    const maliReply = await proposeReply(mali, "Your parcel left this morning.");
    const khaoHomTask = await shopTask(khaoHom.tenant);
    const khaoHomRefund = await plantRequest(khaoHom.tenant, khaoHomTask, "money");
    const paNoiTask = await shopTask(paNoi.tenant);
    const paNoiRefund = await plantRequest(paNoi.tenant, paNoiTask, "money");
    const paNoiReply = await proposeReply(paNoi, "We open at nine.");
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    const asOwnerOfKhaoHom = await shopSession(fon, khaoHom, "owner");
    const asHelperAtPaNoi = await shopSession(fon, paNoi, "helper");

    // Each session lists its own shop's requests and nothing else.
    expect(await openIds(asOwnerOfMali)).toEqual([maliRefund, maliReply.actionId].sort());
    expect(await openIds(asOwnerOfKhaoHom)).toEqual([khaoHomRefund]);
    expect(await openIds(asHelperAtPaNoi)).toEqual([paNoiRefund, paNoiReply.actionId].sort());

    // Baan Mali's session decides Baan Mali's refund as its owner, named by the linked account.
    expect(await decide(asOwnerOfMali, maliRefund, DECLINE)).toMatchObject({ status: 200, body: { result: { ok: true,
      decision: { decidedBy: maliAccount, role: "owner" } }, action: "rejected" } });
    expect((await auditEntries(mali.tenant)).find((entry) => entry.action === "approval.decided")).toMatchObject({
      actor: { kind: "owner", id: maliAccount }, subject: { requestId: maliRefund }, outcome: "declined" });
    // It never reaches another shop's request: not one Fon owns too, and not one where she helps.
    for (const requestId of [khaoHomRefund, paNoiRefund, paNoiReply.actionId]) {
      expect(await decide(asOwnerOfMali, requestId, DECLINE)).toMatchObject({ status: 404, body: { error: "not_found" } });
    }
    // At Ran Pa Noi she is a helper: the refund waits for that shop's owner, and the reply is hers to decide.
    expect(await decide(asHelperAtPaNoi, paNoiRefund, DECLINE)).toMatchObject({ status: 403,
      body: { error: "not_permitted", result: { refused: "not_permitted" } } });
    expect(await decide(asHelperAtPaNoi, paNoiReply.actionId, DECLINE)).toMatchObject({ status: 200,
      body: { result: { ok: true, decision: { decidedBy: helperId, role: "helper" } }, action: "rejected" } });
    // Her helper session cannot reach the shops she owns either.
    expect((await decide(asHelperAtPaNoi, maliReply.actionId, DECLINE)).status).toBe(404);
    expect((await storedRequest(khaoHom.tenant, khaoHomTask, khaoHomRefund)).record.status).toBe("pending");
    expect((await storedRequest(paNoi.tenant, paNoiTask, paNoiRefund)).record.status).toBe("pending");

    // An approval from the linked owner goes through the one send gate, once.
    await ownerConsents(maliReply);
    expect(await decide(asOwnerOfMali, maliReply.actionId, APPROVE)).toMatchObject({ status: 200,
      body: { result: { ok: true, decision: { decidedBy: maliAccount, role: "owner" } }, action: "confirmed" } });
    expect(line.pushes()).toBe(1);
  });

  it("refuses a shop they are not linked to with 404, as it answers a shop that does not exist", async () => {
    const { fon } = await fonsShops();
    const elsewhere = await setupShop("Someone else's shop");
    await linkAsOwner(elsewhere, await signIn());
    for (const shop of [elsewhere.tenant, "pilot:no-such-shop"]) {
      expect(await openShop(fon, shop)).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect((await myShops(fon)).body.shops.map((shop) => shop.id)).not.toContain(elsewhere.tenant);
    // A row in Fon's index naming a shop whose record names another owner lists nothing and opens nothing: the index
    // is only a hint, and the shop's record decides.
    await runInDurableObject(authStub(), async (_instance, state) => {
      const key = `identity-shops:${encodeURIComponent(fon.tenant)}`;
      const rows = (await state.storage.get<unknown[]>(key)) ?? [];
      await state.storage.put(key, [...rows, { shop: elsewhere.tenant, role: "owner", ref: "owner-planted", at: Date.now() },
        { shop: elsewhere.tenant, role: "helper", ref: "helper-planted", at: Date.now() }]);
    });
    expect((await myShops(fon)).body.shops.map((shop) => shop.id)).not.toContain(elsewhere.tenant);
    expect(await openShop(fon, elsewhere.tenant)).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("unlinking the owner's account", () => {
  it("ends that shop's owner sessions at once, and nothing else", async () => {
    const { fon, mali, khaoHom, paNoi, maliAccount } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    const anotherDevice = await shopSession(fon, mali, "owner");
    const asOwnerOfKhaoHom = await shopSession(fon, khaoHom, "owner");
    const asHelperAtPaNoi = await shopSession(fon, paNoi, "helper");

    expect(await unlinkOwner(mali)).toEqual({ status: 200, body: { tenant: mali.tenant, unlinked: maliAccount,
      sessionsEnded: 2 } });
    for (const headers of [asOwnerOfMali, anotherDevice]) {
      const refused = await asSession<{ error: string; unlinkedAt: string }>(headers, "GET", "/v1/approvals?state=open");
      expect(refused.status).toBe(401);
      expect(refused.body.error).toBe("unlinked");
      expect(Math.abs(Date.parse(refused.body.unlinkedAt) - Date.now())).toBeLessThan(60_000);
    }
    // Her other shops and her own session carry on.
    expect((await asSession(asOwnerOfKhaoHom, "GET", "/v1/approvals?state=open")).status).toBe(200);
    expect((await asSession(asHelperAtPaNoi, "GET", "/v1/approvals?state=open")).status).toBe(200);
    expect((await myShops(fon)).body.shops.map((shop) => [shop.id, shop.role])).toEqual([[khaoHom.tenant, "owner"],
      [paNoi.tenant, "helper"]]);
    expect(await openShop(fon, mali.tenant)).toEqual({ status: 404, body: { error: "not_found" } });
    // The log says the operator unlinked that account, by its id.
    expect((await auditEntries(mali.tenant)).find((entry) => entry.action === "owner.unlinked")).toMatchObject({
      actor: { kind: "operator" }, subject: { ownerAccountId: maliAccount }, outcome: "ok" });

    // Unlinking again finds nothing; linking again makes a new link, and the ended sessions stay ended.
    expect(await unlinkOwner(mali)).toEqual({ status: 404, body: { error: "not_linked" } });
    const relinked = await linkAsOwner(mali, fon);
    expect(relinked).not.toBe(maliAccount);
    expect((await asSession(asOwnerOfMali, "GET", "/v1/approvals?state=open")).status).toBe(401);
    expect((await asSession(await shopSession(fon, mali, "owner"), "GET", "/v1/approvals?state=open")).status).toBe(200);
  });
});

describe("removing them as a helper", () => {
  it("ends that shop's helper sessions, and none of the shops they own", async () => {
    const { fon, mali, khaoHom, paNoi, helperId, joinedSession } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    const asHelperAtPaNoi = await shopSession(fon, paNoi, "helper");

    expect(await admin("POST", "/v1/admin/people/remove", { tenant: paNoi.tenant, helperId })).toMatchObject({
      status: 200, body: { removed: helperId, sessionsEnded: 2 } });
    for (const headers of [joinedSession, asHelperAtPaNoi]) {
      expect(await asSession(headers, "GET", "/v1/approvals?state=open")).toMatchObject({ status: 401,
        body: { error: "removed" } });
    }
    expect((await asSession(asOwnerOfMali, "GET", "/v1/approvals?state=open")).status).toBe(200);
    expect((await myShops(fon)).body.shops.map((shop) => shop.id)).toEqual([mali.tenant, khaoHom.tenant]);
    expect(await openShop(fon, paNoi.tenant)).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("signing out of a shop session", () => {
  type Ended = { ended?: { shop: string; role: Role }; error?: string; unlinkedAt?: string; removedAt?: string };
  /// The app ends its own shop session: the session is the credential, and the body is `{}`.
  const endSession = (headers: Headers, body: unknown = {}) =>
    asSession<Ended>(headers, "POST", "/v1/shops/session/end", body);
  const worksOnApprovals = async (headers: Headers) => (await asSession(headers, "GET", "/v1/approvals?state=open")).status;
  /// How many devices the shop's people list counts as signed in: the owner's account and each helper.
  async function devices(shop: Shop) {
    const listed = await admin<{ owner: { account: { devices: number } | null }; helpers: { id: string; devices: number }[] }>(
      "GET", `/v1/admin/people?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(listed.status).toBe(200);
    return { owner: listed.body.owner.account?.devices ?? null,
      helpers: Object.fromEntries(listed.body.helpers.map((helper) => [helper.id, helper.devices])) };
  }
  const sessionEnds = async (shop: Shop, action: "owner.session_ended" | "helper.session_ended") =>
    (await auditEntries(shop.tenant)).filter((entry) => entry.action === action);

  it("ends exactly that owner session: it answers 401 everywhere after, and no other session of hers is touched", async () => {
    const { fon, mali, khaoHom, paNoi, maliAccount, joinedSession } = await fonsShops();
    const phone = await shopSession(fon, mali, "owner");
    const laptop = await shopSession(fon, mali, "owner");
    const asOwnerOfKhaoHom = await shopSession(fon, khaoHom, "owner");
    const asHelperAtPaNoi = await shopSession(fon, paNoi, "helper");
    expect((await devices(mali)).owner).toBe(2);

    expect(await endSession(phone)).toEqual({ status: 200, body: { ended: { shop: mali.tenant, role: "owner" } } });

    // The same token answers 401 everywhere, as any ended session does: the approvals, the team's routines and this route.
    for (const [method, path, body] of [["GET", "/v1/approvals?state=open"], ["POST", "/v1/approvals/anything/decision", DECLINE],
      ["GET", "/v1/routines"], ["POST", "/v1/team/pause", {}], ["POST", "/v1/shops/session/end", {}]] as const) {
      expect(await asSession(phone, method, path, body)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    // Her other device of the same shop, her other shops, her helper session and her own sign-in carry on.
    for (const headers of [laptop, asOwnerOfKhaoHom, asHelperAtPaNoi, joinedSession]) expect(await worksOnApprovals(headers)).toBe(200);
    expect((await myShops(fon)).body.shops.map((shop) => [shop.id, shop.role])).toEqual([[mali.tenant, "owner"],
      [khaoHom.tenant, "owner"], [paNoi.tenant, "helper"]]);
    expect((await devices(mali)).owner).toBe(1);
    // Signing out is not unlinking: she opens the shop again with her sign-in, and the new session works.
    expect(await worksOnApprovals(await shopSession(fon, mali, "owner"))).toBe(200);
    // The log says the account ended a session, by ids only: never the token, the account's subject, her email or a name.
    const ended = await sessionEnds(mali, "owner.session_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ actor: { kind: "owner", id: maliAccount }, subject: { ownerAccountId: maliAccount },
      outcome: "ok" });
    expect(Object.keys(ended[0]!).sort()).toEqual(["action", "actor", "at", "id", "outcome", "subject"]);
    const secret = phone.authorization.split(".")[2]!;
    for (const kept of [secret, phone.authorization, fon.tenant, "Fon"]) expect(JSON.stringify(ended)).not.toContain(kept);
    expect(await sessionEnds(khaoHom, "owner.session_ended")).toHaveLength(0);
  });

  it("ends exactly that helper session, answers it 401 unauthorized and not removed, and removal then ends only the rest", async () => {
    const { fon, paNoi, helperId, joinedSession } = await fonsShops();
    const laptop = await shopSession(fon, paNoi, "helper");
    expect((await devices(paNoi)).helpers).toEqual({ [helperId]: 2 });

    expect(await endSession(laptop)).toEqual({ status: 200, body: { ended: { shop: paNoi.tenant, role: "helper" } } });

    // She signed out; nobody removed her, so the token is unknown, not "removed".
    for (const [method, path, body] of [["GET", "/v1/approvals?state=open"], ["POST", "/v1/approvals/anything/decision", DECLINE],
      ["GET", "/v1/routines"], ["POST", "/v1/shops/session/end", {}]] as const) {
      expect(await asSession(laptop, method, path, body)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(await worksOnApprovals(joinedSession)).toBe(200);
    expect((await devices(paNoi)).helpers).toEqual({ [helperId]: 1 });
    const ended = await sessionEnds(paNoi, "helper.session_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ actor: { kind: "helper", id: helperId }, subject: { helperId }, outcome: "ok" });
    expect(Object.keys(ended[0]!).sort()).toEqual(["action", "actor", "at", "id", "outcome", "subject"]);
    for (const kept of [laptop.authorization.split(".")[2]!, fon.tenant, "Fon"]) expect(JSON.stringify(ended)).not.toContain(kept);

    // She is still a helper and opens the shop again; removing her later ends only the one session that was still open.
    expect(await worksOnApprovals(await shopSession(fon, paNoi, "helper"))).toBe(200);
    expect(await admin("POST", "/v1/admin/people/remove", { tenant: paNoi.tenant, helperId })).toMatchObject({ status: 200,
      body: { removed: helperId, sessionsEnded: 2 } });
    expect(await asSession(joinedSession, "GET", "/v1/approvals?state=open")).toMatchObject({ status: 401,
      body: { error: "removed" } });
    expect(await asSession(laptop, "GET", "/v1/approvals?state=open")).toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("refuses what is not a shop session, each with its own status, and ends nothing", async () => {
    const { fon, mali, khaoHom } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    // A person's sign-in and the shop's own pilot session are real credentials of another kind: they are told so, and
    // neither is ended.
    const shopsOwn = await tenantSession(mali.tenant);
    for (const headers of [fon.headers, shopsOwn]) {
      expect(await endSession(headers)).toEqual({ status: 403, body: { error: "not_a_shop_session" } });
    }
    expect((await myShops(fon)).status).toBe(200);
    expect(await worksOnApprovals(shopsOwn)).toBe(200);
    // The operator key is no session at all, and nor is no credential, a token nobody holds, or one moved to another shop.
    const [prefix, , secret] = asOwnerOfMali.authorization.slice("Bearer ".length).split(".");
    const toShop = (tenant: string) => `${prefix}.${btoa(tenant).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${secret}`;
    for (const headers of [{ authorization: "Bearer test-key" }, {}, { authorization: "Bearer nonsense" },
      { authorization: `Bearer ${toShop(khaoHom.tenant)}` }, { authorization: `Bearer ${prefix}.bm9wZQ.${"0".repeat(64)}` }]) {
      expect(await endSession(headers)).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    // Who is asking is checked before the method and the body, so none of these learns anything about the route.
    expect(await asSession({}, "GET", "/v1/shops/session/end")).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await endSession({ authorization: "Bearer test-key" }, { shop: mali.tenant })).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    // The shop session is still open, and nothing was written.
    expect(await worksOnApprovals(asOwnerOfMali)).toBe(200);
    expect((await devices(mali)).owner).toBe(1);
    expect(await sessionEnds(mali, "owner.session_ended")).toHaveLength(0);
  });

  it("takes exactly {} from a live session: another method or body is refused, and ends nothing", async () => {
    const { fon, mali } = await fonsShops();
    const phone = await shopSession(fon, mali, "owner");
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect(await asSession(phone, method, "/v1/shops/session/end")).toEqual({ status: 405, body: { error: "method_not_allowed" } });
    }
    // A shop, a role or an account in the body is refused, never read: the session names all three.
    for (const body of [{ shop: mali.tenant }, { role: "owner" }, { tenant: mali.tenant }, { ownerAccountId: "owner-chosen" }, [], "end",
      null, 7]) {
      expect(await endSession(phone, body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    for (const raw of ["{not json", ""]) {
      const response = await call("/v1/shops/session/end", { method: "POST", headers: { ...phone, "content-type": "application/json" },
        ...(raw === "" ? {} : { body: raw }) });
      expect({ status: response.status, body: await response.json() }).toEqual({ status: 400, body: { error: "invalid_json" } });
    }
    expect(await worksOnApprovals(phone)).toBe(200);
    expect(await sessionEnds(mali, "owner.session_ended")).toHaveLength(0);
    expect(await endSession(phone)).toMatchObject({ status: 200 });
  });

  it("answers a session that unlinking or removal ended as every route does, and records nothing", async () => {
    const { fon, mali, paNoi, helperId } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    const asHelperAtPaNoi = await shopSession(fon, paNoi, "helper");
    expect((await unlinkOwner(mali)).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: paNoi.tenant, helperId })).status).toBe(200);
    expect(await endSession(asOwnerOfMali)).toMatchObject({ status: 401, body: { error: "unlinked", unlinkedAt: expect.any(String) } });
    expect(await endSession(asHelperAtPaNoi)).toMatchObject({ status: 401, body: { error: "removed", removedAt: expect.any(String) } });
    expect(await sessionEnds(mali, "owner.session_ended")).toHaveLength(0);
    expect(await sessionEnds(paNoi, "helper.session_ended")).toHaveLength(0);
  });

  it("answers a session past its 30 days 401 and records nothing", async () => {
    const { fon, mali } = await fonsShops();
    const phone = await shopSession(fon, mali, "owner");
    const hash = await sha256Hex(phone.authorization.slice("Bearer ".length));
    await runInDurableObject(tenantStub(bindings, mali.tenant), async (_instance, state) => {
      const key = `people:${encodeURIComponent(mali.tenant)}`;
      const record = (await state.storage.get<PeopleRecord>(key))!;
      const session = record.ownerSessions![hash]!;
      await state.storage.put(key, { ...record, ownerSessions: { ...record.ownerSessions, [hash]: { ...session,
        expiresAt: Date.now() - 1000 } } });
    });
    expect(await endSession(phone)).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await sessionEnds(mali, "owner.session_ended")).toHaveLength(0);
  });

  it("ends a session once however many devices send it at once: one answer 200, the rest 401, one entry in the log", async () => {
    const { fon, mali } = await fonsShops();
    const phone = await shopSession(fon, mali, "owner");
    const answers = await Promise.all([endSession(phone), endSession(phone), endSession(phone)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401, 401]);
    expect(await sessionEnds(mali, "owner.session_ended")).toHaveLength(1);
  });

  it("answers 503 and ends nothing when the shop's record cannot be read or written", async () => {
    const { fon, mali, paNoi } = await fonsShops();
    const phone = await shopSession(fon, mali, "owner");
    const laptop = await shopSession(fon, paNoi, "helper");
    const post = (path: string) => (request: Request) => request.method === "POST" && new URL(request.url).pathname === path;
    const cases = [
      [phone, post("/people/end-owner-session")], [phone, post("/people/owner-session-check")],
      [laptop, post("/people/end-helper-session")], [laptop, post("/people/session-check")],
    ] as const;
    for (const [headers, fails] of cases) {
      expect(await callWith(failingWhere("TENANT", fails), "/v1/shops/session/end", { method: "POST", headers, body: {} }))
        .toEqual({ status: 503, body: { error: "people_unavailable" } });
    }
    for (const headers of [phone, laptop]) expect(await worksOnApprovals(headers)).toBe(200);
    expect(await endSession(phone)).toMatchObject({ status: 200 });
    expect(await endSession(laptop)).toMatchObject({ status: 200 });
  });
});

describe("the operator's link", () => {
  it("is audited under the operator, naming the link by its id, never the account, the email or the code", async () => {
    const fonEmail = `fon-${crypto.randomUUID()}@example.test`;
    const fon = await signIn(fonEmail);
    const shop = await setupShop();
    const code = await ownerCode(fon);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const linked = await linkOwner(shop, code);
    expect(linked.status).toBe(200);
    const accountId = linked.body.ownerAccount.id;
    expect(linked.body).toEqual({ tenant: shop.tenant, ownerAccount: { id: accountId, linkedAt: expect.any(String) } });
    expect(accountId).toMatch(/^owner-[0-9a-f-]{36}$/);
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "owner.linked")).toMatchObject({
      actor: { kind: "operator" }, subject: { ownerAccountId: accountId }, outcome: "ok" });
    // Opening the shop is logged as that account.
    await shopSession(fon, shop, "owner");
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "owner.session_opened")).toMatchObject({
      actor: { kind: "owner", id: accountId }, subject: { ownerAccountId: accountId }, outcome: "ok" });
    const log = JSON.stringify(await auditEntries(shop.tenant));
    for (const kept of [fon.tenant, fonEmail, code, code.replace("-", "")]) expect(log).not.toContain(kept);
    // The console's People shows the link and how many devices have it open, never the account itself.
    const people = await admin<{ owner: unknown }>("GET", `/v1/admin/people?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(people.body.owner).toEqual({ name: "Fon", account: { id: accountId, linkedAt: linked.body.ownerAccount.linkedAt,
      devices: 1 } });
    expect(JSON.stringify(people.body)).not.toContain(fon.tenant);
  });

  it("uses a code once, for the account that asked for it, while it lasts", async () => {
    const fon = await signIn();
    const [mali, khaoHom, paNoi] = [await setupShop(), await setupShop("Khao Hom"), await setupShop("Ran Pa Noi")];
    const code = await ownerCode(fon);
    // As a person types it: in lower case and without the dash.
    expect((await linkOwner(mali, code.toLowerCase().replace("-", ""))).status).toBe(200);
    expect(await linkOwner(khaoHom, code)).toEqual({ status: 404, body: { error: "unknown_code" } });
    // A new code replaces the one before it.
    const first = await ownerCode(fon);
    const second = await ownerCode(fon);
    expect(await linkOwner(khaoHom, first)).toEqual({ status: 404, body: { error: "unknown_code" } });
    expect((await linkOwner(khaoHom, second)).status).toBe(200);
    // A code past its 15 minutes, as AuthObject would hold it.
    const late = await ownerCode(fon);
    const hash = await sha256Hex(late.replace("-", ""));
    await runInDurableObject(authStub(), async (_instance, state) => {
      const key = `owner-code:${hash}`;
      const stored = (await state.storage.get<Record<string, unknown>>(key))!;
      expect(stored).toBeDefined();
      await state.storage.put(key, { ...stored, expiresAt: Date.now() - 1000 });
    });
    expect(await linkOwner(paNoi, late)).toEqual({ status: 410, body: { error: "code_expired" } });
    // Codes nobody made, and text that is no code at all.
    for (const never of ["ZZZZ-ZZZZ", "not a code", ""]) {
      expect(await linkOwner(paNoi, never)).toEqual({ status: 404, body: { error: "unknown_code" } });
    }
    expect(await linkOwner(paNoi, 12345678)).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect((await myShops(fon)).body.shops.map((shop) => shop.id)).toEqual([mali.tenant, khaoHom.tenant]);
  });

  it("keeps one owner account per shop: another waits for an unlink, and the same one is kept and listed again", async () => {
    const fon = await signIn();
    const someoneElse = await signIn();
    const shop = await setupShop();
    const accountId = await linkAsOwner(shop, fon);
    expect(await linkOwner(shop, await ownerCode(someoneElse))).toEqual({ status: 409, body: { error: "already_linked" } });
    expect((await myShops(someoneElse)).body.shops).toEqual([]);
    // Fon's index row lost, as if its write had failed: linking the same account again keeps the link and lists it.
    await runInDurableObject(authStub(), async (_instance, state) => {
      await state.storage.delete(`identity-shops:${encodeURIComponent(fon.tenant)}`);
    });
    expect((await myShops(fon)).body.shops).toEqual([]);
    expect(await linkOwner(shop, await ownerCode(fon))).toMatchObject({ status: 200, body: { ownerAccount: { id: accountId } } });
    expect((await myShops(fon)).body.shops.map((one) => [one.id, one.role])).toEqual([[shop.tenant, "owner"]]);
    expect((await auditEntries(shop.tenant)).filter((entry) => entry.action === "owner.linked")).toHaveLength(1);
    // Only a pilot shop has an owner to link, and a code is not spent on one that is not.
    const code = await ownerCode(fon);
    expect(await linkOwner({ tenant: "pilot:no-such-shop" }, code)).toEqual({ status: 404,
      body: { error: "shop_not_found" } });
    expect(await admin("POST", "/v1/admin/shops/owner", { code })).toEqual({ status: 400,
      body: { error: "tenant_required" } });
    const another = await setupShop("Khao Hom");
    expect((await linkOwner(another, code)).status).toBe(200);
  });

  it("stands in the shop's record when the owner's list cannot be written, and linking again lists the shop", async () => {
    const fon = await signIn();
    const shop = await setupShop();
    const cannotIndex = failingWhere("AUTH", (request) => request.method === "POST" &&
      new URL(request.url).pathname === "/identity-shops");
    expect(await callWith(cannotIndex, "/v1/admin/shops/owner", { method: "POST", operator: true,
      body: { tenant: shop.tenant, code: await ownerCode(fon) } })).toEqual({ status: 503,
      body: { error: "index_unavailable" } });
    expect((await myShops(fon)).body.shops).toEqual([]);
    const linked = (await auditEntries(shop.tenant)).filter((entry) => entry.action === "owner.linked");
    expect(linked).toHaveLength(1);
    // The same account again, with a new code: the same link, now listed, and no second entry.
    const again = await linkOwner(shop, await ownerCode(fon));
    expect(again).toMatchObject({ status: 200, body: { ownerAccount: { id: linked[0]!.subject.ownerAccountId } } });
    expect((await myShops(fon)).body.shops.map((one) => [one.id, one.role])).toEqual([[shop.tenant, "owner"]]);
    expect((await auditEntries(shop.tenant)).filter((entry) => entry.action === "owner.linked")).toHaveLength(1);
  });
});

describe("AuthObject's records", () => {
  function authWrite(path: string, body: unknown, admin = true) {
    return authStub().fetch(new Request(`https://auth${path}`, { method: "POST",
      headers: { "content-type": "application/json", ...(admin ? { "x-admin": "1" } : {}) }, body: JSON.stringify(body) }));
  }

  it("never let one code name two people, and take writes from the Worker only", async () => {
    const codeHash = await sha256Hex(`code-${crypto.randomUUID()}`);
    const first = `apple:first-${crypto.randomUUID()}`;
    const second = `apple:second-${crypto.randomUUID()}`;
    const expiresAt = Date.now() + 60_000;
    expect((await authWrite("/owner-codes", { subject: first, codeHash, expiresAt })).status).toBe(200);
    const taken = await authWrite("/owner-codes", { subject: second, codeHash, expiresAt });
    expect({ status: taken.status, body: await taken.json() }).toEqual({ status: 409, body: { error: "code_taken" } });
    const redeemed = await authWrite("/owner-codes/redeem", { codeHash });
    expect(await redeemed.json()).toEqual({ subject: first });
    // Without the Worker's header, nothing is written or used.
    for (const [path, body] of [["/owner-codes", { subject: second, codeHash, expiresAt }], ["/owner-codes/redeem",
      { codeHash }], ["/identity-shops", { subject: second, shop: "pilot:x", role: "owner", ref: "owner-x" }],
    ["/identity-shops/remove", { subject: second, shop: "pilot:x", role: "owner", ref: "owner-x" }]] as const) {
      expect((await authWrite(path, body, false)).status).toBe(403);
    }
    // A row names a shop, a role and the link it was written for, or it is not written.
    for (const row of [{ subject: second, shop: "pilot:x", role: "admin", ref: "owner-x" },
      { subject: second, shop: "", role: "owner", ref: "owner-x" }, { subject: second, shop: "pilot:x", role: "owner" }]) {
      expect((await authWrite("/identity-shops", row)).status).toBe(400);
    }
  });

  it("take a row out only while it is still the one its link wrote", async () => {
    const subject = `apple:rows-${crypto.randomUUID()}`;
    expect((await authWrite("/identity-shops", { subject, shop: "pilot:a", role: "owner", ref: "owner-new" })).status)
      .toBe(200);
    // An unlink of an older link of the same shop leaves the newer link's row.
    expect(await (await authWrite("/identity-shops/remove", { subject, shop: "pilot:a", role: "owner",
      ref: "owner-old" })).json()).toEqual({ removed: false });
    const rows = await (await authStub().fetch(`https://auth/identity-shops?subject=${encodeURIComponent(subject)}`))
      .json() as { rows: { shop: string; ref: string }[] };
    expect(rows.rows.map((row) => [row.shop, row.ref])).toEqual([["pilot:a", "owner-new"]]);
    expect(await (await authWrite("/identity-shops/remove", { subject, shop: "pilot:a", role: "owner",
      ref: "owner-new" })).json()).toEqual({ removed: true });
  });
});

describe("the shop and the role", () => {
  it("come from the session and the shop's record, never from the request", async () => {
    const { fon, mali, khaoHom, paNoi } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    const maliTask = await shopTask(mali.tenant);
    const maliRefund = await plantRequest(mali.tenant, maliTask, "money");
    const khaoHomTask = await shopTask(khaoHom.tenant);
    const khaoHomRefund = await plantRequest(khaoHom.tenant, khaoHomTask, "money");
    // A decision names only the option and the revision seen.
    for (const extra of [{ shop: khaoHom.tenant }, { tenant: khaoHom.tenant }, { role: "owner" }]) {
      for (const requestId of [khaoHomRefund, maliRefund]) {
        expect(await decide(asOwnerOfMali, requestId, { ...DECLINE, ...extra })).toEqual({ status: 400,
          body: { error: "invalid_request" } });
      }
    }
    // The listing reads the session's shop: a shop or a role in the query is refused, never read.
    for (const query of [`shop=${encodeURIComponent(khaoHom.tenant)}`, `tenant=${encodeURIComponent(khaoHom.tenant)}`,
      "role=owner"]) {
      expect(await asSession(asOwnerOfMali, "GET", `/v1/approvals?state=open&${query}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    // Asking for a shop session names the shop and nothing else: the shop's record decides the role.
    expect(await asSession(fon.headers, "POST", "/v1/shops/session", { shop: paNoi.tenant, role: "owner" })).toEqual({
      status: 400, body: { error: "invalid_request" } });
    for (const body of [{}, { shop: 42 }, { tenant: paNoi.tenant }, [], "shop"]) {
      expect(await asSession(fon.headers, "POST", "/v1/shops/session", body)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    // A code is for the account that asks for it, and the operator's link names the shop and the code only.
    expect(await asSession(fon.headers, "POST", "/v1/shops/owner-code", { subject: "apple:someone-else" })).toEqual({
      status: 400, body: { error: "invalid_request" } });
    expect((await asSession(fon.headers, "POST", "/v1/shops/owner-code", {})).status).toBe(200);
    expect(await call("/v1/shops/owner-code", { method: "POST", headers: { ...fon.headers,
      "content-type": "application/json" }, body: "{not json" }).then(async (response) =>
      ({ status: response.status, body: await response.json() }))).toEqual({ status: 400, body: { error: "invalid_json" } });
    for (const extra of [{ subject: fon.tenant }, { role: "owner" }, { ownerAccountId: "owner-chosen" }]) {
      expect(await admin("POST", "/v1/admin/shops/owner", { tenant: paNoi.tenant, code: await ownerCode(fon), ...extra }))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: mali.tenant, subject: fon.tenant })).toEqual({
      status: 400, body: { error: "invalid_request" } });
    // Nothing above changed who she is where.
    expect((await openShop(fon, paNoi.tenant)).body.role).toBe("helper");
    expect((await storedRequest(khaoHom.tenant, khaoHomTask, khaoHomRefund)).record.status).toBe("pending");
    expect((await decide(asOwnerOfMali, maliRefund, DECLINE)).status).toBe(200);
  });

  it("an owner's shop session opens no route of the shop's beyond its approvals and routines", async () => {
    const { fon, mali } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    for (const [method, path] of [["GET", "/v1/tenant/export"], ["DELETE", "/v1/tenant/data"],
      ["GET", "/v1/consent/cloud"], ["GET", "/v1/connections"], ["GET", "/v1/schedules"], ["GET", "/v1/shops"],
      ["POST", "/v1/shops/owner-code"]] as const) {
      expect((await asSession(asOwnerOfMali, method, path)).status).toBe(401);
    }
    expect((await asSession(asOwnerOfMali, "PUT", "/v1/consent/cloud", { enabled: false })).status).toBe(401);
    expect((await asSession(asOwnerOfMali, "POST", "/v1/shops/session", { shop: mali.tenant })).status).toBe(401);
    // Passing a request on is a helper's: the owner decides it.
    const refund = await plantRequest(mali.tenant, await shopTask(mali.tenant), "money");
    expect(await asSession(asOwnerOfMali, "POST", `/v1/approvals/${refund}/pass-on`, { note: "Over to you" })).toEqual({
      status: 403, body: { error: "not_a_helper" } });
    expect((await asSession(asOwnerOfMali, "POST", "/v1/people/session", { shop: mali.tenant })).status).toBe(401);
    // The person's routes need the person's own signed-in session: none, and the operator key, are not one.
    for (const headers of [{}, { authorization: "Bearer test-key" }]) {
      expect(await asSession(headers, "GET", "/v1/shops")).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect((await asSession(headers, "POST", "/v1/shops/session", { shop: mali.tenant })).status).toBe(401);
      expect((await asSession(headers, "POST", "/v1/shops/owner-code")).status).toBe(401);
    }
    expect((await asSession(fon.headers, "PUT", "/v1/shops")).status).toBe(405);
    expect((await asSession(fon.headers, "GET", "/v1/shops/session")).status).toBe(405);
  });
});

describe("the owner's routines", () => {
  it("are the linked owner's to read and change through that shop's session alone, and the log names the account",
    async () => {
      const { fon, mali, khaoHom, maliAccount } = await fonsShops();
      const asOwnerOfMali = await shopSession(fon, mali, "owner");
      const asOwnerOfKhaoHom = await shopSession(fon, khaoHom, "owner");
      const routineIds = async (headers: Headers) =>
        (await asSession<{ routines: { id: string }[] }>(headers, "GET", "/v1/routines")).body.routines.map((r) => r.id);
      const created = await asSession<{ routine: { id: string } }>(asOwnerOfMali, "POST", "/v1/routines",
        { name: "Weekly growth brief", action: "brief", trigger: { kind: "weekly", weekdays: [1], at: "08:00" } });
      expect(created.status).toBe(200);
      const id = created.body.routine.id;
      expect(await routineIds(asOwnerOfMali)).toContain(id);
      // Khao Hom's session, Fon's too, neither sees nor changes Baan Mali's routine.
      expect(await routineIds(asOwnerOfKhaoHom)).not.toContain(id);
      expect(await asSession(asOwnerOfKhaoHom, "POST", "/v1/routines/pause", { routineId: id })).toEqual({ status: 404,
        body: { error: "not_found" } });
      // The log names the linked account, as the owner's decisions do.
      expect((await auditEntries(mali.tenant)).find((entry) => entry.action === "routine.created" &&
        entry.subject.routineId === id)).toMatchObject({ actor: { kind: "owner", id: maliAccount } });
      // Once the account is unlinked, its session changes nothing there.
      expect((await unlinkOwner(mali)).status).toBe(200);
      expect(await asSession(asOwnerOfMali, "POST", "/v1/team/pause", {})).toMatchObject({ status: 401,
        body: { error: "unlinked" } });
    });
});

describe("a deleted shop", () => {
  it("leaves every list, and its sessions end", async () => {
    const { fon, mali, khaoHom, paNoi } = await fonsShops();
    const asOwnerOfMali = await shopSession(fon, mali, "owner");
    expect((await tenantDelete(bindings, mali.tenant)).status).toBe(200);
    expect((await asSession(asOwnerOfMali, "GET", "/v1/approvals?state=open")).status).toBe(401);
    expect((await myShops(fon)).body.shops.map((shop) => shop.id)).toEqual([khaoHom.tenant, paNoi.tenant]);
    // No one's index names it any more.
    const rows = await runInDurableObject(authStub(), async (_instance, state) =>
      [...(await state.storage.list({ prefix: "identity-shops:" })).values()]);
    expect(JSON.stringify(rows)).not.toContain(mali.tenant);
  });

  it("is not the person's own data: deleting that keeps their links and drops their waiting code", async () => {
    const fon = await signIn();
    const shop = await setupShop();
    await linkAsOwner(shop, fon);
    const waiting = await ownerCode(fon);
    expect((await tenantDelete(bindings, fon.tenant)).status).toBe(200);
    expect(await linkOwner(await setupShop("Khao Hom"), waiting)).toEqual({ status: 404, body: { error: "unknown_code" } });
    const rows = await runInDurableObject(authStub(), async (_instance, state) =>
      state.storage.get<{ shop: string; role: string }[]>(`identity-shops:${encodeURIComponent(fon.tenant)}`));
    expect(rows?.map((row) => [row.shop, row.role])).toEqual([[shop.tenant, "owner"]]);
  });
});
