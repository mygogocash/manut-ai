import { describe, expect, it } from "vitest";
import {
  RemoteChannelError,
  equalBytes,
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  uuidFromBytes,
  uuidToBytes,
} from "../src/index";

/// The byte helpers every other part leans on. Their strictness is what keeps a second spelling of
/// the same value from slipping past a check: a decoder that took padding, the other alphabet or
/// a lower-case device id would let one value arrive in two forms.

describe("base64url", () => {
  it("round-trips every length, with no padding and only the URL-safe alphabet", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
  });

  it("refuses padding, the standard alphabet, spaces and a non-canonical last character", () => {
    const good = toBase64Url(Uint8Array.of(0xfb, 0xff, 0xfe));
    expect(good).toBe("-__-");
    for (const bad of ["+//+", "-__-=", " -__-", "-__-\n", "AB=", "A", "AB*C", "QR"]) {
      expect(() => fromBase64Url(bad), bad).toThrow(RemoteChannelError);
    }
    // "QQ" is the one spelling of a single 0x41; "QR" would decode to the same byte with spare bits set.
    expect(fromBase64Url("QQ")).toEqual(Uint8Array.of(0x41));
  });
});

describe("hex", () => {
  it("round-trips and refuses odd lengths and other characters", () => {
    expect(toHex(Uint8Array.of(0, 15, 255))).toBe("000fff");
    expect(fromHex("000fff")).toEqual(Uint8Array.of(0, 15, 255));
    expect(() => fromHex("abc")).toThrow(RemoteChannelError);
    expect(() => fromHex("zz")).toThrow(RemoteChannelError);
  });
});

describe("equalBytes", () => {
  it("is true only for the same length and the same bytes", () => {
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(equalBytes(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2))).toBe(false);
    expect(equalBytes(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    // A difference in the first byte and in the last are both found, whatever comes between.
    const a = new Uint8Array(64);
    const first = a.slice();
    first[0] = 1;
    const last = a.slice();
    last[63] = 1;
    expect(equalBytes(a, first)).toBe(false);
    expect(equalBytes(a, last)).toBe(false);
  });
});

describe("device ids", () => {
  it("takes exactly the relay's upper-case 8-4-4-4-12 form and gives it back", () => {
    const id = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
    const bytes = uuidToBytes(id);
    expect(bytes.length).toBe(16);
    expect(uuidFromBytes(bytes)).toBe(id);
    for (const bad of [id.toLowerCase(), `{${id}}`, id.replaceAll("-", ""), `${id} `, "E621E1F8-C36C-495A-93FC-0C247A3E6E5"]) {
      expect(() => uuidToBytes(bad), bad).toThrow(RemoteChannelError);
    }
  });
});
