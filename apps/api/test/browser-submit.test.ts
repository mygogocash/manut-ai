import { adminFetch, tenantSession, trustedTaskPut } from "./authenticated-fixtures";
import { call, decide, setFlags } from "./people-fixtures";
import { sourceWorker } from "./source-worker";
import { env, runInDurableObject } from "cloudflare:test";
import { mayDecide, type ApprovalRecord, type Standing } from "@manut/approval-core";
import { DEFAULT_ROSTER } from "@manut/member-grants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import {
  BROWSER_SUBMIT,
  SUBMIT_ACTIONS,
  SUBMIT_JOBS,
  SUBMIT_KINDS,
  submitKind,
  type SubmitDetail,
  type SubmitWrite,
} from "../src/browser-writes";
import type { Env } from "../src/index";
import { dispatchApproved, startAttempt, workerPort, type JobFlags, type WorkerPort } from "../src/job-flow";
import type { BrowserStepView, NewBrowserStep } from "../src/sign-in-vault";
import type { ActionProposalJSON, AttemptJSON, DraftJSON, TaskEventJSON } from "../src/task-object";
import { tenantCall } from "../src/tenant-data";

// Submitting through a browser (docs/browser-control.md, "Reading by default, and asking before submitting"): a step
// that writes goes through member-grants' decide and one approval-core request naming the exact action, and is handed to
// its outpost once, through the same one-use begin gate the broker uses. The outpost's side is a stub: no browser and
// no site. The global fetch answers 599 for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const flowEnv = { ...bindings, MODEL_PROVIDER: "stand-in" } as Env & { MODEL_PROVIDER: string };
const on: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: true });
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
const SITE = "Shopee Seller Centre";
const SELLER = "https://seller.shopee.co.th";
const ORIGINS = [SELLER, "https://accounts.shopee.co.th"];
const CHAT = `${SELLER}/portal/chat/2291`;
const RETURNS = `${SELLER}/portal/sale/return/2291`;
const DAY_MS = 24 * 60 * 60 * 1000;

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect((await setFlags({ officeCloud: true, officeExternalWrites: true })).status).toBe(200);
});

/// Nam's reply in the site's chat: one value, typed into the message box, then the reply form sent.
function reply(signInId: string): SubmitWrite {
  return { action: "send_reply", signInId, url: CHAT, form: "form.chat-reply",
    values: [{ field: "textarea[name=\"message\"]", value: "ขอบคุณค่ะ พัสดุส่งแล้วนะคะ" }] };
}

/// Ton's refund: an amount, a reason chosen from a list, and a note with quotes and a line break in it.
function refund(signInId: string): SubmitWrite {
  return { action: "refund", signInId, url: RETURNS, form: "form#refund", values: [
    { field: "input[name=\"amount\"]", value: "500.00" },
    { field: "select[name=\"reason\"]", value: "damaged" },
    { field: "textarea[name=\"note\"]", value: "Parcel \"SP-2291\" arrived broken.\nRefund in full." },
  ] };
}

type Shop = { tenant: string; taskId: string };

/// A shop with consent given and one draft task, indexed for export and deletion.
async function shop(): Promise<Shop> {
  const tenant = fresh("submit:shop");
  const taskId = fresh("submit-task");
  await consent(tenant, true);
  expect((await tenantCall(bindings, tenant, "/index", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, taskId }) })).status).toBe(200);
  expect((await trustedTaskPut(taskId, { id: taskId, title: "Customer care", objective: "Answer the customer.",
    state: "draft", location: "cloud", funding: "cloudBYOK", criteria: [], updatedAt: new Date().toISOString() },
  tenant)).status).toBe(200);
  return { tenant, taskId };
}

async function consent(tenant: string, cloudWork: boolean) {
  expect((await tenantCall(bindings, tenant, "/consent", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant, cloudWork }) })).status).toBe(200);
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

function vault(tenant: string) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
}

async function exported(s: Shop) {
  const response = await task(s.taskId).fetch(new Request("https://task/export", { headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { events: TaskEventJSON[]; attempts: AttemptJSON[]; actions: ActionProposalJSON[];
    requests: ApprovalRecord[]; drafts: DraftJSON[] };
}

/// A request and its action, as the task object holds them now.
async function stored(s: Shop, requestId: string) {
  const response = await task(s.taskId).fetch(new Request(`https://task/requests/${requestId}`,
    { headers: { "x-tenant": s.tenant } }));
  expect(response.status).toBe(200);
  return (await response.json()) as { record: ApprovalRecord; standing: Standing; action: ActionProposalJSON };
}

/// What the control plane landed in the attempt's events for its outposts, oldest first.
async function landed(s: Shop, attemptId: string): Promise<unknown[]> {
  return (await exported(s)).events.filter((entry) => entry.via === `attempt:outpost:${attemptId}`)
    .map((entry) => entry.event);
}

/// A sign-in for Nam and Ton, added `daysAgo` days ago: a site's practice mode runs three days from when its sign-in was
/// added, so one added today only drafts.
async function addSignIn(tenant: string, options: { members?: string[]; daysAgo?: number } = {}): Promise<string> {
  const response = await adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, site: SITE, origins: ORIGINS, username: "baan.mali@example.com",
      password: `pw-${crypto.randomUUID()}`, members: options.members ?? ["nam", "ton"] }) });
  expect(response.status).toBe(200);
  const signInId = ((await response.json()) as { signIn: { id: string } }).signIn.id;
  const daysAgo = options.daysAgo ?? 4;
  if (daysAgo > 0) {
    await patchVault(tenant, `signin:${signInId}`, { createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString() });
  }
  return signInId;
}

/// Changes a stored record of the shop's vault, as time passing would.
async function patchVault(tenant: string, key: string, change: Record<string, unknown>) {
  await runInDurableObject(vault(tenant), async (_instance, state) => {
    const record = await state.storage.get<Record<string, unknown>>(key);
    await state.storage.put(key, { ...record, ...change });
  });
}

/// Every browser step the shop's vault holds, as stored.
async function stepRecords(tenant: string): Promise<Record<string, unknown>[]> {
  return runInDurableObject(vault(tenant), async (_instance, state) =>
    [...(await state.storage.list<Record<string, unknown>>({ prefix: "browser-step:" })).values()]);
}

type OutpostStep = Record<string, unknown> & { stepId: string; kind: string };

/// The outpost's side, played by a stub: it beats, asks for its steps and reports them, with its own credential.
class StubOutpost {
  constructor(readonly tenant: string, readonly id: string, readonly credential: string) {}

  private call(path: string, body: Record<string, unknown>) {
    return sourceWorker.fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${this.credential}` }, body: JSON.stringify({ tenant: this.tenant, outpostId: this.id,
      ...body }) });
  }

  beat() {
    return this.call("/v1/outposts/heartbeat", {});
  }

  steps() {
    return this.call("/v1/outposts/steps", {});
  }

  report(stepId: string, report: Record<string, unknown>) {
    return this.call("/v1/outposts/steps/report", { stepId, ...report });
  }

  /// The steps handed to it now.
  async take(): Promise<OutpostStep[]> {
    const response = await this.steps();
    expect(response.status).toBe(200);
    return ((await response.json()) as { steps: OutpostStep[] }).steps;
  }
}

async function outpost(tenant: string, options: { name?: string; kind?: string } = {}) {
  const response = await adminFetch(`${API}/v1/admin/outposts`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, name: options.name ?? "This Mac", kind: options.kind ?? "this_mac" }) });
  expect(response.status).toBe(200);
  const { outpost: registered, credential } = (await response.json()) as { outpost: { id: string }; credential: string };
  const stub = new StubOutpost(tenant, registered.id, credential);
  expect((await stub.beat()).status).toBe(200);
  return stub;
}

/// A shop whose sign-in is past its practice days, with an online outpost.
async function ready() {
  const s = await shop();
  const signInId = await addSignIn(s.tenant);
  const mac = await outpost(s.tenant);
  return { s, signInId, mac };
}

async function asked(port: WorkerPort, write: SubmitWrite): Promise<string> {
  const answer = await port.askSubmit(write);
  if (!answer.ok || answer.value.outcome !== "asked") throw new Error(`not_asked_${JSON.stringify(answer)}`);
  return answer.value.requestId;
}

/// The owner approves (or declines) from the shop's own session, as the desktop's answering slice does.
async function ownerDecides(s: Shop, requestId: string, optionId = "approve") {
  const decided = await decide(await tenantSession(s.tenant), requestId, { optionId, seenRevision: 1 });
  expect(decided.status).toBe(200);
  return decided.body;
}

const submit = (outpostId: string, requestId: string, revision = 1): NewBrowserStep =>
  ({ kind: "submit", outpostId, requestId, revision });

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

/// The task object's begin gate, called as the control plane calls it at a hand-out.
function begin(s: Shop, requestId: string, body: Record<string, unknown>, headers: Record<string, string> =
  { "x-control": "1" }) {
  return task(s.taskId).fetch(new Request(`https://task/actions/${requestId}/begin`, { method: "POST",
    headers: { "content-type": "application/json", "x-tenant": s.tenant, ...headers },
    body: JSON.stringify({ grantRevision: 1, revision: 1, ...body }) }));
}

/// The shop's audit entries for asks, decisions, steps and dispatches, oldest first, without their ids and times.
async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said)
    .filter((entry) => /^(approval|browser_step|dispatch)\./.test(entry.action));
}

async function refusal(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

describe("the table from a write's action to its approval kind", () => {
  it("takes every kind from the action, and lets only a private reply be decided by a helper or from a notification",
    () => {
      expect(SUBMIT_KINDS).toEqual({ send_reply: "reply", place_order: "money", change_order: "money", refund: "money",
        publish_post: "public_post", change_setting: "command" });
      // decide's kind for the job each action is agrees with the table, so the two can never drift apart unseen.
      for (const action of SUBMIT_ACTIONS) {
        const job = DEFAULT_ROSTER.flatMap((member) => member.capabilities).find((c) => c.id === SUBMIT_JOBS[action]);
        expect(job).toMatchObject({ access: "write", kind: SUBMIT_KINDS[action], needsConnection: true });
      }
      // A helper decides `message` and `reply` only, and only those may be approved from a notification
      // (@manut/notify-rules): of the actions, only a private reply in a conversation a customer started.
      expect(SUBMIT_ACTIONS.filter((action) => mayDecide("helper", SUBMIT_KINDS[action]))).toEqual(["send_reply"]);
      // A kind that is unclear is the owner's only.
      for (const unclear of ["answer_review", "SEND_REPLY", "", undefined, 42, "constructor", "toString"]) {
        expect(submitKind(unclear)).toBe("command");
      }
    });
});

describe("asking to submit", () => {
  it("raises one approval-core request naming the site, the page and every value, of the table's kind", async () => {
    const { s, signInId } = await ready();
    const ton = await attempt(s, "ton");
    const { attemptId } = ton.job;
    const write = refund(signInId);
    const answer = await ton.askSubmit(write);
    expect(answer).toEqual({ ok: true, value: { outcome: "asked", requestId: expect.any(String), kind: "money",
      revision: 1, expiresAt: expect.any(String) } });
    if (!answer.ok || answer.value.outcome !== "asked") throw new Error("not_asked");
    const { requestId } = answer.value;

    const { record, standing, action } = await stored(s, requestId);
    expect(standing).toEqual({ state: "open", reason: "waiting" });
    expect(record.status).toBe("pending");
    expect(record.request).toMatchObject({ id: requestId, kind: "money", revision: 1, attemptId });
    const detail = record.request.detail as SubmitDetail;
    expect(detail).toEqual({ actionId: requestId, operationType: BROWSER_SUBMIT, action: "refund", site: SITE, signInId,
      origin: SELLER, url: RETURNS, form: "form#refund", values: write.values, text: expect.any(String),
      payloadHash: action.payloadHash });
    // The words the owner reads name the site, the page, the form and every value, each exactly as it will be typed.
    expect(detail.text).toBe(`Make a refund on ${SITE} (${SELLER}). On ${RETURNS}, set input[name="amount"] to ` +
      `"500.00", set select[name="reason"] to "damaged", set textarea[name="note"] to ` +
      `"Parcel \\"SP-2291\\" arrived broken.\\nRefund in full.", then submit form#refund.`);
    for (const { field, value } of write.values) {
      expect(detail.text).toContain(field);
      expect(detail.text).toContain(JSON.stringify(value));
    }
    // The exact action is stored as an immutable proposal, decided only through its request.
    expect(action).toMatchObject({ id: requestId, operationType: BROWSER_SUBMIT, connectionId: signInId,
      targetResourceId: SELLER, payload: { action: "refund", site: SITE, signInId, url: RETURNS, form: "form#refund",
        values: write.values }, state: "proposed", requestId });
    // It is listed for the owner like any other approval, and nothing is queued for an outpost.
    const listed = await call("/v1/approvals?state=open", { headers: await tenantSession(s.tenant) });
    expect(((await listed.json()) as { approvals: { record: { request: { id: string; kind: string } } }[] }).approvals
      .map((entry) => [entry.record.request.id, entry.record.request.kind])).toEqual([[requestId, "money"]]);
    expect(await stepRecords(s.tenant)).toEqual([]);
    expect(await audit(s.tenant)).toEqual([{ actor: { kind: "worker", attemptId }, action: "approval.requested",
      subject: { taskId: s.taskId, attemptId, signInId, requestId, actionId: requestId }, outcome: "ok" }]);
  });

  it("stops at member-grants' decide: not my job, not connected and refused raise nothing", async () => {
    const { s, signInId } = await ready();
    const nam = await attempt(s, "nam");
    // Refunds are Ton's job, so Nam is told whose it is.
    expect(await nam.askSubmit(refund(signInId))).toEqual({ ok: false, error: "not_my_job", member: "ton" });
    // A sign-in that does not exist, or one the site refused, is no connection to write through.
    expect(await nam.askSubmit(reply(crypto.randomUUID()))).toEqual({ ok: false, error: "not_connected" });
    const broken = await addSignIn(s.tenant);
    expect((await nam.signInBroken(broken)).ok).toBe(true);
    expect(await nam.askSubmit(reply(broken))).toEqual({ ok: false, error: "not_connected" });
    // An attempt for someone the roster does not know is refused, never guessed.
    const stranger = await attempt(s, "stand-in");
    expect(await stranger.askSubmit(reply(signInId))).toEqual({ ok: false, error: "unknown_member" });

    const after = await exported(s);
    expect(after.actions).toEqual([]);
    expect(after.requests).toEqual([]);
    expect(after.drafts).toEqual([]);
    expect((await audit(s.tenant)).map((entry) => [entry.action, entry.outcome, entry.reason])).toEqual([
      ["approval.requested", "refused", "not_my_job"],
      ["approval.requested", "refused", "not_connected"],
      ["approval.requested", "refused", "not_connected"],
      ["approval.requested", "refused", "unknown_member"],
    ]);
  });

  it("makes a draft and no request while the site is in practice mode", async () => {
    const s = await shop();
    const signInId = await addSignIn(s.tenant, { daysAgo: 0 });
    const nam = await attempt(s, "nam");
    const write = reply(signInId);
    const answer = await nam.askSubmit(write);
    expect(answer).toEqual({ ok: true, value: { outcome: "draft_only", kind: "reply", draft: {
      attemptId: nam.job.attemptId, member: "nam", job: "send_reply", text: expect.any(String), about: { signInId },
      send: { answer: "draft_only", kind: "reply" }, at: expect.any(String) } } });
    if (!answer.ok || answer.value.outcome !== "draft_only") throw new Error("no_draft");
    // The draft says exactly what would have been submitted, for the owner to read.
    expect(answer.value.draft.text).toBe(`Send a reply on ${SITE} (${SELLER}). On ${CHAT}, set ` +
      `textarea[name="message"] to "ขอบคุณค่ะ พัสดุส่งแล้วนะคะ", then submit form.chat-reply.`);
    const after = await exported(s);
    expect(after.actions).toEqual([]);
    expect(after.drafts).toEqual([answer.value.draft]);
    // One draft per attempt, as for every draft.
    expect(await nam.askSubmit(write)).toEqual({ ok: false, error: "draft_exists" });
    expect((await audit(s.tenant)).map((entry) => [entry.action, entry.outcome, entry.reason])).toEqual([
      ["approval.requested", "skipped", "draft_only"],
      ["approval.requested", "refused", "draft_exists"],
    ]);
  });

  it("takes the kind from the action alone: a kind the worker names is refused", async () => {
    const { s, signInId } = await ready();
    const ton = await attempt(s, "ton");
    for (const kind of ["reply", "message", "money"]) {
      expect(await ton.askSubmit({ ...refund(signInId), kind } as unknown as SubmitWrite))
        .toEqual({ ok: false, error: "invalid_write" });
    }
    // The task object, too, sets the kind itself and refuses a body that names one.
    const write = refund(signInId);
    const direct = (extra: Record<string, unknown>) => task(s.taskId).fetch(new Request(
      `https://task/attempts/${ton.job.attemptId}/ask-submit`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": s.tenant },
        body: JSON.stringify({ fence: ton.job.fence, write, site: SITE,
          expiresAt: new Date(Date.now() + DAY_MS).toISOString(), ...extra }) }));
    await refusal(await direct({ kind: "reply" }), 400, "invalid_request");
    expect((await exported(s)).actions).toEqual([]);
    // Without one it opens the request with the table's kind for a refund, whoever asks.
    const opened = await direct({});
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { request: { kind: string } }).request.kind).toBe("money");
    // An action off the list has no kind at all: it is refused before anyone is asked.
    expect(await ton.askSubmit({ ...refund(signInId), action: "wire_money" } as unknown as SubmitWrite))
      .toEqual({ ok: false, error: "unknown_action" });
  });

  it("refuses a write that is not something an outpost can run and an owner can read word for word", async () => {
    const { s, signInId } = await ready();
    const nam = await attempt(s, "nam");
    const base = reply(signInId);
    const field = base.values[0]!;
    for (const write of [
      { ...base, url: "http://seller.shopee.co.th/portal/chat/2291" },
      { ...base, url: "https://fon:secret@seller.shopee.co.th/portal" },
      { ...base, url: "not a url" },
      { ...base, form: "" },
      { ...base, form: "form\nbutton" },
      { ...base, values: "hello" },
      { ...base, values: [{ field: "", value: "hi" }] },
      { ...base, values: [{ field: "textarea", value: 42 }] },
      { ...base, values: [{ field: "textarea", value: "a\u0000b" }] },
      { ...base, values: [{ field: "textarea", value: "x".repeat(5_001) }] },
      { ...base, values: [field, field] },
      { ...base, values: [{ ...field, label: "Message" }] },
      { ...base, values: Array.from({ length: 21 }, (_, i) => ({ field: `input#f${i}`, value: "1" })) },
      // Each value within its 5,000 characters, but the whole write over 12 KB as JSON.
      { ...base, values: Array.from({ length: 4 }, (_, i) => ({ field: `input#f${i}`, value: "x".repeat(3_500) })) },
      { ...base, note: "and also" },
      { ...base, signInId: "not-a-sign-in" },
      "send it",
    ]) {
      expect(await nam.askSubmit(write as unknown as SubmitWrite)).toEqual({ ok: false, error: "invalid_write" });
    }
    // Only a page on one of its sign-in's origins, and only a sign-in its member is named on.
    expect(await nam.askSubmit({ ...base, url: "https://evil.example/chat" }))
      .toEqual({ ok: false, error: "origin_not_allowed" });
    const pims = await addSignIn(s.tenant, { members: ["pim"] });
    expect(await nam.askSubmit(reply(pims))).toEqual({ ok: false, error: "member_not_allowed" });
    expect((await exported(s)).actions).toEqual([]);
    // Nothing the worker wrote but ids goes into the log.
    expect(JSON.stringify(await audit(s.tenant))).not.toContain("evil.example");
  });

  it("needs the external-writes switch and the owner's consent", async () => {
    const { s, signInId } = await ready();
    const off: JobFlags = async () => ({ officeCloud: true, officeExternalWrites: false });
    const nam = await attempt(s, "nam", off);
    expect(await nam.askSubmit(reply(signInId))).toEqual({ ok: false, error: "feature_disabled" });
    const withdrawn = await attempt(s, "nam");
    await consent(s.tenant, false);
    expect(await withdrawn.askSubmit(reply(signInId))).toEqual({ ok: false, error: "consent_required" });
    expect((await exported(s)).actions).toEqual([]);
  });
});

describe("queuing a write step", () => {
  it("needs a request approved at the revision it names, not yet begun, and queues it once", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;
    expect(await nam.browserStep(submit(mac.id, crypto.randomUUID()))).toEqual({ ok: false, error: "request_not_found" });
    const waiting = await asked(nam, reply(signInId));
    expect(await nam.browserStep(submit(mac.id, waiting))).toEqual({ ok: false, error: "not_approved" });
    const declined = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value: "No." }] });
    expect((await ownerDecides(s, declined, "decline")).action).toBe("rejected");
    expect(await nam.browserStep(submit(mac.id, declined))).toEqual({ ok: false, error: "not_approved" });

    const approved = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value: "Yes." }] });
    expect((await ownerDecides(s, approved)).action).toBe("approved");
    // A step names the revision it was approved at; any other is refused.
    expect(await nam.browserStep(submit(mac.id, approved, 2))).toEqual({ ok: false, error: "request_changed" });
    for (const step of [{ kind: "submit", outpostId: mac.id, requestId: approved },
      { kind: "submit", outpostId: mac.id, requestId: approved, revision: 0 },
      { kind: "submit", outpostId: mac.id, requestId: approved, revision: 1, url: CHAT },
      { kind: "submit", outpostId: mac.id, requestId: approved, revision: 1, values: [] },
      { kind: "submit", outpostId: mac.id, url: CHAT }]) {
      expect(await nam.browserStep(step as unknown as NewBrowserStep)).toEqual({ ok: false, error: "invalid_request" });
    }
    const step = await queued(nam, submit(mac.id, approved));
    expect(step).toEqual({ stepId: expect.any(String), kind: "submit", outpostId: mac.id, state: "queued",
      queuedAt: expect.any(String), expiresAt: expect.any(String), url: CHAT, signInId, requestId: approved });
    // One step at a time carries a request.
    expect(await nam.browserStep(submit(mac.id, approved))).toEqual({ ok: false, error: "request_queued" });
    expect((await stepRecords(s.tenant)).map((record) => record.id)).toEqual([step.stepId]);

    // A request that is not a browser write is not one a step can carry.
    const linear = await adminFetch(`${API}/v1/admin/connections`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenantId: s.tenant, provider: "linear", accountId: "ws-submit", scopes: ["write"],
        refreshToken: "linear-vault-token-submit", resourceIds: ["ws/submit"], allowsActions: true }) });
    expect(linear.status).toBe(200);
    const issue = await nam.ask({ operationType: "linear.issue.create", targetResourceId: "ws/submit",
      payload: { title: "Late parcel" } });
    if (!issue.ok) throw new Error(`issue_not_asked_${issue.error}`);
    expect(await nam.browserStep(submit(mac.id, issue.value.requestId)))
      .toEqual({ ok: false, error: "request_not_found" });

    const refusedQueues = (await audit(s.tenant)).filter((entry) => entry.action === "browser_step.queued");
    expect(refusedQueues.map((entry) => [entry.outcome, entry.reason])).toEqual([
      ["refused", "request_not_found"], ["refused", "not_approved"], ["refused", "not_approved"],
      ["refused", "request_changed"], ["refused", "invalid_request"], ["refused", "invalid_request"],
      ["refused", "invalid_request"], ["refused", "invalid_request"], ["refused", "invalid_request"],
      ["ok", undefined], ["refused", "request_queued"], ["refused", "request_not_found"]]);
    expect(refusedQueues[9]).toEqual({ actor: { kind: "worker", attemptId }, action: "browser_step.queued",
      subject: { stepId: step.stepId, outpostId: mac.id, taskId: s.taskId, attemptId, signInId, requestId: approved,
        actionId: approved }, outcome: "ok" });
  });

  it("is never a read: a worker cannot write through the read steps or the broker's asks", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    for (const kind of ["click", "type", "post", ""]) {
      expect(await nam.browserStep({ kind, outpostId: mac.id, url: CHAT } as unknown as NewBrowserStep))
        .toEqual({ ok: false, error: "step_kind_not_allowed" });
    }
    expect(await nam.ask({ operationType: BROWSER_SUBMIT, targetResourceId: SELLER,
      payload: { ...reply(signInId) } })).toEqual({ ok: false, error: "unsupported_operation" });
    // Nor can a session propose one: only a worker's ask stores a browser write, with its request.
    const proposed = await call(`/v1/tasks/${s.taskId}/actions`, { method: "POST",
      headers: { ...(await tenantSession(s.tenant)), "content-type": "application/json" },
      body: JSON.stringify({ connectionId: signInId, providerAccountId: signInId, operationType: BROWSER_SUBMIT,
        targetResourceId: SELLER, resourceScope: [SELLER], payload: reply(signInId), grantRevision: 1,
        expiresAt: new Date(Date.now() + DAY_MS).toISOString() }) });
    await refusal(proposed, 400, "unknown_operation");
    expect(await stepRecords(s.tenant)).toEqual([]);
    expect((await exported(s)).actions).toEqual([]);
  });
});

describe("a write step end to end", () => {
  it("goes from the ask to one submit on the page: decided by the owner, handed out once, run once", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const { attemptId } = nam.job;
    const write = reply(signInId);
    const requestId = await asked(nam, write);

    // Approved from the owner's session; nothing is begun until its step is handed to an outpost.
    expect(await ownerDecides(s, requestId)).toMatchObject({ result: { ok: true }, action: "approved" });
    const step = await queued(nam, submit(mac.id, requestId));

    // The outpost receives exactly what the owner approved, and nothing else: no request, no member, no secret.
    const handed = await mac.take();
    expect(handed).toEqual([{ stepId: step.stepId, kind: "submit", action: "send_reply", url: CHAT,
      form: "form.chat-reply", values: write.values, origins: [SELLER], expiresAt: step.expiresAt }]);
    expect(await mac.take()).toEqual([]);
    expect((await stored(s, requestId)).action.state).toBe("dispatching");
    expect((await outcome(nam, step.stepId)).state).toBe("taken");

    const reported = await mac.report(step.stepId, { outcome: "done" });
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ step: { stepId: step.stepId, state: "done" } });
    expect((await stored(s, requestId)).action).toMatchObject({ state: "confirmed",
      dispatch: { providerOperationId: step.stepId, receipt: { stepId: step.stepId, outpostId: mac.id } } });
    expect(await nam.outcome(requestId)).toEqual({ ok: true, value: { standing: "decided", reason: "decided",
      approved: true, action: "confirmed", providerOperationId: step.stepId } });
    expect(await outcome(nam, step.stepId)).toEqual({ ...step, state: "done" });
    expect(await landed(s, attemptId)).toEqual([
      { type: "toolStarted", id: step.stepId, call: { kind: "web", title: `Send a reply on ${SITE}`, output: "",
        status: "running", edits: [], startedAt: step.queuedAt } },
      { type: "toolUpdated", id: step.stepId, update: { status: "completed", output: "" } },
    ]);
    // Once is all: a second report is refused, and the write cannot be begun again.
    await refusal(await mac.report(step.stepId, { outcome: "done" }), 409, "step_reported");
    await refusal(await begin(s, requestId, { attemptId }), 409, "already_settled");

    const bound = { stepId: step.stepId, outpostId: mac.id, taskId: s.taskId, attemptId, signInId, requestId,
      actionId: requestId };
    const outpostActor = { kind: "outpost", id: mac.id };
    const entries = await audit(s.tenant);
    expect(entries).toEqual([
      { actor: { kind: "worker", attemptId }, action: "approval.requested",
        subject: { taskId: s.taskId, attemptId, signInId, requestId, actionId: requestId }, outcome: "ok" },
      { actor: { kind: "owner", id: "owner-session" }, action: "approval.decided",
        subject: { taskId: s.taskId, attemptId, requestId, actionId: requestId }, outcome: "approved" },
      { actor: { kind: "worker", attemptId }, action: "browser_step.queued", subject: bound, outcome: "ok" },
      { actor: { kind: "system" }, action: "dispatch.started", subject: { taskId: s.taskId, actionId: requestId },
        outcome: "ok" },
      { actor: outpostActor, action: "browser_step.fetched", subject: bound, outcome: "ok" },
      { actor: { kind: "system" }, action: "dispatch.settled", subject: { taskId: s.taskId, actionId: requestId },
        outcome: "confirmed" },
      { actor: outpostActor, action: "browser_step.reported", subject: bound, outcome: "done" },
      { actor: outpostActor, action: "browser_step.reported", subject: bound, outcome: "refused",
        reason: "step_reported" },
    ]);
    // Never what was typed: not in the log, the vault's step, or the events' titles.
    const log = await (await tenantCall(bindings, s.tenant, `/audit/export?tenant=${encodeURIComponent(s.tenant)}`))
      .text();
    for (const text of [log, JSON.stringify(await stepRecords(s.tenant)), JSON.stringify(await landed(s, attemptId))]) {
      for (const { value } of write.values) expect(text).not.toContain(value);
    }
  });

  it("hands the outpost exactly the values the request names, however many and whatever they hold", async () => {
    const { s, signInId, mac } = await ready();
    const ton = await attempt(s, "ton");
    const write = refund(signInId);
    const requestId = await asked(ton, write);
    const named = ((await stored(s, requestId)).record.request.detail as SubmitDetail).text;
    await ownerDecides(s, requestId);
    const step = await queued(ton, submit(mac.id, requestId));
    const [handed] = await mac.take();
    expect(Object.keys(handed ?? {}).sort()).toEqual(["action", "expiresAt", "form", "kind", "origins", "stepId",
      "url", "values"]);
    expect(handed).toMatchObject({ stepId: step.stepId, action: "refund", url: RETURNS, form: "form#refund" });
    // Every value handed out is one the owner read, in the same order, and no other.
    expect(handed?.values).toEqual(write.values);
    for (const { field, value } of handed?.values as { field: string; value: string }[]) {
      expect(named).toContain(`set ${field} to ${JSON.stringify(value)}`);
    }
    expect((await mac.report(step.stepId, { outcome: "done" })).status).toBe(200);
  });
});

describe("handing a write step out", () => {
  it("hands it out once and begins it once, even when the outpost asks twice at the same time", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const step = await queued(nam, submit(mac.id, requestId));
    const answers = await Promise.all([mac.steps(), mac.steps()]);
    const handed: OutpostStep[] = [];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      handed.push(...((await answer.json()) as { steps: OutpostStep[] }).steps);
    }
    expect(handed.map((entry) => entry.stepId)).toEqual([step.stepId]);
    expect((await audit(s.tenant)).filter((entry) => entry.action === "dispatch.started")).toHaveLength(1);
    // The begin gate itself is one-use, however many begins arrive at once.
    const nextId = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value: "Again" }] });
    await ownerDecides(s, nextId);
    const begins = await Promise.all([begin(s, nextId, { attemptId: nam.job.attemptId }),
      begin(s, nextId, { attemptId: nam.job.attemptId })]);
    expect(begins.map((response) => response.status).sort()).toEqual([200, 409]);
    await refusal(await begin(s, nextId, { attemptId: nam.job.attemptId }), 409, "dispatch_in_flight");
  });

  it("is begun only as its step is handed out: no session, broker or read begins it", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const { attemptId } = nam.job;
    // The broker's send after a decision, a worker's read of how its request stands, and a session's dispatch all
    // leave it approved.
    expect(await dispatchApproved(flowEnv, s.tenant, s.taskId, requestId, { flags: on })).toBe("approved");
    expect(await nam.outcome(requestId)).toEqual({ ok: true, value: { standing: "decided", reason: "decided",
      approved: true, action: "approved" } });
    const dispatched = await call(`/v1/tasks/${s.taskId}/actions/${requestId}/dispatch`, { method: "POST",
      headers: { ...(await tenantSession(s.tenant)), "content-type": "application/json" },
      body: JSON.stringify({ grantRevision: 1 }) });
    await refusal(dispatched, 409, "begin_by_step");
    await refusal(await begin(s, requestId, { attemptId }, {}), 409, "begin_by_step");
    // Nor is it decided again, or settled, by the routes that came before requests.
    const decidedAgain = await call(`/v1/tasks/${s.taskId}/actions/${requestId}/decision`, { method: "POST",
      headers: { ...(await tenantSession(s.tenant)), "content-type": "application/json" },
      body: JSON.stringify({ approve: true, by: "anyone" }) });
    await refusal(decidedAgain, 409, "decide_by_request");
    const settledByHand = await task(s.taskId).fetch(new Request(`https://task/actions/${requestId}/settle`,
      { method: "POST", headers: { "content-type": "application/json", "x-tenant": s.tenant },
        body: JSON.stringify({ outcome: "confirmed", providerOperationId: "made-up" }) }));
    await refusal(settledByHand, 409, "settle_by_report");
    expect((await stored(s, requestId)).action.state).toBe("approved");
    // The hand-out begins it.
    await queued(nam, submit(mac.id, requestId));
    expect(await mac.take()).toHaveLength(1);
    expect((await stored(s, requestId)).action.state).toBe("dispatching");
  });

  it("goes only to the outpost it is bound to", async () => {
    const { s, signInId, mac } = await ready();
    const cloud = await outpost(s.tenant, { name: "Cloud outpost", kind: "cloud" });
    const foreign = await outpost(fresh("submit:other-shop"));
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const step = await queued(nam, submit(mac.id, requestId));
    expect(await cloud.take()).toEqual([]);
    expect(await foreign.take()).toEqual([]);
    expect((await stored(s, requestId)).action.state).toBe("approved");
    expect((await mac.take()).map((entry) => entry.stepId)).toEqual([step.stepId]);
    await refusal(await cloud.report(step.stepId, { outcome: "done" }), 403, "wrong_outpost");
    expect((await stored(s, requestId)).action.state).toBe("dispatching");
  });

  it("refuses a step whose attempt ended, or no longer holds the task, and begins nothing", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const step = await queued(nam, submit(mac.id, requestId));
    expect((await nam.finish("done")).ok).toBe(true);
    expect(await mac.take()).toEqual([]);
    expect(await outcome(await attempt(s, "nam"), step.stepId).catch((error: Error) => error.message))
      .toBe("outcome_refused_step_not_found");
    expect((await stepRecords(s.tenant)).find((record) => record.id === step.stepId))
      .toMatchObject({ state: "refused", code: "attempt_ended" });
    expect((await stored(s, requestId)).action.state).toBe("approved");

    // An attempt that still runs by its lease, but that a newer claim took the task from, may not begin a write.
    const ton = await attempt(s, "ton");
    const tonsRequest = await asked(ton, refund(signInId));
    await ownerDecides(s, tonsRequest);
    const tonsStep = await queued(ton, submit(mac.id, tonsRequest));
    await attempt(s, "ton");
    expect(await mac.take()).toEqual([]);
    expect(await outcome(ton, tonsStep.stepId)).toEqual({ ...tonsStep, state: "refused", code: "attempt_ended" });
    expect((await stored(s, tonsRequest)).action.state).toBe("approved");
    expect((await audit(s.tenant)).filter((entry) => entry.action === "browser_step.fetched")
      .map((entry) => [entry.subject.stepId, entry.outcome, entry.reason])).toEqual([
      [step.stepId, "refused", "attempt_ended"], [tonsStep.stepId, "refused", "attempt_ended"]]);
  });

  it("refuses a write step while external writes are switched off, and still hands out reads", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const write = await queued(nam, submit(mac.id, requestId));
    const read = await queued(nam, { kind: "read", outpostId: mac.id });
    expect((await setFlags({ officeExternalWrites: false })).status).toBe(200);
    expect((await mac.take()).map((entry) => entry.stepId)).toEqual([read.stepId]);
    expect(await outcome(nam, write.stepId)).toEqual({ ...write, state: "refused", code: "feature_disabled" });
    expect((await stored(s, requestId)).action.state).toBe("approved");
    // Refused for good: back on, nothing more is handed out, and a new step can carry the approved write.
    expect((await setFlags({ officeExternalWrites: true })).status).toBe(200);
    expect(await mac.take()).toEqual([]);
    expect((await queued(nam, submit(mac.id, requestId))).state).toBe("queued");
  });

  it("refuses it when consent was withdrawn, the request moved to another revision, or its sign-in broke", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const first = await asked(nam, reply(signInId));
    await ownerDecides(s, first);
    const withdrawn = await queued(nam, submit(mac.id, first));
    await consent(s.tenant, false);
    await refusal(await mac.steps(), 403, "consent_required");
    await consent(s.tenant, true);
    expect(await outcome(nam, withdrawn.stepId)).toEqual({ ...withdrawn, state: "refused", code: "consent_required" });

    // A request is never revised once decided; were it ever at another revision, the step bound to this one stops.
    const revised = await queued(nam, submit(mac.id, first));
    await runInDurableObject(task(s.taskId), async (_instance, state) => {
      const record = await state.storage.get<ApprovalRecord>(`request:${first}`);
      if (!record) throw new Error("no_record");
      await state.storage.put(`request:${first}`, { ...record, request: { ...record.request, revision: 2 } });
    });
    expect(await mac.take()).toEqual([]);
    expect(await outcome(nam, revised.stepId)).toEqual({ ...revised, state: "refused", code: "request_changed" });
    expect((await stored(s, first)).action.state).toBe("approved");

    const second = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value: "Second" }] });
    await ownerDecides(s, second);
    const broken = await queued(nam, submit(mac.id, second));
    expect((await nam.signInBroken(signInId)).ok).toBe(true);
    expect(await mac.take()).toEqual([]);
    expect(await outcome(nam, broken.stepId)).toEqual({ ...broken, state: "refused", code: "sign_in_broken" });
    expect((await stored(s, second)).action.state).toBe("approved");
  });
});

describe("reporting a write step", () => {
  it("settles the write as the outpost said: done, failed before submitting, or not sure", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const run = async (value: string, report: Record<string, unknown>) => {
      const requestId = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value }] });
      await ownerDecides(s, requestId);
      const step = await queued(nam, submit(mac.id, requestId));
      expect(await mac.take()).toHaveLength(1);
      expect((await mac.report(step.stepId, report)).status).toBe(200);
      return { requestId, step };
    };
    const missing = await run("one", { outcome: "failed", code: "selector_not_found" });
    expect((await stored(s, missing.requestId)).action.state).toBe("failed");
    expect(await outcome(nam, missing.step.stepId)).toMatchObject({ state: "failed", code: "selector_not_found" });
    const refusedBySite = await run("two", { outcome: "failed", code: "submit_refused" });
    expect((await stored(s, refusedBySite.requestId)).action.state).toBe("failed");
    // A timeout or a browser fault may have come after the submit: nobody can say it was not made.
    const timedOut = await run("three", { outcome: "failed", code: "timed_out" });
    expect((await stored(s, timedOut.requestId)).action.state).toBe("unknown");
    const wandered = await run("four", { outcome: "failed", code: "origin_not_allowed" });
    expect((await stored(s, wandered.requestId)).action.state).toBe("unknown");
    // A submit brings back no text.
    const texted = await asked(nam, { ...reply(signInId), values: [{ field: "textarea", value: "five" }] });
    await ownerDecides(s, texted);
    const step = await queued(nam, submit(mac.id, texted));
    expect(await mac.take()).toHaveLength(1);
    await refusal(await mac.report(step.stepId, { outcome: "done", text: "Sent" }), 400, "invalid_report");
    expect((await stored(s, texted)).action.state).toBe("dispatching");
    expect((await audit(s.tenant)).filter((entry) => entry.action === "dispatch.settled").map((entry) => entry.outcome))
      .toEqual(["failed", "failed", "unknown", "unknown"]);
  });

  it("records what the outpost did even when its outcome can no longer land in the attempt", async () => {
    const { s, signInId, mac } = await ready();
    const nam = await attempt(s, "nam");
    const requestId = await asked(nam, reply(signInId));
    await ownerDecides(s, requestId);
    const step = await queued(nam, submit(mac.id, requestId));
    expect(await mac.take()).toHaveLength(1);
    expect((await nam.finish("done")).ok).toBe(true);
    // The write was made; the attempt that asked for it ended meanwhile, so the step reads refused and nothing lands.
    await refusal(await mac.report(step.stepId, { outcome: "done" }), 409, "attempt_ended");
    expect((await stored(s, requestId)).action.state).toBe("confirmed");
    expect(await landed(s, nam.job.attemptId)).toEqual([]);
  });
});
