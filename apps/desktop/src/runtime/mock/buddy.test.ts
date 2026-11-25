// Buddy in Practice answers through the person's own coding agent (buddy.ts), on the in-process runtime (host.ts): the
// real answer and its streaming, the asks that settle once through approval-core, Stop, the honest words when no agent
// can answer, the demo's own commands, and the model line. The shell's side is a stand-in (buddyKit.ts) that sends what
// the shell's Claude adapter sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeEvent } from "../../lib/protocol";
import { createStore, selectAsks } from "../../state/store";
import { AgentBuddy, LIVE, noneSaid, whySaid, withBefore } from "./buddy";
import { StandInBuddyHost } from "./buddyKit";
import { MockHost, MockRuntime } from "./index";

const T0 = 1_800_000_000;
/** The shell's own words for a Claude Code that is not signed in (`CLAUDE_SIGNED_OUT` in src-tauri/src/agent_chat.rs). */
const CLAUDE_SIGNED_OUT = "Claude Code is not signed in. Sign in from Settings › Accounts (or open Terminal and run /login), then Restart.";

type Raw = (op: string, p: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function open(agent = new StandInBuddyHost()) {
  const host = new MockHost({ now: () => T0, buddy: new AgentBuddy(() => agent) });
  const rt = new MockRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((e) => events.push(e));
  await rt.connect();
  const raw = rt.request.bind(rt) as unknown as Raw;
  const of = (name: string, bot = "buddy") => events.filter((e) => e.event === name && e.bot === bot);
  const said = () => of("message").map((e) => (e.event === "message" ? e.text : ""));
  return { rt, host, agent, events, raw, of, said };
}

beforeEach(() => {
  vi.useFakeTimers();
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Buddy, with Claude Code installed and signed in", () => {
  it("names the agent as what answers, from the first read of the team", async () => {
    const { rt } = await open();
    const buddy = (await rt.request("bots.list", {})).bots.find((b) => b.name === "buddy");
    expect(buddy).toMatchObject({ model: "Claude Code", provider: "claude" });
    expect(await rt.request("chat.open", { bot: "buddy" })).toMatchObject({ model: "Claude Code", provider: "claude", reasoning: "" });
    // the picker offers what answers and nothing of the demo's
    const opts = await rt.request("models.options", { bot: "buddy" });
    expect(opts.providers).toEqual([{ slug: "claude", name: "Claude Code", models: ["Claude Code"] }]);
    expect(opts.reasoning_levels).toEqual([]);
    await expect(rt.request("chat.set_model", { bot: "buddy", model: "demo-standard", provider: "demo" })).rejects.toMatchObject({ code: "bad_request" });
    // the members are still the demo team
    expect((await rt.request("chat.open", { bot: "nam" })).model).toBe("demo-standard");
  });

  it("sends a message to the agent with Buddy's instructions, and streams its answer back as Buddy's", async () => {
    const { rt, agent, events, said } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.starts).toHaveLength(1);
    expect(agent.starts[0].agent).toBe("claude");
    const prompt = agent.starts[0].prompt;
    expect(prompt).toContain("You are Buddy, the assistant in Manut AI");
    expect(prompt).toMatch(/This is Practice mode: the sample shop is a sample shop/);
    expect(prompt).toContain("Nam (sales chat), Pim (content), Ton (books), Kit (engineer)");
    expect(prompt).toContain("Free shipping on orders over ฿800");
    // a customer's fact the owner has not confirmed is not handed to the agent
    expect(prompt).not.toContain("Closed on Mondays");
    expect(agent.sent()).toEqual(["hi"]);
    const turn = events.filter((e) => e.bot === "buddy").map((e) => e.event);
    expect(turn).toEqual(["bot.status", "turn.start", "delta", "delta", "message", "turn.end", "bot.status"]);
    expect(said()).toEqual(["Answered: hi"]);
    expect(events.find((e) => e.event === "turn.end")).toMatchObject({ outcome: "done" });
    const { messages } = await rt.request("chat.open", { bot: "buddy" });
    expect(messages.slice(-2).map((m) => [m.role, m.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Answered: hi"],
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/sample answer/i);
  });

  it("keeps one agent for each conversation: the next message in it goes to the same one, a thread has its own", async () => {
    const { rt, agent, raw, events } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "first" });
    await vi.advanceTimersByTimeAsync(1_500);
    await rt.request("chat.send", { bot: "buddy", text: "second" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.starts).toHaveLength(1);
    expect(agent.sent(1)).toEqual(["first", "second"]);
    const { thread } = await raw("thread.create", { bot: "buddy", key: "k1" });
    await rt.request("chat.send", { bot: "buddy", session: thread as string, text: "in a thread" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.starts).toHaveLength(2);
    expect(agent.sent(2)).toEqual(["in a thread"]);
    expect(events.filter((e) => e.event === "message" && e.session === thread).map((e) => (e.event === "message" ? e.text : ""))).toEqual(["Answered: in a thread"]);
    const opened = await raw("thread.open", { bot: "buddy", thread });
    expect(opened).toMatchObject({ model: "Claude Code" });
    // removing the thread stops its agent
    await raw("thread.remove", { bot: "buddy", thread });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.closed).toEqual([2]);
  });

  it(`keeps at most ${LIVE} agents, closes the idle one used longest ago, and hands a new one what was said`, async () => {
    const { rt, agent, raw } = await open();
    const threads: string[] = [];
    for (const k of ["a", "b", "c"]) {
      const { thread } = await raw("thread.create", { bot: "buddy", key: k });
      threads.push(thread as string);
      await rt.request("chat.send", { bot: "buddy", session: thread as string, text: `hello ${k}` });
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(agent.starts).toHaveLength(3);
    expect(agent.closed).toEqual([1]);
    // thread a again: a new agent, which hears the conversation so far before the new message
    await rt.request("chat.send", { bot: "buddy", session: threads[0], text: "and now?" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.starts).toHaveLength(4);
    const first = agent.sent(4)[0];
    expect(first).toContain("Owner: hello a");
    expect(first).toContain("Buddy: Answered: hello a");
    expect(first.endsWith("The owner's new message:\nand now?")).toBe(true);
  });

  it("Stop stops the agent's answer and ends the turn; what the agent says after it is dropped", async () => {
    const { rt, agent, of, said } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "write me a long story" });
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "turn.start" });
    agent.emit(1, { event: "delta", text: "Once upon" });
    await rt.request("chat.interrupt", { bot: "buddy" });
    await vi.advanceTimersByTimeAsync(10);
    expect(agent.inputs.at(-1)?.input).toEqual({ kind: "interrupt" });
    agent.emit(1, { event: "message", id: "m1", text: "Once upon a time" });
    agent.emit(1, { event: "turn.end", outcome: "interrupted" });
    expect(of("turn.end").map((e) => (e.event === "turn.end" ? e.outcome : ""))).toEqual(["interrupted"]);
    expect(said()).toEqual([]);
  });

  it("refuses a steer while the agent answers, so the app sends that message next instead of losing it", async () => {
    const { rt, agent } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "first" });
    expect(await rt.request("chat.steer", { bot: "buddy", text: "and this" })).toEqual({ status: "rejected" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.sent()).toEqual(["first"]);
  });

  it("an agent's ask is Buddy's card: yes once or no, settled once through approval-core, and only then sent to the agent", async () => {
    const { rt, agent, of, said } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "list my Mobbin collections" });
    await vi.advanceTimersByTimeAsync(10);
    const tool = { kind: "other", name: "mcp__mobbin__list_collections", server: "mobbin", cwd: "/home/you/.manut/buddy/chat" };
    agent.emit(1, { event: "turn.start" });
    agent.emit(1, { event: "approval.request", request_id: "agent-r1", title: "Allow List Collections from mobbin?", command: "task_intent: list them", whole: true, choices: ["deny", "once", "session"], tool });
    const [ask] = of("approval.request");
    if (ask?.event !== "approval.request") throw new Error("no card");
    expect(ask).toMatchObject({ title: "Allow List Collections from mobbin?", command: "task_intent: list them", whole: true, choices: ["once", "deny"], tool });
    expect(ask.request_id).not.toBe("agent-r1");
    // nothing reaches the agent while it waits, and a standing yes is not offered
    expect(agent.inputs.filter((x) => x.input.kind === "approve")).toEqual([]);
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: ask.request_id, choice: "session" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(rt.request("approval.respond", { bot: "nam", request_id: ask.request_id, choice: "once" })).rejects.toMatchObject({ code: "not_found" });
    await rt.request("approval.respond", { bot: "buddy", request_id: ask.request_id, choice: "once" });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.inputs.filter((x) => x.input.kind === "approve").map((x) => x.input)).toEqual([{ kind: "approve", request_id: "agent-r1", choice: "once" }]);
    // a second answer, from a second window say, finds nothing to settle and sends the agent nothing
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: ask.request_id, choice: "deny" })).rejects.toMatchObject({ code: "not_found" });
    expect(agent.inputs.filter((x) => x.input.kind === "approve")).toHaveLength(1);
    agent.emit(1, { event: "message", id: "m1", text: "You have 3 collections." });
    agent.emit(1, { event: "turn.end", outcome: "done" });
    expect(said()).toEqual(["You have 3 collections."]);
  });

  it("an ask the agent takes back, or one left when its turn ends, leaves the card and can no longer be answered", async () => {
    const { rt, agent, of } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "do two things" });
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "approval.request", request_id: "a1", title: "Run this command?", command: "ls", choices: ["deny", "once", "session"] });
    agent.emit(1, { event: "approval.request", request_id: "a2", title: "Allow Write to change notes.txt?", command: "", choices: ["deny", "once", "session"] });
    const [one, two] = of("approval.request").map((e) => (e.event === "approval.request" ? e.request_id : ""));
    agent.emit(1, { event: "prompt.expired", request_id: "a1", reason: "cancelled" });
    expect(of("prompt.expired")).toEqual([expect.objectContaining({ request_id: one, reason: "cancelled" })]);
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: one, choice: "once" })).rejects.toMatchObject({ code: "not_found" });
    agent.emit(1, { event: "turn.end", outcome: "done" });
    expect(of("prompt.expired").map((e) => (e.event === "prompt.expired" ? e.request_id : ""))).toEqual([one, two]);
    await expect(rt.request("approval.respond", { bot: "buddy", request_id: two, choice: "once" })).rejects.toMatchObject({ code: "not_found" });
    expect(agent.inputs.filter((x) => x.input.kind === "approve")).toEqual([]);
  });

  it("a question the agent asks is answered once and goes back to it", async () => {
    const { rt, agent, of } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "plan a sale" });
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "clarify.request", request_id: "q-agent", question: "Which day?", choices: ["Saturday", "Sunday"] });
    const [q] = of("clarify.request");
    if (q?.event !== "clarify.request") throw new Error("no question");
    expect(q).toMatchObject({ question: "Which day?", choices: ["Saturday", "Sunday"] });
    await rt.request("clarify.respond", { bot: "buddy", request_id: q.request_id, answer: "Saturday" });
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.inputs.at(-1)?.input).toEqual({ kind: "clarify", request_id: "q-agent", answer: "Saturday" });
    await expect(rt.request("clarify.respond", { bot: "buddy", request_id: q.request_id, answer: "Sunday" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("in the app's store, the agent's ask is in Needs you and its card's Allow once reaches the agent", async () => {
    const agent = new StandInBuddyHost();
    agent.answer = null;
    const rt = new MockRuntime(new MockHost({ now: () => T0, buddy: new AgentBuddy(() => agent) }));
    const store = createStore(rt, { now: () => T0 * 1000, firstRoster: "all" });
    await store.actions.init();
    await store.actions.send("send the restock order to the supplier");
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "approval.request", request_id: "r9", title: "Allow Send Email from gmail?", command: "to: supplier@example.com\nbody: 40 jasmine candles", whole: true, choices: ["deny", "once", "session"], tool: { kind: "other", name: "mcp__gmail__send_email", server: "gmail" } });
    await vi.advanceTimersByTimeAsync(0);
    const [ask] = selectAsks(store.getState());
    expect(ask).toMatchObject({ bot: "buddy" });
    if (ask.item.kind !== "approval") throw new Error("not an approval");
    expect(ask.item.command).toContain("40 jasmine candles");
    await store.actions.respondApproval(ask.item.request_id, "once");
    await vi.advanceTimersByTimeAsync(0);
    expect(agent.inputs.at(-1)?.input).toEqual({ kind: "approve", request_id: "r9", choice: "once" });
    expect(selectAsks(store.getState())).toEqual([]);
  });

  it("keeps the demo's own commands for the sample shop, and sends any other slash command (a skill) to the agent", async () => {
    const { rt, agent, of } = await open();
    await rt.request("chat.send", { bot: "buddy", text: "/approve" });
    await vi.advanceTimersByTimeAsync(400);
    expect(of("approval.request")[0]).toMatchObject({ command: expect.stringContaining("Khun Mali") });
    expect(agent.starts).toEqual([]);
    await rt.request("chat.interrupt", { bot: "buddy" });
    await rt.request("chat.send", { bot: "buddy", text: "/approvals-report" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.sent()).toEqual(["/approvals-report"]);
  });
});

describe("Buddy, when no agent can answer", () => {
  it("with no coding agent installed, says so and what to do, and never answers as if it could", async () => {
    const { rt, agent, of, said } = await open(new StandInBuddyHost([]));
    expect((await rt.request("bots.list", {})).bots.find((b) => b.name === "buddy")).toMatchObject({ model: "No coding agent", provider: "" });
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(100);
    expect(agent.starts).toEqual([]);
    expect(said()).toEqual([t("buddy.none", { cmd: "claude auth login" })]);
    expect(said()[0]).toMatch(/Claude Code works: its install line is in the Code page's \+ menu, under More agents/);
    expect(of("turn.end")).toEqual([expect.objectContaining({ outcome: "error" })]);
    expect(said().join(" ")).not.toMatch(/sample answer|You said/i);
  });

  it("with only Codex, says Codex is there but cannot answer as Buddy yet", async () => {
    const { rt, said } = await open(new StandInBuddyHost(["codex"]));
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(100);
    expect(said()[0]).toContain("Codex is on this computer, but I cannot answer through it yet.");
  });

  it("with Claude Code signed out, says to sign in with its own command", async () => {
    const { rt, agent, of, said } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "turn.start" });
    agent.emit(1, { event: "turn.end", outcome: "error", error: CLAUDE_SIGNED_OUT });
    expect(said()).toEqual(["Claude Code is not signed in, so I cannot answer yet. Run claude auth login in a terminal and sign in, then send your message again."]);
    expect(of("turn.end")).toEqual([expect.objectContaining({ outcome: "error" })]);
  });

  it("with a Claude Code too old for Buddy's start, says to update it", async () => {
    const { rt, agent, said } = await open();
    agent.answer = null;
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(10);
    agent.emit(1, { event: "exit", code: 1, error: "error: unknown option '--append-system-prompt-file'" });
    expect(said()).toEqual(["Claude Code on this computer is too old to answer as Buddy. Update it with npm i -g @anthropic-ai/claude-code, then send your message again."]);
    // the next message starts a new agent
    agent.answer = (text) => `Answered: ${text}`;
    await rt.request("chat.send", { bot: "buddy", text: "again" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(agent.starts).toHaveLength(2);
  });

  it("says in the person's language, and in the agent's own words, why it could not answer", () => {
    setLang("ko");
    expect(whySaid("claude", CLAUDE_SIGNED_OUT)).toBe(t("buddy.signedOut", { agent: "Claude Code", cmd: "claude auth login" }));
    expect(noneSaid([])).toBe(t("buddy.none", { cmd: "claude auth login" }));
    setLang("en");
    expect(whySaid("claude", "You've hit your limit · resets 5pm")).toBe("Claude Code could not answer this time. It said: You've hit your limit · resets 5pm\n\nSend your message again to try once more.");
    expect(whySaid("claude", "")).toBe("Claude Code stopped before it answered. Send your message again to try once more.");
    expect(withBefore([{ role: "assistant", text: "Hi, I'm Buddy." }], "hi")).toBe("hi");
  });

  it("names Claude Code once it is installed, and tells the app to read the team again", async () => {
    const agent = new StandInBuddyHost([]);
    const { rt, events } = await open(agent);
    agent.installed = ["claude"];
    await rt.request("chat.send", { bot: "buddy", text: "hi" });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(events).toContainEqual({ event: "bots.update", bot: "buddy" });
    expect((await rt.request("bots.list", {})).bots.find((b) => b.name === "buddy")).toMatchObject({ model: "Claude Code" });
    expect(agent.sent()).toEqual(["hi"]);
  });
});

describe("Buddy's welcome", () => {
  it("is in the person's language and says how Buddy answers, with no sample answer on offer", () => {
    setLang("ja");
    const host = new MockHost({ now: () => T0 });
    const welcome = (host.handle("chat.open", { bot: "buddy" }) as { messages: { text: string }[] }).messages[0].text;
    expect(welcome).toBe(t("buddy.hello"));
    setLang("en");
    host.reset();
    const en = (host.handle("chat.open", { bot: "buddy" }) as { messages: { text: string }[] }).messages[0].text;
    expect(en).toMatch(/I answer through a coding agent you already have on this computer, such as Claude Code/);
    expect(en).not.toMatch(/sample answer/i);
  });
});
