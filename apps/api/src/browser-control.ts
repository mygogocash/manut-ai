/// Browser control's routes (docs/browser-control.md; the contract is docs/pilot-api.md, "Vault sign-ins and
/// outposts"). The records live in the shop's vault object (sign-in-vault.ts).
///
/// - The operator's side of the shop's site sign-ins and outposts, after the admin gate's exact ADMIN_METHODS entries
///   (index.ts).
/// - The outposts' own routes under `/v1/outposts/`, which need the outpost's credential as a bearer token and
///   nothing else: neither an operator's key nor an owner's session opens them. Besides the heartbeat and the redeem,
///   the step channel: an outpost asks for the browser steps workers queued for it, and reports how each went, which
///   lands in the attempt's events.
/// - The owner's routes, with the owner's session: this Mac registering itself as an outpost through the desktop
///   (`POST /v1/outposts/register`), and the owner's Connections (`ownerVaultRoute`): the shop's sign-ins and outposts, a
///   new password typed into the vault, and renaming or removing an outpost, all under `/v1/vault/`. Under
///   `/v1/outposts/` only the registration takes a session; the outposts' credentials open none of the owner's routes.
///
/// Every change is written to the shop's audit log with ids only, after it has happened (`appendAudit`): the record
/// lives in the vault object and the log in the TenantObject, so the entry is best effort and never holds the change
/// up. No entry, and no answer here but the redeem's, holds a password.

import { appendAudit, type AuditAction, type AuditOutcome, type AuditSubject } from "./audit-log";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { handOutSubmit, settleSubmitReport, submitTitle } from "./browser-writes";
import { isValidTenant } from "./companies";
import { workGate, type JobFlags } from "./job-flow";
import { callerOf, hasExactly, OWNER_SESSION, ownerActor, queryNamesSession, type Caller, type PeopleEnv } from "./people";
import { operatorIdentity } from "./pilot";
import { base64url } from "./relay";
import {
  reportShapeError,
  vaultAnswer,
  vaultCall,
  type GrantBinding,
  type OutpostStep,
  type OutpostView,
  type ReportedStep,
  type SignInView,
  type StepBinding,
  type VaultEnv,
} from "./sign-in-vault";
import type { AttemptJSON, TaskDocJSON } from "./task-object";
import type { TenantDataEnv } from "./tenant-data";

/// The redeem reads the task object too, to see that the grant's attempt still runs.
type RedeemEnv = VaultEnv & Pick<TenantDataEnv, "TASK">;

const MAX_BODY_BYTES = 16 * 1024;
/// An outpost's credential: `mo1_` and 32 random bytes in base64url. Checked before anything is read or woken, so a
/// request that does not even carry one costs the vault nothing.
const OUTPOST_CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;

/// The operator's writes, the vault path each one is, and what the log calls it.
const OPERATOR_WRITES: Readonly<Record<string, { path: string; action: AuditAction }>> = {
  "POST /v1/admin/vault/sign-ins": { path: "/sign-ins", action: "signin.created" },
  "POST /v1/admin/vault/sign-ins/password": { path: "/sign-ins/password", action: "signin.password_replaced" },
  "POST /v1/admin/vault/sign-ins/remove": { path: "/sign-ins/remove", action: "signin.removed" },
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// `/v1/admin/vault/*` and `/v1/admin/outposts{,/*}`, after the admin gate, which already required both credentials and
/// an exact method. Answers null for any other path.
export async function vaultAdminRoute(
  request: Request,
  url: URL,
  env: VaultEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/vault/") && url.pathname !== "/v1/admin/outposts" &&
      !url.pathname.startsWith("/v1/admin/outposts/")) {
    return null;
  }
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/admin/vault/sign-ins") return listSignIns(env, url);
  if (route === "GET /v1/admin/outposts") return listOutposts(env, url);
  if (route === "POST /v1/admin/outposts") return registerOutpost(request, env, ctx);
  if (route === "POST /v1/admin/outposts/remove") return removeOutpost(request, env, ctx);
  if (route === "POST /v1/admin/outposts/credential") return rotateCredential(request, env, ctx);
  const write = OPERATOR_WRITES[route];
  if (write) return operatorWrite(request, env, ctx, write);
  return json({ error: "not_found" }, 404);
}

/// The outposts' own routes, each a method and a path. The Worker's ingress gate (index.ts) limits exactly these, per
/// source address, before anything else reads the request: each takes a bearer credential, so each answer is a guess
/// someone could repeat.
const OUTPOST_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/outposts/heartbeat",
  "POST /v1/outposts/redeem",
  "POST /v1/outposts/steps",
  "POST /v1/outposts/steps/report",
]);

/// Whether a request is for one of the outposts' own routes.
export function isOutpostRoute(method: string, pathname: string): boolean {
  return OUTPOST_ROUTES.has(`${method} ${pathname}`);
}

/// `/v1/outposts/*`, the outposts' own routes. Answers null for any other path, and for a method or path under it that
/// is not a route, so those answer the Worker's final not_found like any path that does not exist.
export async function outpostRoute(request: Request, url: URL, env: RedeemEnv, flags: JobFlags):
  Promise<Response | null> {
  const route = `${request.method} ${url.pathname}`;
  if (!OUTPOST_ROUTES.has(route)) return null;
  if (route === "POST /v1/outposts/heartbeat") return outpostHeartbeat(request, env);
  if (route === "POST /v1/outposts/redeem") return redeemGrant(request, env, flags);
  if (route === "POST /v1/outposts/steps") return fetchSteps(request, env, flags);
  return takeReport(request, env, flags);
}

/// An answer that names steps, which no cache on the way may keep: they say where the shop's browser goes.
function stepsAnswer(steps: OutpostStep[]): Response {
  return Response.json({ steps }, { headers: { "cache-control": "no-store" } });
}

/// `POST /v1/outposts/steps` with `{ tenant, outpostId }`: the outpost asks for the browser steps waiting for it. In
/// order:
///
/// 1. The vault checks the outpost's credential and lists its steps waiting, oldest first, five at most. A request
///    without the credential is refused 401 and writes nothing. With none waiting the answer is an empty list, and
///    nothing else is read or written, so an outpost asking every few seconds costs little.
/// 2. The switches and the owner's consent, as at every step of the job flow. Refused, every waiting step is refused
///    with the same code, for good: the outpost never runs work the owner stopped.
/// 3. Each step's attempt still runs, read from the task object without extending its lease. A step whose attempt
///    ended is refused (`attempt_ended`); one whose task cannot be read is left waiting for the next ask.
/// 4. The vault hands the rest out, once each, with the origins its browser may be on for each, read from the
///    sign-ins again; one that may no longer run is refused there.
/// 5. A write step (`submit`) needs `officeExternalWrites` as well at step 2, and once the vault has taken it, the task
///    object's one-use begin gate moves its approved write to dispatching before it leaves (browser-writes.ts,
///    `handOutSubmit`): only then does the outpost get it, with the approved write's values.
///
/// Each step handed out or refused writes `browser_step.fetched`, by the outpost, with ids only.
async function fetchSteps(request: Request, env: RedeemEnv, flags: JobFlags): Promise<Response> {
  const read = await outpostRequest(request);
  if (read instanceof Response) return read;
  const { tenant, fields, credentialHash } = read;
  const proof = { outpostId: fields.outpostId, credentialHash };
  const pending = await askVault(env, tenant, "/browser-steps/pending", proof);
  if (!pending) return json({ error: "vault_unavailable" }, 503);
  if (pending.status === 401) return json({ error: "unauthorized" }, 401);
  if (pending.status !== 200 || !Array.isArray(pending.body.steps)) return json({ error: "vault_unavailable" }, 503);
  const waiting = pending.body.steps as { stepId: string; kind?: string; taskId: string; attemptId: string }[];
  if (waiting.length === 0) return stepsAnswer([]);

  const gated = await workGate(env, tenant, flags, false);
  const take: string[] = [];
  const refuse: { stepId: string; code: string }[] = [];
  if (gated) {
    for (const step of waiting) refuse.push({ stepId: step.stepId, code: gated.error });
  } else {
    // A write needs the external-writes switch too: without it a write step is refused for good, and reads still go.
    const writesGated = waiting.some((step) => step.kind === "submit") ? await workGate(env, tenant, flags, true) : null;
    const runs = new Map<string, boolean | undefined>();
    for (const step of waiting) {
      if (step.kind === "submit" && writesGated) {
        refuse.push({ stepId: step.stepId, code: writesGated.error });
        continue;
      }
      const attempt = `${step.taskId} ${step.attemptId}`;
      if (!runs.has(attempt)) runs.set(attempt, await attemptRuns(env, tenant, step.taskId, step.attemptId));
      const running = runs.get(attempt);
      if (running === true) take.push(step.stepId);
      else if (running === false) refuse.push({ stepId: step.stepId, code: "attempt_ended" });
    }
  }
  const handed = await askVault(env, tenant, "/browser-steps/take", { ...proof, take, refuse });
  if (!handed) return json({ error: "vault_unavailable" }, 503);
  if (handed.status === 401) return json({ error: "unauthorized" }, 401);
  if (handed.status !== 200 || !Array.isArray(handed.body.taken) || !Array.isArray(handed.body.refused)) {
    return json({ error: "vault_unavailable" }, 503);
  }
  // Past the vault's check the outpost is known, so its id is one the vault minted.
  const outpostId = String(fields.outpostId);
  const actor = { kind: "outpost", id: outpostId } as const;
  const taken = handed.body.taken as { step: OutpostStep; binding: StepBinding; revision?: number }[];
  const out: OutpostStep[] = [];
  for (const entry of taken) {
    if (entry.step.kind === "submit") {
      const begun = await handOutSubmit(env, tenant, outpostId, entry);
      if (begun) out.push(begun);
      continue;
    }
    await appendAudit(env, tenant, { actor, action: "browser_step.fetched", subject: { ...entry.binding, outpostId },
      outcome: "ok" });
    out.push(entry.step);
  }
  for (const { code, binding } of handed.body.refused as { code: string; binding: StepBinding }[]) {
    await appendAudit(env, tenant, { actor, action: "browser_step.fetched", subject: { ...binding, outpostId },
      outcome: "refused", reason: code });
  }
  if (gated) return json({ error: gated.error, ...(gated.feature ? { feature: gated.feature } : {}) }, gated.status);
  return stepsAnswer(out);
}

/// `POST /v1/outposts/steps/report` with `{ tenant, outpostId, stepId, outcome, code?, text? }`: how a step the outpost
/// was handed went, once. In order:
///
/// 1. The report's shape: `done`, or `failed` with a code from the fixed list; a read's text at most 4 KB as JSON. One
///    that fails this is refused 400 before anything is read, and uses nothing up, so the outpost can cut its text and
///    report again.
/// 2. The vault checks the outpost's credential, that the step is its own, was handed out, is not yet reported and is
///    on time, and holds the report: from here a second report is refused, whatever comes next. A read whose text holds
///    a sign-in's password is held as failed, `text_withheld`, with no text.
/// 3. The switches and the owner's consent.
/// 4. The outcome lands in the attempt's events through the task object's control path, only while the attempt still
///    runs and without extending its lease, so an outpost can never keep a silent worker's attempt alive. Then the
///    vault lets it stand, and the worker can read it.
///
/// A refusal at 3 or 4 takes the report back: the step reads refused, with that code, and what it read is dropped.
/// A write step's report settles its write first, once the vault holds it (browser-writes.ts, `settleSubmitReport`):
/// what was done on the site stands, whatever can still land in the attempt.
/// Every answer after the vault's credential check writes `browser_step.reported`, by the outpost, with ids only.
async function takeReport(request: Request, env: RedeemEnv, flags: JobFlags): Promise<Response> {
  const read = await outpostRequest(request);
  if (read instanceof Response) return read;
  const { tenant, fields, credentialHash } = read;
  const shape = reportShapeError(fields);
  if (shape) return json({ error: shape }, 400);
  const reported = await askVault(env, tenant, "/browser-steps/report", { stepId: fields.stepId,
    outpostId: fields.outpostId, credentialHash, outcome: fields.outcome, code: fields.code, text: fields.text });
  if (!reported) return json({ error: "vault_unavailable" }, 503);
  if (reported.status === 401) return json({ error: "unauthorized" }, 401);
  const outpostId = String(fields.outpostId);
  const binding = isRecord(reported.body.binding) ? reported.body.binding as StepBinding : null;
  const subject: AuditSubject = { ...binding, outpostId };
  const record = (outcome: AuditOutcome, reason?: string) => appendAudit(env, tenant, {
    actor: { kind: "outpost", id: outpostId }, action: "browser_step.reported", subject, outcome,
    ...(reason !== undefined ? { reason } : {}) });
  const step = isRecord(reported.body.step) ? reported.body.step as ReportedStep : null;
  if (reported.status !== 200 || !binding || !step) {
    const error = typeof reported.body.error === "string" ? reported.body.error : "vault_unavailable";
    await record("refused", error);
    return json({ error }, reported.status === 200 ? 503 : reported.status);
  }
  if (step.kind === "submit") await settleSubmitReport(env, tenant, binding, step, outpostId);
  const takeBack = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
    await askVault(env, tenant, "/browser-steps/settle", { stepId: step.stepId, code: error });
    await record("refused", error);
    return json({ error, ...extra }, status);
  };
  const gated = await workGate(env, tenant, flags, false);
  if (gated) return takeBack(gated.status, gated.error, gated.feature ? { feature: gated.feature } : {});
  const landed = await landOutcome(env, tenant, binding, step);
  if (landed !== "landed") return takeBack(landed === "attempt_ended" ? 409 : 503, landed);
  const settled = await askVault(env, tenant, "/browser-steps/settle", { stepId: step.stepId });
  if (!settled || settled.status !== 200) {
    await record("refused", "vault_unavailable");
    return json({ error: "vault_unavailable" }, 503);
  }
  await record(step.outcome, step.outcome === "failed" && step.code !== null ? step.code : undefined);
  return json({ step: { stepId: step.stepId, state: step.outcome } });
}

/// Lands a reported step's outcome in the attempt's events, through the task object's control path, as a tool call
/// in the agent event contract: `toolStarted` as it was queued, then `toolUpdated` with how it ended (a read's text, or
/// a failure's code). Every reader of the timeline shows it with no new kind of event. Answers whether it landed, the
/// attempt no longer runs, or the task could not be written.
async function landOutcome(env: RedeemEnv, tenant: string, binding: StepBinding, step: ReportedStep):
  Promise<"landed" | "attempt_ended" | "task_unavailable"> {
  const events = [
    { type: "toolStarted", id: step.stepId, call: { kind: "web", title: stepTitle(step), output: "",
      status: "running", edits: [], startedAt: step.queuedAt } },
    { type: "toolUpdated", id: step.stepId, update: { status: step.outcome === "done" ? "completed" : "failed",
      output: step.text ?? step.code ?? "" } },
  ];
  try {
    const response = await env.TASK.get(env.TASK.idFromName(binding.taskId)).fetch(new Request(
      `https://task/attempts/${encodeURIComponent(binding.attemptId)}/outpost-events`, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant": tenant, "x-control": "1" },
        body: JSON.stringify({ events }) }));
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (response.ok) return "landed";
    const ended = response.status === 404 || (response.status === 409 &&
      ["stale_attempt", "lease_expired", "task_settled"].includes(String(answer?.error)));
    return ended ? "attempt_ended" : "task_unavailable";
  } catch {
    return "task_unavailable";
  }
}

/// What the attempt's events call a step, in plain words, from what the worker asked for: never anything it read.
function stepTitle(step: ReportedStep): string {
  if (step.kind === "open") return `Open ${step.url ?? "a page"}`;
  if (step.kind === "read") return step.selector !== null ? `Read ${step.selector}` : "Read the page";
  if (step.kind === "submit") return submitTitle(step.action, step.site);
  return `Sign in to ${step.site ?? "a site"}`;
}

/// `POST /v1/outposts/redeem` with `{ tenant, outpostId, grantId }`: the outpost is about to type a sign-in for a
/// worker's step, and asks for it. In order:
///
/// 1. The vault checks the outpost's credential and that the grant is its own, unused and on time, and uses it up. A
///    request without the outpost's credential is refused 401, uses nothing up and writes nothing to the shop's log,
///    so nobody can fill a shop's log from outside.
/// 2. The switches and the owner's consent, as at every step of the job flow.
/// 3. The attempt the grant was issued to still runs.
/// 4. The vault answers the username, the password and the origins, and marks the sign-in used.
///
/// Every answer after the first check writes `signin.redeemed`, by the outpost, with ids only. Only the last holds the
/// password, and it is not to be stored anywhere on the way (`no-store`).
async function redeemGrant(request: Request, env: RedeemEnv, flags: JobFlags): Promise<Response> {
  const read = await outpostRequest(request);
  if (read instanceof Response) return read;
  const { tenant, fields, credentialHash } = read;
  const proof = { grantId: fields.grantId, outpostId: fields.outpostId, credentialHash };
  let claimed: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    claimed = await vaultAnswer(await vaultCall(env, tenant, "POST", "/sign-in-grants/claim", proof));
  } catch {
    claimed = null;
  }
  if (!claimed) return json({ error: "vault_unavailable" }, 503);
  if (claimed.status === 401) return json({ error: "unauthorized" }, 401);
  // Past the vault's check the outpost is known, so its id is one the vault minted.
  const outpostId = String(fields.outpostId);
  const binding = isRecord(claimed.body.binding) ? claimed.body.binding as GrantBinding : null;
  const subject: AuditSubject = binding
    ? { signInId: binding.signInId, taskId: binding.taskId, attemptId: binding.attemptId, outpostId,
      grantId: String(fields.grantId) }
    : { outpostId };
  const record = async (outcome: "ok" | "refused", reason?: string) => appendAudit(env, tenant, {
    actor: { kind: "outpost", id: outpostId }, action: "signin.redeemed", subject, outcome,
    ...(reason !== undefined ? { reason } : {}) });
  const refuse = async (status: number, error: string, extra: Record<string, unknown> = {}) => {
    await record("refused", error);
    return json({ error, ...extra }, status);
  };
  if (claimed.status !== 200 || !binding) {
    return refuse(claimed.status === 200 ? 503 : claimed.status,
      typeof claimed.body.error === "string" ? claimed.body.error : "vault_unavailable");
  }
  const gated = await workGate(env, tenant, flags, false);
  if (gated) return refuse(gated.status, gated.error, gated.feature ? { feature: gated.feature } : {});
  const running = await attemptRuns(env, tenant, binding.taskId, binding.attemptId);
  if (running === undefined) return refuse(503, "task_unavailable");
  if (!running) return refuse(409, "attempt_ended");
  let opened: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    opened = await vaultAnswer(await vaultCall(env, tenant, "POST", "/sign-in-grants/open", proof));
  } catch {
    opened = null;
  }
  if (!opened) return refuse(503, "vault_unavailable");
  if (opened.status !== 200) {
    return refuse(opened.status, typeof opened.body.error === "string" ? opened.body.error : "vault_unavailable");
  }
  await record("ok");
  return Response.json(opened.body, { headers: { "cache-control": "no-store" } });
}

/// Whether the attempt a grant was issued to still runs, by the task object's own rules for a fenced step: active,
/// neither its lease nor its deadline passed, and its task not settled. Read from the task's export, which changes
/// nothing, rather than a heartbeat, which would extend the lease: an outpost redeeming a grant must not keep a silent
/// worker's attempt alive. An attempt the export does not carry (it carries 200) reads as ended. Undefined when the task
/// cannot be read.
async function attemptRuns(env: RedeemEnv, tenant: string, taskId: string, attemptId: string):
  Promise<boolean | undefined> {
  try {
    const response = await env.TASK.get(env.TASK.idFromName(taskId)).fetch(new Request("https://task/export",
      { headers: { "x-tenant": tenant } }));
    if (response.status === 404) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const { task, attempts } = (await response.json()) as { task: TaskDocJSON; attempts: AttemptJSON[] };
    const attempt = attempts.find((entry) => entry.id === attemptId);
    const nowS = Date.now() / 1000;
    return attempt !== undefined && attempt.status === "active" && attempt.leaseUntil > nowS &&
      attempt.deadline > nowS && task.state !== "completed" && task.state !== "cancelled";
  } catch {
    return undefined;
  }
}

/// The outpost's credential from `Authorization: Bearer`, or null when there is none of the right shape.
function presentedCredential(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const credential = header.slice("Bearer ".length);
  return OUTPOST_CREDENTIAL.test(credential) ? credential : null;
}

/// An outpost's request, read: its credential first, so a request without one is refused before its body is read,
/// then `{ tenant, ... }`. Answers the refusal to send, or the tenant, the rest of the body and the credential's digest.
async function outpostRequest(request: Request): Promise<Response |
  { tenant: string; fields: Record<string, unknown>; credentialHash: string }> {
  const credential = presentedCredential(request);
  if (!credential) return json({ error: "unauthorized" }, 401);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const { tenant, ...fields } = parsed.value;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  return { tenant, fields, credentialHash: await sha256Hex(credential) };
}

/// `POST /v1/outposts/heartbeat` with `{ tenant, outpostId }`: the outpost is awake. Answers it as the operator lists
/// it. Not written to the audit log: a beat changes nothing but its time.
async function outpostHeartbeat(request: Request, env: VaultEnv): Promise<Response> {
  const read = await outpostRequest(request);
  if (read instanceof Response) return read;
  try {
    const answer = await vaultAnswer(await vaultCall(env, read.tenant, "POST", "/outposts/heartbeat",
      { outpostId: read.fields.outpostId, credentialHash: read.credentialHash }));
    if (answer) return json(answer.body, answer.status);
  } catch {
    // Answered below.
  }
  return json({ error: "vault_unavailable" }, 503);
}

/// `GET /v1/admin/outposts?tenant=`: the shop's outposts, oldest first, each `online` or `asleep` as of now. Never a
/// credential or its digest.
async function listOutposts(env: VaultEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", "/outposts"));
    if (!answer || answer.status !== 200) return json({ error: "vault_unavailable" }, 503);
    return json({ tenant, outposts: answer.body.outposts as OutpostView[] });
  } catch {
    return json({ error: "vault_unavailable" }, 503);
  }
}

/// A new outpost credential: `mo1_` and 32 random bytes in base64url. Minted here and handed out once; only its digest
/// ever goes to the vault.
function mintCredential(): string {
  return `mo1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/// The one answer that holds a new credential, which no cache on the way may keep.
function credentialAnswer(outpost: OutpostView, credential: string): Response {
  return Response.json({ outpost, credential }, { headers: { "cache-control": "no-store" } });
}

/// An operator's request body, read: `{ tenant, ... }`. Answers the refusal to send, or the tenant and the rest.
async function operatorBody(request: Request): Promise<Response | { tenant: string; fields: Record<string, unknown> }> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const { tenant, ...fields } = parsed.value;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  return { tenant, fields };
}

/// One call to the shop's vault object, or null when it did not answer one it understood.
async function askVault(env: VaultEnv, tenant: string, path: string, body: Record<string, unknown>):
  Promise<Awaited<ReturnType<typeof vaultAnswer>>> {
  try {
    return await vaultAnswer(await vaultCall(env, tenant, "POST", path, body));
  } catch {
    return null;
  }
}

/// `POST /v1/admin/outposts` with `{ tenant, name, kind }`: registers an outpost and answers its credential, this once.
/// The credential is minted here and only its digest goes to the vault, so it is kept nowhere: an outpost that loses
/// it gets a new one (`POST /v1/admin/outposts/credential`).
async function registerOutpost(request: Request, env: VaultEnv, ctx: ExecutionContext): Promise<Response> {
  const read = await operatorBody(request);
  if (read instanceof Response) return read;
  const { tenant, fields } = read;
  const credential = mintCredential();
  const answer = await askVault(env, tenant, "/outposts",
    { name: fields.name, kind: fields.kind, credentialHash: await sha256Hex(credential) });
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status !== 200 || !isRecord(answer.body.outpost)) return json(answer.body, answer.status);
  const outpost = answer.body.outpost as OutpostView;
  await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
    action: "outpost.registered", subject: { outpostId: outpost.id }, outcome: "ok" });
  return credentialAnswer(outpost, credential);
}

/// `POST /v1/outposts/register` with `{ name, kind: "this_mac" }` and the owner's session: the desktop registers the
/// Mac it runs on as one of the shop's outposts, and answers `{ tenant, outpost, credential }`, the credential this once
/// and only its digest kept, as at the operator's registration. Answers null for any other method or path, so those
/// answer the Worker's final not_found.
///
/// - **Who.** The shop and the role come from the session alone (`callerOf`, people.ts): an owner session of the shop's
///   linked account, or the shop's own signed-in session. A helper's session is refused (`owner_only`): an outpost
///   receives the shop's passwords, so only the owner may add one. A body that names a shop is refused rather than read
///   as another shop.
/// - **What.** `this_mac` only: a cloud outpost is a machine the operator runs, and registers.
/// - **The log.** `outpost.registered` with the outpost's id, by the owner's linked account, or by the shop's own
///   session (`owner-session`), as the owner's other changes are logged.
///
/// It is not behind the outposts' ingress limit, which is for routes that take an outpost's credential: like every
/// session route it needs a session first, and a shop holds 20 outposts at most.
export async function ownerOutpostRoute(request: Request, url: URL, env: VaultEnv & PeopleEnv):
  Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/v1/outposts/register") return null;
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || "tenant" in parsed.value) return json({ error: "invalid_request" }, 400);
  if (parsed.value.kind !== "this_mac") return json({ error: "invalid_kind" }, 400);
  const tenant = caller.shop;
  const credential = mintCredential();
  const answer = await askVault(env, tenant, "/outposts",
    { name: parsed.value.name, kind: "this_mac", credentialHash: await sha256Hex(credential) });
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status !== 200 || !isRecord(answer.body.outpost)) return json(answer.body, answer.status);
  const outpost = answer.body.outpost as OutpostView;
  await appendAudit(env, tenant, { actor: { kind: "owner", id: caller.accountId ?? OWNER_SESSION },
    action: "outpost.registered", subject: { outpostId: outpost.id }, outcome: "ok" });
  return Response.json({ tenant, outpost, credential }, { headers: { "cache-control": "no-store" } });
}

/// `POST /v1/admin/outposts/credential` with `{ tenant, outpostId }`: a new credential for the outpost, answered this
/// once, as at registration. The old one stops working at once, and the outpost is asleep until the new one beats.
async function rotateCredential(request: Request, env: VaultEnv, ctx: ExecutionContext): Promise<Response> {
  const read = await operatorBody(request);
  if (read instanceof Response) return read;
  const { tenant, fields } = read;
  const credential = mintCredential();
  const answer = await askVault(env, tenant, "/outposts/credential",
    { outpostId: fields.outpostId, credentialHash: await sha256Hex(credential) });
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status !== 200 || !isRecord(answer.body.outpost)) return json(answer.body, answer.status);
  const outpost = answer.body.outpost as OutpostView;
  await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
    action: "outpost.credential_rotated", subject: { outpostId: outpost.id }, outcome: "ok" });
  return credentialAnswer(outpost, credential);
}

/// `POST /v1/admin/outposts/remove` with `{ tenant, outpostId }`: the outpost is gone, its credential stops working at
/// once, and whatever still waited for it is refused in the same step (sign-in-vault.ts). Answers what the vault
/// answers, with how many it refused.
async function removeOutpost(request: Request, env: VaultEnv, ctx: ExecutionContext): Promise<Response> {
  const read = await operatorBody(request);
  if (read instanceof Response) return read;
  const { tenant, fields } = read;
  const answer = await askVault(env, tenant, "/outposts/remove", { outpostId: fields.outpostId });
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status === 200 && typeof answer.body.outpostId === "string") {
    await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
      action: "outpost.removed", subject: { outpostId: answer.body.outpostId }, outcome: "ok" });
  }
  return json(answer.body, answer.status);
}

/// `GET /v1/admin/vault/sign-ins?tenant=`: the shop's live sign-ins, oldest first, each saying only that its password
/// is set.
async function listSignIns(env: VaultEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", "/sign-ins"));
    if (!answer || answer.status !== 200) return json({ error: "vault_unavailable" }, 503);
    return json({ tenant, signIns: answer.body.signIns as SignInView[] });
  } catch {
    return json({ error: "vault_unavailable" }, 503);
  }
}

/// `POST /v1/admin/vault/sign-ins{,/password,/remove}` with `{ tenant, ... }`: the operator's change, recorded under
/// the operator's Access identity (none for a service token). Answers what the vault answers: the sign-in's public view
/// on success, or the refusal with its status.
async function operatorWrite(request: Request, env: VaultEnv, ctx: ExecutionContext,
  write: { path: string; action: AuditAction }): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  const { tenant, ...fields } = body;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", write.path, fields));
  } catch {
    answer = null;
  }
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status === 200) {
    const signInId = isRecord(answer.body.signIn) ? answer.body.signIn.id : answer.body.signInId;
    if (typeof signInId === "string") {
      await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
        action: write.action, subject: { signInId }, outcome: "ok" });
    }
  }
  return json(answer.body, answer.status);
}

// The owner's Connections: the shop's sign-ins and outposts, from the owner's own session (docs/browser-control.md,
// "The owner's Connections"; docs/pilot-api.md, "The owner's vault and outposts").

/// Each owner route by its path: the one method it takes, and for a change, the exact keys of its body (each a string).
const OWNER_VAULT_ROUTES: ReadonlyMap<string, { method: "GET" | "POST"; keys?: readonly string[] }> = new Map([
  ["/v1/vault/sign-ins", { method: "GET" }],
  ["/v1/vault/sign-ins/password", { method: "POST", keys: ["signInId", "password"] }],
  ["/v1/vault/outposts", { method: "GET" }],
  ["/v1/vault/outposts/rename", { method: "POST", keys: ["outpostId", "name"] }],
  ["/v1/vault/outposts/remove", { method: "POST", keys: ["outpostId"] }],
] as const);

/// The owner's routes for the shop's vault and outposts, which the desktop's Customize › Connections uses. Answers null for
/// any other path, so it answers the Worker's final not_found.
///
/// - **Who.** The shop and the role come from the session alone (`callerOf`, people.ts): an owner session of the shop's
///   linked account, or the shop's own signed-in session. A helper's session is refused (`owner_only`): the vault holds
///   the shop's passwords, and an outpost receives them, so only the owner sees or changes either. The order is who is
///   asking (401 or 503), then the role (403), the method (405), the query and the body (400), as on the owner's other
///   routes, so a caller with no session learns nothing about a route, not even its method.
/// - **Lists.** `GET /v1/vault/sign-ins` and `GET /v1/vault/outposts` answer what the operator's lists answer for the shop: each
///   sign-in's public view, which says only that its password is set, and each outpost without its credential's digest.
/// - **Changes.** A new password (`POST /v1/vault/sign-ins/password`), and renaming or removing an outpost
///   (`POST /v1/vault/outposts/rename`, `POST /v1/vault/outposts/remove`). Each goes through the same operation of the shop's vault as
///   the operator's route, or for a rename the vault's own, so there is one way to each record. A body is exactly the keys
///   its route reads, each a string: a `tenant`, a `shop` or a `role` above all is refused rather than read.
/// - **The password.** It goes from the body straight into the vault, which seals it as the operator's route does. It is
///   never kept here, logged, or answered: the answer is the sign-in's public view, and the log names the sign-in by id.
/// - **The log.** Each change done writes its entry by the owner (`ownerActor`), with the record's id only; a refusal
///   writes nothing, as the operator's do not. Nothing here is behind the outposts' ingress limit: like every session
///   route it needs a session first.
export async function ownerVaultRoute(request: Request, url: URL, env: VaultEnv & PeopleEnv):
  Promise<Response | null> {
  const route = OWNER_VAULT_ROUTES.get(url.pathname);
  if (!route) return null;
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  if (request.method !== route.method) return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  const tenant = caller.shop;
  if (url.pathname === "/v1/vault/sign-ins") return ownerList(env, tenant, "/sign-ins", "signIns");
  if (url.pathname === "/v1/vault/outposts") return ownerList(env, tenant, "/outposts", "outposts");
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  const keys = route.keys ?? [];
  if (!isRecord(body) || !hasExactly(body, keys) || !keys.every((key) => typeof body[key] === "string")) {
    return json({ error: "invalid_request" }, 400);
  }
  if (url.pathname === "/v1/vault/sign-ins/password") return ownerNewPassword(env, tenant, caller, body);
  if (url.pathname === "/v1/vault/outposts/rename") return ownerOutpostChange(env, tenant, caller, "/outposts/rename", body);
  return ownerOutpostChange(env, tenant, caller, "/outposts/remove", body);
}

/// One of the shop's two lists, as the operator's list answers it for the same shop.
async function ownerList(env: VaultEnv, tenant: string, path: "/sign-ins" | "/outposts", field: "signIns" | "outposts"):
  Promise<Response> {
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", path));
    if (!answer || answer.status !== 200 || !Array.isArray(answer.body[field])) {
      return json({ error: "vault_unavailable" }, 503);
    }
    return json({ tenant, [field]: answer.body[field] });
  } catch {
    return json({ error: "vault_unavailable" }, 503);
  }
}

/// `POST /v1/vault/sign-ins/password` with exactly `{ signInId, password }`: the owner's new password, sealed by the
/// vault in place of the old one (`/sign-ins/password`, the operator's own operation), which also mends a broken
/// sign-in. Only the two fields are passed on, and the answer is the vault's, which never holds the password.
async function ownerNewPassword(env: VaultEnv, tenant: string, caller: Extract<Caller, { role: "owner" }>,
  body: Record<string, unknown>): Promise<Response> {
  const answer = await askVault(env, tenant, "/sign-ins/password", { signInId: body.signInId, password: body.password });
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  const signIn = answer.status === 200 && isRecord(answer.body.signIn) ? answer.body.signIn : null;
  if (signIn && typeof signIn.id === "string") {
    await appendAudit(env, tenant, { actor: ownerActor(caller), action: "signin.password_replaced",
      subject: { signInId: signIn.id }, outcome: "ok" });
  }
  return json(answer.body, answer.status);
}

/// `POST /v1/vault/outposts/rename` with exactly `{ outpostId, name }`, or `POST /v1/vault/outposts/remove` with exactly
/// `{ outpostId }`: the vault renames the outpost, or removes it as the operator's removal does, so its credential stops
/// working at once and whatever waited for it is refused in the same step. Answers what the vault answers.
async function ownerOutpostChange(env: VaultEnv, tenant: string, caller: Extract<Caller, { role: "owner" }>,
  path: "/outposts/rename" | "/outposts/remove", body: Record<string, unknown>): Promise<Response> {
  const answer = await askVault(env, tenant, path, body);
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  const outpostId = path === "/outposts/rename"
    ? (isRecord(answer.body.outpost) ? answer.body.outpost.id : null)
    : answer.body.outpostId;
  if (answer.status === 200 && typeof outpostId === "string") {
    await appendAudit(env, tenant, { actor: ownerActor(caller),
      action: path === "/outposts/rename" ? "outpost.renamed" : "outpost.removed", subject: { outpostId }, outcome: "ok" });
  }
  return json(answer.body, answer.status);
}
