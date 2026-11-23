import { describe, expect, it } from "vitest";
import {
  type ProviderEvent,
  type ResearchSourceRecord,
  TOOL_OUTPUT_LIMIT,
  decodeProviderEvent,
  decodeThreadDocument,
  emptyTimeline,
  encodeThreadDocument,
  reduceTimeline,
  researchSourceRecord,
  utf8Length,
} from "../src/index";
import { AT, ELLIPSIS, EM_DASH, Thread, command, overTheWire, uuid } from "./support";

/// Timeline row ids are unique. A provider that reuses an id for a different kind of thing must
/// not get a second row under it. Ported from GoSpark's `Tests/TimelineIdentityTests.swift`.
describe("TimelineIdentityTests", () => {
  const sharedOnce = (thread: Thread) => {
    expect(thread.rowIDs().filter((id) => id === "shared").length).toBe(1);
    expect(thread.hasUniqueIDs()).toBe(true);
  };

  it("reasoningOntoToolID: reasoning completing onto a tool's id does not duplicate it", () => {
    const thread = new Thread();
    thread.rehearseTurn("hello");
    thread.rehearse({ type: "toolStarted", id: "shared", call: command("ls") });
    thread.rehearse({ type: "reasoningCompleted", id: "shared", text: "thinking" });
    sharedOnce(thread);
    expect(thread.content("shared")?.type).toBe("tool");
  });

  it("planOntoToolID: a plan completing onto a tool's id does not duplicate it", () => {
    const thread = new Thread();
    thread.rehearseTurn("hello");
    thread.rehearse({ type: "toolStarted", id: "shared", call: command("ls") });
    thread.rehearse({ type: "planCompleted", id: "shared", markdown: "# plan" });
    sharedOnce(thread);
  });

  it("toolOntoMessageID: a tool starting onto a message's id does not duplicate it", () => {
    const thread = new Thread();
    thread.rehearseTurn("hello");
    thread.rehearse({ type: "messageDelta", id: "shared", text: "reply" });
    thread.rehearse({ type: "messageCompleted", id: "shared", text: "reply" });
    thread.rehearse({ type: "toolStarted", id: "shared", call: command("ls") });
    sharedOnce(thread);
    expect(thread.text("shared")).toBe("reply");
  });

  it("messageOntoToolID: a message completing onto a tool's id does not duplicate it", () => {
    const thread = new Thread();
    thread.rehearseTurn("hello");
    thread.rehearse({ type: "toolStarted", id: "shared", call: command("ls") });
    thread.rehearse({ type: "messageCompleted", id: "shared", text: "reply" });
    sharedOnce(thread);
  });

  it("ordinaryTurnStillWorks: an ordinary turn still builds the entries it should", () => {
    const thread = new Thread();
    const turnID = thread.rehearseTurn("hello");
    thread.rehearse({ type: "toolStarted", id: "tool-1", call: command("ls") });
    thread.rehearse({ type: "messageDelta", id: "msg-1", text: "one " });
    thread.rehearse({ type: "messageCompleted", id: "msg-1", text: "one two" });
    expect(thread.rowIDs()).toEqual(["user-0", "tool-1", "msg-1"]);
    expect(thread.text("msg-1")).toBe("one two");
    expect(thread.state.items.every((item) => item.turnID === turnID)).toBe(true);
    expect(thread.hasUniqueIDs()).toBe(true);
  });
});

/// These pin what the person ends up reading: the exact text, which rows exist, what is
/// flattened and what is left alone. Ported from GoSpark's
/// `Tests/StreamingIngestionStressTests.swift`. Left out: `accumulationIsNotQuadratic`, which
/// measures the Swift string storage this reducer does not have.
describe("StreamingIngestionStressTests", () => {
  const started = (): Thread => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    return thread;
  };

  it("messageAccumulatesExactly: a long reply accumulates to exactly what was sent", () => {
    const thread = started();
    const chunk = "x".repeat(200);
    for (let index = 0; index < 2_000; index += 1) thread.rehearse({ type: "messageDelta", id: "m", text: chunk });
    thread.rehearse({ type: "messageCompleted", id: "m", text: "" });
    expect(thread.text("m")).toBe(chunk.repeat(2_000));
  });

  it("reasoningAndPlanAccumulateExactly: reasoning and plan accumulate to exactly what was sent", () => {
    const thread = started();
    for (let index = 0; index < 200; index += 1) {
      thread.rehearse({ type: "reasoningDelta", id: "r", text: "ab" });
      thread.rehearse({ type: "planDelta", id: "p", text: "cd" });
    }
    thread.rehearse({ type: "reasoningCompleted", id: "r", text: "" });
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "" });
    expect(thread.text("r")).toBe("ab".repeat(200));
    expect(thread.text("p")).toBe("cd".repeat(200));
  });

  it("toolOutputAccumulatesExactly: tool output accumulates to exactly what was sent", () => {
    const thread = started();
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    for (let index = 0; index < 200; index += 1) thread.rehearse({ type: "toolOutput", id: "t", text: "line\n" });
    expect(thread.text("t")).toBe("line\n".repeat(200));
  });

  it("interleavedIdsNeverMix: many replies streaming at once never mix", () => {
    const thread = started();
    const ids = Array.from({ length: 200 }, (_, index) => `m${index}`);
    for (let round = 0; round < 5; round += 1) {
      for (const id of ids) thread.rehearse({ type: "messageDelta", id, text: `${id}-${round} ` });
    }
    for (const id of ids) thread.rehearse({ type: "messageCompleted", id, text: "" });
    for (const id of ids) {
      expect(thread.text(id)).toBe([0, 1, 2, 3, 4].map((round) => `${id}-${round} `).join(""));
    }
  });

  it("emptyReasoningDeltaCreatesNothing: a redacted thinking block leaves no blank row", () => {
    const thread = started();
    thread.rehearse({ type: "reasoningDelta", id: "r", text: "" });
    expect(thread.content("r")).toBeUndefined();
  });

  it("emDashesFlattenInProseOnly: prose is flattened as it streams but process output is left alone", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m", text: `a${EM_DASH}b` });
    thread.rehearse({ type: "reasoningDelta", id: "r", text: `c${EM_DASH}d` });
    thread.rehearse({ type: "planDelta", id: "p", text: `e${EM_DASH}f` });
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    thread.rehearse({ type: "toolOutput", id: "t", text: `g${EM_DASH}h` });
    expect(thread.text("m")).toBe("a-b");
    expect(thread.text("r")).toBe("c-d");
    expect(thread.text("p")).toBe("e-f");
    expect(thread.text("t")).toBe(`g${EM_DASH}h`);
  });

  it("a caller that wants model prose exactly as it arrived says so", () => {
    const thread = new Thread({ cleanProse: (text) => text });
    thread.rehearseTurn("go");
    thread.rehearse({ type: "messageDelta", id: "m", text: `a${EM_DASH}` });
    thread.rehearse({ type: "messageCompleted", id: "m", text: `a${EM_DASH}b` });
    expect(thread.text("m")).toBe(`a${EM_DASH}b`);
  });

  it("toolOutputIsTrimmed: runaway tool output is capped and stays capped", () => {
    const thread = started();
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    const block = "y".repeat(10_000);
    for (let index = 0; index < 12; index += 1) thread.rehearse({ type: "toolOutput", id: "t", text: block });
    expect(utf8Length(thread.text("t") ?? "")).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT);
    for (let index = 0; index < 4; index += 1) thread.rehearse({ type: "toolOutput", id: "t", text: block });
    expect(utf8Length(thread.text("t") ?? "")).toBeLessThanOrEqual(TOOL_OUTPUT_LIMIT);
    expect(thread.text("t")?.startsWith(ELLIPSIS)).toBe(true);
    expect(thread.text("t")?.length).toBe(1 + TOOL_OUTPUT_LIMIT / 2);
  });

  it("output set whole is capped the same way, and keeps whole characters", () => {
    const thread = started();
    // A Thai character of three code points and nine bytes: the cut must fall between two of them.
    const character = String.fromCodePoint(0x0e01, 0x0e35, 0x0e49);
    thread.rehearse({ type: "toolUpdated", id: "t", update: { output: character.repeat(40_000) } });
    expect(thread.text("t")).toBe(ELLIPSIS + character.repeat(TOOL_OUTPUT_LIMIT / 2));
  });

  it("toolDoesNotEndAssistantStreaming: a tool call mid-reply does not mark the reply as finished", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m", text: "hello" });
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    thread.rehearse({ type: "messageDelta", id: "m", text: " still going" });
    expect(thread.content("m")).toStrictEqual({ type: "assistant", message: { text: "hello still going", isStreaming: true } });
  });

  it("any other row settles the reply that was streaming above it", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m1", text: "first" });
    thread.rehearse({ type: "messageDelta", id: "m2", text: "second" });
    expect(thread.content("m1")).toStrictEqual({ type: "assistant", message: { text: "first", isStreaming: false } });
    expect(thread.content("m2")).toMatchObject({ message: { isStreaming: true } });
  });

  it("deltaForRemovedEntryIsHarmless: a delta for a message that was already dropped is ignored", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m", text: "   " });
    // Whitespace only, so completing it removes the row.
    thread.rehearse({ type: "messageCompleted", id: "m", text: "" });
    expect(thread.content("m")).toBeUndefined();
    thread.rehearse({ type: "messageDelta", id: "m", text: "late" });
    expect(thread.hasUniqueIDs()).toBe(true);
  });
});

/// Events do not always arrive in the order a tidy provider would send them. None of these may
/// throw, duplicate a row or lose the final text.
describe("out-of-order deltas", () => {
  const started = (): Thread => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    return thread;
  };

  it("a completion with no deltas before it lands whole, and an empty one makes no row", () => {
    const thread = started();
    thread.rehearse({ type: "messageCompleted", id: "m", text: "All at once." });
    thread.rehearse({ type: "reasoningCompleted", id: "r", text: "Thought." });
    thread.rehearse({ type: "messageCompleted", id: "nothing", text: "" });
    thread.rehearse({ type: "reasoningCompleted", id: "nothing-thought", text: "" });
    thread.rehearse({ type: "planCompleted", id: "no-plan", markdown: "" });
    expect(thread.content("m")).toStrictEqual({ type: "assistant", message: { text: "All at once.", isStreaming: false } });
    expect(thread.content("r")).toStrictEqual({ type: "reasoning", block: { text: "Thought.", isStreaming: false } });
    expect(thread.rowIDs()).toEqual(["user-0", "m", "r"]);
  });

  it("the completion's text is the reply, whatever part of it the deltas carried", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m", text: "wor" });
    thread.rehearse({ type: "messageDelta", id: "m", text: "Hello " });
    thread.rehearse({ type: "messageCompleted", id: "m", text: "Hello world" });
    expect(thread.text("m")).toBe("Hello world");
  });

  it("a delta that arrives after its completion is appended, as GoSpark's runtime appends it", () => {
    const thread = started();
    thread.rehearse({ type: "messageDelta", id: "m", text: "Hello" });
    thread.rehearse({ type: "messageCompleted", id: "m", text: "Hello" });
    thread.rehearse({ type: "messageDelta", id: "m", text: " again" });
    // The row is not reopened: it does not go back to streaming, and no second row appears.
    expect(thread.content("m")).toStrictEqual({ type: "assistant", message: { text: "Hello again", isStreaming: false } });
    expect(thread.hasUniqueIDs()).toBe(true);
    // A second completion still has the last word.
    thread.rehearse({ type: "messageCompleted", id: "m", text: "Hello" });
    expect(thread.text("m")).toBe("Hello");
  });

  it("output for a tool nobody announced is dropped, and reaches the row once the tool is announced", () => {
    const thread = started();
    thread.rehearse({ type: "toolOutput", id: "t", text: "early\n" });
    expect(thread.content("t")).toBeUndefined();
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    thread.rehearse({ type: "toolOutput", id: "t", text: "late\n" });
    expect(thread.text("t")).toBe("late\n");
  });

  it("an update before the start makes the row, and the start then names it without undoing its ending", () => {
    const thread = started();
    thread.rehearse({ type: "toolUpdated", id: "t", update: { status: "completed", output: "done", exitCode: 0 } });
    expect(thread.call("t")).toMatchObject({ kind: "other", title: "Tool", status: "completed", output: "done", exitCode: 0 });
    thread.rehearse({ type: "toolStarted", id: "t", call: command("npm test") });
    expect(thread.call("t")).toMatchObject({ kind: "command", title: "npm test", status: "completed", output: "done" });
    expect(thread.hasUniqueIDs()).toBe(true);
  });

  it("a start announced twice is one row, and the second word may end it", () => {
    const thread = started();
    thread.rehearse({ type: "toolStarted", id: "t", call: command("npm test") });
    thread.rehearse({ type: "toolOutput", id: "t", text: "ok" });
    thread.rehearse({ type: "toolStarted", id: "t", call: { ...command(""), status: "completed", detail: "in web", edits: [{ path: "a.ts", additions: 1, deletions: 0 }] } });
    expect(thread.call("t")).toMatchObject({ title: "npm test", detail: "in web", status: "completed", output: "ok" });
    expect(thread.call("t")?.edits).toStrictEqual([{ path: "a.ts", additions: 1, deletions: 0 }]);
    expect(thread.call("t")?.finishedAt).toBeDefined();
    // A later start cannot take a finished call back to running.
    thread.rehearse({ type: "toolStarted", id: "t", call: command("npm test") });
    expect(thread.call("t")?.status).toBe("completed");
  });

  it("deltas that arrive between turns land on no turn, and nothing throws", () => {
    const thread = new Thread();
    thread.rehearse({ type: "messageDelta", id: "m", text: "No turn." });
    thread.rehearse({ type: "toolStarted", id: "t", call: command("ls") });
    expect(thread.state.items.every((item) => !("turnID" in item))).toBe(true);
  });

  it("an event with no id addresses no row and is ignored", () => {
    const thread = started();
    const before = thread.state;
    for (const event of [
      { type: "messageDelta", id: "", text: "lost" },
      { type: "messageCompleted", id: "", text: "lost" },
      { type: "reasoningDelta", id: "", text: "lost" },
      { type: "reasoningCompleted", id: "", text: "lost" },
      { type: "planDelta", id: "", text: "lost" },
      { type: "planCompleted", id: "", markdown: "lost" },
      { type: "toolOutput", id: "", text: "lost" },
      { type: "toolStarted", id: "", call: command("ls") },
      { type: "toolUpdated", id: "", update: { status: "completed" } },
      { type: "agentStarted", spawn: { id: "", description: "Nobody", isBackground: true } },
      { type: "agentEvent", agentID: "", event: { type: "spend", tokens: 5 } },
      { type: "sessionReady", sessionID: "" },
    ] satisfies ProviderEvent[]) {
      thread.rehearse(event);
    }
    expect(thread.state).toBe(before);
  });
});

describe("unknown kinds", () => {
  it("an event this build cannot read changes nothing, and the same state comes back", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "messageDelta", id: "m", text: "Hello" });
    const before = thread.state;
    thread.rehearse(decodeProviderEvent({ type: "cosmicRay", strength: 9 }));
    thread.rehearse(decodeProviderEvent({ type: "toolStarted", id: "t" }));
    thread.rehearse(decodeProviderEvent("not an event"));
    expect(thread.state).toBe(before);
  });

  it("values this build cannot name are folded in as unknown rather than dropped", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse(decodeProviderEvent({ type: "toolStarted", id: "t", call: { kind: "hologram", title: "Project it", startedAt: AT } }));
    thread.rehearse(decodeProviderEvent({ type: "toolUpdated", id: "t", update: { status: "paused" } }));
    thread.rehearse(decodeProviderEvent({ type: "todos", steps: [{ text: "Wait", status: "blocked" }] }));
    thread.rehearse(decodeProviderEvent({ type: "notice", notice: { level: "loud", message: "Hi" } }));
    thread.rehearse(decodeProviderEvent({ type: "modeChanged", mode: "review" }));
    expect(thread.call("t")).toMatchObject({ kind: "unknown", status: "unknown" });
    expect(thread.content("todos-1")).toStrictEqual({ type: "todos", steps: [{ text: "Wait", status: "unknown" }] });
    expect(thread.content("notice-2")).toStrictEqual({ type: "notice", notice: { level: "unknown", message: "Hi" } });
    expect(thread.state.interactionMode).toBe("unknown");
  });
});

/// The sources a research answer was written from land once on the answer and are read back
/// unchanged. Ported from the thread case of GoSpark's `Tests/ResearchSourcesEventTests.swift`;
/// its other cases test the Perplexity adapter that builds the event.
describe("ResearchSourcesEventTests", () => {
  it("runtimeLandsSourcesOnce: sources land on their answer once, survive a save and reload, and touch no other reply", () => {
    const run = { retrievedAt: "2026-09-22T08:26:40Z", provider: "perplexity", runID: "run-9", responseID: "resp-9" };
    const first: ResearchSourceRecord[] = [
      researchSourceRecord({ index: 1, url: "https://swift.org", title: "Swift", ...run }),
      researchSourceRecord({ index: 2, ...run }),
    ];
    const fresher = [researchSourceRecord({ index: 1, url: "https://elsewhere.example", ...run, runID: "run-10", responseID: "resp-10" })];

    const thread = new Thread();
    thread.rehearseTurn("What changed?");
    thread.rehearse({ type: "messageDelta", id: "answer-1", text: "Swift [1] " });
    thread.rehearse({ type: "messageCompleted", id: "answer-1", text: "Swift [1] and [2]." });
    thread.rehearse({ type: "sources", messageID: "answer-1", sources: first });
    thread.rehearse({ type: "sources", messageID: "answer-1", sources: fresher });
    thread.rehearse({ type: "messageCompleted", id: "other-reply", text: "A reply from a provider with no sources." });
    thread.rehearse({ type: "sources", messageID: "no-such-message", sources: fresher });

    expect(thread.content("answer-1")).toMatchObject({ message: { sources: first } });
    const other = thread.content("other-reply");
    expect(other?.type === "assistant" && "sources" in other.message).toBe(false);
    expect(thread.content("no-such-message")).toBeUndefined();

    const saved = overTheWire(encodeThreadDocument({ threadID: uuid(1), items: thread.state.items, turns: thread.state.turns, followUps: [], attempts: [] }));
    const reloaded = decodeThreadDocument(saved);
    expect(reloaded?.items).toStrictEqual(thread.state.items);
  });
});

describe("the reducer is pure", () => {
  const events: ProviderEvent[] = [
    { type: "turnStarted", providerTurnID: "t-1" },
    { type: "reasoningDelta", id: "r", text: "Hm" },
    { type: "messageDelta", id: "m", text: "Hello" },
    { type: "toolStarted", id: "t", call: command("ls") },
    { type: "toolOutput", id: "t", text: "a.txt\n" },
    { type: "approval", request: { id: "req", kind: "command", title: "ls", options: [] } },
    { type: "todos", steps: [{ text: "List", status: "active" }] },
    { type: "agentStarted", spawn: { id: "a", description: "Scout", prompt: "Look", isBackground: true } },
    { type: "agentEvent", agentID: "a", event: { type: "messageCompleted", id: "h", text: "Found it." } },
    { type: "spend", tokens: 12, model: "opus" },
    { type: "turnCompleted", status: "completed" },
  ];

  const fold = () =>
    events.reduce((state, event, index) => reduceTimeline(state, event, { at: AT, freshID: uuid(index) }), emptyTimeline());

  it("the same events give the same state, which is plain JSON", () => {
    const state = fold();
    expect(fold()).toStrictEqual(state);
    expect(overTheWire(state)).toStrictEqual(state);
  });

  it("no state it is given is ever changed", () => {
    const freeze = (value: unknown): void => {
      if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
      Object.freeze(value);
      for (const inner of Object.values(value)) freeze(inner);
    };
    let state = emptyTimeline();
    events.forEach((event, index) => {
      freeze(state);
      freeze(event);
      state = reduceTimeline(state, event, { at: AT, freshID: uuid(index) });
    });
    expect(state.phase).toBe("idle");
  });
});
