// What the page holds of the keychain item (keys.ts): the relay key made only when asked and kept as a key script cannot
// read back, K the same way, phone names cleaned, and every change kept by the keychain before the page holds it.
import { describe, expect, it } from "vitest";
import vectors from "../../../api/test/fixtures/relay-v1-vectors.json";
import { type DeviceRecord, MAX_PHONES, RemoteVault, cleanName, hostIdentity, isDeviceRecord, memoryKeyring } from "./keys";

const passkey = { credentialId: new Uint8Array(16).fill(1), publicKey: Uint8Array.of(4, ...new Uint8Array(64).fill(2)), signCount: 0 };
const PHONE = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";

describe("the remote keys as the page holds them", () => {
  it("makes no relay key on a read, makes one when asked, and keeps that one after", async () => {
    const keyring = memoryKeyring();
    const looked = await RemoteVault.open(keyring, false);
    expect(looked.identity).toBeNull();
    expect(keyring.doc()).toBeNull();
    const made = await RemoteVault.open(keyring, true);
    expect(made.identity?.hostId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await RemoteVault.open(keyring, true);
    expect(again.identity?.hostId).toBe(made.identity?.hostId);
  });

  it("names the Mac by the SHA-256 of its relay key, as the relay does", async () => {
    const { d, x, y } = vectors.hostKey.privateJwk;
    const identity = await hostIdentity({ d, x, y });
    expect(identity.hostId).toBe(vectors.hostKey.hostID);
    expect(identity.publicKey).toBe(vectors.hostKey.publicKeyX963);
    await expect(hostIdentity({ d: "short", x, y })).rejects.toThrow();
  });

  it("keeps K as a key script cannot read back, and zeroes the bytes it came in", async () => {
    const keyring = memoryKeyring();
    const vault = await RemoteVault.open(keyring, true);
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
    const vault = await RemoteVault.open(keyring, true);
    await vault.add({ id: PHONE, name: "Pixel", pairedAt: 1, k: new Uint8Array(32).fill(1), tokenHash: vectors.deviceToken.tokenHash, passkey });
    keyring.removeDevice = async () => {
      throw new Error("keychain");
    };
    await expect(vault.remove(PHONE)).rejects.toThrow();
    expect(vault.secretFor(PHONE)).toBeUndefined();
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
