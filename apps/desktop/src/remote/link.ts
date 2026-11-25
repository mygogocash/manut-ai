// The Mac's one socket to the relay (docs/remote-access.md, "The architecture"; docs/relay-protocol-v1.md, sections 5 to
// 11). It dials `/relay/v1/hosts/<hostID>/socket` on the API origin the app is already connected to, signs the relay's
// challenge with the Mac's relay key as `apps/api/test/fixtures/relay-v1-vectors.json` pins it, and then carries three
// things only: the Mac's own messages (`device`, `revoke`, `status`, `close`), the relay's (`open`, `close`, `error`), and
// binary stream frames, whose first four bytes are the stream number. It reads no frame: the channel inside each one is
// the package's (`@manut/remote-channel`), and the relay cannot read it either.
//
// It keeps the socket up: a ping every 50 seconds (the relay answers it without waking, section 11), and after a drop a
// wait that doubles from one second up to 60. While the relay answers that it is switched off (`RELAY_ENABLED`, a 503
// `relay_disabled`, or a socket closed with 4503), it says so and tries again only every 15 minutes, so a Mac whose
// relay is not on yet costs nothing.
//
// Which devices the relay lets in is the Mac's to say, and the Mac says it again at every `ready`: each paired phone and
// any open pairing door is registered (the relay ignores a hash it already holds), and every device the relay lists that
// the Mac no longer has is revoked. That is how Unpair works while the relay cannot be reached: the Mac forgets the phone
// at once, and the relay hears `revoke` the next time the socket is up.
//
// Nothing here touches the DOM, the store or the shell, so the API's tests run it against the real relay object in
// workerd, and the desktop's tests against a fake socket.

/** What a socket needs to be for the link: the page's `WebSocket`, or a test's stand-in. */
export interface RelaySocket {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => RelaySocket;

/** The Mac's relay key: its host id (the SHA-256 of the public key, base64url), the public key the relay hashes to it,
 *  and a signature with the private half, which script cannot read back (identity.ts). */
export interface HostIdentity {
  readonly hostId: string;
  /** The uncompressed P-256 public key (X9.63), base64url. */
  readonly publicKey: string;
  /** A raw P-256 ECDSA signature over `message` (UTF-8), base64url, as the relay verifies it. */
  sign(message: string): Promise<string>;
}

/** Whether the relay is switched on, asked without a socket: `off` for its 503 `relay_disabled`. The page asks through the
 *  shell, because its content policy lets it open sockets to the API origin but send it no plain request. */
export type RelayProbe = () => Promise<"off" | "on" | "unknown">;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Where the link stands, for the Settings page: not started, dialling, up, waiting to dial again, or the relay switched
 *  off or out of today's budget (`unavailable`, "not available yet"). */
export type LinkState = "stopped" | "connecting" | "ready" | "waiting" | "unavailable";

export type RelayPresence = "available" | "paused" | "sleeping" | "off";

export interface LinkEvents {
  /** The relay opened a stream for a phone. `device` is the relay's word for who it is, which proves nothing: the Mac
   *  takes who is speaking only from the channel's own handshake. */
  onOpen(stream: number, device: string): void;
  /** One binary frame on a stream, without its stream number. */
  onFrame(stream: number, payload: Uint8Array): void;
  /** The relay ended a stream, or the socket went down with every stream on it. */
  onClose(stream: number, reason: string): void;
  onState(state: LinkState): void;
}

/** The relay's own messages and limits (docs/relay-protocol-v1.md; `apps/api/src/relay-object.ts`). */
export const PING_MS = 50_000;
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 60_000;
/** How often a Mac whose relay is switched off, or out of today's budget, tries again. */
export const OFF_RETRY_MS = 15 * 60_000;
/** A Mac socket that is not through its hello within this is closed by the relay (`RelayObject.authTimeoutMs`); the
 *  link gives up a little later on its own, so a socket that never answered does not hang it. */
export const HELLO_TIMEOUT_MS = 15_000;
const STREAM_HEADER_BYTES = 4;
const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const CLOSE = { unauthenticated: 4401, replaced: 4409, overBudget: 4429, disabled: 4503 } as const;

/** The relay's socket address for `hostId` on the API at `origin`, or null where the page may open no socket. The packaged
 *  app's `connect-src` names `wss://manut.xyz` and `wss://*.manut.xyz` at the default port, as for the feed
 *  (`runtime/http/feed.ts`); `wrangler dev` on this computer is the one plain address taken, for development. */
export function relaySocketUrl(origin: string, hostId: string): string | null {
  if (!DIGEST.test(hostId)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = `/relay/v1/hosts/${hostId}/socket`;
  if (url.protocol === "https:" && (host === "manut.xyz" || host.endsWith(".manut.xyz")) && url.port === "") return `wss://${host}${path}`;
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return `ws://${url.host}${path}`;
  return null;
}

/** The same route as plain https, for the probe that asks whether the relay is on. */
export function relayProbeUrl(socketUrl: string): string {
  return socketUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function readJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isStream = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

/** The string the Mac signs for the relay's challenge, exactly as `verifyHostHello` in `apps/api/src/relay.ts` checks it. */
export function challengeMessage(hostId: string, nonce: string): string {
  return `gospark-relay-v1|host|${hostId}|${nonce}`;
}

export class RelayLink {
  readonly #url: string;
  readonly #identity: HostIdentity;
  readonly #connect: SocketFactory;
  readonly #probe: RelayProbe;
  readonly #timers: Timers;
  readonly #events: LinkEvents;
  /** Every device the relay should let in, with its token hash: the paired phones and an open pairing door. */
  readonly #wanted = new Map<string, string>();
  readonly #streams = new Set<number>();
  #socket: RelaySocket | null = null;
  #state: LinkState = "stopped";
  #running = false;
  #ready = false;
  #failures = 0;
  #retry: unknown = null;
  #ping: unknown = null;
  #helloTimer: unknown = null;
  #presence: { state: RelayPresence; at: number } | null = null;

  constructor(params: { url: string; identity: HostIdentity; connect: SocketFactory; probe: RelayProbe; events: LinkEvents; timers?: Timers }) {
    this.#url = params.url;
    this.#identity = params.identity;
    this.#connect = params.connect;
    this.#probe = params.probe;
    this.#events = params.events;
    this.#timers = params.timers ?? systemTimers;
  }

  get state(): LinkState {
    return this.#state;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  /** Starts dialling, and keeps the socket up until `stop`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#failures = 0;
    this.#dial();
  }

  /** Closes the socket for good and ends every stream on it. Nothing is dialled again until `start`. */
  stop(): void {
    this.#running = false;
    this.#clearTimers();
    this.#drop(1000, "stopped");
    this.#setState("stopped");
  }

  /** Lets `id` in with the token whose hash this is: sent now while the socket is up, and again at every `ready`. */
  allowDevice(id: string, tokenHash: string): void {
    if (!DEVICE_ID.test(id) || !DIGEST.test(tokenHash)) throw new Error("not a device");
    this.#wanted.set(id, tokenHash);
    if (this.#ready) this.#sendJson({ t: "device", v: 1, id, tokenHash });
  }

  /** Shuts `id` out: `revoke` now while the socket is up; otherwise the next `ready` revokes it, since the relay will still
   *  list it then and the Mac no longer wants it. */
  revokeDevice(id: string): void {
    if (!DEVICE_ID.test(id)) return;
    this.#wanted.delete(id);
    if (this.#ready) this.#sendJson({ t: "revoke", v: 1, id });
  }

  /** The Mac's presence, kept and sent again at every `ready`. */
  setPresence(state: RelayPresence, at: number): void {
    this.#presence = { state, at: Math.floor(at) };
    if (this.#ready) this.#sendJson({ t: "status", v: 1, state, at: this.#presence.at });
  }

  /** Sends one frame to the phone on `stream`. Dropped while the stream is not open on this socket. */
  sendFrame(stream: number, payload: Uint8Array): boolean {
    if (!this.#ready || !this.#streams.has(stream) || this.#socket === null) return false;
    const frame = new Uint8Array(STREAM_HEADER_BYTES + payload.length);
    new DataView(frame.buffer).setUint32(0, stream);
    frame.set(payload, STREAM_HEADER_BYTES);
    this.#socket.send(frame);
    return true;
  }

  /** Ends one stream: the relay closes that phone's socket, and nothing comes back for it. */
  closeStream(stream: number): void {
    if (!this.#streams.delete(stream)) return;
    if (this.#ready) this.#sendJson({ t: "close", v: 1, stream });
  }

  #setState(state: LinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#events.onState(state);
  }

  #sendJson(message: Record<string, unknown>): void {
    this.#socket?.send(JSON.stringify(message));
  }

  #clearTimers(): void {
    for (const handle of [this.#retry, this.#ping, this.#helloTimer]) if (handle !== null) this.#timers.clear(handle);
    this.#retry = null;
    this.#ping = null;
    this.#helloTimer = null;
  }

  /** Forgets the socket and every stream on it, telling the host each stream ended. */
  #drop(code: number, reason: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#ready = false;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closed.
      }
    }
    const streams = [...this.#streams];
    this.#streams.clear();
    for (const stream of streams) this.#events.onClose(stream, reason);
  }

  #dial(): void {
    if (!this.#running || this.#socket !== null) return;
    this.#setState("connecting");
    let socket: RelaySocket;
    try {
      socket = this.#connect(this.#url);
    } catch {
      this.#afterFailure(null);
      return;
    }
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    // Before `ready` the relay sends its challenge, and then `ready` once the hello holds; anything else, or the two out
    // of order, is not this relay, and the socket is dropped.
    let helloSent = false;
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      const data = event.data;
      if (!this.#ready) {
        const message = typeof data === "string" ? readJson(data) : null;
        if (!helloSent) {
          if (message?.t !== "challenge" || message.v !== 1 || typeof message.nonce !== "string" || !DIGEST.test(message.nonce)) {
            return this.#fail(socket, null);
          }
          helloSent = true;
          void this.#hello(socket, message.nonce);
          return;
        }
        const devices = message?.devices;
        if (message?.t !== "ready" || message.v !== 1 || !Array.isArray(devices)) return this.#fail(socket, null);
        return this.#onReady(devices.filter((d): d is string => typeof d === "string" && DEVICE_ID.test(d)));
      }
      if (typeof data === "string") return this.#relayMessage(data);
      if (data instanceof ArrayBuffer) return this.#frame(new Uint8Array(data));
      if (ArrayBuffer.isView(data)) return this.#frame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#afterFailure(event.code);
    };
    socket.onerror = () => {
      // A close always follows; the wait starts there.
    };
    this.#helloTimer = this.#timers.set(() => {
      this.#helloTimer = null;
      if (this.#socket === socket && !this.#ready) this.#fail(socket, null);
    }, HELLO_TIMEOUT_MS);
  }

  async #hello(socket: RelaySocket, nonce: string): Promise<void> {
    let sig: string;
    try {
      sig = await this.#identity.sign(challengeMessage(this.#identity.hostId, nonce));
    } catch {
      return this.#fail(socket, null);
    }
    if (this.#socket !== socket) return;
    socket.send(JSON.stringify({ t: "hello", v: 1, key: this.#identity.publicKey, sig }));
  }

  #onReady(listed: string[]): void {
    if (this.#helloTimer !== null) this.#timers.clear(this.#helloTimer);
    this.#helloTimer = null;
    this.#ready = true;
    this.#failures = 0;
    for (const [id, tokenHash] of this.#wanted) this.#sendJson({ t: "device", v: 1, id, tokenHash });
    for (const id of listed) if (!this.#wanted.has(id)) this.#sendJson({ t: "revoke", v: 1, id });
    if (this.#presence) this.#sendJson({ t: "status", v: 1, ...this.#presence });
    this.#ping = this.#timers.set(() => this.#pingNow(), PING_MS);
    this.#setState("ready");
  }

  #pingNow(): void {
    this.#ping = null;
    if (!this.#ready || this.#socket === null) return;
    this.#socket.send("ping");
    this.#ping = this.#timers.set(() => this.#pingNow(), PING_MS);
  }

  #relayMessage(text: string): void {
    if (text === "pong") return;
    const message = readJson(text);
    if (message?.v !== 1) return;
    if (message.t === "open" && isStream(message.stream) && typeof message.device === "string" && DEVICE_ID.test(message.device)) {
      this.#streams.add(message.stream);
      this.#events.onOpen(message.stream, message.device);
    } else if (message.t === "close" && isStream(message.stream)) {
      if (this.#streams.delete(message.stream)) this.#events.onClose(message.stream, typeof message.reason === "string" ? message.reason : "closed");
    }
    // `error` (`device_limit`) and anything newer are not acted on: the Mac keeps at most seven phones and a door.
  }

  #frame(bytes: Uint8Array): void {
    if (bytes.length < STREAM_HEADER_BYTES) return;
    const stream = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (!this.#streams.has(stream)) return;
    this.#events.onFrame(stream, bytes.slice(STREAM_HEADER_BYTES));
  }

  #fail(socket: RelaySocket, code: number | null): void {
    if (this.#socket !== socket) return;
    this.#afterFailure(code);
  }

  /** The socket is gone, or never came up: forget it, and dial again after the right wait. */
  #afterFailure(code: number | null): void {
    const wasReady = this.#ready;
    this.#clearTimers();
    this.#drop(1000, "closed");
    if (!this.#running) return;
    if (code === CLOSE.disabled || code === CLOSE.overBudget) return this.#waitOff();
    if (code === CLOSE.replaced) {
      // Another copy of this Mac's key took the relay. Trying at once would take it back and forth, so wait the longest.
      this.#failures = Math.max(this.#failures, 6);
    }
    if (!wasReady) {
      // A socket that never came up may be a relay that is switched off: the upgrade's 503 cannot be read from a socket,
      // so it is asked for in plain words before dialling fast again.
      void this.#probe().then(
        (answer) => (answer === "off" ? this.#waitOff() : this.#waitRetry()),
        () => this.#waitRetry(),
      );
      return;
    }
    this.#waitRetry();
  }

  #waitRetry(): void {
    if (!this.#running || this.#socket !== null || this.#retry !== null) return;
    const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** this.#failures);
    this.#failures = Math.min(this.#failures + 1, 16);
    this.#setState("waiting");
    this.#retry = this.#timers.set(() => {
      this.#retry = null;
      this.#dial();
    }, wait);
  }

  #waitOff(): void {
    if (!this.#running || this.#socket !== null || this.#retry !== null) return;
    this.#setState("unavailable");
    this.#retry = this.#timers.set(() => {
      this.#retry = null;
      this.#dial();
    }, OFF_RETRY_MS);
  }
}
