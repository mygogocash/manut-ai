// Stateless pieces of the sessions store: the Accounts CLI of an agent, the terminal timings, which terminal agents come back after a restart, and the new conversation id. Split out of sessions.ts (item 125c), which re-exports what it exported before.
import { type AgentId } from "./agents";
import type { AccountCli, AccountGroup } from "../lib/protocol";
import { type SavedSession } from "../app/resume";

/** The Accounts CLI a session of `agent` signs in as (mirrors `session_cli` in src-tauri/src/accounts.rs). */
export const ACCOUNT_CLI: Partial<Record<AgentId, AccountCli>> = { claude: "claude", codex: "codex", grok: "grok" };

/** The account a new session of `agent` runs as, from the Accounts list when it is loaded (none = unknown or the
 *  agent has no accounts; the shell then uses the one picked for new sessions). */
export function accountFor(groups: AccountGroup[] | null, agent: AgentId): string | undefined {
  const cli = ACCOUNT_CLI[agent];
  const g = cli ? groups?.find((x) => x.cli === cli) : undefined;
  return g ? (g.active ?? "default") : undefined;
}

/** How much of the end of a CLI's output is kept while it may still be refusing its conversation. */
export const SAID_MAX = 2_048;

/** The row's last-output time is written at most this often (a flood would otherwise re-render the sidebar). */
export const OUT_MARK_MS = 500;

/** A terminal's new size goes to its program once it has stopped changing for this long. Dragging a window gives
 *  one size per frame (16.7 ms at 60 Hz), so a wait of one frame or less collapses nothing; two frames does, and
 *  the program redraws once for the size the drag ended on instead of once per frame. */
export const RESIZE_SETTLE_MS = 32;

export const utf8 = new TextEncoder();

/** A random (version 4) UUID: the id manut gives a new Claude Code conversation in a terminal (`--session-id`). */
export function newConversationId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** TERMINALS agents that continue their own conversation after manut restarts (`claude --resume`, `codex resume`). */
export const TERM_CONTINUES: readonly AgentId[] = ["claude", "codex"];
/** TERMINALS agents that reopen their own dropped session after manut restarts with no id from manut: oh-my-hermes
 *  (`omh`) is told its row's link (`MANUT_TERMINAL_LINK`, rule 11) and reopens the session it dropped under that
 *  terminal by itself (OMH's auto-resume), so it needs no conversation id. */
export const TERM_REOPENS: readonly AgentId[] = ["omh"];
/** Whether a TERMINALS session that was running when manut closed starts again by itself after the restart. */
export const termComesBack = (s: Pick<SavedSession, "agent" | "agentSession">): boolean =>
  TERM_REOPENS.includes(s.agent) || (!!s.agentSession && TERM_CONTINUES.includes(s.agent));
/** When a TERMINALS Codex session first asks for its conversation id, and how often after that until it has one. */
export const CODEX_ID_FIRST_MS = 5_000;
export const CODEX_ID_EVERY_MS = 15_000;
