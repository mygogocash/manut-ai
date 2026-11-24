/// Approvals for a session (docs/pilot-api.md, "Approvals for a session" and "Deciding from a session"):
///
/// - `GET /v1/approvals` answers the shop's approval-core records and where each stands now, as approval-core's wire
///   JSON (packages/approval-core/src/wire.ts), so the desktop can read them with approval-core's own decoders, each with
///   the note a helper passed on with it, if any.
/// - `POST /v1/approvals/{requestId}/decision` with `{ optionId, seenRevision }` decides one of them.
/// - `POST /v1/approvals/{requestId}/pass-on` with `{ note }` is a helper handing one to the owner (people.ts).
///
/// Who is calling comes from the credential alone (`callerOf` in people.ts): the shop's own session is its owner, a
/// helper session is a helper of the one shop it names, and an owner session is the owner of the one shop it names
/// (docs/several-shops.md). Every route here works on that shop's requests and no other, and a shop or a role named in
/// the listing's query is refused rather than read.
///
/// The scope is the shop's own, as for the tenant export: every task in the shop's index, each read with only the
/// shop's tenant, so the task object's tenancy rules apply as they do to every task read. A task of another tenant
/// planted in the index answers 404 and is skipped, and an action of another tenant inside the shop's own task is never
/// listed or decided (`/requests` in task-object.ts). Fellow members' company tasks open only to a verified company
/// assertion, which these routes never make, so they are not reached here.
///
/// Each record carries the kind its request was opened with, which the task object sets from the operation it decides
/// (`REQUEST_KINDS` in task-object.ts): a LINE reply is `reply`, a worker's `linear.issue.create` is `command`. A plain
/// proposal that no request decides, such as a session's own `linear.issue.create`, is not an approval-core approval
/// and is not listed.

import { decodeRecord, encodeRecord, encodeStanding, type ApprovalRecord, type Standing } from "@manut/approval-core";
import { readJsonBody } from "./body";
import { helperBooksDetail, isBooksDetail } from "./books-detail";
import { decideRequest, type JobFlags, type JobFlowEnv } from "./job-flow";
import {
  callerOf,
  hasExactly,
  OWNER_SESSION,
  passOnToOwner,
  queryNamesSession,
  readPeople,
  type Caller,
  type PeopleEnv,
} from "./people";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

/// How many recent approvals one answer holds when the query does not say, and the most it may ask for.
const DEFAULT_RECENT = 50;
const MAX_RECENT = 200;
const MAX_BODY_BYTES = 16 * 1024;
/// The longest request id a route looks up: every request shares its action's id, a UUID.
const MAX_REQUEST_ID = 128;

type Found = { taskId: string; record: ApprovalRecord; standing: Standing };

export type ApprovalsEnv = PeopleEnv & JobFlowEnv;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// `/v1/approvals` and `/v1/approvals/{requestId}/(decision|pass-on)`. Answers null for any other path. Who is calling is
/// checked before the method, as for every session route: a caller with no session learns nothing about the route.
export async function approvalsRoute(request: Request, url: URL, env: ApprovalsEnv, flags: JobFlags):
  Promise<Response | null> {
  const item = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/(decision|pass-on)$/);
  if (url.pathname !== "/v1/approvals" && !item) return null;
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (!item) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    // The session names the shop and the role. A query naming either is refused, so it never even looks as if it were
    // read.
    if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
    return listApprovals(env, caller.shop, url, caller.role);
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let requestId: string;
  try {
    requestId = decodeURIComponent(item[1] ?? "");
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!requestId || requestId.length > MAX_REQUEST_ID) return json({ error: "invalid_request" }, 400);
  return item[2] === "decision" ? decideFromSession(request, env, flags, caller, requestId)
    : passOn(request, env, caller, requestId);
}

/// How each of approval-core's refusals is answered. The body always carries approval-core's whole result, so the first
/// decision, the current revision, the expiry or why the request was superseded comes with it.
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  already_decided: 409,
  not_permitted: 403,
  superseded: 409,
  expired: 410,
  changed: 409,
  not_offered: 400,
};

/// `POST /v1/approvals/{requestId}/decision` with exactly `{ optionId, seenRevision }`. The role and who decided come
/// from the caller: `owner` as `owner-session` for the shop's own session, `helper` as their id for a helper session.
/// A body with any other field, a role above all, is refused. Then it is the job flow's `decideRequest`, as for a
/// worker's request: the switches and consent before anything is recorded (`officeCloud`; for an approval
/// `officeExternalWrites` and the shop's consent), approval-core's settle once in the task object, the audit entry, and on
/// approval the broker's one-use begin gate, the same gate the owner's link sends a reply through.
async function decideFromSession(request: Request, env: ApprovalsEnv, flags: JobFlags, caller: Caller,
  requestId: string): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, ["optionId", "seenRevision"]) || typeof body.optionId !== "string" ||
      body.optionId.length === 0 || body.optionId.length > 64 || typeof body.seenRevision !== "number" ||
      !Number.isSafeInteger(body.seenRevision) || body.seenRevision < 1) {
    return json({ error: "invalid_request" }, 400);
  }
  const found = await findRequest(env, caller.shop, requestId);
  if (found instanceof Response) return found;
  const decided = await decideRequest(env, {
    tenant: caller.shop,
    taskId: found.taskId,
    requestId,
    optionId: body.optionId,
    seenRevision: body.seenRevision,
    decidedBy: caller.role === "owner" ? (caller.accountId ?? OWNER_SESSION) : caller.helperId,
    role: caller.role,
  }, { flags });
  if (!decided.ok) return json({ error: decided.error, ...(decided.feature ? { feature: decided.feature } : {}) }, decided.status);
  if (decided.result.ok) return json({ result: decided.result, action: decided.action });
  return json({ error: decided.result.refused, result: decided.result, action: decided.action },
    REFUSAL_STATUS[decided.result.refused] ?? 409);
}

/// `POST /v1/approvals/{requestId}/pass-on` with exactly `{ note }`: a helper hands the owner a request they may not
/// decide. It decides nothing (people.ts, `passOnToOwner`). Only a helper passes a request on.
async function passOn(request: Request, env: ApprovalsEnv, caller: Caller, requestId: string): Promise<Response> {
  if (caller.role !== "helper") return json({ error: "not_a_helper" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, ["note"]) || typeof body.note !== "string") {
    return json({ error: "invalid_request" }, 400);
  }
  const found = await findRequest(env, caller.shop, requestId);
  if (found instanceof Response) return found;
  const { record } = found;
  return passOnToOwner(env, caller, { id: requestId, kind: record.request.kind,
    decided: record.status === "decided" ? { by: record.decision.decidedBy, at: record.decision.decidedAt } : null },
  found.taskId, body.note);
}

/// The task in the shop's index that holds the request, with its record. Each task is read with the shop as its tenant,
/// so a task of another shop, even one planted in this shop's index, answers 404 and is passed over, and a request of
/// another shop is never found. An index or a task that cannot be read is 503, never taken for a missing request.
async function findRequest(env: Pick<TenantDataEnv, "TASK" | "TENANT">, shop: string, requestId: string):
  Promise<{ taskId: string; record: ApprovalRecord } | Response> {
  const index = await tenantCall(env, shop, `/index?tenant=${encodeURIComponent(shop)}`).catch(() => null);
  if (!index?.ok) return json({ error: "approvals_unavailable" }, 503);
  const { taskIds } = (await index.json()) as { taskIds?: string[] };
  for (const taskId of taskIds ?? []) {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(
      `https://task/requests/${encodeURIComponent(requestId)}`, { headers: { "x-tenant": shop } })).catch(() => null);
    if (response?.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response?.ok) return json({ error: "approvals_unavailable" }, 503);
    const { record } = (await response.json()) as { record: ApprovalRecord };
    return { taskId, record };
  }
  return json({ error: "not_found" }, 404);
}

/// `state=open` answers every approval still waiting for a decision: its standing is `open`. `state=recent` answers
/// the newest `limit` of those that left it: decided, expired, or superseded. Both list the newest asked first. An
/// index or a task that cannot be read fails the whole answer rather than leaving its approvals out: an approval
/// missing from the list would read as nobody having asked.
///
/// A helper is listed every approval too, so they can pass on what they may not decide, but an append of Ton's books
/// (books-detail.ts) shows them only that it waits, for which month and which sheet: a month's books are sales, which
/// helpers do not see (the design canvas's People board). Its rows and totals stay the owner's.
export async function listApprovals(env: Pick<TenantDataEnv, "TASK" | "TENANT">, tenant: string, url: URL,
  role: Caller["role"] = "owner"): Promise<Response> {
  const state = url.searchParams.get("state");
  if (state !== "open" && state !== "recent") return json({ error: "invalid_state" }, 400);
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? DEFAULT_RECENT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT) return json({ error: "invalid_limit" }, 400);

  const index = await tenantCall(env, tenant, `/index?tenant=${encodeURIComponent(tenant)}`).catch(() => null);
  if (!index?.ok) return json({ error: "approvals_unavailable" }, 503);
  const { taskIds } = (await index.json()) as { taskIds?: string[] };
  const found: Found[] = [];
  for (const taskId of taskIds ?? []) {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/requests",
      { headers: { "x-tenant": tenant } })).catch(() => null);
    // The create route indexes a task before creating it, so the index may name one that never came to exist; a task
    // of another tenant answers the same.
    if (response?.status === 404) continue;
    if (!response?.ok) return json({ error: "approvals_unavailable" }, 503);
    const { requests } = (await response.json()) as { requests: { record: ApprovalRecord; standing: Standing }[] };
    for (const entry of requests) found.push({ taskId, ...entry });
  }

  const chosen = found
    .filter((entry) => (entry.standing.state === "open") === (state === "open"))
    .sort((a, b) => b.record.request.createdAt - a.record.request.createdAt ||
      (a.record.request.id < b.record.request.id ? -1 : a.record.request.id > b.record.request.id ? 1 : 0));
  const listed = state === "recent" ? chosen.slice(0, limit) : chosen;
  // A note a helper passed on is shown with its request (people.ts). People that cannot be read fail the answer, as a
  // task does: a request listed without its note would read as nobody having looked at it.
  const people = await readPeople(env, tenant);
  if (!people) return json({ error: "approvals_unavailable" }, 503);
  const notes = new Map(people.state.passedOn.map((passed) => [passed.requestId, { by: passed.by,
    name: people.names[passed.by] ?? "", note: passed.note, at: new Date(passed.at).toISOString() }]));
  return json({
    state,
    approvals: listed.map((entry) => {
      const note = notes.get(entry.record.request.id);
      const detail = entry.record.request.detail;
      const shown: ApprovalRecord = role === "helper" && isBooksDetail(detail)
        ? { ...entry.record, request: { ...entry.record.request, detail: helperBooksDetail(detail) } }
        : entry.record;
      return {
        taskId: entry.taskId,
        record: encodeRecord(decodeRecord(shown)),
        standing: encodeStanding(entry.standing),
        ...(note ? { passedOn: note } : {}),
      };
    }),
  });
}
