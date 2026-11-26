import { afterEach, describe, expect, it, vi } from "vitest";
import { createEdges, jobsWorking, working } from "./power";

describe("power busy edges", () => {
  it("sends busy once and idle only after the quiet spell", () => {
    const sent: boolean[] = [];
    const e = createEdges((b) => sent.push(b), 5_000);
    // agent prints for a while: one busy edge, however many readings
    for (let t = 0; t <= 20_000; t += 2_000) e.update(true, t);
    expect(sent).toEqual([true]);
    // a short pause between outputs is no edge
    e.update(false, 22_000);
    e.update(false, 24_000);
    e.update(true, 26_000);
    expect(sent).toEqual([true]);
    // it stops: idle once quiet for 5 s, and only once
    e.update(false, 28_000);
    e.update(false, 30_000);
    expect(sent).toEqual([true]);
    e.update(false, 33_000);
    expect(sent).toEqual([true, false]);
    for (let t = 35_000; t < 60_000; t += 2_000) e.update(false, t);
    expect(sent).toEqual([true, false]);
    e.update(true, 61_000);
    expect(sent).toEqual([true, false, true]);
  });

  it("idle readings with nothing sent send nothing; reset forgets", () => {
    const sent: boolean[] = [];
    const e = createEdges((b) => sent.push(b), 5_000);
    e.update(false, 0);
    e.update(false, 10_000);
    expect(sent).toEqual([]);
    e.update(true, 11_000);
    e.reset();
    e.update(true, 12_000);
    expect(sent).toEqual([true, true]);
  });
});

describe("what counts as work", () => {
  const now = 100_000;
  it("an agent that printed recently, or reports progress, or a bot turn", () => {
    expect(working([{ agent: true, running: true, lastOut: now - 1_000 }], false, now, 5_000)).toBe(true);
    expect(working([{ agent: true, running: true, lastOut: now - 6_000 }], false, now, 5_000)).toBe(false);
    expect(working([{ agent: true, running: true, progress: true }], false, now, 5_000)).toBe(true);
    expect(working([], true, now, 5_000)).toBe(true);
  });
  it("a plain shell printing, or an ended program, is not", () => {
    expect(working([{ agent: false, running: true, lastOut: now }], false, now, 5_000)).toBe(false);
    expect(working([{ agent: true, running: false, lastOut: now }], false, now, 5_000)).toBe(false);
  });
});

describe("the one note that says Manut AI still runs", () => {
  // The first time the window's close hides it to the tray, one notification says where Manut AI went. It is only told once
  // it was shown: quiet hours or a missing permission hold it back, and the next close tells it instead of losing it.
  const hidden = async (shown: boolean) => {
    const calls: string[] = [];
    const store: Record<string, string> = {};
    vi.resetModules();
    vi.doMock("./notify", () => ({
      showNote: async (n: { tag: string }) => {
        calls.push(n.tag);
        return shown;
      },
    }));
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
    const { onWindowHidden } = await import("./power");
    await onWindowHidden();
    await onWindowHidden();
    return { calls, told: store["manut.window.hiddenNoted"] };
  };
  afterEach(() => {
    vi.doUnmock("./notify");
    vi.unstubAllGlobals();
  });

  it("is told once it was shown, and then not again", async () => {
    expect(await hidden(true)).toEqual({ calls: ["manut:hidden"], told: "1" });
  });
  it("is tried again at the next close when nothing was shown", async () => {
    expect(await hidden(false)).toEqual({ calls: ["manut:hidden", "manut:hidden"], told: undefined });
  });
});

describe("how many jobs work now", () => {
  const term = (over: Partial<{ agent: boolean; running: boolean; lastOut: number; progress: boolean }> = {}) => ({ agent: true, running: true, ...over });
  it("counts each bot answering and each agent terminal that printed lately or reports progress", () => {
    const now = 100_000;
    const terms = [term({ lastOut: now - 1_000 }), term({ progress: true }), term({ lastOut: now - 60_000 }), term({ agent: false, lastOut: now - 1_000 }), term({ running: false, lastOut: now - 1_000 })];
    expect(jobsWorking(terms, 2, now)).toBe(4);
    expect(jobsWorking([], 0, now)).toBe(0);
  });
  it("agrees with whether anything works at all", () => {
    const now = 100_000;
    for (const [terms, bots] of [[[], 0], [[term({ progress: true })], 0], [[], 1], [[term({ lastOut: 1 })], 0]] as const) expect(jobsWorking([...terms], bots, now) > 0).toBe(working([...terms], bots > 0, now));
  });
});
