// The id the shell gave a coding chat (`chatIdOf`), which what keeps running (src/running/) names a chat's commands by, as
// `ptyOf` names a terminal's: none before the chat started, what the shell answered once it did, and none for a session
// that is no chat of the shell's. A fake shell stands in; `answer` is what its `chat_start` says.
import { expect, test } from "vitest";
import { createStore, type BridgeLike } from "../state/store";
import { createSessions } from "./sessions";
import type { SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

async function setup(answer: () => number) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async () => "main",
    chatStart: async () => answer(),
    chatInput: async () => {},
    chatClose: async () => {},
    removeFiles: async () => {},
  } as unknown as SessionHost;
  const ss = createSessions(host, () => createStore(bridge));
  await ss.loadAgents();
  return {
    ss,
    /** A coding chat in `cwd`, started with `text`. */
    startIn: async (cwd: string, text: string) => {
      const id = ss.draft("claude" as never);
      ss.setDraft(id, { cwd });
      await ss.start(id, text);
      return id;
    },
  };
}

test("a coding chat has the id the shell answered once it started, and none before", async () => {
  const { ss, startIn } = await setup(() => 7);
  const draft = ss.draft("claude" as never);
  ss.setDraft(draft, { cwd: "/w/baanmali-preorder" });
  // a draft runs nothing
  expect(ss.chatIdOf(draft)).toBeNull();
  const id = await startIn("/w/baanmali-preorder", "Add a PromptPay QR to the checkout.");
  expect(ss.chatIdOf(id)).toBe(7);
  // a chat has no pty, and a session nobody started has no chat
  expect(ss.ptyOf(id)).toBeNull();
  expect(ss.chatIdOf("s999")).toBeNull();
});

test("each chat keeps the id the shell gave it, as the shell numbers them", async () => {
  let n = 0;
  const { ss, startIn } = await setup(() => ++n);
  const a = await startIn("/w/one", "first");
  const b = await startIn("/w/two", "second");
  expect([ss.chatIdOf(a), ss.chatIdOf(b)]).toEqual([1, 2]);
});
