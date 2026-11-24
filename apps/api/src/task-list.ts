/// The session's own tasks, newest first, a page at a time (`GET /v1/tasks`; docs/pilot-api.md, "The shop's tasks, a
/// page at a time"). The desktop read a shop's tasks from its whole export once a minute, and the export is every task with
/// its whole log, every run and every draft, so it grew without bound. This is the list it reads instead
/// (docs/runtime-adapter.md, "A shop the person owns").
///
/// Rules this module keeps:
/// - A page reads the tenant's task index once and at most `limit` tasks, never more, whatever the tenant holds: no answer
///   reads every task. `limit` is at most 25, so one answer makes at most 25 calls to task objects, as the operator's jobs
///   list keeps well inside what one request may make (workers.ts).
/// - Newest first is the index's order backwards: the index only ever appends a task's id when the task is made, so a page
///   is a run of positions before the cursor, and a task made while a person pages lands before the first page and moves
///   no task they have still to read. No task is skipped or listed twice. The cursor is the id of the last task the page
///   looked at, so a task that leaves the index some day moves no cursor but its own.
/// - Each task answers for itself (`/listing` in task-object.ts, task-listing.ts), read with only the session's tenant, so
///   a task of another tenant planted in the index answers 404 and is passed over, as the export passes it over, and so is
///   an id the create route indexed for a task that never came to exist. A task that cannot be read fails the page (503)
///   rather than leave it out: a task missing from the list would read as gone.
/// - With a state named, a page holds only the tasks in that state among the ones it looked at, so it can come back short
///   or empty while `next` says there is more to look at. Reads stay bounded by `limit` all the same.

import { KNOWN_STATES } from "./task-object";
import type { ListedTask } from "./task-listing";
import { tenantCall, type TenantDataEnv } from "./tenant-data";
import { readIndex } from "./workers";

/// How many tasks a page looks at when the query does not say, and the most it may ask for.
export const DEFAULT_TASKS = 25;
export const MAX_TASKS = 25;
/// The longest cursor this route reads. Every cursor it gives is a task id, and those are far shorter.
const MAX_CURSOR = 256;

export type TaskPage = { tasks: ListedTask[]; next: string | null };

function json(data: unknown, status = 200): Response {
  // A page holds customers' words and members' drafts, so no browser or proxy may keep a copy, as with the export.
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/// The page a query asks for, or the code to refuse it with: a `limit` that is not a whole number from 1 to 25, a state no
/// task can be in, or a cursor that cannot be one this route gave. Whether the cursor names a task of the list is known
/// only once the index is read (`listTasks`). The caller has already refused a query that names the shop, the tenant or a
/// role, which only the session decides.
export function pageQuery(url: URL): { limit: number; cursor: string | null; state: string | null } | { error: string } {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_TASKS : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASKS) return { error: "invalid_limit" };
  const state = url.searchParams.get("state");
  if (state !== null && !KNOWN_STATES.has(state)) return { error: "invalid_state" };
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && (cursor.length === 0 || cursor.length > MAX_CURSOR)) return { error: "invalid_cursor" };
  return { limit, cursor, state };
}

/// One task's listing, read with only `tenant`: null when the task is not one of the tenant's (another's, planted in the
/// index) or never came to exist, and undefined when it cannot be read.
async function readListing(env: Pick<TenantDataEnv, "TASK">, tenant: string, taskId: string):
  Promise<ListedTask | null | undefined> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/listing",
      { headers: { "x-tenant": tenant } }));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as ListedTask;
  } catch {
    return undefined;
  }
}

/// When the tenant's data was deleted, from the tombstone its object keeps once a deletion finished; null when it never
/// was, and undefined when the object cannot be read.
async function deletedAt(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<string | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/tombstone?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { tombstone } = (await response.json()) as { tombstone?: { deletedAt?: unknown } | null };
    return typeof tombstone?.deletedAt === "string" ? tombstone.deletedAt : null;
  } catch {
    return undefined;
  }
}

/// `GET /v1/tasks` for `tenant`, the one the session names, once the caller has checked who is asking, the role, the
/// method and the session-named parts of the query. Answers `{ tasks, next }`: the tenant's tasks among the `limit` newest
/// before the cursor, newest first, and the cursor of the next page, or null on the last.
///
/// After the query (400 `invalid_limit`, `invalid_state` or `invalid_cursor`): the index (503 `tasks_unavailable` when it
/// cannot be read); a deleted tenant's, which holds no task and keeps a tombstone, is 404 `tenant_deleted` with when, as
/// the export answers it; a cursor that names no task of the index is 400 `invalid_cursor`; then the page's tasks, any of
/// which failing to read is 503 `tasks_unavailable`.
export async function listTasks(env: Pick<TenantDataEnv, "TASK" | "TENANT">, tenant: string, url: URL):
  Promise<Response> {
  const page = pageQuery(url);
  if ("error" in page) return json({ error: page.error }, 400);
  const index = await readIndex(env, tenant);
  if (!index) return json({ error: "tasks_unavailable" }, 503);
  if (index.length === 0) {
    // Only a tenant with no task can be a deleted one, so the tombstone is read only then: the export says a tenant is
    // deleted when its deletion left a tombstone and no task came after it.
    const deleted = await deletedAt(env, tenant);
    if (deleted === undefined) return json({ error: "tasks_unavailable" }, 503);
    if (deleted !== null) return json({ error: "tenant_deleted", deletedAt: deleted }, 404);
  }
  const newestFirst = [...index].reverse();
  let start = 0;
  if (page.cursor !== null) {
    const at = newestFirst.indexOf(page.cursor);
    if (at < 0) return json({ error: "invalid_cursor" }, 400);
    start = at + 1;
  }
  const looked = newestFirst.slice(start, start + page.limit);
  const read = await Promise.all(looked.map((taskId) => readListing(env, tenant, taskId)));
  if (read.includes(undefined)) return json({ error: "tasks_unavailable" }, 503);
  const tasks = read.filter((listed): listed is ListedTask => !!listed &&
    (page.state === null || listed.task.state === page.state));
  const next = start + looked.length < newestFirst.length ? (looked.at(-1) ?? null) : null;
  return json({ tasks, next } satisfies TaskPage);
}
