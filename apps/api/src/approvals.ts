/// Approvals for a session (docs/pilot-api.md, "Approvals for a session"): `GET /v1/approvals` answers the signed-in
/// tenant's approval-core records and where each stands now, as approval-core's wire JSON
/// (packages/approval-core/src/wire.ts), so the desktop can read them with approval-core's own decoders. Reading only:
/// nothing here decides, and answering from a session is a later slice.
///
/// The scope is the tenant's own, as for the tenant export: every task in the tenant's index, each read with only the
/// tenant the session verified, so the task object's tenancy rules apply as they do to every task read. A task of
/// another tenant planted in the index answers 404 and is skipped, and an action of another tenant inside the tenant's
/// own task is never listed (`GET /requests` in task-object.ts). Fellow members' company tasks open only to a verified
/// company assertion, which this route never makes, so they are not listed here.
///
/// Each record carries the kind its request was opened with, which the task object sets from the operation it decides
/// (`REQUEST_KINDS` in task-object.ts): a LINE reply is `reply`, a worker's `linear.issue.create` is `command`. A plain
/// proposal that no request decides, such as a session's own `linear.issue.create`, is not an approval-core approval
/// and is not listed.

import { decodeRecord, encodeRecord, encodeStanding, type ApprovalRecord, type Standing } from "@manut/approval-core";
import { tenantCall, type TenantDataEnv } from "./tenant-data";

/// How many recent approvals one answer holds when the query does not say, and the most it may ask for.
const DEFAULT_RECENT = 50;
const MAX_RECENT = 200;

type Found = { taskId: string; record: ApprovalRecord; standing: Standing };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/// `state=open` answers every approval still waiting for a decision: its standing is `open`. `state=recent` answers
/// the newest `limit` of those that left it: decided, expired, or superseded. Both list the newest asked first. An
/// index or a task that cannot be read fails the whole answer rather than leaving its approvals out: an approval
/// missing from the list would read as nobody having asked.
export async function listApprovals(env: Pick<TenantDataEnv, "TASK" | "TENANT">, tenant: string, url: URL):
  Promise<Response> {
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
  return json({
    state,
    approvals: listed.map((entry) => ({
      taskId: entry.taskId,
      record: encodeRecord(decodeRecord(entry.record)),
      standing: encodeStanding(entry.standing),
    })),
  });
}
