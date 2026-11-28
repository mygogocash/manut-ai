// The shell's sentences that the sessions store says in the person's language (sessionErrors.ts): the two about an agent
// that would not ask before it acts (item 101a, `no_asks` and `mode_refusal` in acp_chat.rs), written here exactly as the
// shell writes them, so a change on either side fails here.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { MODE_KEPT, NO_ASK_PATH, NO_ASKS, NO_ASKS_COMMAND, NO_CHECK, OMP_PROJECT_CODE, signedOutSaid } from "./sessionErrors";

afterEach(() => setLang("en"));

// acp_chat.rs `no_asks("Cursor")` and `mode_refusal()` for Antigravity left in its `auto` mode, word for word
const SHELL_NO_ASKS = "Cursor did not start because its own settings let it run commands and change files without asking first.";
const SHELL_MODE_KEPT = "Antigravity stayed in its auto mode, which does not ask before it acts, so Manut AI sends it nothing more. Close this chat and start a new one.";

describe("an agent that would not ask before it acts", () => {
  it("is said in the person's language, with the agent and its mode", () => {
    expect(NO_ASKS.test(SHELL_NO_ASKS) && MODE_KEPT.test(SHELL_MODE_KEPT)).toBe(true);
    for (const lang of ["en", "ja", "ko", "zh"] as const) {
      setLang(lang);
      expect(signedOutSaid(SHELL_NO_ASKS)).toBe(t("ss.noAsks", { agent: "Cursor" }));
      expect(signedOutSaid(` ${SHELL_MODE_KEPT}\n`)).toBe(t("ss.asksModeKept", { agent: "Antigravity", mode: "auto" }));
    }
    setLang("en");
    // English says how to put it right, in Cursor's own words for the setting
    expect(signedOutSaid(SHELL_NO_ASKS)).toContain("Set Approval mode to Allowlist in Cursor's own settings");
    // the signed-out sentence still reads as before, and anything else is left as it is
    expect(signedOutSaid("Kimi Code is not signed in. Run `kimi login` in a terminal and sign in.")).toBe(t("ss.signedOut", { agent: "Kimi Code", cmd: "kimi login" }));
    expect(signedOutSaid("Cursor did not start.")).toBe("Cursor did not start.");
  });

  // item 101b: acp_chat.rs `no_asks("Grok")` and `no_asks_command("Grok", "always-approve")`, word for word
  it("Grok's are said with Grok's own setting, and its command that turns its asks off is named", () => {
    const grok = "Grok did not start because its own settings let it run commands and change files without asking first.";
    const command = "Grok's /always-approve turns off its asks, so Manut AI does not send it. Write your message without it.";
    expect(NO_ASKS.test(grok) && NO_ASKS_COMMAND.test(command)).toBe(true);
    for (const lang of ["en", "ja", "ko", "zh"] as const) {
      setLang(lang);
      expect(signedOutSaid(grok)).toBe(t("ss.noAsksGrok", { agent: "Grok" }));
      expect(signedOutSaid(command)).toBe(t("ss.noAsksCommand", { agent: "Grok", cmd: "always-approve" }));
      // each language keeps the setting's own names, as Grok writes them
      expect(t("ss.noAsksGrok", { agent: "Grok" })).toContain("permission_mode");
    }
    setLang("en");
    expect(signedOutSaid(grok)).toContain("Set permission_mode to ask in the [ui] section of Grok's config.toml");
    expect(signedOutSaid(command)).toBe(command);
  });

  // item 139: omp_asks.rs `no_asks("oh-my-pi")` and `no_check("oh-my-pi")`, and sessions.rs `no_ask_path` for pi and OmO, word for word
  it("oh-my-pi's are said with its own settings, and pi's and OmO's refused chats say they run only in a terminal", () => {
    const omp = "oh-my-pi did not start because its own settings let it run commands and change files without asking first.";
    const unchecked = "oh-my-pi did not start because Manut AI could not check that its own settings make it ask first.";
    const pi = "pi does not ask before it runs a command or changes a file, so Manut AI runs it only in a terminal.";
    const omo = "OmO does not ask before it runs a command or changes a file, so Manut AI runs it only in a terminal.";
    expect(NO_ASKS.test(omp) && NO_CHECK.test(unchecked) && NO_ASK_PATH.test(pi) && NO_ASK_PATH.test(omo)).toBe(true);
    for (const lang of ["en", "ja", "ko", "zh"] as const) {
      setLang(lang);
      expect(signedOutSaid(omp)).toBe(t("ss.noAsksOmp", { agent: "oh-my-pi" }));
      expect(signedOutSaid(unchecked)).toBe(t("ss.noAsksCheck", { agent: "oh-my-pi" }));
      expect(signedOutSaid(pi)).toBe(t("ss.noAskPath", { agent: "pi" }));
      expect(signedOutSaid(` ${omo}\n`)).toBe(t("ss.noAskPath", { agent: "OmO" }));
      // each language keeps the setting's own names, as omp writes them
      expect(t("ss.noAsksOmp", { agent: "oh-my-pi" })).toContain("tools.approvalMode");
      expect(t("ss.noAsksOmp", { agent: "oh-my-pi" })).toContain("tools.approval ");
    }
    setLang("en");
    expect(signedOutSaid(omp)).toContain("set tools.approvalMode to always-ask and remove any tools.approval entry that says allow");
    expect(signedOutSaid(pi)).toBe(pi);
  });

  // item 139b: omp_asks.rs `project_code_refusal("oh-my-pi", what)`, word for word, with what it found named in every language
  it("oh-my-pi's refusal in a folder with its own tools, plugins or .env variables names what it found", () => {
    const shell = (what: string) => `oh-my-pi did not start because this folder holds its own code or variables for it (${what}), which would run or apply as it starts, before anything asks you.`;
    for (const what of [".omp/tools", ".env", "/Users/k/work/.omp/plugins"]) {
      expect(OMP_PROJECT_CODE.exec(shell(what))?.slice(1)).toEqual(["oh-my-pi", what]);
      for (const lang of ["en", "ja", "ko", "zh"] as const) {
        setLang(lang);
        const said = signedOutSaid(shell(what));
        expect(said).toBe(t("ss.ompProjectCode", { agent: "oh-my-pi", what }));
        expect(said).toContain(what);
        expect(said).toContain("PI_");
      }
    }
    setLang("en");
    expect(signedOutSaid(shell(".omp/tools"))).toContain("open this folder in a terminal session of oh-my-pi");
  });
});
