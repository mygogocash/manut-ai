// What the page holds of the keychain item (keys.ts): the relay key made only when asked and kept as a key script cannot
// read back, K the same way, phone names cleaned, and every change kept by the keychain before the page holds it.
import { describe, expect, it } from "vitest";
import vectors from "../../../api/test/fixtures/relay-v1-vectors.json";
import { type DeviceRecord, MAX_PHONES, RemoteVault, cleanName, hostIdentity, isDeviceRecord, isRelayChallenge, memoryKeyring } from "./keys";

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
    expect(vault.phones()).toEqual([{ id: PHONE, name: "iPhone, Safari", pairedAt: 5, lastSeen: 5 }]);
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
