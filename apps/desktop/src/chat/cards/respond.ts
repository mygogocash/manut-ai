// How an ask is answered from a button, kept in one place so that every button that settles an approval goes the same
// way: the chat's ask card (Cards.slot.tsx) and Home's Approve (src/pages/HomePage.tsx) both call settleApproval, which
// is the store's own respondApproval, and the runtime settles each approval once. There is no second way round.
import type { Key } from "../../i18n";
import { t } from "../../i18n";
import type { ApprovalChoice } from "../../lib/protocol";
import type { ApprovalItem, AppState, Store } from "../../state/store";

/** The words of a settled approval's line, by the choice that settled it. */
export const ALLOW_LABEL: Record<ApprovalChoice, Key> = {
  once: "card.allowedOnce",
  session: "card.allowedSession",
  always: "card.allowedAlways",
  deny: "card.denied",
};

/** Runs a respond action. The store marks a card answered only after the runtime said ok, so a card that is still
 *  open afterwards was not answered; then this returns the store's error text, or a plain fallback when the store
 *  has none. A card that is gone has nothing left to answer. */
export async function respond(store: { getState(): Pick<AppState, "chats" | "lastError"> }, bot: string, id: string, run: () => Promise<void>): Promise<string | null> {
  await run();
  const st = store.getState();
  const it = st.chats[bot]?.items.find((i) => i.id === id);
  const done = it?.kind === "approval" ? !!it.resolved : it?.kind === "clarify" ? it.answer !== undefined : true;
  return done ? null : st.lastError || t("card.notTaken");
}

/** Settles approval `item` of chat `bot` with `choice` through the store's respondApproval, exactly as each of the
 *  card's buttons does. Null once the runtime took it, otherwise why not. */
export function settleApproval(
  store: Pick<Store, "getState" | "actions">,
  bot: string,
  item: Pick<ApprovalItem, "id" | "request_id">,
  choice: ApprovalChoice,
): Promise<string | null> {
  return respond(store, bot, item.id, () => store.actions.respondApproval(item.request_id, choice, bot));
}
