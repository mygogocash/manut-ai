// The shapes the reader takes and gives (`Where`, `Say`, `Rule`, `ReadCommand`).
// They are their own file so that every other file of the reader can name them without importing one another.
import type { KitAction } from "@manut/member-grants";
import type { Key } from "../../i18n";

/** Where a command runs. */
export interface Where {
  /** The folder it runs in: the ask's own, else the session's. */
  cwd: string;
  /** The project's folder: the folder the session started in. */
  root: string;
  /** The home folder, for `~`. */
  home?: string;
  /** Folders the developer allowed Kit to read beside the project ("Allow this folder"). Kit changes nothing there. */
  allowed?: readonly string[];
  /** The branch the project has checked out, for a push that names none. */
  branch?: string;
  /** The folders a session's earlier commands may have left its shell in, besides `cwd` (item 116): absolute paths, and
   *  null for one that cannot be known. The line is read from `cwd` and from each of them, and the strictest reading
   *  speaks, so whether an agent keeps a `cd` for its next command never decides what the dial lets go. */
  from?: readonly (string | null)[];
  /** Tags the session has made (item 120): a push that names one by its bare name sends a tag. */
  tags?: readonly string[];
}

/** What a step does, in words: a dictionary key and its slots. */
export interface Say {
  key: Key;
  vars?: Record<string, string | number>;
}

/** What "Always allow in this project" keeps: a command's first words, or the whole command (`exact`), and the step it
 *  was kept for (item 116). A rule saved before it named its step has none. */
export interface Rule {
  words: string[];
  exact?: true;
  action?: KitAction;
}

export interface ReadCommand {
  action: KitAction;
  /** The paths it names outside the project and the allowed folders, as written. */
  outside: string[];
  /** It saves the change to the project's history or sends it (a commit, a push, a pull request). */
  saves: boolean;
  /** The rule "Always allow in this project" would keep, or null when none may be kept. */
  rule: Rule | null;
  say: Say;
  /** The folders the shell may be in once the line has run, absolute (null: one that cannot be known), for the
   *  session's next command (`foldersAfter`). */
  ends: (string | null)[];
  /** The line is only a `cd` to the project's or the session's folder, written in full: after it, that is where the
   *  shell is. */
  resets?: string;
  /** Once it has run, the branch checked out in the project's folder may not be the one read before it (item 120): a step
   *  switches, renames or detaches it, may leave the shell in another folder, or cannot be read at all. The session's next
   *  push that names no branch is then read with none, until the branch is read again from disk. */
  movesHead: boolean;
  /** It saves what a read of the folder made before it runs cannot see (item 120): a step beside the commit or the push
   *  writes files (`cp .env notes.txt && git add notes.txt && git commit …`), or a message or a body comes from a file. Such
   *  a step asks, as one whose read could not be made. */
  unseen: boolean;
  /** It sends what is saved to the remote (a push, a pull request): the commits it sends are read too (item 120). */
  sends: boolean;
  /** The tags it makes (item 120), for the session's later pushes. */
  tags: string[];
  /** It defines what a later command of the same shell runs (a function, an alias, a trap, or text read into the shell:
   *  `eval`, `source`, `.`), so no later `cd` to the project's folder says where the shell is (item 120). */
  defines: boolean;
}
