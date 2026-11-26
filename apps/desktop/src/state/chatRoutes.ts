// Where a chat that is not a bot's main chat sends the person's answers, and how its key reads. Split out of
// store.ts (item 125d). The routes are one Map for the whole app: this module holds it, and every reader imports
// it from here.
import type { ApprovalChoice, ClarifyAnswers } from "../lib/protocol";

// ---- chats that are not a bot's main chat ------------------------------------------------------
//
// SESSIONS chats reuse this reducer and the bot chat's timeline, cards and composer under their own key:
// `fold:<bot>:<id>` for a Hermes chat in a folder (bridge `folder.open`, events tagged `session`) and
// `agent:<id>` for a Claude Code / Codex / pi chat run by the desktop shell. A route says where the
// person's answers go.

export interface ChatRoute {
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  approve(requestId: string, choice: ApprovalChoice): Promise<void>;
  /** A text answer, or (Hermes folder chats) an interview's answers per question id. */
  clarify(requestId: string, answer: string | ClarifyAnswers): Promise<void>;
  /** Name for notifications. */
  label: string;
  /** Show this chat (a notification was clicked). */
  open(): void;
}

const chatRoutes = new Map<string, ChatRoute>();
/** Register (or with null, remove) where chat `key`'s answers go. */
export function setChatRoute(key: string, route: ChatRoute | null): void {
  if (route) chatRoutes.set(key, route);
  else chatRoutes.delete(key);
}
export const chatRoute = (key: string): ChatRoute | undefined => chatRoutes.get(key);
/** Key of a folder chat's events. */
export const folderKey = (bot: string, session: string) => `fold:${bot}:${session}`;
/** True for a SESSIONS chat key (not a bot's main chat). */
export const isSessionChat = (key: string) => key.startsWith("fold:") || key.startsWith("agent:");
/** Where a Hermes chat's words go on the bridge: a bot's main chat (`<bot>`) or its folder chat / thread
 *  (`fold:<bot>:<session>`, the bridge's `session=`). The steer queue sends, steers and stops through this. */
export function chatTarget(key: string): { bot: string; session?: string } {
  if (!key.startsWith("fold:")) return { bot: key };
  const rest = key.slice(5);
  const at = rest.indexOf(":");
  return { bot: rest.slice(0, at), session: rest.slice(at + 1) };
}
