// Customize › Connections on the connected runtime (connections.ts), through the real host and session over a fake API:
// the vault read with the session of the shop the switcher shows (or the sign-in while the person is in no shops), a
// shop the person helps at refused with nothing sent, the owner's new password sent once to the password route and
// found nowhere else, a change of a sign-in's account or addresses checked against what the vault lists before anything
// carrying a password goes, a change sent to the shop its row was read for, and nothing sent while only a kept read is
// shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { ShopCache } from "./cache";
import {
  CHANGE_PATH,
  MEMBERS_PATH,
  OUTPOSTS_PATH,
  PASSWORD_PATH,
  REMOVE_PATH,
  REMOVE_SIGN_IN_PATH,
  RENAME_PATH,
  SIGN_INS_PATH,
} from "./connections";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  serveShop,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  type FakeAnswer,
  type FakeApi,
  type Recorded,
  type ServedShops,
} from "./testkit";

const NOW = T0 + 600_000;
// Made up for this file and never a real password: a search for it finds only what the owner typed here.
const PASSWORD = "owner-typed-pw-4d1e8b";
const SIGNED_IN = "apple:owner-1";

/** A sign-in as the API lists it (`SignIn` in docs/pilot-api.md), with the fields the desktop does not show. */
const signInJson = (over: Record<string, unknown> = {}) => ({
  id: "signin-1",
  site: "Shopee Seller Centre",
  origins: ["https://seller.shopee.co.th"],
  username: "baan.mali@example.com",
  members: ["nam", "ton"],
  state: "broken",
  passwordSet: true,
  passwordSetAt: iso(T0 - 86_400_000),
  brokenAt: iso(T0 + 60_000),
  brokenBy: "nam",
  lastUsedAt: iso(T0),
  lastUsedBy: "ton",
  createdAt: iso(T0 - 86_400_000),
  ...over,
});
const outpostJson = (over: Record<string, unknown> = {}) => ({
  id: "outpost-1",
  name: "This Mac",
  kind: "this_mac",
  status: "online",
  lastHeartbeatAt: iso(NOW - 10_000),
  createdAt: iso(T0),
  ...over,
});

/** Each tenant's vault as the fake API keeps it, and the vault routes answered by the bearer as apps/api answers them: a
 *  shop session for its own shop (a helper's refused `owner_only`), and the sign-in for the signed-in tenant. */
function serveVault(api: FakeApi, served: ServedShops | null) {
  const vaults: Record<string, { signIns: Record<string, unknown>[]; outposts: Record<string, unknown>[] }> = {
    [SIGNED_IN]: { signIns: [signInJson()], outposts: [outpostJson()] },
    [SHOP_A.id]: { signIns: [signInJson({ id: "signin-a" })], outposts: [outpostJson({ id: "outpost-a" }), outpostJson({ id: "cloud-a", name: "Cloud outpost", kind: "cloud", status: "asleep", lastHeartbeatAt: null })] },
    [SHOP_B.id]: { signIns: [signInJson({ id: "signin-b" })], outposts: [] },
  };
  const tenantOf = (req: Recorded): string | FakeAnswer => {
    if (req.bearer?.startsWith("access-")) return SIGNED_IN;
    const held = req.bearer ? served?.tokens.get(req.bearer) : undefined;
    if (!held || served?.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    const ended = served?.ended[held.shop];
    if (ended) return { status: 401, json: { error: ended.error, [`${ended.error}At`]: ended.at } };
    return held.role === "owner" ? held.shop : { status: 403, json: { error: "owner_only" } };
  };
  const at = (req: Recorded, then: (tenant: string) => FakeAnswer): FakeAnswer => {
    const tenant = tenantOf(req);
    return typeof tenant === "string" ? then(tenant) : tenant;
  };
  api
    .on("GET", SIGN_INS_PATH, (req) => at(req, (tenant) => ({ status: 200, json: { tenant, signIns: vaults[tenant].signIns } })))
    .on("GET", OUTPOSTS_PATH, (req) => at(req, (tenant) => ({ status: 200, json: { tenant, outposts: vaults[tenant].outposts } })))
    .on("POST", PASSWORD_PATH, (req) =>
      at(req, (tenant) => {
        const { signInId } = req.body as { signInId: string };
        const signIn = vaults[tenant].signIns.find((s) => s.id === signInId);
        if (!signIn) return { status: 404, json: { error: "sign_in_not_found" } };
        Object.assign(signIn, { state: "working", brokenAt: null, brokenBy: null, passwordSetAt: iso(NOW) });
        return { status: 200, json: { signIn } };
      }),
    )
    .on("POST", RENAME_PATH, (req) =>
      at(req, (tenant) => {
        const { outpostId, name } = req.body as { outpostId: string; name: string };
        const outpost = vaults[tenant].outposts.find((o) => o.id === outpostId);
        if (!outpost) return { status: 404, json: { error: "outpost_not_found" } };
        outpost.name = name;
        return { status: 200, json: { outpost } };
      }),
    )
    .on("POST", REMOVE_PATH, (req) =>
      at(req, (tenant) => {
        const { outpostId } = req.body as { outpostId: string };
        if (!vaults[tenant].outposts.some((o) => o.id === outpostId)) return { status: 404, json: { error: "outpost_not_found" } };
        vaults[tenant].outposts = vaults[tenant].outposts.filter((o) => o.id !== outpostId);
        return { status: 200, json: { removed: true, outpostId, stepsRefused: 0, grantsRefused: 0 } };
      }),
    )
    // The vault adds what it is sent and answers its public view, as apps/api does: never the password.
    .on("POST", SIGN_INS_PATH, (req) =>
      at(req, (tenant) => {
        const { site, origins, username, members } = req.body as { site: string; origins: string[]; username: string; members: string[] };
        const signIn = signInJson({ id: `signin-new-${vaults[tenant].signIns.length + 1}`, site, origins, username, members, state: "working",
          brokenAt: null, brokenBy: null, lastUsedAt: null, lastUsedBy: null, passwordSetAt: iso(NOW), createdAt: iso(NOW) });
        vaults[tenant].signIns.push(signIn);
        return { status: 200, json: { signIn } };
      }),
    )
    .on("POST", MEMBERS_PATH, (req) =>
      at(req, (tenant) => {
        const { signInId, members } = req.body as { signInId: string; members: string[] };
        const signIn = vaults[tenant].signIns.find((s) => s.id === signInId);
        if (!signIn) return { status: 404, json: { error: "sign_in_not_found" } };
        signIn.members = members;
        return { status: 200, json: { signIn } };
      }),
    )
    // The vault takes what the runtime let through and answers the public view, as apps/api does: a password typed again
    // mends a broken sign-in and is never answered.
    .on("POST", CHANGE_PATH, (req) =>
      at(req, (tenant) => {
        const { signInId, origins, username, password } = req.body as { signInId: string; origins: string[]; username: string; password: string | null };
        const signIn = vaults[tenant].signIns.find((s) => s.id === signInId);
        if (!signIn) return { status: 404, json: { error: "sign_in_not_found" } };
        Object.assign(signIn, { origins, username }, password !== null ? { state: "working", brokenAt: null, brokenBy: null, passwordSetAt: iso(NOW) } : {});
        return { status: 200, json: { signIn } };
      }),
    )
    .on("POST", REMOVE_SIGN_IN_PATH, (req) =>
      at(req, (tenant) => {
        const { signInId } = req.body as { signInId: string };
        if (!vaults[tenant].signIns.some((s) => s.id === signInId)) return { status: 404, json: { error: "sign_in_not_found" } };
        vaults[tenant].signIns = vaults[tenant].signIns.filter((s) => s.id !== signInId);
        return { status: 200, json: { removed: true, signInId } };
      }),
    );
  return vaults;
}

/** The connected runtime as the app runs it, for a person in shops A (owned) and B (helped), or in none. */
async function setup(opts: { shops: boolean }) {
  const api = fakeApi();
  const served = opts.shops ? serveShops(api, [SHOP_A, SHOP_B]) : null;
  if (!opts.shops) serveShop(api).on("GET", "/v1/shops", { status: 200, json: { shops: [] } });
  const vaults = serveVault(api, served);
  const disk = memoryCacheStore();
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
  const host = new HttpHost({ session, cache: new ShopCache(disk) });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  await rt.connect();
  const ask = rt.request.bind(rt);
  return { api, served, vaults, disk, session, host, rt, ask, events };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
const OWNER_A = shopToken(SHOP_A.id, "owner");
/** A new sign-in as Add a sign-in sends it. */
const NEW_SIGN_IN = { site: "Carrier portal", origins: ["https://track.carrier.example"], username: "baan.mali", password: PASSWORD, members: ["nam", "ton"] };
/** A change Change sends for a listed sign-in (each lists `https://seller.shopee.co.th` for `baan.mali@example.com`): a new
 *  address and the password typed again. */
const MOVED = { origins: ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"], username: "baan.mali@example.com", password: PASSWORD };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the shop's vault and outposts", () => {
  it("reads the signed-in tenant's with the sign-in while the person is in no shops, as the desktop shows them", async () => {
    const { api, ask } = await setup({ shops: false });
    expect(await ask("connections.list", {})).toEqual({
      shop: null,
      signIns: [
        { id: "signin-1", site: "Shopee Seller Centre", username: "baan.mali@example.com", origins: ["https://seller.shopee.co.th"],
          members: ["nam", "ton"], state: "broken", passwordSetAt: (T0 - 86_400_000) / 1000, brokenAt: (T0 + 60_000) / 1000, brokenBy: "nam",
          lastUsedAt: T0 / 1000, lastUsedBy: "ton", createdAt: (T0 - 86_400_000) / 1000 },
      ],
      outposts: [{ id: "outpost-1", name: "This Mac", kind: "this_mac", online: true, lastSeenAt: (NOW - 10_000) / 1000, createdAt: T0 / 1000 }],
    });
    expect([...api.to("GET", SIGN_INS_PATH), ...api.to("GET", OUTPOSTS_PATH)].map((c) => c.bearer)).toEqual(["access-1", "access-1"]);
  });

  it("says no shop is linked when the API answers a person in no shops' sign-in 404, and sends no password", async () => {
    // Since 24 Nov 2026 a vault is a pilot shop's: apps/api answers a person's own sign-in 404 not_found on every vault
    // route, since its tenant is no shop. The tab says so in its own words instead of "not found".
    const { api, ask } = await setup({ shops: false });
    const noShop = { status: 404, json: { error: "not_found" } };
    for (const path of [SIGN_INS_PATH, OUTPOSTS_PATH]) api.on("GET", path, noShop);
    for (const path of [SIGN_INS_PATH, PASSWORD_PATH, MEMBERS_PATH, CHANGE_PATH, REMOVE_SIGN_IN_PATH, RENAME_PATH, REMOVE_PATH]) api.on("POST", path, noShop);
    const said = { code: "no_shop", message: t("conn.err.noShop") };
    expect(await refusal(ask("connections.list", {}))).toEqual(said);
    expect(await refusal(ask("connections.add", { shop: null, ...NEW_SIGN_IN }))).toEqual(said);
    expect(await refusal(ask("connections.password", { shop: null, signIn: "signin-1", password: PASSWORD }))).toEqual(said);
    expect(await refusal(ask("connections.members", { shop: null, signIn: "signin-1", members: ["kit"] }))).toEqual(said);
    expect(await refusal(ask("connections.change", { shop: null, signIn: "signin-1", ...MOVED }))).toEqual(said);
    expect(await refusal(ask("connections.removeSignIn", { shop: null, signIn: "signin-1" }))).toEqual(said);
    expect(await refusal(ask("connections.rename", { shop: null, outpost: "outpost-1", name: "Counter Mac" }))).toEqual(said);
    expect(await refusal(ask("connections.remove", { shop: null, outpost: "outpost-1" }))).toEqual(said);
    // A password goes only after a read of the sign-ins that works, so neither a new one, a changed one nor one typed again
    // with a new address was sent.
    expect(api.to("POST", SIGN_INS_PATH)).toEqual([]);
    expect(api.to("POST", PASSWORD_PATH)).toEqual([]);
    expect(api.to("POST", CHANGE_PATH)).toEqual([]);
    expect(JSON.stringify(api.calls)).not.toContain(PASSWORD);
    // A shop session's 404 is still the shop's own answer, not "no shop".
    const inShops = await setup({ shops: true });
    inShops.api.on("POST", RENAME_PATH, noShop);
    expect((await refusal(inShops.ask("connections.rename", { shop: SHOP_A.id, outpost: "outpost-a", name: "Mac" })))?.code)
      .toBe("not_found");
  });

  it("reads the shop the switcher shows with that shop's own session, and the next one after a switch", async () => {
    const { api, ask } = await setup({ shops: true });
    const listed = await ask("connections.list", {});
    expect(listed.shop).toBe(SHOP_A.id);
    expect(listed.signIns.map((s) => s.id)).toEqual(["signin-a"]);
    expect(listed.outposts.map((o) => [o.name, o.kind, o.online, o.lastSeenAt])).toEqual([
      ["This Mac", "this_mac", true, (NOW - 10_000) / 1000],
      ["Cloud outpost", "cloud", false, null],
    ]);
    expect(api.to("GET", SIGN_INS_PATH).map((c) => c.bearer)).toEqual([OWNER_A]);
    // Ran Pa Noi is a shop the person helps at: only its owner sees its vault, so nothing is asked of it.
    await ask("shops.switch", { shop: SHOP_B.id });
    expect(await refusal(ask("connections.list", {}))).toEqual({ code: "owner_only", message: t("conn.err.ownerOnly") });
    expect(api.calls.filter((c) => c.path.startsWith("/v1/vault/")).map((c) => c.bearer)).toEqual([OWNER_A, OWNER_A]);
  });

  it("leaves out an entry this build cannot read, rather than guessing at it", async () => {
    const { ask, vaults } = await setup({ shops: false });
    vaults[SIGNED_IN].signIns.push(signInJson({ id: "signin-2", state: "paused" }), { id: "signin-3" },
      signInJson({ id: "signin-4", username: undefined }), signInJson({ id: "signin-5", origins: ["http://seller.shopee.co.th"] }),
      signInJson({ id: "signin-6", origins: [] }));
    vaults[SIGNED_IN].outposts.push(outpostJson({ id: "outpost-2", kind: "phone" }));
    const listed = await ask("connections.list", {});
    expect(listed.signIns.map((s) => s.id)).toEqual(["signin-1"]);
    expect(listed.outposts.map((o) => o.id)).toEqual(["outpost-1"]);
  });

  it("says so in the departure's words when the person's place in the shop ended", async () => {
    const { ask, served, events } = await setup({ shops: true });
    served!.ended[SHOP_A.id] = { error: "unlinked", at: iso(NOW - 60_000) };
    const out = await refusal(ask("connections.list", {}));
    expect(out?.code).toBe("unlinked");
    expect(out?.message).toContain("Baan Mali");
    expect(events.some((e) => e.event === "shops.update")).toBe(true);
  });
});

describe("the owner's new password", () => {
  it("is sent once, exactly, with the shop's own session, and is found nowhere else", async () => {
    const { api, ask, disk, events, host } = await setup({ shops: true });
    const { signIn } = await ask("connections.password", { shop: SHOP_A.id, signIn: "signin-a", password: PASSWORD });
    expect(signIn).toMatchObject({ id: "signin-a", state: "working", brokenAt: null, passwordSetAt: NOW / 1000 });
    const sent = api.to("POST", PASSWORD_PATH);
    expect(sent.map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { signInId: "signin-a", password: PASSWORD }]]);
    // Before it went, the same session read the sign-ins, so it went with a session that works, for a sign-in the shop has.
    const vaultCalls = api.calls.filter((c) => c.path.startsWith("/v1/vault/"));
    expect(vaultCalls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SIGN_INS_PATH}`, `POST ${PASSWORD_PATH}`]);
    // Every other request, the saved read of the shop, the events and what the host holds carry none of it.
    for (const call of api.calls.filter((c) => c !== sent[0])) expect(JSON.stringify(call)).not.toContain(PASSWORD);
    expect(JSON.stringify([...disk.files.values()])).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(host)).not.toContain(PASSWORD);
  });

  it("is sent with the sign-in while the person is in no shops", async () => {
    const { api, ask } = await setup({ shops: false });
    await ask("connections.password", { shop: null, signIn: "signin-1", password: PASSWORD });
    expect(api.to("POST", PASSWORD_PATH).map((c) => [c.bearer, c.body])).toEqual([["access-1", { signInId: "signin-1", password: PASSWORD }]]);
  });

  it("is never sent twice: a 401 asks the owner to type it again, with no second try", async () => {
    for (const shops of [true, false]) {
      const { api, ask } = await setup({ shops });
      api.on("POST", PASSWORD_PATH, { status: 401, json: { error: "unauthorized" } });
      const out = await refusal(ask("connections.password", { shop: shops ? SHOP_A.id : null, signIn: shops ? "signin-a" : "signin-1", password: PASSWORD }));
      expect(out).toEqual({ code: "not_saved", message: t("conn.err.again") });
      expect(api.to("POST", PASSWORD_PATH), `in shops: ${shops}`).toHaveLength(1);
      expect(out?.message).not.toContain(PASSWORD);
    }
  });

  it("is not sent for a sign-in the shop no longer lists, for a password the vault would not take, or to a shop the person helps at", async () => {
    const { api, ask, vaults } = await setup({ shops: true });
    vaults[SHOP_A.id].signIns = [];
    expect((await refusal(ask("connections.password", { shop: SHOP_A.id, signIn: "signin-a", password: PASSWORD })))?.code).toBe("sign_in_not_found");
    for (const password of ["", "x".repeat(1025)]) {
      expect(await refusal(ask("connections.password", { shop: SHOP_A.id, signIn: "signin-a", password }))).toEqual({
        code: "invalid_password",
        message: t("conn.err.password", { max: 1024 }),
      });
    }
    expect((await refusal(ask("connections.password", { shop: SHOP_B.id, signIn: "signin-b", password: PASSWORD })))?.code).toBe("owner_only");
    expect((await refusal(ask("connections.password", { shop: "pilot:elsewhere", signIn: "signin-a", password: PASSWORD })))?.code).toBe("not_found");
    // The person is in shops, so the signed-in tenant is not one they act for here.
    expect((await refusal(ask("connections.password", { shop: null, signIn: "signin-1", password: PASSWORD })))?.code).toBe("not_found");
    expect(api.to("POST", PASSWORD_PATH)).toEqual([]);
    for (const call of api.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD);
  });

  it("sends nothing while only a kept read of the shop is shown", async () => {
    const { api, ask, host } = await setup({ shops: false });
    host.cache = { kind: "showing", at: NOW - 60_000 };
    const before = api.calls.length;
    for (const [op, params] of [
      ["connections.list", {}],
      ["connections.add", { shop: null, ...NEW_SIGN_IN }],
      ["connections.password", { shop: null, signIn: "signin-1", password: PASSWORD }],
      ["connections.members", { shop: null, signIn: "signin-1", members: ["kit"] }],
      ["connections.change", { shop: null, signIn: "signin-1", ...MOVED }],
      ["connections.removeSignIn", { shop: null, signIn: "signin-1" }],
      ["connections.rename", { shop: null, outpost: "outpost-1", name: "Counter Mac" }],
      ["connections.remove", { shop: null, outpost: "outpost-1" }],
    ] as const) {
      expect(await refusal((ask as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toEqual({ code: "offline", message: t("rt.offline") });
    }
    expect(api.calls.length).toBe(before);
  });
});

describe("renaming and removing an outpost", () => {
  it("sends exactly the outpost and its name, trimmed, to the shop its row was read for, even after the switcher moved", async () => {
    const { api, ask } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_B.id });
    expect((await ask("connections.rename", { shop: SHOP_A.id, outpost: "outpost-a", name: "  Counter Mac  " })).outpost.name).toBe("Counter Mac");
    expect(await ask("connections.remove", { shop: SHOP_A.id, outpost: "cloud-a" })).toEqual({ outpost: "cloud-a" });
    expect(api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/vault/")).map((c) => [c.path, c.bearer, c.body])).toEqual([
      [RENAME_PATH, OWNER_A, { outpostId: "outpost-a", name: "Counter Mac" }],
      [REMOVE_PATH, OWNER_A, { outpostId: "cloud-a" }],
    ]);
  });

  it("refuses a name the vault would not take with nothing sent, and says the vault's refusals in words", async () => {
    const { api, ask } = await setup({ shops: false });
    for (const name of ["   ", "x".repeat(81), "Mac\u0007"]) {
      expect(await refusal(ask("connections.rename", { shop: null, outpost: "outpost-1", name }))).toEqual({ code: "invalid_name", message: t("conn.err.name", { max: 80 }) });
    }
    expect(api.to("POST", RENAME_PATH)).toEqual([]);
    expect(await refusal(ask("connections.remove", { shop: null, outpost: "outpost-9" }))).toEqual({ code: "outpost_not_found", message: t("conn.err.outpostGone") });
    expect(await refusal(ask("connections.rename", { shop: null, outpost: "outpost-9", name: "Mac" }))).toEqual({ code: "outpost_not_found", message: t("conn.err.outpostGone") });
  });
});

describe("adding a sign-in", () => {
  it("sends exactly its five fields once, with the shop's own session, after a read, and the password is found nowhere else", async () => {
    const { api, ask, disk, events, host } = await setup({ shops: true });
    const { signIn } = await ask("connections.add", { shop: SHOP_A.id, ...NEW_SIGN_IN, site: "  Carrier portal " });
    expect(signIn).toMatchObject({ id: "signin-new-2", site: "Carrier portal", members: ["nam", "ton"], state: "working", lastUsedAt: null, createdAt: NOW / 1000 });
    const sent = api.to("POST", SIGN_INS_PATH);
    expect(sent.map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { ...NEW_SIGN_IN, site: "Carrier portal" }]]);
    // Before it went, the same session read the sign-ins, so it went with a session that works, to a vault with room.
    const vaultCalls = api.calls.filter((c) => c.path.startsWith("/v1/vault/"));
    expect(vaultCalls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SIGN_INS_PATH}`, `POST ${SIGN_INS_PATH}`]);
    for (const call of api.calls.filter((c) => c !== sent[0])) expect(JSON.stringify(call)).not.toContain(PASSWORD);
    expect(JSON.stringify([...disk.files.values()])).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(host)).not.toContain(PASSWORD);
    expect(JSON.stringify(signIn)).not.toContain(PASSWORD);
  });

  it("is sent with the sign-in while the person is in no shops, and to the shop its rows were read for after the switcher moved", async () => {
    const alone = await setup({ shops: false });
    await alone.ask("connections.add", { shop: null, ...NEW_SIGN_IN });
    expect(alone.api.to("POST", SIGN_INS_PATH).map((c) => c.bearer)).toEqual(["access-1"]);
    const inShops = await setup({ shops: true });
    await inShops.ask("shops.switch", { shop: SHOP_B.id });
    await inShops.ask("connections.add", { shop: SHOP_A.id, ...NEW_SIGN_IN });
    expect(inShops.api.to("POST", SIGN_INS_PATH).map((c) => c.bearer)).toEqual([OWNER_A]);
  });

  it("is never sent twice: a 401 asks the owner to type the password again, with no second try", async () => {
    for (const shops of [true, false]) {
      const { api, ask } = await setup({ shops });
      api.on("POST", SIGN_INS_PATH, { status: 401, json: { error: "unauthorized" } });
      const out = await refusal(ask("connections.add", { shop: shops ? SHOP_A.id : null, ...NEW_SIGN_IN }));
      expect(out).toEqual({ code: "not_saved", message: t("conn.err.again") });
      expect(api.to("POST", SIGN_INS_PATH), `in shops: ${shops}`).toHaveLength(1);
    }
  });

  it("is refused with nothing sent for what the vault would not take, a full vault, or a shop the person helps at", async () => {
    const { api, ask, vaults } = await setup({ shops: true });
    const refused = async (over: Record<string, unknown>, shop: string | null = SHOP_A.id) =>
      refusal((ask as (op: string, p: unknown) => Promise<unknown>)("connections.add", { shop, ...NEW_SIGN_IN, ...over }));
    for (const [over, code, words] of [
      [{ site: "  " }, "invalid_site", t("conn.err.site", { max: 80 })],
      [{ site: "x".repeat(81) }, "invalid_site", t("conn.err.site", { max: 80 })],
      [{ origins: [] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ origins: ["http://track.carrier.example"] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ origins: ["https://track.carrier.example/parcels"] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ origins: ["https://track.carrier.example", "https://track.carrier.example"] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ username: "" }, "invalid_username", t("conn.err.username", { max: 256 })],
      [{ password: "" }, "invalid_password", t("conn.err.password", { max: 1024 })],
      [{ password: "x".repeat(1025) }, "invalid_password", t("conn.err.password", { max: 1024 })],
      [{ members: [] }, "invalid_members", t("conn.err.members")],
      [{ members: ["buddy"] }, "invalid_members", t("conn.err.members")],
    ] as const) {
      expect(await refused(over), JSON.stringify(over)).toEqual({ code, message: words });
    }
    expect((await refused({}, SHOP_B.id))?.code).toBe("owner_only");
    expect((await refused({}, "pilot:elsewhere"))?.code).toBe("not_found");
    expect((await refused({}, null))?.code).toBe("not_found");
    // A vault that already keeps 50 takes no more: the read before the send says so, and the password stays here.
    vaults[SHOP_A.id].signIns = Array.from({ length: 50 }, (_, i) => signInJson({ id: `signin-${i}` }));
    expect(await refused({})).toEqual({ code: "too_many_sign_ins", message: t("conn.err.tooMany", { max: 50 }) });
    expect(api.to("POST", SIGN_INS_PATH)).toEqual([]);
    for (const call of api.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD);
  });

  it("says the API's own refusals in words", async () => {
    const { api, ask } = await setup({ shops: false });
    api.on("POST", SIGN_INS_PATH, { status: 400, json: { error: "invalid_origins" } }, { status: 409, json: { error: "too_many_sign_ins" } },
      { status: 503, json: { error: "vault_not_configured" } });
    expect(await refusal(ask("connections.add", { shop: null, ...NEW_SIGN_IN }))).toEqual({ code: "invalid_origins", message: t("conn.err.origins", { max: 5 }) });
    expect(await refusal(ask("connections.add", { shop: null, ...NEW_SIGN_IN }))).toEqual({ code: "too_many_sign_ins", message: t("conn.err.tooMany", { max: 50 }) });
    expect((await refusal(ask("connections.add", { shop: null, ...NEW_SIGN_IN })))?.message).not.toContain(PASSWORD);
  });
});

describe("who may use a sign-in", () => {
  it("sends exactly the sign-in and the members to the shop its row was read for, even after the switcher moved", async () => {
    const { api, ask } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_B.id });
    const { signIn } = await ask("connections.members", { shop: SHOP_A.id, signIn: "signin-a", members: ["nam", "kit"] });
    expect(signIn).toMatchObject({ id: "signin-a", members: ["nam", "kit"] });
    expect(api.to("POST", MEMBERS_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { signInId: "signin-a", members: ["nam", "kit"] }]]);
  });

  it("refuses members the vault would not take with nothing sent, and says the vault's refusals in words", async () => {
    const { api, ask } = await setup({ shops: true });
    for (const members of [[], ["buddy"], ["nam", "nam"], ["nam", "pim", "ton", "kit", "nam"]]) {
      expect(await refusal(ask("connections.members", { shop: SHOP_A.id, signIn: "signin-a", members })), JSON.stringify(members))
        .toEqual({ code: "invalid_members", message: t("conn.err.members") });
    }
    expect((await refusal(ask("connections.members", { shop: SHOP_B.id, signIn: "signin-b", members: ["kit"] })))?.code).toBe("owner_only");
    expect(api.to("POST", MEMBERS_PATH)).toEqual([]);
    expect(await refusal(ask("connections.members", { shop: SHOP_A.id, signIn: "signin-gone", members: ["kit"] }))).toEqual({
      code: "sign_in_not_found",
      message: t("conn.err.signInGone"),
    });
  });
});

describe("changing a sign-in's account or addresses", () => {
  it("sends exactly the four fields once, with the shop's own session, after a read, and the password is found nowhere else", async () => {
    const { api, ask, disk, events, host } = await setup({ shops: true });
    const { signIn } = await ask("connections.change", { shop: SHOP_A.id, signIn: "signin-a", ...MOVED });
    // Typed again, the password mends the broken sign-in, as a new password does; the answer holds none.
    expect(signIn).toMatchObject({ id: "signin-a", origins: MOVED.origins, username: MOVED.username, state: "working", passwordSetAt: NOW / 1000 });
    const sent = api.to("POST", CHANGE_PATH);
    expect(sent.map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { signInId: "signin-a", ...MOVED }]]);
    // Before it went, the same session read the sign-ins: one that works, for a sign-in the shop has, at the addresses checked.
    expect(api.calls.filter((c) => c.path.startsWith("/v1/vault/")).map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SIGN_INS_PATH}`, `POST ${CHANGE_PATH}`]);
    for (const call of api.calls.filter((c) => c !== sent[0])) expect(JSON.stringify(call)).not.toContain(PASSWORD);
    expect(JSON.stringify([...disk.files.values()])).not.toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expect(JSON.stringify(host)).not.toContain(PASSWORD);
    expect(JSON.stringify(signIn)).not.toContain(PASSWORD);
  });

  it("takes addresses away with no password at all, and leaves whether the sign-in works as it was", async () => {
    const { api, ask, vaults } = await setup({ shops: false });
    vaults[SIGNED_IN].signIns[0]!.origins = ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"];
    const { signIn } = await ask("connections.change", { shop: null, signIn: "signin-1", origins: ["https://accounts.shopee.co.th"],
      username: "baan.mali@example.com", password: null });
    expect(signIn).toMatchObject({ origins: ["https://accounts.shopee.co.th"], state: "broken" });
    expect(api.to("POST", CHANGE_PATH).map((c) => [c.bearer, c.body])).toEqual([["access-1", { signInId: "signin-1",
      origins: ["https://accounts.shopee.co.th"], username: "baan.mali@example.com", password: null }]]);
  });

  it("is never sent twice when it carries a password: a 401 asks the owner to type it again, with no second try", async () => {
    for (const shops of [true, false]) {
      const { api, ask } = await setup({ shops });
      api.on("POST", CHANGE_PATH, { status: 401, json: { error: "unauthorized" } });
      const out = await refusal(ask("connections.change", { shop: shops ? SHOP_A.id : null, signIn: shops ? "signin-a" : "signin-1", ...MOVED }));
      expect(out).toEqual({ code: "not_saved", message: t("conn.err.again") });
      expect(api.to("POST", CHANGE_PATH), `in shops: ${shops}`).toHaveLength(1);
      expect(out?.message).not.toContain(PASSWORD);
    }
  });

  it("refuses with nothing sent a change the vault would refuse: a new address or account with no password, no change, a bad value", async () => {
    const { api, ask, vaults } = await setup({ shops: true });
    const change = (over: Record<string, unknown>, shop: string | null = SHOP_A.id) =>
      refusal((ask as (op: string, p: unknown) => Promise<unknown>)("connections.change", { shop, signIn: "signin-a", ...MOVED, ...over }));
    for (const [over, code, words] of [
      // Checked against what the read lists for it: https://seller.shopee.co.th, for baan.mali@example.com.
      [{ password: null }, "password_required", t("conn.err.passwordAgain")],
      [{ password: null, origins: ["https://seller-centre.attacker.example"] }, "password_required", t("conn.err.passwordAgain")],
      [{ password: null, origins: ["https://seller.shopee.co.th"], username: "orders@baanmali.example" }, "password_required", t("conn.err.passwordAgain")],
      [{ password: null, origins: ["https://seller.shopee.co.th"] }, "no_change", t("conn.err.noChange")],
      [{ origins: ["https://seller.shopee.co.th"] }, "no_change", t("conn.err.noChange")],
      // Each value by the rules adding uses, before anything is read.
      [{ origins: [] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ origins: ["http://seller.shopee.co.th"] }, "invalid_origins", t("conn.err.origins", { max: 5 })],
      [{ username: "" }, "invalid_username", t("conn.err.username", { max: 256 })],
      [{ password: "" }, "invalid_password", t("conn.err.password", { max: 1024 })],
      [{ password: "x".repeat(1025) }, "invalid_password", t("conn.err.password", { max: 1024 })],
    ] as const) {
      expect(await change(over), JSON.stringify(over)).toEqual({ code, message: words });
    }
    expect((await change({}, SHOP_B.id))?.code).toBe("owner_only");
    expect((await change({}, "pilot:elsewhere"))?.code).toBe("not_found");
    expect((await change({}, null))?.code).toBe("not_found");
    // A sign-in the shop no longer lists is not changed: the read says so, and the password stays here.
    vaults[SHOP_A.id].signIns = [];
    expect(await change({})).toEqual({ code: "sign_in_not_found", message: t("conn.err.signInGone") });
    expect(api.to("POST", CHANGE_PATH)).toEqual([]);
    for (const call of api.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD);
  });

  it("says the API's own refusals in words", async () => {
    const { api, ask } = await setup({ shops: false });
    api.on("POST", CHANGE_PATH, { status: 400, json: { error: "password_required" } }, { status: 400, json: { error: "no_change" } },
      { status: 404, json: { error: "sign_in_not_found" } });
    const change = () => refusal(ask("connections.change", { shop: null, signIn: "signin-1", ...MOVED }));
    expect(await change()).toEqual({ code: "password_required", message: t("conn.err.passwordAgain") });
    expect(await change()).toEqual({ code: "no_change", message: t("conn.err.noChange") });
    expect(await change()).toEqual({ code: "sign_in_not_found", message: t("conn.err.signInGone") });
  });
});

describe("removing a sign-in", () => {
  it("sends exactly the sign-in to the shop its row was read for, even after the switcher moved", async () => {
    const { api, ask, vaults } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_B.id });
    expect(await ask("connections.removeSignIn", { shop: SHOP_A.id, signIn: "signin-a" })).toEqual({ signIn: "signin-a" });
    expect(api.to("POST", REMOVE_SIGN_IN_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { signInId: "signin-a" }]]);
    expect(vaults[SHOP_A.id].signIns).toEqual([]);
  });

  it("refuses a shop the person helps at with nothing sent, and says a sign-in already gone in words", async () => {
    const { api, ask } = await setup({ shops: true });
    expect((await refusal(ask("connections.removeSignIn", { shop: SHOP_B.id, signIn: "signin-b" })))?.code).toBe("owner_only");
    expect(api.to("POST", REMOVE_SIGN_IN_PATH)).toEqual([]);
    expect(await refusal(ask("connections.removeSignIn", { shop: SHOP_A.id, signIn: "signin-gone" }))).toEqual({
      code: "sign_in_not_found",
      message: t("conn.err.signInGone"),
    });
  });
});
