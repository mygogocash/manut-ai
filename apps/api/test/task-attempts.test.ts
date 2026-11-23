import { tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AttemptJSON, StepJSON, TaskRecordJSON } from "../src/task-object";

let AUTH = { authorization: "" };
const FIXTURE_TENANT = "apple:attempt-fixture";
beforeEach(async () => { AUTH = await tenantSession(FIXTURE_TENANT); });

let counter = 5000;
const freshID = () => `exec-task-${Date.now()}-${counter++}`;

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

async function create(id: string, key: string) {
  return SELF.fetch("https://test/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "idempotency-key": key },
    body: JSON.stringify(draft(id)),
  });
}

async function claim(id: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://test/v1/tasks/${id}/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  });
}

async function act(id: string, attempt: string, action: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://test/v1/tasks/${id}/attempts/${attempt}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
  });
}

async function attemptOf(response: Response): Promise<AttemptJSON> {
  return (await response.json()) as AttemptJSON;
}

describe("attempt ownership", () => {
  it("keeps legacy numeric attempts readable but requires a fresh claim to write", async () => {
    const id = freshID();
    expect((await create(id, "exec-legacy")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const ns = (env as unknown as { TASK: { idFromName(id: string): unknown; get(id: unknown): unknown } }).TASK;
    await runInDurableObject(ns.get(ns.idFromName(id)) as never, async (_instance: unknown, state: {
      storage: { put(key: string, value: unknown): Promise<void> };
    }) => {
      await state.storage.put(`attempt:${a.id}`, { ...a, fence: 1 });
    });
    for (const action of ["heartbeat", "steps", "finish"]) {
      const refused = await act(id, a.id, action, {
        fence: 1, outcome: "done", step: { id: "s", name: "s", status: "done" },
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: "fence_mismatch" });
    }
    const stub = ns.get(ns.idFromName(id)) as { fetch(request: Request): Promise<Response> };
    const exported = await stub.fetch(new Request("https://task/export"));
    expect(exported.status).toBe(200);
    const record = await exported.json() as { attempts: AttemptJSON[] };
    expect(record.attempts).toContainEqual(expect.objectContaining({ id: a.id, fence: 1 }));
    const next = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    expect((await act(id, next.id, "heartbeat", { fence: next.fence })).status).toBe(200);
    expect((await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: AUTH })).status).toBe(200);
  });

  it("rejects a sequential token guess without returning the real token", async () => {
    const id = freshID();
    expect((await create(id, "exec-guess")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const guessed = await act(id, a.id, "heartbeat", { fence: 1 });
    expect(guessed.status).toBe(409);
    expect(await guessed.json()).toEqual({ error: "fence_mismatch" });
  });

  it("mints fenced attempts with leases and budgets", async () => {
    const id = freshID();
    expect((await create(id, "exec-1")).status).toBe(200);
    const first = await claim(id, { executorId: "exec-a", inputRevision: "rev-1", model: "pilot-model" });
    expect(first.status).toBe(200);
    const a = await attemptOf(first);
    expect(a.fence).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(a.steps).toEqual([]);
    expect(a.leaseUntil).toBeGreaterThan(Date.now() / 1000);
    expect(a.model).toBe("pilot-model");
    const second = await claim(id, { executorId: "exec-b", inputRevision: "rev-1" });
    const next = await attemptOf(second);
    expect(next.fence).toEqual(expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(next.fence).not.toBe(a.fence);
  });

  it("validates claims", async () => {
    const id = freshID();
    expect((await create(id, "exec-2")).status).toBe(200);
    expect((await claim(id, { inputRevision: "r" })).status).toBe(400);
    expect((await claim(id, { executorId: "e", inputRevision: "r", maxSteps: 0 })).status).toBe(400);
    expect((await claim(id, { executorId: "e", inputRevision: "r", maxActiveSeconds: 5 })).status).toBe(400);
  });

  it("extends leases on matching fences and rejects strangers", async () => {
    const id = freshID();
    expect((await create(id, "exec-3")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const before = a.leaseUntil;
    const heartbeat = await act(id, a.id, "heartbeat", { fence: a.fence });
    expect(heartbeat.status).toBe(200);
    expect((await attemptOf(heartbeat)).leaseUntil).toBeGreaterThanOrEqual(before);
    const stranger = await act(id, a.id, "heartbeat", { fence: "not-the-attempt-token" });
    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toEqual({ error: "fence_mismatch" });
    const sequentialGuess = await act(id, a.id, "heartbeat", { fence: 1 });
    expect(sequentialGuess.status).toBe(409);
    expect(await sequentialGuess.json()).toEqual({ error: "fence_mismatch" });
  });

  it("replays known steps instead of duplicating them", async () => {
    const id = freshID();
    expect((await create(id, "exec-4")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const step = { id: "read-mail", name: "Read approved mail", status: "done" };
    const first = await act(id, a.id, "steps", { fence: a.fence, step });
    expect(first.status).toBe(200);
    const replay = await act(id, a.id, "steps", { fence: a.fence, step });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { replayed?: boolean }).replayed).toBe(true);
    const attempt = await attemptOf(
      await act(id, a.id, "heartbeat", { fence: a.fence }),
    );
    expect(attempt.steps.map((entry: StepJSON) => entry.id)).toEqual(["read-mail"]);
  });

  it("stops new steps at the attempt budget", async () => {
    const id = freshID();
    expect((await create(id, "exec-5")).status).toBe(200);
    const a = await attemptOf(
      await claim(id, { executorId: "e", inputRevision: "r", maxSteps: 1 }),
    );
    expect((await act(id, a.id, "steps", { fence: a.fence, step: { id: "s1", name: "One", status: "done" } })).status).toBe(
      200,
    );
    const over = await act(id, a.id, "steps", { fence: a.fence, step: { id: "s2", name: "Two", status: "done" } });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error?: string }).error).toBe("budget_exhausted");
  });

  it("closes finished attempts to further writes", async () => {
    const id = freshID();
    expect((await create(id, "exec-6")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const finished = await act(id, a.id, "finish", { fence: a.fence, outcome: "done" });
    expect(finished.status).toBe(200);
    expect((await attemptOf(finished)).outcome).toBe("done");
    const late = await act(id, a.id, "heartbeat", { fence: a.fence });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error?: string }).error).toBe("stale_attempt");
  });

  it("records a failed finish as failed, not as a clean one", async () => {
    const id = freshID();
    expect((await create(id, "exec-9")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const finished = await act(id, a.id, "finish", { fence: a.fence, outcome: "failed" });
    expect(finished.status).toBe(200);
    const record = await attemptOf(finished);
    expect(record.status).toBe("done");
    expect(record.outcome).toBe("failed");
    const late = await act(id, a.id, "heartbeat", { fence: a.fence });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error?: string }).error).toBe("stale_attempt");
  });
});

async function errorOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: string }).error;
}

async function command(id: string, type: string, key: string) {
  return SELF.fetch(`https://test/v1/tasks/${id}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH, "idempotency-key": key },
    body: JSON.stringify({ type }),
  });
}

describe("attempts on settled tasks", () => {
  it("stops a stale executor once the task is cancelled, but lets it close its attempt", async () => {
    const id = freshID();
    expect((await create(id, "exec-10")).status).toBe(200);
    const a = await attemptOf(await claim(id, { executorId: "e", inputRevision: "r" }));
    const cancelled = await command(id, "cancel", "exec-10-cancel");
    expect(cancelled.status).toBe(200);

    // The lease cannot be extended and no step lands on a cancelled task.
    const heartbeat = await act(id, a.id, "heartbeat", { fence: a.fence });
    expect(heartbeat.status).toBe(409);
    expect(await errorOf(heartbeat)).toBe("task_settled");
    const step = await act(id, a.id, "steps", {
      fence: a.fence,
      step: { id: "late", name: "Late step", status: "done" },
    });
    expect(step.status).toBe(409);
    expect(await errorOf(step)).toBe("task_settled");
    const reclaim = await claim(id, { executorId: "e2", inputRevision: "r" });
    expect(reclaim.status).toBe(409);
    expect(await errorOf(reclaim)).toBe("task_settled");

    // Finish still closes the attempt and keeps the reported outcome, so it
    // is not stranded as active.
    const finished = await act(id, a.id, "finish", { fence: a.fence, outcome: "failed" });
    expect(finished.status).toBe(200);
    const record = await attemptOf(finished);
    expect(record.status).toBe("done");
    expect(record.outcome).toBe("failed");
    expect(record.steps).toEqual([]);
  });

  it("takes no new claims on a completed task", async () => {
    const id = freshID();
    expect((await create(id, "exec-11")).status).toBe(200);
    for (const state of ["queued", "running", "verifying", "completed"]) {
      const criteria = state === "completed" ? [{ id: "c1", text: "Brief exists", satisfied: true, by: "human" }] : [];
      expect(
        (
          state === "completed" ? await trustedTaskPut(id, draft(id, { state, criteria }), FIXTURE_TENANT) :
          await SELF.fetch(`https://test/v1/tasks/${id}`, {
            method: "PUT",
            headers: { "content-type": "application/json", ...AUTH },
            body: JSON.stringify(draft(id, { state, criteria })),
          })
        ).status,
      ).toBe(200);
    }
    const reclaim = await claim(id, { executorId: "e", inputRevision: "r" });
    expect(reclaim.status).toBe(409);
    expect(await errorOf(reclaim)).toBe("task_settled");
  });
});

describe("evidence completion", () => {
  it("refuses satisfied criteria without provenance", async () => {
    const id = freshID();
    expect((await create(id, "exec-7")).status).toBe(200);
    for (const state of ["queued", "running", "verifying"]) {
      expect((await SELF.fetch(`https://test/v1/tasks/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify(draft(id, { state })),
      })).status).toBe(200);
    }
    const claim = await SELF.fetch(`https://test/v1/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(
        draft(id, { state: "completed", criteria: [{ id: "c1", text: "Brief exists", satisfied: true }] }),
      ),
    });
    expect(claim.status).toBe(409);
    expect(((await claim.json()) as { error?: string }).error).toBe("criteria_unverified");
    const model = await SELF.fetch(`https://test/v1/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(
        draft(id, {
          state: "completed",
          criteria: [{ id: "c1", text: "Brief exists", satisfied: true, by: "model-claim" }],
        }),
      ),
    });
    expect(model.status).toBe(409);
    const human = await SELF.fetch(`https://test/v1/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify(
        draft(id, {
          state: "completed",
          criteria: [{ id: "c1", text: "Brief exists", satisfied: true, by: "human" }],
        }),
      ),
    });
    expect(human.status).toBe(400);
    expect(await errorOf(human)).toBe("client_provenance_forbidden");
  });
});

describe("bounded replay", () => {
  it("caps pages and rejects bad limits", async () => {
    const id = freshID();
    expect((await create(id, "exec-8")).status).toBe(200);
    const bad = await SELF.fetch(`https://test/v1/tasks/${id}/events?after=0&limit=5000`, { headers: AUTH });
    expect(bad.status).toBe(400);
    const page = await SELF.fetch(`https://test/v1/tasks/${id}/events?after=0&limit=1`, { headers: AUTH });
    expect(page.status).toBe(200);
    const { events } = (await page.json()) as { events: unknown[] };
    expect(events).toHaveLength(1);
  });
});
