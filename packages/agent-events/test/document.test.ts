import { describe, expect, it } from "vitest";
import {
  type ThreadDocument,
  type TimelineItem,
  decodeSparkTaskAttempt,
  decodeTaskBrief,
  decodeThreadDocument,
  decodeTurnRecord,
  encodeThreadDocument,
  encodeTimelineItem,
  parseJSON,
  userMessage,
} from "../src/index";
import { AT, fixedContext, overTheWire, uuid } from "./support";

/// A thread file that will not decode takes the whole conversation with it. These pin that
/// every field tolerates a missing or wrong-typed value, which is the only thing standing
/// between a future field and an unreadable library. Ported from GoSpark's
/// `Tests/ThreadDocumentDecodingTests.swift`. Left out: `fileNameWinsOverTheStoredKey`, which
/// tests GoSpark's own `Storage`.
describe("ThreadDocumentDecodingTests", () => {
  const documentJSON = (threadID: string | undefined): string => `{
    ${threadID === undefined ? "" : `"threadID": ${threadID},`}
    "items": [],
    "turns": [],
    "followUps": [{"id": "${uuid(9)}", "text": "queued", "attachments": [], "createdAt": "2026-01-01T00:00:00Z"}]
  }`;

  it("missingThreadIDKeepsHistory: a missing threadID keeps the rest of the history", () => {
    const document = decodeThreadDocument(parseJSON(documentJSON(undefined)), fixedContext());
    expect(document?.followUps).toStrictEqual([
      { id: uuid(9), text: "queued", attachments: [], createdAt: "2026-01-01T00:00:00Z", source: { type: "mac" } },
    ]);
    // The id it takes instead is a fresh one, which the caller that knows the real one corrects.
    expect(document?.threadID).toBe(uuid(0xd000));
  });

  it("malformedThreadIDKeepsHistory: a malformed threadID keeps the rest of the history", () => {
    expect(decodeThreadDocument(parseJSON(documentJSON('"not-a-uuid"')))?.followUps.length).toBe(1);
  });

  it("wrongTypedThreadIDKeepsHistory: a wrong-typed threadID keeps the rest of the history", () => {
    expect(decodeThreadDocument(parseJSON(documentJSON("42")))?.followUps.length).toBe(1);
  });

  it("truncatedFileIsSurvivable: a truncated file decodes to nothing rather than throwing past the caller", () => {
    expect(decodeThreadDocument(parseJSON('{"items": ['))).toBeUndefined();
  });

  it("oneBadItemDropsOnlyItself: one malformed item among good ones drops only itself", () => {
    // Encoded rather than hand-written, so this pins the tolerance and not a guess at the wire shape.
    const item: TimelineItem = { id: "hello-1", date: AT, content: { type: "user", message: userMessage("hello") } };
    const good = encodeTimelineItem(item);
    const document = decodeThreadDocument({ threadID: uuid(1), items: [good, { id: 7 }, { ...(good as object), id: "hello-2" }] });
    expect(document?.items.map((each) => each.id)).toEqual(["hello-1", "hello-2"]);
  });

  it("servedModelIsRecorded: a turn records the model the provider actually served", () => {
    const turn = decodeTurnRecord({ index: 0, provider: "claude", model: "opus-5", servedModel: "sonnet-9" });
    expect(turn?.model).toBe("opus-5");
    expect(turn?.servedModel).toBe("sonnet-9");
  });

  it("oldDocument: a document holding nothing but its id decodes", () => {
    expect(decodeThreadDocument({ threadID: "00000000-0000-0000-0000-000000000000" })).toStrictEqual({
      threadID: "00000000-0000-0000-0000-000000000000",
      items: [],
      turns: [],
      followUps: [],
      attempts: [],
    });
  });

  it("servedModelDefaultsNil: turns saved before served-model attribution existed decode as unattributed", () => {
    const turn = decodeTurnRecord({ index: 0 }, fixedContext());
    expect(turn).toStrictEqual({ id: uuid(0xd000), index: 0, startedAt: AT, status: "running", buddyMerged: false });
  });

  it("a turn keeps what it can read, and a status this build cannot read is GoSpark's default, running", () => {
    const turn = decodeTurnRecord({ id: uuid(3).toUpperCase(), index: "first", status: "paused", touchedPaths: ["a.swift", 7], completedAt: 12 }, fixedContext());
    expect(turn).toStrictEqual({ id: uuid(3), index: 0, startedAt: AT, status: "running", buddyMerged: false });
  });

  it("a document read and written back is the document GoSpark wrote", () => {
    const written = {
      threadID: uuid(1),
      items: [
        { id: "u1", turnID: uuid(2), date: AT, content: { user: { _0: { text: "hi", attachments: [], wasSteered: false, source: { type: "mac" } } } } },
        { id: "x1", date: AT, content: { hologram: { _0: { text: "from a newer build" } } } },
      ],
      turns: [{ id: uuid(2), index: 0, startedAt: AT, status: "completed", buddyMerged: false, userItemID: "u1" }],
      usage: { usedTokens: 1_200, windowTokens: 200_000 },
      followUps: [],
      pendingHandoff: "kept",
      attempts: [],
    };
    const document = decodeThreadDocument(written) as ThreadDocument;
    expect(overTheWire(encodeThreadDocument(document))).toStrictEqual(written);
  });
});

/// Ported from the decoding cases of GoSpark's `Tests/TaskBriefTests.swift` and
/// `Tests/TaskBriefPersistenceTests.swift`. The brief's own rules (editing a criterion, what
/// counts as complete) belong to whatever runs tasks and are not in this package.
describe("TaskBriefTests", () => {
  it("tolerantDecoding: old histories load with safe defaults, corrupt criteria drop", () => {
    const restored = decodeTaskBrief({ playbookID: "review-changes" }, fixedContext());
    expect(restored).toStrictEqual({
      id: uuid(0xd000),
      playbookID: "review-changes",
      playbookVersion: 1,
      objective: "",
      scope: "",
      criteria: [],
      outcome: "draft",
      updatedAt: AT,
    });
    // Identity is required: a criterion without one is dropped.
    const kept = decodeTaskBrief({ playbookID: "x", criteria: [{ text: "Keep me" }, { id: "not-a-uuid", text: "Drop me" }] });
    expect(kept?.criteria).toEqual([]);
    const identified = decodeTaskBrief({ playbookID: "x", criteria: [{ id: uuid(5), text: "Has identity" }, 7] });
    expect(identified?.criteria).toStrictEqual([{ id: uuid(5), text: "Has identity", isSatisfied: false }]);
  });
});

describe("TaskBriefPersistenceTests", () => {
  it("roundTrip: a document with a brief round-trips with criteria and outcome intact", () => {
    const brief = {
      id: uuid(7),
      playbookID: "fix-bug",
      playbookVersion: 1,
      objective: "Stop the crash on launch.",
      scope: "Only the launch path.",
      criteria: [{ id: uuid(8), text: "Reproduces before the fix", isSatisfied: false }],
      outcome: "active",
      updatedAt: AT,
    };
    const document = decodeThreadDocument({ threadID: uuid(1), taskBrief: brief });
    expect(document?.taskBrief).toStrictEqual(brief);
    expect(decodeThreadDocument(overTheWire(document && encodeThreadDocument(document)))).toStrictEqual(document);
  });

  it("absentStaysAbsent: no brief writes no brief, and old histories load without one", () => {
    const legacy = decodeThreadDocument({ threadID: uuid(1) });
    expect(legacy && "taskBrief" in legacy).toBe(false);
    expect(legacy?.followUps).toEqual([]);
    expect(JSON.stringify(legacy && encodeThreadDocument(legacy))).not.toContain("taskBrief");
  });
});

/// Ported from the decoding cases of GoSpark's `Tests/TaskAttemptLineageTests.swift`. Opening,
/// closing and retrying an attempt is the task runner's work and is not in this package.
describe("TaskAttemptLineageTests", () => {
  it("oldDocumentDecodes: a document written before attempts decodes with none", () => {
    const old = { threadID: uuid(1), items: [], turns: [], followUps: [], pendingHandoff: "kept" };
    const document = decodeThreadDocument(old);
    expect(document?.attempts).toEqual([]);
    expect(document?.threadID).toBe(uuid(1));
    expect(document?.pendingHandoff).toBe("kept");

    // One unreadable attempt costs only itself, and an unreadable list only the list.
    const mixed = { threadID: uuid(1), attempts: [{ inputRevision: "no identity" }, { id: uuid(2), taskID: uuid(3), inputRevision: "abc" }] };
    expect(decodeThreadDocument(mixed)?.attempts.map((attempt) => attempt.id)).toEqual([uuid(2)]);
    const garbled = { threadID: uuid(1), attempts: "not a list", pendingHandoff: "kept" };
    const survived = decodeThreadDocument(garbled);
    expect(survived?.attempts).toEqual([]);
    expect(survived?.pendingHandoff).toBe("kept");
  });

  it("officeAttemptDecodes: an attempt record without the new fields decodes with defaults", () => {
    const running = { id: uuid(2), taskID: uuid(3), startedAt: "2026-09-01T10:00:00Z", inputRevision: "abc" };
    expect(decodeSparkTaskAttempt(running)).toStrictEqual({ ...running, outcome: "running", turnIDs: [] });

    const ended = { ...running, endedAt: "2026-09-01T10:05:00Z" };
    expect(decodeSparkTaskAttempt(ended)?.outcome).toBe("finished");
    // An outcome this build does not know reads by the same rule instead of losing the record.
    expect(decodeSparkTaskAttempt({ ...ended, outcome: "superseded" })?.outcome).toBe("finished");
    expect(decodeSparkTaskAttempt({ ...running, outcome: "cancelled" })?.outcome).toBe("cancelled");
  });

  it("a list of turn ids with one unreadable id is no list, as Swift reads a plain array", () => {
    const attempt = decodeSparkTaskAttempt({ id: uuid(2), taskID: uuid(3), turnIDs: [uuid(4), "nope"] }, fixedContext());
    expect(attempt?.turnIDs).toEqual([]);
    expect(decodeSparkTaskAttempt({ id: uuid(2), taskID: uuid(3), turnIDs: [uuid(4).toUpperCase()] })?.turnIDs).toEqual([uuid(4)]);
  });
});
