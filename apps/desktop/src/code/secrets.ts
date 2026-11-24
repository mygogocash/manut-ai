// A key or a password typed into the code ("A secret found in the code" on the design canvas's StatesCodeDev board).
// Kit's changes reach the app as `tool.diff` files; each file's added and removed lines are read with the app's one
// masker (lib/secrets.ts), so the same strings that are hidden on screen are the ones counted here. What is kept is a
// count per file and nothing of the key itself: a file with a key in it makes a commit or a push ask first, at every
// level of Kit's dial (`holdsSecret` in @manut/member-grants).
import type { DiffFile } from "../lib/protocol";
import { maskSecrets } from "../lib/secrets";

/** Whether `line` holds something the masker hides. */
export const holdsKey = (line: string): boolean => maskSecrets(line) !== line;

/** The keys each file holds after `files` are applied on top of `before`: a line added with a key counts one, a line
 *  taken out with a key takes one away, and a deleted file holds none. Only files that still hold one are kept. */
export function keysAfter(before: Readonly<Record<string, number>>, files: readonly DiffFile[]): Record<string, number> {
  const after: Record<string, number> = { ...before };
  for (const f of files) {
    if (f.kind === "delete") {
      delete after[f.path];
      continue;
    }
    let n = after[f.path] ?? 0;
    for (const l of f.lines) {
      if (l.startsWith("+") && holdsKey(l.slice(1))) n++;
      else if (l.startsWith("-") && holdsKey(l.slice(1))) n--;
    }
    if (n > 0) after[f.path] = n;
    else delete after[f.path];
  }
  return after;
}

/** The files that hold a key, in name order. */
export const keyFiles = (keys: Readonly<Record<string, number>>): string[] => Object.keys(keys).sort();
