// The Team page's status for each member, decided from what the store already holds: the member as the runtime lists
// it, its main chat, and the asks waiting on the person. The words are the design canvas's (StatesFaces.dc.html):
// Needs you, Working, Could not finish and Idle, plus Not connected for a member the runtime cannot reach.
import type { Bot } from "../lib/protocol";
import { chatTarget, type Ask, type Chat } from "../state/store";

export type MemberStatus = "paused" | "needs" | "offline" | "working" | "stuck" | "idle";

/** Paused wins over everything, as on the canvas's pause board: a member Pause everyone holds does nothing, even when an ask
 *  of theirs waits (it keeps waiting, and Needs you still lists it). Then Needs you, because it is the one status that waits
 *  on the person. A member who cannot be reached is not working, whatever its last turn says. A turn the person stopped is
 *  not a failure to finish. */
export function memberStatus(bot: Pick<Bot, "status" | "running" | "paused">, chat: Pick<Chat, "turn" | "lastTurn"> | undefined, asks: number): MemberStatus {
  if (bot.paused) return "paused";
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

/** What a member's menu on the Team page can do, in the order it lists them. These are the actions the sidebar's member rows
 *  had before the side menu replaced them: a new thread with the member, pinning them to the top of the list, and restarting
 *  the agent that serves them (Start for one that is not running). */
export type MemberAction = "new" | "pin" | "unpin" | "restart" | "start";

/** The actions a member's menu offers. A new thread needs a member the runtime can reach, and not one that runs on another
 *  computer (the thread would start there). A restart is offered only where the runtime can restart an agent (`canRestart`,
 *  the runtime's own `restart` capability), as the app offers nothing a runtime cannot do; for a member that is not running it
 *  reads Start. Pinning works everywhere: it is only the order of this list, kept on this computer. */
export function memberActions(m: { pinned: boolean; offline: boolean; remote: boolean; canRestart: boolean }): MemberAction[] {
  return [
    ...(!m.offline && !m.remote ? (["new"] as const) : []),
    m.pinned ? "unpin" : "pin",
    ...(m.canRestart ? [m.offline ? ("start" as const) : ("restart" as const)] : []),
  ];
}

/** One entry of a member's menu: the action and what it does. A new thread is asked of the runtime, so it answers when it
 *  has an answer; the others return at once. */
export interface MemberMenuItem {
  action: MemberAction;
  run: () => void | Promise<unknown>;
}

/** Runs a store action that reports a failed request only through the store's `lastError` (a new thread the runtime does not
 *  start, as the connected one does not yet), and says how it went: null when it went through, otherwise the runtime's own
 *  words. An error left from something earlier is cleared first, so it is never read as this action's. Home's ask box does
 *  the same for its new thread. */
export async function tryAction(
  store: { getState(): { lastError: string | null }; dispatch(a: { type: "error"; message: string | null }): void },
  run: () => unknown,
): Promise<string | null> {
  store.dispatch({ type: "error", message: null });
  await run();
  return store.getState().lastError || null;
}
