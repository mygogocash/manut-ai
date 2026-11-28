// What the page holds of the keychain item (keys.ts): the relay key made only when asked and kept as a key script cannot
// read back, K the same way, phone names cleaned, and every change kept by the keychain before the page holds it.
import { toBase64Url } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import vectors from "../../../api/test/fixtures/relay-v1-vectors.json";
import { type DeviceRecord, MAX_PHONES, RemoteVault, cleanName, grantOf, hostIdentity, isDeviceRecord, isPageDeviceRecord, isRelayChallenge, memoryKeyring } from "./keys";
import { DEFAULT_GRANT, type Grant } from "./levels";

const passkey = { credentialId: new Uint8Array(16).fill(1), publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(2)), signCount: 0 };
const PHONE = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";

describe("the remote keys as the page holds them", () => {
  it("makes no relay key on a read, has the shell make one when asked with the switch on, and keeps that one after", async () => {
    const keyring = memoryKeyring();
    const looked = await RemoteVault.open(keyring, false);
    expect(looked.identity).toBeNull();
    expect(keyring.doc()).toBeNull();
    // With the shell's switch off, asking makes nothing either.
    expect((await RemoteVault.open(keyring, true)).identity).toBeNull();
    expect(keyring.doc()).toBeNull();
    await keyring.setSwitch(true);
    const made = await RemoteVault.open(keyring, true);
    expect(made.identity?.hostId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await RemoteVault.open(keyring, true);
    expect(again.identity?.hostId).toBe(made.identity?.hostId);
  });

  it("names the Mac by the SHA-256 of its relay key's public half, as the relay does", async () => {
    const { x, y } = vectors.hostKey.privateJwk;
    const sign = async () => "";
    const identity = await hostIdentity({ x, y }, sign);
    expect(identity.hostId).toBe(vectors.hostKey.hostID);
    expect(identity.publicKey).toBe(vectors.hostKey.publicKeyX963);
    await expect(hostIdentity({ x: "short", y }, sign)).rejects.toThrow();
  });

  it("is never handed the relay key's private half, and has the shell sign the relay's challenge and nothing else", async () => {
    const keyring = memoryKeyring();
    await keyring.setSwitch(true);
    const vault = await RemoteVault.open(keyring, true);
    const read = await keyring.read();
    expect(Object.keys(read!.host!).sort()).toEqual(["x", "y"]);
    expect(JSON.stringify(read)).not.toContain(keyring.doc()!.host!.d);
    const hostId = vault.identity!.hostId;
    const nonce = vectors.hostChallenge.nonce;
    expect(isRelayChallenge(`gospark-relay-v1|host|${hostId}|${nonce}`, hostId)).toBe(true);
    expect(await vault.identity!.sign(`gospark-relay-v1|host|${hostId}|${nonce}`)).toMatch(/^[A-Za-z0-9_-]{86}$/);
    // Anything else is refused: another host, another nonce's form, a longer message, a message of the shell's own.
    const others = [
      `gospark-relay-v1|host|${vectors.hostKey.hostID}|${nonce}`,
      `gospark-relay-v1|host|${hostId}|${nonce}x`,
      `gospark-relay-v1|host|${hostId}|${nonce}|more`,
      `gospark-relay-v1|phone|${hostId}|${nonce}`,
      `gospark-relay-v1|host|${hostId}|${nonce.replace(/./, "+")}`,
      "any text at all",
      "",
    ];
    for (const message of others) {
      expect(isRelayChallenge(message, hostId), message).toBe(false);
      await expect(vault.identity!.sign(message), message).rejects.toThrow();
    }
    // With the switch off, the shell signs nothing at all.
    await keyring.setSwitch(false);
    await expect(vault.identity!.sign(`gospark-relay-v1|host|${hostId}|${nonce}`)).rejects.toThrow("off");
  });

  it("is given K only while the switch is on, and adds a phone only through one open pairing", async () => {
    const keyring = memoryKeyring();
    await keyring.setSwitch(true);
    const vault = await RemoteVault.open(keyring, true);
    const record = (id: string, credential: number) => ({ id, name: "Pixel", pairedAt: 1, k: new Uint8Array(32).fill(credential), tokenHash: vectors.deviceToken.tokenHash, passkey: { ...passkey, credentialId: new Uint8Array(16).fill(credential) } });
    // No pairing open: refused, whatever the record.
    await expect(vault.add(record(PHONE, 1))).rejects.toThrow("no_pairing");
    await vault.openPairing();
    await vault.add(record(PHONE, 1));
    // One phone a pairing: the window was spent.
    const second = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
    await expect(vault.add(record(second, 2))).rejects.toThrow("no_pairing");
    // A pairing cannot be opened with the switch off, and turning the switch off closes one.
    await vault.openPairing();
    await keyring.setSwitch(false);
    await expect(vault.add(record(second, 2))).rejects.toThrow("no_pairing");
    await expect(vault.openPairing()).rejects.toThrow("off");
    // Read with the switch off, the phone is listed and no K comes with it, so none is held.
    const off = await RemoteVault.open(keyring, false);
    expect(JSON.stringify(await keyring.read())).not.toContain("01".repeat(32));
    expect(off.phones().map((p) => p.id)).toEqual([PHONE]);
    expect(off.secretFor(PHONE)).toBeUndefined();
    // On again, K is read, and held as a key script cannot read back.
    await keyring.setSwitch(true);
    const on = await RemoteVault.open(keyring, true);
    expect(on.secretFor(PHONE)?.extractable).toBe(false);
  });

  it("keeps K as a key script cannot read back, and zeroes the bytes it came in", async () => {
    const keyring = memoryKeyring();
    await keyring.setSwitch(true);
    const vault = await RemoteVault.open(keyring, true);
    await vault.openPairing();
    const k = new Uint8Array(32).fill(7);
    await vault.add({ id: PHONE, name: "  iPhone,\nSafari ", pairedAt: 5, k, tokenHash: vectors.deviceToken.tokenHash, passkey });
    expect(k.every((b) => b === 0)).toBe(true);
    const secret = vault.secretFor(PHONE)!;
    expect(secret.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", secret)).rejects.toThrow();
    // A new pairing is Answer, and its record says nothing of a level.
    expect(vault.phones()).toEqual([{ id: PHONE, name: "iPhone, Safari", pairedAt: 5, lastSeen: 5, grant: DEFAULT_GRANT }]);
    expect(Object.keys(keyring.doc()!.devices[0]!)).not.toContain("level");
    expect(keyring.doc()?.devices[0]?.k).toBe("07".repeat(32));
    // Read again from the keychain, it is the same phone.
    const reread = await RemoteVault.open(keyring, false);
    expect(reread.phones().map((p) => p.name)).toEqual(["iPhone, Safari"]);
    expect(reread.credentialTaken(passkey.credentialId)).toBe(true);
    await reread.seen(PHONE, 9, 3);
    expect(keyring.doc()?.devices[0]).toMatchObject({ lastSeen: 9, signCount: 3 });
    await expect(reread.seen(PHONE, 10, 2)).rejects.toThrow("counter");
    expect(reread.passkey(PHONE)?.signCount).toBe(3);
    await reread.remove(PHONE);
    expect(reread.has(PHONE)).toBe(false);
    expect(keyring.doc()?.devices).toEqual([]);
  });

  it("forgets a phone in the page even when the keychain refused to delete it", async () => {
    const keyring = memoryKeyring();
    await keyring.setSwitch(true);
    const vault = await RemoteVault.open(keyring, true);
    await vault.openPairing();
    await vault.add({ id: PHONE, name: "Pixel", pairedAt: 1, k: new Uint8Array(32).fill(1), tokenHash: vectors.deviceToken.tokenHash, passkey });
    keyring.removeDevice = async () => {
      throw new Error("keychain");
    };
    await expect(vault.remove(PHONE)).rejects.toThrow();
    expect(vault.secretFor(PHONE)).toBeUndefined();
  });

  it("forgets a phone in the page, and says so, before the keychain write is awaited", async () => {
    const keyring = memoryKeyring();
    await keyring.setSwitch(true);
    const vault = await RemoteVault.open(keyring, true);
    await vault.openPairing();
    await vault.add({ id: PHONE, name: "Pixel", pairedAt: 1, k: new Uint8Array(32).fill(1), tokenHash: vectors.deviceToken.tokenHash, passkey });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const remove = keyring.removeDevice;
    keyring.removeDevice = async (id) => {
      await held;
      return remove(id);
    };
    const told: string[] = [];
    vault.onRemoved = (id) => told.push(id);
    const removing = vault.remove(PHONE);
    // At once, with the keychain still writing: no K, no passkey, not paired, and whoever holds its sessions was told.
    expect([vault.has(PHONE), vault.secretFor(PHONE), vault.passkey(PHONE), told]).toEqual([false, undefined, undefined, [PHONE]]);
    expect(keyring.doc()?.devices).toHaveLength(1);
    release();
    await removing;
    expect(keyring.doc()?.devices).toEqual([]);
    // Forgetting one that is not held tells no one.
    await vault.remove(PHONE);
    expect(told).toEqual([PHONE]);
  });

  it("cleans a phone's name and checks a record as the shell does", () => {
    expect(cleanName("  iPhone  \tSafari  ")).toBe("iPhone Safari");
    expect(cleanName("x".repeat(80))).toHaveLength(64);
    expect(cleanName(42)).toBe("");
    const good: DeviceRecord = { id: PHONE, name: "Pixel", pairedAt: 1, lastSeen: null, k: "ab".repeat(32), tokenHash: vectors.deviceToken.tokenHash, credentialId: "AQID", publicKey: "B".repeat(87), signCount: 0 };
    expect(isDeviceRecord(good)).toBe(true);
    for (const bad of [{ id: PHONE.toLowerCase() }, { name: " Pixel" }, { k: "AB".repeat(32) }, { publicKey: "B" }, { signCount: -1 }]) {
      expect(isDeviceRecord({ ...good, ...bad })).toBe(false);
    }
    expect(MAX_PHONES).toBe(7);
  });
});

describe("what each phone may do from afar (item 108b)", () => {
  const WATCH: Grant = { level: "watch", terminal: false, manage: false };
  const ANSWER: Grant = DEFAULT_GRANT;
  const record = (more: Partial<DeviceRecord> = {}): DeviceRecord => ({ id: PHONE, name: "Pixel", pairedAt: 1, lastSeen: null, k: "ab".repeat(32), tokenHash: vectors.deviceToken.tokenHash, credentialId: "AQID", publicKey: toBase64Url(passkey.publicKey), signCount: 0, ...more });
  /** A keyring that already holds one phone kept as `more` says, as a record written by the shell. */
  const holding = (more: Partial<DeviceRecord>) => memoryKeyring({ v: 1, host: null, devices: [record(more)] });

  it("reads a record kept before this item, with no level, as Answer", async () => {
    expect(grantOf(record())).toEqual(ANSWER);
    const vault = await RemoteVault.open(holding({}), false);
    expect(vault.grant(PHONE)).toEqual(ANSWER);
    expect(vault.phones()[0]?.grant).toEqual(ANSWER);
  });

  it("reads a level the record holds, and refuses one it does not understand rather than widening it", async () => {
    expect((await RemoteVault.open(holding({ level: "watch" }), false)).grant(PHONE)).toEqual(WATCH);
    expect((await RemoteVault.open(holding({ level: "work", terminal: true, manage: true }), false)).grant(PHONE)).toEqual({ level: "work", terminal: true, manage: true });
    const odd: Partial<DeviceRecord>[] = [
      { level: "admin" as never },
      { level: "Answer" as never },
      { level: null as never },
      { level: "answer", terminal: true },
      { terminal: true },
      { level: "watch", manage: true },
      { level: "work", manage: "yes" as never },
    ];
    for (const more of odd) {
      expect(grantOf(record(more)), JSON.stringify(more)).toBeNull();
      expect(isPageDeviceRecord(record(more)), JSON.stringify(more)).toBe(false);
      // Not held at all: no K, no passkey, no level, so its hello is refused and nothing it asks is served.
      const vault = await RemoteVault.open(holding(more), false);
      expect([vault.has(PHONE), vault.grant(PHONE), vault.phones()], JSON.stringify(more)).toEqual([false, undefined, []]);
    }
  });

  it("narrows a phone at once, before the keychain write is awaited, and keeps Answer as no level at all", async () => {
    const keyring = holding({});
    const vault = await RemoteVault.open(keyring, false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const write = keyring.setLevel;
    keyring.setLevel = async (id, grant) => {
      await held;
      return write(id, grant);
    };
    // Taken with the switch off, as Unpair is.
    const narrowing = vault.setLevel(PHONE, WATCH);
    expect(vault.grant(PHONE)).toEqual(WATCH);
    expect(keyring.doc()!.devices[0]!.level).toBeUndefined();
    release();
    await narrowing;
    expect(keyring.doc()!.devices[0]!.level).toBe("watch");
    expect((await RemoteVault.open(keyring, false)).grant(PHONE)).toEqual(WATCH);
    // Back to Answer: held only once the keychain took it, which keeps it as no level.
    keyring.setLevel = write;
    await vault.setLevel(PHONE, ANSWER);
    expect(vault.grant(PHONE)).toEqual(ANSWER);
    expect(Object.keys(keyring.doc()!.devices[0]!)).not.toContain("level");
  });

  it("holds a wider level only once the keychain took it, and stays narrow when it refused", async () => {
    const keyring = holding({ level: "watch" });
    const vault = await RemoteVault.open(keyring, false);
    keyring.setLevel = async () => {
      throw new Error("keychain");
    };
    await expect(vault.setLevel(PHONE, ANSWER)).rejects.toThrow("keychain");
    expect(vault.grant(PHONE)).toEqual(WATCH);
    await expect(vault.setLevel("E621E1F8-C36C-495A-93FC-0C247A3E6E5F", WATCH)).rejects.toThrow("not_found");
    // The keychain refuses a level it does not understand, and one for a phone it does not hold.
    const plain = holding({});
    await expect(plain.setLevel(PHONE, { level: "answer", terminal: true, manage: false })).rejects.toThrow("invalid");
    await expect(plain.setLevel("E621E1F8-C36C-495A-93FC-0C247A3E6E5F", WATCH)).rejects.toThrow("not_found");
  });
});
