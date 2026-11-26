/// One session with the paired Mac (docs/remote-access.md, "Each connection"): the relay's door for this phone, then a
/// fresh key exchange proved with K (`startSession`), then JSON requests and answers inside the channel, as the Mac's
/// serve.ts reads and writes them. Every request carries a number `id` this phone picks, and the Mac's answer names it;
/// `event` messages arrive unasked for each change to a chat this phone has open.
///
/// The package's duties for a session (packages/remote-channel/README.md, "What the callers must do"): any refusal of
/// the channel closes it, and so does the relay closing the stream; the next session is a new handshake. A session that
/// ended may have missed messages, which is what the journal's cursors are for (remote.ts).
import { startSession, toBase64Url, type Channel } from "@manut/remote-channel";
import { type PhoneConnect, type RelayEnd, type RelayPipe, type Timers, dialRelay, relayUrl, systemTimers } from "./relay";
import type { PairedMac } from "./vault";

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

/// Opens a session with the paired Mac: the relay's door with this phone's token, then the handshake proved with K.
export async function openSession(deps: SessionDeps, mac: PairedMac): Promise<{ ok: true; session: MacSession } | { ok: false; end: SessionEnd }> {
  const url = relayUrl(deps.origin, mac.hostId);
  if (!url) return { ok: false, end: { why: "lost" } };
  const timers = deps.timers ?? systemTimers;
  const dialled = await dialRelay({ connect: deps.connect, url, device: mac.deviceId, token: toBase64Url(mac.doorToken), timers });
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
