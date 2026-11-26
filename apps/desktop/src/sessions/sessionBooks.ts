// What the sessions store reads back from this computer's localStorage at start (recent folders, sent files, session names, how each agent was last opened). Split out of sessions.ts (item 125c).
import { OPEN_KEY, parseOpens, parseRecent, RECENT_KEY, type AgentId, type SessionRec } from "./agents";
import { parseTitles, TITLES_KEY } from "./titles";
import { parseSentFiles, SENT_FILES_KEY, type SentFilesBook } from "./attach";

export const readRecent = () => {
  try {
    return parseRecent(typeof localStorage !== "undefined" ? localStorage.getItem(RECENT_KEY) : null);
  } catch {
    return [];
  }
};

/** The names the person gave sessions, kept on this computer by the agent's own conversation id. */
/** Files sent in session chats (saved paths), so their bubbles show them again after a restart. */
export const readSentFiles = (): SentFilesBook => {
  try {
    return parseSentFiles(typeof localStorage !== "undefined" ? localStorage.getItem(SENT_FILES_KEY) : null);
  } catch {
    return {};
  }
};

export const readTitles = () => {
  try {
    return parseTitles(typeof localStorage !== "undefined" ? localStorage.getItem(TITLES_KEY) : null);
  } catch {
    return {};
  }
};
export const titleKey = (r: SessionRec) => (r.agentSession ? `${r.agent}:${r.agentSession}` : null);

/** Agents whose own session files carry a conversation title the bridge can read (`cli.title`). */
export const TITLED: readonly AgentId[] = ["claude", "codex"];

export const readOpens = () => {
  try {
    return parseOpens(typeof localStorage !== "undefined" ? localStorage.getItem(OPEN_KEY) : null);
  } catch {
    return {};
  }
};
