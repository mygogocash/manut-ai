// What each coding agent last listed on this computer (its models and effort levels), kept so the Ask several panel can offer
// them before any lane of that agent is running (item 102a). The sessions store writes here as an agent's chat reports its lists
// (`session.models`, `session.efforts`); nothing is asked of an agent to fill it, and a list is never ours: an agent that has
// not listed any is offered only as its own default. Kept in the browser's storage as the app's other per-computer lists are.
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";
import type { AgentId } from "../sessions/agents";
import { CHOICES_KEY, parseChoices, withChoices, type AgentChoice, type AgentChoices } from "./ask";

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

let all: AgentChoices | null = null;
const listeners = changes();

/** The saved lists, read once. */
export function readChoices(): AgentChoices {
  if (all === null) {
    try {
      all = parseChoices(storage()?.getItem(CHOICES_KEY));
    } catch {
      all = {};
    }
  }
  return all;
}

/** Keep what `agent` listed. A list that did not change tells nobody. */
export function noteChoices(agent: AgentId, part: Partial<AgentChoice>): void {
  const before = readChoices();
  const next = withChoices(before, agent, part);
  if (JSON.stringify(next[agent]) === JSON.stringify(before[agent])) return;
  all = next;
  try {
    storage()?.setItem(CHOICES_KEY, JSON.stringify(next));
  } catch {
    /* no storage: the lists last for this run */
  }
  listeners.emitSnapshot();
}

/** A test starts from what its storage holds. */
export function resetChoices(): void {
  all = null;
  listeners.emitSnapshot();
}

export const useAgentChoices = (): AgentChoices => useSyncExternalStore(listeners.subscribe, readChoices, readChoices);
