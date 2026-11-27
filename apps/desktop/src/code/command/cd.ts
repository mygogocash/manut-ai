// `cd` and its options: where the shell is after it, and whether that is a place the reader may follow.
// Its own file because it is one builtin's reading and no other family's code calls it but `classify`.
import { type Where } from "./types";
import { say, v, type Verdict } from "./verdict";
import { resolve } from "./paths";
import { guardedPath } from "./protected";

/** cd's own options (bash's and zsh's) that only choose how a link in the path is followed or how much it says. */
const CD_FLAGS = /^-[PLqse@]+$/;

/** A `cd` (or zsh's `chdir`). It reads nothing, but it decides where every later command of the session runs (item 116):
 *  one into a folder a change to which always asks asks too, and one whose folder cannot be known (`cd -`, a folder
 *  from the stack as `+1` or `-2`, zsh's two-word form, `~user`, the home folder when it is not known) asks and leaves
 *  the folder unknown. */
export function changeFolder(words: string[], where: Where): Verdict {
  const lost = (extra: Partial<Verdict> = {}): Verdict => v("unknown", say("kit.say.opaque"), undefined, { lost: true, ...extra });
  const ops: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--" && !ops.length) {
      ops.push(...words.slice(i + 1));
      break;
    }
    if (!ops.length && w.length > 1 && /^[+-]/.test(w)) {
      if (CD_FLAGS.test(w)) continue;
      return lost();
    }
    ops.push(w);
  }
  if (ops.length > 1 || ops[0] === "-") return lost();
  const to = ops[0] ?? "~";
  const abs = to === "~" ? (where.home ?? null) : resolve(to, where.cwd, where.home);
  // the path is kept so that the line reads it as outside, as it did before
  if (abs === null) return lost({ cd: to });
  if (guardedPath(abs, where)) return v("unknown", say("kit.say.opaque"), undefined, { cd: to });
  return v("read", say("kit.say.read"), undefined, { cd: to });
}
