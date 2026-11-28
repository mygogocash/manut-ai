// What the Diff in the pane beside a lane shows, and how it is walked (item 146). The Diff has three scopes: All changes, the list it
// has always been (everything since the lane started); Not committed, the folder against HEAD; and Commits, the lane's own commits,
// each its own section with its files (laneFolder.ts `LaneReview`, the shell's `lane_review`). Each scope is a list of sections of
// files, and the files can be read as the list or one at a time, with Prev and Next and the file's place ("2 of 7") in whatever
// the scope lists. Nothing here reads the folder or draws: it turns what was read into what the view shows.
import type { DiffFile } from "../lib/protocol";
import type { LaneReview } from "./laneFolder";

export type Scope = "all" | "uncommitted" | "commits";
export const SCOPES: readonly Scope[] = ["all", "uncommitted", "commits"];

/** The whole list the Diff has always shown: the files, and how many more the shell had no room to list. */
export interface WholeList {
  files: DiffFile[];
  moreFiles: number;
}

/** One group of files. `id` is `all`, `uncommitted` or a commit's short id, which a file's key starts with. A commit's section names
 *  the commit; `unread` says its files could not be read, which is not the same as it having none. */
export interface Section {
  id: string;
  commit?: { id: string; subject: string; unread: boolean };
  files: DiffFile[];
  moreFiles: number;
}

/** The sections a scope lists. All changes is one section, with no heading, as the list always was; Not committed is one; Commits
 *  is one for each commit, newest first. A scope that needs the review lists nothing until it has been read. */
export function sectionsOf(scope: Scope, whole: WholeList, review: LaneReview | null): Section[] {
  if (scope === "all") return [{ id: "all", files: whole.files, moreFiles: whole.moreFiles }];
  if (!review) return [];
  if (scope === "uncommitted") return [{ id: "uncommitted", files: review.uncommitted.files, moreFiles: review.uncommitted.moreFiles }];
  return review.commits.map((c) => ({ id: c.id, commit: { id: c.id, subject: c.subject, unread: c.unread }, files: c.files, moreFiles: c.moreFiles }));
}

/** A file and the section it is in, with a key that names both: a file changed in two commits is two entries. */
export interface Entry {
  key: string;
  section: Section;
  file: DiffFile;
}

/** Every file the sections hold, in the order they are drawn: what Prev and Next walk. */
export const entriesOf = (sections: readonly Section[]): Entry[] => sections.flatMap((section) => section.files.map((file) => ({ key: `${section.id}\u0000${file.path}`, section, file })));

/** The place (from 0) of the file shown by itself, among `entries`. The list is read again as the lane works, and the file that
 *  changed last comes first, so the place follows the file by its `key` while it is in the list; once it is gone, the place the
 *  person was at, held inside the list. -1 for an empty list. */
export function placeOf(entries: readonly Entry[], key: string | null, was: number): number {
  if (entries.length === 0) return -1;
  const at = key === null ? -1 : entries.findIndex((e) => e.key === key);
  return at >= 0 ? at : Math.min(Math.max(was, 0), entries.length - 1);
}

/** Prev (`-1`) and Next (`1`) from `place` among `count` files: they stop at the ends. */
export const stepPlace = (place: number, count: number, by: 1 | -1): number => Math.min(Math.max(place + by, 0), Math.max(count - 1, 0));

/** Where the file shown by itself is: its key and its last place (`placeOf`). */
export interface Current {
  key: string | null;
  was: number;
}
