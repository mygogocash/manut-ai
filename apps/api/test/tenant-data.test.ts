import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tenantDelete, tenantExport, tenantPrune, type TenantDataEnv } from "../src/tenant-data";

// Export and deletion fan out across five kinds of object. The real objects
// almost never fail, so the round trip in consent.test.ts cannot show what
// happens when one does; this stub answers every call from a table and lets
// a test make any single call fail.

const TENANT = "apple:tenant-data-sub";
const TASK_IDS = ["task-a", "task-b"];

type Call = { ns: string; name: string; method: string; path: string; tenant: string; url: string };

/// Canned answers keyed "<NS> <METHOD> <path>", or "<NS>:<name> <METHOD>
/// <path>" for one object (a single task). Anything unlisted is a test bug
/// and answers 599 so it cannot pass for success.
function defaults(): Record<string, () => Response> {
  return {
    "TENANT GET /index": () => Response.json({ taskIds: TASK_IDS }),
    "TENANT GET /consent": () => Response.json({ cloudWork: true, updatedAt: "2026-09-24T00:00:00.000Z" }),
    "TENANT GET /tombstone": () => Response.json({ tombstone: null }),
    "TENANT GET /attention": () => Response.json({ items: [{ id: "item-1" }] }),
    "TENANT GET /pilot/export": () => Response.json({ shop: null, messages: [], replies: [], payments: [], displayNames: [] }),
    "TENANT GET /routines/export": () => Response.json({ team: { paused: false, since: null, members: null },
      routines: [{ id: "rt-1", name: "Morning brief" }], questions: [], runs: [{ routineId: "rt-1", status: "done" }] }),
    "TENANT GET /model/export": () =>
      Response.json({ capOverride: null, months: [{ month: "2026-11", spentMillisatang: 4_200 }], calls: [], holds: [] }),
    "TENANT GET /audit/export": () =>
      Response.json({ entries: [{ id: "aud-entry-1", action: "shop.created" }], missed: null }),
    "TENANT GET /memory/export": () =>
      Response.json({ facts: [{ id: "f1", text: "Closed on Mondays", status: "confirmed" }], forgottenCount: 2 }),
    "TENANT GET /people/export": () =>
      Response.json({ state: { shop: TENANT, ownerId: "owner", helpers: [{ id: "helper-1" }], invites: [], away: null,
        passedOn: [], removed: [] }, names: { "helper-1": "Mint" } }),
    "TENANT GET /artifacts/export": () =>
      Response.json({ artifacts: [{ id: "art-1", title: "Menu", kind: "html", bytes: 12, createdAt: 1, text: "<h1>Menu</h1>" }] }),
    "TENANT POST /pilot/prune": () => Response.json({ messagesPruned: 0 }),
    "TENANT POST /tenant-wipe": () => Response.json({ deletedAt: "2026-09-24T00:00:00.000Z", tasksWiped: 2 }),
    "TASK GET /export": () => Response.json({ task: { id: "unnamed" }, events: [], actions: [], attempts: [] }),
    "TASK:task-a GET /export": () =>
      Response.json({ task: { id: "task-a" }, events: [{ seq: 1 }], actions: [], attempts: [] }),
    "TASK:task-b GET /export": () =>
      Response.json({ task: { id: "task-b" }, events: [], actions: [], attempts: [] }),
    "TASK DELETE /wipe": () => Response.json({ wiped: true }),
    "CRED GET /connections": () => Response.json({ connections: [{ id: "conn-1", provider: "linear" }] }),
    "CRED GET /sign-ins": () => Response.json({ signIns: [{ id: "signin-1", site: "Shopee Seller Centre" }] }),
    "CRED GET /outposts": () => Response.json({ outposts: [{ id: "outpost-1", kind: "this_mac" }] }),
    "CRED POST /tenant-wipe": () => Response.json({ connectionsWiped: 1 }),
    "SCHEDULES GET /schedules": () => Response.json({ schedules: [{ id: "sched-1" }] }),
    "SCHEDULES POST /tenant-wipe": () => Response.json({ schedulesWiped: 1, occurrencesWiped: 3 }),
    "AUTH POST /tenant-wipe": () => Response.json({ sessionsWiped: 1 }),
    "AUTH DELETE /pilot-shops": () => Response.json({ removed: true }),
  };
}

function stubEnv(overrides: Record<string, () => Response> = {}) {
  const table = { ...defaults(), ...overrides };
  const calls: Call[] = [];
  const namespace = (ns: string) => ({
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        calls.push({
          ns,
          name,
          method: request.method,
          path,
          tenant: request.headers.get("x-tenant") ?? "",
          url: request.url,
        });
        const answer = table[`${ns}:${name} ${request.method} ${path}`] ?? table[`${ns} ${request.method} ${path}`];
        return answer ? answer() : Response.json({ error: "unexpected_call" }, { status: 599 });
      },
    }),
  });
  const env = {
    TASK: namespace("TASK"),
    AUTH: namespace("AUTH"),
    CRED: namespace("CRED"),
    SCHEDULES: namespace("SCHEDULES"),
    TENANT: namespace("TENANT"),
  } as unknown as TenantDataEnv;
  const reached = (ns: string, method: string, path: string) =>
    calls.some((call) => call.ns === ns && call.method === method && call.path === path);
  return { env, calls, reached };
}

const fail = () => Response.json({ error: "boom" }, { status: 500 });

describe("tenant deletion fan-out", () => {
  it("wipes in order and reports every count", async () => {
    const { env, calls } = stubEnv();
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tasksWiped: 2,
      connectionsWiped: 1,
      schedulesWiped: 1,
      occurrencesWiped: 3,
      sessionsWiped: 1,
      deletedAt: "2026-09-24T00:00:00.000Z",
    });
    // Data first, sessions next, then the index and tombstone, and last of all the shop's row in the operator's list.
    expect(calls.filter((call) => call.method !== "GET").map((call) => `${call.ns} ${call.path}`)).toEqual([
      "TASK /wipe",
      "TASK /wipe",
      "CRED /tenant-wipe",
      "SCHEDULES /tenant-wipe",
      "AUTH /tenant-wipe",
      "TENANT /tenant-wipe",
      "AUTH /pilot-shops",
    ]);
    // The row is the caller's own, named by the tenant the deletion runs for.
    expect(calls.at(-1)?.url).toBe(`https://auth/pilot-shops?tenant=${encodeURIComponent(TENANT)}`);
  });

  it("keeps the shop on the operator's list when its own object's wipe fails", async () => {
    const { env, reached } = stubEnv({ "TENANT POST /tenant-wipe": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "wipe_incomplete", tasksWiped: 2, failed: ["index"] });
    expect(reached("AUTH", "DELETE", "/pilot-shops")).toBe(false);
  });

  it("names the registry when only taking the shop off the list fails, after the tombstone", async () => {
    const { env, reached } = stubEnv({ "AUTH DELETE /pilot-shops": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "wipe_incomplete", tasksWiped: 2, failed: ["registry"] });
    expect(reached("TENANT", "POST", "/tenant-wipe")).toBe(true);
  });

  it("fails loudly when the credential vault wipe fails, and keeps the session and index", async () => {
    const { env, reached } = stubEnv({ "CRED POST /tenant-wipe": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "wipe_incomplete", tasksWiped: 2, failed: ["connections"] });
    expect(reached("AUTH", "POST", "/tenant-wipe")).toBe(false);
    expect(reached("TENANT", "POST", "/tenant-wipe")).toBe(false);
  });

  it("fails loudly when the schedule wipe fails, and keeps the session and index", async () => {
    const { env, reached } = stubEnv({ "SCHEDULES POST /tenant-wipe": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "wipe_incomplete", tasksWiped: 2, failed: ["schedules"] });
    expect(reached("AUTH", "POST", "/tenant-wipe")).toBe(false);
    expect(reached("TENANT", "POST", "/tenant-wipe")).toBe(false);
  });

  it("names both parts when connections and schedules both fail", async () => {
    const { env } = stubEnv({ "CRED POST /tenant-wipe": fail, "SCHEDULES POST /tenant-wipe": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { failed?: string[] }).failed).toEqual(["connections", "schedules"]);
  });

  it("wipes nothing when the task index cannot be read", async () => {
    const { env, calls } = stubEnv({ "TENANT GET /index": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "wipe_incomplete", tasksWiped: 0, failed: ["index-read"] });
    // An unreadable index is not an empty one: no wipe of any kind runs.
    expect(calls.map((call) => `${call.ns} ${call.method} ${call.path}`)).toEqual(["TENANT GET /index"]);
  });

  it("stops before the tombstone when the session wipe fails", async () => {
    const { env, reached } = stubEnv({ "AUTH POST /tenant-wipe": fail });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { failed?: string[] }).failed).toEqual(["sessions"]);
    expect(reached("TENANT", "POST", "/tenant-wipe")).toBe(false);
    expect(reached("AUTH", "DELETE", "/pilot-shops")).toBe(false);
  });
});

describe("tenant export fan-out", () => {
  it("exports every part when every read succeeds", async () => {
    const { env } = stubEnv();
    const response = await tenantExport(env, TENANT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenant?: string;
      tasks?: { task?: { id?: string }; events?: unknown[] }[];
      connections?: unknown[];
      signIns?: unknown[];
      outposts?: unknown[];
      schedules?: unknown[];
      consent?: { cloudWork?: boolean };
      attention?: unknown[];
      model?: { months?: unknown[] };
      audit?: { entries?: unknown[]; missed?: unknown };
      memory?: { facts?: unknown[]; forgottenCount?: number };
      people?: { state?: { helpers?: unknown[] }; names?: unknown };
      routines?: { routines?: unknown[]; runs?: unknown[] };
      artifacts?: unknown[];
    };
    expect(body.tenant).toBe(TENANT);
    expect((body.tasks ?? []).map((entry) => entry.task?.id)).toEqual(TASK_IDS);
    expect((body.tasks ?? []).map((entry) => entry.events)).toEqual([[{ seq: 1 }], []]);
    expect(body.connections).toHaveLength(1);
    // The vault's site sign-ins and outposts, as the operator lists them.
    expect(body.signIns).toEqual([{ id: "signin-1", site: "Shopee Seller Centre" }]);
    expect(body.outposts).toEqual([{ id: "outpost-1", kind: "this_mac" }]);
    expect(body.schedules).toHaveLength(1);
    expect(body.consent?.cloudWork).toBe(true);
    expect(body.attention).toHaveLength(1);
    // The model gateway's meter: what each model call cost the shop.
    expect(body.model?.months).toEqual([{ month: "2026-11", spentMillisatang: 4_200 }]);
    // The shop's audit log: who did what and when.
    expect(body.audit).toEqual({ entries: [{ id: "aud-entry-1", action: "shop.created" }], missed: null });
    // What the team knows about the shop: its facts, and only how many it was told to forget.
    expect(body.memory).toEqual({ facts: [{ id: "f1", text: "Closed on Mondays", status: "confirmed" }], forgottenCount: 2 });
    // The people around the shop: its helpers and the names the owner gave them.
    expect(body.people?.state?.helpers).toEqual([{ id: "helper-1" }]);
    expect(body.people?.names).toEqual({ "helper-1": "Mint" });
    // The team's routines and how each run went.
    expect(body.routines?.routines).toEqual([{ id: "rt-1", name: "Morning brief" }]);
    expect(body.routines?.runs).toEqual([{ routineId: "rt-1", status: "done" }]);
    // The shop's artifact links: each page with its text, never the link itself.
    expect(body.artifacts).toEqual([{ id: "art-1", title: "Menu", kind: "html", bytes: 12, createdAt: 1, text: "<h1>Menu</h1>" }]);
  });

  for (const [route, part] of [
    ["CRED GET /connections", "connections"],
    ["CRED GET /sign-ins", "signIns"],
    ["CRED GET /outposts", "outposts"],
    ["SCHEDULES GET /schedules", "schedules"],
    ["TENANT GET /consent", "consent"],
    ["TENANT GET /tombstone", "tombstone"],
    ["TENANT GET /attention", "attention"],
    ["TENANT GET /pilot/export", "pilot"],
    ["TENANT GET /routines/export", "routines"],
    ["TENANT GET /model/export", "model"],
    ["TENANT GET /audit/export", "audit"],
    ["TENANT GET /memory/export", "memory"],
    ["TENANT GET /people/export", "people"],
    ["TENANT GET /artifacts/export", "artifacts"],
    ["TENANT GET /index", "index"],
  ] as const) {
    it(`answers export_incomplete when the ${part} read fails`, async () => {
      const { env } = stubEnv({ [route]: fail });
      const response = await tenantExport(env, TENANT);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "export_incomplete", failed: [part] });
    });
  }

  it("tells every cache not to keep the export, whole or incomplete", async () => {
    // The export holds customers' words, their LINE display names, what the team knows and drafts, so a browser
    // or a proxy must never keep a copy of it.
    const whole = await tenantExport(stubEnv().env, TENANT);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("cache-control")).toBe("no-store");
    const incomplete = await tenantExport(stubEnv({ "TASK:task-b GET /export": fail }).env, TENANT);
    expect(incomplete.status).toBe(500);
    expect(incomplete.headers.get("cache-control")).toBe("no-store");
  });

  it("skips a phantom task that answers 404", async () => {
    // The create route indexes before creating, so a failed create leaves an
    // id with no task behind it. That is not missing data.
    const { env } = stubEnv({ "TASK:task-a GET /export": () => Response.json({ error: "not_found" }, { status: 404 }) });
    const response = await tenantExport(env, TENANT);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tasks?: { task?: { id?: string } }[] };
    expect((body.tasks ?? []).map((entry) => entry.task?.id)).toEqual(["task-b"]);
  });

  it("answers export_incomplete when a task read fails", async () => {
    const { env } = stubEnv({ "TASK:task-b GET /export": fail });
    const response = await tenantExport(env, TENANT);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "export_incomplete", failed: ["task-b"] });
  });
});

describe("deletion fan-out ownership headers", () => {
  it("sends the caller's tenant on every task wipe", async () => {
    const { env, calls } = stubEnv();
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(200);
    const wipes = calls.filter((call) => call.ns === "TASK" && call.path === "/wipe");
    expect(wipes).toHaveLength(2);
    // Without the tenant on the wipe, the task object cannot tell a planted
    // foreign id from the caller's own work.
    expect(wipes.every((call) => call.tenant === TENANT)).toBe(true);
  });

  it("treats a notOwned wipe as neither wiped nor failed, and keeps deleting", async () => {
    const { env, reached } = stubEnv({
      "TASK:task-a DELETE /wipe": () => Response.json({ wiped: false, notOwned: true }),
    });
    const response = await tenantDelete(env, TENANT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tasksWiped: 1,
      connectionsWiped: 1,
      schedulesWiped: 1,
      occurrencesWiped: 3,
      sessionsWiped: 1,
      deletedAt: "2026-09-24T00:00:00.000Z",
    });
    // A planted foreign id must not wedge the caller's own deletion: the
    // fan-out continues through sessions, and the index still goes last.
    expect(reached("AUTH", "POST", "/tenant-wipe")).toBe(true);
    expect(reached("TENANT", "POST", "/tenant-wipe")).toBe(true);
  });

  it("treats a notOwned prune as neither pruned nor failed", async () => {
    const { env } = stubEnv({
      "TASK POST /prune": () => Response.json({ wiped: false, notOwned: true }),
    });
    const response = await tenantPrune(env, TENANT, 1_000_000);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasksPruned: 0, attemptsPruned: 0, actionsPruned: 0 });
  });
});

/// Ownership against the real Durable Objects. The stub above cannot show
/// what TaskObject does with a planted foreign id, so these drive the actual
/// objects the way the worker and the schedule alarms do: direct object calls
/// carrying only worker-set headers.
type ObjectNamespace = {
  idFromName(id: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
type ProbeStorage = {
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
};

let ownershipCounter = 0;
const freshTenant = (label: string) => `apple:s10-own-${label}-${Date.now()}-${ownershipCounter++}`;

function realEnv(): TenantDataEnv {
  const bindings = env as unknown as Record<string, ObjectNamespace>;
  return {
    TASK: bindings.TASK!,
    AUTH: bindings.AUTH!,
    CRED: bindings.CRED!,
    SCHEDULES: bindings.SCHEDULES!,
    TENANT: bindings.TENANT!,
  } as unknown as TenantDataEnv;
}

function taskStub(id: string): { fetch(request: Request): Promise<Response> } {
  const bindings = env as unknown as { TASK: ObjectNamespace };
  return bindings.TASK.get(bindings.TASK.idFromName(id));
}

async function putTask(id: string, tenant: string, state: string): Promise<Response> {
  return taskStub(id).fetch(
    new Request("https://task/", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tenant": tenant },
      body: JSON.stringify({
        id,
        title: "Owned work",
        objective: "Do the owned work.",
        state,
        location: "cloud",
        funding: "cloudBYOK",
        criteria: [],
        updatedAt: new Date().toISOString(),
      }),
    }),
  );
}

async function readTask(id: string, tenant: string): Promise<Response> {
  return taskStub(id).fetch(new Request("https://task/", { headers: { "x-tenant": tenant } }));
}

async function plantInIndex(tenant: string, taskId: string): Promise<void> {
  const bindings = env as unknown as { TENANT: ObjectNamespace };
  const stub = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
  const response = await stub.fetch(
    new Request("https://tenant/index", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant, taskId }),
    }),
  );
  expect(response.ok).toBe(true);
}

describe("tenant deletion ownership", () => {
  it("leaves a planted foreign task alone while deleting the caller's own", async () => {
    const owner = freshTenant("owner");
    const deleter = freshTenant("deleter");
    const foreignId = `s10-foreign-${crypto.randomUUID()}`;
    const ownId = `s10-own-${crypto.randomUUID()}`;
    expect((await putTask(foreignId, owner, "draft")).status).toBe(200);
    // A second write bumps the revision, so "same rev" also proves the
    // survivor was not silently rewritten.
    expect((await putTask(foreignId, owner, "queued")).status).toBe(200);
    expect((await putTask(ownId, deleter, "draft")).status).toBe(200);
    // The deleter's index holds the owner's id, the way a planted or
    // mis-attributed index entry would.
    await plantInIndex(deleter, foreignId);
    await plantInIndex(deleter, ownId);

    const response = await tenantDelete(realEnv(), deleter);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { tasksWiped?: number }).tasksWiped).toBe(1);

    const survivor = await readTask(foreignId, owner);
    expect(survivor.status).toBe(200);
    expect(((await survivor.json()) as { rev?: number }).rev).toBe(2);
    // The caller's own data is still fully removed.
    expect((await readTask(ownId, deleter)).status).toBe(404);
  });

  it("leaves a planted foreign task's attempts alone when pruning", async () => {
    const owner = freshTenant("prune-owner");
    const sweeper = freshTenant("prune-sweeper");
    const foreignId = `s10-prune-${crypto.randomUUID()}`;
    expect((await putTask(foreignId, owner, "queued")).status).toBe(200);
    const claim = await taskStub(foreignId).fetch(
      new Request("https://task/attempts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": owner },
        body: JSON.stringify({ executorId: "exec-1", inputRevision: "rev-1" }),
      }),
    );
    expect(claim.status).toBe(200);
    const attempt = (await claim.json()) as { id: string; fence: number };
    expect(
      (
        await taskStub(foreignId).fetch(
          new Request(`https://task/attempts/${attempt.id}/finish`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-tenant": owner },
            body: JSON.stringify({ fence: attempt.fence, outcome: "done" }),
          }),
        )
      ).status,
    ).toBe(200);
    // Age the attempt past the 30-day ops window the sweep enforces, the way
    // time would; there is no test backdoor for the server clock.
    await runInDurableObject(taskStub(foreignId) as never, async (_instance: unknown, state: {
      storage: ProbeStorage;
    }) => {
      for (const [key, value] of await state.storage.list<Record<string, unknown>>({ prefix: "attempt:" })) {
        await state.storage.put(key, {
          ...value,
          finishedAt: (value.finishedAt as number) - 40 * 24 * 3600,
        });
      }
    });
    await plantInIndex(sweeper, foreignId);

    const response = await tenantPrune(realEnv(), sweeper, Date.now());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasksPruned: 0, attemptsPruned: 0 });
    const kept = await runInDurableObject(taskStub(foreignId) as never, async (_instance: unknown, state: {
      storage: ProbeStorage;
    }) => [...(await state.storage.list({ prefix: "attempt:" })).keys()]);
    expect(kept).toHaveLength(1);
  });
});
