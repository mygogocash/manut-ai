// "Tell me when my Mac needs me" (item 78d, src/app/mac/remote.ts and notify.ts): the switch subscribes with the API's
// push key, and the push address goes to the Mac inside the session (`notify`), never anywhere else; an address the
// relay would not send to, or one the Mac refuses, is ended at once; turned off, or Forget this Mac, ends the
// subscription; and at every session the Mac hears the address as it is now. The desktop's real Mac and the real relay
// take the same request in apps/api/test/remote-phone.test.ts.
import { importSharedSecret } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { healthOf } from "../src/app/mac/live";
import type { PhonePush, SubscribeResult } from "../src/app/mac/notify";
import type { PairResult } from "../src/app/mac/pair";
import { MacRemote, type MacBackend, type MacView } from "../src/app/mac/remote";
import type { MacLink, Message, SessionEnd } from "../src/app/mac/session";
import { memoryVault, type PairedMac } from "../src/app/mac/vault";
import { ManualClock, StandInPasskeys, settle } from "./macKit";

const KEY = "B".padEnd(87, "k");
const APPLE = "https://web.push.apple.com/QGuQyavXutnMH8iVgwGGgVwKbd5Wfa1DXQWCeQGAkdaBJgJ1wUtklzp9KgAoWwPb";

class FakeLink implements MacLink {
  readonly sent: Message[] = [];
  onEvent: ((message: Message) => void) | null = null;
  onEnd: ((end: SessionEnd) => void) | null = null;
  closed = false;
  constructor(readonly answer: (message: Message) => Message | null) {}
  async request(message: Message): Promise<Message | null> {
    if (this.closed) return null;
    this.sent.push(message);
    return this.answer(message);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onEnd?.({ why: "closed" });
  }
  notifies(): Message[] {
    return this.sent.filter((m) => m.t === "notify");
  }
}

/// The browser's push, as a test plays it: what it was asked, and what it answers.
class FakePush implements PhonePush {
  readonly calls: string[] = [];
  endpoint: string | null = null;
  answer: SubscribeResult = { ok: true, endpoint: APPLE };
  constructor(readonly can = true) {}
  supported(): boolean {
    return this.can;
  }
  async current(): Promise<string | null> {
    return this.endpoint;
  }
  async subscribe(key: string): Promise<SubscribeResult> {
    this.calls.push(`subscribe ${key}`);
    if (this.answer.ok) this.endpoint = this.answer.endpoint;
    return this.answer;
  }
  async unsubscribe(): Promise<void> {
    this.calls.push("unsubscribe");
    this.endpoint = null;
  }
}

async function setup(options: { key?: string | null; push?: FakePush | null; macSays?: (message: Message) => Message | null; relay?: "on" | "off" } = {}) {
  const clock = new ManualClock();
  const vault = memoryVault();
  const passkeys = new StandInPasskeys();
  const mac: PairedMac = {
    hostId: "H".repeat(43),
    deviceId: "0B6A2C1E-4D5F-4A6B-8C7D-9E0F1A2B3C4D",
    doorToken: new Uint8Array(32),
    k: await importSharedSecret(new Uint8Array(32).fill(7)),
    credentialId: passkeys.credentialId,
    rpId: "phone.manut.test",
    pairedAt: 0,
  };
  await vault.save(mac);
  const links: FakeLink[] = [];
  let reachable = true;
  const push = options.push === undefined ? new FakePush() : options.push;
  const macSays = options.macSays ?? ((message: Message) => (message.t === "list" ? { t: "chats", chats: [] } : message.t === "notify" ? { t: "done" } : null));
  const backend: MacBackend = {
    relay: async () => options.relay ?? "on",
    pushKey: async () => (options.key === undefined ? KEY : options.key),
    ...(push ? { push } : {}),
    vault,
    passkeys,
    now: () => clock.now,
    timers: clock,
    pair: async (): Promise<PairResult> => ({ ok: true, mac }),
    connect: async () => {
      if (!reachable) return { ok: false, end: { why: "lost" } };
      const link = new FakeLink(macSays);
      links.push(link);
      return { ok: true, link };
    },
  };
  const remote = new MacRemote(backend);
  return { remote, push: push!, links, link: () => links.at(-1)!, clock, setReachable: (on: boolean) => (reachable = on) };
}

const notify = (view: MacView) => {
  if (view.phase !== "paired") throw new Error(`not paired: ${view.phase}`);
  return view.notify;
};

describe("the switch", () => {
  it("is offered only with the API's push key and a browser that can subscribe", async () => {
    for (const [key, push, offered] of [
      [KEY, new FakePush(true), "yes"],
      [KEY, new FakePush(false), "install"],
      [null, new FakePush(true), "no"],
      [KEY, null, "no"],
    ] as const) {
      const { remote } = await setup({ key, push });
      await remote.start();
      expect(notify(remote.view).offered, `${key} ${push?.can}`).toBe(offered);
    }
  });

  it("subscribes with the key from the tap, and sends the push address to the Mac inside the session", async () => {
    const s = await setup();
    await s.remote.start();
    await settle();
    // At the session's start the Mac hears there is no address yet.
    expect(s.link().notifies()).toEqual([{ t: "notify", endpoint: null }]);
    const turning = s.remote.notifyOn();
    // Asked before anything awaited, as Safari needs.
    expect(s.push.calls).toEqual([`subscribe ${KEY}`]);
    expect(notify(s.remote.view).busy).toBe(true);
    await turning;
    expect(s.link().notifies().at(-1)).toEqual({ t: "notify", endpoint: APPLE });
    expect(notify(s.remote.view)).toEqual({ offered: "yes", on: true, busy: false, note: null });
    // Turned off: the subscription ends, and the Mac forgets the address.
    await s.remote.notifyOff();
    expect(s.push.calls.at(-1)).toBe("unsubscribe");
    expect(s.link().notifies().at(-1)).toEqual({ t: "notify", endpoint: null });
    expect(notify(s.remote.view)).toMatchObject({ on: false, note: null });
  });

  it("says why when permission is refused or the subscription fails, and sends nothing", async () => {
    for (const why of ["denied", "failed"] as const) {
      const s = await setup();
      await s.remote.start();
      await settle();
      s.push.answer = { ok: false, why };
      await s.remote.notifyOn();
      expect(notify(s.remote.view)).toMatchObject({ on: false, note: why });
      expect(s.link().notifies()).toEqual([{ t: "notify", endpoint: null }]);
    }
  });

  it("ends a subscription on a push service the relay does not send to, and one the Mac refuses", async () => {
    const elsewhere = await setup();
    await elsewhere.remote.start();
    await settle();
    elsewhere.push.answer = { ok: true, endpoint: "https://wns2-par02p.notify.windows.com/w/?token=abc" };
    await elsewhere.remote.notifyOn();
    expect(elsewhere.push.calls.at(-1)).toBe("unsubscribe");
    expect(elsewhere.link().notifies()).toEqual([{ t: "notify", endpoint: null }]);
    expect(notify(elsewhere.remote.view)).toMatchObject({ on: false, note: "refused" });

    const refused = await setup({ macSays: (m) => (m.t === "list" ? { t: "chats", chats: [] } : m.t === "notify" && m.endpoint ? { t: "refused", reason: "push_address" } : { t: "done" }) });
    await refused.remote.start();
    await settle();
    await refused.remote.notifyOn();
    expect(refused.push.calls.at(-1)).toBe("unsubscribe");
    expect(notify(refused.remote.view)).toMatchObject({ on: false, note: "refused" });

    // A Mac not yet updated keeps no addresses: the phone says to update it.
    const old = await setup({ macSays: (m) => (m.t === "list" ? { t: "chats", chats: [] } : m.t === "notify" ? { t: "refused", reason: "unknown_request" } : null) });
    await old.remote.start();
    await settle();
    await old.remote.notifyOn();
    expect(notify(old.remote.view)).toMatchObject({ on: false, note: "mac" });
  });

  it("turned on while the Mac is away, sends the address at the next session", async () => {
    const s = await setup();
    s.setReachable(false);
    await s.remote.start();
    await settle();
    await s.remote.notifyOn();
    expect(notify(s.remote.view)).toMatchObject({ on: true, note: "later" });
    expect(s.links).toEqual([]);
    s.setReachable(true);
    s.clock.advance(1_000);
    await settle();
    expect(s.link().notifies()).toEqual([{ t: "notify", endpoint: APPLE }]);
    expect(notify(s.remote.view)).toMatchObject({ on: true, note: null });
  });

  it("reads as on when the app already holds a subscription, and Forget this Mac ends it", async () => {
    const push = new FakePush();
    push.endpoint = APPLE;
    const s = await setup({ push });
    await s.remote.start();
    expect(notify(s.remote.view).on).toBe(true);
    await settle();
    expect(s.link().notifies()).toEqual([{ t: "notify", endpoint: APPLE }]);
    expect(await s.remote.forget()).toBe(true);
    await settle();
    expect(push.calls).toEqual(["unsubscribe"]);
  });

  it("asks nothing of the browser while the relay is off", async () => {
    const s = await setup({ relay: "off" });
    await s.remote.start();
    expect(s.remote.view).toEqual({ phase: "unavailable" });
    expect(s.push.calls).toEqual([]);
  });
});

describe("the push key", () => {
  it("comes from the API's public health answer, only while the relay is on", async () => {
    const answer = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;
    expect(await healthOf("https://dev.manut.xyz", answer({ relay: "on", webPush: KEY }))).toEqual({ relay: "on", webPush: KEY });
    expect(await healthOf("https://dev.manut.xyz", answer({ relay: "off", webPush: KEY }))).toEqual({ relay: "off", webPush: null });
    expect(await healthOf("https://dev.manut.xyz", answer({ relay: "on", webPush: "short" }))).toEqual({ relay: "on", webPush: null });
    expect(await healthOf("https://dev.manut.xyz", answer({ relay: "on" }))).toEqual({ relay: "on", webPush: null });
    expect(await healthOf("https://dev.manut.xyz", answer({}, false))).toEqual({ relay: "unknown", webPush: null });
  });
});
