// How the sessions store words a failed start or a dropped agent: the shell's not-signed-in sentence in the person's language, and plain error text. Split out of sessions.ts (item 125c), which re-exports what it exported before.
import { t as tr } from "../i18n";
import { sandboxSaid } from "../appStore";

/** The shell's own words when it will not start OpenCode (`NO_RULES` in acp_chat.rs, kept equal by a test); for Kilo
 *  Code the same sentence names Kilo Code (`no_rules`). */
export const NO_RULES = "OpenCode did not start because Manut AI could not confirm it would keep your own OpenCode permission rules.";

/** The shell's own sentence for an Agent Client Protocol agent that is not signed in (`signed_out` in acp_chat.rs,
 *  the command between backticks; a test keeps the two equal). */
const SIGNED_OUT = /^(.+) is not signed in\. Run `([^`]+)` in a terminal and sign in\.$/;

/** `text` as a person reads it: the shell's not-signed-in sentence is said in their language with the command as
 *  plain words (no backticks); anything else is returned as it is. */
export const signedOutSaid = (text: string): string => {
  const m = SIGNED_OUT.exec(text.trim());
  return m ? tr("ss.signedOut", { agent: m[1], cmd: m[2] }) : text;
};

export const errText = (e: unknown) =>
  signedOutSaid(
    // (a terminal the App Store edition's sandbox refused is said in plain words, src/appStore.ts)
    sandboxSaid(
      typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : typeof e === "object" && e && "message" in e
            ? String((e as { message: unknown }).message)
            : String(e),
      tr,
    ),
  );
