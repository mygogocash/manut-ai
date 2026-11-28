// How the sessions store words a failed start or a dropped agent: the shell's not-signed-in sentence in the person's language, and plain error text. Split out of sessions.ts (item 125c), which re-exports what it exported before.
import { t as tr } from "../i18n";
import { sandboxSaid } from "../appStore";

/** The shell's own words when it will not start OpenCode (`NO_RULES` in acp_chat.rs, kept equal by a test); for Kilo
 *  Code the same sentence names Kilo Code (`no_rules`). */
export const NO_RULES = "OpenCode did not start because Manut AI could not confirm it would keep your own OpenCode permission rules.";

/** The shell's own sentence for an Agent Client Protocol agent that is not signed in (`signed_out` in acp_chat.rs,
 *  the command between backticks; a test keeps the two equal). */
const SIGNED_OUT = /^(.+) is not signed in\. Run `([^`]+)` in a terminal and sign in\.$/;

/** The shell's sentence for an agent whose own settings let it act without asking (`no_asks` in acp_chat.rs: Cursor's
 *  Run Everything, item 101a), and for one that stayed in a mode without asks (`mode_refusal`). A test keeps each equal
 *  to the shell's. */
export const NO_ASKS = /^(.+) did not start because its own settings let it run commands and change files without asking first\.$/;
export const MODE_KEPT = /^(.+) stayed in its (.+) mode, which does not ask before it acts, so Manut AI sends it nothing more\. Close this chat and start a new one\.$/;

/** The shell's sentence when oh-my-pi's own settings could not be checked before its chat (`no_check` in omp_asks.rs, item
 *  139), and when a chat of pi or OmO, which cannot ask before a tool runs, was refused (`no_ask_path` in sessions.rs). A test
 *  keeps each equal to the shell's. */
export const NO_CHECK = /^(.+) did not start because Manut AI could not check that its own settings make it ask first\.$/;
export const NO_ASK_PATH = /^(.+) does not ask before it runs a command or changes a file, so Manut AI runs it only in a terminal\.$/;

/** The shell's sentence for a message that starts with an agent's own command that turns its asks off (`no_asks_command`
 *  in acp_chat.rs: Grok's `/always-approve`, item 101b), which it never sends. A test keeps it equal to the shell's. */
export const NO_ASKS_COMMAND = /^(.+)'s \/(\S+) turns off its asks, so Manut AI does not send it\. Write your message without it\.$/;

/** `text` as a person reads it: the shell's not-signed-in sentence is said in their language with the command as
 *  plain words (no backticks), and so are its two sentences about an agent that would not ask first; anything else is
 *  returned as it is. */
export const signedOutSaid = (text: string): string => {
  const t = text.trim();
  const m = SIGNED_OUT.exec(t);
  if (m) return tr("ss.signedOut", { agent: m[1], cmd: m[2] });
  const n = NO_ASKS.exec(t);
  // the setting to change is the agent's own: Cursor's Approval mode, Grok's permission_mode (item 101b), oh-my-pi's
  // tools.approvalMode and tools.approval (item 139)
  if (n) return tr(n[1] === "Grok" ? "ss.noAsksGrok" : n[1] === "oh-my-pi" ? "ss.noAsksOmp" : "ss.noAsks", { agent: n[1] });
  const u = NO_CHECK.exec(t);
  if (u) return tr("ss.noAsksCheck", { agent: u[1] });
  const p = NO_ASK_PATH.exec(t);
  if (p) return tr("ss.noAskPath", { agent: p[1] });
  const c = NO_ASKS_COMMAND.exec(t);
  if (c) return tr("ss.noAsksCommand", { agent: c[1], cmd: c[2] });
  const k = MODE_KEPT.exec(t);
  return k ? tr("ss.asksModeKept", { agent: k[1], mode: k[2] }) : text;
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
