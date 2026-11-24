// The offline cache: the last good read of the shop, kept on this computer so that when the API cannot be reached the
// app can show what was there instead of an empty screen, and say when that was (docs/runtime-adapter.md).
//
// Rules this module keeps:
// - What is kept is what the screens read (tasks and their actions, the requests waiting for an answer, schedules,
//   attention items), copied field by field. The requests are written as approval-core's own wire JSON, their detail cut
//   down to the words the card shows (approvals.ts), and read back with the same decoders the live read uses. The API's
//   whole objects (`raw`) and the entries it could not read are left out: the screens do not need them, and copying by
//   name means nothing the API happened to carry beyond the decoded fields reaches the file. Nothing from the session is
//   ever passed in here: no token, no refresh token, no keychain value.
// - The file is named by a hash of the origin and the signed-in tenant, so each sign-in has its own and the name says
//   neither, and the desktop shell keeps only the one file of the one sign-in (src-tauri/src/shop_cache.rs). With several
//   shops (docs/several-shops.md), every shop's record in it is kept under that shop's id, with that shop's own read (for a
//   shop the person owns, its tasks with each member's runs and draft, its schedules, attention items, team and routines),
//   so a shop's asks and work are only ever read back as that shop's, and a shop that leaves is dropped the next time the
//   file is written. Writing the one file for all of them needs no change to the shell, which removes any other file when
//   it writes one.
// - A kept read is shown for 7 days from the moment it was read and never after. One that is damaged, from another
//   version of the app or dated ahead of this computer's clock is not believed: it reads as nothing kept. Half a shop
//   is never shown as the whole one, so a single bad entry ignores the whole file.
// - Nothing here raises. A disk that refuses is a cache that is empty, and a write that fails is a read that was not
//   kept; the app is no worse off than before it had a cache.
// - Calls to the disk run one at a time in the order they were made, and `clear` is final for any read that started
//   before it (`ticket`): a read of the shop that finishes after the person signed out leaves no file behind.
import { encodeRecord, encodeStanding } from "@manut/approval-core";
import { decodeApprovals, shownRecord, type ShopApproval } from "./approvals";
import { sha256Hex } from "./sha256";
import type { Attention, ShopAction, ShopAttempt, ShopDraft, ShopPart, ShopSchedule, ShopSnapshot, ShopTask, ShopTeam, ShopWork, TeamRoutine } from "./shop";

/** 5 since the tasks come from the task list (`GET /v1/tasks`), which carries only the entries of a task's log the screens
 *  read, so a task no longer keeps how many entries its log holds. A file of any earlier version reads as nothing kept: it
 *  is shown no more, never half read, and the next good read writes this version over it. 4 kept each shop the person
 *  owns with its own work (tasks with their runs and drafts, schedules, attention items, team and routines) under its id,
 *  and each action when it was approved and sent; 3 several shops' asks; 2 the signed-in tenant's own read; 1 no requests. */
export const CACHE_VERSION = 5;
/** A kept read is shown for this long after it was read. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A read dated this far ahead of the clock is not believed (a clock that is a little behind is only a clock). */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/** What a look at the saved file found: a read to show, one too old to show (and when it was read), or nothing usable
 *  (none kept, damaged, from another version, or dated in the future). */
export type CachedRead = { kind: "usable"; snapshot: ShopSnapshot } | { kind: "too_old"; at: number } | { kind: "none" };

const NONE: CachedRead = { kind: "none" };

/** The desktop shell's three file commands (src/runtime/http/shell.ts `shellCacheStore`), or a fake in the tests. */
export interface CacheStore {
  write(key: string, text: string): Promise<void>;
  read(key: string): Promise<string | null>;
  /** Removes whatever is kept. */
  clear(): Promise<void>;
}

// ---- the file ---------------------------------------------------------------------------------------------------------

/** A read as the text of the file, copied field by field (see the rules above). */
export function encodeSnapshot(s: ShopSnapshot): string {
  return JSON.stringify({
    v: CACHE_VERSION,
    snapshot: {
      // With several shops the viewed shop's own read is its record's, not kept twice.
      tasks: s.shops ? [] : s.tasks.map(taskOf),
      schedules: s.shops ? [] : s.schedules.map(scheduleOf),
      approvals: s.shops ? [] : s.approvals.map(approvalOf),
      attention: s.shops ? [] : s.attention.map(attentionOf),
      attentionOff: s.attentionOff,
      readAt: s.readAt,
      // each shop under its own id, with what waits there and, for a shop the person owns, its work
      ...(s.shops
        ? {
            shops: s.shops.map((p) => ({
              id: p.shop.id,
              name: p.shop.name,
              owner: p.shop.owner,
              role: p.shop.role,
              approvals: p.approvals.map(approvalOf),
              ...(p.work ? { work: workOf(p.work) } : {}),
            })),
            viewing: s.viewing ?? null,
          }
        : {}),
    },
  });
}

function taskOf(task: ShopTask) {
  return {
    id: task.id,
    title: task.title,
    objective: task.objective,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    actions: task.actions.map((a) => ({
      id: a.id,
      taskId: a.taskId,
      operationType: a.operationType,
      targetResourceId: a.targetResourceId,
      recipients: a.recipients,
      payload: a.payload,
      state: a.state,
      proposedAt: a.proposedAt,
      expiresAt: a.expiresAt,
      approvedAt: a.approvedAt,
      approvedBy: a.approvedBy,
      dispatchedAt: a.dispatchedAt,
    })),
    attempts: task.attempts.map((a) => ({
      id: a.id,
      executor: a.executor,
      status: a.status,
      outcome: a.outcome,
      reason: a.reason,
      claimedAt: a.claimedAt,
      finishedAt: a.finishedAt,
      deadline: a.deadline,
      leaseUntil: a.leaseUntil,
      handedTo: a.handedTo,
      costSatang: a.costSatang,
      tokens: a.tokens,
      model: a.model,
    })),
    draft: task.draft && { member: task.draft.member, job: task.draft.job, text: task.draft.text, at: task.draft.at },
  };
}

function scheduleOf(x: ShopSchedule) {
  return {
    id: x.id,
    name: x.name,
    prompt: x.prompt,
    hour: x.hour,
    minute: x.minute,
    weekdays: x.weekdays,
    timeZone: x.timeZone,
    enabled: x.enabled,
    revision: x.revision,
    nextFire: x.nextFire,
    createdAt: x.createdAt,
  };
}

const attentionOf = (x: Attention) => ({ id: x.id, connectionId: x.connectionId, eventType: x.eventType, issueId: x.issueId, receivedAt: x.receivedAt });

/** The fields of a routine's trigger `@manut/routine-rules` writes, each copied only when it is a plain value of its kind. */
const TRIGGER_FIELDS = ["kind", "at", "weekdays", "day", "from", "to", "threshold"] as const;

function triggerOf(v: unknown): Record<string, unknown> | null {
  if (!isObj(v)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of TRIGGER_FIELDS) {
    const value = v[key];
    if (typeof value === "string" || isNum(value) || (Array.isArray(value) && value.every(isNum))) kept[key] = value;
  }
  return kept;
}

function workOf(w: ShopWork) {
  return {
    tasks: w.tasks.map(taskOf),
    schedules: w.schedules.map(scheduleOf),
    attention: w.attention.map(attentionOf),
    team: { paused: w.team.paused, since: w.team.since, members: w.team.members },
    routines: w.routines.map((r) => ({
      id: r.id,
      name: r.name,
      action: r.action,
      member: r.member,
      when: r.when,
      timeZone: r.timeZone,
      asksFirst: r.asksFirst,
      paused: r.paused,
      next: r.next,
      trigger: triggerOf(r.trigger),
    })),
  };
}

/** A request as the file keeps it: approval-core's wire JSON, its detail cut to the card's words, with any note passed on. */
function approvalOf(a: ShopApproval) {
  return {
    taskId: a.taskId,
    record: encodeRecord(shownRecord(a.record)),
    standing: encodeStanding(a.standing),
    passedOn: a.passedOn && { by: a.passedOn.by, name: a.passedOn.name, note: a.passedOn.note, at: a.passedOn.at },
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const intOrNull = (v: unknown, lo: number, hi: number): v is number | null => v === null || intIn(v, lo, hi);

/** An action as the file keeps it, whole, or null. Every field must be there: a file of this version keeps them all. */
function readAction(v: unknown): ShopAction | null {
  if (!isObj(v)) return null;
  const { id, taskId, operationType, targetResourceId, recipients, payload, state, proposedAt, expiresAt, approvedAt, approvedBy, dispatchedAt } = v;
  if (!isId(id) || !isStr(taskId) || !isStr(operationType) || !isStr(targetResourceId) || !isStr(state)) return null;
  if (!Array.isArray(recipients) || !recipients.every(isStr) || !isObj(payload)) return null;
  if (!numOrNull(proposedAt) || !numOrNull(expiresAt)) return null;
  if (!numOrNull(approvedAt) || !isStr(approvedBy) || !numOrNull(dispatchedAt)) return null;
  return { id, taskId, operationType, targetResourceId, recipients, payload, state, proposedAt, expiresAt, approvedAt, approvedBy, dispatchedAt, raw: null };
}

function readAttempt(v: unknown): ShopAttempt | null {
  if (!isObj(v)) return null;
  const { id, executor, status, outcome, reason, claimedAt, finishedAt, deadline, leaseUntil, handedTo, costSatang, tokens, model } = v;
  if (!isId(id) || !isStr(executor) || !isStr(status) || !isStr(outcome) || !isStr(reason) || !isStr(model)) return null;
  if (!numOrNull(claimedAt) || !numOrNull(finishedAt) || !numOrNull(deadline) || !numOrNull(leaseUntil)) return null;
  if (!(handedTo === null || isId(handedTo)) || !intOrNull(costSatang, 0, Number.MAX_SAFE_INTEGER) || !intOrNull(tokens, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { id, executor, status, outcome, reason, claimedAt, finishedAt, deadline, leaseUntil, handedTo, costSatang, tokens, model };
}

function readDraft(v: unknown): ShopDraft | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !isStr(v.member) || !isStr(v.job) || !isStr(v.text) || !numOrNull(v.at)) return undefined;
  return { member: v.member, job: v.job, text: v.text, at: v.at };
}

function readTask(v: unknown): ShopTask | null {
  if (!isObj(v)) return null;
  const { id, title, objective, state, createdAt, updatedAt } = v;
  if (!isId(id) || !isStr(title) || !isStr(objective) || !isStr(state) || !numOrNull(createdAt) || !numOrNull(updatedAt)) return null;
  const actions = every(v.actions, readAction);
  const attempts = every(v.attempts, readAttempt);
  const draft = readDraft(v.draft);
  if (!actions || !attempts || draft === undefined) return null;
  return { id, title, objective, state, createdAt, updatedAt, actions, attempts, draft, raw: null };
}

function readSchedule(v: unknown): ShopSchedule | null {
  if (!isObj(v)) return null;
  const { id, name, prompt, hour, minute, weekdays, timeZone, enabled, revision, nextFire, createdAt } = v;
  if (!isId(id) || !isStr(name) || !isStr(prompt) || !isStr(timeZone) || typeof enabled !== "boolean") return null;
  if (!intOrNull(hour, 0, 23) || !intOrNull(minute, 0, 59) || !intOrNull(revision, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(weekdays) || !weekdays.every((d) => intIn(d, 1, 7)) || !numOrNull(nextFire) || !numOrNull(createdAt)) return null;
  return { id, name, prompt, hour, minute, weekdays, timeZone, enabled, revision, nextFire, createdAt, raw: null };
}

/** A kept request, read with the decoders the live read uses, but only when it is whole: approval-core's decoders read
 *  anything, so the fields a card and an answer rest on are checked first. */
function readApproval(v: unknown): ShopApproval | null {
  if (!isObj(v)) return null;
  const { taskId, record, standing, passedOn } = v;
  if (!isStr(taskId) || !isObj(record) || !isStr(record.status) || !isObj(standing) || !isStr(standing.state)) return null;
  const request = record.request;
  if (!isObj(request) || !isId(request.id) || !intIn(request.revision, 1, Number.MAX_SAFE_INTEGER) || !isNum(request.createdAt) || !Array.isArray(request.options)) return null;
  if (passedOn !== null && !(isObj(passedOn) && isStr(passedOn.by) && isStr(passedOn.name) && isStr(passedOn.note) && numOrNull(passedOn.at))) return null;
  const unreadable: unknown[] = [];
  const [read] = decodeApprovals({ approvals: [v] }, unreadable);
  return read && !unreadable.length ? { ...read, raw: null } : null;
}

function readAttention(v: unknown): Attention | null {
  if (!isObj(v)) return null;
  const { id, connectionId, eventType, issueId, receivedAt } = v;
  if (!isId(id) || !isStr(connectionId) || !isStr(eventType) || !isStr(issueId) || !numOrNull(receivedAt)) return null;
  return { id, connectionId, eventType, issueId, receivedAt, raw: null };
}

function readTeam(v: unknown): ShopTeam | null {
  if (!isObj(v) || typeof v.paused !== "boolean" || !numOrNull(v.since) || !Array.isArray(v.members) || !v.members.every(isId)) return null;
  return { paused: v.paused, since: v.since, members: v.members };
}

function readRoutine(v: unknown): TeamRoutine | null {
  if (!isObj(v)) return null;
  const { id, name, action, member, when, timeZone, asksFirst, paused, next, trigger } = v;
  if (!isId(id) || !isStr(name) || !isStr(action) || !isStr(member) || !isStr(when) || !isStr(timeZone)) return null;
  if (!(asksFirst === null || typeof asksFirst === "boolean") || typeof paused !== "boolean" || !numOrNull(next) || !(trigger === null || isObj(trigger))) return null;
  return { id, name, action, member, when, timeZone, asksFirst, paused, next, trigger };
}

/** A shop's work, whole, or null when any part of it is not. */
function readWork(v: unknown): ShopWork | null {
  if (!isObj(v)) return null;
  const tasks = every(v.tasks, readTask);
  const schedules = every(v.schedules, readSchedule);
  const attention = every(v.attention, readAttention);
  const team = readTeam(v.team);
  const routines = every(v.routines, readRoutine);
  return tasks && schedules && attention && team && routines ? { tasks, schedules, attention, team, routines } : null;
}

/** One shop of the file, whole: its id, name, owner, the person's role there, its requests, and for a shop the person
 *  owns, its work. Only a shop they own has work, as only an owner's session reads it. */
function readPart(v: unknown): ShopPart | null {
  if (!isObj(v)) return null;
  const { id, name, owner, role, approvals } = v;
  if (!isId(id) || !isStr(name) || !isStr(owner) || (role !== "owner" && role !== "helper")) return null;
  const read = every(approvals, readApproval);
  if (!read) return null;
  if (v.work === undefined) return { shop: { id, name, owner, role }, approvals: read };
  const work = role === "owner" ? readWork(v.work) : null;
  return work ? { shop: { id, name, owner, role }, approvals: read, work } : null;
}

/** `list` read entry by entry, or null when it is not a list or any entry is not one. */
function every<T>(list: unknown, read: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  const out = list.map(read);
  return out.some((x) => x === null) ? null : (out as T[]);
}

/** The saved file as a read of the shop, at the clock `now`. */
export function decodeCached(text: string | null, now: number): CachedRead {
  if (!text) return NONE;
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return NONE;
  }
  // A file of another version, an earlier one above all, is not read: what it kept is not what this build shows.
  if (!isObj(file) || file.v !== CACHE_VERSION || !isObj(file.snapshot)) return NONE;
  const s = file.snapshot;
  const tasks = every(s.tasks, readTask);
  const approvals = every(s.approvals, readApproval);
  const schedules = every(s.schedules, readSchedule);
  const attention = every(s.attention, readAttention);
  if (!tasks || !approvals || !schedules || !attention || typeof s.attentionOff !== "boolean" || !isNum(s.readAt)) return NONE;
  // Several shops, each under its id; a file written while the person was in no shop has none.
  const several = s.shops !== undefined;
  const shops = several ? every(s.shops, readPart) : null;
  if (several && (!shops || new Set(shops.map((p) => p.shop.id)).size !== shops.length)) return NONE;
  const readAt = s.readAt;
  if (readAt > now + CLOCK_SLACK_MS) return NONE;
  if (now - readAt > CACHE_MAX_AGE_MS) return { kind: "too_old", at: readAt };
  const snapshot: ShopSnapshot = { tasks, approvals, schedules, attention, attentionOff: s.attentionOff, unreadable: [], readAt };
  if (!shops) return { kind: "usable", snapshot };
  // The viewed shop is the one the file names while it holds it, else the first; its asks and its work are its own
  // record's, as the host shows a viewed shop (host.ts `atShops`).
  const viewed = shops.find((p) => p.shop.id === s.viewing) ?? shops[0];
  const work = viewed?.work;
  return {
    kind: "usable",
    snapshot: {
      ...snapshot,
      tasks: work?.tasks ?? [],
      schedules: work?.schedules ?? [],
      attention: work?.attention ?? [],
      attentionOff: !work,
      approvals: viewed ? viewed.approvals : [],
      shops,
      ...(viewed ? { viewing: viewed.shop.id } : {}),
      ...(work ? { team: work.team, routines: work.routines } : {}),
    },
  };
}

// ---- the name ---------------------------------------------------------------------------------------------------------

/** The file's name for a shop: the SHA-256 of its origin and tenant, in hex. The two are hashed as a list, so a part of
 *  one can never read as a part of the other. The shell accepts nothing but 64 hex digits as a name. */
export function cacheKey(origin: string, tenant: string): string {
  return sha256Hex(JSON.stringify([origin, tenant]));
}

// ---- the saved file ---------------------------------------------------------------------------------------------------

export class ShopCache {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: CacheStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Taken when a read of the shop starts and handed to `keep` when it ends: a `clear` in between makes `keep` do
   *  nothing, so a read that finished after the person signed out cannot bring the file back. */
  ticket(): number {
    return this.epoch;
  }

  /** Keeps `snapshot` as the shop's last good read, unless the cache was cleared since `ticket` was taken. */
  keep(origin: string, tenant: string, snapshot: ShopSnapshot, ticket: number): Promise<void> {
    return this.enqueue(async () => {
      if (ticket !== this.epoch) return;
      await this.store.write(cacheKey(origin, tenant), encodeSnapshot(snapshot));
    }, undefined);
  }

  /** The shop's kept read, if one is kept for this origin and tenant and is neither damaged nor too old to show. */
  load(origin: string, tenant: string): Promise<CachedRead> {
    return this.enqueue(async () => decodeCached(await this.store.read(cacheKey(origin, tenant)), this.now()), NONE);
  }

  /** Forgets whatever is kept. Final for every read that started before it: the epoch moves at once, not when the
   *  removal gets its turn, so a write still waiting behind another call is dropped. */
  clear(): Promise<void> {
    this.epoch += 1;
    return this.enqueue(() => this.store.clear(), undefined);
  }

  /** One call at a time, in order. A call that fails is `fallback`, and never stops the ones behind it. */
  private enqueue<T>(job: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.tail.then(job).catch(() => fallback);
    this.tail = run;
    return run;
  }
}
