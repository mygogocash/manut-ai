// How a file's diff lines are numbered and laid out for the pane beside a lane (diffLayout.ts, item 146): the numbers git's hunk
// headers give, the side by side pairing of removed, added and changed lines, and the range a run of lines covers.
import { describe, expect, it } from "vitest";
import { pairRows, quoteOf, rangeOf, rowsOf, type DiffRow, type SplitRow } from "./diffLayout";

// the canvas's checkout change: three lines of context, one removed and two added, in a hunk that starts at line 12 on both sides
const LINES = ["@@ -12,4 +12,5 @@", "   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);", "+  return <PromptPayQR value={qr} />;", " }"];

describe("the numbers a hunk's header gives each line", () => {
  it("numbers a line of context on both sides, a removed line on the old side and an added line on the new side", () => {
    const rows = rowsOf(LINES);
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["hunk", undefined, undefined],
      ["ctx", 12, 12],
      ["del", 13, undefined],
      ["add", undefined, 13],
      ["add", undefined, 14],
      ["ctx", 14, 15],
    ]);
  });

  it("keeps each line's place in the file's lines, and its text without the mark", () => {
    const rows = rowsOf(LINES);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows[2].text).toBe("  return <PayByTransfer amount={total} />;");
    expect(rows[1].text).toBe("  const total = order.items.reduce(sum, 0);");
    expect(rows[0].text).toBe("@@ -12,4 +12,5 @@");
  });

  it("starts again at each hunk, and reads a header with no counts or with text after it", () => {
    const rows = rowsOf(["@@ -3 +3 @@ function a()", "-x", "+y", "@@ -40,2 +41,2 @@", " keep", "-old", "+new"]);
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["hunk", undefined, undefined],
      ["del", 3, undefined],
      ["add", undefined, 3],
      ["hunk", undefined, undefined],
      ["ctx", 40, 41],
      ["del", 41, undefined],
      ["add", undefined, 42],
    ]);
  });

  it("leaves a number out rather than guess one: no header, or a header it cannot read", () => {
    for (const lines of [[" a", "-b", "+c"], ["@@", " a", "-b", "+c"], ["@@ -x +y @@", " a", "-b", "+c"]]) {
      const rows = rowsOf(lines).filter((r) => r.kind !== "hunk");
      expect(rows.every((r) => r.old === undefined && r.new === undefined), JSON.stringify(lines)).toBe(true);
    }
  });

  it("does not let a header it cannot read take on the numbers of the one before it", () => {
    const rows = rowsOf(["@@ -5,1 +5,1 @@", " a", "@@ nonsense", " b"]);
    expect(rows[1]).toMatchObject({ old: 5, new: 5 });
    expect(rows[3].old).toBeUndefined();
    expect(rows[3].new).toBeUndefined();
  });
});

const sides = (rows: SplitRow[]) => rows.map((r) => ("hunk" in r ? "hunk" : `${r.left ? r.left.kind + (r.left.old ?? "") : "-"} | ${r.right ? r.right.kind + (r.right.new ?? "") : "-"}`));

describe("the side by side pairing", () => {
  it("puts a line of context on both sides and a hunk's rule across both", () => {
    expect(sides(pairRows(rowsOf(["@@ -1,2 +1,2 @@", " a", " b"])))).toEqual(["hunk", "ctx1 | ctx1", "ctx2 | ctx2"]);
  });

  it("pairs a changed line: the removed line on the left against the added line on the right", () => {
    expect(sides(pairRows(rowsOf(["@@ -1,1 +1,1 @@", "-old", "+new"])))).toEqual(["hunk", "del1 | add1"]);
  });

  it("pairs the lines of a change one against one, and leaves the extra added lines opposite an empty cell", () => {
    // the canvas's change: one line removed, two added
    expect(sides(pairRows(rowsOf(LINES)))).toEqual(["hunk", "ctx12 | ctx12", "del13 | add13", "- | add14", "ctx14 | ctx15"]);
  });

  it("leaves the extra removed lines opposite an empty cell", () => {
    expect(sides(pairRows(rowsOf(["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+x"])))).toEqual(["hunk", "del1 | add1", "del2 | -", "del3 | -"]);
  });

  it("puts a removed line alone on the left and an added line alone on the right", () => {
    expect(sides(pairRows(rowsOf(["@@ -1,2 +1,1 @@", " a", "-gone"])))).toEqual(["hunk", "ctx1 | ctx1", "del2 | -"]);
    expect(sides(pairRows(rowsOf(["@@ -1,1 +1,2 @@", " a", "+new"])))).toEqual(["hunk", "ctx1 | ctx1", "- | add2"]);
  });

  it("pairs only a run of removed lines with the run of added lines right after it, never added lines with the next change's", () => {
    const rows = pairRows(rowsOf(["@@ -1,5 +1,5 @@", "-a", "+b", " mid", "+c", "-d"]));
    // `+c` has no removed line before it, so it stands alone; `-d` comes after it and has no added line after it
    expect(sides(rows)).toEqual(["hunk", "del1 | add1", "ctx2 | ctx2", "- | add3", "del3 | -"]);
  });

  it("shows every line once on its side: nothing is dropped or doubled", () => {
    const rows = rowsOf(LINES);
    const cells = pairRows(rows).flatMap((r) => ("hunk" in r ? [r.hunk] : [r.left, r.right]));
    const indexes = new Set(cells.filter((c): c is DiffRow => !!c).map((c) => c.index));
    expect([...indexes].sort()).toEqual(rows.map((r) => r.index).sort());
    // the removed line is on the left only, an added line on the right only
    const flat = pairRows(rows).filter((r): r is { left?: DiffRow; right?: DiffRow } => !("hunk" in r));
    expect(flat.every((r) => r.left?.kind !== "add" && r.right?.kind !== "del")).toBe(true);
  });

  it("makes no row of no lines", () => {
    expect(pairRows([])).toEqual([]);
    expect(pairRows(rowsOf(["@@ -1 +1 @@"]))).toHaveLength(1);
  });
});

describe("the range a run of lines covers", () => {
  const rows = rowsOf(LINES);
  const pick = (...i: number[]) => i.map((n) => rows[n]);

  it("is the new file's numbers for lines of context and added lines", () => {
    expect(rangeOf(pick(3, 4))).toEqual({ from: 13, to: 14, side: "new" });
    expect(rangeOf(pick(1))).toEqual({ from: 12, to: 12, side: "new" });
  });

  it("is the old file's numbers, and says so, when every line picked was removed", () => {
    expect(rangeOf(pick(2))).toEqual({ from: 13, to: 13, side: "old" });
  });

  it("is mixed when removed lines are among lines of the new file: the new file's numbers, over the lines that are in it", () => {
    expect(rangeOf(pick(1, 2, 3))).toEqual({ from: 12, to: 13, side: "mixed" });
  });

  it("does not count a hunk's rule", () => {
    expect(rangeOf(pick(0, 3))).toEqual({ from: 13, to: 13, side: "new" });
    expect(rangeOf(pick(0))).toBeNull();
  });

  it("is none when the lines carry no numbers", () => {
    expect(rangeOf(rowsOf([" a", "+b"]))).toBeNull();
    expect(rangeOf([])).toBeNull();
  });

  it("takes the old file's numbers over every line when the lines are the split layout's left side", () => {
    expect(rangeOf(pick(1, 2), "old")).toEqual({ from: 12, to: 13, side: "old" });
    // nothing on the old side: no range
    expect(rangeOf(pick(3, 4), "old")).toBeNull();
  });
});

describe("the lines as a patch fragment", () => {
  it("gives each line its mark, so the added lines can be told from the removed", () => {
    const rows = rowsOf(LINES);
    expect(quoteOf(rows.slice(1, 5))).toBe(["   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);", "+  return <PromptPayQR value={qr} />;"].join("\n"));
  });

  it("leaves a hunk's rule out", () => {
    expect(quoteOf(rowsOf(LINES).slice(0, 2))).toBe("   const total = order.items.reduce(sum, 0);");
    expect(quoteOf([])).toBe("");
  });
});
