// How a request that left the shop's open approvals with no answer from this app was settled, read from the shop's recent ones
// (`GET /v1/approvals?state=recent`; docs/pilot-api.md, "Approvals for a session"). That list is approval-core's own records of the
// newest requests that stopped waiting, each with where it stands, so a card that closes on its own can say whether the request was
// approved or declined and by whom, taken back, ended, or timed out, instead of only "answered elsewhere".
//
// Rules this module keeps:
// - It only reads. Nothing here decides, answers or passes on anything, so approval-core's rules (the decide route) stay the only way
//   round a request.
// - Approved or declined is what the option the request offered does (`effect`), never its id or its label: an id or a label can be
//   any words in any language. A decision whose option is not among the request's, is offered twice, or does not say what it does is
//   put as "decided" with no verb, in the words the answer path already has for it.
// - The record is the card's only when it is the request the card showed, at the revision it showed. A request revised after the card
//   was shown and then settled is a different thing from what the card asked: saying "approved" on the old card would say the exact
//   words it showed were approved. The caller then keeps its own closing.
// - Nothing is guessed. A record that says it is still waiting, a standing or a status this build does not know, or a request the list
//   does not hold gives no closing (null), and the caller keeps the words it had before it read.
import type { WireDecision, WireRequest } from "@manut/approval-core";
import { dayTime } from "../../app/time";
import { t, type Key } from "../../i18n";
import { decidedWords, expiredWords, supersededWords, whoDecided, type Closing, type Who } from "./answer";
import { decodeApprovals, type ShopApproval } from "./approvals";
import type { Answer } from "./session";

/** What an ask that left is looked up in: the newest requests that are no longer waiting (the API holds 50 of them when no limit is
 *  asked for), decided, expired or ended, newest asked first. */
export const RECENT_PATH = "/v1/approvals?state=recent";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The records of a `state=recent` answer, or null for anything that is not that list: a refusal, no answer, a body of another
 *  kind (an answer that says `open` is the open list, not this one), or one with no list in it. An entry this build cannot read
 *  whole is left out, as in every read of the shop's approvals. */
export function recentOf(answer: Answer): ShopApproval[] | null {
  if (answer.kind !== "ok") return null;
  const body = answer.json;
  if (!isObj(body) || body.state !== "recent" || !Array.isArray(body.approvals)) return null;
  return decodeApprovals(body, []);
}

/** The helpers' names a list of approvals tells, by id: a note a helper passed on carries the name the owner gave them. */
export function helperNames(...lists: readonly (readonly ShopApproval[])[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const list of lists) for (const a of list) if (a.passedOn?.name) names.set(a.passedOn.by, a.passedOn.name);
  return names;
}

export interface DecidedContext {
  /** the helpers' names this app has been told, by id */
  names: ReadonlyMap<string, string>;
  /** The owner's name when the person is a helper at the shop, so the owner's decision reads "by Noi", never "by you"; absent for
   *  the owner, and for the signed-in tenant's own shop. */
  owner?: string;
  /** ms, this computer's clock */
  now: number;
}

/** The ask a card shows: the request's id and the revision it showed. */
export interface AskedOf {
  id: string;
  revision: number;
}

type Verb = "approve" | "decline";
type Line = Record<Who["kind"], Key> & { none: Key };
/** What each outcome says, by who decided. Typed keys, so a word that is not in every language does not compile. */
const HOW: Record<Verb, Line> = {
  approve: {
    you: "rt.how.approved.you",
    link: "rt.how.approved.link",
    named: "rt.how.approved.by",
    helper: "rt.how.approved.helper",
    unknown: "rt.how.approved.someone",
    none: "rt.how.approved",
  },
  decline: {
    you: "rt.how.declined.you",
    link: "rt.how.declined.link",
    named: "rt.how.declined.by",
    helper: "rt.how.declined.helper",
    unknown: "rt.how.declined.someone",
    none: "rt.how.declined",
  },
};

/** What the option a decision chose does, by what the request itself says: the one option with that id, when it says approve or
 *  decline. Null for an id the request does not offer, one it offers twice, and an effect this build does not know. */
function effectOf(request: WireRequest, decision: WireDecision): Verb | null {
  const offered = request.options.filter((o) => o.id === decision.optionId);
  const effect = offered.length === 1 ? offered[0].effect : null;
  return effect === "approve" || effect === "decline" ? effect : null;
}

function decidedClosing(request: WireRequest, decision: WireDecision, ctx: DecidedContext): Closing {
  const verb = effectOf(request, decision);
  if (!verb) return { reason: "resolved", note: decidedWords(decision, ctx.names, ctx.now, ctx.owner) };
  // With no time to say, "Approved" alone: who is not said either, as for "Already decided" (answer.ts).
  if (!(decision.decidedAt > 0)) return { reason: "resolved", note: t(HOW[verb].none) };
  const who = whoDecided(decision, ctx.names, ctx.owner);
  const time = dayTime(decision.decidedAt, ctx.now);
  return { reason: "resolved", note: t(HOW[verb][who.kind], who.kind === "named" ? { time, name: who.name } : { time }) };
}

/** The decision a record carries: where the request stands says it, and so does the record's own status. */
function decisionOf(entry: ShopApproval): WireDecision | null {
  if (entry.standing.state === "decided") return entry.standing.decision;
  return entry.record.status === "decided" ? entry.record.decision : null;
}

/** How the card of `ask` closes, from the shop's recent requests, or null when they do not say: the request is not listed, the
 *  list holds it at another revision than the card showed, it is still waiting, or where it stands is not known to this build.
 *  Decided closes as "resolved" with who and when, withdrawn or ended as "cancelled", and one that ran out of time as "timeout",
 *  in the words the answer path says them in. */
export function closingFor(records: readonly ShopApproval[], ask: AskedOf, ctx: DecidedContext): Closing | null {
  const entry = records.find((a) => a.record.request.id === ask.id);
  if (!entry || entry.record.request.revision !== ask.revision) return null;
  const decision = decisionOf(entry);
  if (decision) return decidedClosing(entry.record.request, decision, ctx);
  const { standing, record } = entry;
  if (standing.state === "expired") return { reason: "timeout", note: expiredWords(standing.expiredAt, ctx.now) };
  if (standing.state === "superseded") return { reason: "cancelled", note: supersededWords(standing.reason) };
  if (record.status === "withdrawn") return { reason: "cancelled", note: supersededWords("withdrawn") };
  return null;
}
