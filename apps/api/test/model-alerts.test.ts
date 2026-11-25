import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { capNoticeKey, NOTICE_RETRY_MS } from "../src/model-alerts";
import { HOLD_TTL_MS, SWEEP_MARGIN_MS } from "../src/model-meter";
import { bangkokMonth } from "../src/model-price";
import { authCall, tenantCall } from "../src/tenant-data";

// Alerts near the cap: each shop's month notes the first time its charged model spend reaches 80% of the shop's cap, and
// 100%, with an audit entry each, and AuthObject keeps one row per listed shop so the console lists them from one read.
// The global fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
/// 10:00 on 23 November 2026 in Bangkok: the meter's own tests' clock, for what does not touch the real one.
const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const AT = new Date(NOW).toISOString();

let counter = 0;
const fresh = (label: string) => `model-alerts:${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// An operator call through the admin gate, against `target`.
async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown, target: Env = bindings) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", {
    value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => undefined },
    configurable: true,
  });
  const response = await worker.fetch(
    new Request(`https://api.manut.test${path}`, { method, headers: OPERATOR, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    target,
    context,
  );
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

/// A pilot shop on the registry, as an operator makes one.
async function shop(name: string): Promise<string> {
  const made = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName: "Fon" });
  expect(made.status).toBe(200);
  return made.body.tenant;
}

/// A write to the tenant's meter, as the gateway makes it.
async function meter<T = Record<string, unknown>>(tenant: string, path: string, body: Record<string, unknown>) {
  const response = await tenantCall(bindings, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-model": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function reserve(tenant: string, worstMillisatang: number, nowMs = NOW): Promise<string> {
  const answer = await meter<{ callId: string }>(tenant, "/model/reserve",
    { model: "claude-sonnet-5-5", worstMillisatang, defaultCapSatang: 20_000, nowMs });
  expect(answer.status).toBe(200);
  return answer.body.callId;
}

/// One call charged exactly `millisatang`: its reservation and its settle.
async function spend(tenant: string, millisatang: number, nowMs = NOW): Promise<void> {
  const callId = await reserve(tenant, millisatang, nowMs);
  expect((await meter(tenant, "/model/settle", { callId, inputTokens: 1, outputTokens: 1, millisatang, nowMs })).status)
    .toBe(200);
}

/// The cap set as an operator's route sets it: with the default cap and the time, so the month is measured again.
async function capAt(tenant: string, capSatang: number | null, nowMs = NOW) {
  expect((await meter(tenant, "/model/cap", { capSatang, setBy: null, defaultCapSatang: 20_000, nowMs })).status).toBe(200);
}

type Crossing = { percent: number; at: string; capSatang: number; spentMillisatang: number };

async function crossingsOf(tenant: string, month = "2026-11"): Promise<Crossing[]> {
  const response = await tenantCall(bindings, tenant, `/model/usage?tenant=${encodeURIComponent(tenant)}&month=${month}`);
  const { totals } = (await response.json()) as { totals: { crossings?: Crossing[] } };
  return totals.crossings ?? [];
}

type Entry = { actor: Record<string, unknown>; action: string; subject: Record<string, string>; outcome: string;
  amountSatang?: number };

/// The audit entries the crossings wrote, oldest first.
async function crossingEntries(tenant: string): Promise<Entry[]> {
  const response = await tenantCall(bindings, tenant, `/audit/export?tenant=${encodeURIComponent(tenant)}`);
  const { entries } = (await response.json()) as { entries: Entry[] };
  return entries.filter((entry) => ["model.cap_near", "model.cap_reached"].includes(entry.action));
}

type ListedShop = { tenant: string; percent: number; crossings: (Crossing & { spentSatang: number })[] };
type Alerts = { month: string; shops: ListedShop[]; truncated: boolean };

async function alerts(target: Env = bindings): Promise<Alerts> {
  const read = await admin<Alerts>("GET", "/v1/admin/model/alerts", undefined, target);
  expect(read.status).toBe(200);
  return read.body;
}

const stubOf = (tenant: string) => bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
const alarmOf = (tenant: string) => runInDurableObject(stubOf(tenant), (_instance, state) => state.storage.getAlarm());

/// A notice the shop's object sends AuthObject, sent directly, as a late or a replayed one would arrive.
async function notice(body: Record<string, unknown>, headers: Record<string, string> = { "x-model": "1" }) {
  const response = await authCall(bindings, "/model-alerts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function rowsOf(month: string): Promise<{ tenant: string; seq: number; crossings: Crossing[] }[]> {
  const response = await authCall(bindings, `/model-alerts?month=${month}`);
  return ((await response.json()) as { rows: { tenant: string; seq: number; crossings: Crossing[] }[] }).rows;
}

/// An AUTH namespace whose object cannot be reached, as AuthObject down or overloaded looks to the shop's object.
const unreachableAuth = {
  idFromName: (name: string) => bindings.AUTH.idFromName(name),
  get: () => ({ fetch: async () => { throw new Error("auth_unreachable"); } }),
} as unknown as DurableObjectNamespace;

/// Runs `body` while the shop's own object reaches AuthObject through `auth`, then puts its own back. The object reads
/// AUTH from its own env, not the Worker's, so the swap is made on the instance.
async function withAuth<T>(tenant: string, auth: DurableObjectNamespace, body: () => Promise<T>): Promise<T> {
  let saved: unknown;
  await runInDurableObject(stubOf(tenant), (instance) => {
    const holder = instance as unknown as { env: Record<string, unknown> };
    saved = holder.env;
    holder.env = { ...holder.env, AUTH: auth };
  });
  try {
    return await body();
  } finally {
    await runInDurableObject(stubOf(tenant), (instance) => {
      (instance as unknown as { env: unknown }).env = saved;
    });
  }
}

describe("crossings of a shop's cap", () => {
  it("notes 80% and then 100% of the cap once each, in integers, with one audit entry each", async () => {
    const tenant = fresh("thresholds");
    await capAt(tenant, 10);
    // 7,999 of 10,000 millisatang is just under 80%.
    await spend(tenant, 7_999);
    expect(await crossingsOf(tenant)).toEqual([]);
    await spend(tenant, 1);
    expect(await crossingsOf(tenant)).toEqual([{ percent: 80, at: AT, capSatang: 10, spentMillisatang: 8_000 }]);
    // Past 80% and short of the cap: nothing new.
    await spend(tenant, 1_999, NOW + 1_000);
    expect(await crossingsOf(tenant)).toHaveLength(1);
    // The provider answered without a usable count, so the worst case is charged, and it fills the cap exactly.
    const last = await reserve(tenant, 1, NOW + 2_000);
    expect((await meter(tenant, "/model/settle", { callId: last, unreadable: true, nowMs: NOW + 2_000 })).status).toBe(200);
    expect(await crossingsOf(tenant)).toEqual([
      { percent: 80, at: AT, capSatang: 10, spentMillisatang: 8_000 },
      { percent: 100, at: new Date(NOW + 2_000).toISOString(), capSatang: 10, spentMillisatang: 10_000 },
    ]);
    // At the cap, the next call is refused, which notes nothing more.
    expect((await meter(tenant, "/model/reserve", { model: "claude-sonnet-5-5", worstMillisatang: 1,
      defaultCapSatang: 20_000, nowMs: NOW + 3_000 })).status).toBe(402);

    const entries = await crossingEntries(tenant);
    expect(entries).toEqual([
      expect.objectContaining({ actor: { kind: "system" }, action: "model.cap_near", subject: { month: "2026-11" },
        outcome: "ok", amountSatang: 10 }),
      expect.objectContaining({ actor: { kind: "system" }, action: "model.cap_reached", subject: { month: "2026-11" },
        outcome: "ok", amountSatang: 10 }),
    ]);
    // Metadata only: the entries name a month, a cap and nothing else.
    for (const entry of entries) expect(Object.keys(entry).sort()).toEqual(["action", "actor", "amountSatang", "at", "id", "outcome", "subject"]);
    // Several whole requests against real objects: about two seconds alone, and past the five-second default once on
    // a slow CI runner (25 Nov 2026, `7ef8505`, three files in one run), so it has thirty.
  }, 30_000);

  it("counts what was charged, not what is held: a reservation's worst case notes nothing", async () => {
    const tenant = fresh("held");
    await capAt(tenant, 10);
    const held = await reserve(tenant, 9_000);
    expect(await crossingsOf(tenant)).toEqual([]);
    expect((await meter(tenant, "/model/release", { callId: held, nowMs: NOW })).status).toBe(200);
    expect(await crossingsOf(tenant)).toEqual([]);
    expect(await crossingEntries(tenant)).toEqual([]);
  });

  it("takes a crossing off when a raised cap puts the spend back under it, notes one a lowered cap puts it past, and does neither under a cap of zero", async () => {
    const tenant = fresh("rearm");
    await capAt(tenant, 10);
    await spend(tenant, 8_000);
    expect((await crossingsOf(tenant)).map((crossing) => crossing.percent)).toEqual([80]);

    // Raised to 20 satang, 8,000 millisatang is 40%: the crossing comes off, and can be noted again.
    await capAt(tenant, 20);
    expect(await crossingsOf(tenant)).toEqual([]);
    await spend(tenant, 8_000, NOW + 1_000);
    expect(await crossingsOf(tenant)).toEqual([
      { percent: 80, at: new Date(NOW + 1_000).toISOString(), capSatang: 20, spentMillisatang: 16_000 }]);

    // Lowered to 16 satang, the spend is at the cap already: noted at the change, against the new cap.
    await capAt(tenant, 16, NOW + 2_000);
    expect(await crossingsOf(tenant)).toEqual([
      { percent: 80, at: new Date(NOW + 1_000).toISOString(), capSatang: 20, spentMillisatang: 16_000 },
      { percent: 100, at: new Date(NOW + 2_000).toISOString(), capSatang: 16, spentMillisatang: 16_000 },
    ]);

    // A cap of zero is a stop, not a budget: what was noted stays noted.
    const before = await crossingsOf(tenant);
    await capAt(tenant, 0, NOW + 3_000);
    expect(await crossingsOf(tenant)).toEqual(before);

    // Back to the default of ฿200, the spend is far under both.
    await capAt(tenant, null, NOW + 4_000);
    expect(await crossingsOf(tenant)).toEqual([]);
    // And a cap of zero notes nothing either, though any spend is "past" zero.
    await capAt(tenant, 0, NOW + 5_000);
    expect(await crossingsOf(tenant)).toEqual([]);

    expect((await crossingEntries(tenant)).map((entry) => [entry.action, entry.amountSatang])).toEqual([
      ["model.cap_near", 10],
      ["model.cap_near", 20],
      ["model.cap_reached", 16],
    ]);
  });

  it("notes what an abandoned call's worst case takes the month to, whichever path charges it", async () => {
    const tenant = fresh("abandoned");
    await capAt(tenant, 10);
    await reserve(tenant, 8_000);
    // The next write, a quarter of an hour on, finds the hold expired and charges its worst case.
    await reserve(tenant, 1, NOW + HOLD_TTL_MS);
    expect(await crossingsOf(tenant)).toEqual([
      { percent: 80, at: new Date(NOW + HOLD_TTL_MS).toISOString(), capSatang: 10, spentMillisatang: 8_000 }]);
  });
});

describe("the console's list of shops near or at their caps", () => {
  it("lists this month's shops at their caps, then those near them, across all shops, without asking any shop's object", async () => {
    const atCap = await shop("Cap Kitchen");
    const near = await shop("Near Noodles");
    const calm = await shop("Calm Cafe");
    for (const tenant of [atCap, near, calm]) {
      expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 10 })).status).toBe(200);
    }
    const now = Date.now();
    await spend(near, 8_500, now);
    await spend(atCap, 10_000, now);
    await spend(calm, 5_000, now);

    // Every shop's object out of reach: the list is read from AuthObject alone.
    const unreachable = {
      idFromName: (name: string) => bindings.TENANT.idFromName(name),
      get: () => { throw new Error("a shop's object was asked"); },
    } as unknown as DurableObjectNamespace;
    const listed = await alerts({ ...bindings, TENANT: unreachable });
    expect(listed.month).toBe(bangkokMonth(Date.now()));
    expect(listed.truncated).toBe(false);
    const mine = listed.shops.filter((one) => [atCap, near, calm].includes(one.tenant));
    expect(mine.map((one) => [one.tenant, one.percent])).toEqual([[atCap, 100], [near, 80]]);
    const at = new Date(now).toISOString();
    expect(mine[0]!.crossings).toEqual([
      { percent: 80, at, capSatang: 10, spentSatang: 10, spentMillisatang: 10_000 },
      { percent: 100, at, capSatang: 10, spentSatang: 10, spentMillisatang: 10_000 },
    ]);
    expect(mine[1]!.crossings).toEqual([{ percent: 80, at, capSatang: 10, spentSatang: 9, spentMillisatang: 8_500 }]);

    // The shop's own month says the same.
    const month = await admin<{ crossings: unknown[] }>("GET", `/v1/admin/model/usage?tenant=${encodeURIComponent(near)}`);
    expect(month.body.crossings).toEqual(mine[1]!.crossings);

    // A raised cap takes the shop off the list until it nears the new one.
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant: near, capSatang: 100 })).status).toBe(200);
    expect((await alerts()).shops.map((one) => one.tenant)).not.toContain(near);
  });

  it("keeps a tenant off the list that is not a shop on the registry", async () => {
    const tenant = fresh("unlisted");
    await capAt(tenant, 10, Date.now());
    await spend(tenant, 10_000, Date.now());
    expect(await crossingsOf(tenant, bangkokMonth(Date.now()))).toHaveLength(2);
    expect((await alerts()).shops.map((one) => one.tenant)).not.toContain(tenant);
    // AuthObject answered, so the shop's object has nothing left to send and no alarm for it.
    await runInDurableObject(stubOf(tenant), async (_instance, state) => {
      expect(await state.storage.get(capNoticeKey(tenant))).toMatchObject({ sent: true });
    });
    expect(await alarmOf(tenant)).toBeNull();
  });

  it("takes a deleted shop off the list, and keeps nothing a late notice of it brings", async () => {
    const tenant = await shop("Short-lived Satay");
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 10 })).status).toBe(200);
    await spend(tenant, 10_000, Date.now());
    expect((await alerts()).shops.map((one) => one.tenant)).toContain(tenant);

    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant, confirmName: "Short-lived Satay" })).status).toBe(200);
    expect((await alerts()).shops.map((one) => one.tenant)).not.toContain(tenant);
    await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), async (_instance, state) => {
      const named = [...(await state.storage.list({ prefix: "model-alert" })).keys()]
        .filter((key) => key.endsWith(encodeURIComponent(tenant)));
      expect(named).toEqual([]);
    });
    // The shop's object keeps nothing of the meter, its notice included, and no alarm.
    await runInDurableObject(stubOf(tenant), async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "model-" })).keys()]).toEqual([]);
    });
    expect(await alarmOf(tenant)).toBeNull();

    // A notice it sent before the deletion, arriving after it, finds the shop off the registry and is not kept.
    const month = bangkokMonth(Date.now());
    const late = await notice({ tenant, seq: 99, month,
      crossings: [{ percent: 100, at: new Date().toISOString(), capSatang: 10, spentMillisatang: 10_000 }] });
    expect(late).toEqual({ status: 200, body: { stored: false } });
    expect((await rowsOf(month)).map((row) => row.tenant)).not.toContain(tenant);
  });

  it("keeps the shop's latest month: a late charge that takes an earlier month past 80% stays in that month", async () => {
    const tenant = await shop("Midnight Mee");
    // A minute before midnight on 31 October in Bangkok, and midnight itself.
    const lastOfOctober = Date.UTC(2026, 9, 31, 16, 59, 0);
    const firstOfNovember = Date.UTC(2026, 9, 31, 17, 0, 0);
    await capAt(tenant, 10, lastOfOctober);
    // A call reserved in October that nothing settles, then November's own spend past 80%.
    await reserve(tenant, 8_000, lastOfOctober);
    await spend(tenant, 8_000, firstOfNovember);
    const november = () => rowsOf("2026-11").then((rows) => rows.filter((row) => row.tenant === tenant));
    expect(await november()).toEqual([expect.objectContaining({ seq: 1 })]);

    // A write after October's call expired charges it to October, which reaches 80% as well.
    await reserve(tenant, 1, firstOfNovember + HOLD_TTL_MS);
    expect((await crossingsOf(tenant, "2026-10")).map((crossing) => crossing.percent)).toEqual([80]);
    // The month and the audit log keep it; the cross-shop record keeps November's row and makes none for October.
    expect(await november()).toEqual([expect.objectContaining({ seq: 1 })]);
    expect((await rowsOf("2026-10")).map((row) => row.tenant)).not.toContain(tenant);
    expect((await crossingEntries(tenant)).map((entry) => entry.subject.month)).toEqual(["2026-11", "2026-10"]);
  });

  it("keeps only a shop's newest notice, one row a shop, and refuses a notice that is not one", async () => {
    const tenant = await shop("Order Oolong");
    const crossing = (percent: number) => ({ percent, at: AT, capSatang: 10, spentMillisatang: 10_000 });
    expect(await notice({ tenant, seq: 2, month: "2026-11", crossings: [crossing(80)] }))
      .toEqual({ status: 200, body: { stored: true } });
    // An older notice, arriving late, changes nothing; so does the same one again.
    expect((await notice({ tenant, seq: 1, month: "2026-11", crossings: [crossing(80), crossing(100)] })).body)
      .toEqual({ stored: false });
    expect((await notice({ tenant, seq: 2, month: "2026-11", crossings: [crossing(80), crossing(100)] })).body)
      .toEqual({ stored: false });
    expect((await rowsOf("2026-11")).filter((row) => row.tenant === tenant))
      .toEqual([expect.objectContaining({ seq: 2, crossings: [crossing(80)] })]);
    // A newer month replaces the shop's row, so the record holds one row a shop.
    expect((await notice({ tenant, seq: 3, month: "2026-12", crossings: [crossing(80)] })).body).toEqual({ stored: true });
    expect((await rowsOf("2026-11")).map((row) => row.tenant)).not.toContain(tenant);
    expect((await rowsOf("2026-12")).filter((row) => row.tenant === tenant)).toHaveLength(1);
    // Every crossing taken off, by a raised cap: the shop has no row at all.
    expect((await notice({ tenant, seq: 4, month: "2026-12", crossings: [] })).body).toEqual({ stored: true });
    expect((await rowsOf("2026-12")).map((row) => row.tenant)).not.toContain(tenant);

    // Only the shop's object writes, with its header, and only a notice as it writes one.
    expect((await notice({ tenant, seq: 5, month: "2026-12", crossings: [] }, {})).status).toBe(403);
    for (const bad of [
      { tenant, seq: 0, month: "2026-12", crossings: [] },
      { tenant, seq: 1.5, month: "2026-12", crossings: [] },
      { tenant, seq: 6, month: "2026-13", crossings: [] },
      { tenant, seq: 6, month: "2026-12", crossings: [crossing(50)] },
      { tenant, seq: 6, month: "2026-12", crossings: [crossing(80), crossing(80)] },
      { tenant, seq: 6, month: "2026-12", crossings: [{ ...crossing(80), at: "soon" }] },
      { tenant, seq: 6, month: "2026-12", crossings: [{ ...crossing(80), spentMillisatang: -1 }] },
      { tenant: "", seq: 6, month: "2026-12", crossings: [] },
    ]) {
      expect((await notice(bad)).status).toBe(400);
    }
    expect((await authCall(bindings, "/model-alerts?month=November")).status).toBe(400);
  });
});

describe("the shop's alarm serving both of its jobs", () => {
  it("sends a crossing its object could not send, and sweeps an expired reservation, in one run", async () => {
    const tenant = await shop("Retry Rice");
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 10 })).status).toBe(200);
    const reservedAt = Date.now() - HOLD_TTL_MS - 5_000;
    await withAuth(tenant, unreachableAuth, async () => {
      // AuthObject cannot be reached: the crossing is noted in the shop's month, and its notice waits.
      await spend(tenant, 8_000, Date.now());
      // A reservation already past its expiry, which nothing will settle.
      await reserve(tenant, 1_000, reservedAt);
    });
    const month = bangkokMonth(Date.now());
    expect(await crossingsOf(tenant, month)).toHaveLength(1);
    expect((await alerts()).shops.map((one) => one.tenant)).not.toContain(tenant);
    // Both jobs are due within the minute, and the alarm is set for then.
    const armed = await alarmOf(tenant);
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(Date.now() + NOTICE_RETRY_MS);

    expect(await runDurableObjectAlarm(stubOf(tenant))).toBe(true);
    // The notice went: the shop is on the list.
    expect((await alerts()).shops.find((one) => one.tenant === tenant)?.percent).toBe(80);
    // And the sweep ran: the expired reservation is charged as abandoned.
    const response = await tenantCall(bindings, tenant,
      `/model/usage?tenant=${encodeURIComponent(tenant)}&month=${bangkokMonth(reservedAt)}`);
    const { totals, holds } = (await response.json()) as { totals: { abandoned: number }; holds: unknown[] };
    expect(totals.abandoned).toBe(1);
    expect(holds).toEqual([]);
    // Nothing is left for either job.
    expect(await alarmOf(tenant)).toBeNull();
  });

  it("is set for whichever job is due first, and then for the other", async () => {
    const tenant = await shop("First Fried");
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 10 })).status).toBe(200);
    const t0 = Date.now();
    await withAuth(tenant, unreachableAuth, async () => {
      await spend(tenant, 8_000, t0);
      await reserve(tenant, 1_000, t0);
    });
    // The notice's retry comes a minute after its failed send, long before the open reservation expires.
    const armed = await alarmOf(tenant);
    expect(armed!).toBeLessThan(t0 + HOLD_TTL_MS);
    expect(await runDurableObjectAlarm(stubOf(tenant))).toBe(true);
    expect((await alerts()).shops.map((one) => one.tenant)).toContain(tenant);
    // Then the sweep's turn: a minute after the open reservation expires.
    expect(await alarmOf(tenant)).toBe(t0 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
  });
});
