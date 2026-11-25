// The seal on the kept read (seal.ts), with Node's own Web Crypto, the interface the webview gives the page: what a file
// looks like, that it opens only with its key and only as the version and the shop it was written for, that a changed
// byte or a file cut short never opens, that each write has a fresh nonce, and that nothing of the shop is in it to read.
// The stand-in the clock-driven tests use (testkit.ts `microtaskCrypto`) is checked here against the real one, byte for
// byte. How the cache uses the seal (when files are deleted, the key's life) is in cache.test.ts.
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importSealKey, open, seal } from "./seal";
import { hexOf, microtaskCrypto, newSealKey } from "./testkit";

const ORIGIN = "https://dev.manut.xyz";
const TENANT = "apple:owner-1";
const V = 6;

/** A read as a shop keeps it, with a draft's words, a customer's LINE id and a Thai reply in it. */
const PLAIN = JSON.stringify({
  v: V,
  snapshot: {
    tasks: [{ id: "task-1", title: "Reply to Khun Mali", draft: { text: "New candles are in!" }, actions: [{ recipients: ["U4af4980629c9a9d1e3f0b5d2c7e1a6b8"], payload: { text: "ส่งพรุ่งนี้เช้าค่ะ" } }] }],
    schedules: [{ prompt: "Tell me what came in overnight" }],
  },
});
/** Each of them, and none may be in the file. */
const WORDS = ["New candles are in!", "U4af4980629c9a9d1e3f0b5d2c7e1a6b8", "ส่งพรุ่งนี้เช้าค่ะ", "Reply to Khun Mali", "Tell me what came in overnight", "task-1"];

const key = async (hex = newSealKey()) => (await importSealKey(hex))!;
const FILE = /^\{"v":6,"iv":"[A-Za-z0-9_-]{16}","sealed":"[A-Za-z0-9_-]+"\}$/;

/** The file's parts, as bytes. */
function parts(text: string): { iv: Uint8Array; sealed: Uint8Array } {
  const file = JSON.parse(text) as { iv: string; sealed: string };
  const bytes = (s: string) => Uint8Array.from(Buffer.from(s, "base64url"));
  return { iv: bytes(file.iv), sealed: bytes(file.sealed) };
}

/** A file with these parts, written as the page writes one. */
const fileOf = (v: number, iv: Uint8Array, sealed: Uint8Array) =>
  `{"v":${v},"iv":"${Buffer.from(iv).toString("base64url")}","sealed":"${Buffer.from(sealed).toString("base64url")}"}`;

/** Whether `needle`'s bytes are anywhere in `hay`. */
const holds = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(Buffer.from(needle)) !== -1;

afterEach(() => vi.unstubAllGlobals());

describe("a sealed file", () => {
  it("opens with its key as what was sealed, and says its version before anything is opened", async () => {
    const k = await key();
    const text = await seal(PLAIN, k, V, ORIGIN, TENANT);
    expect(text).toMatch(FILE);
    expect(Object.keys(JSON.parse(text))).toEqual(["v", "iv", "sealed"]);
    expect(JSON.parse(text).v).toBe(6);
    const { iv, sealed } = parts(text);
    expect(iv).toHaveLength(12);
    // GCM's 16-byte tag at the end of the sealed bytes, which are otherwise as long as the read
    expect(sealed).toHaveLength(new TextEncoder().encode(PLAIN).length + 16);
    expect(await open(text, k, V, ORIGIN, TENANT)).toBe(PLAIN);
  });

  it("holds nothing of the shop to read: no draft, LINE id, reply or prompt, as text or in its bytes", async () => {
    const text = await seal(PLAIN, await key(), V, ORIGIN, TENANT);
    const { iv, sealed } = parts(text);
    for (const word of WORDS) {
      expect(text, word).not.toContain(word);
      // nor in the bytes the base64 stands for, so a read merely written as base64 would be caught too
      const utf8 = new TextEncoder().encode(word);
      expect(holds(iv, utf8) || holds(sealed, utf8), word).toBe(false);
    }
    // nor who the shop is: the origin and tenant are bound in, not written
    for (const own of [ORIGIN, TENANT, "dev.manut.xyz"]) expect(text, own).not.toContain(own);
  });

  it("has a fresh nonce for every write, so the same read is never the same file twice", async () => {
    const k = await key();
    const texts = await Promise.all(Array.from({ length: 64 }, () => seal(PLAIN, k, V, ORIGIN, TENANT)));
    expect(new Set(texts.map((t) => JSON.parse(t).iv)).size).toBe(64);
    expect(new Set(texts.map((t) => JSON.parse(t).sealed)).size).toBe(64);
    for (const text of texts.slice(0, 4)) expect(await open(text, k, V, ORIGIN, TENANT)).toBe(PLAIN);
  });

  it("never opens with a changed byte, anywhere in its nonce, its sealed bytes or its tag", async () => {
    const k = await key();
    const text = await seal("a short read", k, V, ORIGIN, TENANT);
    const { iv, sealed } = parts(text);
    for (let i = 0; i < iv.length; i += 1) {
      const changed = iv.slice();
      changed[i] ^= 0x01;
      expect(await open(fileOf(V, changed, sealed), k, V, ORIGIN, TENANT), `nonce byte ${i}`).toBeNull();
    }
    for (let i = 0; i < sealed.length; i += 1) {
      const changed = sealed.slice();
      changed[i] ^= 0x80;
      expect(await open(fileOf(V, iv, changed), k, V, ORIGIN, TENANT), `sealed byte ${i}`).toBeNull();
    }
    // the same parts, unchanged, still open: the refusals above are the changed bytes'
    expect(await open(fileOf(V, iv, sealed), k, V, ORIGIN, TENANT)).toBe("a short read");
  });

  it("never opens when cut short, by a byte of its tag or by its end", async () => {
    const k = await key();
    const text = await seal(PLAIN, k, V, ORIGIN, TENANT);
    const { iv, sealed } = parts(text);
    for (const n of [1, 15, 16, 17, sealed.length - 16]) expect(await open(fileOf(V, iv, sealed.subarray(0, sealed.length - n)), k, V, ORIGIN, TENANT), `${n} fewer`).toBeNull();
    for (const n of [1, 2, 10, text.length - 1]) expect(await open(text.slice(0, text.length - n), k, V, ORIGIN, TENANT), `${n} characters fewer`).toBeNull();
  });

  it("never opens with another key", async () => {
    const text = await seal(PLAIN, await key(), V, ORIGIN, TENANT);
    for (let i = 0; i < 4; i += 1) expect(await open(text, await key(), V, ORIGIN, TENANT)).toBeNull();
  });

  it("opens only as the version and the shop it was sealed for, even with its key", async () => {
    const k = await key();
    const text = await seal(PLAIN, k, V, ORIGIN, TENANT);
    expect(await open(text, k, V, ORIGIN, "apple:owner-2")).toBeNull();
    expect(await open(text, k, V, "https://staging.manut.xyz", TENANT)).toBeNull();
    // the parts of the list cannot be shifted into one another
    expect(await open(text, k, V, `${ORIGIN}","apple`, ":owner-1")).toBeNull();
    // another version's file, even one that says this version, does not open as this one
    const seven = await seal(PLAIN, k, 7, ORIGIN, TENANT);
    expect(await open(seven, k, V, ORIGIN, TENANT)).toBeNull();
    const { iv, sealed } = parts(seven);
    expect(await open(fileOf(V, iv, sealed), k, V, ORIGIN, TENANT)).toBeNull();
    expect(await open(seven, k, 7, ORIGIN, TENANT)).toBe(PLAIN);
  });

  it("reads nothing that is not a sealed file of this shape, an earlier version's plain read above all", async () => {
    const k = await key();
    const good = await seal(PLAIN, k, V, ORIGIN, TENANT);
    const five = JSON.stringify({ v: 5, snapshot: JSON.parse(PLAIN).snapshot });
    const odd = [
      five,
      "",
      "{}",
      "null",
      "[]",
      "not json",
      good.replace('{"v":6', '{ "v":6'),
      good.replace('"}', '","more":1}'),
      `${good}\n`,
      good.replace('"iv":"', '"iv":"A'),
      good.replace(/"sealed":"[^"]*"/, '"sealed":"AAAA"'),
      good.replace(/"sealed":"/, '"sealed":"!'),
      // a length base64 cannot have: 25 characters
      good.replace(/"sealed":"[^"]*"/, `"sealed":"${"A".repeat(25)}"`),
    ];
    for (const text of odd) expect(await open(text, k, V, ORIGIN, TENANT), text.slice(0, 40)).toBeNull();
  });

  it("refuses another version's file without trying to open it", async () => {
    const k = await key();
    const seven = await seal(PLAIN, k, 7, ORIGIN, TENANT);
    const decrypt = vi.spyOn(webcrypto.subtle, "decrypt");
    try {
      expect(await open(seven, k, V, ORIGIN, TENANT)).toBeNull();
      expect(decrypt).not.toHaveBeenCalled();
      expect(await open(seven, k, 7, ORIGIN, TENANT)).toBe(PLAIN);
      expect(decrypt).toHaveBeenCalledTimes(1);
    } finally {
      decrypt.mockRestore();
    }
  });

  it("raises rather than answer null when the webview has no Web Crypto, so a good file is never taken for a bad one", async () => {
    const k = await key();
    const text = await seal(PLAIN, k, V, ORIGIN, TENANT);
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(a) });
    await expect(open(text, k, V, ORIGIN, TENANT)).rejects.toThrow("no Web Crypto");
    await expect(seal(PLAIN, k, V, ORIGIN, TENANT)).rejects.toThrow("no Web Crypto");
    await expect(importSealKey(newSealKey())).rejects.toThrow("no Web Crypto");
  });

  it("raises for a failure that is not the file's, rather than answer null", async () => {
    const k = await key();
    const text = await seal(PLAIN, k, V, ORIGIN, TENANT);
    const broken = { decrypt: async () => Promise.reject(new DOMException("busy", "QuotaExceededError")) };
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(a), subtle: broken });
    await expect(open(text, k, V, ORIGIN, TENANT)).rejects.toThrow("busy");
  });
});

describe("the key", () => {
  it("takes 64 lowercase hex digits and nothing else", async () => {
    for (const bad of ["", "00", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), ` ${"a".repeat(63)}`, `${"a".repeat(64)}\n`]) {
      expect(await importSealKey(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(await importSealKey("0".repeat(64))).not.toBeNull();
  });

  it("is held as a key that seals and opens but whose bytes can never be read back", async () => {
    const k = await key();
    expect(k.extractable).toBe(false);
    expect(k.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect([...k.usages].sort()).toEqual(["decrypt", "encrypt"]);
    await expect(webcrypto.subtle.exportKey("raw", k as never)).rejects.toThrow();
  });

  it("zeroes the bytes it came in once it is imported", async () => {
    const given: Uint8Array[] = [];
    const importKey = webcrypto.subtle.importKey.bind(webcrypto.subtle);
    const spy = vi.spyOn(webcrypto.subtle, "importKey").mockImplementation(((format: "raw", data: Uint8Array<ArrayBuffer>, ...rest: [AlgorithmIdentifier, boolean, KeyUsage[]]) => {
      given.push(data);
      return importKey(format, data, ...rest);
    }) as never);
    try {
      const k = await key("ab".repeat(32));
      expect(given).toHaveLength(1);
      expect([...given[0]]).toEqual(new Array(32).fill(0));
      // and the key was taken before they were: it still seals and opens
      expect(await open(await seal(PLAIN, k, V, ORIGIN, TENANT), k, V, ORIGIN, TENANT)).toBe(PLAIN);
    } finally {
      spy.mockRestore();
    }
  });

  it("is the same key from the same digits, as the keychain gives it run after run", async () => {
    const hex = newSealKey();
    const text = await seal(PLAIN, await key(hex), V, ORIGIN, TENANT);
    expect(await open(text, await key(hex), V, ORIGIN, TENANT)).toBe(PLAIN);
  });
});

describe("the clock-driven tests' stand-in", () => {
  it("seals and opens byte for byte as Web Crypto does", async () => {
    const stand = microtaskCrypto().subtle;
    const real = webcrypto.subtle;
    for (const size of [0, 1, 15, 16, 17, 1000, 65_536]) {
      const raw = webcrypto.getRandomValues(new Uint8Array(32));
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const data = webcrypto.getRandomValues(new Uint8Array(size));
      const bound = new TextEncoder().encode(JSON.stringify(["manut.shop-cache", 6, ORIGIN, `${TENANT}-${size}`]));
      const params = { name: "AES-GCM", iv, additionalData: bound, tagLength: 128 };
      const realKey = await real.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const standKey = await stand.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      const byReal = new Uint8Array(await real.encrypt(params, realKey, data));
      const byStand = new Uint8Array(await stand.encrypt(params, standKey, data));
      expect(hexOf(byStand), `${size} bytes`).toBe(hexOf(byReal));
      expect(new Uint8Array(await stand.decrypt(params, standKey, byReal))).toEqual(data);
      expect(new Uint8Array(await real.decrypt(params, realKey, byStand))).toEqual(data);
      // both refuse a changed byte the same way
      const changed = byReal.slice();
      changed[changed.length - 1] ^= 1;
      await expect(real.decrypt(params, realKey, changed)).rejects.toHaveProperty("name", "OperationError");
      await expect(stand.decrypt(params, standKey, changed)).rejects.toHaveProperty("name", "OperationError");
    }
  });

  it("opens what the page sealed with Web Crypto, and the page opens what it sealed", async () => {
    const hex = newSealKey();
    const byReal = await seal(PLAIN, await key(hex), V, ORIGIN, TENANT);
    vi.stubGlobal("crypto", microtaskCrypto());
    const standKey = (await importSealKey(hex))!;
    expect(await open(byReal, standKey, V, ORIGIN, TENANT)).toBe(PLAIN);
    const byStand = await seal(PLAIN, standKey, V, ORIGIN, TENANT);
    expect(await open(byStand, standKey, V, ORIGIN, "apple:owner-2")).toBeNull();
    vi.unstubAllGlobals();
    expect(await open(byStand, await key(hex), V, ORIGIN, TENANT)).toBe(PLAIN);
  });
});
