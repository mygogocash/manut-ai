// Let Kit merge, without a DOM: the ask goes to the project's own running lane as a message, or into a new session's box,
// and never starts an agent or answers a card. The project is the canvas's baanmali-preorder.
import { afterEach, describe, expect, it } from "vitest";
import { clearDrafts, getDraft, setDraft } from "../app/drafts";
import type { Recent, SessionRec } from "../sessions/agents";
import type { SessionsState } from "../sessions/sessions";
import { askKit, laneOf, type Lanes } from "./askKit";

const ROOT = "/Users/fon/baanmali-preorder";
const ASK = "main changed while you worked on kit/promptpay-qr. Merge main into kit/promptpay-qr.";

const rec = (id: string, over: Partial<SessionRec> = {}): SessionRec => ({ id, agent: "claude", cwd: ROOT, startedAt: 1, status: "running", view: "chat", ...over }) as SessionRec;

function lanes(list: SessionRec[], o: { chats?: string[]; recent?: Recent[] } = {}) {
  const calls: unknown[][] = [];
  const s: Lanes = {
    getState: () => ({ list, recent: o.recent ?? [] }) as unknown as SessionsState,
    chatKey: (id) => (id && (o.chats ?? list.map((r) => r.id)).includes(id) ? `agent:${id}` : null),
    send: async (id, text) => {
      calls.push(["send", id, text]);
    },
    draft: (agent) => {
      calls.push(["draft", agent]);
      return "s9";
    },
    setDraft: (id, p) => {
      calls.push(["setDraft", id, p]);
    },
  };
  return { s, calls };
}

afterEach(() => clearDrafts());

describe("the project's lane", () => {
  it("is its newest session that runs as a chat", () => {
    const { s } = lanes([rec("s3"), rec("s2"), rec("s1")]);
    expect(laneOf(s, ROOT)).toBe("s3");
  });

  it("is not a session in a terminal, a draft, an ended one, or another folder's", () => {
    const list = [rec("s5", { cwd: "/Users/fon/storefront" }), rec("s4", { status: "draft" }), rec("s3", { status: "exited" }), rec("s2"), rec("s1")];
    // s2 has no chat: it runs in its own terminal
    const { s } = lanes(list, { chats: ["s1", "s3", "s4", "s5"] });
    expect(laneOf(s, ROOT)).toBe("s1");
    expect(laneOf(lanes(list, { chats: [] }).s, ROOT)).toBeNull();
  });

  it("matches the folder however the path ends", () => {
    const { s } = lanes([rec("s1", { cwd: `${ROOT}/` })]);
    expect(laneOf(s, ROOT)).toBe("s1");
  });
});

describe("Let Kit merge", () => {
  it("sends the ask to the running lane", async () => {
    const { s, calls } = lanes([rec("s2"), rec("s1")]);
    expect(await askKit(s, ROOT, ASK)).toEqual({ how: "sent", session: "s2" });
    expect(calls).toEqual([["send", "s2", ASK]]);
  });

  it("with no lane opens a new session in the project with the ask in its box, and starts nothing", async () => {
    const { s, calls } = lanes([rec("s1", { cwd: "/Users/fon/storefront" })]);
    expect(await askKit(s, ROOT, ASK)).toEqual({ how: "drafted", session: "s9" });
    expect(calls).toEqual([["draft", undefined], ["setDraft", "s9", { cwd: ROOT }]]);
    expect(getDraft("agent:s9")).toBe(ASK);
  });

  it("opens it on the agent that last worked in the folder", async () => {
    const { s, calls } = lanes([], { recent: [{ agent: "claude", cwd: "/Users/fon/storefront", at: 3 }, { agent: "codex", cwd: ROOT, at: 2 }] });
    await askKit(s, ROOT, ASK);
    expect(calls[0]).toEqual(["draft", "codex"]);
  });

  it("keeps the words already in the box, and puts the ask after them", async () => {
    setDraft("agent:s9", "Remember to bump the version.  ");
    const { s } = lanes([]);
    await askKit(s, ROOT, ASK);
    expect(getDraft("agent:s9")).toBe(`Remember to bump the version.\n\n${ASK}`);
  });
});
