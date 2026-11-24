// A lane's branch. When Kit starts a piece of work in a project, the lane gets a branch of its own, named from the work
// (`kit/promptpay-qr`) and made from the branch the folder is on, so what Kit changes is never written to the
// developer's own branch. The shell makes it (`lane_branch` in src-tauri/src/lane.rs); what is decided here is the
// name, and whether to make one at all. Pure: nothing runs and nothing is looked up.
//
// A folder has one checkout, so two lanes working in it at once cannot each have a branch: the one that starts second
// joins the branch the first is working on, which is safe (the developer's branch is still not written to) and says so
// on its row. A lane started after the earlier one stopped gets its own, made from where the folder is.

/** The folder every branch Kit makes is in, so the developer sees at once which branches are Kit's. */
export const LANE_FOLDER = "kit/";

/** What a lane knows of its branch: the one it works on, the branch it was made from, and that it is shared with a lane
 *  that was working in the same folder. */
export interface LaneBranch {
  name: string;
  base: string;
  shared?: true;
}

/** Words a title is padded with, which say nothing of the work. */
const SMALL = new Set(
  "a an the to of in on at for and or with from into by as is it its this that these those my our your me we you i so be are was were do does can could would should will please what why how when where which who there here if then".split(" "),
);

/** The most words a name takes, and the longest the words may be together. A branch name is read in a list of them. */
const WORDS_MAX = 4;
const SLUG_MAX = 40;

/** `title` as the words a branch name is made of: lower case letters and numbers of the Latin alphabet, accents taken
 *  off (café is cafe). Words in another script are left out, since a name that git, every file system and every shell
 *  take is what the shell makes; a title that is all in another script gets `work`. */
function slug(title: string): string {
  const words = (title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !SMALL.has(w));
  let out = "";
  for (const w of words.slice(0, WORDS_MAX)) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > SLUG_MAX) {
      // the first word alone may be too long: cut it, and take no more
      if (!out) out = w.slice(0, SLUG_MAX);
      break;
    }
    out = next;
  }
  return out || "work";
}

/** The names to try for a lane called `title`, in order: `kit/promptpay-qr`, then the same with `-2`, `-3` … for a
 *  branch that is taken. The shell makes the first that no branch has. */
export function laneBranchNames(title: string, tries = 9): string[] {
  const base = `${LANE_FOLDER}${slug(title)}`;
  return Array.from({ length: Math.max(1, tries) }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
}

/** What to do about a lane's branch as the lane starts. */
export type LanePlan =
  /** Make the first of `names` that is free, from `base`, and switch the folder to it. */
  | { kind: "make"; names: string[]; base: string }
  /** The folder is on the branch of a lane that is working, so this lane works on it too. */
  | { kind: "join"; branch: string }
  /** The folder is not a repository, so there is no branch to make or to be made from. */
  | { kind: "none"; why: "no_repository" };

/** `current`: the branch the folder is on now (a short commit when it is detached, "" outside a repository).
 *  `others`: the other lanes in the folder, each with the branch it works on and whether it is working or waiting on
 *  the person now. */
export function planLaneBranch(input: { title: string; current: string; others: readonly { branch: string; busy: boolean }[] }): LanePlan {
  const { title, current, others } = input;
  if (!current) return { kind: "none", why: "no_repository" };
  if (others.some((o) => o.busy && o.branch !== "" && o.branch === current)) return { kind: "join", branch: current };
  return { kind: "make", names: laneBranchNames(title), base: current };
}
