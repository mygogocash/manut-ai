// A relay in memory for the desktop's tests: the parts of `apps/api/src/relay-object.ts` the Mac and a phone meet (the
// challenge and the signed hello, `ready` with the registered devices, `device`, `revoke`, `status`, `close`, the phone's
// token check and its stream, the four-byte stream number on the Mac's frames, the keepalive), with every message it
// carried kept for a test to read. The API's tests run the same Mac and phone against the real relay object; this one
// exists so the desktop's tests can also turn the relay off, cut it, and look at each message without workerd.
import type { RelaySocket, SocketFactory } from "../link";
import type { PhoneSocket } from "./phone";

export interface Carried {
  readonly from: "mac" | "phone" | "relay";
  readonly to: "mac" | "phone";
  readonly data: string | Uint8Array;
}

const b64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const unb64url = (text: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const later = (run: () => void) => void Promise.resolve().then(run);

class MacEnd implements RelaySocket {
  binaryType = "blob";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  open = true;
  authed = false;
  nonce = "";

  constructor(
    readonly relay: FakeRelay,
    readonly hostId: string,
  ) {}

  send(data: string | Uint8Array): void {
    if (!this.open) return;
    const copy = typeof data === "string" ? data : data.slice();
    this.relay.carried.push({ from: "mac", to: "phone", data: copy });
    later(() => void this.relay.fromMac(this, copy));
  }

  close(code = 1000, reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.relay.macClosed(this, code, reason);
  }

  deliver(data: string | Uint8Array): void {
    if (!this.open) return;
    this.relay.carried.push({ from: "relay", to: "mac", data });
    later(() => this.onmessage?.({ data: typeof data === "string" ? data : data.slice().buffer }));
  }

  shut(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    later(() => this.onclose?.({ code, reason }));
  }
}

class PhoneEnd implements PhoneSocket {
  onmessage: PhoneSocket["onmessage"] = null;
  onclose: PhoneSocket["onclose"] = null;
  open = true;
  device: string | null = null;
  stream = 0;

  constructor(readonly relay: FakeRelay) {}

  send(data: string | Uint8Array): void {
    if (!this.open) return;
    const copy = typeof data === "string" ? data : data.slice();
    this.relay.carried.push({ from: "phone", to: "mac", data: copy });
    later(() => void this.relay.fromPhone(this, copy));
  }

  close(code = 1000, reason = ""): void {
    if (!this.open) return;
    this.open = false;
    this.relay.phoneClosed(this, code, reason);
  }

  deliver(data: string | Uint8Array): void {
    if (!this.open) return;
    if (typeof data === "string") this.relay.carried.push({ from: "relay", to: "phone", data });
    later(() => this.onmessage?.({ data: typeof data === "string" ? data : data.slice().buffer }));
  }

  shut(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    later(() => this.onclose?.({ code, reason }));
  }
}

export class FakeRelay {
  /** Every message carried, in order. */
  readonly carried: Carried[] = [];
  /** Registered devices and their token hashes, as the relay's storage holds them. */
  readonly devices = new Map<string, string>();
  /** The Mac's text messages after its hello, parsed. */
  readonly fromMacText: Record<string, unknown>[] = [];
  readonly urls: string[] = [];
  enabled = true;
  reachable = true;
  presence: string | null = null;
  #mac: MacEnd | null = null;
  #phones = new Set<PhoneEnd>();
  #nextStream = 7;

  /** The Mac's socket factory. */
  readonly connectMac: SocketFactory = (url) => {
    this.urls.push(url);
    const hostId = /\/relay\/v1\/hosts\/([^/]+)\/socket$/.exec(url)?.[1] ?? "";
    const socket = new MacEnd(this, hostId);
    if (!this.reachable || !this.enabled) {
      // A refused upgrade or a dropped network reaches a page only as a close with no reason.
      socket.shut(1006, "");
      return socket;
    }
    socket.nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    socket.deliver(JSON.stringify({ t: "challenge", v: 1, nonce: socket.nonce }));
    return socket;
  };

  /** A phone's socket. */
  readonly connectPhone = (_hostId: string): PhoneSocket => {
    const phone = new PhoneEnd(this);
    if (!this.reachable || !this.enabled) phone.shut(1006, "");
    else this.#phones.add(phone);
    return phone;
  };

  get macConnected(): boolean {
    return !!this.#mac?.open && this.#mac.authed;
  }

  /** How many phones have a stream open. */
  get openPhones(): number {
    return [...this.#phones].filter((p) => p.open && p.device !== null).length;
  }

  /** Cuts the network: every socket drops with no reason. */
  cut(): void {
    this.#mac?.shut(1006, "");
    this.#mac = null;
    for (const phone of this.#phones) phone.shut(1006, "");
    this.#phones.clear();
  }

  /** The relay switched off under open sockets (4503). */
  switchOff(): void {
    this.enabled = false;
    this.#mac?.shut(4503, "disabled");
    this.#mac = null;
    for (const phone of this.#phones) phone.shut(4503, "disabled");
    this.#phones.clear();
  }

  async fromMac(socket: MacEnd, data: string | Uint8Array): Promise<void> {
    if (!socket.open) return;
    if (!socket.authed) {
      const hello = typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : null;
      const ok = hello?.t === "hello" && typeof hello.key === "string" && typeof hello.sig === "string" && (await this.#verify(socket.hostId, socket.nonce, hello.key, hello.sig));
      if (!ok) return socket.shut(4401, "unauthenticated");
      this.#mac?.shut(4409, "replaced");
      socket.authed = true;
      this.#mac = socket;
      socket.deliver(JSON.stringify({ t: "ready", v: 1, devices: [...this.devices.keys()] }));
      return;
    }
    if (typeof data === "string") {
      if (data === "ping") return socket.deliver("pong");
      const message = JSON.parse(data) as Record<string, unknown>;
      this.fromMacText.push(message);
      if (message.t === "device" && typeof message.id === "string" && typeof message.tokenHash === "string") {
        const known = this.devices.get(message.id);
        this.devices.set(message.id, message.tokenHash);
        if (known !== undefined && known !== message.tokenHash) this.#endDevice(message.id, 4403, "revoked");
      } else if (message.t === "revoke" && typeof message.id === "string") {
        this.devices.delete(message.id);
        this.#endDevice(message.id, 4403, "revoked");
      } else if (message.t === "status" && typeof message.state === "string") {
        this.presence = message.state;
      } else if (message.t === "close" && typeof message.stream === "number") {
        for (const phone of this.#phones) if (phone.stream === message.stream) phone.shut(1000, "closed");
      }
      return;
    }
    const stream = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    for (const phone of this.#phones) if (phone.open && phone.stream === stream && phone.device !== null) phone.deliver(data.slice(4));
  }

  async fromPhone(phone: PhoneEnd, data: string | Uint8Array): Promise<void> {
    if (!phone.open) return;
    if (phone.device === null) {
      const hello = typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : null;
      const device = typeof hello?.device === "string" ? hello.device : "";
      const token = typeof hello?.token === "string" ? hello.token : "";
      const registered = this.devices.get(device);
      const hash = token ? b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", unb64url(token)))) : "";
      if (registered === undefined || registered !== hash) return phone.shut(4401, "unauthenticated");
      const mac = this.#mac;
      if (!mac?.open) return phone.shut(4404, "unavailable");
      // One socket a device: the older one goes, as the relay does.
      this.#endDevice(device, 4409, "replaced");
      phone.device = device;
      phone.stream = this.#nextStream++;
      mac.deliver(JSON.stringify({ t: "open", v: 1, stream: phone.stream, device }));
      phone.deliver(JSON.stringify({ t: "ready", v: 1 }));
      return;
    }
    if (typeof data === "string") return phone.shut(4400, "closed");
    const frame = new Uint8Array(4 + data.length);
    new DataView(frame.buffer).setUint32(0, phone.stream);
    frame.set(data, 4);
    this.#mac?.deliver(frame);
  }

  macClosed(socket: MacEnd, _code: number, _reason: string): void {
    if (this.#mac !== socket) return;
    this.#mac = null;
    for (const phone of this.#phones) if (phone.device !== null) phone.shut(4404, "unavailable");
  }

  phoneClosed(phone: PhoneEnd, _code: number, _reason: string): void {
    this.#phones.delete(phone);
    if (phone.device !== null) this.#mac?.deliver(JSON.stringify({ t: "close", v: 1, stream: phone.stream, reason: "closed" }));
  }

  #endDevice(device: string, code: number, reason: string): void {
    for (const phone of this.#phones) {
      if (phone.device !== device || !phone.open) continue;
      this.#mac?.deliver(JSON.stringify({ t: "close", v: 1, stream: phone.stream, reason }));
      this.#phones.delete(phone);
      phone.shut(code, reason);
    }
  }

  async #verify(hostId: string, nonce: string, key: string, sig: string): Promise<boolean> {
    try {
      const keyBytes = unb64url(key);
      if (b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes))) !== hostId) return false;
      const publicKey = await crypto.subtle.importKey("raw", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, unb64url(sig), new TextEncoder().encode(`gospark-relay-v1|host|${hostId}|${nonce}`));
    } catch {
      return false;
    }
  }
}
