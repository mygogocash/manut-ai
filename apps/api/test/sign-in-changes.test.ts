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
  joinHelper,
  linkedOwner,
  setupShop,
  signIn as appleSignIn,
} from "./people-fixtures";

// The owner removing a sign-in from the shop's vault and changing its account or its addresses from their own session, and
// the operator choosing who may use one (docs/browser-control.md, "Removing and changing a sign-in"; the contract is
// docs/pilot-api.md, "The owner's vault and outposts"). A removal goes through the vault's own removal, the operator's, so a
// grant issued before it is refused at its redeem. A change goes through one vault operation that checks every value as
// adding does, and lets no stored password be typed at an address, or for an account, it was not given for unless the same
// change types it again: only taking addresses away may go without it. The operator's members route goes through the vault
// operation the owner's uses, with its refusals. The refusals every owner route shares (no session, a helper, an unlinked
// account, a person's own sign-in, the method, the query) are in owner-vault.test.ts, whose list of routes holds these.

// Committed test-only vault key, matching wrangler.test.json (cred-vault.test.ts reads it the same way).
const VAULT_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
// Made up for each run and never a real password, so a search for one finds only what this file sent.
const PASSWORD = `pw-given-${crypto.randomUUID()}`;
const NEW_PASSWORD = `pw-typed-again-${crypto.randomUUID()}`;
const SITE = "Shopee Seller Centre";
const ORIGINS = ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"];
const USERNAME = "baan.mali@example.com";
const OTHER_USERNAME = "orders@baanmali.example";
/// An address the password was never given for: where someone holding a stolen session would want it typed.
const ELSEWHERE = "https://seller-centre.attacker.example";

type SignIn = { id: string; site: string; origins: string[]; username: string; members: string[];
  state: "working" | "broken"; passwordSet: boolean; passwordSetAt: string; brokenAt: string | null;
  brokenBy: string | null; lastUsedAt: string | null; lastUsedBy: string | null; createdAt: string };
type Headers = { authorization?: string };
type Outpost = { outpostId: string; credential: string; credentialHash: string };

/// The two entries a change of a sign-in's account or addresses writes: with the password typed again, or addresses only taken
/// away.
const CHANGES = ["signin.changed", "signin.narrowed"];

afterEach(() => {
  vi.restoreAllMocks();
});

/// A request with a bearer credential: the answer's status and its text, as it left the Worker.
async function send(headers: Headers, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await call(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: response.status, text: await response.text() };
}

const remove = (headers: Headers, body: unknown) => asSession<{ removed?: true; signInId?: string; error?: string }>(headers,
  "POST", "/v1/vault/sign-ins/remove", body);
const change = (headers: Headers, body: unknown) => asSession<{ signIn?: SignIn; error?: string }>(headers, "POST",
  "/v1/vault/sign-ins/change", body);
const ownerMembers = (headers: Headers, body: unknown) => asSession<{ signIn?: SignIn; error?: string }>(headers, "POST",
  "/v1/vault/sign-ins/members", body);

/// The operator's own routes, with the shop named, as the console sends them.
const operatorAdd = (tenant: string, fields: Record<string, unknown>) =>
  admin<{ signIn?: SignIn; error?: string }>("POST", "/v1/admin/vault/sign-ins", { tenant, ...fields });
const operatorMembers = (fields: Record<string, unknown>) =>
  admin<{ signIn?: SignIn; error?: string }>("POST", "/v1/admin/vault/sign-ins/members", fields);

async function operatorSignIns(tenant: string): Promise<SignIn[]> {
  const listed = await admin<{ signIns: SignIn[] }>("GET", `/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body.signIns;
}

const vault = (tenant: string) => bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));

/// What the shop's vault holds for a sign-in, as stored: the seal, and everything kept beside it.
async function stored(tenant: string, signInId: string): Promise<Record<string, unknown>> {
  const record = await runInDurableObject(vault(tenant), (_instance, state) =>
    state.storage.get<Record<string, unknown>>(`signin:${signInId}`));
  expect(record).toBeDefined();
  return record!;
}

async function sealedPassword(tenant: string, signInId: string): Promise<string> {
  return openSecret((await stored(tenant, signInId)).sealed as SealedSecret, VAULT_KEY);
}

/// The entries the shop's log holds about its sign-ins, oldest first, without their ids and times.
async function signInEntries(tenant: string) {
  return (await auditEntries(tenant)).reverse()
    .filter((entry) => entry.action.startsWith("signin."))
    .map(({ actor, action, subject, outcome, reason }) => ({ actor, action, subject, outcome,
      ...(reason !== undefined ? { reason } : {}) }));
}

/// Collects every line the Worker and its objects write to the console while a test runs.
function consoleLines(): string[] {
  const logged: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return logged;
}

/// A pilot shop with its owner's linked account, and a sign-in the operator added for Nam and Ton.
async function shopWithSignIn() {
  const shop = await setupShop();
  const fon = await linkedOwner(shop);
  const added = await operatorAdd(shop.tenant, { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
    members: ["nam", "ton"] });
  expect(added.status).toBe(200);
  return { shop, fon, signIn: added.body.signIn! };
}

/// A cloud outpost the operator registers for the shop, beating, so a grant can be issued to it.
async function onlineOutpost(tenant: string): Promise<Outpost> {
  const registered = await admin<{ outpost: { id: string }; credential: string }>("POST", "/v1/admin/outposts",
    { tenant, name: "Cloud outpost", kind: "cloud" });
  expect(registered.status).toBe(200);
  const { outpost, credential } = registered.body;
  const beat = await call("/v1/outposts/heartbeat", { method: "POST", headers: { authorization: `Bearer ${credential}`,
    "content-type": "application/json" }, body: JSON.stringify({ tenant, outpostId: outpost.id }) });
  expect(beat.status).toBe(200);
  return { outpostId: outpost.id, credential, credentialHash: await sha256Hex(credential) };
}

/// A grant for `member`'s attempt as the job flow's port asks the vault for one. The attempt's ids are made up: the vault
/// only binds them, and the redeem halves below go straight to the vault.
async function grant(tenant: string, signInId: string, outpost: Outpost, member = "nam") {
  const response = await vaultCall(bindings, tenant, "POST", "/sign-in-grants",
    { signInId, outpostId: outpost.outpostId, member, taskId: `task-${member}`, attemptId: `attempt-${member}` });
  return { status: response.status, body: (await response.json()) as { grant?: { grantId: string }; error?: string } };
}

async function grantId(tenant: string, signInId: string, outpost: Outpost, member = "nam"): Promise<string> {
  const issued = await grant(tenant, signInId, outpost, member);
  expect(issued.status).toBe(200);
  return issued.body.grant!.grantId;
}

/// The redeem's two halves in the vault, as an outpost's redeem makes them: the claim uses the grant up, and the open
/// answers what to type.
async function redeemHalf(tenant: string, half: "claim" | "open", id: string, outpost: Outpost) {
  const response = await vaultCall(bindings, tenant, "POST", `/sign-in-grants/${half}`,
    { grantId: id, outpostId: outpost.outpostId, credentialHash: outpost.credentialHash });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/// What the vault would have an outpost type for a grant: both halves, and the open's answer.
async function typed(tenant: string, id: string, outpost: Outpost) {
  expect((await redeemHalf(tenant, "claim", id, outpost)).status).toBe(200);
  return redeemHalf(tenant, "open", id, outpost);
}

/// The whole redeem as an outpost sends it, with its own credential.
async function redeem(tenant: string, id: string, outpost: Outpost) {
  const response = await call("/v1/outposts/redeem", { method: "POST", headers: {
    authorization: `Bearer ${outpost.credential}`, "content-type": "application/json" },
  body: JSON.stringify({ tenant, outpostId: outpost.outpostId, grantId: id }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the owner removing a sign-in", () => {
  it("removes it through the operator's own removal: account and seal wiped, gone from the list, logged by id only", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const removed = await send(fon.headers, "POST", "/v1/vault/sign-ins/remove", { signInId: signIn.id });
    expect(removed).toEqual({ status: 200, text: JSON.stringify({ removed: true, signInId: signIn.id }) });
    expect(await operatorSignIns(shop.tenant)).toEqual([]);
    expect(await asSession(fon.headers, "GET", "/v1/vault/sign-ins")).toEqual({ status: 200,
      body: { tenant: shop.tenant, signIns: [] } });
    // The tombstone the operator's removal leaves: no account and no seal, so no backup can bring the password back.
    expect(await stored(shop.tenant, signIn.id)).toMatchObject({ id: signIn.id, username: "",
      sealed: { keyTag: "", iv: "", data: "" }, removedAt: expect.any(String) });
    expect(JSON.stringify(await stored(shop.tenant, signIn.id))).not.toContain(PASSWORD);

    expect(await signInEntries(shop.tenant)).toEqual([
      { actor: { kind: "operator", email: null }, action: "signin.created", subject: { signInId: signIn.id }, outcome: "ok" },
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.removed", subject: { signInId: signIn.id },
        outcome: "ok" },
    ]);
    const log = JSON.stringify(await auditEntries(shop.tenant));
    for (const said of [USERNAME, SITE, ...ORIGINS]) expect(log).not.toContain(said);
    // Once only.
    expect(await remove(fon.headers, { signInId: signIn.id })).toEqual({ status: 404, body: { error: "sign_in_not_found" } });
  });

  it("refuses a grant issued before the removal, at its redeem and at its open, and issues none after it", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const outpost = await onlineOutpost(shop.tenant);
    const waiting = await grantId(shop.tenant, signIn.id, outpost, "nam");
    // A second grant whose redeem had begun (claimed) before the removal, and opens only after it.
    const halfway = await grantId(shop.tenant, signIn.id, outpost, "ton");
    expect((await redeemHalf(shop.tenant, "claim", halfway, outpost)).status).toBe(200);

    expect((await remove(fon.headers, { signInId: signIn.id })).status).toBe(200);

    expect(await redeem(shop.tenant, waiting, outpost)).toEqual({ status: 404, body: { error: "sign_in_not_found" } });
    expect(await redeemHalf(shop.tenant, "open", halfway, outpost)).toEqual({ status: 404,
      body: { error: "sign_in_not_found" } });
    // Used up by the refused redeem: it can never be tried again.
    expect(await redeem(shop.tenant, waiting, outpost)).toEqual({ status: 409, body: { error: "grant_used" } });
    expect(await grant(shop.tenant, signIn.id, outpost)).toEqual({ status: 404, body: { error: "sign_in_not_found" } });

    const redeems = (await signInEntries(shop.tenant)).filter((entry) => entry.action === "signin.redeemed");
    expect(redeems).toEqual([
      { actor: { kind: "outpost", id: outpost.outpostId }, action: "signin.redeemed", subject: { signInId: signIn.id,
        taskId: "task-nam", attemptId: "attempt-nam", outpostId: outpost.outpostId, grantId: waiting }, outcome: "refused",
      reason: "sign_in_not_found" },
      { actor: { kind: "outpost", id: outpost.outpostId }, action: "signin.redeemed", subject: { signInId: signIn.id,
        taskId: "task-nam", attemptId: "attempt-nam", outpostId: outpost.outpostId, grantId: waiting }, outcome: "refused",
      reason: "grant_used" },
    ]);
  });

  it("names the shop's own session in the log when it is the one that removed it", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const added = await operatorAdd(tenant, { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
      members: ["nam"] });
    expect(await remove(headers, { signInId: added.body.signIn!.id })).toEqual({ status: 200,
      body: { removed: true, signInId: added.body.signIn!.id } });
    expect((await signInEntries(tenant)).filter((entry) => entry.action === "signin.removed")).toEqual([
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.removed", subject: { signInId: added.body.signIn!.id },
        outcome: "ok" },
    ]);
  });

  it("refuses a body that is not exactly a sign-in's id, and a sign-in that is not the shop's, and removes nothing", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const other = await shopWithSignIn();
    for (const body of [
      { signInId: signIn.id, tenant: other.shop.tenant },
      { signInId: signIn.id, shop: other.shop.tenant },
      { signInId: signIn.id, role: "owner" },
      { signInId: signIn.id, password: PASSWORD },
      {},
      { signInId: 7 },
      { signInId: [signIn.id] },
      [signIn.id],
      "remove",
    ]) {
      expect(await remove(fon.headers, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    for (const signInId of [crypto.randomUUID(), "not-an-id", other.signIn.id]) {
      expect(await remove(fon.headers, { signInId }), signInId).toEqual({ status: 404, body: { error: "sign_in_not_found" } });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await operatorSignIns(other.shop.tenant)).toEqual([other.signIn]);
    expect(await sealedPassword(other.shop.tenant, other.signIn.id)).toBe(PASSWORD);
    expect((await signInEntries(shop.tenant)).some((entry) => entry.action === "signin.removed")).toBe(false);
  });
});

describe("the owner changing a sign-in's account or addresses", () => {
  it("refuses, without the password typed again, any change that could send the password somewhere new", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const outpost = await onlineOutpost(shop.tenant);
    const sealBefore = (await stored(shop.tenant, signIn.id)).sealed;
    for (const [origins, username] of [
      [[...ORIGINS, ELSEWHERE], USERNAME],
      [[ORIGINS[0]!, ELSEWHERE], USERNAME],
      [[ELSEWHERE], USERNAME],
      [ORIGINS, OTHER_USERNAME],
      [[ORIGINS[0]!], OTHER_USERNAME],
      [[ELSEWHERE], OTHER_USERNAME],
    ] as const) {
      expect(await change(fon.headers, { signInId: signIn.id, origins, username, password: null }),
        JSON.stringify([origins, username])).toEqual({ status: 400, body: { error: "password_required" } });
    }
    // Nothing moved: the list, the seal, and what a redeem would have the outpost type, where.
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect((await stored(shop.tenant, signIn.id)).sealed).toEqual(sealBefore);
    expect((await typed(shop.tenant, await grantId(shop.tenant, signIn.id, outpost), outpost)).body).toEqual({
      signInId: signIn.id, site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD });
    expect((await signInEntries(shop.tenant)).some((entry) => CHANGES.includes(entry.action))).toBe(false);
  });

  it("with the password typed again, seals it as adding does, and a grant from before types it at the new address only", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const outpost = await onlineOutpost(shop.tenant);
    // Issued before the change, redeemed after it.
    const before = await grantId(shop.tenant, signIn.id, outpost);
    // Broken first, as a worker reports it: typing the password again mends it, as a new password does.
    expect((await vaultCall(bindings, shop.tenant, "POST", "/sign-ins/broken", { signInId: signIn.id, member: "nam" }))
      .status).toBe(200);

    const origins = [ORIGINS[0]!, "https://seller-login.shopee.co.th"];
    const changed = await send(fon.headers, "POST", "/v1/vault/sign-ins/change",
      { signInId: signIn.id, origins, username: OTHER_USERNAME, password: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    for (const secret of [NEW_PASSWORD, PASSWORD]) expect(changed.text).not.toContain(secret);
    const { signIn: view } = JSON.parse(changed.text) as { signIn: SignIn };
    expect(view).toEqual({ ...signIn, origins, username: OTHER_USERNAME, state: "working", brokenAt: null, brokenBy: null,
      passwordSetAt: expect.any(String) });
    expect(Date.parse(view.passwordSetAt)).toBeGreaterThanOrEqual(Date.parse(signIn.passwordSetAt));
    expect(await operatorSignIns(shop.tenant)).toEqual([view]);

    // Sealed under the vault's key as adding seals it, and kept nowhere in the clear.
    const added = await operatorAdd(shop.tenant, { site: "Carrier portal", origins: ["https://track.carrier.example"],
      username: USERNAME, password: PASSWORD, members: ["nam"] });
    const [mySeal, addSeal] = [(await stored(shop.tenant, signIn.id)).sealed as SealedSecret,
      (await stored(shop.tenant, added.body.signIn!.id)).sealed as SealedSecret];
    expect(Object.keys(mySeal).sort()).toEqual(Object.keys(addSeal).sort());
    expect(mySeal.keyTag).toBe(addSeal.keyTag);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(NEW_PASSWORD);
    expect(JSON.stringify(await stored(shop.tenant, signIn.id))).not.toContain(NEW_PASSWORD);

    // The grant from before the change types the new password, for the new account, at the new addresses: never the
    // password the owner gave with the old ones.
    expect((await typed(shop.tenant, before, outpost)).body).toEqual({ signInId: signIn.id, site: SITE, origins,
      username: OTHER_USERNAME, password: NEW_PASSWORD });

    expect((await signInEntries(shop.tenant)).filter((entry) => entry.action === "signin.changed")).toEqual([
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.changed", subject: { signInId: signIn.id }, outcome: "ok" },
    ]);
  });

  it("takes addresses away without the password, keeping the seal and whether it works, and logs that it narrowed", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const outpost = await onlineOutpost(shop.tenant);
    expect((await vaultCall(bindings, shop.tenant, "POST", "/sign-ins/broken", { signInId: signIn.id, member: "ton" }))
      .status).toBe(200);
    const [broken] = await operatorSignIns(shop.tenant);
    const sealBefore = (await stored(shop.tenant, signIn.id)).sealed;

    const narrowed = await change(fon.headers, { signInId: signIn.id, origins: [ORIGINS[1]!], username: USERNAME,
      password: null });
    expect(narrowed).toEqual({ status: 200, body: { signIn: { ...broken, origins: [ORIGINS[1]!] } } });
    expect((await stored(shop.tenant, signIn.id)).sealed).toEqual(sealBefore);
    // Never to none: a sign-in keeps at least one address.
    expect(await change(fon.headers, { signInId: signIn.id, origins: [], username: USERNAME, password: null }))
      .toEqual({ status: 400, body: { error: "invalid_origins" } });
    // Mended with a new password, the narrowed sign-in types the one it was given, at the one address left.
    expect((await asSession(fon.headers, "POST", "/v1/vault/sign-ins/password", { signInId: signIn.id,
      password: NEW_PASSWORD })).status).toBe(200);
    expect((await typed(shop.tenant, await grantId(shop.tenant, signIn.id, outpost), outpost)).body).toEqual({
      signInId: signIn.id, site: SITE, origins: [ORIGINS[1]!], username: USERNAME, password: NEW_PASSWORD });

    expect((await signInEntries(shop.tenant)).filter((entry) => CHANGES.includes(entry.action))).toEqual([
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.narrowed", subject: { signInId: signIn.id }, outcome: "ok" },
    ]);
  });

  it("refuses a change that changes nothing, with or without a password: a new password alone is the password route's", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    for (const password of [null, NEW_PASSWORD]) {
      expect(await change(fon.headers, { signInId: signIn.id, origins: [...ORIGINS].reverse(), username: USERNAME, password }))
        .toEqual({ status: 400, body: { error: "no_change" } });
    }
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
  });

  it("names the shop's own session in the log when it is the one that changed it", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const added = await operatorAdd(tenant, { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
      members: ["nam"] });
    const id = added.body.signIn!.id;
    expect((await change(headers, { signInId: id, origins: [ORIGINS[0]!], username: USERNAME, password: null })).status)
      .toBe(200);
    expect((await change(headers, { signInId: id, origins: ORIGINS, username: USERNAME, password: NEW_PASSWORD })).status)
      .toBe(200);
    expect((await signInEntries(tenant)).filter((entry) => CHANGES.includes(entry.action))).toEqual([
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.narrowed", subject: { signInId: id }, outcome: "ok" },
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.changed", subject: { signInId: id }, outcome: "ok" },
    ]);
  });

  it("checks every value with the rules adding uses, refusing each the way adding does, and changes nothing it refuses", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const sixOrigins = Array.from({ length: 6 }, (_, i) => `https://s${i}.shopee.co.th`);
    const cases: [Record<string, unknown>, string][] = [
      [{ origins: [] }, "invalid_origins"],
      [{ origins: "https://seller.shopee.co.th" }, "invalid_origins"],
      [{ origins: ["http://seller.shopee.co.th"] }, "invalid_origins"],
      [{ origins: ["https://seller.shopee.co.th/portal"] }, "invalid_origins"],
      [{ origins: ["https://Seller.Shopee.co.th"] }, "invalid_origins"],
      [{ origins: ["https://seller.shopee.co.th:443"] }, "invalid_origins"],
      [{ origins: ["https://fon:secret@seller.shopee.co.th"] }, "invalid_origins"],
      [{ origins: ["seller.shopee.co.th"] }, "invalid_origins"],
      [{ origins: ["https://seller.shopee.co.th", "https://seller.shopee.co.th"] }, "invalid_origins"],
      [{ origins: sixOrigins }, "invalid_origins"],
      [{ origins: [`https://${"a".repeat(250)}.example`] }, "invalid_origins"],
      [{ origins: [42] }, "invalid_origins"],
      [{ username: "" }, "invalid_username"],
      [{ username: "   " }, "invalid_username"],
      [{ username: "x".repeat(257) }, "invalid_username"],
      [{ username: "fon\u0000" }, "invalid_username"],
      [{ username: ["fon"] }, "invalid_username"],
      [{ username: 7 }, "invalid_username"],
      [{ password: "" }, "invalid_password"],
      [{ password: "x".repeat(1025) }, "invalid_password"],
    ];
    const fields = { origins: [ELSEWHERE], username: OTHER_USERNAME, password: NEW_PASSWORD };
    for (const [overrides, error] of cases) {
      expect(await change(fon.headers, { signInId: signIn.id, ...fields, ...overrides }), JSON.stringify(overrides))
        .toEqual({ status: 400, body: { error } });
      // Adding refuses the same value the same way.
      expect((await operatorAdd(shop.tenant, { site: SITE, members: ["nam"], ...fields, ...overrides })).body,
        `adding ${JSON.stringify(overrides)}`).toEqual({ error });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);

    // At the edge of each rule it is taken, as adding takes it: five addresses, an account of 256 characters, a password of
    // 1,024 that is all spaces.
    const edge = await change(fon.headers, { signInId: signIn.id, origins: sixOrigins.slice(0, 5), username: "u".repeat(256),
      password: " ".repeat(1024) });
    expect(edge.status).toBe(200);
    expect(edge.body.signIn).toMatchObject({ origins: sixOrigins.slice(0, 5), username: "u".repeat(256) });
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(" ".repeat(1024));
  });

  it("passes on that the vault has no key when a password is typed, and changes nothing", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    // The vault object reads its key from its own environment, so the key is taken from there for this one request.
    type Keyed = { env: Record<string, unknown> };
    const before = await runInDurableObject(vault(shop.tenant), (instance) => (instance as unknown as Keyed).env);
    await runInDurableObject(vault(shop.tenant), (instance) => {
      (instance as unknown as Keyed).env = { ...before, CRED_KEY: undefined };
    });
    try {
      expect(await change(fon.headers, { signInId: signIn.id, origins: [ELSEWHERE], username: USERNAME,
        password: NEW_PASSWORD })).toEqual({ status: 503, body: { error: "vault_not_configured" } });
    } finally {
      await runInDurableObject(vault(shop.tenant), (instance) => {
        (instance as unknown as Keyed).env = before;
      });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
  });

  it("refuses a body that is not exactly the four keys: a shop named, the password left out, an id or password of another kind", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const other = await shopWithSignIn();
    const body = { signInId: signIn.id, origins: [ELSEWHERE], username: USERNAME, password: NEW_PASSWORD };
    const { password: _password, ...withoutPassword } = body;
    const { username: _username, ...withoutUsername } = body;
    for (const sent of [
      { ...body, tenant: other.shop.tenant },
      { ...body, shop: other.shop.tenant },
      { ...body, role: "owner" },
      { ...body, members: ["kit"] },
      withoutPassword,
      withoutUsername,
      { ...body, password: 1234 },
      { ...body, password: [NEW_PASSWORD] },
      { ...body, password: false },
      { ...body, signInId: 7 },
      { ...body, signInId: null },
      [body],
      "change",
    ]) {
      expect(await change(fon.headers, sent), JSON.stringify(sent)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await send(fon.headers, "POST", "/v1/vault/sign-ins/change", JSON.stringify(body).slice(0, -1))).toEqual({
      status: 400, text: JSON.stringify({ error: "invalid_json" }) });
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await operatorSignIns(other.shop.tenant)).toEqual([other.signIn]);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
  });

  it("refuses a sign-in that is not the shop's, or no longer is, even one the same person owns", async () => {
    // One Apple account owns both shops, and holds an owner session for each.
    const person = await appleSignIn();
    const a = await setupShop();
    const atA = await linkedOwner(a, person);
    const b = await setupShop("Ran Pa Noi");
    await linkedOwner(b, person);
    const signInB = (await operatorAdd(b.tenant, { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
      members: ["nam"] })).body.signIn!;
    const gone = (await operatorAdd(a.tenant, { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD,
      members: ["nam"] })).body.signIn!;
    expect((await remove(atA.headers, { signInId: gone.id })).status).toBe(200);
    for (const signInId of [signInB.id, gone.id, crypto.randomUUID(), "not-an-id"]) {
      for (const password of [NEW_PASSWORD, null]) {
        expect(await change(atA.headers, { signInId, origins: [ORIGINS[0]!], username: USERNAME, password }), signInId)
          .toEqual({ status: 404, body: { error: "sign_in_not_found" } });
      }
    }
    expect(await operatorSignIns(b.tenant)).toEqual([signInB]);
    expect(await sealedPassword(b.tenant, signInB.id)).toBe(PASSWORD);
  });

  it("keeps the typed password, the account and the addresses out of every answer's echo, every audit entry and every log line", async () => {
    const logged = consoleLines();
    const { shop, fon, signIn } = await shopWithSignIn();
    const mint = await joinHelper(shop);
    const answers: string[] = [];
    const kept = async (headers: Headers, body: unknown) => {
      const answer = await send(headers, "POST", "/v1/vault/sign-ins/change", body);
      answers.push(answer.text);
      return answer.status;
    };
    const body = { signInId: signIn.id, origins: [ELSEWHERE], username: OTHER_USERNAME, password: NEW_PASSWORD };

    // Every way the password can be sent here: each refusal on the way to it, and then taken.
    expect(await kept(fon.headers, { ...body, tenant: shop.tenant })).toBe(400);
    expect(await kept(fon.headers, { ...body, password: [NEW_PASSWORD] })).toBe(400);
    expect(await kept(fon.headers, { ...body, password: `${NEW_PASSWORD}${"x".repeat(1024)}` })).toBe(400);
    expect(await kept(fon.headers, { ...body, origins: ["http://seller.shopee.co.th"] })).toBe(400);
    expect(await kept(fon.headers, { ...body, signInId: crypto.randomUUID() })).toBe(404);
    expect(await kept(fon.headers, JSON.stringify(body).slice(0, -1))).toBe(400);
    expect(await kept(mint.headers, body)).toBe(403);
    expect(await kept({}, body)).toBe(401);
    expect(await kept(fon.headers, body)).toBe(200);
    // Sent to the removal by mistake, it is refused there without being echoed either.
    answers.push((await send(fon.headers, "POST", "/v1/vault/sign-ins/remove", { signInId: signIn.id,
      password: NEW_PASSWORD })).text);

    const secret = NEW_PASSWORD.slice(0, 22);
    for (const answer of answers) expect(answer).not.toContain(secret);
    const entries = JSON.stringify(await auditEntries(shop.tenant));
    for (const said of [secret, PASSWORD.slice(0, 18), OTHER_USERNAME, USERNAME, ELSEWHERE, ...ORIGINS]) {
      expect(entries).not.toContain(said);
    }
    expect(logged.join("\n")).not.toContain(secret);
  });
});

describe("the operator choosing who may use a sign-in", () => {
  it("changes only who may use it, through the owner's own vault operation, and logs signin.members_changed", async () => {
    const { shop, signIn } = await shopWithSignIn();
    const outpost = await onlineOutpost(shop.tenant);
    const tons = await grantId(shop.tenant, signIn.id, outpost, "ton");
    const sealBefore = (await stored(shop.tenant, signIn.id)).sealed;

    expect(await operatorMembers({ tenant: shop.tenant, signInId: signIn.id, members: ["nam", "kit"] })).toEqual({
      status: 200, body: { signIn: { ...signIn, members: ["nam", "kit"] } } });
    expect(await operatorSignIns(shop.tenant)).toEqual([{ ...signIn, members: ["nam", "kit"] }]);
    expect((await stored(shop.tenant, signIn.id)).sealed).toEqual(sealBefore);
    // Ton, taken off, loses it at once: the grant issued before is refused at its redeem.
    expect(await redeemHalf(shop.tenant, "claim", tons, outpost)).toMatchObject({ status: 403,
      body: { error: "member_not_allowed" } });

    expect((await signInEntries(shop.tenant)).filter((entry) => entry.action === "signin.members_changed")).toEqual([
      { actor: { kind: "operator", email: null }, action: "signin.members_changed", subject: { signInId: signIn.id },
        outcome: "ok" },
    ]);
  });

  it("refuses what the owner's route refuses, the same way, and changes nothing", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const other = await shopWithSignIn();
    for (const members of [[], "nam", ["nam", "nam"], ["buddy"], ["Nam"], ["nam", "pim", "ton", "kit", "nam"], [7], null,
      { nam: true }]) {
      const owners = await ownerMembers(fon.headers, { signInId: signIn.id, members });
      expect(owners, JSON.stringify(members)).toEqual({ status: 400, body: { error: "invalid_members" } });
      expect(await operatorMembers({ tenant: shop.tenant, signInId: signIn.id, members }), `operator ${JSON.stringify(members)}`)
        .toEqual(owners);
    }
    const gone = await operatorAdd(shop.tenant, { site: "Carrier portal", origins: ["https://track.carrier.example"],
      username: USERNAME, password: PASSWORD, members: ["nam"] });
    expect((await remove(fon.headers, { signInId: gone.body.signIn!.id })).status).toBe(200);
    for (const signInId of [crypto.randomUUID(), "not-an-id", other.signIn.id, gone.body.signIn!.id]) {
      const owners = await ownerMembers(fon.headers, { signInId, members: ["kit"] });
      expect(owners, signInId).toEqual({ status: 404, body: { error: "sign_in_not_found" } });
      expect(await operatorMembers({ tenant: shop.tenant, signInId, members: ["kit"] }), `operator ${signInId}`).toEqual(owners);
    }
    expect(await operatorMembers({ signInId: signIn.id, members: ["kit"] })).toEqual({ status: 400,
      body: { error: "tenant_required" } });
    // The admin gate stands in front of it: an owner's session is not the operator's key.
    expect((await asSession(fon.headers, "POST", "/v1/admin/vault/sign-ins/members", { tenant: shop.tenant,
      signInId: signIn.id, members: ["kit"] })).status).toBe(403);

    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await operatorSignIns(other.shop.tenant)).toEqual([other.signIn]);
    expect((await signInEntries(shop.tenant)).some((entry) => entry.action === "signin.members_changed")).toBe(false);
  });
});
