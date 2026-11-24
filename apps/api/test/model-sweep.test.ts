import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { HOLD_TTL_MS, SWEEP_MARGIN_MS, type MeterRecord } from "../src/model-meter";
import { bangkokMonth } from "../src/model-price";
import { tenantCall, tenantDelete } from "../src/tenant-data";

// The sweep: the shop's TenantObject charges a reservation nothing settled in time on its own alarm, a minute after the
// reservation expires, as well as on the shop's next write. Holds here are reserved at real times, because the alarm
// reads the real clock: one reserved more than fifteen minutes ago has expired by the time the test runs its alarm.
// The alarm never fires by itself during a test: the object never sets it sooner than a minute from now.

const bindings = env as unknown as Env;

let counter = 0;
const fresh = (label: string) => `model-sweep:${label}-${Date.now()}-${counter++}`;

const stubOf = (tenant: string) => bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));

/// A write to the tenant's meter, as the gateway makes it.
async function meter<T = Record<string, unknown>>(tenant: string, path: string, body: Record<string, unknown>) {
  const response = await tenantCall(bindings, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-model": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function reserve(tenant: string, worstMillisatang: number, nowMs: number): Promise<string> {
  const answer = await meter<{ callId: string }>(tenant, "/model/reserve",
    { model: "claude-sonnet-5-5", worstMillisatang, defaultCapSatang: 20_000, nowMs });
  expect(answer.status).toBe(200);
  return answer.body.callId;
}

function settle(tenant: string, callId: string, millisatang: number, nowMs = Date.now()) {
  return meter(tenant, "/model/settle", { callId, inputTokens: 10, outputTokens: 10, millisatang, nowMs });
}

type Totals = { spentMillisatang: number; ok: number; abandoned: number; failed: number };
type Usage = { totals: Totals; holds: { callId: string }[]; calls: MeterRecord[] };

async function usage(tenant: string, month: string): Promise<Usage> {
  const response = await tenantCall(bindings, tenant, `/model/usage?tenant=${encodeURIComponent(tenant)}&month=${month}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Usage;
}

const alarmOf = (tenant: string) => runInDurableObject(stubOf(tenant), (_instance, state) => state.storage.getAlarm());

/// Runs the object's alarm now. It is set a minute ahead first, so the run is this one, never one that fired by itself.
async function runAlarm(tenant: string): Promise<boolean> {
  await runInDurableObject(stubOf(tenant), (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
  return runDurableObjectAlarm(stubOf(tenant));
}

/// A time to reserve at so that the hold is past its expiry, and its sweep's minute too, by the real clock: left to
/// itself, its alarm would be due already.
const expiredAt = () => Date.now() - HOLD_TTL_MS - SWEEP_MARGIN_MS - 5_000;

describe("the shop's alarm", () => {
  it("is set a minute after the earliest open reservation expires, follows it as holds close, and is cleared with none", async () => {
    const tenant = fresh("arm");
    const t0 = Date.now();
    const first = await reserve(tenant, 5_000, t0);
    expect(await alarmOf(tenant)).toBe(t0 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
    const second = await reserve(tenant, 5_000, t0 + 10_000);
    // The first still expires first, so the alarm stays with it.
    expect(await alarmOf(tenant)).toBe(t0 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
    expect((await settle(tenant, first, 3_000)).status).toBe(200);
    expect(await alarmOf(tenant)).toBe(t0 + 10_000 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
    expect((await meter(tenant, "/model/release", { callId: second, nowMs: Date.now() })).status).toBe(200);
    expect(await alarmOf(tenant)).toBeNull();
  });

  it("charges a reservation nothing settled its worst case once, and the provider's late answer gets 409", async () => {
    const tenant = fresh("alarm-first");
    const reservedAt = expiredAt();
    const month = bangkokMonth(reservedAt);
    const callId = await reserve(tenant, 5_000, reservedAt);
    // Already past its expiry when reserved, so the alarm waits a minute from now, never a time already gone.
    expect(await alarmOf(tenant)).toBeGreaterThan(Date.now() + 50_000);

    // The alarm first.
    expect(await runAlarm(tenant)).toBe(true);
    const swept = await usage(tenant, month);
    expect(swept.holds).toEqual([]);
    expect(swept.totals).toMatchObject({ spentMillisatang: 5_000, abandoned: 1, ok: 0 });
    expect(swept.calls).toEqual([
      expect.objectContaining({ id: callId, outcome: "abandoned", millisatang: 5_000, inputTokens: 0, outputTokens: 0 }),
    ]);
    // Nothing is left open, so nothing is left for the alarm.
    expect(await alarmOf(tenant)).toBeNull();

    // Then the provider's answer, and the shop's next write: neither finds the call, so nothing is charged twice.
    expect(await settle(tenant, callId, 10)).toEqual({ status: 409, body: { error: "not_reserved" } });
    expect(await meter(tenant, "/model/release", { callId, nowMs: Date.now() }))
      .toEqual({ status: 409, body: { error: "not_reserved" } });
    await reserve(tenant, 1_000, Date.now());
    expect((await usage(tenant, month)).totals).toMatchObject({ spentMillisatang: 5_000, abandoned: 1 });
    expect((await usage(tenant, month)).calls.filter((call) => call.id === callId)).toHaveLength(1);
  });

  it("finds nothing when the shop's next write charged the reservation first", async () => {
    const tenant = fresh("write-first");
    const reservedAt = expiredAt();
    const month = bangkokMonth(reservedAt);
    const callId = await reserve(tenant, 5_000, reservedAt);

    // The next write first: a reservation now closes the expired one as abandoned.
    const later = await reserve(tenant, 1_000, Date.now());
    const charged = await usage(tenant, month);
    expect(charged.totals).toMatchObject({ spentMillisatang: 5_000, abandoned: 1 });
    expect(charged.calls.map((call) => [call.id, call.outcome])).toEqual([[callId, "abandoned"]]);

    // Then the alarm: the expired hold is gone, and the open one has not expired, so it changes nothing.
    expect(await runAlarm(tenant)).toBe(true);
    const after = await usage(tenant, month);
    expect(after.totals).toEqual(charged.totals);
    expect(after.calls).toEqual(charged.calls);
    expect((await usage(tenant, bangkokMonth(Date.now()))).holds.map((hold) => hold.callId)).toEqual([later]);
  });

  it("finds nothing when a settle came first, even after the hold's expiry, which is charged at the provider's count", async () => {
    const tenant = fresh("settle-first");
    const reservedAt = expiredAt();
    const month = bangkokMonth(reservedAt);
    const callId = await reserve(tenant, 5_000, reservedAt);
    expect((await settle(tenant, callId, 3_000)).status).toBe(200);
    expect(await runAlarm(tenant)).toBe(true);
    expect((await usage(tenant, month)).totals).toMatchObject({ spentMillisatang: 3_000, ok: 1, abandoned: 0 });
    expect(await alarmOf(tenant)).toBeNull();
  });

  it.each([
    ["the alarm", "the settle"],
    ["the settle", "the alarm"],
  ])("ends a call one way when %s and %s race for it", async (first) => {
    const tenant = fresh("race");
    const reservedAt = expiredAt();
    const month = bangkokMonth(reservedAt);
    const callId = await reserve(tenant, 5_000, reservedAt);
    await runInDurableObject(stubOf(tenant), (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    const sweep = () => runDurableObjectAlarm(stubOf(tenant)).then(() => null);
    const answer = () => settle(tenant, callId, 3_000);
    const results = await Promise.all(first === "the alarm" ? [sweep(), answer()] : [answer(), sweep()]);
    const settled = results.find((result) => result !== null)!;

    const after = await usage(tenant, month);
    expect(after.holds).toEqual([]);
    expect(after.calls).toHaveLength(1);
    if (settled.status === 200) {
      // The settle won: charged at the provider's count, and the alarm found nothing.
      expect(after.totals).toMatchObject({ spentMillisatang: 3_000, ok: 1, abandoned: 0 });
    } else {
      // The alarm won: charged the worst case, and the settle found nothing.
      expect(settled).toEqual({ status: 409, body: { error: "not_reserved" } });
      expect(after.totals).toMatchObject({ spentMillisatang: 5_000, ok: 0, abandoned: 1 });
    }
  });

  it("is set again after it runs: it closes what has expired and waits for the reservation still open", async () => {
    const tenant = fresh("again");
    const reservedAt = expiredAt();
    const stale = await reserve(tenant, 5_000, reservedAt);
    const t0 = Date.now();
    const open = await reserve(tenant, 2_000, t0);
    expect(await runAlarm(tenant)).toBe(true);

    const month = bangkokMonth(reservedAt);
    expect((await usage(tenant, month)).calls.map((call) => [call.id, call.outcome])).toEqual([[stale, "abandoned"]]);
    expect((await usage(tenant, bangkokMonth(t0))).holds.map((hold) => hold.callId)).toEqual([open]);
    expect(await alarmOf(tenant)).toBe(t0 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
    // Run again early: the open hold has not expired, so it stays, and so does the alarm.
    expect(await runAlarm(tenant)).toBe(true);
    expect((await usage(tenant, bangkokMonth(t0))).holds.map((hold) => hold.callId)).toEqual([open]);
    expect(await alarmOf(tenant)).toBe(t0 + HOLD_TTL_MS + SWEEP_MARGIN_MS);
  });

  it("is cleared with the shop's deletion, which takes every reservation", async () => {
    const tenant = fresh("deleted");
    await reserve(tenant, 5_000, Date.now());
    expect(await alarmOf(tenant)).not.toBeNull();
    expect((await tenantDelete(bindings, tenant)).status).toBe(200);
    expect(await alarmOf(tenant)).toBeNull();
    await runInDurableObject(stubOf(tenant), async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "model-" })).keys()]).toEqual([]);
    });
  });
});
