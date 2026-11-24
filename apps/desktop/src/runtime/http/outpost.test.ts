// This Mac as one of the shop's outposts, from the page's side: registering through the session but never through the
// page's own request command (the answer holds the outpost's credential, which only the shell may keep), reading where
// the outpost stands, and telling the shell who is signed in.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import type { BridgeEvent } from "../../lib/protocol";
import { OpError } from "../mock/host";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { decodeView, followSignIn, registerThisMac, REGISTER_PATH, stopOnEnd, UNAVAILABLE, type OutpostShell, type OutpostView, type RegisterLink } from "./outpost";
import { ApiSession } from "./session";
import {
  clock,
  fakeApi,
  memoryVault,
  ORIGIN,
  serveShop,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  tokens,
  type FakeAnswer,
  type FakeApi,
  type ServedShops,
} from "./testkit";

/** A shell whose registration command is `shell`, a fake of the API as the shell's command answers the page: the
 *  status and the shop and name, or a refusal's code, and never a credential. */
function fakeShell(shell: FakeApi, said?: "keychain" | "unavailable") {
  const told: string[] = [];
  const outpost: OutpostShell = {
    status: async () => UNAVAILABLE,
    signedIn: async (origin, tenant, title) => {
      told.push(`in ${origin} ${tenant} ${title}`);
      return UNAVAILABLE;
    },
    signedOut: async () => {
      told.push("out");
    },
    run: async () => UNAVAILABLE,
    registerFetch: (refused) => async (url, init) => {
      if (said) refused(said);
      return shell.fetch(url, init);
    },
  };
  return { outpost, told };
}

function signedIn(api = fakeApi(), now = clock().now()) {
  const c = clock(now);
  const vault = memoryVault(storedSession(c.now()));
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now });
  return { api, c, session, vault };
}

/** The host's word for a person in no shops, over `session` alone: the signed-in tenant is theirs to register for. */
function overSignIn(session: ApiSession): RegisterLink {
  return {
    live: () => {},
    viewed: async () => null,
    roleAt: () => undefined,
    writeVia: (_shop, path, body, through) => session.writeVia(path, body, through),
    departed: (shop) => new OpError("gone", shop),
  };
}

const MAC = { name: "This Mac", kind: "this_mac" };

describe("registering this Mac", () => {
  it("goes through the shell's own command with the session's token, never through the page's request command", async () => {
    const { api, session } = signedIn();
    const shell = fakeApi().on("POST", "/v1/outposts/register", { status: 200, json: { tenant: "apple:owner-1", outpost: { name: "This Mac" } } });
    expect(await registerThisMac(overSignIn(session), null, fakeShell(shell).outpost, "This Mac")).toBe("registered");
    expect(shell.to("POST", "/v1/outposts/register")).toEqual([
      { method: "POST", url: `${ORIGIN}/v1/outposts/register`, path: "/v1/outposts/register", bearer: "access-1", body: MAC },
    ]);
    // The page's own request command never carried it, so no answer holding a credential could reach the page.
    expect(api.calls).toEqual([]);
  });

  it("refreshes a token about to expire the usual way first, and tries once more after a 401", async () => {
    const api = fakeApi().on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) }, { status: 200, json: tokens(3) });
    const c = clock();
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(c.now(), { accessExpiresAt: c.now() + 60_000 })), now: c.now });
    const shell = fakeApi().on("POST", "/v1/outposts/register", { status: 401, json: { error: "unauthorized" } }, { status: 200, json: {} });
    expect(await registerThisMac(overSignIn(session), null, fakeShell(shell).outpost, "This Mac")).toBe("registered");
    expect(api.to("POST", "/v1/auth/refresh")).toHaveLength(2);
    expect(shell.to("POST", "/v1/outposts/register").map((r) => r.bearer)).toEqual(["access-2", "access-3"]);
  });

  it("says why the shop did not take it, and what this Mac could not do", async () => {
    const cases: [FakeAnswer, "keychain" | undefined, string][] = [
      [{ status: 403, json: { error: "owner_only" } }, undefined, "owner_only"],
      [{ status: 409, json: { error: "too_many_outposts" } }, undefined, "too_many"],
      [{ status: 400, json: { error: "invalid_name" } }, undefined, "failed"],
      [{ status: 503, json: { error: "vault_unavailable" } }, undefined, "failed"],
      ["offline", undefined, "offline"],
      ["failed", "keychain", "keychain"],
      ["failed", undefined, "failed"],
    ];
    for (const [answer, said, result] of cases) {
      const { session } = signedIn();
      const shell = fakeApi().on("POST", "/v1/outposts/register", answer);
      expect(await registerThisMac(overSignIn(session), null, fakeShell(shell, said).outpost, "This Mac"), JSON.stringify(answer)).toBe(result);
      // A request that got no answer is never sent again from here: the API may have it.
      expect(shell.calls).toHaveLength(1);
    }
  });

  it("sends nothing while signed out", async () => {
    const shell = fakeApi();
    const session = new ApiSession({ origin: ORIGIN, fetch: fakeApi().fetch, vault: memoryVault(null), now: clock().now });
    expect(await registerThisMac(overSignIn(session), null, fakeShell(shell).outpost, "This Mac")).toBe("signed_out");
    expect(shell.calls).toEqual([]);
  });
});

// ---- registering for the shop the switcher shows (docs/several-shops.md) ------------------------------------------------

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");

/** The API's register route as the shell's command reaches it, by the bearer, as apps/api answers it: the sign-in registers
 *  the signed-in tenant; a shop session its own shop when it is the owner's and `owner_only` when a helper's; a session the
 *  shop no longer takes 401. The shell passes on a refusal's code alone (`refusal_of` in outpost/mod.rs). */
function serveRegister(shell: FakeApi, served: ServedShops | null): FakeApi {
  return shell.on("POST", REGISTER_PATH, (req) => {
    if (req.bearer?.startsWith("access-")) return { status: 200, json: { tenant: "apple:owner-1", outpost: { name: "This Mac" } } };
    const held = req.bearer ? served?.tokens.get(req.bearer) : undefined;
    if (!held || served?.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    const ended = served?.ended[held.shop];
    if (ended) return { status: 401, json: { error: ended.error } };
    if (held.role !== "owner") return { status: 403, json: { error: "owner_only" } };
    return { status: 200, json: { tenant: held.shop, outpost: { name: "This Mac" } } };
  });
}

/** The connected runtime as the app runs it, for a person in shops A (owned) and B (helped at), or in none. */
async function connected(opts: { shops: boolean }) {
  const api = fakeApi();
  const served = opts.shops ? serveShops(api, [SHOP_A, SHOP_B]) : null;
  if (!opts.shops) serveShop(api).on("GET", "/v1/shops", { status: 200, json: { shops: [] } });
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
  const host = new HttpHost({ session });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  await rt.connect();
  const shell = serveRegister(fakeApi(), served);
  return { api, served, session, host, rt, events, shell, outpost: fakeShell(shell).outpost };
}

describe("registering this Mac for the shop the switcher shows", () => {
  afterEach(() => {
    vi.useRealTimers();
    setLang("en");
  });
  const fake = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  };

  it("goes with that shop's own owner session, through the shell's command, so a pilot shop can have this Mac", async () => {
    fake();
    const { api, host, rt, shell, outpost } = await connected({ shops: true });
    expect(await registerThisMac(host.ownerLink(), SHOP_A.id, outpost, "This Mac")).toBe("registered");
    expect(shell.to("POST", REGISTER_PATH)).toEqual([{ method: "POST", url: `${ORIGIN}${REGISTER_PATH}`, path: REGISTER_PATH, bearer: OWNER_A, body: MAC }]);
    // The page's own request command carried no registration, and the sign-in registered nothing.
    expect(api.to("POST", REGISTER_PATH)).toEqual([]);
    rt.close();
  });

  it("goes to the shop the page named, even when the switcher moved on meanwhile", async () => {
    fake();
    const { host, rt, shell, outpost } = await connected({ shops: true });
    await rt.request("shops.switch", { shop: SHOP_B.id });
    expect(await registerThisMac(host.ownerLink(), SHOP_A.id, outpost, "This Mac")).toBe("registered");
    expect(shell.to("POST", REGISTER_PATH).map((r) => r.bearer)).toEqual([OWNER_A]);
    rt.close();
  });

  it("refuses a shop the person helps at, and a shop that is not theirs, with nothing sent", async () => {
    fake();
    const { host, rt, shell, outpost } = await connected({ shops: true });
    expect(await registerThisMac(host.ownerLink(), SHOP_B.id, outpost, "This Mac")).toBe("owner_only");
    expect(await registerThisMac(host.ownerLink(), "pilot:someone-elses", outpost, "This Mac")).toBe("failed");
    // A person in shops shows none of their own signed-in tenant, so this Mac is never registered for it by mistake.
    expect(await registerThisMac(host.ownerLink(), null, outpost, "This Mac")).toBe("failed");
    expect(shell.calls).toEqual([]);
    rt.close();
  });

  it("registers the signed-in tenant with the sign-in while the person is in no shops, as before shops", async () => {
    fake();
    const { host, rt, shell, outpost } = await connected({ shops: false });
    expect(await registerThisMac(host.ownerLink(), null, outpost, "This Mac")).toBe("registered");
    expect(shell.to("POST", REGISTER_PATH).map((r) => r.bearer)).toEqual(["access-1"]);
    rt.close();
  });

  it("opens the shop again once after a 401 and sends it through the shell again, never through the page", async () => {
    fake();
    const { api, host, rt, served, shell, outpost } = await connected({ shops: true });
    served!.refused.add(OWNER_A);
    expect(await registerThisMac(host.ownerLink(), SHOP_A.id, outpost, "This Mac")).toBe("registered");
    expect(shell.to("POST", REGISTER_PATH).map((r) => r.bearer)).toEqual([OWNER_A, shopToken(SHOP_A.id, "owner", 2)]);
    expect(api.to("POST", REGISTER_PATH)).toEqual([]);
    rt.close();
  });

  it("says the person's place in the shop ended, as a read that found it would", async () => {
    fake();
    const { host, rt, served, session, events, outpost } = await connected({ shops: true });
    served!.ended[SHOP_A.id] = { error: "unlinked", at: new Date(NOW - 60_000).toISOString() };
    expect(await registerThisMac(host.ownerLink(), SHOP_A.id, outpost, "This Mac")).toBe("left");
    expect(session.shopSession(SHOP_A.id)).toBeNull();
    expect(events.some((e) => e.event === "shops.update")).toBe(true);
    const listed = await rt.request("shops.list", {});
    expect(listed.left).toEqual([expect.objectContaining({ id: SHOP_A.id, why: "unlinked" })]);
    rt.close();
  });
});

describe("where the outpost stands", () => {
  it("reads the shell's view and nothing else", () => {
    const view: OutpostView = { state: "running", online: true, steps: 2, name: "This Mac" };
    expect(decodeView({ ...view, credential: "mo1_x", outpostId: "op-1" })).toEqual(view);
    expect(decodeView({ state: "stopped", online: "yes", steps: -1, name: " " })).toEqual({ state: "stopped", online: false, steps: 0, name: null });
    for (const state of ["unavailable", "unregistered", "running", "stopped", "refused", "idle"]) expect(decodeView({ state }).state).toBe(state);
    // A state this build does not know is not guessed at.
    expect(decodeView({ state: "moving", online: true, steps: 1 })).toEqual(UNAVAILABLE);
    expect(decodeView(null)).toEqual(UNAVAILABLE);
    expect(decodeView("running")).toEqual(UNAVAILABLE);
  });
});

describe("the outpost follows the sign-in", () => {
  it("tells the shell who signed in, and that they signed out or the API ended the session", async () => {
    const api = fakeApi().on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    const c = clock();
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(c.now(), { tenant: "apple:fon" })), now: c.now });
    const { outpost, told } = fakeShell(fakeApi());
    let title = "Manut AI: this Mac's browser";
    const stop = followSignIn(session, outpost, () => title);
    await session.load();
    title = "Manut AI";
    await session.signOut();
    expect(told).toEqual([`in ${ORIGIN} apple:fon Manut AI: this Mac's browser`, "out"]);
    stop();
    await session.signOut();
    expect(told).toHaveLength(2);
  });

  it("stops the outpost as a sign-out begins, before it waits on the API", async () => {
    const { outpost, told } = fakeShell(fakeApi());
    let forgotten = 0;
    let toldWhenAsked: string[] = [];
    const api = fakeApi().on("DELETE", "/v1/auth/session", () => {
      toldWhenAsked = [...told];
      return { status: 200, json: {} };
    });
    const c = clock();
    const session = new ApiSession({
      origin: ORIGIN,
      fetch: api.fetch,
      vault: memoryVault(storedSession(c.now())),
      now: c.now,
      onEnd: stopOnEnd(outpost, () => {
        forgotten += 1;
      }),
    });
    await session.load();
    await session.signOut();
    expect(toldWhenAsked).toEqual(["out"]);
    expect(forgotten).toBe(1);
  });

  it("stops the outpost when the API ends the session", async () => {
    const api = fakeApi()
      .on("GET", "/v1/schedules", { status: 401, json: { error: "invalid_session" } })
      .on("POST", "/v1/auth/refresh", { status: 401, json: { error: "invalid_grant" } });
    const c = clock();
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(c.now())), now: c.now });
    const { outpost, told } = fakeShell(fakeApi());
    followSignIn(session, outpost, () => "t");
    expect(await session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    expect(told).toEqual([`in ${ORIGIN} apple:owner-1 t`, "out"]);
  });
});
