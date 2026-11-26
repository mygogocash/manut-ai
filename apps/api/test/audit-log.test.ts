import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { appendAudit, type AuditEntry, type AuditMissed, type AuditRecord } from "../src/audit-log";
import { tenantCall, tenantDelete, tenantExport } from "../src/tenant-data";

// The shop's audit log in its TenantObject, through the real objects in workerd: the Worker-only append route and
// its rules, the operator's read route with paging, the export, the deletion, and the best-effort writer that never
// fails what it records and counts what it could not write.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };

let counter = 0;
const freshTenant = (label: string) => `audit:${label}-${Date.now()}-${counter++}`;

afterEach(() => {
  vi.restoreAllMocks();
});

const shopCreated = (email: string | null = "ops@manut.test"): AuditRecord => ({
  actor: { kind: "operator", email },
  action: "shop.created",
  subject: {},
  outcome: "ok",
});

/// An append as the Worker makes it, header and all, answering the status and body.
async function append(tenant: string, record: unknown, headers: Record<string, string> = { "x-audit": "1" }) {
  const response = await tenantCall(bindings, tenant, "/audit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ tenant, record }),
  });
  return { status: response.status, body: (await response.json()) as { entry?: AuditEntry; error?: string } };
}

type Page = { entries: AuditEntry[]; next: string | null; missed: AuditMissed | null };

async function page(tenant: string, query = ""): Promise<Page> {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Page;
}

/// An operator call through the admin gate (Access audience, operator key and an exact method), as the console makes
/// it, against `target`.
async function operator<T = Record<string, unknown>>(path: string, target: Env = bindings, method = "GET") {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => ({ email: "ops@manut.test" }) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method, headers: OPERATOR }),
    target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

/// The Worker's environment with the TenantObject's answer to `method path` replaced by a 500 (or a thrown error)
/// for as long as `failing` says. Every other call reaches the real object.
function failingTenant(paths: string[], mode: "status" | "throw" = "status"): Env {
  const namespace = bindings.TENANT;
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.method === "POST" && paths.includes(new URL(request.url).pathname)) {
            if (mode === "throw") throw new Error("fixture_object_unreachable");
            return Response.json({ error: "fixture_call_failed" }, { status: 500 });
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...bindings, TENANT: wrapped };
}

describe("appending to a shop's audit log", () => {
  it("stamps each entry with its own id and time and reads them newest first", async () => {
    const tenant = freshTenant("order");
    const first = await append(tenant, shopCreated());
    expect(first.status).toBe(200);
    expect(first.body.entry).toEqual({
      id: expect.stringMatching(/^aud-[0-9a-z]{9}-[0-9a-z]{3}-[0-9a-f]{8}$/),
      at: expect.any(String),
      actor: { kind: "operator", email: "ops@manut.test" },
      action: "shop.created",
      subject: {},
      outcome: "ok",
    });
    expect(Number.isNaN(Date.parse(first.body.entry!.at))).toBe(false);
    const second = await append(tenant, { actor: { kind: "operator", email: null }, action: "payment.recorded",
      subject: { paymentId: "pay-000000001-000-0a1b2c3d" }, outcome: "ok", amountSatang: 129000 });
    expect(second.status).toBe(200);
    const listed = await page(tenant);
    expect(listed.entries.map((entry) => entry.action)).toEqual(["payment.recorded", "shop.created"]);
    expect(listed.entries[0]).toMatchObject({ amountSatang: 129000, actor: { kind: "operator", email: null } });
    expect(listed.next).toBeNull();
    expect(listed.missed).toBeNull();
  });

  it("pages backwards from a cursor, a page at a time", async () => {
    const tenant = freshTenant("paging");
    for (let i = 0; i < 5; i++) expect((await append(tenant, shopCreated())).status).toBe(200);
    const all = (await page(tenant)).entries.map((entry) => entry.id);
    expect(all).toHaveLength(5);
    expect([...all].sort().reverse()).toEqual(all);
    const one = await page(tenant, "&limit=2");
    expect(one.entries.map((entry) => entry.id)).toEqual(all.slice(0, 2));
    expect(one.next).toBe(all[1]);
    const two = await page(tenant, `&limit=2&before=${one.next}`);
    expect(two.entries.map((entry) => entry.id)).toEqual(all.slice(2, 4));
    const three = await page(tenant, `&limit=2&before=${two.next}`);
    expect(three.entries.map((entry) => entry.id)).toEqual(all.slice(4));
    expect(three.next).toBeNull();
  });

  it("keeps each actor the way the log names people and machines", async () => {
    const tenant = freshTenant("actors");
    const actors = [
      { kind: "owner" },
      { kind: "owner", id: "device-7f3a" },
      { kind: "helper", id: "staff-2" },
      { kind: "worker", attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" },
      { kind: "system" },
    ];
    for (const actor of actors) {
      expect((await append(tenant, { actor, action: "approval.decided", subject: {}, outcome: "approved" })).status)
        .toBe(200);
    }
    expect((await page(tenant)).entries.map((entry) => entry.actor).reverse()).toEqual(actors);
  });

  it("keeps what the team knows about a shop by the fact's id, in each of the memory actions, and never by its words", async () => {
    const tenant = freshTenant("memory");
    const actions = ["memory.remembered", "memory.proposed", "memory.confirmed", "memory.corrected", "memory.forgotten"];
    for (const action of actions) {
      const kept = await append(tenant, { actor: { kind: "operator", email: "ops@manut.test" }, action,
        subject: { factId: "f12" }, outcome: action === "memory.proposed" ? "awaiting_owner" : "ok" });
      expect(kept.status).toBe(200);
      expect(kept.body.entry).toMatchObject({ action, subject: { factId: "f12" } });
    }
    expect((await page(tenant)).entries.map((entry) => entry.action).reverse()).toEqual(actions);
    // An id is ASCII letters, digits and ._:- and nothing a person wrote: not Thai, not a sentence.
    for (const factId of ["ร้านปิดวันจันทร์", "we close on mondays", "", "f".repeat(257)]) {
      expect(await append(tenant, { actor: { kind: "system" }, action: "memory.remembered", subject: { factId }, outcome: "ok" }))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
  });

  it("takes only the Worker's writes, and only metadata: never free text, a name it does not know or a fraction", async () => {
    const tenant = freshTenant("refusals");
    expect((await append(tenant, shopCreated(), {})).status).toBe(403);
    for (const record of [
      { ...shopCreated(), action: "shop.renamed" },
      { ...shopCreated(), outcome: "maybe" },
      { ...shopCreated(), subject: { note: "anything" } },
      { ...shopCreated(), subject: { messageId: "ส่งของให้ด้วยนะคะ" } },
      { ...shopCreated(), subject: { messageId: "two words" } },
      { ...shopCreated(), subject: { messageId: "" } },
      { ...shopCreated(), reason: "the customer said it never arrived" },
      { ...shopCreated(), amountSatang: 12.5 },
      { ...shopCreated(), amountSatang: -100 },
      { ...shopCreated(), actor: { kind: "operator" } },
      { ...shopCreated(), actor: { kind: "customer", id: "U1" } },
      { ...shopCreated(), actor: { kind: "helper" } },
      { ...shopCreated(), actor: { kind: "worker" } },
      { ...shopCreated(), extra: "dropped silently would hide it" },
      "shop.created",
      null,
    ]) {
      expect(await append(tenant, record)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect((await page(tenant)).entries).toEqual([]);
  });

  it("refuses a page it cannot read and a cursor that is not an entry's id", async () => {
    const tenant = freshTenant("bad-query");
    for (const query of ["&limit=0", "&limit=201", "&limit=two", "&limit=1.5", "&before=pay-000000001-000-0a1b2c3d",
      "&before=aud-x"]) {
      const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}${query}`);
      expect(response.status).toBe(400);
    }
  });
});

describe("what the log could not write", () => {
  it("counts each miss with the last one's action and time, and the count travels with the page", async () => {
    const tenant = freshTenant("missed");
    for (const action of ["dispatch.started", "deletion.decided"]) {
      const response = await tenantCall(bindings, tenant, "/audit/missed", {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit": "1" },
        body: JSON.stringify({ tenant, action }),
      });
      expect(response.status).toBe(200);
    }
    expect((await page(tenant)).missed).toEqual({ count: 2, lastAt: expect.any(String), lastAction: "deletion.decided" });
  });

  it("never fails the caller: an append that cannot be stored is counted, and one that cannot be counted is logged", async () => {
    const tenant = freshTenant("best-effort");
    const record: AuditRecord = { actor: { kind: "system" }, action: "dispatch.settled",
      subject: { taskId: "task-1", actionId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" }, outcome: "confirmed" };
    await appendAudit(failingTenant(["/audit"]), tenant, record);
    await appendAudit(failingTenant(["/audit"], "throw"), tenant, record);
    expect(await page(tenant)).toEqual({ entries: [], next: null,
      missed: { count: 2, lastAt: expect.any(String), lastAction: "dispatch.settled" } });

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(appendAudit(failingTenant(["/audit", "/audit/missed"], "throw"), tenant, record)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("dispatch.settled");
    // An append the log refuses as malformed is a miss too, so a bug shows as a count rather than a gap.
    await appendAudit(bindings, tenant, { ...record, reason: "not a code" });
    expect((await page(tenant)).missed?.count).toBe(3);

    await appendAudit(bindings, tenant, record);
    expect((await page(tenant)).entries.map((entry) => entry.action)).toEqual(["dispatch.settled"]);
  });
});

describe("the log in the tenant's export and deletion", () => {
  it("is exported oldest first with its miss count, and deleted with the tenant while the tombstone stays", async () => {
    const tenant = freshTenant("lifecycle");
    expect((await append(tenant, shopCreated())).status).toBe(200);
    expect((await append(tenant, { ...shopCreated(), action: "line.connected",
      subject: { connectionId: "0f8c2b1a-1d4e-4a7b-9c3d-5e6f7a8b9c0d" } })).status).toBe(200);
    await appendAudit(failingTenant(["/audit"]), tenant, shopCreated());

    const exported = (await (await tenantExport(bindings, tenant)).json()) as { audit: { entries: AuditEntry[];
      missed: AuditMissed | null } };
    expect(exported.audit.entries.map((entry) => entry.action)).toEqual(["shop.created", "line.connected"]);
    expect(exported.audit.missed?.count).toBe(1);

    expect((await tenantDelete(bindings, tenant)).status).toBe(200);
    expect(await page(tenant)).toEqual({ entries: [], next: null, missed: null });
    const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
    await runInDurableObject(object, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "audit" })).keys()]).toEqual([]);
      expect(await state.storage.get(`tomb:${tenant}`)).toBeDefined();
    });
  });
});

describe("GET /v1/admin/audit", () => {
  it("answers one tenant's entries newest first, a page at a time, behind the admin gate", async () => {
    const tenant = freshTenant("route");
    for (let i = 0; i < 3; i++) expect((await append(tenant, shopCreated())).status).toBe(200);
    const all = await operator<Page & { tenant: string }>(`/v1/admin/audit?tenant=${encodeURIComponent(tenant)}`);
    expect(all.status).toBe(200);
    expect(all.body.tenant).toBe(tenant);
    expect(all.body.entries).toHaveLength(3);
    const first = await operator<Page>(`/v1/admin/audit?tenant=${encodeURIComponent(tenant)}&limit=2`);
    expect(first.body.entries.map((entry) => entry.id)).toEqual(all.body.entries.slice(0, 2).map((entry) => entry.id));
    const rest = await operator<Page>(
      `/v1/admin/audit?tenant=${encodeURIComponent(tenant)}&limit=2&before=${first.body.next}`);
    expect(rest.body).toEqual({ tenant, entries: all.body.entries.slice(2), next: null, missed: null });
  });

  it("refuses without both credentials, any other method, a missing tenant and a bad page", async () => {
    const tenant = freshTenant("route-refusals");
    const path = `/v1/admin/audit?tenant=${encodeURIComponent(tenant)}`;
    const keyless = await worker.fetch(new Request(`https://api.manut.test${path}`), bindings, createExecutionContext());
    expect(keyless.status).toBe(403);
    expect((await operator(path, bindings, "POST")).status).toBe(404);
    expect((await operator(path, bindings, "DELETE")).status).toBe(404);
    expect(await operator("/v1/admin/audit")).toEqual({ status: 400, body: { error: "tenant_required" } });
    expect(await operator(`${path}&limit=0`)).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await operator(`${path}&before=not-an-entry`)).toEqual({ status: 400, body: { error: "invalid_request" } });
  });

  it("answers 503 when the log cannot be read, rather than an empty page", async () => {
    const tenant = freshTenant("route-down");
    const namespace = bindings.TENANT;
    const down = { ...bindings, TENANT: {
      idFromName: (name: string) => namespace.idFromName(name),
      get: () => ({ fetch: async () => Response.json({ error: "fixture_call_failed" }, { status: 500 }) }),
    } as unknown as DurableObjectNamespace };
    expect(await operator(`/v1/admin/audit?tenant=${encodeURIComponent(tenant)}`, down))
      .toEqual({ status: 503, body: { error: "audit_unavailable" } });
  });
});
