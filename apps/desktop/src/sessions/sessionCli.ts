import type { AccountCli } from "../lib/protocol";
import type { AgentId } from "./agents";

/** The Accounts CLI a new session of `agent` signs in as (mirrors `session_cli` in src-tauri/src/accounts.rs). */
export const SESSION_CLI: Partial<Record<AgentId, AccountCli>> = { claude: "claude", codex: "codex", grok: "grok" };
