// The browser stand-in's coding agent (MockHost) takes back every message it took, as Claude Code and Codex do (agent_chat.rs keeps
// each message it took, whatever it says): a lane's scripted `/kit` turn included, so Rewind to before a turn can be walked in a
// browser (e2e/kit-bring-back.spec.ts). Its answers come on timers, so the clock is faked.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MockHost, type ChatEvent } from "./host";

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** A Claude Code chat on the stand-in host, started and booted. */
async function start() {
  const host = new MockHost({});
  const events: ChatEvent[] = [];
  const id = await host.chatStart("claude", "/w/shop", (e) => events.push(e));
  await vi.advanceTimersByTimeAsync(2_000);
  return { host, id, events };
}
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

test("a /kit message is a whole turn the agent took, so Rewind to before it is answered", async () => {
  const { host, id, events } = await start();
  await host.chatInput(id, { kind: "send", text: "/kit pass", id: "local-s1" });
  await wait(6_000);
  expect(events.some((e) => e.event === "turn.end")).toBe(true);
  events.length = 0;
  await host.chatInput(id, { kind: "rewind_to", id: "local-s1" });
  await wait(200);
  expect(events).toContainEqual({ event: "rewound", id: "local-s1" });
});

test("the agent's own rewind takes back the last /kit message, and has nothing to take back before one", async () => {
  const { host, id, events } = await start();
  await expect(host.chatInput(id, { kind: "rewind" })).rejects.toThrow("nothing to take back");
  await host.chatInput(id, { kind: "send", text: "/kit fail", id: "local-s1" });
  await wait(6_000);
  events.length = 0;
  await host.chatInput(id, { kind: "rewind" });
  await wait(200);
  expect(events).toContainEqual({ event: "rewound" });
});

test("a message it did not take is still refused, and an ordinary message is taken as before", async () => {
  const { host, id, events } = await start();
  await expect(host.chatInput(id, { kind: "rewind_to", id: "local-s9" })).rejects.toThrow("cannot take that message back here");
  await host.chatInput(id, { kind: "send", text: "Thai date format", id: "local-s2" });
  await wait(6_000);
  events.length = 0;
  await host.chatInput(id, { kind: "rewind_to", id: "local-s2" });
  await wait(200);
  expect(events).toContainEqual({ event: "rewound", id: "local-s2" });
});
