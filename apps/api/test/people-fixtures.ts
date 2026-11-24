import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import type { ApprovalKind, ApprovalRecord } from "@manut/approval-core";
import { expect } from "vitest";
import worker, { type Env } from "../src/index";
import { testOutbox } from "../src/email-sender";
import { MAKES_TODAY_KEY } from "../src/shops-store";
import { JOB_REQUEST_OPTIONS, type ActionProposalJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";
import { adminFetch, trustedTaskPut } from "./authenticated-fixtures";
import { sourceWorker } from "./source-worker";

// Fixtures for the people around a shop (docs/people.md): helpers signing in through the lifted auth's real exchange,
// a pilot shop with a LINE connection and replies, the operator's people routes, and requests of every kind.

export const bindings = env as unknown as Env;
export const WEB = "https://web.manut.test";
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const CHANNEL_SECRET = "fixture-line-channel-secret-0005";
const BOT = `U${"5".repeat(32)}`;
export const CUSTOMER = `U${"6".repeat(32)}`;

// TEST-ONLY Apple keypair, the same one auth.test.ts uses: its public half is TEST_JWKS_JSON in wrangler.test.json.
// Neither half is a production credential, and production never reads TEST_JWKS_JSON.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};
const NONCE = "people-nonce";

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// An Apple identity token for `claims`, signed with the test key. The usual claims are filled in, so a test names only
/// what it is about.
export async function appleIdentity(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "https://appleid.apple.com", aud: "test-client", sub: `apple-${crypto.randomUUID()}`,
    iat: now - 60, exp: now + 600, nonce: await sha256Hex(NONCE), ...claims };
  const key = await crypto.subtle.importKey("jwk", TEST_PRIVATE_JWK, { name: "ECDSA", namedCurve: "P-256" }, false,
    ["sign"]);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
}

export type SignedIn = { tenant: string; accessToken: string; refreshToken: string; deviceId: string;
  headers: { authorization: string } };

/// Someone signing in with Apple through the real exchange. `email` is the address Apple verified for them; without it
/// the session has none, as for a token that carries no verified email.
export async function signIn(email?: string): Promise<SignedIn> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const identityToken = await appleIdentity(email === undefined ? {} : { email, email_verified: true });
  const response = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken, nonce: NONCE, deviceId }) });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

/// Someone signing in with a code sent by email through the real routes (email-code.ts), reading the code from the test
/// outbox as a person reads it from the email. Each request comes from a source of its own. Its tenant is `email:`.
export async function emailSignIn(email: string): Promise<SignedIn> {
  const asked = await sourceWorker.fetch("https://api.manut.test/v1/auth/email/code", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  expect(asked.status).toBe(200);
  const sent = testOutbox().filter((one) => one.to === email.trim().toLowerCase());
  const code = /sign-in code is (\d{6})\./.exec(sent.at(-1)?.text ?? "")?.[1];
  const deviceId = `device-${crypto.randomUUID()}`;
  const exchanged = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email", email, code, deviceId }) });
  expect(exchanged.status).toBe(200);
  const body = (await exchanged.json()) as { tenant: string; accessToken: string; refreshToken: string };
  expect(body.tenant).toMatch(/^email:[0-9a-f]{64}$/);
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

/// A public request with its own source address, run to the end of its waitUntil work, so a send the answer started
/// has settled by the time this returns.
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  request.headers.set("cf-connecting-ip", `2001:db8:${groups.join(":")}`);
  const context = createExecutionContext();
  const response = await worker.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

/// Clears the day's count of shops people began to make themselves (shops-store.ts, `SELF_SERVE_MAKES_PER_DAY`), so a file
/// that makes more shops than a day allows starts each test with the day's sign-ups open.
export async function forgetTodaysMakes(): Promise<void> {
  await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), (_instance, state) =>
    state.storage.delete(MAKES_TODAY_KEY));
}

export type Answer<T = Record<string, unknown>> = { status: number; body: T };

async function answer<T>(response: Response): Promise<Answer<T>> {
  return { status: response.status, body: (await response.json()) as T };
}

export async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown):
  Promise<Answer<T>> {
  return answer<T>(await adminFetch(`https://api.manut.test${path}`, { method, headers: OPERATOR,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

/// A JSON request with a bearer credential, as a signed-in surface sends it.
export async function asSession<T = Record<string, unknown>>(headers: { authorization?: string }, method: string,
  path: string, body?: unknown): Promise<Answer<T>> {
  return answer<T>(await call(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

export function setFlags(flags: Record<string, boolean>) {
  return admin("PUT", "/v1/admin/flags", flags);
}

/// Counts LINE pushes on the global fetch, which answers everything else 599 so nothing leaves the test. Call it in
/// beforeEach; the caller restores the mock afterwards.
export function stubLine(spy: (impl: typeof fetch) => void): { pushes: () => number; outbound: () => string[] } {
  let pushes = 0;
  const outbound: string[] = [];
  spy(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    if (url === "https://api.line.me/v2/bot/message/push") {
      pushes++;
      return Response.json({ sentMessages: [{ id: "461230966842064899" }] }, { headers: { "x-line-request-id": "r-5" } });
    }
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return Response.json({ displayName: "Somchai" });
    return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
  });
  return { pushes: () => pushes, outbound: () => [...outbound] };
}

async function lineSign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type Shop = { tenant: string; connectionId: string; name: string };

/// A pilot shop with its LINE connection, as the operator console makes one.
export async function setupShop(name = "Baan Mali"): Promise<Shop> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName: "Fon" });
  expect(created.status).toBe(200);
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant: created.body.tenant, channelId: "2000000005", botUserId: BOT, channelSecret: CHANNEL_SECRET,
    channelAccessToken: "fixture-line-channel-access-token-people",
  });
  expect(connected.status).toBe(200);
  return { tenant: created.body.tenant, connectionId: connected.body.connectionId, name };
}

let eventCounter = 0;

/// A customer writes to the shop on LINE; answers the stored message's id.
async function customerWrites(shop: Shop, text: string): Promise<string> {
  const raw = JSON.stringify({ destination: BOT, events: [{ type: "message", mode: "active", timestamp: Date.now(),
    source: { type: "user", userId: CUSTOMER }, webhookEventId: `01P${Date.now().toString(36)}${eventCounter++}`,
    deliveryContext: { isRedelivery: false }, replyToken: "fixture-reply-token",
    message: { type: "text", id: `${Date.now()}${eventCounter}`, text } }] });
  const delivered = await call(`/v1/inbound/line/${shop.connectionId}`, { method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": await lineSign(raw) }, body: raw });
  expect(delivered.status).toBe(200);
  const listed = await admin<{ messages: { id: string; text: string }[] }>("GET",
    `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`);
  return listed.body.messages.find((message) => message.text === text)!.id;
}

export type Reply = { taskId: string; actionId: string; token: string };

/// A reply an operator proposes to a new customer message: an approval-core request of kind `reply`, and the owner's
/// link for it.
export async function proposeReply(shop: Shop, text: string): Promise<Reply> {
  const messageId = await customerWrites(shop, `question for: ${text}`);
  const proposed = await admin<{ taskId: string; actionId: string; approvalUrl: string }>("POST",
    "/v1/admin/pilot/replies", { tenant: shop.tenant, messageId, text });
  expect(proposed.status).toBe(200);
  return { taskId: proposed.body.taskId, actionId: proposed.body.actionId,
    token: proposed.body.approvalUrl.slice(`${WEB}/approve/`.length) };
}

/// The owner's link, as the approval page calls it.
export async function linkPost(reply: Reply, leaf: "consent" | "decision", body: unknown) {
  return answer<{ state?: string; error?: string; view?: { state: string } }>(await call(
    `/v1/pilot/approvals/${reply.token}/${leaf}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) }));
}

export async function linkView(reply: Reply): Promise<{ state: string; decidedAt?: string }> {
  return (await (await call(`/v1/pilot/approvals/${reply.token}`)).json()) as { state: string; decidedAt?: string };
}

/// The owner gives the shop's consent on a reply's link, as the pilot records it.
export async function ownerConsents(reply: Reply): Promise<void> {
  expect((await linkPost(reply, "consent", { cloudWork: true })).status).toBe(200);
}

/// The shop's consent to cloud work, recorded in its object as the owner's link records it, for tests with no reply.
/// Approving anything needs it, and the switches and consent are read before approval-core is asked.
export async function shopConsents(tenant: string): Promise<void> {
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
}

export function taskStub(taskId: string) {
  return bindings.TASK.get(bindings.TASK.idFromName(taskId));
}

/// A request and its action, as the task object holds them now.
export async function storedRequest(tenant: string, taskId: string, requestId: string) {
  const response = await taskStub(taskId).fetch(new Request(`https://task/requests/${requestId}`,
    { headers: { "x-tenant": tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { record: ApprovalRecord; action: ActionProposalJSON };
}

/// A draft task of the shop's, in its index as `POST /v1/tasks` leaves one.
export async function shopTask(tenant: string): Promise<string> {
  const taskId = `people-task-${crypto.randomUUID()}`;
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Owner's requests", objective: "Wait for the owner",
    state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() },
  tenant)).status).toBe(200);
  return taskId;
}

/// A request of any kind waiting on the shop's task, stored as the task object stores a worker's: an action bound to
/// an approval-core request with the usual two options. No route opens money, public post or payment confirmation
/// requests yet (payments and posting are parked), so the stored state stands in for the worker that will.
export async function plantRequest(tenant: string, taskId: string, kind: ApprovalKind,
  options: { revision?: number; expiresAt?: number } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = options.expiresAt ?? now + 3600_000;
  const action: ActionProposalJSON = { id, tenant, connectionId: "conn-planted", providerAccountId: "acct-planted",
    operationType: "linear.issue.create", targetResourceId: "ws/planted", resourceScope: ["ws/planted"],
    payload: { title: `planted ${kind}` }, payloadHash: "planted", grantRevision: 1,
    proposedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), state: "proposed",
    requestId: id };
  const record: ApprovalRecord = { status: "pending", request: { id, kind, options: JOB_REQUEST_OPTIONS,
    revision: options.revision ?? 1, createdAt: now, expiresAt, detail: { actionId: id, kind } } };
  await runInDurableObject(taskStub(taskId), async (_instance, state) => {
    await state.storage.put({ [`action:${id}`]: action, [`request:${id}`]: record });
  });
  return id;
}

export type Invited = { invite: { id: string; name: string; status: string; createdAt: string; expiresAt: string };
  inviteUrl: string };

export async function invite(shop: Shop, name: string, identity: unknown) {
  return admin<Invited & { error?: string }>("POST", "/v1/admin/people/invites", { tenant: shop.tenant, name, identity });
}

export function inviteToken(inviteUrl: string): string {
  expect(inviteUrl.startsWith(`${WEB}/join/`)).toBe(true);
  return inviteUrl.slice(`${WEB}/join/`.length);
}

export type Joined = { answer: "joined"; shop: { id: string; name: string; ownerName: string };
  helper: { id: string; name: string }; session: { accessToken: string; expiresAt: string } };

export async function accept(signedIn: { headers: { authorization?: string } }, token: string) {
  return asSession<Record<string, unknown>>(signedIn.headers, "POST", "/v1/people/accept", { token });
}

export type Helper = { id: string; email: string; person: SignedIn; headers: { authorization: string } };

/// A helper the owner invited by email who signed in with Apple as that address and joined: their id and their first
/// device's helper session.
export async function joinHelper(shop: Shop, name = "Mint", email = `${name.toLowerCase()}-${crypto.randomUUID()}@baanmali.example`):
  Promise<Helper> {
  const made = await invite(shop, name, { kind: "email", address: email });
  expect(made.status).toBe(200);
  const person = await signIn(email);
  const joined = await accept(person, inviteToken(made.body.inviteUrl));
  expect(joined.status).toBe(200);
  const body = joined.body as unknown as Joined;
  return { id: body.helper.id, email, person, headers: { authorization: `Bearer ${body.session.accessToken}` } };
}

/// A decision from a session, as the desktop's answering slice and a helper's app send it.
export async function decide(headers: { authorization?: string }, requestId: string, body: unknown) {
  return asSession<{ result?: Record<string, unknown> & { ok: boolean }; action?: string; error?: string;
    removedAt?: string }>(headers, "POST", `/v1/approvals/${encodeURIComponent(requestId)}/decision`, body);
}

/// The shop's audit log, newest first, as the console reads it.
export async function auditEntries(tenant: string) {
  const page = await admin<{ entries: { actor: Record<string, unknown>; action: string; subject: Record<string, string>;
    outcome: string; reason?: string }[] }>("GET", `/v1/admin/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(page.status).toBe(200);
  return page.body.entries;
}

/// A link code from `person`'s own signed-in session, as the app shows it for the owner to send their operator
/// (docs/several-shops.md).
export async function ownerCode(person: SignedIn): Promise<string> {
  const made = await asSession<{ code: string; expiresAt: string }>(person.headers, "POST", "/v1/shops/owner-code");
  expect(made.status).toBe(200);
  return made.body.code;
}

/// `person`'s account linked by the operator as `shop`'s owner, with a fresh code from their app: the link's id.
export async function linkAccount(shop: { tenant: string }, person: SignedIn): Promise<string> {
  const linked = await admin<{ ownerAccount: { id: string } }>("POST", "/v1/admin/shops/owner",
    { tenant: shop.tenant, code: await ownerCode(person) });
  expect(linked.status).toBe(200);
  return linked.body.ownerAccount.id;
}

/// A device of `person` opening `shop` as its owner: the headers that carry the owner session.
export async function ownerSession(person: SignedIn, shop: { tenant: string }): Promise<{ authorization: string }> {
  const opened = await asSession<{ role: string; session: { accessToken: string } }>(person.headers, "POST",
    "/v1/shops/session", { shop: shop.tenant });
  expect(opened.status).toBe(200);
  expect(opened.body.role).toBe("owner");
  return { authorization: `Bearer ${opened.body.session.accessToken}` };
}

export type Owner = { person: SignedIn; accountId: string; headers: { authorization: string } };

/// The shop's owner: signed in with Apple (as `person` when given), the account linked to the shop by the operator, and
/// one device holding an owner session for it.
export async function linkedOwner(shop: { tenant: string }, person?: SignedIn): Promise<Owner> {
  const signedIn = person ?? await signIn();
  const accountId = await linkAccount(shop, signedIn);
  return { person: signedIn, accountId, headers: await ownerSession(signedIn, shop) };
}

/// The Worker's bindings with one object namespace failing the requests `fails` picks, as if that object could not be
/// reached: answering 500, or with `throws`, throwing as a call to an object that is down does. Every other request
/// reaches the real object.
export function failingWhere(name: "AUTH" | "TENANT", fails: (request: Request) => boolean, throws = false):
  typeof bindings {
  const namespace = bindings[name];
  return { ...bindings, [name]: {
    idFromName: (id: string) => namespace.idFromName(id),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (!fails(request)) return stub.fetch(request);
        if (throws) throw new Error("fixture: object unreachable");
        return Response.json({ error: "fixture" }, { status: 500 });
      } };
    },
  } as unknown as DurableObjectNamespace };
}

/// A request to the Worker with other bindings, as the operator console (with Access) or a signed-in app sends it.
export async function callWith(target: typeof bindings, path: string, init: { method?: string;
  headers?: { authorization?: string }; body?: unknown; operator?: boolean }) {
  const context = createExecutionContext();
  if (init.operator) {
    Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => undefined },
      configurable: true });
  }
  const headers = { "content-type": "application/json", ...(init.operator ? { authorization: "Bearer test-key" } : {}),
    ...init.headers };
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: init.method ?? "GET", headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
