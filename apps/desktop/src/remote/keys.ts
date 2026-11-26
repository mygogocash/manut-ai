// What the Mac keeps for reaching it from a phone, and how the page holds it (docs/remote-access.md, "The architecture").
//
// One keychain item (service `xyz.manut.desktop.api`, account `remote`), read and written only by the shell's
// `remote_keys.rs`, holds a small JSON document: the Mac's relay key (a P-256 key whose public half hashes to the host id
// the relay names the Mac by), and for each paired phone its name, when it paired and was last seen, K (the secret its
// sessions are proved with), the hash of its relay door token and its passkey (credential id, public key, counter). The
// shell checks every field's form and refuses a second phone with the same passkey, so a page with a bug cannot write a
// document it would later misread.
//
// What the page may hold (third review, 26 Nov 2026): a script injected into the window can call any command the page
// can, so the shell hands out as little as the page needs and only while it needs it.
// - The relay key's private half never reaches the page. The shell makes the key (`remote_host_make`) and signs the
//   relay's challenge itself (`remote_host_sign`, which signs nothing else); the page is given the public half only.
// - Each phone's K is in the shell's answer only while the shell's own switch is on (`remote_switch`, which the page
//   turns on only after the consent and off with the switch). The page imports it at once as a key script cannot read
//   back (`extractable: false`), as it does the shop cache's key (`runtime/http/seal.ts`).
// - A phone is added only while the shell has a pairing open (`remote_pairing`, at most five minutes, opened only while
//   the switch is on), and each pairing adds one phone.
// Nothing here is ever made while "Reach this Mac from your phone" is off: `RemoteVault.open(keyring, false)` reads
// only, and then reads no K.
import { type StoredPasskey, fromBase64Url, fromHex, importSharedSecret, toBase64Url, toHex } from "@manut/remote-channel";
import type { HostIdentity } from "./link";

/** The Mac's relay key as the keychain holds it: the JWK's three fields, each 43 base64url characters. Only the shell
 *  holds `d`; the in-memory keyring below keeps it as the keychain would, for tests. */
export interface HostKeyJwk {
  readonly d: string;
  readonly x: string;
  readonly y: string;
}

/** The relay key as the page is given it: its public half. */
export interface HostPublic {
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

/** One paired phone as the page is given it: K only while the shell's switch is on. */
export type PageDeviceRecord = Omit<DeviceRecord, "k"> & { readonly k?: string };

/** The item as the page is given it. */
export interface KeyDoc {
  readonly v: 1;
  readonly host: HostPublic | null;
  readonly devices: readonly PageDeviceRecord[];
}

/** The shell's commands for the `remote` item (remote_keys.rs, lib.rs); tests hand in `memoryKeyring`. */
export interface Keyring {
  /** Never the relay key's private half; each phone's K only while the switch is on. */
  read(): Promise<KeyDoc | null>;
  /** The shell makes the relay key, once, and only while the switch is on. Refused when one is held, so a race can never
   *  replace the key the relay knows the Mac by. */
  makeHost(): Promise<void>;
  /** The relay's challenge (`challengeMessage` in link.ts) signed with the relay key, a raw P-256 ECDSA signature as
   *  base64url. The shell signs nothing else, and only while the switch is on. */
  signHost(message: string): Promise<string>;
  /** The shell's own record of the switch: on only after the consent, off with the switch. */
  setSwitch(on: boolean): Promise<void>;
  /** Opens (at most five minutes, only while the switch is on) or closes the shell's window for adding one phone. */
  setPairing(open: boolean): Promise<void>;
  /** Refused for an id or a passkey already held, past the most phones, and unless a pairing is open, which it spends. */
  addDevice(device: DeviceRecord): Promise<void>;
  /** Only the times and the counter, which may not go down; only while the switch is on. */
  touchDevice(id: string, lastSeen: number, signCount: number): Promise<void>;
  /** Always taken, switch on or off: Unpair must never wait on anything. */
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

/** The relay challenge, the only message the relay key signs (`challengeMessage` in link.ts): the host id the key's
 *  public half hashes to, and the relay's 32-byte nonce. remote_keys.rs checks the same. */
export function isRelayChallenge(message: string, hostId: string): boolean {
  const parts = message.split("|");
  return parts.length === 4 && parts[0] === "gospark-relay-v1" && parts[1] === "host" && parts[2] === hostId && B64_43.test(parts[3] ?? "");
}

/** A phone's own name, as the Mac keeps and shows it: no control characters, spaces folded, at most `MAX_NAME`. */
export function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return [...name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim()].slice(0, MAX_NAME).join("").trim();
}

/** A phone as the page is given it, checked the same way the shell checks it; K may be missing (the switch is off). */
export function isPageDeviceRecord(d: PageDeviceRecord): boolean {
  return (
    DEVICE_ID.test(d.id) &&
    cleanName(d.name) === d.name &&
    d.name.length > 0 &&
    Number.isSafeInteger(d.pairedAt) &&
    d.pairedAt >= 0 &&
    (d.lastSeen === null || (Number.isSafeInteger(d.lastSeen) && d.lastSeen >= 0)) &&
    (d.k === undefined || HEX_64.test(d.k)) &&
    B64_43.test(d.tokenHash) &&
    /^[A-Za-z0-9_-]{1,1364}$/.test(d.credentialId) &&
    /^[A-Za-z0-9_-]{87}$/.test(d.publicKey) &&
    Number.isSafeInteger(d.signCount) &&
    d.signCount >= 0 &&
    d.signCount <= 0xffff_ffff
  );
}

/** A record the shell would take, checked the same way it checks it, so a bad one fails in the page first. */
export function isDeviceRecord(d: DeviceRecord): boolean {
  return typeof d.k === "string" && HEX_64.test(d.k) && isPageDeviceRecord(d);
}

const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The host id the relay names the Mac by: the base64url SHA-256 of the relay key's uncompressed public point. */
async function hostIdOf(host: HostPublic): Promise<{ hostId: string; raw: Uint8Array }> {
  if (![host.x, host.y].every((part) => B64_43.test(part))) throw new Error("invalid");
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(fromBase64Url(host.x), 1);
  raw.set(fromBase64Url(host.y), 33);
  return { hostId: toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))), raw };
}

/** A keyring in memory, for tests and for the browser preview, which has no keychain. It keeps the item as the keychain
 *  would (`doc()`, the relay key's private half included, for tests that look for it on the wire) and answers as the
 *  shell does: the page's read has no `d`, K only while the switch is on, a phone added only through an open pairing. */
export function memoryKeyring(start: KeyDoc | null = null): Keyring & { doc(): { v: 1; host: HostKeyJwk | null; devices: readonly DeviceRecord[] } | null; readonly gate: { on: boolean; pairing: boolean } } {
  type Stored = { v: 1; host: HostKeyJwk | null; devices: DeviceRecord[] };
  let doc: Stored | null = start ? { v: 1, host: null, devices: start.devices.filter((d): d is DeviceRecord => typeof d.k === "string") } : null;
  const gate = { on: false, pairing: false };
  const base = (): Stored => doc ?? { v: 1, host: null, devices: [] };
  return {
    doc: () => doc,
    gate,
    read: async () =>
      doc
        ? {
            v: 1,
            host: doc.host ? { x: doc.host.x, y: doc.host.y } : null,
            devices: doc.devices.map(({ k, ...rest }) => (gate.on ? { ...rest, k } : { ...rest })),
          }
        : null,
    makeHost: async () => {
      if (!gate.on) throw new Error("off");
      if (base().host) throw new Error("exists");
      const pair = (await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;
      const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      if (typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("invalid");
      if (base().host) throw new Error("exists");
      doc = { ...base(), host: { d: jwk.d, x: jwk.x, y: jwk.y } };
    },
    signHost: async (message) => {
      const host = base().host;
      if (!gate.on) throw new Error("off");
      if (!host) throw new Error("no_key");
      if (!isRelayChallenge(message, (await hostIdOf(host)).hostId)) throw new Error("not_a_challenge");
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: host.d, x: host.x, y: host.y, ext: false }, ECDSA, false, ["sign"]);
      return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(message))));
    },
    setSwitch: async (on) => {
      gate.on = on;
      if (!on) gate.pairing = false;
    },
    setPairing: async (open) => {
      if (open && !gate.on) throw new Error("off");
      gate.pairing = open;
    },
    addDevice: async (device) => {
      const now = base();
      if (!gate.on || !gate.pairing) throw new Error("no_pairing");
      // One phone a pairing, taken before anything else is checked.
      gate.pairing = false;
      if (!isDeviceRecord(device)) throw new Error("invalid");
      if (now.devices.some((d) => d.id === device.id)) throw new Error("exists");
      if (now.devices.some((d) => d.credentialId === device.credentialId)) throw new Error("credential_taken");
      if (now.devices.length >= MAX_PHONES) throw new Error("full");
      doc = { ...now, devices: [...now.devices, { ...device }] };
    },
    touchDevice: async (id, lastSeen, signCount) => {
      const now = base();
      if (!gate.on) throw new Error("off");
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

/** The Mac's relay identity from the public half the shell gave and the shell's own signing: the private half never
 *  reaches the page. */
export async function hostIdentity(host: HostPublic, sign: (message: string) => Promise<string>): Promise<HostIdentity> {
  const { hostId, raw } = await hostIdOf(host);
  return { hostId, publicKey: toBase64Url(raw), sign };
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
  /** Null while the switch is off: the shell gives no K then, and none is needed. */
  secret: CryptoKey | null;
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

  /** Reads the item. With `make` (the switch on), a Mac that has no relay key yet has the shell make one; without it
   *  nothing is made, which is how the page reads the phone list while the switch is off. */
  static async open(keyring: Keyring, make: boolean): Promise<RemoteVault> {
    let doc = await keyring.read();
    if (!doc?.host && make) {
      await keyring.makeHost().catch(() => undefined);
      // Read again: if two windows made one at once, the shell kept the first, and that is the one to use.
      doc = await keyring.read();
    }
    const vault = new RemoteVault(keyring, doc?.host ? await hostIdentity(doc.host, (message) => keyring.signHost(message)) : null);
    for (const record of doc?.devices ?? []) {
      if (!isPageDeviceRecord(record)) continue;
      await vault.#hold(record);
    }
    return vault;
  }

  async #hold(record: PageDeviceRecord): Promise<void> {
    let secret: CryptoKey | null = null;
    if (record.k !== undefined) {
      const bytes = fromHex(record.k);
      try {
        secret = await importSharedSecret(bytes);
      } finally {
        bytes.fill(0);
      }
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
    return this.#devices.get(id)?.secret ?? undefined;
  }

  /** Opens the shell's window for adding one phone, for one pairing; refused while the switch is off. */
  openPairing(): Promise<void> {
    return this.#keyring.setPairing(true);
  }

  /** Closes it again, however the pairing ended. */
  closePairing(): void {
    void this.#keyring.setPairing(false).catch(() => undefined);
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
