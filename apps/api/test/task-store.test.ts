import { tenantSession } from "./authenticated-fixtures";
import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskDocJSON, TaskEventJSON, TaskRecordJSON } from "../src/task-object";

/// Minimal structural shapes for the test-only storage probe below. The full
/// runtime types live in workerd; importing the workers-types package here
/// drags its entire graph into tsc, so tests stay with these narrow shapes.
type StubNamespace = {
  idFromName(id: string): unknown;
  get(id: unknown): unknown;
};
type ProbeStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

let AUTH = { authorization: "" };
const FIXTURE_TENANT = "apple:store-fixture";
beforeEach(async () => { AUTH = await tenantSession(FIXTURE_TENANT); });

let counter = 1000;
const freshID = () => `store-task-${Date.now()}-${counter++}`;

function draft(id: string, overrides: Partial<TaskRecordJSON> = {}): TaskRecordJSON {
  return {
    id,
    title: "Pilot brief",
    objective: "Prepare the morning brief.",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function stubFor(id: string): unknown {
  const ns = (env as unknown as { TASK: StubNamespace }).TASK;
  return ns.get(ns.idFromName(id));
}

async function withStorage<T>(id: string, fn: (storage: ProbeStorage) => Promise<T>): Promise<T> {
  return runInDurableObject(
    stubFor(id) as never,
    async (_instance: unknown, state: { storage: ProbeStorage }) => fn(state.storage),
  );
}

async function post(body: TaskRecordJSON, key: string) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

async function put(id: string, body: TaskRecordJSON, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://test/v1/tasks/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...AUTH, ...headers },
    body: JSON.stringify(body),
  });
}

async function events(id: string, after = 0) {
  return SELF.fetch(`https://test/v1/tasks/${id}/events?after=${after}`, { headers: AUTH });
}

describe("versioned task store", () => {
  it("migrates a prototype record without changing its id", async () => {
    const id = freshID();
    const legacy = draft(id, { state: "running" });
    await withStorage(id, async (storage) => {
      await storage.put("record", legacy);
    });
    const response = await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: AUTH });
    expect(response.status).toBe(200);
    const doc = (await response.json()) as TaskDocJSON;
    expect(doc.id).toBe(id);
    expect(doc.state).toBe("running");
    expect(doc.rev).toBe(1);
    const log = await events(id);
    expect(log.status).toBe(200);
    const { events: entries } = (await log.json()) as { events: TaskEventJSON[] };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ seq: 1, kind: "migrated", to: "running", rev: 1 });
  });

  it("keeps the legacy record readable for rollback", async () => {
    const id = freshID();
    expect((await post(draft(id), "rollback-1")).status).toBe(200);
    expect((await put(id, draft(id, { state: "queued" }), AUTH)).status).toBe(200);
    const record = await withStorage(id, async (storage) => storage.get<TaskRecordJSON>("record"));
    expect(record?.id).toBe(id);
    expect(record?.state).toBe("queued");
    expect(record).not.toHaveProperty("rev");
  });

  it("rejects stale and malformed revisions", async () => {
    const id = freshID();
    expect((await post(draft(id), "rev-1")).status).toBe(200);
    const first = await put(id, draft(id, { state: "queued" }), { "x-expected-rev": "1" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as TaskDocJSON).rev).toBe(2);
    const stale = await put(id, draft(id, { state: "queued" }), { "x-expected-rev": "1" });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error?: string; current?: number }).error).toBe("stale_revision");
    const malformed = await put(id, draft(id), { "x-expected-rev": "tomorrow" });
    expect(malformed.status).toBe(400);
  });

  it("lets exactly one concurrent writer win on the same revision", async () => {
    const id = freshID();
    expect((await post(draft(id), "rev-2")).status).toBe(200);
    const [a, b] = await Promise.all([
      put(id, draft(id, { state: "queued" }), { "x-expected-rev": "1" }),
      put(id, draft(id, { state: "queued" }), { "x-expected-rev": "1" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("replays events in order and filters by cursor", async () => {
    const id = freshID();
    expect((await post(draft(id), "replay-1")).status).toBe(200);
    for (const state of ["queued", "running"]) {
      expect((await put(id, draft(id, { state }), AUTH)).status).toBe(200);
    }
    const full = await events(id);
    expect(full.status).toBe(200);
    const { events: entries, floor, tip } = (await full.json()) as {
      events: TaskEventJSON[];
      floor: number;
      tip: number;
    };
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.kind)).toEqual(["created", "state", "state"]);
    expect(floor).toBe(0);
    expect(tip).toBe(3);
    const tail = await events(id, 2);
    const { events: filtered } = (await tail.json()) as { events: TaskEventJSON[] };
    expect(filtered.map((entry) => entry.seq)).toEqual([3]);
    const empty = await events(id, 3);
    expect(((await empty.json()) as { events: TaskEventJSON[] }).events).toEqual([]);
  });

  it("compacts the log and demands resync below the floor", async () => {
    const id = freshID();
    expect((await post(draft(id), "compact-1")).status).toBe(200);
    for (let i = 0; i < 100; i++) {
      const response = await put(id, draft(id), AUTH);
      expect(response.status).toBe(200);
    }
    const stale = await events(id, 0);
    expect(stale.status).toBe(410);
    const demand = (await stale.json()) as { error?: string; floor?: number; tip?: number };
    expect(demand.error).toBe("resync_required");
    expect(demand.floor).toBe(1);
    expect(demand.tip).toBe(101);
    const fresh = await events(id, 1);
    expect(fresh.status).toBe(200);
    const { events: retained } = (await fresh.json()) as { events: TaskEventJSON[] };
    expect(retained).toHaveLength(100);
    expect(retained[0]?.seq).toBe(2);
  });
});
