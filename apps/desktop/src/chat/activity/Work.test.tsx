// A file edit's change as the timeline draws it (src/chat/activity/Work.tsx, `DiffView`), and the two ways the pane beside a lane
// draws it differently: with ids of its own, so the timeline's own diffs are the only ones its specs count, and without scrolling
// itself into view when it opens, since the pane is not opened by a click. The scroll is an effect, which no server render runs, so
// the two hooks it uses are stood in for here: a ref whose element records the scroll, and a layout effect that runs at once.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFile } from "../../lib/protocol";

const scrolled = vi.fn();
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useRef: () => ({ current: { scrollIntoView: scrolled } }),
    useLayoutEffect: (effect: () => void) => {
      effect();
    },
  };
});

const { DiffView } = await import("./Work");

const KEY = "sk-FAKE0000000000000000TEST";
const file = (path: string, lines: string[], added: number, removed = 0): DiffFile => ({ path, kind: "update", lines: ["@@ -12,3 +12,9 @@", ...lines], added, removed });
const CHECKOUT = file("src/checkout.tsx", ["   const total = order.items.reduce(sum, 0);", "-  return <PayByTransfer amount={total} />;", "+  const qr = promptPayQR(SHOP_ID, total);"], 6, 1);
const html = (props: Parameters<typeof DiffView>[0]) => renderToString(createElement(DiffView, props));

beforeEach(() => scrolled.mockClear());

describe("a file edit's change in the timeline", () => {
  it("has the ids the timeline's own specs look for", () => {
    const out = html({ files: [CHECKOUT, file("src/promptpay.ts", ["+export const a = 1;"], 1)] });
    expect(out).toContain('data-testid="diff-view"');
    expect(out.match(/data-testid="diff-file"/g)).toHaveLength(2);
    expect(out.match(/data-testid="diff-body"/g)).toHaveLength(2);
  });

  it("scrolls itself into view when it opens, as it always did", () => {
    html({ files: [CHECKOUT] });
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("draws each file's path, counts and lines, and hides a key in a line", () => {
    const out = html({ files: [file("src/config.ts", [`+export const PROMPTPAY_KEY = "${KEY}";`], 1), CHECKOUT] });
    expect(out).toContain("src/checkout.tsx");
    expect(out).toContain('class="dv-l add"');
    expect(out).toContain('class="dv-l del"');
    expect(out).not.toContain(KEY);
    expect(out).toContain("••••");
  });
});

describe("a file edit's change in the pane beside a lane", () => {
  it("has ids of its own, and none of the timeline's", () => {
    const out = html({ files: [CHECKOUT], testId: "lane-diff", scroll: false });
    expect(out).toContain('data-testid="lane-diff-view"');
    expect(out).toContain('data-testid="lane-diff-file"');
    expect(out).toContain('data-testid="lane-diff-body"');
    for (const own of ["diff-view", "diff-file", "diff-body"]) expect(out.includes(`data-testid="${own}"`), own).toBe(false);
  });

  it("does not scroll itself into view, and still scrolls when it is only given its ids", () => {
    html({ files: [CHECKOUT], testId: "lane-diff", scroll: false });
    expect(scrolled).not.toHaveBeenCalled();
    html({ files: [CHECKOUT], testId: "lane-diff" });
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("draws the same lines in the same way, and hides a key the same", () => {
    const keyed = file("src/config.ts", [`+export const PROMPTPAY_KEY = "${KEY}";`, ` const k = "${KEY}";`], 1);
    const plain = html({ files: [keyed, CHECKOUT] }).replace(/data-testid="diff-/g, 'data-testid="x-');
    const lane = html({ files: [keyed, CHECKOUT], testId: "x", scroll: false });
    expect(lane).toBe(plain);
    expect(lane).not.toContain(KEY);
  });
});
