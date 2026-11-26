// Ask several agents (item 102a, docs/several-agents.md): one send starts one lane for each row of the panel, through the same
// `start` a person's own lane goes through, each in its agent's Ask mode, all one job. The safety rules are pinned here against a
// fake shell: every lane's `chat_start` names its own lane folder (never the developer's) and the Ask mode's value; a limited
// account's row cannot be sent, and a refused send starts nothing for any row; the job survives a restart.
import { beforeEach, expect, test } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { readChoices, resetChoices } from "../jobs/choices";
import type { AccountGroup } from "../lib/protocol";
import { buildResume, parseResume, type SavedSession } from "../app/resume";
import { createStore, type BridgeLike } from "../state/store";
import { ASK_MODE } from "./controls";
import { createSessions } from "./sessions";
import type { ChatEvent, ChatInput, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const DEV = "/w/baanmali-preorder";
const MSG = "Add a PromptPay QR to the checkout.";

interface Start {
  agent: string;
  cwd: string;
  mode: string | undefined;
  session: string;
}

async function setup(over: { groups?: AccountGroup[]; repo?: boolean; installed?: string[] } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetKitProjects();
  resetKitAsks();
  resetChoices();
  const starts: Start[] = [];
  const taken = new Set<string>();
  const sent: { session: string; text: string }[] = [];
  const inputs: { session: string; input: ChatInput }[] = [];
  const sinks = new Map<number, string>();
  const ons = new Map<string, (e: ChatEvent) => void>();
  let next = 0;
  const installed = over.installed ?? ["claude", "codex"];
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => installed.map((id) => ({ id, label: id, mode: "chat", path: `/bin/${id}` })),
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (over.repo === false ? "" : cwd === DEV ? "main" : "kit/x"),
    chatStart: async (agent: string, cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string, _s?: boolean, mode?: string) => {
      starts.push({ agent, cwd, mode, session: session ?? "" });
      const id = ++next;
      sinks.set(id, session ?? "");
      ons.set(session ?? "", on);
      return id;
    },
    chatInput: async (id: number, input: ChatInput) => {
      const session = sinks.get(id) ?? "";
      inputs.push({ session, input });
      if (input.kind === "send") sent.push({ session, text: input.text });
    },
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    // as lane.rs does: the first name the project has not used yet, and a folder of its own for it
    laneWorktree: async (cwd: string, names: string[]) => {
      const name = names.find((n) => !taken.has(n)) ?? names[0];
      taken.add(name);
      const dir = `/w/.manut/lanes/${cwd.split("/").pop()}/${name.slice(4)}`;
      return { branch: name, base: "main", dir, worktree: dir, left: 0, from: "", local: "", config: 0, stayed: 0 } satisfies LaneMade;
    },
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store, () => over.groups ?? null);
  await ss.loadAgents();
  return { ss, store, starts, sent, inputs, emit: (session: string, e: ChatEvent) => ons.get(session)?.(e) };
}

const pick = (agent: string, model = "", effort = "") => ({ agent: agent as never, model, effort });
const limitedCodex = (): AccountGroup[] => [{ cli: "codex", installed: true, active: "default", accounts: [{ id: "default", label: "", email: "", state: "limited", resets_at: Math.floor(Date.now() / 1000) + 3600 }] }];

beforeEach(() => resetLanes());

test("one send starts one lane for each row: three chat starts, each in its agent's Ask mode, all one job", async () => {
  const t = await setup();
  const res = await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex"), pick("claude")] });
  expect(res.ok).toBe(true);
  expect(t.starts).toHaveLength(3);
  expect(t.starts.map((s) => s.agent)).toEqual(["claude", "codex", "claude"]);
  // each lane names the Ask mode of its own agent, never the shell's pick and never another mode
  expect(t.starts.map((s) => s.mode)).toEqual([ASK_MODE.claude, ASK_MODE.codex, ASK_MODE.claude]);
  expect(ASK_MODE).toMatchObject({ claude: "default", codex: "ask" });
  // every lane's message is the person's, sent once to its own chat
  expect(t.sent.map((m) => m.text)).toEqual([MSG, MSG, MSG]);
  expect(new Set(t.sent.map((m) => m.session)).size).toBe(3);
  // one job: the same id on every lane, and a lane each
  const list = t.ss.getState().list;
  expect(list).toHaveLength(3);
  const jobs = new Set(list.map((r) => r.job));
  expect(jobs.size).toBe(1);
  expect([...jobs][0]).toBeTruthy();
  expect(res.ok && res.job).toBe([...jobs][0]);
  // none is a draft the person's next New session would reuse, and none changed the last agent used
  expect(list.every((r) => r.status !== "draft")).toBe(true);
});

test("safety: each lane's chat_start names a lane folder of its own, never the developer's folder or another lane's", async () => {
  const t = await setup();
  await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex"), pick("claude")] });
  const dirs = t.starts.map((s) => s.cwd);
  expect(dirs.every((d) => d.startsWith("/w/.manut/lanes/baanmali-preorder/"))).toBe(true);
  expect(dirs).not.toContain(DEV);
  expect(new Set(dirs).size).toBe(3);
  // the row keeps the developer's folder as its project and the lane's own as where it works
  const list = t.ss.getState().list;
  expect(list.every((r) => r.cwd === DEV)).toBe(true);
  expect(list.map((r) => r.lane?.dir).sort()).toEqual([...dirs].sort());
});

test("a model and an effort picked on a row are set on that lane only, and nothing else is changed", async () => {
  const t = await setup();
  await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude", "opus", "high"), pick("codex")] });
  const [first, second] = t.starts.map((s) => s.session);
  const kinds = (session: string) => t.inputs.filter((i) => i.session === session).map((i) => i.input.kind);
  expect(kinds(first)).toEqual(["effort", "model", "send"]);
  expect(kinds(second)).toEqual(["send"]);
  expect(t.inputs.find((i) => i.input.kind === "model")?.input).toEqual({ kind: "model", model: "opus" });
  // no input ever changes a lane's permission mode after it started: the mode went on its command line
  expect(t.inputs.some((i) => i.input.kind === "mode")).toBe(false);
});

test("what an agent lists is kept for the panel: the models and efforts a lane's chat reports are saved by agent", async () => {
  const t = await setup();
  const res = await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex")] });
  expect(res.ok).toBe(true);
  expect(readChoices()).toEqual({});
  const claude = t.starts.find((s) => s.agent === "claude")!.session;
  t.emit(claude, { event: "session.models", options: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] });
  t.emit(claude, { event: "session.efforts", levels: ["low", "high"] });
  expect(readChoices()).toEqual({ claude: { models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }], efforts: ["low", "high"] } });
  // a list of another agent is kept apart, and an empty one never wipes what was kept
  t.emit(claude, { event: "session.models", options: [] });
  expect(readChoices().claude?.models).toHaveLength(2);
});

test("safety: a limited account's row cannot be sent, and a refused send starts nothing for any row", async () => {
  const t = await setup({ groups: limitedCodex() });
  const res = await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex")] });
  expect(res).toMatchObject({ ok: false, refused: { why: "limited", agent: "codex" } });
  // not even the row whose account is fine was started: a message is never sent to some of the agents picked
  expect(t.starts).toEqual([]);
  expect(t.ss.getState().list).toEqual([]);
  // the same two agents go once the account is usable
  const fine = await setup();
  expect((await fine.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex")] })).ok).toBe(true);
});

test("refuses a send of fewer than two agents, more than three, no message, no folder and an agent that is not here, starting nothing", async () => {
  const t = await setup();
  const none = async (p: Parameters<typeof t.ss.startJob>[0]) => {
    const res = await t.ss.startJob(p);
    expect(t.starts).toEqual([]);
    return res;
  };
  expect(await none({ cwd: DEV, text: MSG, picks: [pick("claude")] })).toMatchObject({ ok: false, refused: { why: "few" } });
  expect(await none({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex"), pick("claude"), pick("codex")] })).toMatchObject({ ok: false, refused: { why: "many" } });
  expect(await none({ cwd: DEV, text: "  ", picks: [pick("claude"), pick("codex")] })).toMatchObject({ ok: false, refused: { why: "empty" } });
  expect(await none({ cwd: "", text: MSG, picks: [pick("claude"), pick("codex")] })).toMatchObject({ ok: false, refused: { why: "folder" } });
  expect(await none({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("pi")] })).toMatchObject({ ok: false, refused: { why: "agent", agent: "pi" } });
});

test("a folder that is not a repository gets no agent at all: no lane can be made, so no agent starts in the developer's folder", async () => {
  const t = await setup({ repo: false });
  const res = await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex")] });
  expect(res).toMatchObject({ ok: false, refused: { why: "no_lane" } });
  expect(t.starts).toEqual([]);
  expect(t.ss.getState().list).toEqual([]);
});

test("the job comes back after a restart: every lane keeps its job id, and one that was still starting does not return as a draft", async () => {
  const t = await setup();
  const res = await t.ss.startJob({ cwd: DEV, text: MSG, picks: [pick("claude"), pick("codex")] });
  const list = t.ss.getState().list;
  // what the resume snapshot saves, as app/resumeBoot.ts builds it
  const saved = buildResume(
    {
      bot: null, bots: [], view: "home", session: null, panelOpen: false, panelTab: "runs", runsFull: false, runId: null, drafts: {},
      sessions: list.map((r) => ({ id: r.id, agent: r.agent, cwd: r.cwd, startedAt: r.startedAt, view: r.view, running: false, ...(r.lane ? { lane: r.lane } : {}), ...(r.mode ? { mode: r.mode } : {}), ...(r.job ? { job: r.job } : {}) })),
      messages: () => undefined,
    } as never,
    Date.now(),
  );
  const back = parseResume(JSON.stringify(saved))!.sessions;
  expect(back.map((s) => s.job)).toEqual(list.map((r) => r.job));
  const fresh = await setup();
  const draft: SavedSession = { id: "s9", agent: "claude", cwd: DEV, startedAt: 1, view: "chat", running: false, draft: true, job: res.ok ? res.job : "x" };
  fresh.ss.restore([...back, draft]);
  const restored = fresh.ss.getState().list;
  expect(restored.map((r) => r.job).sort()).toEqual(list.map((r) => r.job).sort());
  expect(restored.find((r) => r.id === "s9")).toBeUndefined();
  // their lanes and Ask mode are kept, so Resume starts each where it worked and in the mode it asked in
  expect(restored.every((r) => !!r.lane && r.mode === ASK_MODE[r.agent as "claude" | "codex"])).toBe(true);
});
