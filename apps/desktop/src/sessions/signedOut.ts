// An agent the app can tell is installed but not signed in, said in the + menu before the first message (item 68).
// The app knows a sign-in in two ways, both already read for Settings › Accounts and neither one a run of the agent:
//   - Claude Code and Codex: the CLI's own status command (`claude auth status --json`, `codex login status`; src-tauri
//     accounts.rs `fixed_args`), asked for each account every minute by the Accounts watcher.
//   - Grok: whether the account's own folder holds Grok's `auth.json` (a stat, never opened; accounts.rs `signed_in_here`),
//     the same reading the Accounts page words as "Not signed in".
// Every other agent (OmO, pi, oh-my-pi, OpenCode, DeepSeek Harness, the ACP agents, a person's own) is one the app cannot
// tell, and shows nothing. pi has accounts (item 101d) but is left out on purpose: see NO_SIGNED_OUT_WORD. The knowledge can be stale (someone signs in from a terminal a
// moment ago), so the row stays pickable: this only says what the app last read.
import type { AccountGroup } from "../lib/protocol";
import type { LoginStatus } from "../settings/accounts/native";
import { accountForNewSessions, mergeRow } from "../settings/accounts/rules";
import { t } from "../i18n";
import type { AgentId } from "./agents";
import { SESSION_CLI } from "./sessionCli";

/** What the app has read about accounts: `groups` and `status` as `useAccounts()` keeps them. */
export interface SignInKnowledge {
  groups: AccountGroup[] | null;
  /** `${cli}:${account}` -> the CLI's own status. */
  status: Record<string, LoginStatus>;
}

/** The CLI's own sign-in command, from the fixed list accounts.rs runs for Settings › Accounts. Grok's is not known to the
 *  app, so its tooltip names no command. */
const LOGIN_COMMAND: Partial<Record<AgentId, string>> = { claude: "claude auth login", codex: "codex login", grok: "grok login" };

/** Agents the app can tell nothing from: pi is signed in by its /login (a file in the account's folder) or by an API key in
 *  its environment, which no folder shows, so a pi row never says it is not signed in. */
const NO_SIGNED_OUT_WORD: readonly AgentId[] = ["pi"];

/** True only when the app has read that the account a new session of `agent` runs as is not signed in. False for "signed
 *  in" and for "cannot tell" alike, so nothing new shows where the app does not know. */
export function agentSignedOut(known: SignInKnowledge, agent: AgentId): boolean {
  const cli = SESSION_CLI[agent];
  if (!cli || NO_SIGNED_OUT_WORD.includes(agent)) return false;
  const account = accountForNewSessions(known.groups, cli);
  if (!account) return false;
  return !mergeRow(account, known.status[`${cli}:${account.id}`]).signedIn;
}

/** The quiet word on the row. */
export const signedOutWord = (): string => t("ss.notSignedIn");

/** The row's tooltip: that the agent is not signed in, how (in its own CLI, in a terminal), and that it can still start. */
export function signedOutTip(agent: AgentId, label: string): string {
  const command = LOGIN_COMMAND[agent];
  return command ? t("ss.signedOutTip", { agent: label, command }) : t("ss.signedOutTipPlain", { agent: label });
}
