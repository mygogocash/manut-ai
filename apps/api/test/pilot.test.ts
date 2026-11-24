import { adminFetch, trustedTaskPut } from "./authenticated-fixtures";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { checkApprovalToken, checkDeletionToken, mintApprovalToken, mintDeletionToken } from "../src/approval-link";
import { dispatchAction } from "../src/broker-actions";
import type { ApprovalView, DeletionView } from "../src/pilot";
import type { ActionProposalJSON } from "../src/task-object";
import { authCall, tenantCall, tenantDelete, tenantExport, tenantPrune } from "../src/tenant-data";

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
/// unrelated requests never share a rate bucket. `target` swaps in an
/// environment with one binding wrapped, for the tests that make a call fail.
async function call(path: string, init: RequestInit = {}, target: Env = bindings): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  request.headers.set("cf-connecting-ip", sourceIp());
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
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

/// An operator call through the admin gate, against `target` and with the Access identity `email` when given.
async function adminWith<T = Record<string, unknown>>(target: Env, method: string, path: string, body?: unknown,
  email?: string) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => (email ? { email } : undefined) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, {
    method, headers: OPERATOR, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), target, context);
  await waitOnExecutionContext(context);
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
    ["GET", "/v1/admin/pilot/export"], ["POST", "/v1/admin/pilot/deletions"],
    ["POST", "/v1/admin/pilot/subscription-payments"], ["GET", "/v1/admin/pilot/subscription-payments"],
    ["GET", "/v1/admin/pilot/gate"],
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
      ["GET", "/v1/admin/pilot/shops/extra"], ["POST", "/v1/admin/pilot/gate"],
      ["DELETE", "/v1/admin/pilot/subscription-payments"], ["GET", "/v1/admin/pilot/gate/extra"]] as const) {
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

  it("exports one shop through the operator route, without its LINE secrets", async () => {
    const shop = await setupShop();
    const message = await customerWrites(shop, "is the somtam spicy?");
    expect((await propose(shop, message.id, "Medium, and we can make it mild")).status).toBe(200);
    expect((await admin("POST", "/v1/admin/pilot/payments",
      { tenant: shop.tenant, orderRef: "ORD-7", amountSatang: 12000, promptPayId: "0812345678" })).status).toBe(200);

    const exported = await admin<{ tenant: string; tasks: unknown[];
      pilot: { shop: { name: string }; messages: unknown[]; replies: unknown[]; payments: unknown[] } }>(
      "GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(exported.status).toBe(200);
    expect(exported.body.tenant).toBe(shop.tenant);
    expect(exported.body.pilot.shop.name).toBe("Baan Somtam");
    expect(exported.body.pilot.messages).toHaveLength(1);
    expect(exported.body.pilot.replies).toHaveLength(1);
    expect(exported.body.pilot.payments).toHaveLength(1);
    expect(exported.body.tasks).toHaveLength(1);
    expect(JSON.stringify(exported.body)).not.toContain(CHANNEL_SECRET);
    expect(JSON.stringify(exported.body)).not.toContain(CHANNEL_TOKEN);

    expect((await admin("GET", "/v1/admin/pilot/export?tenant=pilot%3Anobody")).body).toEqual({ error: "shop_not_found" });
    expect((await admin("GET", "/v1/admin/pilot/export")).body).toEqual({ error: "tenant_required" });
  });

  it("deletes one shop through the operator route only with its exact name, and its links stop working", async () => {
    const shop = await setupShop();
    const other = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops",
      { name: "Khao Man Gai Lek", ownerName: "Khun Lek" });
    expect(other.status).toBe(200);
    const message = await customerWrites(shop, "open today?");
    const reply = await propose(shop, message.id, "Yes, until 8pm");
    expect(reply.status).toBe(200);
    const token = tokenOf(reply.body.approvalUrl);

    // Nothing can bring the data back, so anything but this shop's exact name deletes nothing: a near miss,
    // another shop's name (the id of the wrong shop pasted with it), or no name at all.
    for (const confirmName of ["Baan Som", "baan somtam", "Khao Man Gai Lek", undefined]) {
      const refused = await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName });
      expect(refused).toEqual({ status: 409, body: { error: "name_mismatch" } });
    }
    expect((await view(token)).status).toBe(200);
    expect(await messages(shop.tenant)).toHaveLength(1);

    // The shop is live, so the right name only asks its owner; the owner's yes deletes it.
    const asked = await askToDelete(shop.tenant, "Baan Somtam");
    expect(asked.status).toBe(202);
    expect(await messages(shop.tenant)).toHaveLength(1);
    const deleted = await decideDeletion(deletionTokenOf(asked.body.confirmUrl), true);
    expect(deleted).toMatchObject({ status: 200, body: { state: "deleted" } });
    const deletedAt = (await deletionRecord(shop.tenant)).deletion?.deletedAt;
    expect(deletedAt).toEqual(expect.any(String));

    // The owner's link and the shop's LINE webhook now know nothing of the shop; every operator route answers that
    // it was deleted, and when.
    expect(await view(token)).toMatchObject({ status: 404, body: { error: "link_invalid" } });
    expect((await deliver(shop.connectionId, { destination: BOT, events: [textEvent("after deletion")] })).status)
      .toBe(404);
    const gone = { error: "tenant_deleted", deletedAt, deletedBy: null };
    for (const path of [`/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`,
      `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`]) {
      expect((await admin("GET", path)).body).toEqual(gone);
    }
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Baan Somtam" })).body)
      .toEqual(gone);
    const remaining = (await admin<{ shops: { tenant: string }[] }>("GET", "/v1/admin/pilot/shops")).body.shops
      .map((entry) => entry.tenant);
    expect(remaining).toContain(other.body.tenant);
    expect(remaining).not.toContain(shop.tenant);
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(other.body.tenant)}`)).status)
      .toBe(200);
  });

  it("matches the typed name however its outer spaces and accents were entered", async () => {
    const created = await admin<{ tenant: string; name: string; ownerName: string }>("POST", "/v1/admin/pilot/shops",
      { name: "  Café Lek  ", ownerName: " Khun Lek " });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "Café Lek", ownerName: "Khun Lek" });
    const listed = (await admin<{ shops: { tenant: string; name: string }[] }>("GET", "/v1/admin/pilot/shops")).body.shops
      .find((entry) => entry.tenant === created.body.tenant);
    expect(listed?.name).toBe("Café Lek");
    // Another word is another name; a decomposed é and stray outer spaces are the same name.
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: created.body.tenant, confirmName: "Cafe Lek" })).status)
      .toBe(409);
    expect((await admin("POST", "/v1/admin/pilot/deletions",
      { tenant: created.body.tenant, confirmName: " Café Lek " })).status).toBe(200);
  });

  it("keeps a record of who deleted a shop and when, which outlives the shop", async () => {
    // A shop that never went live: no LINE connection and no consent, so the operator's request deletes it.
    const shop = await newShop("Baan Somtam");
    const deleted = await adminWith<{ deletedAt: string }>(bindings, "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" }, "ops@manut.test");
    expect(deleted.status).toBe(200);
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`)))
      .toEqual({ status: 404, body: { error: "tenant_deleted", deletedAt: deleted.body.deletedAt,
        deletedBy: "ops@manut.test" } });
  });
});

// ---------------------------------------------------------------------------
// Deleting a live shop: the owner's confirmation through a signed link
// ---------------------------------------------------------------------------

type Asked = { status: "awaiting_owner"; confirmUrl: string; expiresAt: string };
type Settled = { ok: boolean; refused?: string; decision?: { optionId: string; decidedBy: string; decidedAt: number } };
type ConfirmationRecord = { status: "pending" | "decided" | "withdrawn";
  request: { id: string; kind: string; revision: number; expiresAt: number; detail: unknown };
  decision?: { optionId: string; decidedBy: string; role: string; decidedAt: number } };
type DeletionRecord = { tenant: string; name: string; requestedAt: string; deletedBy: string | null;
  confirmationId?: string; deletedAt?: string; counts?: Record<string, number> };

const deletionTokenOf = (confirmUrl: string) => confirmUrl.slice(`${WEB}/delete/`.length);

/// A shop as an operator first creates it: no LINE connection and no consent, so it has never gone live.
async function newShop(name: string, ownerName = "Khun Dao"): Promise<{ tenant: string }> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName });
  expect(created.status).toBe(200);
  return created.body;
}

async function askToDelete(tenant: string, confirmName = "Baan Somtam") {
  return admin<Asked & Record<string, unknown>>("POST", "/v1/admin/pilot/deletions", { tenant, confirmName });
}

async function deletionView(token: string, target: Env = bindings) {
  const response = await call(`/v1/pilot/deletions/${token}`, {}, target);
  return { status: response.status, body: (await response.json()) as DeletionView & { error?: string } };
}

async function decideDeletion(token: string, approve: boolean, target: Env = bindings) {
  const response = await call(`/v1/pilot/deletions/${token}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approve }),
  }, target);
  return { status: response.status, body: (await response.json()) as DeletionView & { error?: string; view?: DeletionView } };
}

/// The deletion record and the confirmation it points at, as AuthObject keeps them.
async function deletionRecord(tenant: string) {
  const response = await authCall(bindings, `/pilot-deletions?tenant=${encodeURIComponent(tenant)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { deletion: DeletionRecord | null; confirmation: ConfirmationRecord | null };
}

async function listedShop(tenant: string) {
  const listed = await admin<{ shops: { tenant: string; deletion?: Record<string, unknown>;
    deleting?: { shopRecord: boolean } }[] }>("GET", "/v1/admin/pilot/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops.find((entry) => entry.tenant === tenant);
}

/// The Worker's environment with one kind of call to one namespace answering 500 the next `times` times, as when an
/// object cannot be reached part way through. With `lost`, the object does the work and only its answer is lost on
/// the way back. Every other call reaches the real objects.
function failingCalls(binding: "TASK" | "TENANT" | "AUTH" | "CRED" | "SCHEDULES", method: string, path: string,
  times: number, lost = false): Env {
  let left = times;
  const namespace = bindings[binding];
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.method === method && new URL(request.url).pathname === path && left > 0) {
            left--;
            if (lost) await (await stub.fetch(request)).arrayBuffer();
            return Response.json({ error: "fixture_call_failed" }, { status: 500 });
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...bindings, [binding]: wrapped };
}

/// The task wipe failing, as when a TaskObject cannot be reached part way through a deletion.
const failingTaskWipes = (times: number) => failingCalls("TASK", "DELETE", "/wipe", times);

/// A live shop with something of everything: two messages, one proposed reply and one payment.
async function liveShopWithData() {
  const shop = await setupShop();
  const message = await customerWrites(shop, "ขอยกเลิกบัญชีค่ะ");
  await customerWrites(shop, "ลบข้อมูลด้วยนะคะ");
  const reply = await propose(shop, message.id, "รับทราบค่ะ");
  expect(reply.status).toBe(200);
  expect((await admin("POST", "/v1/admin/pilot/payments",
    { tenant: shop.tenant, orderRef: "ORD-11", amountSatang: 15000, promptPayId: "0812345678" })).status).toBe(200);
  return { shop, reply: reply.body };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// Signs `fields` the way approval-link.ts does, under the domain tag given, with the real link secret.
async function signUnder(domain: string, fields: unknown[]): Promise<string> {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const payload = base64url(utf8(JSON.stringify(fields)));
  const key = await crypto.subtle.importKey("raw", utf8(LINK_SECRET), { name: "HMAC", hash: "SHA-256" }, false,
    ["sign"]);
  return `${payload}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(domain + payload))))}`;
}

describe("deleting a live shop needs its owner's confirmation", () => {
  it("deletes a shop that never went live at once, without asking its owner", async () => {
    const shop = await newShop("Sabai Tea");
    const deleted = await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Sabai Tea" });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ tasksWiped: 0, connectionsWiped: 0, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: 0, deletedAt: expect.any(String) });
    expect((await deletionRecord(shop.tenant)).confirmation).toBeNull();
  });

  it("asks the owner of a shop with a LINE connection, deletes nothing, and answers the same link again", async () => {
    const { shop } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({ status: "awaiting_owner", expiresAt: expect.any(String),
      confirmUrl: expect.stringMatching(/^https:\/\/web\.manut\.test\/delete\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/) });
    const lifetime = Date.parse(asked.body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(lifetime).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(await messages(shop.tenant)).toHaveLength(2);

    // Asking again answers the confirmation already open: the same link and the same expiry.
    expect(await askToDelete(shop.tenant)).toEqual(asked);
    // The console's list shows the shop waiting for its owner, with that link.
    expect((await listedShop(shop.tenant))?.deletion).toEqual({ state: "awaiting_owner",
      confirmUrl: asked.body.confirmUrl, expiresAt: asked.body.expiresAt });
    // A near miss on the name still deletes nothing and asks nobody.
    expect(await askToDelete(shop.tenant, "Baan Som")).toEqual({ status: 409, body: { error: "name_mismatch" } });
  });

  it("counts the owner's consent alone as live", async () => {
    const shop = await newShop("Khao Man Gai Lek");
    // Consent is only ever recorded through an approval link; written here directly, as that route writes it.
    expect((await tenantCall(bindings, shop.tenant, "/consent", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: shop.tenant, cloudWork: true }) })).status).toBe(200);
    expect((await askToDelete(shop.tenant, "Khao Man Gai Lek")).status).toBe(202);
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`)).status).toBe(200);
  });

  it("asks nobody and deletes nothing when it cannot tell a shop is not live, or cannot make the owner's link", async () => {
    const quiet = await newShop("Sabai Tea");
    const unreadable = failingCalls("TENANT", "GET", "/consent", 1);
    expect(await adminWith(unreadable, "POST", "/v1/admin/pilot/deletions", { tenant: quiet.tenant,
      confirmName: "Sabai Tea" })).toEqual({ status: 503, body: { error: "consent_unavailable" } });
    expect(await deletionRecord(quiet.tenant)).toEqual({ deletion: null, confirmation: null });
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(quiet.tenant)}`)).status).toBe(200);

    const { shop } = await liveShopWithData();
    const { WEB_ORIGIN: _unset, ...withoutOrigin } = bindings;
    for (const [setting, target] of [
      ["WEB_ORIGIN", withoutOrigin as Env],
      ["APPROVAL_LINK_SECRET", { ...bindings, APPROVAL_LINK_SECRET: "too-short-to-sign-with" }],
    ] as const) {
      expect(await adminWith(target, "POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant,
        confirmName: "Baan Somtam" })).toEqual({ status: 503, body: { error: "not_configured", setting } });
    }
    expect(await deletionRecord(shop.tenant)).toEqual({ deletion: null, confirmation: null });
    expect(await messages(shop.tenant)).toHaveLength(2);
  });

  it("records who asked before anything else happens, as a confirmation only the owner can decide", async () => {
    const { shop } = await liveShopWithData();
    const asked = await adminWith<Asked>(bindings, "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" }, "ops@manut.test");
    expect(asked.status).toBe(202);
    const { deletion, confirmation } = await deletionRecord(shop.tenant);
    expect(deletion).toEqual({ tenant: shop.tenant, name: "Baan Somtam", requestedAt: expect.any(String),
      deletedBy: "ops@manut.test", confirmationId: confirmation?.request.id });
    // approval-core's record: one request of an owner-only kind, at its first revision, open for 24 hours.
    expect(confirmation).toMatchObject({ status: "pending",
      request: { kind: "command", revision: 1, expiresAt: Date.parse(asked.body.expiresAt) } });

    const decided = await decideDeletion(deletionTokenOf(asked.body.confirmUrl), true);
    expect(decided).toMatchObject({ status: 200, body: { state: "deleted" } });
    const after = await deletionRecord(shop.tenant);
    expect(after.confirmation).toMatchObject({ status: "decided",
      decision: { optionId: "delete", role: "owner", decidedBy: "owner-link" } });
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`)).body)
      .toEqual({ error: "tenant_deleted", deletedAt: after.deletion?.deletedAt, deletedBy: "ops@manut.test" });
  });

  it("shows the owner what goes, and the link is all it takes to read it", async () => {
    const { shop } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const shown = await deletionView(deletionTokenOf(asked.body.confirmUrl));
    expect(shown).toEqual({ status: 200, body: {
      shopName: "Baan Somtam",
      goes: { messages: 2, replies: 1, payments: 1, lineConnected: true },
      state: "awaiting_owner",
      expiresAt: asked.body.expiresAt,
    } });
  });

  it("deletes everything once the owner approves, and every link and route says so afterwards", async () => {
    const { shop, reply } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const token = deletionTokenOf(asked.body.confirmUrl);

    const decided = await decideDeletion(token, true);
    expect(decided.status).toBe(200);
    expect(decided.body).toEqual({ shopName: "Baan Somtam",
      goes: { messages: 2, replies: 1, payments: 1, lineConnected: true },
      state: "deleted", expiresAt: asked.body.expiresAt, decidedAt: expect.any(String) });

    const { deletion } = await deletionRecord(shop.tenant);
    expect(deletion?.counts).toMatchObject({ tasksWiped: 1, connectionsWiped: 1 });
    expect((await admin("GET", `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`)).body)
      .toEqual({ error: "tenant_deleted", deletedAt: deletion?.deletedAt, deletedBy: null });
    expect(await view(tokenOf(reply.approvalUrl))).toMatchObject({ status: 404, body: { error: "link_invalid" } });
    expect((await deliver(shop.connectionId, { destination: BOT, events: [textEvent("after")] })).status).toBe(404);
    expect(await listedShop(shop.tenant)).toBeUndefined();
    const tenantObject = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
    await runInDurableObject(tenantObject, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "pilot-" })).keys()]).toEqual([]);
    });
    // The confirmation outlives the shop, so its link still says what happened, with what the shop held.
    expect((await deletionView(token)).body).toEqual(decided.body);
  });

  it("deletes nothing when the owner keeps their data, and a new request asks again with a new link", async () => {
    const { shop } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const token = deletionTokenOf(asked.body.confirmUrl);

    const kept = await decideDeletion(token, false);
    expect(kept).toMatchObject({ status: 200, body: { state: "declined", decidedAt: expect.any(String) } });
    expect(await messages(shop.tenant)).toHaveLength(2);
    expect((await listedShop(shop.tenant))?.deletion).toEqual({ state: "declined",
      confirmUrl: asked.body.confirmUrl, expiresAt: asked.body.expiresAt, decidedAt: kept.body.decidedAt });

    const again = await askToDelete(shop.tenant);
    expect(again.status).toBe(202);
    expect(again.body.confirmUrl).not.toBe(asked.body.confirmUrl);
    // The old link still says no; the new one waits.
    expect((await deletionView(token)).body.state).toBe("declined");
    expect((await deletionView(deletionTokenOf(again.body.confirmUrl))).body.state).toBe("awaiting_owner");
    expect((await listedShop(shop.tenant))?.deletion).toMatchObject({ state: "awaiting_owner",
      confirmUrl: again.body.confirmUrl });
  });

  it("refuses a second decision with the settled view, and deletes nothing after a no", async () => {
    const { shop } = await liveShopWithData();
    const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);
    expect((await decideDeletion(token, false)).status).toBe(200);
    for (const approve of [true, false]) {
      const again = await decideDeletion(token, approve);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("already_decided");
      expect(again.body.view?.state).toBe("declined");
    }
    expect(await messages(shop.tenant)).toHaveLength(2);
  });

  it("settles once when two decisions arrive together", async () => {
    for (const second of [true, false]) {
      const { shop } = await liveShopWithData();
      const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);
      const answers = await Promise.all([decideDeletion(token, true), decideDeletion(token, second)]);
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      const won = answers.find((answer) => answer.status === 200)!;
      const lost = answers.find((answer) => answer.status === 409)!;
      expect(lost.body.error).toBe("already_decided");
      const { confirmation } = await deletionRecord(shop.tenant);
      if (won.body.state === "deleted") {
        expect(confirmation?.decision?.optionId).toBe("delete");
        expect(["deleting", "deleted"]).toContain(lost.body.view?.state);
        expect((await admin("GET", `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`)).body.error)
          .toBe("tenant_deleted");
      } else {
        expect(won.body.state).toBe("declined");
        expect(confirmation?.decision?.optionId).toBe("keep");
        expect(lost.body.view?.state).toBe("declined");
        expect(await messages(shop.tenant)).toHaveLength(2);
      }
    }
  });

  it("answers 410 for an expired link and 404 for a bad one, deciding nothing", async () => {
    const { shop } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const genuine = deletionTokenOf(asked.body.confirmUrl);
    const confirmationId = (await deletionRecord(shop.tenant)).confirmation!.request.id;
    const claim = { tenant: shop.tenant, confirmationId };
    const expired = await mintDeletionToken(LINK_SECRET, { ...claim, expiresAtMs: Date.now() - 1000 });
    const forged = await mintDeletionToken("an-attacker-secret-of-reasonable-length",
      { ...claim, expiresAtMs: Date.now() + 3600_000 });
    const [payload, mac] = genuine.split(".") as [string, string];
    const nowhere = await mintDeletionToken(LINK_SECRET,
      { ...claim, confirmationId: crypto.randomUUID(), expiresAtMs: Date.now() + 3600_000 });
    const tampered = `${nowhere.split(".")[0]}.${mac}`;

    expect(await deletionView(expired)).toEqual({ status: 410, body: { error: "link_expired" } });
    expect(await decideDeletion(expired, true)).toEqual({ status: 410, body: { error: "link_expired" } });
    for (const bad of [forged, tampered, `${payload}.${"A".repeat(43)}`, "garbage", nowhere]) {
      expect(await deletionView(bad)).toEqual({ status: 404, body: { error: "link_invalid" } });
      expect(await decideDeletion(bad, true)).toEqual({ status: 404, body: { error: "link_invalid" } });
    }
    expect((await decideDeletion(genuine, "yes" as unknown as boolean)).status).toBe(400);
    expect(await messages(shop.tenant)).toHaveLength(2);
    expect((await deletionView(genuine)).body.state).toBe("awaiting_owner");
  });

  it("lets nobody decide a confirmation past its expiry, and the next request opens a new one", async () => {
    const { shop } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const token = deletionTokenOf(asked.body.confirmUrl);
    const { confirmation } = await deletionRecord(shop.tenant);
    // Moves the stored confirmation's expiry into the past while the token still reads as current, as when the
    // two clocks disagree by a moment at the 24-hour mark.
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    await runInDurableObject(auth, async (_instance, state) => {
      const key = `pilot-deletion-confirmation:${encodeURIComponent(shop.tenant)}:${confirmation!.request.id}`;
      const stored = await state.storage.get<ConfirmationRecord>(key);
      expect(stored?.status).toBe("pending");
      await state.storage.put(key, { ...stored, request: { ...stored!.request, expiresAt: Date.now() - 1000 } });
    });

    expect((await deletionView(token)).body.state).toBe("expired");
    expect(await decideDeletion(token, true)).toEqual({ status: 410, body: { error: "link_expired" } });
    expect(await messages(shop.tenant)).toHaveLength(2);
    expect((await listedShop(shop.tenant))?.deletion).toMatchObject({ state: "expired" });

    const again = await askToDelete(shop.tenant);
    expect(again.status).toBe(202);
    expect(again.body.confirmUrl).not.toBe(asked.body.confirmUrl);
    // The new request withdrew the old one, so at most one confirmation per shop can ever be decided.
    expect((await deletionView(token)).body.state).toBe("expired");
    const next = await decideDeletion(deletionTokenOf(again.body.confirmUrl), true);
    expect(next).toMatchObject({ status: 200, body: { state: "deleted" } });
  });

  it("keeps reply links and deletion links apart, in both directions", async () => {
    const { shop, reply } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const deletionToken = deletionTokenOf(asked.body.confirmUrl);
    const replyToken = tokenOf(reply.approvalUrl);

    // A reply link can never delete.
    expect(await deletionView(replyToken)).toEqual({ status: 404, body: { error: "link_invalid" } });
    expect(await decideDeletion(replyToken, true)).toEqual({ status: 404, body: { error: "link_invalid" } });
    // A deletion link can never approve a reply, nor record consent.
    expect(await view(deletionToken)).toMatchObject({ status: 404, body: { error: "link_invalid" } });
    expect((await linkPost(deletionToken, "consent", { cloudWork: true })).status).toBe(404);
    expect((await linkPost(deletionToken, "decision", { approve: true })).status).toBe(404);
    expect(await messages(shop.tenant)).toHaveLength(2);
    expect((await view(replyToken)).body).toMatchObject({ state: "proposed", needsConsent: true });
    expect((await deletionView(deletionToken)).body.state).toBe("awaiting_owner");
    expect(pushes()).toHaveLength(0);

    // The separation is in the MAC itself: a payload each check would accept, signed with the real secret under
    // the other check's domain, is refused. The same signer under the right domain gives the genuine tokens.
    const confirmationId = (await deletionRecord(shop.tenant)).confirmation!.request.id;
    const deletionFields = [1, shop.tenant, confirmationId, Date.parse(asked.body.expiresAt)];
    const replyFields = [1, shop.tenant, reply.taskId, reply.actionId, Date.parse(reply.expiresAt)];
    expect(await signUnder("manut-ai/pilot-deletion/v1.", deletionFields)).toBe(deletionToken);
    expect(await signUnder("manut-ai/pilot-approval/v1.", replyFields)).toBe(replyToken);
    const deletionSignedAsReply = await signUnder("manut-ai/pilot-approval/v1.", deletionFields);
    const replySignedAsDeletion = await signUnder("manut-ai/pilot-deletion/v1.", replyFields);
    expect(await checkDeletionToken(LINK_SECRET, deletionSignedAsReply, Date.now())).toEqual(
      { ok: false, error: "link_invalid" });
    expect(await checkApprovalToken(LINK_SECRET, replySignedAsDeletion, Date.now())).toEqual(
      { ok: false, error: "link_invalid" });
    expect((await checkDeletionToken(LINK_SECRET, deletionToken, Date.now())).ok).toBe(true);
    expect((await checkApprovalToken(LINK_SECRET, replyToken, Date.now())).ok).toBe(true);
  });

  it("finishes a wipe the owner approved when the operator asks again, without asking the owner again", async () => {
    const { shop, reply } = await liveShopWithData();
    const asked = await askToDelete(shop.tenant);
    const token = deletionTokenOf(asked.body.confirmUrl);

    // The task wipe fails while the owner's yes runs the deletion: the decision stands, the data is half gone.
    const decided = await decideDeletion(token, true, failingTaskWipes(1));
    expect(decided).toMatchObject({ status: 200, body: { state: "deleting", decidedAt: expect.any(String) } });
    expect(await messages(shop.tenant)).toHaveLength(2);
    expect((await deletionView(token)).body.state).toBe("deleting");
    expect((await listedShop(shop.tenant))?.deletion).toMatchObject({ state: "deleting" });
    const decidedAt = (await deletionRecord(shop.tenant)).confirmation?.decision?.decidedAt;

    // The operator's same request runs the wipe again, still failing once, then finishing; never a new link.
    const partial = await adminWith(failingTaskWipes(1), "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" });
    expect(partial).toEqual({ status: 500, body: { error: "wipe_incomplete", tasksWiped: 0, failed: [reply.taskId] } });
    const finished = await askToDelete(shop.tenant);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ tasksWiped: 1, connectionsWiped: 1, deletedAt: expect.any(String) });
    expect(finished.body).not.toHaveProperty("confirmUrl");

    expect((await deletionView(token)).body.state).toBe("deleted");
    const { deletion, confirmation } = await deletionRecord(shop.tenant);
    expect(deletion?.deletedAt).toBe(finished.body.deletedAt);
    expect(confirmation?.decision?.decidedAt).toBe(decidedAt);
    expect((await askToDelete(shop.tenant)).body).toMatchObject({ error: "tenant_deleted" });
  });

  it("answers CORS for the page's origin only, never caches, and counts against the approval routes' limit", async () => {
    const { shop } = await liveShopWithData();
    const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);
    const preflight = await call(`/v1/pilot/deletions/${token}/decision`, {
      method: "OPTIONS",
      headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, POST");
    const ours = await call(`/v1/pilot/deletions/${token}`, { headers: { origin: WEB } });
    expect(ours.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(ours.headers.get("cache-control")).toBe("no-store");
    const theirs = await call(`/v1/pilot/deletions/${token}`, { headers: { origin: "https://evil.example" } });
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
    expect((await call("/v1/pilot/deletions/garbage")).headers.get("cache-control")).toBe("no-store");

    const keys: string[] = [];
    const limited: Env = { ...bindings, PILOT_APPROVAL_LIMITER: { limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    } } as RateLimit };
    for (const path of [`/v1/pilot/deletions/${token}`, `/v1/pilot/deletions/${token}/decision`]) {
      const response = await call(path, { method: path.endsWith("decision") ? "POST" : "GET" }, limited);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited" });
    }
    expect(keys).toHaveLength(2);
    expect((await deletionView(token)).body.state).toBe("awaiting_owner");
  });
});

// ---------------------------------------------------------------------------
// A deletion that stops part way stays on the operator's list until the same request finishes it
// ---------------------------------------------------------------------------

/// Whether the shop registry in AuthObject still lists the tenant.
async function registered(tenant: string): Promise<boolean> {
  const response = await authCall(bindings, `/pilot-shops?tenant=${encodeURIComponent(tenant)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { registered: boolean }).registered;
}

/// A shop whose own record a deletion removed, as listed from what its record of the deletion keeps.
const shopRecordGone = (tenant: string, name: string) =>
  ({ tenant, name, ownerName: "", consent: false, deleting: { shopRecord: false } });

describe("a deletion that stops part way", () => {
  it("keeps a shop whose wipe stopped at its own object on the list as deleting, and the same request finishes it", async () => {
    const { shop } = await liveShopWithData();
    const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);

    // The owner says yes, and every part of the shop is wiped but its own object, which cannot be reached.
    const decided = await decideDeletion(token, true, failingCalls("TENANT", "POST", "/tenant-wipe", 1));
    expect(decided).toMatchObject({ status: 200, body: { state: "deleting" } });
    expect(await listedShop(shop.tenant)).toMatchObject({ tenant: shop.tenant, name: "Baan Somtam",
      ownerName: "Khun Ploy", deletion: { state: "deleting" }, deleting: { shopRecord: true } });
    expect(await messages(shop.tenant)).toHaveLength(2);

    const finished = await askToDelete(shop.tenant);
    expect(finished).toMatchObject({ status: 200, body: { deletedAt: expect.any(String) } });
    expect(await listedShop(shop.tenant)).toBeUndefined();
    expect(await registered(shop.tenant)).toBe(false);
    expect((await deletionView(token)).body.state).toBe("deleted");
    expect((await deletionRecord(shop.tenant)).deletion?.deletedAt).toBe(finished.body.deletedAt);
  });

  // Every step of the deletion, in its order, failing once while the owner's yes runs it. A `lost` step did its work
  // and only its answer went missing. Once the shop's own object is wiped its data is gone, so the owner's page says
  // deleted, while the console still lists the shop, from its record of the deletion, until the last step is done.
  const steps = [
    { step: "the index read", fail: () => failingCalls("TENANT", "GET", "/index", 1), dataGone: false },
    { step: "a task wipe", fail: () => failingCalls("TASK", "DELETE", "/wipe", 1), dataGone: false },
    { step: "the vault wipe", fail: () => failingCalls("CRED", "POST", "/tenant-wipe", 1), dataGone: false },
    { step: "the schedules wipe", fail: () => failingCalls("SCHEDULES", "POST", "/tenant-wipe", 1), dataGone: false },
    { step: "the sessions wipe", fail: () => failingCalls("AUTH", "POST", "/tenant-wipe", 1), dataGone: false },
    { step: "the shop's own wipe", fail: () => failingCalls("TENANT", "POST", "/tenant-wipe", 1), dataGone: false },
    { step: "the answer of the shop's own wipe, after its tombstone",
      fail: () => failingCalls("TENANT", "POST", "/tenant-wipe", 1, true), dataGone: true },
    { step: "taking the shop off the list", fail: () => failingCalls("AUTH", "DELETE", "/pilot-shops", 1),
      dataGone: true },
  ];

  it.each(steps)("finishes when the same request runs again after $step stopped it", async ({ fail, dataGone }) => {
    const { shop } = await liveShopWithData();
    const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);

    const decided = await decideDeletion(token, true, fail());
    expect(decided).toMatchObject({ status: 200, body: { state: dataGone ? "deleted" : "deleting" } });
    expect(await registered(shop.tenant)).toBe(true);
    expect(await listedShop(shop.tenant)).toMatchObject(dataGone
      ? shopRecordGone(shop.tenant, "Baan Somtam")
      : { ownerName: "Khun Ploy", deletion: { state: "deleting" }, deleting: { shopRecord: true } });

    const finished = await askToDelete(shop.tenant);
    expect(finished).toMatchObject({ status: 200, body: { deletedAt: expect.any(String) } });
    expect(await listedShop(shop.tenant)).toBeUndefined();
    expect(await registered(shop.tenant)).toBe(false);
    expect((await deletionView(token)).body.state).toBe("deleted");
    expect((await admin("GET", `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`)).body)
      .toMatchObject({ error: "tenant_deleted", deletedAt: finished.body.deletedAt });
    expect((await askToDelete(shop.tenant)).body).toMatchObject({ error: "tenant_deleted" });
  });

  it("lists a shop whose own record is gone from its record of the deletion, and finishes it only by that name", async () => {
    const { shop } = await liveShopWithData();
    const token = deletionTokenOf((await askToDelete(shop.tenant)).body.confirmUrl);
    // The shop's own wipe stops part way, after the shop's record and before the rest of its object.
    const tenantObject = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
    await runInDurableObject(tenantObject, async (_instance, state) => {
      expect(await state.storage.delete(`pilot-shop:${encodeURIComponent(shop.tenant)}`)).toBe(true);
    });
    expect((await decideDeletion(token, true, failingCalls("TENANT", "POST", "/tenant-wipe", 1))).body.state)
      .toBe("deleting");
    expect(await listedShop(shop.tenant)).toEqual(shopRecordGone(shop.tenant, "Baan Somtam"));

    for (const confirmName of ["Baan Som", "Khun Ploy", undefined]) {
      expect(await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName }))
        .toEqual({ status: 409, body: { error: "name_mismatch" } });
    }
    await runInDurableObject(tenantObject, async (_instance, state) => {
      expect((await state.storage.list({ prefix: "pilot-msg:" })).size).toBe(2);
    });

    const finished = await askToDelete(shop.tenant, " Baan Somtam ");
    expect(finished.status).toBe(200);
    expect(await listedShop(shop.tenant)).toBeUndefined();
    await runInDurableObject(tenantObject, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "pilot-" })).keys()]).toEqual([]);
    });
    expect((await deletionView(token)).body.state).toBe("deleted");
  });

  it("keeps a shop that never went live on the list as deleting too, and finishes it as it was asked for", async () => {
    const shop = await newShop("Sabai Tea");
    const stopped = await adminWith(failingCalls("TENANT", "POST", "/tenant-wipe", 1), "POST",
      "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Sabai Tea" }, "ops@manut.test");
    expect(stopped).toEqual({ status: 500, body: { error: "wipe_incomplete", tasksWiped: 0, failed: ["index"] } });
    // No owner was asked, so there is no link: only that the deletion has not finished.
    expect(await listedShop(shop.tenant)).toEqual({ tenant: shop.tenant, name: "Sabai Tea", ownerName: "Khun Dao",
      consent: false, deleting: { shopRecord: true } });
    const { deletion: asked } = await deletionRecord(shop.tenant);

    const finished = await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Sabai Tea" });
    expect(finished).toMatchObject({ status: 200, body: { deletedAt: expect.any(String) } });
    expect(await listedShop(shop.tenant)).toBeUndefined();
    // The record keeps who asked and when, and says when the deletion finished.
    expect((await deletionRecord(shop.tenant)).deletion).toEqual({ ...asked, deletedAt: finished.body.deletedAt,
      counts: expect.any(Object) });
    expect(asked).toMatchObject({ deletedBy: "ops@manut.test" });
  });

  it("asks the owner of a shop that went live after its deletion stopped, rather than finish it", async () => {
    const shop = await newShop("Baan Somtam");
    const stopped = await adminWith(failingCalls("TENANT", "GET", "/index", 1), "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" });
    expect(stopped.body).toMatchObject({ error: "wipe_incomplete", failed: ["index-read"] });
    expect((await listedShop(shop.tenant))?.deleting).toEqual({ shopRecord: true });
    // Consent is only ever recorded through an approval link; written here directly, as that route writes it.
    expect((await tenantCall(bindings, shop.tenant, "/consent", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: shop.tenant, cloudWork: true }) })).status).toBe(200);

    expect((await askToDelete(shop.tenant)).status).toBe(202);
    expect((await listedShop(shop.tenant))?.deleting).toBeUndefined();
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`)).status).toBe(200);
  });

  it("never takes a shop record it cannot read for one a deletion removed", async () => {
    const shop = await newShop("Baan Somtam");
    expect((await adminWith(failingCalls("TENANT", "GET", "/index", 1), "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" })).body).toMatchObject({ failed: ["index-read"] });
    // The shop goes live after its deletion stopped, so finishing it now needs its owner's yes.
    expect((await tenantCall(bindings, shop.tenant, "/consent", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: shop.tenant, cloudWork: true }) })).status).toBe(200);

    expect(await adminWith(failingCalls("TENANT", "GET", "/pilot/shop", 1), "POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Somtam" })).toEqual({ status: 503, body: { error: "shop_unavailable" } });
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`)).status).toBe(200);
    expect((await askToDelete(shop.tenant)).status).toBe(202);
  });

  it("runs again cleanly once it has finished: every object answers its own wipe a second time", async () => {
    const { shop } = await liveShopWithData();
    expect(await (await tenantDelete(bindings, shop.tenant)).json()).toMatchObject({ tasksWiped: 1, connectionsWiped: 1 });
    const again = await tenantDelete(bindings, shop.tenant);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ tasksWiped: 0, connectionsWiped: 0, schedulesWiped: 0, occurrencesWiped: 0,
      sessionsWiped: 0, deletedAt: expect.any(String) });
  });

  it("answers as before for a shop whose deletion finished, or that never was one", async () => {
    const shop = await newShop("Sabai Tea");
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Sabai Tea" })).status)
      .toBe(200);
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Sabai Tea" })).body)
      .toMatchObject({ error: "tenant_deleted" });
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: "pilot:nobody", confirmName: "Sabai Tea" })).body)
      .toEqual({ error: "shop_not_found" });
  });

  it("fails the list rather than leave out a shop whose record cannot be read", async () => {
    const shop = await newShop("Sabai Tea");
    expect(await adminWith(failingCalls("TENANT", "GET", "/pilot/shop", 1), "GET", "/v1/admin/pilot/shops"))
      .toEqual({ status: 503, body: { error: "shops_unavailable" } });
    expect(await listedShop(shop.tenant)).toBeDefined();
  });
});

describe("the shop registry", () => {
  it("takes a shop off only at the deletion's last step, and only the shop it names", async () => {
    const one = await newShop("Sabai Tea");
    const two = await newShop("Khao Man Gai Lek");
    expect(await registered(one.tenant)).toBe(true);
    // The sessions step leaves the row, which a deletion now removes last of all.
    expect((await authCall(bindings, "/tenant-wipe", { method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" },
      body: JSON.stringify({ tenant: one.tenant }) })).status).toBe(200);
    expect(await registered(one.tenant)).toBe(true);

    const remove = (headers: Record<string, string>, tenant = one.tenant) =>
      authCall(bindings, `/pilot-shops?tenant=${encodeURIComponent(tenant)}`, { method: "DELETE", headers });
    expect((await remove({})).status).toBe(403);
    expect((await remove({ "x-admin": "1" })).status).toBe(403);
    expect((await authCall(bindings, "/pilot-shops", { method: "DELETE", headers: { "x-wipe": "1" } })).status)
      .toBe(400);
    expect(await registered(one.tenant)).toBe(true);
    expect((await remove({ "x-wipe": "1" })).status).toBe(200);
    expect(await registered(one.tenant)).toBe(false);
    expect(await registered(two.tenant)).toBe(true);
    expect((await authCall(bindings, "/pilot-shops?tenant=")).status).toBe(400);
  });
});

describe("the deletion confirmation's store", () => {
  async function decideAtStore(body: Record<string, unknown>, headers: Record<string, string> = { "x-admin": "1" }) {
    const response = await authCall(bindings, "/pilot-deletions/decide", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as { result?: Settled; error?: string } };
  }

  it("lets only the owner decide, and only the Worker write", async () => {
    const { shop } = await liveShopWithData();
    await askToDelete(shop.tenant);
    const id = (await deletionRecord(shop.tenant)).confirmation!.request.id;
    const helper = await decideAtStore({ tenant: shop.tenant, id, approve: false, role: "helper", decidedBy: "staff" });
    expect(helper.body.result).toEqual({ ok: false, refused: "not_permitted" });
    expect((await decideAtStore({ tenant: shop.tenant, id, approve: true, role: "owner", decidedBy: "x" }, {})).status)
      .toBe(403);
    expect((await decideAtStore({ tenant: shop.tenant, id, approve: true, role: "boss", decidedBy: "x" })).status)
      .toBe(400);
    expect((await deletionRecord(shop.tenant)).confirmation?.status).toBe("pending");
  });

  it("settles a confirmation once however many decisions arrive together", async () => {
    const { shop } = await liveShopWithData();
    await askToDelete(shop.tenant);
    const id = (await deletionRecord(shop.tenant)).confirmation!.request.id;
    const answers = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      decideAtStore({ tenant: shop.tenant, id, approve: index % 2 === 0, role: "owner", decidedBy: `owner-${index}` })));
    const settled = answers.filter((answer) => answer.body.result?.ok);
    expect(settled).toHaveLength(1);
    const first = settled[0]!.body.result!.decision!;
    for (const answer of answers.filter((entry) => !entry.body.result?.ok)) {
      expect(answer.body.result).toEqual({ ok: false, refused: "already_decided", decision: first });
    }
    expect((await deletionRecord(shop.tenant)).confirmation?.decision).toEqual(first);
  });
});
