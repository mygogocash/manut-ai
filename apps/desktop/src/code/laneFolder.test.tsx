// The Diff beside a lane read from the lane's own folder (src/code/laneFolder.ts, useLaneFolder.ts; the shell's side is
// src-tauri/src/lane_diff.rs). Covered here: the shell's answer read into the files the diff view draws, the pane after a restart
// (no events at all), after a subagent's edit (events that name no file), the fallback where the shell cannot read, a key in the
// folder's text, and the rule for when the folder is read again. The hook itself only wires `folderReader` to a host and a render.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffFile } from "../lib/protocol";
import type { ActivityItem, Step, SubagentRow } from "../state/store";
import { changedFiles } from "./changes";
import { changeMark, filesShown, folderReader, readLaneFolder, readLaneReview, READ_GAP_MS, type LaneFolder, type ReadsLaneFolder } from "./laneFolder";
import { emptyLane, laneTests } from "./lane";
import { LanePaneView, type LanePaneProps } from "./LanePane";
import { NOT_STARTED } from "./previewRun";

const KEY = "sk-FAKE0000000000000000TEST";
const diff = (path: string, body: string[], head: string[] = []) => [`diff --git a/${path} b/${path}`, ...head, `--- a/${path}`, `+++ b/${path}`, ...body].join("\n") + "\n";
const raw = (files: unknown[], more_files = 0) => ({ start: "abc123", files, more_files });
const CHECKOUT = { path: "src/checkout.tsx", from: null, state: "changed", note: null, diff: diff("src/checkout.tsx", ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"]) };

const preview: LanePaneProps["preview"] = {
  dir: "/lane",
  record: { dir: "/lane", reading: false, project: null, plan: null, readWhy: null, run: NOT_STARTED, openFailed: false, token: 0 },
  samples: [],
  onStart: () => {},
  onStop: () => {},
  onOpen: () => {},
  here: { origin: "tauri://localhost", windows: false },
  reloads: 0,
  onReload: () => {},
};
const pane = (files: DiffFile[], moreFiles = 0) =>
  renderToString(createElement(LanePaneView, { view: "diff", onView: () => {}, files, moreFiles, needs: [], asked: null, onAdd: () => {}, preview, tests: laneTests(emptyLane()) }));

describe("the shell's answer read as the files the diff view draws", () => {
  it("is null for anything that is not an answer (an older shell says nothing)", () => {
    for (const x of [null, undefined, "x", 3, [], {}, { files: "no" }]) expect(readLaneFolder(x)).toBeNull();
  });

  it("reads each state: changed, new, deleted and renamed with its old path, with the counts of the whole diff", () => {
    const got = readLaneFolder(
      raw([
        CHECKOUT,
        { path: "src/new.ts", state: "new", diff: diff("src/new.ts", ["@@ -0,0 +1,2 @@", "+a", "+b"], ["new file mode 100644"]) },
        { path: "src/old.ts", state: "deleted", diff: diff("src/old.ts", ["@@ -1 +0,0 @@", "-gone"], ["deleted file mode 100644"]) },
        { path: "src/b.ts", from: "src/a.ts", state: "renamed", diff: "" },
      ]),
    )!;
    expect(got.files.map((f) => [f.path, f.kind, f.added, f.removed, f.from])).toEqual([
      ["src/checkout.tsx", "update", 1, 1, undefined],
      ["src/new.ts", "add", 2, 0, undefined],
      ["src/old.ts", "delete", 0, 1, undefined],
      ["src/b.ts", "update", 0, 0, "src/a.ts"],
    ]);
  });

  it("says why a file has no lines, and how many more files there were", () => {
    const got = readLaneFolder(raw([{ path: "p.png", state: "new", diff: "", note: "binary" }, { path: "big.txt", state: "changed", diff: "", note: "too_large" }, { path: "z", state: "changed", diff: "", note: "other" }], 12))!;
    expect(got.files.map((f) => f.note)).toEqual(["binary", "too_large", undefined]);
    expect(got.moreFiles).toBe(12);
    const out = pane(got.files, got.moreFiles);
    expect(out).toContain("A binary file: no lines to show.");
    expect(out).toContain("Too large to show.");
    expect(out).toContain("and 12 more files");
  });

  it("drops a file with no path and reads an unknown state as changed", () => {
    const got = readLaneFolder(raw([{ state: "new" }, { path: "a", state: "weird", diff: "" }]))!;
    expect(got.files).toHaveLength(1);
    expect(got.files[0].kind).toBe("update");
  });

  it("hides a key in what the folder says, as it does in the chat's own changes", () => {
    const got = readLaneFolder(raw([{ path: "src/config.ts", state: "changed", diff: diff("src/config.ts", ["@@ -1 +1 @@", `-const k = "${KEY}";`, `+export const PROMPTPAY_KEY = "${KEY}";`]) }]))!;
    const out = pane(got.files);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("sk-FAKE");
    expect(out).toContain("••••");
  });
});

// A chat as the pane sees it: its steps and a subagent's.
const sub = (steps: number, state: SubagentRow["state"] = "running"): SubagentRow => ({ id: "s1", index: 0, goal: "g", state, startedAt: 1, steps: Array.from({ length: steps }, (_, i) => ({ text: `step ${i}` })) });
const act = (steps: Step[], subs: SubagentRow[] = [], endedAt?: number): ActivityItem => ({
  kind: "activity",
  id: "a1",
  ts: 1,
  turn: { id: "t1", startedAt: 1, status: "", steps, skills: [], streaming: "", ...(endedAt ? { endedAt } : {}), ...(subs.length ? { fanouts: [{ key: "f", count: subs.length, startedAt: 1, updatedAt: 1, subs }] } : {}) },
});
const chat = (items: ActivityItem[], running = true) => ({ items, turn: running ? ({} as never) : null });
const step = (id: string, d?: DiffFile[]): Step => ({ id, name: "patch", detail: "", startedAt: 1, ...(d ? { diff: d } : {}) });

describe("the pane", () => {
  const host = (answer: LaneFolder | null): ReadsLaneFolder => ({ laneDiff: async () => answer });
  const folderOf = async (h: ReadsLaneFolder) => {
    let shown: LaneFolder | null = null;
    const r = folderReader(() => h.laneDiff("/lane"), (f) => (shown = f));
    r.poke();
    await Promise.resolve();
    await Promise.resolve();
    r.stop();
    return shown as LaneFolder | null;
  };

  it("after a restart has no events at all and still lists what the folder holds", async () => {
    const events = changedFiles(chat([], false));
    expect(events).toEqual([]);
    const folder = await folderOf(host(readLaneFolder(raw([CHECKOUT]))));
    const out = pane(filesShown(folder, events));
    expect(out).toContain("src/checkout.tsx");
    expect(out).not.toContain("Kit has not changed any file yet.");
  });

  it("shows a subagent's edit, which no step of the chat's own lists, and drops a file the agent rewound", async () => {
    // the chat names one file; a subagent changed another; the first was put back by a rewind, so the folder no longer has it
    const mine = { path: "src/mine.ts", kind: "update" as const, lines: ["@@ -1 +1 @@", "+x"], added: 1, removed: 0 };
    const events = changedFiles(chat([act([step("s1", [mine])], [sub(1)])]));
    expect(events.map((f) => f.path)).toEqual(["src/mine.ts"]);
    const folder = await folderOf(host(readLaneFolder(raw([{ path: "src/by-subagent.ts", state: "new", diff: diff("src/by-subagent.ts", ["@@ -0,0 +1 @@", "+y"], ["new file mode 100644"]) }]))));
    const out = pane(filesShown(folder, events));
    expect(out).toContain("src/by-subagent.ts");
    expect(out).not.toContain("src/mine.ts");
  });

  it("keeps today's list from the chat's events where the shell cannot read a folder", async () => {
    const mine = { path: "src/mine.ts", kind: "update" as const, lines: ["@@ -1 +1 @@", "+x"], added: 1, removed: 0 };
    const events = changedFiles(chat([act([step("s1", [mine])])]));
    const folder = await folderOf(host(null));
    expect(folder).toBeNull();
    expect(filesShown(folder, events)).toBe(events);
    expect(pane(filesShown(folder, events))).toContain("src/mine.ts");
  });
});

describe("the hint that something changed", () => {
  it("is the same text for the same chat, and moves when a step, its change, a subagent's step or state, or the turn's end does", () => {
    const base = chat([act([step("s1")], [sub(1)])]);
    const same = chat([act([step("s1")], [sub(1)])]);
    expect(changeMark(base)).toBe(changeMark(same));
    const marks = new Set([
      changeMark(base),
      changeMark(chat([act([step("s1"), step("s2")], [sub(1)])])),
      changeMark(chat([act([step("s1", [{ path: "a", kind: "update", lines: [], added: 0, removed: 0 }])], [sub(1)])])),
      changeMark(chat([act([step("s1")], [sub(2)])])),
      changeMark(chat([act([step("s1")], [sub(1, "done")])])),
      changeMark(chat([act([step("s1")], [sub(1)], 9)], false)),
    ]);
    expect(marks.size).toBe(6);
  });

  it("is quiet for a chat with nothing to say", () => {
    expect(changeMark(undefined)).toBe(changeMark({ items: [], turn: null }));
  });
});

describe("when the folder is read again", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const calls: number[] = [];
    let release: (() => void) | null = null;
    const read = vi.fn(
      () =>
        new Promise<LaneFolder | null>((resolve) => {
          calls.push(Date.now());
          release = () => resolve({ files: [], moreFiles: 0 });
        }),
    );
    const shown = vi.fn();
    const r = folderReader(read, shown);
    return { r, read, shown, calls, done: async () => { release?.(); await vi.advanceTimersByTimeAsync(0); } };
  };

  it("reads at once the first time it is poked, and reads nothing at all until it is", async () => {
    const t = make();
    await vi.advanceTimersByTimeAsync(10 * READ_GAP_MS);
    expect(t.read).not.toHaveBeenCalled();
    t.r.poke();
    expect(t.read).toHaveBeenCalledTimes(1);
    await t.done();
    expect(t.shown).toHaveBeenCalledTimes(1);
    // and nothing on a timer afterwards
    await vi.advanceTimersByTimeAsync(10 * READ_GAP_MS);
    expect(t.read).toHaveBeenCalledTimes(1);
  });

  it("reads at most once a second, however many changes arrive, and once more at the end of the gap", async () => {
    const t = make();
    t.r.poke();
    await t.done();
    for (let i = 0; i < 20; i++) t.r.poke();
    expect(t.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    expect(t.read).toHaveBeenCalledTimes(2);
    await t.done();
    await vi.advanceTimersByTimeAsync(5 * READ_GAP_MS);
    expect(t.read).toHaveBeenCalledTimes(2);
    expect(t.calls[1] - t.calls[0]).toBeGreaterThanOrEqual(READ_GAP_MS);
  });

  it("never runs two reads at once: a change during a read is read once it ends", async () => {
    const t = make();
    t.r.poke();
    await vi.advanceTimersByTimeAsync(READ_GAP_MS * 2);
    t.r.poke();
    expect(t.read).toHaveBeenCalledTimes(1);
    await t.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.read).toHaveBeenCalledTimes(2);
  });

  it("keeps what was shown when a read fails or says nothing, and reads nothing after stop", async () => {
    const shown = vi.fn();
    const answers: (LaneFolder | null | Error)[] = [{ files: [], moreFiles: 0 }, new Error("unread"), null];
    const read = vi.fn(async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    });
    const r = folderReader(read, shown);
    for (let i = 0; i < 3; i++) {
      r.poke();
      await vi.advanceTimersByTimeAsync(READ_GAP_MS);
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(shown).toHaveBeenCalledTimes(1);
    r.stop();
    r.poke();
    await vi.advanceTimersByTimeAsync(5 * READ_GAP_MS);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("the shell's review read as sections (item 146)", () => {
  const part = (files: unknown[], more_files = 0) => ({ files, more_files });
  const commit = (id: string, subject: string, files: unknown[], over: Record<string, unknown> = {}) => ({ id, subject, files, more_files: 0, unread: false, ...over });
  const NEW = { path: "src/new.ts", state: "new", diff: diff("src/new.ts", ["@@ -0,0 +1,2 @@", "+a", "+b"], ["new file mode 100644"]) };

  it("is null for anything that is not an answer", () => {
    for (const x of [null, undefined, "x", 3, [], {}, { uncommitted: part([]) }, { uncommitted: "no", commits: [] }, { uncommitted: part([]), commits: "no" }]) expect(readLaneReview(x), String(x)).toBeNull();
  });

  it("reads the work not committed and each commit with its files, its subject and the files it had no room to list", () => {
    const got = readLaneReview({
      start: "abc123",
      uncommitted: part([CHECKOUT], 2),
      commits: [commit("3f2a1bcd9e01", "Add the QR", [NEW], { more_files: 5 }), commit("1a2b3c4d5e6f", "Start", [])],
      more_commits: 3,
    })!;
    expect(got.uncommitted.files.map((f) => f.path)).toEqual(["src/checkout.tsx"]);
    expect(got.uncommitted.moreFiles).toBe(2);
    expect(got.commits.map((c) => [c.id, c.subject, c.files.length, c.moreFiles, c.unread])).toEqual([
      ["3f2a1bcd9e01", "Add the QR", 1, 5, false],
      ["1a2b3c4d5e6f", "Start", 0, 0, false],
    ]);
    // the files are read as the folder's are: a new file is added, its lines counted
    expect(got.commits[0].files[0]).toMatchObject({ kind: "add", added: 2, removed: 0 });
    expect(got.moreCommits).toBe(3);
  });

  it("keeps a commit whose files could not be read, as unread, with none", () => {
    const got = readLaneReview({ uncommitted: part([]), commits: [commit("aaaaaaaaaaaa", "Old", [], { unread: true })], more_commits: 0 })!;
    expect(got.commits[0]).toMatchObject({ unread: true, files: [] });
  });

  it("drops a commit with no id or no list of files, and takes a count that is not a number above zero as none", () => {
    const got = readLaneReview({ uncommitted: part([]), commits: [{ subject: "no id", files: [] }, { id: "bbbbbbbbbbbb", subject: "no files" }, null, "x", commit("cccccccccccc", "kept", [])], more_commits: -4 })!;
    expect(got.commits.map((c) => c.id)).toEqual(["cccccccccccc"]);
    expect(got.moreCommits).toBe(0);
  });

  it("reads a file's lines the way the folder's are, so a key in a commit's text is not trusted to be hidden by the shell alone", () => {
    const got = readLaneReview({ uncommitted: part([]), commits: [commit("dddddddddddd", "k", [{ path: "a.txt", state: "changed", diff: diff("a.txt", ["@@ -1 +1 @@", "-x", `+token=${KEY}`]) }])], more_commits: 0 })!;
    // the page's own masker runs where the line is drawn (Work.tsx); here the line is a line, with its mark
    expect(got.commits[0].files[0].lines).toEqual(["@@ -1 +1 @@", "-x", `+token=${KEY}`]);
  });
});

describe("telling a view that a read failed", () => {
  it("calls `fail` when a read rejects, keeps what was shown, and goes on to read again", async () => {
    let calls = 0;
    const shown: string[] = [];
    let failed = 0;
    let now = 0;
    const r = folderReader(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("git is busy");
        return `read ${calls}`;
      },
      (x: string) => shown.push(x),
      { fail: () => (failed += 1), now: () => now, setTimer: () => 1, clearTimer: () => undefined },
    );
    r.poke();
    await Promise.resolve();
    await Promise.resolve();
    now += READ_GAP_MS;
    r.poke();
    await Promise.resolve();
    await Promise.resolve();
    now += READ_GAP_MS;
    r.poke();
    await Promise.resolve();
    await Promise.resolve();
    r.stop();
    expect(shown).toEqual(["read 1", "read 3"]);
    expect(failed).toBe(1);
  });

  it("does not call `fail` for a read that says nothing, or after it was stopped", async () => {
    let failed = 0;
    const r = folderReader(
      async () => null,
      () => undefined,
      { fail: () => (failed += 1) },
    );
    r.poke();
    await Promise.resolve();
    await Promise.resolve();
    r.stop();
    const late = folderReader(
      async () => {
        throw new Error("late");
      },
      () => undefined,
      { fail: () => (failed += 1) },
    );
    late.poke();
    late.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toBe(0);
  });
});
