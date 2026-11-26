// Stand-ins for the Your Mac tab's tests (src/app/mac/), mirrored from the desktop's (apps/desktop/src/remote/testkit/):
// a clock a test moves by hand, a stand-in passkey laid out as WebAuthn Level 3 does, and a relay socket whose other end
// is a Mac a test scripts step by step from the channel package's own Mac side (`macPairing`, `acceptSession`). The
// desktop's real Mac meets this phone through the real relay in apps/api/test/remote-phone.test.ts; these let a test
// break one step at a time and see exactly what the phone sent.
import {
  type Channel,
  type RelyingParty,
  acceptSession,
  decodePairingGrant,
  fromBase64Url,
  importSharedSecret,
  newPairingOffer,
  pairingLink,
  toBase64Url,
} from "@manut/remote-channel";
import type { Assertion, Passkeys, Registration } from "../src/app/mac/passkeys";
import type { PhoneSocket, Timers } from "../src/app/mac/relay";

export const ORIGIN = "https://phone.manut.test";
export const RP: RelyingParty = { id: "phone.manut.test", origin: ORIGIN };

/// A clock and timers a test moves by hand (the desktop's testkit/clock.ts).
export class ManualClock implements Timers {
  now: number;
  readonly #timers = new Map<number, { at: number; run: () => void }>();
  #next = 1;

  constructor(start = 1_800_000_000_000) {
    this.now = start;
  }

  set(run: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, run });
    return id;
  }

  clear(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].run();
    }
    this.now = end;
  }
}

/// Lets every promise that is ready run.
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const enc = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

function cat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function derFromRaw(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let body = bytes.slice(start);
    if ((body[0] ?? 0) & 0x80) body = cat(Uint8Array.of(0), body);
    return cat(Uint8Array.of(0x02, body.length), body);
  };
  const body = cat(integer(raw.slice(0, 32)), integer(raw.slice(32, 64)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

/// A stand-in platform passkey: a P-256 key, its answers laid out as WebAuthn Level 3 does (the desktop's
/// testkit/phone.ts `TestAuthenticator`), recording what it was asked. `refuse` makes the next call throw that error.
export class StandInPasskeys implements Passkeys {
  readonly available: boolean;
  readonly credentialId = new Uint8Array(16).fill(0xc1);
  readonly created: { rpId: string; challenge: Uint8Array; userId: string }[] = [];
  readonly signed: { rpId: string; challenge: Uint8Array; credentialId: Uint8Array }[] = [];
  refuse: Error[] = [];
  #keys: CryptoKeyPair | null = null;

  constructor(available = true) {
    this.available = available;
  }

  async #pair(): Promise<CryptoKeyPair> {
    this.#keys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return this.#keys;
  }

  async #authData(rpId: string, flags: number, extra: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc(rpId)));
    return cat(hash, Uint8Array.of(flags), new Uint8Array(4), extra);
  }

  async create(request: { rpId: string; challenge: Uint8Array; userId: string }): Promise<Registration> {
    this.created.push({ rpId: request.rpId, challenge: request.challenge.slice(), userId: request.userId });
    const refusal = this.refuse.shift();
    if (refusal) throw refusal;
    const keys = await this.#pair();
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    const cose = Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...raw.slice(1, 33), 0x22, 0x58, 0x20, ...raw.slice(33, 65));
    const attested = cat(new Uint8Array(16), Uint8Array.of(0x00, this.credentialId.length), this.credentialId, cose);
    const clientDataJSON = enc(JSON.stringify({ type: "webauthn.create", challenge: toBase64Url(request.challenge), origin: ORIGIN, crossOrigin: false }));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData: await this.#authData(request.rpId, 0x01 | 0x04 | 0x40, attested) };
  }

  async get(request: { rpId: string; challenge: Uint8Array; credentialId: Uint8Array }): Promise<Assertion> {
    this.signed.push({ rpId: request.rpId, challenge: request.challenge.slice(), credentialId: request.credentialId.slice() });
    const refusal = this.refuse.shift();
    if (refusal) throw refusal;
    const keys = await this.#pair();
    const clientDataJSON = enc(JSON.stringify({ type: "webauthn.get", challenge: toBase64Url(request.challenge), origin: ORIGIN, crossOrigin: false }));
    const authenticatorData = await this.#authData(request.rpId, 0x01 | 0x04, new Uint8Array(0));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authenticatorData, hash)));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData, signature: derFromRaw(raw) };
  }
}

/// The relay and a Mac behind it, for one phone socket. The phone's side is a `PhoneSocket`; the test plays the relay's
/// answers (`ready`, a close code) and the Mac's frames, and reads everything the phone sent.
export class ScriptedSocket implements PhoneSocket {
  binaryType = "blob";
  onmessage: PhoneSocket["onmessage"] = null;
  onclose: PhoneSocket["onclose"] = null;
  readonly url: string;
  /// Every message the phone sent, in order.
  readonly sent: (string | Uint8Array)[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #inbox: (string | Uint8Array)[] = [];
  readonly #waiting: ((data: string | Uint8Array | null) => void)[] = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | Uint8Array): void {
    if (this.closed) return;
    const copy = typeof data === "string" ? data : data.slice();
    this.sent.push(copy);
    if (copy === "ping") return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter(copy);
    else this.#inbox.push(copy);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const w of this.#waiting.splice(0)) w(null);
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /// The next thing the phone sent, or null once it closed.
  next(): Promise<string | Uint8Array | null> {
    const queued = this.#inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /// The phone's hello, parsed.
  async hello(): Promise<{ t: string; device: string; token: string }> {
    const data = await this.next();
    if (typeof data !== "string") throw new Error("no hello");
    return JSON.parse(data) as { t: string; device: string; token: string };
  }

  /// The next binary frame the phone sent.
  async frame(): Promise<Uint8Array> {
    const data = await this.next();
    if (!(data instanceof Uint8Array)) throw new Error(`no frame: ${String(data)}`);
    return data;
  }

  /// The relay or the Mac says something to the phone.
  deliver(data: string | Uint8Array): void {
    if (this.closed) return;
    queueMicrotask(() => this.onmessage?.({ data: typeof data === "string" ? data : data.slice().buffer }));
  }

  /// The relay ends the socket with `code`.
  shut(code: number, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const w of this.#waiting.splice(0)) w(null);
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }

  /// Frames the phone sent, in order.
  frames(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
  }
}

/// Every socket the phone opened, in order, each scripted by the test.
export class Sockets {
  readonly opened: ScriptedSocket[] = [];
  #waiting: ((socket: ScriptedSocket) => void)[] = [];
  readonly connect = (url: string): ScriptedSocket => {
    const socket = new ScriptedSocket(url);
    this.opened.push(socket);
    const waiter = this.#waiting.shift();
    if (waiter) waiter(socket);
    return socket;
  };

  /// The socket the phone opens next (or opened last, if one waits unclaimed).
  next(): Promise<ScriptedSocket> {
    const unclaimed = this.opened.find((s) => !claimed.has(s));
    if (unclaimed) {
      claimed.add(unclaimed);
      return Promise.resolve(unclaimed);
    }
    return new Promise((resolve) =>
      this.#waiting.push((socket) => {
        claimed.add(socket);
        resolve(socket);
      }),
    );
  }
}

const claimed = new WeakSet<ScriptedSocket>();

/// A Mac's new pairing code for a host id made for the test, as the link the QR code shows.
export function pairingCode(): { link: string; offer: ReturnType<typeof newPairingOffer>; hostId: string } {
  const hostId = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const offer = newPairingOffer(hostId);
  const link = pairingLink(`${ORIGIN}/app/`, offer);
  return { link, offer, hostId };
}

/// The Mac's side of an open session: the package's `acceptSession` over a scripted socket, then JSON both ways.
export async function macSession(socket: ScriptedSocket, params: { hostId: string; secrets: Map<string, CryptoKey> }): Promise<Channel> {
  const hello = await socket.frame();
  const { welcome, mac } = await acceptSession(hello, { hostId: params.hostId, secretFor: (id) => params.secrets.get(id) });
  socket.deliver(welcome);
  return mac.receiveFinish(await socket.frame());
}

/// One message the phone sent on a channel, parsed.
export async function readJson(socket: ScriptedSocket, channel: Channel): Promise<Record<string, unknown>> {
  for (;;) {
    const opened = await channel.open(await socket.frame());
    if (opened !== null) return JSON.parse(new TextDecoder().decode(opened)) as Record<string, unknown>;
  }
}

/// The Mac says one JSON message on a channel.
export async function sayJson(socket: ScriptedSocket, channel: Channel, message: Record<string, unknown>): Promise<void> {
  for (const frame of await channel.seal(enc(JSON.stringify(message)))) socket.deliver(frame);
}

export { decodePairingGrant, fromBase64Url, importSharedSecret };
