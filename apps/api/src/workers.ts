/// Buddy's three cloud team members as workers on the job flow (job-flow.ts; docs/phase-0-spikes.md, section 4). Nam
/// drafts a reply to a customer's message, Pim drafts a post about a topic an operator gives, and Ton writes the owner a
/// short summary of yesterday's sales from the order payments the shop has recorded. An operator starts each job from
/// the console (`POST /v1/admin/workers/run`, below); the runner does the rest.
///
/// Every result is a draft, kept on the job's own task for the owner to read (task-object.ts, `DraftJSON`). Nothing
/// here can send, post, pay or refund: the runner never asks for an external write, so the approval paths that already
/// exist stay the only way anything leaves the app. A reply Nam drafts reaches a customer only if an operator proposes
/// it through the pilot's reply flow and the owner approves it there.
///
/// One run, in order:
///
/// 1. The switches and the owner's consent (the job flow's gate), then what the job names: the shop, and for a reply
///    the message. Nothing is created for a job that cannot run.
/// 2. A task for the job, in the shop's index so export and deletion find it, and an attempt on it for the member
///    asked, which the log names the operator as starting.
/// 3. The member's permissions (@manut/member-grants `decide`), before anything else in the attempt. A job that is
///    another member's is passed on: the handover is reported on the task, the attempt ends done, and the member whose
///    job it is gets an attempt of its own on the same task. A reply whose connection the shop no longer has ends
///    `not_connected`.
/// 4. The request, built by @manut/agent-prompts from the shop's name, the facts the owner confirmed (memory.ts,
///    `usableFacts`) and the job, and one call through the model gateway on the attempt's port, metered against the
///    shop's cap. Past the cap the control plane ends the attempt (`budget`). Ton with no sales to count says so and
///    calls no model.
/// 5. The draft on the task, then the attempt's end.

import { buildRequest, type Job as PromptJob } from "@manut/agent-prompts";
import { dailySummary, type DailySummary, type Entry, type Flag } from "@manut/books";
import { decide, newConnection, type Connection } from "@manut/member-grants";
import { emptyState } from "@manut/shop-memory";
import type { AuditActor } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import {
  startAttempt,
  workGate,
  workerPort,
  type JobFlags,
  type JobFlowEnv,
  type JobOptions,
  type PortAnswer,
  type Refused,
  type WorkerPort,
} from "./job-flow";
import { usableFacts } from "./memory";
import { operatorIdentity } from "./pilot";
import { bangkokDay } from "./pilot-gate";
import type { InboundMessage, Payment, PilotShopRecord } from "./pilot-store";
import type { DraftJSON } from "./task-object";
import { credStub, tenantCall } from "./tenant-data";

export const WORKER_MEMBERS = ["nam", "pim", "ton"] as const;
export type WorkerMember = (typeof WORKER_MEMBERS)[number];

/// What an operator asks a member to do. A reply names a customer's message the shop already holds, so the draft can
/// be carried into the pilot's reply flow, which needs that message. Ton's summary is always of yesterday in Bangkok,
/// the day @manut/agent-prompts' request says it is.
export type WorkerJob =
  | { kind: "reply"; messageId: string }
  | { kind: "post"; topic: string }
  | { kind: "daily_summary" };

/// The model every member drafts with: the cheapest the gateway prices, which a draft for a small shop needs, and the
/// one the Phase 2 stand-in worker uses. Choosing a model per member is a later decision.
export const WORKER_MODEL = "claude-haiku-5-5";

/// Each job in the roster's words (@manut/member-grants): the capability `decide` is asked about, and the most a draft
/// may run to. A reply is Nam's `reply_customers`, a write, so in practice mode it can only be drafted and after
/// practice it needs the owner's `reply` approval to be sent. A post draft and a books draft stay inside the app, which
/// the roster counts as reads.
const JOBS: Readonly<Record<WorkerJob["kind"], { capability: string; maxOutputTokens: number }>> = {
  reply: { capability: "reply_customers", maxOutputTokens: 600 },
  post: { capability: "draft_posts", maxOutputTokens: 1200 },
  daily_summary: { capability: "draft_books", maxOutputTokens: 600 },
};

/// The longest topic an operator may give Pim, in characters (Thai counted the same as English).
const MAX_TOPIC = 500;
/// The longest message id the shop's object looks up (pilot-store.ts).
const MAX_MESSAGE_ID = 128;
const MAX_BODY_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const enc = encodeURIComponent;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isWorkerMember(value: unknown): value is WorkerMember {
  return typeof value === "string" && (WORKER_MEMBERS as readonly string[]).includes(value);
}

/// The job an operator asked for, or null for anything else: an unknown kind, a field the kind does not have, a
/// blank or overlong topic, a missing message id.
export function parseJob(value: unknown): WorkerJob | null {
  if (!isRecord(value)) return null;
  const only = (...keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
  switch (value.kind) {
    case "reply": {
      const { messageId } = value;
      return only("kind", "messageId") && typeof messageId === "string" && messageId.length > 0 &&
          messageId.length <= MAX_MESSAGE_ID ? { kind: "reply", messageId } : null;
    }
    case "post": {
      const topic = typeof value.topic === "string" ? value.topic.trim() : "";
      return only("kind", "topic") && topic.length > 0 && [...topic].length <= MAX_TOPIC ? { kind: "post", topic } : null;
    }
    case "daily_summary":
      return only("kind") ? { kind: "daily_summary" } : null;
    default:
      return null;
  }
}

export type WorkerRunInput = {
  tenant: string;
  member: WorkerMember;
  job: WorkerJob;
  /// Who started the job, for the log: the operator, by their Access identity.
  startedBy: AuditActor;
};

/// How a job went. `member` is who did it: the member asked, or the one it was passed to, with `passedFrom` naming
/// the member who passed it on. A refusal means nothing was started.
export type WorkerRun =
  | { ok: true; taskId: string; member: WorkerMember; passedFrom?: WorkerMember; outcome: "done"; draft: DraftJSON }
  | { ok: true; taskId: string; member: WorkerMember; passedFrom?: WorkerMember; outcome: "failed"; reason: string }
  | Refused;

/// What the job reads before anything is created for it.
type Inputs = { shop: PilotShopRecord; message: InboundMessage | null; day: string };

/// Runs one job for a shop. See the module note for the order of things.
export async function runWorker(env: JobFlowEnv, input: WorkerRunInput, options: JobOptions): Promise<WorkerRun> {
  const { tenant, job } = input;
  const refused = await workGate(env, tenant, options.flags, false);
  if (refused) return refused;
  const shop = await readShop(env, tenant);
  if (shop === undefined) return { ok: false, status: 503, error: "shop_unavailable" };
  if (shop === null) return { ok: false, status: 404, error: "shop_not_found" };
  let message: InboundMessage | null = null;
  if (job.kind === "reply") {
    const read = await readMessage(env, tenant, job.messageId);
    if (read === undefined) return { ok: false, status: 503, error: "message_unavailable" };
    if (read === null) return { ok: false, status: 404, error: "message_not_found" };
    message = read;
  }
  const inputs: Inputs = { shop, message, day: bangkokYesterday(Date.now()) };
  const taskId = `worker-task-${crypto.randomUUID()}`;
  if (!(await createTask(env, tenant, taskId, job, inputs.day))) {
    return { ok: false, status: 503, error: "task_unavailable" };
  }

  let member = input.member;
  let passedFrom: WorkerMember | undefined;
  let startedBy = input.startedBy;
  for (;;) {
    const started = await startAttempt(env, { tenant, taskId, executorId: member, startedBy }, options);
    const by = passedFrom !== undefined ? { passedFrom } : {};
    if (!started.ok) {
      // The job's first attempt is refused as the run is. Once one member has passed the job on, the run did start,
      // so the refusal is how it ended.
      if (passedFrom === undefined) return started;
      return { ok: true, taskId, member, ...by, outcome: "failed", reason: started.error };
    }
    const worked = await work(env, workerPort(env, started.job, options), member, job, inputs, passedFrom !== undefined);
    if (worked.outcome === "done") return { ok: true, taskId, member, ...by, outcome: "done", draft: worked.draft };
    if (worked.outcome === "failed") return { ok: true, taskId, member, ...by, outcome: "failed", reason: worked.reason };
    // Passed on: the member whose job it is starts on the same task, and the control plane, not the operator, started it.
    passedFrom = member;
    member = worked.to;
    startedBy = { kind: "system" };
  }
}

type Worked =
  | { outcome: "done"; draft: DraftJSON }
  | { outcome: "failed"; reason: string }
  | { outcome: "passed"; to: WorkerMember };

/// One member's attempt at the job, through its port only.
async function work(
  env: JobFlowEnv,
  port: WorkerPort,
  member: WorkerMember,
  job: WorkerJob,
  inputs: Inputs,
  passedAlready: boolean,
): Promise<Worked> {
  const tenant = port.job.tenant;

  /// Ends the attempt failed with `reason`, unless it has already ended (the control plane ends it at the cap), and
  /// answers how it went. What is reported on the way out is best effort: the end is what counts.
  const fail = async (reason: string, answer?: PortAnswer<unknown>): Promise<Worked> => {
    if (!(answer && !answer.ok && answer.ended)) {
      await port.report([{ type: "turnCompleted", status: "failed", error: reason }]);
      await port.finish("failed", reason);
    }
    return { outcome: "failed", reason };
  };

  /// Keeps the draft on the task and ends the attempt done.
  const keep = async (text: string, extra: { about?: Record<string, string>; send?: DraftJSON["send"] }):
    Promise<Worked> => {
    if (text.trim().length === 0) return fail("empty_draft");
    const drafted = await port.draft({ member, job: job.kind, text, ...(extra.about ? { about: extra.about } : {}),
      ...(extra.send ? { send: extra.send } : {}) });
    if (!drafted.ok) return fail(drafted.error, drafted);
    const closed = await port.report([{ type: "turnCompleted", status: "completed" }]);
    if (!closed.ok) return fail(closed.error, closed);
    const finished = await port.finish("done");
    if (!finished.ok) return { outcome: "failed", reason: finished.error };
    return { outcome: "done", draft: drafted.value };
  };

  const opened = await port.report([{ type: "turnStarted" }]);
  if (!opened.ok) return fail(opened.error, opened);

  // Permissions come first: nothing is read for the model, and nothing is spent, for a job the member may not do.
  let connection: Connection | null = null;
  if (job.kind === "reply" && inputs.message) {
    const found = await replyConnection(env, tenant, inputs.message.connectionId);
    if (found === undefined) return fail("vault_unavailable");
    connection = found;
  }
  const decision = decide(member, JOBS[job.kind].capability, connection, Date.now());
  let send: DraftJSON["send"] = undefined;
  switch (decision.answer) {
    case "not_my_job": {
      // A member never does another member's job. It passes it on once; the member it goes to owns the capability,
      // so a second handover would mean the roster is wrong, and the job ends rather than going round.
      if (passedAlready || !isWorkerMember(decision.member)) return fail("not_my_job");
      const handed = await port.report([
        { type: "handoffNote", from: member, to: decision.member, job: job.kind },
        { type: "turnCompleted", status: "completed" },
      ]);
      if (!handed.ok) return fail(handed.error, handed);
      const finished = await port.finish("done");
      if (!finished.ok) return { outcome: "failed", reason: finished.error };
      return { outcome: "passed", to: decision.member };
    }
    case "not_connected":
      return fail("not_connected");
    case "refused":
      return fail(decision.reason);
    case "draft_only":
    case "ask":
      // Practice mode, and after it: either way this phase only drafts. What sending would take goes with the draft.
      send = { answer: decision.answer, kind: decision.kind };
      break;
    case "allowed":
      break;
  }

  let promptJob: PromptJob;
  let about: Record<string, string> | undefined = undefined;
  switch (job.kind) {
    case "reply":
      // Only the message it answers, for now. The conversation's earlier turns need the shop's replies with them,
      // which live on the pilot's own task; without them a model would answer old questions again.
      promptJob = { member: "nam", conversation: [], newest: inputs.message?.text ?? "" };
      about = { messageId: job.messageId };
      break;
    case "post":
      promptJob = { member: "pim", topic: job.topic };
      break;
    case "daily_summary": {
      about = { date: inputs.day };
      const payments = await readPayments(env, tenant);
      if (!payments) return fail("payments_unavailable");
      const summary = dailySummary(entriesOf(payments), inputs.day);
      if (summary.sales.count === 0 && summary.refunds.count === 0 && summary.flags.length === 0) {
        return keep(`No sales were recorded on ${inputs.day}.`, { about });
      }
      promptJob = { member: "ton", numbers: numbersOf(summary) };
      break;
    }
  }

  const facts = await usableFacts(env, tenant);
  if (!facts.ok) return fail(facts.error);
  const built = buildRequest({
    shop: { name: inputs.shop.name },
    memory: { ...emptyState(), facts: facts.facts },
    job: promptJob,
    model: WORKER_MODEL,
    maxOutputTokens: JOBS[job.kind].maxOutputTokens,
  });
  if (!built.ok) return fail(built.reason);
  const answered = await port.callModel(built.request);
  if (!answered.ok) return fail(answered.error === "budget_exceeded" ? "budget" : answered.error, answered);
  const { usage, costSatang } = answered.value;
  // The cost rides with the spend report because nothing else links a job to the meter's record of its call (the meter
  // keeps no task or attempt id, by design: metadata only). It is the gateway's own price in whole satang, so the job
  // list can show what a job cost without reading the meter. The agent-events decoder ignores a field it does not know.
  const spent = await port.report([{ type: "spend", tokens: usage.inputTokens + usage.outputTokens,
    model: WORKER_MODEL, costSatang }]);
  if (!spent.ok) return fail(spent.error, spent);
  return keep(answered.value.text, { ...(about ? { about } : {}), ...(send ? { send } : {}) });
}

/// Yesterday as the calendar reads in Bangkok, `YYYY-MM-DD`.
function bangkokYesterday(nowMs: number): string {
  return new Date((bangkokDay(nowMs) - 1) * DAY_MS).toISOString().slice(0, 10);
}

/// The shop's record, null when the tenant is not a pilot shop, undefined when it cannot be read.
async function readShop(env: JobFlowEnv, tenant: string): Promise<PilotShopRecord | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${enc(tenant)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { shop } = (await response.json()) as { shop?: PilotShopRecord };
    return shop && typeof shop.name === "string" ? shop : undefined;
  } catch {
    return undefined;
  }
}

/// A customer's message the shop holds, null when it holds none by that id, undefined when it cannot be read.
async function readMessage(env: JobFlowEnv, tenant: string, id: string): Promise<InboundMessage | null | undefined> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/message?tenant=${enc(tenant)}&id=${enc(id)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { message } = (await response.json()) as { message?: InboundMessage };
    return message && typeof message.text === "string" && typeof message.connectionId === "string" ? message
      : undefined;
  } catch {
    return undefined;
  }
}

/// The connection a reply would go out through: the shop's connection the customer wrote to, as the vault lists it
/// (only connections not revoked, and never a secret). Its practice clock starts when it was made
/// (`newConnection`): nothing records an owner ending practice early yet, so practice runs its full three days. Null
/// when the shop no longer has that connection; undefined when the vault cannot be read.
async function replyConnection(env: JobFlowEnv, tenant: string, connectionId: string):
  Promise<Connection | null | undefined> {
  try {
    const response = await credStub(env, tenant).fetch(new Request(`https://cred/connections?tenant=${enc(tenant)}`,
      { headers: { "x-tenant": tenant } }));
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { connections } = (await response.json()) as { connections?: Record<string, unknown>[] };
    const found = (connections ?? []).find((connection) => connection.id === connectionId);
    if (!found) return null;
    // A time that does not read as one is left to `decide`, which answers not_connected for it.
    return newConnection(typeof found.createdAt === "string" ? Date.parse(found.createdAt) : Number.NaN);
  } catch {
    return undefined;
  }
}

/// The customers' order payments the shop has recorded, newest first, as many as the console lists. Null when they
/// cannot be read.
async function readPayments(env: JobFlowEnv, tenant: string): Promise<Payment[] | null> {
  try {
    const response = await tenantCall(env, tenant, `/pilot/payments?tenant=${enc(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { payments } = (await response.json()) as { payments?: unknown };
    return Array.isArray(payments) ? payments.filter(isRecord) as Payment[] : null;
  } catch {
    return null;
  }
}

/// The payments as Ton's books count them: each a sale on LINE, the pilot's one channel, at the moment the payment
/// was confirmed. A record that is not whole goes in as it is, and the books flag it rather than count it.
function entriesOf(payments: readonly Payment[]): Entry[] {
  return payments.map((payment): Entry => ({
    kind: "sale",
    ref: payment.orderRef,
    channel: "line",
    amountSatang: payment.amountSatang,
    at: typeof payment.confirmedAt === "string" ? Date.parse(payment.confirmedAt) : Number.NaN,
  }));
}

/// The day's numbers as @manut/agent-prompts takes Ton's: how many orders were paid and for how much, then anything
/// the books flagged for the owner to check. Ton raises flags and never fixes them.
function numbersOf(summary: DailySummary): { label: string; value: string }[] {
  const numbers = [
    { label: "Paid orders", value: String(summary.sales.count) },
    { label: "Sales", value: baht(summary.sales.totalSatang) },
  ];
  if (summary.refunds.count > 0) {
    numbers.push({ label: "Refunds", value: `${summary.refunds.count}, ${baht(summary.refunds.totalSatang)}` });
  }
  for (const flag of summary.flags) numbers.push({ label: "To check", value: flagText(flag) });
  return numbers;
}

function flagText(flag: Flag): string {
  const what = flag.ref ? `order ${flag.ref}` : "an entry";
  switch (flag.kind) {
    case "duplicate_sale_ref":
      return `${what} was recorded as paid twice`;
    case "refund_without_sale":
      return `a refund for ${what} has no sale`;
    case "refund_exceeds_sale":
      return `refunds for ${what} are more than it sold for`;
    case "invalid_amount":
      return `${what} has an amount that cannot be counted`;
    case "invalid_entry":
      return `${what} cannot be counted`;
  }
}

/// Integer satang written in baht by @manut/format's rule (`formatMoney`): `฿1,250.50`, or `฿500` for whole baht.
/// apps/api does not depend on that package, so the rule is written out here, in integer arithmetic only: the baht
/// are the satang less their remainder, divided exactly.
function baht(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const whole = Math.abs(satang);
  const rest = whole % 100;
  const grouped = String((whole - rest) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}฿${grouped}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

/// The job's own task, indexed for the shop before it is created, as `POST /v1/tasks` and the pilot's reply task are,
/// so export and deletion always find it. It stays a draft: its attempts carry the work, and what they leave is drafts.
/// The title and objective say what the job is and never quote a customer.
async function createTask(env: JobFlowEnv, tenant: string, taskId: string, job: WorkerJob, day: string):
  Promise<boolean> {
  const named = job.kind === "reply"
    ? { title: "A reply to a customer", objective: "Draft a reply to a customer's message for the owner to read." }
    : job.kind === "post"
      ? { title: "A post", objective: `Draft a post about ${job.topic}, for the owner to read.` }
      : { title: `Sales summary for ${day}`,
        objective: `Write the owner a short summary of the sales recorded on ${day}.` };
  try {
    const indexed = await tenantCall(env, tenant, "/index", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant, taskId }) });
    await indexed.body?.cancel();
    if (!indexed.ok) return false;
    const created = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-task-id": taskId, "x-tenant": tenant,
        "x-route": "POST /v1/admin/workers/run", "x-create-only": "1" },
      body: JSON.stringify({ id: taskId, ...named, state: "draft", location: "cloud", funding: "cloudBYOK",
        criteria: [], updatedAt: new Date().toISOString(), tenantId: tenant }),
    }));
    await created.body?.cancel();
    return created.ok;
  } catch {
    return false;
  }
}

/// `POST /v1/admin/workers/run` with `{ tenant, member, job }`, after the admin gate's exact ADMIN_METHODS entry
/// (index.ts): starts one member's job for a shop and answers how it went, the draft included. The route calls no
/// model: the runner does, through the gateway. Answers null for any other path.
export async function workersAdminRoute(
  request: Request,
  url: URL,
  env: JobFlowEnv,
  ctx: ExecutionContext,
  flags: JobFlags,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/workers/")) return null;
  if (`${request.method} ${url.pathname}` !== "POST /v1/admin/workers/run") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  if (!isWorkerMember(body.member)) return json({ error: "unknown_member" }, 400);
  const job = parseJob(body.job);
  if (!job) return json({ error: "invalid_job" }, 400);
  const run = await runWorker(env, { tenant: body.tenant, member: body.member, job,
    startedBy: { kind: "operator", email: await operatorIdentity(ctx) } }, { flags });
  if (!run.ok) return json({ error: run.error, ...(run.feature ? { feature: run.feature } : {}) }, run.status);
  const { ok: _ok, ...answer } = run;
  return json(answer);
}
