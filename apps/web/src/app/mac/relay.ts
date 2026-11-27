/// The phone's socket to the relay (docs/relay-protocol-v1.md, section 6), the same relay the Mac's link dials
/// (apps/desktop/src/remote/link.ts). The phone opens `/relay/v1/hosts/<hostID>/phone` on this page's own origin, says
/// `hello` with a device id and that device's door token, and waits for `ready`. After `ready` it carries only binary
/// frames, which are the channel's records (`@manut/remote-channel`): the relay cannot read them, and neither does this
/// file. The text `ping` keeps an idle socket open, and the relay's `pong` is skipped.
///
/// Who the phone is, and the token, are the relay's door only: the Mac takes who is speaking from the channel's own
/// handshake, never from this hello (the package's README, "What the callers must do").
///
/// Every way the relay can turn a phone away is read into one of a few reasons, which the tab says in words:
///   4401  the door does not know this device or token: a code that expired or was used, or a phone the Mac forgot
///   4403  the Mac revoked this device (Unpair)
///   4404  the Mac cannot take a phone now; the `host` message just before says why (offline, paused, sleeping, off)
///   4409  another socket took this device's place: another copy of this phone
///   4429  the relay's limits or today's budget
///   4503  the relay was switched off
/// and anything else, a dropped network included, is `lost`.

/// What a socket must be for the phone: the browser's `WebSocket`, or a test's stand-in.
export interface PhoneSocket {
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export type PhoneConnect = (url: string) => PhoneSocket;

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/// The browser's own socket as a `PhoneSocket`: what is sent before it opens waits for it, as the relay expects the
/// `hello` first, and frames arrive as bytes.
export const browserConnect: PhoneConnect = (url) => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const waiting: (string | Uint8Array)[] = [];
  const socket: PhoneSocket = {
    onmessage: null,
    onclose: null,
    send(data) {
      if (ws.readyState === WebSocket.CONNECTING) waiting.push(data);
      else ws.send(data as string | Uint8Array<ArrayBuffer>);
    },
    close(code, reason) {
      ws.close(code ?? 1000, reason ?? "");
    },
  };
  ws.onopen = () => {
    for (const data of waiting.splice(0)) ws.send(data as string | Uint8Array<ArrayBuffer>);
  };
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = (event) => socket.onclose?.({ code: event.code, reason: event.reason });
  return socket;
};

/// Why a socket ended, or never opened.
export type RelayEnd =
  | { readonly why: "unknown_door" }
  | { readonly why: "revoked" }
  | { readonly why: "mac_away"; readonly state: "offline" | "paused" | "sleeping" | "off" }
  | { readonly why: "replaced" }
  | { readonly why: "busy" }
  | { readonly why: "relay_off" }
  | { readonly why: "closed" }
  | { readonly why: "lost" };

/// How long the relay gives a socket to say `hello` is 10 seconds; the phone waits a little longer for `ready`.
export const READY_MS = 12_000;
/// The phone's own keepalive: shorter than the Mac's 50 seconds, because a phone's network drops idle sockets sooner.
export const PING_MS = 30_000;

const HOST_ID = /^[A-Za-z0-9_-]{43}$/;

/// The relay's phone address on this page's origin: `wss://` for https, and `ws://` only for this machine during
/// development. Anything else has no relay this page may reach, and is null.
export function relayUrl(origin: string, hostId: string): string | null {
  if (!HOST_ID.test(hostId)) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const path = `/relay/v1/hosts/${hostId}/phone`;
  if (url.protocol === "https:") return `wss://${url.host}${path}`;
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return `ws://${url.host}${path}`;
  return null;
}

/// The one port the Mac's door has, and the only one this page's content policy lets a socket reach over a tailnet.
export const TAILNET_PORT = 47100;

/// A Mac's name on a tailnet as the desktop reads it (tailscale.rs `name_ok`): lowercase DNS labels of 1 to 63 letters,
/// digits and hyphens, none starting or ending with one, at most 253 characters, under ts.net with a label of its own.
export function tailnetNameOk(name: string): boolean {
  const labels = name.split(".");
  return name.length <= 253 && name.endsWith(".ts.net") && labels.length >= 3 && labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/// The Mac's own door over the tailnet (item 78f-2c): the same phone route as the relay's, at the Mac's tailnet name and
/// its door's one port, `wss` only. Null for a name or port this page does not take.
export function tailnetUrl(road: { name: string; port: number }, hostId: string): string | null {
  if (!HOST_ID.test(hostId) || !tailnetNameOk(road.name) || road.port !== TAILNET_PORT) return null;
  return `wss://${road.name}:${road.port}/relay/v1/hosts/${hostId}/phone`;
}

/// The reason a close code gives, with the `host` message that came before a 4404, if any.
export function endOf(code: number, host: string | null): RelayEnd {
  switch (code) {
    case 4401:
      return { why: "unknown_door" };
    case 4403:
      return { why: "revoked" };
    case 4404:
      return { why: "mac_away", state: host === "paused" || host === "sleeping" || host === "off" ? host : "offline" };
    case 4409:
      return { why: "replaced" };
    case 4429:
      return { why: "busy" };
    case 4503:
      return { why: "relay_off" };
    case 1000:
      return { why: "closed" };
    default:
      return { why: "lost" };
  }
}

/// One open relay socket, after `ready`: its binary frames in order, waited on one at a time, and how it ended.
export class RelayPipe {
  readonly #socket: PhoneSocket;
  readonly #timers: Timers;
  readonly #queue: Uint8Array[] = [];
  readonly #waiting: { resolve: (frame: Uint8Array | null) => void; timer: unknown }[] = [];
  #ping: unknown = null;
  #ended: RelayEnd | null = null;
  #host: string | null = null;
  /// Told once, when the socket ends for any reason after `ready`.
  onEnd: ((end: RelayEnd) => void) | null = null;
  /// When set, each frame goes here instead of the queue.
  #reader: ((frame: Uint8Array) => void) | null = null;

  constructor(socket: PhoneSocket, timers: Timers) {
    this.#socket = socket;
    this.#timers = timers;
  }

  get ended(): RelayEnd | null {
    return this.#ended;
  }

  /// Hands every frame, those queued first, to `reader` as it arrives.
  read(reader: (frame: Uint8Array) => void): void {
    this.#reader = reader;
    for (const frame of this.#queue.splice(0)) reader(frame);
  }

  /// The next frame, or null once the socket ended or `ms` passed with none.
  next(ms: number): Promise<Uint8Array | null> {
    const frame = this.#queue.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: this.#timers.set(() => {
          const at = this.#waiting.indexOf(entry);
          if (at !== -1) this.#waiting.splice(at, 1);
          resolve(null);
        }, ms),
      };
      this.#waiting.push(entry);
    });
  }

  send(frame: Uint8Array): void {
    if (this.#ended) return;
    try {
      this.#socket.send(frame);
    } catch {
      this.#end(endOf(1006, null));
    }
  }

  close(): void {
    if (this.#ended) return;
    this.#end({ why: "closed" });
    try {
      this.#socket.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }

  /// Wires the socket after `ready`. Called once by `dialRelay`.
  start(): void {
    this.#socket.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      if (typeof data === "string") {
        // After `ready` the relay sends only frames, `pong`, and one `host` just before a 4404 (section 8).
        if (data === "pong") return;
        try {
          const message = JSON.parse(data) as { t?: unknown; state?: unknown };
          if (message.t === "host" && typeof message.state === "string") this.#host = message.state;
        } catch {
          // Nothing else is read.
        }
        return;
      }
      if (!(data instanceof Uint8Array)) return;
      if (this.#reader) return this.#reader(data);
      const waiter = this.#waiting.shift();
      if (waiter) {
        this.#timers.clear(waiter.timer);
        waiter.resolve(data);
      } else this.#queue.push(data);
    };
    this.#socket.onclose = (event) => this.#end(endOf(event.code, this.#host));
    this.#ping = this.#timers.set(() => this.#keepAlive(), PING_MS);
  }

  #keepAlive(): void {
    if (this.#ended) return;
    try {
      this.#socket.send("ping");
    } catch {
      // The close that follows says what happened.
    }
    this.#ping = this.#timers.set(() => this.#keepAlive(), PING_MS);
  }

  #end(end: RelayEnd): void {
    if (this.#ended) return;
    this.#ended = end;
    if (this.#ping !== null) this.#timers.clear(this.#ping);
    for (const waiter of this.#waiting.splice(0)) {
      this.#timers.clear(waiter.timer);
      waiter.resolve(null);
    }
    this.onEnd?.(end);
  }
}

/// Opens the relay's door for `device` with its `token` (base64url), and resolves once the relay says `ready`, or with
/// why it did not.
export function dialRelay(params: {
  connect: PhoneConnect;
  url: string;
  device: string;
  token: string;
  timers?: Timers;
}): Promise<{ ok: true; pipe: RelayPipe } | { ok: false; end: RelayEnd }> {
  const timers = params.timers ?? systemTimers;
  return new Promise((resolve) => {
    let socket: PhoneSocket;
    try {
      socket = params.connect(params.url);
    } catch {
      resolve({ ok: false, end: { why: "lost" } });
      return;
    }
    socket.binaryType = "arraybuffer";
    let settled = false;
    let host: string | null = null;
    const early: Uint8Array[] = [];
    const finish = (result: { ok: true; pipe: RelayPipe } | { ok: false; end: RelayEnd }) => {
      if (settled) return;
      settled = true;
      timers.clear(timer);
      resolve(result);
    };
    const timer = timers.set(() => {
      try {
        socket.close(1000, "closed");
      } catch {
        // Already closed.
      }
      finish({ ok: false, end: { why: "lost" } });
    }, READY_MS);
    socket.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
      if (data instanceof Uint8Array) {
        // The relay forwards nothing before `ready`; a frame here would be the Mac's, so it waits its turn.
        early.push(data);
        return;
      }
      if (typeof data !== "string" || data === "pong") return;
      let message: { t?: unknown; state?: unknown };
      try {
        message = JSON.parse(data) as { t?: unknown; state?: unknown };
      } catch {
        return;
      }
      if (message.t === "host" && typeof message.state === "string") host = message.state;
      if (message.t === "ready") {
        const pipe = new RelayPipe(socket, timers);
        pipe.start();
        for (const frame of early) socket.onmessage?.({ data: frame });
        finish({ ok: true, pipe });
      }
    };
    socket.onclose = (event) => finish({ ok: false, end: endOf(event.code, host) });
    socket.onerror = () => undefined;
    try {
      socket.send(JSON.stringify({ t: "hello", v: 1, device: params.device, token: params.token }));
    } catch {
      finish({ ok: false, end: { why: "lost" } });
    }
  });
}
