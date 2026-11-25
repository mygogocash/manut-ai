// The files a coding session changed, for the Diff beside its lane (src/code/changes.ts): the newest change to each file, from the
// `tool.diff` events the chat keeps on the steps of its turns. The last tests drive the chat's own reducer, so what the pane
// lists is what a session's events and a rewind leave in the chat.
import { describe, expect, it } from "vitest";
import type { BridgeEvent, DiffFile } from "../lib/protocol";
import { initialState, reduce, type Action, type ActivityItem, type AppState, type ChatItem, type Step } from "../state/store";
import { changedFiles, diffsOf, newestFirst, sameDiffs } from "./changes";

const file = (path: string, added: number, removed = 0, kind: DiffFile["kind"] = "update"): DiffFile => ({
  path,
  kind,
  lines: ["@@ -1,2 +1,2 @@", ...Array.from({ length: added }, (_, i) => `+line ${i}`), ...Array.from({ length: removed }, (_, i) => `-line ${i}`)],
  added,
  removed,
});
const step = (id: string, diff?: DiffFile[]): Step => ({ id, name: "patch", detail: "", startedAt: 1, ...(diff ? { diff } : {}) });
const turn = (id: string, ...steps: Step[]): ActivityItem => ({ kind: "activity", id, ts: 1, turn: { id, startedAt: 1, status: "", steps, skills: [], streaming: "" } });
const user = (id: string): ChatItem => ({ kind: "user", id, ts: 1, text: "Add a PromptPay QR to the checkout." });

describe("the files a session changed", () => {
  it("lists none for a chat that does not exist, an empty one, or one whose steps changed no file", () => {
    expect(changedFiles(undefined)).toEqual([]);
    expect(changedFiles({ items: [] })).toEqual([]);
    expect(changedFiles({ items: [user("u1"), turn("t1", step("s1"), step("s2", []))] })).toEqual([]);
  });

  it("lists each file a step changed, in the order the step gave them, with its counts", () => {
    const a = file("src/checkout.tsx", 6, 1);
    const b = file("src/promptpay.ts", 38);
    const files = changedFiles({ items: [user("u1"), turn("t1", step("s1", [a, b]))] });
    expect(files).toEqual([a, b]);
    expect(files[0]).toMatchObject({ added: 6, removed: 1 });
    expect(files[1]).toMatchObject({ added: 38, removed: 0 });
  });

  it("keeps only the newest change to a file, and lists the file that changed last first", () => {
    const a1 = file("src/a.ts", 2);
    const b1 = file("src/b.ts", 3);
    const a2 = file("src/a.ts", 5, 4);
    const files = changedFiles({ items: [user("u1"), turn("t1", step("s1", [a1]), step("s2", [b1])), user("u2"), turn("t2", step("s3", [a2]))] });
    // a changed again after b: its newest change is the last one, and it leads
    expect(files).toEqual([a2, b1]);
  });

  it("keeps the later of two changes to a file in one step", () => {
    const first = file("src/a.ts", 1);
    const second = file("src/a.ts", 9);
    expect(changedFiles({ items: [turn("t1", step("s1", [first, file("src/b.ts", 1), second]))] }).map((f) => `${f.path}:${f.added}`)).toEqual(["src/a.ts:9", "src/b.ts:1"]);
  });

  it("lists a file taken out as deleted, and a file made again after that as new", () => {
    const made = file("src/new.ts", 4, 0, "add");
    const gone = file("src/new.ts", 0, 4, "delete");
    const again = file("src/new.ts", 2, 0, "add");
    expect(changedFiles({ items: [turn("t1", step("s1", [made]), step("s2", [gone]))] })).toEqual([gone]);
    expect(changedFiles({ items: [turn("t1", step("s1", [made]), step("s2", [gone]), step("s3", [again]))] })).toEqual([again]);
  });

  it("leaves out an item that is no turn", () => {
    const a = file("src/a.ts", 1);
    expect(changedFiles({ items: [user("u1"), { kind: "system", id: "x", ts: 1, text: "note" }, turn("t1", step("s1", [a]))] })).toEqual([a]);
  });

  it("is as short as the steps' own lists, whatever turns the chat holds", () => {
    expect(diffsOf({ items: [user("u1"), turn("t1", step("s1"), step("s0", []), step("s2", [file("src/a.ts", 1)])), turn("t2", step("s3", [file("src/b.ts", 1)]))] })).toHaveLength(2);
    expect(newestFirst([])).toEqual([]);
  });

  it("gives the same lists again when the chat's diffs are the same ones, whatever else in it changed", () => {
    const a = file("src/a.ts", 1);
    const s1 = step("s1", [a]);
    const first = diffsOf({ items: [user("u1"), turn("t1", s1)] });
    // a streamed word makes a new turn object, with the same steps and the same diffs in them
    const streaming = turn("t1", s1);
    const second = diffsOf({ items: [user("u1"), { ...streaming, turn: { ...streaming.turn, streaming: "Now I will" } }] });
    expect(sameDiffs(first, second)).toBe(true);
    // another step's change is another list
    expect(sameDiffs(first, diffsOf({ items: [user("u1"), turn("t1", s1, step("s2", [file("src/b.ts", 1)]))] }))).toBe(false);
    // and so is a list of other objects with the same words in them
    expect(sameDiffs(first, [[{ ...a }]])).toBe(false);
    expect(sameDiffs([], [])).toBe(true);
  });
});

describe("the files a session's events and a rewind leave in its chat", () => {
  const bot = "agent:s1";
  const T0 = 1_800_000_000_000;
  const run = (s: AppState, evs: BridgeEvent[], at = T0): AppState => evs.reduce((state, ev, i) => reduce(state, { type: "event", ev, now: at + i * 100 } as Action), s);
  const send = (s: AppState, id: string) => reduce(s, { type: "local.user", bot, id, text: "Add a PromptPay QR.", now: T0 } as Action);
  const edit = (id: string, f: DiffFile[]): BridgeEvent[] => [
    { event: "tool.start", bot, tool_id: id, name: "patch", detail: "src/a.ts" },
    { event: "tool.diff", bot, tool_id: id, files: f },
    { event: "tool.end", bot, tool_id: id, name: "", ok: true, ms: 5 },
  ];
  const turn1 = (s: AppState, f: DiffFile[]) => run(send(s, "u1"), [{ event: "turn.start", bot }, ...edit("e1", f), { event: "turn.end", bot, outcome: "done" }]);

  it("lists what each turn changed, and what a Rewind to before a turn puts back is no longer listed", () => {
    const a1 = file("src/a.ts", 2);
    const b1 = file("src/b.ts", 3);
    const a2 = file("src/a.ts", 6, 1);
    let s = turn1(initialState(), [a1, b1]);
    s = run(send(s, "u2"), [{ event: "turn.start", bot }, ...edit("e2", [a2]), { event: "turn.end", bot, outcome: "done" }], T0 + 10_000);
    expect(changedFiles(s.chats[bot])).toEqual([a2, b1]);
    // Rewind to before the second message: its turn and its change leave the chat, and the first turn's stay
    s = run(s, [{ event: "rewound", bot, id: "u2" } as BridgeEvent], T0 + 20_000);
    expect(changedFiles(s.chats[bot])).toEqual([a1, b1]);
    // and to before the first: nothing is left
    s = run(s, [{ event: "rewound", bot, id: "u1" } as BridgeEvent], T0 + 30_000);
    expect(changedFiles(s.chats[bot])).toEqual([]);
  });

  it("lists the change of the turn that is still running", () => {
    const a = file("src/a.ts", 2);
    const s = run(send(initialState(), "u1"), [{ event: "turn.start", bot }, ...edit("e1", [a])]);
    expect(s.chats[bot].turn).not.toBeNull();
    expect(changedFiles(s.chats[bot])).toEqual([a]);
  });

  it("lists no change that arrived for a step the chat has not got, as the timeline shows none either", () => {
    const s = run(send(initialState(), "u1"), [{ event: "turn.start", bot }, { event: "tool.diff", bot, tool_id: "never-started", files: [file("src/a.ts", 2)] }, { event: "turn.end", bot, outcome: "done" }]);
    expect(changedFiles(s.chats[bot])).toEqual([]);
  });

  it("keeps the same step diffs while the turn's words stream in, so a pane drawn from them need not be drawn again", () => {
    const a = file("src/a.ts", 2);
    const running = run(send(initialState(), "u1"), [{ event: "turn.start", bot }, ...edit("e1", [a])]);
    const before = diffsOf(running.chats[bot]);
    const streamed = run(running, [{ event: "delta", bot, text: "Now " }, { event: "delta", bot, text: "I will" }], T0 + 5_000);
    // every word made a new chat and a new turn in it, and left the steps and what they changed as they were
    expect(streamed.chats[bot]).not.toBe(running.chats[bot]);
    expect(sameDiffs(before, diffsOf(streamed.chats[bot]))).toBe(true);
    // and the next change is another list
    const more = run(streamed, edit("e2", [file("src/b.ts", 1)]), T0 + 6_000);
    expect(sameDiffs(before, diffsOf(more.chats[bot]))).toBe(false);
  });
});
