import { adminFetch, trustedTaskPut } from "./authenticated-fixtures";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { mintApprovalToken } from "../src/approval-link";
import { dispatchAction } from "../src/broker-actions";
import type { ApprovalView } from "../src/pilot";
import type { ActionProposalJSON } from "../src/task-object";
import { tenantDelete, tenantExport, tenantPrune } from "../src/tenant-data";

// Manut AI pilot (docs/pilot-api.md) through the real Worker and objects.
//
// Every LINE delivery is built and signed here with a fixture channel secret,
// and every call to api.line.me is answered by a stub on the global fetch,
// which the Worker's broker and profile lookup use. These tests drive
// `worker.fetch` directly with an execution context, so the dispatch that runs
// in waitUntil has settled by the time a call returns. Nothing reaches LINE;
// a real push counts only as the owner's recorded pilot check.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const LINK_SECRET = "test-approval-link-secret-0123456789abcdef";
const WEB = "https://web.manut.test";
const CHANNEL_SECRET = "fixture-line-channel-secret-0001";
const CHANNEL_TOKEN = "fixture-line-channel-access-token";
const CHANNEL_ID = "2000000001";
const BOT = `U${"b".repeat(32)}`;
const CUSTOMER = `U${"c".repeat(32)}`;
const STRANGER = `U${"d".repeat(32)}`;

let eventCounter = 0;
const eventId = () => `01J${Date.now().toString(36).toUpperCase()}${(eventCounter++).toString().padStart(6, "0")}`;

function sourceIp(): string {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  return `2001:db8:${groups.join(":")}`;
}

/// A public request, as the edge would deliver it: its own source address so
/// unrelated requests never share a rate bucket.
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  request.headers.set("cf-connecting-ip", sourceIp());
  const context = createExecutionContext();
  const response = await worker.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const response = await adminFetch(`https://api.manut.test${path}`, {
    method,
    headers: OPERATOR,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function setFlags(flags: Record<string, boolean>) {
  expect((await admin("PUT", "/v1/admin/flags", flags)).status).toBe(200);
}

type LineCall = { url: string; init: RequestInit };
let lineCalls: LineCall[] = [];
let pushAnswer: () => Response = () => Response.json({ sentMessages: [{ id: "461230966842064897" }] },
  { headers: { "x-line-request-id": "fixture-request-1" } });

beforeEach(async () => {
  await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true });
  lineCalls = [];
  pushAnswer = () => Response.json({ sentMessages: [{ id: "461230966842064897" }] },
    { headers: { "x-line-request-id": "fixture-request-1" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    lineCalls.push({ url, init: init ?? {} });
    if (url === "https://api.line.me/v2/bot/message/push") return pushAnswer();
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return Response.json({ displayName: "Somchai", userId: CUSTOMER });
    return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pushes = () => lineCalls.filter((entry) => entry.url === "https://api.line.me/v2/bot/message/push");

async function lineSign(raw: string, secret = CHANNEL_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function textEvent(text: string, userId = CUSTOMER, id = eventId(), redelivery = false) {
  return {
    type: "message",
    mode: "active",
    timestamp: Date.now(),
    source: { type: "user", userId },
    webhookEventId: id,
    deliveryContext: { isRedelivery: redelivery },
    replyToken: "fixture-reply-token",
    message: { type: "text", id: `${Date.now()}`, quoteToken: "fixture-quote", text },
  };
}

type Delivery = { signature?: string | null; signedRaw?: string; secret?: string };

async function deliver(connectionId: string, payload: unknown, options: Delivery = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined
    ? await lineSign(options.signedRaw ?? raw, options.secret)
    : options.signature;
  if (signature !== null) headers["x-line-signature"] = signature;
  return call(`/v1/inbound/line/${connectionId}`, { method: "POST", headers, body: raw });
}

type Shop = { tenant: string; connectionId: string; webhookUrl: string };

async function setupShop(): Promise<Shop> {
  const created = await admin<{ tenant: string; name: string; ownerName: string }>("POST", "/v1/admin/pilot/shops",
    { name: "Baan Somtam", ownerName: "Khun Ploy" });
  expect(created.status).toBe(200);
  const tenant = created.body.tenant;
  const connected = await admin<{ connectionId: string; webhookUrl: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant, channelId: CHANNEL_ID, botUserId: BOT, channelSecret: CHANNEL_SECRET, channelAccessToken: CHANNEL_TOKEN,
  });
  expect(connected.status).toBe(200);
  return { tenant, ...connected.body };
}

type Message = { id: string; connectionId: string; lineUserId: string; displayName?: string; text: string;
  receivedAt: string; replyActionId?: string };

async function messages(tenant: string): Promise<Message[]> {
  const listed = await admin<{ messages: Message[] }>("GET", `/v1/admin/pilot/messages?tenant=${encodeURIComponent(tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body.messages;
}

/// A customer writes; answers the stored message.
async function customerWrites(shop: Shop, text: string, userId = CUSTOMER): Promise<Message> {
  const response = await deliver(shop.connectionId, { destination: BOT, events: [textEvent(text, userId)] });
  expect(response.status).toBe(200);
  const stored = (await messages(shop.tenant)).find((message) => message.text === text);
  expect(stored).toBeDefined();
  return stored!;
}

type Reply = { taskId: string; actionId: string; approvalUrl: string; expiresAt: string };

async function propose(shop: Shop, messageId: string, text: string) {
  return admin<Reply>("POST", "/v1/admin/pilot/replies", { tenant: shop.tenant, messageId, text });
}

const tokenOf = (approvalUrl: string) => approvalUrl.slice(`${WEB}/approve/`.length);

async function view(token: string) {
  const response = await call(`/v1/pilot/approvals/${token}`);
  return { status: response.status, body: (await response.json()) as ApprovalView & { error?: string } };
}

async function linkPost(token: string, leaf: "consent" | "decision", body: unknown) {
  const response = await call(`/v1/pilot/approvals/${token}/${leaf}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ApprovalView & { error?: string; view?: ApprovalView } };
}

describe("LINE webhook", () => {
  it("stores signed text messages once per webhookEventId and answers 200 with no body", async () => {
    const shop = await setupShop();
    expect(shop.webhookUrl).toBe(`https://api.manut.test/v1/inbound/line/${shop.connectionId}`);
    const first = textEvent("มีเสื้อไซส์ M ไหมคะ");
    const response = await deliver(shop.connectionId, { destination: BOT, events: [first] });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    // LINE's redelivery of the same event, alone and alongside a new one.
    expect((await deliver(shop.connectionId, { destination: BOT, events: [{ ...first, deliveryContext: { isRedelivery: true } }] })).status).toBe(200);
    const second = textEvent("ส่งฟรีไหม");
    expect((await deliver(shop.connectionId, { destination: BOT, events: [first, second, second] })).status).toBe(200);
    const stored = await messages(shop.tenant);
    expect(stored.map((message) => message.text)).toEqual(["ส่งฟรีไหม", "มีเสื้อไซส์ M ไหมคะ"]);
    expect(stored[0]).toMatchObject({ connectionId: shop.connectionId, lineUserId: CUSTOMER });
    // The display name was looked up after the 200, once per new customer.
    expect(stored.every((message) => message.displayName === "Somchai")).toBe(true);
    expect(lineCalls.filter((entry) => entry.url.includes("/v2/bot/profile/"))).toHaveLength(1);
    expect(lineCalls[0]!.url).toBe(`https://api.line.me/v2/bot/profile/${CUSTOMER}`);
  });

  it("answers 200 and stores nothing for deliveries the pilot does not keep", async () => {
    const shop = await setupShop();
    for (const payload of [
      { destination: BOT, events: [] },
      { destination: `U${"a".repeat(32)}`, events: [textEvent("for another bot")] },
      { destination: BOT, events: [{ ...textEvent("in a group"), source: { type: "group", groupId: "Cg", userId: CUSTOMER } }] },
      { destination: BOT, events: [{ ...textEvent("sticker"), message: { type: "sticker", id: "1" } }] },
    ]) {
      expect((await deliver(shop.connectionId, payload)).status).toBe(200);
    }
    expect(await messages(shop.tenant)).toEqual([]);
  });

  it("refuses bad, missing and tampered signatures before storing anything", async () => {
    const shop = await setupShop();
    const payload = { destination: BOT, events: [textEvent("signed by someone else")] };
    const refusals = [
      await deliver(shop.connectionId, payload, { secret: "another-channel-secret" }),
      await deliver(shop.connectionId, payload, { signature: null }),
      await deliver(shop.connectionId, payload, { signature: "not-a-signature" }),
      await deliver(shop.connectionId, payload, { signedRaw: JSON.stringify({ destination: BOT, events: [] }) }),
    ];
    for (const response of refusals) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(await messages(shop.tenant)).toEqual([]);
    expect(lineCalls).toEqual([]);
  });

  it("answers an empty 404 for unknown connections and while officeInbound is off", async () => {
    const shop = await setupShop();
    const payload = { destination: BOT, events: [textEvent("hello")] };
    for (const connectionId of [crypto.randomUUID(), "not-a-connection"]) {
      const response = await deliver(connectionId, payload);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
    await setFlags({ officeInbound: false });
    const closed = await deliver(shop.connectionId, payload);
    expect(closed.status).toBe(404);
    expect(await closed.text()).toBe("");
    expect(await messages(shop.tenant)).toEqual([]);
  });

  it("stops receiving on a replaced connection, whose secrets are revoked", async () => {
    const shop = await setupShop();
    const replaced = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
      tenant: shop.tenant, channelId: CHANNEL_ID, botUserId: BOT, channelSecret: CHANNEL_SECRET, channelAccessToken: "rotated",
    });
    expect(replaced.status).toBe(200);
    expect((await deliver(shop.connectionId, { destination: BOT, events: [textEvent("old url")] })).status).toBe(404);
    expect((await deliver(replaced.body.connectionId, { destination: BOT, events: [textEvent("new url")] })).status).toBe(200);
    expect((await messages(shop.tenant)).map((message) => message.text)).toEqual(["new url"]);
  });
});

describe("owner's approval link", () => {
  it("runs propose, consent, approve and a confirmed LINE push exactly once", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "พรุ่งนี้เปิดกี่โมงคะ");
    const reply = await propose(shop, message.id, "เปิด 9 โมงค่ะ");
    expect(reply.status).toBe(200);
    expect(reply.body.approvalUrl.startsWith(`${WEB}/approve/`)).toBe(true);
    expect(Date.parse(reply.body.expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
    const token = tokenOf(reply.body.approvalUrl);

    const shown = await view(token);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual({
      shopName: "Baan Somtam",
      memberName: "Nam",
      memberRole: "sales chat",
      kind: "line.reply",
      customerName: "Somchai",
      customerMessage: "พรุ่งนี้เปิดกี่โมงคะ",
      replyText: "เปิด 9 โมงค่ะ",
      state: "proposed",
      expiresAt: reply.body.expiresAt,
      needsConsent: true,
    });

    const consented = await linkPost(token, "consent", { cloudWork: true });
    expect(consented.status).toBe(200);
    expect(consented.body.needsConsent).toBe(false);

    const approved = await linkPost(token, "decision", { approve: true });
    expect(approved.status).toBe(200);
    // The answer is built before the background send settles.
    expect(approved.body.state).toBe("dispatching");
    expect(typeof approved.body.decidedAt).toBe("string");

    const settled = await view(token);
    expect(settled.body.state).toBe("confirmed");
    expect(pushes()).toHaveLength(1);
    const push = pushes()[0]!;
    const headers = new Headers(push.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${CHANNEL_TOKEN}`);
    expect(headers.get("x-line-retry-key")).toBe(reply.body.actionId);
    expect(JSON.parse(String(push.init.body))).toEqual({ to: CUSTOMER, messages: [{ type: "text", text: "เปิด 9 โมงค่ะ" }] });

    // The receipt holds ids only, and the console sees the same outcome.
    const actions = await admin<{ actions: Record<string, unknown>[] }>("GET",
      `/v1/admin/pilot/actions?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(actions.body.actions).toEqual([expect.objectContaining({
      taskId: reply.body.taskId,
      actionId: reply.body.actionId,
      messageId: message.id,
      replyText: "เปิด 9 โมงค่ะ",
      state: "confirmed",
      approvalUrl: reply.body.approvalUrl,
    })]);
    expect(actions.body.actions[0]).toHaveProperty("dispatchedAt");
    expect((await messages(shop.tenant))[0]!.replyActionId).toBe(reply.body.actionId);
  });

  it("starts the send of an approval that never began when the link is read, once", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "ส่งวันไหนคะ");
    const reply = await propose(shop, message.id, "ส่งพรุ่งนี้ค่ะ");
    const token = tokenOf(reply.body.approvalUrl);
    expect((await linkPost(token, "consent", { cloudWork: true })).status).toBe(200);

    // The decision is recorded straight on the task, as when the link route
    // recorded it and then could not reach the begin gate: approved, unsent.
    const task = bindings.TASK.get(bindings.TASK.idFromName(reply.body.taskId));
    const decided = await task.fetch(new Request(`https://task/actions/${reply.body.actionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": shop.tenant },
      body: JSON.stringify({ approve: true, by: "owner-link" }),
    }));
    expect(decided.status).toBe(200);
    expect(pushes()).toHaveLength(0);

    // Reading the link begins the send the owner approved.
    const first = await view(token);
    expect(first.status).toBe(200);
    expect(["dispatching", "confirmed"]).toContain(first.body.state);
    // Further reads see it settle and never send again.
    expect((await view(token)).body.state).toBe("confirmed");
    expect((await view(token)).body.state).toBe("confirmed");
    expect(pushes()).toHaveLength(1);
    expect(new Headers(pushes()[0]!.init.headers).get("x-line-retry-key")).toBe(reply.body.actionId);
  });

  it("refuses a second decision with the settled view and sends nothing more", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "ราคาเท่าไหร่");
    const token = tokenOf((await propose(shop, message.id, "250 บาทค่ะ")).body.approvalUrl);
    expect((await linkPost(token, "consent", { cloudWork: true })).status).toBe(200);
    expect((await linkPost(token, "decision", { approve: true })).status).toBe(200);
    for (const approve of [true, false]) {
      const again = await linkPost(token, "decision", { approve });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("already_decided");
      expect(again.body.view?.state).toBe("confirmed");
    }
    expect(pushes()).toHaveLength(1);
  });

  it("declines without consent and without sending", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "ขอเมนูหน่อย");
    const token = tokenOf((await propose(shop, message.id, "ส่งให้แล้วค่ะ")).body.approvalUrl);
    const declined = await linkPost(token, "decision", { approve: false });
    expect(declined.status).toBe(200);
    expect(declined.body.state).toBe("rejected");
    expect(typeof declined.body.decidedAt).toBe("string");
    expect(pushes()).toHaveLength(0);
  });

  it("requires the owner's consent before an approval and records nothing without it", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "มีสาขาไหนบ้าง");
    const token = tokenOf((await propose(shop, message.id, "สีลมค่ะ")).body.approvalUrl);
    const refused = await linkPost(token, "decision", { approve: true });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "consent_required" });
    expect((await view(token)).body.state).toBe("proposed");
    // Only exactly `{ cloudWork: true }` records consent.
    expect((await linkPost(token, "consent", { cloudWork: false })).status).toBe(400);
    expect((await linkPost(token, "consent", {})).status).toBe(400);
    expect((await view(token)).body.needsConsent).toBe(true);
    expect(pushes()).toHaveLength(0);
    // Operators have no route that writes consent; the shop list only reads it.
    const shops = await admin<{ shops: { tenant: string; consent: boolean }[] }>("GET", "/v1/admin/pilot/shops");
    expect(shops.body.shops.find((entry) => entry.tenant === shop.tenant)?.consent).toBe(false);
  });

  it("answers 410 for an expired link and 404 for a forged one, deciding nothing", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "ของหมดหรือยัง");
    const reply = (await propose(shop, message.id, "ยังมีค่ะ")).body;
    const genuine = tokenOf(reply.approvalUrl);
    const claim = { tenant: shop.tenant, taskId: reply.taskId, actionId: reply.actionId };
    const expired = await mintApprovalToken(LINK_SECRET, { ...claim, expiresAtMs: Date.now() - 1000 });
    const forged = await mintApprovalToken("an-attacker-secret-of-reasonable-length", { ...claim, expiresAtMs: Date.now() + 3600_000 });
    const [payload, mac] = genuine.split(".") as [string, string];
    const otherAction = await mintApprovalToken(LINK_SECRET, { ...claim, actionId: crypto.randomUUID(), expiresAtMs: Date.now() + 3600_000 });
    const tampered = `${otherAction.split(".")[0]}.${mac}`;

    for (const path of [`/v1/pilot/approvals/${expired}`]) {
      const response = await call(path);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "link_expired" });
    }
    expect((await linkPost(expired, "decision", { approve: false })).status).toBe(410);
    expect((await linkPost(expired, "consent", { cloudWork: true })).status).toBe(410);
    for (const bad of [forged, tampered, `${payload}.${"A".repeat(43)}`, "garbage"]) {
      expect(await view(bad)).toMatchObject({ status: 404, body: { error: "link_invalid" } });
      expect((await linkPost(bad, "decision", { approve: false })).status).toBe(404);
      expect((await linkPost(bad, "consent", { cloudWork: true })).status).toBe(404);
    }
    // A genuine link to an action that does not exist is invalid too.
    expect((await view(otherAction)).status).toBe(404);
    const still = await view(genuine);
    expect(still.body.state).toBe("proposed");
    expect(still.body.needsConsent).toBe(true);
  });

  it("keeps the kill switches: no approval while external writes are off", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "จองโต๊ะได้ไหม");
    const token = tokenOf((await propose(shop, message.id, "ได้ค่ะ")).body.approvalUrl);
    expect((await linkPost(token, "consent", { cloudWork: true })).status).toBe(200);
    await setFlags({ officeExternalWrites: false });
    expect(await linkPost(token, "decision", { approve: true })).toMatchObject({
      status: 403, body: { error: "feature_disabled", feature: "officeExternalWrites" },
    });
    expect((await propose(shop, message.id, "another")).status).toBe(403);
    expect((await view(token)).body.state).toBe("proposed");
    expect(pushes()).toHaveLength(0);
  });

  it("settles failed when LINE refuses, and lets the operator answer again", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "มีโปรไหม");
    const first = await propose(shop, message.id, "ลด 10% ค่ะ");
    // One open reply per message.
    expect((await propose(shop, message.id, "duplicate")).body).toEqual({ error: "reply_pending" });
    const token = tokenOf(first.body.approvalUrl);
    expect((await linkPost(token, "consent", { cloudWork: true })).status).toBe(200);
    pushAnswer = () => Response.json({ message: "You have reached your monthly limit." }, { status: 429 });
    expect((await linkPost(token, "decision", { approve: true })).status).toBe(200);
    expect((await view(token)).body.state).toBe("failed");
    expect((await propose(shop, message.id, "ลด 10% ค่ะ (อีกครั้ง)")).status).toBe(200);
  });

  it("answers CORS for the approval page's origin only, and never caches", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "hello");
    const token = tokenOf((await propose(shop, message.id, "hi")).body.approvalUrl);
    const preflight = await call(`/v1/pilot/approvals/${token}/decision`, {
      method: "OPTIONS",
      headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST");
    const ours = await call(`/v1/pilot/approvals/${token}`, { headers: { origin: WEB } });
    expect(ours.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(ours.headers.get("cache-control")).toBe("no-store");
    const theirs = await call(`/v1/pilot/approvals/${token}`, { headers: { origin: "https://evil.example" } });
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("line.message.push recipient binding", () => {
  async function directTask(tenant: string) {
    const id = `pilot-direct-${crypto.randomUUID()}`;
    const created = await trustedTaskPut(id, { id, title: "t", objective: "o", state: "draft", location: "cloud",
      funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString(), tenantId: tenant }, tenant);
    expect(created.status).toBe(200);
    return { id, stub: bindings.TASK.get(bindings.TASK.idFromName(id)) };
  }

  function lineProposal(connectionId: string, to: unknown[], text: unknown = "ok") {
    return { connectionId, providerAccountId: CHANNEL_ID, operationType: "line.message.push", targetResourceId: BOT,
      resourceScope: [BOT], payload: { text }, recipients: to, grantRevision: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  }

  it("refuses at propose anything but one LINE user and one 1-5,000 character text", async () => {
    const shop = await setupShop();
    const { stub } = await directTask(shop.tenant);
    const propose = (body: unknown) => stub.fetch(new Request("https://task/actions", { method: "POST",
      headers: { "content-type": "application/json", "x-tenant": shop.tenant }, body: JSON.stringify(body) }));
    expect((await propose(lineProposal(shop.connectionId, [CUSTOMER]))).status).toBe(200);
    for (const body of [
      lineProposal(shop.connectionId, [CUSTOMER, STRANGER]),
      lineProposal(shop.connectionId, []),
      lineProposal(shop.connectionId, ["customer@example.com"]),
      lineProposal(shop.connectionId, [CUSTOMER], ""),
      lineProposal(shop.connectionId, [CUSTOMER], "x".repeat(5001)),
      { ...lineProposal(shop.connectionId, [CUSTOMER]), payload: { text: "ok", altText: "hidden" } },
    ]) {
      expect((await propose(body)).status).toBe(400);
    }
  });

  it("sends only to the author of the message the reply record binds", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "ขอเบอร์ร้านหน่อย");
    const { id, stub } = await directTask(shop.tenant);
    const headers = { "content-type": "application/json", "x-tenant": shop.tenant };
    const approved = async (to: string) => {
      const proposed = (await (await stub.fetch(new Request("https://task/actions", { method: "POST", headers,
        body: JSON.stringify(lineProposal(shop.connectionId, [to])) }))).json()) as ActionProposalJSON;
      expect((await stub.fetch(new Request(`https://task/actions/${proposed.id}/decision`, { method: "POST", headers,
        body: JSON.stringify({ approve: true, by: "fixture" }) }))).status).toBe(200);
      return proposed.id;
    };
    const bind = async (actionId: string, expectedReplyActionId: string | null) => {
      const tenantObject = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
      const bound = await tenantObject.fetch(new Request("https://tenant/pilot/replies", { method: "POST",
        headers: { "content-type": "application/json", "x-pilot": "1" },
        body: JSON.stringify({ tenant: shop.tenant, taskId: id, actionId, messageId: message.id,
          proposedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          expectedReplyActionId }) }));
      expect(bound.status).toBe(200);
    };
    const dispatch = async (actionId: string) => {
      const settled = await dispatchAction(bindings as never, id, actionId, { tenant: shop.tenant, grantRevision: 1 });
      return ((await settled.json()) as ActionProposalJSON).state;
    };

    // Aimed at someone who never wrote, though bound to a real message.
    const misdirected = await approved(STRANGER);
    await bind(misdirected, null);
    expect(await dispatch(misdirected)).toBe("failed");
    // A reply with no record at all: nothing authorized it.
    expect(await dispatch(await approved(CUSTOMER))).toBe("failed");
    expect(pushes()).toHaveLength(0);
    // The same path with the author as recipient goes through.
    const answered = await approved(CUSTOMER);
    await bind(answered, misdirected);
    expect(await dispatch(answered)).toBe("confirmed");
    expect(pushes()).toHaveLength(1);
    expect(JSON.parse(String(pushes()[0]!.init.body)).to).toBe(CUSTOMER);
  });
});

describe("operator routes", () => {
  const routes = [
    ["POST", "/v1/admin/pilot/shops"], ["GET", "/v1/admin/pilot/shops"],
    ["POST", "/v1/admin/pilot/line-connections"], ["GET", "/v1/admin/pilot/messages"],
    ["POST", "/v1/admin/pilot/replies"], ["GET", "/v1/admin/pilot/actions"],
    ["POST", "/v1/admin/pilot/payments"], ["GET", "/v1/admin/pilot/payments"],
  ] as const;

  async function send(method: string, path: string, options: { audience?: string; bearer?: string }) {
    const context = createExecutionContext();
    if (options.audience !== undefined) {
      Object.defineProperty(context, "access", { value: { aud: options.audience, getIdentity: async () => undefined },
        configurable: true });
    }
    const response = await worker.fetch(new Request(`https://api.manut.test${path}`, {
      method,
      headers: { authorization: `Bearer ${options.bearer ?? "test-key"}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }), bindings, context);
    await waitOnExecutionContext(context);
    return response.status;
  }

  it.each(routes)("refuses %s %s without the admin gate's two credentials", async (method, path) => {
    expect(await send(method, path, {})).toBe(403);
    expect(await send(method, path, { audience: "another-application" })).toBe(403);
    expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD!, bearer: "a-session-token" })).toBe(403);
    // Through the gate, each is an exact ADMIN_METHODS entry, never the
    // gate's 404 for an unlisted method.
    expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! })).not.toBe(404);
  });

  it("refuses pilot admin methods that are not listed", async () => {
    for (const [method, path] of [["DELETE", "/v1/admin/pilot/shops"], ["GET", "/v1/admin/pilot/replies"],
      ["GET", "/v1/admin/pilot/shops/extra"]] as const) {
      expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! })).toBe(404);
    }
  });

  it("never returns LINE secrets and lists shops with their connection", async () => {
    const shop = await setupShop();
    const listed = await admin<{ shops: Record<string, unknown>[] }>("GET", "/v1/admin/pilot/shops");
    const entry = listed.body.shops.find((candidate) => candidate.tenant === shop.tenant);
    expect(entry).toEqual({ tenant: shop.tenant, name: "Baan Somtam", ownerName: "Khun Ploy",
      lineConnectionId: shop.connectionId, consent: false });
    const everything = JSON.stringify([listed.body, await tenantExport(bindings, shop.tenant).then((r) => r.json())]);
    expect(everything).not.toContain(CHANNEL_SECRET);
    expect(everything).not.toContain(CHANNEL_TOKEN);
  });

  it("validates writes and names only existing shops", async () => {
    const shop = await setupShop();
    expect((await admin("POST", "/v1/admin/pilot/shops", { name: "" , ownerName: "x" })).status).toBe(400);
    expect((await admin("POST", "/v1/admin/pilot/line-connections", { tenant: shop.tenant, channelId: CHANNEL_ID,
      botUserId: "not-a-bot", channelSecret: "s", channelAccessToken: "t" })).status).toBe(400);
    expect((await admin("POST", "/v1/admin/pilot/replies", { tenant: shop.tenant, messageId: "missing", text: "hi" })).status)
      .toBe(404);
    const message = await customerWrites(shop, "ok?");
    expect((await propose(shop, message.id, "")).status).toBe(400);
    expect((await propose(shop, message.id, "x".repeat(5001))).status).toBe(400);
    expect((await admin("GET", "/v1/admin/pilot/messages?tenant=pilot%3Anobody")).body).toEqual({ error: "shop_not_found" });
    expect((await admin("GET", "/v1/admin/pilot/messages")).body).toEqual({ error: "tenant_required" });
  });

  it("records payments and lists them newest first", async () => {
    const shop = await setupShop();
    const first = await admin<Record<string, unknown>>("POST", "/v1/admin/pilot/payments",
      { tenant: shop.tenant, orderRef: "ORD-1", amountSatang: 25000, promptPayId: "0812345678", slipNote: "KBank 10:02" });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ id: expect.any(String), tenant: shop.tenant, orderRef: "ORD-1", amountSatang: 25000,
      promptPayId: "0812345678", slipNote: "KBank 10:02", confirmedAt: expect.any(String) });
    const second = await admin<Record<string, unknown>>("POST", "/v1/admin/pilot/payments",
      { tenant: shop.tenant, orderRef: "ORD-2", amountSatang: 9900, promptPayId: "0812345678" });
    expect(second.status).toBe(200);
    expect(second.body).not.toHaveProperty("slipNote");
    for (const bad of [{ amountSatang: 0 }, { amountSatang: 12.5 }, { amountSatang: "100" }, { orderRef: "" },
      { promptPayId: undefined }]) {
      const refused = await admin("POST", "/v1/admin/pilot/payments",
        { tenant: shop.tenant, orderRef: "ORD-3", amountSatang: 100, promptPayId: "0812345678", ...bad });
      expect(refused.status).toBe(400);
    }
    expect((await admin("POST", "/v1/admin/pilot/payments",
      { tenant: "pilot:nobody", orderRef: "ORD-4", amountSatang: 100, promptPayId: "0812345678" })).status).toBe(404);
    const listed = await admin<{ payments: { orderRef: string }[] }>("GET",
      `/v1/admin/pilot/payments?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(listed.body.payments.map((payment) => payment.orderRef)).toEqual(["ORD-2", "ORD-1"]);
  });
});

describe("pilot data under retention, export and deletion", () => {
  it("exports the shop's records, ages messages out, and deletes everything", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "old question");
    await customerWrites(shop, "new question");
    await propose(shop, message.id, "answer");
    expect((await admin("POST", "/v1/admin/pilot/payments",
      { tenant: shop.tenant, orderRef: "ORD-9", amountSatang: 100, promptPayId: "0812345678" })).status).toBe(200);

    const exported = (await (await tenantExport(bindings, shop.tenant)).json()) as {
      tasks: unknown[]; pilot: { shop: { name: string }; messages: unknown[]; replies: unknown[]; payments: unknown[] };
    };
    expect(exported.pilot.shop.name).toBe("Baan Somtam");
    expect(exported.pilot.messages).toHaveLength(2);
    expect(exported.pilot.replies).toHaveLength(1);
    expect(exported.pilot.payments).toHaveLength(1);
    expect(exported.tasks).toHaveLength(1);

    // Age one message past the seven-day source-snapshot window.
    const tenantObject = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
    await runInDurableObject(tenantObject, async (_instance, state) => {
      for (const [key, value] of await state.storage.list<Message>({ prefix: "pilot-msg:" })) {
        if (value.text === "old question") {
          await state.storage.put(key, { ...value, receivedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
        }
      }
    });
    const pruned = await tenantPrune(bindings, shop.tenant, Date.now());
    expect(await pruned.json()).toMatchObject({ messagesPruned: 1 });
    expect((await messages(shop.tenant)).map((entry) => entry.text)).toEqual(["new question"]);

    expect((await tenantDelete(bindings, shop.tenant)).status).toBe(200);
    expect((await admin("GET", `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`)).status).toBe(404);
    const shops = await admin<{ shops: { tenant: string }[] }>("GET", "/v1/admin/pilot/shops");
    expect(shops.body.shops.some((entry) => entry.tenant === shop.tenant)).toBe(false);
    expect((await deliver(shop.connectionId, { destination: BOT, events: [textEvent("after deletion")] })).status).toBe(404);
    await runInDurableObject(tenantObject, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "pilot-" })).keys()]).toEqual([]);
    });
  });
});
