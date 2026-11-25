// The live feed's followers on their own (feed.ts), over a fake socket and fake timers: what each shop's follower asks, opens
// and sends, how a ping is passed on and nothing else is, the backoff after a drop or a failed look, the hour's wait while
// the feed is off, the keepalive, and that letting a shop go closes its socket and leaves nothing behind. The host's side,
// end to end over a fake API, is feed.host.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import confText from "../../../src-tauri/tauri.conf.json?raw";
import {
  BEARER_PROTOCOL,
  FEED_OFF_MS,
  FEED_PROTOCOL,
  FEED_RETRY_MAX_MS,
  FEED_RETRY_MIN_MS,
  FEED_STEADY_MS,
  feedUrl,
  KEEPALIVE_MS,
  PONG_WAIT_MS,
  ShopFeeds,
  type Look,
} from "./feed";
import { FakeSocket } from "./testkit";

const URL_ = "wss://dev.manut.xyz/v1/feed";

/** A world for one test: the sockets opened, the looks asked (answered in order, the last one again), the pings heard. */
function world(...answers: Look[]) {
  const sockets: FakeSocket[] = [];
  const looks: string[] = [];
  const pings: string[] = [];
  const queue = [...answers];
  const feeds = new ShopFeeds({
    url: URL_,
    open: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    link: {
      look: async (shop) => {
        looks.push(shop);
        return (queue.length > 1 ? queue.shift() : queue[0]) ?? { kind: "retry" };
      },
      ping: (shop) => void pings.push(shop),
    },
  });
  return { feeds, sockets, looks, pings, answer: (...more: Look[]) => queue.splice(0, queue.length, ...more) };
}

const ON = (token = "mos1.shop-a.fake-1"): Look => ({ kind: "on", token });
const PING = JSON.stringify({ v: 1, seq: 1795591574420 });

async function settle() {
  for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("following a shop", () => {
  it("looks first, then opens one socket to the feed's address with the shop session in its protocols, never in the address", async () => {
    const w = world(ON("mos1.shop-a.fake-1"));
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    expect(w.looks).toEqual(["pilot:shop-a"]);
    expect(w.sockets).toHaveLength(1);
    expect(w.sockets[0]!.url).toBe(URL_);
    expect(w.sockets[0]!.url).not.toContain("fake-1");
    expect(w.sockets[0]!.protocols).toEqual([FEED_PROTOCOL, `${BEARER_PROTOCOL}mos1.shop-a.fake-1`]);
    w.sockets[0]!.opened();
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "open" });
  });

  it("passes a ping on, naming its shop, and takes nothing else from any message", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    const socket = w.sockets[0]!;
    socket.opened();
    socket.says(PING);
    for (const other of ["pong", "ping", "{}", JSON.stringify({ v: 2, seq: 1 }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, seq: "1" }),
      "not json", `{"v":1,"seq":1,"pad":"${"x".repeat(300)}"}`, 42, null]) socket.says(other);
    expect(w.pings).toEqual(["pilot:shop-a"]);
  });

  it("opens nothing while the API says the feed is off, and looks again an hour later, not before", async () => {
    const w = world({ kind: "off" });
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    expect(w.sockets).toEqual([]);
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "off" });
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS - 1);
    expect(w.looks).toHaveLength(1);
    w.answer(ON());
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(w.looks).toHaveLength(2);
    expect(w.sockets).toHaveLength(1);
  });

  it("backs off after a look that failed, doubling from 2 seconds and never waiting more than an hour", async () => {
    const w = world({ kind: "retry" });
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    const waits: number[] = [];
    let at = Date.now();
    for (let i = 0; i < 14; i += 1) {
      const before = w.looks.length;
      while (w.looks.length === before) await vi.advanceTimersByTimeAsync(500);
      waits.push(Math.round((Date.now() - at) / 1000));
      at = Date.now();
    }
    expect(waits.slice(0, 5)).toEqual([2, 4, 8, 16, 32]);
    expect(Math.max(...waits)).toBe(FEED_RETRY_MAX_MS / 1000);
    expect(waits.at(-1)).toBe(FEED_RETRY_MAX_MS / 1000);
    expect(w.sockets).toEqual([]);
  });

  it("looks again after a socket drops, waiting longer each time, and starts over after a socket that stayed open a minute", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    w.sockets[0]!.opened();
    w.sockets[0]!.drops();
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "waiting" });
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(2);
    w.sockets[1]!.drops();
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(3);
    // A good run: the next drop waits the shortest time again, and no less: only a 4000 opens the next one at once.
    w.sockets[2]!.opened();
    await vi.advanceTimersByTimeAsync(FEED_STEADY_MS);
    w.sockets[2]!.drops();
    await settle();
    expect(w.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(4);
  });

  it("starts the backoff over after an hour off", async () => {
    const w = world({ kind: "retry" }, { kind: "retry" }, { kind: "retry" }, { kind: "off" }, ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    await settle();
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "off" });
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS);
    await settle();
    expect(w.sockets).toHaveLength(1);
    w.sockets[0]!.opened();
    w.sockets[0]!.drops();
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(2);
  });

  it("waits an hour when the API closes the socket because the switch is off", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    w.sockets[0]!.opened();
    w.sockets[0]!.drops(4503);
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "off" });
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS - 1);
    expect(w.looks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(w.looks).toHaveLength(2);
  });

  it("opens the next socket at once when a good socket's hour ends (4000), and backs off when a new one is closed so", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    w.sockets[0]!.opened();
    await vi.advanceTimersByTimeAsync(FEED_STEADY_MS);
    w.sockets[0]!.drops(4000);
    await settle();
    expect(w.sockets).toHaveLength(2);
    // One that had no good run is not trusted to say so: nothing loops on a socket that keeps closing.
    w.sockets[1]!.opened();
    w.sockets[1]!.drops(4000);
    await settle();
    expect(w.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(3);
  });

  it("says ping every 50 seconds; an answered one keeps the socket, and one left unanswered closes it and backs off", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    const socket = w.sockets[0]!;
    socket.opened();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(socket.sent).toEqual(["ping"]);
    socket.says("pong");
    await vi.advanceTimersByTimeAsync(PONG_WAIT_MS);
    expect(socket.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS - PONG_WAIT_MS);
    expect(socket.sent).toEqual(["ping", "ping"]);
    await vi.advanceTimersByTimeAsync(PONG_WAIT_MS);
    expect(socket.closed).toEqual({ code: 1000, reason: "done" });
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "waiting" });
    // Its late close says nothing more: one drop, one wait.
    socket.drops();
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(w.sockets).toHaveLength(2);
    expect(w.looks).toHaveLength(2);
    // And it is never said ping again: its keepalive went with it.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(socket.sent).toEqual(["ping", "ping"]);
  });

  it("backs off when the page refuses to open the socket at all", async () => {
    const looks: string[] = [];
    let opens = 0;
    const feeds = new ShopFeeds({
      url: URL_,
      open: () => {
        opens += 1;
        throw new Error("refused by the page's CSP");
      },
      link: { look: async (shop) => (looks.push(shop), ON()), ping: () => undefined },
    });
    feeds.follow(["pilot:shop-a"]);
    await settle();
    expect(opens).toBe(1);
    expect(feeds.states()).toEqual({ "pilot:shop-a": "waiting" });
    await vi.advanceTimersByTimeAsync(FEED_RETRY_MIN_MS);
    await settle();
    expect(opens).toBe(2);
  });

  it("stops following a shop the look says to stop for, and asks nothing more", async () => {
    const w = world({ kind: "stop" });
    w.feeds.follow(["pilot:shop-a"]);
    await settle();
    expect(w.feeds.states()).toEqual({ "pilot:shop-a": "stopped" });
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS * 3);
    expect(w.looks).toHaveLength(1);
    expect(w.sockets).toEqual([]);
  });
});

describe("letting shops go", () => {
  it("closes the socket of a shop the read no longer shows, keeps the others, and opens one for a shop new to it", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a", "pilot:shop-b"]);
    await settle();
    const [a, b] = w.sockets;
    w.feeds.follow(["pilot:shop-a", "pilot:shop-c"]);
    await settle();
    expect(a!.closed).toBeNull();
    expect(b!.closed).toEqual({ code: 1000, reason: "done" });
    expect(w.sockets).toHaveLength(3);
    expect(Object.keys(w.feeds.states()).sort()).toEqual(["pilot:shop-a", "pilot:shop-c"]);
  });

  it("drops one shop, or stops every shop, leaving no socket open and nothing to act later", async () => {
    const w = world(ON());
    w.feeds.follow(["pilot:shop-a", "pilot:shop-b"]);
    await settle();
    for (const socket of w.sockets) socket.opened();
    w.feeds.drop(["pilot:shop-b"]);
    expect(w.sockets[1]!.closed).toEqual({ code: 1000, reason: "done" });
    w.feeds.stop();
    expect(w.sockets[0]!.closed).toEqual({ code: 1000, reason: "done" });
    expect(w.feeds.states()).toEqual({});
    // A ping or a close that comes after is not heard, and no timer is left to look again or say ping.
    w.sockets[0]!.says(PING);
    w.sockets[0]!.drops();
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS * 2);
    expect(w.pings).toEqual([]);
    expect(w.looks).toHaveLength(2);
    expect(w.sockets[0]!.sent).toEqual([]);
  });

  it("leaves no look to come when a shop is let go while it waits, to try again or for the hour off to end", async () => {
    const waiting = world({ kind: "retry" });
    const off = world({ kind: "off" });
    waiting.feeds.follow(["pilot:shop-a"]);
    off.feeds.follow(["pilot:shop-a"]);
    await settle();
    expect(waiting.feeds.states()).toEqual({ "pilot:shop-a": "waiting" });
    expect(off.feeds.states()).toEqual({ "pilot:shop-a": "off" });
    waiting.feeds.stop();
    off.feeds.drop(["pilot:shop-a"]);
    await vi.advanceTimersByTimeAsync(FEED_OFF_MS * 2);
    expect(waiting.looks).toHaveLength(1);
    expect(off.looks).toHaveLength(1);
  });

  it("opens nothing for a shop let go while its look was on its way", async () => {
    let answer: (look: Look) => void = () => undefined;
    const sockets: FakeSocket[] = [];
    const feeds = new ShopFeeds({
      url: URL_,
      open: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      link: { look: () => new Promise<Look>((resolve) => (answer = resolve)), ping: () => undefined },
    });
    feeds.follow(["pilot:shop-a"]);
    await settle();
    feeds.follow([]);
    answer(ON());
    await settle();
    expect(sockets).toEqual([]);
  });
});

describe("where a feed can be opened", () => {
  it("is Manut AI's own API hosts on https at the default port, and nowhere else", () => {
    expect(feedUrl("https://dev.manut.xyz")).toBe("wss://dev.manut.xyz/v1/feed");
    expect(feedUrl("https://staging.manut.xyz")).toBe("wss://staging.manut.xyz/v1/feed");
    expect(feedUrl("https://manut.xyz")).toBe("wss://manut.xyz/v1/feed");
    expect(feedUrl("https://DEV.Manut.XYZ")).toBe("wss://dev.manut.xyz/v1/feed");
    for (const origin of ["http://dev.manut.xyz", "http://localhost:8787", "http://127.0.0.1:8787", "https://example.com",
      "https://manut.xyz.example.com", "https://evilmanut.xyz", "https://dev.manut.xyz:8443", "not an origin", ""]) {
      expect(feedUrl(origin), origin).toBeNull();
    }
  });

  it("is exactly what the packaged app's CSP lets the page connect to, so no socket the page opens is one the CSP refuses", () => {
    const conf = JSON.parse(confText) as { app: { security: { csp: Record<string, string>; devCsp: Record<string, string> } } };
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      const wss = csp["connect-src"]!.split(" ").filter((s) => s.startsWith("wss:"));
      expect(wss).toEqual(["wss://manut.xyz", "wss://*.manut.xyz"]);
      // Nothing else the page may reach outside this app: no other secure socket, no https.
      expect(csp["connect-src"]!.split(" ").filter((s) => s.startsWith("https:"))).toEqual([]);
    }
    const allowed = (url: string) => {
      const { protocol, hostname, port } = new URL(url);
      return protocol === "wss:" && port === "" && (hostname === "manut.xyz" || hostname.endsWith(".manut.xyz"));
    };
    for (const origin of ["https://dev.manut.xyz", "https://manut.xyz", "https://a.b.manut.xyz"]) expect(allowed(feedUrl(origin)!)).toBe(true);
  });
});
