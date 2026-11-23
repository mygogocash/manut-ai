import { DurableObject } from "cloudflare:workers";
import {
  decideTransition,
  openTransition,
  requestStanding,
  ROLES,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRecord,
  type DecideResult,
  type Decision,
  type NewApprovalRequest,
  type Role,
  type Standing,
} from "@manut/approval-core";
import { readJsonBody } from "./body";
import { isValidCompanyId } from "./companies";
import { isValidLinePushProposal, LINE_PUSH_OPERATION, lineReplyText } from "./connectors/line";
import { isPrunableAction, isPrunableAttempt } from "./retention";

export type TaskCriterionJSON = {
  id: string;
  text: string;
  satisfied: boolean;
  /// Who satisfied it: "human", or a deterministic check as "check:<name>".
  /// A satisfied criterion without provenance is a model claim, never evidence.
  by?: string;
};

export type TaskRecordJSON = {
  id: string;
  title: string;
  objective: string;
  state: string;
  location: "local" | "cloud";
  funding: "localProvider" | "cloudBYOK" | "managedAI";
  criteria: TaskCriterionJSON[];
  updatedAt: string;
  /// Owning tenant, stamped by the worker from the verified session. Absent
  /// on prototype-era records, which stay readable to preserve upgrades.
  tenantId?: string;
  /// Owning company, stamped by the worker after it verifies membership and
  /// grants — never trusted from the client body (see PUT). Absent on tasks
  /// outside any company, which keep tenant-only isolation.
  companyId?: string;
};

/// One entry in a task's durable event log. Sequence numbers are monotonic per
/// task: replay filters on them, and compaction only ever moves the floor
/// forward, so a cursor below the floor means the client must resync.
export type TaskEventJSON = {
  seq: number;
  /// `agent` is what a worker reported (job-flow.ts): `event` holds it exactly
  /// as it arrived and `attemptId` names the attempt that reported it.
  kind: "created" | "migrated" | "state" | "updated" | "agent";
  at: string;
  from?: string;
  to?: string;
  rev: number;
  /// Which write produced the entry: "put", "command:<type>",
  /// "attempt:<action>:<id>", or "action:<step>:<id>".
  via?: string;
  attemptId?: string;
  /// An agent event in the wire shape of packages/agent-events: one object
  /// with a `type`. Kept whole whatever its kind, a kind no reader knows yet
  /// included, because readers decode tolerantly and the log is the record.
  event?: unknown;
};

/// Versioned task document. Carries the prototype record's fields unchanged so
/// older readers tolerate it, plus a schema tag and a revision that writes
/// fence on: a PUT carrying a stale expected revision is rejected.
export type TaskDocJSON = TaskRecordJSON & {
  schema: 1;
  rev: number;
};

const MAX_BODY_BYTES = 256 * 1024;
const MAX_WRITES_PER_MINUTE = 120;
const MAX_IDEMPOTENCY_KEYS = 200;
/// Retained events per task. Past this, the oldest entries are dropped and the
/// floor advances; replay below the floor answers resync-required instead of a
/// partial history.
const MAX_EVENTS = 100;
/// Pilot execution bounds, applied per attempt unless the claim narrows them:
/// at most this many tool operations, this long of active runtime. Waiting
/// for a human approval holds the attempt without consuming either.
const DEFAULT_MAX_STEPS = 40;
const DEFAULT_MAX_ACTIVE_SECONDS = 1200;
const LEASE_SECONDS = 300;
const MAX_REPLAY_LIMIT = 1000;
/// Most attempts a single export carries. Claims can grow without bound, so
/// an unbounded read would let one hot task swell the whole export.
const MAX_EXPORT_ATTEMPTS = 200;

/// One execution of a task by one executor. The fencing token plus the lease
/// decide who may publish: a stale or fenced-out executor's steps and finish
/// are rejected, and a lapsed lease marks the attempt instead of letting it
/// act indefinitely.
export type AttemptJSON = {
  id: string;
  executorId: string;
  /// New attempts use a random 128-bit token. Numeric prototype-era records
  /// remain exportable but cannot authorize another mutation; claim anew.
  fence: string | number;
  leaseUntil: number;
  inputRevision: string;
  model?: string;
  maxSteps: number;
  deadline: number;
  /// The attempt's lifecycle: whether it may still publish. It says nothing
  /// about how the work went, so a failed run is `done` too.
  status: "active" | "done";
  /// What the executor reported when it finished. Kept apart from `status` so
  /// recovery and audit can tell a clean finish from a failure instead of
  /// trusting every closed attempt. Records finished before this field
  /// existed have none; a reader must take that as unknown, never as success.
  /// `cancelled` is the control plane stopping the attempt (job-flow.ts).
  outcome?: "done" | "failed" | "cancelled";
  /// Why it failed or was cancelled, as a code: `budget`, `silent` (it stopped
  /// reporting), `deadline`, or one the worker gave.
  reason?: string;
  /// Epoch seconds when the attempt finished. Stamped at finish; absent on
  /// older records, whose age is unknown and which the retention sweep
  /// therefore never prunes.
  finishedAt?: number;
  steps: StepJSON[];
};

export type StepJSON = {
  id: string;
  name: string;
  status: "done" | "failed";
  outputRef?: string;
};

/// Legal state transitions, mirroring SparkTaskState.canTransition in Swift.
/// Terminal states never leave; failed may retry through queued.
const TRANSITIONS: Record<string, string[]> = {
  draft: ["draft", "queued", "cancelled"],
  queued: ["queued", "running", "cancelled", "failed"],
  running: [
    "running",
    "verifying",
    "waitingForInput",
    "waitingForAuthorization",
    "waitingForProvider",
    "paused",
    "recovering",
    "failed",
    "cancelled",
  ],
  verifying: ["verifying", "completed", "failed", "running", "paused", "recovering", "cancelled"],
  waitingForInput: ["waitingForInput", "running", "paused", "cancelled", "failed"],
  waitingForAuthorization: ["waitingForAuthorization", "running", "paused", "cancelled", "failed"],
  waitingForProvider: ["waitingForProvider", "running", "paused", "cancelled", "failed"],
  paused: ["paused", "queued", "running", "cancelled", "failed", "recovering"],
  recovering: ["recovering", "running", "failed", "cancelled"],
  failed: ["failed", "queued", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

const KNOWN_STATES = new Set(Object.keys(TRANSITIONS));
const KNOWN_FUNDING = new Set(["localProvider", "cloudBYOK", "managedAI"]);

function canTransition(from: string, to: string): boolean {
  return from === to || (TRANSITIONS[from] ?? []).includes(to);
}

/// A completed or cancelled task is finished for good: it never leaves those
/// states, so nothing may start or continue work on it. Attempts and action
/// dispatch share this one rule.
function isSettled(doc: TaskDocJSON): boolean {
  return doc.state === "completed" || doc.state === "cancelled";
}

/// Client-submittable lifecycle commands. Every edge is legal in the base
/// table except replan, which returns a paused or failed task to draft for a
/// new plan: a deliberate, recorded extension, not a silent extra.
/// No command reaches running, verifying, or completed; those stay on the
/// trusted execution path with their evidence.
const COMMANDS: Record<string, { from: string[]; to: string }> = {
  queue: { from: ["draft", "paused", "failed"], to: "queued" },
  pause: {
    from: ["running", "verifying", "waitingForInput", "waitingForAuthorization", "waitingForProvider"],
    to: "paused",
  },
  cancel: {
    from: [
      "draft",
      "queued",
      "running",
      "verifying",
      "waitingForInput",
      "waitingForAuthorization",
      "waitingForProvider",
      "paused",
      "recovering",
      "failed",
    ],
    to: "cancelled",
  },
  retry: { from: ["failed", "paused"], to: "queued" },
  replan: { from: ["paused", "failed"], to: "draft" },
};

/// A stored idempotency outcome: the canonical request hash it belongs to,
/// plus the exact status and body to replay.
type IdemEntry = {
  hash: string;
  status: number;
  body: TaskDocJSON;
};

/// Deterministic serialization for request hashing: object keys sorted
/// recursively, so equivalent payloads hash alike regardless of key order.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/// Binds an idempotency key to one exact request: method, normalized route,
/// and canonical body. The same key with a different payload is a client bug,
/// answered 409 rather than replaying somebody else's outcome.
async function requestHash(method: string, route: string, raw: string): Promise<string> {
  let normalized: unknown = raw;
  try {
    normalized = JSON.parse(raw);
  } catch {
    // Unparseable bodies keep their raw form; shape validation answers 400.
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${method}\n${route}\n${canonical(normalized)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/// External operations the pilot may perform after exact approval. Anything
/// else is rejected at propose time; adding a type is a deliberate,
/// separately reviewed change. `line.message.push` is the Manut AI pilot's
/// owner-approved LINE reply (docs/pilot-api.md).
const ACTION_ALLOWLIST = new Set(["linear.issue.create", LINE_PUSH_OPERATION]);

/// An immutable external-action proposal with its approval and dispatch
/// history. The id is the stable logical operation id: retries and recovery
/// attempts reference it, and exactly one receipt ever attaches to it.
export type ActionProposalJSON = {
  id: string;
  tenant: string;
  /// Owning company, copied from the task at propose time. Lets fellow
  /// members read the proposal through the same company-member assertion as
  /// tasks. Absent on pre-company proposals, which keep tenant-only reads.
  companyId?: string;
  connectionId: string;
  providerAccountId: string;
  operationType: string;
  targetResourceId: string;
  resourceScope: string[];
  payload: Record<string, unknown>;
  payloadHash: string;
  recipients?: string[];
  attachmentHashes?: string[];
  expectedTargetRevision?: string;
  grantRevision: number;
  proposedAt: string;
  expiresAt: string;
  state:
    | "proposed"
    | "approved"
    | "rejected"
    | "expired"
    | "dispatching"
    | "confirmed"
    | "failed"
    | "unknown";
  approval?: { by: string; at: string };
  dispatch?: { at: string; providerOperationId?: string; receipt?: unknown };
  /// Set on an action an approval-core request alone decides: one a worker
  /// asked for (job-flow.ts), and every reply. It is the id of that request,
  /// which is the action's own id. The older decision route refuses a
  /// worker's action, and decides a reply only through its request, so the
  /// request's rules (who may decide, once, while its attempt runs, before it
  /// expires) have no way round. A reply stored before replies carried
  /// requests has none until its first decision stores one.
  requestId?: string;
};

/// Deterministic serialization for hashing: object keys sorted recursively,
/// so equivalent payloads hash alike regardless of key order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

async function payloadHash(content: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableStringify(content)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type HashedActionFields = Pick<
  ActionProposalJSON,
  | "connectionId"
  | "providerAccountId"
  | "operationType"
  | "targetResourceId"
  | "resourceScope"
  | "payload"
  | "recipients"
  | "attachmentHashes"
  | "expectedTargetRevision"
  | "grantRevision"
  | "expiresAt"
>;

/// Everything a human approves, in the one shape that is hashed. Propose
/// hashes the validated request through it and dispatch begin hashes the
/// stored record through it, so the two digests agree exactly when the
/// content is what was approved. Lists are sorted because their order
/// carries no meaning, and absent optionals hash as empty or null so a
/// stored record, which omits them, matches the request that proposed it.
function actionHashable(fields: HashedActionFields): Record<string, unknown> {
  return {
    connectionId: fields.connectionId,
    providerAccountId: fields.providerAccountId,
    operationType: fields.operationType,
    targetResourceId: fields.targetResourceId,
    resourceScope: [...fields.resourceScope].sort(),
    payload: fields.payload,
    recipients: [...(fields.recipients ?? [])].sort(),
    attachmentHashes: [...(fields.attachmentHashes ?? [])].sort(),
    expectedTargetRevision: fields.expectedTargetRevision ?? null,
    grantRevision: fields.grantRevision,
    expiresAt: fields.expiresAt,
  };
}

/// Everything a proposal carries about the action itself, checked, with its hash.
type ProposalFields = HashedActionFields & { payloadHash: string };

/// Checks an exact-action proposal as written by its proposer, and hashes what a human will approve. Shared by the
/// propose route and a worker's ask (job-flow.ts), so an action is held to the same rules whichever way it comes.
async function proposalFields(
  value: unknown,
): Promise<{ ok: true; fields: ProposalFields } | { ok: false; error: "invalid_request" | "unknown_operation" }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "invalid_request" };
  const body = value as Record<string, unknown>;
  const text = (item: unknown, max: number): string | null =>
    typeof item === "string" && item.length > 0 && item.length <= max ? item : null;
  const connectionId = text(body.connectionId, 256);
  const providerAccountId = text(body.providerAccountId, 256);
  const operationType = text(body.operationType, 128);
  const targetResourceId = text(body.targetResourceId, 512);
  const resourceScope = Array.isArray(body.resourceScope)
    ? body.resourceScope.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const payload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : null;
  const recipients = body.recipients === undefined ? [] : body.recipients;
  const attachmentHashes = body.attachmentHashes === undefined ? [] : body.attachmentHashes;
  const expectedTargetRevision =
    body.expectedTargetRevision === undefined ? undefined : text(body.expectedTargetRevision, 128);
  if (
    !connectionId ||
    !providerAccountId ||
    !operationType ||
    !targetResourceId ||
    !payload ||
    resourceScope.length === 0 ||
    resourceScope.length > 100 ||
    !resourceScope.includes(targetResourceId) ||
    !Array.isArray(recipients) ||
    recipients.length > 50 ||
    !recipients.every((entry): entry is string => typeof entry === "string" && entry.length <= 256) ||
    !Array.isArray(attachmentHashes) ||
    attachmentHashes.length > 20 ||
    !attachmentHashes.every((entry): entry is string => typeof entry === "string" && entry.length <= 128) ||
    (body.expectedTargetRevision !== undefined && expectedTargetRevision === null) ||
    !Number.isInteger(body.grantRevision) ||
    (body.grantRevision as number) < 1 ||
    typeof body.expiresAt !== "string"
  ) {
    return { ok: false, error: "invalid_request" };
  }
  if (!ACTION_ALLOWLIST.has(operationType)) return { ok: false, error: "unknown_operation" };
  // A LINE reply is exactly one text of 1 to 5,000 characters to exactly
  // one LINE user, so the owner approves nothing that LINE would refuse or
  // that reaches more than the one customer.
  if (operationType === LINE_PUSH_OPERATION &&
      !isValidLinePushProposal({ payload, recipients: recipients as unknown[], targetResourceId })) {
    return { ok: false, error: "invalid_request" };
  }
  const expiresAt = Date.parse(body.expiresAt as string);
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 24 * 3600 * 1000) {
    return { ok: false, error: "invalid_request" };
  }
  const fields: HashedActionFields = {
    connectionId,
    providerAccountId,
    operationType,
    targetResourceId,
    resourceScope,
    payload,
    ...(recipients.length > 0 ? { recipients: recipients as string[] } : {}),
    ...(attachmentHashes.length > 0 ? { attachmentHashes: attachmentHashes as string[] } : {}),
    ...(expectedTargetRevision ? { expectedTargetRevision } : {}),
    grantRevision: body.grantRevision as number,
    expiresAt: body.expiresAt as string,
  };
  return { ok: true, fields: { ...fields, payloadHash: await payloadHash(actionHashable(fields)) } };
}

/// The stored proposal for checked fields, in one shape whichever route proposed it.
function newProposal(
  id: string,
  tenant: string,
  companyId: string | undefined,
  fields: ProposalFields,
  proposedAt: string,
): ActionProposalJSON {
  return {
    id,
    tenant,
    ...(companyId ? { companyId } : {}),
    connectionId: fields.connectionId,
    providerAccountId: fields.providerAccountId,
    operationType: fields.operationType,
    targetResourceId: fields.targetResourceId,
    resourceScope: fields.resourceScope,
    payload: fields.payload,
    payloadHash: fields.payloadHash,
    ...(fields.recipients ? { recipients: fields.recipients } : {}),
    ...(fields.attachmentHashes ? { attachmentHashes: fields.attachmentHashes } : {}),
    ...(fields.expectedTargetRevision ? { expectedTargetRevision: fields.expectedTargetRevision } : {}),
    grantRevision: fields.grantRevision,
    proposedAt,
    expiresAt: fields.expiresAt,
    state: "proposed",
  };
}

// ---------------------------------------------------------------------------
// The worker adapter contract (job-flow.ts, docs/phase-0-spikes.md section 3)
// ---------------------------------------------------------------------------

/// What every request a worker or a reply opens offers. One approves the exact action and one declines it;
/// approval-core keeps what the chosen option does apart from its label, so the decision says whether the action was
/// approved without anyone reading a label.
export const JOB_REQUEST_OPTIONS: readonly ApprovalOption[] = [
  { id: "approve", label: "Approve", effect: "approve" },
  { id: "decline", label: "Decline", effect: "decline" },
];

/// The approval kind of each operation an approval-core request decides, set here from the operation and never taken
/// from whoever proposes it, so nobody can ask for a write to the shop's systems as if it were a reply a helper may
/// decide. A LINE reply answers a customer who wrote first, privately: approval-core's `reply`. An issue in the shop's
/// own tracker changes the shop's records: the owner-only `command`.
const REQUEST_KINDS: Readonly<Record<string, ApprovalKind>> = {
  [LINE_PUSH_OPERATION]: "reply",
  "linear.issue.create": "command",
};

/// The operations a worker may ask for (job-flow.ts). A LINE reply is not one: it needs the reply record binding it
/// to the message it answers, which only the pilot's reply flow writes, so a worker's LINE reply would always fail at
/// dispatch.
const WORKER_OPERATIONS: ReadonlySet<string> = new Set(["linear.issue.create"]);

/// Whether an action is a reply, which only its approval-core request decides, whichever route proposed it.
function isReply(action: Pick<ActionProposalJSON, "operationType">): boolean {
  return REQUEST_KINDS[action.operationType] === "reply";
}

/// Replies are never revised: a changed reply is a new proposal with a link of its own. So the one revision anyone
/// deciding a reply can have seen is the first, and every decision on one names it. Were a revision ever added, the
/// older decisions would be refused as changed, never applied to something nobody saw.
export const REPLY_REVISION = 1;

/// What a reply's approval-core request asks: approve or decline that exact reply, its draft and the one customer it
/// goes to, until the reply's own expiry, which is its link's. It is built from the stored reply alone, so a reply
/// stored before replies carried requests reads as the very request it would have opened (`decidingRecordSync`).
function replyRequest(action: ActionProposalJSON): NewApprovalRequest {
  return {
    id: action.id,
    kind: "reply",
    options: JOB_REQUEST_OPTIONS,
    expiresAt: Date.parse(action.expiresAt),
    detail: {
      actionId: action.id,
      operationType: action.operationType,
      targetResourceId: action.targetResourceId,
      recipient: action.recipients?.[0] ?? null,
      text: lineReplyText(action.payload),
      payloadHash: action.payloadHash,
    },
  };
}

/// A reply's request as approval-core opens it: at revision 1, asked when the reply was proposed.
function openReply(existing: ApprovalRecord | undefined, action: ActionProposalJSON) {
  return openTransition(existing, replyRequest(action), Date.parse(action.proposedAt));
}

/// What settling a decision through a request came to: approval-core's result with the record and the action as they
/// now stand, or a refusal from before approval-core was asked.
type Settled =
  | { asked: true; result: DecideResult; record: ApprovalRecord; action: ActionProposalJSON }
  | { asked: false; status: 404 | 409; error: "not_found" | "action_not_open" };

/// What the control plane reports to approval-core as the running attempt when no attempt holds the task.
/// approval-core reads a missing attempt as unknown and lets a stamped request through, but here it is known that
/// nothing runs, so a request asked in an attempt that has ended must be refused as `attempt_ended`. Attempt ids are
/// UUIDs, so no attempt can ever be called this.
export const NO_ATTEMPT = "none";

/// The most one agent event may take, serialized. The task's log keeps its last MAX_EVENTS entries in one stored
/// value, which may not pass 2 MB; at this size a full log stays well inside it.
const MAX_AGENT_EVENT_BYTES = 8 * 1024;
const MAX_EVENTS_PER_REPORT = 100;
/// Why an attempt ended, as a code a person never writes free text into.
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/// An agent event the log can keep: one object with a `type` naming its kind (packages/agent-events), small enough to
/// store whole. The kind is not checked against any list, so a kind this build does not know is kept, as the
/// contract asks; a reader decodes it as `unknown` and still shows that something arrived.
function isAgentEvent(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0 || type.length > 64) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_AGENT_EVENT_BYTES;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/// An answer worked out inside a synchronous storage transaction, sent once the transaction has committed.
type SyncAnswer = { status: number; body: unknown };

/// Authoritative cloud copy of one SparkTaskRecord. SQLite-backed. Every caller is
/// already authenticated in index.ts; this object validates shape, transitions,
/// revisions, and write rate per record.
export class TaskObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      const doc = await this.load();
      if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(doc);
    }
    if (request.method === "GET" && url.pathname === "/export") {
      // One task's full history for tenant export: the document, the event
      // log with its compaction floor, every action proposal, and every
      // attempt. One tenancy check covers the bundle; proposals from another
      // tenant are filtered rather than trusted to the task's. Attempts are
      // capped with a flag, because claims grow without bound while the log
      // and the proposal set stay small by construction.
      const doc = await this.load();
      if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
      const events = (await this.ctx.storage.get<TaskEventJSON[]>("events")) ?? [];
      const eventFloor = (await this.ctx.storage.get<number>("eventFloor")) ?? 0;
      const actions: ActionProposalJSON[] = [];
      for (const [, value] of await this.ctx.storage.list({ prefix: "action:" })) {
        const action = value as ActionProposalJSON;
        if (!this.foreignAction(action, request)) actions.push(action);
      }
      const attemptEntries = await this.ctx.storage.list({ prefix: "attempt:" });
      const allAttempts = [...attemptEntries.values()].map((value) => value as AttemptJSON);
      const truncated = allAttempts.length > MAX_EXPORT_ATTEMPTS;
      // Each approval request a worker opened shares its action's id, so it
      // goes out exactly when its action does.
      const requests: ApprovalRecord[] = [];
      for (const [, value] of await this.ctx.storage.list({ prefix: "request:" })) {
        const record = value as ApprovalRecord;
        if (actions.some((action) => action.id === record.request.id)) requests.push(record);
      }
      return Response.json({
        task: doc,
        events,
        eventFloor,
        actions,
        attempts: allAttempts.slice(0, MAX_EXPORT_ATTEMPTS),
        attemptsTruncated: truncated,
        requests,
      });
    }
    if (request.method === "GET" && url.pathname === "/events") {
      return this.replay(request, url);
    }
    if (request.method === "DELETE" && url.pathname === "/wipe") {
      // Tenant deletion, worker-orchestrated. The headers are set by the
      // worker, which never copies client headers through, so reaching here
      // already means the caller's tenant was verified at the route. The
      // tenant rides x-tenant so an id planted in the caller's index cannot
      // destroy state this tenant does not own: a foreign task answers
      // notOwned and stays for its real owner, while the caller's own
      // deletion still completes.
      if (request.headers.get("x-wipe") !== "1") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const doc = await this.load();
      if (doc && this.foreign(doc, request)) {
        return Response.json({ wiped: false, notOwned: true });
      }
      await this.ctx.storage.deleteAll();
      return Response.json({ wiped: true });
    }
    if (request.method === "POST" && url.pathname === "/prune") {
      // Retention sweep, worker-orchestrated like /wipe above: the header is
      // set by the worker, which never copies client headers through. The
      // clock arrives in the worker-built body; a missing or unusable value
      // falls back to the server clock, so no caller can age records out
      // early. Only finished attempts with a known finish time and dead
      // (rejected/expired) proposals past the ops-metadata window go: the
      // task document, the event log, idempotency records, and
      // confirmed/failed/unknown proposals stay, because duplicates replay
      // receipts off them and reconciliation reads the unknowns.
      if (request.headers.get("x-prune") !== "1") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      // The same ownership rule as /wipe: a planted foreign id in the
      // caller's index must not age out records the caller does not own.
      const doc = await this.load();
      if (doc && this.foreign(doc, request)) {
        return Response.json({ wiped: false, notOwned: true });
      }
      let nowMs = Date.now();
      try {
        const body = (await request.json()) as { nowMs?: unknown };
        if (typeof body.nowMs === "number" && Number.isFinite(body.nowMs)) nowMs = body.nowMs;
      } catch {
        // No body on the worker-built call is fine; the server clock stands.
      }
      return Response.json(await this.pruneExpired(nowMs));
    }
    if (request.method === "POST" && url.pathname === "/detach-company") {
      return this.detachCompany(request);
    }
    if (request.method === "POST" && url.pathname === "/actions") {
      return this.proposeAction(request);
    }
    const actionRead = url.pathname.match(/^\/actions\/([^/]+)$/);
    if (request.method === "GET" && actionRead) {
      const actionId = actionRead[1];
      if (!actionId) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.readAction(request, actionId);
    }
    const actionDecision = url.pathname.match(/^\/actions\/([^/]+)\/decision$/);
    if (request.method === "POST" && actionDecision) {
      const actionId = actionDecision[1];
      if (!actionId) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.decideAction(request, actionId);
    }
    const actionBegin = url.pathname.match(/^\/actions\/([^/]+)\/begin$/);
    if (request.method === "POST" && actionBegin) {
      const actionId = actionBegin[1];
      if (!actionId) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.beginDispatch(request, actionId);
    }
    const actionSettle = url.pathname.match(/^\/actions\/([^/]+)\/settle$/);
    if (request.method === "POST" && actionSettle) {
      const actionId = actionSettle[1];
      if (!actionId) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.settleDispatch(request, actionId);
    }
    if (request.method === "PUT" && url.pathname === "/") {
      const parsed = await readJsonBody<TaskRecordJSON>(request, MAX_BODY_BYTES);
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
      const { raw, value: body } = parsed;
      if (!body?.id || typeof body.id !== "string") {
        return Response.json({ error: "id_required" }, { status: 400 });
      }
      const routeID = request.headers.get("x-task-id");
      if (routeID && routeID !== body.id) {
        return Response.json({ error: "id_mismatch" }, { status: 400 });
      }
      if (body.location !== "cloud") return Response.json({ error: "cloud_tasks_only" }, { status: 400 });
      if (!KNOWN_STATES.has(body.state)) return Response.json({ error: "unknown_state" }, { status: 400 });
      if (!KNOWN_FUNDING.has(body.funding)) return Response.json({ error: "unknown_funding" }, { status: 400 });
      // Authoritative tenancy comes from the x-tenant header the worker sets
      // from the verified session — never from the client body. Overwriting
      // here keeps direct object callers and stale clients from clearing or
      // spoofing tenantId; the empty header is the tenantless operator path.
      const headerTenant = request.headers.get("x-tenant") ?? "";
      if (headerTenant) body.tenantId = headerTenant;
      // Company scope is stamped the same way: the worker verifies
      // membership and the tasks.create grant, then asserts the company in
      // x-company-verified. Scope is sticky: omitting it preserves the
      // stored company, and only a verified assertion can set or move it —
      // direct object callers cannot self-assign, move, or strip scope.
      const verifiedCompany = request.headers.get("x-company-verified") ?? "";
      if (verifiedCompany && !isValidCompanyId(verifiedCompany)) {
        return Response.json({ error: "invalid_company_id" }, { status: 400 });
      }

      const stored = await this.load();
      if (stored && this.foreign(stored, request)) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (verifiedCompany) {
        body.companyId = verifiedCompany;
        if (stored?.companyId && stored.companyId !== verifiedCompany) {
          return Response.json(
            { error: "company_changed", current: stored.companyId },
            { status: 409 },
          );
        }
      } else if (body.companyId !== stored?.companyId) {
        if (body.companyId === undefined && stored?.companyId) {
          body.companyId = stored.companyId;
        } else {
          return Response.json({ error: "company_not_verified" }, { status: 400 });
        }
      }
      const idempotencyKey = request.headers.get("idempotency-key");
      const hash = await requestHash(
        "PUT",
        request.headers.get("x-route") ?? "PUT /v1/tasks/:id",
        raw,
      );
      const replayed = await this.checkIdem(idempotencyKey, hash);
      if (replayed) return replayed;

      if (stored) {
        if (request.headers.get("x-create-only") === "1") {
          return Response.json({ error: "already_exists" }, { status: 409 });
        }
        const expected = request.headers.get("x-expected-rev");
        if (expected !== null) {
          const want = Number(expected);
          if (!Number.isInteger(want) || want < 0) {
            return Response.json({ error: "invalid_revision" }, { status: 400 });
          }
          if (want !== stored.rev) {
            return Response.json(
              { error: "stale_revision", current: stored.rev },
              { status: 409 },
            );
          }
        }
        if (!canTransition(stored.state, body.state)) {
          return Response.json(
            { error: "illegal_transition", from: stored.state, to: body.state },
            { status: 409 },
          );
        }
      }
      if (body.state === "completed") {
        const criteria = Array.isArray(body.criteria) ? body.criteria : [];
        if (criteria.length === 0 || !criteria.every((c) => c && c.satisfied === true)) {
          return Response.json({ error: "criteria_unsatisfied" }, { status: 409 });
        }
        // Evidence, not claims: a satisfied criterion names its prover — a
        // human acceptance or a deterministic check. Anything else is a model
        // asserting its own success, which never completes a task.
        if (!criteria.every((c) => c.by === "human" || (typeof c.by === "string" && c.by.startsWith("check:")))) {
          return Response.json({ error: "criteria_unverified" }, { status: 409 });
        }
      }
      // Managed compute has no ledger behind it yet: fail closed instead of running
      // work nobody can bill. BYOK and local-provider funding carry no GoSpark cost.
      if (body.funding === "managedAI" && (body.state === "running" || body.state === "verifying")) {
        return Response.json({ error: "managed_billing_not_configured" }, { status: 403 });
      }
      const stamps = await this.takeWriteStamp();
      if (stamps === null) {
        return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
      }
      const doc = await this.commit(stored, body, stamps, "put");
      await this.storeIdem(idempotencyKey, hash, 200, doc);
      return Response.json(doc);
    }
    if (request.method === "POST" && url.pathname === "/commands") {
      return this.command(request);
    }
    if (request.method === "POST" && url.pathname === "/attempts") {
      return this.claimAttempt(request);
    }
    const attemptMatch = url.pathname.match(/^\/attempts\/([^/]+)\/(heartbeat|steps|finish)$/);
    if (request.method === "POST" && attemptMatch) {
      const attemptId = attemptMatch[1];
      const action = attemptMatch[2];
      if (!attemptId || !action) return Response.json({ error: "invalid_request" }, { status: 400 });
      return this.mutateAttempt(request, attemptId, action);
    }
    // The worker adapter contract (job-flow.ts). No public route reaches these
    // paths: the control plane calls them in code, with the attempt's fence
    // for what the worker does, and with `x-control` for what the control
    // plane does on its own.
    if (request.method === "POST" && url.pathname === "/attempts/sweep") {
      return this.sweepAttempts(request);
    }
    const attemptJob = url.pathname.match(/^\/attempts\/([^/]+)\/(events|ask|end)$/);
    if (request.method === "POST" && attemptJob) {
      const attemptId = attemptJob[1];
      if (!attemptId) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (attemptJob[2] === "events") return this.reportEvents(request, attemptId);
      if (attemptJob[2] === "ask") return this.askApproval(request, attemptId);
      return this.endAttempt(request, attemptId);
    }
    if (request.method === "GET" && url.pathname === "/requests") return this.listRequests(request);
    const requestItem = url.pathname.match(/^\/requests\/([^/]+)(\/decision)?$/);
    if (requestItem) {
      const requestId = requestItem[1];
      if (!requestId) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (request.method === "GET" && !requestItem[2]) return this.readRequest(request, requestId);
      if (request.method === "POST" && requestItem[2]) return this.decideRequest(request, requestId);
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  /// Every attempt route below works out its answer inside one synchronous
  /// storage transaction (the synchronous KV API of a SQLite-backed object),
  /// so its checks and writes see one state and commit together: no other
  /// request runs in between, and a throw rolls all of it back. Bodies are
  /// read first, because reading one is I/O that lets other requests in.
  private respond(answer: SyncAnswer): Response {
    return Response.json(answer.body, { status: answer.status });
  }

  /// The task document inside a transaction, with the same tenancy rules as
  /// `foreignForWrite`. Load the document once beforehand (`load`) so a
  /// prototype-era record is migrated before anything here reads it.
  private writableDocSync(kv: SyncKvStorage, request: Request): TaskDocJSON | SyncAnswer {
    const doc = kv.get<TaskDocJSON>("task");
    if (!doc || this.foreign(doc, request)) return { status: 404, body: { error: "not_found" } };
    if (doc.companyId && request.headers.get("x-tenant") && request.headers.get("x-company-writer") !== doc.companyId) {
      return { status: 403, body: { error: "grant_required" } };
    }
    return doc;
  }

  /// The checks every fenced attempt call makes (`mutateAttempt`): the attempt is active, the fence is its holder's,
  /// and neither the lease nor the deadline has lapsed. Ending an attempt stays open once its task is settled, as
  /// finishing does; anything else is refused then.
  private liveAttemptSync(
    kv: SyncKvStorage,
    doc: TaskDocJSON,
    attemptId: string,
    fence: unknown,
    nowS: number,
    ending = false,
  ): { ok: true; attempt: AttemptJSON } | { ok: false; answer: SyncAnswer } {
    const refuse = (status: number, error: string) => ({ ok: false as const, answer: { status, body: { error } } });
    const attempt = kv.get<AttemptJSON>(`attempt:${attemptId}`);
    if (!attempt) return refuse(404, "not_found");
    if (attempt.status !== "active") return refuse(409, "stale_attempt");
    if (typeof attempt.fence !== "string" || fence !== attempt.fence) return refuse(409, "fence_mismatch");
    if (attempt.leaseUntil <= nowS || attempt.deadline <= nowS) return refuse(409, "lease_expired");
    if (!ending && isSettled(doc)) return refuse(409, "task_settled");
    return { ok: true, attempt };
  }

  /// The attempt that holds the task now, for approval-core's binding: the newest claim, while it is active and
  /// neither its lease nor its deadline has lapsed. A worker that stopped reporting therefore stops holding the task
  /// the moment its lease lapses, before anything sweeps it. When nothing holds it, `NO_ATTEMPT`.
  private runningAttemptSync(kv: SyncKvStorage, nowS: number): string {
    const id = kv.get<string>("current-attempt");
    if (!id) return NO_ATTEMPT;
    const attempt = kv.get<AttemptJSON>(`attempt:${id}`);
    if (!attempt || attempt.status !== "active" || attempt.leaseUntil <= nowS || attempt.deadline <= nowS) {
      return NO_ATTEMPT;
    }
    return id;
  }

  /// `appendEvent` for a transaction: entries outside a document revision, in one write with the compaction floor.
  /// Answers the log's new tip.
  private appendEventsSync(
    kv: SyncKvStorage,
    doc: TaskDocJSON,
    entries: { kind: "updated" | "agent"; via: string; attemptId?: string; event?: unknown }[],
  ): number {
    const prior = kv.get<TaskEventJSON[]>("events") ?? [];
    const floor = kv.get<number>("eventFloor") ?? 0;
    let seq = prior.length > 0 ? (prior[prior.length - 1]?.seq ?? floor) : floor;
    const at = new Date().toISOString();
    const grown: TaskEventJSON[] = [
      ...prior,
      ...entries.map((entry) => ({
        seq: ++seq,
        kind: entry.kind,
        at,
        from: doc.state,
        to: doc.state,
        rev: doc.rev,
        via: entry.via,
        ...(entry.attemptId !== undefined ? { attemptId: entry.attemptId } : {}),
        ...(entry.event !== undefined ? { event: entry.event } : {}),
      })),
    ];
    const dropped = grown.length - MAX_EVENTS;
    const events = dropped > 0 ? grown.slice(dropped) : grown;
    const first = events[0];
    kv.put("events", events);
    kv.put("eventFloor", dropped > 0 && first ? first.seq - 1 : floor);
    return seq;
  }

  /// `takeWriteStamp` for a transaction.
  private takeWriteStampSync(kv: SyncKvStorage): number[] | null {
    const now = Date.now();
    const recent = (kv.get<number[]>("writeStamps") ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= MAX_WRITES_PER_MINUTE) return null;
    recent.push(now);
    return recent;
  }

  /// `POST /attempts/:id/events` with `{ fence, events }`: what the worker did, as agent events, appended to the
  /// task's log in the order given and kept exactly as they arrived. A report is a sign of life too, so it extends
  /// the lease as a heartbeat does.
  private async reportEvents(request: Request, attemptId: string): Promise<Response> {
    const parsed = await readJsonBody<{ fence?: unknown; events?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { fence, events } = parsed.value;
    if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_REPORT ||
        !events.every(isAgentEvent)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = this.writableDocSync(kv, request);
      if ("status" in doc) return doc;
      const nowS = Date.now() / 1000;
      const live = this.liveAttemptSync(kv, doc, attemptId, fence, nowS);
      if (!live.ok) return live.answer;
      const stamps = this.takeWriteStampSync(kv);
      if (stamps === null) return { status: 429, body: { error: "rate_limited" } };
      const leaseUntil = nowS + LEASE_SECONDS;
      kv.put(`attempt:${attemptId}`, { ...live.attempt, leaseUntil } satisfies AttemptJSON);
      kv.put("writeStamps", stamps);
      const tip = this.appendEventsSync(kv, doc, events.map((event) => ({ kind: "agent" as const,
        via: `attempt:events:${attemptId}`, attemptId, event })));
      return { status: 200, body: { stored: events.length, leaseUntil, tip } };
    }));
  }

  /// `POST /attempts/:id/ask` with `{ fence, action }`: the worker stops before an external write and proposes the
  /// exact action. In one transaction the action is stored as a proposal bound to its request, and the request is
  /// opened through approval-core: the kind set from the operation, the two options, an expiry with the action's,
  /// and the stamp of the asking attempt. Only the attempt that holds the task may ask, since a request from any
  /// other would be superseded the moment it opened.
  private async askApproval(request: Request, attemptId: string): Promise<Response> {
    const parsed = await readJsonBody<{ fence?: unknown; action?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const checked = await proposalFields(parsed.value.action);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const kind = WORKER_OPERATIONS.has(checked.fields.operationType)
      ? REQUEST_KINDS[checked.fields.operationType]
      : undefined;
    if (!kind) return Response.json({ error: "unsupported_operation" }, { status: 400 });
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    const id = crypto.randomUUID();
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = this.writableDocSync(kv, request);
      if ("status" in doc) return doc;
      const nowMs = Date.now();
      const nowS = nowMs / 1000;
      const live = this.liveAttemptSync(kv, doc, attemptId, parsed.value.fence, nowS);
      if (!live.ok) return live.answer;
      if (this.runningAttemptSync(kv, nowS) !== attemptId) return { status: 409, body: { error: "stale_attempt" } };
      const stamps = this.takeWriteStampSync(kv);
      if (stamps === null) return { status: 429, body: { error: "rate_limited" } };
      const proposal: ActionProposalJSON = {
        ...newProposal(id, doc.tenantId ?? request.headers.get("x-tenant") ?? "", doc.companyId, checked.fields,
          new Date(nowMs).toISOString()),
        requestId: id,
      };
      const opened = openTransition(kv.get<ApprovalRecord>(`request:${id}`), {
        id,
        kind,
        options: JOB_REQUEST_OPTIONS,
        attemptId,
        expiresAt: Date.parse(proposal.expiresAt),
        detail: {
          actionId: id,
          operationType: proposal.operationType,
          targetResourceId: proposal.targetResourceId,
          payloadHash: proposal.payloadHash,
        },
      }, nowMs);
      if (!opened.result.ok || !opened.next) return { status: 400, body: { error: "invalid_request" } };
      kv.put(`action:${id}`, proposal);
      kv.put(`request:${id}`, opened.next);
      kv.put(`attempt:${attemptId}`, { ...live.attempt, leaseUntil: nowS + LEASE_SECONDS } satisfies AttemptJSON);
      kv.put("writeStamps", stamps);
      this.appendEventsSync(kv, doc, [{ kind: "updated", via: `action:propose:${id}` }]);
      return { status: 200, body: { action: proposal, request: opened.result.request } };
    }));
  }

  /// The approval-core record that decides `action`: its stored request, or, for a reply stored before replies carried
  /// requests and still waiting, the request it would have opened when it was proposed (`replyRequest`). Reading that
  /// one writes nothing; the first decision that settles it stores it (`settleSync`). So every decision on an old reply
  /// still goes through approval-core, and no task object has to be swept to give old replies their requests. An old
  /// reply decided before then has no record: its decision stands as it was made, and nothing can settle it again.
  private decidingRecordSync(kv: SyncKvStorage, action: ActionProposalJSON): ApprovalRecord | undefined {
    const stored = kv.get<ApprovalRecord>(`request:${action.id}`);
    if (stored !== undefined) return stored;
    if (action.requestId !== undefined || !isReply(action) || action.state !== "proposed") return undefined;
    return openReply(undefined, action).next;
  }

  /// Settles `decision` on the request that decides `action`, through approval-core's transition, in the caller's
  /// transaction: who decided first, who may decide its kind (`mayDecide`), whether its attempt still holds the task
  /// (`bindingHolds`), its expiry and revision, and the option. The action moves with the request: an approval to
  /// approved, the only state the broker's begin gate dispatches from, and a decline to rejected. This is the only way
  /// an action a request decides leaves `proposed` on a decision. A refusal writes nothing.
  private settleSync(kv: SyncKvStorage, doc: TaskDocJSON, action: ActionProposalJSON, decision: Decision,
    now: number): Settled {
    const record = this.decidingRecordSync(kv, action);
    if (record === undefined) return { asked: false, status: 404, error: "not_found" };
    const { result, next } = decideTransition(record, decision,
      { running: { attemptId: this.runningAttemptSync(kv, now / 1000) }, now });
    if (!result.ok || next?.status !== "decided") return { asked: true, result, record, action };
    // A pending request's action is always proposed: nothing else decides it. If that ever stops holding, nothing is
    // written rather than settling a request whose action cannot follow.
    if (action.state !== "proposed") return { asked: false, status: 409, error: "action_not_open" };
    const approved = next.request.options.find((option) => option.id === next.decision.optionId)?.effect === "approve";
    // An old reply carries its request's id from its first decision on, as every reply proposed since does.
    const bound: ActionProposalJSON = { ...action, requestId: action.id };
    const decided: ActionProposalJSON = approved
      ? { ...bound, state: "approved", approval: { by: decision.decidedBy, at: new Date(now).toISOString() } }
      : { ...bound, state: "rejected" };
    kv.put(`request:${action.id}`, next);
    kv.put(`action:${action.id}`, decided);
    this.appendEventsSync(kv, doc, [{ kind: "updated", via: `action:decision:${action.id}` }]);
    return { asked: true, result, record: next, action: decided };
  }

  /// `GET /requests/:id`: a request, its action, and where it stands for whoever shows it, at its current revision and
  /// against the attempt holding the task now.
  private async readRequest(request: Request, requestId: string): Promise<Response> {
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const action = kv.get<ActionProposalJSON>(`action:${requestId}`);
      if (!action || this.foreignAction(action, request)) return { status: 404, body: { error: "not_found" } };
      const record = this.decidingRecordSync(kv, action);
      if (!record) return { status: 404, body: { error: "not_found" } };
      const now = Date.now();
      const standing = requestStanding(record, { seenRevision: record.request.revision,
        running: { attemptId: this.runningAttemptSync(kv, now / 1000) }, now });
      return { status: 200, body: { record, standing, action } };
    }));
  }

  /// `GET /requests`: every approval-core record in this task the caller may read, each with where it stands now, at
  /// its current revision and against the attempt holding the task, for a session's list of approvals (approvals.ts).
  /// It walks the actions, because every request shares its action's id and an old reply's request exists only as the
  /// one it would have opened. An action of another tenant is never listed, whatever task it sits in.
  private async listRequests(request: Request): Promise<Response> {
    const doc = await this.load();
    if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const now = Date.now();
      const running = { attemptId: this.runningAttemptSync(kv, now / 1000) };
      const requests: { record: ApprovalRecord; standing: Standing }[] = [];
      for (const [, action] of kv.list<ActionProposalJSON>({ prefix: "action:" })) {
        if (this.foreignAction(action, request)) continue;
        const record = this.decidingRecordSync(kv, action);
        if (record === undefined) continue;
        requests.push({ record, standing: requestStanding(record, { seenRevision: record.request.revision, running,
          now }) });
      }
      return { status: 200, body: { requests } };
    }));
  }

  /// `POST /requests/:id/decision` with approval-core's `{ optionId, seenRevision, decidedBy, role }`, the role set
  /// by the control plane from who is deciding, never by a client: the job flow's person deciding a worker's request,
  /// or the owner's link deciding a reply (pilot.ts). approval-core settles the request once and the action moves with
  /// it (`settleSync`). Every refusal answers 200 with approval-core's result and writes nothing.
  private async decideRequest(request: Request, requestId: string): Promise<Response> {
    const parsed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { optionId, seenRevision, decidedBy, role } = parsed.value;
    if (typeof optionId !== "string" || !optionId || optionId.length > 64 || typeof seenRevision !== "number" ||
        !Number.isSafeInteger(seenRevision) || seenRevision < 1 || typeof decidedBy !== "string" || !decidedBy ||
        decidedBy.length > 128 || !isRole(role)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = kv.get<TaskDocJSON>("task");
      const action = kv.get<ActionProposalJSON>(`action:${requestId}`);
      if (!doc || !action || this.foreignAction(action, request)) {
        return { status: 404, body: { error: "not_found" } };
      }
      const settled = this.settleSync(kv, doc, action, { requestId, optionId, seenRevision, decidedBy, role },
        Date.now());
      if (!settled.asked) return { status: settled.status, body: { error: settled.error } };
      return { status: 200, body: { result: settled.result, record: settled.record, action: settled.action } };
    }));
  }

  /// Closes an attempt with its outcome and answers the requests it leaves waiting, which approval-core's binding
  /// now supersedes (`attempt_ended`): nothing is written to them, since where an attempt stands is what decides it.
  private closeAttemptSync(
    kv: SyncKvStorage,
    doc: TaskDocJSON,
    attempt: AttemptJSON,
    outcome: "done" | "failed" | "cancelled",
    reason: string | undefined,
    nowS: number,
    via: string,
  ): { attempt: AttemptJSON; superseded: string[] } {
    const ended: AttemptJSON = { ...attempt, status: "done", outcome, ...(reason ? { reason } : {}), finishedAt: nowS };
    kv.put(`attempt:${attempt.id}`, ended);
    this.appendEventsSync(kv, doc, [{ kind: "updated", via }]);
    const superseded = [...kv.list<ApprovalRecord>({ prefix: "request:" })]
      .filter(([, record]) => record.status === "pending" && record.request.attemptId === attempt.id)
      .map(([, record]) => record.request.id);
    return { attempt: ended, superseded };
  }

  /// `POST /attempts/:id/end` with `{ fence?, outcome, reason? }` and `x-control`: the control plane ends an attempt.
  /// With the fence it closes the attempt for its own worker (the worker's finish, through the control plane), under
  /// the same checks as `finish`; without, the control plane stops it on its own (budget, cancellation), which needs
  /// only that it is still active. Never rate limited: an attempt must always be able to end.
  private async endAttempt(request: Request, attemptId: string): Promise<Response> {
    if (request.headers.get("x-control") !== "1") return Response.json({ error: "forbidden" }, { status: 403 });
    const parsed = await readJsonBody<{ fence?: unknown; outcome?: unknown; reason?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { fence, outcome, reason } = parsed.value;
    if ((outcome !== "done" && outcome !== "failed" && outcome !== "cancelled") ||
        (reason !== undefined && (outcome === "done" || typeof reason !== "string" || !REASON_CODE.test(reason))) ||
        (fence !== undefined && typeof fence !== "string")) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = kv.get<TaskDocJSON>("task");
      if (!doc || this.foreign(doc, request)) return { status: 404, body: { error: "not_found" } };
      const nowS = Date.now() / 1000;
      let attempt = kv.get<AttemptJSON>(`attempt:${attemptId}`);
      if (!attempt) return { status: 404, body: { error: "not_found" } };
      if (fence !== undefined) {
        const live = this.liveAttemptSync(kv, doc, attemptId, fence, nowS, true);
        if (!live.ok) return live.answer;
        attempt = live.attempt;
      } else if (attempt.status !== "active") {
        return { status: 409, body: { error: "stale_attempt" } };
      }
      return { status: 200, body: this.closeAttemptSync(kv, doc, attempt, outcome, reason, nowS,
        `attempt:end:${attemptId}`) };
    }));
  }

  /// `POST /attempts/sweep` with `x-control`: ends every active attempt that stopped reporting (its lease lapsed:
  /// `silent`) or ran out of time (`deadline`), as failed, and answers each with the requests it superseded. The
  /// clock is the server's only, so no caller can end a live attempt early.
  private async sweepAttempts(request: Request): Promise<Response> {
    if (request.headers.get("x-control") !== "1") return Response.json({ error: "forbidden" }, { status: 403 });
    if (!(await this.load())) return Response.json({ error: "not_found" }, { status: 404 });
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = kv.get<TaskDocJSON>("task");
      if (!doc || this.foreign(doc, request)) return { status: 404, body: { error: "not_found" } };
      const nowS = Date.now() / 1000;
      const ended: { attempt: AttemptJSON; superseded: string[] }[] = [];
      for (const [, attempt] of [...kv.list<AttemptJSON>({ prefix: "attempt:" })]) {
        if (attempt.status !== "active") continue;
        const reason = attempt.deadline <= nowS ? "deadline" : attempt.leaseUntil <= nowS ? "silent" : null;
        if (reason) ended.push(this.closeAttemptSync(kv, doc, attempt, "failed", reason, nowS, `attempt:sweep:${attempt.id}`));
      }
      return { status: 200, body: { ended } };
    }));
  }

  /// Releases a task from its company when the company is deleted. The
  /// worker calls this after the company authority confirms the deletion, so
  /// the header carries a decided outcome, not a request: tasks revert to
  /// tenant-only isolation under their creators instead of pointing at a
  /// company that no longer exists. Idempotent by design — a task already
  /// detached, or never attached, answers detached:false — so the worker's
  /// fan-out stays retryable and per-task failures never block the rest.
  private async detachCompany(request: Request): Promise<Response> {
    const company = request.headers.get("x-company-detach") ?? "";
    if (!company) return Response.json({ error: "forbidden" }, { status: 403 });
    const doc = await this.load();
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    if (doc.companyId !== company) return Response.json({ detached: false });
    const stamps = await this.takeWriteStamp();
    if (stamps === null) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const released: TaskDocJSON = await this.commit(
      doc,
      {
        id: doc.id,
        title: doc.title,
        objective: doc.objective,
        state: doc.state,
        location: doc.location,
        funding: doc.funding,
        criteria: doc.criteria,
        updatedAt: new Date().toISOString(),
        ...(doc.tenantId ? { tenantId: doc.tenantId } : {}),
      },
      stamps,
      "company:detach",
    );
    return Response.json({ detached: true, rev: released.rev });
  }

  /// A client lifecycle command: queue, pause, cancel, retry, or replan. The
  /// envelope carries only the command type; revision fencing rides the
  /// x-expected-rev header like any other write. Commands that land on the
  /// task's current state succeed without touching it, so a retried command
  /// is indistinguishable from a replayed one.
  private async command(request: Request): Promise<Response> {
    const parsed = await readJsonBody<{ type?: unknown }>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    const { raw, value: envelope } = parsed;
    const spec = typeof envelope.type === "string" ? COMMANDS[envelope.type] : undefined;
    if (!spec) return Response.json({ error: "unknown_command" }, { status: 400 });
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) return Response.json({ error: "idempotency_key_required" }, { status: 400 });
    const hash = await requestHash(
      "POST",
      request.headers.get("x-route") ?? "POST /v1/tasks/:id/commands",
      raw,
    );
    const stored = await this.load();
    if (!stored) return Response.json({ error: "not_found" }, { status: 404 });
    const refused = this.foreignForWrite(stored, request);
    if (refused) return refused;
    // A cached success or conflict can disclose the owner's task too, so
    // ownership is checked before idempotency, including same-state no-ops.
    const replayed = await this.checkIdem(idempotencyKey, hash);
    if (replayed) return replayed;
    if (stored.state === spec.to) {
      await this.storeIdem(idempotencyKey, hash, 200, stored);
      return Response.json(stored);
    }
    if (!spec.from.includes(stored.state)) {
      return Response.json(
        { error: "illegal_command", command: envelope.type, from: stored.state },
        { status: 409 },
      );
    }
    const expected = request.headers.get("x-expected-rev");
    if (expected !== null) {
      const want = Number(expected);
      if (!Number.isInteger(want) || want < 0) {
        return Response.json({ error: "invalid_revision" }, { status: 400 });
      }
      if (want !== stored.rev) {
        return Response.json(
          { error: "stale_revision", current: stored.rev },
          { status: 409 },
        );
      }
    }
    const stamps = await this.takeWriteStamp();
    if (stamps === null) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const doc = await this.commit(
      stored,
      { ...stored, state: spec.to, updatedAt: new Date().toISOString() },
      stamps,
      `command:${envelope.type}`,
    );
    await this.storeIdem(idempotencyKey, hash, 200, doc);
    return Response.json(doc);
  }

  /// Claims one attempt for one executor. The fencing token is minted here
  /// and checked on every later mutation; the lease bounds liveness and the
  /// budget bounds work. A handoff is an explicit new claim, never a silent
  /// migration of a running job. A completed or cancelled task takes no new
  /// claims: the refusal comes before validation and the write stamp, so it
  /// spends no rate budget and mints no fence.
  private async claimAttempt(request: Request): Promise<Response> {
    const doc = await this.load();
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    const refused = this.foreignForWrite(doc, request);
    if (refused) return refused;
    if (isSettled(doc)) return Response.json({ error: "task_settled" }, { status: 409 });
    let body: {
      executorId?: unknown;
      inputRevision?: unknown;
      model?: unknown;
      maxSteps?: unknown;
      maxActiveSeconds?: unknown;
    };
    const claimed = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!claimed.ok) return Response.json({ error: claimed.error }, { status: claimed.status });
    body = claimed.value;
    if (typeof body.executorId !== "string" || !body.executorId || body.executorId.length > 128) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (typeof body.inputRevision !== "string" || !body.inputRevision || body.inputRevision.length > 256) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 128)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const maxSteps =
      body.maxSteps === undefined ? DEFAULT_MAX_STEPS : Number(body.maxSteps);
    const maxActiveSeconds =
      body.maxActiveSeconds === undefined ? DEFAULT_MAX_ACTIVE_SECONDS : Number(body.maxActiveSeconds);
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (!Number.isInteger(maxActiveSeconds) || maxActiveSeconds < 60 || maxActiveSeconds > 7200) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    // Claims mint fresh attempts by design: a retried claim after a lost
    // response leaves an orphan that lease expiry fences off, and the
    // executor continues with the new attempt.
    const stamps = await this.takeWriteStamp();
    if (stamps === null) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    const now = Date.now() / 1000;
    const fence = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const attempt: AttemptJSON = {
      id: crypto.randomUUID(),
      executorId: body.executorId,
      fence,
      leaseUntil: now + LEASE_SECONDS,
      inputRevision: body.inputRevision,
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      maxSteps,
      deadline: now + maxActiveSeconds,
      status: "active",
      steps: [],
    };
    // The newest claim holds the task: a request asked in any other attempt is
    // superseded (`runningAttemptSync`).
    await this.ctx.storage.put({
      [`attempt:${attempt.id}`]: attempt,
      "current-attempt": attempt.id,
      writeStamps: stamps,
    });
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `attempt:claim:${attempt.id}`,
    });
    return Response.json(attempt);
  }

  /// Heartbeats, step claims, and finishes for one attempt. Every mutation
  /// re-checks the same three things: the attempt is still active, the fence
  /// matches its holder, and neither the lease nor the deadline lapsed.
  /// Anything else answers 409, and a stale executor learns nothing except
  /// that it no longer owns the attempt.
  ///
  /// The owner then learns whether the task is still live. Once it is
  /// completed or cancelled, heartbeats and steps answer 409 task_settled:
  /// the lease cannot be extended and no more work is recorded against a task
  /// the user stopped. Finish stays open on purpose. It records the outcome
  /// and closes the attempt without changing the task, so an executor that
  /// learns of a cancellation, or one that PUT the task to completed before
  /// finishing, can still close cleanly instead of leaving the attempt
  /// stranded as active.
  private async mutateAttempt(request: Request, attemptId: string, action: string): Promise<Response> {
    const doc = await this.load();
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    const refused = this.foreignForWrite(doc, request);
    if (refused) return refused;
    let body: { fence?: unknown; step?: unknown; outcome?: unknown };
    const mutated = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!mutated.ok) return Response.json({ error: mutated.error }, { status: mutated.status });
    body = mutated.value;
    const attempt = await this.ctx.storage.get<AttemptJSON>(`attempt:${attemptId}`);
    if (!attempt) return Response.json({ error: "not_found" }, { status: 404 });
    const now = Date.now() / 1000;
    if (attempt.status !== "active") {
      return Response.json({ error: "stale_attempt" }, { status: 409 });
    }
    if (typeof attempt.fence !== "string" || body.fence !== attempt.fence) {
      return Response.json({ error: "fence_mismatch" }, { status: 409 });
    }
    if (attempt.leaseUntil <= now || attempt.deadline <= now) {
      return Response.json({ error: "lease_expired" }, { status: 409 });
    }
    if (action !== "finish" && isSettled(doc)) {
      return Response.json({ error: "task_settled" }, { status: 409 });
    }
    if (action === "heartbeat") {
      const extended: AttemptJSON = { ...attempt, leaseUntil: now + LEASE_SECONDS };
      await this.ctx.storage.put(`attempt:${attempt.id}`, extended);
      return Response.json(extended);
    }
    const stamps = await this.takeWriteStamp();
    if (stamps === null) {
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
    if (action === "finish") {
      if (body.outcome !== "done" && body.outcome !== "failed") {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }
      const finished: AttemptJSON = { ...attempt, status: "done", outcome: body.outcome, finishedAt: now };
      await this.ctx.storage.put({
        [`attempt:${attempt.id}`]: finished,
        writeStamps: stamps,
      });
      await this.appendEvent(doc, {
        kind: "updated",
        to: doc.state,
        rev: doc.rev,
        via: `attempt:finish:${attempt.id}`,
      });
      return Response.json(finished);
    }
    // Steps: deterministic ids make replay safe — claiming a known step
    // returns it unchanged instead of duplicating work or spend.
    const step = body.step as { id?: unknown; name?: unknown; status?: unknown; outputRef?: unknown } | undefined;
    if (
      !step ||
      typeof step.id !== "string" ||
      !step.id ||
      step.id.length > 128 ||
      typeof step.name !== "string" ||
      step.name.length > 256 ||
      (step.status !== "done" && step.status !== "failed") ||
      (step.outputRef !== undefined &&
        (typeof step.outputRef !== "string" || step.outputRef.length > 512))
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const known = attempt.steps.find((entry) => entry.id === step.id);
    if (known) return Response.json({ attempt, step: known, replayed: true });
    if (attempt.steps.length >= attempt.maxSteps) {
      return Response.json({ error: "budget_exhausted" }, { status: 409 });
    }
    const recorded: StepJSON = {
      id: step.id,
      name: step.name,
      status: step.status,
      ...(typeof step.outputRef === "string" ? { outputRef: step.outputRef } : {}),
    };
    const advanced: AttemptJSON = { ...attempt, steps: [...attempt.steps, recorded] };
    await this.ctx.storage.put({
      [`attempt:${attempt.id}`]: advanced,
      writeStamps: stamps,
    });
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `attempt:step:${attempt.id}`,
    });
    return Response.json({ attempt: advanced, step: recorded });
  }

  /// Request-bound idempotency: the same key with the same canonical payload
  /// replays the original outcome; the same key with a different payload is a
  /// client bug answered 409. Prototype-era mappings keyed by id alone replay
  /// current state, preserving old retry behavior for in-flight keys.
  private async checkIdem(key: string | null, hash: string): Promise<Response | null> {
    if (!key) return null;
    const entry = await this.ctx.storage.get<string | IdemEntry>(`idem:${key}`);
    if (typeof entry === "string" || entry === null || entry === undefined) {
      if (entry) {
        const stored = await this.load();
        if (stored) return Response.json(stored);
      }
      return null;
    }
    if (entry.hash !== hash) {
      return Response.json({ error: "idempotency_conflict" }, { status: 409 });
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }

  private async storeIdem(
    key: string | null,
    hash: string,
    status: number,
    body: TaskDocJSON,
  ): Promise<void> {
    if (!key) return;
    const keys = (await this.ctx.storage.get<string[]>("idemKeys")) ?? [];
    if (!keys.includes(key)) {
      keys.push(key);
      // Bounded: the oldest mapping goes when the list is full, so retries stay
      // cheap and the store cannot grow without bound.
      while (keys.length > MAX_IDEMPOTENCY_KEYS) {
        const oldest = keys.shift();
        if (oldest) await this.ctx.storage.delete(`idem:${oldest}`);
      }
      await this.ctx.storage.put("idemKeys", keys);
    }
    await this.ctx.storage.put(`idem:${key}`, { hash, status, body } satisfies IdemEntry);
  }

  /// Appends to the task log outside a document revision: attempt activity is
  /// execution metadata, not a state change, so the task rev stays put while
  /// the sequence still orders every event.
  private async appendEvent(
    doc: TaskDocJSON,
    event: { kind: "updated"; to: string; rev: number; via: string },
  ): Promise<void> {
    const prior = (await this.ctx.storage.get<TaskEventJSON[]>("events")) ?? [];
    const floor = (await this.ctx.storage.get<number>("eventFloor")) ?? 0;
    const last = prior.length > 0 ? prior[prior.length - 1] : undefined;
    const entry: TaskEventJSON = {
      seq: (last?.seq ?? floor) + 1,
      kind: event.kind,
      at: new Date().toISOString(),
      from: doc.state,
      to: event.to,
      rev: event.rev,
      via: event.via,
    };
    const grown = [...prior, entry];
    const dropped = grown.length - MAX_EVENTS;
    const events = dropped > 0 ? grown.slice(dropped) : grown;
    const first = events[0];
    await this.ctx.storage.put({
      events,
      eventFloor: dropped > 0 && first ? first.seq - 1 : floor,
    });
  }

  /// Ordered replay of a task's event log. A cursor at or past the tip returns
  /// an empty list; a cursor below the compaction floor cannot be honored, so
  /// the client resyncs from the task snapshot instead of reading a partial
  /// history it would mistake for complete.
  private async replay(request: Request, url: URL): Promise<Response> {
    const raw = url.searchParams.get("after") ?? "0";
    const after = Number(raw);
    const limitRaw = url.searchParams.get("limit") ?? "200";
    const limit = Number(limitRaw);
    if (!Number.isInteger(after) || after < 0) {
      return Response.json({ error: "invalid_cursor" }, { status: 400 });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPLAY_LIMIT) {
      return Response.json({ error: "invalid_limit" }, { status: 400 });
    }
    const doc = await this.load();
    if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
    const events = (await this.ctx.storage.get<TaskEventJSON[]>("events")) ?? [];
    const floor = (await this.ctx.storage.get<number>("eventFloor")) ?? 0;
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    const tip = last?.seq ?? floor;
    if (after < floor) {
      return Response.json({ error: "resync_required", floor, tip }, { status: 410 });
    }
    return Response.json({
      events: events.filter((event) => event.seq > after).slice(0, limit),
      floor,
      tip,
    });
  }

  /// Cross-tenant reads answer as if the task never existed: no contents
  /// disclosed, no existence oracle. An empty tenant header (the operator
  /// path) and records without a tenant (prototype era) pass through. A
  /// worker-asserted company membership (`x-company-member`, set only after
  /// the worker verifies it against the company authority) opens reads on
  /// tasks of that company to fellow members — tenant isolation alone would
  /// hide a member's tasks from the rest of the company.
  private foreign(doc: TaskDocJSON, request: Request): boolean {
    const tenant = request.headers.get("x-tenant");
    if (doc.companyId) {
      const asserted = request.headers.get("x-company-member") ?? "";
      if (asserted && asserted === doc.companyId) return false;
    }
    return !!doc.tenantId && !!tenant && doc.tenantId !== tenant;
  }

  /// Read membership never authorizes a mutation. The worker stamps this
  /// separate assertion only after checking the caller's live write grants.
  /// Check before replay, lease extension, or any durable write.
  private foreignForWrite(doc: TaskDocJSON, request: Request): Response | null {
    if (this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
    if (doc.companyId && request.headers.get("x-tenant") && request.headers.get("x-company-writer") !== doc.companyId) {
      return Response.json({ error: "grant_required" }, { status: 403 });
    }
    return null;
  }

  private foreignAction(action: ActionProposalJSON, request: Request): boolean {
    const tenant = request.headers.get("x-tenant");
    if (action.companyId) {
      const asserted = request.headers.get("x-company-member") ?? "";
      if (asserted && asserted === action.companyId) return false;
    }
    return !!action.tenant && !!tenant && action.tenant !== tenant;
  }

  private async loadAction(request: Request, id: string): Promise<ActionProposalJSON | Response> {
    const action = await this.ctx.storage.get<ActionProposalJSON>(`action:${id}`);
    if (!action || this.foreignAction(action, request)) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return action;
  }

  private async proposeAction(request: Request): Promise<Response> {
    const doc = await this.load();
    if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
    const proposed = await readJsonBody<Record<string, unknown>>(request, MAX_BODY_BYTES);
    if (!proposed.ok) return Response.json({ error: proposed.error }, { status: proposed.status });
    const checked = await proposalFields(proposed.value);
    if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
    const proposal = newProposal(
      crypto.randomUUID(),
      doc.tenantId ?? request.headers.get("x-tenant") ?? "",
      doc.companyId,
      checked.fields,
      new Date().toISOString(),
    );
    if (isReply(proposal)) return this.storeReply(request, proposal);
    await this.ctx.storage.put(`action:${proposal.id}`, proposal);
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `action:propose:${proposal.id}`,
    });
    return Response.json(proposal);
  }

  /// Stores a reply with its approval-core request (`replyRequest`), opened in the same storage transaction, so no
  /// reply ever waits without the request that alone decides it, whichever route proposed it: the pilot's reply flow
  /// or a session's propose route.
  private storeReply(request: Request, proposal: ActionProposalJSON): Response {
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = kv.get<TaskDocJSON>("task");
      if (!doc || this.foreign(doc, request)) return { status: 404, body: { error: "not_found" } };
      const reply: ActionProposalJSON = { ...proposal, requestId: proposal.id };
      const opened = openReply(kv.get<ApprovalRecord>(`request:${reply.id}`), reply);
      if (!opened.result.ok || !opened.next) return { status: 400, body: { error: "invalid_request" } };
      kv.put(`action:${reply.id}`, reply);
      kv.put(`request:${reply.id}`, opened.next);
      this.appendEventsSync(kv, doc, [{ kind: "updated", via: `action:propose:${reply.id}` }]);
      return { status: 200, body: reply };
    }));
  }

  private async readAction(request: Request, id: string): Promise<Response> {
    const action = await this.loadAction(request, id);
    if (action instanceof Response) return action;
    // Orphaned dispatches resolve on read, not only on re-begin: a
    // `dispatching` action older than five minutes cannot be a live run (the
    // provider call times out at 15 s and settle follows immediately), so a
    // poller whose worker vanished still terminates — at `unknown`, never by
    // blind retry. Same bound and write shape as the begin-path rule.
    if (action.state === "dispatching") {
      const at = Date.parse(action.dispatch?.at ?? "");
      if (Number.isFinite(at) && Date.now() - at > 5 * 60 * 1000) {
        const unknown: ActionProposalJSON = { ...action, state: "unknown" };
        await this.ctx.storage.put(`action:${id}`, unknown);
        return Response.json(unknown);
      }
    }
    return Response.json(action);
  }

  /// Records a human decision on the immutable proposal. One decision only:
  /// a second call finds no proposal awaiting judgment. Approving binds the
  /// exact hashed content. Dispatch begin re-hashes the stored record and
  /// refuses a mismatch, alongside its freshness, grant, and task-state
  /// checks; the broker checks the connection after that.
  private async decideAction(request: Request, id: string): Promise<Response> {
    const action = await this.loadAction(request, id);
    if (action instanceof Response) return action;
    // An action a worker asked for is decided only through its approval-core
    // request (`/requests/:id/decision`), which checks who may decide and that
    // the attempt that asked still runs. This route checks neither, so it
    // refuses before touching the action, expiry included. A reply is decided
    // through its request here too (`decideReplyByAction`): approval-core lets
    // any role decide a reply, and a reply is never asked in an attempt, so
    // nothing approval-core checks depends on what this route does not know.
    const reply = isReply(action);
    if (action.requestId !== undefined && !reply) {
      return Response.json({ error: "decide_by_request" }, { status: 409 });
    }
    if (action.state !== "proposed") {
      return Response.json({ error: "already_decided" }, { status: 409 });
    }
    if (Date.parse(action.expiresAt) <= Date.now()) {
      await this.ctx.storage.put(`action:${id}`, { ...action, state: "expired" });
      return Response.json({ error: "action_expired" }, { status: 409 });
    }
    let body: { approve?: unknown; by?: unknown };
    const decidedBody = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!decidedBody.ok) return Response.json({ error: decidedBody.error }, { status: decidedBody.status });
    body = decidedBody.value;
    if (typeof body.approve !== "boolean" || typeof body.by !== "string" || !body.by || body.by.length > 128) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const doc = await this.load();
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    // Approval identity comes from the verified session header, never from
    // the client body: a self-attested "by" would let any device approve as
    // anyone. The operator path (empty header) keeps the supplied value.
    const approver = request.headers.get("x-tenant") || body.by;
    if (reply) return this.decideReplyByAction(request, id, body.approve, approver);
    const decided: ActionProposalJSON = body.approve
      ? { ...action, state: "approved", approval: { by: approver, at: new Date().toISOString() } }
      : { ...action, state: "rejected" };
    await this.ctx.storage.put(`action:${id}`, decided);
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `action:decision:${id}`,
    });
    return Response.json(decided);
  }

  /// This route's `{ approve, by }` on a reply, settled through the reply's approval-core request (`settleSync`), so
  /// this route never moves a reply's action on its own. It carries no role, so it claims no more than it knows: a
  /// call stamped with the reply's own tenant is the shop deciding, which is its owner; any other caller is at most a
  /// helper, whom approval-core lets decide a reply and nothing owner-only. The answers stay this route's own.
  private decideReplyByAction(request: Request, id: string, approve: boolean, approver: string): Response {
    return this.respond(this.ctx.storage.transactionSync((): SyncAnswer => {
      const kv = this.ctx.storage.kv;
      const doc = kv.get<TaskDocJSON>("task");
      const action = kv.get<ActionProposalJSON>(`action:${id}`);
      if (!doc || !action || this.foreignAction(action, request)) return { status: 404, body: { error: "not_found" } };
      const tenant = request.headers.get("x-tenant") ?? "";
      const role: Role = tenant !== "" && tenant === action.tenant ? "owner" : "helper";
      const settled = this.settleSync(kv, doc, action, { requestId: id, optionId: approve ? "approve" : "decline",
        seenRevision: REPLY_REVISION, decidedBy: approver, role }, Date.now());
      // No request decides the reply any more (its record is gone), or its action moved on without one: nothing this
      // route may settle.
      if (!settled.asked) {
        return settled.status === 404 ? { status: 404, body: { error: "not_found" } }
          : { status: 409, body: { error: "already_decided" } };
      }
      const { result } = settled;
      if (result.ok) return { status: 200, body: settled.action };
      if (result.refused === "already_decided") return { status: 409, body: { error: "already_decided" } };
      if (result.refused === "expired") {
        // As this route has always marked a proposal it found past its expiry. The request needs no write: its
        // expiry is the reply's, so approval-core already reads it as expired.
        kv.put(`action:${id}`, { ...action, state: "expired" } satisfies ActionProposalJSON);
        return { status: 409, body: { error: "action_expired" } };
      }
      return { status: 409, body: { error: result.refused === "superseded" ? result.reason : result.refused } };
    }));
  }

  /// Atomically moves an approved proposal to dispatching and hands the
  /// broker its immutable copy. At most one dispatch owns an action: a
  /// second begin finds it already moving, and a dispatch orphaned by a
  /// crash past five minutes is marked unknown rather than retried blindly.
  /// The copy handed over is only ever the content the human approved:
  /// begin recomputes payloadHash and answers payload_changed otherwise.
  private async beginDispatch(request: Request, id: string): Promise<Response> {
    const action = await this.loadAction(request, id);
    if (action instanceof Response) return action;
    if (action.state === "dispatching") {
      const at = Date.parse(action.dispatch?.at ?? "");
      if (Number.isFinite(at) && Date.now() - at > 5 * 60 * 1000) {
        const unknown: ActionProposalJSON = { ...action, state: "unknown" };
        await this.ctx.storage.put(`action:${id}`, unknown);
        return Response.json({ error: "action_unknown" }, { status: 409 });
      }
      return Response.json({ error: "dispatch_in_flight" }, { status: 409 });
    }
    if (action.state !== "approved") {
      const terminal = ["confirmed", "failed", "unknown"].includes(action.state);
      return Response.json(
        { error: terminal ? "already_settled" : action.state === "proposed" ? "not_approved" : "already_decided" },
        { status: 409 },
      );
    }
    if (Date.parse(action.expiresAt) <= Date.now()) {
      await this.ctx.storage.put(`action:${id}`, { ...action, state: "expired" });
      return Response.json({ error: "action_expired" }, { status: 409 });
    }
    // The approval covers the hashed content, not whatever the record holds
    // now. A mismatch means the stored proposal changed after a human looked
    // at it, whether through corruption or a future edit path, so dispatch is
    // refused and nothing is written: the action stays approved and never
    // reaches the provider.
    if ((await payloadHash(actionHashable(action))) !== action.payloadHash) {
      return Response.json({ error: "payload_changed" }, { status: 409 });
    }
    let body: { grantRevision?: unknown };
    const begun = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!begun.ok) return Response.json({ error: begun.error }, { status: begun.status });
    body = begun.value;
    if (body.grantRevision !== action.grantRevision) {
      return Response.json({ error: "grant_changed", current: action.grantRevision }, { status: 409 });
    }
    const doc = await this.load();
    if (!doc || this.foreign(doc, request)) return Response.json({ error: "not_found" }, { status: 404 });
    if (isSettled(doc)) return Response.json({ error: "task_settled" }, { status: 409 });
    const moving: ActionProposalJSON = {
      ...action,
      state: "dispatching",
      dispatch: { at: new Date().toISOString() },
    };
    await this.ctx.storage.put(`action:${id}`, moving);
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `action:dispatch:${id}`,
    });
    return Response.json(moving);
  }

  /// Settles a dispatching action. Confirmed carries the provider's
  /// operation id and receipt; failed carries finality; unknown carries
  /// deliberate ambiguity — and stays unknown until a human re-proposes.
  private async settleDispatch(request: Request, id: string): Promise<Response> {
    const action = await this.loadAction(request, id);
    if (action instanceof Response) return action;
    if (action.state !== "dispatching") {
      return Response.json({ error: "not_dispatching" }, { status: 409 });
    }
    let body: { outcome?: unknown; providerOperationId?: unknown; receipt?: unknown };
    const settledBody = await readJsonBody<typeof body>(request, MAX_BODY_BYTES);
    if (!settledBody.ok) return Response.json({ error: settledBody.error }, { status: settledBody.status });
    body = settledBody.value;
    if (body.outcome !== "confirmed" && body.outcome !== "failed" && body.outcome !== "unknown") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (
      body.outcome === "confirmed" &&
      (typeof body.providerOperationId !== "string" || !body.providerOperationId)
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const doc = await this.load();
    if (!doc) return Response.json({ error: "not_found" }, { status: 404 });
    const settled: ActionProposalJSON = {
      ...action,
      state: body.outcome,
      dispatch: {
        at: action.dispatch?.at ?? new Date().toISOString(),
        ...(typeof body.providerOperationId === "string" ? { providerOperationId: body.providerOperationId } : {}),
        ...(body.receipt !== undefined ? { receipt: body.receipt } : {}),
      },
    };
    await this.ctx.storage.put(`action:${id}`, settled);
    await this.appendEvent(doc, {
      kind: "updated",
      to: doc.state,
      rev: doc.rev,
      via: `action:settle:${id}`,
    });
    return Response.json(settled);
  }



  /// The versioned document, migrating a prototype-era record on first touch.
  /// Migration preserves the record's id and fields, seeds the log with a
  /// genesis entry, and leaves the legacy key in place so an older build
  /// reading it directly still sees the last migrated state.
  /// Deletes retention-expired records: finished attempts with a known finish
  /// time and dead (rejected/expired) action proposals past the ops-metadata
  /// window. Everything else stays. Storage keys are listed, not scanned by
  /// prefix, because the store holds no other per-record keys by construction.
  private async pruneExpired(nowMs: number): Promise<{ attemptsPruned: number; actionsPruned: number }> {
    const listed = await this.ctx.storage.list({ prefix: "attempt:" });
    let attemptsPruned = 0;
    for (const [key, value] of listed) {
      if (isPrunableAttempt(value as AttemptJSON, nowMs)) {
        await this.ctx.storage.delete(key);
        attemptsPruned++;
      }
    }
    const actions = await this.ctx.storage.list({ prefix: "action:" });
    let actionsPruned = 0;
    for (const [key, value] of actions) {
      const action = value as ActionProposalJSON;
      if (isPrunableAction(action, nowMs)) {
        // An action a worker asked for goes with its approval request, which
        // means nothing without it.
        await this.ctx.storage.delete(action.requestId ? [key, `request:${action.requestId}`] : [key]);
        actionsPruned++;
      }
    }
    return { attemptsPruned, actionsPruned };
  }

  private async load(): Promise<TaskDocJSON | null> {
    const doc = await this.ctx.storage.get<TaskDocJSON>("task");
    if (doc) return doc;
    const legacy = await this.ctx.storage.get<TaskRecordJSON>("record");
    if (!legacy) return null;
    const migrated: TaskDocJSON = { ...legacy, schema: 1, rev: 1 };
    const genesis: TaskEventJSON = {
      seq: 1,
      kind: "migrated",
      at: new Date().toISOString(),
      to: legacy.state,
      rev: 1,
    };
    await this.ctx.storage.put({ task: migrated, events: [genesis], eventFloor: 0 });
    return migrated;
  }

  /// Persists a validated write atomically: the legacy record (for rollback
  /// readers), the versioned document, the appended event log, the compaction
  /// floor, and the consumed rate-limit stamp go in one put, so a crash
  /// cannot leave state advanced without its event or vice versa.
  private async commit(
    stored: TaskDocJSON | null,
    body: TaskRecordJSON,
    stamps: number[],
    via: string,
  ): Promise<TaskDocJSON> {
    const rev = (stored?.rev ?? 0) + 1;
    const doc: TaskDocJSON = { ...body, schema: 1, rev };
    const prior = (await this.ctx.storage.get<TaskEventJSON[]>("events")) ?? [];
    const floor = (await this.ctx.storage.get<number>("eventFloor")) ?? 0;
    const kind = !stored ? "created" : body.state !== stored.state ? "state" : "updated";
    const last = prior.length > 0 ? prior[prior.length - 1] : undefined;
    const event: TaskEventJSON = {
      seq: (last?.seq ?? floor) + 1,
      kind,
      at: new Date().toISOString(),
      rev,
      ...(stored ? { from: stored.state } : {}),
      to: body.state,
      via,
    };
    const grown = [...prior, event];
    const dropped = grown.length - MAX_EVENTS;
    const events = dropped > 0 ? grown.slice(dropped) : grown;
    const first = events[0];
    const nextFloor = dropped > 0 && first ? first.seq - 1 : floor;
    const record: TaskRecordJSON = {
      id: body.id,
      title: body.title,
      objective: body.objective,
      state: body.state,
      location: body.location,
      funding: body.funding,
      criteria: body.criteria,
      updatedAt: body.updatedAt,
      ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      ...(body.companyId ? { companyId: body.companyId } : {}),
    };
    await this.ctx.storage.put({
      record,
      task: doc,
      events,
      eventFloor: nextFloor,
      writeStamps: stamps,
    });
    return doc;
  }

  /// Consumes one write stamp, returning the updated list, or null when the
  /// per-record budget is spent. Pure against loaded state; the caller
  /// persists the list with the commit it guards.
  private async takeWriteStamp(): Promise<number[] | null> {
    const now = Date.now();
    const recent = ((await this.ctx.storage.get<number[]>("writeStamps")) ?? []).filter(
      (t) => t > now - 60_000,
    );
    if (recent.length >= MAX_WRITES_PER_MINUTE) return null;
    recent.push(now);
    return recent;
  }
}
