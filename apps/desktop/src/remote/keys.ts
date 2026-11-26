// What the Mac keeps for reaching it from a phone, and how the page holds it (docs/remote-access.md, "The architecture").
//
// One keychain item (service `xyz.manut.desktop.api`, account `remote`), read and written only by the shell's
// `remote_keys.rs`, holds a small JSON document: the Mac's relay key (a P-256 key whose public half hashes to the host id
// the relay names the Mac by), and for each paired phone its name, when it paired and was last seen, K (the secret its
// sessions are proved with), the hash of its relay door token and its passkey (credential id, public key, counter). The
// shell checks every field's form and refuses a second phone with the same passkey, so a page with a bug cannot write a
// document it would later misread.
//
// The page imports the relay key and each K at once as keys script cannot read back (`extractable: false`), as it does
// the shop cache's key (`runtime/http/seal.ts`), and zeroes the bytes they came in, best effort. From then on it holds
// only those keys and the plain parts (names, times, hashes, passkey public keys). Nothing here is ever made while
// "Reach this Mac from your phone" is off: `HostKeys.load(keyring, false)` reads only.
import { type StoredPasskey, fromBase64Url, fromHex, importSharedSecret, toBase64Url, toHex } from "@manut/remote-channel";
import type { HostIdentity } from "./link";

/** The Mac's relay key as the keychain holds it: the JWK's three fields, each 43 base64url characters. */
export interface HostKeyJwk {
  readonly d: string;
  readonly x: string;
  readonly y: string;
}

/** One paired phone as the keychain holds it. `k` is 64 lowercase hex digits; the rest is not secret. */
export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeen: number | null;
  readonly k: string;
  readonly tokenHash: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly signCount: number;
}

export interface KeyDoc {
  readonly v: 1;
  readonly host: HostKeyJwk | null;
  readonly devices: readonly DeviceRecord[];
}

/** The shell's five commands on the `remote` item (remote_keys.rs); tests hand in `memoryKeyring`. */
export interface Keyring {
  read(): Promise<KeyDoc | null>;
  /** Refused when a key is already held, so a race can never replace the key the relay knows the Mac by. */
  setHost(host: HostKeyJwk): Promise<void>;
  /** Refused for an id or a passkey already held, or past the most phones. */
  addDevice(device: DeviceRecord): Promise<void>;
  /** Only the times and the counter, which may not go down. */
  touchDevice(id: string, lastSeen: number, signCount: number): Promise<void>;
  removeDevice(id: string): Promise<void>;
}

/** The most phones one Mac pairs. The relay keeps eight devices a Mac (`MAX_DEVICES` in relay-object.ts), and one place is
 *  kept for the pairing door, so pairing never fails on the relay's limit. */
export const MAX_PHONES = 7;
/** The longest phone name kept, in characters. */
export const MAX_NAME = 64;

const B64_43 = /^[A-Za-z0-9_-]{43}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/** A phone's own name, as the Mac keeps and shows it: no control characters, spaces folded, at most `MAX_NAME`. */
export function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return [...name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_NAME).join("").trim();
}

/** A record the shell would take, checked the same way it checks it, so a bad one fails in the page first. */
export function isDeviceRecord(d: DeviceRecord): boolean {
  return (
    DEVICE_ID.test(d.id) &&
    cleanName(d.name) === d.name &&
    d.name.length > 0 &&
    Number.isSafeInteger(d.pairedAt) &&
    d.pairedAt >= 0 &&
    (d.lastSeen === null || (Number.isSafeInteger(d.lastSeen) && d.lastSeen >= 0)) &&
    HEX_64.test(d.k) &&
    B64_43.test(d.tokenHash) &&
    /^[A-Za-z0-9_-]{1,1364}$/.test(d.credentialId) &&
    /^[A-Za-z0-9_-]{87}$/.test(d.publicKey) &&
    Number.isSafeInteger(d.signCount) &&
    d.signCount >= 0 &&
    d.signCount <= 0xffff_ffff
  );
}

/** A keyring in memory, for tests and for the browser preview, which has no keychain. */
export function memoryKeyring(start: KeyDoc | null = null): Keyring & { doc(): KeyDoc | null } {
  let doc: KeyDoc | null = start;
  const base = (): KeyDoc => doc ?? { v: 1, host: null, devices: [] };
  return {
    doc: () => doc,
    read: async () => (doc ? { v: 1, host: doc.host, devices: doc.devices.map((d) => ({ ...d })) } : null),
    setHost: async (host) => {
      if (base().host) throw new Error("exists");
      if (![host.d, host.x, host.y].every((part) => B64_43.test(part))) throw new Error("invalid");
      doc = { ...base(), host: { ...host } };
    },
    addDevice: async (device) => {
      const now = base();
      if (!isDeviceRecord(device)) throw new Error("invalid");
      if (now.devices.some((d) => d.id === device.id)) throw new Error("exists");
      if (now.devices.some((d) => d.credentialId === device.credentialId)) throw new Error("credential_taken");
      if (now.devices.length >= MAX_PHONES) throw new Error("full");
      doc = { ...now, devices: [...now.devices, { ...device }] };
    },
    touchDevice: async (id, lastSeen, signCount) => {
      const now = base();
      const known = now.devices.find((d) => d.id === id);
      if (!known) throw new Error("not_found");
      if (signCount < known.signCount) throw new Error("counter");
      doc = { ...now, devices: now.devices.map((d) => (d.id === id ? { ...d, lastSeen, signCount } : d)) };
    },
    removeDevice: async (id) => {
      const now = base();
      doc = { ...now, devices: now.devices.filter((d) => d.id !== id) };
    },
  };
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

/** A new relay key, made once with Web Crypto: exported this one time so the keychain can keep it, and never again. */
export async function makeHostKey(): Promise<HostKeyJwk> {
  const pair = (await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("invalid");
  return { d: jwk.d, x: jwk.x, y: jwk.y };
}

/** The Mac's relay identity from the key the keychain holds: the private half imported so script cannot read it back. */
export async function hostIdentity(host: HostKeyJwk): Promise<HostIdentity> {
  if (![host.d, host.x, host.y].every((part) => B64_43.test(part))) throw new Error("invalid");
  const privateKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: host.d, x: host.x, y: host.y, ext: false }, ECDSA, false, ["sign"]);
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(fromBase64Url(host.x), 1);
  raw.set(fromBase64Url(host.y), 33);
  const hostId = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const publicKey = toBase64Url(raw);
  return {
    hostId,
    publicKey,
    sign: async (message) => toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(message)))),
  };
}

/** A paired phone as the page shows it. */
export interface PairedPhone {
  readonly id: string;
  readonly name: string;
  readonly pairedAt: number;
  readonly lastSeen: number | null;
}

interface Held {
  phone: PairedPhone;
  secret: CryptoKey;
  tokenHash: string;
  passkey: StoredPasskey;
}

/** What the page holds of the keychain item once read: the relay identity and each phone's K as keys script cannot read
 *  back, and the plain rest. Every change goes to the keychain first and is held only once the shell took it. */
export class RemoteVault {
  readonly #keyring: Keyring;
  readonly #devices = new Map<string, Held>();
  #identity: HostIdentity | null;

  private constructor(keyring: Keyring, identity: HostIdentity | null) {
    this.#keyring = keyring;
    this.#identity = identity;
  }

  /** Reads the item. With `make`, a Mac that has no relay key yet makes one; without it nothing is made, which is how the
   *  page reads the phone list while the switch is off. */
  static async open(keyring: Keyring, make: boolean): Promise<RemoteVault> {
    let doc = await keyring.read();
    if (!doc?.host && make) {
      await keyring.setHost(await makeHostKey()).catch(() => undefined);
      // Read again: if two windows made one at once, the shell kept the first, and that is the one to use.
      doc = await keyring.read();
    }
    const vault = new RemoteVault(keyring, doc?.host ? await hostIdentity(doc.host) : null);
    for (const record of doc?.devices ?? []) {
      if (!isDeviceRecord(record)) continue;
      await vault.#hold(record);
    }
    return vault;
  }

  async #hold(record: DeviceRecord): Promise<void> {
    const bytes = fromHex(record.k);
    let secret: CryptoKey;
    try {
      secret = await importSharedSecret(bytes);
    } finally {
      bytes.fill(0);
    }
    this.#devices.set(record.id, {
      phone: { id: record.id, name: record.name, pairedAt: record.pairedAt, lastSeen: record.lastSeen },
      secret,
      tokenHash: record.tokenHash,
      passkey: { credentialId: fromBase64Url(record.credentialId), publicKey: fromBase64Url(record.publicKey), signCount: record.signCount },
    });
  }

  get identity(): HostIdentity | null {
    return this.#identity;
  }

  phones(): PairedPhone[] {
    return [...this.#devices.values()].map((d) => d.phone).sort((a, b) => a.pairedAt - b.pairedAt);
  }

  has(id: string): boolean {
    return this.#devices.has(id);
  }

  /** K for a device, for `acceptSession`; undefined for a device this Mac does not hold, which the handshake refuses. */
  secretFor(id: string): CryptoKey | undefined {
    return this.#devices.get(id)?.secret;
  }

  passkey(id: string): StoredPasskey | undefined {
    return this.#devices.get(id)?.passkey;
  }

  tokenHashes(): [string, string][] {
    return [...this.#devices.entries()].map(([id, d]) => [id, d.tokenHash]);
  }

  /** Whether a passkey with this credential id already belongs to a paired phone (the package's caller duty: refuse a
   *  credential registered to another device). */
  credentialTaken(credentialId: Uint8Array): boolean {
    const text = toBase64Url(credentialId);
    return [...this.#devices.values()].some((d) => toBase64Url(d.passkey.credentialId) === text);
  }

  get full(): boolean {
    return this.#devices.size >= MAX_PHONES;
  }

  /** Keeps a newly paired phone. `k` is zeroed here, whatever happens. */
  async add(params: { id: string; name: string; pairedAt: number; k: Uint8Array; tokenHash: string; passkey: StoredPasskey }): Promise<void> {
    const record: DeviceRecord = {
      id: params.id,
      name: cleanName(params.name),
      pairedAt: params.pairedAt,
      lastSeen: params.pairedAt,
      k: toHex(params.k),
      tokenHash: params.tokenHash,
      credentialId: toBase64Url(params.passkey.credentialId),
      publicKey: toBase64Url(params.passkey.publicKey),
      signCount: params.passkey.signCount,
    };
    try {
      await this.#keyring.addDevice(record);
      await this.#hold(record);
    } finally {
      params.k.fill(0);
    }
  }

  /** Told, at once and before the keychain is written, whenever a phone is forgotten, so whoever holds its sessions ends
   *  them (host.ts). */
  onRemoved: ((id: string) => void) | null = null;

  /** Forgets a phone: its K and its passkey go from the page at once, before anything awaits, and then from the keychain.
   *  While the keychain write waits, the phone can no longer open a session or be served, whatever a relay lets through;
   *  and it is gone from the page even when the keychain refused. */
  async remove(id: string): Promise<void> {
    const held = this.#devices.delete(id);
    if (held) this.onRemoved?.(id);
    await this.#keyring.removeDevice(id);
  }

  /** The phone was seen now, and its passkey's counter moved to `signCount` when one is given. */
  async seen(id: string, at: number, signCount?: number): Promise<void> {
    const held = this.#devices.get(id);
    if (!held) return;
    const count = signCount ?? held.passkey.signCount;
    await this.#keyring.touchDevice(id, at, count);
    held.phone = { ...held.phone, lastSeen: at };
    held.passkey = { ...held.passkey, signCount: count };
  }
}
