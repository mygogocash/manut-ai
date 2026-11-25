/// The shop's approval lookup (docs/pilot-api.md, "How the shop's approvals are found"): which task holds each of the
/// shop's approval-core requests, which of them may still be open, and the settled ones newest asked first. It is kept in
/// the shop's TenantObject (`t:${tenant}`) beside its task index, and it only ever says where to look. Every answer is
/// read from the task that holds the request, with only the shop's tenant, and approval-core's record there is the one
/// truth (approvals.ts); an entry that disagrees with its task is corrected or dropped, never believed.
///
/// Why it exists. `GET /v1/approvals` and the decision routes walked every task in the shop's index, one after another,
/// on every call, so their cost grew with every task the shop ever had, and Cloudflare caps how many calls one request may
/// make to other objects (docs/decisions.md). With the lookup, an open read reads only the tasks that may hold an open
/// request, a recent read those and the tasks of the newest `limit` settled requests, and a decision one entry.
///
/// Keys, per tenant, beside the index's `tenant-tasks:${tenant}`. One TenantObject holds one tenant; the keys still name
/// it, as every store's do, so no read can reach another tenant's keys by a prefix.
/// - `appr:${tenant}:${requestId}`: `{ taskId, at, askedAt?, settled? }`. Where the request is, and when the entry was
///   written. Once a read has found the request settled, when it was asked (approval-core's `createdAt`) and `settled`.
/// - `appr-open:${tenant}:${requestId}`: the task id. The requests that may still be open: an entry joins before its
///   request opens, and leaves once a read of its task finds the request settled or not there.
/// - `appr-done:${tenant}:${inverted askedAt}:${requestId}`: the settled ones, so that listing them in key order is
///   newest asked first and then by id, the order the approvals list keeps.
/// - `appr-state:${tenant}`: the backfill's place in the index (`{ next }`) while it walks, `{ ready: true, at }` after.
///
/// Rules this module keeps:
/// - An entry is written before its request opens, by the task object, the one place requests open (task-object.ts,
///   `indexRequest`). A request whose entry could not be written is not opened, so no request is ever missing from the
///   lookup; a request that never opened after its entry was written leaves a stale entry, which reads clear.
/// - Settled is final. approval-core settles a request once; an expiry is a fixed instant; and a superseded request's
///   attempt never holds its task again (task-object.ts, `runningAttemptSync`). So moving an entry out of the open set
///   is never wrong, and no request needs to come back into it.
/// - A read clears an entry its task does not hold only when the entry can no longer be opening: a settled one at once
///   (its request has gone from the task), any other once `STALE_AFTER_MS` has passed since it was written. The task
///   object opens a request only within `OPEN_WINDOW_MS` of writing its entry, so no read can clear an entry whose
///   request is about to open.
/// - Readers see only entries whose task is in the shop's index, so the scope stays the index's, as it was when every
///   read walked the index. An entry naming a task outside it is passed over and left: the index may yet catch up with a
///   task the lifted PUT route made (it indexes after it writes).
/// - The backfill (`stepBackfill`) gives shops whose requests were opened before the lookup their entries: a bounded step
///   of `BACKFILL_TASKS` tasks at a time, from where the last step stopped, each run by an approvals read that found the
///   lookup not ready. Until it has stepped through every task in the index, readers walk the index as before. A shop
///   whose first task is indexed after this change has nothing to backfill (`readyOnFirstTask`).
/// - Only the Worker and the task object reach these paths, and every POST needs `x-approvals`, the same defence in depth
///   as the other stores' headers.

import type { ApprovalRecord, Standing } from "@manut/approval-core";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

const MAX_BODY_BYTES = 256 * 1024;
/// The longest request id an entry takes. Every request shares its action's id, a UUID.
const MAX_REQUEST_ID = 128;
/// The longest task id an entry takes. Task ids are the client's or the runner's, far shorter than this.
const MAX_TASK_ID = 512;
/// The most entries one report of what a read found may carry. A read sends its findings in chunks of this size.
export const MAX_LEARNED = 500;
/// The most settled entries one listing answers: the most a recent read may ask for (approvals.ts, `MAX_RECENT`).
const MAX_SETTLED = 200;
/// How many tasks one step of the backfill reads. One step runs beside a read, so it keeps to what a page of the task
/// list reads (task-list.ts), well inside what one request may make.
export const BACKFILL_TASKS = 25;
/// How long after writing a request's entry the task object may still open it. Past this it refuses, so an entry older
/// than `STALE_AFTER_MS` whose task does not hold its request can never be opened any more.
export const OPEN_WINDOW_MS = 60_000;
/// How long an entry whose task does not hold its request is kept, in case the request is still opening. Ten times the
/// open window, so clocks on different machines would have to disagree by minutes before a read could clear an entry
/// whose request was about to open.
export const STALE_AFTER_MS = 10 * 60_000;
/// The latest instant a JavaScript date can hold, so `MAX_TIME - askedAt` is never negative and fits 16 digits.
const MAX_TIME = 8_640_000_000_000_000;

type Entry = { taskId: string; at: number; askedAt?: number; settled?: true };
type BackfillState = { next: number } | { ready: true; at: string };

/// A request and the task the lookup says holds it.
export type Located = { requestId: string; taskId: string };
export type SettledEntry = Located & { askedAt: number };
/// What reading some tasks showed of the requests in them: each request found, with when it was asked and whether it is
/// still open, and each one looked for that its task does not hold.
export type Learned = { found: (Located & { askedAt: number; open: boolean })[]; missing: Located[] };

const entryPrefix = (tenant: string) => `appr:${tenant}:`;
const entryKey = (tenant: string, requestId: string) => `${entryPrefix(tenant)}${requestId}`;
const openPrefix = (tenant: string) => `appr-open:${tenant}:`;
const donePrefix = (tenant: string) => `appr-done:${tenant}:`;
const stateKey = (tenant: string) => `appr-state:${tenant}`;
const indexKey = (tenant: string) => `tenant-tasks:${tenant}`;

/// The settled entry's key: the inverted time first, zero-padded, so ascending keys are newest asked first, and ties
/// fall to the request id, ascending, as the approvals list breaks them.
function doneKey(tenant: string, askedAt: number, requestId: string): string {
  return `${donePrefix(tenant)}${String(MAX_TIME - askedAt).padStart(16, "0")}:${requestId}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isAskedAt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
}

function isLocated(value: unknown): value is Located {
  return isRecord(value) && isId(value.requestId, MAX_REQUEST_ID) && isId(value.taskId, MAX_TASK_ID);
}

/// Whether readers may trust the lookup to hold every one of the shop's requests: its backfill has finished, or the shop
/// has no task, so no request either.
function readySync(kv: SyncKvStorage, tenant: string): boolean {
  const state = kv.get<BackfillState>(stateKey(tenant));
  if (state !== undefined && "ready" in state) return true;
  return (kv.get<string[]>(indexKey(tenant)) ?? []).length === 0;
}

/// The tasks in the shop's index, which bound what readers are shown.
function indexedSync(kv: SyncKvStorage, tenant: string): Set<string> {
  return new Set(kv.get<string[]>(indexKey(tenant)) ?? []);
}

function openSync(kv: SyncKvStorage, tenant: string, requestId: string, taskId: string, at: number): void {
  kv.put(entryKey(tenant, requestId), { taskId, at } satisfies Entry);
  kv.put(`${openPrefix(tenant)}${requestId}`, taskId);
}

/// Forgets one entry wherever it is kept.
function dropSync(kv: SyncKvStorage, tenant: string, requestId: string, entry: Entry): void {
  kv.delete(entryKey(tenant, requestId));
  kv.delete(`${openPrefix(tenant)}${requestId}`);
  if (entry.askedAt !== undefined) kv.delete(doneKey(tenant, entry.askedAt, requestId));
}

/// Applies what reading tasks showed. A request found in a task is where the lookup says it is from then on, open or
/// settled as the task said; a settled entry never goes back to open for the same task, since a request never does
/// (a report that says open may simply be older than the one that said settled). A request its task does not hold is
/// forgotten once it cannot be opening any more (the module note).
export function learnSync(kv: SyncKvStorage, tenant: string, learned: Learned, nowMs: number): void {
  for (const item of learned.found) {
    const entry = kv.get<Entry>(entryKey(tenant, item.requestId));
    if (item.open) {
      if (entry?.taskId === item.taskId) continue;
      if (entry !== undefined) dropSync(kv, tenant, item.requestId, entry);
      openSync(kv, tenant, item.requestId, item.taskId, nowMs);
      continue;
    }
    if (entry?.settled && entry.taskId === item.taskId && entry.askedAt === item.askedAt) continue;
    if (entry !== undefined) dropSync(kv, tenant, item.requestId, entry);
    kv.put(entryKey(tenant, item.requestId),
      { taskId: item.taskId, at: entry?.at ?? nowMs, askedAt: item.askedAt, settled: true } satisfies Entry);
    kv.put(doneKey(tenant, item.askedAt, item.requestId),
      { requestId: item.requestId, taskId: item.taskId, askedAt: item.askedAt } satisfies SettledEntry);
  }
  for (const item of learned.missing) {
    const entry = kv.get<Entry>(entryKey(tenant, item.requestId));
    // Only the task the entry names can say its request is not there.
    if (entry === undefined || entry.taskId !== item.taskId) continue;
    if (!entry.settled && nowMs - entry.at <= STALE_AFTER_MS) continue;
    dropSync(kv, tenant, item.requestId, entry);
  }
}

function isFound(value: unknown): value is Learned["found"][number] {
  return isLocated(value) && isAskedAt((value as Record<string, unknown>).askedAt) &&
    typeof (value as Record<string, unknown>).open === "boolean";
}

/// What a report carries, checked and copied field by field, or null.
function learnedOf(body: Record<string, unknown>): Learned | null {
  const { found, missing } = body;
  if (!Array.isArray(found) || !Array.isArray(missing) || found.length + missing.length > MAX_LEARNED ||
      !found.every(isFound) || !missing.every(isLocated)) {
    return null;
  }
  return {
    found: found.map(({ requestId, taskId, askedAt, open }) => ({ requestId, taskId, askedAt, open })),
    missing: missing.map(({ requestId, taskId }) => ({ requestId, taskId })),
  };
}

/// `/approvals/*` on a TenantObject, all but the backfill's step (`stepBackfill`, which reads tasks):
/// - `GET /approvals/open?tenant=` answers `{ ready, open }`: every entry that may still be open, of a task in the index.
/// - `GET /approvals/settled?tenant=&limit=&after=` answers `{ ready, settled, next }`: the newest `limit` settled entries
///   of tasks in the index after the key `after`, newest asked first, and the key to go on from, or null at the end.
/// - `GET /approvals/where?tenant=&request=` answers `{ ready, taskId }`: the task that holds the request, or null when
///   there is no entry or its task is not in the index.
/// - `POST /approvals/asked` with `{ tenant, requestId, taskId }`: the entry of a request about to open.
/// - `POST /approvals/learned` with `{ tenant, found, missing }`: what a read found (`learnSync`).
export async function approvalIndexRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  const kv = storage.kv;
  if (request.method === "GET") {
    const tenant = url.searchParams.get("tenant") ?? "";
    if (!isValidTenant(tenant)) return json({ error: "invalid_request" }, 400);
    if (route === "GET /approvals/open") {
      const indexed = indexedSync(kv, tenant);
      const prefix = openPrefix(tenant);
      const open: Located[] = [];
      for (const [key, taskId] of kv.list<string>({ prefix })) {
        if (indexed.has(taskId)) open.push({ requestId: key.slice(prefix.length), taskId });
      }
      return json({ ready: readySync(kv, tenant), open });
    }
    if (route === "GET /approvals/settled") {
      const rawLimit = url.searchParams.get("limit") ?? "";
      const limit = /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      const after = url.searchParams.get("after");
      const prefix = donePrefix(tenant);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SETTLED ||
          (after !== null && (!after.startsWith(prefix) || after.length > prefix.length + 17 + MAX_REQUEST_ID))) {
        return json({ error: "invalid_request" }, 400);
      }
      const indexed = indexedSync(kv, tenant);
      const settled: SettledEntry[] = [];
      let taken: string | null = null;
      let next: string | null = null;
      for (const [key, entry] of kv.list<SettledEntry>({ prefix, ...(after !== null ? { startAfter: after } : {}) })) {
        if (settled.length === limit) {
          // There is more: the next listing goes on after the last key this one took.
          next = taken;
          break;
        }
        if (!indexed.has(entry.taskId)) continue;
        settled.push(entry);
        taken = key;
      }
      return json({ ready: readySync(kv, tenant), settled, next });
    }
    if (route === "GET /approvals/where") {
      const requestId = url.searchParams.get("request") ?? "";
      if (!isId(requestId, MAX_REQUEST_ID)) return json({ error: "invalid_request" }, 400);
      const entry = kv.get<Entry>(entryKey(tenant, requestId));
      const taskId = entry !== undefined && indexedSync(kv, tenant).has(entry.taskId) ? entry.taskId : null;
      return json({ ready: readySync(kv, tenant), taskId });
    }
    return json({ error: "not_found" }, 404);
  }
  if (request.headers.get("x-approvals") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !isValidTenant(body.tenant)) return json({ error: "invalid_request" }, 400);
  const tenant = body.tenant;
  if (route === "POST /approvals/asked") {
    if (!isLocated(body)) return json({ error: "invalid_request" }, 400);
    const { requestId, taskId } = body;
    storage.transactionSync(() => {
      // Ids are minted fresh for each request, so an entry already there can only be this one's, and it is kept.
      if (kv.get<Entry>(entryKey(tenant, requestId)) === undefined) openSync(kv, tenant, requestId, taskId, Date.now());
    });
    return json({ indexed: true });
  }
  if (route === "POST /approvals/learned") {
    const learned = learnedOf(body);
    if (!learned) return json({ error: "invalid_request" }, 400);
    storage.transactionSync(() => learnSync(kv, tenant, learned, Date.now()));
    return json({ learned: learned.found.length + learned.missing.length });
  }
  return json({ error: "not_found" }, 404);
}

/// Every request a task holds that the tenant may read, with where each stands (`GET /requests`, task-object.ts): null
/// when the task is not the tenant's or never came to exist, undefined when it cannot be read.
async function taskRequests(env: Pick<TenantDataEnv, "TASK">, tenant: string, taskId: string):
  Promise<{ record: ApprovalRecord; standing: Standing }[] | null | undefined> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/requests",
      { headers: { "x-tenant": tenant } }));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return ((await response.json()) as { requests: { record: ApprovalRecord; standing: Standing }[] }).requests;
  } catch {
    return undefined;
  }
}

/// One step of the backfill for `tenant`: the next `BACKFILL_TASKS` tasks of its index from where the last step stopped,
/// each read with only the tenant, every request in them entered, and the place moved past the tasks read. A task that
/// cannot be read ends the step there, so the next step starts with it: nothing is skipped. A task of another tenant
/// planted in the index, or one the create route indexed and never made, answers 404 and holds nothing of this tenant's.
///
/// The reads are awaited first and everything is written in one transaction after, and only if the place is still the
/// one this step started from: a step cut off before its end writes nothing, a step that overlaps another writes nothing
/// twice, and a deletion that ran meanwhile (which removes the place) is never undone by entries written after it.
export async function stepBackfill(storage: DurableObjectStorage, env: Pick<TenantDataEnv, "TASK">, tenant: string):
  Promise<{ ready: boolean }> {
  const kv = storage.kv;
  if (readySync(kv, tenant)) return { ready: true };
  const begun = kv.get<BackfillState>(stateKey(tenant));
  const from = begun !== undefined && "next" in begun ? begun.next : 0;
  if (begun === undefined) kv.put(stateKey(tenant), { next: 0 } satisfies BackfillState);
  const tasks = (kv.get<string[]>(indexKey(tenant)) ?? []).slice(from, from + BACKFILL_TASKS);
  const learned: Learned = { found: [], missing: [] };
  let read = 0;
  for (const taskId of tasks) {
    const requests = await taskRequests(env, tenant, taskId);
    if (requests === undefined) break;
    for (const { record, standing } of requests ?? []) {
      learned.found.push({ requestId: record.request.id, taskId, askedAt: record.request.createdAt,
        open: standing.state === "open" });
    }
    read += 1;
  }
  return storage.transactionSync(() => {
    const now = kv.get<BackfillState>(stateKey(tenant));
    if (now === undefined || !("next" in now) || now.next !== from) return { ready: readySync(kv, tenant) };
    learnSync(kv, tenant, learned, Date.now());
    const next = from + read;
    const done = next >= (kv.get<string[]>(indexKey(tenant)) ?? []).length;
    kv.put(stateKey(tenant), done ? { ready: true, at: new Date().toISOString() } : { next } satisfies BackfillState);
    return { ready: done };
  });
}

/// For the task index's write (tenant-object.ts, `indexTask`): the state to store with a shop's first task. A shop whose
/// index was empty when this change came holds no request from before it, and every request opened since has its entry,
/// so its lookup is complete from the start and needs no backfill. Answers nothing to store when the shop already had
/// tasks or a state.
export function readyOnFirstTask(kv: SyncKvStorage, tenant: string, indexBefore: readonly string[]):
  Record<string, BackfillState> {
  if (indexBefore.length > 0 || kv.get(stateKey(tenant)) !== undefined) return {};
  return { [stateKey(tenant)]: { ready: true, at: new Date().toISOString() } };
}

/// Forgets the shop's whole lookup and its backfill's place, for the tenant deletion (tenant-object.ts, `tenantWipe`).
/// The keys are listed whole before any is deleted, so no listing runs over rows being deleted under it.
export function wipeApprovalIndex(storage: DurableObjectStorage, tenant: string): void {
  const kv = storage.kv;
  storage.transactionSync(() => {
    const doomed = [entryPrefix(tenant), openPrefix(tenant), donePrefix(tenant)]
      .flatMap((prefix) => [...kv.list({ prefix })].map(([key]) => key));
    for (const key of doomed) kv.delete(key);
    kv.delete(stateKey(tenant));
  });
}

// ---------------------------------------------------------------------------
// The callers' side: the task object writes entries, the Worker reads them.
// ---------------------------------------------------------------------------

const approvalsHeaders = { "content-type": "application/json", "x-approvals": "1" };

/// The task object's write before a request opens (task-object.ts): true once the entry is stored. A request with no
/// tenant is in no shop's index, so no shop's approvals list it and there is no lookup to write; it answers true.
export async function indexRequest(env: Pick<TenantDataEnv, "TENANT">, tenant: string, requestId: string,
  taskId: string): Promise<boolean> {
  if (tenant === "") return true;
  try {
    const response = await tenantCall(env, tenant, "/approvals/asked", { method: "POST", headers: approvalsHeaders,
      body: JSON.stringify({ tenant, requestId, taskId }) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function readLookup<T>(env: Pick<TenantDataEnv, "TENANT">, tenant: string, path: string):
  Promise<T | undefined> {
  try {
    const response = await tenantCall(env, tenant, path);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/// The entries that may still be open, or undefined when the lookup cannot be read.
export function openEntries(env: Pick<TenantDataEnv, "TENANT">, tenant: string):
  Promise<{ ready: boolean; open: Located[] } | undefined> {
  return readLookup(env, tenant, `/approvals/open?tenant=${encodeURIComponent(tenant)}`);
}

/// The newest `limit` settled entries after `after`, or undefined when the lookup cannot be read.
export function settledEntries(env: Pick<TenantDataEnv, "TENANT">, tenant: string, limit: number,
  after: string | null): Promise<{ ready: boolean; settled: SettledEntry[]; next: string | null } | undefined> {
  const query = `tenant=${encodeURIComponent(tenant)}&limit=${limit}${after !== null
    ? `&after=${encodeURIComponent(after)}` : ""}`;
  return readLookup(env, tenant, `/approvals/settled?${query}`);
}

/// The task the lookup says holds the request, or undefined when the lookup cannot be read.
export function whereIs(env: Pick<TenantDataEnv, "TENANT">, tenant: string, requestId: string):
  Promise<{ ready: boolean; taskId: string | null } | undefined> {
  return readLookup(env, tenant,
    `/approvals/where?tenant=${encodeURIComponent(tenant)}&request=${encodeURIComponent(requestId)}`);
}

/// Tells the lookup what a read found. Nothing waits on it: the read has already answered from the tasks, and an entry
/// the report did not reach is read again by the next read, which reports it again.
export async function reportLearned(env: Pick<TenantDataEnv, "TENANT">, tenant: string, learned: Learned):
  Promise<void> {
  const chunks: Learned[] = [];
  for (let i = 0; i < learned.found.length; i += MAX_LEARNED) {
    chunks.push({ found: learned.found.slice(i, i + MAX_LEARNED), missing: [] });
  }
  for (let i = 0; i < learned.missing.length; i += MAX_LEARNED) {
    chunks.push({ found: [], missing: learned.missing.slice(i, i + MAX_LEARNED) });
  }
  for (const chunk of chunks) {
    try {
      const response = await tenantCall(env, tenant, "/approvals/learned",
        { method: "POST", headers: approvalsHeaders, body: JSON.stringify({ tenant, ...chunk }) });
      await response.body?.cancel();
    } catch {
      return;
    }
  }
}

/// Tells the lookup that `taskId` no longer holds `requestIds`, because the retention prune removed them from it
/// (task-object.ts, `pruneExpired`). Each goes as a `missing` entry, the way a read reports a request its task does not
/// hold, so the same rule decides: only the task an entry names can clear it, and an entry is never cleared while its
/// request could still be opening. Unlike a read's report, the prune waits on this one: the task keeps the ids the lookup
/// did not take and sends them again with its next prune, since no read may ever come back for an old settled entry.
/// Whether the lookup took every one.
export async function reportGone(env: Pick<TenantDataEnv, "TENANT">, tenant: string, taskId: string,
  requestIds: readonly string[]): Promise<boolean> {
  for (let i = 0; i < requestIds.length; i += MAX_LEARNED) {
    const missing = requestIds.slice(i, i + MAX_LEARNED).map((requestId) => ({ requestId, taskId }));
    try {
      const response = await tenantCall(env, tenant, "/approvals/learned",
        { method: "POST", headers: approvalsHeaders, body: JSON.stringify({ tenant, found: [], missing }) });
      await response.body?.cancel();
      if (!response.ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/// Whether the lookup would take `requestId` in a report: what the task object notes after a prune is only ever an id
/// the lookup takes, so one it would refuse can never hold the note up.
export const isReportableRequestId = (requestId: unknown): requestId is string => isId(requestId, MAX_REQUEST_ID);

/// Runs one step of the shop's backfill (`stepBackfill`). Nothing waits on it either: the read that runs it answers by
/// walking the index, and the next read runs the next step.
export async function runBackfillStep(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<void> {
  try {
    const response = await tenantCall(env, tenant, "/approvals/backfill",
      { method: "POST", headers: approvalsHeaders, body: JSON.stringify({ tenant }) });
    await response.body?.cancel();
  } catch {
    // The walk answers this read whatever became of the step.
  }
}
