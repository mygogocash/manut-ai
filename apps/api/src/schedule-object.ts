import { DurableObject } from "cloudflare:workers";
import { readJsonBody } from "./body";

const MAX_BODY_BYTES = 256 * 1024;

export type ScheduleJSON = {
  id: string;
  tenant: string;
  roleId: string;
  name: string;
  prompt: string;
  hour: number;
  minute: number;
  weekdays: number[];
  timeZone: string;
  skillId?: string;
  skillVersion?: number;
  instructionRevision?: string;
  funding: "localProvider" | "cloudBYOK" | "managedAI";
  enabled: boolean;
  hasSchedulingConsent: boolean;
  revision: number;
  nextFire: number;
  lastOccurrence?: string;
  createdAt: string;
};

export type OccurrenceJSON = {
  occurrenceId: string;
  scheduleId: string;
  tenant?: string;
  taskId?: string;
  status: "created" | "missed" | "skipped" | "blocked";
  at: string;
};

/// Grace after an occurrence instant inside which a late alarm still fires.
/// Past it, the run is recorded missed rather than executed late.
const OCCURRENCE_GRACE_MS = 15 * 60 * 1000;

/// One logical occurrence per schedule revision and intended instant — never
/// the timestamp of a late alarm. Duplicate alarm delivery claims the same
/// id and finds the work already done.
export function occurrenceID(scheduleId: string, instantMs: number, revision: number): string {
  return `${scheduleId.toLowerCase()}-${Math.floor(instantMs / 1000)}-${revision}`;
}

function wallParts(timeZone: string, atMs: number): { weekday: number; hour: number; minute: number } {
  // One formatter per zone: the sweep calls this per 15-minute slot scanned,
  // and constructing Intl.DateTimeFormat dominates that cost.
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(atMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) + 1;
  return { weekday, hour: Number(get("hour")), minute: Number(get("minute")) };
}

const SCAN_DAYS = 16;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/// Next instant after `fromMs` whose wall-clock time in `timeZone` matches
/// hour:minute on an enabled weekday. Nonexistent DST times never match and
/// are skipped; a time a fall-back repeats runs at its first occurrence only,
/// so a daily run is not minted twice that night.
export function nextFire(
  hour: number,
  minute: number,
  weekdays: number[],
  timeZone: string,
  fromMs: number,
): number | null {
  // Full scan in 15-minute steps: UTC-anchored days start on the previous
  // local evening, so no early exit on wall time is valid. DST gaps simply
  // never match. A repeated time's second copy is recognised by the same
  // wall time having occurred shortly before, and skipped.
  //
  // Sixteen days, not eight: a weekly run in the week a DST gap swallows its
  // wall time is fourteen days out, and a fall-back week stretches the next
  // one past eight. Either used to return null, and fireDue stopped re-arming.
  //
  // Every IANA zone's offset is a whole number of quarter hours (a test
  // guards this), so a grid anchored at `minute % 15` past UTC midnight lands
  // on the target minute exactly in any of them. Raw offsets that are not,
  // such as "+05:07", never match and save() refuses them. Matching a window
  // around the target instead missed minutes 56-59 outright (their window
  // crossed into the next hour) and could hand back an instant before
  // `fromMs`, arming a past alarm.
  const days = new Set(weekdays);
  const start = new Date(fromMs);
  start.setUTCHours(0, minute % 15, 0, 0);
  for (let offset = 0; offset < SCAN_DAYS; offset++) {
    for (let slot = 0; slot < 24 * 4; slot++) {
      const candidate = start.getTime() + offset * 24 * 3600 * 1000 + slot * 15 * 60 * 1000;
      if (candidate <= fromMs) continue;
      const wall = wallParts(timeZone, candidate);
      if (!days.has(wall.weekday)) continue;
      if (wall.hour !== hour || wall.minute !== minute) continue;
      if (repeatsEarlierWallTime(timeZone, candidate, wall)) continue;
      return candidate;
    }
  }
  return null;
}

/// Whether the same wall time already occurred within the last few hours,
/// which makes `atMs` the second copy of a time a fall-back repeats. Every
/// fall-back in use shifts by 30, 60 or (Antarctica/Troll) 120 minutes.
function repeatsEarlierWallTime(
  timeZone: string,
  atMs: number,
  wall: { weekday: number; hour: number; minute: number },
): boolean {
  for (const shift of [30, 60, 120]) {
    const earlier = wallParts(timeZone, atMs - shift * 60 * 1000);
    if (earlier.weekday === wall.weekday && earlier.hour === wall.hour && earlier.minute === wall.minute) {
      return true;
    }
  }
  return false;
}

type ScheduleEnv = {
  TASK: DurableObjectNamespace;
  AUTH: DurableObjectNamespace;
  TENANT: DurableObjectNamespace;
};

/// Durable recurrence for one schedule: alarms wake it, occurrence ids make
/// duplicate delivery harmless, and each firing mints at most one cloud
/// task. Overlap skips while the previous task is still unsettled; missed
/// instants past grace record as missed instead of running late.
export class ScheduleObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    // Earlier builds armed the one alarm per schedule and deleted it whenever a
    // disabled schedule was saved, leaving enabled schedules dormant. Waking
    // with no alarm re-arms, so those start running again on the first request
    // after deploy instead of waiting for someone to save a schedule.
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await this.rearm();
    });
  }

  private get scheduleEnv(): ScheduleEnv {
    return this.env as unknown as ScheduleEnv;
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/schedules") {
      return this.save(request);
    }
    if (request.method === "GET" && url.pathname === "/schedules") {
      return this.list(request);
    }
    const match = url.pathname.match(/^\/schedules\/([^/]+)$/);
    if (match && request.method === "GET") {
      const id = match[1];
      if (!id) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.read(request, id);
    }
    if (match && request.method === "DELETE") {
      const id = match[1];
      if (!id) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.remove(request, id);
    }
    if (request.method === "POST" && url.pathname === "/tenant-wipe") {
      return this.tenantWipe(request);
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  override async alarm(): Promise<void> {
    // Kill switches: while routines are explicitly disabled, or cloud work is,
    // nothing fires, but the alarm stays armed so re-enabling resumes without
    // a manual re-save. An absent flag defers to the environment default (as
    // in index.ts).
    const flags = await this.routineFlags().catch(() => null);
    if (flags && (flags.officeRoutines === false || flags.officeCloud === false)) {
      await this.rearm();
      return;
    }
    // Live consent is checked once per sweep: revoking cloud consent stops
    // future firings even though stored schedules still carry their
    // creation-time hasSchedulingConsent flag. (One tenant per object, so the
    // sweep reads consent for the object owner's tenant only.)
    let needsRetry = false;
    const schedules = await this.ctx.storage.list<ScheduleJSON>({ prefix: "sched:" });
    const owner = [...schedules.values()].find((schedule) => schedule.tenant)?.tenant;
    const consent = owner ? await this.liveConsent(owner).catch(() => false) : false;
    for (const [, schedule] of schedules) {
      try {
        if (!schedule.enabled || !schedule.hasSchedulingConsent) continue;
        if (!consent) continue;
        await this.fireDue(schedule);
      } catch (error) {
        // One schedule's failure never stops the sweep, and the error is
        // logged instead of swallowed: unclaimed occurrences are retried
        // below while still inside the grace window.
        console.error("schedule alarm failed", schedule.id, error);
        needsRetry = true;
      }
    }
    const soonest = await this.rearm();
    if (needsRetry) {
      const retryAt = Date.now() + 60_000;
      if (soonest === null || retryAt < soonest) {
        await this.ctx.storage.setAlarm(retryAt);
      }
    }
  }

  /// One tenant's schedules live in this object, and a Durable Object has a
  /// single alarm, so it is always set to the soonest run across all enabled
  /// schedules of that tenant. Arming it per schedule let the last one
  /// written win: earlier runs of the others woke nobody and were later
  /// recorded missed, and saving any disabled schedule deleted the alarm for
  /// everyone.
  private async rearm(): Promise<number | null> {
    const now = Date.now();
    let soonest: number | null = null;
    for (const [, schedule] of await this.ctx.storage.list<ScheduleJSON>({ prefix: "sched:" })) {
      if (!schedule.enabled || !schedule.hasSchedulingConsent) continue;
      const next = nextFire(schedule.hour, schedule.minute, schedule.weekdays, schedule.timeZone, now);
      if (next !== null && (soonest === null || next < soonest)) soonest = next;
    }
    if (soonest === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(soonest);
    return soonest;
  }

  private tenantOf(request: Request): string {
    return request.headers.get("x-tenant") ?? "";
  }

  /// Same existence-hiding rule as tasks: a set tenant mismatching a set
  /// header is invisible; either side empty passes through.
  private foreign(tenant: string, request: Request): boolean {
    const header = this.tenantOf(request);
    return !!tenant && !!header && tenant !== header;
  }

  private async save(request: Request): Promise<Response> {
    const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    const text = (value: unknown, max: number): string | null =>
      typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
    const id = typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
    const tenant = this.tenantOf(request);
    if (!tenant) return Response.json({ error: "tenant_required" }, { status: 400 });
    const hour = body.hour as number;
    const minute = body.minute as number;
    const weekdays = Array.isArray(body.weekdays) ? body.weekdays : [];
    const timeZone = typeof body.timeZone === "string" ? body.timeZone : "";
    const prompt = text(body.prompt, 4000);
    const name = text(body.name, 128) ?? "Automation";
    const roleId = text(body.roleId, 128) ?? "";
    if (
      !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59 ||
      weekdays.length === 0 ||
      !weekdays.every((day): day is number => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 7) ||
      !prompt
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    try {
      Intl.DateTimeFormat("en-US", { timeZone });
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const prior = await this.ctx.storage.get<ScheduleJSON>(`sched:${id}`);
    if (prior && this.foreign(prior.tenant, request)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const revision = (prior?.revision ?? 0) + 1;
    const next = nextFire(hour, minute, weekdays, timeZone, Date.now());
    // A zone the quarter-hour grid can never match, such as the raw offset
    // "+05:07" that Intl accepts, would store a schedule that never runs.
    if (next === null) return Response.json({ error: "invalid_request" }, { status: 400 });
    const schedule: ScheduleJSON = {
      id,
      tenant,
      roleId,
      name,
      prompt,
      hour,
      minute,
      weekdays: [...new Set(weekdays as number[])].sort(),
      timeZone,
      ...(typeof body.skillId === "string" ? { skillId: body.skillId } : {}),
      ...(Number.isInteger(body.skillVersion) ? { skillVersion: body.skillVersion as number } : {}),
      ...(typeof body.instructionRevision === "string" ? { instructionRevision: body.instructionRevision as string } : {}),
      funding: body.funding === "localProvider" || body.funding === "managedAI" ? body.funding : "cloudBYOK",
      enabled: body.enabled !== false,
      hasSchedulingConsent: body.hasSchedulingConsent === true,
      revision,
      nextFire: next,
      ...(prior?.lastOccurrence ? { lastOccurrence: prior.lastOccurrence } : {}),
      createdAt: prior?.createdAt ?? new Date().toISOString(),
    };
    await this.ctx.storage.put(`sched:${id}`, schedule);
    await this.rearm();
    return Response.json(schedule);
  }

  private async list(request: Request): Promise<Response> {
    const tenant = this.tenantOf(request);
    if (!tenant) return Response.json({ error: "tenant_required" }, { status: 400 });
    const schedules: ScheduleJSON[] = [];
    for (const [, schedule] of await this.ctx.storage.list<ScheduleJSON>({ prefix: "sched:" })) {
      if (schedule.tenant === tenant) schedules.push(publicSchedule(schedule));
    }
    return Response.json({ schedules });
  }

  private async read(request: Request, id: string): Promise<Response> {
    const schedule = await this.ctx.storage.get<ScheduleJSON>(`sched:${id}`);
    if (!schedule || this.foreign(schedule.tenant, request)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Occurrence keys embed the lowercased schedule id, so one prefixed
    // listing replaces the old full-store scan plus filter.
    const occurrences: OccurrenceJSON[] = [];
    for (const [, entry] of await this.ctx.storage.list<OccurrenceJSON>({
      prefix: `occ:${id.toLowerCase()}-`,
    })) {
      occurrences.push(entry);
    }
    occurrences.sort((a, b) => (a.at < b.at ? 1 : -1));
    return Response.json({
      schedule: publicSchedule(schedule),
      next: nextOccurrences(schedule, 3),
      occurrences: occurrences.slice(0, 5),
    });
  }

  private async remove(request: Request, id: string): Promise<Response> {
    const schedule = await this.ctx.storage.get<ScheduleJSON>(`sched:${id}`);
    if (!schedule || this.foreign(schedule.tenant, request)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    await this.ctx.storage.delete(`sched:${id}`);
    // Occurrence records stay as the audit trail; re-arming leaves the
    // deleted schedule out, so the alarm never fires for it again.
    await this.rearm();
    return Response.json({ removed: true });
  }

  private async fireDue(schedule: ScheduleJSON): Promise<void> {
    const now = Date.now();
    // Re-arming happens once, after the sweep, in `alarm()`.
    if (!schedule.enabled || !schedule.hasSchedulingConsent) return;
    // The latest due instant, if any. Past grace it records missed instead
    // of executing late.
    const instant = latestDueInstant(
      schedule.hour,
      schedule.minute,
      schedule.weekdays,
      schedule.timeZone,
      now,
      Date.parse(schedule.createdAt),
    );
    if (instant === null) return;
    const occurrenceId = occurrenceID(schedule.id, instant, schedule.revision);
    if (await this.ctx.storage.get(`occ:${occurrenceId}`)) return;
    if (now - instant > OCCURRENCE_GRACE_MS) {
      await this.ctx.storage.put(`occ:${occurrenceId}`, {
        occurrenceId,
        scheduleId: schedule.id,
        tenant: schedule.tenant,
        status: "missed",
        at: new Date().toISOString(),
      });
      return;
    }
    if (schedule.lastOccurrence) {
      const prior = await this.ctx.storage.get<OccurrenceJSON>(`occ:${schedule.lastOccurrence}`);
      if (prior?.taskId && prior.status === "created") {
        const state = await this.taskState(prior.taskId, schedule.tenant);
        if (state && state !== "completed" && state !== "cancelled" && state !== "failed") {
          await this.ctx.storage.put(`occ:${occurrenceId}`, {
            occurrenceId,
            scheduleId: schedule.id,
            tenant: schedule.tenant,
            status: "skipped",
            at: new Date().toISOString(),
          });
          return;
        }
      }
    }
    // The task id derives from the occurrence id, so a retried mint lands
    // on the same record: create-only answers 409 for the duplicate, the
    // index call is idempotent, and exactly one occurrence is ever claimed.
    const taskId = await deterministicTaskId(occurrenceId);
    const taskStub = this.scheduleEnv.TASK.get(this.scheduleEnv.TASK.idFromName(taskId));
    const created = await taskStub.fetch(
      new Request("https://task/", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-task-id": taskId,
          "x-tenant": schedule.tenant,
          "x-create-only": "1",
        },
        body: JSON.stringify({
          id: taskId,
          title: schedule.name,
          objective: schedule.prompt,
          state: "queued",
          location: "cloud",
          funding: schedule.funding,
          criteria: [],
          updatedAt: new Date().toISOString(),
          tenantId: schedule.tenant,
        }),
      }),
    );
    // A failed mint claims nothing: the next alarm retries the same id. A
    // 404 is the one failure that retrying can never clear: the
    // deterministic task id is held by another tenant (a squat), and the
    // create-only PUT answers not_found for a foreign task. Recording the
    // occurrence as blocked stops the alarm from waking forever on it, and
    // nothing is deleted or rewritten: the squatter's task stays theirs.
    if (created.status === 404) {
      await this.ctx.storage.put(`occ:${occurrenceId}`, {
        occurrenceId,
        scheduleId: schedule.id,
        tenant: schedule.tenant,
        taskId,
        status: "blocked",
        at: new Date().toISOString(),
      });
      return;
    }
    if (!created.ok && created.status !== 409) {
      return;
    }
    // Index before claiming: export and tenant deletion find every task the
    // alarms mint, and a failed index leaves the occurrence unclaimed so a
    // later alarm adopts the existing task instead of orphaning one.
    const indexed = await this.scheduleEnv.TENANT.get(
      this.scheduleEnv.TENANT.idFromName(`t:${schedule.tenant || "operator"}`),
    ).fetch(
      new Request("https://tenant/index", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant: schedule.tenant, taskId }),
      }),
    );
    if (!indexed.ok) return;
    // The mint and index above await other objects: a concurrent save or
    // delete may have landed meanwhile. Re-read and only touch the schedule
    // when it is still the revision we fired for — otherwise a disabled
    // schedule flips back on, or a deleted one comes back. Spreading the
    // fresh copy also preserves field edits made during the flight.
    const fresh = await this.ctx.storage.get<ScheduleJSON>(`sched:${schedule.id}`);
    if (!fresh || fresh.revision !== schedule.revision || !fresh.enabled) return;
    await this.ctx.storage.put({
      [`occ:${occurrenceId}`]: {
        occurrenceId,
        scheduleId: schedule.id,
        tenant: schedule.tenant,
        taskId,
        status: "created",
        at: new Date().toISOString(),
      },
      [`sched:${schedule.id}`]: { ...fresh, lastOccurrence: occurrenceId },
    });
    await this.pruneOccurrences(schedule.id);
  }

  /// Keeps each schedule's occurrence history bounded: the read path shows
  /// only the latest few, so anything past the cap is audit residue. Scoped
  /// by key prefix to the one schedule, never a full-store scan.
  private async pruneOccurrences(scheduleId: string, keep = 30): Promise<void> {
    const entries: { key: string; at: string }[] = [];
    for (const [key, entry] of await this.ctx.storage.list<OccurrenceJSON>({
      prefix: `occ:${scheduleId.toLowerCase()}-`,
    })) {
      entries.push({ key, at: entry.at });
    }
    if (entries.length <= keep) return;
    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const stale of entries.slice(0, entries.length - keep)) {
      await this.ctx.storage.delete(stale.key);
    }
  }

  /// Live cloud-work consent for a tenant, read from its TenantObject. An explicit
  /// opt-out stops firing even though the stored schedule still carries its
  /// creation-time hasSchedulingConsent flag. Tenants with no consent record
  /// at all (operator/dev paths, which never write one) fall back to the
  /// stored flag — session tenants always have a record because schedule
  /// creation requires consent first. Unreadable means no firing, without
  /// claiming, so a later alarm retries the same occurrence id.
  private async liveConsent(tenant: string): Promise<boolean> {
    const stub = this.scheduleEnv.TENANT.get(this.scheduleEnv.TENANT.idFromName(`t:${tenant || "operator"}`));
    const response = await stub.fetch(
      new Request(`https://tenant/consent?tenant=${encodeURIComponent(tenant)}`),
    );
    if (!response.ok) return false;
    const record = (await response.json()) as { cloudWork?: boolean; updatedAt?: string };
    if (typeof record.updatedAt !== "string") return true;
    return record.cloudWork === true;
  }

  private async routineFlags(): Promise<{ officeRoutines?: boolean; officeCloud?: boolean } | null> {
    const response = await this.scheduleEnv.AUTH.get(this.scheduleEnv.AUTH.idFromName("auth")).fetch(
      new Request("https://auth/flags"),
    );
    if (!response.ok) return null;
    return (await response.json()) as { officeRoutines?: boolean };
  }

  /// Tenant deletion, worker-orchestrated. The object IS the tenant's (M4
  /// phase 3: addressed `t:${tenant}`), so wiping is deleting every schedule
  /// and occurrence record, then disarming. No tenant matching — the Worker
  /// chose this object by tenant, and `foreign()` still guards reads.
  private async tenantWipe(request: Request): Promise<Response> {
    if (request.headers.get("x-wipe") !== "1") {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const parsed = await readJsonBody<{ tenant?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const body = parsed.value;
    if (typeof body.tenant !== "string" || !body.tenant) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    let schedulesWiped = 0;
    for (const [key] of await this.ctx.storage.list({ prefix: "sched:" })) {
      await this.ctx.storage.delete(key);
      schedulesWiped++;
    }
    let occurrencesWiped = 0;
    for (const [key] of await this.ctx.storage.list({ prefix: "occ:" })) {
      await this.ctx.storage.delete(key);
      occurrencesWiped++;
    }
    await this.rearm();
    return Response.json({ schedulesWiped, occurrencesWiped });
  }

  private async taskState(taskId: string, tenant: string): Promise<string | null> {
    const stub = this.scheduleEnv.TASK.get(this.scheduleEnv.TASK.idFromName(taskId));
    const response = await stub.fetch(new Request("https://task/", { headers: { "x-tenant": tenant } }));
    if (!response.ok) return null;
    const doc = (await response.json()) as { state?: string };
    return typeof doc.state === "string" ? doc.state : null;
  }
}

/// Deterministic task id per occurrence, so retries converge instead of
/// multiplying tasks. Exported because the squat test must be able to hold
/// the same id the alarm would mint, which any outside party can compute;
/// that is exactly the attack the "blocked" recording answers.
export async function deterministicTaskId(occurrenceId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`task:${occurrenceId}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/// The latest occurrence instant at or before now, looking back up to 8
/// days (weekly schedules still resolve) but never before one catch-up
/// window ahead of creation: a fresh schedule catches a just-missed slot
/// once, and never opens with ancient misses.
export function latestDueInstant(
  hour: number,
  minute: number,
  weekdays: number[],
  timeZone: string,
  nowMs: number,
  createdAtMs: number,
  catchUpMs: number = OCCURRENCE_GRACE_MS,
): number | null {
  let instant: number | null = null;
  let cursor = Math.max(nowMs - 8 * 24 * 3600 * 1000, createdAtMs - catchUpMs);
  for (let i = 0; i < 10; i++) {
    const candidate = nextFire(hour, minute, weekdays, timeZone, cursor);
    if (candidate === null || candidate > nowMs) break;
    instant = candidate;
    cursor = candidate + 1000;
  }
  return instant;
}
/// The next few occurrence instants, for the enablement preview. Purely
/// derived; the alarm owns actual firing.
export function nextOccurrences(schedule: ScheduleJSON, count: number): number[] {
  const instants: number[] = [];
  let from = Date.now();
  for (let i = 0; i < count; i++) {
    const next = nextFire(schedule.hour, schedule.minute, schedule.weekdays, schedule.timeZone, from);
    if (next === null) break;
    instants.push(next);
    from = next + 1000;
  }
  return instants;
}

function publicSchedule(schedule: ScheduleJSON): ScheduleJSON {
  return schedule;
}
