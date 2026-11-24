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
/// The scope is the shop's own, as for the tenant export: the tasks in the shop's index, each read with only the shop's
/// tenant, so the task object's tenancy rules apply as they do to every task read. A task of another tenant planted in
/// the index answers 404 and is skipped, and an action of another tenant inside the shop's own task is never listed or
/// decided (`/requests` in task-object.ts). Fellow members' company tasks open only to a verified company assertion,
/// which these routes never make, so they are not reached here.
///
/// Which of those tasks to read comes from the shop's approval lookup (approval-index.ts): the tasks that may hold an
/// open request, the tasks of the newest settled ones, or the one task that holds a request being decided. The lookup
/// only says where to look, and names only tasks in the shop's index; every answer is approval-core's record as the task
/// holds it. So the cost of a read grows with what is open or asked for, not with every task the shop ever had. Until
/// the lookup holds every request the shop had before it existed, its backfill is not done and the routes walk the
/// index as they always did, running one step of the backfill beside the walk.
///
/// Each record carries the kind its request was opened with, which the task object sets from the operation it decides
/// (`REQUEST_KINDS` in task-object.ts): a LINE reply is `reply`, a worker's `linear.issue.create` is `command`. A plain
/// proposal that no request decides, such as a session's own `linear.issue.create`, is not an approval-core approval
/// and is not listed.

import { decodeRecord, encodeRecord, encodeStanding, type ApprovalRecord, type Standing } from "@manut/approval-core";
import {
  openEntries,
  reportLearned,
  runBackfillStep,
  settledEntries,
  whereIs,
  type Learned,
  type Located,
} from "./approval-index";
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
import { MAX_NAMED_REQUESTS } from "./task-object";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

/// How many recent approvals one answer holds when the query does not say, and the most it may ask for.
const DEFAULT_RECENT = 50;
const MAX_RECENT = 200;
const MAX_BODY_BYTES = 16 * 1024;
/// The longest request id a route looks up: every request shares its action's id, a UUID.
const MAX_REQUEST_ID = 128;

type Listed = { record: ApprovalRecord; standing: Standing };
type Found = { taskId: string } & Listed;
type ReadEnv = Pick<TenantDataEnv, "TASK" | "TENANT">;

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

/// One request as a task holds it for the shop, read with the shop as its tenant: null when the task does not hold it
/// for the shop (no such request, or the task is another shop's or was never made), undefined when the task cannot be
/// read.
async function readOne(env: Pick<TenantDataEnv, "TASK">, shop: string, taskId: string, requestId: string):
  Promise<ApprovalRecord | null | undefined> {
  const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(
    `https://task/requests/${encodeURIComponent(requestId)}`, { headers: { "x-tenant": shop } })).catch(() => null);
  if (response?.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response?.ok) {
    await response?.body?.cancel();
    return undefined;
  }
  return ((await response.json()) as { record: ApprovalRecord }).record;
}

/// The task that holds the request, with its record: the one the shop's approval lookup names, read with the shop as
/// its tenant, so a task of another shop, even one an entry names, answers 404 and a request of another shop is never
/// found. Once the lookup is ready, a request it does not lead to is not the shop's (404). Until then, the shop's index
/// is walked as before, beside a step of the lookup's backfill. A lookup or a task that cannot be read is 503, never
/// taken for a missing request.
async function findRequest(env: ReadEnv, shop: string, requestId: string):
  Promise<{ taskId: string; record: ApprovalRecord } | Response> {
  const where = await whereIs(env, shop, requestId);
  if (!where) return json({ error: "approvals_unavailable" }, 503);
  if (where.taskId !== null) {
    const record = await readOne(env, shop, where.taskId, requestId);
    if (record === undefined) return json({ error: "approvals_unavailable" }, 503);
    if (record !== null) return { taskId: where.taskId, record };
  }
  if (where.ready) return json({ error: "not_found" }, 404);
  const [found] = await Promise.all([walkFind(env, shop, requestId), runBackfillStep(env, shop)]);
  return found;
}

/// `findRequest` by walking every task in the shop's index, while the lookup's backfill runs.
async function walkFind(env: ReadEnv, shop: string, requestId: string):
  Promise<{ taskId: string; record: ApprovalRecord } | Response> {
  const index = await tenantCall(env, shop, `/index?tenant=${encodeURIComponent(shop)}`).catch(() => null);
  if (!index?.ok) return json({ error: "approvals_unavailable" }, 503);
  const { taskIds } = (await index.json()) as { taskIds?: string[] };
  for (const taskId of taskIds ?? []) {
    const record = await readOne(env, shop, taskId, requestId);
    if (record === null) continue;
    if (record === undefined) return json({ error: "approvals_unavailable" }, 503);
    return { taskId, record };
  }
  return json({ error: "not_found" }, 404);
}

/// Every request each task in the shop's index holds for the shop, task by task as the index keeps them, or undefined
/// when the index or a task cannot be read. The create route indexes a task before creating it, so the index may name
/// one that never came to exist; a task of another tenant answers the same, and both are passed over.
async function walkAll(env: ReadEnv, tenant: string): Promise<Found[] | undefined> {
  const index = await tenantCall(env, tenant, `/index?tenant=${encodeURIComponent(tenant)}`).catch(() => null);
  if (!index?.ok) return undefined;
  const { taskIds } = (await index.json()) as { taskIds?: string[] };
  const found: Found[] = [];
  for (const taskId of taskIds ?? []) {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/requests",
      { headers: { "x-tenant": tenant } })).catch(() => null);
    if (response?.status === 404) continue;
    if (!response?.ok) return undefined;
    const { requests } = (await response.json()) as { requests: Listed[] };
    for (const entry of requests) found.push({ taskId, ...entry });
  }
  return found;
}

/// The walk, while the lookup's backfill is not done, with one step of the backfill beside it.
async function walkWhileBackfilling(env: ReadEnv, tenant: string): Promise<Found[] | undefined> {
  const [found] = await Promise.all([walkAll(env, tenant), runBackfillStep(env, tenant)]);
  return found;
}

/// The requests the lookup names, each read from the task its entry names, at most `MAX_NAMED_REQUESTS` to a call and
/// only those, with the shop as the tenant: what the tasks hold, and every name a task did not answer (its entry is
/// stale, or the task is not the shop's). Undefined when any task cannot be read, since an approval left out would read
/// as nobody having asked.
async function readNamed(env: Pick<TenantDataEnv, "TASK">, tenant: string, named: readonly Located[]):
  Promise<{ found: Found[]; missing: Located[] } | undefined> {
  const byTask = new Map<string, Set<string>>();
  for (const { requestId, taskId } of named) byTask.set(taskId, (byTask.get(taskId) ?? new Set()).add(requestId));
  const calls: { taskId: string; ids: string[] }[] = [];
  for (const [taskId, ids] of byTask) {
    const all = [...ids];
    for (let i = 0; i < all.length; i += MAX_NAMED_REQUESTS) calls.push({ taskId, ids: all.slice(i, i + MAX_NAMED_REQUESTS) });
  }
  const answers = await Promise.all(calls.map(async ({ taskId, ids }) => {
    try {
      const query = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(
        `https://task/requests?${query}`, { headers: { "x-tenant": tenant } }));
      if (response.status === 404) {
        await response.body?.cancel();
        return { taskId, ids, requests: [] as Listed[] };
      }
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      return { taskId, ids, requests: ((await response.json()) as { requests: Listed[] }).requests };
    } catch {
      return undefined;
    }
  }));
  const found: Found[] = [];
  const missing: Located[] = [];
  for (const answer of answers) {
    if (answer === undefined) return undefined;
    const asked = new Set(answer.ids);
    const held = new Set<string>();
    for (const listed of answer.requests) {
      // Only what was asked for counts as found.
      if (!asked.has(listed.record.request.id)) continue;
      held.add(listed.record.request.id);
      found.push({ taskId: answer.taskId, ...listed });
    }
    for (const requestId of answer.ids) if (!held.has(requestId)) missing.push({ requestId, taskId: answer.taskId });
  }
  return { found, missing };
}

/// What reading named requests tells the lookup: each one found settled, with when it was asked, so it leaves the open
/// set for the settled list, and each one its task did not hold. One found open is already where the lookup has it.
function learnedFrom(read: { found: Found[]; missing: Located[] }): Learned {
  return {
    found: read.found.filter((item) => item.standing.state !== "open").map((item) => ({
      requestId: item.record.request.id, taskId: item.taskId, askedAt: item.record.request.createdAt, open: false })),
    missing: read.missing,
  };
}

/// `state=open`'s candidates. With the lookup ready: only the tasks its open entries name, and only those requests.
/// Expiry and superseding change a request's standing with nothing written anywhere, so it is this read that tells:
/// what it finds no longer open, or not there, it reports back, and the entry leaves the open set.
async function openCandidates(env: ReadEnv, tenant: string): Promise<Found[] | undefined> {
  const lookup = await openEntries(env, tenant);
  if (!lookup) return undefined;
  if (!lookup.ready) return walkWhileBackfilling(env, tenant);
  const read = await readNamed(env, tenant, lookup.open);
  if (!read) return undefined;
  await reportLearned(env, tenant, learnedFrom(read));
  return read.found;
}

/// `state=recent`'s candidates. With the lookup ready: every entry that may still be open, since any of them may have
/// been decided, expired or superseded since a read last looked, and the newest `limit` settled entries. Settled ones
/// are read in the lookup's order, newest asked first, and more are read only while some turn out gone from their tasks
/// (the retention sweep removes old ones): once `limit` of them are found, every settled request after them was asked
/// earlier than all of these, so none of them can be among the newest `limit`. So the read stays bounded by `limit` and
/// what is open, whatever the shop has kept.
async function recentCandidates(env: ReadEnv, tenant: string, limit: number): Promise<Found[] | undefined> {
  const lookup = await openEntries(env, tenant);
  if (!lookup) return undefined;
  if (!lookup.ready) return walkWhileBackfilling(env, tenant);
  const read = await readNamed(env, tenant, lookup.open);
  if (!read) return undefined;
  const found = [...read.found];
  // Settled entries found settled are what the lookup already has; only what the open entries showed, and every entry
  // whose task did not hold it, is news to report.
  const learned = learnedFrom(read);
  let settled = 0;
  let after: string | null = null;
  for (;;) {
    const page = await settledEntries(env, tenant, limit - settled, after);
    if (!page) return undefined;
    const pageRead = await readNamed(env, tenant, page.settled);
    if (!pageRead) return undefined;
    found.push(...pageRead.found);
    learned.missing.push(...pageRead.missing);
    settled += pageRead.found.filter((item) => item.standing.state !== "open").length;
    if (settled >= limit || page.next === null) break;
    after = page.next;
  }
  await reportLearned(env, tenant, learned);
  // An entry a report moved from open to settled between the two listings is read twice; it is listed once.
  const seen = new Set<string>();
  return found.filter((item) => !seen.has(item.record.request.id) && !!seen.add(item.record.request.id));
}

/// `state=open` answers every approval still waiting for a decision: its standing is `open`. `state=recent` answers
/// the newest `limit` of those that left it: decided, expired, or superseded. Both list the newest asked first. The
/// lookup, an index or a task that cannot be read fails the whole answer rather than leaving its approvals out: an
/// approval missing from the list would read as nobody having asked.
///
/// A helper is listed every approval too, so they can pass on what they may not decide, but an append of Ton's books
/// (books-detail.ts) shows them only that it waits, for which month and which sheet: a month's books are sales, which
/// helpers do not see (the design canvas's People board). Its rows and totals stay the owner's.
export async function listApprovals(env: ReadEnv, tenant: string, url: URL,
  role: Caller["role"] = "owner"): Promise<Response> {
  const state = url.searchParams.get("state");
  if (state !== "open" && state !== "recent") return json({ error: "invalid_state" }, 400);
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? DEFAULT_RECENT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECENT) return json({ error: "invalid_limit" }, 400);

  const found = state === "open" ? await openCandidates(env, tenant) : await recentCandidates(env, tenant, limit);
  if (!found) return json({ error: "approvals_unavailable" }, 503);

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
