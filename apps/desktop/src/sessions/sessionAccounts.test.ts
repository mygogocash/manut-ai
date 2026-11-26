// Which agents take an account, and which one a new session starts as (item 101d: Grok and pi, as Claude Code and Codex).
// The table mirrors `session_cli` in src-tauri/src/accounts.rs, so a change to one without the other fails here.
import { describe, expect, it } from "vitest";
import type { Account, AccountCli, AccountGroup } from "../lib/protocol";
import { sessionAccountSuffix } from "./SessionsSection";
import { SESSION_CLI } from "./sessionCli";
import { ACCOUNT_CLI, accountFor } from "./sessionPure";

const acct = (id: string, label = ""): Account => ({ id, label, email: "", state: "ready" });
const group = (cli: AccountCli, active: string, accounts: Account[]): AccountGroup => ({ cli, installed: true, active, accounts });

describe("agents that take an account", () => {
  it("are Claude Code, Codex, Grok and pi, and the two tables agree", () => {
    expect(SESSION_CLI).toEqual({ claude: "claude", codex: "codex", grok: "grok", pi: "pi" });
    expect(ACCOUNT_CLI).toEqual(SESSION_CLI);
    for (const none of ["omp", "omo", "omh", "opencode", "dsh"]) expect(ACCOUNT_CLI[none], none).toBeUndefined();
  });

  it("start as the account Settings picked for new sessions, or as 'This computer'", () => {
    const groups = [group("grok", "work", [acct("default"), acct("work", "Work")]), group("pi", "default", [acct("default"), acct("play")])];
    expect(accountFor(groups, "grok")).toBe("work");
    expect(accountFor(groups, "pi")).toBe("default");
    expect(accountFor(groups, "omp")).toBeUndefined();
    expect(accountFor(null, "pi")).toBeUndefined();
  });

  it("are named quietly in the + menu when an added account is the one in use", () => {
    const groups = [group("grok", "work", [acct("default"), acct("work", "Work")]), group("pi", "play", [acct("default"), acct("play", "Play")])];
    expect(sessionAccountSuffix(groups, "grok")).toBe("as Work");
    expect(sessionAccountSuffix(groups, "pi")).toBe("as Play");
    expect(sessionAccountSuffix([group("pi", "default", [acct("default")])], "pi")).toBe("");
  });
});
