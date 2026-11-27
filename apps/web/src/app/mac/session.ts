/// One session with the paired Mac (docs/remote-access.md, "Each connection"): the relay's door for this phone, then a
/// fresh key exchange proved with K (`startSession`), then JSON requests and answers inside the channel, as the Mac's
/// serve.ts reads and writes them. Every request carries a number `id` this phone picks, and the Mac's answer names it;
/// `event` messages arrive unasked for each change to a chat this phone has open.
///
/// The package's duties for a session (packages/remote-channel/README.md, "What the callers must do"): any refusal of
/// the channel closes it, and so does the relay closing the stream; the next session is a new handshake. A session that
/// ended may have missed messages, which is what the journal's cursors are for (remote.ts).
import { startSession, toBase64Url, type Channel } from "@manut/remote-channel";
import { type PhoneConnect, type RelayEnd, type RelayPipe, type Timers, dialRelay, relayUrl, systemTimers, tailnetNameOk, tailnetUrl, TAILNET_PORT } from "./relay";
import type { PairedMac, Road } from "./vault";

/// How long the tailnet has before the relay is tried too (docs/remote-access.md, "Which road"): a phone on the tailnet
/// gets there first, and one that is not loses at most this long.
export const TAILNET_HEAD_START_MS = 1_500;

/// The Mac's `road` message (item 78f-2c): its door over the tailnet, null when its Tailscale road is off, or undefined for
/// a message that does not read, which changes nothing. Only a name the desktop itself would accept and the door's one port
/// are taken, since that is all this page's content policy lets a socket reach.
export function readRoad(message: unknown): Road | null | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const m = message as { t?: unknown; name?: unknown; port?: unknown };
  if (m.t !== "road") return undefined;
  if (m.name === null) return null;
  if (typeof m.name !== "string" || !tailnetNameOk(m.name) || m.port !== TAILNET_PORT) return undefined;
  return { name: m.name, port: TAILNET_PORT };
}

/// How long the Mac has to answer the session's handshake, and each request.
export const WELCOME_MS = 10_000;
export const REQUEST_MS = 20_000;

export type Message = Record<string, unknown>;

/// Why a session ended, or did not open: the relay's reasons, or the Mac's channel refusing or going quiet.
export type SessionEnd = RelayEnd | { readonly why: "refused" };

export interface SessionDeps {
  readonly origin: string;
  readonly connect: PhoneConnect;
  readonly timers?: Timers;
}

/// What the tab needs of a session, so practice mode can stand in for the Mac.
export interface MacLink {
  request(message: Message, ms?: number): Promise<Message | null>;
  close(): void;
  onEvent: ((message: Message) => void) | null;
  onEnd: ((end: SessionEnd) => void) | null;
  /// The Mac said where its door over the tailnet is, or that it has none (item 78f-2c).
  onRoad?: ((road: Road | null) => void) | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class MacSession implements MacLink {
  readonly #pipe: RelayPipe;
  readonly #channel: Channel;
  readonly #timers: Timers;
  readonly #pending = new Map<number, { resolve: (message: Message | null) => void; timer: unknown }>();
  #nextId = 1;
  #reading: Promise<void> = Promise.resolve();
  #sending: Promise<void> = Promise.resolve();
  #ended: SessionEnd | null = null;
  onEvent: ((message: Message) => void) | null = null;
  onRoad: ((road: Road | null) => void) | null = null;
  onEnd: ((end: SessionEnd) => void) | null = null;

  constructor(pipe: RelayPipe, channel: Channel, timers: Timers) {
    this.#pipe = pipe;
    this.#channel = channel;
    this.#timers = timers;
    pipe.onEnd = (end) => this.#end(end);
    pipe.read((frame) => {
      this.#reading = this.#reading.then(() => this.#read(frame));
    });
    if (pipe.ended) this.#end(pipe.ended);
  }

  get ended(): SessionEnd | null {
    return this.#ended;
  }

  async #read(frame: Uint8Array): Promise<void> {
    if (this.#ended) return;
    let message: Message;
    try {
      const opened = await this.#channel.open(frame);
      if (opened === null) return;
      const value: unknown = JSON.parse(decoder.decode(opened));
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      message = value as Message;
    } catch {
      // A record that does not open, or a message that does not read, ends the channel: a new session starts over.
      return this.#end({ why: "refused" });
    }
    const id = typeof message.id === "number" ? message.id : null;
    const waiting = id === null ? undefined : this.#pending.get(id);
    if (waiting && id !== null) {
      this.#pending.delete(id);
      this.#timers.clear(waiting.timer);
      waiting.resolve(message);
      return;
    }
    if (message.t === "event") this.onEvent?.(message);
    else if (message.t === "road") {
      const road = readRoad(message);
      if (road !== undefined) this.onRoad?.(road);
    }
  }

  /// Sends one request and resolves with the Mac's answer to it, or null when the session ended or the Mac did not
  /// answer in time (which ends the session too: what it would have said is unknown).
  request(message: Message, ms: number = REQUEST_MS): Promise<Message | null> {
    if (this.#ended) return Promise.resolve(null);
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = this.#timers.set(() => {
        this.#pending.delete(id);
        resolve(null);
        this.#end({ why: "lost" });
      }, ms);
      this.#pending.set(id, { resolve, timer });
      const bytes = encoder.encode(JSON.stringify({ ...message, id }));
      this.#sending = this.#sending.then(async () => {
        if (this.#ended) return;
        try {
          for (const frame of await this.#channel.seal(bytes)) this.#pipe.send(frame);
        } catch {
          this.#end({ why: "refused" });
        }
      });
    });
  }

  close(): void {
    this.#end({ why: "closed" });
  }

  #end(end: SessionEnd): void {
    if (this.#ended) return;
    this.#ended = end;
    this.#channel.close();
    this.#pipe.close();
    for (const [, waiting] of this.#pending) {
      this.#timers.clear(waiting.timer);
      waiting.resolve(null);
    }
    this.#pending.clear();
    this.onEnd?.(end);
  }
}

/// The door to the paired Mac by either road (docs/remote-access.md, "Which road"): with a tailnet door known, it is
/// dialled first and the relay after `TAILNET_HEAD_START_MS`, or at once if the tailnet turns the phone away first; the
/// first to say `ready` carries the session and the other is closed when it comes. The same hello, token and channel go
/// down either road. Turned away by both, the relay's reason is the one said, since it names what the Mac decided.
export function dialRoads(deps: SessionDeps, mac: PairedMac, timers: Timers): Promise<{ ok: true; pipe: RelayPipe } | { ok: false; end: RelayEnd }> {
  return dialDoor(deps, { hostId: mac.hostId, device: mac.deviceId, token: toBase64Url(mac.doorToken), ...(mac.tailnet ? { tailnet: mac.tailnet } : {}) }, timers);
}

/// A door on the Mac by either road: a paired phone's own (`dialRoads`), or a pairing code's one-use door (pair.ts).
export interface DoorTarget {
  readonly hostId: string;
  readonly device: string;
  readonly token: string;
  readonly tailnet?: Road;
}

/// `dialRoads` for any door: the tailnet first when it is known, the relay after the head start or at once.
export function dialDoor(deps: SessionDeps, target: DoorTarget, timers: Timers): Promise<{ ok: true; pipe: RelayPipe } | { ok: false; end: RelayEnd }> {
  const relay = relayUrl(deps.origin, target.hostId);
  const tail = target.tailnet ? tailnetUrl(target.tailnet, target.hostId) : null;
  const dial = (url: string) => dialRelay({ connect: deps.connect, url, device: target.device, token: target.token, timers });
  if (!tail) return relay ? dial(relay) : Promise.resolve({ ok: false, end: { why: "lost" } });
  if (!relay) return dial(tail);
  return new Promise((resolve) => {
    let done = false;
    let relayStarted = false;
    let pending = 0;
    let tailEnd: RelayEnd | null = null;
    let relayEnd: RelayEnd | null = null;
    const startRelay = () => {
      if (relayStarted || done) return;
      relayStarted = true;
      pending += 1;
      void dial(relay).then((r) => settle(r, "relay"));
    };
    const head = timers.set(startRelay, TAILNET_HEAD_START_MS);
    const settle = (r: { ok: true; pipe: RelayPipe } | { ok: false; end: RelayEnd }, road: "tail" | "relay") => {
      pending -= 1;
      if (r.ok) {
        if (done) return r.pipe.close();
        done = true;
        timers.clear(head);
        return resolve(r);
      }
      if (road === "tail") tailEnd = r.end;
      else relayEnd = r.end;
      if (done) return;
      if (!relayStarted) {
        timers.clear(head);
        return startRelay();
      }
      if (pending === 0) {
        done = true;
        resolve({ ok: false, end: relayEnd ?? tailEnd ?? { why: "lost" } });
      }
    };
    pending += 1;
    void dial(tail).then((r) => settle(r, "tail"));
  });
}

/// Opens a session with the paired Mac: the door by either road with this phone's token, then the handshake proved with K.
export async function openSession(deps: SessionDeps, mac: PairedMac): Promise<{ ok: true; session: MacSession } | { ok: false; end: SessionEnd }> {
  const timers = deps.timers ?? systemTimers;
  const dialled = await dialRoads(deps, mac, timers);
  if (!dialled.ok) return { ok: false, end: dialled.end };
  const pipe = dialled.pipe;
  try {
    const { hello, phone } = await startSession({ hostId: mac.hostId, deviceId: mac.deviceId, secret: mac.k });
    pipe.send(hello);
    const welcome = await pipe.next(WELCOME_MS);
    if (!welcome) {
      const end = pipe.ended ?? { why: "lost" as const };
      pipe.close();
      // The Mac closing the stream before its welcome is the Mac turning this phone's hello away.
      return { ok: false, end: end.why === "closed" ? { why: "refused" } : end };
    }
    const { finish, channel } = await phone.receiveWelcome(welcome);
    pipe.send(finish);
    return { ok: true, session: new MacSession(pipe, channel, timers) };
  } catch {
    pipe.close();
    return { ok: false, end: { why: "refused" } };
  }
}
