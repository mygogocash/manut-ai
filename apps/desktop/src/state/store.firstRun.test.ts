// The first-run setup in the app's store, on the demo runtime: whether the app opens on it, when what the person typed
// is kept on this computer (`manut.shop`), how Skip for now and Open Manut AI end it for good (`manut.onboarded`), and
// how Settings opens it again. The test node has no localStorage of its own, so each test hands the store one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { startFlow } from "../onboarding/flow";
import { EMPTY_SHOP } from "../onboarding/shop";

/** A localStorage that lives in a Map, with the Map in reach of the test. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return map;
}

async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}

const SAVED = { person: "Fon", shop: "Baan Mali", sells: "Scented candles and soap", places: ["line", "shopee"], main: "line" } as const;

describe("the first-run setup in the store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on Welcome on a computer that never finished or skipped it, holding what was saved before a quit", async () => {
    memoryStorage({ "manut.shop": JSON.stringify(SAVED) });
    const store = await demoStore();
    expect(store.getState().ui.shop).toEqual(SAVED);
    expect(store.getState().ui.firstRun).toEqual(startFlow("welcome", { ...SAVED, places: [...SAVED.places] }));
    // Home is behind it, ready for when it ends
    expect(store.getState().ui.view).toBe("home");
  });

  it("does not open once it was finished or skipped", async () => {
    memoryStorage({ "manut.onboarded": "1" });
    const store = await demoStore();
    expect(store.getState().ui.firstRun).toBeNull();
    expect(store.getState().ui.shop).toEqual(EMPTY_SHOP);
  });

  it("keeps what was typed when a Next moves on, cleaned as it is kept, and writes nothing for Back, typing or a refused Next", async () => {
    const saved = memoryStorage();
    const store = await demoStore();
    const a = store.actions;
    a.firstRunDo({ type: "next" });
    expect(store.getState().ui.firstRun?.screen).toBe("shop");
    a.firstRunDo({ type: "next" });
    expect(store.getState().ui.firstRun?.problems).toEqual(["shop", "places"]);
    a.firstRunDo({ type: "edit", field: "person", value: " Fon " });
    a.firstRunDo({ type: "edit", field: "shop", value: "Baan  Mali " });
    a.firstRunDo({ type: "place", channel: "line" });
    a.firstRunDo({ type: "back" });
    a.firstRunDo({ type: "next" });
    expect(saved.has("manut.shop")).toBe(false);
    a.firstRunDo({ type: "next" });
    expect(store.getState().ui.firstRun?.screen).toBe("channel");
    const kept = { ...EMPTY_SHOP, person: "Fon", shop: "Baan Mali", places: ["line"], main: "line" };
    expect(JSON.parse(saved.get("manut.shop")!)).toEqual(kept);
    // the account row reads it from here at once
    expect(store.getState().ui.shop).toEqual(kept);
    // the draft keeps the words as typed until the setup ends
    expect(store.getState().ui.firstRun?.draft.shop).toBe("Baan  Mali ");
  });

  it("ends for good on Skip for now, keeping what was typed, and opens Home", async () => {
    const saved = memoryStorage();
    const store = await demoStore();
    const a = store.actions;
    a.firstRunDo({ type: "next" });
    a.firstRunDo({ type: "edit", field: "shop", value: " Baan Mali" });
    // the person wandered to a member's chat behind the setup before skipping (a notification's click can do that)
    await a.selectBot("nam");
    a.firstRunEnd();
    const s = store.getState();
    expect(s.ui.firstRun).toBeNull();
    expect(s.ui.view).toBe("home");
    expect(saved.get("manut.onboarded")).toBe("1");
    expect(JSON.parse(saved.get("manut.shop")!)).toEqual({ ...EMPTY_SHOP, shop: "Baan Mali" });
    expect(s.ui.shop.shop).toBe("Baan Mali");
    // ending twice changes nothing
    a.firstRunEnd();
    expect(store.getState()).toBe(s);
  });

  it("opens again from Settings on Your shop, holding what was saved, and keeps a change when it ends", async () => {
    const saved = memoryStorage({ "manut.onboarded": "1", "manut.shop": JSON.stringify(SAVED) });
    const store = await demoStore();
    const a = store.actions;
    a.openSettings();
    a.openFirstRun();
    expect(store.getState().ui.firstRun).toEqual(startFlow("shop", store.getState().ui.shop));
    a.firstRunDo({ type: "edit", field: "sells", value: "Candles" });
    a.firstRunDo({ type: "next" });
    a.firstRunDo({ type: "main", channel: "shopee" });
    a.firstRunDo({ type: "next" });
    a.firstRunEnd();
    expect(JSON.parse(saved.get("manut.shop")!)).toEqual({ ...SAVED, sells: "Candles", main: "shopee" });
    expect(store.getState().ui).toMatchObject({ firstRun: null, view: "home" });
  });

  it("opens and ends without storage too, as a computer that cannot keep the answer", async () => {
    const store = await demoStore();
    expect(store.getState().ui.firstRun?.screen).toBe("welcome");
    store.actions.firstRunEnd();
    expect(store.getState().ui.firstRun).toBeNull();
  });
});
