// Tests for changed-areas.mjs, run by `node --test` (the root `pnpm test` does, and CI's first job). A wrong answer
// here would skip a check without anyone seeing, so the rules that keep the skipping safe are each pinned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AREAS, MOST_FILES, MOST_TRIES, areasOf, decide, integrates, pushRuns } from "./changed-areas.mjs";

const on = (areas) => AREAS.filter((area) => areas[area]).sort();
const every = [...AREAS].sort();
const REPO = "mygogocash/manut-ai";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const files = (...names) => names.map((filename) => ({ filename }));
/** GitHub as a push run asks it: the last green run's commit on the branch, then the files changed since. A branch with
 *  no green run of its own asks for the newest green runs of every branch (`elsewhere`, newest first), and compares
 *  them with its head in turn (`statuses`, by commit; `status` for any other). */
const github = ({ green = BASE, status = "ahead", changed = files("docs/plan.md"), elsewhere = [], statuses = {} } = {}) => {
  const asked = [];
  const api = async (path) => {
    asked.push(path);
    if (path.includes("/actions/workflows/ci.yml/runs?branch=")) return { workflow_runs: green ? [{ head_sha: green }] : [] };
    if (path.includes("/actions/workflows/ci.yml/runs?")) return { workflow_runs: elsewhere.map(([head_branch, head_sha]) => ({ head_branch, head_sha })) };
    const compare = /\/compare\/([0-9a-f]+)\.\.\./.exec(path);
    if (compare) return { status: statuses[compare[1]] ?? status, files: changed };
    throw new Error(`unexpected ${path}`);
  };
  return { api, asked };
};
const push = { event: "push", repository: REPO, sha: HEAD, branch: "pilot/week-1" };

describe("what a changed file needs", () => {
  it("runs only the jobs that can see it", () => {
    assert.deepEqual(on(areasOf(["apps/api/src/feed.ts"])), ["api", "typecheck"]);
    assert.deepEqual(on(areasOf(["apps/web/src/App.tsx"])), ["api", "phones", "typecheck", "web"]);
    assert.deepEqual(on(areasOf(["apps/desktop/src/sessions/newMenu.ts"])), ["desktop", "e2e", "typecheck"]);
    assert.deepEqual(on(areasOf(["apps/desktop/e2e/kit-lanes.spec.ts"])), ["e2e", "typecheck"]);
    assert.deepEqual(on(areasOf(["apps/desktop/src-tauri/src/lib.rs"])), ["desktop", "rust"]);
    assert.deepEqual(on(areasOf(["apps/desktop/src-tauri/icons/icon.png"])), ["desktop", "rust"]);
  });

  it("runs every app's jobs for a shared package, and Rust only for the masker's, whose patterns the shell reads", () => {
    assert.deepEqual(on(areasOf(["packages/approval-core/src/index.ts"])), ["api", "desktop", "e2e", "packages", "phones", "typecheck", "web"]);
    for (const path of ["packages/mask-secrets/src/secrets.json", "packages/mask-secrets/test/secrets.cases.json",
      "packages/mask-secrets/src/index.ts"]) {
      assert.deepEqual(on(areasOf([path])), ["api", "desktop", "e2e", "packages", "phones", "rust", "typecheck", "web"], path);
    }
  });

  it("runs the two jobs whose tests read the docs for a change of words, and nothing heavy", () => {
    for (const path of ["docs/handoff.md", "docs/plan.md", "README.md", "CLAUDE.md", "apps/desktop/README.md", "apps/api/NOTES.md"]) {
      assert.deepEqual(on(areasOf([path])), ["api", "desktop"], path);
    }
  });

  it("runs the jobs that test the other scripts and workflows for a change to one", () => {
    assert.deepEqual(on(areasOf([".github/workflows/release-desktop.yml"])), ["api", "desktop"]);
    assert.deepEqual(on(areasOf([".github/scripts/check-dev-deploys.mjs"])), ["api", "desktop"]);
    assert.deepEqual(on(areasOf([".github/scripts/e2e-timings.mjs"])), ["api", "desktop"]);
  });

  it("runs the browser jobs too for the scripts they run: the shards' split and the summary that passes them", () => {
    for (const path of [".github/scripts/e2e-shards.mjs", ".github/scripts/playwright-summary.mjs"]) {
      assert.deepEqual(on(areasOf([path])), ["api", "desktop", "e2e", "phones"], path);
    }
    // New timings move files between shards, so the shards run on them.
    assert.deepEqual(on(areasOf(["apps/desktop/e2e/timings.json"])), ["e2e", "typecheck"]);
  });

  it("runs everything for CI's own parts and for what every package installs from", () => {
    for (const path of [".github/workflows/ci.yml", ".github/actions/setup-workspace/action.yml", ".github/scripts/changed-areas.mjs",
      "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"]) {
      assert.deepEqual(on(areasOf([path])), every, path);
    }
  });

  it("runs everything for a file no rule names, so a new folder is never skipped by default", () => {
    assert.deepEqual(on(areasOf(["apps/phone/src/main.ts"])), every);
    assert.deepEqual(on(areasOf(["scripts/release.sh"])), every);
    assert.deepEqual(on(areasOf(["docs/plan.md", "something-new.toml"])), every);
  });

  it("runs nothing for files no job reads", () => {
    assert.deepEqual(on(areasOf([".gitignore", ".claude/settings.json", ".github/dependabot.yml", "LICENSE"])), []);
  });

  it("runs the desktop's job, where their tests are, for the lead's merge scripts", () => {
    assert.deepEqual(on(areasOf([".claude/skills/lead-merge/scripts/ci-wait.sh"])), ["desktop"]);
    assert.deepEqual(on(areasOf([".claude/skills/lead-merge/SKILL.md"])), ["api", "desktop"]);
    assert.deepEqual(on(areasOf([".claude/skills/helper/scripts/x.sh"])), []);
  });

  it("adds up what several files need", () => {
    assert.deepEqual(on(areasOf(["docs/plan.md", "apps/desktop/src-tauri/Cargo.toml"])), ["api", "desktop", "rust"]);
    assert.deepEqual(on(areasOf([])), []);
  });
});

describe("a push", () => {
  it("is measured from the last commit CI passed on this branch, so a cancelled or failed run's files are still counted", async () => {
    const { api, asked } = github({ changed: files("docs/plan.md", "apps/api/src/feed.ts") });
    const { areas, why } = await decide(push, {}, api);
    assert.deepEqual(on(areas), ["api", "desktop", "typecheck"]);
    assert.match(asked[0], /\/actions\/workflows\/ci\.yml\/runs\?branch=pilot%2Fweek-1&event=push&status=success&per_page=1$/);
    assert.equal(asked[1], `/repos/${REPO}/compare/${BASE}...${HEAD}`);
    assert.match(why, /since aaaaaaa, the last commit CI passed on/);
  });

  it("counts a renamed file where it was and where it is", async () => {
    const { api } = github({ changed: [{ filename: "docs/old-notes.md", previous_filename: "apps/desktop/src-tauri/src/notes.rs" }] });
    assert.deepEqual(on((await decide(push, {}, api)).areas), ["api", "desktop", "rust"]);
  });

  it("runs everything when CI has never passed on the branch, nor lately on main or a pilot branch", async () => {
    const { api, asked } = github({ green: null, elsewhere: [["feat/other", "c".repeat(40)], ["cloud/format", "d".repeat(40)]] });
    const { areas, why } = await decide(push, {}, api);
    assert.deepEqual(on(areas), every);
    assert.equal(asked.length, 2);
    assert.match(asked[1], /\/actions\/workflows\/ci\.yml\/runs\?event=push&status=success&per_page=100$/);
    assert.match(why, /^Every job runs: CI has not passed on pilot\/week-1 yet, nor on main or a pilot branch lately/);
  });

  it("runs everything when history was rewritten or the list may be cut short or is empty", async () => {
    for (const status of ["diverged", "behind", "identical"]) {
      assert.deepEqual(on((await decide(push, {}, github({ status }).api)).areas), every, status);
    }
    const many = files(...Array.from({ length: MOST_FILES }, (_, i) => `docs/note-${i}.md`));
    assert.deepEqual(on((await decide(push, {}, github({ changed: many }).api)).areas), every);
    assert.deepEqual(on((await decide(push, {}, github({ changed: files(...many.slice(1).map((f) => f.filename)) }).api)).areas), ["api", "desktop"]);
    assert.deepEqual(on((await decide(push, {}, github({ changed: [] }).api)).areas), every);
    assert.deepEqual(on((await decide(push, {}, github({ changed: null }).api)).areas), every);
  });

  it("runs everything when GitHub cannot be read, and when the same commit is run again", async () => {
    const failing = async () => { throw new Error("GitHub answered 503"); };
    const { areas, why } = await decide(push, {}, failing);
    assert.deepEqual(on(areas), every);
    assert.match(why, /could not be read \(GitHub answered 503\)/);
    assert.deepEqual(on((await decide(push, {}, github({ green: HEAD }).api)).areas), every);
  });
});

describe("a helper's branch that CI has not passed on yet", () => {
  const helper = { event: "push", repository: REPO, sha: HEAD, branch: "feat/lane-diff" };
  const P1 = "1".repeat(40);
  const P2 = "2".repeat(40);
  const M1 = "3".repeat(40);

  it("is measured from the newest commit CI passed on a pilot branch or main that its history holds", async () => {
    // The newest green runs: another helper's, then pilot's newest (not in this branch: it was made earlier), then an
    // older pilot commit it was made from, then main.
    const { api, asked } = github({
      green: null,
      elsewhere: [["feat/other", "9".repeat(40)], ["pilot/week-1", P2], ["pilot/week-1", P2], ["pilot/week-1", P1], ["main", M1]],
      statuses: { [P2]: "diverged", [P1]: "ahead" },
      changed: files("apps/web/src/App.tsx"),
    });
    const { areas, why } = await decide(helper, {}, api);
    assert.deepEqual(on(areas), ["api", "phones", "typecheck", "web"]);
    // Its own green run first, then the list, then pilot's newest (diverged), then the one it holds. A commit listed
    // twice is compared once, and another helper's run is never a starting point.
    assert.deepEqual(asked.slice(2), [`/repos/${REPO}/compare/${P2}...${HEAD}`, `/repos/${REPO}/compare/${P1}...${HEAD}`]);
    assert.equal(asked.length, 4);
    assert.match(why, /since 1111111, the newest commit CI passed on pilot\/week-1 that feat\/lane-diff holds\.$/);
  });

  it("uses main's green commit when no pilot one is in its history", async () => {
    const { api } = github({ green: null, elsewhere: [["pilot/week-1", P1], ["main", M1]], statuses: { [P1]: "diverged", [M1]: "ahead" } });
    const { areas, why } = await decide(helper, {}, api);
    assert.deepEqual(on(areas), ["api", "desktop"]);
    assert.match(why, /since 3333333, the newest commit CI passed on main that feat\/lane-diff holds/);
  });

  it("runs everything when none of the commits it tries is in its history, and tries only a few", async () => {
    const many = Array.from({ length: MOST_TRIES + 5 }, (_, i) => ["pilot/week-1", i.toString(16).padStart(40, "a")]);
    const { api, asked } = github({ green: null, elsewhere: many, status: "diverged" });
    const { areas, why } = await decide(helper, {}, api);
    assert.deepEqual(on(areas), every);
    assert.equal(asked.filter((path) => path.includes("/compare/")).length, MOST_TRIES);
    assert.match(why, new RegExp(`none of the last ${MOST_TRIES} commits CI passed on main or a pilot branch is in its history`));
  });

  it("runs everything when its head is the very commit CI passed on a pilot branch, or the list cannot be read", async () => {
    const same = github({ green: null, elsewhere: [["pilot/week-1", HEAD]] });
    const { areas, why } = await decide(helper, {}, same.api);
    assert.deepEqual(on(areas), every);
    assert.match(why, /this commit is one CI passed on pilot\/week-1, asked for again here/);
    let calls = 0;
    const failing = async () => { if (++calls === 2) throw new Error("GitHub answered 502"); return { workflow_runs: [] }; };
    assert.match((await decide(helper, {}, failing)).why, /could not be read \(GitHub answered 502\)/);
  });

  it("keeps every rule of a measured run: a long list or an empty one still runs everything", async () => {
    const many = files(...Array.from({ length: MOST_FILES }, (_, i) => `docs/n-${i}.md`));
    assert.deepEqual(on((await decide(helper, {}, github({ green: null, elsewhere: [["pilot/week-1", P1]], changed: many }).api)).areas), every);
    assert.deepEqual(on((await decide(helper, {}, github({ green: null, elsewhere: [["pilot/week-1", P1]], changed: [] }).api)).areas), every);
  });

  it("is measured from its own last green run once it has one, as every branch is", async () => {
    const { api, asked } = github({ green: BASE, elsewhere: [["pilot/week-1", P1]] });
    await decide(helper, {}, api);
    assert.equal(asked[1], `/repos/${REPO}/compare/${BASE}...${HEAD}`);
    assert.equal(asked.length, 2);
  });
});

describe("a pull request", () => {
  const pr = (head, base = { sha: BASE, repo: { full_name: REPO } }) => ({ pull_request: { head, base } });
  const run = { event: "pull_request", repository: REPO, sha: "c".repeat(40), branch: "1/merge" };

  it("skips every job when its branch is one CI runs on a push of: that run checks the same commit", async () => {
    for (const ref of ["pilot/week-1", "cloud/format", "main", "feat/lane-diff", "ci/many-agents", "chore/deps"]) {
      const { api, asked } = github();
      const { areas, why } = await decide(run, pr({ sha: HEAD, ref, repo: { full_name: REPO } }), api);
      assert.deepEqual(on(areas), [], ref);
      assert.equal(asked.length, 0);
      assert.match(why, new RegExp(`the push to ${ref} runs CI for this commit`));
    }
  });

  it("is checked by its own run when no push run covers it: another branch here, or a fork with the same branch name", async () => {
    const changed = files("apps/web/src/App.tsx");
    const own = github({ changed });
    assert.deepEqual(on((await decide(run, pr({ sha: HEAD, ref: "spike/x", repo: { full_name: REPO } }), own.api)).areas), ["api", "phones", "typecheck", "web"]);
    assert.deepEqual(own.asked, [`/repos/${REPO}/compare/${BASE}...${HEAD}`]);
    const fork = github({ changed });
    assert.deepEqual(on((await decide(run, pr({ sha: HEAD, ref: "pilot/week-1", repo: { full_name: "someone/manut-ai" } }), fork.api)).areas), ["api", "phones", "typecheck", "web"]);
  });

  it("runs everything when its commits cannot be read", async () => {
    assert.deepEqual(on((await decide(run, {}, github().api)).areas), every);
  });
});

describe("any other start", () => {
  it("runs everything when a person starts CI by hand", async () => {
    const { api, asked } = github();
    assert.deepEqual(on((await decide({ ...push, event: "workflow_dispatch" }, {}, api)).areas), every);
    assert.equal(asked.length, 0);
  });
});

describe("ci.yml and this script agree", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

  it("names the branches a push runs on as pushRuns does", () => {
    const branches = /\n {2}push:\n {4}branches: \[([^\]\n]+)\]\n/.exec(ci)?.[1].split(", ").map((name) => name.replace(/"/g, ""));
    assert.deepEqual(branches, ["main", "pilot/**", "cloud/**", "feat/**", "fix/**", "refactor/**", "test/**", "docs/**", "ci/**", "chore/**"]);
    for (const pattern of branches) {
      const example = pattern.replace("**", "some/branch");
      assert.equal(pushRuns(example), true, example);
    }
    assert.deepEqual(["main", "pilot/week-1", "feat/x", "ci/many-agents", "mainline", "spike/x", "feature/x", "docs"].map(pushRuns),
      [true, true, true, true, false, false, false, false]);
    assert.deepEqual(["main", "pilot/week-1", "cloud/format", "feat/x", "mainline"].map(integrates), [true, true, false, false, false]);
  });

  it("saves the Rust cache from pushes to main and the pilot branches only, which every helper branch cannot fill", () => {
    assert.match(ci, /\n {10}save-if: \$\{\{ github\.event_name == 'push' && \(github\.ref == 'refs\/heads\/main' \|\| startsWith\(github\.ref, 'refs\/heads\/pilot\/'\)\) \}\}\n/);
  });

  it("never cancels a run on main or a pilot branch, and cancels a superseded one anywhere else", () => {
    assert.match(ci, /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' && !startsWith\(github\.ref, 'refs\/heads\/pilot\/'\) \}\}\n/);
    assert.doesNotMatch(ci, /\n {2}queue: max/);
  });

  it("ties every job but the first to an area this script answers, and hands every area on", () => {
    const jobs = ci.slice(ci.indexOf("\njobs:\n") + "\njobs:\n".length).split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/)
      .map((text) => ({ name: /^ {2}([a-z][a-z0-9-]*):/.exec(text)[1], text: `\n${text}` }));
    assert.deepEqual(jobs.map((job) => job.name), ["changes", "typecheck", "api", "web", "web-phones", "desktop", "packages", "rust", "e2e", "e2e-summary"]);
    const used = new Set();
    for (const job of jobs.slice(1)) {
      const area = /needs\.changes\.outputs\.([a-z0-9]+) == 'true'/.exec(job.text)?.[1];
      assert.ok(area && AREAS.includes(area), `${job.name} reads an area`);
      assert.match(job.text, /\n {4}needs: (changes|\[changes, e2e\])\n/, `${job.name} waits for the first job`);
      used.add(area);
    }
    assert.deepEqual([...used].sort(), every);
    for (const area of AREAS) assert.match(jobs[0].text, new RegExp(`\\n {6}${area}: \\$\\{\\{ steps\\.areas\\.outputs\\.${area} \\}\\}\\n`), area);
  });
});
