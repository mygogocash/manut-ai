// Decides which of CI's jobs a run needs, so a change is checked by the jobs that can see it and no others (the owner,
// 25 Nov 2026: skip what is not used, so CI is faster). ci.yml's first job runs this and every other job reads its
// answer. It prints one `area=true|false` line for each area, for $GITHUB_OUTPUT.
//
// Two rules keep the skipping safe:
//
// - What changed is measured from the last commit CI passed on this branch, not from the push before this one. A run
//   that was cancelled by a newer push, or that failed, checked nothing for good, so its files are still in the next
//   run's list. Skipping a job therefore never skips a file that no green run has seen.
// - Whenever the answer is not certain, every job runs: no green run to measure from, a history that was rewritten, a
//   list too long for one answer from GitHub, a file no rule names, a request that failed.
//
// A branch CI has not passed on yet (a helper's, at its first push: the owner, 26 Nov 2026, wanted many agents' branches
// checked at once) is measured from the newest commit CI passed on main or a pilot branch that is in its history, as
// GitHub's comparison says ("ahead": that commit is an ancestor of the head). That commit's green run saw every file
// up to it, so only the branch's own changes are new. When none of the last few such commits is an ancestor, every job
// runs.
//
// One run per commit: a branch that CI runs on its pushes (main, pilot/*, cloud/*, and the helpers' feat/*, fix/*,
// refactor/*, test/*, docs/*, ci/* and chore/*) is checked by that run, so the pull request's run of the same commit
// skips every job instead of doing the work twice. A pull request from any other branch, or from a fork, has no push run
// and is checked by its own.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The areas ci.yml's jobs are tied to. `phones` is Web on phones and `e2e` the desktop's Playwright shards. */
export const AREAS = ["typecheck", "api", "web", "phones", "desktop", "e2e", "rust", "packages"];

const flags = (on) => Object.fromEntries(AREAS.map((area) => [area, on]));
const only = (...areas) => ({ ...flags(false), ...Object.fromEntries(areas.map((area) => [area, true])) });

/** The branch prefixes ci.yml runs on a push of (its `on.push.branches`, besides main). */
export const PUSH_PREFIXES = ["pilot/", "cloud/", "feat/", "fix/", "refactor/", "test/", "docs/", "ci/", "chore/"];

/** The branches ci.yml runs on a push of (its `on.push.branches`). */
export const pushRuns = (branch) => branch === "main" || PUSH_PREFIXES.some((prefix) => branch.startsWith(prefix));

/** The branches items are merged into: a commit CI passed on here is where a new helper's branch is measured from. */
export const integrates = (branch) => branch === "main" || branch.startsWith("pilot/");

/** What one changed file needs, or null for a file no rule names, which needs everything. The first rule that matches
 *  decides. */
function areasOfPath(path) {
  // CI's own parts and what every package installs from: everything.
  if (path === ".github/workflows/ci.yml" || path.startsWith(".github/actions/") ||
      path === ".github/scripts/changed-areas.mjs" ||
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".nvmrc", ".node-version"].includes(path) ||
      /^tsconfig[^/]*\.json$/.test(path)) return flags(true);
  // Words. The desktop's and the API's tests read the docs (a test walks every file for a retired name, others quote
  // docs/pilot-api.md), so those two run; nothing else can see a doc.
  if (path.endsWith(".md") || path.startsWith("docs/")) return only("desktop", "api");
  // The scripts the browser jobs run: the shards' split and the Playwright summary, which decides whether the shards
  // pass. Their tests are in the first job and the desktop's.
  if (path === ".github/scripts/e2e-shards.mjs" || path === ".github/scripts/playwright-summary.mjs") return only("desktop", "api", "e2e", "phones");
  // The other scripts and workflows are read by tests in the API's job (the deploy check) and the desktop's (the
  // release workflow's rules, the Playwright summary, the spec timings).
  if (path.startsWith(".github/scripts/") || path.startsWith(".github/workflows/")) return only("desktop", "api");
  if (path.startsWith(".github/") || path.startsWith(".claude/") || path.startsWith(".vscode/") ||
      [".gitignore", ".gitattributes", ".editorconfig", "LICENSE", "NOTICE"].includes(path)) return flags(false);
  // A shared package reaches every app that imports it.
  if (path.startsWith("packages/")) return only("typecheck", "packages", "api", "web", "phones", "desktop", "e2e");
  if (path.startsWith("apps/api/")) return only("typecheck", "api");
  // The API's job starts the pages Worker on the web app's build (its one-origin contract), so it sees the web app too.
  if (path.startsWith("apps/web/")) return only("typecheck", "web", "phones", "api");
  // The shell: Rust, and the desktop's unit tests, which read tauri.conf.json. Playwright runs the pages in a browser
  // and never the shell.
  if (path.startsWith("apps/desktop/src-tauri/")) return only("rust", "desktop");
  if (path.startsWith("apps/desktop/e2e/")) return only("typecheck", "e2e");
  if (path.startsWith("apps/desktop/")) return only("typecheck", "desktop", "e2e");
  return null;
}

/** What a list of changed files needs: each area any of them needs, and everything for a file no rule names. */
export function areasOf(paths) {
  const need = flags(false);
  for (const path of paths) {
    const one = areasOfPath(path);
    if (one === null) return flags(true);
    for (const area of AREAS) need[area] ||= one[area];
  }
  return need;
}

/** GitHub answers a comparison with 300 files at most; at this many the list may be cut short, so everything runs. */
export const MOST_FILES = 100;

/** How many green runs a new branch reads to find its starting point, and how many of their commits it compares. The
 *  newest runs include other helpers' branches, so the read is wide; each comparison is a request, so the tries are
 *  few. A branch made from an older pilot commit than these is run in full. */
export const GREEN_RUNS_READ = 100;
export const MOST_TRIES = 10;

/**
 * The answer for one run. `api(path)` reads GitHub's REST API as JSON and throws when it cannot.
 *
 * @param {{ event: string, repository: string, sha: string, branch: string }} run
 * @param {any} payload the event's payload (GITHUB_EVENT_PATH)
 * @param {(path: string) => Promise<any>} api
 * @returns {Promise<{ areas: Record<string, boolean>, why: string }>}
 */
export async function decide(run, payload, api) {
  const all = (why) => ({ areas: flags(true), why: `Every job runs: ${why}.` });
  try {
    let base;
    let head = run.sha;
    // A comparison already made while looking for a new branch's starting point, and where that point is.
    let known;
    let from = "the last commit CI passed on";
    if (run.event === "pull_request") {
      const pr = payload?.pull_request;
      if (!pr?.head?.sha || !pr?.base?.sha) return all("the pull request's commits could not be read");
      if (pr.head.repo?.full_name === run.repository && pushRuns(pr.head.ref ?? "")) {
        return { areas: flags(false), why: `No job runs here: the push to ${pr.head.ref} runs CI for this commit, and this run would repeat it.` };
      }
      base = pr.base.sha;
      head = pr.head.sha;
    } else if (run.event === "push") {
      const green = await api(`/repos/${run.repository}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(run.branch)}&event=push&status=success&per_page=1`);
      base = green?.workflow_runs?.[0]?.head_sha;
      if (!base) {
        const start = await startingPoint(run, api);
        if (typeof start === "string") return all(start);
        ({ base, diff: known, from } = start);
      } else if (base === head) return all("this commit is the one CI last passed on, and it was asked for again");
    } else {
      return all(`it was started as ${run.event}`);
    }
    const diff = known ?? await api(`/repos/${run.repository}/compare/${base}...${head}`);
    if (diff?.status !== "ahead") return all(`${head.slice(0, 7)} does not simply follow ${base.slice(0, 7)} (history was rewritten or merged back)`);
    const files = diff.files;
    if (!Array.isArray(files) || files.length === 0) return all("GitHub listed no changed file");
    if (files.length >= MOST_FILES) return all(`${files.length} or more files changed, more than one answer is trusted to list`);
    // A renamed file changed where it was as well as where it is.
    const paths = files.flatMap((file) => [file.filename, file.previous_filename].filter((name) => typeof name === "string"));
    const areas = areasOf(paths);
    const on = AREAS.filter((area) => areas[area]);
    const since = `${paths.length} path${paths.length === 1 ? "" : "s"} changed since ${base.slice(0, 7)}, ${from}`;
    return { areas, why: on.length === AREAS.length ? `Every job runs: ${since}, and they reach every area.` : on.length ? `Runs ${on.join(", ")}: ${since}.` : `No job runs: ${since}, and no job can see them.` };
  } catch (error) {
    return all(`what changed could not be read (${error instanceof Error ? error.message : "an error"})`);
  }
}

/**
 * Where a branch CI has not passed on yet is measured from: the newest commit CI passed on main or a pilot branch that
 * is an ancestor of the head, with GitHub's comparison of the two, or why every job runs instead.
 *
 * @returns {Promise<string | { base: string, diff: any, from: string }>}
 */
async function startingPoint(run, api) {
  const none = `CI has not passed on ${run.branch} yet`;
  const green = await api(`/repos/${run.repository}/actions/workflows/ci.yml/runs?event=push&status=success&per_page=${GREEN_RUNS_READ}`);
  const seen = new Set();
  const candidates = [];
  for (const each of green?.workflow_runs ?? []) {
    const sha = each?.head_sha;
    if (typeof sha !== "string" || seen.has(sha) || !integrates(each?.head_branch ?? "") || each.head_branch === run.branch) continue;
    seen.add(sha);
    candidates.push({ sha, branch: each.head_branch });
  }
  if (candidates.length === 0) return `${none}, nor on main or a pilot branch lately, so there is nothing to measure from`;
  for (const { sha, branch } of candidates.slice(0, MOST_TRIES)) {
    if (sha === run.sha) return `${none}, and this commit is one CI passed on ${branch}, asked for again here`;
    const diff = await api(`/repos/${run.repository}/compare/${sha}...${run.sha}`);
    // "ahead": the commit is in the head's history and the head has more. Anything else ("diverged", "behind") means
    // it is not a starting point, and an older one is tried.
    if (diff?.status === "ahead") return { base: sha, diff, from: `the newest commit CI passed on ${branch} that ${run.branch} holds` };
  }
  return `${none}, and none of the last ${Math.min(candidates.length, MOST_TRIES)} commits CI passed on main or a pilot branch is in its history`;
}

/** GitHub's REST API with the run's own token, which reads this repository only. */
async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${process.env.GH_TOKEN}`, "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const payload = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const { areas, why } = await decide(
    { event: env.GITHUB_EVENT_NAME ?? "", repository: env.GITHUB_REPOSITORY ?? "", sha: env.GITHUB_SHA ?? "", branch: env.GITHUB_REF_NAME ?? "" },
    payload,
    github,
  );
  // The answer for $GITHUB_OUTPUT on stdout, and why on stderr, where the job's log and its summary step read it.
  for (const area of AREAS) console.log(`${area}=${areas[area]}`);
  console.error(why);
}
