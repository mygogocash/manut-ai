import { tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskRecordJSON } from "../src/task-object";

let AUTH = { authorization: "" };
const FIXTURE_TENANT = "apple:route-fixture";
beforeEach(async () => { AUTH = await tenantSession(FIXTURE_TENANT); });

let counter = 0;
const freshID = () => `test-task-${Date.now()}-${counter++}`;

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

async function post(body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function put(id: string, body: TaskRecordJSON, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://test/v1/tasks/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as { error?: string };
}

describe("worker routes", () => {
  it("serves health without auth", async () => {
    const response = await SELF.fetch("https://test/v1/health");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok?: boolean }).ok).toBe(true);
  });

  it("rejects unauthenticated task reads with 401, not a construction error", async () => {
    const response = await SELF.fetch("https://test/v1/tasks/anything");
    expect(response.status).toBe(401);
    expect((await errorOf(response)).error).toBe("unauthorized");
  });

  it("rejects a wrong bearer key with 401", async () => {
    const response = await SELF.fetch("https://test/v1/tasks/anything", {
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await SELF.fetch("https://test/v1/tasks/anything", {
      headers: { ...AUTH, "content-type": "application/json" },
      method: "PUT",
      body: "x".repeat(257 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it("requires an idempotency key to create", async () => {
    const response = await post(draft(freshID()), AUTH);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("idempotency_key_required");
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await post("not json{", { ...AUTH, "idempotency-key": "k1" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("invalid_json");
  });

  it("rejects a missing id with 400", async () => {
    const response = await post({ title: "no id" }, { ...AUTH, "idempotency-key": "k2" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("id_required");
  });

  it("rejects non-cloud tasks with 400", async () => {
    const id = freshID();
    const response = await post(draft(id, { location: "local" }), {
      ...AUTH,
      "idempotency-key": "k3",
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("cloud_tasks_only");
  });

  it("answers 404 for unknown routes and tasks", async () => {
    const route = await SELF.fetch("https://test/v1/nope", { headers: AUTH });
    expect(route.status).toBe(404);
    const task = await SELF.fetch(`https://test/v1/tasks/${freshID()}`, { headers: AUTH });
    expect(task.status).toBe(404);
  });
});

async function walk(id: string, states: string[]) {
  for (const state of states) {
    const criteria =
      state === "completed" ? [{ id: "c1", text: "Brief exists", satisfied: true, by: "human" }] : [];
    // Completed-state fixtures come from the trusted object path; a public
    // client cannot supply its own human/check acceptance provenance.
    const response = state === "completed" ? await trustedTaskPut(id, draft(id, { state, criteria }), FIXTURE_TENANT) :
      await put(id, draft(id, { state, criteria }), AUTH);
    expect(response.status).toBe(200);
  }
}

describe("task lifecycle", () => {
  it("creates a draft and replays the same idempotency key", async () => {
    const id = freshID();
    const body = draft(id);
    const first = await post(body, { ...AUTH, "idempotency-key": "create-1" });
    expect(first.status).toBe(200);
    // Byte-identical replay returns the original outcome without new work.
    const replay = await post(body, { ...AUTH, "idempotency-key": "create-1" });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as TaskRecordJSON).id).toBe(id);
  });

  it("answers 409 when a second key tries to create the same id", async () => {
    const id = freshID();
    const first = await post(draft(id), { ...AUTH, "idempotency-key": "create-2a" });
    expect(first.status).toBe(200);
    const clash = await post(draft(id), { ...AUTH, "idempotency-key": "create-2b" });
    expect(clash.status).toBe(409);
    expect((await errorOf(clash)).error).toBe("already_exists");
  });

  it("rejects route/body id mismatches with 400", async () => {
    const response = await put(freshID(), draft(freshID()), AUTH);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).error).toBe("id_mismatch");
  });

  it("rejects unknown states and funding with 400", async () => {
    const id = freshID();
    const created = await post(draft(id), { ...AUTH, "idempotency-key": "create-3" });
    expect(created.status).toBe(200);
    const badState = await put(id, draft(id, { state: "teleporting" }), AUTH);
    expect(badState.status).toBe(400);
    const badFunding = await put(id, draft(id, { funding: "freeMoney" as never }), AUTH);
    expect(badFunding.status).toBe(400);
  });

  it("refuses completion until every criterion is satisfied", async () => {
    const id = freshID();
    expect((await post(draft(id), { ...AUTH, "idempotency-key": "create-4" })).status).toBe(200);
    await walk(id, ["queued", "running", "verifying"]);
    const bare = await put(id, draft(id, { state: "completed" }), AUTH);
    expect(bare.status).toBe(409);
    const done = await put(
      id,
      draft(id, { state: "completed", criteria: [{ id: "c1", text: "Brief exists", satisfied: true, by: "human" }] }),
      AUTH,
    );
    expect(done.status).toBe(400);
    expect((await errorOf(done)).error).toBe("client_provenance_forbidden");
  });

  it("treats completed as terminal", async () => {
    const id = freshID();
    expect((await post(draft(id), { ...AUTH, "idempotency-key": "create-5" })).status).toBe(200);
    await walk(id, ["queued", "running", "verifying", "completed"]);
    const backtrack = await put(id, draft(id, { state: "running" }), AUTH);
    expect(backtrack.status).toBe(409);
    expect(((await backtrack.json()) as { error?: string }).error).toBe("illegal_transition");
  });

  it("fails managed billing closed with 403", async () => {
    const id = freshID();
    expect((await post(draft(id), { ...AUTH, "idempotency-key": "create-6" })).status).toBe(200);
    await walk(id, ["queued", "running"]);
    const response = await put(id, draft(id, { state: "running", funding: "managedAI" }), AUTH);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).error).toBe("managed_billing_not_configured");
  });

  it("rate-limits hot writers with 429", async () => {
    const id = freshID();
    expect((await post(draft(id), { ...AUTH, "idempotency-key": "create-7" })).status).toBe(200);
    // The create above consumes one of the 120 writes/minute, so 119 more
    // same-state writes succeed and the 120th tips into 429.
    const statuses: number[] = [];
    for (let i = 0; i < 119; i++) {
      statuses.push((await put(id, draft(id), AUTH)).status);
    }
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect((await put(id, draft(id), AUTH)).status).toBe(429);
  });
});

// Transcribed from SparkTaskState.canTransition in
// GoGoCode/Models/SparkTask.swift, which is the source of truth; same-state
// writes are always legal and are added below, as the Swift function does.
// The Swift suite checks that the Worker's TRANSITIONS table matches Swift,
// and this block checks that the Worker behaves as that table says, so drift
// on either side fails a test.
const LEGAL: Record<string, string[]> = {
  draft: ["queued", "cancelled"],
  queued: ["running", "cancelled", "failed"],
  running: [
    "verifying",
    "waitingForInput",
    "waitingForAuthorization",
    "waitingForProvider",
    "paused",
    "recovering",
    "failed",
    "cancelled",
  ],
  verifying: ["completed", "failed", "running", "paused", "recovering", "cancelled"],
  waitingForInput: ["running", "paused", "cancelled", "failed"],
  waitingForAuthorization: ["running", "paused", "cancelled", "failed"],
  waitingForProvider: ["running", "paused", "cancelled", "failed"],
  paused: ["queued", "running", "cancelled", "failed", "recovering"],
  recovering: ["running", "failed", "cancelled"],
  failed: ["queued", "cancelled"],
  completed: [],
  cancelled: [],
};

const STATES = Object.keys(LEGAL);

/// The PUTs that take a fresh draft to each state along legal edges.
const PATH_TO: Record<string, string[]> = {
  draft: [],
  queued: ["queued"],
  running: ["queued", "running"],
  verifying: ["queued", "running", "verifying"],
  waitingForInput: ["queued", "running", "waitingForInput"],
  waitingForAuthorization: ["queued", "running", "waitingForAuthorization"],
  waitingForProvider: ["queued", "running", "waitingForProvider"],
  paused: ["queued", "running", "paused"],
  recovering: ["queued", "running", "recovering"],
  failed: ["queued", "failed"],
  completed: ["queued", "running", "verifying", "completed"],
  cancelled: ["cancelled"],
};

let tableKey = 0;

async function reach(state: string): Promise<string> {
  const id = freshID();
  expect((await post(draft(id), { ...AUTH, "idempotency-key": `table-${tableKey++}` })).status).toBe(200);
  await walk(id, PATH_TO[state] ?? []);
  return id;
}

/// A PUT to `to`, carrying human-satisfied criteria so a legal move into
/// completed is judged on the transition alone.
function target(id: string, to: string): TaskRecordJSON {
  const criteria = to === "completed" ? [{ id: "c1", text: "Brief exists", satisfied: true, by: "human" }] : [];
  return draft(id, { state: to, criteria });
}

describe("state machine mirrors SparkTaskState.canTransition", () => {
  it("covers every state", () => {
    expect([...STATES].sort()).toEqual(Object.keys(PATH_TO).sort());
    expect(STATES).toHaveLength(12);
  });

  for (const from of STATES) {
    const legal = new Set([from, ...(LEGAL[from] ?? [])]);

    it(`refuses every illegal move out of ${from}`, async () => {
      // Illegal PUTs are refused before the write stamp and leave the task
      // where it was, so one task serves every target.
      const id = await reach(from);
      for (const to of STATES.filter((state) => !legal.has(state))) {
        const response = await trustedTaskPut(id, target(id, to), FIXTURE_TENANT);
        expect({ from, to, status: response.status }).toEqual({ from, to, status: 409 });
        expect(await response.json()).toEqual({ error: "illegal_transition", from, to });
      }
    });

    it(`accepts every legal move out of ${from}`, async () => {
      for (const to of legal) {
        const id = await reach(from);
        const response = await trustedTaskPut(id, target(id, to), FIXTURE_TENANT);
        expect({ from, to, status: response.status }).toEqual({ from, to, status: 200 });
      }
    });
  }
});
