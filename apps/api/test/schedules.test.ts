import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { deterministicTaskId, nextFire, latestDueInstant, occurrenceID } from "../src/schedule-object";
import type { ScheduleJSON } from "../src/schedule-object";

const OPERATOR = { authorization: "Bearer test-key" };
const TENANT = "sched-tenant";

// Schedule creation is gated on both kill switches, so the file opts in
// once up front; the tests below toggle them back and restore them.
beforeAll(async () => {
  const response = await adminFetch("https://test/v1/admin/flags", {
    method: "PUT",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify({ officeCloud: true, officeRoutines: true }),
  });
  expect(response.status).toBe(200);
});

type Namespace = { idFromName(id: string): unknown; get(id: unknown): { alarm?: () => Promise<void> } };

function schedules() {
  return (env as unknown as { SCHEDULES: Namespace }).SCHEDULES;
}

function tenantObjectId(tenant: string) {
  return `t:${tenant || "operator"}`;
}

async function runAlarms(...tenants: string[]) {
  const ns = schedules();
  for (const tenant of tenants.length > 0 ? tenants : [TENANT]) {
    await runDurableObjectAlarm(ns.get(ns.idFromName(tenantObjectId(tenant))) as never);
  }
}

async function createSchedule(body: Record<string, unknown>, tenant = TENANT) {
  return SELF.fetch("https://test/v1/schedules", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await tenantSession(tenant)) },
    body: JSON.stringify({ tenantId: tenant, ...body }),
  });
}

function brief(hour: number, minute: number, extra: Record<string, unknown> = {}) {
  return {
    name: "Morning brief",
    prompt: "Prepare priorities.",
    hour,
    minute,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    timeZone: "Asia/Bangkok",
    hasSchedulingConsent: true,
    ...extra,
  };
}

async function taskCount(): Promise<number> {
  const exported = await SELF.fetch(`https://test/v1/tenant/export?tenant=${TENANT}`, { headers: await tenantSession(TENANT, false) });
  expect(exported.status).toBe(200);
  const body = (await exported.json()) as { tasks?: unknown[] };
  return body.tasks?.length ?? -1;
}

async function occurrencesOf(id: string, tenant: string = TENANT) {
  const read = await SELF.fetch(`https://test/v1/schedules/${id}?tenant=${encodeURIComponent(tenant)}`, {
    headers: await tenantSession(tenant, false),
  });
  expect(read.status).toBe(200);
  return (await read.json()) as {
    schedule: ScheduleJSON;
    next: number[];
    occurrences: { occurrenceId: string; status: string; taskId?: string }[];
  };
}

describe("schedule timing", () => {
  it("computes stable occurrence ids", () => {
    expect(occurrenceID("ABC", 1789968000000, 2)).toBe("abc-1789968000-2");
  });

  it("fires a Bangkok morning brief at the right instant", () => {
    // Sunday 2026-09-20 00:00 UTC; 08:30 Bangkok is 01:30 UTC.
    expect(nextFire(8, 30, [1, 2, 3, 4, 5, 6, 7], "Asia/Bangkok", Date.UTC(2026, 8, 20))).toBe(
      Date.UTC(2026, 8, 20, 1, 30),
    );
  });

  it("skips a nonexistent DST wall time", () => {
    // 02:30 never occurs in New York on 2026-03-08 (spring forward).
    expect(nextFire(2, 30, [1, 2, 3, 4, 5, 6, 7], "America/New_York", Date.UTC(2026, 2, 8, 4))).toBe(
      Date.UTC(2026, 2, 9, 6, 30),
    );
  });

  it("fires a repeated DST wall time once", () => {
    // 01:30 occurs twice on 2026-11-01; the first (EDT, 05:30Z) wins.
    expect(nextFire(1, 30, [1, 2, 3, 4, 5, 6, 7], "America/New_York", Date.UTC(2026, 10, 1, 4))).toBe(
      Date.UTC(2026, 10, 1, 5, 30),
    );
    // Chained from just after the first copy, the second copy (EST, 06:30Z) is
    // skipped: the next run is the following day's, so the night mints one task.
    const days = [1, 2, 3, 4, 5, 6, 7];
    expect(nextFire(1, 30, days, "America/New_York", Date.UTC(2026, 10, 1, 5, 30, 1))).toBe(
      Date.UTC(2026, 10, 2, 6, 30),
    );
    // Lord Howe falls back by 30 minutes: 01:45 repeats at 14:45Z and 15:15Z, and
    // the next 01:45, on standard time, is 15:15Z the following day.
    expect(nextFire(1, 45, days, "Australia/Lord_Howe", Date.UTC(2026, 3, 4, 14, 45, 1))).toBe(
      Date.UTC(2026, 3, 5, 15, 15),
    );
  });

  it("relies on every IANA zone being a whole number of quarter hours off UTC", () => {
    // nextFire's quarter-hour grid depends on this; a tzdata change that broke it
    // should fail here rather than silently stop schedules in that zone.
    const offsetMinutes = (zone: string, at: number): number => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(new Date(at));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
      const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
      return Math.round((wall - Math.floor(at / 60000) * 60000) / 60000);
    };
    const instants = [Date.UTC(2026, 0, 15), Date.UTC(2026, 6, 15), Date.now(), Date.now() + 180 * 24 * 3600 * 1000];
    const odd = Intl.supportedValuesOf("timeZone").filter((zone) =>
      instants.some((at) => offsetMinutes(zone, at) % 15 !== 0),
    );
    expect(odd).toEqual([]);
  });

  it("fires at minutes that are not a multiple of five, up to :59", () => {
    // 13:59 Bangkok is 06:59Z. The old five-minute window never matched
    // minutes 56-59, so these schedules silently never ran.
    const from = Date.UTC(2026, 8, 21, 0);
    for (const minute of [1, 7, 44, 56, 57, 58, 59]) {
      expect(nextFire(13, minute, [1, 2, 3, 4, 5, 6, 7], "Asia/Bangkok", from)).toBe(
        Date.UTC(2026, 8, 21, 6, minute),
      );
    }
  });

  it("lands on the exact minute in quarter-hour offset zones", () => {
    // Kathmandu is UTC+05:45, Adelaide UTC+09:30 in September.
    expect(nextFire(9, 2, [1, 2, 3, 4, 5, 6, 7], "Asia/Kathmandu", Date.UTC(2026, 8, 21, 0))).toBe(
      Date.UTC(2026, 8, 21, 3, 17),
    );
    expect(nextFire(9, 59, [1, 2, 3, 4, 5, 6, 7], "Australia/Adelaide", Date.UTC(2026, 8, 21, 0))).toBe(
      Date.UTC(2026, 8, 21, 0, 29),
    );
  });

  it("never returns an instant at or before the starting point", () => {
    // Just past a 13:52 slot: the next run is tomorrow's, not the one just gone.
    const slot = Date.UTC(2026, 8, 21, 6, 52);
    expect(nextFire(13, 52, [1, 2, 3, 4, 5, 6, 7], "Asia/Bangkok", slot + 1000)).toBe(slot + 24 * 3600 * 1000);
    expect(nextFire(13, 52, [1, 2, 3, 4, 5, 6, 7], "Asia/Bangkok", slot - 1000)).toBe(slot);
  });

  it("finds a weekly run a DST change pushes past eight days", () => {
    // Sundays (weekday 1) in New York. Fall back: after the 25 October run, the
    // next is 1 November 19:30 EST, which is 2 November 00:30Z.
    expect(nextFire(19, 30, [1], "America/New_York", Date.UTC(2026, 9, 25, 23, 30, 1))).toBe(
      Date.UTC(2026, 10, 2, 0, 30),
    );
    // Spring forward swallows 02:30 on 8 March, so the run after 1 March is 15 March.
    expect(nextFire(2, 30, [1], "America/New_York", Date.UTC(2026, 2, 1, 7, 30, 1))).toBe(
      Date.UTC(2026, 2, 15, 6, 30),
    );
  });
});

describe("durable routines", () => {
  it("validates schedules and previews the next runs", async () => {
    expect((await createSchedule({ ...brief(8, 30), hour: 25 })).status).toBe(400);
    expect((await createSchedule({ ...brief(8, 30), timeZone: "Moon/Olympus" })).status).toBe(400);
    expect((await createSchedule({ ...brief(8, 30), weekdays: [] })).status).toBe(400);
    const created = await createSchedule(brief(8, 30));
    expect(created.status).toBe(200);
    const schedule = (await created.json()) as ScheduleJSON;
    expect(schedule.revision).toBe(1);
    const read = await SELF.fetch(
      `https://test/v1/schedules/${schedule.id}?tenant=${encodeURIComponent(TENANT)}`,
      { headers: await tenantSession(TENANT, false) },
    );
    const { next } = (await read.json()) as { next: number[] };
    expect(next).toHaveLength(3);
    expect(next[0]! < next[1]! && next[1]! < next[2]!).toBe(true);
  });

  it("fires once per occurrence under duplicate alarms", async () => {
    const now = new Date();
    const bangkok = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(bangkok.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Math.max(0, Number(bangkok.find((part) => part.type === "minute")?.value ?? "0") - 5);
    const created = await createSchedule(brief(hour, minute));
    expect(created.status).toBe(200);
    const schedule = (await created.json()) as ScheduleJSON;
    // Counted per schedule, not tenant-wide: schedules created earlier in this
    // file stay enabled and the store is not reset between tests, so a fixed-time
    // one (08:30 Asia/Bangkok, line 90) is itself due whenever the suite happens to
    // run inside its 15-minute grace. A tenant-wide delta then sees two tasks and
    // blames this test for another schedule firing.
    await runAlarms();
    const seen = await occurrencesOf(schedule.id);
    expect(seen.occurrences.map((entry) => entry.status)).toEqual(["created"]);
    const firstTask = seen.occurrences[0]?.taskId;
    expect(firstTask).toBeTruthy();
    // The point of the test: a duplicate alarm claims the same occurrence rather
    // than opening a second one.
    await runAlarms();
    const again = await occurrencesOf(schedule.id);
    expect(again.occurrences.map((entry) => entry.status)).toEqual(["created"]);
    expect(again.occurrences[0]?.taskId).toBe(firstTask);
  });

  it("finds due instants without opening fresh schedules with misses", () => {
    const hour = 8;
    const minute = 30;
    const days = [1, 2, 3, 4, 5, 6, 7];
    const tz = "Asia/Bangkok";
    // Monday 2026-09-21 02:00 UTC; the 08:30 Bangkok slot is 01:30 UTC.
    const now = Date.UTC(2026, 8, 21, 2, 0);
    const slot = Date.UTC(2026, 8, 21, 1, 30);
    // Fresh schedule, slot an hour old: nothing due, no ancient miss.
    expect(latestDueInstant(hour, minute, days, tz, now, now, 15 * 60 * 1000)).toBeNull();
    // Old schedule, slot an hour old: due, and stale past a 15-minute grace.
    expect(latestDueInstant(hour, minute, days, tz, now, now - 2 * 3600 * 1000, 15 * 60 * 1000)).toBe(slot);
    // Old schedule, slot five minutes old: due and fresh.
    expect(
      latestDueInstant(hour, minute, days, tz, slot + 5 * 60 * 1000, slot - 2 * 3600 * 1000, 15 * 60 * 1000),
    ).toBe(slot);
  });

  it("records missed runs instead of executing late", async () => {
    const now = Date.now();
    const bangkok = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(now - 60 * 60 * 1000));
    const hour = Number(bangkok.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(bangkok.find((part) => part.type === "minute")?.value ?? "0");
    const id = `missed-${now}`;
    const createdAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const ns = schedules();
    await runInDurableObject(ns.get(ns.idFromName(tenantObjectId(TENANT))) as never, async (_instance: unknown, state: {
      storage: {
        put(key: string, value: unknown): Promise<void>;
        setAlarm(ms: number): Promise<void>;
      };
    }) => {
      await state.storage.put(`sched:${id}`, {
        id,
        tenant: TENANT,
        roleId: "",
        name: "Morning brief",
        prompt: "Prepare priorities.",
        hour,
        minute,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        timeZone: "Asia/Bangkok",
        funding: "cloudBYOK",
        enabled: true,
        hasSchedulingConsent: true,
        revision: 1,
        nextFire: now,
        createdAt,
      });
      await state.storage.setAlarm(now);
    });
    const before = await taskCount();
    await runAlarms();
    expect(await taskCount()).toBe(before);
    const seen = await occurrencesOf(id);
    expect(seen.occurrences.map((entry) => entry.status)).toEqual(["missed"]);
  });

  it("never opens a fresh schedule with ancient misses", async () => {
    const now = new Date();
    const bangkok = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(now.getTime() - 60 * 60 * 1000));
    const hour = Number(bangkok.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(bangkok.find((part) => part.type === "minute")?.value ?? "0");
    const before = await taskCount();
    const created = await createSchedule(brief(hour, minute));
    const schedule = (await created.json()) as ScheduleJSON;
    await runAlarms();
    expect(await taskCount()).toBe(before);
    const seen = await occurrencesOf(schedule.id);
    expect(seen.occurrences).toEqual([]);
  });

  it("skips overlap while the previous task is unsettled", async () => {
    const now = new Date();
    const bangkok = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(bangkok.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Math.max(0, Number(bangkok.find((part) => part.type === "minute")?.value ?? "0") - 5);
    const created = await createSchedule(brief(hour, minute));
    const schedule = (await created.json()) as ScheduleJSON;
    await runAlarms();
    // A revision bump mints a fresh occurrence id for the same instant; the
    // still-queued first task forces a skip, not a second task.
    const updated = await SELF.fetch("https://test/v1/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await tenantSession(TENANT, false)) },
      body: JSON.stringify({ ...brief(hour, minute), id: schedule.id, tenantId: TENANT }),
    });
    expect(updated.status).toBe(200);
    await runAlarms();
    const seen = await occurrencesOf(schedule.id);
    expect(seen.occurrences.map((entry) => entry.status).sort()).toEqual(["created", "skipped"]);
  });

  it("stops firing when disabled or deleted", async () => {
    const created = await createSchedule(brief(8, 30));
    const schedule = (await created.json()) as ScheduleJSON;
    const disabled = await SELF.fetch("https://test/v1/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await tenantSession(TENANT, false)) },
      body: JSON.stringify({ ...brief(8, 30), id: schedule.id, tenantId: TENANT, enabled: false }),
    });
    expect(disabled.status).toBe(200);
    const before = await taskCount();
    await runAlarms();
    expect(await taskCount()).toBe(before);
    expect(
      (
        await SELF.fetch(`https://test/v1/schedules/${schedule.id}?tenant=${encodeURIComponent(TENANT)}`, {
          method: "DELETE",
          headers: await tenantSession(TENANT, false),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await SELF.fetch(`https://test/v1/schedules/${schedule.id}?tenant=${encodeURIComponent(TENANT)}`, {
          headers: await tenantSession(TENANT, false),
        })
      ).status,
    ).toBe(404);
  });

  it("refuses a time zone whose runs could never be found", async () => {
    // Intl accepts raw offsets like this one, which no quarter-hour grid matches.
    const created = await createSchedule(brief(9, 30, { timeZone: "+05:07" }));
    expect(created.status).toBe(400);
  });

  it("keeps the tenant's one alarm on the soonest run across its schedules", async () => {
    async function alarm(): Promise<number | null> {
      const ns = schedules();
      let at: number | null = null;
      await runInDurableObject(ns.get(ns.idFromName(tenantObjectId(TENANT))) as never, async (_instance: unknown, state: {
        storage: { getAlarm(): Promise<number | null> };
      }) => {
        at = await state.storage.getAlarm();
      });
      return at;
    }
    function bangkokWall(ms: number): { hour: number; minute: number } {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(new Date(ms));
      const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
      return { hour: get("hour"), minute: get("minute") };
    }
    const soon = bangkokWall(Date.now() + 60 * 60 * 1000);
    const later = bangkokWall(Date.now() + 5 * 60 * 60 * 1000);
    const early = (await (await createSchedule(brief(soon.hour, soon.minute))).json()) as ScheduleJSON;
    // Saved second but due later: arming per schedule used to move the alarm here.
    const late = (await (await createSchedule(brief(later.hour, later.minute))).json()) as ScheduleJSON;
    const armed = await alarm();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(early.nextFire);
    // Disabling one schedule used to delete the alarm for every schedule.
    const disabled = await SELF.fetch("https://test/v1/schedules", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await tenantSession(TENANT, false)) },
      body: JSON.stringify({ ...brief(later.hour, later.minute), id: late.id, tenantId: TENANT, enabled: false }),
    });
    expect(disabled.status).toBe(200);
    const kept = await alarm();
    expect(kept).not.toBeNull();
    expect(kept as number).toBeLessThanOrEqual(early.nextFire);
  });

  it("halts firing while routines are disabled, then resumes", async () => {
    async function setRoutines(value: boolean) {
      const response = await adminFetch("https://test/v1/admin/flags", {
        method: "PUT",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify({ officeRoutines: value }),
      });
      expect(response.status).toBe(200);
    }
    const now = new Date();
    const bangkok = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(bangkok.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Math.max(0, Number(bangkok.find((part) => part.type === "minute")?.value ?? "0") - 5);
    const created = await createSchedule(brief(hour, minute));
    const schedule = (await created.json()) as ScheduleJSON;
    await setRoutines(false);
    const before = await taskCount();
    await runAlarms();
    // Nothing minted, nothing claimed: the same instant is still due.
    expect(await taskCount()).toBe(before);
    expect((await occurrencesOf(schedule.id)).occurrences).toEqual([]);
    await setRoutines(true);
    await runAlarms();
    expect(await taskCount()).toBe(before + 1);
    expect((await occurrencesOf(schedule.id)).occurrences.map((entry) => entry.status)).toEqual(["created"]);
  });

  it("refuses new schedules while either kill switch is off", async () => {
    async function setFlags(body: Record<string, boolean>) {
      const response = await adminFetch("https://test/v1/admin/flags", {
        method: "PUT",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    const now = new Date();
    const attempt = async () =>
      SELF.fetch("https://test/v1/schedules", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await tenantSession(TENANT, false)) },
        body: JSON.stringify({
          tenantId: TENANT,
          name: "Blocked brief",
          prompt: "Never scheduled.",
          hour: now.getHours(),
          minute: now.getMinutes(),
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          timeZone: "UTC",
          hasSchedulingConsent: true,
        }),
      });
    await setFlags({ officeCloud: false });
    const noCloud = await attempt();
    expect(noCloud.status).toBe(403);
    expect(((await noCloud.json()) as { feature?: string }).feature).toBe("officeCloud");
    await setFlags({ officeCloud: true, officeRoutines: false });
    const noRoutines = await attempt();
    expect(noRoutines.status).toBe(403);
    expect(((await noRoutines.json()) as { feature?: string }).feature).toBe("officeRoutines");
    await setFlags({ officeRoutines: true });
    expect((await attempt()).status).toBe(200);
  });

  it("mints nothing while cloud work is off, then resumes", async () => {
    async function setCloud(value: boolean) {
      const response = await adminFetch("https://test/v1/admin/flags", {
        method: "PUT",
        headers: { "content-type": "application/json", ...OPERATOR },
        body: JSON.stringify({ officeCloud: value }),
      });
      expect(response.status).toBe(200);
    }
    const now = new Date();
    const created = await createSchedule(
      brief(now.getHours(), Math.max(0, now.getMinutes() - 5)),
    );
    expect(created.status).toBe(200);
    await setCloud(false);
    const before = await taskCount();
    await runAlarms();
    expect(await taskCount()).toBe(before);
    await setCloud(true);
    await runAlarms();
    expect(await taskCount()).toBe(before + 1);
  });

  it("fires due schedules in every tenant independently", async () => {
    // One alarm per tenant object now (M4 phase 3): a sweep of tenant A must
    // neither mint nor suppress tenant B's due run.
    const now = new Date();
    const wall = (at: Date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(at);
      return {
        hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
        minute: Math.max(0, Number(parts.find((part) => part.type === "minute")?.value ?? "0") - 5),
      };
    };
    const stamp = Date.now();
    const first = (await (
      await createSchedule(brief(wall(now).hour, wall(now).minute), `sched-dual-a-${stamp}`)
    ).json()) as ScheduleJSON;
    const second = (await (
      await createSchedule(brief(wall(now).hour, wall(now).minute), `sched-dual-b-${stamp}`)
    ).json()) as ScheduleJSON;
    await runAlarms(`sched-dual-a-${stamp}`, `sched-dual-b-${stamp}`);
    expect(
      (await occurrencesOf(first.id, `sched-dual-a-${stamp}`)).occurrences.map((entry) => entry.status),
    ).toEqual(["created"]);
    expect(
      (await occurrencesOf(second.id, `sched-dual-b-${stamp}`)).occurrences.map((entry) => entry.status),
    ).toEqual(["created"]);
  });

  it("stops firing after tenant consent is revoked", async () => {
    async function seedConsent(tenant: string, cloudWork: boolean) {
      const ns = (env as unknown as { TENANT: Namespace }).TENANT;
      const id = `t:${tenant || "operator"}`;
      await runInDurableObject(ns.get(ns.idFromName(id)) as never, async (_instance: unknown, state: {
        storage: { put(key: string, value: unknown): Promise<void> };
      }) => {
        await state.storage.put(`consent:${tenant}`, {
          cloudWork,
          updatedAt: new Date().toISOString(),
        });
      });
    }
    const now = new Date();
    const wall = (at: Date) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Bangkok",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(at);
      return {
        hour: Number(parts.find((part) => part.type === "hour")?.value ?? "0"),
        minute: Math.max(0, Number(parts.find((part) => part.type === "minute")?.value ?? "0") - 5),
      };
    };
    const revokedTenant = `sched-revoked-${Date.now()}`;
    const openTenant = `sched-open-${Date.now()}`;
    const revokedAt = wall(now);
    const revoked = (await (
      await createSchedule(brief(revokedAt.hour, revokedAt.minute), revokedTenant)
    ).json()) as ScheduleJSON;
    const openAt = wall(now);
    const open = (await (
      await createSchedule(brief(openAt.hour, openAt.minute), openTenant)
    ).json()) as ScheduleJSON;
    await seedConsent(revokedTenant, false);
    // Each tenant has its own object and alarm now: sweep both.
    await runAlarms(revokedTenant, openTenant);
    // Revoked consent stops its tenant; the other consented tenant still fires.
    expect((await occurrencesOf(revoked.id, revokedTenant)).occurrences).toEqual([]);
    expect((await occurrencesOf(open.id, openTenant)).occurrences.map((entry) => entry.status)).toEqual([
      "created",
    ]);
  });

  it("wipes a tenant's schedules with its data and exports the survivors", async () => {
    const tenant = `sched-wipe-${Date.now()}`;
    const created = await createSchedule(brief(8, 30), tenant);
    expect(created.status).toBe(200);
    const schedule = (await created.json()) as ScheduleJSON;
    const exported = (await (
      await SELF.fetch(`https://test/v1/tenant/export?tenant=${tenant}`, { headers: await tenantSession(tenant, false) })
    ).json()) as { schedules?: { id?: string }[] };
    expect((exported.schedules ?? []).some((entry) => entry.id === schedule.id)).toBe(true);
    const deleted = await SELF.fetch(`https://test/v1/tenant/data?tenant=${tenant}`, {
      method: "DELETE",
      headers: await tenantSession(tenant, false),
    });
    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { schedulesWiped?: number }).schedulesWiped).toBe(1);
    expect(
      (
        await SELF.fetch(`https://test/v1/schedules/${schedule.id}?tenant=${encodeURIComponent(tenant)}`, {
          headers: await tenantSession(tenant, false),
        })
      ).status,
    ).toBe(404);
    // No tasks were ever minted for this tenant, so the tombstone answers.
    const gone = await SELF.fetch(`https://test/v1/tenant/export?tenant=${tenant}`, { headers: await tenantSession(tenant, false) });
    expect(gone.status).toBe(404);
  });
});

describe("schedule mint squatting", () => {
  /// The occurrence's task id is a deterministic hash anyone can compute, so
  /// another tenant can hold it before the alarm fires. The mint then answers
  /// 404 (foreign), and the schedule must record the run as blocked instead
  /// of retrying forever — and never touch the squatter's task.
  it("records a squatted occurrence as blocked and leaves the squatter's task alone", async () => {
    const owner = `s10-sched-owner-${Date.now()}`;
    const squatter = `s10-sched-squat-${Date.now()}`;
    const now = Date.now();
    // A slot five minutes old: still inside the grace, so the alarm mints.
    const wall = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Bangkok",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(now - 5 * 60 * 1000));
    const hour = Number(wall.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(wall.find((part) => part.type === "minute")?.value ?? "0");
    const created = await createSchedule(brief(hour, minute), owner);
    expect(created.status).toBe(200);
    const schedule = (await created.json()) as ScheduleJSON;
    const instant = latestDueInstant(
      hour,
      minute,
      [1, 2, 3, 4, 5, 6, 7],
      "Asia/Bangkok",
      Date.now(),
      Date.parse(schedule.createdAt),
    );
    expect(instant).not.toBeNull();
    const taskId = await deterministicTaskId(occurrenceID(schedule.id, instant!, schedule.revision));
    // The squatter holds the deterministic id before the owner's alarm fires.
    const bindings = env as unknown as { TASK: { idFromName(id: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } };
    const stub = bindings.TASK.get(bindings.TASK.idFromName(taskId));
    const squat = await stub.fetch(
      new Request("https://task/", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-tenant": squatter },
        body: JSON.stringify({
          id: taskId,
          title: "Squatted",
          objective: "Held by another tenant.",
          state: "queued",
          location: "cloud",
          funding: "cloudBYOK",
          criteria: [],
          updatedAt: new Date().toISOString(),
        }),
      }),
    );
    expect(squat.status).toBe(200);

    await runAlarms(owner);
    const seen = await occurrencesOf(schedule.id, owner);
    expect(seen.occurrences.map((entry) => entry.status)).toEqual(["blocked"]);
    // Nothing is deleted or rewritten: the squatter's task is untouched.
    const held = await stub.fetch(new Request("https://task/", { headers: { "x-tenant": squatter } }));
    expect(held.status).toBe(200);
    expect(((await held.json()) as { state?: string }).state).toBe("queued");
    // The blocked occurrence claims the run, so the alarm stops retrying it.
    await runAlarms(owner);
    const again = await occurrencesOf(schedule.id, owner);
    expect(again.occurrences.map((entry) => entry.status)).toEqual(["blocked"]);
  });
});
