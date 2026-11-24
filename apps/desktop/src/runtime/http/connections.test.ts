// Customize › Connections on the connected runtime (connections.ts), through the real host and session over a fake API:
// the vault read with the session of the shop the switcher shows (or the sign-in while the person is in no shops), a
// shop the person helps at refused with nothing sent, the owner's new password sent once to the password route and
// found nowhere else, a change sent to the shop its row was read for, and nothing sent while only a kept read is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { ShopCache } from "./cache";
import { OUTPOSTS_PATH, PASSWORD_PATH, REMOVE_PATH, RENAME_PATH, SIGN_INS_PATH } from "./connections";
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
        { id: "signin-1", site: "Shopee Seller Centre", members: ["nam", "ton"], state: "broken", passwordSetAt: (T0 - 86_400_000) / 1000,
          brokenAt: (T0 + 60_000) / 1000, brokenBy: "nam", lastUsedAt: T0 / 1000, lastUsedBy: "ton", createdAt: (T0 - 86_400_000) / 1000 },
      ],
      outposts: [{ id: "outpost-1", name: "This Mac", kind: "this_mac", online: true, lastSeenAt: (NOW - 10_000) / 1000, createdAt: T0 / 1000 }],
    });
    expect([...api.to("GET", SIGN_INS_PATH), ...api.to("GET", OUTPOSTS_PATH)].map((c) => c.bearer)).toEqual(["access-1", "access-1"]);
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
    vaults[SIGNED_IN].signIns.push(signInJson({ id: "signin-2", state: "paused" }), { id: "signin-3" });
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
      ["connections.password", { shop: null, signIn: "signin-1", password: PASSWORD }],
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
