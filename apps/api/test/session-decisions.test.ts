import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelAttempt, startAttempt, workerPort, type JobFlags } from "../src/job-flow";
import { tenantCall } from "../src/tenant-data";
import { adminFetch, tenantSession } from "./authenticated-fixtures";
import {
  asSession,
  auditEntries,
  bindings,
  decide,
  joinHelper,
  linkPost,
  linkView,
  ownerConsents,
  plantRequest,
  proposeReply,
  setFlags,
  setupShop,
  shopConsents,
  shopTask,
  storedRequest,
  stubLine,
  type Shop,
} from "./people-fixtures";

// Deciding from a session (docs/pilot-api.md, "Deciding from a session"): `POST /v1/approvals/{requestId}/decision`
// with `{ optionId, seenRevision }`, through the real Worker and objects. The role comes from the session only: the
// shop's own session is the owner, a helper session is a helper. approval-core decides the rest in the task object, the
// switches and consent of the owner's link apply, and a reply is sent once whichever path approved it. The global fetch
// counts LINE pushes and answers everything else 599, so nothing leaves the test.

let line: ReturnType<typeof stubLine>;
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as typeof bindings & { MODEL_PROVIDER: string };
const PROJECT = "ws/session-decisions";

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const APPROVE = { optionId: "approve", seenRevision: 1 };
const DECLINE = { optionId: "decline", seenRevision: 1 };

/// A worker's attempt on one of the shop's tasks asks for a write to the shop's tracker: a `command`, owner-only.
async function workerAsksCommand(shop: Shop): Promise<{ taskId: string; requestId: string; attemptId: string }> {
  // A worker works only for a shop whose owner consented to cloud work.
  await shopConsents(shop.tenant);
  const connected = await adminFetch("https://api.manut.test/v1/admin/connections", { method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    body: JSON.stringify({ tenantId: shop.tenant, provider: "linear", accountId: "workspace-sessions", scopes: ["write"],
      refreshToken: "linear-vault-token-sessions", resourceIds: [PROJECT], allowsActions: true }) });
  expect(connected.status).toBe(200);
  const taskId = await shopTask(shop.tenant);
  const started = await startAttempt(flowEnv, { tenant: shop.tenant, taskId, executorId: "stand-in" }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  const asked = await workerPort(flowEnv, started.job, { flags: on }).ask({ operationType: "linear.issue.create",
    targetResourceId: PROJECT, payload: { title: "Restock jasmine gift sets" } });
  if (!asked.ok) throw new Error(`not_asked_${asked.error}`);
  return { taskId, requestId: asked.value.requestId, attemptId: started.job.attemptId };
}

describe("a helper deciding from their session", () => {
  it("approves a reply, which is sent once and logged with the helper's id", async () => {
    const shop = await setupShop();
    const reply = await proposeReply(shop, "Your parcel left this morning.");
    await ownerConsents(reply);
    const helper = await joinHelper(shop, "Mint");
    const decided = await decide(helper.headers, reply.actionId, APPROVE);
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ result: { ok: true, decision: { requestId: reply.actionId, optionId: "approve",
      seenRevision: 1, decidedBy: helper.id, role: "helper" } }, action: "confirmed" });
    expect(line.pushes()).toBe(1);
    // The owner's link now shows what happened, and cannot decide again.
    expect((await linkView(reply)).state).toBe("confirmed");
    expect(await linkPost(reply, "decision", { approve: true })).toMatchObject({ status: 409,
      body: { error: "already_decided", view: { state: "confirmed" } } });
    expect(line.pushes()).toBe(1);
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "approval.decided")).toMatchObject({
      actor: { kind: "helper", id: helper.id }, subject: { requestId: reply.actionId, taskId: reply.taskId },
      outcome: "approved" });
  });

  it("is refused for money, a public post, a payment confirmation and a command, approving or declining", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const command = await workerAsksCommand(shop);
    const taskId = await shopTask(shop.tenant);
    const requests: [string, string][] = [
      [taskId, await plantRequest(shop.tenant, taskId, "money")],
      [taskId, await plantRequest(shop.tenant, taskId, "public_post")],
      [taskId, await plantRequest(shop.tenant, taskId, "payment_confirmation")],
      [command.taskId, command.requestId],
    ];
    for (const [task, requestId] of requests) {
      for (const body of [APPROVE, DECLINE]) {
        expect(await decide(helper.headers, requestId, body)).toMatchObject({ status: 403,
          body: { error: "not_permitted", result: { ok: false, refused: "not_permitted" } } });
      }
      expect((await storedRequest(shop.tenant, task, requestId)).record.status).toBe("pending");
    }
    // Each attempt is in the log under the helper's id, refused with approval-core's reason.
    const attempts = (await auditEntries(shop.tenant)).filter((entry) => entry.action === "approval.decided");
    expect(attempts).toHaveLength(requests.length * 2);
    expect(attempts.every((entry) => entry.actor.kind === "helper" && entry.actor.id === helper.id &&
      entry.outcome === "refused" && entry.reason === "not_permitted")).toBe(true);
    // The owner decides them.
    const owner = await tenantSession(shop.tenant);
    for (const [, requestId] of requests) {
      expect(await decide(owner, requestId, DECLINE)).toMatchObject({ status: 200,
        body: { result: { ok: true, decision: { decidedBy: "owner-session", role: "owner" } }, action: "rejected" } });
    }
  });

  it("takes the role only from the session, never from the body", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const owner = await tenantSession(shop.tenant);
    const taskId = await shopTask(shop.tenant);
    const refund = await plantRequest(shop.tenant, taskId, "money");
    for (const body of [{ ...APPROVE, role: "owner" }, { ...APPROVE, decidedBy: "owner-link" },
      { ...APPROVE, role: "owner", decidedBy: "owner-session" }]) {
      expect(await decide(helper.headers, refund, body)).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
    expect((await decide(owner, refund, { ...DECLINE, role: "helper" })).status).toBe(400);
    expect((await decide(helper.headers, refund, APPROVE)).body.error).toBe("not_permitted");
    expect((await storedRequest(shop.tenant, taskId, refund)).record.status).toBe("pending");
  });
});

describe("the first decision", () => {
  it("wins, and the second hears who decided, whichever path came first", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const owner = await tenantSession(shop.tenant);

    // The helper first, then the owner's session.
    const first = await proposeReply(shop, "We have it in blue.");
    await ownerConsents(first);
    expect((await decide(helper.headers, first.actionId, APPROVE)).status).toBe(200);
    expect(await decide(owner, first.actionId, APPROVE)).toMatchObject({ status: 409, body: { error: "already_decided",
      result: { ok: false, refused: "already_decided", decision: { decidedBy: helper.id, role: "helper" } } } });

    // The owner's link first, then the helper.
    const second = await proposeReply(shop, "We have it in red.");
    expect((await linkPost(second, "decision", { approve: true })).status).toBe(200);
    expect(await decide(helper.headers, second.actionId, DECLINE)).toMatchObject({ status: 409,
      body: { error: "already_decided", result: { decision: { decidedBy: "owner-link", role: "owner" } } } });

    // Both at once: exactly one wins, and the reply is sent once.
    const third = await proposeReply(shop, "We have it in green.");
    const [bySession, byLink] = await Promise.all([decide(helper.headers, third.actionId, APPROVE),
      linkPost(third, "decision", { approve: true })]);
    expect([bySession.status, byLink.status].sort()).toEqual([200, 409]);
    expect(line.pushes()).toBe(3);
    for (const reply of [first, second, third]) {
      expect((await storedRequest(shop.tenant, reply.taskId, reply.actionId)).action.state).toBe("confirmed");
    }
  });
});

describe("approval-core's refusals", () => {
  it("refuse a revision the person did not see", async () => {
    const shop = await setupShop();
    const owner = await tenantSession(shop.tenant);
    const helper = await joinHelper(shop, "Mint");
    const revised = await plantRequest(shop.tenant, await shopTask(shop.tenant), "money", { revision: 2 });
    expect(await decide(owner, revised, DECLINE)).toMatchObject({ status: 409,
      body: { error: "changed", result: { refused: "changed", currentRevision: 2 } } });
    expect((await decide(owner, revised, { optionId: "decline", seenRevision: 2 })).status).toBe(200);
    const reply = await proposeReply(shop, "Tomorrow at ten.");
    expect(await decide(helper.headers, reply.actionId, { optionId: "decline", seenRevision: 2 })).toMatchObject({
      status: 409, body: { error: "changed", result: { currentRevision: 1 } } });
    expect((await linkView(reply)).state).toBe("proposed");
  });

  it("refuse an expired request and one whose attempt has ended", async () => {
    const shop = await setupShop();
    const owner = await tenantSession(shop.tenant);
    const helper = await joinHelper(shop, "Mint");
    const expired = await plantRequest(shop.tenant, await shopTask(shop.tenant), "reply",
      { expiresAt: Date.now() - 1000 });
    expect(await decide(helper.headers, expired, DECLINE)).toMatchObject({ status: 410,
      body: { error: "expired", result: { refused: "expired" } } });
    const command = await workerAsksCommand(shop);
    const cancelled = await cancelAttempt(flowEnv, shop.tenant, command.taskId, command.attemptId, { kind: "system" });
    expect(cancelled.ok).toBe(true);
    expect(await decide(owner, command.requestId, APPROVE)).toMatchObject({ status: 409,
      body: { error: "superseded", result: { refused: "superseded", reason: "attempt_ended" } } });
    expect(await decide(owner, command.requestId, { optionId: "approve-always", seenRevision: 1 })).toMatchObject({
      status: 409, body: { error: "superseded" } });
  });

  it("refuse an option the request never offered", async () => {
    const shop = await setupShop();
    const owner = await tenantSession(shop.tenant);
    const refund = await plantRequest(shop.tenant, await shopTask(shop.tenant), "money");
    expect(await decide(owner, refund, { optionId: "approve-always", seenRevision: 1 })).toMatchObject({ status: 400,
      body: { error: "not_offered" } });
  });
});

describe("the shop's own session", () => {
  it("decides as the owner, and its reply is sent once", async () => {
    const shop = await setupShop();
    const reply = await proposeReply(shop, "Thank you, see you Friday.");
    await ownerConsents(reply);
    const owner = await tenantSession(shop.tenant);
    expect(await decide(owner, reply.actionId, APPROVE)).toMatchObject({ status: 200,
      body: { result: { ok: true, decision: { decidedBy: "owner-session", role: "owner" } }, action: "confirmed" } });
    expect(line.pushes()).toBe(1);
    // Reading the owner's link later starts no second send.
    expect((await linkView(reply)).state).toBe("confirmed");
    expect(line.pushes()).toBe(1);
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "approval.decided")).toMatchObject({
      actor: { kind: "owner", id: "owner-session" }, outcome: "approved" });
  });
});

describe("one shop's helper", () => {
  it("never decides another shop's request, even one planted in its own shop's index", async () => {
    const shop = await setupShop("Baan Mali");
    const other = await setupShop("Another shop");
    const helper = await joinHelper(shop, "Mint");
    const theirs = await proposeReply(other, "Not yours to approve.");
    await ownerConsents(theirs);
    expect(await decide(helper.headers, theirs.actionId, APPROVE)).toMatchObject({ status: 404,
      body: { error: "not_found" } });
    expect((await tenantCall(bindings, shop.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: shop.tenant, taskId: theirs.taskId }) })).status).toBe(200);
    expect((await decide(helper.headers, theirs.actionId, APPROVE)).status).toBe(404);
    expect((await linkView(theirs)).state).toBe("proposed");
    expect(line.pushes()).toBe(0);
  });
});

describe("the switches and consent", () => {
  it("apply as they do on the owner's link, before anything is recorded", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const reply = await proposeReply(shop, "Out of stock until Monday.");
    // No consent yet: approving is refused, declining is not about sending.
    expect(await decide(helper.headers, reply.actionId, APPROVE)).toMatchObject({ status: 403,
      body: { error: "consent_required" } });
    await ownerConsents(reply);
    expect((await setFlags({ officeExternalWrites: false })).status).toBe(200);
    expect(await decide(helper.headers, reply.actionId, APPROVE)).toMatchObject({ status: 403,
      body: { error: "feature_disabled", feature: "officeExternalWrites" } });
    expect((await setFlags({ officeCloud: false, officeExternalWrites: true })).status).toBe(200);
    expect(await decide(helper.headers, reply.actionId, DECLINE)).toMatchObject({ status: 403,
      body: { error: "feature_disabled", feature: "officeCloud" } });
    expect((await linkView(reply)).state).toBe("proposed");
    expect((await setFlags({ officeCloud: true, officeExternalWrites: false })).status).toBe(200);
    expect((await decide(helper.headers, reply.actionId, DECLINE)).body).toMatchObject({ action: "rejected" });
    expect(line.pushes()).toBe(0);
  });
});

describe("the route", () => {
  it("needs a session, and a body that is exactly an option and the revision seen", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const reply = await proposeReply(shop, "Yes, gift wrap is free.");
    expect(await decide({}, reply.actionId, APPROVE)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect((await decide({ authorization: "Bearer test-key" }, reply.actionId, APPROVE)).status).toBe(401);
    for (const body of [{ optionId: "approve" }, { seenRevision: 1 }, { optionId: "approve", seenRevision: 0 },
      { optionId: "approve", seenRevision: "1" }, { optionId: "", seenRevision: 1 }, [], "approve"]) {
      expect(await decide(helper.headers, reply.actionId, body)).toMatchObject({ status: 400,
        body: { error: "invalid_request" } });
    }
    expect((await asSession(helper.headers, "GET", `/v1/approvals/${reply.actionId}/decision`)).status).toBe(405);
    expect(await decide(helper.headers, "no-such-request", APPROVE)).toMatchObject({ status: 404,
      body: { error: "not_found" } });
    expect((await linkView(reply)).state).toBe("proposed");
  });
});
