/// What Buddy's team knows about a shop, from the Worker's side: the routes that read it and that act on the owner's
/// say over each fact, and `proposeFact`, the one way a worker adds to it. The rules are `@manut/shop-memory`'s; the
/// shop's state, its one transaction per change and its audit entry are memory-store.ts's, in the shop's TenantObject.
///
/// The owner's say is "It's true" on a waiting fact, Correct, Forget, and "Tell Buddy something to remember"
/// (docs/pilot-api.md, "Memory"). The owner says it from their own shop session once the operator has linked their
/// account (docs/several-shops.md, slice 4), and until then the operator relays it through the console. Both make each
/// change through the same operation of the shop's object. A worker never does these. It proposes what it learned, and
/// what a customer said waits for the owner. So `proposeFact` is a function the job flow calls, and no route leads to it.

import { emptyState, usable, type Fact, type FactSource, type Refusal } from "@manut/shop-memory";
import type { AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { callerOf, hasExactly, ownerActor, queryNamesSession, type PeopleEnv } from "./people";
import { operatorIdentity } from "./pilot";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

type MemoryEnv = Pick<TenantDataEnv, "TENANT">;

const MAX_BODY_BYTES = 16 * 1024;

/// The owner's changes to what the team knows, by the last part of their path (`/v1/admin/memory/<path>` for the
/// operator, `/v1/memory/<path>` for the owner's session): the object path each one is, and the exact body the owner's
/// session sends for it (the operator's also names the shop's `tenant`). A proposal is not among them.
type Change = { path: string; keys: readonly string[] };

const CHANGES: Readonly<Record<string, Change>> = {
  remember: { path: "/memory/remember", keys: ["text"] },
  confirm: { path: "/memory/confirm", keys: ["id"] },
  correct: { path: "/memory/correct", keys: ["id", "text"] },
  forget: { path: "/memory/forget", keys: ["id"] },
};

/// The change at `path`, or null. Only a path the table names as its own: never a name every object inherits.
function changeAt(path: string): Change | null {
  return Object.hasOwn(CHANGES, path) ? CHANGES[path] ?? null : null;
}

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
/// exact method; and `/v1/memory` and the owner's changes under it, from a shop session. Answers null for any other path,
/// so no route leads to a worker's proposal.
export async function memoryRoute(
  request: Request,
  url: URL,
  env: PeopleEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (url.pathname === "/v1/memory") return sessionRoute(request, url, env, null);
  if (url.pathname.startsWith("/v1/memory/")) {
    const change = changeAt(url.pathname.slice("/v1/memory/".length));
    return change ? sessionRoute(request, url, env, change) : null;
  }
  if (url.pathname !== "/v1/admin/memory" && !url.pathname.startsWith("/v1/admin/memory/")) return null;
  if (request.method === "GET" && url.pathname === "/v1/admin/memory") {
    const tenant = url.searchParams.get("tenant") ?? "";
    return isValidTenant(tenant) ? readMemory(env, tenant) : json({ error: "tenant_required" }, 400);
  }
  const change = request.method === "POST" && url.pathname.startsWith("/v1/admin/memory/")
    ? changeAt(url.pathname.slice("/v1/admin/memory/".length)) : null;
  return change ? operatorChange(request, env, ctx, change) : json({ error: "not_found" }, 404);
}

/// Every fact the team holds for the shop, waiting ones included, oldest first, and how many texts it was told to
/// forget. Never the fingerprints of those: the count is all the owner or an operator needs.
async function readMemory(env: MemoryEnv, tenant: string): Promise<Response> {
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

/// `POST /v1/admin/memory/{remember,confirm,correct,forget}` with `{ tenant, ... }`: the operator relays the owner's
/// change, recorded in the shop's audit log under the operator's Access identity (none for a service token).
async function operatorChange(request: Request, env: MemoryEnv, ctx: ExecutionContext, change: Change): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  return writeMemory(env, body.tenant, change, body, { kind: "operator", email: await operatorIdentity(ctx) });
}

/// `GET /v1/memory` and `POST /v1/memory/{remember,confirm,correct,forget}` (`change` null for the read): the owner's say
/// over what the team knows, from their own shop session (docs/several-shops.md, slice 4), or the shop's own session.
/// The shop and the role come from the session alone (`callerOf`), so the body names neither, and the log names the
/// owner's linked account by its id (`ownerActor`). A helper's session is told the route is the owner's rather than that
/// it ended, as on the team's routines: what the team knows can hold the owner's costs and suppliers, and a helper's
/// work is the conversations.
///
/// The order is who is asking (401 or 503), then the role (403), the method (405), and the query and the body (400).
async function sessionRoute(request: Request, url: URL, env: PeopleEnv, change: Change | null): Promise<Response> {
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  if (request.method !== (change ? "POST" : "GET")) return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  if (!change) return readMemory(env, caller.shop);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, change.keys)) return json({ error: "invalid_request" }, 400);
  return writeMemory(env, caller.shop, change, body, ownerActor(caller));
}

/// One change in the shop's object, recorded in its audit log under `actor`. Answers what the object answers: the fact
/// on success (Forget answers its id), or the package's refusal with its status.
async function writeMemory(env: MemoryEnv, tenant: string, change: Change, body: Record<string, unknown>,
  actor: AuditActor): Promise<Response> {
  try {
    const response = await memoryWrite(env, tenant, change.path, { text: body.text, id: body.id, nowMs: Date.now(), actor });
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

/// What a worker may read of a shop's memory: the facts the owner's own data says or the owner confirmed, oldest first,
/// as `@manut/shop-memory`'s `usable` decides. A fact a customer told the team waits for the owner's "It's true", and
/// until then this never hands it out, so it can never reach a model. Like `proposeFact`, a function the job flow's
/// workers call (workers.ts), with no route to it.
///
/// It never throws. A stored fact that is not whole is left out rather than passed on, and a shop's object that cannot
/// be reached or answers anything but its facts is `memory_unavailable`: a worker must hear that, not run as if the team
/// knew nothing.
export async function usableFacts(
  env: MemoryEnv,
  tenant: string,
): Promise<{ ok: true; facts: Fact[] } | { ok: false; error: "invalid_request" | "memory_unavailable" }> {
  if (!isValidTenant(tenant)) return { ok: false, error: "invalid_request" };
  try {
    const response = await tenantCall(env, tenant, `/memory?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, error: "memory_unavailable" };
    }
    const answer: unknown = await response.json();
    if (!isRecord(answer) || !Array.isArray(answer.facts)) return { ok: false, error: "memory_unavailable" };
    // The package's rule, applied to the whole facts the object holds: the state around them is only what `usable` reads.
    return { ok: true, facts: usable({ ...emptyState(), facts: answer.facts.filter(isFact) }) };
  } catch {
    return { ok: false, error: "memory_unavailable" };
  }
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
