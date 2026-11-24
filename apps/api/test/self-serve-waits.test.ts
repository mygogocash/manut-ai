import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testOutbox } from "../src/email-sender";
import worker, { type Env } from "../src/index";
import type { JobFlags } from "../src/job-flow";
import { callModel } from "../src/model-gateway";
import { standInProvider, type ChatRequest, type ModelProvider } from "../src/model-provider";
import { MAKES_TODAY_KEY, SELF_SERVE_MAKES_PER_DAY, SHOPS_MADE_LIMIT } from "../src/shops-store";
import { tenantCall } from "../src/tenant-data";
import { runWorker, WORKER_MODEL } from "../src/workers";
import { admin, asSession, bindings, failingWhere, forgetTodaysMakes, signIn, type SignedIn } from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// A shop its owner makes, across accounts (self-serve.ts, shop-waits.ts; docs/several-shops.md, "A shop its owner makes"):
// the day's makes are capped for all accounts together, since one mailbox can have as many accounts as it likes, and the
// team of a shop made this way waits, with no model call and no routine run, until an operator counts it in.

const DAY_MS = 24 * 3600 * 1000;
const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;
const today = () => Math.floor((Date.now() + BANGKOK_OFFSET_MS) / DAY_MS);
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const OPS = { kind: "operator", email: "ops@manut.test" } as const;

beforeEach(async () => {
  await forgetTodaysMakes();
  // Nothing leaves the Worker: a call that tried would fail its test.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// Sets the day's count of self-serve makes, as if `count` had begun on Bangkok day `day`.
async function makesToday(count: number, day = today()): Promise<void> {
  await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), (_instance, state) =>
    state.storage.put(MAKES_TODAY_KEY, { day, count }));
}

/// Signs `email` in through the real email code exchange.
async function emailSignIn(email: string): Promise<SignedIn> {
  const asked = await sourceWorker.fetch("https://api.manut.test/v1/auth/email/code", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  expect(asked.status).toBe(200);
  const sent = testOutbox().filter((one) => one.to === email);
  const code = /sign-in code is (\d{6})\./.exec(sent[sent.length - 1]?.text ?? "")?.[1];
  const deviceId = `device-${crypto.randomUUID()}`;
  const exchanged = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email", email, code, deviceId }) });
  expect(exchanged.status).toBe(200);
  const body = (await exchanged.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

type Made = { shop: { id: string }; session: { accessToken: string }; teamWaits?: string; error?: string; retryAfter?: number };

const make = (person: { headers: { authorization?: string } }, name: string) => asSession<Made>(person.headers, "POST",
  "/v1/shops/new", { name, ownerName: "Dao", template: null });

/// A model provider that answers as the stand-in does and keeps every request it was sent.
function recording(): { requests: ChatRequest[]; provider: ModelProvider } {
  const requests: ChatRequest[] = [];
  const inner = standInProvider();
  return { requests, provider: { id: inner.id, missing: inner.missing, async complete(request) {
    requests.push(structuredClone(request));
    return inner.complete(request);
  } } };
}

/// A shop the person made, with the owner's consent to cloud work and one fact the team knows.
async function waitingShop(): Promise<{ tenant: string; owner: { authorization: string } }> {
  const made = await make(await signIn(), `Shop ${crypto.randomUUID().slice(0, 6)}`);
  expect(made.status).toBe(201);
  const tenant = made.body.shop.id;
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
  expect((await tenantCall(bindings, tenant, "/memory/remember", { method: "POST",
    headers: { "content-type": "application/json", "x-memory": "1" },
    body: JSON.stringify({ tenant, text: "We open at 9 every day.", nowMs: Date.now() }) })).status).toBe(200);
  return { tenant, owner: { authorization: `Bearer ${made.body.session.accessToken}` } };
}

const countIn = async (tenant: string) =>
  expect((await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant, counted: true })).status).toBe(200);

describe("the day's makes, all accounts together", () => {
  it("stops one mailbox's many addresses at the day's cap, where each account had its own limit before", async () => {
    // As the review's proof: me+1@ and me+2@ are one mailbox and two accounts. The day has room for four more shops.
    await makesToday(SELF_SERVE_MAKES_PER_DAY - 4);
    const box = `me-${crypto.randomUUID().slice(0, 8)}`;
    const first = await emailSignIn(`${box}+1@mailbox.example`);
    const second = await emailSignIn(`${box}+2@mailbox.example`);
    expect(first.tenant).not.toBe(second.tenant);
    const statuses: number[] = [];
    for (let n = 0; n <= SHOPS_MADE_LIMIT; n++) statuses.push((await make(first, `Shop A${n}`)).status);
    statuses.push((await make(second, "Shop B0")).status);
    const full = await make(second, "Shop B1");
    statuses.push(full.status);
    // The first account's own limit refuses its fourth, which takes nothing of the day's; the second's second is refused
    // because the day is full, whoever asks.
    expect(statuses).toEqual([201, 201, 201, 409, 201, 429]);
    expect(full.body.error).toBe("sign_ups_full");
    const secondsLeft = Math.ceil(((today() + 1) * DAY_MS - BANGKOK_OFFSET_MS - Date.now()) / 1000);
    expect(full.body.retryAfter).toBeGreaterThan(0);
    expect(full.body.retryAfter).toBeLessThanOrEqual(secondsLeft + 1);
    // Someone else entirely is refused too, and the console lists none of the refused shops.
    expect((await make(await signIn(), "Someone else's")).body.error).toBe("sign_ups_full");
    const listed = await admin<{ shops: { name: string }[] }>("GET", "/v1/admin/pilot/shops");
    expect(listed.body.shops.some((shop) => shop.name === "Shop B1" || shop.name === "Someone else's")).toBe(false);
  });

  it("counts again from the first make of a new Bangkok day, and never counts an operator's make", async () => {
    await makesToday(SELF_SERVE_MAKES_PER_DAY, today() - 1);
    expect((await make(await signIn(), "A new day")).status).toBe(201);
    await makesToday(SELF_SERVE_MAKES_PER_DAY);
    expect((await admin("POST", "/v1/admin/pilot/shops", { name: "An operator's", ownerName: "Fon" })).status).toBe(200);
    expect((await make(await signIn(), "Still full")).status).toBe(429);
  });

  it("finishes a make that stopped part way without counting it again", async () => {
    const person = await signIn();
    // The shop's own write fails: the make began, and counted, and stopped, and stays on the journal of makes.
    const shopDown = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/pilot/shop");
    const context = createExecutionContext();
    const first = await worker.fetch(new Request("https://api.manut.test/v1/shops/new", { method: "POST",
      headers: { ...person.headers, "content-type": "application/json", "cf-connecting-ip": "2001:db8:5e1f::1" },
      body: JSON.stringify({ name: "Stopped", ownerName: "Dao", template: null }) }), shopDown, context);
    await waitOnExecutionContext(context);
    expect(first.status).toBe(503);
    // The day fills up; asking again for the very shop that stopped finishes it all the same, and a new one is refused.
    await makesToday(SELF_SERVE_MAKES_PER_DAY);
    expect((await make(person, "Stopped")).status).toBe(201);
    expect((await make(person, "A new one")).status).toBe(429);
  });
});

describe("a shop its owner made, until an operator counts it in", () => {
  it("says in its answer, and in the person's list, that its team waits and why", async () => {
    const person = await signIn();
    const made = await make(person, "Baan Rao");
    expect(made.status).toBe(201);
    expect(made.body.teamWaits).toBe("not_counted_in");
    const before = await asSession<{ shops: { id: string; teamWaits?: string }[] }>(person.headers, "GET", "/v1/shops");
    expect(before.body.shops).toEqual([expect.objectContaining({ id: made.body.shop.id, teamWaits: "not_counted_in" })]);
    await countIn(made.body.shop.id);
    const after = await asSession<{ shops: { id: string; teamWaits?: string }[] }>(person.headers, "GET", "/v1/shops");
    expect(after.body.shops[0]).not.toHaveProperty("teamWaits");
  });

  it("makes no model call, and sends nothing of the shop to a model, until it is counted in", async () => {
    const shop = await waitingShop();
    const model = recording();
    const request: ChatRequest = { model: WORKER_MODEL, system: "You write posts.", maxOutputTokens: 200,
      messages: [{ role: "user", content: "Draft a post." }] };
    expect(await callModel(bindings, shop.tenant, request, { provider: model.provider }))
      .toEqual({ ok: false, status: 403, error: "not_counted_in" });
    // Pim's post job would put the routine's topic, the shop's name and what the team knows in front of the model.
    const topic = "our new mango sticky rice";
    const held = await runWorker({ ...bindings, MODEL_PROVIDER: "stand-in" } as Env, { tenant: shop.tenant, member: "pim",
      job: { kind: "post", topic }, startedBy: OPS }, { flags: on, provider: model.provider });
    expect(held).toMatchObject({ ok: true, member: "pim", outcome: "failed", reason: "not_counted_in" });
    expect(model.requests).toEqual([]);
    // Nothing was held or counted against the shop's month either.
    const usage = await admin<{ counts: Record<string, number>; heldSatang: number }>("GET",
      `/v1/admin/model/usage?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(usage.body).toMatchObject({ heldSatang: 0, counts: { ok: 0, failed: 0, refused: 0 } });

    await countIn(shop.tenant);
    const ran = await runWorker({ ...bindings, MODEL_PROVIDER: "stand-in" } as Env, { tenant: shop.tenant, member: "pim",
      job: { kind: "post", topic }, startedBy: OPS }, { flags: on, provider: model.provider });
    expect(ran).toMatchObject({ ok: true, member: "pim", outcome: "done" });
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests[0])).toContain(topic);
  });

  it("skips its routines' runs, saying why, until it is counted in", async () => {
    const shop = await waitingShop();
    const routines = await asSession<{ routines: { id: string }[] }>(shop.owner, "GET", "/v1/routines");
    expect(routines.status).toBe(200);
    // A shop of none of the templates starts with no routines: the owner makes one, switched on.
    const created = await asSession<{ routine: { id: string } }>(shop.owner, "POST", "/v1/routines",
      { name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" } });
    expect(created.status).toBe(200);
    const routineId = created.body.routine.id;
    const claim = async (instant: number) => {
      const response = await tenantCall(bindings, shop.tenant, "/routines/claim", { method: "POST",
        headers: { "content-type": "application/json", "x-routines": "1" },
        body: JSON.stringify({ tenant: shop.tenant, routineId, instant, late: false, gate: null, nowMs: Date.now() }) });
      expect(response.status).toBe(200);
      return (await response.json()) as { outcome: string; run: { status: string; reason?: string } };
    };
    const start = Date.now() - 60_000;
    expect(await claim(start)).toMatchObject({ outcome: "settled", run: { status: "skipped", reason: "not_counted_in" } });
    await countIn(shop.tenant);
    expect(await claim(start + 1000)).toMatchObject({ outcome: "claimed", run: { status: "running" } });
  });
});
