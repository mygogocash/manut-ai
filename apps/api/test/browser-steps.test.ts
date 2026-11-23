import { trustedTaskPut } from "./authenticated-fixtures";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import type { AttemptJSON, TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";

// The step channel (docs/browser-control.md): how a worker's browser step reaches an outpost, and how what the
// outpost did comes back into the attempt's events. The outpost's side is a stub: no browser and no site. The global
// fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Shop = { tenant: string; taskId: string };

/// A shop with consent given and one draft task, indexed for export and deletion.
async function shop(): Promise<Shop> {
  const tenant = fresh("steps:shop");
  const taskId = fresh("steps-task");
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Parcel status", objective: "Read the parcel status.",
    state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() },
  tenant)).status).toBe(200);
  return { tenant, taskId };
}

/// An attempt at the shop's task for `member`, and the port its worker holds.
async function attempt(s: Shop, member: string, flags: JobFlags = on): Promise<WorkerPort> {
  const started = await startAttempt(flowEnv, { tenant: s.tenant, taskId: s.taskId, executorId: member }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  return workerPort(flowEnv, started.job, { flags });
}

function task(taskId: string) {
  return bindings.TASK.get(bindings.TASK.idFromName(taskId));
}

/// The task's own record: its log and its attempts.
async function exported(s: Shop): Promise<{ events: TaskEventJSON[]; attempts: AttemptJSON[] }> {
  const response = await task(s.taskId).fetch(new Request("https://task/export", { headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { events: TaskEventJSON[]; attempts: AttemptJSON[] };
}

describe("an outpost's events in the attempt's log", () => {
  it("are appended only by the control plane, only while the attempt runs, and never extend its lease", async () => {
    const s = await shop();
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;
    const post = (body: unknown, headers: Record<string, string> = { "x-control": "1" }, tenant = s.tenant) =>
      task(s.taskId).fetch(new Request(`https://task/attempts/${attemptId}/outpost-events`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, ...headers }, body: JSON.stringify(body) }));
    const event = { type: "toolUpdated", id: crypto.randomUUID(), update: { status: "completed", output: "" } };
    const leaseOf = async () => (await exported(s)).attempts.find((entry) => entry.id === attemptId)?.leaseUntil;

    // Only the control plane: the outpost never holds the attempt's fence, and nobody else may write for it.
    const stranger = await post({ events: [event] }, {});
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({ error: "forbidden" });

    const lease = await leaseOf();
    const appended = await post({ events: [event] });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({ stored: 1, tip: expect.any(Number) });
    const after = await exported(s);
    expect(after.events.at(-1)).toMatchObject({ kind: "agent", via: `attempt:outpost:${attemptId}`, attemptId, event });
    // An outpost's word is not a sign of the worker's life.
    expect(await leaseOf()).toBe(lease);

    for (const events of [[], [42], [{ type: "" }], "not-a-list", Array.from({ length: 11 }, () => event)]) {
      const refused = await post({ events });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_request" });
    }
    expect((await post({ events: [event] }, { "x-control": "1" }, fresh("steps:other-shop"))).status).toBe(404);
    const unknown = await task(s.taskId).fetch(new Request(`https://task/attempts/${crypto.randomUUID()}/outpost-events`,
      { method: "POST", headers: { "content-type": "application/json", "x-tenant": s.tenant, "x-control": "1" },
        body: JSON.stringify({ events: [event] }) }));
    expect(unknown.status).toBe(404);

    // A lapsed lease, then an ended attempt: the attempt no longer runs, so nothing more lands in its name.
    await runInDurableObject(task(s.taskId), async (_instance, state) => {
      const record = await state.storage.get<AttemptJSON>(`attempt:${attemptId}`);
      await state.storage.put(`attempt:${attemptId}`, { ...record, leaseUntil: Date.now() / 1000 - 1 });
    });
    const lapsed = await post({ events: [event] });
    expect(lapsed.status).toBe(409);
    expect(await lapsed.json()).toEqual({ error: "lease_expired" });
    await runInDurableObject(task(s.taskId), async (_instance, state) => {
      const record = await state.storage.get<AttemptJSON>(`attempt:${attemptId}`);
      await state.storage.put(`attempt:${attemptId}`, { ...record, leaseUntil: Date.now() / 1000 + 300 });
    });
    expect((await nam.finish("done")).ok).toBe(true);
    const ended = await post({ events: [event] });
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ error: "stale_attempt" });
    expect((await exported(s)).events.filter((entry) => entry.via === `attempt:outpost:${attemptId}`)).toHaveLength(1);
  });
});
