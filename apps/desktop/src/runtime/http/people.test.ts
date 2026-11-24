// Settings › People on the connected runtime (people.ts), through the real host and session over a fake API: the people read with
// the owner's session of the shop the switcher shows, a shop the person helps at refused with nothing sent, a person in no shops
// with nothing to manage and nothing sent, each change sent exactly, to the shop its list was read for and with that shop's own
// session, the API's refusals said in words, an answer this build cannot read shown as nothing, and nothing sent while only a kept
// read of the shop is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { ShopCache } from "./cache";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { AWAY_PATH, CANCEL_INVITE_PATH, CLEAR_AWAY_PATH, decodeHelper, decodeIdentity, decodeInvite, INVITE_PATH, PEOPLE_PATH, peopleOf, readLink, REMOVE_HELPER_PATH } from "./people";
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
  type ShopJson,
} from "./testkit";

const NOW = T0 + 600_000;
/** A second shop the person owns, so a change can be shown to go to the shop it was read for and not the one shown after. */
const SHOP_C: ShopJson = { id: "pilot:shop-c", name: "Suan Dok Mai", ownerName: "Fon", role: "owner" };
const SIGNED_IN = "apple:owner-1";
const OWNER_A = shopToken(SHOP_A.id, "owner");
const OWNER_C = shopToken(SHOP_C.id, "owner");
const LINK = `${ORIGIN}/join/signed-token-1`;

const helperJson = (over: Record<string, unknown> = {}) => ({
  id: "helper-mint",
  name: "Mint",
  identity: { kind: "email", address: "mint@example.com" },
  joinedAt: iso(T0 - 22 * 86_400_000),
  devices: 2,
  ...over,
});
const inviteJson = (over: Record<string, unknown> = {}) => ({
  id: "inv-beam",
  name: "Beam",
  identity: { kind: "line", id: "beam.baanmali" },
  status: "pending",
  createdAt: iso(NOW - 40 * 60_000),
  expiresAt: iso(NOW - 40 * 60_000 + 7 * 86_400_000),
  inviteUrl: LINK,
  ...over,
});

interface ShopPeopleJson {
  owner: { name: string; account: { id: string; linkedAt: string; devices: number } | null };
  helpers: Record<string, unknown>[];
  invites: Record<string, unknown>[];
  away: Record<string, unknown> | null;
}

const freshPeople = (): ShopPeopleJson => ({
  owner: { name: "Fon", account: { id: "owner-account-1", linkedAt: iso(T0 - 86_400_000), devices: 1 } },
  helpers: [helperJson()],
  invites: [inviteJson()],
  away: null,
});

/** The people routes as apps/api answers them from a shop session (docs/pilot-api.md, "The owner's own routes"): an owner session
 *  reads and changes its own shop, a helper session is told 403 `owner_only`, and the sign-in's own tenant is no pilot shop (404). A
 *  body is exactly the fields a route reads, and anything more answers 400 `invalid_request`. */
function servePeople(api: FakeApi, served: ServedShops | null) {
  const shops: Record<string, ShopPeopleJson> = { [SHOP_A.id]: freshPeople(), [SHOP_C.id]: { ...freshPeople(), helpers: [helperJson({ id: "helper-c", name: "Ploy" })], invites: [] } };
  const at = (req: Recorded, then: (people: ShopPeopleJson, shop: string) => FakeAnswer): FakeAnswer => {
    if (req.bearer?.startsWith("access-")) return { status: 404, json: { error: "not_found" } };
    const held = req.bearer ? served?.tokens.get(req.bearer) : undefined;
    if (!held || served?.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    const ended = served?.ended[held.shop];
    if (ended) return { status: 401, json: { error: ended.error, [`${ended.error}At`]: ended.at } };
    if (held.role !== "owner") return { status: 403, json: { error: "owner_only" } };
    return then(shops[held.shop], held.shop);
  };
  const exactly = (req: Recorded, keys: string[]) => {
    const body = req.body;
    return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every((k) => k in (body as object));
  };
  const bad: FakeAnswer = { status: 400, json: { error: "invalid_request" } };
  let n = 0;
  api
    .on("GET", PEOPLE_PATH, (req) => at(req, (p, shop) => ({ status: 200, json: { tenant: shop, ...p } })))
    .on("POST", INVITE_PATH, (req) =>
      at(req, (p) => {
        if (!exactly(req, ["name", "identity"])) return bad;
        const { name, identity } = req.body as { name: string; identity: { kind: string; id?: string; address?: string } };
        if (identity.kind === "line" ? !identity.id : !/^[^\s@]+@[^\s@]+$/.test(identity.address ?? "")) return { status: 400, json: { error: "bad_identity" } };
        const same = (x: { kind: string; id?: string; address?: string }) => x.kind === identity.kind && (x.id ?? x.address?.toLowerCase()) === (identity.id ?? identity.address?.toLowerCase());
        if (p.helpers.some((h) => same(h.identity as never))) return { status: 409, json: { error: "already_helper" } };
        if (p.invites.some((i) => i.status === "pending" && same(i.identity as never))) return { status: 409, json: { error: "already_invited" } };
        const made = inviteJson({ id: `inv-${++n}`, name, identity, inviteUrl: undefined, createdAt: iso(NOW), expiresAt: iso(NOW + 7 * 86_400_000) });
        p.invites.push({ ...made, inviteUrl: `${ORIGIN}/join/token-${n}` });
        return { status: 200, json: { invite: made, inviteUrl: `${ORIGIN}/join/token-${n}` } };
      }),
    )
    .on("POST", CANCEL_INVITE_PATH, (req) =>
      at(req, (p) => {
        if (!exactly(req, ["inviteId"])) return bad;
        const found = p.invites.find((i) => i.id === (req.body as { inviteId: string }).inviteId);
        if (!found) return { status: 404, json: { error: "unknown_invite" } };
        if (found.status !== "pending") return { status: 409, json: { error: "not_pending" } };
        found.status = "revoked";
        delete found.inviteUrl;
        return { status: 200, json: { invite: found } };
      }),
    )
    .on("POST", REMOVE_HELPER_PATH, (req) =>
      at(req, (p) => {
        if (!exactly(req, ["helperId"])) return bad;
        const id = (req.body as { helperId: string }).helperId;
        const helper = p.helpers.find((h) => h.id === id);
        if (!helper) return { status: 404, json: { error: "not_a_helper" } };
        p.helpers = p.helpers.filter((h) => h !== helper);
        const revoked = p.invites.filter((i) => i.status === "pending" && JSON.stringify(i.identity) === JSON.stringify(helper.identity));
        revoked.forEach((i) => (i.status = "revoked"));
        const coverEnded = p.away?.helperId === id;
        if (coverEnded) p.away = null;
        return { status: 200, json: { removed: id, sessionsEnded: helper.devices, invitesRevoked: revoked.map((i) => i.id), coverEnded } };
      }),
    )
    .on("POST", AWAY_PATH, (req) =>
      at(req, (p) => {
        if (!exactly(req, ["helperId", "until"])) return bad;
        const { helperId, until } = req.body as { helperId: string; until: string };
        const when = Date.parse(until);
        if (!Number.isFinite(when) || when <= NOW) return { status: 400, json: { error: "bad_date" } };
        const helper = p.helpers.find((h) => h.id === helperId);
        if (!helper) return { status: 404, json: { error: "not_a_helper" } };
        p.away = { helperId, name: helper.name, until: iso(when), inForce: true };
        return { status: 200, json: { away: p.away } };
      }),
    )
    .on("POST", CLEAR_AWAY_PATH, (req) =>
      at(req, (p) => {
        if (!exactly(req, [])) return bad;
        p.away = null;
        return { status: 200, json: { away: null } };
      }),
    );
  return shops;
}

/** The connected runtime as the app runs it, for a person in shops A and C (owned) and B (helped), or in none. */
async function setup(opts: { shops: boolean }) {
  const api = fakeApi();
  const served = opts.shops ? serveShops(api, [SHOP_A, SHOP_C, SHOP_B]) : null;
  if (!opts.shops) serveShop(api).on("GET", "/v1/shops", { status: 200, json: { shops: [] } });
  const shops = servePeople(api, served);
  const disk = memoryCacheStore();
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
  const host = new HttpHost({ session, cache: new ShopCache(disk) });
  const rt = new HttpRuntime(host);
  await rt.connect();
  const ask = rt.request.bind(rt);
  return { api, served, shops, host, rt, ask, disk };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
/** The requests made to the people routes this page uses: not the host's own look at which helpers signed in (`/v1/people/devices`). */
const peopleCalls = (api: FakeApi) => api.calls.filter((c) => c.path.startsWith("/v1/people") && c.path !== "/v1/people/devices");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading the people", () => {
  it("reads the shop the switcher shows with that shop's own owner session, field by field", async () => {
    const { api, ask } = await setup({ shops: true });
    const listed = await ask("people.list", {});
    expect(listed).toEqual({
      shop: SHOP_A.id,
      owner: { name: "Fon", devices: 1 },
      helpers: [{ id: "helper-mint", name: "Mint", identity: { kind: "email", address: "mint@example.com" }, joinedAt: (T0 - 22 * 86_400_000) / 1000, devices: 2 }],
      invites: [
        { id: "inv-beam", name: "Beam", identity: { kind: "line", id: "beam.baanmali" }, state: "pending", createdAt: (NOW - 40 * 60_000) / 1000, expiresAt: (NOW - 40 * 60_000 + 7 * 86_400_000) / 1000, link: LINK },
      ],
      away: null,
    });
    expect(peopleCalls(api).map((c) => [c.method, c.path, c.bearer])).toEqual([["GET", PEOPLE_PATH, OWNER_A]]);
  });

  it("reads the next shop after a switch, with the next shop's session", async () => {
    const { api, ask } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_C.id });
    const listed = await ask("people.list", {});
    expect(listed.shop).toBe(SHOP_C.id);
    expect(listed.helpers.map((h) => h.name)).toEqual(["Ploy"]);
    expect(peopleCalls(api).map((c) => c.bearer)).toEqual([OWNER_C]);
  });

  it("lists only the invites that wait or ran out, newest first, and says which is which", async () => {
    const { ask, shops } = await setup({ shops: true });
    shops[SHOP_A.id].invites = [
      inviteJson({ id: "old", name: "Old", createdAt: iso(NOW - 9 * 86_400_000), expiresAt: iso(NOW - 2 * 86_400_000), status: "expired", inviteUrl: undefined }),
      inviteJson({ id: "used", status: "used" }),
      inviteJson({ id: "gone", status: "revoked" }),
      inviteJson({ id: "new", name: "New", createdAt: iso(NOW - 60_000) }),
      inviteJson({ id: "mid", name: "Mid", createdAt: iso(NOW - 3_600_000), identity: { kind: "email", address: "mid@example.com" } }),
    ];
    const { invites } = await ask("people.list", {});
    expect(invites.map((i) => [i.id, i.state, i.link !== null])).toEqual([
      ["new", "pending", true],
      ["mid", "pending", true],
      ["old", "expired", false],
    ]);
  });

  it("shows the cover and whether it is in force, and no cover when the API says none", async () => {
    const { ask, shops } = await setup({ shops: true });
    expect((await ask("people.list", {})).away).toBeNull();
    shops[SHOP_A.id].away = { helperId: "helper-mint", name: "Mint", until: iso(NOW + 86_400_000), inForce: true };
    expect((await ask("people.list", {})).away).toEqual({ helperId: "helper-mint", name: "Mint", until: (NOW + 86_400_000) / 1000, inForce: true });
    shops[SHOP_A.id].away = { helperId: "helper-mint", name: "Mint", until: iso(NOW - 3_600_000), inForce: false };
    expect((await ask("people.list", {}))?.away?.inForce).toBe(false);
  });

  it("leaves out what this build cannot read rather than guessing at it", async () => {
    const { ask, shops } = await setup({ shops: true });
    shops[SHOP_A.id].helpers = [
      helperJson(),
      helperJson({ id: "no-time", joinedAt: "yesterday" }),
      helperJson({ id: "no-identity", identity: { kind: "phone", number: "081" } }),
      helperJson({ id: "no-devices", devices: -1 }),
      { name: "No id" },
    ];
    shops[SHOP_A.id].invites = [inviteJson(), inviteJson({ id: "inv-x", status: "paused" }), inviteJson({ id: "inv-y", expiresAt: "soon" })];
    shops[SHOP_A.id].away = { helperId: "helper-mint", until: "someday", inForce: "yes" } as never;
    const listed = await ask("people.list", {});
    expect(listed.helpers.map((h) => h.id)).toEqual(["helper-mint"]);
    expect(listed.invites.map((i) => i.id)).toEqual(["inv-beam"]);
    expect(listed.away).toBeNull();
  });

  it("shows no link for an address that is not a web address, and never reads a link for an invite that is not waiting", () => {
    expect(readLink("https://dev.manut.xyz/join/abc")).toBe("https://dev.manut.xyz/join/abc");
    expect(readLink("http://127.0.0.1:8787/join/abc")).toBe("http://127.0.0.1:8787/join/abc");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "join/abc", "", 7, null, undefined, `https://x.test/${"a".repeat(2100)}`]) expect(readLink(bad), String(bad)).toBeNull();
    expect(decodeInvite(inviteJson({ status: "expired" }))?.link).toBeNull();
    expect(decodeInvite(inviteJson({ inviteUrl: "javascript:alert(1)" }))?.link).toBeNull();
    expect(decodeInvite(inviteJson())?.link).toBe(LINK);
  });

  it("reads each field of a helper, an identity and a list for what it is", () => {
    expect(decodeIdentity({ kind: "line", id: "beam", extra: 1 })).toEqual({ kind: "line", id: "beam" });
    expect(decodeIdentity({ kind: "email", address: "" })).toBeNull();
    expect(decodeIdentity({ kind: "line", id: "x".repeat(257) })).toBeNull();
    expect(decodeHelper({ ...helperJson(), name: 7 })?.name).toBe("");
    expect(decodeHelper(null)).toBeNull();
    for (const json of [null, [], {}, { owner: { name: "Fon" }, helpers: {}, invites: [] }, { owner: { name: 7 }, helpers: [], invites: [] }, { owner: { name: "Fon" }, helpers: [] }]) {
      expect(peopleOf(json, "pilot:a"), JSON.stringify(json)).toBeNull();
    }
    expect(peopleOf({ owner: { name: "Fon", account: null }, helpers: [], invites: [] }, "pilot:a")).toEqual({ shop: "pilot:a", owner: { name: "Fon", devices: null }, helpers: [], invites: [], away: null });
  });

  it("says so when the answer is not a people list, and reads nothing from it", async () => {
    const { api, ask } = await setup({ shops: true });
    api.on("GET", PEOPLE_PATH, { status: 200, json: { people: [] } });
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "unavailable", message: t("people.err.unreadable") });
  });
});

describe("who may see or change the people", () => {
  it("sends nothing for a person in no shops, whose own tenant is no shop", async () => {
    const { api, ask } = await setup({ shops: false });
    const before = api.calls.length;
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "no_shop", message: t("people.err.noShop") });
    expect((await refusal(ask("people.invite", { shop: "pilot:none", name: "Beam", identity: { kind: "line", id: "beam" } })))?.code).toBe("not_found");
    expect(peopleCalls(api)).toEqual([]);
    expect(api.calls.length).toBe(before);
  });

  it("asks nothing of a shop the person only helps at, and sends no change to one: only its owner sees or changes its people", async () => {
    const { api, ask } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_B.id });
    const owner = { code: "owner_only", message: t("people.err.ownerOnly") };
    expect(await refusal(ask("people.list", {}))).toEqual(owner);
    const helped = SHOP_B.id;
    const writes: [string, Record<string, unknown>][] = [
      ["people.invite", { shop: helped, name: "Beam", identity: { kind: "line", id: "beam" } }],
      ["people.cancelInvite", { shop: helped, invite: "inv-1" }],
      ["people.remove", { shop: helped, helper: "helper-1" }],
      ["people.setAway", { shop: helped, helper: "helper-1", until: (NOW + 86_400_000) / 1000 }],
      ["people.clearAway", { shop: helped }],
    ];
    for (const [op, params] of writes) expect(await refusal((ask as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toEqual(owner);
    // The helper's session never carried a name, a LINE ID or an email: no request names the people routes with it.
    expect(peopleCalls(api).filter((c) => c.bearer === shopToken(SHOP_B.id, "helper"))).toEqual([]);
    expect(peopleCalls(api)).toEqual([]);
  });

  it("refuses a change for a shop that is not one of the person's, with nothing sent", async () => {
    const { api, ask } = await setup({ shops: true });
    expect((await refusal(ask("people.remove", { shop: "pilot:elsewhere", helper: "helper-mint" })))?.code).toBe("not_found");
    expect((await refusal(ask("people.clearAway", { shop: "pilot:elsewhere" })))?.code).toBe("not_found");
    expect(peopleCalls(api)).toEqual([]);
  });

  it("says in the departure's words when the person's place in the shop ended", async () => {
    const { ask, served } = await setup({ shops: true });
    served!.ended[SHOP_A.id] = { error: "unlinked", at: iso(NOW - 60_000) };
    const out = await refusal(ask("people.list", {}));
    expect(out?.code).toBe("unlinked");
    expect(out?.message).toContain("Baan Mali");
    // the shop is dropped from the person's list, and said to have left it
    const { shops, left } = await ask("shops.list", {});
    expect(shops.some((s) => s.id === SHOP_A.id)).toBe(false);
    expect(left.map((l) => [l.id, l.why])).toEqual([[SHOP_A.id, "unlinked"]]);
  });

  it("sends nothing while only a kept read of the shop is shown", async () => {
    const { api, ask, host } = await setup({ shops: true });
    host.cache = { kind: "showing", at: NOW - 60_000 };
    const before = api.calls.length;
    const a = SHOP_A.id;
    for (const [op, params] of [
      ["people.list", {}],
      ["people.invite", { shop: a, name: "Beam", identity: { kind: "line", id: "beam" } }],
      ["people.cancelInvite", { shop: a, invite: "inv-beam" }],
      ["people.remove", { shop: a, helper: "helper-mint" }],
      ["people.setAway", { shop: a, helper: "helper-mint", until: (NOW + 86_400_000) / 1000 }],
      ["people.clearAway", { shop: a }],
    ] as const) {
      expect(await refusal((ask as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toEqual({ code: "offline", message: t("rt.offline") });
    }
    expect(api.calls.length).toBe(before);
  });
});

describe("inviting a helper", () => {
  it("sends exactly the name and the account, to the shop's own session, and answers the invite with its link", async () => {
    const { api, ask } = await setup({ shops: true });
    const made = await ask("people.invite", { shop: SHOP_A.id, name: "  Tum  ", identity: { kind: "email", address: " tum@example.com " } });
    expect(made.invite).toEqual({
      id: "inv-1",
      name: "Tum",
      identity: { kind: "email", address: "tum@example.com" },
      state: "pending",
      createdAt: NOW / 1000,
      expiresAt: (NOW + 7 * 86_400_000) / 1000,
      link: `${ORIGIN}/join/token-1`,
    });
    expect(api.to("POST", INVITE_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { name: "Tum", identity: { kind: "email", address: "tum@example.com" } }]]);
  });

  it("makes an invite for a LINE ID, which nobody can open yet, as the API does", async () => {
    const { api, ask } = await setup({ shops: true });
    const made = await ask("people.invite", { shop: SHOP_A.id, name: "Nok", identity: { kind: "line", id: " nok.line " } });
    expect(made.invite.identity).toEqual({ kind: "line", id: "nok.line" });
    expect(api.to("POST", INVITE_PATH)[0].body).toEqual({ name: "Nok", identity: { kind: "line", id: "nok.line" } });
  });

  it("refuses a name or an account the rules would refuse with nothing sent, and says why in words", async () => {
    const { api, ask } = await setup({ shops: true });
    const a = SHOP_A.id;
    for (const name of ["", "   ", "x".repeat(81), "Mint\u0007", 7 as never]) {
      expect(await refusal(ask("people.invite", { shop: a, name, identity: { kind: "line", id: "x" } })), String(name)).toEqual({ code: "invalid_name", message: t("people.err.name", { max: 80 }) });
    }
    for (const identity of [{ kind: "line", id: "  " }, { kind: "email", address: "no-at-sign" }, { kind: "email", address: "a b@example.com" }, { kind: "line", id: "x", role: "owner" }, { kind: "phone" }, null, "beam"]) {
      expect(await refusal(ask("people.invite", { shop: a, name: "Beam", identity: identity as never })), JSON.stringify(identity)).toEqual({ code: "bad_identity", message: t("people.err.identity") });
    }
    expect(api.to("POST", INVITE_PATH)).toEqual([]);
  });

  it("counts a name by characters, not by code units, as the API does", async () => {
    const { ask } = await setup({ shops: true });
    // 80 characters, each two UTF-16 units: kept; 81: refused
    const ok = await ask("people.invite", { shop: SHOP_A.id, name: "🙂".repeat(80), identity: { kind: "line", id: "emoji" } });
    expect([...ok.invite.name]).toHaveLength(80);
    expect((await refusal(ask("people.invite", { shop: SHOP_A.id, name: "🙂".repeat(81), identity: { kind: "line", id: "emoji2" } })))?.code).toBe("invalid_name");
  });

  it("says the API's refusals in words, and each costs nothing", async () => {
    const { ask } = await setup({ shops: true });
    const a = SHOP_A.id;
    // Beam already has an invite waiting; Mint is already a helper.
    expect(await refusal(ask("people.invite", { shop: a, name: "Beam again", identity: { kind: "line", id: "beam.baanmali" } }))).toEqual({ code: "already_invited", message: t("people.err.alreadyInvited") });
    expect(await refusal(ask("people.invite", { shop: a, name: "Mint again", identity: { kind: "email", address: "MINT@example.com" } }))).toEqual({ code: "already_helper", message: t("people.err.alreadyHelper") });
  });

  it("says when the API does not answer (every 5xx, an invite link that cannot be made included) or answers what this build cannot read", async () => {
    const { api, ask } = await setup({ shops: true });
    const call = () => ask("people.invite", { shop: SHOP_A.id, name: "Tum", identity: { kind: "line", id: "tum" } });
    // The session keeps no body for a 5xx, so `not_configured` and `people_unavailable` are both no answer, said as one that may
    // or may not have changed the list: the page reads it again to see.
    for (const answer of [{ status: 503, json: { error: "not_configured", setting: "WEB_ORIGIN" } }, { status: 503, json: { error: "people_unavailable" } }, { status: 500, text: "oops" }]) {
      api.on("POST", INVITE_PATH, answer);
      expect(await refusal(call())).toEqual({ code: "unavailable", message: t("rt.change.noReply") });
    }
    api.on("POST", INVITE_PATH, { status: 200, json: { invite: { id: "x" } } });
    expect(await refusal(call())).toEqual({ code: "unavailable", message: t("people.err.unreadable") });
  });

  it("answers the invite without a link when the link cannot be read, since the invite is there all the same", async () => {
    const { api, ask } = await setup({ shops: true });
    api.on("POST", INVITE_PATH, { status: 200, json: { invite: inviteJson({ id: "inv-9", inviteUrl: undefined }), inviteUrl: "not a link" } });
    const made = await ask("people.invite", { shop: SHOP_A.id, name: "Tum", identity: { kind: "line", id: "tum" } });
    expect(made.invite).toMatchObject({ id: "inv-9", state: "pending", link: null });
  });

  it("keeps the invite's link out of the saved read of the shop, the events and everything the host holds", async () => {
    const { api, ask, disk, host } = await setup({ shops: true });
    const made = await ask("people.invite", { shop: SHOP_A.id, name: "Tum", identity: { kind: "email", address: "tum@example.com" } });
    const link = made.invite.link!;
    const sent = api.to("POST", INVITE_PATH)[0];
    for (const call of api.calls.filter((c) => c !== sent)) expect(JSON.stringify(call).includes(link) && call.method === "POST", `${call.method} ${call.path}`).toBe(false);
    expect(JSON.stringify([...disk.files.values()])).not.toContain(link);
    expect(JSON.stringify(host)).not.toContain(link);
    expect(JSON.stringify(host)).not.toContain("tum@example.com");
  });
});

describe("cancelling an invite, and removing a helper", () => {
  it("sends exactly the invite, and answers it by id", async () => {
    const { api, ask } = await setup({ shops: true });
    expect(await ask("people.cancelInvite", { shop: SHOP_A.id, invite: "inv-beam" })).toEqual({ invite: "inv-beam" });
    expect(api.to("POST", CANCEL_INVITE_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { inviteId: "inv-beam" }]]);
  });

  it("says in words that an invite is gone or was already used, and what is not an invite is not sent", async () => {
    const { api, ask } = await setup({ shops: true });
    expect(await refusal(ask("people.cancelInvite", { shop: SHOP_A.id, invite: "inv-nope" }))).toEqual({ code: "unknown_invite", message: t("people.err.inviteGone") });
    await ask("people.cancelInvite", { shop: SHOP_A.id, invite: "inv-beam" });
    expect(await refusal(ask("people.cancelInvite", { shop: SHOP_A.id, invite: "inv-beam" }))).toEqual({ code: "not_pending", message: t("people.err.notPending") });
    for (const invite of ["", 7 as never, "x".repeat(257)]) expect((await refusal(ask("people.cancelInvite", { shop: SHOP_A.id, invite })))?.code, String(invite)).toBe("unknown_invite");
    // Only the three that were invites went: inv-nope, inv-beam, and inv-beam again.
    expect(api.to("POST", CANCEL_INVITE_PATH)).toHaveLength(3);
  });

  it("answers a cancel that is not the invite it asked for as unreadable, never as done", async () => {
    const { api, ask } = await setup({ shops: true });
    for (const invite of [inviteJson({ id: "another", status: "revoked" }), inviteJson({ status: "pending" })]) {
      api.on("POST", CANCEL_INVITE_PATH, { status: 200, json: { invite } });
      expect(await refusal(ask("people.cancelInvite", { shop: SHOP_A.id, invite: "inv-beam" }))).toEqual({ code: "unavailable", message: t("people.err.unreadable") });
    }
  });

  it("removes a helper, sends exactly their id, and answers what the API says it did", async () => {
    const { api, ask, shops } = await setup({ shops: true });
    // Mint has an invite waiting for the same account, and the cover is Mint's: both go with them.
    shops[SHOP_A.id].invites.push(inviteJson({ id: "inv-mint", identity: { kind: "email", address: "mint@example.com" } }));
    shops[SHOP_A.id].away = { helperId: "helper-mint", name: "Mint", until: iso(NOW + 86_400_000), inForce: true };
    expect(await ask("people.remove", { shop: SHOP_A.id, helper: "helper-mint" })).toEqual({ helper: "helper-mint", sessionsEnded: 2, invitesRevoked: 1, coverEnded: true });
    expect(api.to("POST", REMOVE_HELPER_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { helperId: "helper-mint" }]]);
    expect((await ask("people.list", {})).helpers).toEqual([]);
  });

  it("says in words that a person is no longer a helper, and answers an unreadable removal as unreadable", async () => {
    const { api, ask } = await setup({ shops: true });
    expect(await refusal(ask("people.remove", { shop: SHOP_A.id, helper: "helper-nope" }))).toEqual({ code: "not_a_helper", message: t("people.err.notHelper") });
    expect((await refusal(ask("people.remove", { shop: SHOP_A.id, helper: "" })))?.code).toBe("not_a_helper");
    for (const json of [{}, { removed: "another", sessionsEnded: 1, invitesRevoked: [], coverEnded: false }, { removed: "helper-mint", sessionsEnded: "2", invitesRevoked: [], coverEnded: false }, { removed: "helper-mint", sessionsEnded: 2, invitesRevoked: 1, coverEnded: false }, { removed: "helper-mint", sessionsEnded: 2, invitesRevoked: [], coverEnded: "no" }]) {
      api.on("POST", REMOVE_HELPER_PATH, { status: 200, json });
      expect((await refusal(ask("people.remove", { shop: SHOP_A.id, helper: "helper-mint" })))?.code, JSON.stringify(json)).toBe("unavailable");
    }
  });
});

describe("the cover while the owner is away", () => {
  it("sends the helper and the end of the day as the time the API reads, and answers the cover", async () => {
    const { api, ask } = await setup({ shops: true });
    const until = (NOW + 3 * 86_400_000) / 1000;
    const away = (await ask("people.setAway", { shop: SHOP_A.id, helper: "helper-mint", until })).away;
    expect(away).toEqual({ helperId: "helper-mint", name: "Mint", until, inForce: true });
    expect(api.to("POST", AWAY_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { helperId: "helper-mint", until: iso(until * 1000) }]]);
  });

  it("leaves a date that is not in the future to the API, which says bad_date in words, and a person who is not a helper", async () => {
    const { api, ask } = await setup({ shops: true });
    expect(await refusal(ask("people.setAway", { shop: SHOP_A.id, helper: "helper-mint", until: (NOW - 1000) / 1000 }))).toEqual({ code: "bad_date", message: t("people.err.date") });
    expect(await refusal(ask("people.setAway", { shop: SHOP_A.id, helper: "helper-nope", until: (NOW + 86_400_000) / 1000 }))).toEqual({ code: "not_a_helper", message: t("people.err.notHelper") });
    expect(api.to("POST", AWAY_PATH)).toHaveLength(2);
    // A time that is not a number is not sent at all.
    for (const until of [Number.NaN, Number.POSITIVE_INFINITY, "tomorrow" as never]) expect((await refusal(ask("people.setAway", { shop: SHOP_A.id, helper: "helper-mint", until })))?.code).toBe("bad_date");
    expect(api.to("POST", AWAY_PATH)).toHaveLength(2);
  });

  it("ends the cover with exactly an empty body, and answers none", async () => {
    const { api, ask, shops } = await setup({ shops: true });
    shops[SHOP_A.id].away = { helperId: "helper-mint", name: "Mint", until: iso(NOW + 86_400_000), inForce: true };
    expect(await ask("people.clearAway", { shop: SHOP_A.id })).toEqual({ away: null });
    expect(api.to("POST", CLEAR_AWAY_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, {}]]);
    expect((await ask("people.list", {})).away).toBeNull();
    api.on("POST", CLEAR_AWAY_PATH, { status: 200, json: { away: { helperId: "x" } } });
    expect((await refusal(ask("people.clearAway", { shop: SHOP_A.id })))?.code).toBe("unavailable");
  });
});

describe("the API's own refusals, which the checks here should have kept from happening", () => {
  it("says a 403 owner_only in words for a shop the person was thought to own, and a 404 for one that has no people list", async () => {
    const { api, ask } = await setup({ shops: true });
    api.on("GET", PEOPLE_PATH, { status: 403, json: { error: "owner_only" } });
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "owner_only", message: t("people.err.ownerOnly") });
    // People exist for pilot shops: a shop the API holds no record of answers 404 not_found
    api.on("GET", PEOPLE_PATH, { status: 404, json: { error: "not_found" } });
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "not_found", message: t("people.err.notFound") });
  });

  it("says a 400 invalid_request in words, for every change", async () => {
    const { api, ask } = await setup({ shops: true });
    for (const path of [INVITE_PATH, CANCEL_INVITE_PATH, REMOVE_HELPER_PATH, AWAY_PATH, CLEAR_AWAY_PATH]) api.on("POST", path, { status: 400, json: { error: "invalid_request" } });
    const a = SHOP_A.id;
    const words = { code: "invalid_request", message: t("people.err.invite") };
    expect(await refusal(ask("people.invite", { shop: a, name: "Tum", identity: { kind: "line", id: "tum" } }))).toEqual(words);
    expect(await refusal(ask("people.cancelInvite", { shop: a, invite: "inv-beam" }))).toEqual(words);
    expect(await refusal(ask("people.remove", { shop: a, helper: "helper-mint" }))).toEqual(words);
    expect(await refusal(ask("people.setAway", { shop: a, helper: "helper-mint", until: (NOW + 86_400_000) / 1000 }))).toEqual(words);
    expect(await refusal(ask("people.clearAway", { shop: a }))).toEqual(words);
  });

  it("opens the shop's session again once after a 401, and says it did not work when the API still refuses", async () => {
    const { api, served, ask } = await setup({ shops: true });
    const opened = served!.opened[SHOP_A.id];
    api.on("GET", PEOPLE_PATH, { status: 401, json: { error: "unauthorized" } });
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "unauthorized", message: t("people.err.failed") });
    // the request went with the session held, then once more with a session opened again, and no more
    expect(api.to("GET", PEOPLE_PATH).map((c) => c.bearer)).toEqual([OWNER_A, shopToken(SHOP_A.id, "owner", opened + 1)]);
  });

  it("says plainly that the person is signed out, and that the API cannot be reached", async () => {
    const { api, ask } = await setup({ shops: true });
    api.on("GET", PEOPLE_PATH, "offline");
    expect(await refusal(ask("people.list", {}))).toEqual({ code: "offline", message: t("rt.offline") });
    api.on("POST", INVITE_PATH, "offline");
    expect(await refusal(ask("people.invite", { shop: SHOP_A.id, name: "Tum", identity: { kind: "line", id: "tum" } }))).toEqual({ code: "offline", message: t("rt.offline") });
  });
});

describe("a change goes with the shop its list was read for", () => {
  it("sends each change with that shop's own session even after the switcher moved to another shop the person owns", async () => {
    const { api, ask, shops } = await setup({ shops: true });
    const listed = await ask("people.list", {});
    expect(listed.shop).toBe(SHOP_A.id);
    // The owner switches to their other shop while the page still shows the first one's list.
    await ask("shops.switch", { shop: SHOP_C.id });
    await ask("people.invite", { shop: listed.shop, name: "Tum", identity: { kind: "line", id: "tum" } });
    await ask("people.remove", { shop: listed.shop, helper: "helper-mint" });
    await ask("people.setAway", { shop: listed.shop, helper: "helper-mint", until: (NOW + 86_400_000) / 1000 }).catch(() => undefined);
    await ask("people.cancelInvite", { shop: listed.shop, invite: "inv-beam" });
    await ask("people.clearAway", { shop: listed.shop });
    const writes = api.calls.filter((c) => c.method === "POST" && c.path.startsWith("/v1/people/"));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    // Every one of them went with shop A's session, none with shop C's, which is the shop the switcher shows.
    expect(new Set(writes.map((c) => c.bearer))).toEqual(new Set([OWNER_A]));
    expect(api.calls.some((c) => c.bearer === OWNER_C && c.method === "POST" && c.path.startsWith("/v1/people"))).toBe(false);
    // Shop C's people were not touched.
    expect(shops[SHOP_C.id].helpers.map((h) => h.id)).toEqual(["helper-c"]);
    expect(shops[SHOP_A.id].helpers).toEqual([]);
  });
});
