// Buddy's chat on the session hosts: in the app, the shell's own Buddy commands (src-tauri/src/buddy_chat.rs), with only
// an agent id, Buddy's instructions and a conversation's input crossing; in a plain browser, the stand-in Claude Code on a
// list of its own, as the shell keeps Buddy's chats apart from the coding sessions.
import { describe, expect, it } from "vitest";
import { MockHost, TauriHost, type ChatEvent, type MockGlobals } from "./host";

class Host extends TauriHost {
  calls: [string, Record<string, unknown> | undefined][] = [];
  protected override async core() {
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      this.calls.push([cmd, args]);
      return cmd === "buddy_start" ? 4 : undefined;
    };
    class Channel {
      onmessage: (ev: unknown) => void = () => {};
    }
    return { invoke, Channel } as unknown as Awaited<ReturnType<TauriHost["core"]>>;
  }
}

describe("Buddy's chat in the app", () => {
  it("goes through the shell's Buddy commands, never the coding sessions' chat ones", async () => {
    const h = new Host();
    expect(await h.buddyStart("claude", "You are Buddy.", () => {})).toBe(4);
    await h.buddyInput(4, { kind: "send", text: "hi" });
    await h.buddyInput(4, { kind: "approve", request_id: "r1", choice: "once" });
    await h.buddyClose(4);
    await h.buddyCloseAll();
    expect(h.calls.map(([cmd]) => cmd)).toEqual(["buddy_start", "buddy_input", "buddy_input", "buddy_close", "buddy_close_all"]);
    expect(h.calls[0][1]).toMatchObject({ agent: "claude", prompt: "You are Buddy." });
    expect(Object.keys(h.calls[0][1] ?? {}).sort()).toEqual(["agent", "onEvent", "prompt"]);
    expect(h.calls[1][1]).toEqual({ id: 4, input: { kind: "send", text: "hi" } });
  });
});

describe("Buddy's chat in a plain browser", () => {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it("answers through the stand-in Claude Code, which says it is a stand-in, on a list apart from the sessions", async () => {
    const g: MockGlobals = {};
    const h = new MockHost(g);
    const events: ChatEvent[] = [];
    const id = await h.buddyStart("claude", "You are Buddy.", (ev) => events.push(ev));
    await h.buddyInput(id, { kind: "send", text: "hi" });
    await wait(800);
    expect(events.filter((e) => e.event === "message").map((e) => e.text)).toEqual(["(mock Claude Code) You said: hi"]);
    expect(g.__manutSessionCalls?.map((c) => c.op)).toEqual(["buddy.start", "buddy.input"]);
    // a coding session's reset leaves Buddy's chat alone; Buddy's own closes it
    await h.reset();
    await h.buddyInput(id, { kind: "send", text: "still there?" });
    await h.buddyCloseAll();
    await expect(h.buddyInput(id, { kind: "send", text: "gone" })).rejects.toThrow("no such session");
  });

  it("refuses an agent that does not answer as Buddy, or one that is not installed", async () => {
    await expect(new MockHost({}).buddyStart("codex", "You are Buddy.", () => {})).rejects.toThrow("cannot answer as Buddy");
    await expect(new MockHost({ __manutMockAgents: ["codex"] }).buddyStart("claude", "You are Buddy.", () => {})).rejects.toThrow("Claude Code is not installed");
  });

  it("says Claude Code is not signed in when a test signs it out", async () => {
    const h = new MockHost({ __manutMockBuddySignedOut: true });
    const events: ChatEvent[] = [];
    const id = await h.buddyStart("claude", "You are Buddy.", (ev) => events.push(ev));
    await h.buddyInput(id, { kind: "send", text: "hi" });
    await wait(100);
    expect(events.find((e) => e.event === "turn.end")).toMatchObject({ outcome: "error", error: expect.stringContaining("is not signed in") });
  });
});
