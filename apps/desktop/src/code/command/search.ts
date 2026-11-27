// grep and rg: the options that take a value, the words that are the pattern, and the options that run a program.
// Its own file because it is one family's reading.
import { has, hasIn, operands, say, unknownProgram, v, type Verdict } from "./verdict";

const SEARCH_VALUE: Record<string, ReadonlySet<string>> = {
  grep: new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--label", "--binary-files"]),
  rg: new Set(["-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-j", "-M", "-r", "-E", "--glob", "--iglob", "--type", "--type-not", "--regexp", "--file", "--replace", "--max-count", "--after-context", "--before-context", "--context", "--threads", "--max-columns", "--max-depth", "--maxdepth", "--sort", "--sortr", "--encoding", "--pre", "--pre-glob", "--ignore-file", "--type-add", "--type-clear"]),
};

/** Their short options that take a value: in a bundle, what follows one of them is its value. */
const SEARCH_SHORT_VALUES: Record<"grep" | "rg", string> = { grep: "efmABCdD", rg: "efgtTABCmjMrE" };

/** Their options whose value is text (a pattern, a glob, a type), joined to it or not. */
const SEARCH_TEXT_SHORT: Record<"grep" | "rg", string> = { grep: "e", rg: "egtTr" };

/** grep, rg and the like: the first word that is not an option is the pattern, unless one came with `-e` or `-f`. A
 *  preprocessor (`rg --pre`) or the program that names the computer (`--hostname-bin`) runs a program on every file or at
 *  the start, and ag's pager does at the end, so a search with one is not a read. */
export function search(words: string[], kind: "grep" | "rg"): Verdict {
  if (kind === "rg" && has(words, "--pre", "--pre-glob", "--hostname-bin", "--pager")) return unknownProgram(words[0]);
  const takes = SEARCH_VALUE[kind];
  const ops = operands(words, 1, takes);
  const text = new Set<number>();
  words.forEach((w, i) => {
    if (takes.has(w) && !["-f", "--file", "--ignore-file"].includes(w) && i + 1 < words.length) text.add(i + 1);
    // a pattern or a glob joined to its option (`-efoo`, `--glob=*.ts`) is text too
    else if (new RegExp(`^-[${SEARCH_TEXT_SHORT[kind]}].`).test(w) || /^--(regexp|glob|iglob|type|type-not|replace|type-add)=/.test(w)) text.add(i);
  });
  if (!hasIn(SEARCH_SHORT_VALUES[kind], words, "-e", "--regexp", "-f", "--file") && ops.length) text.add(ops[0]);
  return v("read", say("kit.say.read"), undefined, { text });
}
