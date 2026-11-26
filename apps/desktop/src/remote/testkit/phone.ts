// A phone for tests, built from the package's phone side (`startPairing`, `startSession`, `decisionChallenge`) and a
// stand-in passkey, speaking the relay's phone protocol (docs/relay-protocol-v1.md, section 6) and the Mac's messages
// (pairing.ts, serve.ts). The desktop's tests drive it against a fake relay (relay.ts), and the API's tests drive it
// against the real relay object in workerd, so both prove the Mac's side against the same phone. It is test-only: the
// app imports nothing from this folder, and the phone the person uses is the web app's (item 78c).
import {
  type Channel,
  type PairingOffer,
  type RelyingParty,
  decisionChallenge,
  decodePairingGrant,
  fromBase64Url,
  readPairingLink,
  startPairing,
  startSession,
  toBase64Url,
} from "@manut/remote-channel";

/** The phone end of a relay socket. */
export interface PhoneSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export type PhoneConnect = (hostId: string) => PhoneSocket | Promise<PhoneSocket>;

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

/** A raw `r || s` signature as DER, as an authenticator sends it. */
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

/** A stand-in platform authenticator: a P-256 key, made as WebAuthn Level 3 lays a passkey out. */
export class TestAuthenticator {
  readonly credentialId: Uint8Array<ArrayBuffer>;
  signCount: number;
  #keys: CryptoKeyPair | null = null;

  constructor(credentialByte = 0xc1, signCount = 0) {
    this.credentialId = new Uint8Array(16).fill(credentialByte);
    this.signCount = signCount;
  }

  async #pair(): Promise<CryptoKeyPair> {
    this.#keys ??= (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return this.#keys;
  }

  async #authData(rpId: string, flags: number, count: number, extra: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc(rpId)));
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, count);
    return cat(hash, Uint8Array.of(flags), counter, extra);
  }

  /** `navigator.credentials.create()`'s answer: user present and verified, with the attested ES256 key. */
  async create(rp: RelyingParty, challenge: Uint8Array): Promise<{ credentialId: Uint8Array; clientDataJSON: Uint8Array; authenticatorData: Uint8Array }> {
    const keys = await this.#pair();
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    const cose = Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...raw.slice(1, 33), 0x22, 0x58, 0x20, ...raw.slice(33, 65));
    const attested = cat(new Uint8Array(16), Uint8Array.of(0x00, this.credentialId.length), this.credentialId, cose);
    const clientDataJSON = enc(JSON.stringify({ type: "webauthn.create", challenge: toBase64Url(challenge), origin: rp.origin, crossOrigin: false }));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData: await this.#authData(rp.id, 0x01 | 0x04 | 0x40, this.signCount, attested) };
  }

  /** `navigator.credentials.get()`'s answer over `challenge`. `shape` breaks one part of it, for a refusal test. */
  async get(rp: RelyingParty, challenge: Uint8Array, shape: { origin?: string; flags?: number; signCount?: number } = {}) {
    const keys = await this.#pair();
    if (shape.signCount === undefined && this.signCount > 0) this.signCount += 1;
    const count = shape.signCount ?? this.signCount;
    const clientDataJSON = enc(JSON.stringify({ type: "webauthn.get", challenge: toBase64Url(challenge), origin: shape.origin ?? rp.origin, crossOrigin: false }));
    const authenticatorData = await this.#authData(rp.id, shape.flags ?? 0x01 | 0x04, count, new Uint8Array(0));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, cat(authenticatorData, hash)));
    return { credentialId: this.credentialId, clientDataJSON, authenticatorData, signature: derFromRaw(raw) };
  }
}

/** Waits on a socket's messages in order. */
class Inbox {
  readonly #queue: unknown[] = [];
  readonly #waiting: ((value: unknown) => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  readonly #closeWaiters: ((value: { code: number; reason: string }) => void)[] = [];

  constructor(socket: PhoneSocket) {
    socket.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      const waiter = this.#waiting.shift();
      if (waiter) waiter(data);
      else this.#queue.push(data);
    };
    socket.onclose = (event) => {
      this.closed = { code: event.code, reason: event.reason };
      for (const w of this.#closeWaiters.splice(0)) w(this.closed);
      for (const w of this.#waiting.splice(0)) w(null);
    };
  }

  next(ms = 5_000): Promise<unknown> {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message")), ms);
      this.#waiting.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  whenClosed(ms = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("not closed")), ms);
      this.#closeWaiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

function json(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One open session of the test phone. */
export class PhoneSession {
  readonly socket: PhoneSocket;
  readonly inbox: Inbox;
  readonly channel: Channel;
  readonly #pushed: Record<string, unknown>[] = [];
  #nextId = 1;

  constructor(socket: PhoneSocket, inbox: Inbox, channel: Channel) {
    this.socket = socket;
    this.inbox = inbox;
    this.channel = channel;
  }

  /** Sends any message, as a phone could. */
  async sendRaw(message: Record<string, unknown> | Uint8Array): Promise<void> {
    const bytes = message instanceof Uint8Array ? message : enc(JSON.stringify(message));
    for (const frame of await this.channel.seal(bytes)) this.socket.send(frame);
  }

  /** The next message the Mac sent on this session, opened. */
  async receive(ms = 5_000): Promise<Record<string, unknown> | null> {
    for (;;) {
      const data = await this.inbox.next(ms);
      if (data === null) return null;
      if (!(data instanceof Uint8Array)) continue;
      const opened = await this.channel.open(data);
      if (opened === null) continue;
      return JSON.parse(new TextDecoder().decode(opened)) as Record<string, unknown>;
    }
  }

  /** One request, and the Mac's answer to it; unasked events that arrive first are kept for `pushed`. */
  async request(message: Record<string, unknown>, ms = 5_000): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    await this.sendRaw({ ...message, id });
    for (;;) {
      const reply = await this.receive(ms);
      if (reply === null) throw new Error("closed");
      if (reply.id === id) return reply;
      this.#pushed.push(reply);
    }
  }

  /** Unasked messages received so far, and those waiting now. */
  async pushed(count: number, ms = 5_000): Promise<Record<string, unknown>[]> {
    while (this.#pushed.length < count) {
      const message = await this.receive(ms);
      if (message === null) break;
      this.#pushed.push(message);
    }
    return this.#pushed.splice(0, count);
  }

  close(): void {
    this.channel.close();
    this.socket.close(1000, "closed");
  }
}

export class TestPhone {
  readonly name: string;
  readonly authenticator: TestAuthenticator;
  readonly #connect: PhoneConnect;
  hostId: string | null = null;
  deviceId: string | null = null;
  #token: string | null = null;
  #secret: Uint8Array | null = null;
  rp: RelyingParty | null = null;

  constructor(params: { name: string; connect: PhoneConnect; authenticator?: TestAuthenticator }) {
    this.name = params.name;
    this.#connect = params.connect;
    this.authenticator = params.authenticator ?? new TestAuthenticator();
  }

  /** Dials the relay as `device` with `token` and waits for `ready`. */
  async #dial(hostId: string, device: string, token: string): Promise<{ socket: PhoneSocket; inbox: Inbox }> {
    const socket = await this.#connect(hostId);
    const inbox = new Inbox(socket);
    socket.send(JSON.stringify({ t: "hello", v: 1, device, token }));
    const ready = json(await inbox.next());
    if (ready?.t !== "ready") throw new Error(`relay said ${JSON.stringify(ready)} ${JSON.stringify(inbox.closed)}`);
    return { socket, inbox };
  }

  /** Scans the link, pairs, and shows its four digits to `typeCode` (the person typing them at the Mac). Resolves with
   *  how it ended: `paired`, or the Mac's or the relay's refusal. */
  async pair(link: string, typeCode: (code: string) => Promise<unknown>, options: { rp: RelyingParty; before?: (offer: PairingOffer) => void }): Promise<string> {
    const offer = readPairingLink(link);
    options.before?.(offer);
    const hostId = offer.hostId;
    const doorId = offer.doorId;
    const { socket, inbox } = await this.#dial(hostId, doorId, toBase64Url(offer.doorToken));
    const { commit, phone } = await startPairing(offer);
    socket.send(commit);
    const key = await inbox.next();
    if (!(key instanceof Uint8Array)) return "no key";
    socket.send(await phone.receiveKey(key));
    const confirm = await inbox.next();
    if (!(confirm instanceof Uint8Array)) return "no confirm";
    const { checkCode, channel } = await phone.receiveConfirm(confirm);
    await typeCode(checkCode);
    const session = new PhoneSession(socket, inbox, channel);
    // The grant, then the passkey request.
    let grantBytes: Uint8Array | null = null;
    for (;;) {
      const data = await inbox.next();
      if (!(data instanceof Uint8Array)) return "no grant";
      const opened = await channel.open(data);
      if (opened !== null) {
        grantBytes = opened;
        break;
      }
    }
    const grant = decodePairingGrant(grantBytes);
    const request = await session.receive();
    if (request?.t !== "passkey" || typeof request.challenge !== "string") return "no passkey request";
    this.rp = options.rp;
    const created = await this.authenticator.create(options.rp, fromBase64Url(request.challenge));
    await session.sendRaw({
      t: "registered",
      name: this.name,
      credentialId: toBase64Url(created.credentialId),
      clientDataJSON: toBase64Url(created.clientDataJSON),
      authenticatorData: toBase64Url(created.authenticatorData),
    });
    const outcome = await session.receive();
    channel.close();
    if (outcome?.t === "paired") {
      this.hostId = hostId;
      this.deviceId = grant.deviceId;
      this.#token = toBase64Url(grant.doorToken);
      this.#secret = grant.secret;
      return "paired";
    }
    return typeof outcome?.reason === "string" ? outcome.reason : "closed";
  }

  /** Opens a session with K, through the relay. */
  async connect(): Promise<PhoneSession> {
    if (!this.hostId || !this.deviceId || !this.#token || !this.#secret) throw new Error("not paired");
    const { socket, inbox } = await this.#dial(this.hostId, this.deviceId, this.#token);
    const { hello, phone } = await startSession({ hostId: this.hostId, deviceId: this.deviceId, secret: this.#secret });
    socket.send(hello);
    const welcome = await inbox.next();
    if (!(welcome instanceof Uint8Array)) throw new Error("no welcome");
    const { finish, channel } = await phone.receiveWelcome(welcome);
    socket.send(finish);
    return new PhoneSession(socket, inbox, channel);
  }

  /** Allow once, both steps, with Face ID as the authenticator gives it. `tamper` changes the answer before it is sent. */
  async allow(
    session: PhoneSession,
    params: { chat: string; ask: string; revision: number },
    tamper: (answer: Record<string, unknown>, challenge: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>> = (a) => a,
  ): Promise<Record<string, unknown>> {
    const challenge = await session.request({ t: "allow", ...params });
    if (challenge.t !== "challenge") return challenge;
    if (!this.deviceId || !this.rp) throw new Error("not paired");
    const signed = await decisionChallenge(fromBase64Url(String(challenge.nonce)), {
      deviceId: this.deviceId,
      requestId: JSON.stringify([params.chat, params.ask]),
      revision: params.revision,
      optionId: "once",
    });
    const passkey = await this.authenticator.get(this.rp, signed);
    const answer = {
      challengeId: String(challenge.nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    };
    return session.request({ t: "allow", ...params, option: "once", answer: await tamper(answer, challenge) });
  }

  /** The secrets this phone holds, for a test that scans the relay's frames for them. */
  secrets(): { token: string | null; secret: Uint8Array | null } {
    return { token: this.#token, secret: this.#secret };
  }
}
