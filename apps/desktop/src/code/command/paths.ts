// How a written path is read: split into its parts, made absolute, and compared with the project's folder.
// Its own file because every other file of the reader, and the editor, asks the same question of a path and none may answer it twice.
import { type Where } from "./types";

export const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A path as its root and its parts, `.` and `..` taken out. A Windows path compares without letter case. */
export function parts(path: string): { root: string; list: string[]; win: boolean } {
  const win = WIN_ABS.test(path);
  const root = win ? (path.startsWith("\\\\") ? "\\\\" : path.slice(0, 2).toLowerCase()) : path.startsWith("/") ? "/" : "";
  const list: string[] = [];
  for (const p of path.slice(win && root !== "\\\\" ? 2 : 0).split(win ? /[\\/]+/ : /\/+/)) {
    if (!p || p === ".") continue;
    if (p === "..") list.pop();
    else list.push(win ? p.toLowerCase() : p);
  }
  return { root, list, win };
}

/** Whether `inner` is `outer` or a path inside it, by whole folder names. */
export function within(inner: string, outer: string): boolean {
  const a = parts(inner);
  const b = parts(outer);
  if (a.root !== b.root || a.win !== b.win || a.list.length < b.list.length) return false;
  return b.list.every((p, i) => a.list[i] === p);
}

/** Whether the absolute path `path` is inside the project `root` or one of the `allowed` folders. */
export function insideProject(path: string, root: string, allowed: readonly string[]): boolean {
  return within(path, root) || allowed.some((f) => within(path, f));
}

export const isAbs = (p: string) => p.startsWith("/") || WIN_ABS.test(p);

/** The folder "Allow this folder" would add for `written`, a path as Kit wrote it: the folder a file is in, or the
 *  folder itself. Null when it cannot be known. Nothing is looked up on disk, so a name with an extension is a file. */
export function folderOf(written: string, where: Pick<Where, "cwd" | "home">): string | null {
  const abs = resolve(written, where.cwd, where.home);
  if (abs === null) return null;
  const p = parts(abs);
  const last = p.list[p.list.length - 1] ?? "";
  const list = /.\.[A-Za-z0-9]{1,8}$/.test(last) ? p.list.slice(0, -1) : p.list;
  const sep = p.win ? "\\" : "/";
  return p.root === "/" ? `/${list.join("/")}` : `${p.root}${sep}${list.join(sep)}`;
}

/** `word` as an absolute path from `cwd`, or null when it cannot be known (`~` with no home, `~user`). */
export function resolve(word: string, cwd: string, home: string | undefined): string | null {
  if (word === "~" || word.startsWith("~/")) return home ? home + word.slice(1) : null;
  if (word.startsWith("~")) return null;
  if (isAbs(word)) return word;
  return `${cwd.replace(/[\\/]+$/, "")}/${word}`;
}

/** The same folder as `b`, compared after `.` and `..` are taken out. */
export function samePath(a: string, b: string): boolean {
  return within(a, b) && within(b, a);
}

export const NULL_DEVICES = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "NUL"]);

export const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export const SCP_LIKE = /^[^\s/:@]+@[^\s/:]+:/;

/** A word that names a place on disk that could be outside the folder it runs in. A bare name (`build`) is inside
 *  wherever the command runs, so it is never one. */
export function pathLike(word: string): boolean {
  if (!word || URL_LIKE.test(word) || SCP_LIKE.test(word)) return false;
  return word.startsWith("~") || isAbs(word) || word === ".." || word.startsWith("../") || word.includes("/..") || word.startsWith("..\\");
}
