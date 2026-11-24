import { isUnknown, mayDecide, type OptionEffect, type WireDecision } from "@manut/approval-core";
import { ApiError, type PilotApi, type WebAnswer, type WebApprovalsState, type WebShop } from "../api";
import { answerable, isAsk, optionFor, readDecision, readListing, type Left, type Outcome, type ShopApproval } from "./asks";
import type { Who } from "./strings";

/// Needs you across the person's shops, and answering one ask, outside React so they are tested on their own. Every read
/// and every decision goes to one shop with that shop's own session (the web routes pick it by the shop named), so an
/// answer can never reach a shop it was not asked in. Nothing here keeps anything: what was read lives in the page's
/// memory, and only until the next read.

/// One request of one shop.
export type Ask = { shop: WebShop; approval: ShopApproval };

/// Why a shop's requests are not shown: it could not be read now, or the person's place in it ended.
export type ShopProblem = { shop: WebShop; why: "unavailable" } | { shop: WebShop; why: "left"; left: Left };

export type NeedsRead =
  | {
    ok: true;
    /// Every request still waiting, oldest asked first, as the desktop's Needs you orders them.
    asks: Ask[];
    /// The newest requests answered lately, or that nobody answered in time, newest first.
    recent: Ask[];
    problems: ShopProblem[];
    /// How many entries could not be read at all.
    unreadable: number;
    /// The shops as the last read of them said, when a session had to be opened again on the way; else null.
    shops: WebShop[] | null;
  }
  /// No answer from the API: the phone is offline, or the API cannot be reached.
  | { ok: false; why: "offline" }
  /// The sign-in has ended (`signed_out` when the shops were read again).
  | { ok: false; why: "signed_out" };

/// How many answered requests "Answered lately" shows.
export const RECENT_SHOWN = 6;

class Offline extends Error {}
class SignedOut extends Error {}

/// Reads every ready shop's waiting requests and those answered lately, in parallel. A shop whose session the browser no
/// longer holds is opened again once, by reading the person's shops (`POST /v1/web/shops`, shared by every shop of this
/// read, so two shops never open two sessions for one), and read again.
export async function readNeeds(api: PilotApi, shops: readonly WebShop[]): Promise<NeedsRead> {
  let reopened: Promise<WebShop[]> | null = null;
  let latest: WebShop[] | null = null;
  const reopen = () => {
    reopened ??= api.webShops().then((session) => {
      if (!session.signedIn) throw new SignedOut();
      return (latest = session.shops);
    }, (err: unknown) => {
      if (err instanceof ApiError && err.status === 0) throw new Offline();
      throw err;
    });
    return reopened;
  };

  async function read(shop: WebShop, state: WebApprovalsState) {
    for (let attempt = 0; ; attempt += 1) {
      let answer: WebAnswer;
      try {
        answer = await api.webApprovals(shop.id, state);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) throw new Offline();
        return { ok: false as const, why: "unavailable" as const };
      }
      const listing = readListing(answer);
      if (listing.ok || listing.why !== "session_ended" || attempt > 0) return listing;
      await reopen().catch((err: unknown) => {
        if (err instanceof SignedOut || err instanceof Offline) throw err;
      });
    }
  }

  try {
    const ready = shops.filter((shop) => shop.ready);
    const reads = await Promise.all(ready.map(async (shop) => ({ shop, open: await read(shop, "open"),
      recent: await read(shop, "recent") })));
    const asks: Ask[] = [];
    const recent: Ask[] = [];
    const problems: ShopProblem[] = [];
    let unreadable = 0;
    for (const { shop, open, recent: answered } of reads) {
      const failed = !open.ok ? open : !answered.ok ? answered : null;
      if (failed) {
        problems.push(failed.why === "left" ? { shop, why: "left", left: failed.left } : { shop, why: "unavailable" });
        continue;
      }
      if (!open.ok || !answered.ok) continue;
      unreadable += open.unreadable.length + answered.unreadable.length;
      for (const approval of open.approvals) if (isAsk(approval)) asks.push({ shop, approval });
      for (const approval of answered.approvals) if (!isAsk(approval)) recent.push({ shop, approval });
    }
    const asked = (ask: Ask) => ask.approval.record.request.createdAt;
    asks.sort((a, b) => asked(a) - asked(b) || compare(a.approval.record.request.id, b.approval.record.request.id));
    recent.sort((a, b) => settledAt(b) - settledAt(a) || compare(b.approval.record.request.id, a.approval.record.request.id));
    return { ok: true, asks, recent: recent.slice(0, RECENT_SHOWN), problems, unreadable, shops: latest };
  } catch (err) {
    if (err instanceof SignedOut) return { ok: false, why: "signed_out" };
    if (err instanceof Offline) return { ok: false, why: "offline" };
    throw err;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/// When an answered request was settled, as its standing says: when it was decided, or ran out; else when it was asked.
function settledAt(ask: Ask): number {
  const standing = ask.approval.standing;
  if (standing.state === "decided") return standing.decision.decidedAt;
  if (standing.state === "expired") return standing.expiredAt;
  return ask.approval.record.request.createdAt;
}

/// Whether the person may answer the ask, by approval-core's own rule for their role there: a helper decides messages and
/// replies, and money, public posts, payment confirmations and commands wait for the owner. A kind this build does not
/// know is decided by nobody here.
export function mayAnswer(ask: Ask): boolean {
  const kind = ask.approval.record.request.kind;
  return !isUnknown(kind) && mayDecide(ask.shop.role, kind) && answerable(ask.approval) !== null;
}

/// Sends the person's answer to one ask through that shop's own session, choosing the option by what it does. A shop that
/// no longer holds the browser's session for it answers 401 before it reads the body, so nothing was decided: the shop is
/// opened again once, by reading the person's shops, and the same answer is sent once more. No answer at all is
/// `unclear`, never taken for an answer that arrived or one that did not.
export async function decideAsk(api: PilotApi, ask: Ask, effect: OptionEffect): Promise<Outcome> {
  const request = answerable(ask.approval);
  const option = request ? optionFor(request, effect) : null;
  if (!request || !option) return { kind: "not_offered" };
  const input = { shop: ask.shop.id, requestId: request.id, optionId: option.id, seenRevision: request.revision };
  for (let attempt = 0; ; attempt += 1) {
    let outcome: Outcome;
    try {
      outcome = readDecision(await api.webDecide(input), effect === "approve");
    } catch {
      return { kind: "unclear" };
    }
    if (outcome.kind !== "session_ended" || attempt > 0) return outcome;
    try {
      await api.webShops();
    } catch {
      return outcome;
    }
  }
}

/// Who decided, as this person can be told: themselves (on any of their devices, or from the LINE link when they own the
/// shop), the shop's owner, a helper (the web is not told helpers' names), or someone in a role this build does not know.
export function whoDecided(decision: WireDecision, shop: WebShop): Who {
  const link = decision.decidedBy === "owner-link";
  if (isUnknown(decision.role)) return { kind: "someone" };
  if (decision.decidedBy === shop.you || (decision.role === "owner" && shop.role === "owner")) return { kind: "you", link };
  if (decision.role === "owner") return { kind: "owner", name: shop.ownerName, link };
  return { kind: "helper" };
}

/// Whether an outcome means the request is over, so the shop is read again and the ask leaves Needs you.
export function isOver(outcome: Outcome): boolean {
  return ["decided", "already", "changed", "superseded", "expired", "gone", "left"].includes(outcome.kind);
}
