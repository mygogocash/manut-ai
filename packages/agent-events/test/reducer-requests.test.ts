import { describe, expect, it } from "vitest";
import {
  type ApprovalOption,
  type ApprovalRequest,
  type PlanState,
  type ProposedPlan,
  type QuestionRequest,
  requestDecided,
} from "../src/index";
import { EM_DASH, Thread, uuid } from "./support";

const allow: ApprovalOption = { id: "allow", title: "Allow", role: "approve" };
const always: ApprovalOption = { id: "always", title: "Always allow", role: "approveAlways" };
const deny: ApprovalOption = { id: "deny", title: "Deny", role: "decline" };

const commandRequest = (id: string, title = "swift test"): ApprovalRequest => ({ id, kind: "command", title, options: [allow, deny] });
const planRequest = (id: string, toolItemID: string): ApprovalRequest => ({
  id,
  kind: "plan",
  title: "Implement this plan",
  options: [allow, always, deny],
  toolItemID,
});
const question = (id: string, prompt = "Which folder?"): QuestionRequest => ({
  id,
  questions: [{ id: "q", header: "Where", prompt, choices: [], allowsMultiple: false, allowsOther: false, isSecret: false }],
});

const plan = (thread: Thread, id: string): ProposedPlan | undefined => {
  const content = thread.content(id);
  return content?.type === "plan" ? content.plan : undefined;
};

/// What the Implement and Dismiss buttons do to a plan's row. They are the person's acts, not
/// events, so the tests make the change the way a caller would: with a spread.
const setPlanState = (thread: Thread, id: string, state: PlanState): void => {
  thread.state = {
    ...thread.state,
    items: thread.state.items.map((item) =>
      item.id === id && item.content.type === "plan" ? { ...item, content: { type: "plan", plan: { ...item.content.plan, state } } } : item,
    ),
  };
};

/// A plan the agent changes after proposing it is a new revision. Ported from GoSpark's
/// `Tests/PlanRevisionTests.swift`: the rules an event moves. Refusing to implement or approve
/// an older revision is a decision rule and lives in `@manut/approval-core`; `legacyPhone` and
/// `staleRefused` test only that and are not ported.
describe("PlanRevisionTests", () => {
  it("starts: a completed plan starts at revision 1", () => {
    const thread = new Thread();
    // A plan that arrives whole, as Claude's and Copilot's do.
    thread.rehearse({ type: "planCompleted", id: "whole", markdown: "1. Read the code" });
    expect(plan(thread, "whole")).toStrictEqual({ markdown: "1. Read the code", state: "proposed", revision: 1 });

    // A plan that streams, as Codex's does: revision 1 while it drafts and once it lands.
    thread.rehearse({ type: "planDelta", id: "streamed", text: "1. Write " });
    expect(plan(thread, "streamed")).toStrictEqual({ markdown: "1. Write ", state: "drafting", revision: 1 });
    thread.rehearse({ type: "planDelta", id: "streamed", text: "the test" });
    thread.rehearse({ type: "planCompleted", id: "streamed", markdown: "1. Write the test" });
    expect(plan(thread, "streamed")).toStrictEqual({ markdown: "1. Write the test", state: "proposed", revision: 1 });
  });

  // Covers: GS-07-AC02
  it("bumps: changed markdown after proposal bumps the revision", () => {
    const thread = new Thread();
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code" });
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code\n2. Write the test" });
    const revised = plan(thread, "p");
    expect(revised).toStrictEqual({ markdown: "1. Read the code\n2. Write the test", state: "proposed", revision: 2 });

    // An empty completion brings no new text, so nothing moves.
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "" });
    expect(plan(thread, "p")).toStrictEqual(revised);

    // An accepted plan the agent changes asks again, as the next revision.
    setPlanState(thread, "p", "accepted");
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code\n2. Write the test\n3. Ship it" });
    expect(plan(thread, "p")).toMatchObject({ state: "proposed", revision: 3 });

    // Once a streamed plan has landed, a change to it is a revision like any other.
    thread.rehearse({ type: "planDelta", id: "streamed", text: "1. Draft" });
    thread.rehearse({ type: "planCompleted", id: "streamed", markdown: "1. Draft" });
    thread.rehearse({ type: "planCompleted", id: "streamed", markdown: "1. Draft\n2. Review" });
    expect(plan(thread, "streamed")?.revision).toBe(2);
  });

  it("identicalMarkdownKeepsRevision: identical markdown keeps the revision", () => {
    const thread = new Thread();
    const dashed = `1. Read the code ${EM_DASH} carefully`;
    thread.rehearse({ type: "planCompleted", id: "whole", markdown: dashed });
    thread.rehearse({ type: "planCompleted", id: "whole", markdown: dashed });
    // The text is compared as it is kept, with its long dashes flattened.
    thread.rehearse({ type: "planCompleted", id: "whole", markdown: "1. Read the code - carefully" });
    expect(plan(thread, "whole")).toStrictEqual({ markdown: "1. Read the code - carefully", state: "proposed", revision: 1 });

    // A streamed plan: a reply appended mid-stream proposes it early, and the completion then
    // brings the same final text. That is the plan arriving, not a revision of it.
    thread.rehearse({ type: "planDelta", id: "same", text: "1. Write " });
    thread.rehearse({ type: "planDelta", id: "same", text: "the test" });
    thread.rehearse({ type: "messageDelta", id: "reply-1", text: "Here is the plan." });
    expect(plan(thread, "same")?.state).toBe("proposed");
    thread.rehearse({ type: "planCompleted", id: "same", markdown: "1. Write the test" });
    expect(plan(thread, "same")).toStrictEqual({ markdown: "1. Write the test", state: "proposed", revision: 1 });

    // The same with a final text that differs from what had streamed so far: still the first
    // completion, so still revision 1, now holding the final text.
    thread.rehearse({ type: "planDelta", id: "longer", text: "1. Write the" });
    thread.rehearse({ type: "messageDelta", id: "reply-2", text: "One moment." });
    expect(plan(thread, "longer")?.state).toBe("proposed");
    thread.rehearse({ type: "planCompleted", id: "longer", markdown: "1. Write the test\n2. Run it" });
    expect(plan(thread, "longer")).toStrictEqual({ markdown: "1. Write the test\n2. Run it", state: "proposed", revision: 1 });
    thread.rehearse({ type: "planCompleted", id: "longer", markdown: "1. Write the test\n2. Run it" });
    expect(plan(thread, "longer")?.revision).toBe(1);

    // An accepted plan sent again unchanged stays accepted.
    setPlanState(thread, "whole", "accepted");
    thread.rehearse({ type: "planCompleted", id: "whole", markdown: "1. Read the code - carefully" });
    expect(plan(thread, "whole")).toStrictEqual({ markdown: "1. Read the code - carefully", state: "accepted", revision: 1 });
  });

  // Covers: GS-37-AC02, GS-11-AC01
  it("approvalBound: an approval request is bound to the revision of the plan it was asked about", () => {
    const thread = new Thread();
    // As Claude's ExitPlanMode arrives: the plan first, then the request that names it.
    thread.rehearse({ type: "planCompleted", id: "tool-1", markdown: "1. Read the code" });
    thread.rehearse({ type: "approval", request: planRequest("req-1", "tool-1") });
    expect(thread.state.approvals.find((request) => request.id === "req-1")?.planRevision).toBe(1);

    // Only a plan request is stamped, and only from a plan this timeline holds.
    thread.rehearse({ type: "approval", request: { ...commandRequest("cmd"), toolItemID: "tool-1" } });
    thread.rehearse({ type: "approval", request: planRequest("orphan", "missing") });
    const waiting = (id: string) => thread.state.approvals.find((request) => request.id === id);
    expect(waiting("cmd") && "planRevision" in (waiting("cmd") as object)).toBe(false);
    expect(waiting("orphan") && "planRevision" in (waiting("orphan") as object)).toBe(false);

    // The plan changes while the request waits. The request keeps the revision it was asked
    // about, which is what lets the decision rules refuse an approval of the new text.
    thread.rehearse({ type: "planCompleted", id: "tool-1", markdown: "1. Read the code\n2. Drop the database" });
    expect(plan(thread, "tool-1")?.revision).toBe(2);
    expect(waiting("req-1")?.planRevision).toBe(1);
    expect(plan(thread, "tool-1")?.state).toBe("proposed");

    // Declining dismisses the plan the request named, at the revision the plan now holds.
    thread.state = requestDecided(thread.state, "req-1", "2026-11-23T06:00:00Z", "decline");
    expect(waiting("req-1")).toBeUndefined();
    expect(plan(thread, "tool-1")).toStrictEqual({ markdown: "1. Read the code\n2. Drop the database", state: "dismissed", revision: 2 });

    // A request asked about the revision on the card approves it.
    thread.rehearse({ type: "planCompleted", id: "tool-2", markdown: "1. Ship it" });
    thread.rehearse({ type: "approval", request: planRequest("req-2", "tool-2") });
    thread.state = requestDecided(thread.state, "req-2", "2026-11-23T06:00:00Z", "approve");
    expect(plan(thread, "tool-2")?.state).toBe("accepted");

    // Approving for the session accepts the plan as well.
    thread.rehearse({ type: "planCompleted", id: "tool-3", markdown: "1. Tag the release" });
    thread.rehearse({ type: "approval", request: planRequest("req-3", "tool-3") });
    thread.state = requestDecided(thread.state, "req-3", "2026-11-23T06:00:00Z", "approveAlways");
    expect(plan(thread, "tool-3")?.state).toBe("accepted");

    // A request whose plan is not in the timeline settles with nothing to mark.
    thread.state = requestDecided(thread.state, "orphan", "2026-11-23T06:00:00Z", "approve");
    expect(thread.state.approvals.map((request) => request.id)).toEqual(["cmd"]);
    expect(thread.state.settled.map((each) => `${each.request.id}:${each.by}`)).toEqual(["req-1:decided", "req-2:decided", "req-3:decided", "orphan:decided"]);
  });

  // Covers: GS-07-AC03
  it("dismissed: a dismissed plan the agent sends again stays dismissed, and a changed one asks again", () => {
    const thread = new Thread();
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code" });
    setPlanState(thread, "p", "dismissed");

    // The agent sends the same plan again: it stays dismissed.
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code" });
    expect(plan(thread, "p")).toStrictEqual({ markdown: "1. Read the code", state: "dismissed", revision: 1 });

    // A plan dismissed while it was still streaming stays dismissed when its text lands.
    thread.rehearse({ type: "planDelta", id: "streamed", text: "1. Write the" });
    thread.rehearse({ type: "messageDelta", id: "reply", text: "Here is the plan." });
    setPlanState(thread, "streamed", "dismissed");
    thread.rehearse({ type: "planCompleted", id: "streamed", markdown: "1. Write the test" });
    expect(plan(thread, "streamed")).toStrictEqual({ markdown: "1. Write the test", state: "dismissed", revision: 1 });

    // Changed, it is a new revision that asks again; the dismissed one never comes back.
    thread.rehearse({ type: "planCompleted", id: "p", markdown: "1. Read the code\n2. Keep the tests" });
    expect(plan(thread, "p")).toStrictEqual({ markdown: "1. Read the code\n2. Keep the tests", state: "proposed", revision: 2 });
  });
});

/// Every approval and question is stamped as it arrives with the turn and the attempt it was
/// asked in. Ported from GoSpark's `Tests/DecisionBindingTests.swift`: the stamping, and what a
/// turn's end and a lost session do to what waits. Whether a decision is then refused as
/// superseded (`reusedID`'s and `oldAttempt`'s chokepoint half, and `firstWins`) is
/// `@manut/approval-core`'s rule and is tested there.
describe("DecisionBindingTests", () => {
  it("stamped: a request carries the turn and attempt it arrived in", () => {
    const thread = new Thread();
    // A chat without a task records no attempt, so its requests carry the turn alone.
    const chatTurn = thread.rehearseTurn("hello");
    thread.rehearse({ type: "approval", request: commandRequest("req-1") });
    thread.rehearse({ type: "question", request: question("ask-1") });
    expect(thread.state.approvals[0]).toStrictEqual({ ...commandRequest("req-1"), turnID: chatTurn });
    expect(thread.state.questions[0]).toStrictEqual({ ...question("ask-1"), turnID: chatTurn });
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.currentTurnID).toBeUndefined();

    // A request that arrives between turns carries no turn at all.
    thread.rehearse({ type: "approval", request: commandRequest("late") });
    expect(thread.state.approvals).toStrictEqual([commandRequest("late")]);

    // Under a task, a request carries the turn and the attempt running it.
    const attempt = uuid(0x77);
    const taskTurn = thread.rehearseTurn("go", attempt);
    thread.rehearse({ type: "approval", request: commandRequest("req-2") });
    thread.rehearse({ type: "question", request: question("ask-2") });
    expect(thread.state.approvals.find((request) => request.id === "req-2")).toMatchObject({ turnID: taskTurn, attemptID: attempt });
    expect(thread.state.questions.find((request) => request.id === "ask-2")).toMatchObject({ turnID: taskTurn, attemptID: attempt });

    // Where a request was asked is the runtime's to say: a stamp it arrives with is replaced.
    thread.rehearse({ type: "approval", request: { ...commandRequest("req-3", "make"), turnID: uuid(1), attemptID: uuid(2) } });
    thread.rehearse({ type: "question", request: { ...question("ask-3"), turnID: uuid(1), attemptID: uuid(2) } });
    expect(thread.state.approvals.find((request) => request.id === "req-3")).toMatchObject({ turnID: taskTurn, attemptID: attempt });
    expect(thread.state.questions.find((request) => request.id === "ask-3")).toMatchObject({ turnID: taskTurn, attemptID: attempt });

    // The request that arrived between turns still waits, with no stamp to block it.
    expect(thread.state.approvals.find((request) => request.id === "late")).toStrictEqual(commandRequest("late"));
  });

  it("a stamp a request arrives with is removed when nothing is running to replace it", () => {
    const thread = new Thread();
    thread.rehearse({ type: "approval", request: { ...commandRequest("req-1"), turnID: uuid(1), attemptID: uuid(2) } });
    expect(thread.state.approvals).toStrictEqual([commandRequest("req-1")]);
  });

  // Covers: GS-11-AC03, GS-08-AC02
  it("reusedID: what an ended turn asked is gone, even when the provider asks again under the same id", () => {
    const thread = new Thread();
    // Turn 1 asks, and ends with both requests still waiting.
    const first = thread.rehearseTurn("first");
    thread.rehearse({ type: "approval", request: commandRequest("req-1", "Run the export") });
    thread.rehearse({ type: "question", request: question("ask-1", "Which folder?") });
    thread.rehearse({ type: "turnCompleted", status: "completed" });
    expect(thread.state.approvals).toEqual([]);
    expect(thread.state.questions).toEqual([]);
    expect(thread.state.settled.map((each) => `${each.kind}:${each.request.id}:${each.by}:${each.request.turnID}`)).toEqual([
      `approval:req-1:turnEnded:${first}`,
      `question:ask-1:turnEnded:${first}`,
    ]);

    // Turn 2's provider numbers its requests from the start again and asks under the same ids.
    const second = thread.rehearseTurn("second");
    thread.rehearse({ type: "approval", request: commandRequest("req-1", "Delete the export") });
    thread.rehearse({ type: "question", request: question("ask-1", "Which folder should I delete?") });
    expect(thread.state.approvals).toStrictEqual([{ ...commandRequest("req-1", "Delete the export"), turnID: second }]);
    expect(thread.state.questions[0]?.turnID).toBe(second);
  });

  // Covers: GS-11-AC02
  it("firstWins: a request the provider has since replaced is recorded as replaced, and only the replacement waits", () => {
    const thread = new Thread();
    const turn = thread.rehearseTurn("go");
    thread.rehearse({ type: "approval", request: commandRequest("req-2", "Send the report") });
    thread.rehearse({ type: "approval", request: commandRequest("req-2", "Send the report to everyone") });
    thread.rehearse({ type: "question", request: question("ask-2", "Who?") });
    thread.rehearse({ type: "question", request: question("ask-2", "Who exactly?") });
    expect(thread.state.approvals).toStrictEqual([{ ...commandRequest("req-2", "Send the report to everyone"), turnID: turn }]);
    expect(thread.state.questions.map((request) => request.questions[0]?.prompt)).toEqual(["Who exactly?"]);
    expect(thread.state.settled.map((each) => `${each.kind}:${each.by}`)).toEqual(["approval:replaced", "question:replaced"]);
    expect(thread.state.settled[0]?.request).toMatchObject({ title: "Send the report" });
  });

  // Covers: GS-14-AC05
  it("oldAttempt: a session that drops while requests wait settles them and fails the turn", () => {
    const thread = new Thread();
    const attempt = uuid(0x71);
    thread.rehearseTurn("go", attempt);
    thread.rehearse({ type: "approval", request: commandRequest("req-1", "Run the migration") });
    thread.rehearse({ type: "question", request: question("ask-1", "Which database?") });
    thread.rehearse({ type: "exited" });
    expect(thread.state.approvals).toEqual([]);
    expect(thread.state.questions).toEqual([]);
    expect(thread.state.settled.map((each) => `${each.request.id}:${each.by}:${each.request.attemptID}`)).toEqual([
      `req-1:sessionEnded:${attempt}`,
      `ask-1:sessionEnded:${attempt}`,
    ]);
    expect(thread.state.turns[0]?.status).toBe("failed");
    expect(thread.state.currentAttemptID).toBeUndefined();

    // The retry runs in a new attempt, whose provider asks again under the same ids.
    const retry = uuid(0x72);
    const second = thread.rehearseTurn("again", retry);
    thread.rehearse({ type: "approval", request: commandRequest("req-1", "Drop the database") });
    expect(thread.state.approvals[0]).toMatchObject({ turnID: second, attemptID: retry });
  });
});

describe("requests waiting and settled", () => {
  it("the provider's word that a request is no longer pending settles it, whichever kind it is", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "approval", request: commandRequest("req-1") });
    thread.rehearse({ type: "question", request: question("ask-1") });
    thread.rehearse({ type: "approval", request: commandRequest("req-2") });
    thread.rehearse({ type: "requestResolved", id: "ask-1" });
    thread.rehearse({ type: "requestResolved", id: "req-1" });
    expect(thread.state.approvals.map((request) => request.id)).toEqual(["req-2"]);
    expect(thread.state.questions).toEqual([]);
    expect(thread.state.settled.map((each) => `${each.request.id}:${each.by}`)).toEqual(["ask-1:provider", "req-1:provider"]);

    // A word about a request that is not waiting changes nothing.
    const before = thread.state;
    thread.rehearse({ type: "requestResolved", id: "req-1" });
    thread.rehearse({ type: "requestResolved", id: "never-asked" });
    expect(thread.state).toBe(before);
  });

  it("a decision the person made settles the request once, and a question the same way", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "approval", request: commandRequest("req-1") });
    thread.rehearse({ type: "question", request: question("ask-1") });
    const at = "2026-11-23T06:00:00Z";
    thread.state = requestDecided(thread.state, "req-1", at, "approve");
    thread.state = requestDecided(thread.state, "ask-1", at);
    expect(thread.state.approvals).toEqual([]);
    expect(thread.state.questions).toEqual([]);
    const settled = thread.state;
    expect(requestDecided(settled, "req-1", at, "decline")).toBe(settled);
    // The provider confirming it afterwards finds nothing left to settle.
    thread.rehearse({ type: "requestResolved", id: "req-1" });
    expect(thread.state.settled.map((each) => `${each.request.id}:${each.by}:${each.at}`)).toEqual([`req-1:decided:${at}`, `ask-1:decided:${at}`]);
  });

  it("a request asked inside a sub-agent waits on the sub-agent's own timeline", () => {
    const thread = new Thread();
    thread.rehearseTurn("go");
    thread.rehearse({ type: "agentStarted", spawn: { id: "agent-1", description: "Scout", isBackground: true } });
    thread.rehearse({ type: "agentEvent", agentID: "agent-1", event: { type: "approval", request: commandRequest("req-1") } });
    const head = thread.state.agents[0];
    expect(thread.state.approvals).toEqual([]);
    expect(head?.timeline.approvals.map((request) => request.id)).toEqual(["req-1"]);
    expect(head?.timeline.approvals[0]?.turnID).toBe(head?.timeline.currentTurnID);
  });
});
