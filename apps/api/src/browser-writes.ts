/// Submitting through a browser (docs/browser-control.md, "Reading by default, and asking before submitting"): a browser
/// step that would submit anything other than a read is a write, and it is made the way every write is made.
///
/// 1. The worker asks through its port (job-flow.ts, `askSubmit`) with the exact write: the typed action, the site (one
///    of the shop's sign-ins), the page, the form it submits, and every value it would type or choose. The control plane
///    runs member-grants' `decide` for the attempt's member and the action's job first: `not_my_job`, `not_connected` and
///    `refused` stop there, and `draft_only` keeps a draft of the write and raises no request. Only then does the task
///    object open one approval-core request naming the site, the page and every value, of the kind this module's fixed
///    table gives the action (never the worker's word), with the exact write stored beside it as an immutable proposal.
/// 2. Once the owner (or a helper, for the one kind a helper may decide) approves it, the worker queues one `submit` step
///    for an outpost, naming the request and the revision it was approved at. The step carries no values of its own.
/// 3. As the outpost takes the step (browser-control.ts, `fetchSteps`), the control plane reads the switches (with
///    `officeExternalWrites`), consent and the attempt again; the vault checks the page's origin is still a working
///    sign-in's; and the task object's one-use begin gate, the one the broker uses, moves the approved write to
///    dispatching once, checking it is still approved at that revision and that the attempt still holds the task. Only
///    then does the outpost get the step, with the values from the approved copy the gate hands back.
/// 4. The outpost reports how it went, once. The write settles as it said (confirmed, failed, or unknown when it cannot
///    know whether the site took it), and the outcome lands in the attempt's events as every step's does.
///
/// Every ask, decision, hand-out and report is written to the audit log with ids only, never a value or a page.

import type { ApprovalKind, ApprovalRecord } from "@manut/approval-core";
import { decide, newConnection, type Connection } from "@manut/member-grants";
import { appendAudit, type AuditSubject } from "./audit-log";
import {
  selectorOf,
  urlOf,
  vaultAnswer,
  vaultCall,
  type AttemptRef,
  type BrowserStepView,
  type OutpostStep,
  type SignInView,
  type StepBinding,
  type VaultEnv,
} from "./sign-in-vault";
import type { ActionProposalJSON } from "./task-object";
import type { TenantDataEnv } from "./tenant-data";

/// The operation type of a browser write, as the task object stores its proposal. It is not on the propose route's
/// allowlist: only a worker's ask stores one, with the request that alone decides it.
export const BROWSER_SUBMIT = "browser.submit";

/// A browser write has no grant revision: a sign-in is not narrowed the way a connection's grant is. Its proposal is
/// stored with this one, which the begin gate compares like any other.
export const SUBMIT_GRANT_REVISION = 1;

/// What a write step may do, as a fixed list: a worker names one, and the rest follows from it.
export const SUBMIT_ACTIONS = ["send_reply", "place_order", "change_order", "refund", "publish_post", "change_setting"] as
  const;
export type SubmitAction = (typeof SUBMIT_ACTIONS)[number];

/// The approval kind of each action, set here and never by the worker. A kind decides who may approve the request and
/// whether a notification may (approval-core's `mayDecide`, `@manut/notify-rules`): `message` and `reply` are the only
/// kinds a helper decides and the only ones a notification may approve, so only an action that can be nothing but a
/// private answer to a customer who wrote first maps to one. Everything that can spend, refund or charge is `money`;
/// anything the public can see, an answer to a public review included, is `publish_post` and `public_post`; and a change
/// to the shop's own settings is `command`. All three are the owner's only.
export const SUBMIT_KINDS: Readonly<Record<SubmitAction, ApprovalKind>> = {
  send_reply: "reply",
  place_order: "money",
  change_order: "money",
  refund: "money",
  publish_post: "public_post",
  change_setting: "command",
};

/// The member-grants job (capability) each action is, which `decide` answers for. Each job's kind in the roster is the
/// table's kind for its action; a disagreement is refused (`kind_mismatch`) rather than settled either way.
export const SUBMIT_JOBS: Readonly<Record<SubmitAction, string>> = {
  send_reply: "reply_customers",
  place_order: "place_orders",
  change_order: "change_orders",
  refund: "ask_refund",
  publish_post: "publish_posts",
  change_setting: "run_command",
};

/// Each action in the owner's words, as the request's text begins.
const ACTION_WORDS: Readonly<Record<SubmitAction, string>> = {
  send_reply: "Send a reply",
  place_order: "Place an order",
  change_order: "Change an order",
  refund: "Make a refund",
  publish_post: "Publish a post",
  change_setting: "Change a shop setting",
};

/// One value a write types or chooses: the field it goes into, as a selector, and exactly what goes there.
export type SubmitValue = { field: string; value: string };

/// A write, as a worker asks for it: what the outpost will do, and all an owner needs to read to approve it.
export type SubmitWrite = {
  action: SubmitAction;
  /// The site: one of the shop's sign-ins, whose origins the page must be on.
  signInId: string;
  /// The page the write is made on, written as the URL parser writes it.
  url: string;
  /// The form it submits, or the control (a button) it presses, as a selector.
  form: string;
  /// Each value, in the order it is typed or chosen.
  values: SubmitValue[];
};

/// What a browser write's request names (`record.request.detail`), so the owner approves exactly what will be submitted.
/// `text` is the control plane's own sentence naming the site, the page, the form and every value; nothing in it is the
/// worker's words but the values themselves, each quoted exactly as it will be typed.
export type SubmitDetail = {
  actionId: string;
  operationType: typeof BROWSER_SUBMIT;
  action: SubmitAction;
  site: string;
  signInId: string;
  origin: string;
  url: string;
  form: string;
  values: SubmitValue[];
  text: string;
  payloadHash: string;
};

/// What a browser write's proposal holds as its payload: the write, with the site's name as the request named it. It is
/// hashed with the rest of the proposal, so what the begin gate hands back is only ever what was approved.
export type SubmitPayload = SubmitWrite & { site: string };

/// The most values one write may carry: a form with more is not one an owner reads word for word.
const MAX_VALUES = 20;
/// The most one value may hold, in characters (Thai counted the same as English): a LINE reply's bound.
const MAX_VALUE = 5_000;
/// The most a whole write may take once written as JSON, in UTF-8: its request names every value twice (as data and in
/// its text), and in practice mode its text is a draft, which may take 16 KB. A reply, a refund or a caption is far
/// smaller; only a write of thousands of quotes could still make a draft too long, and that ask is refused.
const MAX_WRITE_BYTES = 12 * 1024;
/// A value may hold a tab and line breaks, which a message has; no other control character can be typed into a form.
const VALUE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_KEYS = ["action", "signInId", "url", "form", "values"] as const;
const VALUE_KEYS = ["field", "value"] as const;
const STEP_KEYS = ["kind", "outpostId", "requestId", "revision"] as const;
const MAX_REQUEST_ID = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether `value` holds exactly `keys`, no more and no fewer: a field a write does not have is refused, not dropped, so
/// nothing rides along that an owner was not shown.
function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

export function isSubmitAction(value: unknown): value is SubmitAction {
  return typeof value === "string" && (SUBMIT_ACTIONS as readonly string[]).includes(value);
}

/// The kind of a request for `action`: the table's, or `command`, the owner's only, for anything it does not know.
export function submitKind(action: unknown): ApprovalKind {
  return isSubmitAction(action) ? SUBMIT_KINDS[action] : "command";
}

/// A selector a write needs: the same rules as a read's (1 to 256 characters, no control character), never absent.
function requiredSelector(value: unknown): string | null {
  if (value === undefined) return null;
  return selectorOf(value) ?? null;
}

/// The write a worker asked for, checked, or why it cannot be one: `unknown_action` for an action off the list, and
/// `invalid_write` for anything else an outpost could not run exactly or an owner could not read word for word.
export function submitWriteOf(value: unknown): SubmitWrite | "unknown_action" | "invalid_write" {
  if (!isRecord(value) || !keysAre(value, WRITE_KEYS)) return "invalid_write";
  if (!isSubmitAction(value.action)) return "unknown_action";
  if (typeof value.signInId !== "string" || !UUID.test(value.signInId)) return "invalid_write";
  const page = urlOf(value.url);
  const form = requiredSelector(value.form);
  if (!page || form === null || !Array.isArray(value.values) || value.values.length > MAX_VALUES) return "invalid_write";
  const values: SubmitValue[] = [];
  for (const entry of value.values as unknown[]) {
    if (!isRecord(entry) || !keysAre(entry, VALUE_KEYS)) return "invalid_write";
    const field = requiredSelector(entry.field);
    const typed = entry.value;
    if (field === null || typeof typed !== "string" || [...typed].length > MAX_VALUE || VALUE_CONTROL.test(typed) ||
        values.some((earlier) => earlier.field === field)) {
      return "invalid_write";
    }
    values.push({ field, value: typed });
  }
  const write: SubmitWrite = { action: value.action, signInId: value.signInId, url: page.href, form, values };
  return new TextEncoder().encode(JSON.stringify(write)).byteLength <= MAX_WRITE_BYTES ? write : "invalid_write";
}

/// The write a stored proposal's payload holds, with the site's name, or null when it does not read as one.
export function submitPayloadOf(payload: unknown): SubmitPayload | null {
  if (!isRecord(payload) || typeof payload.site !== "string") return null;
  const { site, ...rest } = payload;
  const write = submitWriteOf(rest);
  return typeof write === "string" ? null : { ...write, site };
}

/// What the owner reads: the action, the site, the page, then every value as "set {field} to {value}", the value quoted
/// as JSON so that quotes, line breaks and spaces at either end show exactly as they will be typed, and the form last.
export function submitText(write: SubmitWrite, site: string): string {
  const origin = new URL(write.url).origin;
  const steps = write.values.map(({ field, value }) => `set ${field} to ${JSON.stringify(value)}`);
  steps.push(`${write.values.length > 0 ? "then " : ""}submit ${write.form}`);
  return `${ACTION_WORDS[write.action]} on ${site} (${origin}). On ${write.url}, ${steps.join(", ")}.`;
}

/// What the attempt's events call a write step: the action and the site, never a value.
export function submitTitle(action: string | null, site: string | null): string {
  return `${isSubmitAction(action) ? ACTION_WORDS[action] : "Submit"} on ${site ?? "a site"}`;
}

/// The failure codes an outpost reports only before it submits, so that nothing was submitted: the page did not load, a
/// field or the form was not on it, there was nothing to sign in with, or the site refused what was submitted and kept
/// the form. After any other failure (a timeout, a browser fault, a page that went off the step's origins) nobody can say
/// the site did not take it.
const NOTHING_SUBMITTED: ReadonlySet<string> = new Set(["page_unavailable", "selector_not_found", "sign_in_refused",
  "grant_refused", "submit_refused"]);

/// How a write settles from its step's report, as the broker settles a provider's answer.
export function submitSettlement(outcome: "done" | "failed", code: string | null): "confirmed" | "failed" | "unknown" {
  if (outcome === "done") return "confirmed";
  return code !== null && NOTHING_SUBMITTED.has(code) ? "failed" : "unknown";
}

// ---------------------------------------------------------------------------
// The control plane's side: asking, queuing, handing out and reporting
// ---------------------------------------------------------------------------

export type SubmitEnv = VaultEnv & Pick<TenantDataEnv, "TASK">;

/// What asking may come to before the task object is asked anything: the write, the site's name and the request's kind
/// with `decide`'s answer, or why not (with whose job it is, for `not_my_job`).
export type PreparedSubmit =
  | { ok: true; write: SubmitWrite; site: string; kind: ApprovalKind; answer: "ask" | "draft_only" }
  | { ok: false; error: string; member?: string };

/// The shop's live sign-in by id, as the operator lists it (no secret), null when there is none, undefined when the vault
/// does not answer.
async function signInOf(env: VaultEnv, tenant: string, signInId: string): Promise<SignInView | null | undefined> {
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", "/sign-ins"));
    if (!answer || answer.status !== 200 || !Array.isArray(answer.body.signIns)) return undefined;
    return (answer.body.signIns as SignInView[]).find((signIn) => signIn.id === signInId) ?? null;
  } catch {
    return undefined;
  }
}

/// The connection a write goes through is its sign-in. Its practice days run from when it was added, as for a shop's
/// other connections, and one the site refused, or that is gone, is no connection to write through.
function connectionOf(signIn: SignInView | null): Connection | null {
  if (!signIn) return null;
  const connection = newConnection(Date.parse(signIn.createdAt));
  return signIn.state === "working" ? connection : { ...connection, connected: false };
}

/// Everything asking checks before the task object is asked, in order: the write's shape; member-grants' `decide` for the
/// attempt's member and the action's job, through the sign-in as the connection; that `decide`'s kind is the table's;
/// then the sign-in's own rules, that the member is named on it and that the page is on one of its origins.
export async function prepareSubmit(env: VaultEnv, attempt: AttemptRef, asked: unknown, nowMs: number):
  Promise<PreparedSubmit> {
  const write = submitWriteOf(asked);
  if (typeof write === "string") return { ok: false, error: write };
  const signIn = await signInOf(env, attempt.tenant, write.signInId);
  if (signIn === undefined) return { ok: false, error: "vault_unavailable" };
  const decided = decide(attempt.member, SUBMIT_JOBS[write.action], connectionOf(signIn), nowMs);
  switch (decided.answer) {
    case "not_my_job":
      return { ok: false, error: "not_my_job", member: decided.member };
    case "not_connected":
      return { ok: false, error: "not_connected" };
    case "refused":
      return { ok: false, error: decided.reason };
    case "allowed":
      // A write never answers allowed; a roster that calls this job a read does not describe this write.
      return { ok: false, error: "kind_mismatch" };
    case "ask":
    case "draft_only":
      break;
  }
  const kind = SUBMIT_KINDS[write.action];
  if (decided.kind !== kind) return { ok: false, error: "kind_mismatch" };
  if (!signIn) return { ok: false, error: "not_connected" };
  if (!signIn.members.includes(attempt.member)) return { ok: false, error: "member_not_allowed" };
  if (!signIn.origins.includes(new URL(write.url).origin)) return { ok: false, error: "origin_not_allowed" };
  return { ok: true, write, site: signIn.site, kind, answer: decided.answer };
}

/// Ids a worker named, kept in an audit entry only when they could be the shop's (a UUID), so the log never refuses the
/// entry for a malformed one.
function namedIds(ids: Partial<Record<"signInId" | "outpostId" | "requestId", unknown>>): AuditSubject {
  const subject: AuditSubject = {};
  if (typeof ids.outpostId === "string" && UUID.test(ids.outpostId)) subject.outpostId = ids.outpostId;
  if (typeof ids.signInId === "string" && UUID.test(ids.signInId)) subject.signInId = ids.signInId;
  if (typeof ids.requestId === "string" && UUID.test(ids.requestId)) {
    subject.requestId = ids.requestId;
    subject.actionId = ids.requestId;
  }
  return subject;
}

/// An ask, written to the shop's log under the attempt with ids only: the request it opened, or why none was (a refusal,
/// or `skipped` with `draft_only` for practice mode).
export async function auditAsk(env: Pick<TenantDataEnv, "TENANT">, attempt: AttemptRef, asked: unknown,
  result: { requestId: string } | { skipped: "draft_only" } | { refused: string }): Promise<void> {
  const signInId = isRecord(asked) ? asked.signInId : undefined;
  const base = { actor: { kind: "worker" as const, attemptId: attempt.attemptId }, action: "approval.requested" as const };
  const subject = { taskId: attempt.taskId, attemptId: attempt.attemptId, ...namedIds({ signInId }) };
  if ("requestId" in result) {
    await appendAudit(env, attempt.tenant, { ...base, subject: { ...subject, ...namedIds({ requestId: result.requestId }) },
      outcome: "ok" });
  } else if ("skipped" in result) {
    await appendAudit(env, attempt.tenant, { ...base, subject, outcome: "skipped", reason: result.skipped });
  } else {
    await appendAudit(env, attempt.tenant, { ...base, subject, outcome: "refused", reason: result.refused });
  }
}

type StoredRequest = { record: ApprovalRecord; action: ActionProposalJSON };

/// A request and its action as the task object holds them, null when it holds none, undefined when it cannot be read.
async function readRequest(env: Pick<TenantDataEnv, "TASK">, tenant: string, taskId: string, requestId: string):
  Promise<StoredRequest | null | undefined> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(
      `https://task/requests/${encodeURIComponent(requestId)}`, { headers: { "x-tenant": tenant } }));
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as StoredRequest;
  } catch {
    return undefined;
  }
}

/// Whether a request was decided by choosing an option that approves.
function approvedRecord(record: ApprovalRecord): record is Extract<ApprovalRecord, { status: "decided" }> {
  return record.status === "decided" &&
    record.request.options.find((option) => option.id === record.decision.optionId)?.effect === "approve";
}

/// A worker's write step (job-flow.ts, `browserStep` with `kind: "submit"`), once the port has read the switches with
/// `officeExternalWrites`, consent and the attempt's own heartbeat. The step names only the outpost, the request and the
/// revision it was approved at; what it will submit is the approved request's, read here from the task object. In order:
/// the step's shape; the request is a browser write of this task, approved at that revision, its write neither begun
/// nor past its time; then the vault queues it for the outpost (the shop's and online), if the attempt's member is named
/// on the write's working sign-in, the page is still on its origins, and no other step carries the request. Writes
/// `browser_step.queued`, queued or refused, with ids only.
export async function queueSubmitStep(env: SubmitEnv, attempt: AttemptRef, asked: unknown):
  Promise<{ ok: true; value: BrowserStepView } | { ok: false; error: string }> {
  const { tenant, taskId, attemptId, member } = attempt;
  const fields = isRecord(asked) ? asked : {};
  const actor = { kind: "worker" as const, attemptId };
  const refuse = async (error: string, signInId?: string) => {
    await appendAudit(env, tenant, { actor, action: "browser_step.queued", subject: { ...namedIds({
      outpostId: fields.outpostId, requestId: fields.requestId, signInId }), taskId, attemptId }, outcome: "refused",
    reason: error });
    return { ok: false as const, error };
  };
  const { requestId, revision } = fields;
  if (!keysAre(fields, STEP_KEYS) || typeof requestId !== "string" || requestId.length === 0 ||
      requestId.length > MAX_REQUEST_ID || typeof revision !== "number" || !Number.isSafeInteger(revision) ||
      revision < 1) {
    return refuse("invalid_request");
  }
  const stored = await readRequest(env, tenant, taskId, requestId);
  if (stored === undefined) return refuse("task_unavailable");
  const write = stored?.action.operationType === BROWSER_SUBMIT ? submitPayloadOf(stored.action.payload) : null;
  if (!stored || !write) return refuse("request_not_found");
  const { record, action } = stored;
  if (!approvedRecord(record)) return refuse("not_approved", write.signInId);
  // A request is decided at one revision and never revised after; a step names that revision, and any other is a
  // request that has changed since it was approved.
  if (record.request.revision !== revision || record.decision.seenRevision !== revision) {
    return refuse("request_changed", write.signInId);
  }
  if (action.state === "proposed" || action.state === "rejected") return refuse("not_approved", write.signInId);
  if (action.state !== "approved" && action.state !== "expired") return refuse("already_begun", write.signInId);
  // Past its time is one answer, whether or not a begin has already marked the write expired.
  if (action.state === "expired" || !(Date.now() < Date.parse(action.expiresAt))) {
    return refuse("action_expired", write.signInId);
  }
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", "/browser-steps/submit", { outpostId: fields.outpostId,
      requestId, revision, signInId: write.signInId, url: write.url, action: write.action, site: write.site, member,
      taskId, attemptId }));
  } catch {
    answer = null;
  }
  if (!answer) return refuse("vault_unavailable", write.signInId);
  if (answer.status !== 200 || !isRecord(answer.body.step)) {
    return refuse(typeof answer.body.error === "string" ? answer.body.error : "vault_unavailable", write.signInId);
  }
  const queued = answer.body.step as BrowserStepView;
  await appendAudit(env, tenant, { actor, action: "browser_step.queued", subject: { stepId: queued.stepId,
    ...namedIds({ outpostId: queued.outpostId, signInId: write.signInId, requestId }), taskId, attemptId },
  outcome: "ok" });
  return { ok: true, value: queued };
}

/// The begin gate's answer: the approved proposal now dispatching, or the gate's refusal, or `task_unavailable` when the
/// gate could not be asked (whether it moved the write is then not known).
type Begun = { ok: true; proposal: ActionProposalJSON } | { ok: false; error: string };

/// Asks the task object's one-use begin gate, as the control plane, to move a write step's approved write to
/// dispatching. It checks, in one step with the move, that the write is still approved, that its request is approved at
/// the step's revision, and that the step's attempt still holds the task.
async function beginSubmit(env: Pick<TenantDataEnv, "TASK">, tenant: string,
  bound: { taskId: string; attemptId: string; requestId: string; revision: number }): Promise<Begun> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(bound.taskId)).fetch(new Request(
      `https://task/actions/${encodeURIComponent(bound.requestId)}/begin`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, "x-control": "1" },
        body: JSON.stringify({ grantRevision: SUBMIT_GRANT_REVISION, revision: bound.revision,
          attemptId: bound.attemptId }) }));
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && body && body.state === "dispatching") return { ok: true, proposal: body as ActionProposalJSON };
    if (response.status === 404) return { ok: false, error: "request_not_found" };
    return { ok: false, error: response.status < 500 && typeof body?.error === "string" ? body.error
      : "task_unavailable" };
  } catch {
    return { ok: false, error: "task_unavailable" };
  }
}

/// Settles a dispatching browser write, as the control plane, and writes `dispatch.settled` once it has. False when the
/// task object did not take it.
async function settleSubmit(env: SubmitEnv, tenant: string, taskId: string, requestId: string,
  outcome: "confirmed" | "failed" | "unknown", receipt?: { stepId: string; outpostId: string }): Promise<boolean> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request(
      `https://task/actions/${encodeURIComponent(requestId)}/settle`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, "x-control": "1" },
        body: JSON.stringify({ outcome, ...(receipt && outcome === "confirmed"
          ? { providerOperationId: receipt.stepId, receipt } : receipt ? { receipt } : {}) }) }));
    await response.body?.cancel();
    if (!response.ok) return false;
  } catch {
    return false;
  }
  await appendAudit(env, tenant, { actor: { kind: "system" }, action: "dispatch.settled",
    subject: { taskId, actionId: requestId }, outcome });
  return true;
}

/// A write step the vault has just taken for an outpost (browser-control.ts, `fetchSteps`): begun through the one-use
/// gate and handed out with the approved copy's values, or refused and kept from the outpost. Answers the step to hand
/// out, or null. A write the gate began but that cannot be handed out after all is settled failed, since the outpost never
/// had it. Writes `dispatch.started` and `browser_step.fetched`, by the outpost, with ids only.
export async function handOutSubmit(env: SubmitEnv, tenant: string, outpostId: string,
  taken: { step: OutpostStep; binding: StepBinding; revision?: number }): Promise<OutpostStep | null> {
  const { step, binding, revision } = taken;
  const subject = { ...binding, outpostId };
  const refuse = async (code: string) => {
    try {
      await vaultAnswer(await vaultCall(env, tenant, "POST", "/browser-steps/refuse", { stepId: step.stepId, code }));
    } catch {
      // A step the vault could not refuse stays taken until its time runs out; the outpost never has it.
    }
    await appendAudit(env, tenant, { actor: { kind: "outpost", id: outpostId }, action: "browser_step.fetched", subject,
      outcome: "refused", reason: code });
    return null;
  };
  if (binding.requestId === undefined || revision === undefined) return refuse("request_not_found");
  const begun = await beginSubmit(env, tenant, { taskId: binding.taskId, attemptId: binding.attemptId,
    requestId: binding.requestId, revision });
  if (!begun.ok) {
    // The gate could not be asked: if it did move the write, nothing was handed out, so it fails. If it did not, the
    // settle is refused and the write stays approved for a new step.
    if (begun.error === "task_unavailable") await settleSubmit(env, tenant, binding.taskId, binding.requestId, "failed");
    return refuse(begun.error);
  }
  await appendAudit(env, tenant, { actor: { kind: "system" }, action: "dispatch.started",
    subject: { taskId: binding.taskId, actionId: binding.requestId }, outcome: "ok" });
  const write = submitPayloadOf(begun.proposal.payload);
  const origin = write ? new URL(write.url).origin : null;
  // The step's page is the approved write's, and the vault let its origin through; anything else is not handed out.
  if (!write || write.url !== step.url || origin === null || step.origins.length !== 1 || step.origins[0] !== origin) {
    await settleSubmit(env, tenant, binding.taskId, binding.requestId, "failed");
    return refuse("payload_changed");
  }
  await appendAudit(env, tenant, { actor: { kind: "outpost", id: outpostId }, action: "browser_step.fetched", subject,
    outcome: "ok" });
  return { stepId: step.stepId, kind: "submit", action: write.action, url: write.url, form: write.form,
    values: write.values.map(({ field, value }) => ({ field, value })), origins: [origin], expiresAt: step.expiresAt };
}

/// A write step's report, held by the vault (browser-control.ts, `takeReport`): the write settles as the outpost said,
/// before anything else is read, since it records what was done on the site whatever may now land in the attempt.
export async function settleSubmitReport(env: SubmitEnv, tenant: string, binding: StepBinding,
  reported: { stepId: string; outcome: "done" | "failed"; code: string | null }, outpostId: string): Promise<void> {
  if (binding.requestId === undefined) return;
  await settleSubmit(env, tenant, binding.taskId, binding.requestId, submitSettlement(reported.outcome, reported.code),
    { stepId: reported.stepId, outpostId });
}
