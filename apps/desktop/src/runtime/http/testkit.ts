// Fakes for the connected runtime's tests: an API that answers by method and path and records every request, and a
// keychain that keeps one value in memory. They stand where the desktop shell's `api_request` and `session_*`
// commands stand in the app (shell.ts), so the tests run without a shell or a network.
import type { FetchLike, SessionVault } from "./shell";
import { LinkDown, VaultUnavailable } from "./shell";

export const ORIGIN = "https://dev.manut.xyz";

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

/** Serves the three routes a read of the shop makes. Later calls to `api.on` replace one of them. */
export function serveShop(api: FakeApi, over: { tasks?: unknown[]; schedules?: unknown[]; attention?: unknown[] } = {}): FakeApi {
  return api
    .on("GET", "/v1/tenant/export", { status: 200, json: { tenant: "apple:owner-1", exportedAt: iso(T0), tasks: over.tasks ?? [taskJson()], schedules: [], attention: [] } })
    .on("GET", "/v1/schedules", { status: 200, json: { schedules: over.schedules ?? [scheduleJson()] } })
    .on("GET", "/v1/inbound/attention", { status: 200, json: { items: over.attention ?? [attentionJson()] } });
}

/** A clock a test moves by hand. */
export function clock(start = Date.UTC(2026, 10, 23, 3, 0, 0)) {
  const c = { ms: start, now: () => c.ms, pass: (ms: number) => void (c.ms += ms) };
  return c;
}
