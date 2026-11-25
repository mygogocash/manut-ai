// Item 89 (security review, 26 Nov 2026): a chat's permission mode is named when its agent starts, never set after it is
// already running. A new chat names none, and the shell starts the agent in its careful mode (Claude Code's Ask, Codex's
// Ask); a chat whose person picked a mode starts in it again after a Restart, with no second mode message after the start.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessions } from "./sessions";
import { createStore, type BridgeLike } from "../state/store";
import type { ChatEvent, ChatInput, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

function setup(agent: "claude" | "codex" | "pi") {
  const modes: (string | undefined)[] = [];
  const inputs: ChatInput[] = [];
  const sinks = new Map<number, (e: ChatEvent) => void>();
  let next = 0;
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: agent, label: agent, mode: "chat", path: `/bin/${agent}` }],
    home: async () => "/w",
    pickFolder: async () => null,
    start: async () => 99,
    write: async () => {},
    resize: async () => {},
    close: async () => {},
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, _s?: string, _suggest?: boolean, mode?: string) => {
      modes.push(mode);
      const id = ++next;
      sinks.set(id, on);
      return id;
    },
    chatInput: async (_id: number, i: ChatInput) => {
      inputs.push(i);
    },
    chatClose: async () => {},
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  return { ss, modes, inputs, sinks };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("a new chat names no mode, so the shell starts its agent in the careful one", async () => {
  for (const agent of ["claude", "codex", "pi"] as const) {
    const t = setup(agent);
    await t.ss.loadAgents();
    const id = t.ss.draft(agent);
    t.ss.setDraft(id, { cwd: "/w/proj" });
    await t.ss.start(id, "hi");
    expect(t.modes, agent).toEqual([undefined]);
    expect(t.inputs.map((i) => i.kind), agent).toEqual(["send"]);
  }
});

test("a mode the person picked is named again when the chat restarts, and not set again after the start", async () => {
  const t = setup("claude");
  await t.ss.loadAgents();
  const id = t.ss.draft("claude");
  t.ss.setDraft(id, { cwd: "/w/proj" });
  await t.ss.start(id, "hi");
  await t.ss.setMode(id, "plan");
  expect(t.inputs.map((i) => i.kind)).toEqual(["send", "mode"]);
  // the agent ends; Restart starts it again in the mode the person picked
  t.sinks.get(1)!({ event: "exit", code: 0 });
  await new Promise((r) => setTimeout(r, 0));
  await t.ss.restart(id);
  expect(t.modes).toEqual([undefined, "plan"]);
  expect(t.inputs.map((i) => i.kind)).toEqual(["send", "mode"]);
});
