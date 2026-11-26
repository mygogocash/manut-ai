import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { openSecret, type SealedSecret } from "../src/cred-crypto";
import { vaultCall } from "../src/sign-in-vault";
import { tenantSession } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  callWith,
  emailSignIn,
  failingWhere,
  joinHelper,
  linkedOwner,
  setupShop,
  signIn as appleSignIn,
  type Shop,
} from "./people-fixtures";

// The owner's side of the shop's vault and outposts (docs/browser-control.md, "The owner's Connections"; the contract is
// docs/pilot-api.md, "The owner's vault and outposts"). The desktop's Customize › Connections reads the shop's sign-ins and
// outposts with the owner's own session, types a new password into the vault, and renames or removes an outpost. Each
// route takes who is calling from the session alone: an owner session of the shop's linked account, or the shop's own
// signed-in session. A helper's session is refused. Each change goes through the same operation of the shop's vault as the
// operator's route, and the log names the owner by id only.

// Committed test-only vault key, matching wrangler.test.json (cred-vault.test.ts reads it the same way).
const VAULT_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
// Made up for each run and never a real password, so a search for one finds only what this file sent.
const PASSWORD = `pw-old-${crypto.randomUUID()}`;
const NEW_PASSWORD = `pw-new-${crypto.randomUUID()}`;
const SITE = "Shopee Seller Centre";
const ORIGINS = ["https://seller.shopee.co.th"];
const USERNAME = "baan.mali@example.com";

type SignIn = { id: string; site: string; origins: string[]; username: string; members: string[];
  state: "working" | "broken"; passwordSet: boolean; passwordSetAt: string; brokenAt: string | null;
  brokenBy: string | null; lastUsedAt: string | null; lastUsedBy: string | null; createdAt: string };
type Outpost = { id: string; name: string; kind: string; status: string; lastHeartbeatAt: string | null;
  createdAt: string };
type Headers = { authorization?: string };

afterEach(() => {
  vi.restoreAllMocks();
});

/// A sign-in the operator adds to the shop's vault, as the console does.
async function addSignIn(tenant: string, overrides: Record<string, unknown> = {}): Promise<SignIn> {
  const made = await admin<{ signIn: SignIn }>("POST", "/v1/admin/vault/sign-ins", { tenant, site: SITE,
    origins: ORIGINS, username: USERNAME, password: PASSWORD, members: ["nam", "ton"], ...overrides });
  expect(made.status).toBe(200);
  return made.body.signIn;
}

/// An outpost the operator registers for the shop, with its credential.
async function addOutpost(tenant: string, name = "Cloud outpost", kind = "cloud"):
  Promise<{ outpost: Outpost; credential: string }> {
  const made = await admin<{ outpost: Outpost; credential: string }>("POST", "/v1/admin/outposts",
    { tenant, name, kind });
  expect(made.status).toBe(200);
  return made.body;
}

/// The operator's list of the shop's sign-ins and outposts, which the owner's must equal.
async function operatorSignIns(tenant: string): Promise<SignIn[]> {
  const listed = await admin<{ signIns: SignIn[] }>("GET", `/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body.signIns;
}

async function operatorOutposts(tenant: string): Promise<Outpost[]> {
  const listed = await admin<{ outposts: Outpost[] }>("GET", `/v1/admin/outposts?tenant=${encodeURIComponent(tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body.outposts;
}

/// What the shop's vault holds for a sign-in, as stored: the seal, and everything kept beside it.
async function stored(tenant: string, signInId: string): Promise<Record<string, unknown>> {
  const vault = bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
  const record = await runInDurableObject(vault, (_instance, state) =>
    state.storage.get<Record<string, unknown>>(`signin:${signInId}`));
  expect(record).toBeDefined();
  return record!;
}

async function sealedPassword(tenant: string, signInId: string): Promise<string> {
  return openSecret((await stored(tenant, signInId)).sealed as SealedSecret, VAULT_KEY);
}

/// A request with a bearer credential: the answer's status and its text, as it left the Worker.
async function send(headers: Headers, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await call(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: response.status, text: await response.text() };
}

const listSignIns = (headers: Headers) => asSession<{ tenant: string; signIns: SignIn[]; error?: string }>(headers, "GET",
  "/v1/vault/sign-ins");
const listOutposts = (headers: Headers) => asSession<{ tenant: string; outposts: Outpost[]; error?: string }>(headers, "GET",
  "/v1/vault/outposts");
const changePassword = (headers: Headers, body: unknown) => asSession<{ signIn?: SignIn; error?: string }>(headers, "POST",
  "/v1/vault/sign-ins/password", body);
const rename = (headers: Headers, body: unknown) => asSession<{ outpost?: Outpost; error?: string }>(headers, "POST",
  "/v1/vault/outposts/rename", body);
const remove = (headers: Headers, body: unknown) => asSession<Record<string, unknown>>(headers, "POST",
  "/v1/vault/outposts/remove", body);

function heartbeat(tenant: string, outpostId: string, credential: string) {
  return call("/v1/outposts/heartbeat", { method: "POST", headers: { authorization: `Bearer ${credential}`,
    "content-type": "application/json" }, body: JSON.stringify({ tenant, outpostId }) });
}

/// Every route here with a body it would take, so a refusal can be shown on each. Adding a sign-in and choosing who may
/// use one are tested for what they do in owner-sign-ins.test.ts, and changing one's account or addresses and removing one
/// in sign-in-changes.test.ts.
function everyRoute(signInId: string, outpostId: string): [string, string, unknown][] {
  return [
    ["GET", "/v1/vault/sign-ins", undefined],
    ["POST", "/v1/vault/sign-ins", { site: "Carrier portal", origins: ["https://track.carrier.example"],
      username: "baan.mali", password: NEW_PASSWORD, members: ["nam"] }],
    ["POST", "/v1/vault/sign-ins/password", { signInId, password: NEW_PASSWORD }],
    ["POST", "/v1/vault/sign-ins/members", { signInId, members: ["kit"] }],
    ["POST", "/v1/vault/sign-ins/change", { signInId, origins: ["https://track.carrier.example"], username: "baan.mali",
      password: NEW_PASSWORD }],
    ["POST", "/v1/vault/sign-ins/change", { signInId, origins: [ORIGINS[0]], username: USERNAME, password: null }],
    ["POST", "/v1/vault/sign-ins/remove", { signInId }],
    ["GET", "/v1/vault/outposts", undefined],
    ["POST", "/v1/vault/outposts/rename", { outpostId, name: "Fon's MacBook" }],
    ["POST", "/v1/vault/outposts/remove", { outpostId }],
  ];
}

/// The entries the shop's log holds about the vault and the outposts, oldest first, without their ids and times.
async function vaultEntries(tenant: string) {
  return (await auditEntries(tenant)).reverse()
    .filter((entry) => entry.action.startsWith("signin.") || entry.action.startsWith("outpost."))
    .map(({ actor, action, subject, outcome }) => ({ actor, action, subject, outcome }));
}

/// A pilot shop with its owner's linked account, a sign-in and a cloud outpost the operator added.
async function shopWithVault(): Promise<{ shop: Shop; accountId: string; owner: Headers; signIn: SignIn;
  outpost: Outpost; credential: string }> {
  const shop = await setupShop();
  const fon = await linkedOwner(shop);
  const signIn = await addSignIn(shop.tenant);
  const { outpost, credential } = await addOutpost(shop.tenant);
  return { shop, accountId: fon.accountId, owner: fon.headers, signIn, outpost, credential };
}

describe("the owner's view of the shop's vault and outposts", () => {
  it("lists the shop's sign-ins and outposts to an owner session as the operator sees them, and never a secret", async () => {
    const { shop, owner, credential } = await shopWithVault();
    const signIns = await send(owner, "GET", "/v1/vault/sign-ins");
    expect(signIns.status).toBe(200);
    expect(JSON.parse(signIns.text)).toEqual({ tenant: shop.tenant, signIns: await operatorSignIns(shop.tenant) });
    const [listed] = (JSON.parse(signIns.text) as { signIns: SignIn[] }).signIns;
    expect(listed).toEqual({ id: expect.any(String), site: SITE, origins: ORIGINS, username: USERNAME,
      members: ["nam", "ton"], state: "working", passwordSet: true, passwordSetAt: expect.any(String), brokenAt: null,
      brokenBy: null, lastUsedAt: null, lastUsedBy: null, createdAt: expect.any(String) });

    const outposts = await send(owner, "GET", "/v1/vault/outposts");
    expect(outposts.status).toBe(200);
    expect(JSON.parse(outposts.text)).toEqual({ tenant: shop.tenant, outposts: await operatorOutposts(shop.tenant) });

    // Neither answer holds the password, its seal, the outpost's credential or the credential's digest.
    const seal = (await stored(shop.tenant, listed!.id)).sealed as SealedSecret;
    for (const text of [signIns.text, outposts.text]) {
      for (const secret of [PASSWORD, seal.data, seal.iv, credential, await sha256Hex(credential)]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/sealed|credential/i);
    }
  });

  it("lists them to the shop's own signed-in session, for its own tenant", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const signIn = await addSignIn(tenant);
    const { outpost } = await addOutpost(tenant);
    expect(await listSignIns(headers)).toEqual({ status: 200, body: { tenant, signIns: [signIn] } });
    expect(await listOutposts(headers)).toEqual({ status: 200, body: { tenant, outposts: [outpost] } });
  });

  it("answers a person's own sign-in not_found on every route, and keeps nothing for its tenant, which is no shop", async () => {
    // The review (24 Nov 2026): once email sign-in is on, a stranger would own a vault of their own `email:` tenant here,
    // storing sign-ins in it. Apple's sign-in is answered the same: neither tenant is a shop.
    for (const person of [await emailSignIn(`vault-stranger-${crypto.randomUUID()}@example.org`), await appleSignIn()]) {
      for (const [method, path, body] of everyRoute("signin-x", "outpost-x")) {
        expect([path, await send(person.headers, method, path, body)]).toEqual([path,
          { status: 404, text: JSON.stringify({ error: "not_found" }) }]);
      }
      expect(await operatorSignIns(person.tenant)).toEqual([]);
      expect(await operatorOutposts(person.tenant)).toEqual([]);
      expect(await vaultEntries(person.tenant)).toEqual([]);
      // Its body is still read first, so a body that names a shop is refused as one.
      expect(await send(person.headers, "POST", "/v1/vault/sign-ins/password", { signInId: "x", password: "y",
        tenant: "pilot:x" })).toEqual({ status: 400, text: JSON.stringify({ error: "invalid_request" }) });
    }
  });

  it("answers an empty vault with empty lists", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    expect(await listSignIns(fon.headers)).toEqual({ status: 200, body: { tenant: shop.tenant, signIns: [] } });
    expect(await listOutposts(fon.headers)).toEqual({ status: 200, body: { tenant: shop.tenant, outposts: [] } });
  });

  it("refuses a helper's session on every route, and changes nothing", async () => {
    const { shop, signIn, outpost, credential } = await shopWithVault();
    const mint = await joinHelper(shop);
    const before = await vaultEntries(shop.tenant);
    for (const [method, path, body] of everyRoute(signIn.id, outpost.id)) {
      const answer = await send(mint.headers, method, path, body);
      expect(answer, `${method} ${path}`).toEqual({ status: 403, text: JSON.stringify({ error: "owner_only" }) });
    }
    // Nothing was added, and the sign-in is as it was, its members included.
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect(await operatorOutposts(shop.tenant)).toEqual([{ ...outpost, status: "asleep" }]);
    expect((await heartbeat(shop.tenant, outpost.id, credential)).status).toBe(200);
    expect(await vaultEntries(shop.tenant)).toEqual(before);
  });

  it("refuses no session, the operator's key, an outpost's credential and a made-up session on every route", async () => {
    const { shop, signIn, outpost, credential } = await shopWithVault();
    // A helper session's shape, naming the shop, that the shop's record does not hold.
    const madeUp = `mhs1.${btoa(shop.tenant).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${"0".repeat(64)}`;
    for (const headers of [{}, { authorization: "Bearer test-key" }, { authorization: `Bearer ${credential}` },
      { authorization: "Bearer mos1.not-a-session" }, { authorization: `Bearer ${madeUp}` }]) {
      for (const [method, path, body] of everyRoute(signIn.id, outpost.id)) {
        const answer = await send(headers, method, path, body);
        expect(answer, `${method} ${path}`).toEqual({ status: 401, text: JSON.stringify({ error: "unauthorized" }) });
      }
    }
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await operatorOutposts(shop.tenant)).toHaveLength(1);
  });

  it("refuses an owner session whose account the operator unlinked", async () => {
    const { shop, owner, signIn, outpost } = await shopWithVault();
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    for (const [method, path, body] of everyRoute(signIn.id, outpost.id)) {
      const answer = await asSession<{ error: string; unlinkedAt: string }>(owner, method, path, body);
      expect(answer.status, `${method} ${path}`).toBe(401);
      expect(answer.body.error).toBe("unlinked");
    }
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
  });

  it("answers 503 when the shop's record cannot be read to check the session, before anything else", async () => {
    const { shop, owner, signIn } = await shopWithVault();
    const down = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/people/owner-session-check");
    const answer = await callWith(down, "/v1/vault/sign-ins/password", { method: "POST", headers: owner,
      body: { signInId: signIn.id, password: NEW_PASSWORD } });
    expect(answer).toEqual({ status: 503, body: { error: "people_unavailable" } });
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
  });

  it("takes each route's own methods, after the session", async () => {
    const { owner } = await shopWithVault();
    // The shop's sign-ins take two: `GET` lists them and `POST` adds one. Every other route takes one.
    for (const [method, path] of [["PUT", "/v1/vault/sign-ins"], ["DELETE", "/v1/vault/sign-ins"],
      ["PATCH", "/v1/vault/sign-ins"], ["GET", "/v1/vault/sign-ins/password"], ["GET", "/v1/vault/sign-ins/members"],
      ["PUT", "/v1/vault/sign-ins/members"], ["GET", "/v1/vault/sign-ins/change"], ["PATCH", "/v1/vault/sign-ins/change"],
      ["GET", "/v1/vault/sign-ins/remove"], ["DELETE", "/v1/vault/sign-ins/remove"], ["POST", "/v1/vault/outposts"],
      ["PUT", "/v1/vault/outposts"], ["GET", "/v1/vault/outposts/rename"], ["GET", "/v1/vault/outposts/remove"]] as const) {
      const answer = await send(owner, method, path, method === "GET" || method === "DELETE" ? undefined : {});
      expect(answer, `${method} ${path}`).toEqual({ status: 405, text: JSON.stringify({ error: "method_not_allowed" }) });
    }
    // Paths beside them are not routes at all, and the outposts' own namespace takes no owner's list.
    for (const path of ["/v1/vault", "/v1/vault/sign-ins/reseal", "/v1/vault/sign-ins/broken", "/v1/vault/outposts/credential",
      "/v1/outposts"]) {
      expect((await send(owner, "POST", path, {})).status, path).toBe(404);
    }
  });

  it("refuses a query that names the shop, the tenant or a role: the session decides those", async () => {
    const { owner } = await shopWithVault();
    for (const path of ["/v1/vault/sign-ins?tenant=pilot:another", "/v1/vault/outposts?shop=pilot:another",
      "/v1/vault/outposts/rename?role=owner"]) {
      const answer = await send(owner, path.startsWith("/v1/vault/outposts/rename") ? "POST" : "GET", path,
        path.startsWith("/v1/vault/outposts/rename") ? {} : undefined);
      expect(answer, path).toEqual({ status: 400, text: JSON.stringify({ error: "invalid_request" }) });
    }
  });
});

describe("the owner typing a new password into the vault", () => {
  it("seals it in place of the old one, mends a broken sign-in, and answers no password", async () => {
    const { shop, accountId, owner, signIn } = await shopWithVault();
    // A member reports that the site refused the saved password, as a worker's port does.
    const broken = await vaultCall(bindings, shop.tenant, "POST", "/sign-ins/broken", { signInId: signIn.id, member: "nam" });
    expect(broken.status).toBe(200);
    expect((await operatorSignIns(shop.tenant))[0]?.state).toBe("broken");

    const changed = await send(owner, "POST", "/v1/vault/sign-ins/password", { signInId: signIn.id, password: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.text).not.toContain(NEW_PASSWORD);
    expect(changed.text).not.toContain(PASSWORD);
    const { signIn: view } = JSON.parse(changed.text) as { signIn: SignIn };
    expect(view).toEqual({ ...signIn, state: "working", brokenAt: null, brokenBy: null, passwordSetAt: expect.any(String) });
    expect(Date.parse(view.passwordSetAt)).toBeGreaterThanOrEqual(Date.parse(signIn.passwordSetAt));
    expect(await operatorSignIns(shop.tenant)).toEqual([view]);

    // Sealed with the vault's own keys, as the operator's route seals it, and kept nowhere in the clear.
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(NEW_PASSWORD);
    expect(JSON.stringify(await stored(shop.tenant, signIn.id))).not.toContain(NEW_PASSWORD);

    // The log names the owner's linked account and the sign-in, by id only.
    expect((await vaultEntries(shop.tenant)).filter((entry) => entry.action === "signin.password_replaced")).toEqual([
      { actor: { kind: "owner", id: accountId }, action: "signin.password_replaced", subject: { signInId: signIn.id },
        outcome: "ok" },
    ]);
  });

  it("names the shop's own session in the log when it is the one that typed it", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const signIn = await addSignIn(tenant);
    expect((await changePassword(headers, { signInId: signIn.id, password: NEW_PASSWORD })).status).toBe(200);
    expect(await sealedPassword(tenant, signIn.id)).toBe(NEW_PASSWORD);
    expect((await vaultEntries(tenant)).filter((entry) => entry.action === "signin.password_replaced")).toEqual([
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.password_replaced",
        subject: { signInId: signIn.id }, outcome: "ok" },
    ]);
  });

  it("keeps the typed password out of every answer, every audit entry and every log line", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const { shop, owner, signIn, outpost } = await shopWithVault();
    const other = await shopWithVault();
    const mint = await joinHelper(shop);
    const answers: string[] = [];
    const kept = async (headers: Headers, body: unknown, path = "/v1/vault/sign-ins/password") => {
      const answer = await send(headers, "POST", path, body);
      answers.push(answer.text);
      return answer;
    };

    // Every way the password can be sent here: taken, and each refusal on the way to it.
    expect((await kept(owner, { signInId: signIn.id, password: NEW_PASSWORD })).status).toBe(200);
    expect((await kept(owner, { signInId: signIn.id, password: NEW_PASSWORD, tenant: other.shop.tenant })).status).toBe(400);
    expect((await kept(owner, { signInId: signIn.id, password: [NEW_PASSWORD] })).status).toBe(400);
    expect((await kept(owner, { signInId: other.signIn.id, password: NEW_PASSWORD })).status).toBe(404);
    expect((await kept(owner, { signInId: crypto.randomUUID(), password: NEW_PASSWORD })).status).toBe(404);
    expect((await kept(owner, { signInId: signIn.id, password: `${NEW_PASSWORD}${"x".repeat(1024)}` })).status).toBe(400);
    expect((await kept(owner, `{"signInId":"${signIn.id}","password":"${NEW_PASSWORD}"`)).status).toBe(400);
    expect((await kept(mint.headers, { signInId: signIn.id, password: NEW_PASSWORD })).status).toBe(403);
    expect((await kept({}, { signInId: signIn.id, password: NEW_PASSWORD })).status).toBe(401);
    // Sent to the wrong route by mistake, it is refused there without being echoed either.
    expect((await kept(owner, { outpostId: outpost.id, password: NEW_PASSWORD }, "/v1/vault/outposts/remove")).status).toBe(400);
    answers.push((await send(owner, "GET", "/v1/vault/sign-ins")).text);

    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(NEW_PASSWORD);
    expect(await sealedPassword(other.shop.tenant, other.signIn.id)).toBe(PASSWORD);
    expect(await operatorOutposts(shop.tenant)).toHaveLength(1);
    for (const answer of answers) expect(answer).not.toContain(NEW_PASSWORD.slice(0, 20));
    const entries = [...await auditEntries(shop.tenant), ...await auditEntries(other.shop.tenant)];
    expect(JSON.stringify(entries)).not.toContain(NEW_PASSWORD.slice(0, 20));
    expect(logged.join("\n")).not.toContain(NEW_PASSWORD.slice(0, 20));
  });

  it("refuses a body that is not exactly a sign-in's id and a password, and changes nothing", async () => {
    const { shop, owner, signIn } = await shopWithVault();
    const bodies: unknown[] = [
      { signInId: signIn.id, password: NEW_PASSWORD, tenant: shop.tenant },
      { signInId: signIn.id, password: NEW_PASSWORD, shop: shop.tenant },
      { signInId: signIn.id, password: NEW_PASSWORD, role: "owner" },
      { signInId: signIn.id },
      { password: NEW_PASSWORD },
      { signInId: signIn.id, password: 1234 },
      { signInId: signIn.id, password: null },
      { signInId: [signIn.id], password: NEW_PASSWORD },
      [signIn.id, NEW_PASSWORD],
      "password",
    ];
    for (const body of bodies) {
      expect(await changePassword(owner, body), JSON.stringify(body)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    expect(await send(owner, "POST", "/v1/vault/sign-ins/password", "{not json")).toEqual({ status: 400,
      text: JSON.stringify({ error: "invalid_json" }) });
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect((await vaultEntries(shop.tenant)).some((entry) => entry.action === "signin.password_replaced")).toBe(false);
  });

  it("answers the vault's own refusals: a password it does not take, and a sign-in that is not the shop's", async () => {
    const { shop, owner, signIn } = await shopWithVault();
    const other = await shopWithVault();
    const gone = await addSignIn(shop.tenant, { site: "Carrier portal" });
    expect((await admin("POST", "/v1/admin/vault/sign-ins/remove", { tenant: shop.tenant, signInId: gone.id })).status)
      .toBe(200);
    for (const [body, status, error] of [
      [{ signInId: signIn.id, password: "" }, 400, "invalid_password"],
      [{ signInId: signIn.id, password: "x".repeat(1025) }, 400, "invalid_password"],
      [{ signInId: crypto.randomUUID(), password: NEW_PASSWORD }, 404, "sign_in_not_found"],
      [{ signInId: "not-an-id", password: NEW_PASSWORD }, 404, "sign_in_not_found"],
      [{ signInId: other.signIn.id, password: NEW_PASSWORD }, 404, "sign_in_not_found"],
      [{ signInId: gone.id, password: NEW_PASSWORD }, 404, "sign_in_not_found"],
    ] as const) {
      expect(await changePassword(owner, body), JSON.stringify(body)).toEqual({ status, body: { error } });
    }
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect(await sealedPassword(other.shop.tenant, other.signIn.id)).toBe(PASSWORD);
    // A password of exactly 1,024 characters is taken, as the operator's route takes it.
    expect((await changePassword(owner, { signInId: signIn.id, password: "y".repeat(1024) })).status).toBe(200);
  });
});

describe("the owner renaming and removing an outpost", () => {
  it("renames one, trimmed, keeps its credential working, and logs outpost.renamed", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    const registered = await asSession<{ outpost: Outpost; credential: string }>(fon.headers, "POST",
      "/v1/outposts/register", { name: "This Mac", kind: "this_mac" });
    expect(registered.status).toBe(200);
    const { outpost, credential } = registered.body;

    const renamed = await rename(fon.headers, { outpostId: outpost.id, name: "  Fon's MacBook  " });
    expect(renamed).toEqual({ status: 200, body: { outpost: { ...outpost, name: "Fon's MacBook" } } });
    expect(await operatorOutposts(shop.tenant)).toEqual([{ ...outpost, name: "Fon's MacBook" }]);
    // Only the name changed: the outpost still beats with the credential it was given.
    expect((await heartbeat(shop.tenant, outpost.id, credential)).status).toBe(200);
    // A Thai name of 80 letters is taken, as at registration.
    const thai = "ร้านบ้านมะลิ".repeat(7).slice(0, 80);
    expect((await rename(fon.headers, { outpostId: outpost.id, name: thai })).body.outpost?.name).toBe(thai);

    const entries = (await vaultEntries(shop.tenant)).filter((entry) => entry.action === "outpost.renamed");
    expect(entries).toEqual([
      { actor: { kind: "owner", id: fon.accountId }, action: "outpost.renamed", subject: { outpostId: outpost.id },
        outcome: "ok" },
      { actor: { kind: "owner", id: fon.accountId }, action: "outpost.renamed", subject: { outpostId: outpost.id },
        outcome: "ok" },
    ]);
    // The log keeps ids only: never the name the owner typed.
    expect(JSON.stringify(await auditEntries(shop.tenant))).not.toContain("Fon's MacBook");
  });

  it("refuses a name the vault does not take, and a body that is not exactly an outpost's id and a name", async () => {
    const { shop, owner, outpost } = await shopWithVault();
    for (const [body, error] of [
      [{ outpostId: outpost.id, name: "   " }, "invalid_name"],
      [{ outpostId: outpost.id, name: "x".repeat(81) }, "invalid_name"],
      [{ outpostId: outpost.id, name: "Mac\u0007" }, "invalid_name"],
      [{ outpostId: outpost.id, name: "Mac", tenant: shop.tenant }, "invalid_request"],
      [{ outpostId: outpost.id, name: 7 }, "invalid_request"],
      [{ outpostId: outpost.id }, "invalid_request"],
      [{ name: "Mac" }, "invalid_request"],
    ] as const) {
      expect(await rename(owner, body), JSON.stringify(body)).toEqual({ status: 400, body: { error } });
    }
    for (const outpostId of [crypto.randomUUID(), "not-an-id"]) {
      expect(await rename(owner, { outpostId, name: "Mac" })).toEqual({ status: 404, body: { error: "outpost_not_found" } });
    }
    expect(await operatorOutposts(shop.tenant)).toEqual([{ ...outpost, status: "asleep" }]);
    expect((await vaultEntries(shop.tenant)).some((entry) => entry.action === "outpost.renamed")).toBe(false);
  });

  it("removes one: its credential stops working at once, and the log says the owner did it", async () => {
    const { shop, accountId, owner, outpost, credential } = await shopWithVault();
    expect((await heartbeat(shop.tenant, outpost.id, credential)).status).toBe(200);
    const removed = await remove(owner, { outpostId: outpost.id });
    expect(removed).toEqual({ status: 200, body: { removed: true, outpostId: outpost.id, stepsRefused: 0,
      grantsRefused: 0 } });
    expect((await heartbeat(shop.tenant, outpost.id, credential)).status).toBe(401);
    expect(await operatorOutposts(shop.tenant)).toEqual([]);
    expect((await vaultEntries(shop.tenant)).filter((entry) => entry.action === "outpost.removed")).toEqual([
      { actor: { kind: "owner", id: accountId }, action: "outpost.removed", subject: { outpostId: outpost.id },
        outcome: "ok" },
    ]);
    // Once only.
    expect(await remove(owner, { outpostId: outpost.id })).toEqual({ status: 404, body: { error: "outpost_not_found" } });
  });

  it("refuses a body that is not exactly an outpost's id, and removes nothing", async () => {
    const { shop, owner, outpost } = await shopWithVault();
    for (const body of [{ outpostId: outpost.id, tenant: shop.tenant }, { outpostId: outpost.id, role: "owner" }, {},
      { outpostId: 7 }, [outpost.id]]) {
      expect(await remove(owner, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await operatorOutposts(shop.tenant)).toHaveLength(1);
  });

  it("never reaches another shop's outpost or sign-in, even one the same person owns", async () => {
    // One Apple account owns both shops, and holds an owner session for each.
    const person = await appleSignIn();
    const a = await setupShop();
    const atA = await linkedOwner(a, person);
    const b = await setupShop("Ran Pa Noi");
    const atB = await linkedOwner(b, person);
    const signInB = await addSignIn(b.tenant);
    const { outpost: outpostB, credential: credentialB } = await addOutpost(b.tenant);

    // Baan Mali's session names Baan Mali, so Ran Pa Noi's records are not there for it.
    expect(await changePassword(atA.headers, { signInId: signInB.id, password: NEW_PASSWORD }))
      .toEqual({ status: 404, body: { error: "sign_in_not_found" } });
    expect(await rename(atA.headers, { outpostId: outpostB.id, name: "Mine now" }))
      .toEqual({ status: 404, body: { error: "outpost_not_found" } });
    expect(await remove(atA.headers, { outpostId: outpostB.id })).toEqual({ status: 404, body: { error: "outpost_not_found" } });
    expect(await listSignIns(atA.headers)).toEqual({ status: 200, body: { tenant: a.tenant, signIns: [] } });
    expect(await listOutposts(atA.headers)).toEqual({ status: 200, body: { tenant: a.tenant, outposts: [] } });

    // Ran Pa Noi's own session reaches them, untouched.
    expect(await listSignIns(atB.headers)).toEqual({ status: 200, body: { tenant: b.tenant, signIns: [signInB] } });
    expect(await sealedPassword(b.tenant, signInB.id)).toBe(PASSWORD);
    expect((await heartbeat(b.tenant, outpostB.id, credentialB)).status).toBe(200);
  });
});
