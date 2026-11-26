// Settings › General › Suggested next message (item 76). After a turn ends in a chat with a coding agent, the empty box may show one
// predicted next message, greyed: Tab takes it, typing replaces it, and nothing is ever sent by itself.
//
// It is OFF unless the person turns it on, because each suggestion is an extra request on their own plan after every turn (Claude Code
// makes it with a request of its own, which never enters the conversation). The words of the setting say so.
//
// How it is asked for, and for whom (verified with `claude --help` and the Claude Code package, 25 Nov 2026):
//  - Claude Code: `claude -p --prompt-suggestions true` makes print/SDK mode send a `prompt_suggestion` message after each turn. The
//    shell starts a chat with that flag when this is on (src-tauri/src/sessions.rs `CLAUDE_SUGGEST_ARGS`) and turns the message into a
//    `suggestion` event. It is chosen when a chat starts, so a chat already running keeps its way until it is started again.
//  - Codex: its app-server protocol (`codex app-server generate-json-schema`, 0.169.0) has no such request, so there is none to make.
//  - Every other agent: none is known to offer one. A side question sent to the agent would land in the chat's own history, which is
//    not acceptable, so none is made.
import { useSyncExternalStore } from "react";
import { changes } from "./changes";

export const SUGGEST_KEY = "manut.suggest";

/** The agents that have an honest way to be asked for a suggestion. */
export const SUGGEST_AGENTS: readonly string[] = ["claude"];

/** Whether a chat with `agent` can show suggestions (it has a way to be asked, whatever the setting). */
export const suggestWorks = (agent: string): boolean => SUGGEST_AGENTS.includes(agent);

function read(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SUGGEST_KEY) === "on";
  } catch {
    return false;
  }
}

let on = read();
const listeners = changes();

/** Whether the person turned suggestions on. Off by default and for anything but the exact saved word. */
export const suggestOn = (): boolean => on;

export function setSuggestOn(next: boolean): void {
  if (next === on) return;
  on = next;
  try {
    if (next) localStorage.setItem(SUGGEST_KEY, "on");
    else localStorage.removeItem(SUGGEST_KEY);
  } catch {
    /* no storage: it holds for this run */
  }
  listeners.emit();
}

/** Tests: read the setting again from storage. */
export function reloadSuggest(): void {
  on = read();
  listeners.emit();
}

const subscribe = (l: () => void) => {
  return listeners.subscribe(l);
};
export const useSuggestOn = (): boolean => useSyncExternalStore(subscribe, suggestOn, suggestOn);
