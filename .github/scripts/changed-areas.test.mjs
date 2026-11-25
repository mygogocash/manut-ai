// Tests for changed-areas.mjs, run by `node --test` (the root `pnpm test` does, and CI's first job). A wrong answer
// here would skip a check without anyone seeing, so the rules that keep the skipping safe are each pinned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AREAS, MOST_FILES, areasOf, decide, pushRuns } from "./changed-areas.mjs";

const on = (areas) => AREAS.filter((area) => areas[area]).sort();
const every = [...AREAS].sort();
const REPO = "mygogocash/manut-ai";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const files = (...names) => names.map((filename) => ({ filename }));
/** GitHub as a push run asks it: the last green run's commit, then the files changed since. */
const github = ({ green = BASE, status = "ahead", changed = files("docs/plan.md") } = {}) => {
  const asked = [];
  const api = async (path) => {
    asked.push(path);
    if (path.includes("/actions/workflows/ci.yml/runs")) return { workflow_runs: green ? [{ head_sha: green }] : [] };
    if (path.includes("/compare/")) return { status, files: changed };
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

  it("runs every app's jobs for a shared package, and never Rust, which imports none", () => {
    assert.deepEqual(on(areasOf(["packages/approval-core/src/index.ts"])), ["api", "desktop", "e2e", "packages", "phones", "typecheck", "web"]);
  });

  it("runs the two jobs whose tests read the docs for a change of words, and nothing heavy", () => {
    for (const path of ["docs/handoff.md", "docs/plan.md", "README.md", "CLAUDE.md", "apps/desktop/README.md", "apps/api/NOTES.md"]) {
      assert.deepEqual(on(areasOf([path])), ["api", "desktop"], path);
    }
  });

  it("runs the jobs that test the other scripts and workflows for a change to one", () => {
    assert.deepEqual(on(areasOf([".github/workflows/release-desktop.yml"])), ["api", "desktop"]);
    assert.deepEqual(on(areasOf([".github/scripts/check-dev-deploys.mjs"])), ["api", "desktop"]);
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

  it("runs everything when CI has never passed on the branch", async () => {
    const { api, asked } = github({ green: null });
    const { areas, why } = await decide(push, {}, api);
    assert.deepEqual(on(areas), every);
    assert.equal(asked.length, 1);
    assert.match(why, /^Every job runs: CI has not passed on pilot\/week-1 yet/);
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

describe("a pull request", () => {
  const pr = (head, base = { sha: BASE, repo: { full_name: REPO } }) => ({ pull_request: { head, base } });
  const run = { event: "pull_request", repository: REPO, sha: "c".repeat(40), branch: "1/merge" };

  it("skips every job when its branch is one CI runs on a push of: that run checks the same commit", async () => {
    for (const ref of ["pilot/week-1", "cloud/format", "main"]) {
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
    assert.deepEqual(on((await decide(run, pr({ sha: HEAD, ref: "feat/x", repo: { full_name: REPO } }), own.api)).areas), ["api", "phones", "typecheck", "web"]);
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
    assert.match(ci, /\n {2}push:\n {4}branches: \[main, "pilot\/\*\*", "cloud\/\*\*"\]\n/);
    assert.deepEqual(["main", "pilot/week-1", "cloud/format", "feat/x", "mainline"].map(pushRuns), [true, true, true, false, false]);
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
