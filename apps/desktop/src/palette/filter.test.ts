import { describe, expect, it } from "vitest";
import { keyResult, matches } from "./filter";

describe("what a typed word finds", () => {
  it("finds every row for no words or only spaces", () => {
    expect(matches("Settings › Voice", "")).toBe(true);
    expect(matches("Settings › Voice", "   ")).toBe(true);
  });

  it("is plain and case-insensitive, with every word present in any order", () => {
    expect(matches("Settings › Voice", "VOICE")).toBe(true);
    expect(matches("Settings › Voice", "voice sett")).toBe(true);
    expect(matches("Settings › Voice", "voice mic")).toBe(false);
    // not fuzzy: letters that merely appear in order are not a match
    expect(matches("Settings › Voice", "svc")).toBe(false);
  });

  it("matches the words shown in each of the app's languages", () => {
    expect(matches("設定 › 音声", "音声")).toBe(true);
    expect(matches("설정 › 음성", "음성")).toBe(true);
    expect(matches("设置 › 语音", "语音")).toBe(true);
    expect(matches("言語: 日本語", "日本")).toBe(true);
    expect(matches("言語: 日本語", "中文")).toBe(false);
  });

  it("treats a composed and a decomposed Korean syllable as the same word", () => {
    expect(matches("설정", "설정".normalize("NFD"))).toBe(true);
    expect(matches("설정".normalize("NFD"), "설정")).toBe(true);
  });
});

describe("what each key does", () => {
  const at = (cursor: number, count = 3, composing = false) => ({ cursor, count, composing });

  it("moves with the arrows and wraps at both ends", () => {
    expect(keyResult("ArrowDown", at(0))).toEqual({ cursor: 1, do: "none" });
    expect(keyResult("ArrowDown", at(2))).toEqual({ cursor: 0, do: "none" });
    expect(keyResult("ArrowUp", at(0))).toEqual({ cursor: 2, do: "none" });
    expect(keyResult("ArrowUp", at(2))).toEqual({ cursor: 1, do: "none" });
  });

  it("picks on Enter and closes on Esc", () => {
    expect(keyResult("Enter", at(1))).toEqual({ cursor: 1, do: "pick" });
    expect(keyResult("Escape", at(1))).toEqual({ cursor: 1, do: "close" });
  });

  it("picks nothing from an empty list, but Esc still closes", () => {
    expect(keyResult("Enter", at(0, 0)).do).toBe("none");
    expect(keyResult("ArrowDown", at(0, 0))).toEqual({ cursor: 0, do: "none" });
    expect(keyResult("Escape", at(0, 0)).do).toBe("close");
  });

  it("does nothing while an input method composes, Enter and Esc included", () => {
    for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) expect(keyResult(key, at(1, 3, true)), key).toEqual({ cursor: 1, do: "none" });
  });

  it("leaves other keys to the field", () => {
    expect(keyResult("a", at(1))).toEqual({ cursor: 1, do: "none" });
  });
});
