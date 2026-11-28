// Find in a chat (item 150), the matching itself: across a chat's messages and its steps, how a query is read (case, white
// space, Thai and every other script), the count, and Next and Previous wrapping at the ends.
import { describe, expect, it } from "vitest";
import { findCountText } from "../../sessions/term/find-bar";
import { FIND_LIMIT, findAll, firstFrom, patternFor, stepIndex, type Run } from "./text";

/** A chat as find reads it: a question, a turn's steps (folded or not, they are runs like the rest) and the answer. */
const CHAT: Run[] = [
  { key: "u1:0", text: "Why does the checkout total come out wrong?" },
  { key: "a1:0", text: "I ran the tests and read src/checkout.tsx." },
  { key: "a1:1", text: "pnpm test checkout" },
  { key: "a1:2", text: "src/checkout.tsx" },
  { key: "a2:0", text: "The Checkout total adds the shipping twice. สวัสดีครับ ยอดรวมผิด" },
];

const at = (runs: readonly Run[], query: string, o?: Parameters<typeof findAll>[2]) => findAll(runs, query, o).matches.map((m) => [runs[m.block]!.key, m.start, m.end]);

describe("finding across messages and steps", () => {
  it("finds a word in every run it is in, in the order the chat shows them", () => {
    expect(at(CHAT, "checkout")).toEqual([
      ["u1:0", 13, 21],
      ["a1:0", 29, 37],
      ["a1:1", 10, 18],
      ["a1:2", 4, 12],
      ["a2:0", 4, 12],
    ]);
  });

  it("finds a match inside a step on its own", () => {
    expect(at(CHAT, "pnpm")).toEqual([["a1:1", 0, 4]]);
  });

  it("counts them: the bar says which one of how many", () => {
    const found = findAll(CHAT, "checkout");
    expect(found.matches).toHaveLength(5);
    expect(found.capped).toBe(false);
    expect(findCountText({ index: 2, count: found.matches.length, capped: found.capped }, "checkout")).toBe("3 of 5");
    expect(findCountText({ index: 0, count: 0, capped: false }, "zzz")).toBe("No matches");
    expect(findCountText({ index: -1, count: 0, capped: false }, "")).toBe("");
  });

  it("finds several matches in one run, left to right", () => {
    expect(at([{ key: "a", text: "ab ab ab" }], "ab")).toEqual([["a", 0, 2], ["a", 3, 5], ["a", 6, 8]]);
  });

  it("finds nothing for an empty query or one of white space only", () => {
    for (const q of ["", " ", "  \n\t"]) expect(findAll(CHAT, q).matches).toEqual([]);
    expect(patternFor("")).toBeNull();
  });
});

describe("case", () => {
  it("does not count by default: Checkout and checkout are the same word", () => {
    expect(findAll(CHAT, "CHECKOUT").matches).toHaveLength(5);
    expect(findAll(CHAT, "cHeCkOuT").matches).toHaveLength(5);
  });

  it("counts with Match case on", () => {
    expect(at(CHAT, "Checkout", { caseSensitive: true })).toEqual([["a2:0", 4, 12]]);
    expect(at(CHAT, "checkout", { caseSensitive: true })).toHaveLength(4);
  });

  it("keeps every offset right where lowercasing a copy would not: the capital dotted I is two letters when lowered", () => {
    const run: Run[] = [{ key: "a", text: "İstanbul and Istanbul" }];
    expect(at(run, "stanbul")).toEqual([["a", 1, 8], ["a", 14, 21]]);
    expect("İstanbul and Istanbul".toLowerCase().indexOf("stanbul")).toBe(2);
  });

  it("folds other scripts that have a case: Greek and Cyrillic", () => {
    expect(at([{ key: "a", text: "ΑΘΗΝΑ Привет" }], "αθηνα")).toEqual([["a", 0, 5]]);
    expect(at([{ key: "a", text: "ΑΘΗΝΑ Привет" }], "ПРИВЕТ")).toEqual([["a", 6, 12]]);
  });
});

describe("Thai text, as any other", () => {
  const THAI: Run[] = [
    { key: "u", text: "ยอดรวมผิดครับ" },
    { key: "a", text: "ตรวจแล้ว ยอดรวมของตะกร้าบวกค่าส่งสองครั้ง สวัสดีครับ" },
  ];

  it("finds a Thai word with no spaces round it, in every run", () => {
    expect(at(THAI, "ยอดรวม")).toEqual([["u", 0, 6], ["a", 9, 15]]);
    expect(at(THAI, "ครับ")).toEqual([["u", 9, 13], ["a", 48, 52]]);
  });

  it("finds Thai text among Latin text, and Latin text among Thai", () => {
    const mixed: Run[] = [{ key: "m", text: "สั่งซื้อ order #1042 แล้ว" }];
    expect(at(mixed, "order")).toEqual([["m", 9, 14]]);
    expect(at(mixed, "แล้ว")).toEqual([["m", 21, 25]]);
    expect(at(mixed, "ซื้อ order")).toEqual([["m", 4, 14]]);
  });

  it("finds a word with its vowels and tone marks (which are letters of their own in the text), and not the word without them", () => {
    const run: Run[] = [{ key: "t", text: "ค่าส่งฟรี" }];
    expect(at(run, "ค่า")).toEqual([["t", 0, 3]]);
    expect(at(run, "คา")).toEqual([]);
  });

  it("has no case to fold: Match case changes nothing", () => {
    expect(at(THAI, "ยอดรวม", { caseSensitive: true })).toEqual(at(THAI, "ยอดรวม"));
  });
});

describe("what a query is", () => {
  it("is matched as typed: a character that means something to a regular expression is only itself", () => {
    const run: Run[] = [{ key: "a", text: "a.b axb (x) [y] $5 a+b 1|2 \\ ^ {z} ?" }];
    expect(at(run, "a.b")).toEqual([["a", 0, 3]]);
    for (const q of ["(x)", "[y]", "$5", "a+b", "1|2", "\\", "^", "{z}", "?"]) expect(findAll(run, q).matches, q).toHaveLength(1);
    expect(findAll(run, "(").matches).toHaveLength(1);
  });

  it("takes a run of white space in the query for any run of it in the text", () => {
    expect(at([{ key: "a", text: "one\n   two" }], "one two")).toEqual([["a", 0, 10]]);
    expect(at([{ key: "a", text: "one two" }], "one   two")).toEqual([["a", 0, 7]]);
    // a space at the end of the query is a space that has to be there
    expect(at([{ key: "a", text: "the end the" }], "the ")).toEqual([["a", 0, 4]]);
  });

  it("is not a lowercased copy: the pattern's flags are g, i and u, and without i for Match case", () => {
    expect(patternFor("x")!.flags).toBe("giu");
    expect(patternFor("x", { caseSensitive: true })!.flags).toBe("gu");
  });
});

describe("Next and Previous", () => {
  it("wrap round at both ends", () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, -1, 3)).toBe(1);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, -1, 1)).toBe(0);
  });

  it("with no match current, go to the first and to the last", () => {
    expect(stepIndex(-1, 1, 4)).toBe(0);
    expect(stepIndex(-1, -1, 4)).toBe(3);
  });

  it("have nowhere to go with no matches", () => {
    expect(stepIndex(-1, 1, 0)).toBe(-1);
    expect(stepIndex(0, -1, 0)).toBe(-1);
  });

  it("go once round in as many presses as there are matches", () => {
    const n = findAll(CHAT, "checkout").matches.length;
    let i = 1;
    for (let k = 0; k < n; k++) i = stepIndex(i, 1, n);
    expect(i).toBe(1);
  });
});

describe("where a search starts", () => {
  const ms = findAll(CHAT, "checkout").matches;

  it("is the first match at or after the place: the one the person is on stays while it still matches", () => {
    expect(firstFrom(ms, { block: 0, start: 0 })).toBe(0);
    expect(firstFrom(ms, { block: 1, start: 29 })).toBe(1);
    expect(firstFrom(ms, { block: 1, start: 30 })).toBe(2);
    expect(firstFrom(ms, { block: 2, start: 0 })).toBe(2);
  });

  it("is -1 after the last match, and the caller wraps to the first", () => {
    expect(firstFrom(ms, { block: 4, start: 5 })).toBe(-1);
    expect(firstFrom(ms, { block: 9, start: 0 })).toBe(-1);
  });
});

describe("the limit", () => {
  it("stops at the limit and says there may be more", () => {
    const run: Run[] = [{ key: "a", text: "x".repeat(50) }];
    const found = findAll(run, "x", undefined, 10);
    expect(found.matches).toHaveLength(10);
    expect(found.capped).toBe(true);
    expect(findCountText({ index: 0, count: 10, capped: found.capped }, "x")).toBe("1 of 10+");
    expect(findAll(run, "x", undefined, 51).capped).toBe(false);
    expect(FIND_LIMIT).toBe(2000);
  });
});
