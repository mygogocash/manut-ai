import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { bangkokMonth } from "../src/model-price";
import { CLIENT_ID, CLIENT_SECRET, DRIVE_FILE, FakeGoogle } from "./google-fake";
import { bindings, type Owner, type Shop } from "./people-fixtures";

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

export type Status = { connected: boolean; connection: null | { id: string; connectedAt: string; state: string;
  broken?: { at: string; reason: string; words: string }; sheet: null | { id: string; title: string; tab: string;
  url: string | null } } };

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
