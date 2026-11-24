// Practice's two sample shops (docs/several-shops.md), so the switcher in the account row and the one Needs you across
// the shops can be seen and tried without an API: the person's own shop, which is the demo team's, and Ran Pa Noi, a
// sample shop they help at, owned by Noi. Their requests arrive when the person types /shops in a chat, as the other demo
// asks do (/approve), so a fresh start in Practice waits on nothing.
//
// What each request offers follows the person's role at its shop, as approval-core's `mayDecide` says on the connected
// runtime: at their own shop they decide everything; at Ran Pa Noi they decide messages and replies, and pass money on to
// Noi with a note. Viewing Ran Pa Noi shows what a helper's shop shows on the connected runtime: Buddy alone, with the
// requests and nothing else. Nothing here is real, and nothing leaves the app.
import { mayDecide, type ApprovalKind } from "@manut/approval-core";
import type { ApprovalChoice, AskShop, EventOf, PassedOnNote, ShopRow } from "../../lib/protocol";

export const OWN_SHOP = "practice:own-shop";
export const HELPED_SHOP = "practice:ran-pa-noi";

/** The person's own shop, listed with no name: the app names an owned shop that comes unnamed as the first-run setup
 *  named the person's shop on this computer (store.ts `shopName`), and the setup may name it at any moment. */
function ownShop(): ShopRow {
  return { id: OWN_SHOP, name: "", owner: "", role: "owner" };
}

const HELPED: ShopRow = { id: HELPED_SHOP, name: "Ran Pa Noi", owner: "Noi", role: "helper" };

/** The two sample shops, the person's own first, as `shops.list` lists them. */
export function sampleShops(): ShopRow[] {
  return [ownShop(), { ...HELPED }];
}

/** What Buddy says when the person views Ran Pa Noi, in place of the demo team's chat. */
export const HELPED_INTRO =
  "This is Ran Pa Noi, a sample shop you help at in Practice. Noi owns it. You can approve its messages and replies; money waits for Noi, and you can pass it on with a note. Nothing here is real, and its team is not here.";

/** What a write says while the person views Ran Pa Noi. */
export const HELPED_REFUSAL = "Ran Pa Noi is a sample shop in Practice, and its team is not here. Switch back to your own shop to try the team.";

/** What Buddy says after /shops. */
export const SHOPS_SAID = "Requests from both of your shops are waiting in Needs you. Each one says which shop it is for.";

interface SampleAsk {
  id: string;
  shop: "own" | "helped";
  kind: ApprovalKind;
  command: string;
  /** seconds before /shops that it was asked */
  ago: number;
  passedOn?: Omit<PassedOnNote, "at"> & { ago: number };
}

const SAMPLE_ASKS: readonly SampleAsk[] = [
  {
    id: "shop-ask-refund-350",
    shop: "own",
    kind: "money",
    command: "Refund ฿350 for order SP-2291 from your Shopee wallet",
    ago: 40 * 60,
    passedOn: { name: "Mint", note: "The customer sent a photo of the broken jar. It looks right to me.", ago: 25 * 60 },
  },
  { id: "shop-ask-reply-ploy", shop: "helped", kind: "reply", command: "Send on LINE: “We open at nine tomorrow, Khun Ploy.”", ago: 15 * 60 },
  { id: "shop-ask-refund-120", shop: "helped", kind: "money", command: "Refund ฿120 for order RP-118", ago: 5 * 60 },
];

/** One sample request while it waits: its ask as the protocol sends it, and the note passed on with it, if any. */
export interface WaitingAsk {
  ev: EventOf<"approval.request">;
  kind: ApprovalKind;
  shop: ShopRow;
}

/** The ask a sample request is, for the person's role at its shop. */
export function askEvent(bot: string, shop: ShopRow, kind: ApprovalKind, id: string, command: string, asked: number, passed: PassedOnNote | null): EventOf<"approval.request"> {
  const decides = mayDecide(shop.role, kind);
  const named: AskShop = { id: shop.id, name: shop.name, owner: shop.owner, role: shop.role };
  return {
    event: "approval.request",
    bot,
    request_id: id,
    title: "",
    command,
    choices: decides ? (["once", "deny"] as ApprovalChoice[]) : [],
    kind,
    shop: named,
    asked_at: asked,
    ...(!decides && shop.role === "helper" && !passed ? { pass_on: true } : {}),
    ...(passed ? { passed_on: passed } : {}),
  };
}

/** The sample requests as /shops asks them at `now` (seconds), in Buddy's chat `bot`. */
export function sampleAsks(bot: string, now: number): WaitingAsk[] {
  const shops = { own: ownShop(), helped: { ...HELPED } };
  return SAMPLE_ASKS.map((a) => {
    const shop = shops[a.shop];
    const passed = a.passedOn ? { name: a.passedOn.name, note: a.passedOn.note, at: now - a.passedOn.ago } : null;
    return { ev: askEvent(bot, shop, a.kind, a.id, a.command, now - a.ago, passed), kind: a.kind, shop };
  });
}
