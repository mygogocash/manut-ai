import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { cancelAttempt, startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import { bangkokMonth } from "../src/model-price";
import type { AttemptJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";
import { runWorker, taskTitle, type WorkerJob, type WorkerJobEntry, type WorkerMember } from "../src/workers";

// What an operator reads of a shop's workers: `GET /v1/admin/workers/drafts` (workers.ts), end to end in real workerd
// against the real objects. Most jobs are made by a real run with the gateway's stand-in model. The endings a run cannot
// reach in a test (a worker waiting for the owner, a handover nobody took up, an attempt that went silent) are left as
// the job flow leaves them: through the same task object and the same worker port. Nothing here can send, post, pay or
// refund, and the route calls no model: the global fetch answers 599 for the whole file.

const bindings = env as unknown as Env;
/// The gateway's stand-in provider, as `MODEL_PROVIDER=stand-in` sets it for local runs.
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const OPS = { kind: "operator", email: "ops@manut.test" } as const;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const CHANNEL_SECRET = "fixture-line-channel-secret-drafts-01";
const CHANNEL_TOKEN = "fixture-line-channel-access-token-drafts-01";
const BOT = `U${"d".repeat(32)}`;
const CUSTOMER = `U${"e".repeat(32)}`;
const LINEAR_PROJECT = "ws/shop-issues";
const VAULT_TOKEN = "linear-vault-token-for-the-drafts";
const DAY = "2026-11-22";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Page = { tenant: string; jobs: WorkerJobEntry[]; next: string | null };
type Refused = { error: string };

/// An object namespace whose objects note every request they are sent (as `<object> <method> <path>`) and fail the ones
/// `breaks` names, as an object that cannot be reached would.
function watching(namespace: DurableObjectNamespace, seen: string[],
  breaks: (label: string) => boolean = () => false): DurableObjectNamespace {
  const names = new Map<string, string>();
  return {
    idFromName: (name: string) => {
      const id = namespace.idFromName(name);
      names.set(id.toString(), name);
      return id;
    },
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const label = `${names.get(id.toString()) ?? "?"} ${request.method} ${new URL(request.url).pathname}`;
          seen.push(label);
          if (breaks(label)) throw new Error("fixture_object_down");
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}

/// An operator call through the admin gate, as the console makes it: the operator's Access identity, the stand-in model,
/// and `overrides` for any binding a test replaces.
async function admin<T>(method: string, path: string, body?: unknown, overrides: Partial<Env> = {}) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => ({ email: OPS.email }) }, configurable: true });
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method, headers: OPERATOR,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { ...flowEnv, ...overrides } as Env, context);
  await waitOnExecutionContext(context);
  return { status: response.status, headers: response.headers, body: (await response.json()) as T };
}

type Shop = { tenant: string; connectionId: string };

/// A pilot shop as the console makes one, with its LINE connection in the vault and the owner's consent to cloud work.
async function shop(): Promise<Shop> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops",
    { name: "Baan Somtam", ownerName: "Khun Ploy" });
  expect(created.status).toBe(200);
  const tenant = created.body.tenant;
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant, channelId: "2000000043", botUserId: BOT, channelSecret: CHANNEL_SECRET, channelAccessToken: CHANNEL_TOKEN,
  });
  expect(connected.status).toBe(200);
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, cloudWork: true }) })).status)
    .toBe(200);
  return { tenant, connectionId: connected.body.connectionId };
}

/// A customer's message, stored as the shop's LINE webhook stores one. Answers its id.
async function customerWrites(s: Shop, text: string): Promise<string> {
  const response = await tenantCall(bindings, s.tenant, "/pilot/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-pilot": "1" },
    body: JSON.stringify({ tenant: s.tenant, connectionId: s.connectionId,
      events: [{ webhookEventId: crypto.randomUUID(), lineUserId: CUSTOMER, text }] }) });
  expect(response.status).toBe(200);
  const { created } = (await response.json()) as { created: { id: string }[] };
  return created[0]!.id;
}

/// One job through the runner, with the stand-in model.
async function run(s: Shop, member: WorkerMember, job: WorkerJob) {
  const result = await runWorker(flowEnv, { tenant: s.tenant, member, job, startedBy: OPS }, { flags: on });
  if (!result.ok) throw new Error(`run_refused_${result.error}`);
  return result;
}

/// What the meter charged for each call it recorded this month, in whole satang, newest first.
async function meteredSatang(s: Shop): Promise<number[]> {
  const usage = await tenantCall(bindings, s.tenant,
    `/model/usage?tenant=${encodeURIComponent(s.tenant)}&month=${bangkokMonth(Date.now())}`);
  return ((await usage.json()) as { calls: { satang: number }[] }).calls.map((call) => call.satang);
}

const listPath = (tenant: string, query = "") => `/v1/admin/workers/drafts?tenant=${encodeURIComponent(tenant)}${query}`;
const list = (s: Shop, query = "", overrides: Partial<Env> = {}) =>
  admin<Page>("GET", listPath(s.tenant, query), undefined, overrides);

/// The one job a page holds.
function only(page: Page): WorkerJobEntry {
  expect(page.jobs).toHaveLength(1);
  return page.jobs[0]!;
}

/// A job's task as the runner makes it (workers.ts, `createTask`): indexed in the shop first, then created as a draft task
/// of the shop's, titled in the runner's own words. Answers its id. `index` and `owner` default to the shop, and name
/// another shop's index or tenant to plant a task where it does not belong.
async function taskFor(s: Shop, job: WorkerJob, options: { title?: string; index?: string; owner?: string } = {}):
  Promise<string> {
  const taskId = `worker-task-${crypto.randomUUID()}`;
  const indexed = await tenantCall(bindings, options.index ?? s.tenant, "/index", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: options.index ?? s.tenant, taskId }) });
  expect(indexed.status).toBe(200);
  const created = await bindings.TASK.get(bindings.TASK.idFromName(taskId)).fetch(new Request("https://task/", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-task-id": taskId, "x-tenant": options.owner ?? s.tenant,
      "x-create-only": "1" },
    body: JSON.stringify({ id: taskId, title: options.title ?? taskTitle(job, DAY), objective: "For the owner to read.",
      state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString(),
      tenantId: options.owner ?? s.tenant }),
  }));
  expect(created.status).toBe(200);
  return taskId;
}

/// A member's attempt on a task, as the job flow gives it, and the port that member works through.
async function begin(s: Shop, taskId: string, executorId: string): Promise<WorkerPort> {
  const started = await startAttempt(flowEnv, { tenant: s.tenant, taskId, executorId }, { flags: on });
  if (!started.ok) throw new Error(`attempt_refused_${started.error}`);
  return workerPort(flowEnv, started.job, { flags: on });
}

/// A Linear connection in the shop's vault whose grant covers the project, so a worker can ask for a write.
async function linearGrant(s: Shop): Promise<void> {
  const stored = await admin("POST", "/v1/admin/connections", { tenantId: s.tenant, provider: "linear",
    accountId: "workspace-shop", scopes: ["write"], refreshToken: VAULT_TOKEN, resourceIds: [LINEAR_PROJECT],
    allowsActions: true });
  expect(stored.status).toBe(200);
}

async function attemptsOf(taskId: string, tenant: string): Promise<AttemptJSON[]> {
  const response = await bindings.TASK.get(bindings.TASK.idFromName(taskId)).fetch(new Request("https://task/export",
    { headers: { "x-tenant": tenant } }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { attempts: AttemptJSON[] }).attempts;
}

describe("the drafts route behind the admin gate", () => {
  /// A request through the Worker with the Access audience and the bearer given, or left off, and every object it reached.
  async function send(method: string, path: string, options: { audience?: string; bearer?: string }) {
    const seen: string[] = [];
    const context = createExecutionContext();
    if (options.audience !== undefined) {
      Object.defineProperty(context, "access", { value: { aud: options.audience, getIdentity: async () => undefined },
        configurable: true });
    }
    const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method,
      headers: { authorization: `Bearer ${options.bearer ?? "test-key"}`, "content-type": "application/json" } }),
    { ...flowEnv, TENANT: watching(bindings.TENANT, seen), TASK: watching(bindings.TASK, seen) } as Env, context);
    await waitOnExecutionContext(context);
    return { status: response.status, seen };
  }

  it("refuses a call without the gate's two credentials, before any object is reached", async () => {
    for (const options of [{}, { audience: "another-application" }, { audience: bindings.ADMIN_ACCESS_AUD!, bearer: "a-session-token" }]) {
      const answer = await send("GET", listPath("workers:gate-shop"), options);
      expect(answer).toEqual({ status: 403, seen: [] });
    }
  });

  it("is an exact GET entry: through the gate, the route is never the gate's 404, and nothing else is a route", async () => {
    const audience = bindings.ADMIN_ACCESS_AUD!;
    // The route's own answer to a call with no tenant, never the gate's 404 for a method it does not list.
    expect((await send("GET", "/v1/admin/workers/drafts", { audience })).status).toBe(400);
    for (const [method, path] of [
      ["POST", "/v1/admin/workers/drafts"],
      ["PUT", "/v1/admin/workers/drafts"],
      ["DELETE", "/v1/admin/workers/drafts"],
      ["GET", "/v1/admin/workers/drafts/more"],
      ["GET", "/v1/admin/workers/run"],
    ] as const) {
      expect((await send(method, listPath("workers:gate-shop").replace("/v1/admin/workers/drafts", path), { audience })).status)
        .toBe(404);
    }
  });
});

describe("what the route checks before it reads a shop's jobs", () => {
  it("refuses a missing or overlong tenant, and a page it cannot read, before reaching any object", async () => {
    const seen: string[] = [];
    const watched = { TENANT: watching(bindings.TENANT, seen), TASK: watching(bindings.TASK, seen) };
    const tenant = encodeURIComponent("workers:validation");
    const task = `worker-task-${crypto.randomUUID()}`;
    const cases: [string, string][] = [
      ["/v1/admin/workers/drafts", "tenant_required"],
      [`/v1/admin/workers/drafts?tenant=${"t".repeat(257)}`, "tenant_required"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=0`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=26`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=-1`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=1.5`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=ten`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&limit=`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&before=nope`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&before=pilot-task-${crypto.randomUUID()}`, "invalid_request"],
      [`/v1/admin/workers/drafts?tenant=${tenant}&before=${task}%0A`, "invalid_request"],
    ];
    for (const [path, error] of cases) {
      expect(await admin("GET", path, undefined, watched)).toMatchObject({ status: 400, body: { error } });
    }
    expect(seen).toEqual([]);
  });

  it("answers 404 shop_not_found for a tenant that is no pilot shop, and an empty page for a shop with no jobs", async () => {
    const stranger = `workers:no-shop-${crypto.randomUUID()}`;
    expect(await admin("GET", listPath(stranger))).toMatchObject({ status: 404, body: { error: "shop_not_found" } });
    const s = await shop();
    expect(await list(s)).toMatchObject({ status: 200, body: { tenant: s.tenant, jobs: [], next: null } });
  });

  it("refuses a cursor that is not one of the shop's own jobs", async () => {
    const s = await shop();
    const other = await shop();
    const theirs = (await run(other, "pim", { kind: "post", topic: "another shop's post" })).taskId;
    await run(s, "pim", { kind: "post", topic: "this shop's post" });
    for (const before of [theirs, `worker-task-${crypto.randomUUID()}`]) {
      expect(await list(s, `&before=${before}`)).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
  });

  it("says so when the shop's record, its index or one of its jobs cannot be read, and never shows a short list instead", async () => {
    const s = await shop();
    const first = await run(s, "pim", { kind: "post", topic: "one" });
    await run(s, "pim", { kind: "post", topic: "two" });
    const down = (label: string) => label.includes(first.taskId);
    expect(await list(s, "", { TASK: watching(bindings.TASK, [], down) }))
      .toMatchObject({ status: 503, body: { error: "drafts_unavailable" } });
    expect(await list(s, "", { TENANT: watching(bindings.TENANT, [], (label) => label.includes("GET /index")) }))
      .toMatchObject({ status: 503, body: { error: "drafts_unavailable" } });
    expect(await list(s, "", { TENANT: watching(bindings.TENANT, [], (label) => label.includes("GET /pilot/shop")) }))
      .toMatchObject({ status: 503, body: { error: "shop_unavailable" } });
  });

  it("calls no model, writes nothing and tells every cache not to keep what it answers", async () => {
    const s = await shop();
    await run(s, "pim", { kind: "post", topic: "rainy season specials" });
    const before = { calls: await meteredSatang(s), index: await tenantCall(bindings, s.tenant,
      `/index?tenant=${encodeURIComponent(s.tenant)}`).then((response) => response.json()) };
    const seen: string[] = [];
    const answer = await list(s, "", { TENANT: watching(bindings.TENANT, seen), TASK: watching(bindings.TASK, seen) });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    // Only reads: the shop, its index, and each job's task.
    expect(seen.every((label) => label.includes(" GET "))).toBe(true);
    expect(await meteredSatang(s)).toEqual(before.calls);
    expect(await tenantCall(bindings, s.tenant, `/index?tenant=${encodeURIComponent(s.tenant)}`)
      .then((response) => response.json())).toEqual(before.index);
  });
});

describe("how each job ended", () => {
  it("shows a finished job with its member, its kind, when it ran, the draft in full and what the call cost", async () => {
    const s = await shop();
    const topic = "our new mango sticky rice";
    const before = Date.now();
    const result = await run(s, "pim", { kind: "post", topic });
    const [charged] = await meteredSatang(s);
    expect(charged).toBeGreaterThan(0);
    const job = only((await list(s)).body);
    expect(job).toEqual({ taskId: result.taskId, member: "pim", job: "post", at: expect.any(String),
      ending: { state: "done" }, draft: { text: `Stand-in reply to: Draft a post about: ${topic}`, at: expect.any(String) },
      costSatang: charged });
    expect(Date.parse(job.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(job.at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(job.draft!.at)).toBeGreaterThanOrEqual(Date.parse(job.at));
  });

  it("names the message a reply answers and what sending it would take, and a summary's day", async () => {
    const s = await shop();
    const messageId = await customerWrites(s, "Is the green papaya salad spicy?");
    await run(s, "nam", { kind: "reply", messageId });
    await run(s, "ton", { kind: "daily_summary" });
    const [summary, reply] = (await list(s)).body.jobs;
    expect(reply).toMatchObject({ member: "nam", job: "reply", ending: { state: "done" }, draft: {
      text: "Stand-in reply to: Customer message:\nIs the green papaya salad spicy?", about: { messageId },
      send: { answer: "draft_only", kind: "reply" } } });
    // Ton with no sales to count calls no model, so there is a draft and no cost.
    expect(summary).toMatchObject({ member: "ton", job: "daily_summary", ending: { state: "done" },
      draft: { about: { date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) } } });
    expect(summary).not.toHaveProperty("costSatang");
    expect(reply).toHaveProperty("costSatang", (await meteredSatang(s))[0]);
  });

  it("shows a job that failed with its reason and no draft: its connection gone, and its shop's budget spent", async () => {
    const s = await shop();
    const messageId = await customerWrites(s, "Hello?");
    expect((await bindings.CRED.get(bindings.CRED.idFromName(`t:${s.tenant}`)).fetch(new Request(
      `https://cred/connections/${encodeURIComponent(s.connectionId)}`,
      { method: "DELETE", headers: { "x-tenant": s.tenant } }))).status).toBe(200);
    const disconnected = await run(s, "nam", { kind: "reply", messageId });
    expect(disconnected).toMatchObject({ outcome: "failed", reason: "not_connected" });
    expect((await tenantCall(bindings, s.tenant, "/model/cap", { method: "POST",
      headers: { "content-type": "application/json", "x-model": "1" },
      body: JSON.stringify({ tenant: s.tenant, capSatang: 0, setBy: null }) })).status).toBe(200);
    const broke = await run(s, "pim", { kind: "post", topic: "rainy season specials" });
    expect(broke).toMatchObject({ outcome: "failed", reason: "budget" });

    const [post, reply] = (await list(s)).body.jobs;
    expect(reply).toEqual({ taskId: disconnected.taskId, member: "nam", job: "reply", at: expect.any(String),
      ending: { state: "failed", reason: "not_connected" }, draft: null });
    expect(post).toEqual({ taskId: broke.taskId, member: "pim", job: "post", at: expect.any(String),
      ending: { state: "failed", reason: "budget" }, draft: null });
    // Nothing was spent on either, so neither reports a cost.
    expect(post).not.toHaveProperty("costSatang");
    expect(reply).not.toHaveProperty("costSatang");
  });

  it("shows a worker that asked and is waiting for the owner, with the draft it wrote", async () => {
    const s = await shop();
    await linearGrant(s);
    const taskId = await taskFor(s, { kind: "post", topic: "rainy season specials" });
    const port = await begin(s, taskId, "pim");
    expect((await port.report([{ type: "turnStarted" }])).ok).toBe(true);
    expect((await port.draft({ member: "pim", job: "post", text: "Rainy season specials: iced jasmine tea on us." })).ok)
      .toBe(true);
    expect((await port.ask({ operationType: "linear.issue.create", targetResourceId: LINEAR_PROJECT,
      payload: { title: "Photograph the new candles", description: "For the post." } })).ok).toBe(true);
    expect(await port.waitForOwner()).toEqual({ ok: true, value: { outcome: "awaiting_owner" } });
    expect(only((await list(s)).body)).toEqual({ taskId, member: "pim", job: "post", at: expect.any(String),
      ending: { state: "awaiting_owner" },
      draft: { text: "Rainy season specials: iced jasmine tea on us.", at: expect.any(String) } });
  });

  it("shows a job someone cancelled", async () => {
    const s = await shop();
    const taskId = await taskFor(s, { kind: "post", topic: "anything" });
    const port = await begin(s, taskId, "pim");
    expect((await cancelAttempt(flowEnv, s.tenant, taskId, port.job.attemptId, OPS)).ok).toBe(true);
    expect(only((await list(s)).body)).toMatchObject({ taskId, member: "pim", ending: { state: "cancelled" }, draft: null });
  });

  it("says a job is running while its attempt can act, and failed the way the sweep will settle it once it cannot, writing nothing", async () => {
    const s = await shop();
    const taskId = await taskFor(s, { kind: "post", topic: "anything" });
    await begin(s, taskId, "pim");
    expect(only((await list(s)).body)).toMatchObject({ taskId, ending: { state: "running" }, draft: null });

    // Ten minutes on, past the five-minute lease but inside the 20-minute deadline, the worker has gone silent; half an
    // hour on, it is past its deadline.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60 * 1000);
    expect(only((await list(s)).body).ending).toEqual({ state: "failed", reason: "silent" });
    vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60 * 1000);
    expect(only((await list(s)).body).ending).toEqual({ state: "failed", reason: "deadline" });
    // Reading settled nothing: the attempt is still active in the task, for the sweep to end and record.
    expect(await attemptsOf(taskId, s.tenant)).toEqual([expect.objectContaining({ status: "active" })]);
  });
});

describe("handovers", () => {
  it("shows the member who did a job that was passed to them, and who passed it, once", async () => {
    const s = await shop();
    const topic = "our new mango sticky rice";
    // A post is Pim's job: asked of Nam, it is passed on, and Pim does it with a model call of their own.
    const result = await run(s, "nam", { kind: "post", topic });
    expect(result).toMatchObject({ member: "pim", passedFrom: "nam", outcome: "done" });
    expect(await attemptsOf(result.taskId, s.tenant)).toHaveLength(2);
    const [charged] = await meteredSatang(s);
    expect(only((await list(s)).body)).toEqual({ taskId: result.taskId, member: "pim", passedFrom: "nam", job: "post",
      at: expect.any(String), ending: { state: "done" },
      draft: { text: `Stand-in reply to: Draft a post about: ${topic}`, at: expect.any(String) }, costSatang: charged });
  });

  it("shows a job passed on and not taken up as ended by the handover, naming who it went to", async () => {
    const s = await shop();
    const taskId = await taskFor(s, { kind: "daily_summary" });
    const port = await begin(s, taskId, "nam");
    expect((await port.report([{ type: "turnStarted" },
      { type: "handoffNote", from: "nam", to: "ton", job: "daily_summary" },
      { type: "turnCompleted", status: "completed" }])).ok).toBe(true);
    expect((await port.finish("done")).ok).toBe(true);
    const job = only((await list(s)).body);
    expect(job).toEqual({ taskId, member: "nam", job: "daily_summary", at: expect.any(String),
      ending: { state: "handed_over", to: "ton" }, draft: null });
    expect(job).not.toHaveProperty("passedFrom");
  });

  it("does not take a handoff note for a handover unless it names one of the team", async () => {
    const s = await shop();
    const taskId = await taskFor(s, { kind: "post", topic: "anything" });
    const port = await begin(s, taskId, "pim");
    expect((await port.report([{ type: "handoffNote", to: "Ton", summary: "books need the refund" },
      { type: "handoffNote", from: "pim", to: "someone-else", job: "post" }])).ok).toBe(true);
    expect((await port.finish("done")).ok).toBe(true);
    expect(only((await list(s)).body)).toMatchObject({ member: "pim", ending: { state: "done" } });
  });
});

describe("which jobs it lists, and in what order", () => {
  it("lists newest first, a page at a time, each job once, and the last page has no cursor", async () => {
    const s = await shop();
    const made: string[] = [];
    for (let n = 1; n <= 5; n++) made.push((await run(s, "pim", { kind: "post", topic: `post number ${n}` })).taskId);
    // A job passed on counts once, wherever the page ends.
    made.push((await run(s, "nam", { kind: "post", topic: "post number 6" })).taskId);
    const newest = [...made].reverse();

    const first = (await list(s, "&limit=4")).body;
    expect(first.jobs.map((job) => job.taskId)).toEqual(newest.slice(0, 4));
    expect(first.next).toBe(newest[3]);
    const second = (await list(s, `&limit=4&before=${first.next}`)).body;
    expect(second.jobs.map((job) => job.taskId)).toEqual(newest.slice(4));
    expect(second.next).toBeNull();
    // The times run backwards down the list.
    const times = [...first.jobs, ...second.jobs].map((job) => Date.parse(job.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Without a limit a page holds up to ten; the whole shop fits.
    expect((await list(s)).body.jobs).toHaveLength(6);
  });

  it("lists only what the runner made: not another kind of task, a task it never created, one with no attempt, one a tenant titled itself, or another shop's", async () => {
    const s = await shop();
    const other = await shop();
    const real = await run(s, "pim", { kind: "post", topic: "the one real job" });
    const seen: string[] = [];

    // Newer than the real job, so each must be read and passed over to find it.
    await tenantCall(bindings, s.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: s.tenant, taskId: `pilot-task-${crypto.randomUUID()}` }) });
    const never = `worker-task-${crypto.randomUUID()}`;
    await tenantCall(bindings, s.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: s.tenant, taskId: never }) });
    await taskFor(s, { kind: "post", topic: "never claimed" });
    const titled = await taskFor(s, { kind: "post", topic: "x" }, { title: "Something the shop's own client wrote" });
    await begin(s, titled, "pim");
    const strangers = await taskFor(other, { kind: "post", topic: "someone else's" });
    await tenantCall(bindings, s.tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: s.tenant, taskId: strangers }) });
    const foreign = await taskFor(s, { kind: "post", topic: "y" });
    await begin(s, foreign, "someone-not-on-the-team");

    // One job a page, so the route has to read on past every task it passes over.
    const page = await list(s, "&limit=1", { TASK: watching(bindings.TASK, seen) });
    expect(page.body.jobs.map((job) => job.taskId)).toEqual([real.taskId]);
    expect(page.body.next).toBeNull();
    // It never read the pilot's own task: only tasks the runner names.
    expect(seen.every((label) => label.includes("worker-task-"))).toBe(true);
    expect(seen.some((label) => label.includes(never))).toBe(true);
  });
});
