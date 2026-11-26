// A helper's new device on the connected runtime (docs/people.md, "A helper's new device"; docs/several-shops.md), end to
// end under the host over a fake API: each shop the person owns has its helpers' devices read with that shop's own session,
// the first look at a shop says nothing, every later new sign-in is said once as `device.new`, and what was said is kept
// per shop on this computer and dropped with the shop. A shop the person helps at is never asked, and a read of the devices
// that does not work leaves the read of the shop whole and says nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICES_PATH, DeviceWatch, type SeenStore } from "./devices";
import { HttpHost, POLL_MS, type HostEvent } from "./host";
import { ApiSession } from "./session";
import type { FetchLike } from "./shell";
import { fakeApi, iso, memoryVault, ORIGIN, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, T0, type ShopJson } from "./testkit";
import { TEAM } from "./view";

const NOW = T0 + 600_000;
const SHOP_C: ShopJson = { id: "pilot:shop-c", name: "Khao Hom", ownerName: "Fon", role: "owner" };
const OWNER_A = shopToken(SHOP_A.id, "owner");
const OWNER_C = shopToken(SHOP_C.id, "owner");

type Mode = "ok" | "unavailable" | "owner_only" | "offline" | "garbled";
type Told = Extract<HostEvent, { event: "device.new" }>;

/** One sign-in of a helper, opened `minutes` after the test's clock began, as the API lists it. */
const signIn = (id: string, minutes: number, name = "Mint") => ({ id, helperId: `helper-${name.toLowerCase()}`, name, openedAt: iso(T0 + minutes * 60_000) });

/** What this computer keeps of what was seen, in memory, as one text. */
function memorySeen(): SeenStore & { text: string | null } {
  const store = { text: null as string | null, read: () => store.text, write: (next: string) => void (store.text = next) };
  return store;
}
const kept = (seen: { text: string | null }): Record<string, string[]> => (seen.text ? JSON.parse(seen.text).shops : {});

async function settled() {
  for (let i = 0; i < 12; i += 1) await vi.advanceTimersByTimeAsync(5);
}
async function poll(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await settled();
  }
}

/** The API as apps/api answers it for the person: three shops (they own two and help at one), and each owned shop's
 *  `GET /v1/people/devices` by the shop session it is sent with, 403 `owner_only` for a helper's session. */
function world() {
  const api = fakeApi();
  const shops = serveShops(api, [SHOP_A, SHOP_B, SHOP_C], { [SHOP_A.id]: [], [SHOP_B.id]: [], [SHOP_C.id]: [] });
  const vault = memoryVault(storedSession(NOW));
  const devices: Record<string, unknown[]> = {};
  /** `gate` holds every answer of the devices route back until it is released, after the API has made it: an answer on its way. */
  const route = { mode: "ok" as Mode, gate: null as Promise<void> | null };
  const fetch: FetchLike = async (url, init) => {
    const answer = await api.fetch(url, init);
    if (new URL(url).pathname === DEVICES_PATH && route.gate) await route.gate;
    return answer;
  };
  api.on("GET", DEVICES_PATH, (req) => {
    const held = shops.tokens.get(req.bearer ?? "");
    if (!held || shops.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    if (held.role !== "owner" || route.mode === "owner_only") return { status: 403, json: { error: "owner_only" } };
    if (route.mode === "unavailable") return { status: 503, json: { error: "people_unavailable" } };
    if (route.mode === "offline") return "offline";
    if (route.mode === "garbled") return { status: 200, json: { nothing: true } };
    return { status: 200, json: { devices: devices[held.shop] ?? [] } };
  });
  const events: HostEvent[] = [];
  const told = () => events.filter((e): e is Told => e.event === "device.new");
  /** The app opening: a session and a host over this API and keychain, with `seen` as what this computer kept. */
  async function open(seen: SeenStore) {
    const session = new ApiSession({ origin: ORIGIN, fetch, vault });
    const host = new HttpHost({ session, devices: new DeviceWatch(seen) });
    host.subscribe((ev) => events.push(ev));
    const release = host.attach();
    await settled();
    return { host, session, release };
  }
  return { api, shops, vault, devices, route, events, told, open };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a helper's new device", () => {
  it("is said once for each new sign-in, naming the helper, the shop and when, and never for what was there at the first look", async () => {
    const w = world();
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    const { host } = await w.open(memorySeen());
    expect(host.link).toBe("open");
    expect(w.told()).toEqual([]);

    // Beam signs in on a new device; the next read says so, and the ones after it do not say it again.
    w.devices[SHOP_A.id] = [signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    await poll();
    expect(w.told()).toEqual([{ event: "device.new", bot: TEAM, id: "hs-2", helper: "Beam", shop: { id: SHOP_A.id, name: "Baan Mali" }, at: (T0 + 20 * 60_000) / 1000 }]);
    await poll(3);
    expect(w.told()).toHaveLength(1);

    // Two more in one read: both, oldest first.
    w.devices[SHOP_A.id] = [signIn("hs-4", 40), signIn("hs-3", 30, "Beam"), signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    await poll();
    expect(w.told().map((e) => [e.id, e.helper])).toEqual([["hs-2", "Beam"], ["hs-3", "Beam"], ["hs-4", "Mint"]]);
  });

  it("reads each shop the person owns with that shop's own session, and never asks about a shop they help at", async () => {
    const w = world();
    w.devices[SHOP_A.id] = [signIn("hs-a1", 1)];
    w.devices[SHOP_B.id] = [signIn("hs-b1", 1)];
    w.devices[SHOP_C.id] = [signIn("hs-c1", 1)];
    await w.open(memorySeen());
    expect(w.api.to("GET", DEVICES_PATH).map((c) => c.bearer).sort()).toEqual([OWNER_A, OWNER_C].sort());
    // nothing else is sent with the route: no body, and no other session (not the sign-in's, not the helper's)
    expect(w.api.to("GET", DEVICES_PATH).map((c) => [c.url, c.body])).toEqual([[`${ORIGIN}${DEVICES_PATH}`, undefined], [`${ORIGIN}${DEVICES_PATH}`, undefined]]);

    w.devices[SHOP_A.id] = [signIn("hs-a2", 2, "Beam"), signIn("hs-a1", 1)];
    w.devices[SHOP_B.id] = [signIn("hs-b2", 2, "Pim"), signIn("hs-b1", 1)];
    w.devices[SHOP_C.id] = [signIn("hs-c2", 2, "Nok"), signIn("hs-c1", 1)];
    await poll();
    // the owned shops say theirs; the shop they help at says nothing, whatever it would list
    expect(w.told().map((e) => [e.shop.name, e.helper]).sort()).toEqual([["Baan Mali", "Beam"], ["Khao Hom", "Nok"]]);
    for (const call of w.api.to("GET", DEVICES_PATH)) expect([OWNER_A, OWNER_C]).toContain(call.bearer);
    expect(w.api.calls.some((c) => c.path === DEVICES_PATH && c.bearer === shopToken(SHOP_B.id, "helper"))).toBe(false);
    expect(w.api.calls.some((c) => c.path === DEVICES_PATH && c.bearer === "access-1")).toBe(false);
  });

  it("leaves the read of the shop whole, says nothing and remembers nothing when the devices cannot be read, and says the sign-in once they can", async () => {
    const w = world();
    const seen = memorySeen();
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    const { host } = await w.open(seen);
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1"]);
    w.devices[SHOP_A.id] = [signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    for (const mode of ["unavailable", "owner_only", "offline", "garbled"] as const) {
      w.route.mode = mode;
      await poll();
      // the shop's own read is as it was: open, with both shops listed, and nothing said, nothing taken as said
      expect(host.link, mode).toBe("open");
      expect(((await host.handle("shops.list")) as { shops: unknown[] }).shops, mode).toHaveLength(3);
      expect(w.told(), mode).toEqual([]);
      expect(kept(seen)[SHOP_A.id], mode).toEqual(["hs-1"]);
    }
    w.route.mode = "ok";
    await poll();
    expect(w.told().map((e) => e.id)).toEqual(["hs-2"]);
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1", "hs-2"]);
  });

  it("never holds back the read of the shop: the asks are taken while the devices are still on their way", async () => {
    const w = world();
    const seen = memorySeen();
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    let release!: () => void;
    w.route.gate = new Promise<void>((resolve) => (release = resolve));
    const { host } = await w.open(seen);
    // the read of the shop is taken and shown, with every shop listed, although no devices have answered
    expect(host.link).toBe("open");
    expect(((await host.handle("shops.list")) as { shops: unknown[] }).shops).toHaveLength(3);
    expect(w.api.to("GET", DEVICES_PATH).length).toBeGreaterThan(0);
    expect(seen.text).toBeNull();
    // and when they answer, the shop's first look is remembered
    release();
    await settled();
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1"]);
    expect(w.told()).toEqual([]);
  });

  it("says nothing, and remembers nothing, when the answer comes after the person signed out: the next read says it", async () => {
    const w = world();
    const seen = memorySeen();
    w.api.on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    const { session } = await w.open(seen);
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1"]);
    // Beam signs in; the poll's read of the devices is made, and its answer is on its way when the person signs out
    w.devices[SHOP_A.id] = [signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    let release!: () => void;
    w.route.gate = new Promise<void>((resolve) => (release = resolve));
    await poll();
    expect(w.api.to("GET", DEVICES_PATH).length).toBeGreaterThan(2);
    await session.signOut();
    release();
    await settled();
    expect(w.told()).toEqual([]);
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1"]);
  });

  it("is kept on this computer, so a restart says what arrived while the app was closed and not what it already said", async () => {
    const w = world();
    const seen = memorySeen();
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    const first = await w.open(seen);
    w.devices[SHOP_A.id] = [signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    await poll();
    expect(w.told().map((e) => e.id)).toEqual(["hs-2"]);
    // the app is closed; Mint signs in on a phone and, hours later, Beam on a laptop
    first.release();
    await settled();
    w.devices[SHOP_A.id] = [signIn("hs-4", 400, "Beam"), signIn("hs-3", 100), signIn("hs-2", 20, "Beam"), signIn("hs-1", 5)];
    await w.open(seen);
    expect(w.told().map((e) => e.id)).toEqual(["hs-2", "hs-3", "hs-4"]);
    await poll(2);
    expect(w.told()).toHaveLength(3);
  });

  it("goes with the shop: it is dropped when the person leaves the shop, and a shop they own again is a first look", async () => {
    const w = world();
    const seen = memorySeen();
    w.devices[SHOP_A.id] = [signIn("hs-1", 5)];
    w.devices[SHOP_C.id] = [signIn("hs-c1", 5)];
    await w.open(seen);
    expect(Object.keys(kept(seen)).sort()).toEqual([SHOP_A.id, SHOP_C.id]);

    // the operator unlinked the person's account from Baan Mali
    w.shops.list = [SHOP_B, SHOP_C];
    w.shops.ended[SHOP_A.id] = { error: "unlinked", at: "2026-11-22T03:00:00.000Z" };
    await poll();
    expect(Object.keys(kept(seen))).toEqual([SHOP_C.id]);

    // linked again, with a sign-in that came meanwhile: nothing is said, the shop is only looked at
    delete w.shops.ended[SHOP_A.id];
    w.shops.list = [SHOP_A, SHOP_B, SHOP_C];
    w.devices[SHOP_A.id] = [signIn("hs-2", 50, "Beam"), signIn("hs-1", 5)];
    await poll();
    expect(w.told()).toEqual([]);
    expect(kept(seen)[SHOP_A.id]).toEqual(["hs-1", "hs-2"]);
  });
});
