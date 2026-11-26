/// The JSON a request, decision, record or standing travels as between the server, the desktop app,
/// the web approval page and the phone. Each is one flat-ish JSON object using the same field
/// names as `types.ts`.
///
/// The decoders never throw. They read whatever arrives, which may come from a newer or older
/// build, and always answer a value: a missing or unreadable field takes the default written on
/// its decoder, and a kind, status, effect, role or state this build does not know is kept as an
/// explicit `unknown` value carrying the text that was sent. Keeping it means an older client can
/// show "update the app" instead of dropping the row, and a relay passes it on unchanged.
///
/// An `unknown` value is for showing, never for deciding: the rules in `roles.ts` and
/// `transitions.ts` only accept the known kinds and roles, so nothing unrecognised can approve or
/// be approved. Encoders write what the decoders read, so `decode(encode(x))` equals `x`.

import {
  APPROVAL_KINDS,
  OPTION_EFFECTS,
  ROLES,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRequest,
  type OptionEffect,
  type Role,
  type SettledDecision,
  type SupersededReason,
} from "./types";

/// A value this build does not recognise, kept with the text that was sent (empty when none was).
export interface Unknown {
  readonly unknown: true;
  readonly raw: string;
}

export type WireKind = ApprovalKind | Unknown;
export type WireEffect = OptionEffect | Unknown;
export type WireRole = Role | Unknown;

export interface WireOption {
  readonly id: string;
  readonly label: string;
  readonly effect: WireEffect;
}

export interface WireRequest {
  readonly id: string;
  readonly kind: WireKind;
  readonly options: readonly WireOption[];
  readonly revision: number;
  readonly createdAt: number;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly expiresAt?: number;
  readonly detail?: unknown;
}

export interface WireDecision {
  readonly requestId: string;
  readonly optionId: string;
  readonly seenRevision: number;
  readonly decidedBy: string;
  readonly role: WireRole;
  readonly decidedAt: number;
}

export type WireRecord =
  | { readonly status: "pending"; readonly request: WireRequest }
  | { readonly status: "decided"; readonly request: WireRequest; readonly decision: WireDecision }
  | { readonly status: "withdrawn"; readonly request: WireRequest; readonly withdrawnAt: number }
  | { readonly status: Unknown; readonly request: WireRequest };

export type WireStanding =
  | { readonly state: "open"; readonly reason: "waiting" }
  | { readonly state: "decided"; readonly reason: "decided"; readonly decision: WireDecision }
  | { readonly state: "changed"; readonly reason: "revised"; readonly currentRevision: number }
  | { readonly state: "superseded"; readonly reason: SupersededReason | Unknown }
  | { readonly state: "expired"; readonly reason: "expired"; readonly expiredAt: number }
  | { readonly state: Unknown };

type Json = Record<string, unknown>;

const SUPERSEDED_REASONS: readonly SupersededReason[] = ["turn_ended", "attempt_ended", "withdrawn", "not_found"];

/// Only an object that is not an array counts as one; anything else reads as an empty object so
/// every field takes its default.
function asObject(input: unknown): Json {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Json) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/// Optional text: a missing field and a `null` (as a stored row may hold) are the same thing.
function optText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/// A revision starts at 1 and counts whole steps, so anything else reads as the first.
function revisionOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function unknownOf(value: unknown): Unknown {
  return { unknown: true, raw: typeof value === "string" ? value : "" };
}

function oneOf<T extends string>(known: readonly T[], value: unknown): T | Unknown {
  return typeof value === "string" && (known as readonly string[]).includes(value) ? (value as T) : unknownOf(value);
}

/// The text to send for a value that may be unknown: the known value itself, or what was sent.
function rawOf(value: string | Unknown): string {
  return typeof value === "string" ? value : value.raw;
}

function isUnknown(value: unknown): value is Unknown {
  return typeof value === "object" && value !== null && (value as Unknown).unknown === true;
}

function decodeOption(input: unknown): WireOption {
  const o = asObject(input);
  return { id: text(o.id), label: text(o.label), effect: oneOf(OPTION_EFFECTS, o.effect) };
}

/// Defaults: id and kind empty (kind `unknown`), no options, revision 1, created at 0, and no
/// stamps, expiry or detail. An unreadable option becomes an option with empty text and an
/// unknown effect rather than disappearing, so the count of options survives.
export function decodeRequest(input: unknown): WireRequest {
  const o = asObject(input);
  const turnId = optText(o.turnId);
  const attemptId = optText(o.attemptId);
  const expiresAt = optFinite(o.expiresAt);
  return {
    id: text(o.id),
    kind: oneOf(APPROVAL_KINDS, o.kind),
    options: Array.isArray(o.options) ? o.options.map(decodeOption) : [],
    revision: revisionOf(o.revision),
    createdAt: finite(o.createdAt, 0),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(o.detail !== undefined && o.detail !== null ? { detail: o.detail } : {}),
  };
}

/// Defaults: empty ids, seen revision 0 (which matches no request, so it is never accepted by
/// accident), and decided at 0. A role that is missing or unknown stays `unknown`; it is never
/// defaulted to the owner.
export function decodeDecision(input: unknown): WireDecision {
  const o = asObject(input);
  return {
    requestId: text(o.requestId),
    optionId: text(o.optionId),
    seenRevision: typeof o.seenRevision === "number" && Number.isInteger(o.seenRevision) ? o.seenRevision : 0,
    decidedBy: text(o.decidedBy),
    role: oneOf(ROLES, o.role),
    decidedAt: finite(o.decidedAt, 0),
  };
}

/// A missing `status` is `unknown`
/// with empty text: guessing "pending" could show buttons for a request nobody checked.
/// A decided record with no readable decision carries the decision defaults; a withdrawn one
/// with no time carries 0.
export function decodeRecord(input: unknown): WireRecord {
  const o = asObject(input);
  const request = decodeRequest(o.request);
  switch (o.status) {
    case "pending":
      return { status: "pending", request };
    case "decided":
      return { status: "decided", request, decision: decodeDecision(o.decision) };
    case "withdrawn":
      return { status: "withdrawn", request, withdrawnAt: finite(o.withdrawnAt, 0) };
    default:
      return { status: unknownOf(o.status), request };
  }
}

/// Defaults: a missing or unrecognised `state` is `unknown`; a missing reason on `superseded`
/// is `unknown`; revisions and times default to 1 and 0.
export function decodeStanding(input: unknown): WireStanding {
  const o = asObject(input);
  switch (o.state) {
    case "open":
      return { state: "open", reason: "waiting" };
    case "decided":
      return { state: "decided", reason: "decided", decision: decodeDecision(o.decision) };
    case "changed":
      return { state: "changed", reason: "revised", currentRevision: revisionOf(o.currentRevision) };
    case "superseded":
      return { state: "superseded", reason: oneOf(SUPERSEDED_REASONS, o.reason) };
    case "expired":
      return { state: "expired", reason: "expired", expiredAt: finite(o.expiredAt, 0) };
    default:
      return { state: unknownOf(o.state) };
  }
}

function encodeOption(option: WireOption): Json {
  return { id: option.id, label: option.label, effect: rawOf(option.effect) };
}

export function encodeRequest(request: WireRequest | ApprovalRequest): Json {
  return {
    id: request.id,
    kind: rawOf(request.kind as string | Unknown),
    options: request.options.map((option) => encodeOption(option as WireOption)),
    revision: request.revision,
    createdAt: request.createdAt,
    ...(request.turnId != null ? { turnId: request.turnId } : {}),
    ...(request.attemptId != null ? { attemptId: request.attemptId } : {}),
    ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
    ...(request.detail !== undefined ? { detail: request.detail } : {}),
  };
}

export function encodeDecision(decision: WireDecision | SettledDecision): Json {
  return {
    requestId: decision.requestId,
    optionId: decision.optionId,
    seenRevision: decision.seenRevision,
    decidedBy: decision.decidedBy,
    role: rawOf(decision.role as string | Unknown),
    decidedAt: decision.decidedAt,
  };
}

export function encodeRecord(record: WireRecord): Json {
  const request = encodeRequest(record.request);
  if (isUnknown(record.status)) return { status: record.status.raw, request };
  switch (record.status) {
    case "pending":
      return { status: "pending", request };
    case "decided":
      return { status: "decided", request, decision: encodeDecision((record as { decision: WireDecision }).decision) };
    case "withdrawn":
      return { status: "withdrawn", request, withdrawnAt: (record as { withdrawnAt: number }).withdrawnAt };
  }
}

export function encodeStanding(standing: WireStanding): Json {
  if (isUnknown(standing.state)) return { state: standing.state.raw };
  switch (standing.state) {
    case "open":
      return { state: "open", reason: "waiting" };
    case "decided":
      return { state: "decided", reason: "decided", decision: encodeDecision((standing as { decision: WireDecision }).decision) };
    case "changed":
      return { state: "changed", reason: "revised", currentRevision: (standing as { currentRevision: number }).currentRevision };
    case "superseded":
      return { state: "superseded", reason: rawOf((standing as { reason: SupersededReason | Unknown }).reason) };
    case "expired":
      return { state: "expired", reason: "expired", expiredAt: (standing as { expiredAt: number }).expiredAt };
  }
}

/// Whether a decoded value is one this build does not recognise.
export { isUnknown };

/// Narrows a decoded request to the shape the rules accept, or `undefined` when its kind or any
/// option's effect is unknown. The rules never see an unknown value.
export function toKnownRequest(request: WireRequest): ApprovalRequest | undefined {
  if (isUnknown(request.kind)) return undefined;
  const options: ApprovalOption[] = [];
  for (const option of request.options) {
    if (isUnknown(option.effect)) return undefined;
    options.push({ id: option.id, label: option.label, effect: option.effect });
  }
  return { ...request, kind: request.kind, options };
}
