// What a lane learns from the events of its session, the state the owner reads from that, and the line under its row
// (src/code/lane.ts). The test outputs are the ones testRun.test.ts reads (__fixtures__/test-output).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DICT, LANGS, setLang, t } from "../i18n";
import { emptyLane, failedNames, laneLine, laneStatus, laneTag, noteLane, testState, type LaneRecord, type LaneStatus } from "./lane";

const out = (name: string) => readFileSync(join(__dirname, "__fixtures__", "test-output", `${name}.txt`), "utf8");

type Ev = { event: string; [k: string]: unknown };
const start = (id: string, detail: string, name = "terminal"): Ev => ({ event: "tool.start", tool_id: id, name, detail });
const end = (id: string, ok: boolean, output?: string): Ev => ({ event: "tool.end", tool_id: id, name: "", ok, ms: 5, ...(output === undefined ? {} : { output }) });
const feed = (events: Ev[], from: LaneRecord = emptyLane()): LaneRecord => events.reduce((lane, ev, i) => noteLane(lane, ev, 1_000 + i), from);
/** A run of `command` that ended with `output`, as the lane saw it. */
const ran = (command: string, ok: boolean, output?: string): Ev[] => [start("t1", command), end("t1", ok, output)];

describe("what a lane learns from its events", () => {
  it("knows nothing before anything happened", () => {
    expect(testState(emptyLane())).toBe("none");
  });

  it("reads a test run that passed from its output", () => {
    const lane = feed(ran("pnpm test", true, out("vitest-pass")));
    expect(testState(lane)).toBe("passed");
    expect(lane.run?.read).toEqual({ kind: "passed", passed: 2 });
  });

  it("reads a test run that failed, with how many and which", () => {
    const lane = feed(ran("pnpm test", false, out("vitest-fail")));
    expect(testState(lane)).toBe("failed");
    expect(lane.run?.read).toEqual({ kind: "failed", failed: 1, total: 5, names: ["promptpay > locks the amount into the QR"] });
  });

  it("is running tests from the step's start until its end", () => {
    const running = feed([start("t1", "vitest run")]);
    expect(testState(running)).toBe("running");
    expect(testState(feed([end("t1", true, out("vitest-pass"))], running))).toBe("passed");
  });

  it("keeps no step that runs no tests", () => {
    const lane = feed([...ran("pnpm build", true, "built in 2s"), ...ran("git status", true, out("vitest-pass"))]);
    expect(testState(lane)).toBe("none");
    expect(lane.run).toBeUndefined();
  });

  it("reads a run from the whole command the step's end carries, when the start's was cut short", () => {
    // the shell cuts a step's detail to 160 characters, and a long folder before the tests can take them away
    const cut = `cd /Users/fon/work/baanmali-preorder/apps/storefront/packages/checkout/src/components/payments/promptpay/qr && ${"x".repeat(60)}…`;
    const whole = "cd /Users/fon/work/baanmali-preorder/apps/storefront && pnpm exec vitest run src/checkout.test.ts";
    expect(testState(feed([start("t1", cut)]))).toBe("none");
    const lane = feed([start("t1", cut), { ...end("t1", true, out("vitest-pass")), command: whole }]);
    expect(testState(lane)).toBe("passed");
    expect(lane.run?.read).toEqual({ kind: "passed", passed: 2 });
    // the runner the whole command names limits the reading, as it would have from the start
    expect(feed([start("t1", cut), { ...end("t1", true, out("cargo-pass")), command: whole }]).run?.read).toMatchObject({ kind: "unknown" });
  });

  it("keeps no step whose whole command runs no tests, and the same object for a step that is no command", () => {
    const lane = feed(ran("pnpm test", true, out("vitest-pass")));
    expect(feed([start("t2", "pnpm build"), { ...end("t2", true, "built"), command: "pnpm build" }], lane)).toEqual(lane);
    expect(noteLane(lane, { ...end("t9", true, "text") }, 9_999)).toBe(lane);
    expect(noteLane(lane, { ...end("t9", true, "text"), command: "ls" }, 9_999)).toBe(lane);
  });

  it("reads no run its words send to another folder than the lane's own", () => {
    const where = { root: "/Users/fon/.manut/lanes/baanmali-preorder/promptpay-qr", home: "/Users/fon" };
    const dev = "cd /Users/fon/work/baanmali-preorder && pnpm test";
    const at = (events: Ev[]) => events.reduce((lane, ev, i) => noteLane(lane, ev, 1_000 + i, where), emptyLane());
    // in the developer's folder: never running, never a result
    expect(testState(at([start("t1", dev)]))).toBe("none");
    expect(at(ran(dev, true, out("vitest-pass"))).run).toBeUndefined();
    // a start that looked like the lane's, whose whole command at the end went elsewhere: the step goes, with no result
    const cut = "pnpm test …";
    expect(at([start("t1", cut)]).steps).toEqual({ t1: cut });
    expect(at([start("t1", cut), { ...end("t1", true, out("vitest-pass")), command: `pnpm test; ${dev}` }])).toEqual(emptyLane());
    // in its own folder, as before
    expect(at(ran("cd apps/web && pnpm test", true, out("vitest-pass"))).run?.read).toEqual({ kind: "passed", passed: 2 });
    // with no folder known, every run is read as before
    expect(feed(ran(dev, true, out("vitest-pass"))).run?.read).toEqual({ kind: "passed", passed: 2 });
  });

  it("counts no run for a step the person refused, which never ran", () => {
    const refused = feed([start("t1", "pnpm test"), { event: "tool.end", tool_id: "t1", name: "", ok: false, ms: 0, declined: true }]);
    expect(testState(refused)).toBe("none");
    expect(refused.run).toBeUndefined();
    // an earlier result stands, since nothing ran since
    const before = feed(ran("pnpm test", true, out("vitest-pass")));
    const after = feed([start("t2", "pnpm test"), { event: "tool.end", tool_id: "t2", name: "", ok: false, ms: 0, declined: true }], before);
    expect(testState(after)).toBe("passed");
  });

  it("is only a terminal step that runs tests, not a file tool whose detail happens to say so", () => {
    expect(testState(feed([start("t1", "pnpm test", "read_file")]))).toBe("none");
  });

  it("leaves a run it could not read unknown, whether the shell sent its output or not", () => {
    expect(testState(feed(ran("pnpm test", true, "all done")))).toBe("unknown");
    const none = feed(ran("pnpm test", true));
    expect(testState(none)).toBe("unknown");
    expect(none.run?.read).toEqual({ kind: "unknown", why: "no_output" });
  });

  it("never reads a pass whose command ended with an error as a pass", () => {
    expect(testState(feed(ran("pnpm test && pnpm lint", false, out("vitest-pass"))))).toBe("unknown");
  });

  it("reads the output as the runner the command names", () => {
    // the Go output has no vitest summary, and the command says it is Go
    expect(feed(ran("go test ./...", true, out("go-pass"))).run?.read).toEqual({ kind: "passed", passed: null });
    // a command that names vitest is not read for another runner's summary that a test printed
    expect(feed(ran("vitest run", true, out("cargo-pass"))).run?.read).toMatchObject({ kind: "unknown" });
  });

  it("is the last run that counts", () => {
    const failed = feed(ran("pnpm test", false, out("vitest-fail")));
    const fixed = feed([start("t2", "pnpm test"), end("t2", true, out("vitest-pass"))], failed);
    expect(testState(fixed)).toBe("passed");
  });

  it("ends a run the turn ended on, and ignores that run's late end", () => {
    const stopped = feed([start("t1", "pnpm test"), { event: "turn.end", outcome: "interrupted" }]);
    expect(testState(stopped)).toBe("none");
    expect(testState(feed([end("t1", true, out("vitest-pass"))], stopped))).toBe("none");
  });

  it("makes a result old when a file changes after the run", () => {
    const passed = feed(ran("pnpm test", true, out("vitest-pass")));
    expect(testState(passed)).toBe("passed");
    for (const change of [{ event: "tool.diff", tool_id: "e1", files: [] }, start("e1", "src/a.ts +3 -1", "patch"), { event: "subagent", id: "s1", state: "running", diff: [{ path: "a.ts" }] }]) {
      expect(testState(feed([change], passed)), JSON.stringify(change)).toBe("stale");
    }
    // a failed result is old as well, and a subagent that changed nothing changes nothing
    expect(testState(feed([{ event: "tool.diff", tool_id: "e1", files: [] }], feed(ran("pnpm test", false, out("vitest-fail")))))).toBe("stale");
    expect(testState(feed([{ event: "subagent", id: "s1", state: "running" }], passed))).toBe("passed");
  });

  it("is fresh again after a run that follows the change", () => {
    const changed = feed([...ran("pnpm test", true, out("vitest-pass")), { event: "tool.diff", tool_id: "e1", files: [] }]);
    expect(testState(feed([start("t2", "pnpm test"), end("t2", true, out("vitest-pass"))], changed))).toBe("passed");
  });

  it("is edited before any run without that being a stale result", () => {
    expect(testState(feed([start("e1", "a.ts +1", "patch")]))).toBe("none");
  });

  it("takes a rewound turn's results away, and says it was reverted until the next turn starts", () => {
    const rewound = feed([...ran("pnpm test", true, out("vitest-pass")), { event: "rewound" }]);
    expect(testState(rewound)).toBe("none");
    expect(rewound.revertedAt).toBe(1_000 + 2);
    expect(feed([{ event: "turn.start" }], rewound).revertedAt).toBeUndefined();
  });

  it("knows a Rewind put the files back, and the agent's own rewind of the last message did not", () => {
    const own = feed([...ran("pnpm test", true, out("vitest-pass")), { event: "rewound" }]);
    expect(own.revertedFiles).toBeUndefined();
    const rewind = feed([...ran("pnpm test", true, out("vitest-pass")), { event: "rewound", id: "m-2", text: "Thai date format" }]);
    expect(rewind.revertedFiles).toBe(true);
    expect(rewind.revertedAt).toBe(1_000 + 2);
    expect(testState(rewind)).toBe("none");
    expect(feed([{ event: "rewound", id: "" }]).revertedFiles).toBeUndefined();
    const next = feed([{ event: "turn.start" }], rewind);
    expect(next.revertedAt).toBeUndefined();
    expect(next.revertedFiles).toBeUndefined();
  });

  it("knows Bring it back put the files back, and reads by its tests again until the next turn starts", () => {
    const rewound = feed([...ran("pnpm test", true, out("vitest-pass")), { event: "rewound", id: "m-2", text: "Thai date format" }]);
    const back = feed([{ event: "files.back" }], rewound);
    // no longer reverted: the files are as they were before the rewind
    expect(back.revertedAt).toBeUndefined();
    expect(back.revertedFiles).toBeUndefined();
    expect(back.backAt).toBe(1_000);
    // what the rewind took away stays away: the files that came back are of no run
    expect(testState(back)).toBe("none");
    // a turn that starts ends it, and a new rewind starts over
    expect(feed([{ event: "turn.start" }], back).backAt).toBeUndefined();
    const again = feed([{ event: "rewound", id: "m-1" }], back);
    expect(again.backAt).toBeUndefined();
    expect(again.revertedFiles).toBe(true);
    // a lane that was not reverted has no files to bring back: nothing changes
    const plain = feed(ran("pnpm test", true, out("vitest-pass")));
    expect(noteLane(plain, { event: "files.back" }, 9_999)).toBe(plain);
  });

  it("leaves the record as it was for an event it does not use", () => {
    const lane = feed(ran("pnpm test", true, out("vitest-pass")));
    for (const ev of [{ event: "delta", text: "hi" }, { event: "message", id: "m", text: "done" }, { event: "approval.request", request_id: "r" }, { event: "turn.start" }, { event: "turn.end", outcome: "done" }, { event: "session.info" }]) {
      expect(noteLane(lane, ev, 9_999), ev.event).toBe(lane);
    }
  });

  it("keeps a key that a failing test's name holds out of what it keeps", () => {
    const name = ` FAIL  a.test.ts > sends sk-FAKE0000000000000000TEST to the api\n      Tests  1 failed (1)\n`;
    const lane = feed(ran("vitest run", false, name));
    expect(JSON.stringify(lane)).not.toContain("sk-FAKE0000000000000000TEST");
    expect(failedNames(lane).names[0]).toContain("••••");
  });
});

describe("the state the owner reads", () => {
  const base = { ended: false, working: false, asks: 0, reverted: false, test: "none" as const };
  const status = (over: Partial<Parameters<typeof laneStatus>[0]>): LaneStatus => laneStatus({ ...base, ...over });

  it("says Checked only when the last run passed", () => {
    expect(status({ test: "passed" })).toBe("checked");
    for (const test of ["none", "stale", "unknown", "running"] as const) expect(status({ test }), test).not.toBe("checked");
  });

  it("says Tests failed for a run that failed, and Not confirmed for one that could not be read", () => {
    expect(status({ test: "failed" })).toBe("tests_failed");
    expect(status({ test: "unknown" })).toBe("unconfirmed");
  });

  it("says Not run yet when no test ran, or the code changed after the last one", () => {
    expect(status({ test: "none" })).toBe("not_run");
    expect(status({ test: "stale" })).toBe("not_run");
  });

  it("says Working while a turn runs, whatever the last run said, and Needs you before that", () => {
    expect(status({ working: true, test: "passed" })).toBe("working");
    expect(status({ working: true, test: "running" })).toBe("working");
    expect(status({ working: true, asks: 1, test: "passed" })).toBe("needs_you");
    expect(status({ asks: 2 })).toBe("needs_you");
  });

  it("says Reverted until the next turn, and Failed for a session that ended in an error", () => {
    expect(status({ reverted: true })).toBe("reverted");
    expect(status({ reverted: true, test: "passed" })).toBe("reverted");
    expect(status({ ended: true, test: "passed" })).toBe("failed");
    expect(status({ ended: true, reverted: true })).toBe("failed");
  });

  it("gives each state a tag, in the canvas's colours", () => {
    const tags: [LaneStatus, string, string][] = [
      ["needs_you", "ss.needsYou", "warn"],
      ["working", "ss.working", "run"],
      ["checked", "lane.tag.checked", "ok"],
      ["tests_failed", "lane.tag.testsFailed", "err"],
      ["failed", "lane.tag.failed", "err"],
      ["reverted", "lane.tag.reverted", ""],
      ["unconfirmed", "lane.tag.unconfirmed", ""],
      ["not_run", "lane.tag.notRun", ""],
    ];
    for (const [s, key, tone] of tags) expect(laneTag(s), s).toEqual({ key, tone });
  });
});

describe("the line under a lane's row", () => {
  const withRun = (command: string, ok: boolean, output: string, more: Ev[] = []) => feed([...ran(command, ok, output), ...more]);
  const line = (status: LaneStatus, lane: LaneRecord, over: Partial<Parameters<typeof laneLine>[0]> = {}) => laneLine({ status, lane, branch: true, ...over });

  it("says where Kit works, and that nothing is live", () => {
    expect(line("working", emptyLane())).toEqual({ key: "lane.line.working" });
    expect(line("working", emptyLane(), { branch: false })).toEqual({ key: "lane.line.workingHere" });
  });

  it("says what Kit asks", () => {
    expect(line("needs_you", emptyLane(), { ask: "Which year should customers see?" })).toEqual({ key: "lane.line.asks", vars: { ask: "Which year should customers see?" } });
  });

  it("counts the tests that passed, and does not guess a count that was not given", () => {
    expect(line("checked", withRun("pnpm test", true, out("vitest-pass")))).toEqual({ key: "lane.line.checkedN", vars: { n: 2 } });
    expect(line("checked", withRun("vitest run", true, " Test Files  1 passed (1)\n      Tests  1 passed (1)\n"))).toEqual({ key: "lane.line.checked1" });
    expect(line("checked", withRun("go test ./...", true, out("go-pass")))).toEqual({ key: "lane.line.checkedSome" });
  });

  it("says how many tests failed of how many, as the canvas does", () => {
    expect(line("tests_failed", withRun("pnpm test", false, out("vitest-fail")))).toEqual({ key: "lane.line.failedOf", vars: { failed: 1, total: 5 } });
    expect(line("tests_failed", withRun("vitest run", false, " FAIL  a.test.ts > a > b\n      Tests  1 failed (1)\n"))).toEqual({ key: "lane.line.failedOf", vars: { failed: 1, total: 1 } });
    expect(line("tests_failed", withRun("go test ./...", false, out("go-fail")))).toEqual({ key: "lane.line.failed1" });
    expect(line("tests_failed", withRun("go test -v ./...", false, `${out("go-fail-verbose")}--- FAIL: TestB (0.00s)\n`))).toEqual({ key: "lane.line.failedOf", vars: { failed: 2, total: 5 } });
    expect(line("tests_failed", withRun("go test ./...", false, out("go-build-failed")))).toEqual({ key: "lane.line.failedSome" });
    expect(line("tests_failed", withRun("go test ./...", false, `${out("go-fail")}--- FAIL: TestB (0.00s)\n--- FAIL: TestC (0.00s)\n`))).toEqual({ key: "lane.line.failedN", vars: { n: 3 } });
  });

  it("says that it could not read a run, and that nothing is marked as passed", () => {
    expect(line("unconfirmed", withRun("pnpm test", true, "all done"))).toEqual({ key: "lane.line.unconfirmed" });
  });

  it("says the code changed after the last run, and nothing for a lane that has run no test", () => {
    const changed = withRun("pnpm test", true, out("vitest-pass"), [{ event: "tool.diff", tool_id: "e", files: [] }]);
    expect(line("not_run", changed)).toEqual({ key: "lane.line.stale" });
    expect(line("not_run", emptyLane())).toBeNull();
  });

  it("says when the turn was reverted, and that the files stay", () => {
    expect(line("reverted", emptyLane(), { time: "09:40" })).toEqual({ key: "lane.line.reverted", vars: { time: "09:40" } });
  });

  it("says the files are back after a Rewind that put them back", () => {
    const lane = { ...emptyLane(), revertedAt: 1, revertedFiles: true };
    expect(line("reverted", lane, { time: "09:40" })).toEqual({ key: "lane.line.revertedFiles", vars: { time: "09:40" } });
  });

  it("says the files were brought back and the chat was not, until the next turn", () => {
    const lane = { ...emptyLane(), backAt: 1 };
    expect(line("not_run", lane, { time: "10:02" })).toEqual({ key: "lane.line.broughtBack", vars: { time: "10:02" } });
    // the lane then reads by its tests (Not run yet), not as Reverted
    expect(laneStatus({ ended: false, working: false, asks: 0, reverted: false, test: testState(lane) })).toBe("not_run");
    // once a turn started, nothing is said
    expect(line("not_run", emptyLane(), { time: "10:02" })).toBeNull();
  });

  it("leaves a failed session's own words to the row", () => {
    expect(line("failed", emptyLane(), { error: "boom" })).toBeNull();
  });

  it("is in every language, with the same slots", () => {
    const keys = ["lane.title", "lane.who", "lane.open", "lane.madeFrom", "lane.madeFromIn", "lane.moved", "lane.testing", "lane.tag.checked", "lane.tag.testsFailed", "lane.tag.reverted", "lane.tag.failed", "lane.tag.unconfirmed", "lane.tag.notRun", "lane.line.working", "lane.line.workingHere", "lane.line.asks", "lane.line.checked1", "lane.line.checkedN", "lane.line.checkedSome", "lane.line.failedOf", "lane.line.failed1", "lane.line.failedN", "lane.line.failedSome", "lane.line.reverted", "lane.line.revertedFiles", "lane.line.broughtBack", "lane.line.unconfirmed", "lane.line.stale", "lane.answer", "lane.back", "lane.moreNames"] as const;
    for (const l of LANGS) for (const k of keys) expect(DICT[l][k].trim(), `${l} ${k}`).not.toBe("");
  });
});

describe("the failing tests a row names", () => {
  afterEach(() => setLang("en"));

  it("lists the first three, and counts the rest", () => {
    const names = Array.from({ length: 6 }, (_, i) => ` FAIL  a.test.ts > case ${i}`).join("\n");
    const lane = feed(ran("vitest run", false, `${names}\n      Tests  6 failed (9)\n`));
    expect(failedNames(lane)).toEqual({ names: ["case 0", "case 1", "case 2"], more: 3 });
  });

  it("names none for a run that did not fail, or that gave no names", () => {
    expect(failedNames(emptyLane())).toEqual({ names: [], more: 0 });
    expect(failedNames(feed(ran("pnpm test", true, out("vitest-pass"))))).toEqual({ names: [], more: 0 });
    expect(failedNames(feed(ran("go test ./...", false, out("go-build-failed"))))).toEqual({ names: [], more: 0 });
  });

  it("is not named once the code has changed since", () => {
    const lane = feed([...ran("pnpm test", false, out("vitest-fail")), { event: "tool.diff", tool_id: "e", files: [] }]);
    expect(failedNames(lane)).toEqual({ names: [], more: 0 });
  });

  it("says its words in the owner's language", () => {
    setLang("zh");
    expect(t("lane.line.failedOf", { failed: 1, total: 14 })).toBe("14 个测试中有 1 个未通过。没有任何内容上线。");
    setLang("ko");
    expect(t(laneTag("checked").key)).toBe("확인됨");
    setLang("ja");
    expect(t("lane.line.checkedN", { n: 14 })).toBe("テスト 14 件が成功しました。");
  });
});
