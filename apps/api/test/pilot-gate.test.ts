import { adminFetch } from "./authenticated-fixtures";
import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import {
  ACTIVE_THRESHOLD_PERCENT,
  ACTIVE_WINDOW_DAYS,
  bangkokDay,
  gateShop,
  PAID_THRESHOLD_PERCENT,
  pilotGate,
  SUBSCRIPTION_PRICE_SATANG,
  TRIAL_DAYS,
  trialDay,
  type GateShopInput,
  type PilotGate,
} from "../src/pilot-gate";
import type { PilotReplyRecord, PilotShopRecord, SubscriptionPayment } from "../src/pilot-store";
import { tenantCall } from "../src/tenant-data";

// The roadmap's Phase 1 gate (docs/pilot-api.md, "The pilot gate"): first its rules as pure functions of the
// records and the time, then the records and the route through the real Worker and objects.

const at = (iso: string) => Date.parse(iso);

// Most cases below start a trial at 10:00 in Bangkok on Monday 7 December 2026 (03:00 UTC). Day 1 is 7 December,
// day 14 is 20 December, and day 15 begins at midnight in Bangkok, which is 17:00 UTC on 20 December.
const START = "2026-12-07T03:00:00.000Z";
const DAY_15_BEGINS = "2026-12-20T17:00:00.000Z";
const LAST_MOMENT_OF_DAY_14 = "2026-12-20T16:59:59.999Z";

function input(overrides: Partial<GateShopInput> = {}): GateShopInput {
  return {
    tenant: "pilot:baan-mali",
    name: "Baan Mali",
    trialStartedAt: START,
    decisions: [],
    subscriptionPayments: [],
    ...overrides,
  };
}

function payment(amountSatang: number, confirmedAt: string): SubscriptionPayment {
  return { id: `sub-${crypto.randomUUID()}`, tenant: "pilot:baan-mali", amountSatang, slipRef: crypto.randomUUID(),
    confirmedAt };
}

describe("the gate's rules", () => {
  it("names each number once: 14 free days, ฿499 in satang, a 7-day window, lines at 25% and 50%", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(SUBSCRIPTION_PRICE_SATANG).toBe(49900);
    expect(Number.isSafeInteger(SUBSCRIPTION_PRICE_SATANG)).toBe(true);
    expect(ACTIVE_WINDOW_DAYS).toBe(7);
    expect(PAID_THRESHOLD_PERCENT).toBe(25);
    expect(ACTIVE_THRESHOLD_PERCENT).toBe(50);
    expect(pilotGate([], at(START)).rules).toEqual({ trialDays: 14, priceSatang: 49900, activeWindowDays: 7 });
  });

  it("counts trial days on Bangkok's calendar, turning at midnight there and not at midnight UTC", () => {
    // A trial that starts a moment before midnight in Bangkok has a day 1 that short.
    const late = at("2026-12-07T16:59:59.999Z"); // 23:59:59.999 in Bangkok on 7 December
    expect(trialDay(late, late)).toBe(1);
    expect(trialDay(late, at("2026-12-07T17:00:00.000Z"))).toBe(2); // 00:00 in Bangkok on 8 December

    // Midnight UTC is 07:00 in Bangkok: no new day there.
    const evening = at("2026-12-07T10:00:00.000Z"); // 17:00 in Bangkok
    expect(trialDay(evening, at("2026-12-07T16:59:59.999Z"))).toBe(1);
    expect(trialDay(evening, at("2026-12-07T23:59:59.999Z"))).toBe(2); // 06:59 in Bangkok on 8 December
    expect(trialDay(evening, at("2026-12-08T00:00:00.000Z"))).toBe(2);
    expect(trialDay(evening, at("2026-12-08T16:59:59.999Z"))).toBe(2);
    expect(trialDay(evening, at("2026-12-08T17:00:00.000Z"))).toBe(3);

    expect(trialDay(at(START), at(LAST_MOMENT_OF_DAY_14))).toBe(14);
    expect(trialDay(at(START), at(DAY_15_BEGINS))).toBe(15);
    // Across the year's end.
    expect(trialDay(at("2026-12-25T03:00:00.000Z"), at("2027-01-07T03:00:00.000Z"))).toBe(14);
    expect(bangkokDay(at("2026-12-31T17:00:00.000Z"))).toBe(bangkokDay(at("2026-12-31T16:59:59.999Z")) + 1);
    // A start a moment ahead of the clock (two machines' clocks) is still day 1, never day 0.
    expect(trialDay(at("2026-12-07T17:00:00.000Z"), at("2026-12-07T16:59:59.999Z"))).toBe(1);
  });

  it("ends the trial when day 15 begins, and leaves a shop with no LINE connection unstarted", () => {
    expect(gateShop(input(), at(LAST_MOMENT_OF_DAY_14))).toMatchObject({ day: 14, trialEnded: false });
    expect(gateShop(input(), at(DAY_15_BEGINS))).toMatchObject({ day: 15, trialEnded: true });
    expect(gateShop(input({ trialStartedAt: null }), at(DAY_15_BEGINS))).toEqual({
      tenant: "pilot:baan-mali",
      name: "Baan Mali",
      trialStartedAt: null,
      day: null,
      trialEnded: false,
      paid: false,
      paidSatang: 0,
      activeOnDay14: "not_yet",
      inCohort: true,
    });
  });

  it("says not yet for activity on day 14 before day 14, and no only once day 14 is over", () => {
    const decided = input({ decisions: ["2026-12-15T05:00:00.000Z"] }); // 12:00 on day 9
    // Before day 14, even a decision already inside day 14's window is no answer yet.
    expect(gateShop(decided, at("2026-12-16T05:00:00.000Z")).activeOnDay14).toBe("not_yet"); // day 10
    expect(gateShop(decided, at("2026-12-19T16:59:59.999Z")).activeOnDay14).toBe("not_yet"); // day 13
    // On day 14 a decision in the window is a yes at once; without one, day 14 is not over yet.
    expect(gateShop(decided, at("2026-12-19T17:00:00.000Z")).activeOnDay14).toBe("yes");
    expect(gateShop(input(), at(LAST_MOMENT_OF_DAY_14)).activeOnDay14).toBe("not_yet");
    // From day 15 on, the answer is settled.
    expect(gateShop(decided, at(DAY_15_BEGINS)).activeOnDay14).toBe("yes");
    expect(gateShop(input(), at(DAY_15_BEGINS)).activeOnDay14).toBe("no");
    expect(gateShop(input(), at("2027-03-01T03:00:00.000Z")).activeOnDay14).toBe("no");
  });

  it("counts a decision in the seven Bangkok days up to and including day 14, to the millisecond", () => {
    const later = at("2027-01-30T03:00:00.000Z");
    const active = (...decisions: string[]) => gateShop(input({ decisions }), later).activeOnDay14;
    expect(active("2026-12-13T16:59:59.999Z")).toBe("no"); // 23:59:59.999 on day 7
    expect(active("2026-12-13T17:00:00.000Z")).toBe("yes"); // 00:00 on day 8
    expect(active("2026-12-20T16:59:59.999Z")).toBe("yes"); // 23:59:59.999 on day 14
    expect(active("2026-12-20T17:00:00.000Z")).toBe("no"); // 00:00 on day 15
    // Decisions before and after the window do not make up for none inside it.
    expect(active("2026-12-08T03:00:00.000Z", "2026-12-25T03:00:00.000Z")).toBe("no");
    expect(gateShop(input({ decisions: ["2026-12-08T03:00:00.000Z", "2026-12-25T03:00:00.000Z",
      "2026-12-18T03:00:00.000Z"] }), later)).toMatchObject({ activeOnDay14: "yes",
      lastDecisionAt: "2026-12-25T03:00:00.000Z" });
    expect(gateShop(input(), later)).not.toHaveProperty("lastDecisionAt");
  });

  it("marks a shop paid once its subscription payments reach ฿499, saying when", () => {
    const now = at("2027-01-05T03:00:00.000Z");
    const shop = (...payments: SubscriptionPayment[]) => gateShop(input({ subscriptionPayments: payments }), now);
    expect(shop()).toMatchObject({ paid: false, paidSatang: 0 });
    expect(shop()).not.toHaveProperty("paidAt");
    const short = shop(payment(49800, "2026-12-21T05:00:00.000Z"));
    expect(short).toMatchObject({ paid: false, paidSatang: 49800 });
    expect(short).not.toHaveProperty("paidAt");
    expect(shop(payment(49900, "2026-12-21T05:00:00.000Z"))).toMatchObject({ paid: true,
      paidAt: "2026-12-21T05:00:00.000Z", paidSatang: 49900 });
    // Two transfers that together reach the price: paid when the second arrived, in whatever order they are listed.
    expect(shop(payment(24900, "2026-12-22T05:00:00.000Z"), payment(25000, "2026-12-21T05:00:00.000Z")))
      .toMatchObject({ paid: true, paidAt: "2026-12-22T05:00:00.000Z", paidSatang: 49900 });
    // Two months at once is paid from that payment, and a payment made during the trial counts.
    expect(shop(payment(99800, "2026-12-19T05:00:00.000Z"))).toMatchObject({ paid: true,
      paidAt: "2026-12-19T05:00:00.000Z", paidSatang: 99800 });
  });
});

describe("the cohort's two percentages", () => {
  const now = at("2027-01-10T03:00:00.000Z");
  const PAID = [payment(49900, "2026-12-21T05:00:00.000Z")];
  const ACTIVE = ["2026-12-18T05:00:00.000Z"]; // day 12

  /// A shop whose trial started on 7 December: day 35 on 10 January, long past day 14.
  function ended(name: string, paid: boolean, active: boolean): GateShopInput {
    return input({ tenant: `pilot:${name}`, name, subscriptionPayments: paid ? PAID : [], decisions: active ? ACTIVE : [] });
  }

  /// Paid and active, and still not counted: mid-trial, on day 14 itself, or never started.
  const notCounted = [
    input({ tenant: "pilot:mid", trialStartedAt: "2027-01-01T03:00:00.000Z", subscriptionPayments: PAID,
      decisions: ["2027-01-09T05:00:00.000Z"] }),
    input({ tenant: "pilot:day-14", trialStartedAt: "2026-12-28T03:00:00.000Z", subscriptionPayments: PAID,
      decisions: ["2027-01-09T05:00:00.000Z"] }),
    input({ tenant: "pilot:unstarted", trialStartedAt: null, subscriptionPayments: PAID }),
  ];

  it("leaves a shop its owner made out of the counts, listed and marked, until an operator adds it", () => {
    const operators = [ended("a", true, true), ended("b", false, false)];
    // Paid and active long past day 14, and still left out: nobody chose it for the pilot.
    const selfServe = { ...ended("own", true, true), selfServe: true };
    const gate = pilotGate([...operators, selfServe], now);
    expect(gate.shops.map((shop) => [shop.tenant, shop.selfServe, shop.inCohort])).toEqual([
      ["pilot:a", undefined, true],
      ["pilot:b", undefined, true],
      ["pilot:own", true, false],
    ]);
    expect(gate.cohort.counted).toBe(2);
    expect(gate.cohort.paid).toEqual({ count: 1, percent: 50, thresholdPercent: 25, met: true });
    expect(gate.cohort.active).toEqual({ count: 1, percent: 50, thresholdPercent: 50, met: true });
    // Added by an operator, it counts as any other shop does.
    const added = pilotGate([...operators, { ...selfServe, addedToCohort: true }], now);
    expect(added.shops[2]).toMatchObject({ selfServe: true, inCohort: true });
    expect(added.cohort.counted).toBe(3);
    expect(added.cohort.paid.count).toBe(2);
    // A self-serve shop alone is not enough data, however well it does.
    expect(pilotGate([selfServe], now).cohort.status).toBe("not_enough_data");
  });

  it("counts only shops whose day 14 has passed", () => {
    const gate = pilotGate([...notCounted, ended("a", true, true), ended("b", false, true), ended("c", false, false),
      ended("d", false, false)], now);
    expect(gate.shops.map((shop) => [shop.tenant, shop.day, shop.trialEnded])).toEqual([
      ["pilot:mid", 10, false],
      ["pilot:day-14", 14, false],
      ["pilot:unstarted", null, false],
      ["pilot:a", 35, true],
      ["pilot:b", 35, true],
      ["pilot:c", 35, true],
      ["pilot:d", 35, true],
    ]);
    // 1 paid of 4 is exactly 25% and 2 active of 4 exactly 50%: a share on its line meets it.
    expect(gate.cohort).toEqual({
      counted: 4,
      paid: { count: 1, percent: 25, thresholdPercent: 25, met: true },
      active: { count: 2, percent: 50, thresholdPercent: 50, met: true },
      status: "on_track",
    });
    expect(gate.asOf).toBe("2027-01-10T03:00:00.000Z");
  });

  it("is below the line when either share is under its line", () => {
    const shops = [ended("a", true, true), ended("b", false, true), ended("c", false, false), ended("d", false, false)];
    expect(pilotGate([...shops, ended("e", false, false)], now).cohort).toEqual({
      counted: 5,
      paid: { count: 1, percent: 20, thresholdPercent: 25, met: false },
      active: { count: 2, percent: 40, thresholdPercent: 50, met: false },
      status: "below_line",
    });
    // Paid meets its line, active does not.
    expect(pilotGate([...shops, ended("e", true, false)], now).cohort).toMatchObject({
      paid: { count: 2, percent: 40, met: true },
      active: { count: 2, percent: 40, met: false },
      status: "below_line",
    });
  });

  it("rounds a share down to a whole percent, so it never shows a line it has not reached", () => {
    const shops = Array.from({ length: 200 }, (_, index) => ended(`s${index}`, false, index < 99));
    expect(pilotGate(shops, now).cohort.active).toEqual({ count: 99, percent: 49, thresholdPercent: 50, met: false });
    shops[150] = ended("s150", false, true);
    expect(pilotGate(shops, now).cohort.active).toEqual({ count: 100, percent: 50, thresholdPercent: 50, met: true });
  });

  it("has not enough data until some shop's day 14 has passed", () => {
    const empty = { count: 0, percent: null, met: false };
    expect(pilotGate(notCounted, now).cohort).toEqual({
      counted: 0,
      paid: { ...empty, thresholdPercent: 25 },
      active: { ...empty, thresholdPercent: 50 },
      status: "not_enough_data",
    });
    expect(pilotGate([], now).cohort.status).toBe("not_enough_data");
  });
});

// ---------------------------------------------------------------------------
// The records and the route, through the real Worker and objects
// ---------------------------------------------------------------------------

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const DAY_MS = 24 * 60 * 60 * 1000;
const BOT = `U${"b".repeat(32)}`;
const CUSTOMER = `U${"c".repeat(32)}`;

async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const response = await adminFetch(`https://api.manut.test${path}`, {
    method,
    headers: OPERATOR,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/// An operator call through the admin gate against `target`, an environment with one binding wrapped.
async function adminWith<T = Record<string, unknown>>(target: Env, method: string, path: string) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => undefined }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method, headers: OPERATOR }),
    target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

/// The Worker's environment with every vault answering 500 for a first connection's time, as when the vault cannot
/// be reached. Every other call reaches the real objects.
function vaultUnreachable(): Env {
  const namespace = bindings.CRED;
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === "/first-connection") {
            return Response.json({ error: "fixture_vault_unreachable" }, { status: 500 });
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...bindings, CRED: wrapped };
}

/// A public request with its own source address, so the link routes' rate limit never trips across tests.
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://api.manut.test${path}`, init);
  request.headers.set("cf-connecting-ip", `2001:db8::${crypto.randomUUID().slice(0, 4)}`);
  const context = createExecutionContext();
  const response = await worker.fetch(request, bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

async function newShop(name: string): Promise<string> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName: "Khun Fon" });
  expect(created.status).toBe(200);
  return created.body.tenant;
}

async function connectLine(tenant: string): Promise<string> {
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant, channelId: "2000000001", botUserId: BOT, channelSecret: "fixture-line-channel-secret-0001",
    channelAccessToken: `fixture-token-${crypto.randomUUID()}`,
  });
  expect(connected.status).toBe(200);
  return connected.body.connectionId;
}

const tenantObject = (tenant: string) => bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
const shopKey = (tenant: string) => `pilot-shop:${encodeURIComponent(tenant)}`;

async function shopRecord(tenant: string): Promise<PilotShopRecord> {
  const response = await tenantCall(bindings, tenant, `/pilot/shop?tenant=${encodeURIComponent(tenant)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { shop: PilotShopRecord }).shop;
}

/// Rewrites the stored shop, as time passing or a record written before this change would leave it.
async function editShop(tenant: string, edit: (shop: PilotShopRecord) => PilotShopRecord) {
  await runInDurableObject(tenantObject(tenant), async (_instance, state) => {
    const shop = await state.storage.get<PilotShopRecord>(shopKey(tenant));
    expect(shop).toBeDefined();
    await state.storage.put(shopKey(tenant), edit(shop!));
  });
}

/// A trial that started `days` days ago, to the millisecond, so its day number does not depend on the hour.
async function startedDaysAgo(tenant: string, days: number): Promise<number> {
  const startMs = Date.now() - days * DAY_MS;
  await editShop(tenant, (shop) => ({ ...shop, trialStartedAt: new Date(startMs).toISOString() }));
  return startMs;
}

/// Owner decisions on replies, stored as the owner's link stores them: on the reply record, approve or decline alike.
async function ownerDecided(tenant: string, ...times: number[]) {
  await runInDurableObject(tenantObject(tenant), async (_instance, state) => {
    for (const time of times) {
      const actionId = crypto.randomUUID();
      const reply: PilotReplyRecord = { taskId: "pilot-task-fixture", actionId, messageId: "msg-fixture",
        connectionId: "connection-fixture", lineUserId: CUSTOMER, proposedAt: new Date(time - 60_000).toISOString(),
        expiresAt: new Date(time + DAY_MS).toISOString(), decidedAt: new Date(time).toISOString() };
      await state.storage.put(`pilot-reply:${encodeURIComponent(tenant)}:${encodeURIComponent(actionId)}`, reply);
    }
  });
}

async function paySubscription(body: Record<string, unknown>) {
  return admin<SubscriptionPayment & { error?: string }>("POST", "/v1/admin/pilot/subscription-payments", body);
}

async function readGate(): Promise<PilotGate> {
  const answer = await admin<PilotGate>("GET", "/v1/admin/pilot/gate");
  expect(answer.status).toBe(200);
  return answer.body;
}

async function gateRow(tenant: string) {
  return (await readGate()).shops.find((shop) => shop.tenant === tenant);
}

describe("a shop's trial start", () => {
  it("is its first LINE connection, never its creation, and a new connection never moves it", async () => {
    const tenant = await newShop("Baan Mali");
    expect(await shopRecord(tenant)).not.toHaveProperty("trialStartedAt");
    expect(await gateRow(tenant)).toMatchObject({ trialStartedAt: null, day: null, trialEnded: false });

    await connectLine(tenant);
    const started = (await shopRecord(tenant)).trialStartedAt;
    expect(started).toEqual(expect.any(String));
    expect(Date.parse(started!)).toBeGreaterThanOrEqual(Date.parse((await shopRecord(tenant)).createdAt));
    expect(Date.parse(started!)).toBeLessThanOrEqual(Date.now());
    expect(await gateRow(tenant)).toMatchObject({ trialStartedAt: started, day: 1, trialEnded: false });

    // A rotated token is a new connection; the trial keeps the day it started.
    await connectLine(tenant);
    expect((await shopRecord(tenant)).trialStartedAt).toBe(started);
  });

  it("of a shop connected before trial starts were recorded is its first connection in the vault, even a revoked one", async () => {
    const tenant = await newShop("Baan Mali");
    const first = await connectLine(tenant);
    const second = await connectLine(tenant); // revokes the first
    await editShop(tenant, ({ trialStartedAt: _dropped, ...shop }) => shop);
    const firstMs = Date.now() - 20 * DAY_MS;
    const vault = bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
    await runInDurableObject(vault, async (_instance, state) => {
      for (const [id, createdAt] of [[first, firstMs], [second, Date.now() - 2 * DAY_MS]] as const) {
        const record = await state.storage.get<Record<string, unknown>>(`conn:${id}`);
        expect(record).toBeDefined();
        await state.storage.put(`conn:${id}`, { ...record, createdAt: new Date(createdAt).toISOString() });
      }
    });
    expect(await gateRow(tenant)).toMatchObject({ trialStartedAt: new Date(firstMs).toISOString(), day: 21,
      trialEnded: true });

    // The vault answers only for the tenant whose vault it is, and only that one time.
    const read = (asTenant: string) => vault.fetch(new Request(
      `https://cred/first-connection?tenant=${encodeURIComponent(tenant)}&provider=line`,
      { headers: { "x-tenant": asTenant } }));
    expect(await (await read(tenant)).json()).toEqual({ createdAt: new Date(firstMs).toISOString() });
    expect((await read("pilot:someone-else")).status).toBe(404);
  });
});

describe("subscription payments", () => {
  it("records the shop's payment to Manut AI in integer satang against a slip, and lists them newest first", async () => {
    const tenant = await newShop("Baan Mali");
    const first = await paySubscription({ tenant, amountSatang: 24900, slipRef: "  KB-20261221-0001 ",
      slipNote: "KBank 21 Dec 10:02" });
    expect(first).toEqual({ status: 200, body: { id: expect.any(String), tenant, amountSatang: 24900,
      slipRef: "KB-20261221-0001", slipNote: "KBank 21 Dec 10:02", confirmedAt: expect.any(String) } });
    const second = await paySubscription({ tenant, amountSatang: 25000, slipRef: "SCB-77" });
    expect(second.status).toBe(200);
    expect(second.body).not.toHaveProperty("slipNote");

    const listed = await admin<{ payments: SubscriptionPayment[] }>("GET",
      `/v1/admin/pilot/subscription-payments?tenant=${encodeURIComponent(tenant)}`);
    expect(listed.status).toBe(200);
    expect(listed.body.payments.map((payment) => payment.slipRef)).toEqual(["SCB-77", "KB-20261221-0001"]);
    // Customer order payments are a different ledger.
    expect((await admin<{ payments: unknown[] }>("GET",
      `/v1/admin/pilot/payments?tenant=${encodeURIComponent(tenant)}`)).body.payments).toEqual([]);
  });

  it("refuses anything but a positive whole number of satang, a slip reference and a short note", async () => {
    const tenant = await newShop("Baan Mali");
    const good = { tenant, amountSatang: SUBSCRIPTION_PRICE_SATANG, slipRef: "KB-1" };
    for (const bad of [{ amountSatang: 0 }, { amountSatang: -49900 }, { amountSatang: 499.5 }, { amountSatang: "49900" },
      { amountSatang: undefined }, { amountSatang: 2 ** 53 }, { slipRef: "" }, { slipRef: "   " }, { slipRef: undefined },
      { slipRef: 7 }, { slipRef: "x".repeat(129) }, { slipNote: "x".repeat(1001) }, { slipNote: 5 }]) {
      expect(await paySubscription({ ...good, ...bad })).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect((await paySubscription({ ...good, tenant: "pilot:nobody" })).body).toEqual({ error: "shop_not_found" });
    expect((await paySubscription({ amountSatang: 49900, slipRef: "KB-1" })).body).toEqual({ error: "tenant_required" });
    expect((await admin<{ payments: unknown[] }>("GET",
      `/v1/admin/pilot/subscription-payments?tenant=${encodeURIComponent(tenant)}`)).body.payments).toEqual([]);
  });

  it("counts a slip once: the same reference again is refused, whatever its spaces and capitals", async () => {
    const tenant = await newShop("Baan Mali");
    expect((await paySubscription({ tenant, amountSatang: 25000, slipRef: "KB-20261221-0001" })).status).toBe(200);
    for (const slipRef of ["KB-20261221-0001", " kb-20261221-0001", "KB-2026 1221-0001"]) {
      expect(await paySubscription({ tenant, amountSatang: 25000, slipRef }))
        .toEqual({ status: 409, body: { error: "slip_already_recorded" } });
    }
    // Recorded twice, one half would have read as the whole price.
    expect(await gateRow(tenant)).toMatchObject({ paid: false, paidSatang: 25000 });
  });
});

describe("GET /v1/admin/pilot/gate", () => {
  // The tests of one file share storage, so the registry also holds the shops earlier tests made. Each test checks
  // its own shops' rows exactly and the cohort by what its shops added to it.
  it("measures every shop from its own records and counts only those past day 14", async () => {
    const before = await readGate();
    const paidActive = await newShop("Baan Mali");
    const activeOnly = await newShop("Sabai Tea");
    const quiet = await newShop("Khao Man Gai Lek");
    const midTrial = await newShop("Som Tam Nua");
    const unconnected = await newShop("Kanom Jeen");
    for (const tenant of [paidActive, activeOnly, quiet, midTrial]) await connectLine(tenant);

    const paidActiveStart = await startedDaysAgo(paidActive, 20); // day 21
    await ownerDecided(paidActive, paidActiveStart + 9 * DAY_MS); // day 10
    const paidAt = (await paySubscription({ tenant: paidActive, amountSatang: 49900, slipRef: "KB-1" })).body
      .confirmedAt;
    const activeOnlyStart = await startedDaysAgo(activeOnly, 16); // day 17
    const lastDecision = activeOnlyStart + 13 * DAY_MS; // day 14
    await ownerDecided(activeOnly, activeOnlyStart + DAY_MS, lastDecision);
    const quietStart = await startedDaysAgo(quiet, 15); // day 16
    await ownerDecided(quiet, quietStart + 2 * DAY_MS); // day 3, before the window
    await startedDaysAgo(midTrial, 5); // day 6
    await paySubscription({ tenant: midTrial, amountSatang: 49900, slipRef: "KB-2" });

    const gate = await readGate();
    const row = (tenant: string) => gate.shops.find((shop) => shop.tenant === tenant);
    expect(row(paidActive)).toEqual({ tenant: paidActive, name: "Baan Mali",
      trialStartedAt: new Date(paidActiveStart).toISOString(), day: 21, trialEnded: true, paid: true, paidAt,
      paidSatang: 49900, activeOnDay14: "yes", lastDecisionAt: new Date(paidActiveStart + 9 * DAY_MS).toISOString(),
      inCohort: true });
    expect(row(activeOnly)).toMatchObject({ day: 17, trialEnded: true, paid: false, paidSatang: 0, activeOnDay14: "yes",
      lastDecisionAt: new Date(lastDecision).toISOString() });
    expect(row(quiet)).toMatchObject({ day: 16, trialEnded: true, paid: false, activeOnDay14: "no" });
    expect(row(midTrial)).toMatchObject({ day: 6, trialEnded: false, paid: true, activeOnDay14: "not_yet" });
    expect(row(unconnected)).toMatchObject({ trialStartedAt: null, day: null, trialEnded: false, activeOnDay14: "not_yet" });
    // Three of these shops are past day 14: one of them paid and two were active. The mid-trial shop's payment
    // does not count.
    expect(gate.cohort.counted - before.cohort.counted).toBe(3);
    expect(gate.cohort.paid.count - before.cohort.paid.count).toBe(1);
    expect(gate.cohort.active.count - before.cohort.active.count).toBe(2);
    // The cohort is the one of every row answered, against both lines.
    const counted = gate.shops.filter((shop) => shop.inCohort && shop.trialEnded);
    const paid = counted.filter((shop) => shop.paid).length;
    const active = counted.filter((shop) => shop.activeOnDay14 === "yes").length;
    expect(gate.cohort).toEqual({
      counted: counted.length,
      paid: { count: paid, percent: Math.floor((paid * 100) / counted.length), thresholdPercent: 25,
        met: paid * 100 >= 25 * counted.length },
      active: { count: active, percent: Math.floor((active * 100) / counted.length), thresholdPercent: 50,
        met: active * 100 >= 50 * counted.length },
      status: paid * 100 >= 25 * counted.length && active * 100 >= 50 * counted.length ? "on_track" : "below_line",
    });
  });

  it("counts an owner's decline through the approval link as activity", async () => {
    const tenant = await newShop("Baan Mali");
    const connectionId = await connectLine(tenant);
    const stored = await tenantCall(bindings, tenant, "/pilot/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pilot": "1" },
      body: JSON.stringify({ tenant, connectionId, events: [{ webhookEventId: crypto.randomUUID(), lineUserId: CUSTOMER,
        text: "เปิดกี่โมงคะ" }] }),
    });
    expect(stored.status).toBe(200);
    const [{ id: messageId }] = ((await stored.json()) as { created: { id: string }[] }).created as [{ id: string }];
    const proposed = await admin<{ approvalUrl: string }>("POST", "/v1/admin/pilot/replies",
      { tenant, messageId, text: "เปิด 9 โมงค่ะ" });
    expect(proposed.status).toBe(200);
    const token = proposed.body.approvalUrl.split("/approve/")[1]!;
    const declined = await call(`/v1/pilot/approvals/${token}/decision`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: false }) });
    expect(declined.status).toBe(200);
    const { decidedAt } = (await declined.json()) as { decidedAt: string };

    await startedDaysAgo(tenant, 13); // today is day 14
    expect(await gateRow(tenant)).toMatchObject({ day: 14, activeOnDay14: "yes", lastDecisionAt: decidedAt });
  });

  it("answers 503 rather than leave a shop out of the cohort or guess its trial start", async () => {
    const tenant = await newShop("Baan Mali");
    await connectLine(tenant);
    // A shop connected before trial starts were recorded.
    await editShop(tenant, ({ trialStartedAt: _dropped, ...shop }) => shop);
    const unavailable = { status: 503, body: { error: "gate_unavailable" } };

    // Its vault cannot be reached.
    expect(await adminWith(vaultUnreachable(), "GET", "/v1/admin/pilot/gate")).toEqual(unavailable);

    // Its vault holds no connection at all, which a connected shop never lacks. The records are put back after,
    // since the tests of this file share storage.
    const vault = bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
    const saved = await runInDurableObject(vault, async (_instance, state) => {
      const records = await state.storage.list({ prefix: "conn:" });
      await state.storage.delete([...records.keys()]);
      return [...records.entries()];
    });
    expect(await admin("GET", "/v1/admin/pilot/gate")).toEqual(unavailable);
    await runInDurableObject(vault, async (_instance, state) => {
      await state.storage.put(Object.fromEntries(saved));
    });
    expect((await gateRow(tenant))?.trialStartedAt).toEqual(expect.any(String));
  });
});

describe("subscription payments with the shop's other data", () => {
  it("are exported with the shop and deleted with it", async () => {
    const tenant = await newShop("Sabai Tea");
    expect((await paySubscription({ tenant, amountSatang: 49900, slipRef: "KB-9" })).status).toBe(200);
    const exported = await admin<{ pilot: { shop: PilotShopRecord; subscriptionPayments: SubscriptionPayment[] } }>(
      "GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(tenant)}`);
    expect(exported.status).toBe(200);
    expect(exported.body.pilot.subscriptionPayments).toEqual([expect.objectContaining({ slipRef: "KB-9",
      amountSatang: 49900 })]);

    // Never connected and never consented, so the operator's request deletes it at once.
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant, confirmName: "Sabai Tea" })).status).toBe(200);
    await runInDurableObject(tenantObject(tenant), async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "pilot-" })).keys()]).toEqual([]);
    });
    expect((await readGate()).shops.some((shop) => shop.tenant === tenant)).toBe(false);
  });

  it("count among the payment records a live shop's owner is told will go, and the trial start is exported", async () => {
    const tenant = await newShop("Baan Mali");
    await connectLine(tenant);
    expect((await admin("POST", "/v1/admin/pilot/payments", { tenant, orderRef: "ORD-1", amountSatang: 15000,
      promptPayId: "0812345678" })).status).toBe(200);
    expect((await paySubscription({ tenant, amountSatang: 49900, slipRef: "KB-3" })).status).toBe(200);
    const exported = await admin<{ pilot: { shop: PilotShopRecord } }>("GET",
      `/v1/admin/pilot/export?tenant=${encodeURIComponent(tenant)}`);
    expect(exported.body.pilot.shop.trialStartedAt).toEqual(expect.any(String));

    const asked = await admin<{ confirmUrl: string }>("POST", "/v1/admin/pilot/deletions",
      { tenant, confirmName: "Baan Mali" });
    expect(asked.status).toBe(202);
    const view = await call(`/v1/pilot/deletions/${asked.body.confirmUrl.split("/delete/")[1]}`);
    expect(((await view.json()) as { goes: Record<string, unknown> }).goes).toEqual({ messages: 0, replies: 0,
      payments: 2, lineConnected: true });
  });
});
