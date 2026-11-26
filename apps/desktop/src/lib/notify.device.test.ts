// A helper's new device reaching the owner outside the app (docs/people.md, "A helper's new device"; the canvas's board
// "States: people and roles", "A new device"). One of the two alerts quiet hours never silence. It goes through
// `showOutside` and notify-rules like every notification: the helper and the shop are named unless details are hidden, it
// rings at any hour, Look first (or a click) brings the app forward and opens Settings › People for that shop, where its owner
// removes access, and Later only dismisses. Run end to end under the app's own store over a fake API, with the notification
// plugin stood in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  types: [] as { id: string; actions: { id: string; title: string }[] }[],
  listener: null as null | ((e: unknown) => unknown),
  front: [] as string[],
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  registerActionTypes: async (types: { id: string; actions: { id: string; title: string }[] }[]) => void h.types.push(...types),
  onAction: async (cb: (e: unknown) => unknown) => {
    h.listener = cb;
    return { unregister: async () => {} };
  },
  sendNotification: (options: Record<string, unknown>) => void h.sent.push(options),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: async () => void h.front.push("unminimize"),
    show: async () => void h.front.push("show"),
    setFocus: async () => void h.front.push("focus"),
  }),
}));

// 08:10 on 24 November in Bangkok (UTC+7): quiet hours have ended. The test's own "night" is 03:00 the same day.
const at = (hhmm: string) => Date.parse(`2026-11-24T${hhmm}:00+07:00`);
const NOW = at("08:10");

/** One sign-in of a helper, opened at `hhmm` Bangkok time on 24 November, as the API lists it. */
const signIn = (id: string, hhmm: string, name = "Mint") => ({ id, helperId: `helper-${name.toLowerCase()}`, name, openedAt: new Date(at(hhmm)).toISOString() });

/** The page as the desktop shell runs it: a connected runtime over a fake API where the person owns Baan Mali and Khao Hom
 *  and helps at Ran Pa Noi, the store with notifications switched on, and a fresh copy of every module, since what notify.ts
 *  keeps (its listener, what it showed) is per page. `first` is what each owned shop lists when the app first looks. */
async function opened(settings: Record<string, string> = {}, first: Record<string, unknown[]> = {}) {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const data: Record<string, string> = { ...settings };
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k in data ? data[k] : null), setItem: (k: string, v: string) => void (data[k] = v), removeItem: (k: string) => void delete data[k] });
  const kit = await import("../runtime/http/testkit");
  const { createStore, notifySessionEvent } = await import("../state/store");
  const { HttpHost } = await import("../runtime/http/host");
  const { HttpRuntime } = await import("../runtime/http");
  const { ApiSession } = await import("../runtime/http/session");
  const { DEVICES_PATH, DeviceWatch } = await import("../runtime/http/devices");
  const khaoHom = { id: "pilot:shop-c", name: "Khao Hom", ownerName: "Fon", role: "owner" as const };
  const api = kit.fakeApi();
  const shops = kit.serveShops(api, [kit.SHOP_A, kit.SHOP_B, khaoHom], {});
  const devices: Record<string, unknown[]> = first;
  api.on("GET", DEVICES_PATH, (req) => {
    const held = shops.tokens.get(req.bearer ?? "");
    if (!held) return { status: 401, json: { error: "unauthorized" } };
    return held.role === "owner" ? { status: 200, json: { devices: devices[held.shop] ?? [] } } : { status: 403, json: { error: "owner_only" } };
  });
  const session = new ApiSession({ origin: kit.ORIGIN, fetch: api.fetch as never, vault: kit.memoryVault(kit.storedSession(NOW)) });
  const seen = { text: null as string | null };
  const rt = new HttpRuntime(new HttpHost({ session, devices: new DeviceWatch({ read: () => seen.text, write: (t) => void (seen.text = t) }) }));
  const store: import("../state/store").Store = createStore(rt, {
    firstRoster: "all",
    watchSeen: { get: () => null, set: () => {} },
    onEvent: (ev, state) => notifySessionEvent(ev, state, store),
  });
  await store.actions.init();
  await settled();
  return { api, store, kit, devices, khaoHom, shops };
}

/** Lets everything the store and the host started, which all answer in-process, run to its end. The clock is faked but not
 *  `setImmediate`: the notification plugin is loaded on demand, which needs real turns of the event loop. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(5);
    await tick();
  }
}
async function poll() {
  const { POLL_MS } = await import("../runtime/http/host");
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await settled();
}
/** Waits until `n` notifications have gone to the system. */
const shown = (n: number) => vi.waitFor(() => expect(h.sent).toHaveLength(n), { timeout: 4000, interval: 5 });
const press = async (actionId: string, id: unknown) => {
  await h.listener!({ actionId, inputValue: null, notification: { id } });
  await settled();
};
const titles = () => h.sent.map((s) => s.title);

beforeEach(() => {
  h.sent.length = 0;
  h.types.length = 0;
  h.listener = null;
  h.front.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a helper's new device, outside the app", () => {
  it("is said once, to the owner, naming the helper, the shop and when, with a sound, and says nothing at the first look", async () => {
    const { devices, kit } = await opened({}, { "pilot:shop-a": [signIn("hs-0", "07:00", "Beam")] });
    // the first look at the shop found Beam's sign-in already there: nothing is said of it, now or later
    expect(h.sent).toEqual([]);
    devices[kit.SHOP_A.id] = [signIn("hs-1", "08:05"), signIn("hs-0", "07:00", "Beam")];
    await poll();
    await shown(1);
    const { dayTime } = await import("../app/time");
    expect(h.sent[0]).toMatchObject({
      title: "Mint signed in on a new device",
      body: `Baan Mali, ${dayTime(at("08:05"), NOW)}. If this was not Mint, remove access.`,
      sound: "Ping",
      actionTypeId: "manut:look_first+later",
    });
    // read again, and again: it is not said twice
    await poll();
    await poll();
    expect(h.sent).toHaveLength(1);
  });

  it("gives each new sign-in a notification of its own", async () => {
    const { devices, kit, khaoHom } = await opened();
    devices[kit.SHOP_A.id] = [signIn("a-2", "08:09", "Beam"), signIn("a-1", "08:07")];
    devices[khaoHom.id] = [signIn("c-1", "08:08", "Nok")];
    await poll();
    await shown(3);
    expect([...titles()].sort()).toEqual(["Beam signed in on a new device", "Mint signed in on a new device", "Nok signed in on a new device"]);
    expect(h.sent.map((s) => s.id).length).toBe(new Set(h.sent.map((s) => s.id)).size);
  });

  it("rings in the middle of the night, when quiet hours keep everything else waiting", async () => {
    const { devices, kit } = await opened();
    vi.setSystemTime(at("03:00"));
    devices[kit.SHOP_A.id] = [signIn("hs-1", "02:58")];
    await poll();
    await shown(1);
    expect(h.sent[0]).toMatchObject({ title: "Mint signed in on a new device", sound: "Ping" });
  });

  it("names neither the helper nor the shop while details are hidden, as every notification hides them", async () => {
    const { devices, kit } = await opened({ "manut.notify.hide": "on" });
    devices[kit.SHOP_A.id] = [signIn("hs-1", "08:05")];
    await poll();
    await shown(1);
    expect(h.sent[0]).toMatchObject({ title: "Manut AI", body: "Something needs you.", sound: "Ping" });
    expect(JSON.stringify(h.sent[0])).not.toMatch(/Mint|Baan Mali/);
  });

  it("is not shown when the owner has turned Notify me off", async () => {
    const { devices, kit } = await opened({ "manut.notify": "off" });
    devices[kit.SHOP_A.id] = [signIn("hs-1", "08:05")];
    await poll();
    await settled();
    expect(h.sent).toEqual([]);
  });

  it("says nothing of a shop the person helps at, however its devices are listed", async () => {
    const { devices, kit, api } = await opened();
    devices[kit.SHOP_B.id] = [signIn("b-1", "08:05")];
    await poll();
    await settled();
    expect(h.sent).toEqual([]);
    expect(api.calls.some((c) => c.path === "/v1/people/devices" && /^mhs1\./.test(c.bearer ?? ""))).toBe(false);
  });

  it("offers Look first and Later only, and never Approve", async () => {
    const { devices, kit } = await opened();
    devices[kit.SHOP_A.id] = [signIn("hs-1", "08:05")];
    await poll();
    await shown(1);
    expect(h.types.at(-1)).toEqual({ id: "manut:look_first+later", actions: [{ id: "look_first", title: "Look first" }, { id: "later", title: "Later" }] });
  });
});

describe("a pressed button on that notification", () => {
  /** Khao Hom's sign-in while Baan Mali, the first listed, is the shop the pages show. */
  async function alertForKhaoHom() {
    const world = await opened();
    expect(world.store.getState().shops.current).toBe(world.kit.SHOP_A.id);
    world.devices[world.khaoHom.id] = [signIn("c-1", "08:05", "Nok")];
    await poll();
    await shown(1);
    return world;
  }

  it("Look first brings the app forward and opens People for that shop; a click on the notification itself does the same", async () => {
    for (const action of ["look_first", "tap"]) {
      h.sent.length = 0;
      h.front.length = 0;
      const { store, khaoHom, api } = await alertForKhaoHom();
      // before the press the app is on the chat and Settings is on its first page
      expect(store.getState().ui.view, action).not.toBe("settings");
      await press(action, h.sent[0]!.id);
      expect(h.front, action).toEqual(["unminimize", "show", "focus"]);
      // that shop is the one every page shows, and Settings is open on People
      expect(store.getState().shops.current, action).toBe(khaoHom.id);
      expect([store.getState().ui.view, store.getState().ui.settingsPage], action).toEqual(["settings", "people"]);
      // the shop was chosen once, and nothing was asked of the API for it but what the app always reads
      expect(api.calls.filter((c) => c.path.startsWith("/v1/people") && c.path !== "/v1/people/devices"), action).toEqual([]);
    }
  });

  it("opens People for the shop already shown without switching, and for the shop it names when another is shown", async () => {
    const { store, kit, devices } = await opened();
    devices[kit.SHOP_A.id] = [signIn("a-1", "08:05")];
    await poll();
    await shown(1);
    expect(store.getState().shops.current).toBe(kit.SHOP_A.id);
    await press("tap", h.sent[0]!.id);
    expect([store.getState().shops.current, store.getState().ui.view, store.getState().ui.settingsPage]).toEqual([kit.SHOP_A.id, "settings", "people"]);
  });

  it("Later only dismisses: the app does not come forward, the shop shown does not change and Settings does not open", async () => {
    const { store, kit } = await alertForKhaoHom();
    const before = store.getState().ui;
    await press("later", h.sent[0]!.id);
    expect(h.front).toEqual([]);
    expect(store.getState().shops.current).toBe(kit.SHOP_A.id);
    expect([store.getState().ui.view, store.getState().ui.settingsPage]).toEqual([before.view, before.settingsPage]);
  });

  it("does not open People on another shop's people when the shop it names can no longer be shown", async () => {
    const { store, kit, khaoHom, shops } = await alertForKhaoHom();
    // Khao Hom leaves the person's list before the notification is pressed
    shops.list = shops.list.filter((s) => s.id !== khaoHom.id);
    await poll();
    const before = store.getState().ui;
    await press("look_first", h.sent[0]!.id);
    // the app still comes forward, but Settings is not opened onto Baan Mali's people under Khao Hom's alert
    expect(h.front).toEqual(["unminimize", "show", "focus"]);
    expect(store.getState().shops.current).toBe(kit.SHOP_A.id);
    expect([store.getState().ui.view, store.getState().ui.settingsPage]).toEqual([before.view, before.settingsPage]);
  });

  it("keeps the notification as it was: the same words and the same two buttons", async () => {
    const { store, khaoHom } = await alertForKhaoHom();
    expect(h.sent[0]).toMatchObject({ title: "Nok signed in on a new device", actionTypeId: "manut:look_first+later" });
    expect(String(h.sent[0]!.body)).toContain("If this was not Nok, remove access.");
    expect(h.types.at(-1)!.actions.map((a) => a.title)).toEqual(["Look first", "Later"]);
    expect(store.getState().shops.current).not.toBe(khaoHom.id);
  });
});
