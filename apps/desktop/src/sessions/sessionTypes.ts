// The shapes the sessions store keeps and shows: what a session list, a terminal and a chat process hold. Types only; split out of sessions.ts (item 125c), which re-exports the ones it exported before.
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { Remake } from "./term/engine";
import type { AgentInfo, Unseen, Opens, Recent, SessionRec } from "./agents";
import type { SessionHost } from "./host";
import type { AgentCommand } from "../chat/parts/commands";

export interface ModelOption {
  id: string;
  label: string;
  detail?: string;
  /** Hermes provider slug (oh-my-hermes sessions). */
  provider?: string;
}

export interface SessionsState {
  /** null until the first look-up */
  agents: AgentInfo[] | null;
  home: string | null;
  list: SessionRec[];
  recent: Recent[];
  /** How the person last opened each agent (Chat or Terminal), kept on this computer. */
  opens: Opens;
  /** models a chat session can switch to, by session id */
  models: Record<string, ModelOption[]>;
  /** last problem a chat reported that is not a turn's own error (model refused, …), by session id */
  notes: Record<string, string>;
  /** what each chat's agent reported about itself, by session id */
  live: Record<string, AgentLive>;
  /** what a session did while the person was not looking at it, by session id (gone once they open it) */
  unseen: Record<string, Unseen>;
}

/** What a chat's agent said about its controls (agent_chat.rs events). Nothing here is estimated. */
export interface AgentLive {
  /** the permission mode in force ("" = one manut does not offer, the agent's own) */
  mode?: string;
  /** what the agent itself reported it runs with: its approval policy and sandbox (Codex `never`,
   *  `dangerFullAccess`; Claude Code's permission mode), shown when it means no approvals or full disk access */
  approval?: string;
  sandbox?: string;
  /** the reasoning effort in force */
  effort?: string;
  /** the reasoning levels it takes; none = it has no effort control */
  efforts?: string[];
  /** its own commands and skills, for the `/` menu */
  commands?: AgentCommand[];
  /** context tokens in use and its window, as it counted them */
  usage?: { used: number; max: number };
  /** the git branch of its folder ("" = not a repository) */
  branch?: string;
  /** the agent can take back the person's last message (its own rewind; Claude Code and Codex) */
  rewind?: boolean;
  /** it ended because it is not signed in: the command that signs it in, run by the person in a terminal */
  signin?: string;
}

export interface Term {
  /** the terminal now: reading it makes a parked one again (term/park.ts) */
  readonly term: Terminal;
  /** the xterm it has, parked or not */
  raw: Terminal;
  fit: FitAddon;
  /** makes it again after it was parked */
  remake?: Remake;
  /** xterm renders into this element; it moves between session views instead of being re-created */
  el: HTMLDivElement;
  hostId: number | null;
  closed: boolean;
  /** Undoes what the engine attached after the terminal opened (its renderer, add-ons). */
  undo: () => void;
  /** The size the program was last told (when it started, then each resize sent). */
  told: { cols: number; rows: number } | null;
  /** xterm resized (and so reflowed or trimmed its screen) since the program was last told its size: set by every
   *  resize, cleared by `tellSize`. A size that came back to `told` still needs the program to redraw. */
  reflowed: boolean;
  /** A changed size waiting to be sent (`RESIZE_SETTLE_MS`). */
  settle: ReturnType<typeof setTimeout> | null;
  /** Where its program runs: the agent PTY host, or (a Shell row) the login-shell host of the bottom panel. */
  io: TermIo;
  /** Which program run in this terminal it is (a CLI row goes on as the login shell when its CLI ends): output
   *  drawn after its program was replaced is not acknowledged to the next one. */
  run: number;
  /** The person pressed a key or pasted in the current program once it ran (not the terminal's own replies to its
   *  queries): a shell that ends before that, with an error, failed at start (termEnd). */
  keyed: boolean;
  /** The current program printed something; `keyedHeard`: the person pressed a key or pasted after that. A CLI
   *  continuing its conversation that ends before such a key could not continue it (termEnd). */
  heard: boolean;
  keyedHeard: boolean;
  /** The next start continues the row's conversation without looking for its file first: Claude Code refused that
   *  id as a new conversation because it has it (once). */
  resumeOnce?: boolean;
  /** Its row was closed and waits out the undo window (closeGrace.ts): its program runs on, hidden, and takes no
   *  input (keys, bot prompts, dropped files) until Undo puts the row back. */
  held?: boolean;
}

/** The PTY calls a terminal makes once its program runs. */
export type TermIo = Pick<SessionHost, "write" | "ack" | "resize" | "close">;

/** A chat's process (agent chat in the shell) or Hermes folder chat (bridge). */
export interface ChatProc {
  kind: "agent" | "folder";
  /** shell chat id (agent) */
  hostId?: number;
  /** bridge folder chat id (folder) */
  fid?: string;
  bot?: string;
  /** set when manut itself stopped it (close, Terminal toggle), so its exit is not an end of the session */
  stopping?: boolean;
  /** the program never spoke its chat protocol (an old version, a hung start): the reason its turn and exit carry */
  noChat?: string;
  /** it is not signed in (an Agent Client Protocol agent's `-32000`): manut ends it with `noChat` as the reason */
  signedOut?: boolean;
}
