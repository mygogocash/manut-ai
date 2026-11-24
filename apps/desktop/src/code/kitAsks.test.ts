// Kit's dial on a real sessions store and app store, with a stand-in for the shell: an ask the dial settles goes
// through the ask's own card (the chat shows it, settled), never rings or notifies, and every other ask waits on the
// person with Kit's words on its card. Every key here is plainly fake.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessions } from "../sessions/sessions";
import type { ChatEvent, ChatInput, SessionHost } from "../sessions/host";
import { createStore, type ApprovalItem, type BridgeLike } from "../state/store";
import type { AskTool, BridgeEvent, EventOf } from "../lib/protocol";
import { askOfItem, kitAnswer, kitAnswered, kitCard, keysIn, resetKitAsks } from "./kitAsks";
import { addRule, kitProjects, projectOf, resetKitProjects, setLevel, updateKitProjects } from "./project";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const ROOT = "/w/baanmali-preorder";
const FAKE_KEY = "sk-FAKE0000000000000000TEST";

async function session() {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const sinks = new Map<number, (e: ChatEvent) => void>();
  const inputs: ChatInput[] = [];
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    start: async () => 99,
    write: async () => {},
    resize: async () => {},
    close: async () => {},
    branch: async () => "kit/promptpay-qr",
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void) => {
      sinks.set(1, on);
      return 1;
    },
    chatInput: async (_id: number, i: ChatInput) => {
      inputs.push(i);
      if (i.kind === "send") sinks.get(1)!({ event: "turn.start" });
    },
    chatClose: async () => {},
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  const told: BridgeEvent[] = [];
  ss.setNotify((ev) => told.push(ev));
  await ss.loadAgents();
  const id = ss.draft("claude");
  ss.setDraft(id, { cwd: ROOT });
  await ss.start(id, "Add a PromptPay QR to the checkout");
  const key = ss.chatKey(id)!;
  const emit = (e: ChatEvent) => sinks.get(1)!(e);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const ask = async (request_id: string, title: string, command: string, tool?: AskTool) => {
    emit({ event: "approval.request", request_id, title, command, cwd: ROOT, choices: ["deny", "once", "session"], ...(tool ? { tool } : {}) } as unknown as ChatEvent);
    await settle();
    await settle();
    return store.getState().chats[key]!.items.find((i) => i.kind === "approval" && i.request_id === request_id) as ApprovalItem;
  };
  const answers = () => inputs.filter((i) => i.kind === "approve");
  return { store, key, emit, ask, answers, told };
}

const asked = (request_id: string, title: string, command: string) =>
  ({ event: "approval.request", bot: "", request_id, title, command, cwd: ROOT, choices: ["deny", "once", "session"] }) as EventOf<"approval.request">;

describe("Kit's dial on a coding session's asks", () => {
  beforeEach(() => {
    resetKitProjects();
    resetKitAsks();
  });
  afterEach(() => {
    resetKitProjects();
    resetKitAsks();
  });

  it("runs the tests alone, through the ask's own card, and tells nobody", async () => {
    const s = await session();
    const card = await s.ask("r1", "Run this command?", "pnpm test");
    expect(card.resolved).toBe("once");
    expect(s.answers()).toEqual([{ kind: "approve", request_id: "r1", choice: "once" }]);
    expect(kitAnswered(s.key, "r1")).toEqual({ by: "reads" });
    expect(s.told.some((e) => e.event === "approval.request")).toBe(false);
  });

  it("asks the person before an install, with what it does and the rule it would keep", async () => {
    const s = await session();
    const card = await s.ask("r2", "Run this command?", "pnpm add qrcode");
    expect(card.resolved).toBeUndefined();
    expect(s.answers()).toEqual([]);
    expect(s.told.some((e) => e.event === "approval.request")).toBe(true);
    expect(kitCard(asked("r2", "Run this command?", "pnpm add qrcode"), { chat: s.key, root: ROOT, home: "/w" })).toEqual({
      root: ROOT,
      say: { key: "kit.say.add1" },
      always: { words: ["pnpm", "add"] },
      keys: [],
    });
  });

  it("lets a command go alone once its rule is kept, and says so", async () => {
    updateKitProjects((p) => addRule(p, ROOT, { words: ["pnpm", "add"] }));
    const s = await session();
    const card = await s.ask("r3", "Run this command?", "pnpm add dayjs");
    expect(card.resolved).toBe("once");
    expect(kitAnswered(s.key, "r3")).toEqual({ by: "rule" });
    // a kept rule is no longer offered
    expect(kitCard(asked("r3", "Run this command?", "pnpm add dayjs"), { chat: s.key, root: ROOT, home: "/w" })?.always).toBeNull();
  });

  it("edits alone from Edits alone up, and names the level", async () => {
    updateKitProjects((p) => setLevel(p, ROOT, "edits_alone"));
    const s = await session();
    const card = await s.ask("r4", "Allow Edit to change src/checkout.tsx?", "");
    expect(card.resolved).toBe("once");
    expect(kitAnswered(s.key, "r4")).toEqual({ by: "dial", level: "edits_alone" });
  });

  it("denies a read outside the project, and lists it with the folder that would allow it", async () => {
    const s = await session();
    const card = await s.ask("r5", "Allow Read?", "/w/Documents/tax-2026.xlsx");
    expect(card.resolved).toBe("deny");
    expect(s.answers()).toEqual([{ kind: "approve", request_id: "r5", choice: "deny" }]);
    expect(kitAnswered(s.key, "r5")).toEqual({ by: "blocked", project: "baanmali-preorder" });
    expect(projectOf(kitProjects(), ROOT).blocked).toMatchObject([{ what: "read", path: "/w/Documents/tax-2026.xlsx", folder: "/w/Documents" }]);
  });

  it("asks before a commit while the session's changes hold a key, at every level", async () => {
    updateKitProjects((p) => setLevel(p, ROOT, "everything_in_project"));
    const s = await session();
    expect((await s.ask("r6", "Run this command?", "git commit -m 'Add the QR'")).resolved).toBe("once");
    s.emit({ event: "tool.diff", tool_id: "t1", files: [{ path: "src/config.ts", kind: "update", lines: [`+export const KEY = "${FAKE_KEY}";`], added: 1, removed: 0 }] } as unknown as ChatEvent);
    expect(keysIn(s.key)).toEqual(["src/config.ts"]);
    const card = await s.ask("r7", "Run this command?", "git commit -m 'Add the QR'");
    expect(card.resolved).toBeUndefined();
    const shown = kitCard(asked("r7", "Run this command?", "git commit -m 'Add the QR'"), { chat: s.key, root: ROOT, home: "/w" });
    expect(shown).toEqual({ root: ROOT, say: { key: "kit.say.commit" }, always: null, keys: ["src/config.ts"] });
    expect(JSON.stringify(shown)).not.toContain(FAKE_KEY);
  });

  it("asks before going live, whatever the level", async () => {
    updateKitProjects((p) => setLevel(p, ROOT, "everything_in_project"));
    const s = await session();
    const card = await s.ask("r8", "Run this command?", "wrangler deploy");
    expect(card.resolved).toBeUndefined();
    expect(kitCard(asked("r8", "Run this command?", "wrangler deploy"), { chat: s.key, root: ROOT, home: "/w" })).toEqual({ root: ROOT, say: { key: "kit.say.live" }, always: null, keys: [] });
  });

  it("leaves an ask its words do not cover as it always was", async () => {
    const s = await session();
    const card = await s.ask("r9", "Allow WebFetch?", "https://example.com");
    expect(card.resolved).toBeUndefined();
    expect(kitCard(asked("r9", "Allow WebFetch?", "https://example.com"), { chat: s.key, root: ROOT, home: "/w" })).toBeNull();
  });
});

describe("Kit's dial on what the shell names of an ask", () => {
  beforeEach(() => {
    resetKitProjects();
    resetKitAsks();
  });
  afterEach(() => {
    resetKitProjects();
    resetKitAsks();
  });
  const ctx = (chat: string) => ({ chat, root: ROOT, home: "/w" });
  const bash = (line: string): AskTool => ({ kind: "command", name: "Bash", line, cwd: ROOT });

  it("runs the tests alone through the card, and the card keeps what the shell named", async () => {
    const s = await session();
    const card = await s.ask("t1", "Run this command?", "pnpm test", bash("pnpm test"));
    expect(card.resolved).toBe("once");
    expect(kitAnswered(s.key, "t1")).toEqual({ by: "reads" });
    expect(card.tool).toEqual(bash("pnpm test"));
  });

  it("asks the person before a command on two lines that goes live, which its card shows as one line of tests", async () => {
    updateKitProjects((p) => setLevel(p, ROOT, "everything_in_project"));
    const s = await session();
    const card = await s.ask("t2", "Run this command?", "pnpm test git push origin main", bash("pnpm test\ngit push origin main"));
    expect(card.resolved).toBeUndefined();
    expect(s.answers()).toEqual([]);
    // the open card is read from what the store kept of it
    expect(kitCard(askOfItem(s.key, card), ctx(s.key))).toEqual({ root: ROOT, say: { key: "kit.say.live" }, always: null, keys: [] });
  });

  it("blocks a change outside the project that the title's cut list hid, and lists it", async () => {
    updateKitProjects((p) => setLevel(p, ROOT, "everything_in_project"));
    const s = await session();
    const paths = [...Array.from({ length: 12 }, (_, i) => `${ROOT}/src/f${i}.ts`), "/w/elsewhere/z.ts"];
    const card = await s.ask("t3", "Allow Codex to change src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts, src/f5.ts, src/f6.ts, s…?", "", { kind: "edit", paths, cwd: ROOT });
    expect(card.resolved).toBe("deny");
    expect(kitAnswered(s.key, "t3")).toEqual({ by: "blocked", project: "baanmali-preorder" });
    expect(projectOf(kitProjects(), ROOT).blocked).toMatchObject([{ what: "edit", path: "/w/elsewhere/z.ts", folder: "/w/elsewhere" }]);
  });

  it("does not let a kept rule cover a second command on the next line", async () => {
    updateKitProjects((p) => addRule(p, ROOT, { words: ["pnpm", "add"] }));
    const s = await session();
    expect((await s.ask("t4", "Run this command?", "pnpm add dayjs", bash("pnpm add dayjs"))).resolved).toBe("once");
    const card = await s.ask("t5", "Run this command?", "pnpm add dayjs rm -rf src", bash("pnpm add dayjs\nrm -rf src"));
    expect(card.resolved).toBeUndefined();
    expect(kitCard(askOfItem(s.key, card), ctx(s.key))?.always).toBeNull();
  });

  it("leaves to the person an ask whose tool names no line, and never reads its words instead", async () => {
    const s = await session();
    const card = await s.ask("t6", "Run this command?", "pnpm test", { kind: "command", name: "Bash", cwd: ROOT });
    expect(card.resolved).toBeUndefined();
    expect(kitCard(askOfItem(s.key, card), ctx(s.key))).toBeNull();
  });
});

describe("Kit's dial for a lane in a folder of its own", () => {
  const LANE = "/w/.manut/lanes/baanmali-preorder/promptpay-qr";
  const ctx = { chat: "agent:s9", root: LANE, project: ROOT, home: "/w" };
  const edit = (request_id: string, path: string, cwd = LANE) =>
    ({ event: "approval.request", bot: "", request_id, title: `Allow Edit to change ${path}?`, command: "", cwd, choices: ["deny", "once", "session"], tool: { kind: "edit", name: "Edit", paths: [path], cwd } }) as EventOf<"approval.request">;
  beforeEach(() => {
    resetKitProjects();
    resetKitAsks();
  });
  afterEach(() => {
    resetKitProjects();
    resetKitAsks();
  });

  it("reads inside the lane's own folder at the project's level, and keeps nothing under the lane's folder", () => {
    updateKitProjects((p) => setLevel(p, ROOT, "edits_alone"));
    expect(kitAnswer(edit("r1", `${LANE}/src/checkout.tsx`), ctx)).toEqual({ choice: "once", answer: { by: "dial", level: "edits_alone" } });
    expect(Object.keys(kitProjects())).toEqual([ROOT]);
  });

  it("stops a change in the developer's own folder, and lists it under the project as the lane's", () => {
    updateKitProjects((p) => setLevel(p, ROOT, "everything_in_project"));
    expect(kitAnswer(edit("r2", `${ROOT}/src/checkout.tsx`), ctx)).toEqual({ choice: "deny", answer: { by: "blocked", project: "baanmali-preorder" } });
    expect(projectOf(kitProjects(), ROOT).blocked).toMatchObject([{ what: "edit", path: `${ROOT}/src/checkout.tsx`, lane: true }]);
    // another lane's folder is outside it too
    expect(kitAnswer(edit("r3", "/w/.manut/lanes/baanmali-preorder/thai-date/src/a.ts"), ctx)?.choice).toBe("deny");
    // a session with no folder of its own is not a lane: what it stops is the project's own words
    expect(kitAnswer(edit("r4", "/w/Documents/a.ts", ROOT), { chat: "agent:s8", root: ROOT, home: "/w" })?.choice).toBe("deny");
    expect(projectOf(kitProjects(), ROOT).blocked.find((b) => b.path === "/w/Documents/a.ts")?.lane).toBeUndefined();
  });

  it("keeps Always allow's rule for the project, which every lane of it reads", () => {
    const card = kitCard({ ...asked("r5", "Run this command?", "pnpm add qrcode"), cwd: LANE }, ctx);
    expect(card).toMatchObject({ root: ROOT, always: { words: ["pnpm", "add"] } });
    updateKitProjects((p) => addRule(p, ROOT, { words: ["pnpm", "add"] }));
    expect(kitAnswer({ ...asked("r6", "Run this command?", "pnpm add qrcode"), cwd: LANE }, ctx)).toEqual({ choice: "once", answer: { by: "rule" } });
  });
});
