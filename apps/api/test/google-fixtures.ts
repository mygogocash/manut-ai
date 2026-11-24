import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { bangkokMonth } from "../src/model-price";
import { sortableId, type Payment } from "../src/pilot-store";
import type { ActionProposalJSON } from "../src/task-object";
import { CLIENT_ID, CLIENT_SECRET, DRIVE_FILE, FakeGoogle } from "./google-fake";
import { bindings, linkedOwner, setupShop, shopConsents, type Owner, type Shop } from "./people-fixtures";

// Fixtures for Google Sheets for Ton's books (google-connect.test.ts, google-books.test.ts). The owner's OAuth client is
// not in wrangler.test.json, as it is in no environment: `googleEnv` is the Worker's bindings with a test client's id and
// secret, and anything sent with plain `bindings` sees Google off. Google is the fake in google-fake.ts.

export const googleEnv = { ...bindings, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } as Env;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const enc = encodeURIComponent;

/// The fake Google of the test running now, and what the Worker printed to the console during it.
export const world = { google: new FakeGoogle(), logged: [] as string[] };

/// A new fake Google on the global fetch, and the console caught, for one test. The caller restores the mocks.
export function installGoogle(): void {
  world.google = new FakeGoogle();
  world.logged = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(world.google.fetch);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      world.logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
}

function randomIp(): string {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  return `2001:db8:${groups.join(":")}`;
}

export type Sent = { method?: string; headers?: Record<string, string>; body?: unknown; target?: Env };

/// A request to the Worker as a signed-in app or the owner's browser sends it, with its own source address, run to the
/// end of its waitUntil work.
export async function send(path: string, init: Sent = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  headers.set("cf-connecting-ip", randomIp());
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: init.method ?? "GET",
    headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), init.target ?? googleEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

export async function sendJson<T = Record<string, unknown>>(path: string, init: Sent = {}):
  Promise<{ status: number; body: T }> {
  const response = await send(path, init);
  return { status: response.status, body: (await response.json()) as T };
}

/// An operator's request through the admin gate, as the console sends it.
export async function operator(method: string, path: string, body?: unknown, target: Env = bindings): Promise<Response> {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => ({ email: "ops@manut.test" }) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method,
    headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), target, context);
  await waitOnExecutionContext(context);
  return response;
}

/// The month before the one it is now in Bangkok, `YYYY-MM`.
export function lastMonth(): string {
  const [year, month] = bangkokMonth(Date.now()).split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function vault(shop: Shop) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${shop.tenant}`));
}

/// One of the vault's Google operations, called as the Worker calls it (with its own `x-google` header unless a test
/// leaves it out), and what the vault answered.
export async function vaultPost(shop: Shop, path: string, body: unknown, headers: Record<string, string> = { "x-google": "1" }):
  Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await vault(shop).fetch(new Request(`https://cred${path}`, { method: "POST",
    headers: { "x-tenant": shop.tenant, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/// Everything the shop's vault holds, as stored.
export async function vaultRecords(shop: Shop): Promise<Record<string, Record<string, unknown>>> {
  return runInDurableObject(vault(shop), async (_instance, state) =>
    Object.fromEntries((await state.storage.list<Record<string, unknown>>()).entries()));
}

type Started = { url: string; expiresAt: string };

export async function startConnect(owner: Owner): Promise<URL> {
  const started = await sendJson<Started>("/v1/google/connect", { method: "POST", headers: owner.headers, body: {} });
  expect(started.status).toBe(200);
  return new URL(started.body.url);
}

export function callbackPath(answer: { state: string; code?: string; error?: string }): string {
  const query = new URLSearchParams({ state: answer.state, ...(answer.code ? { code: answer.code, scope: DRIVE_FILE } : {}),
    ...(answer.error ? { error: answer.error } : {}) });
  return `/v1/google/callback?${query.toString()}`;
}

export type AppendedMonth = { month: string; at: string; rows: number; outcome: "confirmed" | "unknown" };

export type Status = { connected: boolean; connection: null | { id: string; connectedAt: string; state: string;
  broken?: { at: string; reason: string; words: string }; sheet: null | { id: string; title: string; tab: string;
  url: string | null; appended: AppendedMonth[] } } };

export async function status(owner: Owner): Promise<Status> {
  const read = await sendJson<Status>("/v1/google", { headers: owner.headers });
  expect(read.status).toBe(200);
  return read.body;
}

/// The owner connects Google: the app asks for a sign-in, the owner says yes on Google's page, and Google sends the
/// browser back. Answers the connection's id.
export async function connect(owner: Owner): Promise<string> {
  const url = await startConnect(owner);
  const back = await send(callbackPath(world.google.consent(url.href)));
  expect(back.status).toBe(200);
  expect(await back.text()).toContain("Google is connected");
  const now = await status(owner);
  expect(now.connected).toBe(true);
  return now.connection!.id;
}

export type AuditRow = { actor: Record<string, unknown>; action: string; subject: Record<string, string>; outcome: string;
  reason?: string };

/// The shop's audit log, newest first, as the console reads it.
export async function auditOf(shop: Shop): Promise<AuditRow[]> {
  const response = await operator("GET", `/v1/admin/audit?tenant=${enc(shop.tenant)}&limit=200`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { entries: AuditRow[] }).entries;
}

/// No token the fake Google handed out is in `text`.
export function holdsNoToken(text: string): void {
  for (const token of world.google.tokens()) expect(text).not.toContain(token);
}

// ---------------------------------------------------------------------------
// Ton's books: a shop with Google connected, its payments, asking for a month and deciding the request
// ---------------------------------------------------------------------------

const BANGKOK_MS = 7 * 60 * 60 * 1000;

/// Order payments confirmed on the 10th of `month`, an hour apart, kept in the shop's object as the operator's route keeps
/// them, so the month is over by the time Ton reads it.
export async function paidIn(shop: Shop, month: string, payments: { orderRef: string; amountSatang: number }[]):
  Promise<void> {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const start = Date.UTC(year, number - 1, 10, 12) - BANGKOK_MS;
  const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${shop.tenant}`));
  await runInDurableObject(object, async (_instance, state) => {
    for (const [index, payment] of payments.entries()) {
      const at = start + index * 3600_000;
      const id = sortableId("pay", at, index);
      const record: Payment = { id, tenant: shop.tenant, orderRef: payment.orderRef, amountSatang: payment.amountSatang,
        promptPayId: "0812345678", confirmedAt: new Date(at).toISOString() };
      await state.storage.put(`pilot-pay:${enc(shop.tenant)}:${id}`, record);
    }
  });
}

/// The shop's Google connections were made four days ago, so their three days of practice are over.
export async function pastPractice(shop: Shop): Promise<void> {
  await runInDurableObject(vault(shop), async (_instance, state) => {
    for (const [key, record] of await state.storage.list<Record<string, unknown>>({ prefix: "conn:" })) {
      if (record.provider !== "gsheets") continue;
      await state.storage.put(key, { ...record, createdAt: new Date(Date.now() - 4 * DAY_MS).toISOString() });
    }
  });
}

/// A pilot shop with consent to cloud work, its owner signed in with an owner session, and Google connected and past
/// practice.
export async function readyShop(name = "Baan Mali"): Promise<{ shop: Shop; owner: Owner; connectionId: string }> {
  const shop = await setupShop(name);
  await shopConsents(shop.tenant);
  const owner = await linkedOwner(shop);
  const connectionId = await connect(owner);
  await pastPractice(shop);
  return { shop, owner, connectionId };
}

export type Asked = { taskId: string; member: string; outcome: string; requestId?: string; kind?: string; reason?: string;
  draft?: { text: string; job: string; about?: Record<string, string>; send?: { answer: string; kind: string } };
  error?: string };

/// The owner asks Ton for a month of the books, from their own session.
export async function askBooks(owner: Owner, month: string, target?: Env) {
  return sendJson<Asked>("/v1/google/books", { method: "POST", headers: owner.headers, body: { month },
    ...(target ? { target } : {}) });
}

export type Listed = { approvals: { taskId: string; record: { status: string; request: { id: string; kind: string;
  revision: number; detail: Record<string, unknown> } } }[] };

export async function openApprovals(headers: { authorization?: string }): Promise<Listed["approvals"]> {
  const listed = await sendJson<Listed>("/v1/approvals?state=open", { headers });
  expect(listed.status).toBe(200);
  return listed.body.approvals;
}

export async function decide(headers: { authorization?: string }, requestId: string, optionId = "approve") {
  return sendJson<{ result?: { ok: boolean; refused?: string }; action?: string; error?: string }>(
    `/v1/approvals/${enc(requestId)}/decision`, { method: "POST", headers, body: { optionId, seenRevision: 1 } });
}

/// What the task object holds for an action.
export async function actionOf(shop: Shop, taskId: string, actionId: string): Promise<ActionProposalJSON> {
  const response = await bindings.TASK.get(bindings.TASK.idFromName(taskId)).fetch(new Request(
    `https://task/actions/${actionId}`, { headers: { "x-tenant": shop.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as ActionProposalJSON;
}
