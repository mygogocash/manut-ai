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

// The owner adding a sign-in to the shop's vault, and choosing who may use one, from their own session
// (docs/browser-control.md, "The owner's Connections"; the contract is docs/pilot-api.md, "The owner's vault and outposts").
// Adding goes through the vault's own `/sign-ins`, the operator's, so it is checked, sealed and kept exactly as the
// operator's is, with the operator's refusals. Who may use a sign-in goes through the vault's `/sign-ins/members`, whose
// members are checked as at creation, and a member taken off loses it at once. The shop is the session's, a helper's
// session is refused, and the log names the owner and the sign-in by id only. The refusals every owner route shares (no
// session, a helper, an unlinked account, the method, the query) are in owner-vault.test.ts, whose list of routes holds
// these two.

// Committed test-only vault key, matching wrangler.test.json (cred-vault.test.ts reads it the same way).
const VAULT_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
// Made up for each run and never a real password, so a search for one finds only what this file sent.
const PASSWORD = `pw-owner-${crypto.randomUUID()}`;
const OPERATOR_PASSWORD = `pw-operator-${crypto.randomUUID()}`;
const SITE = "Shopee Seller Centre";
const ORIGINS = ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"];
const USERNAME = "baan.mali@example.com";
/// What the desktop's Add a sign-in sends.
const NEW_SIGN_IN = { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD, members: ["nam", "ton"] };

type SignIn = { id: string; site: string; origins: string[]; username: string; members: string[];
  state: "working" | "broken"; passwordSet: boolean; passwordSetAt: string; brokenAt: string | null;
  brokenBy: string | null; lastUsedAt: string | null; lastUsedBy: string | null; createdAt: string };
type Headers = { authorization?: string };

afterEach(() => {
  vi.restoreAllMocks();
});

/// A request with a bearer credential: the answer's status and its text, as it left the Worker.
async function send(headers: Headers, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const response = await call(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  return { status: response.status, text: await response.text() };
}

const add = (headers: Headers, body: unknown) => asSession<{ signIn?: SignIn; error?: string }>(headers, "POST",
  "/v1/vault/sign-ins", body);
const choose = (headers: Headers, body: unknown) => asSession<{ signIn?: SignIn; error?: string }>(headers, "POST",
  "/v1/vault/sign-ins/members", body);

/// The operator's own route, with the same fields and the shop named, as the console sends it.
const operatorAdd = (tenant: string, fields: Record<string, unknown>) =>
  admin<{ signIn?: SignIn; error?: string }>("POST", "/v1/admin/vault/sign-ins", { tenant, ...fields });

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
    .map(({ actor, action, subject, outcome }) => ({ actor, action, subject, outcome }));
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

describe("the owner adding a sign-in to the shop's vault", () => {
  it("adds it through the operator's own operation: the same record, sealed the same way, and no password answered", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);

    const added = await send(fon.headers, "POST", "/v1/vault/sign-ins", NEW_SIGN_IN);
    expect(added.status).toBe(200);
    expect(added.text).not.toContain(PASSWORD);
    const { signIn } = JSON.parse(added.text) as { signIn: SignIn };
    expect(signIn).toEqual({ id: expect.any(String), site: SITE, origins: ORIGINS, username: USERNAME,
      members: ["nam", "ton"], state: "working", passwordSet: true, passwordSetAt: expect.any(String), brokenAt: null,
      brokenBy: null, lastUsedAt: null, lastUsedBy: null, createdAt: signIn.passwordSetAt });
    // The shop is the session's: the operator's list for it, and the owner's own, hold what was added.
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await asSession(fon.headers, "GET", "/v1/vault/sign-ins")).toEqual({ status: 200,
      body: { tenant: shop.tenant, signIns: [signIn] } });

    // The operator adds the same sign-in with a password of its own: both records are kept the same way, under the same
    // key, each opening to its own password, and neither holds a password in the clear.
    const byOperator = await operatorAdd(shop.tenant, { ...NEW_SIGN_IN, password: OPERATOR_PASSWORD });
    expect(byOperator.status).toBe(200);
    const [mine, theirs] = [await stored(shop.tenant, signIn.id), await stored(shop.tenant, byOperator.body.signIn!.id)];
    expect(Object.keys(mine).sort()).toEqual(Object.keys(theirs).sort());
    const kept = ({ id: _id, sealed: _sealed, passwordSetAt: _set, createdAt: _made, ...rest }: Record<string, unknown>) => rest;
    expect(kept(mine)).toEqual(kept(theirs));
    expect(kept(mine)).toMatchObject({ tenant: shop.tenant, state: "working", removedAt: null });
    const [mySeal, theirSeal] = [mine.sealed as SealedSecret, theirs.sealed as SealedSecret];
    expect(Object.keys(mySeal).sort()).toEqual(Object.keys(theirSeal).sort());
    expect(mySeal.keyTag).toBe(theirSeal.keyTag);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(PASSWORD);
    expect(await sealedPassword(shop.tenant, byOperator.body.signIn!.id)).toBe(OPERATOR_PASSWORD);
    expect(JSON.stringify(mine)).not.toContain(PASSWORD);

    // The log names the owner's linked account and the sign-in, by id only, as it names the operator for theirs.
    expect(await signInEntries(shop.tenant)).toEqual([
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.created", subject: { signInId: signIn.id },
        outcome: "ok" },
      { actor: { kind: "operator", email: null }, action: "signin.created",
        subject: { signInId: byOperator.body.signIn!.id }, outcome: "ok" },
    ]);
  });

  it("names the shop's own session in the log when it is the one that added it", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const added = await add(headers, NEW_SIGN_IN);
    expect(added.status).toBe(200);
    expect(await operatorSignIns(tenant)).toEqual([added.body.signIn]);
    expect(await sealedPassword(tenant, added.body.signIn!.id)).toBe(PASSWORD);
    expect(await signInEntries(tenant)).toEqual([
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.created",
        subject: { signInId: added.body.signIn!.id }, outcome: "ok" },
    ]);
  });

  it("refuses what the vault does not take with the operator's own refusal, field by field, and adds nothing", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    const sixOrigins = Array.from({ length: 6 }, (_, i) => `https://s${i}.shopee.co.th`);
    const cases: [Record<string, unknown>, string][] = [
      [{ site: "" }, "invalid_site"],
      [{ site: "   " }, "invalid_site"],
      [{ site: "x".repeat(81) }, "invalid_site"],
      [{ site: "Shopee\u0007" }, "invalid_site"],
      [{ site: 7 }, "invalid_site"],
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
      [{ password: "" }, "invalid_password"],
      [{ password: "x".repeat(1025) }, "invalid_password"],
      [{ password: 1234 }, "invalid_password"],
      [{ members: [] }, "invalid_members"],
      [{ members: "nam" }, "invalid_members"],
      [{ members: ["nam", "nam"] }, "invalid_members"],
      [{ members: ["buddy"] }, "invalid_members"],
      [{ members: ["Nam"] }, "invalid_members"],
      [{ members: ["nam", "pim", "ton", "kit", "nam"] }, "invalid_members"],
      [{ members: [7] }, "invalid_members"],
    ];
    for (const [overrides, error] of cases) {
      const fields = { ...NEW_SIGN_IN, ...overrides };
      expect(await add(fon.headers, fields), JSON.stringify(overrides)).toEqual({ status: 400, body: { error } });
      // The operator's route refuses the same fields the same way.
      expect(await operatorAdd(shop.tenant, fields), `operator ${JSON.stringify(overrides)}`)
        .toEqual({ status: 400, body: { error } });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([]);
    expect(await signInEntries(shop.tenant)).toEqual([]);

    // At the edge of each rule it is taken, as the operator's route takes it: a Thai name of 80 letters, five origins, a
    // name of 256 characters, a password of 1,024, and every member whose jobs run through a connection.
    const thai = "ร้านบ้านมะลิ".repeat(7).slice(0, 80);
    const edge = await add(fon.headers, { site: thai, origins: sixOrigins.slice(0, 5), username: "u".repeat(256),
      password: " ".repeat(1024), members: ["kit", "pim", "nam", "ton"] });
    expect(edge.status).toBe(200);
    expect(edge.body.signIn).toMatchObject({ site: thai, members: ["kit", "pim", "nam", "ton"] });
    expect(await sealedPassword(shop.tenant, edge.body.signIn!.id)).toBe(" ".repeat(1024));
  });

  it("refuses a sign-in past the shop's fifty, as the operator's route does", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    for (let i = 0; i < 50; i++) {
      expect((await operatorAdd(shop.tenant, { ...NEW_SIGN_IN, site: `Site ${i}` })).status).toBe(200);
    }
    expect(await add(fon.headers, NEW_SIGN_IN)).toEqual({ status: 409, body: { error: "too_many_sign_ins" } });
    expect(await operatorSignIns(shop.tenant)).toHaveLength(50);
    expect((await signInEntries(shop.tenant)).filter((entry) => entry.actor.kind === "owner")).toEqual([]);
  });

  it("passes on that the vault has no key, and adds nothing", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    // The vault object reads its key from its own environment, so the key is taken from there for this one request.
    type Keyed = { env: Record<string, unknown> };
    const before = await runInDurableObject(vault(shop.tenant), (instance) => (instance as unknown as Keyed).env);
    await runInDurableObject(vault(shop.tenant), (instance) => {
      (instance as unknown as Keyed).env = { ...before, CRED_KEY: undefined };
    });
    try {
      expect(await add(fon.headers, NEW_SIGN_IN)).toEqual({ status: 503, body: { error: "vault_not_configured" } });
    } finally {
      await runInDurableObject(vault(shop.tenant), (instance) => {
        (instance as unknown as Keyed).env = before;
      });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([]);
    expect(await signInEntries(shop.tenant)).toEqual([]);
    // With its key back, the same request adds it.
    expect((await add(fon.headers, NEW_SIGN_IN)).status).toBe(200);
  });

  it("refuses a body that is not exactly the five fields, a shop named in it above all, and adds nothing anywhere", async () => {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    const other = await setupShop("Ran Pa Noi");
    const { password: _password, ...withoutPassword } = NEW_SIGN_IN;
    const bodies: unknown[] = [
      { ...NEW_SIGN_IN, tenant: other.tenant },
      { ...NEW_SIGN_IN, shop: other.tenant },
      { ...NEW_SIGN_IN, role: "owner" },
      { ...NEW_SIGN_IN, passwordSet: true },
      withoutPassword,
      { site: SITE, origins: ORIGINS, username: USERNAME, password: PASSWORD },
      [NEW_SIGN_IN],
      "sign-in",
      null,
    ];
    for (const body of bodies) {
      expect(await add(fon.headers, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await send(fon.headers, "POST", "/v1/vault/sign-ins", `{"site":"${SITE}"`)).toEqual({ status: 400,
      text: JSON.stringify({ error: "invalid_json" }) });
    expect((await add(fon.headers, { ...NEW_SIGN_IN, username: "x".repeat(17 * 1024) })).status).toBe(413);
    expect(await operatorSignIns(shop.tenant)).toEqual([]);
    expect(await operatorSignIns(other.tenant)).toEqual([]);
    expect(await signInEntries(shop.tenant)).toEqual([]);
  });

  it("keeps the typed password out of every answer, every audit entry and every log line", async () => {
    const logged = consoleLines();
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    const other = await setupShop("Ran Pa Noi");
    const mint = await joinHelper(shop);
    const answers: string[] = [];
    const kept = async (headers: Headers, body: unknown) => {
      const answer = await send(headers, "POST", "/v1/vault/sign-ins", body);
      answers.push(answer.text);
      return answer.status;
    };

    // Every way the password can be sent here: taken, and each refusal on the way to it.
    expect(await kept(fon.headers, NEW_SIGN_IN)).toBe(200);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, tenant: other.tenant })).toBe(400);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, password: [PASSWORD] })).toBe(400);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, password: `${PASSWORD}${"x".repeat(1024)}` })).toBe(400);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, origins: ["http://seller.shopee.co.th"] })).toBe(400);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, members: ["buddy"] })).toBe(400);
    expect(await kept(fon.headers, { ...NEW_SIGN_IN, site: "" })).toBe(400);
    expect(await kept(fon.headers, JSON.stringify(NEW_SIGN_IN).slice(0, -1))).toBe(400);
    expect(await kept(mint.headers, NEW_SIGN_IN)).toBe(403);
    expect(await kept({}, NEW_SIGN_IN)).toBe(401);
    // Sent to the members route by mistake, it is refused there without being echoed either.
    answers.push((await send(fon.headers, "POST", "/v1/vault/sign-ins/members", { signInId: "x", members: ["nam"],
      password: PASSWORD })).text);
    answers.push((await send(fon.headers, "GET", "/v1/vault/sign-ins")).text);

    expect(await operatorSignIns(shop.tenant)).toHaveLength(1);
    expect(await operatorSignIns(other.tenant)).toEqual([]);
    const secret = PASSWORD.slice(0, 20);
    for (const answer of answers) expect(answer).not.toContain(secret);
    const entries = [...await auditEntries(shop.tenant), ...await auditEntries(other.tenant)];
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(USERNAME);
    expect(logged.join("\n")).not.toContain(secret);
  });
});

describe("the owner choosing who may use a sign-in", () => {
  /// A pilot shop with its owner's linked account and a sign-in the operator added for Nam and Ton.
  async function shopWithSignIn() {
    const shop = await setupShop();
    const fon = await linkedOwner(shop);
    const added = await operatorAdd(shop.tenant, { ...NEW_SIGN_IN, password: OPERATOR_PASSWORD });
    expect(added.status).toBe(200);
    return { shop, fon, signIn: added.body.signIn! };
  }

  it("changes only who may use it, keeps its password and its state, and logs signin.members_changed", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    // Broken first, as a worker reports it: choosing members neither mends it nor touches the seal.
    expect((await vaultCall(bindings, shop.tenant, "POST", "/sign-ins/broken", { signInId: signIn.id, member: "nam" }))
      .status).toBe(200);
    const [broken] = await operatorSignIns(shop.tenant);
    const sealBefore = (await stored(shop.tenant, signIn.id)).sealed;

    const chosen = await choose(fon.headers, { signInId: signIn.id, members: ["pim", "kit"] });
    expect(chosen).toEqual({ status: 200, body: { signIn: { ...broken, members: ["pim", "kit"] } } });
    expect(await operatorSignIns(shop.tenant)).toEqual([{ ...broken, members: ["pim", "kit"] }]);
    expect((await stored(shop.tenant, signIn.id)).sealed).toEqual(sealBefore);
    expect(await sealedPassword(shop.tenant, signIn.id)).toBe(OPERATOR_PASSWORD);
    // And back to everyone whose jobs run through a connection.
    expect((await choose(fon.headers, { signInId: signIn.id, members: ["nam", "pim", "ton", "kit"] })).body.signIn?.members)
      .toEqual(["nam", "pim", "ton", "kit"]);

    const changes = (await signInEntries(shop.tenant)).filter((entry) => entry.action === "signin.members_changed");
    expect(changes).toEqual([
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.members_changed", subject: { signInId: signIn.id },
        outcome: "ok" },
      { actor: { kind: "owner", id: fon.accountId }, action: "signin.members_changed", subject: { signInId: signIn.id },
        outcome: "ok" },
    ]);
  });

  it("names the shop's own session in the log when it is the one that chose", async () => {
    const tenant = (await setupShop()).tenant;
    const headers = await tenantSession(tenant, false);
    const added = await operatorAdd(tenant, NEW_SIGN_IN);
    expect((await choose(headers, { signInId: added.body.signIn!.id, members: ["ton"] })).body.signIn?.members).toEqual(["ton"]);
    expect((await signInEntries(tenant)).filter((entry) => entry.action === "signin.members_changed")).toEqual([
      { actor: { kind: "owner", id: "owner-session" }, action: "signin.members_changed",
        subject: { signInId: added.body.signIn!.id }, outcome: "ok" },
    ]);
  });

  it("takes a member off at once: a grant given before the change is refused at its redeem, and no new one is issued", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const registered = await admin<{ outpost: { id: string }; credential: string }>("POST", "/v1/admin/outposts",
      { tenant: shop.tenant, name: "Cloud outpost", kind: "cloud" });
    expect(registered.status).toBe(200);
    const { outpost, credential } = registered.body;
    const beat = await call("/v1/outposts/heartbeat", { method: "POST", headers: { authorization: `Bearer ${credential}`,
      "content-type": "application/json" }, body: JSON.stringify({ tenant: shop.tenant, outpostId: outpost.id }) });
    expect(beat.status).toBe(200);
    // A grant as the job flow's port asks for one, for Ton's attempt and for Nam's.
    const grantFor = (member: string) => vaultCall(bindings, shop.tenant, "POST", "/sign-in-grants",
      { signInId: signIn.id, outpostId: outpost.id, member, taskId: `task-${member}`, attemptId: `attempt-${member}` });
    const tons = await grantFor("ton");
    expect(tons.status).toBe(200);
    const { grant } = (await tons.json()) as { grant: { grantId: string } };

    expect((await choose(fon.headers, { signInId: signIn.id, members: ["nam"] })).status).toBe(200);

    const claimed = await vaultCall(bindings, shop.tenant, "POST", "/sign-in-grants/claim",
      { grantId: grant.grantId, outpostId: outpost.id, credentialHash: await sha256Hex(credential) });
    expect(claimed.status).toBe(403);
    expect(((await claimed.json()) as { error: string }).error).toBe("member_not_allowed");
    const again = await grantFor("ton");
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toBe("member_not_allowed");
    // Nam, still named on it, may.
    expect((await grantFor("nam")).status).toBe(200);
  });

  it("checks the members as the operator's route checks them at creation, and changes nothing it refuses", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const refused: unknown[] = [[], "nam", ["nam", "nam"], ["buddy"], ["Nam"], ["nam", "pim", "ton", "kit", "nam"], [7], null,
      { nam: true }];
    for (const members of refused) {
      expect(await choose(fon.headers, { signInId: signIn.id, members }), JSON.stringify(members))
        .toEqual({ status: 400, body: { error: "invalid_members" } });
      // The operator's route refuses the same members the same way when it adds a sign-in.
      expect((await operatorAdd(shop.tenant, { ...NEW_SIGN_IN, members })).body, `operator ${JSON.stringify(members)}`)
        .toEqual({ error: "invalid_members" });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect((await signInEntries(shop.tenant)).some((entry) => entry.action === "signin.members_changed")).toBe(false);
  });

  it("refuses a sign-in that is not the shop's, or no longer is, and a body that is not exactly an id and the members", async () => {
    const { shop, fon, signIn } = await shopWithSignIn();
    const other = await shopWithSignIn();
    const gone = await operatorAdd(shop.tenant, { ...NEW_SIGN_IN, site: "Carrier portal" });
    expect((await admin("POST", "/v1/admin/vault/sign-ins/remove", { tenant: shop.tenant, signInId: gone.body.signIn!.id }))
      .status).toBe(200);
    for (const signInId of [crypto.randomUUID(), "not-an-id", other.signIn.id, gone.body.signIn!.id]) {
      expect(await choose(fon.headers, { signInId, members: ["kit"] }), signInId)
        .toEqual({ status: 404, body: { error: "sign_in_not_found" } });
    }
    for (const body of [
      { signInId: signIn.id, members: ["kit"], tenant: other.shop.tenant },
      { signInId: signIn.id, members: ["kit"], shop: other.shop.tenant },
      { signInId: signIn.id, members: ["kit"], role: "owner" },
      { signInId: signIn.id },
      { members: ["kit"] },
      { signInId: [signIn.id], members: ["kit"] },
      { signInId: 7, members: ["kit"] },
      [signIn.id, ["kit"]],
    ]) {
      expect(await choose(fon.headers, body), JSON.stringify(body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await operatorSignIns(shop.tenant)).toEqual([signIn]);
    expect(await operatorSignIns(other.shop.tenant)).toEqual([other.signIn]);
  });

  it("never reaches another shop's sign-in, even one the same person owns", async () => {
    // One Apple account owns both shops, and holds an owner session for each.
    const person = await appleSignIn();
    const a = await setupShop();
    const atA = await linkedOwner(a, person);
    const b = await setupShop("Ran Pa Noi");
    const atB = await linkedOwner(b, person);
    const signInB = (await operatorAdd(b.tenant, NEW_SIGN_IN)).body.signIn!;

    // Baan Mali's session names Baan Mali, so Ran Pa Noi's sign-in is not there for it, and what it adds is Baan Mali's.
    expect(await choose(atA.headers, { signInId: signInB.id, members: ["kit"] }))
      .toEqual({ status: 404, body: { error: "sign_in_not_found" } });
    const addedAtA = await add(atA.headers, NEW_SIGN_IN);
    expect(await operatorSignIns(a.tenant)).toEqual([addedAtA.body.signIn]);
    expect(await operatorSignIns(b.tenant)).toEqual([signInB]);
    // Ran Pa Noi's own session reaches its own.
    expect((await choose(atB.headers, { signInId: signInB.id, members: ["kit"] })).body.signIn?.members).toEqual(["kit"]);
  });
});
