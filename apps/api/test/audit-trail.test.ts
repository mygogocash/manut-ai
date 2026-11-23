import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { AuditEntry, AuditMissed } from "../src/audit-log";
import { tenantCall } from "../src/tenant-data";

// What the shop's audit log records as the pilot runs, through the real Worker and objects: every operator action
// with the operator's Access identity, the owner's consent and decisions, each dispatch with its outcome, and a
// deletion's request and answer. Nothing a customer or the operator wrote, and no secret, ever reaches the log, and a
// log that cannot be written never stops the action it records.
//
// LINE is a stub on the global fetch, as in pilot.test.ts: nothing leaves the test.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const EMAIL = "ops@manut.test";
const WEB = "https://web.manut.test";
const CHANNEL_SECRET = "fixture-line-channel-secret-0002";
const CHANNEL_TOKEN = "fixture-line-channel-access-token-audit";
const BOT = `U${"e".repeat(32)}`;
const CUSTOMER = `U${"f".repeat(32)}`;
const CUSTOMER_WORDS = "สั่งเทียนไปสามวันแล้ว ยังไม่ได้รับของเลยค่ะ";
const REPLY_TEXT = "ขออภัยค่ะ ของจะถึงพรุ่งนี้นะคะ";
const DISPLAY_NAME = "Khun Somsri";

let eventCounter = 0;
const eventId = () => `01K${Date.now().toString(36).toUpperCase()}${(eventCounter++).toString().padStart(6, "0")}`;

function sourceIp(): string {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  return `2001:db8:${groups.join(":")}`;
}

async function call(path: string, init: RequestInit = {}, target: Env = bindings): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  request.headers.set("cf-connecting-ip", sourceIp());
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

/// An operator call through the admin gate, with the Access identity `email` (none for a service token).
async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown,
  email: string | null = EMAIL, target: Env = bindings) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => (email ? { email } : undefined) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, {
    method, headers: OPERATOR, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

let pushAnswer: () => Response;

beforeEach(async () => {
  expect((await admin("PUT", "/v1/admin/flags", { officeInbound: true, officeCloud: true, officeExternalWrites: true }))
    .status).toBe(200);
  pushAnswer = () => Response.json({ sentMessages: [{ id: "461230966842064898" }] },
    { headers: { "x-line-request-id": "fixture-request-audit" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.line.me/v2/bot/message/push") return pushAnswer();
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) {
      return Response.json({ displayName: DISPLAY_NAME, userId: CUSTOMER });
    }
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

async function newShop(name = "Baan Tian"): Promise<string> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName: "Khun Ying" });
  expect(created.status).toBe(200);
  return created.body.tenant;
}

async function connect(tenant: string, email: string | null = EMAIL): Promise<string> {
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", { tenant,
    channelId: "2000000002", botUserId: BOT, channelSecret: CHANNEL_SECRET, channelAccessToken: CHANNEL_TOKEN }, email);
  expect(connected.status).toBe(200);
  return connected.body.connectionId;
}

async function liveShop(): Promise<Shop> {
  const tenant = await newShop();
  return { tenant, connectionId: await connect(tenant) };
}

/// A customer writes; answers the stored message's id.
async function customerWrites(shop: Shop, text = CUSTOMER_WORDS): Promise<string> {
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

type Proposed = { taskId: string; actionId: string; approvalUrl: string };

async function propose(shop: Shop, messageId: string): Promise<Proposed> {
  const proposed = await admin<Proposed>("POST", "/v1/admin/pilot/replies", { tenant: shop.tenant, messageId,
    text: REPLY_TEXT });
  expect(proposed.status).toBe(200);
  return proposed.body;
}

const tokenOf = (url: string, page: "approve" | "delete") => url.slice(`${WEB}/${page}/`.length);

async function link(path: string, body: unknown, target: Env = bindings) {
  const response = await call(path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }, target);
  return { status: response.status, body: (await response.json()) as { state?: string; error?: string } };
}

async function log(tenant: string): Promise<{ entries: AuditEntry[]; missed: AuditMissed | null }> {
  const page = await admin<{ entries: AuditEntry[]; missed: AuditMissed | null }>("GET",
    `/v1/admin/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(page.status).toBe(200);
  return { entries: page.body.entries, missed: page.body.missed };
}

/// The owner approves through the link. The send runs after the answer (in waitUntil), so the answer says it is
/// dispatching and a read of the link afterwards says how it settled.
async function approve(token: string, target: Env = bindings): Promise<string | undefined> {
  expect((await link(`/v1/pilot/approvals/${token}/decision`, { approve: true }, target)).body.state)
    .toBe("dispatching");
  const read = await call(`/v1/pilot/approvals/${token}`);
  return ((await read.json()) as { state?: string }).state;
}

/// The log oldest first, each entry as what it says without its id and time.
async function trail(tenant: string) {
  return (await log(tenant)).entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
}

/// The Worker's environment with every `method path` call to the TenantObject answering 500.
function failingTenant(method: string, paths: string[]): Env {
  const namespace = bindings.TENANT;
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.method === method && paths.includes(new URL(request.url).pathname)) {
            return Response.json({ error: "fixture_call_failed" }, { status: 500 });
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...bindings, TENANT: wrapped };
}

const operator = { kind: "operator", email: EMAIL };

describe("operator actions", () => {
  it("records each with the operator's Access identity, in the same write as its record", async () => {
    const tenant = await newShop();
    const first = await connect(tenant);
    const second = await connect(tenant, null);
    const shop = { tenant, connectionId: second };
    const messageId = await customerWrites(shop);
    const reply = await propose(shop, messageId);
    const payment = await admin<{ id: string }>("POST", "/v1/admin/pilot/payments",
      { tenant, orderRef: "ORD-77", amountSatang: 129000, promptPayId: "0812345678", slipNote: "seen in the app" });
    const subscription = await admin<{ id: string }>("POST", "/v1/admin/pilot/subscription-payments",
      { tenant, amountSatang: 49900, slipRef: "SLIP 0001", slipNote: "first month" });
    // A slip recorded already records nothing, so it writes no entry either.
    expect((await admin("POST", "/v1/admin/pilot/subscription-payments",
      { tenant, amountSatang: 49900, slipRef: "slip0001" })).status).toBe(409);
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 15000 })).status).toBe(200);
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: null }, null)).status).toBe(200);

    expect(await trail(tenant)).toEqual([
      { actor: operator, action: "shop.created", subject: {}, outcome: "ok" },
      { actor: operator, action: "line.connected", subject: { connectionId: first }, outcome: "ok" },
      { actor: { kind: "operator", email: null }, action: "line.connected",
        subject: { connectionId: second, previousConnectionId: first }, outcome: "ok" },
      { actor: operator, action: "reply.proposed",
        subject: { taskId: reply.taskId, actionId: reply.actionId, messageId }, outcome: "ok" },
      { actor: operator, action: "payment.recorded", subject: { paymentId: payment.body.id }, outcome: "ok",
        amountSatang: 129000 },
      { actor: operator, action: "subscription_payment.recorded", subject: { paymentId: subscription.body.id },
        outcome: "ok", amountSatang: 49900 },
      { actor: operator, action: "model.cap_set", subject: {}, outcome: "ok", amountSatang: 15000 },
      { actor: { kind: "operator", email: null }, action: "model.cap_cleared", subject: {}, outcome: "ok" },
    ]);
  });
});

describe("the owner's consent and decisions, and every dispatch", () => {
  it("records consent, each decision, and each send with how it settled", async () => {
    const shop = await liveShop();
    const sent = await propose(shop, await customerWrites(shop));
    const token = tokenOf(sent.approvalUrl, "approve");
    expect((await link(`/v1/pilot/approvals/${token}/consent`, { cloudWork: true })).status).toBe(200);
    expect(await approve(token)).toBe("confirmed");

    const kept = await propose(shop, await customerWrites(shop, "ส่งฟรีไหมคะ"));
    expect((await link(`/v1/pilot/approvals/${tokenOf(kept.approvalUrl, "approve")}/decision`, { approve: false }))
      .body.state).toBe("rejected");

    pushAnswer = () => Response.json({ message: "The request body has 1 error(s)" }, { status: 400 });
    const refused = await propose(shop, await customerWrites(shop, "มีโปรไหมคะ"));
    expect(await approve(tokenOf(refused.approvalUrl, "approve"))).toBe("failed");

    const said = (await trail(shop.tenant)).filter((entry) => entry.actor.kind !== "operator");
    const owner = { kind: "owner" };
    const system = { kind: "system" };
    const about = (reply: Proposed) => ({ taskId: reply.taskId, actionId: reply.actionId });
    expect(said).toEqual([
      { actor: owner, action: "consent.given", subject: {}, outcome: "ok" },
      { actor: owner, action: "reply.decided", subject: about(sent), outcome: "approved" },
      { actor: system, action: "dispatch.started", subject: about(sent), outcome: "ok" },
      { actor: system, action: "dispatch.settled", subject: about(sent), outcome: "confirmed" },
      { actor: owner, action: "reply.decided", subject: about(kept), outcome: "declined" },
      { actor: owner, action: "reply.decided", subject: about(refused), outcome: "approved" },
      { actor: system, action: "dispatch.started", subject: about(refused), outcome: "ok" },
      { actor: system, action: "dispatch.settled", subject: about(refused), outcome: "failed" },
    ]);
  });

  it("never holds a customer's words, a reply's text, a name, a note or a secret", async () => {
    const shop = await liveShop();
    const sent = await propose(shop, await customerWrites(shop));
    const token = tokenOf(sent.approvalUrl, "approve");
    expect((await link(`/v1/pilot/approvals/${token}/consent`, { cloudWork: true })).status).toBe(200);
    expect((await link(`/v1/pilot/approvals/${token}/decision`, { approve: true })).status).toBe(200);
    expect((await admin("POST", "/v1/admin/pilot/payments", { tenant: shop.tenant, orderRef: "ORD-9",
      amountSatang: 5000, promptPayId: "0812345678", slipNote: "paid at the counter" })).status).toBe(200);
    const written = JSON.stringify(await log(shop.tenant));
    for (const words of [CUSTOMER_WORDS, REPLY_TEXT, DISPLAY_NAME, "paid at the counter", "ORD-9", CHANNEL_SECRET,
      CHANNEL_TOKEN, bindings.APPROVAL_LINK_SECRET!, token]) {
      expect(written).not.toContain(words);
    }
  });
});

describe("a shop's deletion", () => {
  it("records the operator's request and the owner's answer, and goes with the shop", async () => {
    const shop = await liveShop();
    const asked = await admin<{ confirmUrl: string }>("POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Tian" });
    expect(asked.status).toBe(202);
    // Asking again while that confirmation waits answers the same link, and is not a new request.
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Baan Tian" })).status)
      .toBe(202);
    const token = tokenOf(asked.body.confirmUrl, "delete");
    expect((await link(`/v1/pilot/deletions/${token}/decision`, { approve: false })).body.state).toBe("declined");
    const confirmation = (await trail(shop.tenant)).find((entry) => entry.action === "deletion.requested");
    const confirmationId = confirmation?.subject.confirmationId;
    expect(confirmationId).toEqual(expect.any(String));
    expect((await trail(shop.tenant)).filter((entry) => entry.action.startsWith("deletion."))).toEqual([
      { actor: operator, action: "deletion.requested", subject: { confirmationId }, outcome: "awaiting_owner" },
      { actor: { kind: "owner" }, action: "deletion.decided", subject: { confirmationId }, outcome: "declined" },
    ]);

    const again = await admin<{ confirmUrl: string }>("POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Tian" });
    expect((await link(`/v1/pilot/deletions/${tokenOf(again.body.confirmUrl, "delete")}/decision`, { approve: true }))
      .body.state).toBe("deleted");
    expect(await log(shop.tenant)).toEqual({ entries: [], missed: null });
  });
});

describe("a log that cannot be written", () => {
  it("never stops the action it records: the owner's answers and the send go through, and each miss is counted", async () => {
    const shop = await liveShop();
    const sent = await propose(shop, await customerWrites(shop));
    const token = tokenOf(sent.approvalUrl, "approve");
    expect((await link(`/v1/pilot/approvals/${token}/consent`, { cloudWork: true })).status).toBe(200);
    // The reply's decision time and its entry share one write, and the dispatch's two entries are appended after.
    const broken = failingTenant("POST", ["/audit", "/pilot/reply-decided"]);
    expect(await approve(token, broken)).toBe("confirmed");
    expect((await log(shop.tenant)).missed).toEqual({ count: 3, lastAt: expect.any(String),
      lastAction: "dispatch.settled" });

    const asked = await admin<{ confirmUrl: string }>("POST", "/v1/admin/pilot/deletions",
      { tenant: shop.tenant, confirmName: "Baan Tian" }, EMAIL, broken);
    expect(asked.status).toBe(202);
    const answered = await link(`/v1/pilot/deletions/${tokenOf(asked.body.confirmUrl, "delete")}/decision`,
      { approve: false }, broken);
    expect(answered.body.state).toBe("declined");
    expect((await log(shop.tenant)).missed?.count).toBe(5);
  });
});
