import { mayDecide } from "./roles";
import { requestStanding } from "./standing";
import {
  APPROVAL_KINDS,
  OPTION_EFFECTS,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRecord,
  type ApprovalRequest,
  type DecideResult,
  type Decision,
  type NewApprovalRequest,
  type OpenResult,
  type RequestRevision,
  type ReviseResult,
  type Running,
  type WithdrawResult,
} from "./types";

/// Every change a store can make, as pure functions from the record it read to the result it
/// returns and the record it must write.
///
/// The rules live here, once, so every store applies them in the same order: the in-memory store,
/// and later a Durable Object or a SQLite table. A store only has to make the read and the write
/// one atomic step. For a store that cannot hold a lock across them, `next` is safe to write only
/// if the stored record is still the one that was read: a record leaves `pending` once and its
/// revision only goes up, so `status = 'pending' AND revision = <read revision>` identifies it.
/// When that conditional write changes no row, another call got there first, and the store reads
/// again and runs the transition again, which then answers `already_decided`, `changed` or
/// `withdrawn` instead of settling a second time. Orca's decision gate store updated a gate
/// without such a condition and could settle one twice; this shape exists so no store repeats it.

/// A store's answer, plus the record to write when something changed. `next` is absent when the
/// call was refused or changed nothing, so a refusal never writes.
export interface Transition<R> {
  readonly result: R;
  readonly next?: ApprovalRecord;
}

/// What the runtime knows when a decision arrives.
export interface DecideContext {
  readonly running: Running;
  readonly now: number;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>(APPROVAL_KINDS);
const KNOWN_EFFECTS: ReadonlySet<string> = new Set<string>(OPTION_EFFECTS);

/// Whether a decision may settle `record`, and the settled decision if it may.
///
/// Who may decide comes before when, because it never changes: a helper told that a payment
/// request "changed, look again" would only be refused on the next look. Everything about time
/// and revision is `requestStanding`'s, so a surface reading the standing and the store deciding
/// can never disagree. The option is checked last, against the options at the revision the
/// person saw, which by then is the current one.
export function evaluateDecision(
  record: ApprovalRecord | undefined,
  decision: Decision,
  context: DecideContext,
): DecideResult {
  if (record === undefined || record.request.id !== decision.requestId) return { ok: false, refused: "not_found" };
  if (record.status === "decided") return { ok: false, refused: "already_decided", decision: record.decision };
  if (!mayDecide(decision.role, record.request.kind)) return { ok: false, refused: "not_permitted" };
  const standing = requestStanding(record, {
    seenRevision: decision.seenRevision,
    running: context.running,
    now: context.now,
  });
  switch (standing.state) {
    case "decided":
      return { ok: false, refused: "already_decided", decision: standing.decision };
    case "superseded":
      return standing.reason === "not_found"
        ? { ok: false, refused: "not_found" }
        : { ok: false, refused: "superseded", reason: standing.reason };
    case "expired":
      return { ok: false, refused: "expired", expiredAt: standing.expiredAt };
    case "changed":
      return { ok: false, refused: "changed", currentRevision: standing.currentRevision };
    case "open":
      break;
  }
  // Checked here and not only where buttons are drawn, so a surface that drew an option anyway,
  // or a client that sends one it was never shown, still settles nothing.
  if (!record.request.options.some((option) => option.id === decision.optionId)) {
    return { ok: false, refused: "not_offered" };
  }
  return {
    ok: true,
    decision: {
      requestId: decision.requestId,
      optionId: decision.optionId,
      seenRevision: decision.seenRevision,
      decidedBy: decision.decidedBy,
      role: decision.role,
      decidedAt: context.now,
    },
  };
}

/// Settles `record` with `decision` when `evaluateDecision` accepts it.
export function decideTransition(
  record: ApprovalRecord | undefined,
  decision: Decision,
  context: DecideContext,
): Transition<DecideResult> {
  const result = evaluateDecision(record, decision, context);
  if (!result.ok || record === undefined) return { result };
  return { result, next: { status: "decided", request: record.request, decision: result.decision } };
}

/// Opens a new request at revision 1. An id already in the store is refused whatever its state,
/// so opening again can never reset a decided request to pending.
export function openTransition(
  existing: ApprovalRecord | undefined,
  input: NewApprovalRequest,
  now: number,
): Transition<OpenResult> {
  if (existing !== undefined) return { result: { ok: false, refused: "already_exists" } };
  if (typeof input.id !== "string" || input.id.length === 0) {
    return { result: { ok: false, refused: "invalid", problem: "A request needs an id." } };
  }
  const problem = requestProblem(input.kind, input);
  if (problem !== undefined) return { result: { ok: false, refused: "invalid", problem } };
  const request = buildRequest(input.id, input.kind, input, 1, now);
  return { result: { ok: true, request }, next: { status: "pending", request } };
}

/// Replaces what a pending request asks with its next revision. The id, kind and creation time
/// stay; everything else, stamps included, is what `next` says. Every revision counts as a change,
/// even one that repeats the last: a decision then has to name the revision it saw, which costs a
/// person one more look and never lets an approval drift onto something re-sent.
export function reviseTransition(
  existing: ApprovalRecord | undefined,
  next: RequestRevision,
): Transition<ReviseResult> {
  if (existing === undefined) return { result: { ok: false, refused: "not_found" } };
  if (existing.status === "decided") {
    return { result: { ok: false, refused: "already_decided", decision: existing.decision } };
  }
  if (existing.status === "withdrawn") return { result: { ok: false, refused: "withdrawn" } };
  const current = existing.request;
  const problem = requestProblem(current.kind, next);
  if (problem !== undefined) return { result: { ok: false, refused: "invalid", problem } };
  const request = buildRequest(current.id, current.kind, next, current.revision + 1, current.createdAt);
  return { result: { ok: true, request }, next: { status: "pending", request } };
}

/// Takes a pending request back, as when the team no longer needs the answer. A decision on it is
/// then refused as superseded, never as already decided, because nobody decided it. Withdrawing
/// twice changes nothing and reports the first time. A decided request cannot be withdrawn: its
/// decision stands, and the surface hears who made it.
export function withdrawTransition(existing: ApprovalRecord | undefined, now: number): Transition<WithdrawResult> {
  if (existing === undefined) return { result: { ok: false, refused: "not_found" } };
  if (existing.status === "decided") {
    return { result: { ok: false, refused: "already_decided", decision: existing.decision } };
  }
  if (existing.status === "withdrawn") return { result: { ok: true, withdrawnAt: existing.withdrawnAt } };
  return {
    result: { ok: true, withdrawnAt: now },
    next: { status: "withdrawn", request: existing.request, withdrawnAt: now },
  };
}

/// Why a request cannot be asked as given, in a sentence for logs, or undefined when it can.
///
/// A request with no options cannot be decided at all, and two options with one id would make
/// "the option chosen" ambiguous. An effect other than approve or decline, such as a blanket
/// "approve always", is refused because no decision may cover more than the one request.
export function requestProblem(
  kind: ApprovalKind,
  body: { readonly options: readonly ApprovalOption[]; readonly expiresAt?: number },
): string | undefined {
  if (!KNOWN_KINDS.has(kind)) return `"${String(kind)}" is not a kind of request.`;
  if (!Array.isArray(body.options) || body.options.length === 0) return "A request needs at least one option.";
  const seen = new Set<string>();
  for (const option of body.options) {
    if (typeof option?.id !== "string" || option.id.length === 0) return "Every option needs an id.";
    if (seen.has(option.id)) return `Option "${option.id}" is offered twice.`;
    seen.add(option.id);
    if (!KNOWN_EFFECTS.has(option.effect)) return `Option "${option.id}" neither approves nor declines.`;
  }
  if (body.expiresAt !== undefined && !Number.isFinite(body.expiresAt)) return "The expiry is not a time.";
  return undefined;
}

/// Builds the stored request from known fields only, so nothing a caller attached by accident
/// is stored or shown.
function buildRequest(
  id: string,
  kind: ApprovalKind,
  body: RequestRevision,
  revision: number,
  createdAt: number,
): ApprovalRequest {
  return {
    id,
    kind,
    options: body.options.map((option) => ({ id: option.id, label: option.label, effect: option.effect })),
    revision,
    createdAt,
    ...(body.turnId != null ? { turnId: body.turnId } : {}),
    ...(body.attemptId != null ? { attemptId: body.attemptId } : {}),
    ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    ...(body.detail !== undefined ? { detail: body.detail } : {}),
  };
}
