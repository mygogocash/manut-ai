// Rewind to before a turn through the sessions themselves (sessions.ts, rewind.ts), against a stand-in shell whose
// snapshots are the browser stand-in's pretend folder (turnFiles.ts): each turn keeps its files before its message
// goes out, a rewind puts back the files and then the chat, and a refusal puts the files back as they were.
import { expect, test } from "vitest";
import { createSessions } from "./sessions";
import { createStore, type BridgeLike } from "../state/store";
import { MockTurnFiles, type MockTurnGlobals, type TurnFilesHost } from "./turnFiles";
import { RewindError } from "./rewind";
import type { ChatEvent, ChatInput, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

async function setup(agent = "claude", answer: "rewound" | "refused" = "rewound") {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  let sink: (e: ChatEvent) => void = () => {};
  const inputs: ChatInput[] = [];
  const g: MockTurnGlobals = {};
  const files = new MockTurnFiles(g);
  // the calls the sessions make to the shell's snapshots, in order
  const calls: string[] = [];
  const turnFiles = new Proxy(files, {
    get(target, name: string) {
      const f = (target as unknown as Record<string, unknown>)[name];
      return typeof f === "function" ? (...args: unknown[]) => (calls.push(name), (f as (...a: unknown[]) => unknown).apply(target, args)) : f;
    },
  }) as TurnFilesHost;
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: agent, label: agent, mode: "chat", path: `/bin/${agent}` }],
    home: async () => "/w",
    pickFolder: async () => null,
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void) => {
      sink = on;
      return 1;
    },
    chatInput: async (_id: number, i: ChatInput) => {
      inputs.push(i);
      if (i.kind === "send") sink({ event: "turn.start" });
      // the shell's adapters answer a rewind to a turn as agent_chat.rs does
      if (i.kind === "rewind_to")
        setTimeout(() => {
          if (answer === "refused") sink({ event: "session.error", message: "Not taken back: busy" });
          else sink({ event: "rewound", id: i.id });
        }, 0);
    },
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    branch: async () => "",
    turnFiles,
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const id = ss.draft(agent as never);
  ss.setDraft(id, { cwd: "/w/shop" });
  await ss.start(id, "Fix stock sync with Shopee");
  const key = ss.chatKey(id)!;
  const chat = () => store.getState().chats[key]!;
  const row = (text: string) => chat().items.find((i) => i.kind === "user" && i.text === text) as { id: string } | undefined;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const end = async () => {
    sink({ event: "turn.end", outcome: "done" });
    await tick();
  };
  return { ss, id, key, chat, row, inputs, calls, end, tick, store, folder: () => g.__manutMockFolders!["/w/shop"] };
}

test("each turn keeps its files before its message goes out; Rewind puts back the files, then the chat", async () => {
  const t = await setup();
  // the first message: a new process forgets what an earlier one kept, then the turn's files are kept
  expect(t.calls).toEqual(["forget", "take"]);
  await t.end();
  await t.ss.send(t.id, "PromptPay QR at checkout");
  await t.end();
  expect(t.calls).toEqual(["forget", "take", "end", "take", "end"]);
  const first = t.row("Fix stock sync with Shopee")!.id;
  expect(t.ss.turns.marksOf(t.id).map((m) => m.id)).toEqual([first, t.row("PromptPay QR at checkout")!.id]);
  // the person changes a file by hand after the last turn
  t.folder()["README.md"] = "# changed by hand\n";
  const p = await t.ss.turns.preview(t.id, first);
  expect(p.back.map((c) => c.path)).toEqual(["README.md", "notes/turn-1.md", "notes/turn-2.md"]);
  expect(p.hand).toEqual(["README.md"]);
  const done = await t.ss.rewindTo(t.id, first, ["README.md"]);
  expect(done.changed).toBe(2);
  expect(t.inputs.at(-1)).toEqual({ kind: "rewind_to", id: first });
  // the turns' notes went; the change made by hand stayed, as the person chose
  expect(Object.keys(t.folder()).sort()).toEqual(["README.md", "src/checkout.tsx"]);
  expect(t.folder()["README.md"]).toBe("# changed by hand\n");
  // the chat is back to before that message: its words wait in the box, and a line says what went back
  expect(t.chat().items.filter((i) => i.kind === "user")).toEqual([]);
  expect(t.store.getState().ui.draft).toMatchObject({ bot: t.key, text: "Fix stock sync with Shopee" });
  expect(t.chat().items.at(-1)).toMatchObject({ kind: "system", text: "Rewound to before “Fix stock sync with Shopee”. 2 files are back as they were." });
  expect(t.ss.turns.marksOf(t.id)).toEqual([]);
});

test("when the agent refuses, the files go back as they were and the chat keeps its turns", async () => {
  const t = await setup("codex", "refused");
  await t.end();
  const first = t.row("Fix stock sync with Shopee")!.id;
  const before = { ...t.folder() };
  const e = await t.ss.rewindTo(t.id, first, []).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(RewindError);
  expect((e as RewindError).message).toBe("Not taken back: busy");
  expect((e as RewindError).filesBack).toBe(true);
  expect(t.folder()).toEqual(before);
  expect(t.row("Fix stock sync with Shopee")).toBeDefined();
  expect(t.ss.turns.marksOf(t.id).map((m) => m.id)).toEqual([first]);
});

test("an agent that cannot take its chat back keeps no turn's files, and closing a session drops its turns", async () => {
  const pi = await setup("pi");
  expect(pi.calls).toEqual(["forget"]);
  expect(pi.ss.turns.marksOf(pi.id)).toEqual([]);
  const t = await setup();
  t.ss.close(t.id);
  await t.tick();
  expect(t.calls.at(-1)).toBe("forget");
  expect(t.ss.turns.marksOf(t.id)).toEqual([]);
});
