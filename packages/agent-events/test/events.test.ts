import { describe, expect, it } from "vitest";
import {
  PROVIDER_EVENT_TYPES,
  type ProviderEvent,
  decodeProviderEvent,
  readValue,
  researchSourceRecord,
  toolCall,
} from "../src/index";
import { AT, fixedContext, overTheWire, uuid } from "./support";

/// One of every kind, each with every field it can carry.
const everyEvent: ProviderEvent[] = [
  { type: "sessionReady", sessionID: "session-1" },
  { type: "turnStarted", providerTurnID: "turn-9" },
  { type: "messageDelta", id: "m1", text: "Hel" },
  { type: "messageCompleted", id: "m1", text: "Hello" },
  { type: "reasoningDelta", id: "r1", text: "Hm" },
  { type: "reasoningCompleted", id: "r1", text: "Hmm." },
  { type: "toolStarted", id: "t1", call: { ...toolCall({ kind: "command", title: "npm test", startedAt: AT, detail: "in web" }), exitCode: 0, edits: [{ path: "a.ts", diff: "+1", additions: 1, deletions: 0 }] } },
  { type: "toolOutput", id: "t1", text: "ok\n" },
  { type: "toolUpdated", id: "t1", update: { title: "npm test", detail: "in web", output: "ok", status: "completed", exitCode: 0, edits: [{ path: "a.ts", additions: 1, deletions: 0 }], kind: "command" } },
  { type: "planDelta", id: "p1", text: "1. " },
  { type: "planCompleted", id: "p1", markdown: "1. Read the code" },
  { type: "todos", steps: [{ text: "Read", status: "done" }, { text: "Write", status: "active" }, { text: "Ship", status: "pending" }] },
  { type: "approval", request: { id: "req-1", kind: "command", title: "rm -rf build", detail: "in web", reason: "It asked.", options: [{ id: "allow", title: "Allow", role: "approve" }, { id: "deny", title: "Deny", role: "decline" }], toolItemID: "t1" } },
  { type: "question", request: { id: "ask-1", questions: [{ id: "q", header: "Where", prompt: "Which folder?", choices: [{ label: "src", detail: "the code" }], allowsMultiple: false, allowsOther: true, isSecret: false }] } },
  { type: "requestResolved", id: "req-1" },
  { type: "usage", usage: { usedTokens: 90_000, windowTokens: 200_000, freshInputTokens: 1_000, cacheReadTokens: 80_000, cacheWriteTokens: 5_000, outputTokens: 4_000 } },
  { type: "spend", tokens: 1_200, model: "opus" },
  { type: "sources", messageID: "m1", sources: [researchSourceRecord({ index: 1, url: "https://swift.org", title: "Swift", retrievedAt: AT, provider: "perplexity", runID: "run-1", responseID: "resp-1" })] },
  { type: "diff", diff: "--- a\n+++ b\n" },
  { type: "notice", notice: { level: "warning", message: "Careful." } },
  { type: "usageLimit", resetsAt: "2026-11-23T09:00:00Z" },
  { type: "modeChanged", mode: "plan" },
  { type: "models", models: [{ id: "opus", name: "Opus", efforts: ["low", "high"], isDefault: true, contextWindow: 200_000 }], current: "sonnet" },
  { type: "commands", commands: [{ name: "compact", detail: "Summarize the conversation", isBuiltIn: true }] },
  { type: "sessionFeatures", features: { readsSettings: true, ultracodeAvailable: true, ultracodeRequested: true, ultracodeActive: true, workflowsEnabled: true, keywordTriggerEnabled: false, appliedEffort: "high" } },
  { type: "title", title: "Fix the flaky test" },
  { type: "assistantMessageID", messageID: "msg_01" },
  { type: "turnCompleted", status: "failed", error: "The provider failed." },
  { type: "exited", error: "Killed." },
  { type: "agentStarted", spawn: { id: "agent-1", taskID: "task-1", toolUseID: "t1", description: "Refactor the model", prompt: "Refactor it", model: "sonnet", isBackground: false } },
  { type: "agentEvent", agentID: "agent-1", event: { type: "agentEvent", agentID: "agent-2", event: { type: "messageCompleted", id: "h1", text: "Done." } } },
  { type: "agentProgress", agentID: "agent-1", summary: "Reading", lastTool: "Read", tokens: 900, toolCalls: 4 },
  { type: "agentFinished", agentID: "agent-1", status: "completed", summary: "Refactored." },
];

describe("the event contract", () => {
  it("names thirty-three kinds, GoSpark's ProviderEvent case for case", () => {
    expect(PROVIDER_EVENT_TYPES.length).toBe(33);
    expect(everyEvent.map((event) => event.type)).toEqual([...PROVIDER_EVENT_TYPES]);
  });

  // GoSpark's RemoteWireTests.eventsRoundTrip, for the events this contract carries.
  it("every event is its own JSON and round-trips unchanged", () => {
    for (const event of everyEvent) {
      expect(decodeProviderEvent(overTheWire(event)), event.type).toStrictEqual(event);
    }
  });

  it("an event with only its type decodes with every optional absent, not undefined", () => {
    expect(decodeProviderEvent({ type: "turnStarted" })).toStrictEqual({ type: "turnStarted" });
    expect(decodeProviderEvent({ type: "exited" })).toStrictEqual({ type: "exited" });
    expect(decodeProviderEvent({ type: "usageLimit" })).toStrictEqual({ type: "usageLimit" });
    expect(decodeProviderEvent({ type: "spend" })).toStrictEqual({ type: "spend", tokens: 0 });
    expect(decodeProviderEvent({ type: "agentProgress" })).toStrictEqual({ type: "agentProgress", agentID: "" });
  });
});

/// GoSpark's RemoteWireTests.unknownEventDecodes and unknownCommandDecodes: anything unrecognised
/// lands in a case that exists rather than throwing.
describe("unknown kinds", () => {
  it("unknownEventDecodes: an event this build has never heard of decodes as unknown, with what arrived", () => {
    const json = { type: "cosmicRay", threadID: "x", strength: 9 };
    expect(decodeProviderEvent(json)).toStrictEqual({ type: "unknown", rawType: "cosmicRay", raw: json });
  });

  it("anything that is not an event decodes as unknown and never throws", () => {
    for (const value of [undefined, null, 7, "messageDelta", [], [{ type: "exited" }], true, {}, { type: 7 }, { type: null }]) {
      const decoded = decodeProviderEvent(value);
      expect(decoded.type).toBe("unknown");
      expect(decoded).toMatchObject({ raw: value });
    }
  });

  it("a kind named after something every object has is still only an unknown kind", () => {
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(decodeProviderEvent(JSON.parse(`{"type":"${type}"}`))).toMatchObject({ type: "unknown", rawType: type });
    }
  });

  it("a key off the prototype is not a field", () => {
    expect(readValue({}, "constructor")).toBeUndefined();
    expect(readValue({}, "toString")).toBeUndefined();
    expect(readValue(JSON.parse('{"constructor":"mine"}'), "constructor")).toBe("mine");
  });

  it("an unknown event inside a sub-agent stays inside it", () => {
    const decoded = decodeProviderEvent({ type: "agentEvent", agentID: "a", event: { type: "cosmicRay" } });
    expect(decoded).toStrictEqual({ type: "agentEvent", agentID: "a", event: { type: "unknown", rawType: "cosmicRay", raw: { type: "cosmicRay" } } });
  });

  it("sub-agents nested without end stop at a depth instead of overflowing the stack", () => {
    let json: unknown = { type: "exited" };
    for (let depth = 0; depth < 5_000; depth += 1) json = { type: "agentEvent", agentID: "a", event: json };
    let decoded = decodeProviderEvent(json);
    let levels = 0;
    while (decoded.type === "agentEvent") {
      decoded = decoded.event;
      levels += 1;
    }
    expect(levels).toBe(8);
    expect(decoded).toMatchObject({ type: "unknown", rawType: "agentEvent" });
  });
});

describe("unknown enum values", () => {
  it("are kept as unknown where GoSpark has no fallback, so the event still arrives", () => {
    expect(decodeProviderEvent({ type: "turnCompleted", status: "paused" })).toStrictEqual({ type: "turnCompleted", status: "unknown" });
    expect(decodeProviderEvent({ type: "turnCompleted" })).toStrictEqual({ type: "turnCompleted", status: "unknown" });
    expect(decodeProviderEvent({ type: "agentFinished", agentID: "a", status: 3 })).toStrictEqual({ type: "agentFinished", agentID: "a", status: "unknown" });
    expect(decodeProviderEvent({ type: "modeChanged", mode: "review" })).toStrictEqual({ type: "modeChanged", mode: "unknown" });
    expect(decodeProviderEvent({ type: "notice", notice: { level: "loud", message: "Hi" } })).toStrictEqual({ type: "notice", notice: { level: "unknown", message: "Hi" } });
    expect(decodeProviderEvent({ type: "todos", steps: [{ text: "Wait", status: "blocked" }] })).toStrictEqual({ type: "todos", steps: [{ text: "Wait", status: "unknown" }] });
    const started = decodeProviderEvent({ type: "toolStarted", id: "t", call: { kind: "hologram", title: "Project", status: "paused" } }, fixedContext());
    expect(started).toMatchObject({ type: "toolStarted", call: { kind: "unknown", status: "unknown" } });
  });

  it("an update names a status or a kind it cannot read as unknown, and says nothing about one it does not carry", () => {
    expect(decodeProviderEvent({ type: "toolUpdated", id: "t", update: { status: "paused", kind: "hologram" } })).toStrictEqual({
      type: "toolUpdated",
      id: "t",
      update: { status: "unknown", kind: "unknown" },
    });
    expect(decodeProviderEvent({ type: "toolUpdated", id: "t", update: { status: null } })).toStrictEqual({ type: "toolUpdated", id: "t", update: {} });
  });

  it("take GoSpark's fallback where it has one: an unreadable role declines, an unreadable kind is the general one", () => {
    const decoded = decodeProviderEvent({ type: "approval", request: { id: "r", kind: "teleport", options: [{ id: "go", title: "Go", role: "superApprove" }] } });
    expect(decoded).toStrictEqual({ type: "approval", request: { id: "r", kind: "tool", title: "", options: [{ id: "go", title: "Go", role: "decline" }] } });
  });
});

describe("missing fields", () => {
  it("a missing text or id takes the empty default", () => {
    expect(decodeProviderEvent({ type: "messageDelta" })).toStrictEqual({ type: "messageDelta", id: "", text: "" });
    expect(decodeProviderEvent({ type: "messageCompleted", id: 7, text: ["a"] })).toStrictEqual({ type: "messageCompleted", id: "", text: "" });
    expect(decodeProviderEvent({ type: "planCompleted", id: "p" })).toStrictEqual({ type: "planCompleted", id: "p", markdown: "" });
    expect(decodeProviderEvent({ type: "sessionReady" })).toStrictEqual({ type: "sessionReady", sessionID: "" });
    expect(decodeProviderEvent({ type: "requestResolved" })).toStrictEqual({ type: "requestResolved", id: "" });
  });

  it("a kind missing the one value it exists to carry is unknown, never a blank stand-in", () => {
    const hollow = [
      { type: "toolStarted", id: "t" },
      { type: "toolUpdated", id: "t", update: "done" },
      { type: "todos" },
      { type: "todos", steps: "none" },
      { type: "approval" },
      { type: "approval", request: [] },
      { type: "question", request: "why" },
      { type: "usage", usage: { windowTokens: 5 } },
      { type: "sources", messageID: "m" },
      { type: "diff" },
      { type: "notice" },
      { type: "models", current: "x" },
      { type: "commands", commands: {} },
      { type: "sessionFeatures" },
      { type: "title" },
      { type: "assistantMessageID" },
      { type: "agentStarted" },
      { type: "agentEvent", agentID: "a" },
    ];
    for (const json of hollow) {
      expect(decodeProviderEvent(json), JSON.stringify(json)).toStrictEqual({ type: "unknown", rawType: json.type, raw: json });
    }
  });

  it("one unreadable element of a list costs only itself", () => {
    expect(decodeProviderEvent({ type: "todos", steps: [{ text: "Keep", status: "done" }, 7, null] })).toStrictEqual({
      type: "todos",
      steps: [{ text: "Keep", status: "done" }],
    });
    expect(decodeProviderEvent({ type: "models", models: [{ id: "a", name: "A" }, { name: "no id" }] })).toStrictEqual({
      type: "models",
      models: [{ id: "a", name: "A", efforts: [], isDefault: false }],
    });
    expect(decodeProviderEvent({ type: "commands", commands: [{ name: "plan" }, {}] })).toStrictEqual({
      type: "commands",
      commands: [{ name: "plan", detail: "", isBuiltIn: false }],
    });
  });

  it("a wrong-typed optional is absent, and a call with no start takes the time of reading", () => {
    expect(decodeProviderEvent({ type: "spend", tokens: "many", model: 5 })).toStrictEqual({ type: "spend", tokens: 0 });
    expect(decodeProviderEvent({ type: "usageLimit", resetsAt: "soon" })).toStrictEqual({ type: "usageLimit" });
    expect(decodeProviderEvent({ type: "agentProgress", agentID: "a", tokens: 1.5, toolCalls: "3" })).toStrictEqual({ type: "agentProgress", agentID: "a" });
    expect(decodeProviderEvent({ type: "toolStarted", id: "t", call: { kind: "read", title: "notes.txt" } }, fixedContext())).toStrictEqual({
      type: "toolStarted",
      id: "t",
      call: toolCall({ kind: "read", title: "notes.txt", startedAt: AT }),
    });
    expect(decodeProviderEvent({ type: "agentStarted", spawn: {} })).toStrictEqual({ type: "agentStarted", spawn: { id: "", description: "", isBackground: true } });
  });

  it("a request's stamps arrive as written, in lower case", () => {
    const decoded = decodeProviderEvent({ type: "question", request: { id: "q", questions: [], turnID: uuid(5).toUpperCase() } });
    expect(decoded).toStrictEqual({ type: "question", request: { id: "q", questions: [], turnID: uuid(5) } });
  });
});
