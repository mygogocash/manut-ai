// What GitHub's `gh` does: which of its subcommands read, which open a pull request or issue, and which send.
// Its own file because it is one program's reading.
import { samePath, URL_LIKE } from "./paths";
import { has, isOpt, live, say, sends, textAfter, unknownProgram, v, type Verdict } from "./verdict";
import { type Where } from "./types";

/** A link gh would follow to a host other than GitHub's own, or a repository named with its host (`-R host/owner/repo`):
 *  gh then talks to that host, and the words it sends there can carry anything out. */
const ghElsewhere = (words: string[]) =>
  words.some((w, i) => {
    if (URL_LIKE.test(w) && !/^https?:\/\/(www\.)?github\.com(\/|$)/i.test(w)) return true;
    const repo = isOpt(w, "--repo") && w.includes("=") ? w.slice(w.indexOf("=") + 1) : w === "-R" || w === "--repo" ? (words[i + 1] ?? "") : /^-R./.test(w) ? w.slice(2) : null;
    return repo !== null && (URL_LIKE.test(repo) || repo.split("/").length > 2);
  });

export function gh(words: string[], where: Where): Verdict {
  const [, area, act] = words;
  const head = 3;
  // `gh api` is a web client: what it asks GitHub, or the host `--hostname` names, is up to the words
  if (area === "api" || has(words, "--hostname") || ghElsewhere(words)) return sends();
  // `--web` opens the person's browser on the page
  if (has(words, "--web", "-w")) return unknownProgram("gh");
  const text = textAfter(words, ["-t", "--title", "-b", "--body", "-m", "--message", "--subject", "-q", "--jq", "--template"]);
  const reads = ["list", "view", "status", "checks", "diff"];
  switch (area) {
    case "pr":
      if (act === "create") {
        // a request on a repository the words name, or one opened from another folder than the session's, which may be
        // another repository (item 120)
        if (words.some((w) => w === "-R" || /^-R./.test(w) || isOpt(w, "--repo"))) return { ...sends(), saves: true, sends: true };
        if (!samePath(where.cwd || where.root, where.root)) return { ...live(), saves: true, sends: true };
        // a body read from a file, or from a template file, which no read of the folder sees (item 120)
        const fromFile = words.some((w, i) => !text.has(i) && (["-F", "-T"].some((o) => w === o || (w.startsWith(o) && w.length > 2)) || isOpt(w, "--body-file") || isOpt(w, "--template")));
        return v("push", say("kit.say.pr"), head, { saves: true, sends: true, text, ...(fromFile ? { fromFile: true as const } : {}) });
      }
      if (act === "merge") return live();
      // it checks out the request's branch (item 120)
      if (act === "checkout") return v("change", say("kit.say.change"), head, { moves: true });
      return reads.includes(act ?? "") ? v("read", say("kit.say.history")) : sends();
    case "repo":
      if (act === "clone") return v("change", say("kit.say.change"), head, { moves: true });
      return ["view", "list"].includes(act ?? "") ? v("read", say("kit.say.history")) : sends();
    case "release":
      return ["list", "view"].includes(act ?? "") ? v("read", say("kit.say.history")) : live();
    case "workflow":
      return ["list", "view"].includes(act ?? "") ? v("read", say("kit.say.history")) : live();
    case "run":
    case "issue":
    case "search":
      return reads.includes(act ?? "") || area === "search" ? v("read", say("kit.say.history"), undefined, { text }) : sends();
    case "status":
      return v("read", say("kit.say.history"));
    default:
      return unknownProgram("gh");
  }
}
