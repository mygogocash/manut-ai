// The conversations History lists for the folders brought over (item 101e): the newest of each agent across all of them, read by
// the shell from the agents' own files (past_chats.rs `recent`, read-only). Each opens and continues as the + menu's past
// conversations do (sessions.ts `continuePast`). The last answer is kept for this run of the app, so History shows it at once
// when it opens again while the shell reads afresh.
import { useEffect, useState } from "react";
import { useFolderPrefs } from "../sessions/folders";
import { getHost, type PastChat, type SessionHost } from "../sessions/host";
import { historyFolders, useImportRecord } from "./offer";

/** Conversations History lists of each agent at most. */
export const HISTORY_PER_AGENT = 30;

const AGENTS = ["claude", "codex"] as const;

export interface BroughtOver {
  /** newest first */
  chats: PastChat[];
  /** an agent has more than History lists */
  more: boolean;
}

const NONE: BroughtOver = { chats: [], more: false };
let kept: { key: string; got: BroughtOver } | null = null;

/** The shell's answers for each agent, one more than listed asked so `more` is known: History's rows. A failed read leaves that
 *  agent's rows out. */
export async function readBroughtOver(host: Pick<SessionHost, "pastRecent">, folders: readonly string[]): Promise<BroughtOver> {
  if (!folders.length || !host.pastRecent) return NONE;
  const lists = await Promise.all(AGENTS.map((a) => host.pastRecent!(a, [...folders], HISTORY_PER_AGENT + 1).catch(() => [] as PastChat[])));
  const chats = lists.flatMap((l) => l.slice(0, HISTORY_PER_AGENT)).sort((a, b) => b.at - a.at);
  return { chats, more: lists.some((l) => l.length > HISTORY_PER_AGENT) };
}

export function useBroughtOver(host: Pick<SessionHost, "pastRecent"> = getHost()): BroughtOver {
  const rec = useImportRecord();
  const prefs = useFolderPrefs();
  const folders = historyFolders(rec, prefs);
  const key = folders.join("\n");
  const [got, setGot] = useState<BroughtOver>(() => (kept && kept.key === key ? kept.got : NONE));
  useEffect(() => {
    let live = true;
    if (!key) {
      setGot(NONE);
      return;
    }
    void readBroughtOver(host, key.split("\n")).then((g) => {
      kept = { key, got: g };
      if (live) setGot(g);
    });
    return () => {
      live = false;
    };
  }, [key, host]);
  return key ? got : NONE;
}
