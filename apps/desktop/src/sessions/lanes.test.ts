// A coding session's lane (src/code/): the branch of its own that is made as the session starts, and what its events
// teach the lane, against a fake shell. The lane's rules are tested in src/code/lane.test.ts and laneBranch.test.ts; this
// is the sessions store keeping them: in what order the shell is asked, and what is kept on the row and in the lane.
import { beforeEach, expect, test } from "vitest";
import { laneOf, resetLanes } from "../code/laneStore";
import { testState } from "../code/lane";
import { createStore, type BridgeLike } from "../state/store";
import { createSessions } from "./sessions";
import type { ChatEvent, ChatInput, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

interface Setup {
  /** The branch the folder is on; the fake shell moves it as a lane's branch is made. */
  folder: { branch: string };
  calls: string[];
  made: { names: string[] }[];
}

async function setup(over: { branch?: string; laneBranch?: SessionHost["laneBranch"] | null } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const s: Setup = { folder: { branch: over.branch ?? "main" }, calls: [], made: [] };
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const sent: string[] = [];
  const base = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async () => {
      s.calls.push("branch");
      return s.folder.branch;
    },
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      s.calls.push("chatStart");
      sinks.set(session ?? "", on);
      return sinks.size;
    },
    chatInput: async (_id: number, i: ChatInput) => {
      s.calls.push(`input:${i.kind}`);
      if (i.kind === "send") sent.push(i.text);
    },
    chatClose: async () => {},
    removeFiles: async () => {},
  };
  const lane: SessionHost["laneBranch"] = async (_cwd, names) => {
    s.calls.push("laneBranch");
    s.made.push({ names });
    const was = s.folder.branch;
    s.folder.branch = names[0];
    return { branch: names[0], base: was };
  };
  const host = { ...base, ...(over.laneBranch === null ? {} : { laneBranch: over.laneBranch ?? lane }) } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const startIn = async (text: string, cwd = "/w/baanmali-preorder") => {
    const id = ss.draft("claude" as never);
    ss.setDraft(id, { cwd });
    await ss.start(id, text);
    return id;
  };
  const row = (id: string) => ss.getState().list.find((r) => r.id === id);
  return { ss, s, store, startIn, row, sinks, sent, emit: (id: string, e: ChatEvent) => sinks.get(id)?.(e) };
}

beforeEach(() => resetLanes());

test("makes a branch of its own as a session starts, named from the first message, before the agent runs", async () => {
  const t = await setup();
  const id = await t.startIn("Add a PromptPay QR to the checkout.");
  // the shell is asked for the folder's branch, makes the lane's, starts the agent, reads the folder's branch again for
  // the composer's foot (which now says the lane's), and only then sends the first message
  expect(t.s.calls).toEqual(["branch", "laneBranch", "chatStart", "branch", "input:send"]);
  expect(t.s.made[0].names[0]).toBe("kit/add-promptpay-qr-checkout");
  expect(t.row(id)?.lane).toEqual({ name: "kit/add-promptpay-qr-checkout", base: "main" });
  expect(t.sent).toEqual(["Add a PromptPay QR to the checkout."]);
});

test("makes a branch from a detached commit, and a name for a first message with no words", async () => {
  const t = await setup({ branch: "3e3f4c1" });
  const id = await t.startIn("👍");
  expect(t.row(id)?.lane).toEqual({ name: "kit/work", base: "3e3f4c1" });
});

test("makes none outside a repository, and the agent starts all the same", async () => {
  const t = await setup({ branch: "" });
  const id = await t.startIn("Fix the totals");
  expect(t.s.calls).toEqual(["branch", "chatStart", "branch", "input:send"]);
  expect(t.row(id)?.lane).toBeUndefined();
  expect(t.sent).toEqual(["Fix the totals"]);
});

test("starts the agent when the shell cannot make the branch", async () => {
  const t = await setup({
    laneBranch: async () => {
      throw new Error("no_commit");
    },
  });
  const id = await t.startIn("Fix the totals");
  expect(t.row(id)?.lane).toBeUndefined();
  expect(t.row(id)?.status).toBe("running");
  expect(t.sent).toEqual(["Fix the totals"]);
});

test("asks nothing of a shell that is older than lanes", async () => {
  const t = await setup({ laneBranch: null });
  const id = await t.startIn("Fix the totals");
  expect(t.s.calls).toEqual(["chatStart", "branch", "input:send"]);
  expect(t.row(id)?.lane).toBeUndefined();
});

test("joins the branch of a lane that is working in the folder, for the folder has one checkout", async () => {
  const t = await setup();
  const a = await t.startIn("Thai date format");
  t.emit(a, { event: "turn.start" });
  const b = await t.startIn("Fix stock sync with Shopee");
  expect(t.s.made).toHaveLength(1);
  expect(t.row(b)?.lane).toEqual({ name: "kit/thai-date-format", base: "main", shared: true });
});

test("a lane that waits on the person holds its branch too", async () => {
  const t = await setup();
  const a = await t.startIn("Thai date format");
  t.emit(a, { event: "approval.request", request_id: "r1", title: "Run this command?", command: "pnpm add qrcode", choices: ["deny", "once"] });
  const b = await t.startIn("Fix stock sync with Shopee");
  expect(t.row(b)?.lane).toMatchObject({ name: "kit/thai-date-format", shared: true });
});

test("makes its own branch, from where the folder is, once the lane before it has stopped", async () => {
  const t = await setup();
  const a = await t.startIn("Thai date format");
  t.emit(a, { event: "turn.start" });
  t.emit(a, { event: "turn.end", outcome: "done" });
  const b = await t.startIn("Fix stock sync with Shopee");
  expect(t.row(b)?.lane).toEqual({ name: "kit/fix-stock-sync-shopee", base: "kit/thai-date-format" });
});

test("does not share a branch across folders", async () => {
  const t = await setup();
  const a = await t.startIn("Thai date format", "/w/one");
  t.emit(a, { event: "turn.start" });
  const b = await t.startIn("Thai date format", "/w/two");
  // the fake shell has one folder; the point is that the second is planned on its own and made its own branch
  expect(t.s.made).toHaveLength(2);
  expect(t.row(b)?.lane?.shared).toBeUndefined();
});

test("teaches the lane what its test runs said, and forgets the lane when the session closes", async () => {
  const t = await setup();
  const id = await t.startIn("Fix the totals");
  const key = t.ss.chatKey(id)!;
  t.emit(id, { event: "turn.start" });
  t.emit(id, { event: "tool.start", tool_id: "t1", name: "terminal", detail: "pnpm test" });
  expect(testState(laneOf(key))).toBe("running");
  t.emit(id, { event: "tool.end", tool_id: "t1", name: "", ok: true, ms: 40, output: " Test Files  1 passed (1)\n      Tests  14 passed (14)\n" });
  expect(laneOf(key).run?.read).toEqual({ kind: "passed", passed: 14 });
  t.emit(id, { event: "rewound" });
  expect(testState(laneOf(key))).toBe("none");
  expect(laneOf(key).revertedAt).toBeTypeOf("number");
  t.ss.close(id);
  expect(laneOf(key)).toEqual({ steps: {}, changed: false });
});
