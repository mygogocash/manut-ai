// The Mac's one socket to the relay (link.ts) against a bare fake socket: the hello signed as the relay's shared vectors
// pin it, the devices said again at every `ready`, the ping, the capped retry, the slow retry while the relay is off, and
// stream frames with their four-byte number.
import { describe, expect, it } from "vitest";
import vectors from "../../../api/test/fixtures/relay-v1-vectors.json";
import { toBase64Url } from "@manut/remote-channel";
import { hostIdentity } from "./keys";
import { HELLO_TIMEOUT_MS, OFF_RETRY_MS, PING_MS, type RelaySocket, RelayLink, challengeMessage, relayFromHealth, relaySocketUrl } from "./link";
import { ManualClock, settle } from "./testkit/clock";

const HOST = vectors.hostKey.hostID;
const NONCE = vectors.hostChallenge.nonce;
const DEVICE = vectors.deviceToken.device;
const HASH = vectors.deviceToken.tokenHash;
const OTHER = "00000000-0000-4000-8000-000000000001";

class FakeSocket implements RelaySocket {
  binaryType = "blob";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : data.slice());
  }
  close(code = 1000): void {
    this.closedWith = code;
  }
  /** The relay sends something. */
  receive(data: string | Record<string, unknown> | Uint8Array): void {
    this.onmessage?.({ data: data instanceof Uint8Array ? data.slice().buffer : typeof data === "string" ? data : JSON.stringify(data) });
  }
  /** The relay or the network closes it. */
  drop(code: number): void {
    this.onclose?.({ code, reason: "" });
  }
  texts(): Record<string, unknown>[] {
    return this.sent.filter((d): d is string => typeof d === "string" && d !== "ping").map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

async function vectorIdentity() {
  // The shell signs with the private half (remote_keys.rs); here Web Crypto stands in for it.
  const { d, x, y } = vectors.hostKey.privateJwk;
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d, x, y, ext: false }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return hostIdentity({ x, y }, async (message) => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message)))));
}

async function setup(probe: "on" | "off" | "unknown" = "on") {
  const clock = new ManualClock();
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const frames: [number, number[]][] = [];
  const identity = await vectorIdentity();
  const link = new RelayLink({
    url: `wss://dev.manut.xyz/relay/v1/hosts/${HOST}/socket`,
    identity,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    probe: async () => probe,
    timers: clock,
    events: {
      onOpen: (stream, device) => events.push(`open ${stream} ${device}`),
      onFrame: (stream, payload) => frames.push([stream, [...payload]]),
      onClose: (stream, reason) => events.push(`close ${stream} ${reason}`),
      onState: (state) => events.push(state),
    },
  });
  const last = () => sockets.at(-1)!;
  /** Answers the newest socket's challenge and waits for its hello, then says `ready` with `devices`. */
  const handshake = async (devices: string[] = []) => {
    last().receive({ t: "challenge", v: 1, nonce: NONCE });
    for (let i = 0; i < 50 && last().sent.length === 0; i++) await settle(1);
    last().receive({ t: "ready", v: 1, devices });
  };
  return { clock, sockets, events, frames, identity, link, last, handshake };
}

describe("the relay link", () => {
  it("is the vectors' host, and signs the relay's challenge as the relay checks it", async () => {
    const identity = await vectorIdentity();
    expect(identity.hostId).toBe(vectors.hostKey.hostID);
    expect(identity.publicKey).toBe(vectors.hostKey.publicKeyX963);
    expect(challengeMessage(HOST, NONCE)).toBe(vectors.hostChallenge.message);
    const s = await setup();
    s.link.start();
    expect(s.events).toEqual(["connecting"]);
    expect(s.last().binaryType).toBe("arraybuffer");
    await s.handshake();
    const hello = s.last().texts()[0]!;
    expect(Object.keys(hello).sort()).toEqual(["key", "sig", "t", "v"]);
    expect(hello).toMatchObject({ t: "hello", v: 1, key: vectors.hostKey.publicKeyX963 });
    // ECDSA signatures differ each time, so the vectors' own one is not repeated; this one verifies as the relay verifies.
    const raw = Uint8Array.from(atob(String(hello.key).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const sig = Uint8Array.from(atob(String(hello.sig).replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(vectors.hostChallenge.message))).toBe(true);
    expect(s.link.state).toBe("ready");
  });

  it("says again at every ready which devices may come in, revokes the rest, and repeats its presence", async () => {
    const s = await setup();
    s.link.allowDevice(DEVICE, HASH);
    s.link.setPresence("available", 1_789_000_000);
    s.link.start();
    await s.handshake([DEVICE, OTHER]);
    expect(s.last().texts().slice(1)).toEqual([
      { t: "device", v: 1, id: DEVICE, tokenHash: HASH },
      { t: "revoke", v: 1, id: OTHER },
      { t: "status", v: 1, state: "available", at: 1_789_000_000 },
    ]);
    // While up, each change goes at once.
    s.link.revokeDevice(DEVICE);
    expect(s.last().texts().at(-1)).toEqual({ t: "revoke", v: 1, id: DEVICE });
    // Messages in the vectors' own words.
    expect(vectors.messages.hostOutbound).toContainEqual({ t: "device", v: 1, id: DEVICE, tokenHash: HASH });
  });

  it("pings every 50 seconds while up", async () => {
    const s = await setup();
    s.link.start();
    await s.handshake();
    s.clock.advance(PING_MS - 1);
    expect(s.last().sent.filter((d) => d === "ping")).toHaveLength(0);
    s.clock.advance(1);
    s.clock.advance(PING_MS);
    expect(s.last().sent.filter((d) => d === "ping")).toHaveLength(2);
  });

  it("waits twice as long after each failed dial, up to 60 seconds, and from one second again after a good one", async () => {
    const s = await setup("on");
    s.link.start();
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      s.last().drop(1006);
      await settle(2);
      waits.push(s.clock.pending()[0]!);
      s.clock.advance(waits.at(-1)!);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    await s.handshake();
    s.last().drop(1006);
    await settle(2);
    expect(s.clock.pending()).toEqual([1_000]);
  });

  it("says not available and tries only every 15 minutes while the relay is switched off", async () => {
    const off = await setup("off");
    off.link.start();
    off.last().drop(1006);
    await settle(2);
    expect(off.link.state).toBe("unavailable");
    expect(off.clock.pending()).toEqual([OFF_RETRY_MS]);
    // Switched off under an open socket (4503), or out of today's budget (4429): the same slow wait, with no probe.
    for (const code of [4503, 4429]) {
      const s = await setup("on");
      s.link.start();
      await s.handshake();
      s.last().drop(code);
      await settle(2);
      expect(s.link.state).toBe("unavailable");
      expect(s.clock.pending()).toEqual([OFF_RETRY_MS]);
    }
    expect(relayFromHealth({ ok: true, relay: "off" })).toBe("off");
    expect(relayFromHealth({ ok: true, relay: "on" })).toBe("on");
    for (const odd of [null, "off", { relay: true }, { ok: true }]) expect(relayFromHealth(odd)).toBe("unknown");
  });

  it("drops a relay that does not challenge first, or says ready before the hello, or never answers", async () => {
    for (const first of [{ t: "ready", v: 1, devices: [] }, { t: "challenge", v: 2, nonce: NONCE }, { t: "challenge", v: 1, nonce: "short" }, "not json"]) {
      const s = await setup();
      s.link.start();
      s.last().receive(first);
      await settle(2);
      expect(s.last().closedWith).toBe(1000);
      expect(s.link.state).toBe("waiting");
    }
    const s = await setup();
    s.link.start();
    s.clock.advance(HELLO_TIMEOUT_MS);
    await settle(2);
    expect(s.sockets[0]!.closedWith).toBe(1000);
    expect(s.link.state).toBe("waiting");
  });

  it("carries frames by stream number, both ways, and only for streams the relay opened", async () => {
    const s = await setup();
    s.link.start();
    await s.handshake();
    const frame = vectors.streamFrames[0]!;
    s.last().receive({ t: "open", v: 1, stream: frame.stream, device: DEVICE });
    s.last().receive(Uint8Array.from(frame.frame.match(/../g)!.map((h) => parseInt(h, 16))));
    s.last().receive(Uint8Array.of(0, 0, 0, 9, 1, 2));
    s.last().receive(Uint8Array.of(1, 2));
    expect(s.frames).toEqual([[frame.stream, [0x09, 0x08]]]);
    expect(s.link.sendFrame(frame.stream, Uint8Array.of(0x09, 0x08))).toBe(true);
    expect([...(s.last().sent.at(-1) as Uint8Array)]).toEqual(frame.frame.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(s.link.sendFrame(9, Uint8Array.of(1))).toBe(false);
    s.link.closeStream(frame.stream);
    expect(s.last().texts().at(-1)).toEqual({ t: "close", v: 1, stream: frame.stream });
    // The relay closing a stream, and the socket dropping, each end what was open.
    s.last().receive({ t: "open", v: 1, stream: 5, device: DEVICE });
    s.last().receive({ t: "open", v: 1, stream: 6, device: DEVICE });
    s.last().receive({ t: "close", v: 1, stream: 5, reason: "replaced" });
    s.last().drop(1006);
    expect(s.events.filter((e) => e.startsWith("close"))).toEqual(["close 5 replaced", "close 6 closed"]);
  });

  it("closes for good on stop, and dials nothing more", async () => {
    const s = await setup();
    s.link.start();
    await s.handshake();
    s.link.stop();
    expect(s.sockets[0]!.closedWith).toBe(1000);
    expect(s.link.state).toBe("stopped");
    s.clock.advance(OFF_RETRY_MS * 4);
    expect(s.sockets).toHaveLength(1);
  });

  it("reaches only the API origin's relay, at the addresses the app's content policy allows", () => {
    expect(relaySocketUrl("https://dev.manut.xyz", HOST)).toBe(`wss://dev.manut.xyz/relay/v1/hosts/${HOST}/socket`);
    expect(relaySocketUrl("https://manut.xyz", HOST)).toBe(`wss://manut.xyz/relay/v1/hosts/${HOST}/socket`);
    expect(relaySocketUrl("http://localhost:8787", HOST)).toBe(`ws://localhost:8787/relay/v1/hosts/${HOST}/socket`);
    for (const origin of ["https://evil.example", "https://dev.manut.xyz:8443", "http://dev.manut.xyz", "https://manut.xyz.evil.example", "not a url"]) {
      expect(relaySocketUrl(origin, HOST)).toBeNull();
    }
    expect(relaySocketUrl("https://dev.manut.xyz", "../../x")).toBeNull();
  });
});
