// A helper's new device, as the owner's app finds it out and remembers it has said so (docs/people.md, "A helper's new
// device"): the route's answer read field by field, and what the app has already said kept per shop on this computer.
// Pure and without a DOM: the store of what was seen is a fake that can fail.
import { describe, expect, it } from "vitest";
import { DEVICES_PATH, DeviceWatch, SEEN_KEY, browserSeen, decodeDevices, readDevices, type HelperDevice, type SeenStore } from "./devices";
import type { ShopAnswer } from "./shops";

const T = Date.UTC(2026, 10, 24, 14, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
/** One entry of the route's answer, opened `minutes` after 14:00 UTC on 24 November. */
const entry = (id: string, minutes = 0, over: Record<string, unknown> = {}) => ({ id, helperId: "helper-1", name: "Mint", openedAt: iso(T + minutes * 60_000), ...over });
/** The same, as the app holds it. */
const device = (id: string, minutes = 0, over: Partial<HelperDevice> = {}): HelperDevice => ({ id, helperId: "helper-1", name: "Mint", openedAt: T + minutes * 60_000, ...over });
const ids = (list: readonly HelperDevice[]) => list.map((d) => d.id);

/** What this computer keeps, in memory, that can refuse as a disabled or full storage would. */
function memorySeen(text: string | null = null): SeenStore & { text: string | null; writes: number; refuseRead: boolean; refuseWrite: boolean } {
  const store = {
    text,
    writes: 0,
    refuseRead: false,
    refuseWrite: false,
    read() {
      if (store.refuseRead) throw new Error("storage");
      return store.text;
    },
    write(next: string) {
      if (store.refuseWrite) throw new Error("storage");
      store.text = next;
      store.writes += 1;
    },
  };
  return store;
}

describe("the route's answer", () => {
  it("is read as the sign-ins it lists, oldest first, with their times in ms", () => {
    const read = decodeDevices({ devices: [entry("hs-3", 30, { helperId: "helper-2", name: "Beam" }), entry("hs-2", 20), entry("hs-1", 10)] });
    expect(read).toEqual([device("hs-1", 10), device("hs-2", 20), device("hs-3", 30, { helperId: "helper-2", name: "Beam" })]);
  });

  it("is nothing at all, so nothing is said and nothing remembered, when it is not an answer of this route", () => {
    for (const json of [null, undefined, [], "devices", 7, {}, { devices: "hs-1" }, { devices: {} }, { shops: [] }]) expect(decodeDevices(json)).toBeNull();
    expect(decodeDevices({ devices: [] })).toEqual([]);
  });

  it("leaves out an entry it cannot read, and only that entry", () => {
    const read = decodeDevices({
      devices: [
        entry("hs-1", 10),
        null,
        "hs-x",
        entry("", 11),
        { ...entry("hs-2", 12), helperId: "" },
        { ...entry("hs-3", 13), helperId: 5 },
        { ...entry("hs-4", 14), openedAt: "yesterday" },
        { ...entry("hs-5", 15), openedAt: 12345 },
        { id: "hs-6", helperId: "helper-1", name: "Mint" },
        entry("hs-7", 17),
      ],
    });
    expect(ids(read!)).toEqual(["hs-1", "hs-7"]);
  });

  it("reads a name that is missing or not text as no name, which the words fill in", () => {
    expect(decodeDevices({ devices: [{ ...entry("hs-1"), name: undefined }, { ...entry("hs-2", 1), name: 7 }] })!.map((d) => d.name)).toEqual(["", ""]);
  });

  it("lists a sign-in once, and no more than the 50 newest, however many the answer holds", () => {
    expect(ids(decodeDevices({ devices: [entry("hs-1", 5), entry("hs-1", 1), entry("hs-2", 9)] })!)).toEqual(["hs-1", "hs-2"]);
    const many = Array.from({ length: 80 }, (_, i) => entry(`hs-${i}`, 80 - i));
    const read = decodeDevices({ devices: many })!;
    expect(read).toHaveLength(50);
    expect(read[0]!.id).toBe("hs-49");
    expect(read[49]!.id).toBe("hs-0");
  });
});

describe("what the app has already said", () => {
  it("is nothing the first time it looks at a shop: what is there is where it starts, so a first run does not ring for every helper", () => {
    const seen = memorySeen();
    const watch = new DeviceWatch(seen);
    expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)])).toEqual([]);
    // and it has begun to remember them
    expect(JSON.parse(seen.text!)).toEqual({ v: 1, shops: { "shop-a": ["hs-1", "hs-2"] } });
    expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)])).toEqual([]);
  });

  it("then says each new sign-in once, oldest first, and never again", () => {
    const watch = new DeviceWatch(memorySeen());
    watch.fresh("shop-a", [device("hs-1", 1)]);
    expect(ids(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2), device("hs-3", 3)]))).toEqual(["hs-2", "hs-3"]);
    expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2), device("hs-3", 3)])).toEqual([]);
    expect(ids(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2), device("hs-3", 3), device("hs-4", 4)]))).toEqual(["hs-4"]);
  });

  it("says nothing twice whatever order the list comes in, and a sign-in that left the list and came back is not new", () => {
    const watch = new DeviceWatch(memorySeen());
    watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]);
    expect(watch.fresh("shop-a", [device("hs-2", 2), device("hs-1", 1)])).toEqual([]);
    expect(watch.fresh("shop-a", [])).toEqual([]);
    expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)])).toEqual([]);
  });

  it("keeps each shop apart: a shop's first look is its own, and one shop's sign-ins never count for another", () => {
    const watch = new DeviceWatch(memorySeen());
    watch.fresh("shop-a", [device("hs-1", 1)]);
    expect(watch.fresh("shop-b", [device("hs-1", 1), device("hs-9", 9)])).toEqual([]);
    expect(ids(watch.fresh("shop-a", [device("hs-1", 1), device("hs-9", 9)]))).toEqual(["hs-9"]);
    expect(watch.fresh("shop-b", [device("hs-1", 1), device("hs-9", 9)])).toEqual([]);
  });

  it("is kept on this computer, so a restart says what arrived while the app was closed and not what it already said", () => {
    const seen = memorySeen();
    const first = new DeviceWatch(seen);
    first.fresh("shop-a", [device("hs-1", 1)]);
    first.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]);
    // the app is closed; Mint signs in twice; it opens again
    const second = new DeviceWatch(seen);
    expect(ids(second.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2), device("hs-3", 3), device("hs-4", 4)]))).toEqual(["hs-3", "hs-4"]);
    expect(new DeviceWatch(seen).fresh("shop-a", [device("hs-3", 3), device("hs-4", 4)])).toEqual([]);
  });

  it("goes with the shop: what was seen of a shop the person no longer owns is dropped, and it is a first look if they own it again", () => {
    const seen = memorySeen();
    const watch = new DeviceWatch(seen);
    watch.fresh("shop-a", [device("hs-1", 1)]);
    watch.fresh("shop-b", [device("hs-2", 2)]);
    watch.keepOnly(["shop-a"]);
    expect(JSON.parse(seen.text!).shops).toEqual({ "shop-a": ["hs-1"] });
    expect(watch.fresh("shop-b", [device("hs-2", 2), device("hs-3", 3)])).toEqual([]);
    // the same after a restart
    watch.keepOnly([]);
    expect(JSON.parse(seen.text!).shops).toEqual({});
    expect(new DeviceWatch(seen).fresh("shop-a", [device("hs-1", 1), device("hs-5", 5)])).toEqual([]);
  });

  it("writes only when something changed", () => {
    const seen = memorySeen();
    const watch = new DeviceWatch(seen);
    watch.fresh("shop-a", [device("hs-1", 1)]);
    const written = seen.writes;
    watch.fresh("shop-a", [device("hs-1", 1)]);
    watch.keepOnly(["shop-a"]);
    watch.keepOnly(["shop-a", "shop-z"]);
    expect(seen.writes).toBe(written);
    watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]);
    expect(seen.writes).toBe(written + 1);
  });

  it("keeps at most the 200 newest ids of a shop, so the record cannot grow", () => {
    const seen = memorySeen();
    const watch = new DeviceWatch(seen);
    watch.fresh("shop-a", []);
    for (let i = 0; i < 250; i += 1) watch.fresh("shop-a", [device(`hs-${i}`, i)]);
    const kept = JSON.parse(seen.text!).shops["shop-a"] as string[];
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe("hs-50");
    expect(kept[199]).toBe("hs-249");
  });

  it("starts from nothing, and says nothing, when what is kept is damaged or from another version", () => {
    for (const text of ["", "{not json", "null", "[]", JSON.stringify({ v: 2, shops: {} }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, shops: [] }), JSON.stringify({ v: 1, shops: { "shop-a": "hs-1" } }), JSON.stringify({ v: 1, shops: { "shop-a": [1, 2] } })]) {
      const watch = new DeviceWatch(memorySeen(text));
      expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]), text).toEqual([]);
      expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2), device("hs-3", 3)]).map((d) => d.id), text).toEqual(["hs-3"]);
    }
  });

  it("never throws, and still says each sign-in once in a run, when this computer's storage refuses", () => {
    const seen = memorySeen();
    seen.refuseRead = true;
    seen.refuseWrite = true;
    const watch = new DeviceWatch(seen);
    expect(watch.fresh("shop-a", [device("hs-1", 1)])).toEqual([]);
    expect(ids(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]))).toEqual(["hs-2"]);
    expect(watch.fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)])).toEqual([]);
    expect(() => watch.keepOnly([])).not.toThrow();
  });

  it("is kept in this computer's own storage under one key, and works with no storage at all", () => {
    const data: Record<string, string> = {};
    const stored = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    const store = browserSeen(stored);
    const watch = new DeviceWatch(store);
    watch.fresh("shop-a", [device("hs-1", 1)]);
    expect(Object.keys(data)).toEqual([SEEN_KEY]);
    expect(ids(new DeviceWatch(browserSeen(stored)).fresh("shop-a", [device("hs-1", 1), device("hs-2", 2)]))).toEqual(["hs-2"]);
    const broken = browserSeen({ getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } });
    expect(broken.read()).toBeNull();
    expect(() => broken.write("x")).not.toThrow();
    expect(browserSeen(null).read()).toBeNull();
    expect(() => browserSeen(null).write("x")).not.toThrow();
  });
});

describe("reading a shop's devices", () => {
  const answering = (answer: ShopAnswer) => {
    const calls: [string, string][] = [];
    return { calls, shops: { read: async (shop: string, path: string) => (calls.push([shop, path]), answer) } };
  };

  it("asks the route with that shop's own session, and reads what it says", async () => {
    const { calls, shops } = answering({ kind: "ok", status: 200, json: { devices: [entry("hs-1", 1)] } });
    expect(DEVICES_PATH).toBe("/v1/people/devices");
    expect(await readDevices(shops, { id: "shop-a" })).toEqual([device("hs-1", 1)]);
    expect(calls).toEqual([["shop-a", "/v1/people/devices"]]);
  });

  it("is nothing for any other answer: a refusal, a link that is down, a shop the person left, or one it cannot read", async () => {
    for (const answer of [
      { kind: "refused", status: 403, code: "owner_only", json: { error: "owner_only" } },
      { kind: "refused", status: 404, code: "not_found", json: {} },
      { kind: "refused", status: 503, code: "people_unavailable", json: {} },
      { kind: "offline" },
      { kind: "unavailable" },
      { kind: "signed_out" },
      { kind: "left", departure: { why: "removed", at: null } },
      { kind: "ok", status: 200, json: { nothing: true } },
    ] as unknown as ShopAnswer[]) {
      expect(await readDevices(answering(answer).shops, { id: "shop-a" }), JSON.stringify(answer)).toBeNull();
    }
  });

  it("is nothing, and never throws, when the read itself fails", async () => {
    const shops = { read: async () => Promise.reject(new Error("keychain")) };
    expect(await readDevices(shops, { id: "shop-a" })).toBeNull();
  });
});
