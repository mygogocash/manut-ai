// Item 139 (the sixth security read's H1): a lane the app makes runs only on an agent that asks before it acts. Grown from the
// reader's scratch test, which showed an oh-my-pi lane started with no ask mode named while the cards promised its Ask mode.
// oh-my-pi's lanes still start, and the shell holds them to its asking mode (`OMP_CHAT_ARGS` in src-tauri/src/sessions.rs, its
// overlay and settings check in omp_asks.rs, each pinned by Rust tests there). pi and OmO cannot ask, so no card, helper row,
// workflow, Ask several or outside program starts a lane on them, nothing is made for them, and the person reads why.
import { beforeEach, describe, expect, it } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { createStore, type BridgeLike } from "../state/store";
import { createSessions } from "../sessions/sessions";
import { ASK_MODE } from "../sessions/controls";
import { asksFirst, chatAgents, laneAgentNamed, NO_ASKS, opensAs, terminalAgents, type AgentInfo } from "../sessions/agents";
import type { ChatEvent, SessionHost } from "../sessions/host";
import { helperRows, resolveAgent } from "./helperAsks";
import { rowAgentWords } from "./HelpersCard";
import { askRefusal } from "./ask";
import { t } from "../i18n";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const tick = () => new Promise((r) => setTimeout(r, 0));
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const DEV = "/w/baanmali-preorder";
const laneDir = (branch: string) => `/w/.manut/lanes/baanmali-preorder/${branch.slice(4)}`;

// the agents as the shell lists them since item 139: pi and OmO only as their own terminal
const AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
  { id: "omp", label: "oh-my-pi", mode: "chat", path: "/opt/homebrew/bin/omp" },
  { id: "pi", label: "pi", mode: "terminal", path: "/opt/homebrew/bin/pi" },
  { id: "omo", label: "OmO", mode: "terminal", path: "/Users/k/.local/bin/omo" },
];

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = memory();
  resetKitProjects();
  resetKitAsks();
  resetLanes();
});

/** The sessions store over a stand-in shell that records every chat it starts and every lane folder it makes. */
function setup(agents: AgentInfo[] = AGENTS) {
  const starts: { agent: string; mode?: string }[] = [];
  const folders: string[] = [];
  let n = 0;
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => agents,
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (cwd === DEV ? "main" : "kit/x"),
    chatStart: async (agent: string, _cwd: string, _on: (e: ChatEvent) => void, _r?: string, _acc?: string, _session?: string, _s?: boolean, mode?: string) => {
      starts.push({ agent, mode });
      return ++n;
    },
    chatInput: async () => {},
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneWorktree: async (_cwd: string, names: string[]) => {
      folders.push(names[0]);
      return { branch: names[0], base: "main", dir: laneDir(names[0]), worktree: laneDir(names[0]), left: 0, from: "", local: "", config: 0, stayed: 0 } satisfies LaneMade;
    },
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  return { ss, starts, folders };
}

describe("a lane runs only on an agent that asks before it acts", () => {
  it("opens a card's lane on Claude Code in its Ask mode and on oh-my-pi, which the shell holds to its asking mode", async () => {
    const { ss, starts } = setup();
    await ss.loadAgents();
    for (const agent of ["claude", "omp"]) {
      const r = await ss.openLane({ agent, cwd: DEV, title: "From a program", first: "Run the build", from: "", program: "Claude" });
      expect(r.ok, agent).toBe(true);
      await tick();
    }
    // oh-my-pi has no mode to name from the page: its asking mode is one of the shell's own fixed arguments for it
    expect(starts).toEqual([
      { agent: "claude", mode: ASK_MODE.claude },
      { agent: "omp", mode: undefined },
    ]);
    // the card's promise is about an agent that asks, and oh-my-pi is one
    expect(asksFirst("omp")).toBe(true);
    expect(t("reach.open.note", { folder: DEV })).toContain("in its agent's Ask mode");
  });

  it("never opens a card's lane on pi or OmO: refused in the person's words, with no folder made and no agent started", async () => {
    const { ss, starts, folders } = setup();
    await ss.loadAgents();
    for (const [agent, label] of [
      ["pi", "pi"],
      ["omo", "OmO"],
    ]) {
      const r = await ss.openLane({ agent, cwd: DEV, title: "From a program", first: "Run the build", from: "", program: "Claude" });
      expect(r).toEqual({ ok: false, why: t("ss.noAskPath", { agent: label }) });
    }
    await tick();
    expect(starts).toEqual([]);
    expect(folders).toEqual([]);
    expect(t("ss.noAskPath", { agent: "pi" })).toBe("pi does not ask before it runs a command or changes a file, so Manut AI runs it only in a terminal.");
  });

  it("refuses them even from an older shell that still lists them as chats", async () => {
    const { ss, starts, folders } = setup(AGENTS.map((a) => ({ ...a, mode: "chat" as const })));
    await ss.loadAgents();
    expect((await ss.openLane({ agent: "pi", cwd: DEV, title: "x", first: "y", from: "" })).ok).toBe(false);
    expect(await ss.startWorkflowLane({ agent: "omo", cwd: DEV, workflow: "Nightly", first: "Run it" })).toBe("failed");
    await tick();
    expect(starts).toEqual([]);
    expect(folders).toEqual([]);
  });

  it("starts no workflow lane on pi or OmO", async () => {
    const { ss, starts, folders } = setup();
    await ss.loadAgents();
    for (const agent of NO_ASKS) expect(await ss.startWorkflowLane({ agent, cwd: DEV, workflow: "Nightly", first: "Run it" }), agent).toBe("failed");
    expect(await ss.startWorkflowLane({ agent: "omp", cwd: DEV, workflow: "Nightly", first: "Run it" })).not.toBe("failed");
    await tick();
    expect(starts.map((s) => s.agent)).toEqual(["omp"]);
    expect(folders).toHaveLength(1);
  });

  it("names them on a helper row and a reach card as agents that will not start, and Ask several refuses them", () => {
    for (const named of ["pi", "PI", "OmO", "omo"]) expect(resolveAgent(named, AGENTS).problem, named).toBe("noAsks");
    expect(resolveAgent("oh-my-pi", AGENTS)).toEqual({ id: "omp" });
    const { rows } = helperRows([{ title: "Tests", brief: "Run them", agent: "pi" }], { agent: "claude", models: [], efforts: [] }, AGENTS);
    expect(rows[0]).toMatchObject({ agent: "pi", problem: "noAsks", asked: "pi" });
    expect(rowAgentWords(rows[0])).toBe(`pi: ${t("helpers.noAsks")}`);
    expect(t("helpers.noAsks")).toBe("does not ask before it acts, will not start");
    const pick = (agent: string) => ({ agent, model: "", effort: "" });
    expect(askRefusal({ cwd: DEV, hasMessage: true, picks: [pick("claude"), pick("pi")], agents: AGENTS, groups: null })).toEqual({ why: "agent", agent: "pi" });
    expect(askRefusal({ cwd: DEV, hasMessage: true, picks: [pick("omo"), pick("omp")], agents: AGENTS, groups: null })).toEqual({ why: "agent", agent: "omo" });
    expect(askRefusal({ cwd: DEV, hasMessage: true, picks: [pick("claude"), pick("omp")], agents: AGENTS, groups: null })).toBeNull();
  });

  it("gives an outside program no lane on them, and offers them only in a terminal", () => {
    expect(laneAgentNamed("oh-my-pi", AGENTS)).toEqual({ id: "omp", label: "oh-my-pi" });
    expect(laneAgentNamed(" Claude Code ", AGENTS)).toEqual({ id: "claude", label: "Claude Code" });
    for (const named of ["pi", "omo", "OmO"]) expect(laneAgentNamed(named, AGENTS), named).toBeNull();
    // the same from an older shell that still lists them as chats
    expect(laneAgentNamed("pi", AGENTS.map((a) => ({ ...a, mode: "chat" as const })))).toBeNull();
    expect(chatAgents(AGENTS, []).map((a) => a.id)).toEqual(["claude", "omp"]);
    const term = terminalAgents(AGENTS, []);
    expect([...term.shown, ...term.more].map((a) => a.id).sort()).toEqual(["claude", "omo", "omp", "pi"]);
    for (const id of NO_ASKS) expect(opensAs(id, AGENTS), id).toEqual({ chat: false, terminal: true });
    expect(NO_ASKS).toEqual(["pi", "omo"]);
  });
});
