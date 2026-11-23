import { describe, expect, it } from "vitest";
import {
  type ApprovalRequest,
  type QuestionRequest,
  decodeApprovalOption,
  decodeApprovalRequest,
  decodeQuestionRequest,
} from "../src/index";
import { overTheWire, uuid } from "./support";

/// A paired phone shows these two and sends back an option id, so they have to survive a round
/// trip through JSON. The defaults matter more than the round trip: a newer build can name a
/// kind or a role this one has never heard of, and the safe reading of an unknown role is
/// "decline", never "approve". Ported from GoSpark's `Tests/RequestsCodingTests.swift`.
describe("RequestsCodingTests", () => {
  it("approvalRoundTrips: an approval round-trips with every field", () => {
    const request: ApprovalRequest = {
      id: "7",
      kind: "command",
      title: "rm -rf build.noindex",
      detail: "in ~/Developer/gogocode-main",
      reason: "The agent asked to run a command.",
      options: [
        { id: "allow", title: "Allow", role: "approve" },
        { id: "always", title: "Always allow", role: "approveAlways" },
        { id: "deny", title: "Deny", role: "decline" },
      ],
      toolItemID: "tool-1",
    };
    const decoded = decodeApprovalRequest(overTheWire(request));
    expect(decoded).toStrictEqual(request);
    expect(decoded?.options.map((option) => option.role)).toEqual(["approve", "approveAlways", "decline"]);
  });

  it("missingOptionalsDecode: a missing optional field decodes rather than failing", () => {
    const decoded = decodeApprovalRequest({ id: "3", kind: "tool", title: "Read a file", options: [] });
    expect(decoded).toStrictEqual({ id: "3", kind: "tool", title: "Read a file", options: [] });
    expect(decoded && "detail" in decoded).toBe(false);
  });

  it("unknownKindFallsBack: an unknown kind decodes to tool rather than failing the whole request", () => {
    expect(decodeApprovalRequest({ id: "3", kind: "teleport", title: "?", options: [] })?.kind).toBe("tool");
  });

  // The one default that is a security decision rather than a convenience.
  it("unknownRoleDeclines: an unknown role decodes to decline, never to an approving role", () => {
    expect(decodeApprovalOption({ id: "o", title: "Do it", role: "superApprove" })?.role).toBe("decline");
    expect(decodeApprovalOption({ id: "o", title: "Do it" })?.role).toBe("decline");
    expect(decodeApprovalOption({ id: "o", title: "Do it", role: 1 })?.role).toBe("decline");
  });

  it("questionRoundTrips: a question round-trips with its choices and flags", () => {
    const request: QuestionRequest = {
      id: "q1",
      questions: [
        {
          id: "which",
          header: "Branch",
          prompt: "Which branch should I use?",
          choices: [{ label: "main", detail: "the default" }, { label: "develop" }],
          allowsMultiple: false,
          allowsOther: true,
          isSecret: false,
        },
      ],
    };
    const decoded = decodeQuestionRequest(overTheWire(request));
    expect(decoded).toStrictEqual(request);
    expect(decoded?.questions[0]?.choices.map((choice) => choice.label)).toEqual(["main", "develop"]);
  });

  it("questionFlagsDefault: a question decodes with its flags missing", () => {
    const decoded = decodeQuestionRequest({ id: "q", questions: [{ id: "a", header: "H", prompt: "P", choices: [] }] });
    expect(decoded?.questions[0]).toMatchObject({ allowsMultiple: false, allowsOther: false, isSecret: false });
  });
});

/// The decoding half of GoSpark's `DecisionBindingTests.nilStamps`. Whether a stamp still holds
/// against what runs now is `@manut/approval-core`'s rule and is tested there.
describe("DecisionBindingTests", () => {
  it("nilStamps: a request written before the stamps existed decodes with none and writes none back", () => {
    const oldApproval = decodeApprovalRequest({ id: "req-1", kind: "command", title: "swift test", options: [] });
    const oldQuestion = decodeQuestionRequest({ id: "ask-1", questions: [] });
    for (const written of [JSON.stringify(oldApproval), JSON.stringify(oldQuestion)]) {
      expect(written).not.toContain("turnID");
      expect(written).not.toContain("attemptID");
    }
  });

  it("nilStamps: an unreadable stamp costs only itself", () => {
    const garbledApproval = decodeApprovalRequest({
      id: "req-1",
      kind: "command",
      title: "swift test",
      options: [],
      turnID: "not a turn",
      attemptID: 7,
    });
    const garbledQuestion = decodeQuestionRequest({ id: "ask-1", questions: [], turnID: [], attemptID: "not an attempt" });
    expect(garbledApproval).toStrictEqual({ id: "req-1", kind: "command", title: "swift test", options: [] });
    expect(garbledQuestion).toStrictEqual({ id: "ask-1", questions: [] });
  });

  it("nilStamps: stamps that were written come back as they were, a missing one included", () => {
    const approval: ApprovalRequest = { id: "req-1", kind: "command", title: "swift test", options: [], turnID: uuid(1), attemptID: uuid(2) };
    const question: QuestionRequest = { id: "ask-1", questions: [], turnID: uuid(1) };
    expect(decodeApprovalRequest(overTheWire(approval))).toStrictEqual(approval);
    expect(decodeQuestionRequest(overTheWire(question))).toStrictEqual(question);
  });

  it("a stamp GoSpark wrote in capitals reads as the id JavaScript makes", () => {
    const written = { id: "req-1", kind: "command", title: "x", options: [], turnID: uuid(0xabc).toUpperCase() };
    expect(decodeApprovalRequest(written)?.turnID).toBe(uuid(0xabc));
  });
});

/// The approval-request half of GoSpark's `PlanRevisionTests.oldPlans`.
describe("PlanRevisionTests", () => {
  it("oldPlans: an approval request from before revisions carries none and writes none back", () => {
    const request = decodeApprovalRequest({
      id: "req-1",
      kind: "plan",
      title: "Implement this plan",
      options: [],
      toolItemID: "plan-1",
    });
    expect(request?.planRevision).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain("planRevision");
    const stamped = { ...request, planRevision: 2 };
    expect(decodeApprovalRequest(overTheWire(stamped))).toStrictEqual(stamped);
  });
});

describe("requests that are not objects", () => {
  it("decode to nothing rather than to a blank request, and never throw", () => {
    for (const value of [undefined, null, 42, "request", [], true]) {
      expect(decodeApprovalRequest(value)).toBeUndefined();
      expect(decodeQuestionRequest(value)).toBeUndefined();
    }
  });

  it("one unreadable option or question costs only itself", () => {
    const approval = decodeApprovalRequest({ id: "a", options: [{ id: "allow", title: "Allow", role: "approve" }, 7, "deny"] });
    expect(approval?.options.map((option) => option.id)).toEqual(["allow"]);
    const question = decodeQuestionRequest({ id: "q", questions: ["nope", { id: "a" }] });
    expect(question?.questions.map((each) => each.id)).toEqual(["a"]);
  });
});
