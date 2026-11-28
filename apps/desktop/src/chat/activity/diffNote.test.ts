// The file and lines a selection in the pane's Diff covers, for a note (diffNote.ts, item 146). The rule is tested over the cells the
// page draws; reading them back from the page's attributes is walked in a browser (e2e/lane-review.spec.ts).
import { describe, expect, it } from "vitest";
import { rowsOf } from "./diffLayout";
import { pickedLines, type Cell } from "./diffNote";

const LINES = ["@@ -12,4 +12,5 @@", "   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);", "+  return <PromptPayQR value={qr} />;", " }"];
const rows = rowsOf(LINES);
const cell = (i: number, side?: Cell["side"]): Cell => ({ ...rows[i], ...(side ? { side } : {}) });

describe("a selection of lines of one file in the unified layout", () => {
  it("quotes the lines as a patch and names the file and the new file's lines", () => {
    const got = pickedLines("src/checkout.tsx", [cell(3), cell(4)]);
    expect(got?.at).toEqual({ file: "src/checkout.tsx", range: { from: 13, to: 14, side: "new" } });
    expect(got?.quote).toBe(["+  const qr = promptPayQR(SHOP_ID, total);", "+  return <PromptPayQR value={qr} />;"].join("\n"));
  });

  it("says deleted lines are the old file's, and a mix of both is the new file's numbers with the removed lines in the quote", () => {
    expect(pickedLines("src/checkout.tsx", [cell(2)])?.at.range).toEqual({ from: 13, to: 13, side: "old" });
    const mixed = pickedLines("src/checkout.tsx", [cell(1), cell(2), cell(3)]);
    expect(mixed?.at.range).toEqual({ from: 12, to: 13, side: "mixed" });
    expect(mixed?.quote.split("\n").map((l) => l[0])).toEqual([" ", "-", "+"]);
  });

  it("names only the file when no hunk header numbered the lines, and none when no line was picked", () => {
    const bare = rowsOf([" a", "+b"]);
    expect(pickedLines("src/a.ts", bare)?.at).toEqual({ file: "src/a.ts" });
    expect(pickedLines("src/a.ts", [])).toBeNull();
    // a hunk's rule alone is no line
    expect(pickedLines("src/a.ts", [cell(0)])).toBeNull();
  });

  it("leaves a hunk's rule out of what it quotes and counts a line once", () => {
    const got = pickedLines("src/checkout.tsx", [cell(0), cell(3), cell(3)]);
    expect(got?.quote).toBe("+  const qr = promptPayQR(SHOP_ID, total);");
    expect(got?.at.range).toEqual({ from: 13, to: 13, side: "new" });
  });
});

describe("a selection in the split layout", () => {
  it("takes only the side the selection began on, and numbers the right side as the new file", () => {
    // a line of context is a cell on both sides: the right side's cells begin the selection, so the left's are left out
    const got = pickedLines("src/checkout.tsx", [cell(1, "new"), cell(1, "old"), cell(3, "new"), cell(2, "old"), cell(4, "new")]);
    expect(got?.at.range).toEqual({ from: 12, to: 14, side: "new" });
    expect(got?.quote.split("\n")).toHaveLength(3);
  });

  it("numbers the left side as the old file, over every line there, context included", () => {
    const got = pickedLines("src/checkout.tsx", [cell(1, "old"), cell(2, "old"), cell(3, "new")]);
    expect(got?.at.range).toEqual({ from: 12, to: 13, side: "old" });
    expect(got?.quote).toBe(["   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;"].join("\n"));
  });
});
