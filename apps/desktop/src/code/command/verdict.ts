// What a step is (`Verdict`), how strict each kind is (`RANK`), and the helpers the program families share to build one and to read a command's options.
// Its own file because every family needs them and none may import another for them.
import type { KitAction } from "@manut/member-grants";
import type { Key } from "../../i18n";
import { type Say } from "./types";

/** How strict a step is, for a command built from several: the strictest part speaks for the whole. */
export const RANK: Record<KitAction, number> = { read: 0, check: 1, edit: 2, change: 3, install: 4, delete: 5, push: 6, unknown: 7, live: 8 };

export interface Verdict {
  action: KitAction;
  say: Say;
  /** How many of the command's first words a kept rule holds; "exact" for the whole command; absent for none. */
  head?: number | "exact";
  saves?: boolean;
  /** Words that are text, not paths (a pattern, a message, a script), by their index in the command's words. */
  text?: Set<number>;
  /** For `cd`: where it goes, as written (`~` when it names nothing). */
  cd?: string;
  /** Its folders are where it looks, not what it deletes (a `find` that deletes only what matches a name). */
  filtered?: true;
  /** After it, the folder the shell is in cannot be known (`cd -`, `pushd`, `popd`, `source`, `eval`). */
  lost?: true;
  /** It may switch, rename or detach the branch checked out, or make another repository to work in (item 120). */
  moves?: true;
  /** It sends what is saved (item 120). */
  sends?: true;
  /** Its message or body is read from a file (item 120). */
  fromFile?: true;
  /** It only stages or unstages what the folder already holds, or takes it away (`git add` without force, `git rm`,
   *  `git mv`): a read of the folder made before it sees what it saves (item 120). */
  staged?: true;
  /** The tags it makes (item 120). */
  tags?: string[];
}

export const say = (key: Key, vars?: Say["vars"]): Say => (vars ? { key, vars } : { key });

export const v = (action: KitAction, s: Say, head?: number | "exact", extra: Partial<Verdict> = {}): Verdict => ({ action, say: s, ...(head === undefined ? {} : { head }), ...extra });

export const unknownProgram = (program: string): Verdict => v("unknown", say("kit.say.unknown", { program }));

export const thisMac = (): Verdict => v("unknown", say("kit.say.thisMac"));

export const sends = (): Verdict => v("unknown", say("kit.say.send"));

export const live = (): Verdict => v("live", say("kit.say.live"));

/** The first word that is not an option, from `from`, skipping the values of the options in `takesValue`. */
export function operands(words: string[], from: number, takesValue: ReadonlySet<string> = new Set()): number[] {
  const out: number[] = [];
  for (let i = from; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      for (let j = i + 1; j < words.length; j++) out.push(j);
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (takesValue.has(w)) i++;
      continue;
    }
    out.push(i);
  }
  return out;
}

/** Whether the word `w` is the option `opt` in a form the program reads as it: a long one in full, with `=value`, or
 *  shortened to any start of its name (git and every program built on GNU getopt take an unambiguous start, so
 *  `--upload-pa` is `--upload-pack`); a short one alone, joined to its value (`-ofile`) or bundled after other short ones
 *  (`-fsSLo`); a word option (`-exec`, `-TT`) itself or with its value joined. `values` are the short options of the
 *  program that take a value: in a bundle, what follows one of them is its value, not more options. Leaving one out
 *  only reads more into a word, never less. */
export function isOpt(w: string, opt: string, values = ""): boolean {
  if (w === opt) return true;
  if (opt.startsWith("--")) {
    if (!w.startsWith("--") || w.length < 3) return false;
    const name = w.slice(2).split("=")[0];
    return name !== "" && opt.slice(2).startsWith(name);
  }
  if (opt.length === 2) {
    if (!/^-[^-]/.test(w)) return false;
    for (const c of w.slice(1)) {
      if (c === opt[1]) return true;
      if (values.includes(c)) return false;
    }
    return false;
  }
  return opt.startsWith("-") && w.startsWith(opt);
}

/** Whether any of `words` is one of the options `opts` (`isOpt`). For an option that makes a step stricter: reading too
 *  much into a word only ever asks more. */
export const has = (words: string[], ...opts: string[]) => words.some((w) => opts.some((o) => isOpt(w, o)));

/** `has` with the short options of the program that take a value. */
export const hasIn = (values: string, words: string[], ...opts: string[]) => words.some((w) => opts.some((o) => isOpt(w, o, values)));

/** Whether one of `opts` is written in full, for an option that makes a step looser (a dry run, a list). It counts only
 *  as written and only while no word takes an option back (`--no-dry-run`, or any start of one), so a word read too
 *  much into never lets a step through. */
export const hasExactly = (words: string[], ...opts: string[]) => words.some((w) => opts.includes(w)) && !words.some((w) => w.startsWith("--no-"));

/** The words that are an option's value from `opts`: a message, a name, a pattern. */
export function textAfter(words: string[], opts: string[]): Set<number> {
  const out = new Set<number>();
  words.forEach((w, i) => {
    if (opts.includes(w) && i + 1 < words.length) out.add(i + 1);
  });
  return out;
}

/** Whether `next`, the word after an option that takes a value, is read as that value by an allow-list (item 120): never a
 *  word that starts with `-` (but `-` alone, which names the input), so a program whose value is optional cannot hide its
 *  next option there. A program whose value is required takes the word or refuses to start: reading it as an option only
 *  asks more. */
export const takesWord = (next: string | undefined) => next !== undefined && (next === "-" || !next.startsWith("-"));

/** An option's name as written, in lower case, without its dashes or its value: `--Cache-Dir=x` is `cache-dir`. */
export const optName = (w: string) => (w.startsWith("-") ? w.replace(/^-+/, "").split("=")[0].toLowerCase() : "");

/** Whether any of `words` is one of the options `names` (by `optName`), with one dash or two, its value joined or not. */
export const hasNamed = (words: readonly string[], ...names: string[]) => words.some((w) => names.includes(optName(w)));

export function strictest(list: Verdict[]): Verdict {
  return list.reduce((a, b) => (RANK[b.action] > RANK[a.action] ? b : a));
}
