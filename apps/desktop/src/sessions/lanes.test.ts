// A coding session's lane (src/code/): the branch of its own and the folder of its own that are made as the session starts,
// and what its events teach the lane, against a fake shell. The lane's rules are tested in src/code/lane.test.ts and
// laneBranch.test.ts; this is the sessions store keeping them: in what order the shell is asked, where the agent works, what
// is kept on the row and in the lane, and the folder letting go when the session closes.
import { beforeEach, expect, test } from "vitest";
import { laneOf, resetLanes } from "../code/laneStore";
import { testState } from "../code/lane";
import { kitProjects, resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade, LaneRemoveAsk } from "../code/laneBranch";
import { createStore, type BridgeLike } from "../state/store";
import { createSessions } from "./sessions";
import type { ChatEvent, ChatInput, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

const DEV = "/w/baanmali-preorder";

interface Setup {
  /** The branch each folder is on: the developer's never moves; a lane's folder is on its own branch. */
  folders: Record<string, string>;
  calls: string[];
  made: { cwd: string; names: string[] }[];
  /** The folder each agent was started in. */
  started: string[];
  removed: { worktree: string; ask: LaneRemoveAsk }[];
}

/** The folder the fake shell makes for a lane, as lane.rs names it. */
const laneDir = (branch: string, cwd = DEV) => `/w/.manut/lanes/${cwd.split("/").pop()}/${branch.slice(4)}`;

async function setup(over: { branch?: string; left?: number; laneWorktree?: SessionHost["laneWorktree"] | null } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetKitProjects();
  resetKitAsks();
  const s: Setup = { folders: { [DEV]: over.branch ?? "main", "/w/one": "main", "/w/two": "main" }, calls: [], made: [], started: [], removed: [] };
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const sent: string[] = [];
  const inputs: ChatInput[] = [];
  const base = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => {
      s.calls.push("branch");
      return s.folders[cwd] ?? "";
    },
    chatStart: async (_a: string, cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      s.calls.push("chatStart");
      s.started.push(cwd);
      sinks.set(session ?? "", on);
      return sinks.size;
    },
    chatInput: async (_id: number, i: ChatInput) => {
      s.calls.push(`input:${i.kind}`);
      inputs.push(i);
      if (i.kind === "send") sent.push(i.text);
    },
    chatClose: async () => {
      s.calls.push("chatClose");
    },
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneRemove: async (worktree: string, ask: LaneRemoveAsk) => {
      s.calls.push("laneRemove");
      s.removed.push({ worktree, ask });
      return { removed: true, deleted: false, changed: null, ahead: null, error: null };
    },
  };
  const lane: SessionHost["laneWorktree"] = async (cwd, names) => {
    s.calls.push("laneWorktree");
    s.made.push({ cwd, names });
    const dir = laneDir(names[0], cwd);
    // the lane's folder is on its own branch; the developer's stays where it was
    s.folders[dir] = names[0];
    return { branch: names[0], base: s.folders[cwd], dir, worktree: dir, left: over.left ?? 0 } satisfies LaneMade;
  };
  const host = { ...base, ...(over.laneWorktree === null ? {} : { laneWorktree: over.laneWorktree ?? lane }) } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const startIn = async (text: string, cwd = DEV) => {
    const id = ss.draft("claude" as never);
    ss.setDraft(id, { cwd });
    await ss.start(id, text);
    return id;
  };
  const row = (id: string) => ss.getState().list.find((r) => r.id === id);
  const notes = (id: string) => (store.getState().chats[ss.chatKey(id)!]?.items ?? []).flatMap((i) => (i.kind === "system" ? [i.text] : []));
  return { ss, s, store, startIn, row, sinks, sent, inputs, notes, emit: (id: string, e: ChatEvent) => sinks.get(id)?.(e) };
}

beforeEach(() => resetLanes());

test("makes a folder of its own as a session starts, named from the first message, and the agent works there", async () => {
  const t = await setup();
  const id = await t.startIn("Add a PromptPay QR to the checkout.");
  // the shell is asked for the folder's branch, makes the lane's folder, starts the agent in it, reads the branch of the
  // folder the agent works in for the composer's foot, and only then sends the first message
  expect(t.s.calls).toEqual(["branch", "laneWorktree", "chatStart", "branch", "input:send"]);
  expect(t.s.made).toEqual([{ cwd: DEV, names: expect.arrayContaining(["kit/add-promptpay-qr-checkout"]) }]);
  const dir = laneDir("kit/add-promptpay-qr-checkout");
  expect(t.row(id)?.lane).toEqual({ name: "kit/add-promptpay-qr-checkout", base: "main", dir, worktree: dir });
  expect(t.s.started).toEqual([dir]);
  // the session stays the project's: its folder is the developer's, which stays on its own branch
  expect(t.row(id)?.cwd).toBe(DEV);
  expect(t.s.folders[DEV]).toBe("main");
  expect(t.ss.getState().live[id]?.branch).toBe("kit/add-promptpay-qr-checkout");
  expect(t.sent).toEqual(["Add a PromptPay QR to the checkout."]);
});

test("the chat says where the lane works and what did not come along", async () => {
  const t = await setup({ left: 3 });
  const id = await t.startIn("Fix the totals");
  const [said] = t.notes(id);
  expect(said).toContain(`Kit works on kit/fix-totals in a folder of its own, made from main: ${laneDir("kit/fix-totals")}.`);
  expect(said).toContain("3 changed files in your folder did not come along: Kit starts from the last commit on main.");
  expect(said).toContain("Nothing is installed in it yet. Kit asks before it installs anything.");
  const quiet = await setup();
  expect(quiet.notes(await quiet.startIn("Fix the totals"))[0]).not.toContain("did not come along");
});

test("makes a lane from a detached commit, and a name for a first message with no words", async () => {
  const t = await setup({ branch: "3e3f4c1" });
  const id = await t.startIn("👍");
  expect(t.row(id)?.lane).toMatchObject({ name: "kit/work", base: "3e3f4c1" });
});

test("makes none outside a repository, and the agent starts in the session's folder all the same", async () => {
  const t = await setup({ branch: "" });
  const id = await t.startIn("Fix the totals");
  expect(t.s.calls).toEqual(["branch", "chatStart", "branch", "input:send"]);
  expect(t.row(id)?.lane).toBeUndefined();
  expect(t.s.started).toEqual([DEV]);
  expect(t.sent).toEqual(["Fix the totals"]);
});

test("starts the agent in the session's folder when the shell cannot make the lane's", async () => {
  const t = await setup({
    laneWorktree: async () => {
      throw new Error("no_commit");
    },
  });
  const id = await t.startIn("Fix the totals");
  expect(t.row(id)?.lane).toBeUndefined();
  expect(t.row(id)?.status).toBe("running");
  expect(t.s.started).toEqual([DEV]);
  expect(t.sent).toEqual(["Fix the totals"]);
});

test("asks nothing of a shell that is older than lanes' folders", async () => {
  const t = await setup({ laneWorktree: null });
  const id = await t.startIn("Fix the totals");
  expect(t.s.calls).toEqual(["chatStart", "branch", "input:send"]);
  expect(t.row(id)?.lane).toBeUndefined();
});

test("two lanes work at once in one project, each in its own folder made from the developer's branch", async () => {
  const t = await setup();
  const a = await t.startIn("Thai date format");
  t.emit(a, { event: "turn.start" });
  const b = await t.startIn("Fix stock sync with Shopee");
  expect(t.s.made).toHaveLength(2);
  expect(t.row(a)?.lane).toMatchObject({ name: "kit/thai-date-format", base: "main", dir: laneDir("kit/thai-date-format") });
  // never joined to the working lane, never stacked on it
  expect(t.row(b)?.lane).toMatchObject({ name: "kit/fix-stock-sync-shopee", base: "main", dir: laneDir("kit/fix-stock-sync-shopee") });
  expect(t.s.started).toEqual([laneDir("kit/thai-date-format"), laneDir("kit/fix-stock-sync-shopee")]);
  t.emit(a, { event: "turn.end", outcome: "done" });
  const c = await t.startIn("Rename the pre-order page");
  expect(t.row(c)?.lane).toMatchObject({ base: "main" });
  expect(t.s.folders[DEV]).toBe("main");
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

test("a test run in the developer's folder is not the lane's", async () => {
  const t = await setup();
  const id = await t.startIn("Fix the totals");
  const key = t.ss.chatKey(id)!;
  t.emit(id, { event: "turn.start" });
  t.emit(id, { event: "tool.start", tool_id: "t1", name: "terminal", detail: `cd ${DEV} && pnpm test` });
  expect(testState(laneOf(key))).toBe("none");
  t.emit(id, { event: "tool.end", tool_id: "t1", name: "", ok: true, ms: 40, command: `cd ${DEV} && pnpm test`, output: "      Tests  14 passed (14)\n" });
  expect(laneOf(key).run).toBeUndefined();
  // run in the lane's own folder, it is
  t.emit(id, { event: "tool.start", tool_id: "t2", name: "terminal", detail: "cd src && pnpm test" });
  t.emit(id, { event: "tool.end", tool_id: "t2", name: "", ok: true, ms: 40, output: "      Tests  14 passed (14)\n" });
  expect(laneOf(key).run?.read).toEqual({ kind: "passed", passed: 14 });
});

test("closing a lane's session lets its folder go once the agent stopped, when nothing in it would be lost", async () => {
  const t = await setup();
  const id = await t.startIn("Fix the totals");
  const lane = t.row(id)!.lane!;
  t.ss.close(id);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  // the shell is told nothing may be lost and the branch stays: a folder with changes in it is kept
  expect(t.s.removed).toEqual([{ worktree: lane.worktree, ask: { changed: 0, branch: false, ahead: null } }]);
  expect(t.s.calls.indexOf("laneRemove")).toBeGreaterThan(t.s.calls.indexOf("chatClose"));
  // a session with no folder of its own asks nothing
  const plain = await setup({ branch: "" });
  plain.ss.close(await plain.startIn("Fix the totals"));
  await new Promise((r) => setTimeout(r, 0));
  expect(plain.s.removed).toEqual([]);
});

test("the dial reads a lane's asks inside its own folder, and the developer's folder is outside it", async () => {
  const t = await setup();
  const id = await t.startIn("Fix the totals");
  const dir = t.row(id)!.lane!.dir!;
  // a change in the developer's folder: stopped as it is asked, and noted under the project as a lane's
  t.emit(id, { event: "approval.request", request_id: "r1", title: `Allow Edit to change ${DEV}/src/a.ts?`, command: "", choices: ["deny", "once"], tool: { kind: "edit", name: "Edit", paths: [`${DEV}/src/a.ts`], cwd: dir } });
  await new Promise((r) => setTimeout(r, 0));
  expect(t.inputs).toContainEqual({ kind: "approve", request_id: "r1", choice: "deny" });
  expect(kitProjects()[DEV]?.blocked).toEqual([expect.objectContaining({ what: "edit", path: `${DEV}/src/a.ts`, lane: true })]);
  // a change in its own folder is inside: at the lowest level it waits on the person, and nothing is noted
  t.emit(id, { event: "approval.request", request_id: "r2", title: `Allow Edit to change ${dir}/src/a.ts?`, command: "", choices: ["deny", "once"], tool: { kind: "edit", name: "Edit", paths: [`${dir}/src/a.ts`], cwd: dir } });
  await new Promise((r) => setTimeout(r, 0));
  expect(t.inputs.filter((i) => i.kind === "approve")).toHaveLength(1);
  expect(kitProjects()[DEV]?.blocked).toHaveLength(1);
  expect(kitProjects()[dir]).toBeUndefined();
});

test("a lane that comes back after a restart works in its own folder again, never in the developer's", async () => {
  const t = await setup();
  const dir = laneDir("kit/fix-totals");
  t.ss.restore([
    { id: "s7", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: true, agentSession: "c0ffee00-1111-4222-8333-444444444444", lane: { name: "kit/fix-totals", base: "main", dir, worktree: dir } },
  ]);
  expect(t.row("s7")?.lane).toEqual({ name: "kit/fix-totals", base: "main", dir, worktree: dir });
  expect(t.row("s7")?.paused).toBe(true);
  await t.ss.resume("s7");
  expect(t.s.started).toEqual([dir]);
});
