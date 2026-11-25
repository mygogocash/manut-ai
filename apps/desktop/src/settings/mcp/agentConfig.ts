// Settings › MCP and Skills (item 72): what the shell reads from each coding agent's own files (src-tauri/src/agent_config.rs),
// and what a running chat last said of its servers. Names only: the shell never sends a command, an argument, an
// environment value, a header or an address, and `readAgentConfig` keeps nothing else even if one came.
//
// Whether a server is connected is only known from a chat: Claude Code says it in the first line of every chat
// (`session.info`'s `mcp`, names and a status word), which `noteMcpSeen` keeps here, in memory, until the app closes.
import { useSyncExternalStore } from "react";

export type ConfigFrom = "home" | "local" | "project" | "plugin";
export type ConfigState = "on" | "off" | "ask";
export type SeenStatus = "connected" | "failed" | "needs_auth" | "pending" | "off" | "other";

export interface ConfigItem {
  name: string;
  from: ConfigFrom;
  plugin?: string;
  state: ConfigState;
}

export interface AgentConfig {
  agent: "claude" | "codex";
  /** Its home folder is on this computer. */
  found: boolean;
  servers: ConfigItem[];
  skills: ConfigItem[];
}

const FROM: readonly ConfigFrom[] = ["home", "local", "project", "plugin"];
const STATES: readonly ConfigState[] = ["on", "off", "ask"];
const SEEN: readonly SeenStatus[] = ["connected", "failed", "needs_auth", "pending", "off", "other"];

/** A name as the page shows it: one line, at most 80 characters, or null. */
const name = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const n = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return n || null;
};

function item(raw: unknown): ConfigItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = name(r.name);
  const from = FROM.find((f) => f === r.from);
  const state = STATES.find((s) => s === r.state);
  if (!n || !from || !state) return null;
  const plugin = from === "plugin" ? name(r.plugin) : null;
  return plugin ? { name: n, from, plugin, state } : { name: n, from, state };
}

/** The shell's answer (`agent_config_list`), with anything that is not a name, a source and a state left out. */
export function readAgentConfig(raw: unknown): AgentConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const r = x as Record<string, unknown>;
    if (r.agent !== "claude" && r.agent !== "codex") return [];
    const list = (v: unknown) => (Array.isArray(v) ? v.map(item).filter((i): i is ConfigItem => !!i) : []);
    return [{ agent: r.agent, found: r.found === true, servers: list(r.servers), skills: list(r.skills) }];
  });
}

/** What the last chat of each agent said of its servers: name -> status. */
const seen = new Map<string, Map<string, SeenStatus>>();
const listeners = new Set<() => void>();
let version = 0;

/** A chat's `session.info` `mcp` list for agent `agent`: kept as names and status words, replacing what the agent said before. */
export function noteMcpSeen(agent: string, raw: unknown): void {
  if (!agent || !Array.isArray(raw)) return;
  const m = new Map<string, SeenStatus>();
  for (const x of raw.slice(0, 100)) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const n = name(r.name);
    if (n) m.set(n, SEEN.find((s) => s === r.status) ?? "other");
  }
  seen.set(agent, m);
  version++;
  for (const l of listeners) l();
}

/** What agent `agent`'s last chat said, or undefined before one. */
export function mcpSeen(agent: string): ReadonlyMap<string, SeenStatus> | undefined {
  return seen.get(agent);
}

/** Tests: forget every chat's report. */
export function forgetMcpSeen(): void {
  seen.clear();
  version++;
  for (const l of listeners) l();
}

/** Re-renders when a chat reports its servers. */
export function useMcpSeenVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}
