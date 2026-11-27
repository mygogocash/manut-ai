// "Your Mac needs you" on the Mac's side (item 78d, push.ts and host.ts): a phone's push address arrives inside the
// channel and goes to the relay as `webpush`, again at every `ready`; when an ask opens and no paired phone has a session
// open, the relay hears `push` naming the phones with an address, once for that ask and never twice within two minutes;
// Unpair forgets the address and the relay's `revoke` takes it there.
import { describe, expect, it } from "vitest";
import type { SourceApproval } from "./project";
import { PUSH_GAP_MS, PUSH_KEY, PushPlan, localPushStore, memoryPushStore } from "./push";
import { settle } from "./testkit/clock";
import { macHarness, pairPhone, turnOn, waitFor, type Harness } from "./testkit/harness";

const APPLE = "https://web.push.apple.com/QGuQyavXutnMH8iVgwGGgVwKbd5Wfa1DXQWCeQGAkdaBJgJ1wUtklzp9KgAoWwPbIaHRdQ0v7gkTSDN";
const GOOGLE = "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bHqjZxM0VImWWqDRN7U0a3AycjUf4O-byuxb_wJsKRaKvV";

let asks = 0;

/** A new approval opens in Buddy's chat, and the store says so. */
async function openAsk(h: Harness): Promise<string> {
  const ask: SourceApproval = { kind: "approval", id: `new-${++asks}`, ts: 1_800_000_500, open: true, title: "Refund an order", command: "refund --order 7", choices: ["once", "deny"] };
  h.chats.update("buddy", (items) => [...items, ask]);
  h.remote.publish();
  await settle();
  return ask.id;
}

/** A Mac with one paired phone whose notifications are on, and no session open. */
async function phoneWithPush(h: Harness, endpoint = APPLE) {
  await turnOn(h);
  const { phone } = await pairPhone(h);
  const session = await phone.connect();
  expect(await session.request({ t: "notify", endpoint })).toMatchObject({ t: "done" });
  session.close();
  await waitFor(() => h.remote.snapshot().phones[0]?.connected === false);
  return phone;
}

describe("a phone's push address", () => {
  it("comes inside the channel, is kept, goes to the relay, and again at every ready", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    expect(await session.request({ t: "notify", endpoint: APPLE })).toEqual({ t: "done", id: 1 });
    expect(h.pushes.book).toEqual({ [phone.deviceId!]: APPLE });
    expect(h.remote.snapshot().phones[0]?.push).toBe(true);
    expect(h.relay.sent("webpush")).toEqual([{ t: "webpush", v: 1, id: phone.deviceId, endpoint: APPLE }]);
    // The same address again changes nothing; a new one replaces it.
    expect(await session.request({ t: "notify", endpoint: APPLE })).toMatchObject({ t: "done" });
    expect(await session.request({ t: "notify", endpoint: GOOGLE })).toMatchObject({ t: "done" });
    expect(h.relay.sent("webpush").map((m) => m.endpoint)).toEqual([APPLE, GOOGLE]);
    // The relay comes back: the address goes again, after the device.
    h.relay.cut();
    await waitFor(() => h.remote.snapshot().link === "waiting");
    h.clock.advance(1_000);
    await waitFor(() => h.remote.snapshot().link === "ready");
    await waitFor(() => h.relay.sent("webpush").length === 3);
    const order = h.relay.fromMacText.map((m) => m.t);
    expect(order.lastIndexOf("webpush")).toBeGreaterThan(order.lastIndexOf("device"));
    expect(h.relay.sent("webpush")[2]).toEqual({ t: "webpush", v: 1, id: phone.deviceId, endpoint: GOOGLE });
  });

  it("is refused anywhere but a known push service, and kept nowhere", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    for (const endpoint of ["https://push.example.com/x", "http://fcm.googleapis.com/fcm/send/x", "https://fcm.googleapis.com:444/x"]) {
      expect(await session.request({ t: "notify", endpoint })).toMatchObject({ t: "refused", request: "notify", reason: "push_address" });
    }
    expect(await session.request({ t: "notify", endpoint: 42 })).toMatchObject({ t: "refused", reason: "malformed" });
    expect(h.pushes.book).toEqual({});
    expect(h.relay.sent("webpush")).toEqual([]);
    expect(h.remote.snapshot().phones[0]?.push).toBe(false);
  });

  it("is taken away by the phone with null, and the relay hears so", async () => {
    const h = macHarness();
    await turnOn(h);
    const { phone } = await pairPhone(h);
    const session = await phone.connect();
    await session.request({ t: "notify", endpoint: APPLE });
    expect(await session.request({ t: "notify", endpoint: null })).toMatchObject({ t: "done" });
    expect(h.pushes.book).toEqual({});
    expect(h.relay.sent("webpush").at(-1)).toEqual({ t: "webpush", v: 1, id: phone.deviceId, endpoint: null });
  });

  it("is forgotten at Unpair, the relay told by revoke, and never sent again", async () => {
    const h = macHarness();
    const phone = await phoneWithPush(h);
    await h.remote.unpair(phone.deviceId!);
    expect(h.pushes.book).toEqual({});
    await waitFor(() => h.relay.sent("revoke").some((m) => m.id === phone.deviceId));
    // Back after a drop, nothing of that phone goes to the relay.
    const before = h.relay.sent("webpush").length;
    h.relay.cut();
    await waitFor(() => h.remote.snapshot().link === "waiting");
    h.clock.advance(1_000);
    await waitFor(() => h.remote.snapshot().link === "ready");
    await settle();
    expect(h.relay.sent("webpush")).toHaveLength(before);
    // And an ask opening wakes no one.
    await openAsk(h);
    expect(h.relay.sent("push")).toEqual([]);
  });

  it("is forgotten when the relay says its push service lost it", async () => {
    const h = macHarness();
    const phone = await phoneWithPush(h);
    h.relay.tellMac({ t: "webpush", v: 1, id: phone.deviceId, endpoint: null });
    await waitFor(() => !(phone.deviceId! in h.pushes.book));
    expect(h.remote.snapshot().phones[0]?.push).toBe(false);
    await openAsk(h);
    expect(h.relay.sent("push")).toEqual([]);
  });

  it("drops a kept address of a phone not paired here, and hands a paired phone's to the relay when the switch turns on", async () => {
    const stranger = "11111111-2222-4333-8444-555555555555";
    const h = macHarness({ pushes: { [stranger]: GOOGLE } });
    const phone = await phoneWithPush(h);
    expect(h.pushes.book).toEqual({ [phone.deviceId!]: APPLE });
    h.remote.turnOff();
    const before = h.relay.sent("webpush").length;
    await turnOn(h);
    await waitFor(() => h.relay.sent("webpush").length === before + 1);
    expect(h.relay.sent("webpush").at(-1)).toEqual({ t: "webpush", v: 1, id: phone.deviceId, endpoint: APPLE });
    expect(h.relay.sent("webpush").some((m) => m.id === stranger)).toBe(false);
  });
});

describe("push", () => {
  it("is sent once for a new ask while no phone is connected, naming the phones with an address", async () => {
    const h = macHarness();
    const phone = await phoneWithPush(h);
    await openAsk(h);
    expect(h.relay.sent("push")).toEqual([{ t: "push", v: 1, kind: "decision", devices: [phone.deviceId] }]);
    // The store changes again with the same ask open: nothing more.
    h.remote.publish();
    await settle();
    h.clock.advance(PUSH_GAP_MS);
    h.remote.publish();
    await settle();
    expect(h.relay.sent("push")).toHaveLength(1);
  });

  it("is not sent while a paired phone is connected, nor later for that ask", async () => {
    const h = macHarness();
    const phone = await phoneWithPush(h);
    const session = await phone.connect();
    await waitFor(() => h.remote.snapshot().phones[0]?.connected === true);
    await openAsk(h);
    session.close();
    await waitFor(() => h.remote.snapshot().phones[0]?.connected === false);
    h.clock.advance(PUSH_GAP_MS);
    h.remote.publish();
    await settle();
    expect(h.relay.sent("push")).toEqual([]);
  });

  it("waits two minutes between two pushes, and does not push later for an ask that opened in the gap", async () => {
    const h = macHarness();
    await phoneWithPush(h);
    await openAsk(h);
    h.clock.advance(PUSH_GAP_MS - 1);
    await openAsk(h);
    expect(h.relay.sent("push")).toHaveLength(1);
    h.clock.advance(1);
    h.remote.publish();
    await settle();
    expect(h.relay.sent("push")).toHaveLength(1);
    await openAsk(h);
    expect(h.relay.sent("push")).toHaveLength(2);
  });

  it("is not sent for the asks already open when the switch turns on, nor with no phone that has an address", async () => {
    const h = macHarness();
    await turnOn(h);
    await pairPhone(h);
    // The sample chats hold two open asks from the start, and no phone has an address.
    h.remote.publish();
    await settle();
    await openAsk(h);
    expect(h.relay.sent("push")).toEqual([]);
  });

  it("is not sent while the switch is off", async () => {
    const h = macHarness();
    await phoneWithPush(h);
    h.remote.turnOff();
    await openAsk(h);
    expect(h.relay.sent("push")).toEqual([]);
  });
});

describe("the plan and the store on their own", () => {
  it("pushes for a fresh ask once, lets closed asks go, and keeps the gap", () => {
    const plan = new PushPlan();
    plan.seed(["a"]);
    expect(plan.consider(["a"], 0, true)).toBe(false);
    expect(plan.consider(["a", "b"], 0, true)).toBe(true);
    expect(plan.consider(["a", "b"], PUSH_GAP_MS, true)).toBe(false);
    expect(plan.consider(["a", "b", "c"], PUSH_GAP_MS - 1, true)).toBe(false);
    // Seen while nothing could be pushed: not pushed for later.
    expect(plan.consider(["d"], 10 * PUSH_GAP_MS, false)).toBe(false);
    expect(plan.consider(["d"], 11 * PUSH_GAP_MS, true)).toBe(false);
  });

  it("keeps only device ids with a push address the relay would take", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
    const store = localPushStore(storage);
    expect(store.read()).toEqual({});
    store.write({ "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F": APPLE });
    expect(JSON.parse(kept.get(PUSH_KEY)!)).toEqual({ "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F": APPLE });
    kept.set(PUSH_KEY, JSON.stringify({ "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F": "https://example.com/x", nope: APPLE, "E621E1F8-C36C-495A-93FC-0C247A3E6E5F": GOOGLE }));
    expect(store.read()).toEqual({ "E621E1F8-C36C-495A-93FC-0C247A3E6E5F": GOOGLE });
    kept.set(PUSH_KEY, "not json");
    expect(store.read()).toEqual({});
    expect(memoryPushStore({ x: APPLE }).read()).toEqual({});
  });
});
