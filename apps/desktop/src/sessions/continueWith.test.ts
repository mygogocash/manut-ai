// Continue with… (item 97): a coding chat handed to another agent or model. The rules (continueWith.ts), then the sessions store
// against a fake shell: a new chat in the same lane, linked both ways, its context above the box, and no turn started; one
// working agent in the lane; the old chat stopped only when idle and asked.
import { beforeEach, describe, expect, test } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { createStore, type BridgeLike } from "../state/store";
import { getCarried, setCarryStorage } from "../chat/box/carry";
import { createSessions } from "./sessions";
import type { ChatEvent, ChatInput, SessionHost } from "./host";
import type { AgentInfo, SessionRec } from "./agents";
import { continuedDraft, continuePicks, laneFree, linkedOf } from "./continueWith";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const DEV = "/w/baanmali-preorder";
const LANE = "/w/.manut/lanes/baanmali-preorder/fix-totals";

const rec = (over: Partial<SessionRec> = {}): SessionRec => ({ id: "s1", linkId: "L1", agent: "claude", cwd: DEV, startedAt: 1, status: "running", view: "chat", ...over });
const AGENTS = [
  { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
  { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
] as AgentInfo[];

describe("the rules", () => {
  test("offers the chat's own other models first, then every other agent that chats", () => {
    const picks = continuePicks(rec({ model: "Opus" }), AGENTS, [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
    ]);
    expect(picks).toEqual([{ agent: "claude", model: { id: "sonnet", label: "Sonnet" } }, { agent: "codex" }]);
    expect(continuePicks(rec(), AGENTS, undefined)).toEqual([{ agent: "codex" }]);
  });

  test("a continued chat is a draft in the same folder and lane, linked, its own agent keeping the account", () => {
    const old = rec({ lane: { name: "kit/fix-totals", base: "main", dir: LANE, worktree: LANE }, account: "work", startedAs: "Work" });
    const same = continuedDraft(old, { agent: "claude", model: { id: "sonnet", label: "Sonnet" } }, { id: "s2", linkId: "L2", now: 5 });
    expect(same).toEqual({ id: "s2", linkId: "L2", agent: "claude", cwd: DEV, startedAt: 5, status: "draft", view: "chat", lane: old.lane, continuedFrom: "L1", account: "work", startedAs: "Work", modelWant: "sonnet" });
    const other = continuedDraft(old, { agent: "codex" }, { id: "s3", linkId: "L3", now: 5 });
    expect(other.account).toBeUndefined();
    expect(other.startedAs).toBeUndefined();
    expect(other.lane).toBe(old.lane);
  });

  test("links both ways, and keeps a lane's folder until the last chat in it closes", () => {
    const a = rec({ continuedIn: "L2", lane: { name: "b", base: "main", dir: LANE, worktree: LANE } });
    const b = rec({ id: "s2", linkId: "L2", continuedFrom: "L1", lane: a.lane });
    const c = rec({ id: "s3", linkId: "L3", lane: { name: "c", base: "main", dir: "/w/x", worktree: "/w/x" } });
    expect(linkedOf([a, b, c], a)).toEqual([b]);
    expect(linkedOf([a, b, c], b)).toEqual([a]);
    expect(linkedOf([a, b, c], c)).toEqual([]);
    expect(laneFree([a, b, c], a)).toBe(false);
    expect(laneFree([a, c], a)).toBe(true);
    expect(laneFree([a, b], { id: "s9" })).toBe(true);
  });
});

async function setup() {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetKitProjects();
  resetKitAsks();
  const calls: string[] = [];
  const started: string[] = [];
  const inputs: { id: string; input: ChatInput }[] = [];
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const ids = new Map<number, string>();
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => AGENTS,
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (cwd === DEV ? "main" : "kit/fix-totals"),
    chatStart: async (agent: string, cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      calls.push(`chatStart:${agent}`);
      started.push(cwd);
      sinks.set(session ?? "", on);
      ids.set(sinks.size, session ?? "");
      return sinks.size;
    },
    chatInput: async (n: number, i: ChatInput) => {
      calls.push(`input:${i.kind}`);
      inputs.push({ id: ids.get(n) ?? "", input: i });
    },
    chatClose: async () => {
      calls.push("chatClose");
    },
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneWorktree: async (cwd: string, names: string[]) => {
      calls.push("laneWorktree");
      return { branch: names[0], base: "main", dir: LANE, worktree: LANE, left: 0, from: "", local: "", config: 0, stayed: 0 } satisfies LaneMade;
    },
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const id = ss.draftChat("claude" as never, DEV);
  await ss.start(id, "Fix the totals");
  const row = (x: string) => ss.getState().list.find((r) => r.id === x)!;
  return { ss, store, calls, started, inputs, id, row, emit: (x: string, e: ChatEvent) => sinks.get(x)?.(e) };
}

describe("in the sessions store", () => {
  beforeEach(() => {
    resetLanes();
    const mem = new Map<string, string>();
    setCarryStorage({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) });
  });

  test("makes a new chat in the same lane, linked both ways, with the context above its box, and starts no turn", async () => {
    const t = await setup();
    const before = [...t.calls];
    const n = t.ss.continueWith(t.id, { agent: "codex" }, { title: "Fix the totals", text: "Context of the old chat", ref: `session:${t.id}`, scope: {} })!;
    expect(n).toBeTruthy();
    // nothing ran: no agent started, nothing sent, no second folder made
    expect(t.calls).toEqual(before);
    expect(t.row(n)).toMatchObject({ status: "draft", agent: "codex", cwd: DEV, lane: { worktree: LANE }, continuedFrom: t.row(t.id).linkId });
    expect(t.row(t.id).continuedIn).toBe(t.row(n).linkId);
    // the old chat is left as it is
    expect(t.row(t.id).status).toBe("running");
    expect(getCarried(`agent:${n}`)).toEqual([expect.objectContaining({ kind: "thread", title: "Fix the totals", text: "Context of the old chat" })]);
    expect(t.store.getState().ui.session).toBe(n);
    // the person's own New session never takes it over
    const d = t.ss.draft("claude" as never);
    expect(d).not.toBe(n);
    expect(t.row(n).agent).toBe("codex");
  });

  test("the new chat's agent starts in the shared lane on the person's first message, no second folder, its model set first", async () => {
    const t = await setup();
    const n = t.ss.continueWith(t.id, { agent: "claude", model: { id: "sonnet", label: "Sonnet" } })!;
    await t.ss.start(n, "Go on from here");
    expect(t.calls.filter((c) => c === "laneWorktree")).toHaveLength(1);
    expect(t.started).toEqual([LANE, LANE]);
    const mine = t.inputs.filter((x) => x.id === n).map((x) => x.input);
    expect(mine.map((i) => i.kind)).toEqual(["model", "send"]);
    expect(mine[0]).toMatchObject({ model: "sonnet" });
    expect(t.row(n).modelWant).toBeUndefined();
  });

  test("one working agent in a lane: each chat waits while the other works", async () => {
    const t = await setup();
    const n = t.ss.continueWith(t.id, { agent: "codex" })!;
    t.emit(t.id, { event: "turn.start" });
    expect(t.ss.waitsFor(n)?.id).toBe(t.id);
    expect(await t.ss.start(n, "Go on")).toBe(false);
    expect(t.calls.filter((c) => c.startsWith("chatStart"))).toEqual(["chatStart:claude"]);
    expect(t.row(n).status).toBe("draft");
    t.emit(t.id, { event: "turn.end", outcome: "done" });
    expect(t.ss.waitsFor(n)).toBeNull();
    expect(await t.ss.start(n, "Go on")).toBe(true);
    // now the new one works, and the old one waits
    t.emit(n, { event: "turn.start" });
    expect(t.ss.waitsFor(t.id)?.id).toBe(n);
    expect(await t.ss.send(t.id, "me too")).toBe(false);
    t.emit(n, { event: "turn.end", outcome: "done" });
    expect(await t.ss.send(t.id, "me too")).toBe(true);
  });

  test("stops the old chat only while it is idle, when the person asks", async () => {
    const t = await setup();
    t.ss.continueWith(t.id, { agent: "codex" });
    t.emit(t.id, { event: "turn.start" });
    expect(await t.ss.stopIdle(t.id)).toBe(false);
    expect(t.row(t.id).status).toBe("running");
    t.emit(t.id, { event: "turn.end", outcome: "done" });
    expect(await t.ss.stopIdle(t.id)).toBe(true);
    expect(t.calls).toContain("chatClose");
    expect(t.row(t.id).status).toBe("exited");
  });

  test("continues only a chat that has started", async () => {
    const t = await setup();
    const d = t.ss.draft("claude" as never);
    expect(t.ss.continueWith(d, { agent: "codex" })).toBeNull();
  });
});
