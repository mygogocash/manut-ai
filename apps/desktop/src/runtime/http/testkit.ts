// Fakes for the connected runtime's tests: an API that answers by method and path and records every request, a
// keychain that keeps one value in memory, and the disk that keeps the last good read. They stand where the desktop
// shell's `api_request`, `api_session_*` and `shop_cache_*` commands stand in the app (shell.ts), so the tests run
// without a shell or a network.
import { decodeRecord, encodeRecord, encodeStanding } from "@manut/approval-core";
import { vi } from "vitest";
import { cacheKey, encodeSnapshot, type CacheStore } from "./cache";
import { ApiSession } from "./session";
import type { FetchLike, SessionVault } from "./shell";
import { LinkDown, VaultUnavailable } from "./shell";
import { readShop } from "./shop";

export const ORIGIN = "https://dev.manut.xyz";

/** Every op the connected runtime refuses because it only reads: each answers `not_yet` while connected and `offline` while only a kept read is shown. */
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

/** The shell's saved-read commands in memory, with a log of the calls. Like the shell's, it keeps the one read of the one
 *  signed-in shop: a write replaces whatever was kept. `refuse` makes every call fail, as a full or unreadable disk
 *  would. */
export function memoryCacheStore(files: Record<string, string> = {}): CacheStore & { files: Map<string, string>; calls: string[]; refuse: boolean } {
  const store = {
    files: new Map(Object.entries(files)),
    calls: [] as string[],
    refuse: false,
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

/** One entry of `GET /v1/tenant/export`'s `tasks`: the document, its event log, its actions and attempts. */
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

/** The open requests the API lists for these export entries' LINE replies: one per reply still proposed and not past its
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

/** Serves the four routes a read of the shop makes. Without `approvals`, the open approvals are the export's LINE replies
 *  still waiting, as the API would list them. Later calls to `api.on` replace one of them. */
export function serveShop(api: FakeApi, over: { tasks?: unknown[]; schedules?: unknown[]; attention?: unknown[]; approvals?: unknown[] } = {}): FakeApi {
  const tasks = over.tasks ?? [taskJson()];
  return api
    .on("GET", "/v1/tenant/export", { status: 200, json: { tenant: "apple:owner-1", exportedAt: iso(T0), tasks, schedules: [], attention: [] } })
    .on("GET", "/v1/schedules", { status: 200, json: { schedules: over.schedules ?? [scheduleJson()] } })
    .on("GET", "/v1/inbound/attention", { status: 200, json: { items: over.attention ?? [attentionJson()] } })
    .on("GET", "/v1/approvals", () => ({ status: 200, json: { state: "open", approvals: over.approvals ?? openReplies(tasks, Date.now()) } }));
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

/** What an earlier run left on disk for the shop, as the shell holds it (the file's name, and its text): the read of
 *  `serveShop(api, over)` as of `at`. */
export async function savedRead(at: number, over: Parameters<typeof serveShop>[1] = {}): Promise<Record<string, string>> {
  const api = serveShop(fakeApi(), over);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(Date.now())) });
  const read = await readShop(session, () => at);
  if (!read.ok) throw new Error("the fixture's read failed");
  return { [cacheKey(ORIGIN, "apple:owner-1")]: encodeSnapshot(read.snapshot) };
}
