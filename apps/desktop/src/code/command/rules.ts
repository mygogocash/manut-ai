// The rules "Always allow in this project" keeps: when a rule matches a line, whether it covers an action, and how it is written.
// Its own file because it reads a line only through `readCommand` and nothing reads it back.
import type { KitAction } from "@manut/member-grants";
import { type Rule } from "./types";
import { lex } from "./shell";
import { ASSIGNMENT, readCommand } from "./whole";

/** Whether a kept rule covers `line`: one simple command, read in full, whose first words are the rule's (all of them,
 *  and nothing more, for an exact rule). */
export function ruleMatches(rule: Rule, line: string): boolean {
  const { cmds, opaque } = lex(line);
  if (opaque || cmds.length !== 1 || cmds[0].redirects.length || !rule.words.length) return false;
  const words = cmds[0].words;
  if (ASSIGNMENT.test(words[0] ?? "")) return false;
  if (rule.exact && words.length !== rule.words.length) return false;
  return rule.words.every((w, i) => words[i] === w);
}

/** Options that make a command do more of what it does, or something harsher: force, delete, hard, clear, recursive. */
const HARSHER = /^--(force|force-with-lease|force-if-includes|force-create|delete|hard|clear|recursive|mirror|prune|discard-changes)(=|$)/;

/** The short ones, where the program reads its letters so (git's `-f`, `-d`, `-D`, `-r`, and since item 120 `-B`, `-C`
 *  and `-M`, which make or rename a branch over one that is there; a package manager's `-f` and `-r`), counted inside a
 *  bundle (`-fu`). Elsewhere a letter means something else (`pnpm add -D` saves a tool). */
const HARSHER_SHORT: Record<string, RegExp> = { git: /^-[^-]*[fdDrRBCM]/, pnpm: /^-[^-]*[fr]/, npm: /^-[^-]*[fr]/, yarn: /^-[^-]*[fr]/, bun: /^-[^-]*[fr]/ };

/** The step a kept rule covers: the one it was kept for, or, for a rule saved before rules named one, the least strict
 *  step its own words can mean (read as on a branch of Kit's own, so `git push` is a push). */
const ruleAction = (rule: Rule): KitAction => rule.action ?? readCommand(rule.words.join(" "), { cwd: "/rule", root: "/rule", branch: "kit/rule" }).action;

/** Whether a kept rule covers `line`, read as `action` (item 116): its words begin the line (`ruleMatches`), the line is
 *  the very step the rule was kept for, and no word after the rule's own is an option that makes it harsher. So a rule
 *  kept from a push never covers a forced push or a delete, nor one kept from a new branch a branch's delete. */
export function ruleCovers(rule: Rule, line: string, action: KitAction): boolean {
  if (!ruleMatches(rule, line) || ruleAction(rule) !== action) return false;
  const words = lex(line).cmds[0].words;
  const short = HARSHER_SHORT[words[0] ?? ""];
  return !words.slice(rule.words.length).some((w) => HARSHER.test(w) || short?.test(w));
}

/** A rule as the developer reads it: "pnpm add …", or the whole command. */
export function ruleText(rule: Rule): string {
  return rule.exact ? rule.words.join(" ") : `${rule.words.join(" ")} …`;
}
