import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fingerprint, MAX_FACTS, type Fact } from "@manut/shop-memory";
import type { AuditEntry, AuditMissed } from "../src/audit-log";
import worker, { type Env } from "../src/index";
import { tenantCall } from "../src/tenant-data";

// What the team knows about a shop, through the real Worker and the shop's TenantObject in workerd: the five operator
// routes behind the admin gate, what each answers and refuses, the one state stored per shop, and the audit entry each
// change leaves (an id and a code, never the fact's words). A worker's proposal has no route: it is a function
// (memory-propose.test.ts), and this file reaches it only through the object's own door, as that function does.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const EMAIL = "ops@manut.test";

let counter = 0;
const freshTenant = (label: string) => `memory-routes:${label}-${Date.now()}-${counter++}`;

type Answer<T> = { status: number; body: T };
type Refused = { error: string };
type Memory = { tenant: string; facts: Fact[]; forgottenCount: number };

/// An operator call through the admin gate (Access audience, operator key and an exact method), with the Access
/// identity `email`, or none for a service token. A string body is sent as it is, so a test can send bad JSON.
async function admin<T>(method: string, path: string, body?: unknown, email: string | null = EMAIL): Promise<Answer<T>> {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => (email ? { email } : undefined) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, {
    method, headers: OPERATOR, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }), bindings, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

const memoryPath = (tenant: string) => `/v1/admin/memory?tenant=${encodeURIComponent(tenant)}`;
const read = (tenant: string) => admin<Memory>("GET", memoryPath(tenant));
const remember = (tenant: string, text: unknown, email: string | null = EMAIL) =>
  admin<Fact | Refused>("POST", "/v1/admin/memory/remember", { tenant, text }, email);
const confirm = (tenant: string, id: unknown) => admin<Fact | Refused>("POST", "/v1/admin/memory/confirm", { tenant, id });
const correct = (tenant: string, id: unknown, text: unknown) =>
  admin<Fact | Refused>("POST", "/v1/admin/memory/correct", { tenant, id, text });
const forget = (tenant: string, id: unknown) => admin<{ id: string } | Refused>("POST", "/v1/admin/memory/forget", { tenant, id });

/// A fact the operator remembered, which must have been accepted.
async function remembered(tenant: string, text: string): Promise<Fact> {
  const answer = await remember(tenant, text);
  expect(answer.status).toBe(200);
  return answer.body as Fact;
}

/// A worker's proposal as `proposeFact` makes it: through the object's own door, with the Worker-only header.
async function propose(tenant: string, text: string, source: unknown) {
  const response = await tenantCall(bindings, tenant, "/memory/propose", { method: "POST",
    headers: { "content-type": "application/json", "x-memory": "1" },
    body: JSON.stringify({ tenant, text, source, nowMs: Date.now() }) });
  return { status: response.status, body: (await response.json()) as Fact | Refused };
}
const CUSTOMER = { kind: "customer", chat: "line:Ucustomer0001" };

/// Every audit entry of the shop, oldest first, and what the log missed.
async function auditOf(tenant: string): Promise<{ entries: AuditEntry[]; missed: AuditMissed | null }> {
  const response = await tenantCall(bindings, tenant, `/audit/export?tenant=${encodeURIComponent(tenant)}`);
  return (await response.json()) as { entries: AuditEntry[]; missed: AuditMissed | null };
}

/// What the shop's object holds under the memory prefix, as stored.
async function stored(tenant: string): Promise<[string, unknown][]> {
  const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
  return runInDurableObject(object, async (_instance, state) => [...(await state.storage.list({ prefix: "memory" })).entries()]);
}

describe("the memory operator routes behind the admin gate", () => {
  const routes = [
    ["GET", "/v1/admin/memory"],
    ["POST", "/v1/admin/memory/remember"],
    ["POST", "/v1/admin/memory/confirm"],
    ["POST", "/v1/admin/memory/correct"],
    ["POST", "/v1/admin/memory/forget"],
  ] as const;

  /// A request whose body counts how often it is read, so a test can show the gate answered first.
  function send(method: string, path: string, options: { audience?: string; bearer?: string }) {
    let pulls = 0;
    const body = method === "POST"
      ? new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } },
        { highWaterMark: 0 })
      : undefined;
    const context = createExecutionContext();
    if (options.audience !== undefined) {
      Object.defineProperty(context, "access", { value: { aud: options.audience, getIdentity: async () => undefined }, configurable: true });
    }
    const request = new Request(`https://api.manut.test${path}`, { method,
      headers: { authorization: `Bearer ${options.bearer ?? "test-key"}`, "content-type": "application/json" }, ...(body ? { body } : {}) });
    return { status: worker.fetch(request, bindings, context).then(async (response) => {
      await waitOnExecutionContext(context);
      return response.status;
    }), pulls: () => pulls };
  }

  it.each(routes)("refuses %s %s without the admin gate's two credentials, before reading anything", async (method, path) => {
    for (const options of [{}, { audience: "another-application" }, { audience: bindings.ADMIN_ACCESS_AUD!, bearer: "a-session-token" }]) {
      const attempt = send(method, path, options);
      expect(await attempt.status).toBe(403);
      expect(attempt.pulls()).toBe(0);
    }
    // Through the gate each is an exact ADMIN_METHODS entry: never the gate's 404 for an unlisted method.
    expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! }).status).not.toBe(404);
  });

  it("has no route for a worker's proposal, and none for any method or path that is not listed", async () => {
    for (const [method, path] of [
      ["POST", "/v1/admin/memory/propose"],
      ["POST", "/v1/admin/memory"],
      ["PUT", "/v1/admin/memory/remember"],
      ["GET", "/v1/admin/memory/remember"],
      ["DELETE", "/v1/admin/memory/forget"],
      ["GET", "/v1/admin/memory/export"],
      ["GET", "/v1/admin/memory/forget/f1"],
    ] as const) {
      expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! }).status).toBe(404);
    }
  });
});

describe("reading a shop's memory", () => {
  it("answers an untouched shop with nothing known and nothing forgotten", async () => {
    const tenant = freshTenant("empty");
    expect(await read(tenant)).toEqual({ status: 200, body: { tenant, facts: [], forgottenCount: 0 } });
  });

  it("refuses a tenant that is missing or too long", async () => {
    expect(await admin("GET", "/v1/admin/memory")).toEqual({ status: 400, body: { error: "tenant_required" } });
    expect(await admin("GET", memoryPath("t".repeat(257)))).toEqual({ status: 400, body: { error: "tenant_required" } });
  });

  it("answers every fact, waiting ones included, oldest first, and only the number of forgotten fingerprints", async () => {
    const tenant = freshTenant("everything");
    await remembered(tenant, "kept");
    expect((await propose(tenant, "waiting one", CUSTOMER)).status).toBe(200);
    const gone = await remembered(tenant, "gone");
    expect((await forget(tenant, gone.id)).status).toBe(200);
    const answer = await read(tenant);
    expect(answer.status).toBe(200);
    expect(answer.body.facts.map((fact) => [fact.id, fact.text, fact.status])).toEqual([["f1", "kept", "confirmed"], ["f2", "waiting one", "waiting"]]);
    expect(answer.body.facts[1]!.source).toEqual(CUSTOMER);
    expect(answer.body.forgottenCount).toBe(1);
    expect(JSON.stringify(answer.body)).not.toContain(fingerprint("gone"));
  });
});

describe("remember", () => {
  it("adds the owner's fact, confirmed at once, with its text trimmed and the time it was made", async () => {
    const tenant = freshTenant("remember");
    const before = Date.now();
    const answer = await remember(tenant, "  We close on Mondays ");
    const after = Date.now();
    expect(answer).toEqual({ status: 200, body: { id: "f1", text: "We close on Mondays", status: "confirmed",
      createdAt: expect.any(Number), updatedAt: expect.any(Number), source: { kind: "owner" } } });
    const fact = answer.body as Fact;
    expect(fact.createdAt).toBeGreaterThanOrEqual(before);
    expect(fact.createdAt).toBeLessThanOrEqual(after);
    expect(fact.updatedAt).toBe(fact.createdAt);
    expect((await read(tenant)).body.facts).toEqual([fact]);
  });

  it("keeps Thai text, counted by characters", async () => {
    const tenant = freshTenant("thai");
    expect((await remember(tenant, "ร้านปิดวันจันทร์")).status).toBe(200);
    expect((await remember(tenant, "ก".repeat(280))).status).toBe(200);
    expect(await remember(tenant, "ก".repeat(281))).toEqual({ status: 400, body: { error: "invalid_text" } });
  });

  it("answers already_known for the same text in another form, and changes nothing", async () => {
    const tenant = freshTenant("duplicate");
    const first = await remembered(tenant, "Closed on Mondays");
    expect(await remember(tenant, "  closed on  MONDAYS ")).toEqual({ status: 409, body: { error: "already_known" } });
    expect((await read(tenant)).body.facts).toEqual([first]);
  });

  it("confirms a waiting fact with the same text instead of adding it twice", async () => {
    const tenant = freshTenant("waiting");
    const waiting = (await propose(tenant, "Ships in 2 days", CUSTOMER)).body as Fact;
    expect(waiting.status).toBe("waiting");
    const answer = await remember(tenant, "ships in 2 days");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id: waiting.id, status: "confirmed" });
    expect((await read(tenant)).body.facts).toHaveLength(1);
  });

  it("refuses text that is empty, blank, over 280 characters or not text, writing nothing", async () => {
    const tenant = freshTenant("invalid-text");
    for (const text of ["", "   ", "x".repeat(281), 5, null, undefined, ["a"]]) {
      expect(await remember(tenant, text)).toEqual({ status: 400, body: { error: "invalid_text" } });
    }
    expect((await remember(tenant, "x".repeat(280))).status).toBe(200);
    expect((await auditOf(tenant)).entries).toHaveLength(1);
  });

  it("keeps each shop's memory apart", async () => {
    const mine = freshTenant("mine");
    const yours = freshTenant("yours");
    await remembered(mine, "only mine");
    expect((await read(yours)).body.facts).toEqual([]);
    expect(await remember(yours, "only mine")).toMatchObject({ status: 200 });
  });
});

describe("confirm", () => {
  it("answers 'It's true' for a waiting fact, and answering twice changes nothing more", async () => {
    const tenant = freshTenant("confirm");
    const waiting = (await propose(tenant, "Gift wrap is 20", CUSTOMER)).body as Fact;
    const first = await confirm(tenant, waiting.id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: waiting.id, text: "Gift wrap is 20", status: "confirmed", source: CUSTOMER });
    const again = await confirm(tenant, waiting.id);
    expect(again).toEqual(first);
    expect((await read(tenant)).body.facts).toEqual([first.body]);
  });

  it("answers not_found for an id the shop does not have, and refuses an id that is not one", async () => {
    const tenant = freshTenant("confirm-missing");
    await remembered(tenant, "something");
    expect(await confirm(tenant, "f99")).toEqual({ status: 404, body: { error: "not_found" } });
    // Another shop's f2 is not this shop's: this shop has an f1 only.
    const other = freshTenant("confirm-other");
    await remembered(other, "another shop's first");
    await remembered(other, "another shop's second");
    expect(await confirm(tenant, "f2")).toEqual({ status: 404, body: { error: "not_found" } });
    for (const id of [undefined, null, 1, "", "f".repeat(65), ["f1"]]) {
      expect(await confirm(tenant, id)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
  });
});

describe("correct", () => {
  it("gives a fact new text, confirmed and marked as corrected, keeping its source and its first time", async () => {
    const tenant = freshTenant("correct");
    const waiting = (await propose(tenant, "Free shipping over 500", CUSTOMER)).body as Fact;
    const answer = await correct(tenant, waiting.id, " Free shipping over 600 ");
    expect(answer.status).toBe(200);
    const fact = answer.body as Fact;
    expect(fact).toMatchObject({ id: waiting.id, text: "Free shipping over 600", status: "confirmed", source: CUSTOMER, createdAt: waiting.createdAt });
    expect(fact.correctedAt).toBeGreaterThanOrEqual(waiting.createdAt);
    expect(fact.updatedAt).toBe(fact.correctedAt);
    expect((await read(tenant)).body.facts).toEqual([fact]);
  });

  it("refuses bad text and another fact's text, and answers not_found for an unknown id, changing nothing", async () => {
    const tenant = freshTenant("correct-refusals");
    const one = await remembered(tenant, "one");
    const two = await remembered(tenant, "two");
    expect(await correct(tenant, two.id, "ONE")).toEqual({ status: 409, body: { error: "already_known" } });
    for (const text of ["", "  ", "x".repeat(281), 7, undefined]) {
      expect(await correct(tenant, two.id, text)).toEqual({ status: 400, body: { error: "invalid_text" } });
    }
    expect(await correct(tenant, "f99", "anything")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await correct(tenant, undefined, "anything")).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect((await read(tenant)).body.facts).toEqual([one, two]);
    // A correction to the fact's own text, in another form, is allowed.
    expect((await correct(tenant, two.id, "TWO")).status).toBe(200);
  });
});

describe("forget", () => {
  it("removes the text and keeps only a fingerprint: in the answer, in storage and in the log", async () => {
    const tenant = freshTenant("forget");
    const text = "Our secret supplier is Khun Somchai";
    const fact = await remembered(tenant, text);
    const answer = await forget(tenant, fact.id);
    expect(answer).toEqual({ status: 200, body: { id: fact.id } });
    expect(JSON.stringify(answer.body)).not.toContain("Somchai");
    expect((await read(tenant)).body).toEqual({ tenant, facts: [], forgottenCount: 1 });

    const rows = await stored(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]![1]).toMatchObject({ facts: [], forgotten: [fingerprint(text)] });
    expect(JSON.stringify(rows)).not.toContain("Somchai");
    expect(JSON.stringify(await auditOf(tenant))).not.toContain("Somchai");
  });

  it("is not learned again, in any form, until the owner says it again", async () => {
    const tenant = freshTenant("forgotten");
    const text = "Our secret supplier is Khun Somchai";
    const fact = await remembered(tenant, text);
    await forget(tenant, fact.id);
    for (const source of [CUSTOMER, { kind: "orders", days: 30 }]) {
      expect(await propose(tenant, " our SECRET  supplier is khun somchai ", source)).toEqual({ status: 409, body: { error: "forgotten" } });
    }
    // The owner saying it lifts the Forget, and the new fact has a new id.
    const again = await remember(tenant, text);
    expect(again.status).toBe(200);
    expect((again.body as Fact).id).not.toBe(fact.id);
    expect((await read(tenant)).body.forgottenCount).toBe(0);
  });

  it("answers not_found for an id that is gone or never was, and refuses an id that is not one", async () => {
    const tenant = freshTenant("forget-missing");
    const fact = await remembered(tenant, "short lived");
    expect((await forget(tenant, fact.id)).status).toBe(200);
    expect(await forget(tenant, fact.id)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await forget(tenant, "f99")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await forget(tenant, 3)).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect((await read(tenant)).body.forgottenCount).toBe(1);
  });
});

describe("a body the routes cannot use", () => {
  it("answers 400 for JSON that is not valid or not an object, and for a missing tenant, and 413 for a body that is too large", async () => {
    const post = (body: unknown) => admin<Refused>("POST", "/v1/admin/memory/remember", body);
    expect(await post("{not json")).toEqual({ status: 400, body: { error: "invalid_json" } });
    for (const body of ['"text"', "[1]", "null", "5"]) expect(await post(body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    for (const body of [{ text: "x" }, { tenant: "", text: "x" }, { tenant: 7, text: "x" }, { tenant: "t".repeat(257), text: "x" }]) {
      expect(await post(body)).toEqual({ status: 400, body: { error: "tenant_required" } });
    }
    expect(await post({ tenant: freshTenant("big"), text: "x".repeat(20_000) })).toEqual({ status: 413, body: { error: "body_too_large" } });
  });

  it("answers invalid_text, not a failure, for words just inside the Worker's limit: what the Worker adds is not counted against the sender", async () => {
    // The body the Worker forwards also carries the time and the operator, so it is a little larger than the one it read.
    // All ASCII, so a string's length is its size in bytes: this body is eight bytes under the Worker's 16 KB.
    const tenant = freshTenant("edge");
    const text = "x".repeat(16 * 1024 - JSON.stringify({ tenant, text: "" }).length - 8);
    expect(JSON.stringify({ tenant, text }).length).toBe(16 * 1024 - 8);
    expect(await admin<Refused>("POST", "/v1/admin/memory/remember", { tenant, text })).toEqual({ status: 400, body: { error: "invalid_text" } });
  });
});

describe("the limit of 200 facts", () => {
  it("accepts 200 facts at once, answers full for one more, and lets Forget make room", async () => {
    const tenant = freshTenant("cap");
    const added = await Promise.all(Array.from({ length: MAX_FACTS }, (_, i) => remember(tenant, `fact ${i}`)));
    expect(added.map((answer) => answer.status)).toEqual(Array(MAX_FACTS).fill(200));
    expect(await remember(tenant, "one more")).toEqual({ status: 409, body: { error: "full" } });
    expect(await propose(tenant, "one more from a customer", CUSTOMER)).toEqual({ status: 409, body: { error: "full" } });
    expect((await forget(tenant, "f1")).status).toBe(200);
    expect((await remember(tenant, "one more")).status).toBe(200);
    expect((await read(tenant)).body.facts).toHaveLength(MAX_FACTS);
  }, 60_000);
});

describe("two operators clicking at once", () => {
  it("keeps every fact: none is lost and no two share an id", async () => {
    const tenant = freshTenant("race");
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => remember(tenant, `fact number ${i}`)));
    expect(answers.map((answer) => answer.status)).toEqual(Array(20).fill(200));
    expect(new Set(answers.map((answer) => (answer.body as Fact).id)).size).toBe(20);
    expect((await read(tenant)).body.facts).toHaveLength(20);
    expect((await auditOf(tenant)).entries.filter((entry) => entry.action === "memory.remembered")).toHaveLength(20);
  });

  it("lets exactly one of two clicks on the same words win", async () => {
    const tenant = freshTenant("twins");
    const answers = await Promise.all([remember(tenant, "We close at 19:00"), remember(tenant, "we  close at 19:00 ")]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect((await read(tenant)).body.facts).toHaveLength(1);
  });

  it("settles a Forget and a Correct of the same fact one after the other, never half of each", async () => {
    const tenant = freshTenant("forget-correct");
    const fact = await remembered(tenant, "before");
    const [corrected, forgotten] = await Promise.all([correct(tenant, fact.id, "after"), forget(tenant, fact.id)]);
    // Whichever came first, the Forget wins in the end: if the Correct came first the Forget removed its text, and if
    // the Forget came first the Correct found nothing to correct.
    expect(forgotten.status).toBe(200);
    expect([200, 404]).toContain(corrected.status);
    expect((await read(tenant)).body).toEqual({ tenant, facts: [], forgottenCount: 1 });
    // Neither text is left behind: what is stored is a fingerprint, in hexadecimal.
    expect(JSON.stringify(await stored(tenant))).not.toMatch(/before|after/);
  });
});

describe("the audit entry of each change", () => {
  it("names the operator, the action and the fact's id, and never its words", async () => {
    const tenant = freshTenant("audit");
    const made = await remembered(tenant, "ลูกค้าประจำได้ส่วนลด 10% ทุกครั้ง");
    await correct(tenant, made.id, "ลูกค้าประจำได้ส่วนลด 15% ทุกครั้ง");
    const waiting = (await propose(tenant, "A customer says the shop closes at five", CUSTOMER)).body as Fact;
    await confirm(tenant, waiting.id);
    await forget(tenant, made.id);

    const { entries, missed } = await auditOf(tenant);
    expect(missed).toBeNull();
    expect(entries.map((entry) => [entry.action, entry.subject, entry.outcome])).toEqual([
      ["memory.remembered", { factId: made.id }, "ok"],
      ["memory.corrected", { factId: made.id }, "ok"],
      ["memory.proposed", { factId: waiting.id }, "awaiting_owner"],
      ["memory.confirmed", { factId: waiting.id }, "ok"],
      ["memory.forgotten", { factId: made.id }, "ok"],
    ]);
    // The operator's four, and the worker's proposal, which the object's door records as the system's.
    expect(entries.map((entry) => entry.actor)).toEqual([
      { kind: "operator", email: EMAIL }, { kind: "operator", email: EMAIL }, { kind: "system" },
      { kind: "operator", email: EMAIL }, { kind: "operator", email: EMAIL },
    ]);
    const written = JSON.stringify(entries);
    for (const words of ["ลูกค้าประจำ", "closes at five", "Ucustomer0001", "line:"]) expect(written).not.toContain(words);
  });

  it("records a service token as an operator with no identity", async () => {
    const tenant = freshTenant("audit-token");
    expect((await remember(tenant, "from a service token", null)).status).toBe(200);
    expect((await auditOf(tenant)).entries.map((entry) => entry.actor)).toEqual([{ kind: "operator", email: null }]);
  });

  it("writes nothing for a refusal, or for a confirm that changed nothing", async () => {
    const tenant = freshTenant("audit-quiet");
    const fact = await remembered(tenant, "same");
    await remember(tenant, "SAME");
    await remember(tenant, "");
    await confirm(tenant, fact.id);
    await confirm(tenant, "f99");
    await correct(tenant, fact.id, "");
    await forget(tenant, "f99");
    expect((await auditOf(tenant)).entries.map((entry) => entry.action)).toEqual(["memory.remembered"]);
  });

  it("appears on the audit page the operators read", async () => {
    const tenant = freshTenant("audit-page");
    const fact = await remembered(tenant, "visible on the page");
    const page = await admin<{ entries: AuditEntry[] }>("GET", `/v1/admin/audit?tenant=${encodeURIComponent(tenant)}`);
    expect(page.status).toBe(200);
    expect(page.body.entries).toEqual([expect.objectContaining({ action: "memory.remembered", subject: { factId: fact.id } })]);
  });
});
