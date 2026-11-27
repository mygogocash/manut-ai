// The reach cards' asks (item 102k; `docs/several-agents.md`, rule R10): one approval of the asking chat per card, opened in
// `packages/approval-core` and settled there once, by approval-core's own rules (a request leaves waiting once, only an option it
// offered can be chosen, a request asked in a turn that has ended is superseded). As `helperAsks.ts` does for the Start helpers card,
// this file is the only place a reach card's request is opened, decided or withdrawn; nothing an agent writes reaches it, because the
// parser (`reachBlocks.ts`) has no verb that answers anything.
//
// The request's kind is `command`: reading a chat into an agent, putting words into another chat and starting an agent on this Mac
// change what runs here and spend the person's own plans, which only the owner decides (approval-core's `mayDecide`). On this Mac
// the person is the owner of their own chats.
//
// Buddy's cards on the Connected runtime (item 102l-3, `buddyReach.ts`) are opened, decided and withdrawn here too, in the same store
// and by the same rules, as `command` requests decided by the owner: each press posts one message to the API's chat, which changes
// the shop's own conversations and is billed to its monthly limit, and only the shop's owner chats there (102l-2), so only the owner
// may decide one. There is no second way round: this is the one place either kind of card settles.
import { InMemoryApprovalStore, type ApprovalOption, type DecideResult, type Running } from "@manut/approval-core";
import type { Scope } from "../chat/box/carry";
import type { ThreadRef } from "../chat/box/threadContext";
import type { HelperRow } from "./helperAsks";
import type { ReachKind } from "./reachBlocks";

/** What each card offers: its one yes, and its no. approval-core has no standing yes, so neither does a card. */
export const REACH_OPTIONS: Record<ReachKind, readonly ApprovalOption[]> = {
  read: [
    { id: "read", label: "let kit read", effect: "approve" },
    { id: "no", label: "no", effect: "decline" },
  ],
  send: [
    { id: "send", label: "send there", effect: "approve" },
    { id: "keep", label: "keep here", effect: "decline" },
  ],
  open: [
    { id: "start", label: "start lane", effect: "approve" },
    { id: "notNow", label: "not now", effect: "decline" },
  ],
};

/** Who decides on this Mac, as approval-core records it. */
export const DECIDED_BY = "this-mac";

/** The chat a read or send card names, as the list and the reader had it when the card opened. */
export interface ReachTarget {
  /** its number on the asking chat's list */
  readonly n: number;
  readonly ref: ThreadRef;
  readonly key: string;
  readonly title: string;
  /** what it belonged to when the card opened: checked again at the press */
  readonly scope: Scope;
}

/** A card's request: exactly what the person is shown, kept as approval-core's `detail`. */
export type ReachAsk = {
  readonly id: string;
  /** the asking chat's session */
  readonly asker: string;
  /** the turn whose answer asked */
  readonly turn: string;
} & (
  | {
      readonly kind: "read";
      readonly target: ReachTarget;
      /** item 97's text of that chat, built with no model when the card opened: exactly what Let Kit read sends */
      readonly text: string;
    }
  | {
      readonly kind: "send";
      readonly target: ReachTarget;
      /** the agent's words, whole: exactly what Send there puts in that chat, under the line that says where they came from */
      readonly message: string;
    }
  | {
      readonly kind: "open";
      /** the lane as the card shows it: item 102e's row, with what the app made of its agent, model and effort */
      readonly lane: HelperRow;
      /** the developer's folder the lane is made from */
      readonly cwd: string;
    }
);

/** What each of Buddy's cards offers on Connected (item 102l-3): the same one yes and one no, in Buddy's words. */
export const BUDDY_OPTIONS: Record<ReachKind, readonly ApprovalOption[]> = {
  read: [
    { id: "read", label: "let buddy read", effect: "approve" },
    { id: "no", label: "no", effect: "decline" },
  ],
  send: [
    { id: "send", label: "send there", effect: "approve" },
    { id: "keep", label: "keep here", effect: "decline" },
  ],
  open: [
    { id: "start", label: "start conversation", effect: "approve" },
    { id: "notNow", label: "not now", effect: "decline" },
  ],
};

/** Who decides one of Buddy's cards, as approval-core records it: the shop's owner, on this computer. */
export const BUDDY_DECIDED_BY = "shop-owner";

/** One of Buddy's cards on Connected (item 102l-3): what Buddy asked of another of the shop's conversations, exactly as the person is
 *  shown it, kept as approval-core's `detail`. `buddy` tells it from a coding chat's card. */
export type BuddyAsk = {
  readonly id: string;
  readonly buddy: true;
  /** the asking chat's key: Buddy's main chat, or a conversation's `fold:` key */
  readonly asker: string;
  /** the shop the asking chat was of when the card opened: a press under any other is refused */
  readonly shop: string;
  /** the turn whose answer asked */
  readonly turn: string;
} & (
  | {
      readonly kind: "read";
      readonly target: ReachTarget;
      /** item 97's text of that conversation, built with no model when the card opened: exactly what Let Buddy read posts */
      readonly text: string;
    }
  | {
      readonly kind: "send";
      readonly target: ReachTarget;
      /** Buddy's words, whole and masked as the card shows them: exactly what Send there posts, with the line saying where from */
      readonly message: string;
    }
  | {
      readonly kind: "open";
      /** the new conversation's first message, whole and masked as the card shows it */
      readonly brief: string;
      /** what the API will name it: the brief's first words */
      readonly title: string;
    }
);

/** Whether a card is one of Buddy's on Connected. */
export const isBuddyAsk = (ask: ReachAsk | BuddyAsk): ask is BuddyAsk => "buddy" in ask && ask.buddy === true;

let store = new InMemoryApprovalStore();

/** Tests: start from no asks. */
export function resetReachAsks(): void {
  store = new InMemoryApprovalStore();
}

const optionsOf = (ask: ReachAsk | BuddyAsk) => (isBuddyAsk(ask) ? BUDDY_OPTIONS : REACH_OPTIONS)[ask.kind];

/** Opens a card's request in approval-core, stamped with the turn whose answer asked: once another turn of the asking chat runs, a
 *  decision on it is refused as superseded. Throws when approval-core refuses it (an id already used). */
export async function openReachAsk(ask: ReachAsk | BuddyAsk): Promise<void> {
  const opened = await store.open({ id: ask.id, kind: "command", options: optionsOf(ask), turnId: ask.turn, detail: ask });
  if (!opened.ok) throw new Error(opened.refused);
}

/** The person's yes or no on card `id`. `running` is the asking chat's turn now, read from the chat itself, never from the card.
 *  Only an `ok` result settled the request; a refusal left it as it was. `buddy`: one of Buddy's cards on Connected, decided by the
 *  shop's owner (its caller has checked the person owns the shop). */
export function answerReachAsk(id: string, kind: ReachKind, yes: boolean, running: Running, buddy = false): Promise<DecideResult> {
  const [approve, decline] = (buddy ? BUDDY_OPTIONS : REACH_OPTIONS)[kind];
  return store.decide({ requestId: id, optionId: yes ? approve.id : decline.id, seenRevision: 1, decidedBy: buddy ? BUDDY_DECIDED_BY : DECIDED_BY, role: "owner" }, { running });
}

/** Takes a waiting request back (the person wrote to the chat again, or emptied its list), so a later press settles nothing. */
export async function withdrawReachAsk(id: string): Promise<void> {
  await store.withdraw(id);
}

/** Where the request stands in approval-core (tests). */
export const reachAskRecord = (id: string) => store.get(id);
