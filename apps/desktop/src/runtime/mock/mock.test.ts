// The in-process runtime answers the protocol the way the screens expect: staged team, scripted turns, asks that
// settle once. The last test runs the real store on it, which is the claim this whole seam exists for: the app
// starts and can be used with no bridge, no Hermes and no other process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { createStore, selectAsks, selectSidebarBots } from "../../state/store";
import { MockHost, MockRuntime } from "./index";
import { BOT_SEED } from "./seed";

const T0 = 1_800_000_000;

/** A fresh runtime with its own clock, connected, and every event it sends. */
async function open(host = new MockHost({ now: () => T0 })) {
  const rt = new MockRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((e) => events.push(e));
  await rt.connect();
  return { rt, host, events, names: () => events.map((e) => e.event) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the in-process runtime", () => {
  it("opens without dialling anything and refuses requests while closed", async () => {
    const rt = new MockRuntime(new MockHost());
    const seen: string[] = [];
    rt.onStatus((s) => seen.push(s));
    await expect(rt.request("hello")).rejects.toMatchObject({ code: "disconnected" });
    await rt.connect();
    expect(rt.status).toBe("open");
    expect(seen).toEqual(["connecting", "open"]);
    expect(await rt.request("hello")).toMatchObject({ bridge: "mock" });
    rt.close();
    expect(rt.status).toBe("closed");
    await expect(rt.request("bots.list")).rejects.toMatchObject({ code: "disconnected" });
  });

  it("has none of the optional feature groups, and still answers their reads", async () => {
    const { rt } = await open();
    expect(rt.kind).toBe("mock");
    expect(Object.values(rt.capabilities)).toEqual([false, false, false, false, false]);
    expect(await rt.request("automations.list", {})).toEqual({ automations: [] });
    expect(await rt.request("elsewhere.list", { bot: "buddy" })).toEqual({ sessions: [] });
    expect(await rt.request("plugins.list", { bot: "buddy" })).toEqual({ plugins: [] });
    expect(await rt.request("accounts.list", {})).toEqual({ groups: [] });
    expect(await rt.request("usage.read", {})).toEqual({ providers: [] });
    await expect(rt.request("automations.add", { bot: "buddy", name: "n", schedule: "30m", prompt: "p" })).rejects.toMatchObject({ code: "unsupported" });
    await expect((rt.request.bind(rt) as unknown as (op: string) => Promise<unknown>)("no.such.op")).rejects.toMatchObject({ code: "unknown_op" });
  });

  it("lists Buddy first as the default, then the team, each with a chat that opens", async () => {
    const { rt } = await open();
    const { bots } = await rt.request("bots.list", {});
    expect(bots.map((b) => b.name)).toEqual(BOT_SEED.map((b) => b.name));
    expect(bots[0]).toMatchObject({ name: "buddy", display_name: "Buddy", is_default: true, status: "online", running: false });
    for (const b of bots) {
      const chat = await rt.request("chat.open", { bot: b.name });
      expect(chat).toMatchObject({ session_id: `main-${b.name}`, running: false, model: b.model, provider: b.provider });
    }
    await expect(rt.request("chat.open", { bot: "nobody" })).rejects.toMatchObject({ code: "unknown_bot" });
  });

  it("plays a whole turn for a member's message: status, tools, streamed text, the answer, the end", async () => {
    const { rt, names, events } = await open();
    await rt.request("chat.send", { bot: "nam", text: "what needs me today?" });
    expect(names()).toEqual(["bot.status", "turn.start"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(names()).toEqual([
      "bot.status", "turn.start", "status", "thinking", "tool.start", "tool.end", "tool.start", "tool.end", "thinking",
      "delta", "delta", "delta", "message", "turn.end", "bot.status",
    ]);
    const answer = events.find((e) => e.event === "message");
    const streamed = events.filter((e) => e.event === "delta").map((e) => (e.event === "delta" ? e.text : "")).join("");
    expect(answer?.event === "message" && answer.text).toBe(streamed);
    expect(events.at(-2)).toMatchObject({ event: "turn.end", outcome: "done" });
    // the chat now holds both sides
    const { messages } = await rt.request("chat.open", { bot: "nam" });
    expect(messages.slice(-2).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("an approval names the exact action, waits, and settles once", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "nam", text: "/approve" });
    await vi.advanceTimersByTimeAsync(400);
    const ask = events.find((e) => e.event === "approval.request");
    if (ask?.event !== "approval.request") throw new Error("no approval was asked");
    expect(ask.command).toContain("Khun Mali");
    expect(ask.choices).toEqual(["once", "session", "always", "deny"]);
    // nothing happens while it waits
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.some((e) => e.event === "turn.end")).toBe(false);
    // the wrong chat cannot answer it, and a bad choice is refused
    await expect(rt.request("approval.respond", { bot: "pim", request_id: ask.request_id, choice: "once" })).rejects.toMatchObject({ code: "not_found" });
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "maybe" as "once" })).rejects.toMatchObject({ code: "bad_request" });
    await rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "once" });
    // a second answer, from a second window say, finds nothing to settle
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "deny" })).rejects.toMatchObject({ code: "not_found" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.filter((e) => e.event === "message").map((e) => (e.event === "message" ? e.text : ""))).toEqual(["Sent the reply (approved: once)."]);
    expect(events.filter((e) => e.event === "turn.end")).toEqual([expect.objectContaining({ outcome: "done" })]);
  });

  it("a denied approval ends the turn with nothing sent", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "nam", text: "/approve" });
    await vi.advanceTimersByTimeAsync(400);
    const ask = events.find((e) => e.event === "approval.request");
    if (ask?.event !== "approval.request") throw new Error("no approval was asked");
    await rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "deny" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.some((e) => e.event === "message")).toBe(false);
    expect(events.some((e) => e.event === "tool.start")).toBe(false);
    expect(events.filter((e) => e.event === "turn.end")).toEqual([expect.objectContaining({ outcome: "interrupted" })]);
  });

  it("a waiting ask is sent again when its chat is opened again", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "pim", text: "/clarify" });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.filter((e) => e.event === "clarify.request")).toHaveLength(1);
    await rt.request("chat.open", { bot: "pim" });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((e) => e.event === "clarify.request")).toHaveLength(2);
    const ask = events.find((e) => e.event === "clarify.request");
    if (ask?.event !== "clarify.request") throw new Error("no question was asked");
    await rt.request("clarify.respond", { bot: "pim", request_id: ask.request_id, answer: "Facebook" });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.filter((e) => e.event === "message").at(-1)).toMatchObject({ text: "Got it, using Facebook." });
  });

  it("an interview asks its questions at once and counts the answers given", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "/interview" });
    await vi.advanceTimersByTimeAsync(200);
    const ask = events.find((e) => e.event === "clarify.request");
    if (ask?.event !== "clarify.request") throw new Error("no interview was asked");
    expect(ask.questions?.map((q) => q.qid)).toEqual(["q1", "q2", "q3"]);
    expect(ask.questions?.[1].multi_select).toBe(true);
    await rt.request("clarify.respond", { bot: "buddy", request_id: ask.request_id, answers: { q1: "Both", q2: '["LINE"]', q3: null } });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.filter((e) => e.event === "message").at(-1)).toMatchObject({ text: "Got it, using 2 of 3 answers." });
  });

  it("Stop ends the turn and drops what was queued behind it; a message sent meanwhile waits its turn", async () => {
    const { rt, names } = await open();
    await rt.request("chat.send", { bot: "pim", text: "first" });
    expect(await rt.request("chat.steer", { bot: "pim", text: "also this" })).toEqual({ status: "queued" });
    await rt.request("chat.send", { bot: "pim", text: "second" });
    await vi.advanceTimersByTimeAsync(2_000);
    // the queued message started its own turn after the first one ended
    expect(names().filter((n) => n === "turn.start")).toHaveLength(2);
    await rt.request("chat.send", { bot: "pim", text: "third" });
    await rt.request("chat.interrupt", { bot: "pim" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(names().filter((n) => n === "turn.start")).toHaveLength(2);
    expect(names().filter((n) => n === "turn.end")).toHaveLength(2);
    // with no turn running a steer is refused, never sent another way
    expect(await rt.request("chat.steer", { bot: "pim", text: "late" })).toEqual({ status: "rejected" });
  });

  it("two helpers outlive the turn that started them and report back on their own", async () => {
    const { rt, events } = await open();
    await rt.request("chat.send", { bot: "kit", text: "/delegate fail" });
    await vi.advanceTimersByTimeAsync(700);
    expect(events.at(-2)).toMatchObject({ event: "turn.end", outcome: "done" });
    await vi.advanceTimersByTimeAsync(3_000);
    const last = events.filter((e) => e.event === "subagent").slice(-2);
    expect(last.map((e) => (e.event === "subagent" ? e.state : ""))).toEqual(["done", "failed"]);
  });

  it("threads live under a member: made, named by their first message, answered, listed, removed", async () => {
    const { rt, events } = await open();
    // the thread ops live beside the protocol's op map (src/threads/types.ts), so they are asked by name
    const req = rt.request.bind(rt) as unknown as (op: string, p: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const made = await req("thread.create", { bot: "pim", key: "k1" });
    const again = await req("thread.create", { bot: "pim", key: "k1" });
    expect(again.thread).toBe(made.thread);
    const thread = made.thread as string;
    await rt.request("chat.send", { bot: "pim", session: thread, text: "write the caption for Saturday" });
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toContainEqual({ event: "session.title", bot: "pim", session: thread, title: "write the caption for Saturday" });
    expect(events.filter((e) => e.event === "message" && e.session === thread)).toHaveLength(1);
    // a thread's turn never moves the member's own status
    expect(events.filter((e) => e.event === "bot.status")).toEqual([]);
    const { threads } = (await req("thread.list", { bot: "pim" })) as { threads: { thread: string; message_count: number; preview: string }[] };
    expect(threads).toEqual([expect.objectContaining({ thread, message_count: 2, preview: "write the caption for Saturday" })]);
    await req("thread.remove", { bot: "pim", thread });
    await vi.advanceTimersByTimeAsync(0);
    expect((events as { event: string }[]).map((e) => e.event)).toContain("thread.removed");
    expect(await req("thread.list", { bot: "pim" })).toEqual({ threads: [] });
    await expect(req("thread.open", { bot: "pim", thread })).rejects.toMatchObject({ code: "not_found" });
  });

  it("renames a member, keeps its picture, and changes its model", async () => {
    const { rt, names } = await open();
    expect(await rt.request("bots.rename", { bot: "ton", name: "  Khun   Ton " })).toEqual({ display_name: "Khun Ton" });
    expect(await rt.request("bots.rename", { bot: "ton", name: "" })).toEqual({ display_name: "Ton" });
    expect(names()).toEqual(["bots.update", "bots.update"]);
    await expect(rt.request("bots.set_avatar", { bot: "ton", data: "not a picture" })).rejects.toMatchObject({ code: "bad_request" });
    const { avatar_rev } = await rt.request("bots.set_avatar", { bot: "ton", data: "data:image/png;base64,AAAA" });
    expect(await rt.request("bots.avatar", { bot: "ton" })).toEqual({ rev: avatar_rev, data: "data:image/png;base64,AAAA" });
    const opts = await rt.request("models.options", { bot: "ton" });
    expect(opts.providers).toHaveLength(1);
    expect(await rt.request("chat.set_model", { bot: "ton", model: "demo-standard", reasoning: "low" })).toEqual({ model: "demo-standard", provider: "demo", reasoning: "low" });
    await expect(rt.request("chat.set_model", { bot: "ton", provider: "nope" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("every client of one runtime sees the same events, each with its own copy", async () => {
    const host = new MockHost({ now: () => T0 });
    const a = await open(host);
    const b = await open(host);
    await a.rt.request("chat.send", { bot: "buddy", text: "hello" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b.names()).toEqual(a.names());
    expect(b.events[0]).toEqual(a.events[0]);
    expect(b.events[0]).not.toBe(a.events[0]);
    // one client closing leaves the other connected
    a.rt.close();
    expect(await b.rt.request("hello")).toMatchObject({ bridge: "mock" });
  });
});

describe("the app's store on the in-process runtime", () => {
  it("starts, lists the whole team, shows a chat, and carries an approval from the ask to its answer", async () => {
    const rt = new MockRuntime(new MockHost({ now: () => T0 }));
    const store = createStore(rt, { now: () => T0 * 1000, firstRoster: "all" });
    await store.actions.init();
    const s = store.getState();
    expect(s.conn).toBe("open");
    expect(s.hello).toMatchObject({ bridge: "mock" });
    expect(selectSidebarBots(s).map((b) => b.display_name)).toEqual(["Buddy", "Nam", "Pim", "Ton", "Kit"]);
    expect(s.selectedBot).toBe("buddy");
    expect(s.chats.buddy.items.some((i) => i.kind === "assistant")).toBe(true);
    expect(s.lastError).toBeNull();

    await store.actions.send("/approve");
    await vi.advanceTimersByTimeAsync(400);
    const [ask] = selectAsks(store.getState());
    expect(ask).toMatchObject({ bot: "buddy" });
    expect(ask.item.kind).toBe("approval");
    await store.actions.respondApproval(ask.item.request_id, "once");
    await vi.advanceTimersByTimeAsync(1_000);
    const after = store.getState();
    expect(selectAsks(after)).toEqual([]);
    expect(after.chats.buddy.turn).toBeNull();
    expect(after.chats.buddy.items.at(-1)).toMatchObject({ kind: "assistant", text: "Sent the reply (approved: once)." });
  });
});
