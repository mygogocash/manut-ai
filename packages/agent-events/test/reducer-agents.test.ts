import { describe, expect, it } from "vitest";
import { type AgentHead, type AgentSpawn, type SpendTally, addSpend, toolCall } from "../src/index";
import { AT, Thread, command } from "./support";

const spawn = (id: string, more: Partial<AgentSpawn> = {}): AgentSpawn => ({ id, description: "Scout", isBackground: true, ...more });

const head = (thread: Thread, id = "agent-1"): AgentHead => {
  const found = thread.state.agents.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no sub-agent ${id}`);
  return found;
};

const agentCall = (title: string) => toolCall({ kind: "agent", title, startedAt: AT });

/// The per-thread spend tally: what each adapter reported, summed per model, so a sub-agent's
/// tokens are what it cost rather than how full its context was. Ported from the arithmetic and
/// the runtime cases of GoSpark's `Tests/SpendTallyTests.swift`. GoSpark keys a row by provider
/// and model; a thread here has one provider, so a row is a model. Its adapter and ledger cases
/// are not ported: they test GoSpark's own sessions and its token ledger.
describe("SpendTallyTests", () => {
  const empty: SpendTally = { total: 0, rows: [] };
  const tokensFor = (tally: SpendTally, model: string | undefined) => tally.rows.find((row) => row.model === model)?.tokens;

  it("aggregatesPerProviderAndModel: spend adds up per model, and in one total", () => {
    let tally = addSpend(empty, 1_200, "deepseek-v4-pro");
    tally = addSpend(tally, 300, "deepseek-v4-pro");
    tally = addSpend(tally, 40, "deepseek-v4-flash");
    expect(tally.total).toBe(1_540);
    expect(tally.rows).toStrictEqual([
      { model: "deepseek-v4-pro", tokens: 1_500 },
      { model: "deepseek-v4-flash", tokens: 40 },
    ]);
    expect(tally.rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(tally.total);
  });

  it("unnamedModelIsTheDefault: a model the adapter did not name, or named blank, is the provider's default", () => {
    let tally = addSpend(empty, 10, undefined);
    tally = addSpend(tally, 20, "");
    tally = addSpend(tally, 30, "  \n");
    tally = addSpend(tally, 5, " glm-5 ");
    expect(tokensFor(tally, undefined)).toBe(60);
    expect(tokensFor(tally, "glm-5")).toBe(5);
    expect(tally.rows.length).toBe(2);
    expect(tally.total).toBe(65);
    expect(tally.rows[0]).toStrictEqual({ tokens: 60 });
  });

  it("zeroAndNegativeAreIgnored: zero and negative reports change nothing, and leave no empty row", () => {
    let tally = addSpend(empty, 0, "gpt-5");
    tally = addSpend(tally, -50, "gpt-5");
    tally = addSpend(tally, Number.NaN, "gpt-5");
    expect(tally).toBe(empty);
    tally = addSpend(tally, 9, "gpt-5");
    tally = addSpend(tally, -9, "gpt-5");
    expect(tally.total).toBe(9);
  });

  it("saturatesInsteadOfTrapping: a corrupt report stops the sums at the largest count", () => {
    let tally = addSpend(empty, Number.MAX_SAFE_INTEGER, undefined);
    tally = addSpend(tally, 1, undefined);
    expect(tally.total).toBe(Number.MAX_SAFE_INTEGER);
    expect(tokensFor(tally, undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a thread keeps its own tally from the spend events it hears", () => {
    const thread = new Thread();
    thread.rehearseTurn("Work");
    thread.rehearse({ type: "spend", tokens: 400, model: "deepseek-v4-pro" });
    thread.rehearse({ type: "spend", tokens: 0 });
    thread.rehearse({ type: "spend", tokens: 100 });
    expect(thread.state.spend).toStrictEqual({ total: 500, rows: [{ model: "deepseek-v4-pro", tokens: 400 }, { tokens: 100 }] });
  });

  it("nativeHeadSpendCreditsTheHead: a sub-agent's spend inside its lead's session credits that sub-agent, and its usage stays dropped", () => {
    const thread = new Thread();
    thread.rehearseTurn("Split this across a head");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { prompt: "Look" }) });

    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "spend", tokens: 700 } });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "spend", tokens: 300 } });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "usage", usage: { usedTokens: 90_000, windowTokens: 200_000 } } });
    expect(head(thread).tokens).toBe(1_000);
    expect(head(thread).timeline.spend).toStrictEqual({ total: 1_000, rows: [{ tokens: 1_000 }] });
    expect(head(thread).timeline.usage).toBeUndefined();
    expect(thread.state.spend.total).toBe(0);
    expect(thread.state.usage).toBeUndefined();

    // The provider's own running total may say more, never less: a lower one cannot undercut the sum.
    thread.rehearse({ type: "agentProgress", agentID: "agent-1", tokens: 800 });
    expect(head(thread).tokens).toBe(1_000);
    thread.rehearse({ type: "agentProgress", agentID: "agent-1", tokens: 1_600 });
    expect(head(thread).tokens).toBe(1_600);
    // A later report adds to the sum but does not drag the shown figure below the provider's.
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "spend", tokens: 100 } });
    expect(head(thread).tokens).toBe(1_600);

    thread.rehearse({ type: "agentFinished", agentID: "agent-1", status: "completed", summary: "Looked." });
    expect(head(thread)).toMatchObject({ tokens: 1_600, status: "completed", summary: "Looked." });
  });

  it("unclaimedSpendIsTheLeads: spend from a sub-agent nobody announced stays with the lead", () => {
    const thread = new Thread();
    thread.rehearseTurn("Work");
    thread.rehearse({ type: "agentEvent", agentID: "unknown-agent", event: { type: "spend", tokens: 55 } });
    expect(thread.state.spend).toStrictEqual({ total: 55, rows: [{ tokens: 55 }] });
    expect(thread.state.agents).toEqual([]);
    // Anything else about a sub-agent nobody announced has nowhere to go.
    const before = thread.state;
    thread.rehearse({ type: "agentEvent", agentID: "unknown-agent", event: { type: "messageCompleted", id: "h", text: "Lost." } });
    thread.rehearse({ type: "agentProgress", agentID: "unknown-agent", summary: "Working" });
    thread.rehearse({ type: "agentFinished", agentID: "unknown-agent", status: "completed" });
    expect(thread.state).toBe(before);
  });
});

/// Sub-agents a provider runs inside the lead's session. Ported from the event half of
/// GoSpark's `Tests/NativeHeadsFollowUpTests.swift`; holding a follow-up message back while a
/// head works is the composer's rule and is not part of the event contract.
describe("NativeHeadsFollowUpTests", () => {
  it("headsKeepWorking: a sub-agent streams on and finishes, then the lead's turn ends on its own", () => {
    const thread = new Thread();
    thread.rehearseTurn("Split this across two heads");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { description: "Refactor the model", prompt: "Refactor it", isBackground: false }) });
    expect(head(thread)).toMatchObject({ description: "Refactor the model", status: "running", isBackground: false, sessionEnded: false });
    // Its timeline starts on its brief, at work.
    expect(head(thread).timeline.phase).toBe("running");
    expect(head(thread).timeline.items.map((item) => item.content)).toStrictEqual([
      { type: "user", message: { text: "Refactor it", attachments: [], wasSteered: false, source: { type: "mac" } } },
    ]);

    // The sub-agent streams on and finishes; then the lead's turn ends on its own.
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "messageCompleted", id: "h1", text: "Done refactoring." } });
    thread.rehearse({ type: "agentFinished", agentID: "agent-1", status: "completed", summary: "Refactored." });
    expect(head(thread)).toMatchObject({ status: "completed", summary: "Refactored." });
    expect(head(thread).finishedAt).toBeDefined();
    expect(head(thread).timeline.phase).toBe("idle");
    expect(head(thread).timeline.turns[0]?.status).toBe("completed");
    expect(head(thread).timeline.items.map((item) => item.content.type)).toEqual(["user", "assistant", "turnEnd"]);
    // What it said never lands on the lead's own timeline.
    expect(thread.rowIDs()).toEqual(["user-0"]);

    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.turns[0]?.status).toBe("completed");
    expect(head(thread)).toMatchObject({ status: "completed", summary: "Refactored." });
  });
});

describe("sub-agents", () => {
  it("a second word about a sub-agent names it and gives its brief, and a placeholder never renames it", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { description: "Subagent" }) });
    expect(head(thread).timeline.items).toEqual([]);
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "messageDelta", id: "h1", text: "Looking" } });

    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { description: "Audit the tests", toolUseID: "tool-9", prompt: "Audit them" }) });
    expect(thread.state.agents.length).toBe(1);
    expect(head(thread)).toMatchObject({ description: "Audit the tests", toolUseID: "tool-9", prompt: "Audit them" });
    // The brief slots in above what the sub-agent has already said.
    expect(head(thread).timeline.items.map((item) => item.content.type)).toEqual(["user", "assistant"]);
    expect(head(thread).timeline.turns[0]?.userItemID).toBe(head(thread).timeline.items[0]?.id);

    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { description: "Subagent", toolUseID: "tool-other", prompt: "Another brief" }) });
    expect(head(thread)).toMatchObject({ description: "Audit the tests", toolUseID: "tool-9", prompt: "Audit them" });
    expect(head(thread).timeline.items.length).toBe(2);
  });

  it("a sub-agent set to work again is not handed its first brief a second time", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { prompt: "First brief" }) });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "turnCompleted", status: "completed" } });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "turnStarted" } });
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { prompt: "First brief" }) });
    const users = head(thread).timeline.items.filter((item) => item.content.type === "user");
    expect(users.length).toBe(1);
    expect(head(thread).timeline.items[0]?.content.type).toBe("user");
  });

  it("a sub-agent heard from before it was announced takes its task from the tool call that spawned it", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "toolStarted", id: "toolu_1", call: agentCall("Map the routes") });
    thread.rehearse({ type: "agentEvent", agentID: "toolu_1", event: { type: "toolStarted", id: "h-t1", call: command("rg routes") } });
    expect(head(thread, "toolu_1")).toMatchObject({ description: "Map the routes", toolUseID: "toolu_1", isBackground: false, toolCalls: 1, activity: "rg routes" });
    expect(head(thread, "toolu_1").timeline.items.map((item) => item.id)).toEqual(["h-t1"]);
    // An ordinary tool row is nobody's sub-agent.
    thread.rehearse({ type: "toolStarted", id: "toolu_2", call: command("ls") });
    thread.rehearse({ type: "agentEvent", agentID: "toolu_2", event: { type: "messageCompleted", id: "x", text: "?" } });
    expect(thread.state.agents.length).toBe(1);
  });

  it("a tool is counted once however often its start is announced, and progress carries an absolute count", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1") });
    const start = { type: "agentEvent", agentID: "agent-1", event: { type: "toolStarted", id: "h-t1", call: command("npm test") } } as const;
    thread.rehearse(start).rehearse(start);
    expect(head(thread).toolCalls).toBe(1);
    thread.rehearse({ type: "agentProgress", agentID: "agent-1", summary: "", lastTool: "Read", toolCalls: 7 });
    expect(head(thread)).toMatchObject({ toolCalls: 7, activity: "Read" });
    thread.rehearse({ type: "agentProgress", agentID: "agent-1", summary: "Writing the report", lastTool: "Edit" });
    expect(head(thread)).toMatchObject({ toolCalls: 7, activity: "Writing the report" });
    thread.rehearse({ type: "agentProgress", agentID: "agent-1" });
    expect(head(thread)).toMatchObject({ toolCalls: 7, activity: "Writing the report" });
  });

  it("what a sub-agent's session says about itself is dropped", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1") });
    const before = thread.state;
    for (const event of [
      { type: "sessionReady", sessionID: "inner" },
      { type: "models", models: [], current: "haiku" },
      { type: "commands", commands: [] },
      { type: "title", title: "Inner title" },
      { type: "assistantMessageID", messageID: "msg_inner" },
      { type: "sessionFeatures", features: { readsSettings: true, ultracodeAvailable: false, ultracodeRequested: false, ultracodeActive: false, keywordTriggerEnabled: true } },
      { type: "unknown", rawType: "cosmicRay", raw: {} },
    ] as const) {
      thread.rehearse({ type: "agentEvent", agentID: "agent-1", event });
    }
    expect(thread.state).toBe(before);
  });

  it("the tool call that sent out a foreground sub-agent returns: the sub-agent is done, and the result is its report", () => {
    const ending = (status: "completed" | "declined" | "failed") => {
      const thread = new Thread();
      thread.rehearseTurn("go");
      thread.rehearse({ type: "toolStarted", id: "toolu_1", call: agentCall("Map the routes") });
      thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { toolUseID: "toolu_1", isBackground: false }) });
      thread.rehearse({ type: "toolUpdated", id: "toolu_1", update: { status, output: "Mapped 12 routes." } });
      return head(thread);
    };
    expect(ending("completed")).toMatchObject({ status: "completed", summary: "Mapped 12 routes." });
    expect(ending("declined").status).toBe("interrupted");
    expect(ending("failed").status).toBe("failed");
    expect(ending("completed").timeline.phase).toBe("idle");
  });

  it("a background sub-agent's call returns at once and says nothing about it; its finish completes the row the provider left running", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "toolStarted", id: "toolu_1", call: agentCall("Watch the build") });
    thread.rehearse({ type: "toolStarted", id: "toolu_2", call: agentCall("Watch the deploy") });
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { toolUseID: "toolu_1" }) });
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-2", { toolUseID: "toolu_2" }) });
    thread.rehearse({ type: "toolUpdated", id: "toolu_1", update: { status: "completed", output: "Started." } });
    expect(head(thread).status).toBe("running");

    thread.rehearse({ type: "agentFinished", agentID: "agent-2", status: "failed", summary: "The deploy failed." });
    expect(thread.call("toolu_2")).toMatchObject({ status: "failed", output: "The deploy failed." });
    // A row the provider already ended keeps its own ending.
    thread.rehearse({ type: "agentFinished", agentID: "agent-1", status: "failed", summary: "The build failed." });
    expect(thread.call("toolu_1")).toMatchObject({ status: "completed", output: "Started." });
  });

  it("a sub-agent finishes once: a second word keeps the first ending", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1") });
    thread.rehearse({ type: "agentFinished", agentID: "agent-1", status: "completed", summary: "Done." });
    const finishedAt = head(thread).finishedAt;
    thread.rehearse({ type: "agentFinished", agentID: "agent-1", status: "failed", summary: "Too late." });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "turnCompleted", status: "interrupted" } });
    expect(head(thread)).toMatchObject({ status: "completed", summary: "Done.", finishedAt });
  });

  it("a sub-agent's own turn ending finishes it, and a new turn puts it back to work", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { prompt: "First brief" }) });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "toolStarted", id: "h-t1", call: command("npm test") } });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "turnCompleted", status: "interrupted" } });
    expect(head(thread).status).toBe("interrupted");
    const cutOff = head(thread).timeline.items.find((item) => item.id === "h-t1")?.content;
    expect(cutOff).toMatchObject({ call: { status: "failed", cutOff: true } });

    // Briefed again by its lead, it works another turn.
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "turnStarted" } });
    expect(head(thread).status).toBe("running");
    expect("finishedAt" in head(thread)).toBe(false);
    expect(head(thread).timeline.turns.map((turn) => turn.status)).toEqual(["interrupted", "running"]);
    expect(thread.state.agents.length).toBe(1);
  });

  it("the lead's turn ending takes its foreground sub-agents with it, and leaves the background ones at work", () => {
    const run = (status: "completed" | "interrupted" | "failed") => {
      const thread = new Thread();
      thread.rehearseTurn("go");
      thread.rehearse({ type: "agentStarted", spawn: spawn("front", { isBackground: false }) });
      thread.rehearse({ type: "agentStarted", spawn: spawn("back", { isBackground: true }) });
      thread.rehearse({ type: "turnCompleted", status });
      return thread;
    };
    expect(head(run("completed"), "front").status).toBe("completed");
    expect(head(run("interrupted"), "front").status).toBe("interrupted");
    expect(head(run("failed"), "front").status).toBe("interrupted");
    expect(head(run("completed"), "back").status).toBe("running");
    expect(head(run("completed"), "front").timeline.phase).toBe("idle");
  });

  it("the session ending stops every sub-agent still running, and its ids start over in the next session", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "toolStarted", id: "toolu_1", call: agentCall("Watch the build") });
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { toolUseID: "toolu_1" }) });
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-2") });
    thread.rehearse({ type: "agentFinished", agentID: "agent-2", status: "completed", summary: "Done." });
    thread.rehearse({ type: "exited", error: "Lost the connection." });

    expect(thread.state.agents.map((each) => `${each.id}:${each.status}:${each.sessionEnded}`)).toEqual([
      "agent-1:interrupted:true",
      "agent-2:completed:true",
    ]);
    expect(head(thread).timeline.phase).toBe("idle");
    // The row that sent out the stopped sub-agent ends with it, not with the turn's failure.
    expect(thread.call("toolu_1")?.status).toBe("failed");

    // The next session's first sub-agent takes the same id and is a different one.
    thread.rehearseTurn("again");
    thread.rehearse({ type: "agentStarted", spawn: spawn("agent-1", { description: "A new scout" }) });
    expect(thread.state.agents.length).toBe(3);
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "messageCompleted", id: "h", text: "Fresh." } });
    expect(thread.state.agents[0]?.timeline.items.some((item) => item.id === "h")).toBe(false);
    expect(thread.state.agents[2]?.timeline.items.some((item) => item.id === "h")).toBe(true);
  });

  it("a sub-agent may run sub-agents of its own, each on its parent's timeline", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: spawn("outer") });
    thread.rehearse({ type: "agentEvent", agentID: "outer", event: { type: "agentStarted", spawn: spawn("inner", { prompt: "Dig" }) } });
    thread.rehearse({
      type: "agentEvent",
      agentID: "outer",
      event: { type: "agentEvent", agentID: "inner", event: { type: "messageCompleted", id: "deep", text: "Found it." } },
    });
    const inner = head(thread, "outer").timeline.agents[0];
    expect(thread.state.agents.length).toBe(1);
    expect(inner?.id).toBe("inner");
    expect(inner?.timeline.items.map((item) => item.content.type)).toEqual(["user", "assistant"]);
  });
});
