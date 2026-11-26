import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fingerprint, type Fact } from "@manut/shop-memory";
import type { AuditEntry, AuditMissed } from "../src/audit-log";
import type { Env } from "../src/index";
import { tenantCall, tenantDelete, tenantExport } from "../src/tenant-data";

// The shop's TenantObject and its memory paths on their own, without the operator routes in front: who may write,
// what a body or time has to be, what happens when the actor cannot be recorded, and how the shop's memory travels
// with the shop, into its export and out of existence with its deletion.

const bindings = env as unknown as Env;

let counter = 0;
const freshTenant = (label: string) => `memory-store:${label}-${Date.now()}-${counter++}`;

type Door = { facts: Fact[]; forgottenCount: number };

/// A write as the Worker makes it: JSON, and the header only the Worker sets.
function write(tenant: string, path: string, body: unknown, headers: Record<string, string> = { "x-memory": "1" }) {
  return tenantCall(bindings, tenant, path, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function read(tenant: string): Promise<Door> {
  const response = await tenantCall(bindings, tenant, `/memory?tenant=${encodeURIComponent(tenant)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Door;
}

async function remember(tenant: string, text: string, extra: Record<string, unknown> = {}): Promise<Fact> {
  const response = await write(tenant, "/memory/remember", { tenant, text, nowMs: Date.now(), ...extra });
  expect(response.status).toBe(200);
  return (await response.json()) as Fact;
}

async function stored(tenant: string): Promise<[string, unknown][]> {
  const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
  return runInDurableObject(object, async (_instance, state) => [...(await state.storage.list({ prefix: "memory" })).entries()]);
}

async function auditOf(tenant: string): Promise<{ entries: AuditEntry[]; missed: AuditMissed | null }> {
  const response = await tenantCall(bindings, tenant, `/audit/export?tenant=${encodeURIComponent(tenant)}`);
  return (await response.json()) as { entries: AuditEntry[]; missed: AuditMissed | null };
}

describe("the TenantObject's memory paths", () => {
  it("takes a write only with the Worker's header, and a read with just the tenant", async () => {
    const tenant = freshTenant("header");
    const body = { tenant, text: "kept", nowMs: Date.now() };
    for (const headers of [{}, { "x-memory": "0" }, { "x-model": "1" }, { "x-audit": "1" }]) {
      const refused = await write(tenant, "/memory/remember", body, headers);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "forbidden" });
    }
    expect(await read(tenant)).toEqual({ facts: [], forgottenCount: 0 });
    expect((await write(tenant, "/memory/remember", body)).status).toBe(200);
    expect((await read(tenant)).facts.map((fact) => fact.text)).toEqual(["kept"]);
  });

  it("refuses a body, a tenant or a time it cannot use, and a path it does not have, writing nothing", async () => {
    const tenant = freshTenant("bodies");
    const nowMs = Date.now();
    const bad: [string, unknown][] = [
      ["/memory/remember", { tenant, text: "x" }],
      ["/memory/remember", { tenant, text: "x", nowMs: 0 }],
      ["/memory/remember", { tenant, text: "x", nowMs: -5 }],
      ["/memory/remember", { tenant, text: "x", nowMs: 1.5 }],
      ["/memory/remember", { tenant, text: "x", nowMs: "1700000000000" }],
      ["/memory/remember", { text: "x", nowMs }],
      ["/memory/remember", { tenant: "", text: "x", nowMs }],
      ["/memory/remember", { tenant: "t".repeat(257), text: "x", nowMs }],
      ["/memory/remember", [tenant, "x", nowMs]],
      ["/memory/confirm", { tenant, nowMs }],
      ["/memory/confirm", { tenant, id: 4, nowMs }],
      ["/memory/correct", { tenant, id: "f1", text: "x" }],
      ["/memory/forget", { tenant }],
      ["/memory/forget", { tenant, id: "f".repeat(65) }],
    ];
    for (const [path, body] of bad) {
      const response = await write(tenant, path, body);
      expect([path, response.status, await response.json()]).toEqual([path, 400, { error: "invalid_request" }]);
    }
    const unreadable = await write(tenant, "/memory/remember", "{not json");
    expect([unreadable.status, await unreadable.json()]).toEqual([400, { error: "invalid_json" }]);
    const unknown = await write(tenant, "/memory/erase", { tenant, nowMs });
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "not_found" }]);
    expect((await tenantCall(bindings, tenant, "/memory")).status).toBe(400);
    expect((await tenantCall(bindings, tenant, `/memory/nope?tenant=${encodeURIComponent(tenant)}`)).status).toBe(404);
    expect(await read(tenant)).toEqual({ facts: [], forgottenCount: 0 });
    expect(await stored(tenant)).toEqual([]);
    expect((await auditOf(tenant)).entries).toEqual([]);
  });

  it("forgets by id with no time at all, since forgetting is not dated", async () => {
    const tenant = freshTenant("forget-door");
    const fact = await remember(tenant, "to forget");
    const forgotten = await write(tenant, "/memory/forget", { tenant, id: fact.id });
    expect([forgotten.status, await forgotten.json()]).toEqual([200, { id: fact.id }]);
  });

  it("keeps a change whose actor it cannot record, and counts the miss in the same write", async () => {
    const tenant = freshTenant("actor");
    for (const actor of [{ kind: "operator" }, { kind: "customer", id: "U1" }, "ops@manut.test", 7]) {
      await remember(tenant, `kept despite ${JSON.stringify(actor)}`, { actor });
    }
    expect((await read(tenant)).facts).toHaveLength(4);
    const { entries, missed } = await auditOf(tenant);
    expect(entries).toEqual([]);
    expect(missed).toEqual({ count: 4, lastAt: expect.any(String), lastAction: "memory.remembered" });
  });

  it("keeps each shop's whole memory as one stored record, under the memory prefix", async () => {
    const tenant = freshTenant("record");
    await remember(tenant, "one");
    await remember(tenant, "two");
    const rows = await stored(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toMatchObject({ facts: [expect.objectContaining({ text: "one" }), expect.objectContaining({ text: "two" })], forgotten: [] });
  });
});

describe("memory in the tenant's export", () => {
  it("holds every fact, waiting ones included, and only the number of fingerprints", async () => {
    const tenant = freshTenant("export");
    await remember(tenant, "kept");
    const waiting = await write(tenant, "/memory/propose", { tenant, text: "waiting one", nowMs: Date.now(),
      source: { kind: "customer", chat: "line:Ucustomer0002" } });
    expect(waiting.status).toBe(200);
    const gone = await remember(tenant, "gone");
    expect((await write(tenant, "/memory/forget", { tenant, id: gone.id })).status).toBe(200);

    const response = await tenantExport(bindings, tenant);
    expect(response.status).toBe(200);
    const exported = (await response.json()) as { memory: Door };
    expect(exported.memory).toEqual(await read(tenant));
    expect(exported.memory.facts.map((fact) => [fact.text, fact.status])).toEqual([["kept", "confirmed"], ["waiting one", "waiting"]]);
    expect(exported.memory.forgottenCount).toBe(1);
    expect(JSON.stringify(exported)).not.toContain(fingerprint("gone"));
  });

  it("is there for a shop that knows nothing, as an empty memory", async () => {
    const tenant = freshTenant("export-empty");
    const exported = (await (await tenantExport(bindings, tenant)).json()) as { memory: Door };
    expect(exported.memory).toEqual({ facts: [], forgottenCount: 0 });
  });
});

describe("memory when the shop is deleted", () => {
  it("is wiped with the shop, fingerprints included, while the tombstone stays", async () => {
    const tenant = freshTenant("deleted");
    await remember(tenant, "kept");
    const gone = await remember(tenant, "gone");
    expect((await write(tenant, "/memory/forget", { tenant, id: gone.id })).status).toBe(200);
    expect(await stored(tenant)).toHaveLength(1);

    expect((await tenantDelete(bindings, tenant)).status).toBe(200);
    expect(await stored(tenant)).toEqual([]);
    expect(await read(tenant)).toEqual({ facts: [], forgottenCount: 0 });
    const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
    await runInDurableObject(object, async (_instance, state) => {
      expect(await state.storage.get(`tomb:${tenant}`)).toBeDefined();
    });
  });

  it("leaves another shop's memory alone", async () => {
    const mine = freshTenant("delete-mine");
    const yours = freshTenant("delete-yours");
    await remember(mine, "mine");
    await remember(yours, "yours");
    expect((await tenantDelete(bindings, mine)).status).toBe(200);
    expect((await read(yours)).facts.map((fact) => fact.text)).toEqual(["yours"]);
  });
});
