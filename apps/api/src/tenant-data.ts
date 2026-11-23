/// Tenant-wide data handling: the per-tenant object addresses, plus export
/// and deletion, which fan out across every object that holds a tenant's
/// data. It lives outside index.ts so the Worker's main module exports only
/// Durable Object classes, and so tests can drive export and deletion against
/// a stubbed environment where any one fan-out call fails.

/// The namespaces export and deletion reach. The Worker's `Env` satisfies
/// this, and a test can too without standing up the whole Worker.
export type TenantDataEnv = {
  TASK: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
  CRED: DurableObjectNamespace;
  SCHEDULES: DurableObjectNamespace;
  TENANT: DurableObjectNamespace;
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function authCall(env: Pick<TenantDataEnv, "AUTH">, path: string, init?: RequestInit): Promise<Response> {
  const stub = env.AUTH.get(env.AUTH.idFromName("auth"));
  return stub.fetch(new Request(`https://auth${path}`, init));
}

/// Per-tenant object address. The empty tenant is the tenantless operator
/// path; every other tenant gets an isolated object.
export function tenantStub(env: Pick<TenantDataEnv, "TENANT">, tenant: string): DurableObjectStub {
  return env.TENANT.get(env.TENANT.idFromName(`t:${tenant || "operator"}`));
}

/// Per-tenant credential vault address. Same addressing as tenant objects.
export function credStub(env: Pick<TenantDataEnv, "CRED">, tenant: string): DurableObjectStub {
  return env.CRED.get(env.CRED.idFromName(`t:${tenant || "operator"}`));
}

/// Per-tenant schedule object address. Each tenant's recurrence gets its own
/// alarm, so one tenant's sweep never touches another's schedules.
export function scheduleStub(env: Pick<TenantDataEnv, "SCHEDULES">, tenant: string): DurableObjectStub {
  return env.SCHEDULES.get(env.SCHEDULES.idFromName(`t:${tenant || "operator"}`));
}

export async function tenantCall(
  env: Pick<TenantDataEnv, "TENANT">,
  tenant: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const stub = tenantStub(env, tenant);
  return stub.fetch(new Request(`https://tenant${path}`, init));
}

/// Assembles a tenant's task documents with their histories, connection
/// metadata, site sign-ins and outposts (no secret), schedules, consent, inbound attention items, pilot records,
/// model meter, audit log, memory, people and deletion tombstone. Each task answers with its document, event
/// log, action proposals and attempts, so the export no longer leaves the
/// history behind (the old "task record only" gap is closed below).
///
/// For the parts it does assemble, a part that cannot be read answers 500
/// export_incomplete naming it, instead of a 200 that quietly leaves those
/// records out. The one skip is a task that answers 404: the create route
/// indexes before creating, so the index can hold ids of tasks that never
/// came to exist.
export async function tenantExport(env: TenantDataEnv, tenant: string): Promise<Response> {
  const response = await assembleExport(env, tenant);
  // The export holds customers' words, their LINE display names, what the team knows and its drafts, so no
  // browser or proxy may keep a copy of it, whatever it answers: the whole export, an incomplete one or a deletion.
  response.headers.set("cache-control", "no-store");
  return response;
}

async function assembleExport(env: TenantDataEnv, tenant: string): Promise<Response> {
  const headers = new Headers();
  headers.set("x-tenant", tenant);
  const query = `tenant=${encodeURIComponent(tenant)}`;
  const failed: string[] = [];
  const indexResp = await tenantCall(env, tenant, `/index?${query}`);
  if (!indexResp.ok) failed.push("index");
  const index = (indexResp.ok ? await indexResp.json() : {}) as { taskIds?: string[] };
  const tasks: unknown[] = [];
  for (const id of index.taskIds ?? []) {
    const stub = env.TASK.get(env.TASK.idFromName(id));
    const response = await stub.fetch(new Request("https://task/export", { headers }));
    if (response.ok) tasks.push(await response.json());
    else if (response.status !== 404) failed.push(id);
  }
  const credResp = await credStub(env, tenant).fetch(
    new Request(`https://cred/connections?${query}`, { headers }),
  );
  if (!credResp.ok) failed.push("connections");
  const connections = (credResp.ok ? await credResp.json() : {}) as { connections?: unknown[] };
  // The vault's site sign-ins and the outposts that type them (sign-in-vault.ts), as the operator lists them: never a
  // password, a credential or its digest.
  const signInsResp = await credStub(env, tenant).fetch(new Request("https://cred/sign-ins", { headers }));
  if (!signInsResp.ok) failed.push("signIns");
  const signIns = (signInsResp.ok ? await signInsResp.json() : {}) as { signIns?: unknown[] };
  const outpostsResp = await credStub(env, tenant).fetch(new Request("https://cred/outposts", { headers }));
  if (!outpostsResp.ok) failed.push("outposts");
  const outposts = (outpostsResp.ok ? await outpostsResp.json() : {}) as { outposts?: unknown[] };
  const consentResp = await tenantCall(env, tenant, `/consent?${query}`);
  if (!consentResp.ok) failed.push("consent");
  const consent: unknown = consentResp.ok ? await consentResp.json() : null;
  const attentionResp = await tenantCall(env, tenant, `/attention?${query}`);
  if (!attentionResp.ok) failed.push("attention");
  const attention = (attentionResp.ok ? await attentionResp.json() : {}) as { items?: unknown[] };
  // Manut AI pilot records: the shop, its customers' messages, replies and
  // payments. Empty for every tenant that is not a pilot shop.
  const pilotResp = await tenantCall(env, tenant, `/pilot/export?${query}`);
  if (!pilotResp.ok) failed.push("pilot");
  const pilot: unknown = pilotResp.ok ? await pilotResp.json() : null;
  // The model gateway's meter: the cap override, monthly totals, open
  // reservations and one metadata record per model call (model-meter.ts).
  const modelResp = await tenantCall(env, tenant, `/model/export?${query}`);
  if (!modelResp.ok) failed.push("model");
  const model: unknown = modelResp.ok ? await modelResp.json() : null;
  // The shop's audit log: every entry, oldest first, and how many entries it
  // could not write (audit-log.ts).
  const auditResp = await tenantCall(env, tenant, `/audit/export?${query}`);
  if (!auditResp.ok) failed.push("audit");
  const audit: unknown = auditResp.ok ? await auditResp.json() : null;
  // What the team knows about the shop: every fact, waiting ones included, and only how many texts it was told to
  // forget, never their fingerprints (memory-store.ts).
  const memoryResp = await tenantCall(env, tenant, `/memory/export?${query}`);
  if (!memoryResp.ok) failed.push("memory");
  const memory: unknown = memoryResp.ok ? await memoryResp.json() : null;
  // The people around the shop: helpers, invites, cover, the notes helpers passed on and the names the owner gave,
  // never a helper session's hash (people-store.ts).
  const peopleResp = await tenantCall(env, tenant, `/people/export?${query}`);
  if (!peopleResp.ok) failed.push("people");
  const people: unknown = peopleResp.ok ? await peopleResp.json() : null;
  const schedResp = await scheduleStub(env, tenant).fetch(new Request("https://schedules/schedules", { headers }));
  if (!schedResp.ok) failed.push("schedules");
  const schedules = (schedResp.ok ? await schedResp.json() : {}) as { schedules?: unknown[] };
  const tombResp = await tenantCall(env, tenant, `/tombstone?${query}`);
  if (!tombResp.ok) failed.push("tombstone");
  const tomb = (tombResp.ok ? await tombResp.json() : {}) as {
    tombstone?: { deletedAt: string } | null;
  };
  if (failed.length > 0) {
    return json({ error: "export_incomplete", failed }, 500);
  }
  if (tasks.length === 0 && tomb.tombstone) {
    return json({ error: "tenant_deleted", deletedAt: tomb.tombstone.deletedAt }, 404);
  }
  return json({
    tenant,
    exportedAt: new Date().toISOString(),
    tasks,
    connections: connections.connections ?? [],
    signIns: signIns.signIns ?? [],
    outposts: outposts.outposts ?? [],
    schedules: schedules.schedules ?? [],
    consent,
    attention: attention.items ?? [],
    pilot,
    model,
    audit,
    memory,
    people,
    ...(tomb.tombstone ? { deletedAt: tomb.tombstone.deletedAt } : {}),
  });
}

/// Runs the retention sweep for one tenant: the task index fans out to a
/// per-task prune in every TaskObject holding the tenant's work. Parts that
/// cannot be pruned answer 500 prune_incomplete naming them, the same
/// convention as export and deletion, so a partial sweep never reads as a
/// clean one. Time comes from the caller (the worker passes its own clock);
/// per-task calls carry no client headers, only the worker-set prune header
/// and the tenant the index was read under.
export async function tenantPrune(env: TenantDataEnv, tenant: string, nowMs: number): Promise<Response> {
  const headers = new Headers();
  headers.set("x-tenant", tenant);
  const indexResp = await tenantCall(env, tenant, `/index?tenant=${encodeURIComponent(tenant)}`);
  // An unreadable index is not an empty one: reporting a clean sweep over
  // tasks the index would have listed orphans their expired records.
  if (!indexResp.ok) {
    return json({ error: "prune_incomplete", tasksPruned: 0, failed: ["index-read"] }, 500);
  }
  const index = (await indexResp.json()) as { taskIds?: string[] };
  let tasksPruned = 0;
  let attemptsPruned = 0;
  let actionsPruned = 0;
  const failed: string[] = [];
  for (const id of index.taskIds ?? []) {
    const stub = env.TASK.get(env.TASK.idFromName(id));
    const response = await stub.fetch(
      new Request("https://task/prune", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, "x-prune": "1" },
        body: JSON.stringify({ nowMs }),
      }),
    );
    if (response.ok) {
      // Same rule as the wipe above: a planted foreign task answers notOwned
      // and is left for its real owner, neither pruned nor a failure.
      const counts = (await response.json()) as {
        attemptsPruned?: number;
        actionsPruned?: number;
        notOwned?: unknown;
      };
      if (!counts.notOwned) {
        tasksPruned++;
        attemptsPruned += typeof counts.attemptsPruned === "number" ? counts.attemptsPruned : 0;
        actionsPruned += typeof counts.actionsPruned === "number" ? counts.actionsPruned : 0;
      }
    } else if (response.status !== 404) {
      // A 404 is the indexed-but-never-created task the export already
      // tolerates; anything else keeps its id in the failed list.
      failed.push(id);
    }
  }
  // Pilot customer messages age out on the source-snapshot window
  // (pilot-store.ts). Nothing to prune for a tenant that is not a pilot shop.
  let messagesPruned = 0;
  const pilotResp = await tenantCall(env, tenant, "/pilot/prune", {
    method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant, nowMs }),
  });
  if (pilotResp.ok) {
    const counts = (await pilotResp.json()) as { messagesPruned?: unknown };
    messagesPruned = typeof counts.messagesPruned === "number" ? counts.messagesPruned : 0;
  } else {
    failed.push("pilot");
  }
  if (failed.length > 0) {
    return json({ error: "prune_incomplete", tasksPruned, failed }, 500);
  }
  return json({
    tenant,
    tasksPruned,
    attemptsPruned,
    actionsPruned,
    messagesPruned,
    prunedAt: new Date(nowMs).toISOString(),
  });
}
///
/// The order is the safety property. Tasks, connections and schedules go
/// first; the tenant's sessions go next; the task index and consent go last,
/// replaced by the tombstone. Any failure stops the run before the sessions
/// and the index are touched, answering 500 wipe_incomplete with the parts
/// that failed. The surviving session lets the user run the delete again and
/// the surviving index lets that run find every remaining task. A tombstone
/// written over surviving credentials or schedules would tell the user their
/// data was gone while sealed connector secrets, or alarms that keep minting
/// tasks, lived on.
export async function tenantDelete(env: TenantDataEnv, tenant: string): Promise<Response> {
  const indexResp = await tenantCall(env, tenant, `/index?tenant=${encodeURIComponent(tenant)}`);
  // An unreadable index is not an empty one: wiping nothing and then the
  // index would orphan every task it listed.
  if (!indexResp.ok) {
    return json({ error: "wipe_incomplete", tasksWiped: 0, failed: ["index-read"] }, 500);
  }
  const index = (await indexResp.json()) as { taskIds?: string[] };
  let tasksWiped = 0;
  const failed: string[] = [];
  for (const id of index.taskIds ?? []) {
    const stub = env.TASK.get(env.TASK.idFromName(id));
    const wiped = await stub.fetch(
      new Request("https://task/wipe", {
        method: "DELETE",
        headers: { "x-wipe": "1", "x-tenant": tenant },
      }),
    );
    if (wiped.ok) {
      // An id planted in this index but owned by another tenant answers
      // notOwned: it is neither wiped nor a failure, and the task stays for
      // its real owner while this tenant's own deletion completes.
      const answer = (await wiped.json().catch(() => null)) as { notOwned?: unknown } | null;
      if (!answer?.notOwned) tasksWiped++;
    } else failed.push(id);
  }
  // A failed task wipe must not delete the index below: an indexed-but-live
  // task is retryable, an unindexed-but-live task is orphaned forever.
  if (failed.length > 0) {
    return json({ error: "wipe_incomplete", tasksWiped, failed }, 500);
  }
  const credResp = await credStub(env, tenant).fetch(
    new Request("https://cred/tenant-wipe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" },
      body: JSON.stringify({ tenant }),
    }),
  );
  if (!credResp.ok) failed.push("connections");
  const schedResp = await scheduleStub(env, tenant).fetch(
    new Request("https://schedules/tenant-wipe", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" },
      body: JSON.stringify({ tenant }),
    }),
  );
  if (!schedResp.ok) failed.push("schedules");
  // Same ordering rule as the task wipes above: stop before the sessions
  // and the tombstone so the delete stays retryable.
  if (failed.length > 0) {
    return json({ error: "wipe_incomplete", tasksWiped, failed }, 500);
  }
  const connections = (await credResp.json()) as { connectionsWiped?: number };
  const sched = (await schedResp.json()) as { schedulesWiped?: number; occurrencesWiped?: number };
  // Sessions before the tombstone: a live session must never survive its
  // tenant's deletion. The tombstone goes last (TenantObject below); if it
  // fails, the surviving index keeps every remaining task retryable and the
  // delete can run again.
  const authResp = await authCall(env, "/tenant-wipe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wipe": "1" },
    body: JSON.stringify({ tenant }),
  });
  if (!authResp.ok) {
    return json({ error: "wipe_incomplete", tasksWiped, failed: ["sessions"] }, 500);
  }
  const auth = (await authResp.json()) as { sessionsWiped?: number };
  const tenantResp = await tenantCall(env, tenant, "/tenant-wipe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-wipe": "1" },
    body: JSON.stringify({ tenant }),
  });
  if (!tenantResp.ok) {
    return json({ error: "wipe_incomplete", tasksWiped, failed: ["index"] }, 500);
  }
  const wiped = (await tenantResp.json()) as { deletedAt?: string };
  return json({
    tasksWiped,
    connectionsWiped: connections.connectionsWiped ?? 0,
    schedulesWiped: sched.schedulesWiped ?? 0,
    occurrencesWiped: sched.occurrencesWiped ?? 0,
    sessionsWiped: auth.sessionsWiped ?? 0,
    deletedAt: wiped.deletedAt,
  });
}
