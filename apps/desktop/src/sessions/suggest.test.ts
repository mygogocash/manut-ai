// The sessions store's side of the suggested next message (item 76): a chat asks its agent for suggestions only when the setting is on
// and the agent can give one, the agent's `suggestion` event goes to the composer's store and not to the timeline, and a new turn
// drops it.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessions } from "./sessions";
import { createStore, type BridgeLike } from "../state/store";
import type { ChatEvent, SessionHost } from "./host";
import { setSuggestOn } from "../lib/suggest";
import { resetSuggestions, suggestionFor } from "../chat/suggestion";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

function setup(agent: "claude" | "codex") {
  const asked: (boolean | undefined)[] = [];
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
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, _s?: string, suggest?: boolean) => {
      asked.push(suggest);
      const id = ++next;
      sinks.set(id, on);
      return id;
    },
    chatInput: async () => {},
    chatClose: async () => {},
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  return { ss, store, asked, emit: (e: ChatEvent) => sinks.get(1)!(e) };
}

async function started(agent: "claude" | "codex") {
  const t = setup(agent);
  await t.ss.loadAgents();
  const id = t.ss.draft(agent);
  t.ss.setDraft(id, { cwd: "/w/proj" });
  await t.ss.start(id, "hi");
  return { ...t, key: t.ss.chatKey(id)! };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  resetSuggestions();
});
afterEach(() => {
  setSuggestOn(false);
  vi.unstubAllGlobals();
});

test("a chat is started asking for suggestions only when the setting is on and the agent can give one", async () => {
  expect((await started("claude")).asked).toEqual([false]);
  setSuggestOn(true);
  expect((await started("claude")).asked).toEqual([true]);
  // Codex has no way to ask, so it is never started as if it had
  expect((await started("codex")).asked).toEqual([false]);
});

test("the agent's suggestion goes to the composer's store and stays out of the timeline, and a new turn drops it", async () => {
  setSuggestOn(true);
  const t = await started("claude");
  t.emit({ event: "turn.start" });
  t.emit({ event: "turn.end", outcome: "done" });
  const before = t.store.getState().chats[t.key]!.items.length;
  t.emit({ event: "suggestion", text: "Now add a test for the empty cart" });
  expect(suggestionFor(t.key)).toBe("Now add a test for the empty cart");
  expect(t.store.getState().chats[t.key]!.items.length).toBe(before);
  t.emit({ event: "turn.start" });
  expect(suggestionFor(t.key)).toBeNull();
});

test("a suggestion that arrives after the person turned the setting off is dropped", async () => {
  setSuggestOn(true);
  const t = await started("claude");
  setSuggestOn(false);
  t.emit({ event: "suggestion", text: "Now add a test" });
  setSuggestOn(true);
  expect(suggestionFor(t.key)).toBeNull();
});
