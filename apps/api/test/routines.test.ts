import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createRoutine, nextRun, type Routine, type Trigger } from "@manut/routine-rules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { runRoutineOccurrence, type RoutineRun, type RoutinesView, type RoutineView, type TeamView } from "../src/routines";
import { latestRoutineInstant, type ScheduleJSON, type ScheduleObject } from "../src/schedule-object";
import type { ActionProposalJSON, DraftJSON } from "../src/task-object";
import { scheduleStub, tenantCall } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  auditEntries,
  bindings,
  joinHelper,
  setupShop,
  shopConsents,
  type Shop,
} from "./people-fixtures";

// Routines per shop (routines.ts, routine-store.ts) through the real Worker and objects in workerd: made through
// @manut/routine-rules, listed with their words and next run, paused, resumed and removed by an operator or by the
// shop's own session; run by the lifted schedule object (daily and weekly, through `toSchedule`) or by the routine
// timer beside it (monthly and window), one run per intended instant, missed past the grace, skipped while the routine
// or the team is paused; and each run only a worker's draft. The global fetch answers 599 for the whole file, so
// anything that tried to leave the Worker would fail the test that made it.

/// The gateway's stand-in model, as `MODEL_PROVIDER=stand-in` sets it for local runs.
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GRACE = 15 * MINUTE;
const enc = encodeURIComponent;

let outbound: ReturnType<typeof vi.fn>;

beforeEach(() => {
  outbound = vi.fn(async () => Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(outbound as unknown as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Refusal = { error: string };

const list = (tenant: string) => admin<RoutinesView>("GET", `/v1/admin/routines?tenant=${enc(tenant)}`);
const make = (tenant: string, input: Record<string, unknown>) =>
  admin<{ routine: RoutineView } & Partial<Refusal>>("POST", "/v1/admin/routines", { tenant, ...input });
const change = (tenant: string, verb: "pause" | "resume" | "remove", routineId: string) =>
  admin<{ routine?: RoutineView; removed?: string } & Partial<Refusal>>("POST", `/v1/admin/routines/${verb}`,
    { tenant, routineId });
const team = (tenant: string, verb: "pause" | "resume") =>
  admin<{ team: TeamView } & Partial<Refusal>>("POST", `/v1/admin/team/${verb}`, { tenant });

/// A routine an operator made, which must have been accepted.
async function made(tenant: string, input: Record<string, unknown>): Promise<RoutineView> {
  const answer = await make(tenant, input);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body.routine;
}

/// A pilot shop with its LINE connection and, unless told otherwise, the owner's consent to cloud work.
async function shop(options: { consent?: boolean } = {}): Promise<Shop> {
  const created = await setupShop(`Routine shop ${crypto.randomUUID().slice(0, 8)}`);
  if (options.consent !== false) await shopConsents(created.tenant);
  return created;
}

/// Every run recorded for a routine, newest first, as the shop's object keeps them.
async function runsOf(tenant: string, routineId: string): Promise<RoutineRun[]> {
  const response = await tenantCall(bindings, tenant, `/routines/runs?tenant=${enc(tenant)}&routineId=${enc(routineId)}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { runs: RoutineRun[] }).runs;
}

/// The tasks the shop's index holds: every job a run started is indexed before it is created.
async function taskIds(tenant: string): Promise<string[]> {
  const response = await tenantCall(bindings, tenant, `/index?tenant=${enc(tenant)}`);
  return ((await response.json()) as { taskIds: string[] }).taskIds;
}

type TaskExport = { actions: ActionProposalJSON[]; requests: unknown[]; drafts: DraftJSON[] };

async function taskExport(tenant: string, taskId: string): Promise<TaskExport> {
  const response = await bindings.TASK.get(bindings.TASK.idFromName(taskId)).fetch(new Request("https://task/export",
    { headers: { "x-tenant": tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as TaskExport;
}

/// The wall clock in Bangkok five minutes before `ms` (never before the top of its hour, so it stays on the same day),
/// as a routine's "HH:MM", and that day's weekday, Sunday 0.
function bangkokJustBefore(ms: number): { at: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", hour: "numeric", minute: "numeric",
    weekday: "short", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const minute = Math.max(0, Number(get("minute")) - 5);
  return {
    at: `${get("hour").padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/// "HH:MM" in Bangkok at `ms`.
function bangkokAt(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23" }).format(new Date(ms));
}

/// The day of the month in Bangkok at `ms`, as a monthly routine may name it (28 at most).
function bangkokDayOfMonth(ms: number): number {
  return Math.min(28, Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Bangkok", day: "numeric" })
    .format(new Date(ms))));
}

/// The routine-rules routine a view describes, for working out its instants as the clocks do.
function rulesOf(view: RoutineView): Routine {
  const built = createRoutine({ id: view.id, name: view.name, action: view.action, timeZone: view.timeZone,
    trigger: view.trigger, asksFirst: view.asksFirst });
  if (!built.ok) throw new Error(built.reason);
  return built.routine;
}

/// The schedule object's alarm, as Cloudflare would run it: daily and weekly routines are its schedules.
async function fireSchedules(tenant: string): Promise<void> {
  await runDurableObjectAlarm(scheduleStub(bindings, tenant));
}

/// The routine timer's sweep at a chosen moment, as the alarm runs it at `Date.now()`.
async function sweepAt(tenant: string, nowMs: number): Promise<void> {
  await runInDurableObject(scheduleStub(bindings, tenant), async (instance: ScheduleObject) => {
    await instance.routineSweep(nowMs);
  });
}

/// What the tenant's schedule object holds for a routine: its schedule (daily, weekly) or its timer (monthly, window).
async function clockOf(tenant: string, routineId: string): Promise<{ schedule?: ScheduleJSON; timer?: unknown }> {
  let found: { schedule?: ScheduleJSON; timer?: unknown } = {};
  await runInDurableObject(scheduleStub(bindings, tenant), async (_instance, state) => {
    const schedule = await state.storage.get<ScheduleJSON>(`sched:${routineId}`);
    const timer = await state.storage.get(`rclock:${routineId}`);
    found = { ...(schedule ? { schedule } : {}), ...(timer ? { timer } : {}) };
  });
  return found;
}

describe("making, reading and changing routines", () => {
  it("makes a routine through routine-rules and lists it with its words and next run", async () => {
    const s = await shop();
    const before = Date.now();
    const routine = await made(s.tenant, { name: "  Morning brief  ", action: "brief",
      trigger: { kind: "daily", at: "08:00" } });
    const after = Date.now();
    expect(routine).toMatchObject({ name: "Morning brief", action: "brief", timeZone: "Asia/Bangkok", asksFirst: false,
      member: "ton", when: "Every day at 08:00", paused: false, lastRun: null });
    expect(routine.id).toMatch(/^rt-[0-9a-z-]+$/);
    // The next run is routine-rules' own answer for the moment the route read the clock.
    const expected = [before, after].map((now) => new Date(nextRun(rulesOf(routine), now)!).toISOString());
    expect(expected).toContain(routine.next);

    const read = await list(s.tenant);
    expect(read.status).toBe(200);
    expect(read.body.team).toEqual({ paused: false, since: null, members: ["nam", "pim", "ton"] });
    expect(read.body.routines.map((r) => r.id)).toEqual([routine.id]);
    expect(read.body.routines[0]).toMatchObject({ when: "Every day at 08:00", paused: false, next: routine.next });
    // A daily routine runs on the lifted schedule object, through `toSchedule`.
    const clock = await clockOf(s.tenant, routine.id);
    expect(clock.schedule).toMatchObject({ id: routine.id, routineId: routine.id, hour: 8, minute: 0,
      weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "Asia/Bangkok", enabled: true });
  });

  it("makes a routine that would reply, send, pay or delete only as one that asks first", async () => {
    const s = await shop();
    const cases: { action: string; member?: string }[] = [
      { action: "reply", member: "nam" }, { action: "send" }, { action: "pay" }, { action: "delete" },
    ];
    for (const { action, member } of cases) {
      const base = { name: `Routine that ${action}s`, action, trigger: { kind: "daily", at: "09:00" },
        ...(member ? { member } : {}) };
      const refused = await make(s.tenant, { ...base, asksFirst: false });
      expect(refused.status).toBe(400);
      expect(refused.body).toEqual({ error: "must_ask_first" });
      expect((await made(s.tenant, base)).asksFirst).toBe(true);
      expect((await made(s.tenant, { ...base, asksFirst: true })).asksFirst).toBe(true);
    }
    // A brief or a draft only the owner sees may run without asking, or ask if the owner wants it to.
    expect((await made(s.tenant, { name: "Brief", action: "brief", trigger: { kind: "daily", at: "07:00" },
      asksFirst: false })).asksFirst).toBe(false);
    expect((await made(s.tenant, { name: "Post", action: "draft", member: "pim",
      trigger: { kind: "weekly", weekdays: [5], at: "10:00" }, asksFirst: true })).asksFirst).toBe(true);
    // Nothing refused was kept, and nothing refused was logged.
    const kept = (await list(s.tenant)).body.routines;
    expect(kept).toHaveLength(10);
    expect(kept.every((r) => r.asksFirst || r.action === "brief")).toBe(true);
    const created = (await auditEntries(s.tenant)).filter((entry) => entry.action === "routine.created");
    expect(created).toHaveLength(10);
  });

  it("refuses what routine-rules refuses, and a member whose work the routine is not", async () => {
    const s = await shop();
    const daily = { kind: "daily", at: "08:00" };
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "", action: "brief", trigger: daily }, "invalid_name"],
      [{ name: "x".repeat(81), action: "brief", trigger: daily }, "invalid_name"],
      [{ name: "Post", action: "post", trigger: daily }, "invalid_action"],
      [{ name: "Brief", action: "brief", trigger: daily, timeZone: "Moon/Olympus" }, "invalid_time_zone"],
      [{ name: "Brief", action: "brief", trigger: { kind: "hourly" } }, "invalid_trigger"],
      [{ name: "Brief", action: "brief", trigger: { kind: "daily", at: "8:00" } }, "invalid_time"],
      [{ name: "Brief", action: "brief", trigger: { kind: "weekly", weekdays: [7], at: "08:00" } }, "invalid_weekdays"],
      [{ name: "Brief", action: "brief", trigger: { kind: "monthly", day: 29, at: "08:00" } }, "invalid_day"],
      [{ name: "Brief", action: "brief", trigger: { kind: "window", from: "09:00", to: "09:00" } }, "invalid_window"],
      [{ name: "Restock", action: "draft", trigger: { kind: "stockBelow", threshold: 0 } }, "invalid_threshold"],
      [{ name: "Brief", action: "brief", trigger: daily, member: "kit" }, "unknown_member"],
      [{ name: "Brief", action: "brief", trigger: daily, member: "nam" }, "wrong_member"],
      [{ name: "Reply", action: "reply", trigger: daily, member: "pim" }, "wrong_member"],
      [{ name: "Pay", action: "pay", trigger: daily, member: "pim" }, "wrong_member"],
    ];
    for (const [input, error] of cases) {
      const answer = await make(s.tenant, input);
      expect(answer.status, `${JSON.stringify(input)}`).toBe(400);
      expect(answer.body).toEqual({ error });
    }
    expect((await list(s.tenant)).body.routines).toEqual([]);
    expect((await make("pilot:not-a-shop", { name: "Brief", action: "brief", trigger: daily })).body)
      .toEqual({ error: "shop_not_found" });
    expect((await make("", { name: "Brief", action: "brief", trigger: daily })).body).toEqual({ error: "tenant_required" });
  });

  it("pauses and resumes a routine once each, and removing it takes its clock away", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Last-day books", action: "send",
      trigger: { kind: "monthly", day: "last", at: "18:00" } });
    expect(await clockOf(s.tenant, routine.id)).toEqual({ timer: expect.anything() });

    const paused = await change(s.tenant, "pause", routine.id);
    expect(paused.status).toBe(200);
    expect(paused.body.routine).toMatchObject({ id: routine.id, paused: true, next: null });
    // Pausing a paused routine changes nothing, and logs nothing.
    expect((await change(s.tenant, "pause", routine.id)).body.routine).toMatchObject({ paused: true });
    const resumed = await change(s.tenant, "resume", routine.id);
    expect(resumed.body.routine).toMatchObject({ paused: false, next: routine.next });
    expect((await change(s.tenant, "resume", routine.id)).body.routine).toMatchObject({ paused: false });
    const actions = (await auditEntries(s.tenant)).map((entry) => entry.action).filter((a) => a.startsWith("routine."));
    expect(actions).toEqual(["routine.resumed", "routine.paused", "routine.created"]);

    const removed = await change(s.tenant, "remove", routine.id);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ removed: routine.id });
    expect((await list(s.tenant)).body.routines).toEqual([]);
    expect(await clockOf(s.tenant, routine.id)).toEqual({});
    for (const verb of ["pause", "resume", "remove"] as const) {
      expect((await change(s.tenant, verb, routine.id)).body).toEqual({ error: "not_found" });
    }
    expect((await change(s.tenant, "pause", "")).body).toEqual({ error: "invalid_request" });
  });

  it("keeps a stock routine and says it waits for a stock feed", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Tell me and draft a restock order", action: "draft",
      trigger: { kind: "stockBelow", threshold: 5 } });
    expect(routine).toMatchObject({ when: "When stock drops under 5", next: null, waitsFor: "stock_feed",
      member: "ton", asksFirst: false });
    // There is no stock feed yet, so nothing can tell it when to run: it has no clock.
    expect(await clockOf(s.tenant, routine.id)).toEqual({});
  });

  it("lets the shop's own session read and change its own routines, and nobody else", async () => {
    const tenant = `routines-session-${crypto.randomUUID()}`;
    const owner = await tenantSession(tenant);
    const created = await asSession<{ routine: RoutineView }>(owner, "POST", "/v1/routines",
      { name: "Weekly growth brief", action: "brief", trigger: { kind: "weekly", weekdays: [1], at: "08:00" } });
    expect(created.status).toBe(200);
    const id = created.body.routine.id;
    expect(created.body.routine.when).toBe("Every Monday at 08:00");
    const read = await asSession<RoutinesView>(owner, "GET", "/v1/routines");
    expect(read.status).toBe(200);
    expect(read.body.routines.map((r) => r.id)).toEqual([id]);
    expect((await asSession(owner, "POST", "/v1/routines/pause", { routineId: id })).body)
      .toMatchObject({ routine: { paused: true } });
    expect((await asSession(owner, "POST", "/v1/team/pause", {})).body).toMatchObject({ team: { paused: true } });
    expect((await asSession(owner, "POST", "/v1/team/resume", {})).body).toMatchObject({ team: { paused: false } });
    const logged = (await auditEntries(tenant)).find((entry) => entry.action === "routine.created");
    expect(logged).toMatchObject({ actor: { kind: "owner", id: "owner-session" }, subject: { routineId: id } });

    // Another shop's session finds nothing by that id, and changes nothing.
    const other = await tenantSession(`routines-session-${crypto.randomUUID()}`);
    expect((await asSession(other, "POST", "/v1/routines/resume", { routineId: id })).body).toEqual({ error: "not_found" });
    expect((await asSession<RoutinesView>(owner, "GET", "/v1/routines")).body.routines[0]).toMatchObject({ paused: true });
    // No session, or the operator key where a session belongs: nobody.
    expect((await asSession({}, "GET", "/v1/routines")).status).toBe(401);
    expect((await asSession({ authorization: "Bearer test-key" }, "GET", "/v1/routines")).status).toBe(401);
    // A helper decides what the owner lets them, but the team's routines stay the owner's.
    const s = await shop();
    const helper = await joinHelper(s);
    for (const [method, path] of [["GET", "/v1/routines"], ["POST", "/v1/routines"], ["POST", "/v1/team/pause"]]) {
      const answer = await asSession(helper.headers, method!, path!, method === "POST" ? {} : undefined);
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({ error: "owner_only" });
    }
  });
});

describe("running routines", () => {
  it("runs a daily and a weekly routine on the schedule object at their instant, once", async () => {
    const s = await shop();
    const { at, weekday } = bangkokJustBefore(Date.now());
    const daily = await made(s.tenant, { name: "Morning brief", action: "brief", trigger: { kind: "daily", at } });
    const weekly = await made(s.tenant, { name: "Weekly brief", action: "brief",
      trigger: { kind: "weekly", weekdays: [weekday], at } });
    expect((await clockOf(s.tenant, weekly.id)).schedule).toMatchObject({ routineId: weekly.id,
      weekdays: [weekday + 1] });

    await fireSchedules(s.tenant);
    for (const routine of [daily, weekly]) {
      const runs = await runsOf(s.tenant, routine.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ routineId: routine.id, status: "done", member: "ton" });
      // Ton's brief: a draft of yesterday's sales, which with none recorded calls no model.
      const exported = await taskExport(s.tenant, runs[0]!.taskId!);
      expect(exported.drafts).toHaveLength(1);
      expect(exported.drafts[0]).toMatchObject({ member: "ton", job: "daily_summary" });
      expect(exported.drafts[0]!.text).toMatch(/^No sales were recorded on \d{4}-\d{2}-\d{2}\.$/);
    }
    const tasks = await taskIds(s.tenant);

    // A duplicate alarm finds the occurrence already claimed, and so does the runner asked again directly.
    await fireSchedules(s.tenant);
    const instant = Date.parse((await runsOf(s.tenant, daily.id))[0]!.instant);
    expect(await runRoutineOccurrence(flowEnv, { tenant: s.tenant, routineId: daily.id, instant, late: false }))
      .toMatchObject({ status: "done" });
    for (const routine of [daily, weekly]) expect(await runsOf(s.tenant, routine.id)).toHaveLength(1);
    expect(await taskIds(s.tenant)).toEqual(tasks);
    expect((await list(s.tenant)).body.routines.find((r) => r.id === daily.id)?.lastRun)
      .toMatchObject({ status: "done", instant: new Date(instant).toISOString() });
  });

  it("runs a monthly and a window routine on the routine timer at their instant, once", async () => {
    // Instants well away from now, so the one before each is far outside the grace whenever the suite runs. Each has a
    // shop of its own: a sweep runs every clock the shop has, and sweeping ahead to one routine's instant would also
    // find the other's earlier one, and rightly record it missed.
    const now = Date.now();
    const triggers = [
      { kind: "monthly", day: bangkokDayOfMonth(now + 10 * DAY), at: "18:00" },
      { kind: "window", from: bangkokAt(now + 2 * HOUR), to: bangkokAt(now + 3 * HOUR) },
    ];
    for (const trigger of triggers) {
      const s = await shop();
      const routine = await made(s.tenant, { name: `A ${trigger.kind} brief`, action: "brief", trigger });
      expect((await clockOf(s.tenant, routine.id)).timer).toBeDefined();
      const instant = nextRun(rulesOf(routine), Date.now())!;
      expect(routine.next).toBe(new Date(instant).toISOString());
      // A minute before its instant nothing is due; a minute after, it runs, and sweeping again changes nothing.
      await sweepAt(s.tenant, instant - MINUTE);
      expect(await runsOf(s.tenant, routine.id)).toEqual([]);
      await sweepAt(s.tenant, instant + MINUTE);
      await sweepAt(s.tenant, instant + 2 * MINUTE);
      const runs = await runsOf(s.tenant, routine.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "done", instant: new Date(instant).toISOString(), member: "ton" });
    }
  });

  it("records a late alarm past the grace as missed and does not run it", async () => {
    const s = await shop();
    // The timer: monthly, swept twenty minutes after its instant.
    const monthly = await made(s.tenant, { name: "Month end", action: "brief",
      trigger: { kind: "monthly", day: 1, at: "09:00" } });
    const instant = nextRun(rulesOf(monthly), Date.now())!;
    await sweepAt(s.tenant, instant + GRACE + 5 * MINUTE);
    expect(await runsOf(s.tenant, monthly.id)).toEqual([
      expect.objectContaining({ status: "missed", instant: new Date(instant).toISOString() }),
    ]);
    expect((await runsOf(s.tenant, monthly.id))[0]!.taskId).toBeUndefined();

    // The schedule object: a daily routine whose clock was made two hours ago, an hour after its instant.
    const daily = await made(s.tenant, { name: "Hour-old brief", action: "brief",
      trigger: { kind: "daily", at: bangkokAt(Date.now() - 60 * MINUTE) } });
    await runInDurableObject(scheduleStub(bindings, s.tenant), async (_instance, state) => {
      const schedule = await state.storage.get<ScheduleJSON>(`sched:${daily.id}`);
      await state.storage.put(`sched:${daily.id}`, { ...schedule!,
        createdAt: new Date(Date.now() - 120 * MINUTE).toISOString() });
    });
    await fireSchedules(s.tenant);
    const runs = await runsOf(s.tenant, daily.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "missed" });
    expect(await taskIds(s.tenant)).toEqual([]);
    const ran = (await auditEntries(s.tenant)).filter((entry) => entry.action === "routine.ran");
    expect(ran.map((entry) => entry.outcome)).toEqual(["missed", "missed"]);
  });

  it("skips a paused routine's run and says so", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Morning brief", action: "brief",
      trigger: { kind: "daily", at: bangkokJustBefore(Date.now()).at } });
    await change(s.tenant, "pause", routine.id);
    await fireSchedules(s.tenant);
    const runs = await runsOf(s.tenant, routine.id);
    expect(runs).toEqual([expect.objectContaining({ status: "skipped", reason: "routine_paused" })]);
    expect(await taskIds(s.tenant)).toEqual([]);
    expect((await auditEntries(s.tenant)).find((entry) => entry.action === "routine.ran"))
      .toMatchObject({ actor: { kind: "system" }, subject: { routineId: routine.id }, outcome: "skipped",
        reason: "routine_paused" });
  });

  it("skips every routine's run while the team is paused, says so, and runs again once it is resumed", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Month end", action: "brief",
      trigger: { kind: "monthly", day: "last", at: "18:00" } });
    const paused = await team(s.tenant, "pause");
    expect(paused.status).toBe(200);
    expect(paused.body.team).toMatchObject({ paused: true, members: ["nam", "pim", "ton"] });
    expect(Date.parse(paused.body.team.since!)).toBeGreaterThan(0);
    // While everyone is paused, no routine has a next run.
    expect((await list(s.tenant)).body.routines[0]).toMatchObject({ paused: false, next: null });

    const first = nextRun(rulesOf(routine), Date.now())!;
    await sweepAt(s.tenant, first + MINUTE);
    expect(await runsOf(s.tenant, routine.id)).toEqual([
      expect.objectContaining({ status: "skipped", reason: "team_paused" }),
    ]);
    expect(await taskIds(s.tenant)).toEqual([]);

    expect((await team(s.tenant, "resume")).body.team).toEqual({ paused: false, since: null,
      members: ["nam", "pim", "ton"] });
    const second = nextRun(rulesOf(routine), first)!;
    await sweepAt(s.tenant, second + MINUTE);
    expect((await runsOf(s.tenant, routine.id)).map((run) => run.status)).toEqual(["done", "skipped"]);
    const actions = (await auditEntries(s.tenant)).map((entry) => entry.action);
    expect(actions).toContain("team.paused");
    expect(actions).toContain("team.resumed");
  });

  it("skips a run the owner has not consented to, and says why", async () => {
    const s = await shop({ consent: false });
    const routine = await made(s.tenant, { name: "Morning brief", action: "brief",
      trigger: { kind: "daily", at: bangkokJustBefore(Date.now()).at } });
    await fireSchedules(s.tenant);
    expect(await runsOf(s.tenant, routine.id)).toEqual([
      expect.objectContaining({ status: "skipped", reason: "consent_required" }),
    ]);
    expect(await taskIds(s.tenant)).toEqual([]);
  });

  it("only ever drafts: Ton's brief, Pim's post and Nam's reply, with nothing sent or asked", async () => {
    const s = await shop();
    const customer = await tenantCall(bindings, s.tenant, "/pilot/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-pilot": "1" },
      body: JSON.stringify({ tenant: s.tenant, connectionId: s.connectionId,
        events: [{ webhookEventId: crypto.randomUUID(), lineUserId: `U${"7".repeat(32)}`, text: "Is my parcel out?" }] }) });
    expect(customer.status).toBe(200);
    const routines = [
      await made(s.tenant, { name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" } }),
      await made(s.tenant, { name: "New arrivals", action: "draft", member: "pim",
        trigger: { kind: "weekly", weekdays: [5], at: "10:00" } }),
      await made(s.tenant, { name: "Answer order questions", action: "reply",
        trigger: { kind: "window", from: "21:00", to: "08:00" } }),
    ];
    expect(routines.map((r) => r.member)).toEqual(["ton", "pim", "nam"]);
    expect(routines[2]!.asksFirst).toBe(true);
    const instant = Math.floor(Date.now() / 1000) * 1000;
    for (const routine of routines) {
      const outcome = await runRoutineOccurrence(flowEnv, { tenant: s.tenant, routineId: routine.id, instant, late: false });
      expect(outcome, routine.name).toMatchObject({ status: "done" });
      const [run] = await runsOf(s.tenant, routine.id);
      const exported = await taskExport(s.tenant, run!.taskId!);
      expect(exported.drafts).toHaveLength(1);
      expect(exported.drafts[0]!.member).toBe(routine.member);
      // A draft only: no exact action was proposed and no approval request opened.
      expect(exported.actions).toEqual([]);
      expect(exported.requests).toEqual([]);
    }
    const [reply] = await runsOf(s.tenant, routines[2]!.id);
    expect((await taskExport(s.tenant, reply!.taskId!)).drafts[0]).toMatchObject({ job: "reply",
      send: { answer: "draft_only", kind: "reply" } });
    // Nothing left the Worker.
    expect(outbound).not.toHaveBeenCalled();
  });

  it("says a reply routine with no customer message to answer has nothing to do", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Answer order questions", action: "reply",
      trigger: { kind: "daily", at: "21:00" } });
    const outcome = await runRoutineOccurrence(flowEnv, { tenant: s.tenant, routineId: routine.id,
      instant: Date.now(), late: false });
    expect(outcome).toMatchObject({ status: "skipped", reason: "nothing_to_answer" });
    expect(await taskIds(s.tenant)).toEqual([]);
  });

  it("drops the clock of a routine that is gone", async () => {
    const s = await shop();
    const routine = await made(s.tenant, { name: "Month end", action: "brief",
      trigger: { kind: "monthly", day: 15, at: "09:00" } });
    // The routine's record goes, as a remove would take it, but its timer is left behind.
    const removed = await tenantCall(bindings, s.tenant, "/routines/remove", { method: "POST",
      headers: { "content-type": "application/json", "x-routines": "1" },
      body: JSON.stringify({ tenant: s.tenant, routineId: routine.id }) });
    expect(removed.status).toBe(200);
    expect((await clockOf(s.tenant, routine.id)).timer).toBeDefined();
    await sweepAt(s.tenant, nextRun(rulesOf(routine), Date.now())! + MINUTE);
    expect(await clockOf(s.tenant, routine.id)).toEqual({});
    expect(await runsOf(s.tenant, routine.id)).toEqual([]);
  });
});

describe("the audit log", () => {
  it("records each change and each run by id, never by a routine's words", async () => {
    const s = await shop();
    const name = "Count the jasmine candles 7781";
    const routine = await made(s.tenant, { name, action: "brief",
      trigger: { kind: "daily", at: bangkokJustBefore(Date.now()).at } });
    await change(s.tenant, "pause", routine.id);
    await fireSchedules(s.tenant);
    await change(s.tenant, "resume", routine.id);
    await team(s.tenant, "pause");
    await team(s.tenant, "resume");
    await change(s.tenant, "remove", routine.id);
    const entries = await auditEntries(s.tenant);
    const routineEntries = entries.filter((entry) => entry.action.startsWith("routine."));
    expect(routineEntries.map((entry) => entry.action)).toEqual(["routine.removed", "routine.resumed", "routine.ran",
      "routine.paused", "routine.created"]);
    for (const entry of routineEntries) expect(entry.subject).toEqual({ routineId: routine.id });
    expect(JSON.stringify(entries)).not.toContain("jasmine");
    expect(JSON.stringify(entries)).not.toContain(name);
  });
});

describe("the routine timer's instants", () => {
  const routineOf = (trigger: Trigger): Routine => {
    const built = createRoutine({ id: "rt-test", name: "Test", action: "brief", trigger });
    if (!built.ok) throw new Error(built.reason);
    return built.routine;
  };
  // 30 November 2026 is the last day of the month; 18:00 in Bangkok is 11:00 UTC.
  const lastDay = routineOf({ kind: "monthly", day: "last", at: "18:00" });
  const slot = Date.UTC(2026, 10, 30, 11, 0);

  it("finds the latest instant at or before now, back to a month ago", () => {
    expect(latestRoutineInstant(lastDay, slot + 5 * MINUTE, Date.UTC(2026, 0, 1))).toBe(slot);
    expect(latestRoutineInstant(lastDay, slot, Date.UTC(2026, 0, 1))).toBe(slot);
    expect(latestRoutineInstant(lastDay, slot - 1, Date.UTC(2026, 0, 1))).toBe(Date.UTC(2026, 9, 31, 11, 0));
    // A window starts at its first minute: 21:00 in Bangkok is 14:00 UTC.
    const night = routineOf({ kind: "window", from: "21:00", to: "08:00" });
    expect(latestRoutineInstant(night, Date.UTC(2026, 10, 23, 14, 3), Date.UTC(2026, 0, 1)))
      .toBe(Date.UTC(2026, 10, 23, 14, 0));
  });

  it("catches a slot a new clock just missed once, and never opens with older misses", () => {
    // Made five minutes after the slot: the slot is still inside the grace, so it is due.
    expect(latestRoutineInstant(lastDay, slot + 6 * MINUTE, slot + 5 * MINUTE)).toBe(slot);
    // Made an hour after it: nothing is due until the next one.
    expect(latestRoutineInstant(lastDay, slot + 61 * MINUTE, slot + 60 * MINUTE)).toBeNull();
    // A stock routine waits for an event and has no instants at all.
    expect(latestRoutineInstant(routineOf({ kind: "stockBelow", threshold: 5 }), slot, 0)).toBeNull();
  });
});
