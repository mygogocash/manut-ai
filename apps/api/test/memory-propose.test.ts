import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_FACTS, type Fact, type FactSource } from "@manut/shop-memory";
import type { AuditEntry, AuditMissed } from "../src/audit-log";
import worker, { type Env } from "../src/index";
import { proposeFact } from "../src/memory";
import { tenantCall, type TenantDataEnv } from "../src/tenant-data";

// What a worker learns about a shop. `proposeFact` is the one way in for the job flow: a function, with no HTTP route
// (memory-routes.test.ts shows there is none). It is tested here against the real TenantObject in workerd, and against
// stand-in objects that cannot be reached or that fail, because it must never throw into the job it was called from.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };

let counter = 0;
const freshTenant = (label: string) => `memory-propose:${label}-${Date.now()}-${counter++}`;

const CUSTOMER: FactSource = { kind: "customer", chat: "line:Ucustomer0003" };
const ORDERS: FactSource = { kind: "orders", days: 30 };

async function facts(tenant: string): Promise<Fact[]> {
  const response = await tenantCall(bindings, tenant, `/memory?tenant=${encodeURIComponent(tenant)}`);
  return ((await response.json()) as { facts: Fact[] }).facts;
}

async function auditOf(tenant: string): Promise<{ entries: AuditEntry[]; missed: AuditMissed | null }> {
  const response = await tenantCall(bindings, tenant, `/audit/export?tenant=${encodeURIComponent(tenant)}`);
  return (await response.json()) as { entries: AuditEntry[]; missed: AuditMissed | null };
}

/// An operator call through the admin gate: the owner's say over a fact, relayed by the console.
async function admin(path: string, body: unknown) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => ({ email: "ops@manut.test" }) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify(body) }), bindings, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as Fact & { error?: string } };
}

/// Stand-in TenantObjects, and a record of what they were asked.
function standIn(answer: (request: Request) => Promise<Response>) {
  const calls: string[] = [];
  const stand = { TENANT: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return answer(request);
  } }) } } as unknown as Pick<TenantDataEnv, "TENANT">;
  return { stand, calls };
}

describe("what comes from the owner's own data", () => {
  it("is confirmed at once, and keeps where it came from", async () => {
    const tenant = freshTenant("owner-data");
    const sources: FactSource[] = [
      { kind: "document", name: "your price list", date: Date.UTC(2026, 10, 3) },
      { kind: "edits", count: 12 },
      ORDERS,
      { kind: "connection", name: "Google Sheets", detail: "cost sheet" },
    ];
    for (const [i, source] of sources.entries()) {
      expect(await proposeFact(bindings, tenant, `Candles cost 9${i}`, source)).toEqual({ ok: true, fact: {
        id: `f${i + 1}`, text: `Candles cost 9${i}`, status: "confirmed", createdAt: expect.any(Number),
        updatedAt: expect.any(Number), source } });
    }
    expect((await facts(tenant)).map((fact) => fact.source)).toEqual(sources);
  });

  it("keeps only the fields a source's kind has, so nothing else can ride along into the shop's record", async () => {
    const tenant = freshTenant("clean-source");
    const sneaky = { kind: "customer", chat: "line:Ucustomer0005", note: "x".repeat(5_000), text: "another fact" };
    expect(await proposeFact(bindings, tenant, "A fact", sneaky as FactSource)).toMatchObject({ ok: true });
    expect((await facts(tenant)).map((fact) => fact.source)).toEqual([{ kind: "customer", chat: "line:Ucustomer0005" }]);
    // Even the owner's source is only its kind.
    expect(await proposeFact(bindings, tenant, "Another fact", { kind: "owner", said: "anything" } as FactSource)).toMatchObject({ ok: true });
    expect((await facts(tenant)).map((fact) => fact.source)).toEqual([{ kind: "customer", chat: "line:Ucustomer0005" }, { kind: "owner" }]);
  });
});

describe("what a customer said", () => {
  it("waits for the owner, and only the owner's 'It's true' makes it a fact the team may use", async () => {
    const tenant = freshTenant("customer");
    const answer = await proposeFact(bindings, tenant, "Shop is cheaper on Shopee", CUSTOMER);
    expect(answer).toMatchObject({ ok: true, fact: { status: "waiting", source: CUSTOMER } });
    const fact = (answer as { fact: Fact }).fact;
    expect((await facts(tenant)).map((f) => f.status)).toEqual(["waiting"]);

    const confirmed = await admin("/v1/admin/memory/confirm", { tenant, id: fact.id });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ id: fact.id, status: "confirmed", source: CUSTOMER });
  });

  it("is confirmed when the owner's own data says it too, and not when another customer repeats it", async () => {
    const tenant = freshTenant("repeat");
    const waiting = (await proposeFact(bindings, tenant, "Gift wrap is 20", CUSTOMER)) as { ok: true; fact: Fact };
    expect(await proposeFact(bindings, tenant, "gift wrap is 20", { kind: "customer", chat: "line:Ucustomer0004" }))
      .toEqual({ ok: false, reason: "already_known" });
    expect((await facts(tenant))[0]!.status).toBe("waiting");

    const confirmed = await proposeFact(bindings, tenant, "gift wrap is  20", { kind: "orders", days: 14 }, { now: () => 9_000_000_000_000 });
    expect(confirmed).toMatchObject({ ok: true, fact: { id: waiting.fact.id, status: "confirmed", updatedAt: 9_000_000_000_000 } });
    expect(await facts(tenant)).toHaveLength(1);
  });
});

describe("what a proposal is refused for", () => {
  it("answers already_known for a fact the team holds, in any form, even from the owner's data", async () => {
    const tenant = freshTenant("known");
    expect(await proposeFact(bindings, tenant, "Closed on Mondays", ORDERS)).toMatchObject({ ok: true });
    for (const source of [ORDERS, CUSTOMER]) {
      expect(await proposeFact(bindings, tenant, "  closed on  MONDAYS ", source)).toEqual({ ok: false, reason: "already_known" });
    }
  });

  it("answers invalid_text for text that is empty, blank, over 280 characters or not text", async () => {
    const tenant = freshTenant("text");
    for (const text of ["", "   ", "x".repeat(281), 5, null, undefined]) {
      expect(await proposeFact(bindings, tenant, text as unknown as string, ORDERS)).toEqual({ ok: false, reason: "invalid_text" });
    }
    expect(await facts(tenant)).toEqual([]);
  });

  it("answers invalid_source for a source the package or this store cannot keep, writing nothing", async () => {
    const tenant = freshTenant("source");
    const long = "n".repeat(257);
    const bad: unknown[] = [
      // Not a source at all, or one the package refuses.
      null, "orders", { kind: "nope" }, { kind: "edits", count: 0 }, { kind: "orders", days: 1.5 },
      { kind: "document", name: " ", date: 1 }, { kind: "customer", chat: "" }, { kind: "connection", name: "", detail: "" },
      // Well formed, but too large for one record that holds up to 200 facts, or not a time or a count a person can read.
      { kind: "document", name: long, date: 1 }, { kind: "customer", chat: long },
      { kind: "connection", name: "Google Sheets", detail: long }, { kind: "connection", name: long, detail: "" },
      { kind: "document", name: "your price list", date: 1e300 }, { kind: "document", name: "your price list", date: -1 },
      { kind: "document", name: "your price list", date: 8_640_000_000_000_001 },
      { kind: "edits", count: 2 ** 60 }, { kind: "orders", days: 2 ** 60 },
    ];
    for (const source of bad) {
      expect([JSON.stringify(source), await proposeFact(bindings, tenant, "A fact", source as FactSource)])
        .toEqual([JSON.stringify(source), { ok: false, reason: "invalid_source" }]);
    }
    expect(await facts(tenant)).toEqual([]);
    expect((await auditOf(tenant)).entries).toEqual([]);
    // The largest that is kept.
    expect(await proposeFact(bindings, tenant, "Largest", { kind: "document", name: "n".repeat(256), date: 8_640_000_000_000_000 }))
      .toMatchObject({ ok: true });
  });

  it("answers forgotten for a text the owner made the team forget, from any source and in any form", async () => {
    const tenant = freshTenant("forgotten");
    const fact = (await proposeFact(bindings, tenant, "Our secret supplier is Khun Somchai", ORDERS)) as { ok: true; fact: Fact };
    const response = await tenantCall(bindings, tenant, "/memory/forget", { method: "POST",
      headers: { "content-type": "application/json", "x-memory": "1" }, body: JSON.stringify({ tenant, id: fact.fact.id }) });
    expect(response.status).toBe(200);
    for (const source of [ORDERS, CUSTOMER]) {
      expect(await proposeFact(bindings, tenant, " our SECRET supplier  is khun somchai", source)).toEqual({ ok: false, reason: "forgotten" });
    }
    expect(await facts(tenant)).toEqual([]);
  });

  it("answers full once the shop holds 200 facts", async () => {
    const tenant = freshTenant("full");
    const added = await Promise.all(Array.from({ length: MAX_FACTS }, (_, i) => proposeFact(bindings, tenant, `fact ${i}`, ORDERS)));
    expect(added.every((answer) => answer.ok)).toBe(true);
    expect(await proposeFact(bindings, tenant, "one more", ORDERS)).toEqual({ ok: false, reason: "full" });
    expect(await proposeFact(bindings, tenant, "one more from a customer", CUSTOMER)).toEqual({ ok: false, reason: "full" });
    expect(await facts(tenant)).toHaveLength(MAX_FACTS);
  }, 60_000);
});

describe("the audit entry of a proposal", () => {
  it("names the system by default, or the worker that learned it, and the fact's id and no more", async () => {
    const tenant = freshTenant("audit");
    const document: FactSource = { kind: "document", name: "your price list", date: Date.UTC(2026, 10, 3) };
    const learner = { kind: "worker" as const, attemptId: "6f9d1f0e-9a7e-4a53-9a0b-2f5c1d1f7c11" };
    await proposeFact(bindings, tenant, "Small candles are 90 baht", document);
    await proposeFact(bindings, tenant, "A customer says the large jar is 400", CUSTOMER, { actor: learner });
    // A repeat from the owner's data confirms the waiting fact: that is a change too.
    await proposeFact(bindings, tenant, "a customer says the large jar is 400", ORDERS, { actor: learner });
    // Refusals change nothing and write nothing.
    await proposeFact(bindings, tenant, "small candles are 90 baht", document);
    await proposeFact(bindings, tenant, "", document);

    const { entries, missed } = await auditOf(tenant);
    expect(missed).toBeNull();
    expect(entries.map((entry) => [entry.action, entry.subject, entry.outcome, entry.actor])).toEqual([
      ["memory.proposed", { factId: "f1" }, "ok", { kind: "system" }],
      ["memory.proposed", { factId: "f2" }, "awaiting_owner", learner],
      ["memory.proposed", { factId: "f2" }, "ok", learner],
    ]);
    const written = JSON.stringify(entries);
    for (const words of ["candles", "jar", "price list", "Ucustomer0003", "line:", "Google"]) expect(written).not.toContain(words);
  });

  it("keeps the proposal when the actor cannot be recorded, and counts the miss instead", async () => {
    const tenant = freshTenant("audit-actor");
    const answer = await proposeFact(bindings, tenant, "Kept anyway", ORDERS, { actor: { kind: "worker" } as never });
    expect(answer).toMatchObject({ ok: true });
    const { entries, missed } = await auditOf(tenant);
    expect(entries).toEqual([]);
    expect(missed).toEqual({ count: 1, lastAt: expect.any(String), lastAction: "memory.proposed" });
  });
});

describe("the time of a proposal", () => {
  it("comes from the caller's clock when it gives one, and from the Worker's otherwise", async () => {
    const tenant = freshTenant("clock");
    const given = await proposeFact(bindings, tenant, "On a given day", ORDERS, { now: () => 1_700_000_000_000 });
    expect(given).toMatchObject({ ok: true, fact: { createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 } });
    const before = Date.now();
    const own = (await proposeFact(bindings, tenant, "On the Worker's day", ORDERS)) as { ok: true; fact: Fact };
    expect(own.fact.createdAt).toBeGreaterThanOrEqual(before);
    expect(own.fact.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("a shop's object that cannot answer", () => {
  it("is unavailable, never an exception, whether it cannot be reached, fails or answers nonsense", async () => {
    for (const answer of [
      async () => { throw new Error("fixture_object_unreachable"); },
      async () => Response.json({ error: "fixture_call_failed" }, { status: 500 }),
      async () => Response.json({ error: "forbidden" }, { status: 403 }),
      async () => new Response("not json", { status: 200 }),
      async () => Response.json({ unexpected: true }, { status: 200 }),
    ]) {
      const { stand } = standIn(answer);
      expect(await proposeFact(stand, "memory-propose:down", "A fact", ORDERS)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("answers invalid_text for words too long to be a fact, and invalid_request for a proposal too large to send at all", async () => {
    const tenant = freshTenant("large");
    expect(await proposeFact(bindings, tenant, "x".repeat(20_000), ORDERS)).toEqual({ ok: false, reason: "invalid_text" });
    expect(await proposeFact(bindings, tenant, "x".repeat(40_000), ORDERS)).toEqual({ ok: false, reason: "invalid_request" });
    const { stand } = standIn(async () => Response.json({ error: "body_too_large" }, { status: 413 }));
    expect(await proposeFact(stand, "memory-propose:large", "A fact", ORDERS)).toEqual({ ok: false, reason: "invalid_request" });
    expect(await facts(tenant)).toEqual([]);
  });

  it("is not asked at all for a tenant that is not one", async () => {
    const { stand, calls } = standIn(async () => Response.json({}, { status: 200 }));
    for (const tenant of ["", "t".repeat(257), undefined as unknown as string]) {
      expect(await proposeFact(stand, tenant, "A fact", ORDERS)).toEqual({ ok: false, reason: "invalid_request" });
    }
    expect(calls).toEqual([]);
  });

  it("is sent the Worker-only header and the tenant, the text and the source, and nothing else", async () => {
    const seen: { path: string; header: string | null; body: Record<string, unknown> }[] = [];
    const { stand } = standIn(async (request) => {
      seen.push({ path: new URL(request.url).pathname, header: request.headers.get("x-memory"), body: (await request.json()) as Record<string, unknown> });
      return Response.json({ error: "already_known" }, { status: 409 });
    });
    expect(await proposeFact(stand, "memory-propose:sent", "A fact", ORDERS, { now: () => 5_000, actor: { kind: "system" } }))
      .toEqual({ ok: false, reason: "already_known" });
    expect(seen).toEqual([{ path: "/memory/propose", header: "1", body: { tenant: "memory-propose:sent", text: "A fact", source: ORDERS,
      nowMs: 5_000, actor: { kind: "system" } } }]);
  });
});
