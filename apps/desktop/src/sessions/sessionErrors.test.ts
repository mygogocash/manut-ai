// The shell's sentences that the sessions store says in the person's language (sessionErrors.ts): the two about an agent
// that would not ask before it acts (item 101a, `no_asks` and `mode_refusal` in acp_chat.rs), written here exactly as the
// shell writes them, so a change on either side fails here.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { MODE_KEPT, NO_ASKS, signedOutSaid } from "./sessionErrors";

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
});
