import { adminFetch, tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { sourceWorker } from "./source-worker";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import { sha256Hex } from "../src/auth";
import type { Env } from "../src/index";
import { startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import { stepOrder, type BrowserStepView, type NewBrowserStep } from "../src/sign-in-vault";
import type { AttemptJSON, TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";

// The step channel (docs/browser-control.md): how a worker's browser step reaches an outpost, and how what the
// outpost did comes back into the attempt's events. The outpost's side is a stub: no browser and no site. The global
// fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
const SITE = "Shopee Seller Centre";
const ORIGINS = ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"];
const ORDERS = "https://seller.shopee.co.th/portal/sale/order";
const USERNAME = "baan.mali@example.com";
// Made up for each run and never a real password, so a search for it finds only what this file stored.
const PASSWORD = `pw-${crypto.randomUUID()}`;

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Shop = { tenant: string; taskId: string };

/// A shop with consent given and one draft task, indexed for export and deletion.
async function shop(): Promise<Shop> {
  const tenant = fresh("steps:shop");
  const taskId = fresh("steps-task");
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork: true }) })).status).toBe(200);
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Parcel status", objective: "Read the parcel status.",
    state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() },
  tenant)).status).toBe(200);
  return { tenant, taskId };
}

/// An attempt at the shop's task for `member`, and the port its worker holds.
async function attempt(s: Shop, member: string, flags: JobFlags = on): Promise<WorkerPort> {
  const started = await startAttempt(flowEnv, { tenant: s.tenant, taskId: s.taskId, executorId: member }, { flags: on });
  if (!started.ok) throw new Error(`attempt_not_started_${started.error}`);
  return workerPort(flowEnv, started.job, { flags });
}

function task(taskId: string) {
  return bindings.TASK.get(bindings.TASK.idFromName(taskId));
}

/// The task's own record: its log and its attempts.
async function exported(s: Shop): Promise<{ events: TaskEventJSON[]; attempts: AttemptJSON[] }> {
  const response = await task(s.taskId).fetch(new Request("https://task/export", { headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { events: TaskEventJSON[]; attempts: AttemptJSON[] };
}

/// What the control plane landed in the attempt's events for its outposts, oldest first.
async function landed(s: Shop, attemptId: string): Promise<unknown[]> {
  return (await exported(s)).events.filter((entry) => entry.via === `attempt:outpost:${attemptId}`)
    .map((entry) => entry.event);
}

async function leaseOf(s: Shop, attemptId: string): Promise<number | undefined> {
  return (await exported(s)).attempts.find((entry) => entry.id === attemptId)?.leaseUntil;
}

async function consent(tenant: string, cloudWork: boolean) {
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork }) })).status).toBe(200);
}

async function addSignIn(tenant: string, options: { members?: string[]; site?: string; origins?: string[] } = {}):
  Promise<string> {
  const response = await adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, site: options.site ?? SITE, origins: options.origins ?? ORIGINS, username: USERNAME,
      password: PASSWORD, members: options.members ?? ["nam", "ton"] }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { signIn: { id: string } }).signIn.id;
}

type OutpostStep = { stepId: string; kind: string; url?: string; selector?: string; grantId?: string; origins: string[];
  expiresAt: string };

/// Who an outpost's request says it is, when a test makes it say something else.
type As = { tenant?: string; outpostId?: string; credential?: string | null };

/// The outpost's side, played by a stub: it beats, redeems, asks for its steps and reports them, with its own
/// credential, each request from an address of its own.
class StubOutpost {
  constructor(readonly tenant: string, readonly id: string, readonly credential: string) {}

  private call(path: string, body: Record<string, unknown>, as: As = {}) {
    const credential = as.credential === undefined ? this.credential : as.credential;
    return sourceWorker.fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json",
      ...(credential !== null ? { authorization: `Bearer ${credential}` } : {}) },
    body: JSON.stringify({ tenant: as.tenant ?? this.tenant, outpostId: as.outpostId ?? this.id, ...body }) });
  }

  beat() {
    return this.call("/v1/outposts/heartbeat", {});
  }

  redeem(grantId: string) {
    return this.call("/v1/outposts/redeem", { grantId });
  }

  steps(as: As = {}) {
    return this.call("/v1/outposts/steps", {}, as);
  }

  report(stepId: string, report: Record<string, unknown>, as: As = {}) {
    return this.call("/v1/outposts/steps/report", { stepId, ...report }, as);
  }

  /// The steps handed to it now.
  async take(): Promise<OutpostStep[]> {
    const response = await this.steps();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return ((await response.json()) as { steps: OutpostStep[] }).steps;
  }
}

/// A registered outpost, beating unless told not to.
async function outpost(tenant: string, options: { name?: string; kind?: string; beat?: boolean } = {}) {
  const response = await adminFetch(`${API}/v1/admin/outposts`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, name: options.name ?? "This Mac", kind: options.kind ?? "this_mac" }) });
  expect(response.status).toBe(200);
  const { outpost: registered, credential } = (await response.json()) as { outpost: { id: string }; credential: string };
  const stub = new StubOutpost(tenant, registered.id, credential);
  if (options.beat !== false) expect((await stub.beat()).status).toBe(200);
  return stub;
}

async function queued(port: WorkerPort, step: NewBrowserStep): Promise<BrowserStepView> {
  const answer = await port.browserStep(step);
  if (!answer.ok) throw new Error(`step_refused_${answer.error}`);
  return answer.value;
}

async function outcome(port: WorkerPort, stepId: string): Promise<BrowserStepView> {
  const answer = await port.browserStepOutcome(stepId);
  if (!answer.ok) throw new Error(`outcome_refused_${answer.error}`);
  return answer.value;
}

async function grantOf(port: WorkerPort, signInId: string, outpostId: string): Promise<string> {
  const asked = await port.signIn(signInId, outpostId);
  if (!asked.ok) throw new Error(`grant_refused_${asked.error}`);
  return asked.value.grantId;
}

function vault(tenant: string) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
}

/// Every browser step the shop's vault holds, as stored.
async function stepRecords(tenant: string): Promise<Record<string, unknown>[]> {
  return runInDurableObject(vault(tenant), async (_instance, state) =>
    [...(await state.storage.list<Record<string, unknown>>({ prefix: "browser-step:" })).values()]);
}

/// Changes a stored record of the shop's vault, as time passing would.
async function patch(tenant: string, key: string, change: Record<string, unknown>) {
  await runInDurableObject(vault(tenant), async (_instance, state) => {
    const record = await state.storage.get<Record<string, unknown>>(key);
    await state.storage.put(key, { ...record, ...change });
  });
}

const past = () => new Date(Date.now() - 1).toISOString();

async function refusal(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

/// The shop's audit entries for browser steps, oldest first, without their ids and times.
async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said)
    .filter((entry) => entry.action.startsWith("browser_step."));
}

describe("an outpost's events in the attempt's log", () => {
  it("are appended only by the control plane, only while the attempt runs, and never extend its lease", async () => {
    const s = await shop();
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;
    const post = (body: unknown, headers: Record<string, string> = { "x-control": "1" }, tenant = s.tenant) =>
      task(s.taskId).fetch(new Request(`https://task/attempts/${attemptId}/outpost-events`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, ...headers }, body: JSON.stringify(body) }));
    const event = { type: "toolUpdated", id: crypto.randomUUID(), update: { status: "completed", output: "" } };
    const leaseOf = async () => (await exported(s)).attempts.find((entry) => entry.id === attemptId)?.leaseUntil;

    // Only the control plane: the outpost never holds the attempt's fence, and nobody else may write for it.
    const stranger = await post({ events: [event] }, {});
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual({ error: "forbidden" });

    const lease = await leaseOf();
    const appended = await post({ events: [event] });
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual({ stored: 1, tip: expect.any(Number) });
    const after = await exported(s);
    expect(after.events.at(-1)).toMatchObject({ kind: "agent", via: `attempt:outpost:${attemptId}`, attemptId, event });
    // An outpost's word is not a sign of the worker's life.
    expect(await leaseOf()).toBe(lease);

    for (const events of [[], [42], [{ type: "" }], "not-a-list", Array.from({ length: 11 }, () => event)]) {
      const refused = await post({ events });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_request" });
    }
    expect((await post({ events: [event] }, { "x-control": "1" }, fresh("steps:other-shop"))).status).toBe(404);
    const unknown = await task(s.taskId).fetch(new Request(`https://task/attempts/${crypto.randomUUID()}/outpost-events`,
      { method: "POST", headers: { "content-type": "application/json", "x-tenant": s.tenant, "x-control": "1" },
        body: JSON.stringify({ events: [event] }) }));
    expect(unknown.status).toBe(404);

    // A lapsed lease, then an ended attempt: the attempt no longer runs, so nothing more lands in its name.
    await runInDurableObject(task(s.taskId), async (_instance, state) => {
      const record = await state.storage.get<AttemptJSON>(`attempt:${attemptId}`);
      await state.storage.put(`attempt:${attemptId}`, { ...record, leaseUntil: Date.now() / 1000 - 1 });
    });
    const lapsed = await post({ events: [event] });
    expect(lapsed.status).toBe(409);
    expect(await lapsed.json()).toEqual({ error: "lease_expired" });
    await runInDurableObject(task(s.taskId), async (_instance, state) => {
      const record = await state.storage.get<AttemptJSON>(`attempt:${attemptId}`);
      await state.storage.put(`attempt:${attemptId}`, { ...record, leaseUntil: Date.now() / 1000 + 300 });
    });
    expect((await nam.finish("done")).ok).toBe(true);
    const ended = await post({ events: [event] });
    expect(ended.status).toBe(409);
    expect(await ended.json()).toEqual({ error: "stale_attempt" });
    expect((await exported(s)).events.filter((entry) => entry.via === `attempt:outpost:${attemptId}`)).toHaveLength(1);
  });
});

describe("the order steps are handed out in", () => {
  it("is the order they were asked for, also for steps queued in the same millisecond, never their random ids' order", () => {
    const at = "2026-11-27T05:00:00.000Z";
    const steps = [
      { queuedAt: at, seq: 7, id: "00000000-0000-4000-8000-000000000000" },
      { queuedAt: at, seq: 6, id: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
      { queuedAt: "2026-11-27T04:59:59.999Z", seq: 8, id: "88888888-8888-4888-8888-888888888888" },
    ];
    expect([...steps].sort(stepOrder).map((step) => step.seq)).toEqual([8, 6, 7]);
    // a step queued before the order existed sorts first among its millisecond, then by its id as before
    expect([{ queuedAt: at, seq: 1, id: "a" }, { queuedAt: at, id: "b" }].sort(stepOrder).map((step) => step.id)).toEqual(["b", "a"]);
  });
});

describe("browser steps", () => {
  it("hands an open step to its outpost once, and lands what it did in the attempt's events", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;

    const step = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect(step).toEqual({ stepId: expect.any(String), kind: "open", outpostId: mac.id, state: "queued",
      queuedAt: expect.any(String), expiresAt: expect.any(String), url: ORDERS });
    const lasts = Date.parse(step.expiresAt) - Date.now();
    expect(lasts).toBeGreaterThan(110_000);
    expect(lasts).toBeLessThanOrEqual(120_000);

    expect(await mac.take()).toEqual([{ stepId: step.stepId, kind: "open", url: ORDERS, origins: ORIGINS,
      expiresAt: step.expiresAt }]);
    // Handed out once: the next fetch finds nothing.
    expect(await mac.take()).toEqual([]);
    expect((await outcome(nam, step.stepId)).state).toBe("taken");

    const lease = await leaseOf(s, attemptId);
    const reported = await mac.report(step.stepId, { outcome: "done" });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ step: { stepId: step.stepId, state: "done" } });
    // The outpost's report is not the worker's sign of life.
    expect(await leaseOf(s, attemptId)).toBe(lease);

    expect(await outcome(nam, step.stepId)).toEqual({ ...step, state: "done" });
    expect(await landed(s, attemptId)).toEqual([
      { type: "toolStarted", id: step.stepId, call: { kind: "web", title: `Open ${ORDERS}`, output: "",
        status: "running", edits: [], startedAt: step.queuedAt } },
      { type: "toolUpdated", id: step.stepId, update: { status: "completed", output: "" } },
    ]);

    const bound = { stepId: step.stepId, outpostId: mac.id, taskId: s.taskId, attemptId };
    expect(await audit(s.tenant)).toEqual([
      { actor: { kind: "worker", attemptId }, action: "browser_step.queued", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "browser_step.fetched", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "browser_step.reported", subject: bound, outcome: "done" },
    ]);
  });

  it("reads a page's text, or a selector's, up to 4 KB once written as JSON", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const status = await queued(nam, { kind: "read", outpostId: mac.id, selector: ".order-status" });
    expect(status).toMatchObject({ kind: "read", selector: ".order-status", state: "queued" });
    const whole = await queued(nam, { kind: "read", outpostId: mac.id });
    expect(whole).not.toHaveProperty("selector");
    expect(await mac.take()).toEqual([
      { stepId: status.stepId, kind: "read", selector: ".order-status", origins: ORIGINS, expiresAt: status.expiresAt },
      { stepId: whole.stepId, kind: "read", origins: ORIGINS, expiresAt: whole.expiresAt },
    ]);

    const shipped = "จัดส่งแล้ว: Shipped, SP-2291";
    expect((await mac.report(status.stepId, { outcome: "done", text: shipped })).status).toBe(200);
    expect(await outcome(nam, status.stepId)).toEqual({ ...status, state: "done", text: shipped });
    expect((await landed(s, nam.job.attemptId)).at(-1)).toEqual({ type: "toolUpdated", id: status.stepId,
      update: { status: "completed", output: shipped } });

    // Over the bound is refused before anything is used up, so the outpost can cut it and report again. Thai takes
    // three bytes a letter, so 1,400 of them are over 4 KB; 4,094 ASCII letters and their quotes are exactly 4 KB.
    await refusal(await mac.report(whole.stepId, { outcome: "done", text: "ก".repeat(1_400) }), 400, "text_too_long");
    const fits = "a".repeat(4_094);
    expect((await mac.report(whole.stepId, { outcome: "done", text: fits })).status).toBe(200);
    expect((await outcome(nam, whole.stepId)).text).toBe(fits);
  });

  it("takes a report only in the shape its step's kind allows, and uses nothing up for one it refuses", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const open = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    const read = await queued(nam, { kind: "read", outpostId: mac.id });
    const skipped = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect(await mac.take()).toHaveLength(3);
    for (const report of [{}, { outcome: "skipped" }, { outcome: "failed" }, { outcome: "failed", code: "it_broke" },
      { outcome: "failed", code: "timed_out", text: "partial" }, { outcome: "done", code: "timed_out" },
      { outcome: "done", text: 42 }]) {
      await refusal(await mac.report(open.stepId, report), 400, "invalid_report");
    }
    // What only the step's kind can say: an open brings back no text, and a read always does.
    await refusal(await mac.report(open.stepId, { outcome: "done", text: "Orders" }), 400, "invalid_report");
    await refusal(await mac.report(read.stepId, { outcome: "done" }), 400, "invalid_report");

    expect((await mac.report(open.stepId, { outcome: "failed", code: "page_unavailable" })).status).toBe(200);
    expect(await outcome(nam, open.stepId)).toEqual({ ...open, state: "failed", code: "page_unavailable" });
    expect((await landed(s, nam.job.attemptId)).at(-1)).toEqual({ type: "toolUpdated", id: open.stepId,
      update: { status: "failed", output: "page_unavailable" } });
    // An empty page is still a read.
    expect((await mac.report(read.stepId, { outcome: "done", text: "" })).status).toBe(200);
    expect(await outcome(nam, read.stepId)).toEqual({ ...read, state: "done", text: "" });
    // A step the outpost did not run at all says so, and carries no text.
    await refusal(await mac.report(skipped.stepId, { outcome: "failed", code: "not_run", text: "" }), 400, "invalid_report");
    expect((await mac.report(skipped.stepId, { outcome: "failed", code: "not_run" })).status).toBe(200);
    expect(await outcome(nam, skipped.stepId)).toEqual({ ...skipped, state: "failed", code: "not_run" });
  });

  it("signs in with a grant, and a site's refusal leads the worker to report the sign-in broken", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;
    const asked = await nam.signIn(signInId, mac.id);
    if (!asked.ok) throw new Error(`grant_refused_${asked.error}`);
    const { grantId, expiresAt } = asked.value;

    const step = await queued(nam, { kind: "sign_in", outpostId: mac.id, grantId });
    // It lives no longer than its grant.
    expect(step).toEqual({ stepId: expect.any(String), kind: "sign_in", outpostId: mac.id, state: "queued",
      queuedAt: expect.any(String), expiresAt, signInId });
    expect(await mac.take()).toEqual([{ stepId: step.stepId, kind: "sign_in", grantId, origins: ORIGINS, expiresAt }]);
    const redeemed = await mac.redeem(grantId);
    expect(((await redeemed.json()) as { password: string }).password).toBe(PASSWORD);
    expect((await mac.report(step.stepId, { outcome: "failed", code: "sign_in_refused" })).status).toBe(200);

    // The worker reads how it went and, as the site refused the saved password, reports the sign-in broken.
    const failed = await outcome(nam, step.stepId);
    expect(failed).toEqual({ ...step, state: "failed", code: "sign_in_refused" });
    expect(await nam.signInBroken(failed.signInId ?? "")).toEqual({ ok: true, value: { signInId, state: "broken" } });

    expect(await landed(s, attemptId)).toEqual([
      { type: "toolStarted", id: step.stepId, call: { kind: "web", title: `Sign in to ${SITE}`, output: "",
        status: "running", edits: [], startedAt: step.queuedAt } },
      { type: "toolUpdated", id: step.stepId, update: { status: "failed", output: "sign_in_refused" } },
    ]);
    const bound = { stepId: step.stepId, outpostId: mac.id, taskId: s.taskId, attemptId, signInId, grantId };
    expect(await audit(s.tenant)).toEqual([
      { actor: { kind: "worker", attemptId }, action: "browser_step.queued", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "browser_step.fetched", subject: bound, outcome: "ok" },
      { actor: { kind: "outpost", id: mac.id }, action: "browser_step.reported", subject: bound, outcome: "failed",
        reason: "sign_in_refused" },
    ]);
  });

  it("lands a sign-in the site interrupted as failed, and leaves the sign-in working", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const grantId = await grantOf(nam, signInId, mac.id);
    const step = await queued(nam, { kind: "sign_in", outpostId: mac.id, grantId });
    expect(await mac.take()).toHaveLength(1);
    // The site asked for a check that you are a person, or a code: the outpost says so, with no text.
    await refusal(await mac.report(step.stepId, { outcome: "failed", code: "sign_in_interrupted", text: "" }), 400, "invalid_report");
    expect((await mac.report(step.stepId, { outcome: "failed", code: "sign_in_interrupted" })).status).toBe(200);
    expect(await outcome(nam, step.stepId)).toEqual({ ...step, state: "failed", code: "sign_in_interrupted" });
    expect((await landed(s, nam.job.attemptId)).at(-1)).toEqual({ type: "toolUpdated", id: step.stepId,
      update: { status: "failed", output: "sign_in_interrupted" } });
    // Nothing refused the saved password, so nothing marks the sign-in broken: it is working, for the next try.
    const listed = await nam.signIns();
    expect(listed.ok && listed.value.signIns.map(({ signInId: id, state }) => ({ id, state }))).toEqual([{ id: signInId, state: "working" }]);
  });

  it("carries a grant in one step only, from its own attempt, for its own outpost, while it is good", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const cloud = await outpost(s.tenant, { name: "Cloud outpost", kind: "cloud" });
    const nam = await attempt(s, "nam");
    const ton = await attempt(s, "ton");
    const signIn = (grantId: string) => nam.browserStep({ kind: "sign_in", outpostId: mac.id, grantId });

    const grant = await grantOf(nam, signInId, mac.id);
    expect((await signIn(grant)).ok).toBe(true);
    expect(await signIn(grant)).toEqual({ ok: false, error: "grant_queued" });
    expect(await signIn(await grantOf(nam, signInId, cloud.id))).toEqual({ ok: false, error: "wrong_outpost" });
    for (const other of [await grantOf(ton, signInId, mac.id), crypto.randomUUID(), "not-a-grant"]) {
      expect(await signIn(other)).toEqual({ ok: false, error: "grant_not_found" });
    }
    const used = await grantOf(nam, signInId, mac.id);
    expect((await mac.redeem(used)).status).toBe(200);
    expect(await signIn(used)).toEqual({ ok: false, error: "grant_used" });
    const late = await grantOf(nam, signInId, mac.id);
    await patch(s.tenant, `signin-grant:${late}`, { expiresAt: past() });
    expect(await signIn(late)).toEqual({ ok: false, error: "grant_expired" });
  });

  // A write is a `submit` step, queued only from an approved request (browser-submit.test.ts); any other kind is refused.
  const notSteps = ["click", "type", "post", "SUBMIT", "", undefined, 42];
  it.each(notSteps)("refuses a %j step: a worker's own words only read", async (kind) => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    expect(await nam.browserStep({ kind, outpostId: mac.id, url: ORDERS } as unknown as NewBrowserStep))
      .toEqual({ ok: false, error: "step_kind_not_allowed" });
    expect(await stepRecords(s.tenant)).toEqual([]);
    expect(await audit(s.tenant)).toEqual([{ actor: { kind: "worker", attemptId: nam.job.attemptId },
      action: "browser_step.queued", subject: { outpostId: mac.id, taskId: s.taskId, attemptId: nam.job.attemptId },
      outcome: "refused", reason: "step_kind_not_allowed" }]);
  });

  it("goes only to the origins of a working sign-in its member is named on", async () => {
    const s = await shop();
    const shopee = await addSignIn(s.tenant);
    const lazada = "https://sellercenter.lazada.co.th";
    await addSignIn(s.tenant, { site: "Lazada Seller Center", origins: [lazada], members: ["pim"] });
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const pim = await attempt(s, "pim");
    const kit = await attempt(s, "kit");
    const open = (port: WorkerPort, url: unknown) =>
      port.browserStep({ kind: "open", outpostId: mac.id, url } as NewBrowserStep);

    for (const url of ["http://seller.shopee.co.th/portal", "https://fon:secret@seller.shopee.co.th/", "not a url", "",
      "https://seller.shopee.co.th/ order", `https://seller.shopee.co.th/${"a".repeat(2_048)}`, 42, undefined]) {
      expect(await open(nam, url)).toEqual({ ok: false, error: "invalid_url" });
    }
    for (const url of ["https://evil.example/", "https://seller.shopee.co.th:8443/", "https://shopee.co.th/",
      `${lazada}/order`]) {
      expect(await open(nam, url)).toEqual({ ok: false, error: "origin_not_allowed" });
    }
    expect(await open(pim, ORDERS)).toEqual({ ok: false, error: "origin_not_allowed" });
    expect((await open(pim, `${lazada}/order`)).ok).toBe(true);
    expect((await open(nam, "https://accounts.shopee.co.th/seller/login")).ok).toBe(true);
    // A member named on no working sign-in may read no page at all.
    expect(await kit.browserStep({ kind: "read", outpostId: mac.id })).toEqual({ ok: false, error: "origin_not_allowed" });
    // Only the fields of its kind, and a selector a person could write.
    expect(await nam.browserStep({ kind: "read", outpostId: mac.id, url: ORDERS } as unknown as NewBrowserStep))
      .toEqual({ ok: false, error: "invalid_request" });
    for (const selector of ["", "   ", "a".repeat(257), "div\nspan", 42]) {
      expect(await pim.browserStep({ kind: "read", outpostId: mac.id, selector } as unknown as NewBrowserStep))
        .toEqual({ ok: false, error: "invalid_selector" });
    }

    // A broken sign-in takes its origins with it until the owner types a new password.
    expect((await nam.signInBroken(shopee)).ok).toBe(true);
    expect(await open(nam, ORDERS)).toEqual({ ok: false, error: "origin_not_allowed" });
    expect(await nam.browserStep({ kind: "read", outpostId: mac.id })).toEqual({ ok: false, error: "origin_not_allowed" });

    const refused = (await audit(s.tenant)).filter((entry) => entry.outcome === "refused");
    expect(refused[0]).toEqual({ actor: { kind: "worker", attemptId: nam.job.attemptId },
      action: "browser_step.queued", subject: { outpostId: mac.id, taskId: s.taskId, attemptId: nam.job.attemptId },
      outcome: "refused", reason: "invalid_url" });
    // Nothing the worker named but ids goes into the log.
    expect(JSON.stringify(await audit(s.tenant))).not.toContain("evil.example");
  });

  it("asks for an online outpost of the shop", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const nam = await attempt(s, "nam");
    const asleep = await outpost(s.tenant, { beat: false });
    const open = (outpostId: string) => nam.browserStep({ kind: "open", outpostId, url: ORDERS });
    expect(await open(asleep.id)).toEqual({ ok: false, error: "outpost_asleep" });
    expect(await open(crypto.randomUUID())).toEqual({ ok: false, error: "outpost_not_found" });
    expect(await open((await outpost(fresh("steps:other-shop"))).id)).toEqual({ ok: false, error: "outpost_not_found" });
    expect((await asleep.beat()).status).toBe(200);
    expect((await open(asleep.id)).ok).toBe(true);
  });

  it("holds at most 20 steps for an outpost at once", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const steps: BrowserStepView[] = [];
    for (let i = 0; i < 20; i++) steps.push(await queued(nam, { kind: "read", outpostId: mac.id }));
    expect(await nam.browserStep({ kind: "read", outpostId: mac.id })).toEqual({ ok: false, error: "too_many_steps" });
    // One that ran out of time no longer counts.
    await patch(s.tenant, `browser-step:${steps[0]?.stepId}`, { expiresAt: past() });
    expect((await nam.browserStep({ kind: "read", outpostId: mac.id })).ok).toBe(true);
  });

  it("shows a step to its own outpost alone, and takes its report from it alone", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const cloud = await outpost(s.tenant, { name: "Cloud outpost", kind: "cloud" });
    const other = fresh("steps:other-shop");
    const foreign = await outpost(other);
    const nam = await attempt(s, "nam");
    const step = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });

    expect(await cloud.take()).toEqual([]);
    expect(await foreign.take()).toEqual([]);
    for (const response of [await mac.steps({ credential: null }), await mac.steps({ credential: cloud.credential }),
      await mac.steps({ credential: `mo1_${"A".repeat(43)}` }), await mac.steps({ credential: "test-key" }),
      await mac.steps({ tenant: other })]) {
      await refusal(response, 401, "unauthorized");
    }
    expect((await mac.take()).map((entry) => entry.stepId)).toEqual([step.stepId]);

    await refusal(await cloud.report(step.stepId, { outcome: "done" }), 403, "wrong_outpost");
    await refusal(await foreign.report(step.stepId, { outcome: "done" }), 404, "step_not_found");
    await refusal(await mac.report(step.stepId, { outcome: "done" }, { credential: null }), 401, "unauthorized");
    await refusal(await mac.report(step.stepId, { outcome: "done" }, { credential: cloud.credential }), 401,
      "unauthorized");
    // Left for its own outpost.
    expect((await mac.report(step.stepId, { outcome: "done" })).status).toBe(200);
    // Nothing anyone tried without the right credential was written to the shop's log.
    expect((await audit(s.tenant)).map((entry) => [entry.action, entry.outcome, entry.reason])).toEqual([
      ["browser_step.queued", "ok", undefined],
      ["browser_step.fetched", "ok", undefined],
      ["browser_step.reported", "refused", "wrong_outpost"],
      ["browser_step.reported", "done", undefined],
    ]);
  });

  it("takes one report per step, for a step it handed out, within its time", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const first = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    await refusal(await mac.report(first.stepId, { outcome: "done" }), 409, "step_not_fetched");
    expect(await mac.take()).toHaveLength(1);
    expect((await mac.report(first.stepId, { outcome: "done" })).status).toBe(200);
    await refusal(await mac.report(first.stepId, { outcome: "failed", code: "timed_out" }), 409, "step_reported");
    expect((await outcome(nam, first.stepId)).state).toBe("done");

    const late = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect(await mac.take()).toHaveLength(1);
    await patch(s.tenant, `browser-step:${late.stepId}`, { expiresAt: past() });
    await refusal(await mac.report(late.stepId, { outcome: "done" }), 409, "step_expired");
    expect(await outcome(nam, late.stepId)).toEqual({ ...late, state: "expired", expiresAt: expect.any(String) });
    await refusal(await mac.report(crypto.randomUUID(), { outcome: "done" }), 404, "step_not_found");
    await refusal(await mac.report("not-a-step", { outcome: "done" }), 404, "step_not_found");
    expect(await landed(s, nam.job.attemptId)).toHaveLength(2);

    expect((await audit(s.tenant)).filter((entry) => entry.action === "browser_step.reported")
      .map((entry) => [entry.outcome, entry.reason])).toEqual([["refused", "step_not_fetched"], ["done", undefined],
      ["refused", "step_reported"], ["refused", "step_expired"], ["refused", "step_not_found"],
      ["refused", "step_not_found"]]);
  });

  it("hands out nothing late: a step nobody took in time reads expired", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const step = await queued(nam, { kind: "read", outpostId: mac.id });
    await patch(s.tenant, `browser-step:${step.stepId}`, { expiresAt: past() });
    expect(await mac.take()).toEqual([]);
    expect((await outcome(nam, step.stepId)).state).toBe("expired");
    expect(await audit(s.tenant)).toHaveLength(1);
  });

  it("reads the switches, consent and the attempt as it hands a step out", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const ton = await attempt(s, "ton");
    const namStep = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    const tonStep = await queued(ton, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect((await nam.finish("done")).ok).toBe(true);
    // Nam's attempt ended, so its step is refused; Ton's still runs, so its step is handed out.
    expect((await mac.take()).map((entry) => entry.stepId)).toEqual([tonStep.stepId]);
    expect((await stepRecords(s.tenant)).find((record) => record.id === namStep.stepId))
      .toMatchObject({ state: "refused", code: "attempt_ended" });

    const waiting = await queued(ton, { kind: "read", outpostId: mac.id });
    await consent(s.tenant, false);
    await refusal(await mac.steps(), 403, "consent_required");
    await consent(s.tenant, true);
    // Refused for good, not handed out once consent is back.
    expect(await mac.take()).toEqual([]);
    expect(await outcome(ton, waiting.stepId)).toEqual({ ...waiting, state: "refused", code: "consent_required" });

    // Each fetch writes the steps it handed out, then those it refused.
    expect((await audit(s.tenant)).filter((entry) => entry.action === "browser_step.fetched")
      .map((entry) => [entry.subject.stepId, entry.outcome, entry.reason])).toEqual([
      [tonStep.stepId, "ok", undefined], [namStep.stepId, "refused", "attempt_ended"],
      [waiting.stepId, "refused", "consent_required"]]);
  });

  it("takes back an outcome when consent or the attempt refuse it as it is reported", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const read = await queued(nam, { kind: "read", outpostId: mac.id });
    expect(await mac.take()).toHaveLength(1);
    await consent(s.tenant, false);
    await refusal(await mac.report(read.stepId, { outcome: "done", text: "Shipped" }), 403, "consent_required");
    await consent(s.tenant, true);
    // What it read is kept nowhere, and nothing landed in the attempt's events.
    expect(await outcome(nam, read.stepId)).toEqual({ ...read, state: "refused", code: "consent_required" });
    expect(JSON.stringify(await stepRecords(s.tenant))).not.toContain("Shipped");
    expect(await landed(s, nam.job.attemptId)).toEqual([]);
    await refusal(await mac.report(read.stepId, { outcome: "done", text: "Shipped" }), 409, "step_reported");

    const open = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect(await mac.take()).toHaveLength(1);
    expect((await nam.finish("done")).ok).toBe(true);
    await refusal(await mac.report(open.stepId, { outcome: "done" }), 409, "attempt_ended");
    expect((await stepRecords(s.tenant)).find((record) => record.id === open.stepId))
      .toMatchObject({ state: "refused", code: "attempt_ended", text: null });
    expect(await landed(s, nam.job.attemptId)).toEqual([]);
  });

  it("withholds a read that holds a sign-in's password, and keeps the text nowhere", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const read = await queued(nam, { kind: "read", outpostId: mac.id });
    expect(await mac.take()).toHaveLength(1);
    const reported = await mac.report(read.stepId, { outcome: "done", text: `Your password is ${PASSWORD}.` });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ step: { stepId: read.stepId, state: "failed" } });
    expect(await outcome(nam, read.stepId)).toEqual({ ...read, state: "failed", code: "text_withheld" });
    expect((await landed(s, nam.job.attemptId)).at(-1)).toEqual({ type: "toolUpdated", id: read.stepId,
      update: { status: "failed", output: "text_withheld" } });
    for (const text of [JSON.stringify(await stepRecords(s.tenant)), JSON.stringify((await exported(s)).events),
      JSON.stringify(await audit(s.tenant))]) {
      expect(text).not.toContain(PASSWORD);
    }
  });

  it("refuses an outpost's waiting steps when it is removed, and leaves other outposts' alone", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const cloud = await outpost(s.tenant, { name: "Cloud outpost", kind: "cloud" });
    const nam = await attempt(s, "nam");
    const running = await queued(nam, { kind: "open", outpostId: mac.id, url: ORDERS });
    expect(await mac.take()).toHaveLength(1);
    const waiting = await queued(nam, { kind: "read", outpostId: mac.id });
    const elsewhere = await queued(nam, { kind: "read", outpostId: cloud.id });

    const removed = await adminFetch(`${API}/v1/admin/outposts/remove`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, outpostId: mac.id }) });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, outpostId: mac.id, stepsRefused: 2, grantsRefused: 0 });
    for (const step of [running, waiting]) {
      expect(await outcome(nam, step.stepId)).toEqual({ ...step, state: "refused", code: "outpost_removed" });
    }
    expect((await outcome(nam, elsewhere.stepId)).state).toBe("queued");
    await refusal(await mac.report(running.stepId, { outcome: "done" }), 401, "unauthorized");
    await refusal(await mac.steps(), 401, "unauthorized");
  });

  it("is reached only through exact routes", async () => {
    for (const [method, path] of [["GET", "/v1/outposts/steps"], ["PUT", "/v1/outposts/steps"],
      ["GET", "/v1/outposts/steps/report"], ["POST", "/v1/outposts/steps/other"]] as const) {
      expect((await sourceWorker.fetch(`${API}${path}`, { method,
        ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }) })).status).toBe(404);
    }
  });

  it("goes with the shop's deletion", async () => {
    const s = await shop();
    await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    await queued(await attempt(s, "nam"), { kind: "read", outpostId: mac.id });
    expect(await stepRecords(s.tenant)).toHaveLength(1);
    const deleted = await sourceWorker.fetch(`${API}/v1/tenant/data`, { method: "DELETE",
      headers: await tenantSession(s.tenant) });
    expect(deleted.status).toBe(200);
    expect(await stepRecords(s.tenant)).toEqual([]);
  });

  it("keeps the password out of every step, event, audit entry, answer, log and export but the redeem", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    const answers: string[] = [];
    const kept = async (response: Response) => {
      answers.push(await response.clone().text());
      return response;
    };
    const s = await shop();
    const signInId = await addSignIn(s.tenant);
    const mac = await outpost(s.tenant);
    const nam = await attempt(s, "nam");
    const grantId = await grantOf(nam, signInId, mac.id);
    const asked = [
      await nam.browserStep({ kind: "open", outpostId: mac.id, url: "https://accounts.shopee.co.th/seller/login" }),
      await nam.browserStep({ kind: "sign_in", outpostId: mac.id, grantId }),
      await nam.browserStep({ kind: "read", outpostId: mac.id, selector: ".order-status" }),
      await nam.browserStep({ kind: "read", outpostId: mac.id }),
    ];
    answers.push(JSON.stringify(asked));
    const steps = ((await (await kept(await mac.steps())).json()) as { steps: OutpostStep[] }).steps;
    expect(steps).toHaveLength(4);
    // The one answer that holds it: the redeem, to the outpost its grant names, once.
    const redeemed = await mac.redeem(grantId);
    expect(((await redeemed.json()) as { password: string }).password).toBe(PASSWORD);
    const [opened, signedIn, status, page] = steps;
    await kept(await mac.report(opened?.stepId ?? "", { outcome: "done" }));
    await kept(await mac.report(signedIn?.stepId ?? "", { outcome: "done" }));
    await kept(await mac.report(status?.stepId ?? "", { outcome: "done", text: "Shipped" }));
    // A page that showed the password, or an outpost that read it back by mistake: withheld.
    await kept(await mac.report(page?.stepId ?? "", { outcome: "done", text: `password ${PASSWORD}` }));
    await kept(await mac.report(page?.stepId ?? "", { outcome: "done", text: `password ${PASSWORD}` }));
    for (const step of steps) answers.push(JSON.stringify(await nam.browserStepOutcome(step.stepId)));
    await kept(await mac.steps());
    answers.push(JSON.stringify(await nam.finish("done")));
    await kept(await adminFetch(`${API}/v1/admin/outposts/credential`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, outpostId: mac.id }) }));
    const exportedShop = await kept(await SELF.fetch(`${API}/v1/tenant/export`,
      { headers: await tenantSession(s.tenant) }));
    expect(exportedShop.status).toBe(200);
    const events = JSON.stringify((await exported(s)).events);
    expect(events).toContain("Shipped");
    const auditLog = await (await tenantCall(bindings, s.tenant, `/audit/export?tenant=${encodeURIComponent(s.tenant)}`))
      .text();
    expect(auditLog).toContain("browser_step.reported");
    // Everything the vault keeps, read raw: the sign-in holds only its seal.
    const stored = await runInDurableObject(vault(s.tenant), async (_instance, state) =>
      JSON.stringify([...(await state.storage.list()).values()]));
    await kept(await adminFetch(`${API}/v1/admin/outposts/remove`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, outpostId: mac.id }) }));

    const digest = await sha256Hex(mac.credential);
    for (const text of [...answers, events, auditLog, ...logged]) {
      for (const secret of [PASSWORD, mac.credential, digest]) expect(text).not.toContain(secret);
    }
    // The vault keeps an outpost's digest by design; never a password in the clear.
    for (const text of [stored, JSON.stringify(await stepRecords(s.tenant))]) expect(text).not.toContain(PASSWORD);
  });
});

describe("a worker's list of the shop's sign-ins", () => {
  it("names only the sign-ins its member may use, by site, and nothing of the account", async () => {
    const s = await shop();
    const shopee = await addSignIn(s.tenant, { members: ["nam", "ton"] });
    await addSignIn(s.tenant, { members: ["ton"], site: "Lazada Seller Center",
      origins: ["https://sellercenter.lazada.co.th"] });
    const listed = await (await attempt(s, "nam")).signIns();
    expect(listed).toEqual({ ok: true, value: { signIns: [{ signInId: shopee, site: SITE, origins: ORIGINS,
      state: "working" }] } });
    expect(JSON.stringify(listed)).not.toContain(USERNAME);
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    expect(JSON.stringify(listed)).not.toContain("members");
  });

  it("lists every sign-in a member is named on, oldest first, a broken one as broken and a removed one not at all", async () => {
    const s = await shop();
    const shopee = await addSignIn(s.tenant, { members: ["ton"] });
    // "Oldest first" is by the time a sign-in was made, to the millisecond, and two sign-ins made in the same one fall
    // back to their random ids. A Worker's clock moves only between requests, so two adds in a row can share a
    // millisecond; the second waits a few so the order this test checks is the order they were made.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const lazada = await addSignIn(s.tenant, { members: ["ton"], site: "Lazada Seller Center",
      origins: ["https://sellercenter.lazada.co.th"] });
    const removed = await addSignIn(s.tenant, { members: ["ton"], site: "Old shop" });
    expect((await adminFetch(`${API}/v1/admin/vault/sign-ins/remove`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant: s.tenant, signInId: removed }) })).status).toBe(200);
    const port = await attempt(s, "ton");
    expect((await port.signInBroken(lazada)).ok).toBe(true);
    const listed = await port.signIns();
    expect(listed.ok && listed.value.signIns.map(({ signInId, state }) => ({ signInId, state }))).toEqual([
      { signInId: shopee, state: "working" }, { signInId: lazada, state: "broken" }]);
  });

  it("is refused, as every browser call is, while cloud work is off", async () => {
    const s = await shop();
    await addSignIn(s.tenant, { members: ["nam"] });
    const off: JobFlags = async () => ({ officeCloud: false, officeExternalWrites: false });
    const listed = await (await attempt(s, "nam", off)).signIns();
    expect(listed.ok).toBe(false);
  });
});
