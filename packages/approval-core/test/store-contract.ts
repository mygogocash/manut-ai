import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  OPTION_EFFECTS,
  ROLES,
  mayDecide,
  stampRequest,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalStore,
  type DecideResult,
  type Decision,
  type NewApprovalRequest,
  type Role,
  type Running,
  type SettledDecision,
} from "../src/index";

/// The behaviour every `ApprovalStore` must have, whatever holds its records. The in-memory store
/// runs it in `in-memory-store.test.ts`; a Durable Object or SQLite store runs the same suite by
/// passing its own factory, so the rules cannot drift between them.
///
/// Each case is named after the GoSpark or Orca test it comes from. GoSpark drove a real runtime
/// and recorded what reached its provider; here the store's record is that provider, so "nothing
/// reached the provider" reads as "the record is still pending, with no decision".
export type StoreFactory = (now: () => number) => ApprovalStore;

const allow: ApprovalOption = { id: "allow", label: "Approve", effect: "approve" };
const deny: ApprovalOption = { id: "deny", label: "Decline", effect: "decline" };

const OPEN = { state: "open", reason: "waiting" } as const;

function ask(id: string, extra: Partial<NewApprovalRequest> = {}): NewApprovalRequest {
  return { id, kind: "command", options: [allow, deny], ...extra };
}

function decision(
  requestId: string,
  optionId: string,
  seenRevision: number,
  decidedBy = "owner@desktop",
  role: Role = "owner",
): Decision {
  return { requestId, optionId, seenRevision, decidedBy, role };
}

/// The settled decision of an accepted result, failing the test at once if it was refused.
function settled(result: DecideResult): SettledDecision {
  if (!result.ok) throw new Error(`expected the decision to settle, but it was refused: ${JSON.stringify(result)}`);
  return result.decision;
}

export function approvalStoreContract(name: string, makeStore: StoreFactory): void {
  function fixture(start = 1_000_000): { clock: { now: number }; store: ApprovalStore } {
    const clock = { now: start };
    return { clock, store: makeStore(() => clock.now) };
  }

  /// Asserts that nothing settled the request: GoSpark's "nothing reached the provider".
  async function expectPending(store: ApprovalStore, requestId: string, revision?: number): Promise<void> {
    const record = await store.get(requestId);
    expect(record?.status, `${requestId} should still wait`).toBe("pending");
    expect(record && "decision" in record).toBe(false);
    if (revision !== undefined) expect(record?.request.revision).toBe(revision);
  }

  describe(`${name}: DecisionBindingTests`, () => {
    it("DecisionBindingTests.stamped: the request asked between turns is decided in a later one: no stamp, no block", async () => {
      const { store } = fixture();
      const chat = await store.open(stampRequest(ask("req-1"), { turnId: "turn-1" }));
      expect(chat).toMatchObject({ ok: true, request: { turnId: "turn-1", revision: 1 } });
      expect(chat.ok && "attemptId" in chat.request).toBe(false);

      // Between turns the runtime has no turn to stamp, and a stamp the model sent is not kept.
      const late = await store.open(stampRequest(ask("late", { turnId: "claimed", attemptId: "claimed" }), {}));
      expect(late.ok).toBe(true);
      if (late.ok) {
        expect("turnId" in late.request).toBe(false);
        expect("attemptId" in late.request).toBe(false);
      }

      const task = await store.open(stampRequest(ask("req-2"), { turnId: "turn-2", attemptId: "attempt-1" }));
      expect(task).toMatchObject({ ok: true, request: { turnId: "turn-2", attemptId: "attempt-1" } });

      const running = { turnId: "turn-2", attemptId: "attempt-1" };
      expect(await store.standing("late", { seenRevision: 1, running })).toEqual(OPEN);
      expect(settled(await store.decide(decision("late", "allow", 1), { running })).optionId).toBe("allow");
    });

    it("DecisionBindingTests.reusedID: a decision for an ended turn's request is superseded even when the request is asked again under its id", async () => {
      const { store } = fixture();
      const turn1 = { turnId: "turn-1" };
      const turn2 = { turnId: "turn-2" };
      await store.open(stampRequest(ask("req-1", { detail: { title: "Run the export" } }), turn1));

      // Turn 2 asks again under the same id, for something else. The surface still shows revision 1.
      const reissued = await store.revise(
        "req-1",
        stampRequest({ options: [allow, deny], detail: { title: "Delete the export" } }, turn2),
      );
      expect(reissued).toMatchObject({ ok: true, request: { revision: 2, turnId: "turn-2" } });

      // What turn 1 showed decides nothing, from any surface.
      expect(await store.decide(decision("req-1", "allow", 1), { running: turn2 })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      expect(await store.decide(decision("req-1", "allow", 1, "owner@phone"), { running: turn2 })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      await expectPending(store, "req-1", 2);

      // Turn 2's own request is decided, once.
      const first = settled(await store.decide(decision("req-1", "allow", 2), { running: turn2 }));
      expect(await store.decide(decision("req-1", "allow", 2), { running: turn2 })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: first,
      });

      // The binding refuses on its own as well: a request still stamped with a turn that is no
      // longer running, never revised.
      await store.open(stampRequest(ask("req-2", { detail: { title: "Push the branch" } }), turn2));
      expect(await store.standing("req-2", { seenRevision: 1, running: turn2 })).toEqual(OPEN);
      const turn3 = { turnId: "turn-3" };
      // A surface reads it as superseded by the same rule, so it never offers choices that every
      // press would have refused.
      expect(await store.standing("req-2", { seenRevision: 1, running: turn3 })).toEqual({
        state: "superseded",
        reason: "turn_ended",
      });
      expect(await store.decide(decision("req-2", "allow", 1), { running: turn3 })).toEqual({
        ok: false,
        refused: "superseded",
        reason: "turn_ended",
      });

      // Nothing was recorded as decided: asked again, from elsewhere and the other way, the store
      // still answers superseded, never already decided.
      expect(await store.decide(decision("req-2", "deny", 1, "owner@phone"), { running: turn3 })).toEqual({
        ok: false,
        refused: "superseded",
        reason: "turn_ended",
      });
      await expectPending(store, "req-2", 1);
      expect((await store.get("req-1"))?.status).toBe("decided");
    });

    it("DecisionBindingTests.oldAttempt: a decision from a previous attempt cannot resolve the retry's request", async () => {
      const { store } = fixture();
      const attempt1 = { turnId: "turn-1", attemptId: "attempt-1" };
      await store.open(stampRequest(ask("req-1", { detail: { title: "Run the migration" } }), attempt1));
      await store.open(stampRequest(ask("ask-1", { kind: "reply", detail: { text: "Which database?" } }), attempt1));

      // The retry runs in a new turn and attempt, and asks again under the same id.
      const retry = { turnId: "turn-2", attemptId: "attempt-2" };
      const asked = await store.revise(
        "req-1",
        stampRequest({ options: [allow, deny], detail: { title: "Drop the database" } }, retry),
      );
      expect(asked).toMatchObject({ ok: true, request: { revision: 2, turnId: "turn-2", attemptId: "attempt-2" } });

      // Attempt 1's decisions resolve nothing, and the retry's request still waits for its own.
      expect(await store.decide(decision("req-1", "allow", 1), { running: retry })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      expect(await store.decide(decision("ask-1", "allow", 1, "helper@phone", "helper"), { running: retry })).toEqual({
        ok: false,
        refused: "superseded",
        reason: "turn_ended",
      });
      await expectPending(store, "req-1", 2);
      await expectPending(store, "ask-1", 1);
      expect(await store.standing("req-1", { seenRevision: 2, running: retry })).toEqual(OPEN);

      // The binding refuses on the attempt alone, in the same turn: the retry ends and another
      // attempt takes the running turn.
      const later = { turnId: "turn-2", attemptId: "attempt-3" };
      expect(await store.standing("req-1", { seenRevision: 2, running: later })).toEqual({
        state: "superseded",
        reason: "attempt_ended",
      });
      expect(await store.decide(decision("req-1", "allow", 2), { running: later })).toEqual({
        ok: false,
        refused: "superseded",
        reason: "attempt_ended",
      });
      await expectPending(store, "req-1", 2);
    });

    it("DecisionBindingTests.firstWins: the first valid decision wins across desktop and phone", async () => {
      const { store } = fixture();
      const running = { turnId: "turn-1", attemptId: "attempt-1" };

      // The desktop first. The phone's decision on the same request is told who decided.
      await store.open(stampRequest(ask("req-1", { detail: { title: "Run the export" } }), running));
      const desktop = settled(await store.decide(decision("req-1", "allow", 1, "owner@desktop"), { running }));
      expect(await store.decide(decision("req-1", "deny", 1, "owner@phone"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: desktop,
      });

      await store.open(stampRequest(ask("ask-1", { kind: "reply" }), running));
      const answered = settled(await store.decide(decision("ask-1", "allow", 1, "owner@desktop"), { running }));
      expect(await store.decide(decision("ask-1", "deny", 1, "helper@phone", "helper"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: answered,
      });

      // A decision on a revision since replaced is no decision at all: refused, it leaves the
      // current revision to whichever valid decision comes first, the phone's this time.
      await store.open(stampRequest(ask("req-2", { kind: "message", detail: { text: "Send the report" } }), running));
      await store.revise(
        "req-2",
        stampRequest({ options: [allow, deny], detail: { text: "Send the report to everyone" } }, running),
      );
      expect(await store.decide(decision("req-2", "allow", 1, "owner@desktop"), { running })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      const phone = settled(await store.decide(decision("req-2", "deny", 2, "owner@phone"), { running }));
      expect(await store.decide(decision("req-2", "allow", 2, "owner@desktop"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: phone,
      });

      // Each request kept exactly the first valid decision made on it.
      expect(await store.get("req-1")).toMatchObject({ status: "decided", decision: { optionId: "allow", decidedBy: "owner@desktop" } });
      expect(await store.get("ask-1")).toMatchObject({ status: "decided", decision: { optionId: "allow", decidedBy: "owner@desktop" } });
      expect(await store.get("req-2")).toMatchObject({ status: "decided", decision: { optionId: "deny", decidedBy: "owner@phone", seenRevision: 2 } });
    });
  });

  describe(`${name}: OfficeDecisionChokepointTests`, () => {
    const running: Running = { turnId: "turn-1" };

    it("OfficeDecisionChokepointTests.staleApprovalRefused: a request asked again refuses the revision shown before and settles nothing", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "message", detail: { to: "finance@example.invalid" } }));

      // Asked again under the same id, now for a different recipient.
      await store.revise("req-1", { options: [allow, deny], detail: { to: "everyone@example.invalid" } });

      expect(await store.decide(decision("req-1", "allow", 1), { running })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      await expectPending(store, "req-1", 2);

      const accepted = settled(await store.decide(decision("req-1", "allow", 2), { running }));
      expect(accepted).toMatchObject({ requestId: "req-1", optionId: "allow", seenRevision: 2 });
    });

    it("OfficeDecisionChokepointTests.staleQuestionRefused: a reply asked again refuses the revision shown before, for a helper too", async () => {
      const { store } = fixture();
      await store.open(ask("ask-1", { kind: "reply", detail: { text: "We open at 9." } }));
      await store.revise("ask-1", { options: [allow, deny], detail: { text: "We open at 10." } });

      expect(await store.decide(decision("ask-1", "allow", 1, "helper@phone", "helper"), { running })).toEqual({
        ok: false,
        refused: "changed",
        currentRevision: 2,
      });
      await expectPending(store, "ask-1", 2);
      expect(settled(await store.decide(decision("ask-1", "allow", 2, "helper@phone", "helper"), { running })).role).toBe(
        "helper",
      );
    });

    it("OfficeDecisionChokepointTests.withdrawnRequestIsSuperseded: a withdrawn request is refused as superseded, not as already decided", async () => {
      const { store, clock } = fixture();
      await store.open(ask("req-1"));
      await store.open(ask("ask-1", { kind: "reply" }));
      clock.now += 5;
      expect(await store.withdraw("req-1")).toEqual({ ok: true, withdrawnAt: clock.now });
      expect(await store.withdraw("ask-1")).toEqual({ ok: true, withdrawnAt: clock.now });

      const refused = { ok: false, refused: "superseded", reason: "withdrawn" };
      expect(await store.decide(decision("req-1", "allow", 1), { running })).toEqual(refused);
      expect(await store.decide(decision("ask-1", "deny", 1, "helper@phone", "helper"), { running })).toEqual(refused);
      // Asked again, still superseded: a refusal records nothing.
      expect(await store.decide(decision("req-1", "deny", 1, "owner@phone"), { running })).toEqual(refused);
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual({ state: "superseded", reason: "withdrawn" });
      expect((await store.get("req-1"))?.status).toBe("withdrawn");

      // Withdrawing again changes nothing and reports the first time, and a withdrawn request
      // cannot be asked again under its id.
      clock.now += 5;
      expect(await store.withdraw("req-1")).toEqual({ ok: true, withdrawnAt: clock.now - 5 });
      expect(await store.revise("req-1", { options: [allow] })).toEqual({ ok: false, refused: "withdrawn" });
      expect(await store.open(ask("req-1"))).toEqual({ ok: false, refused: "already_exists" });
    });

    it("OfficeDecisionChokepointTests.doubleApprovalAcceptedOnce: deciding the same request twice settles it once", async () => {
      const { store, clock } = fixture();
      await store.open(ask("req-1"));
      const first = settled(await store.decide(decision("req-1", "allow", 1), { running }));
      expect(first.decidedAt).toBe(clock.now);
      clock.now += 1_000;
      expect(await store.decide(decision("req-1", "allow", 1), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: first,
      });
      expect(await store.get("req-1")).toEqual({
        status: "decided",
        request: expect.objectContaining({ id: "req-1", revision: 1 }),
        decision: first,
      });
    });

    it("OfficeDecisionChokepointTests.doubleAnswerAcceptedOnce: a second, different answer is refused and the first stands", async () => {
      const { store } = fixture();
      await store.open(ask("ask-1", { kind: "reply" }));
      const first = settled(await store.decide(decision("ask-1", "allow", 1, "helper@phone", "helper"), { running }));
      expect(await store.decide(decision("ask-1", "deny", 1, "helper@phone", "helper"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: first,
      });
      expect(await store.get("ask-1")).toMatchObject({ decision: { optionId: "allow" } });
    });

    it("OfficeDecisionChokepointTests.macAndRemoteApproval: two surfaces on one request give one accepted and one already decided", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "public_post" }));
      await store.open(ask("req-2", { kind: "public_post" }));

      // The desktop first, then the phone.
      const desktop = settled(await store.decide(decision("req-1", "allow", 1, "owner@desktop"), { running }));
      expect(await store.decide(decision("req-1", "deny", 1, "owner@phone"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: desktop,
      });
      // The phone first, then the web approval page.
      const phone = settled(await store.decide(decision("req-2", "deny", 1, "owner@phone"), { running }));
      expect(await store.decide(decision("req-2", "allow", 1, "owner@web"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: phone,
      });

      // Each request keeps the first decision made on it.
      expect((await store.get("req-1"))).toMatchObject({ decision: { optionId: "allow", decidedBy: "owner@desktop" } });
      expect((await store.get("req-2"))).toMatchObject({ decision: { optionId: "deny", decidedBy: "owner@phone" } });
    });

    it("OfficeDecisionChokepointTests.macAndRemoteAnswer: the phone's answer first, then the desktop's, gives one accepted", async () => {
      const { store } = fixture();
      await store.open(ask("ask-1", { kind: "reply" }));
      const phone = settled(await store.decide(decision("ask-1", "deny", 1, "helper@phone", "helper"), { running }));
      expect(await store.decide(decision("ask-1", "allow", 1, "owner@desktop"), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: phone,
      });
      expect(await store.get("ask-1")).toMatchObject({ decision: { optionId: "deny", decidedBy: "helper@phone" } });
    });

    it("OfficeDecisionChokepointTests.noRuntimeIsNotFound: a request the store never had has nothing to decide", async () => {
      const { store } = fixture();
      expect(await store.decide(decision("nobody", "allow", 1), { running })).toEqual({ ok: false, refused: "not_found" });
      expect(await store.standing("nobody", { seenRevision: 1, running })).toEqual({ state: "superseded", reason: "not_found" });
      expect(await store.revise("nobody", { options: [allow] })).toEqual({ ok: false, refused: "not_found" });
      expect(await store.withdraw("nobody")).toEqual({ ok: false, refused: "not_found" });
      expect(await store.get("nobody")).toBeUndefined();
    });
  });

  describe(`${name}: OfficeDecisionTests`, () => {
    const running: Running = {};

    it("OfficeDecisionTests.reissuedRequestGetsANewInstance: a request asked again is the next revision, and the old one is gone", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "message", detail: { command: "sendmail a@example.invalid" } }));
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual(OPEN);

      await store.revise("req-1", { options: [allow, deny], detail: { command: "sendmail b@example.invalid" } });
      const record = await store.get("req-1");
      expect(record).toMatchObject({
        status: "pending",
        request: { id: "req-1", revision: 2, detail: { command: "sendmail b@example.invalid" } },
      });
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual({
        state: "changed",
        reason: "revised",
        currentRevision: 2,
      });
      expect(await store.standing("req-1", { seenRevision: 2, running })).toEqual(OPEN);
    });

    it("OfficeDecisionTests.twoApprovalsStayDistinct: two requests are two decisions", async () => {
      const { store } = fixture();
      await store.open(ask("a", { kind: "command" }));
      await store.open(ask("b", { kind: "public_post" }));
      settled(await store.decide(decision("a", "allow", 1), { running }));
      await expectPending(store, "b", 1);
      expect(await store.standing("b", { seenRevision: 1, running })).toEqual(OPEN);
      expect(settled(await store.decide(decision("b", "deny", 1), { running })).optionId).toBe("deny");
      expect(await store.get("a")).toMatchObject({ decision: { optionId: "allow" } });
    });

    it("OfficeDecisionTests.approveAlwaysExcluded: a blanket approval cannot be offered, nor an option twice, nor no option", async () => {
      const { store } = fixture();
      const always = { id: "always", label: "Always allow", effect: "approve_always" } as unknown as ApprovalOption;
      expect(await store.open(ask("r1", { options: [allow, always, deny] }))).toMatchObject({ ok: false, refused: "invalid" });
      expect(await store.open(ask("r2", { options: [allow, { ...deny, id: "allow" }] }))).toMatchObject({
        ok: false,
        refused: "invalid",
      });
      expect(await store.open(ask("r3", { options: [] }))).toMatchObject({ ok: false, refused: "invalid" });
      expect(await store.open(ask("r4", { kind: "refund_everything" as ApprovalKind }))).toMatchObject({
        ok: false,
        refused: "invalid",
      });
      for (const id of ["r1", "r2", "r3", "r4"]) expect(await store.get(id)).toBeUndefined();

      // A revision is held to the same rule, and a refused one leaves the request as it was.
      await store.open(ask("r5"));
      const before = await store.get("r5");
      expect(await store.revise("r5", { options: [allow, always] })).toMatchObject({ ok: false, refused: "invalid" });
      expect(await store.get("r5")).toEqual(before);
    });

    it("OfficeDecisionTests.readingStoresNothing: reading a request's standing writes nothing", async () => {
      const { store } = fixture();
      await store.open(stampRequest(ask("req-1", { expiresAt: 2_000_000 }), { turnId: "turn-1" }));
      const before = await store.get("req-1");
      await store.standing("req-1", { seenRevision: 1, running: { turnId: "turn-1" } });
      await store.standing("req-1", { seenRevision: 7, running: { turnId: "turn-2" } });
      await store.standing("unknown", { seenRevision: 1, running: {} });
      expect(await store.get("req-1")).toEqual(before);
      expect(await store.get("unknown")).toBeUndefined();
    });
  });

  describe(`${name}: PlanRevisionTests`, () => {
    const running: Running = { turnId: "turn-1" };
    const postNow: ApprovalOption = { id: "post-now", label: "Post now", effect: "approve" };
    const postTonight: ApprovalOption = { id: "post-tonight", label: "Post tonight", effect: "approve" };
    const keep: ApprovalOption = { id: "keep-drafting", label: "Keep drafting", effect: "decline" };

    it("PlanRevisionTests (a completed plan starts at revision 1; changed markdown bumps the revision): a request opens at revision 1 and each change adds one", async () => {
      const { store, clock } = fixture();
      const createdAt = clock.now;
      expect(await store.open(ask("req-1", { kind: "public_post" }))).toMatchObject({
        ok: true,
        request: { revision: 1, createdAt, kind: "public_post" },
      });
      clock.now += 10;
      expect(await store.revise("req-1", { options: [allow, deny], detail: { text: "v2" } })).toMatchObject({
        ok: true,
        request: { revision: 2, createdAt, kind: "public_post" },
      });
      expect(await store.revise("req-1", { options: [allow, deny], detail: { text: "v3" } })).toMatchObject({
        ok: true,
        request: { revision: 3, createdAt },
      });
    });

    it("PlanRevisionTests.approvalBound: a decision bound to revision 1 cannot approve revision 2", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "public_post", options: [postNow, postTonight, keep], detail: { text: "Sale today" } }));

      // The post changes while the request waits: approving what was shown is refused in either
      // form, and nothing is settled or changed.
      await store.revise("req-1", { options: [postNow, postTonight, keep], detail: { text: "Sale today, 90% off" } });
      const changed = { ok: false, refused: "changed", currentRevision: 2 };
      expect(await store.decide(decision("req-1", "post-now", 1), { running })).toEqual(changed);
      expect(await store.decide(decision("req-1", "post-tonight", 1), { running })).toEqual(changed);
      // GoSpark lets a decline through on a changed plan. Here a decision counts only for the
      // revision the person saw, so declining what was shown is refused too, and the person
      // declines the current revision instead.
      expect(await store.decide(decision("req-1", "keep-drafting", 1), { running })).toEqual(changed);
      await expectPending(store, "req-1", 2);

      // A decision on the revision on screen goes ahead.
      expect(settled(await store.decide(decision("req-1", "post-tonight", 2), { running }))).toMatchObject({
        optionId: "post-tonight",
        seenRevision: 2,
      });
    });

    it("PlanRevisionTests.staleRefused: acting on an older revision is refused and changes nothing", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "money", detail: { amountSatang: 50_000 } }));
      await store.revise("req-1", { options: [allow, deny], detail: { amountSatang: 500_000 } });
      const before = await store.get("req-1");
      expect((await store.decide(decision("req-1", "allow", 1), { running })).ok).toBe(false);
      expect(await store.get("req-1")).toEqual(before);
    });
  });

  describe(`${name}: Orca bug classes`, () => {
    const running: Running = { turnId: "turn-1" };

    it("decision-gate-store resolveGate: concurrent decisions settle a request once, and every other one hears the first", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "money" }));
      const deciders = Array.from({ length: 12 }, (_, i) =>
        decision("req-1", i % 2 === 0 ? "allow" : "deny", 1, `owner@device-${i}`),
      );
      const results = await Promise.all(deciders.map((d) => store.decide(d, { running })));
      const accepted = results.filter((r) => r.ok);
      expect(accepted).toHaveLength(1);
      const winner = settled(accepted[0]!);
      for (const result of results.filter((r) => !r.ok)) {
        expect(result).toEqual({ ok: false, refused: "already_decided", decision: winner });
      }
      expect(await store.get("req-1")).toMatchObject({ status: "decided", decision: winner });
    });

    it("decision-gate-store resolveGate: a double tap settles once", async () => {
      const { store } = fixture();
      await store.open(ask("req-1"));
      const tap = decision("req-1", "allow", 1);
      const [a, b] = await Promise.all([store.decide(tap, { running }), store.decide(tap, { running })]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].filter((r) => !r.ok && r.refused === "already_decided")).toHaveLength(1);
    });

    it("first valid decision wins: refused decisions racing ahead leave the request to the first valid one", async () => {
      const { store } = fixture();
      // Stamped, so a decision under another turn has a binding to break. A revision is stamped
      // again, because it replaces the stamps too.
      await store.open(stampRequest(ask("req-1", { kind: "money" }), running));
      await store.revise("req-1", stampRequest({ options: [allow, deny] }, running));
      const results = await Promise.all([
        store.decide(decision("req-1", "allow", 1), { running }), // stale revision
        store.decide(decision("req-1", "always", 2), { running }), // not offered
        store.decide(decision("req-1", "allow", 2, "helper@phone", "helper"), { running }), // not permitted
        store.decide(decision("req-1", "allow", 2), { running: { turnId: "turn-0" } }), // another turn
        store.decide(decision("req-1", "deny", 2, "owner@desktop"), { running }), // valid
        store.decide(decision("req-1", "allow", 2, "owner@phone"), { running }), // valid
      ]);
      const refusals = results.map((r) => (r.ok ? "ok" : r.refused));
      const accepted = results.filter((r) => r.ok);
      expect(accepted).toHaveLength(1);
      const winner = settled(accepted[0]!);
      expect(["owner@desktop", "owner@phone"]).toContain(winner.decidedBy);
      // The four invalid decisions are refused for their own reasons wherever they land, or as
      // already decided if the winner landed first; never accepted.
      expect(refusals.slice(0, 4).every((r) => r !== "ok")).toBe(true);
      expect(await store.get("req-1")).toMatchObject({ status: "decided", decision: winner });
    });

    it("journal-prompt-mutation: a revision racing a decision lets exactly one of them through", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "public_post" }));
      const [decided, revised] = await Promise.all([
        store.decide(decision("req-1", "allow", 1), { running }),
        store.revise("req-1", { options: [allow, deny], detail: { text: "changed" } }),
      ]);
      expect([decided.ok, revised.ok].filter(Boolean)).toHaveLength(1);
      const record = await store.get("req-1");
      if (decided.ok) {
        // The decision landed first: the revision is refused with it, and the record keeps what was approved.
        expect(revised).toEqual({ ok: false, refused: "already_decided", decision: decided.decision });
        expect(record).toMatchObject({ status: "decided", request: { revision: 1 } });
      } else {
        // The revision landed first: approving what was shown is refused as changed.
        expect(decided).toEqual({ ok: false, refused: "changed", currentRevision: 2 });
        expect(record).toMatchObject({ status: "pending", request: { revision: 2 } });
      }
    });

    it("journal-prompt-mutation: a settled request cannot be reopened, revised or withdrawn", async () => {
      const { store } = fixture();
      await store.open(ask("req-1"));
      const first = settled(await store.decide(decision("req-1", "deny", 1), { running }));
      expect(await store.open(ask("req-1"))).toEqual({ ok: false, refused: "already_exists" });
      expect(await store.revise("req-1", { options: [allow] })).toEqual({ ok: false, refused: "already_decided", decision: first });
      expect(await store.withdraw("req-1")).toEqual({ ok: false, refused: "already_decided", decision: first });
      // And with all that tried, a later decision still hears the first one.
      expect(await store.decide(decision("req-1", "allow", 1), { running })).toEqual({
        ok: false,
        refused: "already_decided",
        decision: first,
      });
      expect(await store.get("req-1")).toMatchObject({ status: "decided", request: { revision: 1 }, decision: first });
    });

    it("acp-permission-requests answerAcpPermission: an option that was not offered is refused and settles nothing", async () => {
      const { store } = fixture();
      await store.open(ask("req-1", { kind: "money" }));
      expect(await store.decide(decision("req-1", "always", 1), { running })).toEqual({ ok: false, refused: "not_offered" });
      await expectPending(store, "req-1", 1);

      // An option offered at an earlier revision is not offered now.
      await store.revise("req-1", { options: [deny] });
      expect(await store.decide(decision("req-1", "allow", 2), { running })).toEqual({ ok: false, refused: "not_offered" });
      await expectPending(store, "req-1", 2);
      expect(settled(await store.decide(decision("req-1", "deny", 2), { running })).optionId).toBe("deny");
    });
  });

  describe(`${name}: roles`, () => {
    const running: Running = {};

    it("a helper may decide messages and replies only, approving or declining, and a refusal leaves the request for the owner", async () => {
      const { store } = fixture();
      for (const kind of APPROVAL_KINDS) {
        for (const option of [allow, deny]) {
          const id = `${kind}-${option.id}`;
          await store.open(ask(id, { kind }));
          const result = await store.decide(decision(id, option.id, 1, "helper@phone", "helper"), { running });
          if (kind === "message" || kind === "reply") {
            expect(result.ok, id).toBe(true);
          } else {
            expect(result, id).toEqual({ ok: false, refused: "not_permitted" });
            await expectPending(store, id, 1);
            expect(settled(await store.decide(decision(id, option.id, 1), { running })).role).toBe("owner");
          }
        }
      }
    });

    it("ApprovalPolicyTests.grantOfferedOnlyWhereHonoured (adapted): a role is shown a choice exactly where the store would accept it", async () => {
      // GoSpark pins that "Approve for turn" is offered exactly where taking it is honoured. The
      // same promise here: a surface that draws buttons by `mayDecide` never draws one the store
      // refuses for the role, and never hides one it would accept.
      const { store } = fixture();
      for (const role of ROLES) {
        for (const kind of APPROVAL_KINDS) {
          for (const effect of OPTION_EFFECTS) {
            const id = `${role}-${kind}-${effect}`;
            const option = effect === "approve" ? allow : deny;
            await store.open(ask(id, { kind }));
            const result = await store.decide(decision(id, option.id, 1, `${role}@device`, role), { running });
            expect(result.ok, id).toBe(mayDecide(role, kind));
          }
        }
      }
    });
  });

  describe(`${name}: expiry`, () => {
    const running: Running = {};

    it("an expired request cannot be decided, and a decided one stays decided after its expiry", async () => {
      const { store, clock } = fixture();
      const expiresAt = clock.now + 1_000;
      await store.open(ask("req-1", { kind: "payment_confirmation", expiresAt }));
      await store.open(ask("req-2", { kind: "payment_confirmation", expiresAt }));

      clock.now = expiresAt - 1;
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual(OPEN);
      const early = settled(await store.decide(decision("req-2", "allow", 1), { running }));

      clock.now = expiresAt;
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual({
        state: "expired",
        reason: "expired",
        expiredAt: expiresAt,
      });
      expect(await store.decide(decision("req-1", "allow", 1), { running })).toEqual({
        ok: false,
        refused: "expired",
        expiredAt: expiresAt,
      });
      await expectPending(store, "req-1", 1);
      expect(await store.standing("req-2", { seenRevision: 1, running })).toEqual({
        state: "decided",
        reason: "decided",
        decision: early,
      });
    });

    it("a request asked again carries its own expiry", async () => {
      const { store, clock } = fixture();
      await store.open(ask("req-1", { kind: "money", expiresAt: clock.now + 10 }));
      clock.now += 20;
      await store.revise("req-1", { options: [allow, deny], expiresAt: clock.now + 10 });
      expect(settled(await store.decide(decision("req-1", "allow", 2), { running })).seenRevision).toBe(2);
    });

    it("a request without an expiry waits", async () => {
      const { store, clock } = fixture();
      await store.open(ask("req-1"));
      clock.now += 365 * 24 * 60 * 60 * 1000;
      expect(await store.standing("req-1", { seenRevision: 1, running })).toEqual(OPEN);
    });
  });

  describe(`${name}: standing and decide agree`, () => {
    it("DecisionBindingTests.reusedID (standing): a surface offers choices exactly when a press would settle the request", async () => {
      // Each case builds one state, then compares what a surface reads with what a press does.
      // The refusal a press gets for each standing a surface can read, other than open.
      const pressFor = { decided: "already_decided", superseded: "superseded", expired: "expired", changed: "changed" } as const;
      const cases: {
        name: string;
        setup: (store: ApprovalStore, clock: { now: number }) => Promise<void>;
        seenRevision: number;
        running: Running;
      }[] = [
        { name: "waiting", setup: async () => {}, seenRevision: 1, running: { turnId: "t1", attemptId: "a1" } },
        { name: "no stamps on the running side", setup: async () => {}, seenRevision: 1, running: {} },
        {
          name: "revised",
          setup: async (s) => void (await s.revise("req", stampRequest({ options: [allow, deny] }, { turnId: "t1", attemptId: "a1" }))),
          seenRevision: 1,
          running: { turnId: "t1", attemptId: "a1" },
        },
        { name: "another turn", setup: async () => {}, seenRevision: 1, running: { turnId: "t2", attemptId: "a1" } },
        { name: "another attempt", setup: async () => {}, seenRevision: 1, running: { turnId: "t1", attemptId: "a2" } },
        { name: "withdrawn", setup: async (s) => void (await s.withdraw("req")), seenRevision: 1, running: { turnId: "t1" } },
        {
          name: "expired",
          setup: async (_s, clock) => {
            clock.now += 10_000;
          },
          seenRevision: 1,
          running: { turnId: "t1" },
        },
        {
          name: "decided",
          setup: async (s) => void (await s.decide(decision("req", "deny", 1, "owner@web"), { running: {} })),
          seenRevision: 1,
          running: { turnId: "t1" },
        },
      ];
      for (const c of cases) {
        const { store, clock } = fixture();
        await store.open(stampRequest(ask("req", { kind: "public_post", expiresAt: clock.now + 5_000 }), { turnId: "t1", attemptId: "a1" }));
        await c.setup(store, clock);
        const standing = await store.standing("req", { seenRevision: c.seenRevision, running: c.running });
        const press = await store.decide(decision("req", "allow", c.seenRevision), { running: c.running });
        expect(press.ok, c.name).toBe(standing.state === "open");
        if (!press.ok) {
          const expected = standing.state === "open" ? "ok" : pressFor[standing.state];
          expect(press.refused, c.name).toBe(expected);
        }
      }
    });
  });
}
