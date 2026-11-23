/// Building the team's routines and setting a new shop up from a template: what the routes (routines.ts) and a shop's
/// creation (pilot.ts) share. It imports neither of them, nor the workers, so creating a shop never pulls the runner in.
///
/// - `buildRoutine` makes a routine through `@manut/routine-rules`' `createRoutine`, so a routine that replies, sends,
///   pays or deletes always asks first and asking for false there is refused, then names the worker whose job each
///   run starts.
/// - `routineView` is a routine as a list shows it: its trigger in words (`describeTrigger`) and its next run
///   (`nextRun`), or none while it, or the whole team, is paused.
/// - `ensureClocks` and `removeClock` keep the shop's schedule object in step: a schedule for a daily or weekly routine,
///   through `toSchedule`, and a timer for a monthly or window one (schedule-object.ts). A stock routine waits for a
///   stock feed, which does not exist yet, so it has no clock.
/// - `checkedTemplate` and `applyTemplate` are a shop template (`@manut/shop-templates`): its members on, its routines
///   paused until the owner turns each on, and its first-week questions for Buddy to ask.
///
/// Order is how a half-finished change heals itself. A clock is written before its routine and removed after it, so
/// whatever stops part way leaves at most a clock with no routine, which finds it gone at its first instant and removes
/// itself (routine-store.ts, the claim).

import {
  createRoutine,
  describeTrigger,
  nextRun,
  type ActionKind,
  type Routine,
  type RoutineRefusal,
  type Trigger,
} from "@manut/routine-rules";
import { checkTemplate, templateById, type RoutineKind, type ShopTemplate } from "@manut/shop-templates";
import type { AuditActor } from "./audit-log";
import { sortableId } from "./pilot-store";
import { memberOn, type RoutineRun, type RoutineState, type StoredRoutine, type Team } from "./routine-store";
import { scheduleStub, tenantCall, type TenantDataEnv } from "./tenant-data";
import type { WorkerMember } from "./workers";

export const WORKERS: readonly WorkerMember[] = ["nam", "pim", "ton"];

/// The kinds of routine each worker's job can carry out, from what each can draft (workers.ts): Nam drafts replies to
/// customers; Pim drafts posts, which sending later asks for; Ton drafts the owner's summaries and the books, which is
/// also where paying and deleting would be asked from. A routine given to a member whose work it is not is refused
/// rather than run as something else.
const WORK: Readonly<Record<WorkerMember, readonly ActionKind[]>> = {
  nam: ["reply"],
  pim: ["draft", "send"],
  ton: ["brief", "draft", "send", "pay", "delete"],
};

export type RoutineView = {
  id: string;
  name: string;
  action: ActionKind;
  trigger: Trigger;
  timeZone: string;
  asksFirst: boolean;
  member: WorkerMember;
  /// The trigger in words, as `@manut/routine-rules` says it ("Every day at 08:00").
  when: string;
  paused: boolean;
  /// When it next runs, or null: paused, the team paused, its member off, or waiting for an event.
  next: string | null;
  /// A stock routine waits for a stock feed, which Manut AI does not have yet.
  waitsFor?: "stock_feed";
  template?: string;
  createdAt: string;
  lastRun: RoutineRun | null;
};

export type TeamView = { paused: boolean; since: string | null; members: WorkerMember[] };
export type RoutinesView = { tenant: string; team: TeamView; routines: RoutineView[] };

/// What a request may say about a new routine. Everything is checked; nothing is trusted.
export type RoutineInput = {
  name?: unknown;
  action?: unknown;
  trigger?: unknown;
  timeZone?: unknown;
  asksFirst?: unknown;
  member?: unknown;
};

export type BuildRefusal = RoutineRefusal | "unknown_member" | "wrong_member" | "invalid_request";
export type BuildResult = { ok: true; routine: StoredRoutine } | { ok: false; error: BuildRefusal };

const iso = (ms: number) => new Date(ms).toISOString();

export function isWorkerMember(value: unknown): value is WorkerMember {
  return typeof value === "string" && (WORKERS as readonly string[]).includes(value);
}

/// Who runs a routine when nobody said: Nam for a reply, Ton for everything else (a brief or a draft is Ton's first).
export function defaultMember(action: ActionKind): WorkerMember {
  return action === "reply" ? "nam" : "ton";
}

/// A new routine, with a new id (`rt-` and an id that sorts by when it was made, so a list reads in that order). See
/// the module note.
export function buildRoutine(input: RoutineInput, options: { nowMs: number; paused: boolean; template?: string }):
  BuildResult {
  if (input.asksFirst !== undefined && typeof input.asksFirst !== "boolean") return { ok: false, error: "invalid_request" };
  // routine-rules checks every field itself, whatever its type, so each goes over as it came.
  const built = createRoutine({
    id: sortableId("rt", options.nowMs, 0),
    name: input.name as string,
    action: input.action as ActionKind,
    trigger: input.trigger as Trigger,
    ...(input.timeZone !== undefined ? { timeZone: input.timeZone as string } : {}),
    ...(input.asksFirst !== undefined ? { asksFirst: input.asksFirst } : {}),
  });
  if (!built.ok) return { ok: false, error: built.reason };
  const { routine } = built;
  const member = input.member === undefined ? defaultMember(routine.action) : input.member;
  if (!isWorkerMember(member)) return { ok: false, error: "unknown_member" };
  if (!WORK[member].includes(routine.action)) return { ok: false, error: "wrong_member" };
  return { ok: true, routine: { ...routine, member, paused: options.paused, createdAt: iso(options.nowMs),
    ...(options.template !== undefined ? { template: options.template } : {}) } };
}

/// The routine-rules routine a stored one is, for the package's functions.
export function rulesOf(routine: StoredRoutine): Routine {
  return { id: routine.id, name: routine.name, action: routine.action, timeZone: routine.timeZone,
    trigger: routine.trigger, asksFirst: routine.asksFirst };
}

export function teamView(team: Team): TeamView {
  return { paused: team.paused, since: team.since, members: team.members ? [...team.members] : [...WORKERS] };
}

export function routineView(routine: StoredRoutine, team: Team, lastRun: RoutineRun | null, nowMs: number): RoutineView {
  const rules = rulesOf(routine);
  const runs = !routine.paused && !team.paused && memberOn(team, routine.member);
  const next = runs ? nextRun(rules, nowMs) : null;
  return {
    id: routine.id,
    name: routine.name,
    action: routine.action,
    trigger: routine.trigger,
    timeZone: routine.timeZone,
    asksFirst: routine.asksFirst,
    member: routine.member,
    when: describeTrigger(rules),
    paused: routine.paused,
    next: next === null ? null : iso(next),
    ...(routine.trigger.kind === "stockBelow" ? { waitsFor: "stock_feed" as const } : {}),
    ...(routine.template !== undefined ? { template: routine.template } : {}),
    createdAt: routine.createdAt,
    lastRun,
  };
}

export function routinesView(tenant: string, state: RoutineState & { lastRuns: RoutineRun[] }, nowMs: number): RoutinesView {
  const lastRun = (id: string) => state.lastRuns.find((run) => run.routineId === id) ?? null;
  return { tenant, team: teamView(state.team),
    routines: state.routines.map((routine) => routineView(routine, state.team, lastRun(routine.id), nowMs)) };
}

// ---------------------------------------------------------------------------
// The shop's records and its clocks
// ---------------------------------------------------------------------------

/// A write to the shop's routines (routine-store.ts), with the Worker's header. Null when the object cannot be reached.
export async function routineWrite(env: Pick<TenantDataEnv, "TENANT">, tenant: string, path: string,
  body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await tenantCall(env, tenant, path, { method: "POST",
      headers: { "content-type": "application/json", "x-routines": "1" }, body: JSON.stringify({ tenant, ...body }) });
  } catch {
    return null;
  }
}

/// The shop's routines, team, questions and each routine's latest run; null when they cannot be read.
export async function readRoutines(env: Pick<TenantDataEnv, "TENANT">, tenant: string):
  Promise<(RoutineState & { lastRuns: RoutineRun[] }) | null> {
  try {
    const response = await tenantCall(env, tenant, `/routines?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as RoutineState & { lastRuns: RoutineRun[] };
  } catch {
    return null;
  }
}

/// Asks the shop's schedule object to keep a clock for each routine that runs at set times. A clock it already keeps
/// stays as it is, so asking again (a routine resumed, a template applied twice) never moves an instant. Answers
/// whether the object took them all.
export async function ensureClocks(env: Pick<TenantDataEnv, "SCHEDULES">, tenant: string,
  routines: readonly StoredRoutine[]): Promise<boolean> {
  const timed = routines.filter((routine) => routine.trigger.kind !== "stockBelow").map(rulesOf);
  if (timed.length === 0) return true;
  try {
    const response = await scheduleStub(env, tenant).fetch(new Request("https://schedules/routine-clocks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant, "x-routine": "1" },
      body: JSON.stringify({ tenant, routines: timed }),
    }));
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/// Removes a routine's clock. Best effort: a clock left behind removes itself at its next instant.
export async function removeClock(env: Pick<TenantDataEnv, "SCHEDULES">, tenant: string, routineId: string):
  Promise<void> {
  try {
    const response = await scheduleStub(env, tenant).fetch(new Request(
      `https://schedules/routine-clocks/${encodeURIComponent(routineId)}`,
      { method: "DELETE", headers: { "x-tenant": tenant, "x-routine": "1" } },
    ));
    await response.body?.cancel();
  } catch {
    // Heals at the clock's next instant (module note).
  }
}

// ---------------------------------------------------------------------------
// Shop templates
// ---------------------------------------------------------------------------

/// The template with this id when it is one of `@manut/shop-templates`' own and `checkTemplate` finds no problem with
/// it; null for anything else.
export function checkedTemplate(id: unknown): ShopTemplate | null {
  if (typeof id !== "string") return null;
  const template = templateById(id);
  return template && checkTemplate(template).length === 0 ? template : null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/// The trigger a template's words describe: the forms `describeTrigger` writes, read back. "When a size drops under 3"
/// is read as stock below 3: until a stock feed exists neither runs, and the routine's name keeps what it is for.
/// Null for words in any other form, and routine-rules checks the rest (a time that is not one, a day out of range).
export function triggerOf(words: string): Trigger | null {
  const time = "(\\d{2}:\\d{2})";
  let match: RegExpExecArray | null;
  if ((match = new RegExp(`^Every day at ${time}$`).exec(words))) return { kind: "daily", at: match[1]! };
  if ((match = new RegExp(`^Every day from ${time} to ${time}$`).exec(words))) {
    return { kind: "window", from: match[1]!, to: match[2]! };
  }
  if ((match = new RegExp(`^On the last day of the month at ${time}$`).exec(words))) {
    return { kind: "monthly", day: "last", at: match[1]! };
  }
  if ((match = new RegExp(`^On the (\\d{1,2})(?:st|nd|rd|th) of each month at ${time}$`).exec(words))) {
    return { kind: "monthly", day: Number(match[1]), at: match[2]! };
  }
  if ((match = /^When (?:stock|a size) drops under (\d+)$/.exec(words))) {
    return { kind: "stockBelow", threshold: Number(match[1]) };
  }
  if ((match = new RegExp(`^Every (.+) at ${time}$`).exec(words))) {
    const weekdays = match[1]!.split(/, | and /).map((name) => DAY_NAMES.indexOf(name));
    return weekdays.every((day) => day >= 0) ? { kind: "weekly", weekdays, at: match[2]! } : null;
  }
  return null;
}

/// A template's kinds in routine-rules' words: a reminder is a brief for the owner, and a post is something sent, which
/// asks first.
const ACTION_OF: Readonly<Record<RoutineKind, ActionKind>> = {
  brief: "brief", draft: "draft", remind: "brief", reply: "reply", send: "send", post: "send", pay: "pay",
  delete: "delete",
};

/// Who runs a template's routine: Nam a reply, Pim a post (a kind of its own, or a draft whose words say it is one), and
/// Ton the rest.
function memberOf(kind: RoutineKind, does: string): WorkerMember {
  if (kind === "reply") return "nam";
  return kind === "post" || /\bpost\b/i.test(does) ? "pim" : "ton";
}

/// A template's routines as this shop's, each paused until the owner turns it on, so nothing runs by surprise.
export function templateRoutines(template: ShopTemplate, nowMs: number):
  { ok: true; routines: StoredRoutine[] } | { ok: false; error: BuildRefusal } {
  const routines: StoredRoutine[] = [];
  for (const routine of template.routines) {
    const trigger = triggerOf(routine.trigger);
    if (!trigger) return { ok: false, error: "invalid_trigger" };
    const built = buildRoutine({ name: routine.does, action: ACTION_OF[routine.kind], trigger,
      asksFirst: routine.asksFirst, member: memberOf(routine.kind, routine.does) },
    { nowMs, paused: true, template: template.id });
    if (!built.ok) return built;
    routines.push(built.routine);
  }
  return { ok: true, routines };
}

/// Sets a new shop up from a template: the clocks first, then the members it turns on, its routines and its questions
/// in one write to the shop's object, logged as `template.applied` and one `routine.created` each. Answers whether all
/// of it was written. Only the workers among its members can be turned on; Kit has no job here yet.
export async function applyTemplate(env: Pick<TenantDataEnv, "TENANT" | "SCHEDULES">, tenant: string,
  template: ShopTemplate, actor: AuditActor): Promise<boolean> {
  const built = templateRoutines(template, Date.now());
  if (!built.ok) return false;
  if (!(await ensureClocks(env, tenant, built.routines))) return false;
  const response = await routineWrite(env, tenant, "/routines/template", {
    template: template.id,
    members: template.team.filter(isWorkerMember),
    routines: built.routines,
    questions: template.questions.map((text, index) => ({ id: `q${index + 1}`, text })),
    actor,
  });
  await response?.body?.cancel();
  return response?.ok === true;
}
