// Let Kit merge: the ask goes to Kit as a message to the project's own lane, never as a new kind of approval. Every step
// Kit then takes arrives as an ask card of its own (a `git merge` is a command that changes the project, a push is a push)
// and is answered through the card's one path, `settleApproval`, at the level the developer chose (`kitDecide`). Nothing
// here runs git or answers a card.
//
// The lane is a coding session of the project that runs as a chat in the app: only those have asks that arrive as cards (a
// session in its own terminal keeps its agent's prompts in the terminal; docs/code-editor.md). With none running, a new
// session opens in the project with the ask written in its box, and the person presses Start: no agent starts by itself,
// and an open draft's own words stay (the ask goes after them).
import { getDraft, setDraft as setUnsent } from "../app/drafts";
import { isGone, type SessionRec } from "../sessions/agents";
import { pathKey } from "../sessions/folders";
import type { SessionsState } from "../sessions/sessions";

/** The part of the sessions store this uses, so a test can stand in for it. */
export interface Lanes {
  getState(): SessionsState;
  /** The app-store chat key of session `id`'s chat, null when it has none (a terminal). */
  chatKey(id: string | null): string | null;
  send(id: string, text: string): Promise<unknown>;
  draft(agent?: SessionRec["agent"]): string;
  setDraft(id: string, p: { agent?: SessionRec["agent"]; cwd?: string }): void;
}

/** What happened to the ask: sent to the project's running lane, or written into a new session's box. */
export type Asked = { how: "sent"; session: string } | { how: "drafted"; session: string };

/** The newest session of project `root` that runs as a chat, if any: Kit's lane. */
export function laneOf(s: Pick<Lanes, "getState" | "chatKey">, root: string): string | null {
  const here = pathKey(root);
  return s.getState().list.find((r) => r.status === "running" && pathKey(r.cwd) === here && s.chatKey(r.id) !== null)?.id ?? null;
}

/** Send `text` to Kit in project `root`. */
export async function askKit(s: Lanes, root: string, text: string): Promise<Asked> {
  const lane = laneOf(s, root);
  if (lane) {
    await s.send(lane, text);
    return { how: "sent", session: lane };
  }
  // the agent that last worked in this folder, if the app still offers it; else the usual one
  const was = s.getState().recent.find((r) => pathKey(r.cwd) === pathKey(root))?.agent;
  const id = s.draft(was && !isGone(was) ? was : undefined);
  s.setDraft(id, { cwd: root });
  const key = `agent:${id}`;
  const own = getDraft(key).trimEnd();
  setUnsent(key, own ? `${own}\n\n${text}` : text);
  return { how: "drafted", session: id };
}
