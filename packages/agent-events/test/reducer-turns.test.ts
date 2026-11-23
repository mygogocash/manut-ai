import { describe, expect, it } from "vitest";
import {
  type TimelineItem,
  type ToolCall,
  type TurnRecord,
  type TurnStatus,
  cutOffToolCall,
  decodeProviderEvent,
  emptyTimeline,
  finishToolCall,
  isOutcomeUnknown,
  markTurnSent,
  openTurn,
  reduceTimeline,
  restoreTimeline,
  toolCall,
  userMessage,
} from "../src/index";
import { AT, EM_DASH, Thread, command, overTheWire, uuid } from "./support";

const turnEnds = (thread: Thread, turnID: string) =>
  thread.state.items.filter((item) => item.content.type === "turnEnd" && item.content.summary.turnID === turnID);

const errors = (thread: Thread) =>
  thread.state.items.flatMap((item) => (item.content.type === "notice" && item.content.notice.level === "error" ? [item.content.notice.message] : []));

/// The runtime half of GoSpark's `Tests/ToolCutOffStatusTests.swift`: how a turn's end, and a
/// reload, leave the calls that were still running.
describe("ToolCutOffStatusTests", () => {
  const callLeftRunning = (status: TurnStatus): ToolCall => {
    const thread = new Thread();
    thread.rehearseTurn("run the tests");
    thread.rehearse({ type: "toolStarted", id: "tool", call: command("npm test") });
    expect(thread.call("tool")?.status).toBe("running");
    thread.rehearse({ type: "turnCompleted", status });
    expect(thread.state.phase).toBe("idle");
    return thread.call("tool") as ToolCall;
  };

  it("stoppedTurnCutsOff: a stopped turn cuts off the calls it left running", () => {
    const call = callLeftRunning("interrupted");
    expect(call.status).toBe("failed");
    expect(isOutcomeUnknown(call)).toBe(true);
    expect(call.finishedAt).toBeDefined();
  });

  it("failedTurnFails: a failed turn fails the calls it left running", () => {
    const call = callLeftRunning("failed");
    expect(call.status).toBe("failed");
    expect(isOutcomeUnknown(call)).toBe(false);
  });

  it("completedTurnCompletes: a completed turn completes the calls it left running", () => {
    const call = callLeftRunning("completed");
    expect(call.status).toBe("completed");
    expect(isOutcomeUnknown(call)).toBe(false);
  });

  it("a turn that ended in a way this build cannot name leaves its calls' outcome unknown", () => {
    const thread = new Thread();
    const turnID = thread.rehearseTurn("run the tests");
    thread.rehearse({ type: "toolStarted", id: "tool", call: command("npm test") });
    thread.rehearse(decodeProviderEvent({ type: "turnCompleted", status: "paused" }));
    expect(isOutcomeUnknown(thread.call("tool") as ToolCall)).toBe(true);
    expect(thread.state.turns[0]?.status).toBe("unknown");
    expect(turnEnds(thread, turnID).length).toBe(1);
  });

  it("loadCutsOffRunningCalls: a thread that quit with a call running loads it cut off", () => {
    const turnID = uuid(1);
    const tool = (id: string, call: ToolCall): TimelineItem => ({ id, turnID, date: AT, content: { type: "tool", call } });
    const turns: TurnRecord[] = [{ id: turnID, index: 0, startedAt: AT, status: "running", buddyMerged: false }];
    const items = [
      tool("running", command("npm test")),
      tool("finished", finishToolCall(toolCall({ kind: "read", title: "notes.txt", startedAt: AT }), "completed", AT)),
      tool("failed", { ...finishToolCall(command("false"), "failed", AT), exitCode: 1 }),
    ];
    const later = "2026-11-24T08:00:00Z";
    const state = restoreTimeline({ items, turns }, later);
    const call = (id: string) => {
      const content = state.items.find((item) => item.id === id)?.content;
      return content?.type === "tool" ? content.call : undefined;
    };
    expect(call("running")).toMatchObject({ status: "failed", cutOff: true, finishedAt: later });
    expect(call("finished")?.status).toBe("completed");
    expect(call("failed")).toMatchObject({ status: "failed", exitCode: 1 });
    expect(isOutcomeUnknown(call("failed") as ToolCall)).toBe(false);
    expect(state.turns[0]?.status).toBe("interrupted");
    expect(state.phase).toBe("idle");

    // Saved again by this build, it still says failed for older builds and phones.
    const saved = JSON.stringify(state.items);
    expect(saved).toContain('"cutOff":true');
    expect(saved).not.toContain('"status":"running"');
  });

  it("a reload settles what was still arriving, drops thinking with nothing to read, and cleans old prose", () => {
    const row = (id: string, content: TimelineItem["content"]): TimelineItem => ({ id, date: AT, content });
    const state = restoreTimeline(
      {
        items: [
          row("m", { type: "assistant", message: { text: `Half a rep${EM_DASH}`, isStreaming: true } }),
          row("blank", { type: "reasoning", block: { text: "  \n", isStreaming: true } }),
          row("r", { type: "reasoning", block: { text: "Thinking", isStreaming: true } }),
          row("p", { type: "plan", plan: { markdown: "1. Draft", state: "drafting", revision: 1 } }),
          row("x", { type: "unknown", rawType: "hologram", raw: { hologram: {} } }),
        ],
        turns: [],
        usage: { usedTokens: 10 },
      },
      AT,
    );
    expect(state.items.map((item) => item.id)).toEqual(["m", "r", "p", "x"]);
    expect(state.items[0]?.content).toStrictEqual({ type: "assistant", message: { text: "Half a rep-", isStreaming: false } });
    expect(state.items[1]?.content).toStrictEqual({ type: "reasoning", block: { text: "Thinking", isStreaming: false } });
    expect(state.items[2]?.content).toStrictEqual({ type: "plan", plan: { markdown: "1. Draft", state: "proposed", revision: 1 } });
    expect(state.usage).toStrictEqual({ usedTokens: 10 });
    // A row made after the reload takes an id none of the saved rows has.
    const next = reduceTimeline(state, { type: "notice", notice: { level: "info", message: "Back." } }, { at: AT, freshID: uuid(9) });
    expect(new Set(next.items.map((item) => item.id)).size).toBe(5);
  });
});

/// How a turn ends, and which words about an ending are not about the turn in hand. The event
/// rules of GoSpark's `Tests/TurnCloseRuntimeTests.swift` and `Tests/TurnCloseInvariantTests.swift`;
/// the rest of those suites is about git checkpoints, which this package does not take.
describe("TurnCloseRuntimeTests", () => {
  it("aDuplicateFinishLeavesTheNextTurnAlone: a finish and an exit back to back end the turn once", () => {
    const thread = new Thread();
    const first = thread.rehearseTurn("first");
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    thread.rehearse({ type: "exited" });
    expect(turnEnds(thread, first).length).toBe(1);
    expect(thread.state.turns[0]?.status).toBe("completed");
    expect(errors(thread)).toEqual([]);

    // The follow-up's turn opens after both, and neither ended it.
    thread.rehearseTurn("second");
    expect(thread.state.turns.map((turn) => turn.status)).toEqual(["completed", "running"]);
    expect(thread.state.phase).toBe("running");
  });

  it("exitedLeavesAnUnsentWaitingTurnAlone: a session that exits while a turn waits to send leaves that turn to start on a fresh one", () => {
    const thread = new Thread();
    thread.rehearseTurn("first");
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    const second = thread.openUnsent("second");
    expect(thread.state.phase).toBe("starting");

    thread.rehearse({ type: "exited" });
    expect(thread.state.turns[1]?.status).toBe("running");
    expect(thread.state.currentTurnID).toBe(second);
    expect(thread.state.phase).toBe("starting");
    expect(errors(thread)).toEqual([]);

    thread.state = markTurnSent(thread.state);
    expect(thread.state.phase).toBe("running");
  });

  it("the working line ends when the provider is done, and the closing line goes in with no counts", () => {
    const thread = new Thread();
    const turnID = thread.rehearseTurn("go");
    thread.rehearse({ type: "messageDelta", id: "m", text: "Working" });
    thread.rehearse({ type: "planDelta", id: "p", text: "1. Draft" });
    thread.rehearse({ type: "turnCompleted", status: "completed" });

    expect(thread.state.phase).toBe("idle");
    expect(thread.state.currentTurnID).toBeUndefined();
    expect(thread.state.turns[0]).toMatchObject({ status: "completed", completedAt: "2026-11-23T05:00:04Z" });
    expect(thread.content("m")).toStrictEqual({ type: "assistant", message: { text: "Working", isStreaming: false } });
    expect(thread.content("p")).toMatchObject({ plan: { state: "proposed" } });
    const closing = turnEnds(thread, turnID);
    expect(closing.length).toBe(1);
    expect(closing[0]).toStrictEqual({
      id: "turn-end-1",
      turnID,
      date: "2026-11-23T05:00:04Z",
      content: { type: "turnEnd", summary: { turnID, status: "completed", duration: 3, filesChanged: 0, additions: 0, deletions: 0 } },
    });
  });

  it("a turn's error is shown once, though the failing turn and the exit both carry it", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "turnCompleted", status: "failed", error: "The provider failed." });
    thread.rehearse({ type: "exited", error: "The provider failed." });
    expect(errors(thread)).toEqual(["The provider failed."]);
  });

  it("only an immediate repeat of a notice is dropped", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    const notice = { type: "notice", notice: { level: "warning", message: "Slow." } } as const;
    thread.rehearse(notice).rehearse(notice);
    thread.rehearse({ type: "notice", notice: { level: "info", message: "Slow." } });
    thread.rehearse(notice);
    expect(thread.state.items.filter((item) => item.content.type === "notice").length).toBe(3);
  });

  it("a provider that goes away mid-turn fails the turn and says so, in its words or the default's", () => {
    const silent = new Thread();
    const turnID = silent.rehearseTurn("go");
    silent.rehearse({ type: "toolStarted", id: "t", call: command("npm test") });
    silent.rehearse({ type: "exited" });
    expect(errors(silent)).toEqual(["The agent stopped unexpectedly."]);
    expect(silent.state.turns[0]?.status).toBe("failed");
    expect(silent.call("t")).toMatchObject({ status: "failed" });
    expect(isOutcomeUnknown(silent.call("t") as ToolCall)).toBe(false);
    expect(turnEnds(silent, turnID).length).toBe(1);
    expect(silent.state.phase).toBe("idle");

    const named = new Thread({ unexpectedExitMessage: "The team member stopped unexpectedly." });
    named.rehearseTurn("go");
    named.rehearse({ type: "exited" });
    expect(errors(named)).toEqual(["The team member stopped unexpectedly."]);

    const explained = new Thread();
    explained.rehearseTurn("go");
    explained.rehearse({ type: "exited", error: "Killed by signal 9." });
    expect(errors(explained)).toEqual(["Killed by signal 9."]);
  });

  it("a turn's end closes only what that turn left open", () => {
    const thread = new Thread();
    // A call that started between turns belongs to no turn, so no turn's end can say how it went.
    thread.rehearse({ type: "toolStarted", id: "between", call: command("tail -f log") });
    thread.rehearseTurn("go");
    thread.rehearse({ type: "toolStarted", id: "mine", call: command("npm test") });
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.call("mine")?.status).toBe("completed");
    expect(thread.call("between")?.status).toBe("running");
  });

  it("a finish with no turn in hand only settles the phase", () => {
    const thread = new Thread();
    thread.rehearse({ type: "messageDelta", id: "m", text: "Between turns" });
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.phase).toBe("idle");
    expect(thread.state.items.length).toBe(1);
  });
});

describe("TurnCloseInvariantTests", () => {
  it("strayCompletionLeavesAWaitingTurnAlone: a stray completion from the provider does not end a turn still waiting to send", () => {
    const thread = new Thread();
    const first = thread.rehearseTurn("first");
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    const second = thread.openUnsent("second");

    // A Stop that raced the first turn's own end: the provider answers it with a second
    // completion, which arrives while the queued message waits to send.
    thread.rehearse({ type: "turnCompleted", status: "interrupted" });
    expect(thread.state.phase).toBe("starting");
    expect(thread.state.currentTurnID).toBe(second);
    expect(thread.state.turns.map((turn) => turn.status)).toEqual(["completed", "running"]);
    expect(turnEnds(thread, first).length).toBe(1);
    expect(turnEnds(thread, second).length).toBe(0);

    thread.state = markTurnSent(thread.state);
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
  });
});

describe("opening a turn", () => {
  it("opens the record and its message, and waits to send", () => {
    const state = openTurn(emptyTimeline(), {
      turnID: uuid(1),
      at: AT,
      userMessage: userMessage("Fix the bug"),
      attemptID: uuid(2),
      provider: "claude",
      model: "opus",
      effort: "high",
    });
    expect(state.phase).toBe("starting");
    expect(state.currentTurnID).toBe(uuid(1));
    expect(state.currentAttemptID).toBe(uuid(2));
    expect(state.turns).toStrictEqual([
      { id: uuid(1), index: 0, startedAt: AT, status: "running", userItemID: "user-0", buddyMerged: false, provider: "claude", model: "opus", effort: "high" },
    ]);
    expect(state.items).toStrictEqual([{ id: "user-0", turnID: uuid(1), date: AT, content: { type: "user", message: userMessage("Fix the bug") } }]);
    // Opening the same turn twice opens it once.
    expect(openTurn(state, { turnID: uuid(1), at: AT })).toBe(state);
  });

  it("a message row under an id the timeline already holds is not added a second time", () => {
    const thread = new Thread();
    thread.rehearse({ type: "messageCompleted", id: "taken", text: "Already here." });
    const state = openTurn(thread.state, { turnID: uuid(1), at: AT, userMessage: userMessage("hello"), userItemID: "taken" });
    expect(state.items.map((item) => item.id)).toEqual(["taken"]);
    expect(state.items[0]?.content.type).toBe("assistant");
    expect(state.turns).toHaveLength(1);
  });

  it("numbers turns from the highest index so far, and a turn outside a task carries no attempt", () => {
    let state = openTurn(emptyTimeline(), { turnID: uuid(1), at: AT, attemptID: uuid(7), userItemID: "mine", userMessage: userMessage("one") });
    state = reduceTimeline(markTurnSent(state), { type: "turnCompleted", status: "completed" }, { at: AT, freshID: uuid(8) });
    expect(state.currentAttemptID).toBeUndefined();
    state = openTurn(state, { turnID: uuid(2), at: AT });
    expect(state.turns.map((turn) => turn.index)).toEqual([0, 1]);
    expect(state.turns[0]?.userItemID).toBe("mine");
    expect(state.turns[1] && "userItemID" in state.turns[1]).toBe(false);
    expect(state.currentAttemptID).toBeUndefined();
  });

  it("a turn the provider starts by itself gets a record of its own, so its output lands on a turn that ends", () => {
    const thread = new Thread();
    thread.rehearse({ type: "turnStarted", providerTurnID: "provider-7" });
    const turn = thread.state.turns[0];
    expect(turn).toMatchObject({ index: 0, status: "running", providerTurnID: "provider-7" });
    expect(turn && "userItemID" in turn).toBe(false);
    expect(thread.state.phase).toBe("running");
    thread.rehearse({ type: "messageCompleted", id: "m", text: "On my own." });
    expect(thread.state.items[0]?.turnID).toBe(turn?.id);
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.turns[0]?.status).toBe("completed");
    expect(turnEnds(thread, turn?.id ?? "").length).toBe(1);
  });

  it("a turn the caller opened is the one the provider's start names", () => {
    const thread = new Thread();
    const turnID = thread.openUnsent("go");
    thread.rehearse({ type: "turnStarted", providerTurnID: "provider-1" });
    expect(thread.state.turns).toHaveLength(1);
    expect(thread.state.turns[0]).toMatchObject({ id: turnID, providerTurnID: "provider-1" });
    expect(thread.state.phase).toBe("running");
  });
});

describe("what a session says about itself", () => {
  it("lands on the state, and on the turn where it is about the turn", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "sessionReady", sessionID: "session-1" });
    thread.rehearse({ type: "usage", usage: { usedTokens: 90_000, windowTokens: 200_000 } });
    thread.rehearse({ type: "diff", diff: "+one line" });
    thread.rehearse({ type: "assistantMessageID", messageID: "msg_01" });
    thread.rehearse({ type: "models", models: [{ id: "opus", name: "Opus", efforts: [], isDefault: true }], current: "sonnet" });
    thread.rehearse({ type: "commands", commands: [{ name: "compact", detail: "", isBuiltIn: true }] });
    thread.rehearse({ type: "modeChanged", mode: "plan" });
    thread.rehearse({ type: "usageLimit", resetsAt: "2026-11-23T09:00:00Z" });

    expect(thread.state.sessionID).toBe("session-1");
    expect(thread.state.usage).toStrictEqual({ usedTokens: 90_000, windowTokens: 200_000 });
    expect(thread.state.turns[0]).toMatchObject({ providerDiff: "+one line", providerAnchor: "msg_01", servedModel: "sonnet" });
    expect(thread.state.models.map((model) => model.id)).toEqual(["opus"]);
    expect(thread.state.commands.map((each) => each.name)).toEqual(["compact"]);
    expect(thread.state.interactionMode).toBe("plan");
    expect(thread.state.usageLimit).toStrictEqual({ resetsAt: "2026-11-23T09:00:00Z", at: "2026-11-23T05:00:09Z" });

    // A catalog with no word on what is serving leaves the turn's served model as it was.
    thread.rehearse({ type: "models", models: [] });
    expect(thread.state.turns[0]?.servedModel).toBe("sonnet");
    // The wait is over once the next turn opens.
    thread.rehearse({ type: "turnCompleted", status: "interrupted" });
    thread.rehearseTurn("again");
    expect("usageLimit" in thread.state).toBe(false);
  });

  it("a provider's title is offered during the first turn only, with its prose cleaned", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "title", title: `Fix it ${EM_DASH} now` });
    expect(thread.state.title).toBe("Fix it - now");
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    thread.rehearseTurn("more");
    thread.rehearse({ type: "title", title: "Something else" });
    expect(thread.state.title).toBe("Fix it - now");
  });

  it("session features are kept while the session lives, and an unchanged report changes nothing", () => {
    const features = { readsSettings: true, ultracodeAvailable: true, ultracodeRequested: false, ultracodeActive: false, keywordTriggerEnabled: true };
    const thread = new Thread();
    thread.rehearse({ type: "sessionFeatures", features });
    const before = thread.state;
    thread.rehearse({ type: "sessionFeatures", features: { ...features } });
    expect(thread.state).toBe(before);
    thread.rehearse({ type: "sessionFeatures", features: { ...features, ultracodeActive: true, ultracodeRequested: true } });
    expect(thread.state.sessionFeatures?.ultracodeActive).toBe(true);
    thread.rehearse({ type: "exited" });
    expect("sessionFeatures" in thread.state).toBe(false);
  });

  it("the todo list is one row a turn, replaced each time, and an empty list makes no row", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "todos", steps: [] });
    expect(thread.state.items.some((item) => item.content.type === "todos")).toBe(false);
    thread.rehearse({ type: "todos", steps: [{ text: "Read", status: "active" }, { text: "Write", status: "pending" }] });
    thread.rehearse({ type: "messageCompleted", id: "m", text: "Reading." });
    thread.rehearse({ type: "todos", steps: [{ text: "Read", status: "done" }, { text: "Write", status: "active" }] });
    const lists = thread.state.items.filter((item) => item.content.type === "todos");
    expect(lists.length).toBe(1);
    expect(lists[0]?.content).toStrictEqual({ type: "todos", steps: [{ text: "Read", status: "done" }, { text: "Write", status: "active" }] });

    thread.rehearse({ type: "turnCompleted", status: "completed" });
    thread.rehearseTurn("next");
    thread.rehearse({ type: "todos", steps: [{ text: "Ship", status: "pending" }] });
    expect(thread.state.items.filter((item) => item.content.type === "todos").length).toBe(2);
  });

  it("a state that has held every kind of row is still plain JSON", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "todos", steps: [{ text: "Read", status: "active" }] });
    thread.rehearse({ type: "toolStarted", id: "t", call: cutOffToolCall(command("ls"), AT) });
    thread.rehearse({ type: "turnCompleted", status: "failed", error: "No." });
    expect(overTheWire(thread.state)).toStrictEqual(thread.state);
  });
});
