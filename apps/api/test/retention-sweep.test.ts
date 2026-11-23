import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { actionAgeMs, isPrunableAction, isPrunableAttempt, RETENTION } from "../src/retention";

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 1);
const old = T0 - 31 * DAY;
const fresh = T0;

// The sweep enforces the retention windows on call (the scheduled trigger
// arrives with durable routines). Age math is proven on pure predicates
// below; the worker tests prove the wiring is operator-gated, fans out per
// tenant, and never prunes fresh records. End-to-end deletion of a 30-day-old
// record is not simulated: the server clock cannot be moved in tests, and no
// test backdoor exists by design.

describe("retention sweep predicates", () => {
  it("prunes finished attempts past the ops window, nothing else", () => {
    expect(isPrunableAttempt({ status: "done", finishedAt: old / 1000 }, T0)).toBe(true);
    expect(isPrunableAttempt({ status: "done", finishedAt: fresh / 1000 }, T0)).toBe(false);
    expect(isPrunableAttempt({ status: "active", finishedAt: old / 1000 }, T0)).toBe(false);
    expect(isPrunableAttempt({ status: "done" }, T0)).toBe(false);
    expect(isPrunableAttempt({ status: "done", finishedAt: "yesterday" }, T0)).toBe(false);
  });

  it("prunes only rejected and expired proposals past the window", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(isPrunableAction({ state: "rejected", proposedAt: iso(old) }, T0)).toBe(true);
    expect(isPrunableAction({ state: "expired", expiresAt: iso(old) }, T0)).toBe(true);
    expect(isPrunableAction({ state: "rejected", proposedAt: iso(fresh) }, T0)).toBe(false);
    // Receipts and reconciliation evidence stay whatever their age.
    for (const state of ["confirmed", "failed", "unknown", "proposed", "approved", "dispatching"]) {
      expect(isPrunableAction({ state, proposedAt: iso(old) }, T0)).toBe(false);
    }
    expect(isPrunableAction({ state: "rejected" }, T0)).toBe(false);
    expect(isPrunableAction({ state: "expired", expiresAt: "not-a-date" }, T0)).toBe(false);
  });

  it("ages an action by its latest known timestamp", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(
      actionAgeMs({ state: "rejected", proposedAt: iso(old), approval: { at: iso(fresh) } }),
    ).toBe(fresh);
    expect(actionAgeMs({ state: "expired" })).toBe(null);
  });

  it("keeps the chartered windows", () => {
    expect(RETENTION.sourceSnapshotDays).toBe(7);
    expect(RETENTION.opsMetadataDays).toBe(30);
  });
});

const OPERATOR = { authorization: "Bearer test-key" };
let SESSION = { authorization: "" };
beforeEach(async () => { SESSION = await tenantSession(TENANT); });
const TENANT = "prune-tenant";

let counter = 7000;
const freshID = () => `prune-task-${Date.now()}-${counter++}`;

async function prune(tenant: unknown, headers: Record<string, string> = {}) {
  return adminFetch("https://test/v1/admin/prune", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ tenant }),
  });
}

describe("retention sweep route", () => {
  it("keeps the sweep on the operator key", async () => {
    expect((await adminFetch("https://test/v1/admin/prune", { method: "POST" })).status).toBe(403);
    const wrong = await prune(TENANT, { authorization: "Bearer test-key-wrong" });
    expect(wrong.status).toBe(403);
  });

  it("refuses a missing or invalid tenant", async () => {
    // Tenants are opaque subjects: only empty, missing and over-long values
    // are refused. Odd-but-bounded strings sweep an empty index cleanly.
    for (const tenant of [undefined, "", "x".repeat(257)]) {
      const response = await prune(tenant, OPERATOR);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error?: string }).error).toBe("tenant_required");
    }
    const odd = await prune("../x", OPERATOR);
    expect(odd.status).toBe(200);
  });

  it("sweeps an empty tenant cleanly", async () => {
    const response = await prune(`empty-${Date.now()}`, OPERATOR);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tasksPruned?: number;
      attemptsPruned?: number;
      actionsPruned?: number;
    };
    expect(body.tasksPruned).toBe(0);
    expect(body.attemptsPruned).toBe(0);
    expect(body.actionsPruned).toBe(0);
  });

  it("leaves fresh attempts and rejected proposals in place", async () => {
    const id = freshID();
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION, "idempotency-key": `prune-${id}` },
      body: JSON.stringify({
        id,
        title: "Prune check",
        objective: "Nothing old here.",
        state: "draft",
        location: "cloud",
        funding: "cloudBYOK",
        criteria: [],
        updatedAt: new Date().toISOString(),
        tenantId: TENANT,
      }),
    });
    expect(created.status).toBe(200);
    const claimed = (await (
      await SELF.fetch(`https://test/v1/tasks/${id}/attempts`, {
        method: "POST",
        headers: { "content-type": "application/json", ...SESSION },
        body: JSON.stringify({ executorId: "e", inputRevision: "r" }),
      })
    ).json()) as { id: string; fence: string };
    const finished = await SELF.fetch(`https://test/v1/tasks/${id}/attempts/${claimed.id}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json", ...SESSION },
      body: JSON.stringify({ fence: claimed.fence, outcome: "done" }),
    });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as { finishedAt?: number }).finishedAt).toBeGreaterThan(0);

    const swept = await prune(TENANT, OPERATOR);
    expect(swept.status).toBe(200);
    const body = (await swept.json()) as { attemptsPruned?: number; actionsPruned?: number };
    expect(body.attemptsPruned).toBe(0);
    expect(body.actionsPruned).toBe(0);
  });
});
