// A shop's approvals as the owner's web app reads them: approval-core's own wire records, as `GET /v1/approvals` lists them
// to a shop's session (docs/pilot-api.md, "Approvals for a session"), read with `@manut/approval-core`'s decoders and never
// by hand, and what the decision route answered (docs/pilot-api.md, "Deciding from a session").
//
// The reading of a listing is lifted from the desktop (apps/desktop/src/runtime/http/approvals.ts) with its tests, so the
// two apps read a request alike. Its rules:
// - Decoding never throws and never drops a request. A kind, an option's effect, a record's status or a standing's state
//   this build does not know is kept as approval-core keeps it (an `unknown` value carrying the text that was sent): the
//   ask is shown, says the app must be updated to answer it, and nothing here ever answers it (`answerable`). Only an
//   entry with no request id, which nothing could show or answer, goes with the shop's other unreadable entries.
// - What a request shows (`detail`) is cut down to the words this app shows: the operation, where it goes, to whom, and
//   its text. Nothing else the API sends stays on the record.
// - A decision names the revision the person saw and no other, so a request revised since then is a new ask the person
//   sees first, never one decided unseen.
// - An option is chosen by what it does, never by its label: Approve approves, Decline declines. approval-core has no
//   standing approval, so nothing answers for a session or for always.
import {
  decodeDecision,
  decodeRecord,
  decodeStanding,
  isUnknown,
  toKnownRequest,
  type ApprovalOption,
  type ApprovalRequest,
  type OptionEffect,
  type WireDecision,
  type WireRecord,
  type WireRequest,
  type WireStanding,
} from "@manut/approval-core";
import type { WebAnswer } from "../api";

/** What a request shows that this app puts into words. A LINE reply names all five (`replyRequest` in the API's
 *  task-object.ts); a browser write, Ton's books and a helper's view of them carry the control plane's own sentence as
 *  `text`; a worker's other requests name their operation and where it goes. */
export interface AskDetail {
  actionId?: string;
  operationType?: string;
  targetResourceId?: string;
  /** the LINE user id of the customer a reply goes to */
  recipient?: string;
  /** exactly what would be sent, or the control plane's sentence for what would be done */
  text?: string;
}

/** A note a helper passed on to the owner with a request they may not decide (docs/people.md). */
export interface PassedOn {
  by: string;
  name: string;
  note: string;
  /** ms; null when the API sent no readable time */
  at: number | null;
}

export interface ShopApproval {
  /** the task whose work asked; "" when the API named none */
  taskId: string;
  /** approval-core's record, its request's detail cut down to `AskDetail` */
  record: WireRecord;
  /** where it stands, read by the API when it answered */
  standing: WireStanding;
  passedOn: PassedOn | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const ms = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

const DETAIL_FIELDS = ["actionId", "operationType", "targetResourceId", "recipient", "text"] as const;

/** The words a request shows, and nothing else; undefined when it shows none this app reads. */
function narrowDetail(detail: unknown): AskDetail | undefined {
  if (!isObj(detail)) return undefined;
  const kept: AskDetail = {};
  for (const field of DETAIL_FIELDS) if (typeof detail[field] === "string") kept[field] = detail[field] as string;
  return Object.keys(kept).length ? kept : undefined;
}

/** The record with its request's detail cut down to the words this app shows. */
export function shownRecord(record: WireRecord): WireRecord {
  const { detail, ...request } = record.request;
  const kept = narrowDetail(detail);
  return { ...record, request: { ...request, ...(kept ? { detail: kept } : {}) } } as WireRecord;
}

/** What a request shows, as this app reads it: `{}` when it shows nothing this app puts into words. */
export function detailOf(request: WireRequest): AskDetail {
  return narrowDetail(request.detail) ?? {};
}

function passedOnOf(v: unknown): PassedOn | null {
  if (!isObj(v)) return null;
  return { by: str(v.by), name: str(v.name), note: str(v.note), at: ms(v.at) };
}

function decodeApproval(v: unknown, unreadable: unknown[]): ShopApproval | null {
  const record = isObj(v) ? decodeRecord(v.record) : null;
  if (!isObj(v) || !record || !record.request.id) {
    unreadable.push(v);
    return null;
  }
  return { taskId: str(v.taskId), record: shownRecord(record), standing: decodeStanding(v.standing), passedOn: passedOnOf(v.passedOn) };
}

/** The approvals of one `GET /v1/approvals` answer (`{ state, approvals }`), in the order the API listed them. An entry
 *  that cannot be read goes to `unreadable`; a body with no list is no approvals. */
export function decodeApprovals(json: unknown, unreadable: unknown[]): ShopApproval[] {
  const entries = isObj(json) && Array.isArray(json.approvals) ? json.approvals : [];
  return entries.map((v) => decodeApproval(v, unreadable)).filter((a): a is ShopApproval => !!a);
}

/** Whether the request still waits for someone: open, or standing in a state this build does not know, which is shown
 *  (to say "update the app") rather than taken for over. */
export function isAsk(a: ShopApproval): boolean {
  return a.standing.state === "open" || isUnknown(a.standing.state);
}

/** The request as approval-core's rules take it, when this build can answer it: open and pending, of a kind and with
 *  options it knows, and offering at most one option of each effect, so each answer the card shows is exactly one option.
 *  Null for anything else, which is shown and never answered. */
export function answerable(a: ShopApproval): ApprovalRequest | null {
  if (a.standing.state !== "open" || a.record.status !== "pending") return null;
  const request = toKnownRequest(a.record.request);
  if (!request) return null;
  const approve = request.options.filter((o) => o.effect === "approve").length;
  const decline = request.options.filter((o) => o.effect === "decline").length;
  if (approve > 1 || decline > 1 || approve + decline === 0) return null;
  return request;
}

/** The answers the card offers: Approve for the option that approves, Decline for the one that declines. None for a
 *  request this build cannot answer. */
export function choicesOf(a: ShopApproval): OptionEffect[] {
  const request = answerable(a);
  if (!request) return [];
  const choices: OptionEffect[] = [];
  if (request.options.some((o) => o.effect === "approve")) choices.push("approve");
  if (request.options.some((o) => o.effect === "decline")) choices.push("decline");
  return choices;
}

/** The one option a choice means for this request, by its effect; null when the request offers no such option, and for
 *  anything that is not an effect, since approval-core cannot express a standing approval. */
export function optionFor(request: ApprovalRequest, choice: string): ApprovalOption | null {
  const found = choice === "approve" || choice === "decline" ? request.options.filter((o) => o.effect === choice) : [];
  return found.length === 1 ? found[0]! : null;
}

/** The ask's id: the request's id and the revision shown, `action-1@1`. A revised request is a new ask. */
export function askId(a: ShopApproval): string {
  return `${a.record.request.id}@${a.record.request.revision}`;
}

/** The request id and the revision an ask's id names, or null for an id `askId` did not make. */
export function parseAskId(ask: string): { id: string; revision: number } | null {
  const at = ask.lastIndexOf("@");
  if (at <= 0) return null;
  const digits = ask.slice(at + 1);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  const revision = Number(digits);
  return Number.isSafeInteger(revision) ? { id: ask.slice(0, at), revision } : null;
}

// ---------------------------------------------------------------------------
// The web routes' answers
// ---------------------------------------------------------------------------

/** How a person's place in a shop ended, or that the browser's session for it did: removed as its helper, or unlinked as
 *  its owner's account, each with when the API says it happened (ms; null when it did not say). */
export type Left = { why: "removed" | "unlinked"; at: number | null };

/** What a read of one shop's approvals came to. */
export type Listing =
  | { ok: true; approvals: ShopApproval[]; unreadable: unknown[] }
  /** The browser holds no session the shop still holds: reading the person's shops opens a new one. */
  | { ok: false; why: "session_ended" }
  | { ok: false; why: "left"; left: Left }
  | { ok: false; why: "unavailable" };

function leftOf(body: Obj): Left | null {
  if (body.error === "removed") return { why: "removed", at: ms(body.removedAt) };
  if (body.error === "unlinked") return { why: "unlinked", at: ms(body.unlinkedAt) };
  return null;
}

/** A `GET /v1/web/approvals` answer. Anything but a list or one of the three 401s is the shop being unreadable now, never
 *  a shop with nothing waiting. */
export function readListing(answer: WebAnswer): Listing {
  const body = isObj(answer.body) ? answer.body : {};
  if (answer.status === 200 && Array.isArray(body.approvals)) {
    const unreadable: unknown[] = [];
    return { ok: true, approvals: decodeApprovals(body, unreadable), unreadable };
  }
  if (answer.status === 401) {
    const left = leftOf(body);
    return left ? { ok: false, why: "left", left } : { ok: false, why: "session_ended" };
  }
  return { ok: false, why: "unavailable" };
}

/** Where an action stands after a decision, as the decision route's `action` says it; null when it said nothing readable. */
export type ActionState = "approved" | "rejected" | "dispatching" | "confirmed" | "failed" | "unknown" | "proposed" | "expired";
const ACTION_STATES = new Set<string>(["approved", "rejected", "dispatching", "confirmed", "failed", "unknown", "proposed", "expired"]);

function actionOf(v: unknown): ActionState | null {
  return typeof v === "string" && ACTION_STATES.has(v) ? (v as ActionState) : null;
}

/** What a decision came to, as the decision route answered it, read field by field. Taken only when the route says it was
 *  decided; no answer, or one this build cannot read, is never read as taken or as lost (`unclear`): the request may have
 *  been decided, so the app reads the shop again before offering the buttons. */
export type Outcome =
  /** Decided as the person chose: `approved` says which, and `action` where the send stands now. */
  | { kind: "decided"; approved: boolean; action: ActionState | null }
  /** Someone decided first: who, as approval-core recorded it, and where the send stands. */
  | { kind: "already"; decision: WireDecision; action: ActionState | null }
  | { kind: "changed" }
  | { kind: "superseded"; reason: string }
  | { kind: "expired"; at: number | null }
  /** The person's role may not decide the request's kind (approval-core's `mayDecide`). */
  | { kind: "not_permitted" }
  | { kind: "not_offered" }
  | { kind: "consent_required" }
  | { kind: "switched_off" }
  | { kind: "gone" }
  | { kind: "session_ended" }
  | { kind: "left"; left: Left }
  | { kind: "unclear" };

/** A `POST /v1/web/approvals/{requestId}/decision` answer, for a decision that `approved` or declined. */
export function readDecision(answer: WebAnswer, approved: boolean): Outcome {
  const body = isObj(answer.body) ? answer.body : {};
  const result = isObj(body.result) ? body.result : {};
  if (answer.status === 200) return result.ok === true ? { kind: "decided", approved, action: actionOf(body.action) } : { kind: "unclear" };
  if (answer.status === 401) {
    const left = leftOf(body);
    return left ? { kind: "left", left } : { kind: "session_ended" };
  }
  switch (body.error) {
    case "already_decided":
      return isObj(result.decision) ? { kind: "already", decision: decodeDecision(result.decision), action: actionOf(body.action) }
        : { kind: "unclear" };
    case "changed":
      return { kind: "changed" };
    case "superseded":
      return { kind: "superseded", reason: str(result.reason) };
    case "expired":
      return { kind: "expired", at: typeof result.expiredAt === "number" && result.expiredAt > 0 ? result.expiredAt : null };
    case "not_permitted":
      return { kind: "not_permitted" };
    case "not_offered":
      return { kind: "not_offered" };
    case "consent_required":
      return { kind: "consent_required" };
    case "feature_disabled":
      return { kind: "switched_off" };
    case "not_found":
      return { kind: "gone" };
    default:
      return { kind: "unclear" };
  }
}
