// Words about the person's shops that more than one place says: the notice above the account row, and the line an ask's
// card closes with, when the person's place in a shop ended (docs/several-shops.md). They follow the design canvas's
// People board ("You no longer have access to Baan Mali. Fon removed you on Sunday 22 November. Ask Fon if this is a
// mistake."). Pure, so tests read them without a page.
import type { ApprovalKind } from "@manut/approval-core";
import { longDay } from "../app/time";
import { t, type Key } from "../i18n";
import type { ApprovalItem } from "../state/store";
import type { ShopLeft } from "./protocol";

/** What the app says when the person's place in a shop ended: removed as its helper, or unlinked as its owner's account,
 *  each with when the API said it happened (`at`, seconds), or gone from their list with nothing said. */
export function leftWords(left: Pick<ShopLeft, "name" | "owner" | "why" | "at">): string {
  const date = left.at === null ? null : longDay(left.at * 1000);
  const shop = left.name || t("shops.aShop");
  if (left.why === "removed") {
    // A shop this app never named still says what happened, in the words a removed helper's card says it.
    if (!left.owner) return date ? t("rt.ask.removed", { date }) : t("rt.ask.removedNoDate");
    return date ? t("shops.left.removed", { shop, owner: left.owner, date }) : t("shops.left.removedNoDate", { shop, owner: left.owner });
  }
  if (left.why === "unlinked") return date ? t("shops.left.unlinked", { shop, date }) : t("shops.left.unlinkedNoDate", { shop });
  return t("shops.left.gone", { shop });
}

/** What only a shop's owner may decide, in the words a helper's card says it ("Only Noi can approve money"). */
const ONLY: Partial<Record<ApprovalKind, Key>> = {
  money: "rt.only.money",
  public_post: "rt.only.public_post",
  payment_confirmation: "rt.only.payment_confirmation",
  command: "rt.only.command",
};

/** Why the person may not decide a request of `kind` at a shop whose owner is `owner`, in words. */
export const onlyOwnerWords = (kind: string | undefined, owner: string): string => t(ONLY[kind as ApprovalKind] ?? "rt.only.other", { owner });

/** What an ask card of one of several shops says beyond its buttons: who may decide it when the person may not (a helper,
 *  and money, a public post, a payment or a command), and the note a helper passed on with it, as the canvas's People
 *  board words them: the owner sees "Passed on by Mint" and "Mint: <note>"; the helper who passed it sees "Passed on to
 *  Noi" and their note. Null parts for an ask with no shop, or nothing to say. */
export function shopAskLines(item: Pick<ApprovalItem, "shop" | "choices" | "outdated" | "passedOn" | "approvalKind">): {
  only: string | null;
  passed: { title: string; note: string } | null;
} {
  const shop = item.shop;
  if (!shop) return { only: null, passed: null };
  const only = item.choices.length === 0 && !item.outdated ? onlyOwnerWords(item.approvalKind, shop.owner) : null;
  const p = item.passedOn;
  if (!p) return { only, passed: null };
  if (shop.role === "helper") return { only, passed: { title: t("card.passedTo", { owner: shop.owner }), note: p.note } };
  return {
    only,
    passed: { title: p.name ? t("card.passedBy", { name: p.name }) : t("card.passedByHelper"), note: p.name ? t("card.passNoteBy", { name: p.name, note: p.note }) : p.note },
  };
}
