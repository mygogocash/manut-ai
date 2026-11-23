// The shop's approvals: approval-core's own wire records, as `GET /v1/approvals?state=open` lists them for a session
// (docs/pilot-api.md, "Approvals for a session"), read with `@manut/approval-core`'s decoders and never by hand.
//
// Rules this module keeps:
// - Decoding never throws and never drops a request. A kind, an option's effect, a record's status or a standing's state
//   this build does not know is kept as approval-core keeps it (an `unknown` value carrying the text that was sent): the
//   ask is shown, says "Update the app to answer this", and nothing here ever answers it (`answerable`). Only an entry
//   with no request id, which nothing could show or answer, goes with the shop's other unreadable entries.
// - What a request shows (`detail`) is cut down to the words this app shows: the operation, where it goes, to whom, and
//   its text. Nothing else the API sends stays on the record, so nothing more reaches the offline cache; the whole entry
//   stays in `raw`, as every record the runtime reads keeps it.
// - An ask's id carries the revision the person saw (`askId`). A decision names that revision and no other, so a request
//   revised since then is a new ask the person sees first, never one decided unseen.
// - An option is chosen by what it does, never by its label: Allow once approves, Deny declines. approval-core has no
//   standing approval, so nothing answers for a session or for always.
import {
  decodeRecord,
  decodeStanding,
  isUnknown,
  toKnownRequest,
  type ApprovalOption,
  type ApprovalRequest,
  type OptionEffect,
  type WireRecord,
  type WireRequest,
  type WireStanding,
} from "@manut/approval-core";
import type { ApprovalChoice } from "../../lib/protocol";

/** What a request shows that this app puts into words. A LINE reply names all five (`replyRequest` in the API's
 *  task-object.ts); a worker's request names its operation and where it goes, and the words are in its action. */
export interface AskDetail {
  actionId?: string;
  operationType?: string;
  targetResourceId?: string;
  /** the LINE user id of the customer a reply goes to */
  recipient?: string;
  /** exactly what would be sent */
  text?: string;
}

/** A note a helper passed on to the owner with a request they may not decide (docs/people.md). */
export interface PassedOn {
  /** the helper's id */
  by: string;
  /** the name the owner gave them */
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
  raw: unknown;
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

/** The record with its request's detail cut down to the words this app shows: what a read keeps, and what the offline
 *  cache writes. */
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
  return { taskId: str(v.taskId), record: shownRecord(record), standing: decodeStanding(v.standing), passedOn: passedOnOf(v.passedOn), raw: v };
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

/** The answers the card offers: Allow once for the option that approves, Deny for the one that declines. None for a
 *  request this build cannot answer. */
export function choicesOf(a: ShopApproval): ApprovalChoice[] {
  const request = answerable(a);
  if (!request) return [];
  const choices: ApprovalChoice[] = [];
  if (request.options.some((o) => o.effect === "approve")) choices.push("once");
  if (request.options.some((o) => o.effect === "decline")) choices.push("deny");
  return choices;
}

const EFFECT_OF: Partial<Record<ApprovalChoice, OptionEffect>> = { once: "approve", deny: "decline" };

/** The one option a choice means for this request, by its effect; null when the request offers no such option, and
 *  always for a session or for always, which approval-core cannot express. */
export function optionFor(request: ApprovalRequest, choice: ApprovalChoice): ApprovalOption | null {
  const effect = EFFECT_OF[choice];
  const found = effect ? request.options.filter((o) => o.effect === effect) : [];
  return found.length === 1 ? found[0] : null;
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
