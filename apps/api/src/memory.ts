/// What Buddy's team knows about a shop, from the Worker's side: the operator routes that read it and that act on the
/// owner's say over each fact, and `proposeFact`, the one way a worker adds to it. The rules are `@manut/shop-memory`'s;
/// the shop's state, its one transaction per change and its audit entry are memory-store.ts's, in the shop's
/// TenantObject.
///
/// In the pilot the owner has no account, so the operator relays the owner's word: "It's true" on a waiting fact,
/// Correct, Forget, and "Tell Buddy something to remember" (docs/pilot-api.md, "Memory"). A worker never does these. It
/// proposes what it learned, and what a customer said waits for the owner. So `proposeFact` is a function the job flow
/// calls, and no route leads to it.

import type { Fact, FactSource, Refusal } from "@manut/shop-memory";
import type { AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { operatorIdentity } from "./pilot";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

type MemoryEnv = Pick<TenantDataEnv, "TENANT">;

const MAX_BODY_BYTES = 16 * 1024;

/// The operator routes that change a shop's memory, and the object path each one is. A proposal is not among them.
const WRITES: Readonly<Record<string, string>> = {
  "POST /v1/admin/memory/remember": "/memory/remember",
  "POST /v1/admin/memory/confirm": "/memory/confirm",
  "POST /v1/admin/memory/correct": "/memory/correct",
  "POST /v1/admin/memory/forget": "/memory/forget",
};

/// What the shop's object answers to a write that was understood: a fact, or a refusal. Anything else is the object
/// failing, and is not passed on as if it were an answer.
const ANSWERED = new Set([200, 400, 404, 409]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function memoryWrite(env: MemoryEnv, tenant: string, path: string, body: Record<string, unknown>): Promise<Response> {
  return tenantCall(env, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-memory": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
}

/// `/v1/admin/memory` and `/v1/admin/memory/*`, after the admin gate, which already required both credentials and an
/// exact method. Answers null for any other path.
export async function memoryAdminRoute(
  request: Request,
  url: URL,
  env: MemoryEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname !== "/v1/admin/memory" && !url.pathname.startsWith("/v1/admin/memory/")) return null;
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/admin/memory") return readMemory(env, url);
  const path = WRITES[route];
  if (path) return writeMemory(request, env, ctx, path);
  return json({ error: "not_found" }, 404);
}

/// `GET /v1/admin/memory?tenant=`: every fact the team holds for the shop, waiting ones included, oldest first, and how
/// many texts it was told to forget. Never the fingerprints of those: the count is all the owner or an operator needs.
async function readMemory(env: MemoryEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  try {
    const response = await tenantCall(env, tenant, `/memory?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return json({ error: "memory_unavailable" }, 503);
    }
    const memory = (await response.json()) as { facts: Fact[]; forgottenCount: number };
    return json({ tenant, facts: memory.facts, forgottenCount: memory.forgottenCount });
  } catch {
    return json({ error: "memory_unavailable" }, 503);
  }
}

/// `POST /v1/admin/memory/{remember,confirm,correct,forget}` with `{ tenant, ... }`: the operator's change, recorded in
/// the shop's audit log under the operator's Access identity (none for a service token). Answers what the shop's object
/// answers: the fact on success, or the package's refusal with its status.
async function writeMemory(request: Request, env: MemoryEnv, ctx: ExecutionContext, path: string): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  const actor: AuditActor = { kind: "operator", email: await operatorIdentity(ctx) };
  try {
    const response = await memoryWrite(env, body.tenant, path, { text: body.text, id: body.id, nowMs: Date.now(), actor });
    if (!ANSWERED.has(response.status)) {
      await response.body?.cancel();
      return json({ error: "memory_unavailable" }, 503);
    }
    return json(await response.json(), response.status);
  } catch {
    return json({ error: "memory_unavailable" }, 503);
  }
}

/// Why a proposal did not become a fact: one of the package's refusals, a tenant that is not one, or the shop's
/// object not answering.
export type ProposeResult =
  | { ok: true; fact: Fact }
  | { ok: false; reason: Refusal | "invalid_request" | "unavailable" };

const REASONS: ReadonlySet<string> = new Set<Refusal | "invalid_request">([
  "invalid_text", "invalid_source", "already_known", "forgotten", "not_found", "full", "invalid_request",
]);

function isFact(value: unknown): value is Fact {
  return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
    (value.status === "confirmed" || value.status === "waiting") && typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" && isRecord(value.source);
}

/// A worker's proposal for the job flow to call: the team learned something about a shop. What comes from the owner's
/// own data becomes a fact at once, and what a customer said waits for the owner's "It's true" (the package's rule).
/// There is no route for it, so no operator can make a worker's proposal, and no worker can confirm one.
///
/// It never throws: the job it was called from is not the memory's to fail. The answer is the fact, or why it was
/// not kept: a refusal of the package's, `invalid_request` for a tenant that is not one or a proposal too large to send,
/// or `unavailable` when the shop's object cannot be reached or does not answer as it should. `actor` is who the log names: the worker's attempt
/// when the job flow gives it, Manut AI's system otherwise. `now` is the clock of the caller, for tests.
export async function proposeFact(
  env: MemoryEnv,
  tenant: string,
  text: string,
  source: FactSource,
  options: { actor?: AuditActor; now?: () => number } = {},
): Promise<ProposeResult> {
  if (!isValidTenant(tenant)) return { ok: false, reason: "invalid_request" };
  try {
    const response = await memoryWrite(env, tenant, "/memory/propose", {
      text,
      source,
      nowMs: (options.now ?? Date.now)(),
      ...(options.actor ? { actor: options.actor } : {}),
    });
    // A proposal too large for the shop's object to read is not a fact or a source of any shop: it cannot be sent, which
    // is not the object failing.
    if (response.status === 413) {
      await response.body?.cancel();
      return { ok: false, reason: "invalid_request" };
    }
    const answer: unknown = await response.json();
    if (response.status === 200 && isFact(answer)) return { ok: true, fact: answer };
    if (ANSWERED.has(response.status) && isRecord(answer) && typeof answer.error === "string" && REASONS.has(answer.error)) {
      return { ok: false, reason: answer.error as Refusal | "invalid_request" };
    }
  } catch {
    // Unavailable, below.
  }
  return { ok: false, reason: "unavailable" };
}
