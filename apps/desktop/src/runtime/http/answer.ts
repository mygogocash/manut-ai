// What the person's answer to an ask came to, as the decide route answered it (apps/api, `POST /v1/approvals/{requestId}/
// decision`; docs/pilot-api.md, "Deciding from a session"): taken, or why not, in the words the card and Home show, and
// how the card closes once the shop is read again.
//
// The route decides through approval-core in the request's own task, with the role taken from the session and never
// from the body, so nothing here decides anything: it only puts the API's answer into words. Rules it keeps:
// - Taken only when the API says it was decided. No answer at all (offline, a 5xx, a body that does not say so) is never
//   read as taken or as lost: the request may have been decided, so the words say it is being checked, and the runtime
//   reads the shop again to find out.
// - A refusal that means the request is over (decided first, changed, superseded, expired, gone) carries the words its
//   card closes with ("Already decided by Mint at 19:42"). One that leaves it waiting (a role that may not decide it, the
//   shop's consent, a switch) leaves the card open with the words under it.
import { decodeDecision, isUnknown, type ApprovalKind, type WireDecision } from "@manut/approval-core";
import { dayTime, longDay } from "../../app/time";
import { t, type Key } from "../../i18n";
import { onlyOwnerWords } from "../../lib/shops";
import type { Answer } from "./session";

/** Who the API names when the shop's own session decided (apps/api approvals.ts) and when the owner's link did (pilot.ts). */
export const OWNER_SESSION = "owner-session";
export const OWNER_LINK = "owner-link";

/** How an ask's card closes when its request is over, as the protocol's `prompt.expired` says it: the reason, which the
 *  card has a word for, and, when there are any, the API's own words for it. */
export interface Closing {
  reason: "timeout" | "cancelled" | "resolved";
  note?: string;
}

export type Outcome = { ok: true } | { ok: false; code: string; words: string; closing?: Closing };

export interface AnswerContext {
  /** the kind of what was answered, which says who may decide it */
  kind: ApprovalKind;
  /** the names of the shop's helpers this app has been told, by id */
  names: ReadonlyMap<string, string>;
  /** ms, this computer's clock */
  now: number;
  /** The owner's name, when the person is a helper at the shop: a decision of the owner's is then "by Noi", never "by you". Absent
   *  for the owner themselves, and for the signed-in tenant's own shop, where the person is the owner. */
  owner?: string;
}

/** The request's decision route. Its id is one path segment, whatever it holds. */
export function decisionPath(requestId: string): string {
  return `/v1/approvals/${encodeURIComponent(requestId)}/decision`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const NOT_PERMITTED: Partial<Record<ApprovalKind, Key>> = {
  money: "rt.no.money",
  public_post: "rt.no.public_post",
  payment_confirmation: "rt.no.payment_confirmation",
  command: "rt.no.command",
};

/** Words for an answer that changed nothing and leaves the ask waiting. */
const WAITING: Readonly<Record<string, Key>> = {
  not_offered: "rt.ask.notOffered",
  consent_required: "rt.ask.consent",
  feature_disabled: "rt.ask.switchedOff",
  invalid_request: "rt.ask.notRead",
};

/** Who decided a request, as the words name them. */
export type Who = { kind: "you" } | { kind: "link" } | { kind: "named"; name: string } | { kind: "helper" } | { kind: "unknown" };

/** Who decided, from what the API says (`decidedBy` and `role`, which it takes from the session): the owner from this app, or
 *  from the link on LINE; the owner by name when the person reading is a helper (`owner` is set only for one: to a helper the
 *  owner's decision is never "yours"); a helper by the name the shop gave them when this app was told it, otherwise as a helper;
 *  and anyone in a role this build does not know as no one in particular. */
export function whoDecided(decision: WireDecision, names: ReadonlyMap<string, string>, owner?: string): Who {
  if (isUnknown(decision.role)) return { kind: "unknown" };
  if (decision.role === "owner") {
    if (owner !== undefined) return owner ? { kind: "named", name: owner } : { kind: "unknown" };
    return { kind: decision.decidedBy === OWNER_LINK ? "link" : "you" };
  }
  const name = names.get(decision.decidedBy);
  return name ? { kind: "named", name } : { kind: "helper" };
}

/** Who decided first and when, in words. With no time, no time is said, and nor is who. */
export function decidedWords(decision: WireDecision, names: ReadonlyMap<string, string>, now: number, owner?: string): string {
  if (!(decision.decidedAt > 0)) return t("rt.decided.already");
  const time = dayTime(decision.decidedAt, now);
  const who = whoDecided(decision, names, owner);
  switch (who.kind) {
    case "unknown":
      return t("rt.decided.someone", { time });
    case "you":
      return t("rt.decided.you", { time });
    case "link":
      return t("rt.decided.link", { time });
    case "named":
      return t("rt.decided.by", { name: who.name, time });
    case "helper":
      return t("rt.decided.helper", { time });
  }
}

/** Why a request nobody decided is no longer asked: the work it was for stopped, the team took it back, or no more is said. */
export function supersededWords(reason: unknown): string {
  if (reason === "attempt_ended" || reason === "turn_ended") return t("rt.ask.ended");
  return t(reason === "withdrawn" ? "rt.ask.withdrawn" : "rt.ask.gone");
}

/** When a request ran out of time: "Expired at 19:42", or "Timed out" when the API gave no time. */
export function expiredWords(expiredAt: unknown, now: number): string {
  const at = typeof expiredAt === "number" && expiredAt > 0 ? expiredAt : null;
  return at === null ? t("card.timedOut") : t("rt.ask.expired", { time: dayTime(at, now) });
}

function removedWords(removedAt: unknown): string {
  const at = typeof removedAt === "string" ? Date.parse(removedAt) : NaN;
  return Number.isNaN(at) ? t("rt.ask.removedNoDate") : t("rt.ask.removed", { date: longDay(at) });
}

/** A refusal that means the request is over: its words, and its card closes with them. */
function over(code: string, words: string, reason: Closing["reason"]): Outcome {
  return { ok: false, code, words, closing: { reason, note: words } };
}

/** What the decide route's answer comes to. */
export function outcomeOf(answer: Answer, ctx: AnswerContext): Outcome {
  if (answer.kind === "ok") {
    const result = isObj(answer.json) ? answer.json.result : undefined;
    return isObj(result) && result.ok === true ? { ok: true } : { ok: false, code: "unknown", words: t("rt.ask.noReply") };
  }
  if (answer.kind === "signed_out") return { ok: false, code: "signed_out", words: t("rt.signedOut") };
  if (answer.kind !== "refused") return { ok: false, code: "unknown", words: t("rt.ask.noReply") };
  const body = isObj(answer.json) ? answer.json : {};
  const result = isObj(body.result) ? body.result : {};
  const code = answer.code || "refused";
  switch (code) {
    case "not_permitted":
      // A helper is told who may decide it, by name, in the words their card says it in ("Only Noi can approve money"): the
      // card offered an answer this build thought their role may give, and approval-core, which decides, says it may not.
      return { ok: false, code, words: ctx.owner ? onlyOwnerWords(ctx.kind, ctx.owner) : t(NOT_PERMITTED[ctx.kind] ?? "rt.no.other") };
    case "already_decided":
      return over(code, decidedWords(decodeDecision(result.decision), ctx.names, ctx.now, ctx.owner), "resolved");
    case "changed":
      return over(code, t("rt.ask.changed"), "cancelled");
    case "superseded":
      return over(code, supersededWords(result.reason), "cancelled");
    case "expired":
      return over(code, expiredWords(result.expiredAt, ctx.now), "timeout");
    case "not_found":
      return over(code, t("rt.notFound"), "cancelled");
    case "removed":
      return { ok: false, code, words: removedWords(body.removedAt) };
    default:
      return { ok: false, code, words: t(WAITING[code] ?? "rt.ask.refused") };
  }
}
