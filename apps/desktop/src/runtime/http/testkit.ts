// Fakes for the connected runtime's tests: an API that answers by method and path and records every request, a
// keychain that keeps one value in memory, and the disk that keeps the last good read with the key it is sealed with.
// They stand where the desktop shell's `api_request`, `api_session_*` and `shop_cache_*` commands stand in the app
// (shell.ts), so the tests run without a shell or a network.
import { createCipheriv, createDecipheriv, webcrypto } from "node:crypto";
import { decodeDecision, decodeRecord, encodeRecord, encodeStanding } from "@manut/approval-core";
import { createRoutine, describeTrigger, nextRun, type ActionKind, type Trigger } from "@manut/routine-rules";
import { confirm as confirmFact, correct as correctFact, emptyState, forget as forgetFact, propose, remember as rememberFact, type FactSource, type MemoryState, type Result } from "@manut/shop-memory";
import { vi } from "vitest";
import { cacheKey, encodeSnapshot, NoKeychain, openFile, sealFile, type CacheStore } from "./cache";
import { TICKET_PROTOCOL, type FeedSocket } from "./feed";
import { importSealKey } from "./seal";
import { ApiSession } from "./session";
import type { FetchLike, SessionVault } from "./shell";
import { LinkDown, VaultUnavailable } from "./shell";
import { readShop } from "./shop";

export const ORIGIN = "https://dev.manut.xyz";

/** Every op that writes. Each answers `offline` while only a kept read is shown (an ask: "Connect to answer this"); while
 *  connected, `approval.respond` answers through the decide route and every other one answers `not_yet`. */
export const WRITE_OPS = [
  "chat.send",
  "chat.steer",
  "chat.interrupt",
  "approval.respond",
  "clarify.respond",
  "chat.set_model",
  "chat.attach",
  "folder.open",
  "folder.close",
  "folder.resume",
  "thread.create",
  "thread.remove",
  "bots.rename",
  "bots.set_avatar",
  "bots.restart",
  "automations.add",
  "automations.pause",
  "automations.resume",
  "automations.remove",
  "plugins.inspect",
  "plugins.install",
  "plugins.toggle",
  "plugins.update",
  "plugins.reload",
  "plugins.remove",
  "peers.probe",
  "peers.attach",
  "peers.detach",
  "accounts.add",
  "accounts.set_active",
  "accounts.remove",
  "accounts.label",
  "accounts.discard",
  "team.pause",
  "team.resume",
  "memory.remember",
  "memory.confirm",
  "memory.correct",
  "memory.forget",
  "routine.create",
  "routine.pause",
  "routine.resume",
  "routine.remove",
] as const;


export interface Recorded {
  method: string;
  url: string;
  /** the path without the query */
  path: string;
  bearer: string | null;
  body: unknown;
}

/** One answer: a status with a JSON body (or raw text), or no answer at all. */
export type FakeAnswer = { status: number; json?: unknown; text?: string } | "offline" | "failed";

export interface FakeApi {
  fetch: FetchLike;
  calls: Recorded[];
  /** Answers `method path` with these, one per request, the last one again for every later request. */
  on(method: string, path: string, ...answers: (FakeAnswer | ((req: Recorded) => FakeAnswer))[]): FakeApi;
  /** The requests made to `method path`. */
  to(method: string, path: string): Recorded[];
}

export function fakeApi(): FakeApi {
  const calls: Recorded[] = [];
  const routes = new Map<string, (FakeAnswer | ((req: Recorded) => FakeAnswer))[]>();
  const api: FakeApi = {
    calls,
    on(method, path, ...answers) {
      routes.set(`${method} ${path}`, answers);
      return api;
    },
    to: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    fetch: async (url, init) => {
      const u = new URL(url);
      const auth = init.headers.authorization ?? init.headers.Authorization;
      const req: Recorded = {
        method: init.method,
        url,
        path: u.pathname,
        bearer: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(req);
      const queue = routes.get(`${req.method} ${req.path}`);
      if (!queue?.length) return { status: 404, text: async () => JSON.stringify({ error: "not_found" }) };
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      const answer = typeof next === "function" ? next(req) : next;
      if (answer === "offline" || answer === "failed") throw new LinkDown(answer);
      const body = answer.text ?? JSON.stringify(answer.json ?? {});
      return { status: answer.status, text: async () => body };
    },
  };
  return api;
}

/** What `/v1/auth/exchange` and `/v1/auth/refresh` answer, numbered so a test can tell one pair from the next. */
export function tokens(n: number, tenant = "apple:owner-1") {
  return { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, csrf: `csrf-${n}`, expiresIn: 3600, tenant };
}

/** A keychain item in memory. `refuse` makes the next calls fail as a locked keychain would; `missing` makes it a
 *  shell with no keychain. */
export function memoryVault(value: string | null = null): SessionVault & { value: string | null; refuse: boolean; missing: boolean } {
  const vault = {
    value,
    refuse: false,
    missing: false,
    check() {
      if (vault.missing) throw new VaultUnavailable();
      if (vault.refuse) throw new Error("keychain");
    },
    async read() {
      vault.check();
      return vault.value;
    },
    async write(v: string) {
      vault.check();
      vault.value = v;
    },
    async clear() {
      vault.check();
      vault.value = null;
    },
  };
  return vault;
}

/** 32 bytes as the shell gives a key: 64 lowercase hex digits. */
export const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A key the shell would give, made at run time: random, never written in a test. */
export const newSealKey = () => hexOf(crypto.getRandomValues(new Uint8Array(32)));

/** The key the tests' keychain holds unless a test gives another: made once per test file, when it runs. */
export const TEST_SEAL_KEY = newSealKey();

/** `plain` (encodeSnapshot's) sealed as the page writes it to disk for `origin` and `tenant`, with `key`. */
export async function sealedFile(plain: string, origin = ORIGIN, tenant = "apple:owner-1", key = TEST_SEAL_KEY): Promise<string> {
  return sealFile(plain, (await importSealKey(key))!, origin, tenant);
}

/** What a file the page wrote holds, opened with `key` for `origin` and `tenant`. Throws when it does not open. */
export async function openedFile(text: string, origin = ORIGIN, tenant = "apple:owner-1", key = TEST_SEAL_KEY): Promise<string> {
  const plain = await openFile(text, (await importSealKey(key))!, origin, tenant);
  if (plain === null) throw new Error("the file does not open with that key for that shop");
  return plain;
}

/** What every file `store` keeps holds, opened with the key its keychain holds now, for `origin` and `tenant`: what a
 *  test looks through for words that must never be kept. */
export async function keptPlain(store: { files: Map<string, string>; key: string | null }, origin = ORIGIN, tenant = "apple:owner-1"): Promise<string[]> {
  if (!store.files.size) return [];
  if (!store.key) throw new Error("files kept with no key to open them");
  return Promise.all([...store.files.values()].map((text) => openedFile(text, origin, tenant, store.key!)));
}

/** Web Crypto as the page uses it to seal the kept read, AES-GCM, done by Node's own cipher and answered at once, for
 *  the tests that move a fake clock by hand. Node's Web Crypto finishes AES-GCM on its thread pool, which a fake clock
 *  never waits for, so a read kept or looked at during a tick would land after the test looked. Every other call is
 *  Node's Web Crypto. seal.test.ts checks that it seals and opens byte for byte as Web Crypto does; seal.test.ts and
 *  cache.test.ts themselves use the real one. */
export function microtaskCrypto(): Crypto {
  const real = webcrypto as unknown as Crypto;
  const keys = new WeakMap<object, Buffer>();
  const bytes = (b: BufferSource) => (ArrayBuffer.isView(b) ? Buffer.from(b.buffer, b.byteOffset, b.byteLength) : Buffer.from(b as ArrayBuffer));
  const owned = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const keyOf = (key: CryptoKey) => {
    const raw = keys.get(key);
    if (!raw) throw new DOMException("not a key of this stand-in", "InvalidAccessError");
    return raw;
  };
  const aesGcm = (alg: unknown) => {
    const a = alg as AesGcmParams;
    if (a.name !== "AES-GCM" || (a.tagLength ?? 128) !== 128) throw new DOMException("only AES-GCM with a 128-bit tag", "NotSupportedError");
    return a;
  };
  const subtle = {
    async importKey(format: string, data: BufferSource, alg: AlgorithmIdentifier, extractable: boolean, usages: KeyUsage[]) {
      if (format !== "raw" || (alg as Algorithm).name !== "AES-GCM") throw new DOMException("only a raw AES-GCM key", "NotSupportedError");
      const raw = Buffer.from(bytes(data));
      if (raw.length !== 32) throw new DOMException("not a 256-bit key", "DataError");
      const key = { type: "secret", extractable, algorithm: { name: "AES-GCM", length: 256 }, usages: [...usages] };
      keys.set(key, raw);
      return key as unknown as CryptoKey;
    },
    async encrypt(alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) {
      const a = aesGcm(alg);
      const cipher = createCipheriv("aes-256-gcm", keyOf(key), bytes(a.iv), { authTagLength: 16 });
      if (a.additionalData) cipher.setAAD(bytes(a.additionalData));
      return owned(Buffer.concat([cipher.update(bytes(data)), cipher.final(), cipher.getAuthTag()]));
    },
    async decrypt(alg: AlgorithmIdentifier, key: CryptoKey, data: BufferSource) {
      const a = aesGcm(alg);
      const sealed = bytes(data);
      if (sealed.length < 16) throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
      const decipher = createDecipheriv("aes-256-gcm", keyOf(key), bytes(a.iv), { authTagLength: 16 });
      if (a.additionalData) decipher.setAAD(bytes(a.additionalData));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      try {
        return owned(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]));
      } catch {
        // what Web Crypto raises when GCM's check fails
        throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
      }
    },
  };
  return {
    getRandomValues: real.getRandomValues.bind(real),
    randomUUID: real.randomUUID.bind(real),
    subtle: subtle as unknown as SubtleCrypto,
  } as Crypto;
}

/** One stand-in for a whole test file, so a key one test imported (a `ShopCache` the page keeps for its life holds its
 *  key) still works in the next. */
const MICROTASK_CRYPTO = microtaskCrypto();

/** Puts `microtaskCrypto` where the page's code finds Web Crypto, for a test file whose tests move a fake clock by hand;
 *  `vi.unstubAllGlobals` takes it away. */
export function useMicrotaskCrypto(): void {
  vi.stubGlobal("crypto", MICROTASK_CRYPTO);
}

/** The shell's saved-read commands in memory, with a log of the calls, and the keychain's key the read is sealed with
 *  (`key`, the tests' own unless given; null when the keychain holds none). Like the shell's, it keeps the one read of
 *  the one signed-in shop: a write replaces whatever was kept. `refuse` makes every call to the disk fail, as a full or
 *  unreadable disk would; `lockedKeychain` makes the key's calls fail, as a locked keychain or a denied prompt would;
 *  `noKeychain` makes them answer as on a computer with no keychain. The key's calls are logged apart (`keyCalls`), so
 *  the order of the disk's own reads as before. */
export function memoryCacheStore(
  files: Record<string, string> = {},
  key: string | null = TEST_SEAL_KEY,
): CacheStore & { files: Map<string, string>; calls: string[]; refuse: boolean; key: string | null; keyCalls: string[]; lockedKeychain: boolean; noKeychain: boolean } {
  const store = {
    files: new Map(Object.entries(files)),
    calls: [] as string[],
    refuse: false,
    key,
    keyCalls: [] as string[],
    lockedKeychain: false,
    noKeychain: false,
    async sealKey(make: boolean) {
      store.keyCalls.push(make ? "make" : "look");
      if (store.noKeychain) throw new NoKeychain();
      if (store.lockedKeychain) throw new Error("keychain");
      if (store.key === null && make) store.key = newSealKey();
      return store.key;
    },
    async dropSealKey() {
      store.keyCalls.push("drop");
      if (store.noKeychain) throw new NoKeychain();
      if (store.lockedKeychain) throw new Error("keychain");
      store.key = null;
    },
    async write(key: string, text: string) {
      store.calls.push("write");
      if (store.refuse) throw new Error("disk");
      store.files.clear();
      store.files.set(key, text);
    },
    async read(key: string) {
      store.calls.push("read");
      if (store.refuse) throw new Error("disk");
      return store.files.get(key) ?? null;
    },
    async clear() {
      store.calls.push("clear");
      if (store.refuse) throw new Error("disk");
      store.files.clear();
    },
  };
  return store;
}

// ---- what the API answers, in the shapes apps/api writes (task-object.ts, schedule-object.ts, inbound.ts) ----------

export const T0 = Date.UTC(2026, 10, 23, 1, 0, 0);
export const iso = (ms: number) => new Date(ms).toISOString();

/** One action proposal: a LINE reply waiting for the owner. */
export function actionJson(over: Record<string, unknown> = {}) {
  return {
    id: "action-1",
    tenant: "apple:owner-1",
    connectionId: "conn-1",
    providerAccountId: "channel-1",
    operationType: "line.message.push",
    targetResourceId: "bot-user-1",
    resourceScope: ["bot-user-1"],
    payload: { text: "Your order ships tomorrow morning." },
    payloadHash: "hash",
    recipients: ["U-customer"],
    grantRevision: 0,
    proposedAt: iso(T0 + 90_000),
    expiresAt: iso(T0 + 24 * 3600_000),
    state: "proposed",
    ...over,
  };
}

/** One task as the shop's records hold it, in the shape of an entry of `GET /v1/tenant/export`'s `tasks`: the document,
 *  its event log, its actions and attempts. The task list carries what `listedJson` keeps of it. */
export function taskJson(over: { task?: Record<string, unknown>; actions?: Record<string, unknown>[]; [k: string]: unknown } = {}) {
  const { task, actions, ...rest } = over as { task?: Record<string, unknown>; actions?: Record<string, unknown>[]; [k: string]: unknown };
  return {
    task: {
      id: "task-1",
      title: "Reply to Khun Mali",
      objective: "Answer her question about delivery",
      state: "waitingForAuthorization",
      location: "cloud",
      funding: "managedAI",
      criteria: [],
      updatedAt: iso(T0 + 120_000),
      tenantId: "apple:owner-1",
      schema: 1,
      rev: 3,
      ...task,
    },
    events: [
      { seq: 1, kind: "created", at: iso(T0), rev: 1, via: "put" },
      { seq: 2, kind: "state", at: iso(T0 + 60_000), from: "queued", to: "running", rev: 2 },
    ],
    eventFloor: 0,
    actions: actions ?? [actionJson()],
    attempts: [],
    attemptsTruncated: false,
    ...rest,
  };
}

export function scheduleJson(over: Record<string, unknown> = {}) {
  return {
    id: "sched-1",
    tenant: "apple:owner-1",
    roleId: "buddy",
    name: "Morning brief",
    prompt: "Tell me what came in overnight",
    hour: 8,
    minute: 30,
    weekdays: [2, 3, 4, 5, 6],
    timeZone: "Asia/Bangkok",
    funding: "managedAI",
    enabled: true,
    hasSchedulingConsent: true,
    revision: 2,
    nextFire: T0 + 3600_000,
    createdAt: iso(T0 - 86_400_000),
    ...over,
  };
}

export function attentionJson(over: Record<string, unknown> = {}) {
  return { id: "att-1", connectionId: "conn-2", eventType: "linear.issue.update", issueId: "issue-9", receivedAt: iso(T0 + 30_000), ...over };
}

/** The keychain's session for ORIGIN, signed in at `now`. */
export function storedSession(now: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    origin: ORIGIN,
    tenant: "apple:owner-1",
    deviceId: "device-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessExpiresAt: now + 3600_000,
    signedInAt: now,
    ...over,
  });
}

/** What every request the API opens offers: approve or decline the exact action (`JOB_REQUEST_OPTIONS` in task-object.ts). */
export const OPTIONS = [
  { id: "approve", label: "Approve", effect: "approve" },
  { id: "decline", label: "Decline", effect: "decline" },
];

/** What a LINE reply's request names (`replyRequest` in task-object.ts, `ReplyDetail` in docs/pilot-api.md). */
export function replyDetail(id = "action-1", text = "Your order ships tomorrow morning.") {
  return { actionId: id, operationType: "line.message.push", targetResourceId: "bot-user-1", recipient: "U-customer", text, payloadHash: "hash" };
}

export interface ApprovalOver {
  id?: string;
  taskId?: string;
  kind?: string;
  revision?: number;
  status?: string;
  options?: unknown[];
  detail?: unknown;
  createdAt?: number;
  expiresAt?: number;
  attemptId?: string;
  decision?: Record<string, unknown>;
  standing?: Record<string, unknown>;
  passedOn?: Record<string, unknown>;
}

/** One entry of `GET /v1/approvals`: a request and where it stands, as approval-core's wire JSON, encoded the way the API
 *  encodes it (`encodeRecord(decodeRecord(record))` in approvals.ts). By default a LINE reply waiting for the owner. */
export function approvalJson(over: ApprovalOver = {}) {
  const id = over.id ?? "action-1";
  const request = {
    id,
    kind: over.kind ?? "reply",
    options: over.options ?? OPTIONS,
    revision: over.revision ?? 1,
    createdAt: over.createdAt ?? T0 + 90_000,
    expiresAt: over.expiresAt ?? T0 + 24 * 3600_000,
    ...(over.attemptId ? { attemptId: over.attemptId } : {}),
    detail: over.detail ?? replyDetail(id),
  };
  return {
    taskId: over.taskId ?? "task-1",
    record: encodeRecord(decodeRecord({ status: over.status ?? "pending", request, ...(over.decision ? { decision: over.decision } : {}) })),
    standing: over.standing ?? encodeStanding({ state: "open", reason: "waiting" }),
    ...(over.passedOn ? { passedOn: over.passedOn } : {}),
  };
}

/** How a request stopped waiting: decided, taken back, run out of time, or ended with the work that asked it (approval-core's standing). */
export type Settled = "decided" | "withdrawn" | "expired" | "attempt_ended" | "turn_ended" | "not_found";

/** One entry of `GET /v1/approvals?state=recent`: a request that stopped waiting, as the API lists it (approvals.ts `listApprovals`), the
 *  record and the standing approval-core gives it. `decided` is by the owner's own session, approving, unless `by`, `role`, `option` and `at`
 *  say otherwise; `withdrawn` and `expired` carry their time in `at`. */
export function settledJson(how: Settled, over: ApprovalOver & { by?: string; role?: string; option?: string; at?: number } = {}) {
  const { by, role, option, at, ...entry } = over;
  const id = entry.id ?? "action-1";
  if (how === "decided") {
    const decision = { requestId: id, optionId: option ?? "approve", seenRevision: entry.revision ?? 1, decidedBy: by ?? "owner-session", role: role ?? "owner", decidedAt: at ?? T0 + 300_000 };
    return approvalJson({ ...entry, status: "decided", decision, standing: encodeStanding({ state: "decided", reason: "decided", decision: decodeDecision(decision) }) });
  }
  if (how === "withdrawn") return approvalJson({ ...entry, status: "withdrawn", standing: { state: "superseded", reason: "withdrawn" } });
  if (how === "expired") return approvalJson({ ...entry, standing: encodeStanding({ state: "expired", reason: "expired", expiredAt: at ?? T0 + 24 * 3600_000 }) });
  return approvalJson({ ...entry, standing: { state: "superseded", reason: how } });
}

/** The open requests the API lists for these tasks' LINE replies: one per reply still proposed and not past its
 *  expiry, as the task object opens a request with every reply and lists one stored before that as the request it would
 *  have opened (docs/pilot-api.md, "Approvals for a session"). */
function openReplies(tasks: unknown[], now: number) {
  return tasks.flatMap((entry) => {
    const { task, actions } = entry as { task: { id: string }; actions?: Record<string, unknown>[] };
    return (actions ?? [])
      .filter((a) => a.operationType === "line.message.push" && a.state === "proposed" && Date.parse(String(a.expiresAt)) > now)
      .map((a) =>
        approvalJson({
          id: String(a.id),
          taskId: task.id,
          createdAt: Date.parse(String(a.proposedAt)),
          expiresAt: Date.parse(String(a.expiresAt)),
          detail: replyDetail(String(a.id), String((a.payload as { text?: unknown }).text)),
        }),
      );
  });
}

/** What the task list carries of one task (`taskJson`'s shape), as apps/api's task object builds it (task-listing.ts): its
 *  document and its actions whole, its runs without their steps, fencing tokens and revisions, the first 200 of them as
 *  the export keeps them, its newest draft, and from its log only the entries the lists read: the one that made it, each
 *  run's claim, and each handoff note and spend report a run made. */
export function listedJson(entry: unknown): Record<string, unknown> {
  const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, any>;
  const reads = (ev: any) => ev?.kind === "created" || /^attempt:claim:/.test(ev?.via ?? "") ||
    (ev?.kind === "agent" && !!ev.event && typeof ev.event === "object" && !Array.isArray(ev.event) && (ev.event.type === "handoffNote" || ev.event.type === "spend"));
  const runs: any[] = Array.isArray(e.attempts) ? e.attempts : [];
  const pick = (a: any) => Object.fromEntries(["id", "executorId", "status", "outcome", "reason", "finishedAt", "deadline", "leaseUntil"].filter((k) => a?.[k] !== undefined).map((k) => [k, a[k]]));
  const drafts = [...(Array.isArray(e.drafts) ? e.drafts : [])].sort((a: any, b: any) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    task: e.task,
    events: (Array.isArray(e.events) ? e.events : []).filter(reads),
    actions: Array.isArray(e.actions) ? e.actions : [],
    attempts: runs.slice(0, 200).map(pick),
    attemptsTruncated: runs.length > 200,
    drafts: drafts.slice(-1),
  };
}

/** `GET /v1/tasks` over a shop's tasks (`taskJson`'s shape, oldest first as the shop's index holds them), as apps/api answers
 *  it (task-list.ts): newest first, at most `limit` (25 when the query does not say, never more), from just after the task
 *  the cursor names, and the cursor of the next page. */
export function taskPage(tasks: readonly unknown[], req: Recorded): FakeAnswer {
  const url = new URL(req.url);
  const raw = url.searchParams.get("limit");
  const limit = raw === null ? 25 : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) return { status: 400, json: { error: "invalid_limit" } };
  const newest = [...tasks].reverse();
  const ids = newest.map((t) => (t as { task?: { id?: unknown } } | null)?.task?.id);
  const cursor = url.searchParams.get("cursor");
  let start = 0;
  if (cursor !== null) {
    const at = ids.indexOf(cursor);
    if (at < 0) return { status: 400, json: { error: "invalid_cursor" } };
    start = at + 1;
  }
  const looked = newest.slice(start, start + limit);
  const end = start + looked.length;
  return { status: 200, json: { tasks: looked.map(listedJson), next: end < newest.length ? (ids[end - 1] ?? null) : null } };
}

/** `GET /v1/approvals` as apps/api answers it: `state` names the list (`open`, or `recent` for the ones that stopped waiting) and says which
 *  it is in the answer; any other is 400 `invalid_state`. */
function approvalsListing(url: URL, open: unknown[], recent: Recent): FakeAnswer {
  const state = url.searchParams.get("state");
  if (state !== "open" && state !== "recent") return { status: 400, json: { error: "invalid_state" } };
  // a recent list that is an answer instead of entries is that answer, to test what the app does when the read goes wrong
  if (state === "recent" && !Array.isArray(recent)) return recent;
  return { status: 200, json: { state, approvals: state === "open" ? open : recent } };
}

/** What `GET /v1/approvals?state=recent` answers: the entries it lists (`settledJson`), or the answer itself (a refusal, no answer at all,
 *  anything). */
export type Recent = unknown[] | FakeAnswer;

/** Serves the four routes a read of the shop makes. Without `approvals`, the open approvals are the tasks' LINE replies
 *  still waiting, as the API would list them. Later calls to `api.on` replace one of them. */
export function serveShop(api: FakeApi, over: { tasks?: unknown[]; schedules?: unknown[]; attention?: unknown[]; approvals?: unknown[]; recent?: Recent } = {}): FakeApi {
  const tasks = over.tasks ?? [taskJson()];
  return api
    .on("GET", "/v1/tasks", (req) => taskPage(tasks, req))
    .on("GET", "/v1/schedules", { status: 200, json: { schedules: over.schedules ?? [scheduleJson()] } })
    .on("GET", "/v1/inbound/attention", { status: 200, json: { items: over.attention ?? [attentionJson()] } })
    .on("GET", "/v1/approvals", (req) => approvalsListing(new URL(req.url), over.approvals ?? openReplies(tasks, Date.now()), over.recent ?? []));
}

/** The desktop shell's commands in memory, stood in `window.__TAURI_INTERNALS__` as the app's shell stands: the API
 *  through the fake, the keychain item, and the saved read. Every call is logged with its arguments. */
export function desktopShell(api: FakeApi, store: ReturnType<typeof memoryCacheStore>, keychain: string | null) {
  const calls: { cmd: string; args: Record<string, any> }[] = [];
  let answered = 0;
  let item = keychain;
  const invoke = async (cmd: string, args: Record<string, any> = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "api_request": {
        try {
          const answer = await api.fetch(args.url, { method: args.method, headers: args.bearer ? { authorization: `Bearer ${args.bearer}` } : {}, ...(args.body ? { body: args.body } : {}) });
          const body = await answer.text();
          answered += 1;
          return { status: answer.status, body };
        } catch (e) {
          throw e instanceof LinkDown && e.kind === "offline" ? "offline" : "failed";
        }
      }
      case "api_session_read":
        return item;
      case "api_session_write":
        item = args.value;
        return null;
      case "api_session_clear":
        item = null;
        return null;
      case "shop_cache_write":
        return store.write(args.key, args.text);
      case "shop_cache_read":
        return store.read(args.key);
      case "shop_cache_clear":
        return store.clear();
      // the shell answers its own words, `unavailable` where there is no keychain and `keychain` when it refused
      case "shop_cache_seal_key":
        return store.sealKey(args.make).catch((e) => Promise.reject(e instanceof NoKeychain ? "unavailable" : "keychain"));
      case "shop_cache_seal_key_clear":
        return store.dropSealKey().then(() => null, (e) => Promise.reject(e instanceof NoKeychain ? "unavailable" : "keychain"));
    }
    throw new Error(`no such command: ${cmd}`);
  };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
  return { calls, commands: (name: string) => calls.filter((c) => c.cmd === name), answered: () => answered };
}

/** A clock a test moves by hand. */
export function clock(start = Date.UTC(2026, 10, 23, 3, 0, 0)) {
  const c = { ms: start, now: () => c.ms, pass: (ms: number) => void (c.ms += ms) };
  return c;
}

/** What an earlier run left on disk for the shop, as the shell holds it (the file's name, and its text, sealed with the
 *  tests' key): the read of `serveShop(api, over)` as of `at`. */
export async function savedRead(at: number, over: Parameters<typeof serveShop>[1] = {}): Promise<Record<string, string>> {
  const api = serveShop(fakeApi(), over);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(Date.now())) });
  const read = await readShop(session, () => at);
  if (!read.ok) throw new Error("the fixture's read failed");
  return { [cacheKey(ORIGIN, "apple:owner-1")]: await sealedFile(encodeSnapshot(read.snapshot)) };
}

// ---- several shops (docs/several-shops.md; docs/pilot-api.md, "Several shops") -------------------------------------

/** A shop as `GET /v1/shops` lists it. */
export interface ShopJson {
  id: string;
  name: string;
  ownerName: string;
  role: "owner" | "helper";
}

/** Two sample shops: one the signed-in person owns, one they help at. */
export const SHOP_A: ShopJson = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon", role: "owner" };
export const SHOP_B: ShopJson = { id: "pilot:shop-b", name: "Ran Pa Noi", ownerName: "Noi", role: "helper" };

/** A plainly fake shop session token. A real one is `mos1.` (an owner's) or `mhs1.` (a helper's), the shop in base64url,
 *  and 64 hex digits; `n` tells one opening from the next. */
export function shopToken(shop: string, role: "owner" | "helper", n = 1): string {
  return `${role === "owner" ? "mos1" : "mhs1"}.test-${shop.replace(/[^a-z0-9]/gi, "-")}.fake-${n}`;
}

export interface ServedShops {
  /** the shops `GET /v1/shops` lists; change it to move a shop off the list */
  list: ShopJson[];
  /** each shop's open approvals, by shop id */
  approvals: Record<string, unknown[]>;
  /** each shop's recent approvals, the ones that stopped waiting (`settledJson`), by shop id; or the answer to give instead */
  recent: Record<string, Recent>;
  /** shops whose sessions the API answers 401 `removed` or `unlinked` with this time, by shop id */
  ended: Record<string, { error: "removed" | "unlinked"; at: string }>;
  /** every token the fake gave, by token: its shop and role */
  tokens: Map<string, { shop: string; role: "owner" | "helper" }>;
  /** the tokens the fake no longer takes (ended, or refused on purpose), which answer 401 `unauthorized` */
  refused: Set<string>;
  /** how many times each shop was opened */
  opened: Record<string, number>;
  /** each shop's work, by shop id, as an owner's session reads it (`GET /v1/tasks`, `/v1/schedules`, `/v1/inbound/attention`
   *  and `/v1/routines`), and as the owner's changes to the team leave it; a shop the person owns with none listed here has
   *  no tasks, no routines and all three members on */
  work: Record<string, ShopWorkJson>;
  /** what each shop's team knows, by shop id, in `@manut/shop-memory`'s own state: the owner's own routes read and change it, as
   *  apps/api's do (`/v1/memory`); a shop with none listed here knows nothing yet. Seed it with `learned`. */
  memory: Record<string, MemoryState>;
}

/** What a shop's team has learned: each text with where it came from, in the order given, as the package's `propose` keeps them
 *  (a customer's words wait for the owner). */
export function learned(...facts: { text: string; source?: FactSource; at?: number }[]): MemoryState {
  return facts.reduce((state, f, i) => {
    const made = propose(state, f.text, f.source ?? { kind: "owner" }, f.at ?? T0 + i * 1000);
    if (!made.ok) throw new Error(`the fixture's fact "${f.text}" was refused: ${made.reason}`);
    return made.state;
  }, emptyState());
}

/** A shop's work as the fake API keeps it: its tasks (`taskJson`'s shape, oldest first), schedules and attention items,
 *  and the team's routines. */
export interface ShopWorkJson {
  tasks: unknown[];
  schedules: unknown[];
  attention: unknown[];
  team: { paused: boolean; since: string | null; members: string[] };
  routines: Record<string, unknown>[];
}

/** One of the team's routines as `GET /v1/routines` lists it (apps/api routine-setup.ts `routineView`): by default Ton's
 *  morning brief, every day at 08:00, switched on. */
export function routineJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rt-0001-brief",
    name: "Morning brief",
    action: "brief",
    trigger: { kind: "daily", at: "08:00" },
    timeZone: "Asia/Bangkok",
    asksFirst: false,
    member: "ton",
    when: "Every day at 08:00",
    paused: false,
    next: iso(T0 + 7 * 3600_000),
    createdAt: iso(T0 - 86_400_000),
    lastRun: null,
    ...over,
  };
}

/** A member's job as the task's export carries it (apps/api workers.ts): the task the runner made, the log with its claim
 *  and what the run reported, the run itself and the draft it wrote. By default Nam's reply, done, at ฿0.38. */
export function workerTaskJson(over: { id?: string; member?: string; job?: string; title?: string; claimedAt?: number; finishedAt?: number | null; outcome?: string | null; status?: string; reason?: string; draft?: string | null; costSatang?: number; tokens?: number; deadline?: number } = {}) {
  const id = over.id ?? "worker-task-1";
  const attemptId = `${id}-attempt`;
  const member = over.member ?? "nam";
  const claimedAt = over.claimedAt ?? T0 + 60_000;
  const finishedAt = over.finishedAt === undefined ? claimedAt + 4_000 : over.finishedAt;
  const status = over.status ?? (finishedAt === null ? "active" : "done");
  return {
    task: { id, title: over.title ?? "A reply to a customer", objective: "Draft a reply to a customer's message for the owner to read.", state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: iso(claimedAt), tenantId: SHOP_A.id },
    events: [
      { seq: 1, kind: "created", at: iso(claimedAt - 1_000), rev: 1, via: "put" },
      { seq: 2, kind: "updated", at: iso(claimedAt), rev: 2, via: `attempt:claim:${attemptId}` },
      { seq: 3, kind: "agent", at: iso(claimedAt + 1_000), rev: 2, attemptId, event: { type: "turnStarted" } },
      { seq: 4, kind: "agent", at: iso(claimedAt + 3_000), rev: 2, attemptId, event: { type: "spend", tokens: over.tokens ?? 640, model: "claude-haiku-5-5", costSatang: over.costSatang ?? 38 } },
    ],
    eventFloor: 0,
    actions: [],
    attempts: [
      {
        id: attemptId,
        executorId: member,
        fence: "f",
        leaseUntil: (claimedAt + 300_000) / 1000,
        inputRevision: "r",
        maxSteps: 40,
        deadline: (over.deadline ?? claimedAt + 1_200_000) / 1000,
        status,
        ...(over.outcome === null || status === "active" ? {} : { outcome: over.outcome ?? "done" }),
        ...(over.reason ? { reason: over.reason } : {}),
        ...(finishedAt === null ? {} : { finishedAt: finishedAt / 1000 }),
        steps: [],
      },
    ],
    attemptsTruncated: false,
    requests: [],
    drafts: over.draft === null ? [] : [{ attemptId, member, job: over.job ?? "reply", text: over.draft ?? "Thank you! Your parcel left this morning.", at: iso(finishedAt ?? claimedAt) }],
  };
}

/** What a shop the person owns holds when a test says nothing: no tasks, no routines, and the whole team on. */
const emptyWork = (): ShopWorkJson => ({ tasks: [], schedules: [], attention: [], team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });

/** Serves the several-shops routes over `api`, as apps/api answers them: the list, opening a shop session (owned and
 *  helped shops alike, 404 for a shop not listed), each shop's `GET /v1/approvals` and its decision and pass-on routes by
 *  the shop session it is sent with, and ending a session. A request with any other bearer on those routes is the
 *  sign-in's: `GET /v1/approvals` then answers what `serveShop` would (the signed-in tenant's own). */
export function serveShops(api: FakeApi, list: ShopJson[], approvals: Record<string, unknown[]> = {}, now: () => number = Date.now, work: Record<string, Partial<ShopWorkJson>> = {}): ServedShops {
  const served: ServedShops = {
    list,
    approvals,
    recent: {},
    ended: {},
    tokens: new Map(),
    refused: new Set(),
    opened: {},
    work: Object.fromEntries(list.filter((s) => s.role === "owner").map((s) => [s.id, { ...emptyWork(), ...work[s.id] }])),
    memory: {},
  };
  /** The shop a shop-session request is for, or the 401 to answer; null when the bearer is not a shop session. */
  const shopOf = (req: Recorded): { shop: string; role: "owner" | "helper" } | FakeAnswer | null => {
    if (!req.bearer || !/^m[oh]s1\./.test(req.bearer)) return null;
    const held = served.tokens.get(req.bearer);
    if (!held || served.refused.has(req.bearer)) return { status: 401, json: { error: "unauthorized" } };
    const ended = served.ended[held.shop];
    if (ended) return { status: 401, json: ended.error === "removed" ? { error: "removed", removedAt: ended.at } : { error: "unlinked", unlinkedAt: ended.at } };
    return held;
  };
  const isAnswer = (v: unknown): v is FakeAnswer => typeof v === "string" || (!!v && typeof v === "object" && "status" in v);
  api
    .on("GET", "/v1/shops", () => ({ status: 200, json: { shops: served.list } }))
    .on("POST", "/v1/shops/session", (req) => {
      const shop = served.list.find((s) => s.id === (req.body as { shop?: unknown })?.shop);
      if (!shop) return { status: 404, json: { error: "not_found" } };
      served.opened[shop.id] = (served.opened[shop.id] ?? 0) + 1;
      const accessToken = shopToken(shop.id, shop.role, served.opened[shop.id]);
      served.tokens.set(accessToken, { shop: shop.id, role: shop.role });
      const named = { id: shop.id, name: shop.name, ownerName: shop.ownerName };
      const session = { accessToken, expiresAt: iso(now() + 30 * 86_400_000) };
      return { status: 200, json: shop.role === "owner" ? { shop: named, role: "owner", account: { id: "owner-account-1" }, session } : { shop: named, role: "helper", helper: { id: "helper-1", name: "Mint" }, session } };
    })
    .on("POST", "/v1/shops/session/end", (req) => {
      const at = shopOf(req);
      if (at === null) return { status: 403, json: { error: "not_a_shop_session" } };
      if (isAnswer(at)) return at;
      served.refused.add(req.bearer!);
      return { status: 200, json: { ended: { shop: at.shop, role: at.role } } };
    });
  const listing = (req: Recorded): FakeAnswer => {
    const at = shopOf(req);
    if (at === null) return approvalsListing(new URL(req.url), [], []);
    if (isAnswer(at)) return at;
    return approvalsListing(new URL(req.url), served.approvals[at.shop] ?? [], served.recent[at.shop] ?? []);
  };
  api.on("GET", "/v1/approvals", listing);
  // An owner's session reads its shop's tasks, schedules, attention items and routines and changes its team, as apps/api
  // answers them; a helper's is told they are the owner's (403 `owner_only`).
  const ownerAt = (req: Recorded): { shop: string; work: ShopWorkJson } | FakeAnswer => {
    const at = shopOf(req);
    if (at === null) return { status: 401, json: { error: "unauthorized" } };
    if (isAnswer(at)) return at;
    if (at.role !== "owner") return { status: 403, json: { error: "owner_only" } };
    return { shop: at.shop, work: (served.work[at.shop] ??= emptyWork()) };
  };
  const owned = (req: Recorded, answer: (shop: string, work: ShopWorkJson) => FakeAnswer): FakeAnswer => {
    const at = ownerAt(req);
    return isAnswer(at) ? at : answer(at.shop, at.work);
  };
  // The sign-in's own tenant has nothing in these tests: a person in shops is never read as it.
  const ownTenant = (req: Recorded, empty: FakeAnswer, answer: (w: ShopWorkJson) => FakeAnswer): FakeAnswer =>
    shopOf(req) === null ? empty : owned(req, (_shop, w) => answer(w));
  api
    .on("GET", "/v1/tasks", (req) => ownTenant(req, { status: 200, json: { tasks: [], next: null } }, (w) => taskPage(w.tasks, req)))
    .on("GET", "/v1/schedules", (req) => ownTenant(req, { status: 200, json: { schedules: [] } }, (w) => ({ status: 200, json: { schedules: w.schedules } })))
    .on("GET", "/v1/inbound/attention", (req) => ownTenant(req, { status: 200, json: { items: [] } }, (w) => ({ status: 200, json: { items: w.attention } })))
    .on("GET", "/v1/routines", (req) => owned(req, (shop, w) => ({ status: 200, json: { tenant: shop, team: w.team, routines: w.routines } })))
    .on("POST", "/v1/team/pause", (req) => owned(req, (_shop, w) => ((w.team = { ...w.team, paused: true, since: w.team.since ?? iso(now()) }), { status: 200, json: { team: w.team } })))
    .on("POST", "/v1/team/resume", (req) => owned(req, (_shop, w) => ((w.team = { ...w.team, paused: false, since: null }), { status: 200, json: { team: w.team } })));
  for (const [path, paused] of [["/v1/routines/pause", true], ["/v1/routines/resume", false]] as const) {
    api.on("POST", path, (req) =>
      owned(req, (_shop, w) => {
        const routine = w.routines.find((r) => r.id === (req.body as { routineId?: unknown })?.routineId);
        if (!routine) return { status: 404, json: { error: "not_found" } };
        routine.paused = paused;
        if (paused) routine.next = null;
        return { status: 200, json: { routine } };
      }),
    );
  }
  ownerMemoryRoutes(api, served, owned, now);
  ownerRoutineRoutes(api, owned, now);
  return served;
}

type Owned = (req: Recorded, answer: (shop: string, work: ShopWorkJson) => FakeAnswer) => FakeAnswer;

/** What apps/api's `memory.ts` answers a session: its own shop's facts (`GET /v1/memory`) and the owner's four changes, each a body of
 *  exactly the fields it reads, through the package. A helper's session is 403 `owner_only`. */
function ownerMemoryRoutes(api: FakeApi, served: ServedShops, owned: Owned, now: () => number): void {
  const STATUS: Record<string, number> = { invalid_text: 400, invalid_source: 400, not_found: 404, already_known: 409, forgotten: 409, full: 409 };
  const exact = (body: unknown, keys: readonly string[]): body is Record<string, unknown> =>
    !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every((k) => k in (body as object));
  const stateOf = (shop: string): MemoryState => (served.memory[shop] ??= emptyState());
  api.on("GET", "/v1/memory", (req) =>
    owned(req, (shop) => {
      const state = stateOf(shop);
      return { status: 200, json: { tenant: shop, facts: state.facts, forgottenCount: state.forgotten.length } };
    }),
  );
  type Done = { ok: true; state: MemoryState; reply: unknown } | { ok: false; reason: string };
  const fact = (r: Result): Done => (r.ok ? { ok: true, state: r.state, reply: r.fact } : { ok: false, reason: r.reason });
  const change = (path: string, keys: readonly string[], run: (state: MemoryState, body: Record<string, unknown>) => Done) =>
    api.on("POST", path, (req) =>
      owned(req, (shop) => {
        if (!exact(req.body, keys)) return { status: 400, json: { error: "invalid_request" } };
        const body = req.body as Record<string, unknown>;
        if ("id" in body && !(typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64)) return { status: 400, json: { error: "invalid_request" } };
        const done = run(stateOf(shop), body);
        if (!done.ok) return { status: STATUS[done.reason] ?? 400, json: { error: done.reason } };
        served.memory[shop] = done.state;
        return { status: 200, json: done.reply };
      }),
    );
  change("/v1/memory/remember", ["text"], (state, body) => fact(rememberFact(state, body.text as string, now())));
  change("/v1/memory/confirm", ["id"], (state, body) => fact(confirmFact(state, body.id as string, now())));
  change("/v1/memory/correct", ["id", "text"], (state, body) => fact(correctFact(state, body.id as string, body.text as string, now())));
  change("/v1/memory/forget", ["id"], (state, body) => {
    const gone = forgetFact(state, body.id as string);
    return gone.ok ? { ok: true, state: gone.state, reply: { id: body.id } } : { ok: false, reason: gone.reason };
  });
}

const WORK: Record<string, readonly ActionKind[]> = { nam: ["reply"], pim: ["draft", "send"], ton: ["brief", "draft", "send", "pay", "delete"] };

/** What apps/api's `routines.ts` answers a session that makes or removes a routine (`POST /v1/routines`, `/v1/routines/remove`): the
 *  package builds the routine and the API names who runs it, a body is exactly the fields the route reads, a team keeps at most 50,
 *  and a routine that is not there is 404. */
function ownerRoutineRoutes(api: FakeApi, owned: Owned, now: () => number): void {
  let made = 0;
  api.on("POST", "/v1/routines", (req) =>
    owned(req, (_shop, w) => {
      const body = req.body;
      const FIELDS = ["name", "action", "trigger", "timeZone", "asksFirst", "member"];
      if (!body || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).every((k) => FIELDS.includes(k))) return { status: 400, json: { error: "invalid_request" } };
      const input = body as Record<string, unknown>;
      if (input.asksFirst !== undefined && typeof input.asksFirst !== "boolean") return { status: 400, json: { error: "invalid_request" } };
      made += 1;
      const built = createRoutine({
        id: `rt-made-${String(made).padStart(4, "0")}`,
        name: input.name as string,
        action: input.action as ActionKind,
        trigger: input.trigger as Trigger,
        ...(input.timeZone !== undefined ? { timeZone: input.timeZone as string } : {}),
        ...(input.asksFirst !== undefined ? { asksFirst: input.asksFirst } : {}),
      });
      if (!built.ok) return { status: 400, json: { error: built.reason } };
      const { routine } = built;
      const member = input.member === undefined ? (routine.action === "reply" ? "nam" : "ton") : input.member;
      if (typeof member !== "string" || !(member in WORK)) return { status: 400, json: { error: "unknown_member" } };
      if (!WORK[member].includes(routine.action)) return { status: 400, json: { error: "wrong_member" } };
      if (w.routines.length >= 50) return { status: 409, json: { error: "full" } };
      const next = nextRun(routine, now());
      const view: Record<string, unknown> = {
        ...routine,
        member,
        when: describeTrigger(routine),
        paused: false,
        next: next === null ? null : iso(next),
        ...(routine.trigger.kind === "stockBelow" ? { waitsFor: "stock_feed" } : {}),
        createdAt: iso(now()),
        lastRun: null,
      };
      w.routines.push(view);
      return { status: 200, json: { routine: view } };
    }),
  );
  api.on("POST", "/v1/routines/remove", (req) =>
    owned(req, (_shop, w) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== "object" || Object.keys(body).length !== 1 || typeof body.routineId !== "string" || !/^rt-[0-9a-z-]{1,64}$/.test(body.routineId)) {
        return { status: 400, json: { error: "invalid_request" } };
      }
      const at = w.routines.findIndex((r) => r.id === body.routineId);
      if (at < 0) return { status: 404, json: { error: "not_found" } };
      w.routines.splice(at, 1);
      return { status: 200, json: { removed: body.routineId } };
    }),
  );
}

/** A socket as the page's WebSocket behaves for the live feed (feed.ts), driven by the test: it opens, takes messages and
 *  drops only when told, and records what was sent on it and how it was closed. */
export class FakeSocket implements FeedSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  opened(): void {
    this.onopen?.();
  }
  says(data: unknown): void {
    this.onmessage?.({ data });
  }
  drops(code = 1006): void {
    this.onerror?.();
    this.onclose?.({ code });
  }
  /** The ticket the socket was opened with, from its protocol entry. */
  get ticket(): string | undefined {
    return this.protocols.find((p) => p.startsWith(TICKET_PROTOCOL))?.slice(TICKET_PROTOCOL.length);
  }
}

/** Opens fake sockets, keeping each one in the order opened. */
export function socketOpener(): { sockets: FakeSocket[]; open: (url: string, protocols: string[]) => FakeSocket } {
  const sockets: FakeSocket[] = [];
  return { sockets, open: (url, protocols) => {
    const socket = new FakeSocket(url, protocols);
    sockets.push(socket);
    return socket;
  } };
}
