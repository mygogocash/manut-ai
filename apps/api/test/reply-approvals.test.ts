import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import type { ApprovalRecord, DecideResult, Standing } from "@manut/approval-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { ApprovalView } from "../src/pilot";
import type { ActionProposalJSON } from "../src/task-object";
import { adminFetch, trustedTaskPut } from "./authenticated-fixtures";

// The pilot's replies on approval-core (docs/pilot-api.md, "Security rules"), through the real Worker and objects:
// every proposed reply opens an approval-core request of kind `reply` in the same storage write that stores it,
// naming the exact reply; the owner's link decides that request as the owner, once; and no route moves a reply's
// action without its request, a reply stored before replies had requests included.
//
// pilot.test.ts keeps every answer the owner's page and the console see; this file reads what lies under them. LINE
// is a stub on the global fetch, as there: nothing leaves the test.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const WEB = "https://web.manut.test";
const CHANNEL_SECRET = "fixture-line-channel-secret-0003";
const BOT = `U${"1".repeat(32)}`;
const CUSTOMER = `U${"2".repeat(32)}`;
const OPTIONS = [
  { id: "approve", label: "Approve", effect: "approve" },
  { id: "decline", label: "Decline", effect: "decline" },
];

let eventCounter = 0;
const eventId = () => `01R${Date.now().toString(36).toUpperCase()}${(eventCounter++).toString().padStart(6, "0")}`;

function sourceIp(): string {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  return `2001:db8:${groups.join(":")}`;
}

/// A public request with its own source address, run to the end of its waitUntil work, so a send the answer started
/// has settled by the time this returns.
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  request.headers.set("cf-connecting-ip", sourceIp());
  const context = createExecutionContext();
  const response = await worker.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const response = await adminFetch(`https://api.manut.test${path}`, { method, headers: OPERATOR,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as T };
}

let pushes = 0;

beforeEach(async () => {
  expect((await admin("PUT", "/v1/admin/flags", { officeInbound: true, officeCloud: true, officeExternalWrites: true }))
    .status).toBe(200);
  pushes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.line.me/v2/bot/message/push") {
      pushes++;
      return Response.json({ sentMessages: [{ id: "461230966842064899" }] }, { headers: { "x-line-request-id": "r-1" } });
    }
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return Response.json({ displayName: "Somchai" });
    return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function lineSign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type Shop = { tenant: string; connectionId: string };

async function setupShop(): Promise<Shop> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops",
    { name: "Baan Somtam", ownerName: "Khun Ploy" });
  expect(created.status).toBe(200);
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant: created.body.tenant, channelId: "2000000003", botUserId: BOT, channelSecret: CHANNEL_SECRET,
    channelAccessToken: "fixture-line-channel-access-token-replies",
  });
  expect(connected.status).toBe(200);
  return { tenant: created.body.tenant, connectionId: connected.body.connectionId };
}

/// A customer writes; answers the stored message's id.
async function customerWrites(shop: Shop, text: string): Promise<string> {
  const raw = JSON.stringify({ destination: BOT, events: [{ type: "message", mode: "active", timestamp: Date.now(),
    source: { type: "user", userId: CUSTOMER }, webhookEventId: eventId(), deliveryContext: { isRedelivery: false },
    replyToken: "fixture-reply-token", message: { type: "text", id: `${Date.now()}`, text } }] });
  const delivered = await call(`/v1/inbound/line/${shop.connectionId}`, { method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": await lineSign(raw) }, body: raw });
  expect(delivered.status).toBe(200);
  const listed = await admin<{ messages: { id: string; text: string }[] }>("GET",
    `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`);
  return listed.body.messages.find((message) => message.text === text)!.id;
}

type Reply = { taskId: string; actionId: string; approvalUrl: string; expiresAt: string; token: string };

async function propose(shop: Shop, text: string): Promise<Reply> {
  const messageId = await customerWrites(shop, `question for: ${text}`);
  const proposed = await admin<Omit<Reply, "token">>("POST", "/v1/admin/pilot/replies",
    { tenant: shop.tenant, messageId, text });
  expect(proposed.status).toBe(200);
  return { ...proposed.body, token: proposed.body.approvalUrl.slice(`${WEB}/approve/`.length) };
}

async function linkPost(reply: Reply, leaf: "consent" | "decision", body: unknown) {
  const response = await call(`/v1/pilot/approvals/${reply.token}/${leaf}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as ApprovalView & { error?: string } };
}

async function view(reply: Reply) {
  return ((await (await call(`/v1/pilot/approvals/${reply.token}`)).json()) as ApprovalView).state;
}

function task(taskId: string) {
  return bindings.TASK.get(bindings.TASK.idFromName(taskId));
}

type StoredRequest = { record: ApprovalRecord; standing: Standing; action: ActionProposalJSON };

/// The reply's request, its standing and its action, as the task object holds them.
async function stored(tenant: string, taskId: string, actionId: string) {
  const response = await task(taskId).fetch(new Request(`https://task/requests/${actionId}`,
    { headers: { "x-tenant": tenant } }));
  return { status: response.status, body: (await response.json()) as StoredRequest };
}

/// A decision straight on the task object's approval-core route, as the Worker sends one.
async function decideRequest(tenant: string, taskId: string, actionId: string,
  decision: { optionId: string; role: "owner" | "helper"; decidedBy?: string; seenRevision?: number }) {
  const response = await task(taskId).fetch(new Request(`https://task/requests/${actionId}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ seenRevision: 1, decidedBy: "fixture-decider", ...decision }) }));
  return { status: response.status,
    body: (await response.json()) as { result: DecideResult; record: ApprovalRecord; action: ActionProposalJSON } };
}

/// The older decision route, `{ approve, by }`, which a session's decision passes through.
async function oldRoute(tenant: string, taskId: string, actionId: string, approve: boolean, by = "fixture-by") {
  const response = await task(taskId).fetch(new Request(`https://task/actions/${actionId}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-tenant": tenant },
    body: JSON.stringify({ approve, by }) }));
  return { status: response.status, body: (await response.json()) as ActionProposalJSON & { error?: string } };
}

async function taskExport(tenant: string, taskId: string) {
  const response = await task(taskId).fetch(new Request("https://task/export", { headers: { "x-tenant": tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { actions: ActionProposalJSON[]; requests: ApprovalRecord[] };
}

/// Turns a reply back into the shape replies were stored in before they had requests: the same action, without its
/// request id, and no request beside it.
async function storedTheOldWay(taskId: string, actionId: string) {
  await runInDurableObject(task(taskId), async (_instance, state) => {
    const action = (await state.storage.get<ActionProposalJSON>(`action:${actionId}`))!;
    const { requestId: _dropped, ...old } = action;
    await state.storage.put(`action:${actionId}`, old);
    await state.storage.delete(`request:${actionId}`);
  });
}

/// The request a reply opens, at revision 1, for the action as stored.
function replyRequest(action: ActionProposalJSON, text: string) {
  return {
    id: action.id,
    kind: "reply",
    options: OPTIONS,
    revision: 1,
    createdAt: Date.parse(action.proposedAt),
    expiresAt: Date.parse(action.expiresAt),
    detail: { actionId: action.id, operationType: "line.message.push", targetResourceId: BOT, recipient: CUSTOMER,
      text, payloadHash: action.payloadHash },
  };
}

describe("a reply's approval-core request", () => {
  it("opens with each proposed reply, in the write that stores it, naming the exact reply and its one recipient", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "เปิด 9 โมงค่ะ");
    const read = await stored(shop.tenant, reply.taskId, reply.actionId);
    expect(read.status).toBe(200);
    expect(read.body.action).toMatchObject({ id: reply.actionId, requestId: reply.actionId, state: "proposed",
      expiresAt: reply.expiresAt });
    expect(read.body.record).toEqual({ status: "pending", request: replyRequest(read.body.action, "เปิด 9 โมงค่ะ") });
    expect(read.body.standing).toEqual({ state: "open", reason: "waiting" });
    // It goes wherever the reply goes: the shop's export carries the two together.
    const exported = await taskExport(shop.tenant, reply.taskId);
    expect(exported.actions.map((action) => action.id)).toEqual([reply.actionId]);
    expect(exported.requests).toEqual([read.body.record]);
  });

  it("opens with a LINE push however it is proposed, and never with another operation", async () => {
    const tenant = `reply-direct:${crypto.randomUUID()}`;
    const taskId = `reply-direct-${crypto.randomUUID()}`;
    expect((await trustedTaskPut(taskId, { id: taskId, title: "t", objective: "o", state: "draft", location: "cloud",
      funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() }, tenant)).status).toBe(200);
    const propose = async (operationType: string, extra: Record<string, unknown>) => {
      const response = await task(taskId).fetch(new Request("https://task/actions", { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant }, body: JSON.stringify({
          connectionId: "conn-1", providerAccountId: "acct-1", operationType, grantRevision: 1,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...extra }) }));
      expect(response.status).toBe(200);
      return (await response.json()) as ActionProposalJSON;
    };
    const line = await propose("line.message.push", { targetResourceId: BOT, resourceScope: [BOT],
      payload: { text: "ok" }, recipients: [CUSTOMER] });
    expect(line.requestId).toBe(line.id);
    expect((await stored(tenant, taskId, line.id)).body.record).toEqual({ status: "pending",
      request: replyRequest(line, "ok") });
    const issue = await propose("linear.issue.create", { targetResourceId: "ws/p", resourceScope: ["ws/p"],
      payload: { title: "t" } });
    expect(issue).not.toHaveProperty("requestId");
    expect((await stored(tenant, taskId, issue.id)).status).toBe(404);
  });

  it("is what the owner's yes decides, as the owner, once, and the reply is sent once", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "ส่งพรุ่งนี้ค่ะ");
    expect((await linkPost(reply, "consent", { cloudWork: true })).status).toBe(200);
    expect((await linkPost(reply, "decision", { approve: true })).body.state).toBe("dispatching");
    expect(await view(reply)).toBe("confirmed");
    const read = (await stored(shop.tenant, reply.taskId, reply.actionId)).body;
    expect(read.record).toEqual({ status: "decided", request: replyRequest(read.action, "ส่งพรุ่งนี้ค่ะ"),
      decision: { requestId: reply.actionId, optionId: "approve", seenRevision: 1, decidedBy: "owner-link",
        role: "owner", decidedAt: expect.any(Number) } });
    expect(read.standing).toMatchObject({ state: "decided" });
    expect(read.action.approval?.at).toBe(new Date((read.record as { decision: { decidedAt: number } }).decision
      .decidedAt).toISOString());

    // Nothing decides it again, whichever way it is asked.
    const again = await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "decline", role: "owner" });
    expect(again.body.result).toEqual({ ok: false, refused: "already_decided",
      decision: expect.objectContaining({ optionId: "approve", decidedBy: "owner-link" }) });
    expect(await oldRoute(shop.tenant, reply.taskId, reply.actionId, false)).toEqual({ status: 409,
      body: { error: "already_decided" } });
    expect((await linkPost(reply, "decision", { approve: false })).status).toBe(409);
    expect(await view(reply)).toBe("confirmed");
    expect(pushes).toBe(1);
  });

  it("is what the owner's no decides, and nothing is sent", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "หมดแล้วค่ะ");
    expect((await linkPost(reply, "decision", { approve: false })).body.state).toBe("rejected");
    const read = (await stored(shop.tenant, reply.taskId, reply.actionId)).body;
    expect(read.record).toMatchObject({ status: "decided", decision: { optionId: "decline", role: "owner",
      decidedBy: "owner-link", seenRevision: 1 } });
    expect(read.action.state).toBe("rejected");
    expect(pushes).toBe(0);
  });
});

describe("no route moves a reply's action without its request", () => {
  it("decides a reply through its request when the older route is asked, as the shop's owner", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "มีค่ะ");
    const declined = await oldRoute(shop.tenant, reply.taskId, reply.actionId, false);
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ id: reply.actionId, state: "rejected" });
    // The decision is the request's: the route's caller is the shop itself, so it decided as the owner.
    expect((await stored(shop.tenant, reply.taskId, reply.actionId)).body.record).toMatchObject({ status: "decided",
      decision: { optionId: "decline", seenRevision: 1, decidedBy: shop.tenant, role: "owner" } });
    // The owner's link, and the request's own route, then find it decided.
    expect((await linkPost(reply, "decision", { approve: true })).body).toMatchObject({ error: "already_decided" });
    expect((await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "approve", role: "owner" }))
      .body.result).toMatchObject({ ok: false, refused: "already_decided" });
    expect(await view(reply)).toBe("rejected");
  });

  it("names a caller that is not the shop as a helper, the most a route without a role can claim", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "ได้ค่ะ");
    // The tenantless path: no session stamped a tenant on the call.
    const approved = await oldRoute("", reply.taskId, reply.actionId, true, "staff-desk-3");
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ state: "approved", approval: { by: "staff-desk-3" } });
    expect((await stored(shop.tenant, reply.taskId, reply.actionId)).body.record).toMatchObject({ status: "decided",
      decision: { optionId: "approve", decidedBy: "staff-desk-3", role: "helper" } });
  });

  it("leaves a reply decided through its request alone when the older route is asked after", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "ราคา 250 ค่ะ");
    const first = await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "decline", role: "owner" });
    expect(first.body.result.ok).toBe(true);
    expect(first.body.action.state).toBe("rejected");
    expect(await oldRoute(shop.tenant, reply.taskId, reply.actionId, true)).toEqual({ status: 409,
      body: { error: "already_decided" } });
    expect((await stored(shop.tenant, reply.taskId, reply.actionId)).body.action.state).toBe("rejected");
    expect(pushes).toBe(0);
  });
});

describe("a reply stored before replies had requests", () => {
  it("reads as the request it would have opened, and stores it with the first decision, through the owner's link", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "เปิดทุกวันค่ะ");
    await storedTheOldWay(reply.taskId, reply.actionId);
    const before = await stored(shop.tenant, reply.taskId, reply.actionId);
    expect(before.status).toBe(200);
    expect(before.body.action).not.toHaveProperty("requestId");
    expect(before.body.record).toEqual({ status: "pending", request: replyRequest(before.body.action, "เปิดทุกวันค่ะ") });
    expect(before.body.standing).toEqual({ state: "open", reason: "waiting" });
    // Reading it wrote nothing.
    expect((await taskExport(shop.tenant, reply.taskId)).requests).toEqual([]);

    expect((await linkPost(reply, "consent", { cloudWork: true })).status).toBe(200);
    expect((await linkPost(reply, "decision", { approve: true })).body.state).toBe("dispatching");
    expect(await view(reply)).toBe("confirmed");
    expect(pushes).toBe(1);
    const after = (await stored(shop.tenant, reply.taskId, reply.actionId)).body;
    expect(after.action).toMatchObject({ requestId: reply.actionId, state: "confirmed" });
    expect(after.record).toEqual({ status: "decided", request: replyRequest(before.body.action, "เปิดทุกวันค่ะ"),
      decision: expect.objectContaining({ optionId: "approve", role: "owner", decidedBy: "owner-link" }) });
    expect((await taskExport(shop.tenant, reply.taskId)).requests).toEqual([after.record]);
    expect((await linkPost(reply, "decision", { approve: true })).status).toBe(409);
    expect(pushes).toBe(1);
  });

  it("is decided through that request by the older route too", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "ส่งฟรีค่ะ");
    await storedTheOldWay(reply.taskId, reply.actionId);
    expect((await oldRoute(shop.tenant, reply.taskId, reply.actionId, false)).body.state).toBe("rejected");
    const after = (await stored(shop.tenant, reply.taskId, reply.actionId)).body;
    expect(after.action.requestId).toBe(reply.actionId);
    expect(after.record).toMatchObject({ status: "decided", decision: { optionId: "decline", role: "owner" } });
    expect((await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "approve", role: "owner" }))
      .body.result).toMatchObject({ ok: false, refused: "already_decided" });
  });

  it("cannot be decided past its expiry, and a refusal stores nothing", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "พรุ่งนี้ค่ะ");
    await storedTheOldWay(reply.taskId, reply.actionId);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(reply.expiresAt) + 1000);
    const late = await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "approve", role: "owner" });
    expect(late.status).toBe(200);
    expect(late.body.result).toEqual({ ok: false, refused: "expired", expiredAt: Date.parse(reply.expiresAt) });
    expect(late.body.action.state).toBe("proposed");
    expect((await taskExport(shop.tenant, reply.taskId)).requests).toEqual([]);
    expect(pushes).toBe(0);
  });

  it("has no request once it was decided the old way, and stays decided", async () => {
    const shop = await setupShop();
    const reply = await propose(shop, "ไม่มีค่ะ");
    expect((await linkPost(reply, "decision", { approve: false })).body.state).toBe("rejected");
    await storedTheOldWay(reply.taskId, reply.actionId);
    expect((await stored(shop.tenant, reply.taskId, reply.actionId)).status).toBe(404);
    expect((await decideRequest(shop.tenant, reply.taskId, reply.actionId, { optionId: "approve", role: "owner" }))
      .status).toBe(404);
    expect(await oldRoute(shop.tenant, reply.taskId, reply.actionId, true)).toEqual({ status: 409,
      body: { error: "already_decided" } });
    expect((await linkPost(reply, "decision", { approve: true })).status).toBe(409);
    expect(await view(reply)).toBe("rejected");
  });
});
