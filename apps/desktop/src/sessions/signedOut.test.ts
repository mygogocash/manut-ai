// The + menu says, before the first message, that an agent is installed but not signed in, where the app can already tell
// (item 68). What it can tell is pinned here: Claude Code and Codex by the CLI's own status, Grok by the bridge's state,
// and nothing for any other agent or for a computer whose accounts the app has not read.
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t } from "../i18n";
import type { Account, AccountCli, AccountGroup } from "../lib/protocol";
import type { LoginStatus } from "../settings/accounts/native";
import { agentSignedOut, signedOutTip, type SignInKnowledge } from "./signedOut";

const account = (over: Partial<Account> = {}): Account => ({ id: "default", label: "", email: "", state: "ready", ...over });
const group = (cli: AccountCli, accounts: Account[], active: string | null = "default"): AccountGroup => ({ cli, installed: true, active, accounts });
const status = (logged_in: boolean): LoginStatus => ({ logged_in, email: null, plan: null, method: null });
const known = (groups: AccountGroup[] | null, st: Record<string, LoginStatus> = {}): SignInKnowledge => ({ groups, status: st });

afterEach(() => setLang("en"));

describe("an agent the app can tell is not signed in", () => {
  it("is Claude Code or Codex when the CLI's own status says it is not logged in", () => {
    const groups = [group("claude", [account()]), group("codex", [account()])];
    expect(agentSignedOut(known(groups, { "claude:default": status(false), "codex:default": status(true) }), "claude")).toBe(true);
    expect(agentSignedOut(known(groups, { "claude:default": status(false), "codex:default": status(true) }), "codex")).toBe(false);
  });

  it("is read for the account a new session runs as, not another one the CLI holds", () => {
    const groups = [group("claude", [account(), account({ id: "work" })], "work")];
    expect(agentSignedOut(known(groups, { "claude:default": status(false), "claude:work": status(true) }), "claude")).toBe(false);
    expect(agentSignedOut(known(groups, { "claude:default": status(true), "claude:work": status(false) }), "claude")).toBe(true);
  });

  it("falls back to the bridge's own state when the CLI could not be asked, as Settings › Accounts does", () => {
    expect(agentSignedOut(known([group("claude", [account({ state: "login" })])]), "claude")).toBe(true);
    expect(agentSignedOut(known([group("claude", [account({ state: "active" })])]), "claude")).toBe(false);
    // Grok has no status command here: the account folder's own auth file (the bridge's state, "login") tells
    expect(agentSignedOut(known([group("grok", [account({ state: "login" })])]), "grok")).toBe(true);
  });

  it("says nothing for a limited account, which is signed in", () => {
    expect(agentSignedOut(known([group("codex", [account({ state: "limited" })])]), "codex")).toBe(false);
  });

  it("says nothing where the app cannot tell: accounts not read, no account for the CLI, or an agent with no account", () => {
    expect(agentSignedOut(known(null), "claude")).toBe(false);
    expect(agentSignedOut(known([group("codex", [account({ state: "login" })])]), "claude")).toBe(false);
    expect(agentSignedOut(known([group("claude", [], null)]), "claude")).toBe(false);
    const all = [group("claude", [account({ state: "login" })]), group("pi", [account({ state: "login" })]), group("omp", [account({ state: "login" })])];
    for (const agent of ["omp", "opencode", "omo", "dsh", "omh", "cursor", "my-own"]) expect(agentSignedOut(known(all), agent), agent).toBe(false);
  });
});

describe("Grok and pi accounts (item 101d)", () => {
  it("reads Grok for the account a new session runs as, not another one", () => {
    const groups = [group("grok", [account({ state: "login" }), account({ id: "work", state: "ready" })], "work")];
    expect(agentSignedOut(known(groups, { "grok:default": status(false), "grok:work": status(true) }), "grok")).toBe(false);
    const other = [group("grok", [account({ state: "ready" }), account({ id: "work", state: "login" })], "work")];
    expect(agentSignedOut(known(other, { "grok:default": status(true), "grok:work": status(false) }), "grok")).toBe(true);
  });

  it("never says pi is not signed in, whatever its folder holds: a key in its environment signs it in and no folder shows that", () => {
    const groups = [group("pi", [account({ state: "login" }), account({ id: "work", state: "login" })], "work")];
    expect(agentSignedOut(known(groups, { "pi:work": status(false) }), "pi")).toBe(false);
  });
});

describe("the tooltip", () => {
  it("names the CLI's own sign-in command, to run in a terminal, and that the row still starts", () => {
    expect(signedOutTip("claude", "Claude Code")).toBe("Claude Code is not signed in on this computer. To sign in, run claude auth login in a terminal. You can still start it.");
    expect(signedOutTip("codex", "Codex")).toContain("codex login");
  });

  it("names Grok's own sign-in line, and none for an agent whose sign-in the app does not know", () => {
    expect(signedOutTip("grok", "Grok")).toBe("Grok is not signed in on this computer. To sign in, run grok login in a terminal. You can still start it.");
    expect(signedOutTip("opencode", "OpenCode")).toBe("OpenCode is not signed in on this computer. Sign in with its own command in a terminal. You can still start it.");
  });

  it("reads in every language", () => {
    for (const lang of LANGS) {
      setLang(lang);
      expect(signedOutTip("claude", "Claude Code"), lang).toContain("claude auth login");
      expect(t("ss.notSignedIn"), lang).not.toBe("");
      expect(signedOutTip("grok", "Grok"), lang).toContain("grok login");
    }
  });
});
