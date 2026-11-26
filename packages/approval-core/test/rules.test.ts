import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  ROLES,
  bindingBreak,
  bindingHolds,
  mayDecide,
  requestStanding,
  stampRequest,
  type ApprovalKind,
  type ApprovalRecord,
  type ApprovalRequest,
  type Role,
  type SettledDecision,
  type Stamp,
} from "../src/index";

/// The pure rules, without a store: the binding (ported from GoSpark's DecisionBindingTests),
/// who may decide what, and the order in which a request's standing is read.

let counter = 0;
const freshId = (prefix: string): string => `${prefix}-${++counter}`;

/// How a request's stamp and the value running now stand, for one of the two pairs. GoSpark's
/// `StampPair`, plus the two `null` cases a database row reads back with.
const PAIRS = ["bothMissing", "stampMissing", "currentMissing", "stampNull", "currentNull", "same", "different"] as const;
type Pair = (typeof PAIRS)[number];

function idsFor(pair: Pair): { stamp: string | null | undefined; current: string | null | undefined } {
  const id = freshId("id");
  switch (pair) {
    case "bothMissing":
      return { stamp: undefined, current: undefined };
    case "stampMissing":
      return { stamp: undefined, current: id };
    case "currentMissing":
      return { stamp: id, current: undefined };
    case "stampNull":
      return { stamp: null, current: id };
    case "currentNull":
      return { stamp: id, current: null };
    case "same":
      return { stamp: id, current: id };
    case "different":
      return { stamp: id, current: freshId("id") };
  }
}

/// A stamp with only the keys that have a value, as `exactOptionalPropertyTypes` requires.
function stampOf(turnId: string | null | undefined, attemptId: string | null | undefined): Stamp {
  return {
    ...(turnId !== undefined ? { turnId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
  };
}

describe("DecisionBindingTests (binding rules)", () => {
  it("DecisionBindingTests.nilStamps: nil stamps never block", () => {
    expect(bindingHolds({}, { turnId: freshId("turn") })).toBe(true);

    // Every way the two pairs can stand. Only two known ids that differ block, the turn's or the
    // attempt's, and a missing value in the other pair never makes up for them.
    for (const turn of PAIRS) {
      for (const attempt of PAIRS) {
        const turnIds = idsFor(turn);
        const attemptIds = idsFor(attempt);
        const holds = bindingHolds(stampOf(turnIds.stamp, attemptIds.stamp), stampOf(turnIds.current, attemptIds.current));
        expect(holds, `turn ${turn}, attempt ${attempt}`).toBe(turn !== "different" && attempt !== "different");
      }
    }

    // A request written before stamps existed reads back with none and writes none back, so
    // whatever runs, it never blocks.
    const old = JSON.parse('{"id":"req-1","kind":"command","options":[],"revision":1,"createdAt":0}') as ApprovalRequest;
    expect(old.turnId).toBeUndefined();
    expect(old.attemptId).toBeUndefined();
    const written = JSON.stringify(old);
    expect(written).not.toContain("turnId");
    expect(written).not.toContain("attemptId");
    expect(bindingHolds(old, { turnId: freshId("turn"), attemptId: freshId("attempt") })).toBe(true);

    // Stamps that were written come back as they were, a missing one included.
    const stamped = stampRequest(old, { turnId: "turn-1" });
    const roundTrip = JSON.parse(JSON.stringify(stamped)) as ApprovalRequest;
    expect(roundTrip).toEqual(stamped);
    expect(roundTrip.turnId).toBe("turn-1");
    expect("attemptId" in roundTrip).toBe(false);
  });

  it("DecisionBindingTests.stamped: a request carries the turn and attempt it arrived in", () => {
    const draft = { id: "req-1", kind: "command" as const };

    // Outside a task there is no attempt, so a request carries the turn alone.
    expect(stampRequest(draft, { turnId: "turn-1" })).toEqual({ ...draft, turnId: "turn-1" });

    // A request that arrives between turns carries no turn at all.
    expect(stampRequest(draft, {})).toEqual(draft);

    // Inside a task, it carries the turn and the attempt running it.
    expect(stampRequest(draft, { turnId: "turn-2", attemptId: "attempt-1" })).toEqual({
      ...draft,
      turnId: "turn-2",
      attemptId: "attempt-1",
    });

    // Where a request was asked is the runtime's to say: a stamp it arrives with is replaced, and
    // one the runtime does not have is cleared rather than kept.
    const claimed = { ...draft, turnId: "claimed-turn", attemptId: "claimed-attempt" };
    expect(stampRequest(claimed, { turnId: "turn-2", attemptId: "attempt-1" })).toEqual({
      ...draft,
      turnId: "turn-2",
      attemptId: "attempt-1",
    });
    const cleared = stampRequest(claimed, { turnId: "turn-3" });
    expect(cleared).toEqual({ ...draft, turnId: "turn-3" });
    expect("attemptId" in cleared).toBe(false);
  });

  it("names which half of the binding broke, the turn before the attempt", () => {
    expect(bindingBreak({ turnId: "t1", attemptId: "a1" }, { turnId: "t1", attemptId: "a1" })).toBeUndefined();
    expect(bindingBreak({ turnId: "t1", attemptId: "a1" }, { turnId: "t2", attemptId: "a1" })).toBe("turn_ended");
    expect(bindingBreak({ turnId: "t1", attemptId: "a1" }, { turnId: "t1", attemptId: "a2" })).toBe("attempt_ended");
    expect(bindingBreak({ turnId: "t1", attemptId: "a1" }, { turnId: "t2", attemptId: "a2" })).toBe("turn_ended");
  });
});

describe("roles", () => {
  it("the owner decides every kind, a helper messages and replies only", () => {
    const expected: Record<Role, Record<ApprovalKind, boolean>> = {
      owner: { message: true, reply: true, money: true, public_post: true, payment_confirmation: true, command: true },
      helper: { message: true, reply: true, money: false, public_post: false, payment_confirmation: false, command: false },
    };
    for (const role of ROLES) {
      for (const kind of APPROVAL_KINDS) {
        expect(mayDecide(role, kind), `${role}, ${kind}`).toBe(expected[role][kind]);
      }
    }
  });

  it("a role or kind it does not recognise is refused rather than guessed", () => {
    // Values like these arrive at runtime from an older or newer client, past the type checker.
    expect(mayDecide("admin" as Role, "message")).toBe(false);
    expect(mayDecide("owner", "refund_everything" as ApprovalKind)).toBe(false);
    expect(mayDecide("helper", "refund_everything" as ApprovalKind)).toBe(false);
  });
});

describe("standing", () => {
  const options = [
    { id: "allow", label: "Approve", effect: "approve" },
    { id: "deny", label: "Decline", effect: "decline" },
  ] as const;

  function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    return {
      id: "req-1",
      kind: "public_post",
      options,
      revision: 1,
      createdAt: 0,
      turnId: "turn-1",
      attemptId: "attempt-1",
      ...overrides,
    };
  }

  const running = { turnId: "turn-1", attemptId: "attempt-1" };
  const decision: SettledDecision = {
    requestId: "req-1",
    optionId: "allow",
    seenRevision: 1,
    decidedBy: "owner@desktop",
    role: "owner",
    decidedAt: 50,
  };

  it("reads open while the exact request still waits", () => {
    const record: ApprovalRecord = { status: "pending", request: request() };
    expect(requestStanding(record, { seenRevision: 1, running, now: 10 })).toEqual({ state: "open", reason: "waiting" });
  });

  it("reads an unknown request as superseded, not found", () => {
    expect(requestStanding(undefined, { seenRevision: 1, running, now: 10 })).toEqual({
      state: "superseded",
      reason: "not_found",
    });
  });

  it("reads decided ahead of every later reason, so a second tap hears who decided", () => {
    // Decided at revision 1 in turn 1, then expired, and now another turn runs.
    const record: ApprovalRecord = { status: "decided", request: request({ expiresAt: 100 }), decision };
    expect(requestStanding(record, { seenRevision: 1, running: { turnId: "turn-9" }, now: 500 })).toEqual({
      state: "decided",
      reason: "decided",
      decision,
    });
  });

  it("reads withdrawn, then an ended turn or attempt, ahead of expiry and revision", () => {
    const stale = request({ revision: 3, expiresAt: 100 });
    expect(
      requestStanding({ status: "withdrawn", request: stale, withdrawnAt: 20 }, { seenRevision: 1, running, now: 500 }),
    ).toEqual({ state: "superseded", reason: "withdrawn" });
    const pending: ApprovalRecord = { status: "pending", request: stale };
    expect(requestStanding(pending, { seenRevision: 1, running: { turnId: "turn-2" }, now: 500 })).toEqual({
      state: "superseded",
      reason: "turn_ended",
    });
    expect(
      requestStanding(pending, { seenRevision: 1, running: { turnId: "turn-1", attemptId: "attempt-2" }, now: 500 }),
    ).toEqual({ state: "superseded", reason: "attempt_ended" });
  });

  it("reads expired ahead of changed, because no revision of it can be decided any more", () => {
    const record: ApprovalRecord = { status: "pending", request: request({ revision: 2, expiresAt: 100 }) };
    expect(requestStanding(record, { seenRevision: 1, running, now: 100 })).toEqual({
      state: "expired",
      reason: "expired",
      expiredAt: 100,
    });
  });

  it("reads changed when the person saw another revision, naming the current one", () => {
    const record: ApprovalRecord = { status: "pending", request: request({ revision: 2 }) };
    expect(requestStanding(record, { seenRevision: 1, running, now: 10 })).toEqual({
      state: "changed",
      reason: "revised",
      currentRevision: 2,
    });
    // A revision from the future is no more the one waiting than one from the past.
    expect(requestStanding(record, { seenRevision: 3, running, now: 10 }).state).toBe("changed");
  });

  it("expires at the instant named, not after it, and never without an expiry", () => {
    const expiring: ApprovalRecord = { status: "pending", request: request({ expiresAt: 100 }) };
    expect(requestStanding(expiring, { seenRevision: 1, running, now: 99 }).state).toBe("open");
    expect(requestStanding(expiring, { seenRevision: 1, running, now: 100 }).state).toBe("expired");
    const waiting: ApprovalRecord = { status: "pending", request: request() };
    expect(requestStanding(waiting, { seenRevision: 1, running, now: Number.MAX_SAFE_INTEGER }).state).toBe("open");
  });
});
