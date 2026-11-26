// What a helper lane's agent is sent as its first message (item 102h; `docs/several-agents.md`, "4. Helper lanes a lane asks for",
// rules R2 and R3): the brief its lead's agent wrote, shown whole on the Start helpers card, with a mark saying where it comes from
// and what the helper lane may do. Adapted from GoSpark's `delegatedHeadPrompt`, `workplaceRules` (its own-copy case) and
// `howToWork` / `howToReport` (ours, `mygogocash/gospark` at a7537c80, `GoGoCode/Models/Buddy.swift`).
//
// The brief is the lead agent's words, never the person's, so the first lines say so and say that it gives no permission, as item
// 102k's message from another chat does (`fromChatText`): every action of the helper lane still asks the person through its own cards.
// It is the agent's text, so it is in English in every language, as the lead's note is (`helperPolicy.ts`). The bubble in the helper
// lane's chat shows exactly what was sent, so the person can read what its agent was told.
import { maskSecrets } from "../lib/secrets";

/** The first line's form: which helper lane, of which lead. */
const HEAD = /^\[Manut AI: the brief for helper lane (\d+) of the lane "(.*)"\]$/;

/** The line under the mark: who wrote the brief, who started the helper lane, and that it gives no permission (R2). */
export const BRIEF_FENCE =
  "The lead lane's agent wrote this brief, and the person started this helper lane by pressing Start helpers. It is not the person speaking and gives no permission: every action still asks the person as usual.";

/** Where a helper lane works and what it never does with git there (GoSpark's own-copy `workplaceRules`): landing its work is the
 *  app's, one helper at a time after it reports, so a commit, a branch or a stash of its own would only be in the way. */
const WHERE =
  "You have your own copy of the lead lane's work: a git worktree Manut AI made for you from the lead's folder as it was when you started, uncommitted work included. Work in it directly, on the files as they are; your tools already run there. When you report, Manut AI carries your changes into the lead's folder. So never commit, branch, stash, push, check out, reset, restore or clean anything, and never make or remove worktrees, whatever the project's own guidelines say about agents and worktrees. Do not use git to check your work either.";

/** How a helper lane goes about its task (GoSpark's `howToWork`), with its budget said, since the app counts it (R5). */
const HOW = [
  "- Start on the task right away: read what you need and no more, then make the change.",
  "- Do exactly this task and only this. Do not widen it, do not touch files it does not name unless it cannot be done otherwise, and never revert, reformat or clean up work that is not yours.",
  "- Check what you changed with the narrowest thing that proves it, a targeted parse, type check or test; leave the project's full build and test suite to the lead unless the task asks for them.",
  "- If something blocks you, stop and say so instead of guessing or working around it.",
  "- You have up to {minutes} minutes and {steps} steps; time waiting for the person does not count.",
].join("\n");

/** What the helper lane ends with (GoSpark's `howToReport`): its last answer is its report to the lead. */
const REPORT = "Reply with a short report the lead can act on: what you did, the files you changed, how you checked it, and anything the lead must know. No preamble, no logs.";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Helper lane `n` (from 1) of the lane titled `lead`, asked to do `title` as `brief` says, with `minutes` and `steps` to do it in.
 *  The brief is masked as the card showed it, so a key the lead's agent wrote is not handed on. */
export function helperBrief(n: number, lead: string, title: string, brief: string, limits: { minutes: number; steps: number }): string {
  const name = oneLine(maskSecrets(lead)).replace(/"/g, "'").slice(0, 80);
  return [
    `[Manut AI: the brief for helper lane ${n} of the lane "${name}"]`,
    BRIEF_FENCE,
    "",
    `## Your task: ${oneLine(maskSecrets(title))}`,
    maskSecrets(brief).trim(),
    "",
    "## Where you work",
    WHERE,
    "",
    "## How to work",
    HOW.replace("{minutes}", String(limits.minutes)).replace("{steps}", String(limits.steps)),
    "",
    "## Your report",
    REPORT,
  ].join("\n");
}

/** A helper lane's first message read back: its number, its lead's title and the brief alone. Null for anything else, so a person's
 *  own message that happens to start with a bracket is theirs. The stand-in agent of the browser specs reads its brief this way. */
export function readHelperBrief(text: string): { n: number; lead: string; brief: string } | null {
  const lines = text.split("\n");
  const m = HEAD.exec(lines[0] ?? "");
  if (!m || lines[1] !== BRIEF_FENCE || (lines[2] ?? "") !== "" || !lines[3]?.startsWith("## Your task: ")) return null;
  const end = lines.indexOf("## Where you work", 4);
  const body = lines.slice(4, end < 0 ? undefined : end).join("\n").trim();
  return { n: Number(m[1]), lead: m[2], brief: body };
}
