import { describe, expect, it } from "vitest";
import {
  type AssistantMessage,
  type ContextUsage,
  type TimelineItem,
  type ToolCall,
  type UserMessage,
  completedPlan,
  cutOffToolCall,
  decodeAssistantMessage,
  decodeContextUsage,
  decodeProposedPlan,
  decodeTimelineItem,
  decodeToolCall,
  decodeUserMessage,
  encodeTimelineItem,
  finishToolCall,
  finishToolCallEndingTurn,
  isOutcomeUnknown,
  toolCall,
  usageFraction,
  usageHasSplit,
  userMessage,
} from "../src/index";
import { AT, fixedContext, overTheWire, uuid } from "./support";

const LATER = "2026-11-23T05:00:09Z";

/// `AssistantMessage` gained `actedOnDelegationBlocks` after every stored reply had been saved
/// without it. Ported from GoSpark's `Tests/AssistantMessageDecodingTests.swift`.
describe("AssistantMessageDecodingTests", () => {
  it("decodesHistoryWithoutTheRecord: a reply saved before the delegation record existed loads with none", () => {
    expect(decodeAssistantMessage({ text: "done", isStreaming: false })).toStrictEqual({ text: "done", isStreaming: false });
  });

  it("decodesWithOnlyText: the barest possible reply still loads", () => {
    expect(decodeAssistantMessage({ text: "hello" })?.text).toBe("hello");
    expect(decodeAssistantMessage({})?.text).toBe("");
  });

  it("wrongTypedRecordIsIgnored: a value this build cannot read counts as nothing recorded", () => {
    const message = decodeAssistantMessage({ text: "done", actedOnDelegationBlocks: "yes" });
    expect(message?.actedOnDelegationBlocks).toBeUndefined();
  });

  it("roundTrips: both records round-trip, and a reply with none writes no key", () => {
    for (const acted of [true, false]) {
      const original: AssistantMessage = { text: "Splitting.", isStreaming: false, actedOnDelegationBlocks: acted };
      expect(decodeAssistantMessage(overTheWire(original))).toStrictEqual(original);
    }
    const plain = overTheWire(decodeAssistantMessage({ text: "done" }));
    expect(plain).toStrictEqual({ text: "done", isStreaming: false });
  });
});

/// `UserMessage` gained `wasSteered` after threads had already been saved without it. Ported
/// from GoSpark's `Tests/UserMessageDecodingTests.swift`.
describe("UserMessageDecodingTests", () => {
  it("decodesHistoryWithoutTheField: a message saved before steering existed still loads", () => {
    const message = decodeUserMessage({ text: "ship it", attachments: [] });
    expect(message).toStrictEqual(userMessage("ship it"));
  });

  it("decodesWithOnlyText: the barest possible message still loads", () => {
    expect(decodeUserMessage({ text: "hello" })?.text).toBe("hello");
    expect(decodeUserMessage({})?.text).toBe("");
  });

  it("decodesLegacyHydraHeads: a report keeps its roster places", () => {
    const message = decodeUserMessage({ text: "report", hydraHeads: [1, 3] });
    expect(message?.buddyHeads).toEqual([1, 3]);
    expect(message?.wasSteered).toBe(false);
  });

  it("decodesBuddyHeads: a report stored under buddyHeads still loads", () => {
    expect(decodeUserMessage({ text: "report", buddyHeads: [2, 4] })?.buddyHeads).toEqual([2, 4]);
  });

  it("buddyHeadsWin: buddyHeads wins when both keys are present", () => {
    expect(decodeUserMessage({ text: "report", buddyHeads: [7], hydraHeads: [1, 3] })?.buddyHeads).toEqual([7]);
  });

  it("encodesBuddyHeads: encoding a report writes buddyHeads and not hydraHeads", () => {
    const original: UserMessage = { ...userMessage("report"), buddyHeads: [1, 3] };
    const written = overTheWire(original) as Record<string, unknown>;
    expect(written["buddyHeads"]).toEqual([1, 3]);
    expect("hydraHeads" in written).toBe(false);
    expect(decodeUserMessage(written)).toStrictEqual(original);
  });

  it("roundTrips: a steered message survives a round trip", () => {
    for (const wasSteered of [true, false]) {
      const original: UserMessage = { ...userMessage("check the logs"), wasSteered };
      expect(decodeUserMessage(overTheWire(original))).toStrictEqual(original);
    }
  });

  it("toleratesABadAttachment: one unreadable attachment does not take the message with it", () => {
    const good = { id: uuid(1), name: "notes.txt", path: "/tmp/notes.txt", mimeType: "text/plain" };
    const message = decodeUserMessage({ text: "look", attachments: [{ nonsense: true }, good] });
    expect(message?.text).toBe("look");
    expect(message?.attachments).toStrictEqual([good]);
  });
});

/// Ported from `MessageSourceTests` in GoSpark's `Tests/UserMessageDecodingTests.swift`.
describe("MessageSourceTests", () => {
  it("legacyDocumentsDefaultToMac: a document written before this field decodes as sent from the Mac", () => {
    expect(decodeUserMessage({ text: "hello", attachments: [], wasSteered: false })?.source).toStrictEqual({ type: "mac" });
  });

  it("remoteSourceRoundTrips: a remote source round-trips with the device name", () => {
    const message: UserMessage = { ...userMessage("run the tests"), source: { type: "remote", deviceName: "An iPhone" } };
    expect(decodeUserMessage(overTheWire(message))?.source).toStrictEqual({ type: "remote", deviceName: "An iPhone" });
  });

  it("unknownSourceFallsBack: a source this build cannot read decodes as the Mac rather than losing the message", () => {
    const message = decodeUserMessage({ text: "hello", source: { type: "satellite" } });
    expect(message?.text).toBe("hello");
    expect(message?.source).toStrictEqual({ type: "mac" });
  });
});

/// A tool call that a Stop or a quit cut off may well have done its work, so it is marked rather
/// than called a failure, and older readers must keep reading it as `failed`. The saved form and
/// the mark, ported from GoSpark's `Tests/ToolCutOffStatusTests.swift`; the runtime half is in
/// `reducer-turns.test.ts`.
describe("ToolCutOffStatusTests", () => {
  const started = (title: string): ToolCall => toolCall({ kind: "command", title, startedAt: AT });

  it("missingKeyDecodesAsNoMark: a call saved before the mark decodes with no mark", () => {
    const call = decodeToolCall({
      kind: "command",
      title: "npm test",
      output: "",
      status: "failed",
      edits: [],
      startedAt: "2026-09-01T10:00:00Z",
    });
    expect(call?.status).toBe("failed");
    expect(call && "cutOff" in call).toBe(false);
    expect(call && isOutcomeUnknown(call)).toBe(false);
  });

  it("cutOffEncodesAsFailed: a cut-off call is saved as failed, with the mark beside it", () => {
    const json = JSON.stringify(cutOffToolCall(started("npm test"), LATER));
    expect(json).toContain('"status":"failed"');
    expect(json).toContain('"cutOff":true');
    const decoded = decodeToolCall(JSON.parse(json));
    expect(decoded && isOutcomeUnknown(decoded)).toBe(true);
  });

  it("uncutCallHasNoKey: a call that was never cut off is saved without the key", () => {
    expect(JSON.stringify(finishToolCall(started("npm test"), "failed", LATER))).not.toContain("cutOff");
  });

  // An older build decodes the same fields and ignores a key it does not know.
  it("olderBuildReadsFailed: an older build reads a cut-off call as failed", () => {
    const call: ToolCall = { ...toolCall({ kind: "edit", title: "Edit notes.txt", startedAt: AT }), exitCode: 1, edits: [{ path: "notes.txt", additions: 2, deletions: 0 }] };
    const written = overTheWire(cutOffToolCall(call, LATER)) as Record<string, unknown>;
    const { cutOff: _unknownToIt, ...previous } = written;
    expect(previous).toStrictEqual({
      kind: "edit",
      title: "Edit notes.txt",
      output: "",
      status: "failed",
      exitCode: 1,
      edits: [{ path: "notes.txt", additions: 2, deletions: 0 }],
      startedAt: AT,
      finishedAt: LATER,
    });
  });

  it("turnEndingDecides: a turn's ending decides how a running call ends", () => {
    const ended = (status: Parameters<typeof finishToolCallEndingTurn>[1]) => finishToolCallEndingTurn(started("make"), status, LATER);
    expect(ended("completed").status).toBe("completed");
    expect(isOutcomeUnknown(ended("completed"))).toBe(false);
    expect(ended("interrupted").status).toBe("failed");
    expect(isOutcomeUnknown(ended("interrupted"))).toBe(true);
    expect(ended("failed").status).toBe("failed");
    expect(isOutcomeUnknown(ended("failed"))).toBe(false);
    expect(ended("interrupted").finishedAt).toBe(LATER);
  });

  it("an ending this build cannot name leaves the call's outcome unknown", () => {
    expect(isOutcomeUnknown(finishToolCallEndingTurn(started("make"), "unknown", LATER))).toBe(true);
  });

  it("lateOutcomeClearsMark: a late word from the provider replaces the mark", () => {
    const completed = finishToolCall(cutOffToolCall(started("make"), LATER), "completed", "2026-11-23T05:00:30Z");
    expect(completed.status).toBe("completed");
    expect("cutOff" in completed).toBe(false);
    // The first ending keeps its time.
    expect(completed.finishedAt).toBe(LATER);
    expect(isOutcomeUnknown(finishToolCall(cutOffToolCall(started("make"), LATER), "failed", LATER))).toBe(false);
  });
});

describe("a tool call from a newer writer", () => {
  it("keeps a kind and a status this build cannot name as unknown instead of losing the row", () => {
    const call = decodeToolCall({ kind: "hologram", title: "Project it", status: "paused", startedAt: AT });
    expect(call).toStrictEqual({ kind: "unknown", title: "Project it", output: "", status: "unknown", edits: [], startedAt: AT });
  });

  it("gives every missing field its default, and a missing start the time of reading", () => {
    expect(decodeToolCall({}, fixedContext())).toStrictEqual({
      kind: "unknown",
      title: "",
      output: "",
      status: "running",
      edits: [],
      startedAt: AT,
    });
    expect(decodeToolCall({ exitCode: "one", edits: [7, { path: "a.txt" }] }, fixedContext())?.edits).toStrictEqual([
      { path: "a.txt", additions: 0, deletions: 0 },
    ]);
  });
});

/// The saved-plan half of GoSpark's `PlanRevisionTests.oldPlans`.
describe("PlanRevisionTests", () => {
  it("oldPlans: plans saved before revisions decode as revision 1", () => {
    expect(decodeProposedPlan({ markdown: "1. Read the code", state: "accepted" })).toStrictEqual({
      markdown: "1. Read the code",
      state: "accepted",
      revision: 1,
    });
  });

  it("oldPlans: a state this build cannot read, or none, is dismissed, so it never offers Implement", () => {
    expect(decodeProposedPlan({})).toStrictEqual({ markdown: "", state: "dismissed", revision: 1 });
    expect(decodeProposedPlan({ markdown: "1. A", state: "superseded", revision: 2 })).toStrictEqual({
      markdown: "1. A",
      state: "dismissed",
      revision: 2,
    });
    expect(decodeProposedPlan({ markdown: "1. A", state: "proposed", revision: "two" })).toStrictEqual({
      markdown: "1. A",
      state: "proposed",
      revision: 1,
    });
  });

  it("oldPlans: a thread saved before revisions keeps its plan, and saving it again writes the revision", () => {
    const item = decodeTimelineItem({
      id: "plan-1",
      date: "2026-11-01T00:00:00Z",
      content: { plan: { _0: { markdown: "1. Read the code", state: "proposed" } } },
    });
    expect(item?.id).toBe("plan-1");
    expect(item?.content).toStrictEqual({ type: "plan", plan: { markdown: "1. Read the code", state: "proposed", revision: 1 } });
    // GoSpark's storage sorts keys, so the same three keys are compared as an object.
    const rewritten = overTheWire(item && encodeTimelineItem(item)) as { content: { plan: { _0: unknown } } };
    expect(rewritten.content.plan._0).toStrictEqual({ markdown: "1. Read the code", revision: 1, state: "proposed" });
  });

  it("bumps: the rule on its own, a dismissed plan the agent changes is the next revision, proposed", () => {
    const dismissed = { markdown: "1. A", state: "dismissed", revision: 4 } as const;
    expect(completedPlan(dismissed, "1. B", false)).toStrictEqual({ markdown: "1. B", state: "proposed", revision: 5 });
    expect(completedPlan(dismissed, "1. A", false)).toStrictEqual(dismissed);
    expect(completedPlan(dismissed, "", false)).toStrictEqual(dismissed);
    expect(completedPlan(dismissed, "1. B", true)).toStrictEqual({ markdown: "1. B", state: "dismissed", revision: 4 });
  });
});

/// The value half of GoSpark's `Tests/UsageSplitTests.swift`. The ledger and the Settings
/// wording it also covers are GoSpark's own.
describe("UsageSplitTests", () => {
  it("splitDefaultsAbsent: a usage reading without a split stays a plain total", () => {
    expect(usageHasSplit({ usedTokens: 100, windowTokens: 1_000 })).toBe(false);
    // Readings recorded before the split existed decode with no split.
    const decoded = decodeContextUsage({ usedTokens: 100 });
    expect(decoded).toStrictEqual({ usedTokens: 100 });
    expect(decoded && usageHasSplit(decoded)).toBe(false);
  });

  it("splitRoundTrips: a split survives encoding", () => {
    const usage: ContextUsage = { usedTokens: 200_000, windowTokens: 200_000, freshInputTokens: 12_000, cacheReadTokens: 175_000, outputTokens: 3_200 };
    expect(usageHasSplit(usage)).toBe(true);
    expect(decodeContextUsage(overTheWire(usage))).toStrictEqual(usage);
  });

  it("the meter reads against the window, and has nothing to read against without one", () => {
    expect(usageFraction({ usedTokens: 50, windowTokens: 200 })).toBe(0.25);
    expect(usageFraction({ usedTokens: 500, windowTokens: 200 })).toBe(1);
    expect(usageFraction({ usedTokens: 50 })).toBeUndefined();
    expect(usageFraction({ usedTokens: 50, windowTokens: 0 })).toBeUndefined();
  });

  it("a reading with no total is no reading", () => {
    expect(decodeContextUsage({ windowTokens: 1_000 })).toBeUndefined();
    expect(decodeContextUsage({ usedTokens: "many" })).toBeUndefined();
  });
});

/// The rows a paired phone and a thread file both carry. The item cases of GoSpark's
/// `Tests/Shared/RemoteWireTests.swift` and `Tests/Shared/ResearchEvidenceTests.swift`.
describe("RemoteWireTests", () => {
  it("eventsRoundTrip: a row survives a round trip through GoSpark's wire shape", () => {
    const rows: TimelineItem[] = [
      { id: "u1", turnID: uuid(1), date: AT, content: { type: "user", message: userMessage("hello") } },
      { id: "a1", turnID: uuid(1), date: AT, content: { type: "assistant", message: { text: "hello", isStreaming: false } } },
      { id: "r1", date: AT, content: { type: "reasoning", block: { text: "thinking", isStreaming: true } } },
      { id: "t1", turnID: uuid(1), date: AT, content: { type: "tool", call: toolCall({ kind: "read", title: "notes.txt", startedAt: AT }) } },
      { id: "p1", date: AT, content: { type: "plan", plan: { markdown: "1. A", state: "proposed", revision: 2 } } },
      { id: "d1", date: AT, content: { type: "todos", steps: [{ text: "Write it", status: "active" }] } },
      { id: "n1", date: AT, content: { type: "notice", notice: { level: "warning", message: "Careful." } } },
      { id: "e1", turnID: uuid(1), date: AT, content: { type: "turnEnd", summary: { turnID: uuid(1), status: "completed", duration: 4.5, filesChanged: 2, additions: 10, deletions: 3 } } },
      { id: "s1", date: AT, content: { type: "modelSwitch", info: { provider: "claude", model: "opus", modelName: "Opus", effort: "high", kind: "live", buddyDisabled: false } } },
    ];
    for (const row of rows) {
      expect(decodeTimelineItem(overTheWire(encodeTimelineItem(row)))).toStrictEqual(row);
    }
  });

  it("writes a row the way Swift's synthesized coding does: one case key, its value under _0", () => {
    const row: TimelineItem = { id: "a1", date: AT, content: { type: "assistant", message: { text: "Hello", isStreaming: false } } };
    expect(encodeTimelineItem(row)).toStrictEqual({ id: "a1", date: AT, content: { assistant: { _0: { text: "Hello", isStreaming: false } } } });
  });

  // GoSpark's phone drops such a row, because its decoder throws. Here it keeps its place.
  it("unreadableUpsertedItemIsAbsent: a row whose content this build cannot read is kept as unknown, and written back unchanged", () => {
    const written = { id: "item-1", turnID: null, date: "2026-09-17T00:00:00Z", content: { hologram: { _0: { text: "hi" } } } };
    const item = decodeTimelineItem(written);
    expect(item).toStrictEqual({
      id: "item-1",
      date: "2026-09-17T00:00:00Z",
      content: { type: "unknown", rawType: "hologram", raw: { hologram: { _0: { text: "hi" } } } },
    });
    expect(item && encodeTimelineItem(item)).toStrictEqual({ id: "item-1", date: "2026-09-17T00:00:00Z", content: written.content });
  });

  it("a known kind with nothing readable in it is unknown too, never a blank row of that kind", () => {
    for (const content of [{ tool: {} }, { tool: { _0: 7 } }, { todos: { _0: "none" } }, { turnEnd: { _0: {} } }, { modelSwitch: { _0: { model: "x" } } }, { user: 1, tool: 2 }, "text", undefined]) {
      const item = decodeTimelineItem({ id: "x", date: AT, content });
      expect(item?.content.type).toBe("unknown");
    }
  });

  it("a row with no id is dropped, and one with no readable date takes the time of reading", () => {
    expect(decodeTimelineItem({ id: 7 })).toBeUndefined();
    expect(decodeTimelineItem({ date: AT, content: {} })).toBeUndefined();
    expect(decodeTimelineItem("row")).toBeUndefined();
    const undated = decodeTimelineItem({ id: "a", date: "yesterday", turnID: "not-a-uuid", content: { notice: { _0: { level: "loud" } } } }, fixedContext());
    expect(undated).toStrictEqual({ id: "a", date: AT, content: { type: "notice", notice: { level: "unknown", message: "" } } });
  });
});

describe("ResearchEvidenceTests", () => {
  it("legacyAssistantMessage: an answer saved before sources were kept reads with no sources", () => {
    const message = decodeAssistantMessage({ text: "Swift 6 shipped in 2024 [1].", isStreaming: false });
    expect(message && "sources" in message).toBe(false);
    // A whole timeline item, as a thread file from before holds it.
    const item = decodeTimelineItem({ id: "a1", date: "2026-09-01T10:00:00Z", content: { assistant: { _0: { text: "Hello" } } } });
    expect(item?.content).toStrictEqual({ type: "assistant", message: { text: "Hello", isStreaming: false } });
  });
});
