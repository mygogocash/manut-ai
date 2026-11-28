// Find in a chat (item 150): the controller the bar drives, given a stand-in page. What it asks the page to do is recorded,
// so each test reads what was drawn, opened and scrolled to, and in what order.
import { describe, expect, it } from "vitest";
import type { FindResults } from "../../sessions/term/engine-find";
import { makeChatFinder } from "./finder";
import type { Block } from "./read";

const block = (key: string, text: string, fold: string | null = null): Block => ({ key, text, segs: [], fold });

/** A chat: a question, an answer that mentions the file, a folded group with two steps in it, and a last answer. */
const chat = (): Block[] => [
  block("u1:0", "Why does the checkout total come out wrong?"),
  block("a1:0", "I read src/checkout.tsx and ran the tests."),
  block("t1:1", "pnpm test checkout", "G1"),
  block("t1:2", "src/checkout.tsx", "G1"),
  block("a2:0", "The checkout adds the shipping twice."),
];

function rig(initial: Block[] = chat()) {
  let blocks = initial;
  let top = 0;
  const log: string[] = [];
  const painted: { matches: number; current: number }[] = [];
  const finder = makeChatFinder({
    read: () => blocks,
    top: () => top,
    fold: (ids) => void log.push(`fold ${ids.join(",") || "-"}`),
    paint: (_b, m, current) => void painted.push({ matches: m.length, current }),
    show: (b, m) => void log.push(`show ${b.key}@${m.start}`),
  });
  const results: FindResults[] = [];
  finder.onResults((r) => void results.push(r));
  finder.refresh();
  results.length = 0;
  log.length = 0;
  painted.length = 0;
  return {
    finder,
    log,
    painted,
    results,
    last: () => results[results.length - 1]!,
    set: (b: Block[]) => void (blocks = b),
    scrolledTo: (n: number) => void (top = n),
  };
}

describe("typing", () => {
  it("finds across the messages and the steps, folded or not, counts them, and goes to the first match", () => {
    const r = rig();
    r.finder.search("checkout");
    expect(r.last()).toEqual({ index: 0, count: 5, capped: false });
    expect(r.log).toEqual(["fold -", "show u1:0@13"]);
    expect(r.painted.at(-1)).toEqual({ matches: 5, current: 0 });
  });

  it("starts at the top of the view: the first match at or below the first run that is in view", () => {
    const r = rig();
    r.scrolledTo(2);
    r.finder.search("checkout");
    expect(r.last().index).toBe(2);
    expect(r.log).toEqual(["fold G1", "show t1:1@10"]);
  });

  it("wraps to the first match when every match is above the view", () => {
    const r = rig();
    r.scrolledTo(4);
    r.finder.search("src/");
    expect(r.last()).toMatchObject({ index: 0, count: 2 });
  });

  it("stays on the match the person is on while the longer word still matches there", () => {
    const r = rig();
    r.finder.search("check");
    r.finder.step(1);
    r.finder.step(1);
    expect(r.last().index).toBe(2);
    r.log.length = 0;
    r.finder.search("checkout");
    expect(r.last().index).toBe(2);
    expect(r.log).toEqual(["fold G1", "show t1:1@10"]);
  });

  it("says no match, draws nothing and holds no group open for a word that is nowhere", () => {
    const r = rig();
    r.finder.search("checkout");
    r.finder.step(1);
    r.finder.step(1);
    r.log.length = 0;
    r.finder.search("zzz");
    expect(r.last()).toEqual({ index: -1, count: 0, capped: false });
    expect(r.log).toEqual(["fold -"]);
    expect(r.painted.at(-1)).toEqual({ matches: 0, current: -1 });
  });

  it("takes Match case into account, and keeps it for the next word", () => {
    const r = rig([block("a:0", "Checkout and checkout")]);
    r.finder.search("Checkout", { caseSensitive: true });
    expect(r.last().count).toBe(1);
    r.finder.search("checkout");
    expect(r.last().count).toBe(1);
    r.finder.search("checkout", { caseSensitive: false });
    expect(r.last().count).toBe(2);
  });
});

describe("Next and Previous", () => {
  it("go through every match and wrap round at both ends", () => {
    const r = rig();
    r.finder.search("checkout");
    const seen = [r.last().index];
    for (let i = 0; i < 5; i++) {
      r.finder.step(1);
      seen.push(r.last().index);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 0]);
    r.finder.step(-1);
    expect(r.last().index).toBe(4);
    r.finder.step(-1);
    expect(r.last().index).toBe(3);
  });

  it("do nothing with no match", () => {
    const r = rig();
    r.finder.search("zzz");
    r.log.length = 0;
    r.finder.step(1);
    r.finder.step(-1);
    expect(r.log).toEqual([]);
  });
});

describe("a match in a folded step", () => {
  it("opens its group while it is the current match, and lets go of it when the person moves on", () => {
    const r = rig();
    r.finder.search("checkout");
    r.log.length = 0;
    r.finder.step(1); // a1:0, in the open
    r.finder.step(1); // t1:1, in G1
    r.finder.step(1); // t1:2, in G1 again
    r.finder.step(1); // a2:0, in the open
    expect(r.log).toEqual(["fold -", "show a1:0@11", "fold G1", "show t1:1@10", "fold G1", "show t1:2@4", "fold -", "show a2:0@4"]);
  });

  it("holds a group open for its match before the match is scrolled to, so the page can measure it", () => {
    const r = rig();
    r.finder.search("pnpm");
    // the group is told to open first, then the match is brought into view
    expect(r.log).toEqual(["fold G1", "show t1:1@0"]);
  });

  it("goes the other way too: Previous from the first match wraps to the last, in the open, and G1 goes back", () => {
    const r = rig();
    r.scrolledTo(2);
    r.finder.search("checkout"); // t1:1
    r.log.length = 0;
    r.finder.step(-1); // a1:0
    r.finder.step(-1); // u1:0
    r.finder.step(-1); // a2:0, wrapped
    expect(r.log).toEqual(["fold -", "show a1:0@11", "fold -", "show u1:0@13", "fold -", "show a2:0@4"]);
  });
});

describe("the chat changing under the find", () => {
  it("keeps the current match where it is when a message comes, and counts the new one, without scrolling or opening anything", () => {
    const r = rig();
    r.finder.search("checkout");
    r.finder.step(1);
    r.finder.step(1); // t1:1
    r.log.length = 0;
    r.set([...chat(), block("a3:0", "One more checkout note.")]);
    r.finder.refresh();
    expect(r.last()).toEqual({ index: 2, count: 6, capped: false });
    expect(r.log).toEqual([]);
  });

  it("keeps it when a run before it grows: the match is found again by its place, not its number", () => {
    const r = rig();
    r.finder.search("checkout");
    r.finder.step(1);
    r.finder.step(1); // t1:1
    r.set([block("u0:0", "an earlier checkout question"), ...chat()]);
    r.finder.refresh();
    expect(r.last()).toEqual({ index: 3, count: 6, capped: false });
  });

  it("finds the nearest match in the same run when the words of that run moved (an answer still being written)", () => {
    const r = rig([block("s:0", "checkout one")]);
    r.finder.search("checkout");
    r.set([block("s:0", "Well, checkout one checkout two")]);
    r.finder.refresh();
    expect(r.last()).toEqual({ index: 0, count: 2, capped: false });
  });

  it("does not make a match current that the person never moved to", () => {
    const r = rig([block("a:0", "nothing here")]);
    r.finder.search("checkout");
    expect(r.last().index).toBe(-1);
    r.set([block("a:0", "nothing here"), block("a:1", "a checkout note")]);
    r.finder.refresh();
    expect(r.last()).toEqual({ index: -1, count: 1, capped: false });
  });

  it("never opens a group: a person who shut it by hand does not see the find open it again", () => {
    const r = rig();
    r.finder.search("pnpm");
    r.log.length = 0;
    // the person clicks the group shut (the activity line lets go of it); the page then changes, and the find reads it again
    r.set(chat());
    r.finder.refresh();
    r.set([...chat(), block("a3:0", "pnpm again")]);
    r.finder.refresh();
    expect(r.log.filter((l) => l.startsWith("fold"))).toEqual([]);
  });

  it("only draws again, as it is, when the page is the same runs in the same nodes", () => {
    const r = rig();
    r.finder.search("checkout");
    r.painted.length = 0;
    r.finder.refresh();
    expect(r.painted).toEqual([{ matches: 5, current: 0 }]);
    r.painted.length = 0;
    r.finder.repaint();
    expect(r.painted).toEqual([{ matches: 5, current: 0 }]);
  });
});

describe("closing", () => {
  it("clearing takes the highlights off and lets go of the group", () => {
    const r = rig();
    r.finder.search("pnpm");
    r.log.length = 0;
    r.finder.clear();
    expect(r.log).toEqual(["fold -"]);
    expect(r.painted.at(-1)).toEqual({ matches: 0, current: -1 });
    expect(r.last()).toEqual({ index: -1, count: 0, capped: false });
  });

  it("disposing does the same and stops telling anyone", () => {
    const r = rig();
    r.finder.search("pnpm");
    r.log.length = 0;
    const before = r.results.length;
    r.finder.dispose();
    expect(r.log).toEqual(["fold -"]);
    r.finder.search("pnpm");
    expect(r.results).toHaveLength(before);
  });

  it("tells a late listener where things stand", () => {
    const r = rig();
    r.finder.search("checkout");
    const seen: FindResults[] = [];
    r.finder.onResults((x) => void seen.push(x));
    expect(seen).toEqual([{ index: 0, count: 5, capped: false }]);
  });
});
