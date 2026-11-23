// The Team page's status for each member, decided from what the store already holds: the member as the runtime lists
// it, its main chat, and the asks waiting on the person. The words are the design canvas's (StatesFaces.dc.html):
// Needs you, Working, Could not finish and Idle, plus Not connected for a member the runtime cannot reach.
import type { Bot } from "../lib/protocol";
import { chatTarget, type Ask, type Chat } from "../state/store";

export type MemberStatus = "needs" | "offline" | "working" | "stuck" | "idle";

/** Needs you wins over everything, because it is the one status that waits on the person. A member who cannot be
 *  reached is not working, whatever its last turn says. A turn the person stopped is not a failure to finish. */
export function memberStatus(bot: Pick<Bot, "status" | "running">, chat: Pick<Chat, "turn" | "lastTurn"> | undefined, asks: number): MemberStatus {
  if (asks > 0) return "needs";
  if (bot.status === "offline") return "offline";
  if (bot.running || chat?.turn) return "working";
  if (chat?.lastTurn?.outcome === "error") return "stuck";
  return "idle";
}

/** The asks of one member: those in its main chat and in its threads and folder chats (`fold:<member>:<id>`). */
export function asksOf(asks: readonly Ask[], member: string): Ask[] {
  return asks.filter((a) => chatTarget(a.bot).bot === member);
}
