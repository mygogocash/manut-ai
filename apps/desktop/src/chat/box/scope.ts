// What a chat belongs to, for the chips the box carries (carry.ts `Scope`, item 97). A team chat and its threads belong to the shop
// every page shows: the store drops their chats and threads when another shop is shown (state/store.ts, `shop.switched`), but a
// chip is kept by chat key, and a member's key ("buddy") is the same in every shop, so the chip names its shop. A coding chat
// belongs to no shop, and runs as one account of its agent (Settings › Providers › Accounts): its chips name that account.
import type { AccountGroup } from "../../lib/protocol";
import { ACCOUNT_CLI, accountFor } from "../../sessions/sessions";
import type { SessionRec } from "../../sessions/agents";
import type { Scope } from "./carry";

/** Whether `key` is a coding chat's (a SESSIONS chat, `agent:<id>`). */
export const isCodingKey = (key: string): boolean => key.startsWith("agent:");

/** The scope of the chat whose key is `key`. `shop`: the shop every page shows (none: the runtime lists no shops). `rec`: the
 *  coding chat's session, when `key` is one; a draft runs as the account picked for new sessions now (`groups`), a started one as
 *  the account it was started with, and one whose account is not known names none, so it is compared with nothing. */
export function chatScope(key: string, shop: string | null, rec: Pick<SessionRec, "agent" | "account" | "status"> | null, groups: AccountGroup[] | null): Scope {
  if (!isCodingKey(key)) return { shop: shop ?? "" };
  if (!rec) return {};
  const cli = ACCOUNT_CLI[rec.agent];
  if (!cli) return {};
  const account = rec.account ?? (rec.status === "draft" ? accountFor(groups, rec.agent) : undefined);
  return account ? { account: `${cli}:${account}` } : {};
}
