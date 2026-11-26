import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FactSource } from "@manut/shop-memory";
import type { Env } from "../src/index";
import { proposeFact, usableFacts } from "../src/memory";
import { tenantCall, type TenantDataEnv } from "../src/tenant-data";

// What a worker may read of a shop's memory (memory.ts, `usableFacts`): only what the owner's own data says or the
// owner confirmed. A fact a customer told the team waits for the owner's "It's true", and until then it never reaches a
// worker, so it can never reach a model. Tested against the real TenantObject in workerd, and against stand-in objects
// that fail, because a worker's job must hear that its memory could not be read rather than run as if the shop had none.

const bindings = env as unknown as Env;

let counter = 0;
const freshTenant = (label: string) => `memory-read:${label}-${Date.now()}-${counter++}`;

const CUSTOMER: FactSource = { kind: "customer", chat: "line:Ucustomer0007" };

/// The owner's own fact, as the operator relays it ("Tell Buddy something to remember").
async function remember(tenant: string, text: string) {
  const response = await tenantCall(bindings, tenant, "/memory/remember", { method: "POST",
    headers: { "content-type": "application/json", "x-memory": "1" },
    body: JSON.stringify({ tenant, text, nowMs: Date.now() }) });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string };
}

async function confirm(tenant: string, id: string) {
  const response = await tenantCall(bindings, tenant, "/memory/confirm", { method: "POST",
    headers: { "content-type": "application/json", "x-memory": "1" },
    body: JSON.stringify({ tenant, id, nowMs: Date.now() }) });
  expect(response.status).toBe(200);
}

describe("the facts a worker may use", () => {
  it("are the confirmed ones only, oldest first, and never one still waiting for the owner", async () => {
    const tenant = freshTenant("confirmed-only");
    await remember(tenant, "We open at 9 every day.");
    const waiting = await proposeFact(bindings, tenant, "Delivery is free for everyone.", CUSTOMER);
    expect(waiting).toMatchObject({ ok: true, fact: { status: "waiting" } });
    const fromOrders = await proposeFact(bindings, tenant, "Most orders are for som tam.", { kind: "orders", days: 30 });
    expect(fromOrders).toMatchObject({ ok: true, fact: { status: "confirmed" } });

    const read = await usableFacts(bindings, tenant);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.facts.map((fact) => [fact.text, fact.status])).toEqual([
      ["We open at 9 every day.", "confirmed"],
      ["Most orders are for som tam.", "confirmed"],
    ]);
    expect(JSON.stringify(read.facts)).not.toContain("Delivery is free");

    // Once the owner says "It's true", the customer's fact is the shop's, and a worker may use it.
    if (!waiting.ok) return;
    await confirm(tenant, waiting.fact.id);
    const after = await usableFacts(bindings, tenant);
    expect(after.ok && after.facts.map((fact) => fact.text)).toEqual([
      "We open at 9 every day.", "Delivery is free for everyone.", "Most orders are for som tam.",
    ]);
  });

  it("are none for a shop the team knows nothing about", async () => {
    expect(await usableFacts(bindings, freshTenant("empty"))).toEqual({ ok: true, facts: [] });
  });

  it("are refused for a tenant that is not one, and unavailable when the shop's object fails", async () => {
    expect(await usableFacts(bindings, "")).toEqual({ ok: false, error: "invalid_request" });
    for (const answer of [
      async () => { throw new Error("fixture_unreachable"); },
      async () => Response.json({ error: "boom" }, { status: 500 }),
      async () => Response.json({ facts: "not a list" }),
      async () => new Response("not json"),
    ]) {
      const stand = { TENANT: { idFromName: (name: string) => name, get: () => ({ fetch: answer }) } } as unknown as
        Pick<TenantDataEnv, "TENANT">;
      expect(await usableFacts(stand, freshTenant("failing"))).toEqual({ ok: false, error: "memory_unavailable" });
    }
  });

  it("skips a stored fact that is not whole rather than handing it to a worker", async () => {
    const stand = { TENANT: { idFromName: (name: string) => name, get: () => ({ fetch: async () => Response.json({
      facts: [
        { id: "f1", text: "We open at 9.", status: "confirmed", createdAt: 1, updatedAt: 1, source: { kind: "owner" } },
        { id: "f2", text: 42, status: "confirmed", createdAt: 2, updatedAt: 2, source: { kind: "owner" } },
        { id: "f3", text: "Waiting one.", status: "waiting", createdAt: 3, updatedAt: 3,
          source: { kind: "customer", chat: "line:U1" } },
        null,
      ],
      forgottenCount: 0,
    }) }) } } as unknown as Pick<TenantDataEnv, "TENANT">;
    const read = await usableFacts(stand, freshTenant("malformed"));
    expect(read.ok && read.facts.map((fact) => fact.id)).toEqual(["f1"]);
  });
});
