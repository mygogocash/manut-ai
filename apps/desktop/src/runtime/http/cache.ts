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
// - The file is sealed (seal.ts): AES-GCM under a 256-bit key that only the keychain holds (src-tauri/src/shop_cache_key.rs),
//   made the first time a read is kept, with this version, the origin and the tenant bound in. Without that key the file
//   says nothing of the shop, and the key is deleted with the file whenever the read is forgotten, so a copy of the file
//   that outlived it can never be opened. On a computer with no keychain nothing is kept at all, rather than kept plain.
// - The file is named by a hash of the origin and the signed-in tenant, so each sign-in has its own and the name says
//   neither, and the desktop shell keeps only the one file of the one sign-in (src-tauri/src/shop_cache.rs). With several
//   shops (docs/several-shops.md), every shop's record in it is kept under that shop's id, with that shop's own read (for a
//   shop the person owns, its tasks with each member's runs and draft, its schedules, attention items, team and routines),
//   so a shop's asks and work are only ever read back as that shop's, and a shop that leaves is dropped the next time the
//   file is written. Writing the one file for all of them needs no change to the shell, which removes any other file when
//   it writes one.
// - A kept read is shown for 7 days from the moment it was read and never after. One that is damaged, from another
//   version of the app or dated ahead of this computer's clock is not believed: it reads as nothing kept. A file that
//   does not open (changed, cut short, of another version, sealed with another key or for another shop) is deleted as
//   well, and with no key in the keychain whatever is on disk is deleted without being read, so an earlier version's
//   plain file goes the first time the app looks. Half a shop is never shown as the whole one, so a single bad entry
//   ignores the whole file.
// - Nothing here raises. A disk that refuses is a cache that is empty, and a write that fails is a read that was not
//   kept; the app is no worse off than before it had a cache.
// - Calls to the disk run one at a time in the order they were made, and `clear` is final for any read that started
//   before it (`ticket`): a read of the shop that finishes after the person signed out leaves no file behind.
import { encodeRecord, encodeStanding } from "@manut/approval-core";
import { decodeApprovals, shownRecord, type ShopApproval } from "./approvals";
import { importSealKey, open, seal } from "./seal";
import { sha256Hex } from "./sha256";
import type { Attention, ShopAction, ShopAttempt, ShopDraft, ShopPart, ShopSchedule, ShopSnapshot, ShopTask, ShopTeam, ShopWork, TeamRoutine } from "./shop";
import { isObj } from "../../lib/guards";

/** 6 since the file is sealed (seal.ts); what it keeps is 5's. A file of any earlier version, which kept the read in
 *  plain text, is deleted unread, never shown, and the next good read writes this version in its place. 5 came from the
 *  task list (`GET /v1/tasks`), which carries only the entries of a task's log the screens read, so a task no longer kept
 *  how many entries its log holds; 4 kept each shop the person owns with its own work (tasks with their runs and drafts,
 *  schedules, attention items, team and routines) under its id, and each action when it was approved and sent; 3 several
 *  shops' asks; 2 the signed-in tenant's own read; 1 no requests. */
export const CACHE_VERSION = 6;
/** A kept read is shown for this long after it was read. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A read dated this far ahead of the clock is not believed (a clock that is a little behind is only a clock). */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/** What a look at the saved file found: a read to show, one too old to show (and when it was read), nothing usable (none
 *  kept, damaged, not opened, from another version, or dated in the future), or nothing because this computer has no
 *  keychain to keep the key in, so no copy is ever kept (`unkept`). */
export type CachedRead = { kind: "usable"; snapshot: ShopSnapshot } | { kind: "too_old"; at: number } | { kind: "none" } | { kind: "unkept" };

const NONE: CachedRead = { kind: "none" };
const UNKEPT: CachedRead = { kind: "unkept" };

/** The desktop shell's three file commands and two for the key the file is sealed with (src/runtime/http/shell.ts
 *  `shellCacheStore`), or a fake in the tests. */
export interface CacheStore {
  write(key: string, text: string): Promise<void>;
  read(key: string): Promise<string | null>;
  /** Removes whatever is kept. */
  clear(): Promise<void>;
  /** The key the file is sealed with, as 64 lowercase hex digits from the keychain: made and kept first when `make` is
   *  set and none is held, else null when none is held. Raises `NoKeychain` on a computer with no keychain, and any other
   *  error when the keychain refused. */
  sealKey(make: boolean): Promise<string | null>;
  /** Deletes the key from the keychain. */
  dropSealKey(): Promise<void>;
}

/** This computer has no keychain to keep the key in (anything but macOS today), so no copy of the shop is kept. */
export class NoKeychain extends Error {
  constructor() {
    super("no keychain");
    this.name = "NoKeychain";
  }
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

// ---- the seal ---------------------------------------------------------------------------------------------------------

/** `text` (encodeSnapshot's) sealed as the file holds it for this version, `origin` and `tenant`. */
export const sealFile = (text: string, key: CryptoKey, origin: string, tenant: string): Promise<string> => seal(text, key, CACHE_VERSION, origin, tenant);

/** What a file holds when it opens with `key` as this version's file for `origin` and `tenant`; else null. */
export const openFile = (text: string, key: CryptoKey, origin: string, tenant: string): Promise<string | null> => open(text, key, CACHE_VERSION, origin, tenant);

// ---- the saved file ---------------------------------------------------------------------------------------------------

export class ShopCache {
  private epoch = 0;
  private tail: Promise<unknown> = Promise.resolve();
  /** The key the file is sealed with, once the keychain gave it, as Web Crypto holds it: script can use it but never read
   *  it back. It is set and dropped only inside a call to the disk, and those run one at a time, so a `clear` that deleted
   *  the key from the keychain has dropped it here too before any later call runs. */
  private sealing: CryptoKey | null = null;

  constructor(
    private readonly store: CacheStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Taken when a read of the shop starts and handed to `keep` when it ends: a `clear` in between makes `keep` do
   *  nothing, so a read that finished after the person signed out cannot bring the file back. */
  ticket(): number {
    return this.epoch;
  }

  /** Keeps `snapshot` as the shop's last good read, sealed, unless the cache was cleared since `ticket` was taken. When
   *  the keychain refuses the key nothing is kept this time; on a computer with no keychain nothing is ever kept, and a
   *  file found there is deleted rather than left as it is. */
  keep(origin: string, tenant: string, snapshot: ShopSnapshot, ticket: number): Promise<void> {
    return this.enqueue(async () => {
      if (ticket !== this.epoch) return;
      const key = await this.key(true);
      if (key === "unkept") return this.store.clear();
      if (!key) return;
      await this.store.write(cacheKey(origin, tenant), await sealFile(encodeSnapshot(snapshot), key, origin, tenant));
    }, undefined);
  }

  /** The shop's kept read, if one is kept for this origin and tenant, opens, and is neither damaged nor too old to show. */
  load(origin: string, tenant: string): Promise<CachedRead> {
    return this.enqueue(async () => {
      const key = await this.key(false);
      if (key === "unkept") {
        await this.store.clear().catch(() => undefined);
        return UNKEPT;
      }
      // With no key nothing on disk can be opened, so whatever is there goes without being read: above all a file an
      // earlier version kept in plain text, the first time this version looks.
      if (!key) {
        await this.store.clear();
        return NONE;
      }
      const text = await this.store.read(cacheKey(origin, tenant));
      if (text === null) return NONE;
      const plain = await openFile(text, key, origin, tenant);
      // A file that does not open (changed, cut short, of another version, sealed with another key or for another shop)
      // is not believed, as a damaged file never was, and goes.
      if (plain === null) {
        await this.store.clear();
        return NONE;
      }
      return decodeCached(plain, this.now());
    }, NONE);
  }

  /** Forgets whatever is kept, and the key it was sealed with. Final for every read that started before it: the epoch
   *  moves at once, not when the removal gets its turn, so a write still waiting behind another call is dropped. */
  clear(): Promise<void> {
    this.epoch += 1;
    return this.enqueue(async () => {
      this.sealing = null;
      // The key goes with the file, even when the disk refuses the removal, so a copy of the file that outlived it (a
      // backup, a sync folder, a removal that failed) can never be opened. The next read kept makes a new key.
      try {
        await this.store.clear();
      } finally {
        await this.store.dropSealKey();
      }
    }, undefined);
  }

  /** The key the file is sealed with: the one this run already has, else the keychain's, made first when `make` is set
   *  and it holds none. Null when it holds none, and `unkept` on a computer with no keychain. A keychain that refused,
   *  or an answer that is not a key, raises, so the call that asked keeps or deletes nothing. */
  private async key(make: boolean): Promise<CryptoKey | null | "unkept"> {
    if (this.sealing) return this.sealing;
    let hex: string | null;
    try {
      hex = await this.store.sealKey(make);
    } catch (e) {
      if (e instanceof NoKeychain) return "unkept";
      throw e;
    }
    // Only the shell's null says none is held; any other answer that is not a key is a failure, so no file goes for it.
    if (hex === null) return null;
    const key = await importSealKey(hex);
    if (!key) throw new Error("not a key");
    this.sealing = key;
    return key;
  }

  /** One call at a time, in order. A call that fails is `fallback`, and never stops the ones behind it. */
  private enqueue<T>(job: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.tail.then(job).catch(() => fallback);
    this.tail = run;
    return run;
  }
}
