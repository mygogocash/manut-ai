// A workflow's history (item 77b): its bounds, the skipped runs kept as Settings says, what an earlier run of the app left going,
// and the reason's words with any key hidden.
import { describe, expect, it } from "vitest";
import { DETAIL_MAX, detailOf, keepRuns, parseRuns, RUNS_KEPT, settleLeftovers, type RunRec } from "./history";
import { parseWorkflowSettings, SKIPPED_KEPT_MAX, WORKFLOW_DEFAULTS } from "./settings";

const run = (i: number, over: Partial<RunRec> = {}): RunRec => ({ id: `r${i}`, file: "a.json", name: "A", by: "schedule", at: 1000 + i, steps: 2, reached: 2, state: "done", ...over });

describe("the history's bounds", () => {
  it("keeps each workflow's newest runs that did something, newest first", () => {
    const list = Array.from({ length: RUNS_KEPT + 5 }, (_, i) => run(i));
    const kept = keepRuns(list, 50);
    expect(kept).toHaveLength(RUNS_KEPT);
    expect(kept[0].id).toBe(`r${RUNS_KEPT + 4}`);
    expect(kept.at(-1)!.id).toBe("r5");
  });

  it("keeps the skipped runs apart, up to the number Settings says, 0 keeping none", () => {
    const list = [...Array.from({ length: 8 }, (_, i) => run(i, { state: "skipped", reached: 0, why: "closed" })), run(100), run(101, { state: "failed", why: "turn" })];
    expect(keepRuns(list, 3).filter((r) => r.state === "skipped").map((r) => r.id)).toEqual(["r7", "r6", "r5"]);
    expect(keepRuns(list, 0).map((r) => r.id)).toEqual(["r101", "r100"]);
    // what did something is never pushed out by what was skipped
    expect(keepRuns(list, 3).filter((r) => r.state !== "skipped")).toHaveLength(2);
  });

  it("bounds each workflow on its own, and never drops a run still going", () => {
    const list = [
      ...Array.from({ length: RUNS_KEPT + 2 }, (_, i) => run(i, { file: "a.json" })),
      ...Array.from({ length: 3 }, (_, i) => run(50 + i, { file: "b.json" })),
      run(-500, { state: "running", file: "a.json" }),
    ];
    const kept = keepRuns(list, 50);
    expect(kept.filter((r) => r.file === "a.json" && r.state === "done")).toHaveLength(RUNS_KEPT);
    expect(kept.filter((r) => r.file === "b.json")).toHaveLength(3);
    expect(kept.some((r) => r.id === "r-500")).toBe(true);
  });
});

describe("what is saved", () => {
  it("reads back what it wrote and leaves out a record it cannot read", () => {
    const good = run(1, { due: 900, why: "turn", state: "failed", detail: "Tests failed", session: "s3", ended: 2000 });
    const text = JSON.stringify([good, { id: "x" }, run(2, { state: "lost" as never }), run(3, { by: "robot" as never }), 7, null]);
    expect(parseRuns(text)).toEqual([good]);
    expect(parseRuns("{")).toEqual([]);
    expect(parseRuns(null)).toEqual([]);
    // a reason this build does not know is dropped, the run kept
    expect(parseRuns(JSON.stringify([run(4, { why: "meteor" as never })]))[0].why).toBeUndefined();
  });

  it("ends a run an earlier run of the app left going: it closed while it ran", () => {
    const [r] = settleLeftovers([run(1, { state: "running", reached: 1 })], 5000);
    expect(r).toMatchObject({ state: "stopped", why: "app_closed", ended: 5000, reached: 1 });
    expect(settleLeftovers([run(2)], 5000)[0]).toEqual(run(2));
  });

  it("hides any key in the agent's words before it keeps them, then cuts them", () => {
    expect(detailOf("push failed:   token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 refused")).toBe("push failed: token=•••• refused");
    const long = detailOf("x".repeat(DETAIL_MAX + 50));
    expect(long).toHaveLength(DETAIL_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Settings › Workflows' choices", () => {
  it("starts off, keeping 50 skipped runs, and a damaged setting never turns it on", () => {
    expect(parseWorkflowSettings(null)).toEqual(WORKFLOW_DEFAULTS);
    expect(WORKFLOW_DEFAULTS).toEqual({ on: false, skippedKept: 50 });
    expect(parseWorkflowSettings("{")).toEqual(WORKFLOW_DEFAULTS);
    expect(parseWorkflowSettings(JSON.stringify({ on: "yes", skippedKept: -1 }))).toEqual(WORKFLOW_DEFAULTS);
    expect(parseWorkflowSettings(JSON.stringify({ on: true, skippedKept: 0 }))).toEqual({ on: true, skippedKept: 0 });
    expect(parseWorkflowSettings(JSON.stringify({ on: true, skippedKept: SKIPPED_KEPT_MAX + 1 })).skippedKept).toBe(50);
    expect(parseWorkflowSettings(JSON.stringify({ on: true, skippedKept: 2.5 })).skippedKept).toBe(50);
  });
});
