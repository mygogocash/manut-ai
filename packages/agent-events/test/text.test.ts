import { describe, expect, it } from "vitest";
import { firstCharacters, isBlank, lastCharacters, trimmedOrUndefined, utf8Length, withoutEmDashes } from "../src/index";
import { EM_DASH } from "./support";

const dash = (code: number): string => String.fromCodePoint(code);

/// The em dash cases of GoSpark's `Tests/TextCleanupTests.swift`. Its other cases (ANSI escapes,
/// the last lines of process output, single-line titles, bidi controls) test helpers this
/// package does not carry.
describe("TextCleanupTests", () => {
  it("turns an em dash into a hyphen and keeps the spacing", () => {
    expect(withoutEmDashes(`works ${EM_DASH} every time`)).toBe("works - every time");
    expect(withoutEmDashes(`ships${EM_DASH}sometimes`)).toBe("ships-sometimes");
  });

  it("keeps the en dash, which is correct in a range", () => {
    const range = `lines 10${dash(0x2013)}20`;
    expect(withoutEmDashes(range)).toBe(range);
  });

  it("replaces the horizontal bar and the long em dashes too", () => {
    expect(withoutEmDashes(`a${dash(0x2015)}b`)).toBe("a-b");
    expect(withoutEmDashes(`a${dash(0x2e3a)}b`)).toBe("a-b");
    expect(withoutEmDashes(`a${dash(0x2e3b)}b`)).toBe("a-b");
  });

  it("returns the identical string when there is nothing to replace", () => {
    expect(withoutEmDashes("nothing to do here")).toBe("nothing to do here");
    expect(withoutEmDashes(`one${EM_DASH}two${EM_DASH}three`)).toBe("one-two-three");
  });
});

describe("counting text", () => {
  const thai = String.fromCodePoint(0x0e01, 0x0e35, 0x0e49);
  const family = [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467].map(dash).join("");

  it("measures bytes as UTF-8 does", () => {
    expect(utf8Length("")).toBe(0);
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length(dash(0xe9))).toBe(2);
    expect(utf8Length(thai)).toBe(9);
    expect(utf8Length(dash(0x1f600))).toBe(4);
    expect(utf8Length(`a${family}`)).toBe(new TextEncoder().encode(`a${family}`).length);
  });

  it("takes characters from the front as a person reads them", () => {
    expect(firstCharacters("hello", 5)).toStrictEqual({ text: "hello", cut: false });
    expect(firstCharacters("hello!", 5)).toStrictEqual({ text: "hello", cut: true });
    expect(firstCharacters(thai.repeat(3), 2)).toStrictEqual({ text: thai.repeat(2), cut: true });
    // Three code points and one character: nothing is left behind, so nothing was cut.
    expect(firstCharacters(thai, 1)).toStrictEqual({ text: thai, cut: false });
    expect(firstCharacters(`${family}${family}`, 1)).toStrictEqual({ text: family, cut: true });
  });

  it("takes characters from the back the same way, however long the text before them", () => {
    expect(lastCharacters("hello", 5)).toBe("hello");
    expect(lastCharacters("hello!", 5)).toBe("ello!");
    expect(lastCharacters(thai.repeat(5), 2)).toBe(thai.repeat(2));
    expect(lastCharacters("x".repeat(1_000) + thai.repeat(10), 10)).toBe(thai.repeat(10));
    expect(lastCharacters(`${family}${family}${family}`, 2)).toBe(`${family}${family}`);
  });

  it("knows blank text from text", () => {
    expect(isBlank(" \n\t")).toBe(true);
    expect(isBlank(" a ")).toBe(false);
    expect(trimmedOrUndefined("  a  ")).toBe("a");
    expect(trimmedOrUndefined("   ")).toBeUndefined();
    expect(trimmedOrUndefined(undefined)).toBeUndefined();
  });
});
