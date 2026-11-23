// SHA-256 for the name of the saved read of the shop (cache.ts), checked against the published test vectors and, on
// many strings, against Node's own implementation.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

const node = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256Hex", () => {
  it("gives the published digests", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56 bytes: the length field no longer fits in the block that holds the message, so a second block is made
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("agrees with Node on every length around a block boundary, and on text that is not ASCII", () => {
    for (let n = 0; n <= 130; n += 1) expect(sha256Hex("x".repeat(n)), String(n)).toBe(node("x".repeat(n)));
    for (const text of ["ร้านมะลิ", "가나다라", "日本語のテキスト", "👍🏽 emoji", "apple:001234.abcdef", JSON.stringify(["https://dev.manut.xyz", "apple:owner-1"])]) {
      expect(sha256Hex(text), text).toBe(node(text));
    }
  });

  it("agrees with Node on random strings", () => {
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let i = 0; i < 200; i += 1) {
      const text = Array.from({ length: next() % 300 }, () => String.fromCodePoint(32 + (next() % 3000))).join("");
      expect(sha256Hex(text)).toBe(node(text));
    }
  });
});
