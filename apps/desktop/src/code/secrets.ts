// A key or a password typed into the code ("A secret found in the code" on the design canvas's StatesCodeDev board).
// Kit's changes reach the app as `tool.diff` files; each file's added lines are read with the app's one masker
// (lib/secrets.ts), so the same strings that are hidden on screen are the ones counted here. What is kept is a count per
// file and nothing of the key itself: a file with a key in it makes a commit or a push ask first, at every level of Kit's
// dial (`holdsSecret` in @manut/member-grants).
//
// Since item 117 that count is only half of it. A key written by a command (`cat .env >> notes.md`) comes in no file tool's
// diff, so a commit or a push the dial would let go alone first reads what is being saved: the lane's own diff, from the
// shell's read-only `lane_diff` (bounded, never through a filter or a text conversion, each file's diff already masked by
// the same masker), in `savedKeys`. A file it could not read whole, or a read that failed or took too long, counts as one that
// may hold a key, so the step asks. And nothing is ever taken away: a key taken out again is still in the lane's history,
// which a push sends.
import type { DiffFile } from "../lib/protocol";
import { maskSecrets } from "../lib/secrets";
import spec from "../lib/secrets.json";

/** Whether `line` holds something the masker hides. */
export const holdsKey = (line: string): boolean => maskSecrets(line) !== line;

/** The keys each file was given after `files` are applied on top of `before`: a line added with a key counts one. Nothing is
 *  taken away (item 117): a line taken out, a placeholder's line replaced or a file deleted leaves what was counted, since a
 *  key that was there may already be in a commit. Only files given one are kept. */
export function keysAfter(before: Readonly<Record<string, number>>, files: readonly DiffFile[]): Record<string, number> {
  const after: Record<string, number> = { ...before };
  for (const f of files) {
    let n = after[f.path] ?? 0;
    for (const l of f.lines) if (l.startsWith("+") && holdsKey(l.slice(1))) n++;
    if (n > 0) after[f.path] = n;
  }
  return after;
}

/** What a commit or a push would save, as far as keys go: the files an added line of which holds one, and whether some of it
 *  could not be read (`unread`), in which case the step asks as it does for a key. */
export interface SavedKeys {
  files: string[];
  unread: boolean;
}

/** The keys in the shell's `lane_diff` answer (src-tauri/src/lane_diff.rs): every file that differs from where the lane started,
 *  committed or not, each diff whole and already masked by the shell's twin of the masker, so a key reads as its mask. Every line
 *  of each diff is read, not the lines the Diff pane draws. A file with a note (binary, too large, left out at the read's budget,
 *  or one this version does not know) was not read, nor were files past the list (`more_files`): both make it `unread`. Null for
 *  an answer this does not understand, which the caller takes as no read at all. */
export function savedKeys(raw: unknown): SavedKeys | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.files)) return null;
  const files: string[] = [];
  let unread = typeof r.more_files === "number" && r.more_files > 0;
  for (const x of r.files) {
    if (!x || typeof x !== "object") return null;
    const o = x as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path) return null;
    if (o.note !== undefined && o.note !== null) unread = true;
    const diff = typeof o.diff === "string" ? o.diff : "";
    const added = diff.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++ ") && l.includes(spec.mask));
    if (added && !files.includes(o.path)) files.push(o.path);
  }
  return { files: files.sort(), unread };
}

/** How long a commit or a push waits for the read of what it saves before it asks instead. */
export const SAVED_READ_MS = 5_000;

/** `read()`, or null when it fails or has not answered within `ms`: the step then asks. */
export async function readSaved(read: () => Promise<SavedKeys | null>, ms: number = SAVED_READ_MS): Promise<SavedKeys | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)));
  try {
    return await Promise.race([read().catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The files that hold a key, in name order. */
export const keyFiles = (keys: Readonly<Record<string, number>>): string[] => Object.keys(keys).sort();
