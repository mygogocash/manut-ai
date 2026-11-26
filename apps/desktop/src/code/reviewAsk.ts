// The asks that put a lane up for review and merge its pull request (item 75), on the page's side. The shell writes down the
// exact plan and answers it as an ask (src-tauri/src/review.rs); this file opens that ask as an approval-core request and settles
// it there, once, through approval-core's own rules (`packages/approval-core`: a request leaves waiting once, only an option it
// offered can be chosen, an id is never reused). Only a request approval-core settled reaches the shell's `review_settle`, which
// runs a Yes once more, by the ask's id alone, and only once. There is no other way from the page to a push, a pull request or
// a merge: the host has no call that takes an argv, a branch or a text to write.
//
// The request's kind is `public_post`: a pull request and a merge are seen by everyone who can see the repository, and
// approval-core lets only the owner decide that kind. On this Mac the person is the owner of their own repositories' asks.
import { InMemoryApprovalStore, type ApprovalOption } from "@manut/approval-core";
import type { SessionHost } from "../sessions/host";
import type { RepoAsk, ReviewAsk, ReviewDone } from "./source";

/** What every ask offers: yes, this once, or no. approval-core has no standing yes, so neither does the ask. */
export const REVIEW_OPTIONS: readonly ApprovalOption[] = [
  { id: "yes", label: "yes", effect: "approve" },
  { id: "no", label: "no", effect: "decline" },
];

/** Who decides on this Mac, as approval-core records it. */
export const DECIDED_BY = "this-mac";

let store = new InMemoryApprovalStore();

/** Tests: start from no asks. */
export function resetReviewAsks(): void {
  store = new InMemoryApprovalStore();
}

/** Opens the shell's ask as an approval-core request, its detail the ask as the shell wrote it. Throws when approval-core refuses
 *  it (an id already used, which the shell never sends). */
export async function openReviewAsk(ask: ReviewAsk | RepoAsk): Promise<void> {
  const opened = await store.open({ id: ask.id, kind: "public_post", options: REVIEW_OPTIONS, detail: ask });
  if (!opened.ok) throw new Error(opened.refused);
}

/** What answering an ask did: the shell's outcome, or why nothing ran (approval-core's refusal, `already_decided`, `not_found`,
 *  `changed`..., or the shell's, `expired`, `withdrawn`...). */
export type ReviewAnswer = { ok: true; done: ReviewDone } | { ok: false; refused: string };

/** The person's Yes or No to ask `id`. approval-core settles the request first; a refusal there stops here and the shell hears
 *  nothing. A settled request goes to the shell with the answer that settled it. */
export async function answerReviewAsk(host: Pick<SessionHost, "reviewSettle">, id: string, yes: boolean): Promise<ReviewAnswer> {
  const decided = await store.decide({ requestId: id, optionId: yes ? "yes" : "no", seenRevision: 1, decidedBy: DECIDED_BY, role: "owner" }, { running: {} });
  if (!decided.ok) return { ok: false, refused: decided.refused };
  if (!host.reviewSettle) return { ok: false, refused: "no_shell" };
  try {
    return { ok: true, done: await host.reviewSettle(id, yes) };
  } catch (e) {
    return { ok: false, refused: e instanceof Error ? e.message : String(e) };
  }
}

/** Takes a waiting ask back on both sides (the person closed it or changed what it asks), so a later answer runs nothing. */
export async function withdrawReviewAsk(host: Pick<SessionHost, "reviewWithdraw">, id: string): Promise<void> {
  await store.withdraw(id);
  await host.reviewWithdraw?.(id).catch(() => undefined);
}

/** Where the request stands in approval-core (tests, and a surface that wants to know before it draws buttons). */
export async function reviewAskRecord(id: string) {
  return store.get(id);
}
