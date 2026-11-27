// Tests for the lead's merge on CI (.claude/skills/lead-merge/scripts/ci-wait.sh and finish-item.sh --ci), run by
// `node --test` (the root `pnpm test` does, and CI's Desktop tests job). The lead merges an item when CI is green on the
// exact commit that merges, so the rules that keep it exact are pinned: only a push's or a person's run counts, a failed
// or cancelled job refuses, and a commit that moved, was never pushed, or is not on top of the lead's branch never merges.
// They run against local repositories and a stand-in `gh`; nothing reaches GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude", "skills", "lead-merge", "scripts");
const scratch = mkdtempSync(join(tmpdir(), "lead-merge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Git with a fixed author and no config of the machine's (signing, hooks), as the scripts see it under a test HOME. */
const gitEnv = (home) => ({
  ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GH_TOKEN: "made-up",
});
const git = (env, cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();
const commit = (env, cwd, file, text) => {
  writeFileSync(join(cwd, file), text);
  git(env, cwd, "add", file);
  git(env, cwd, "commit", "-q", "-m", `change ${file}`);
  return git(env, cwd, "rev-parse", "HEAD");
};

/** A stand-in gh that answers `run list` and `run view` from JSON files in `dir`, applying --jq with jq as gh does. */
function fakeGh(dir) {
  mkdirSync(dir, { recursive: true });
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/bash
case "$1 $2" in
  "auth token") exit 1 ;;
  "run list") data="${dir}/runs.json" ;;
  "run view") data="${dir}/run-$3.json" ;;
  *) echo "unexpected gh $*" >&2; exit 3 ;;
esac
while [ $# -gt 0 ]; do if [ "$1" = "--jq" ]; then jq -r "$2" < "$data"; exit; fi; shift; done
cat "$data"
`);
  chmodSync(gh, 0o755);
  return dir;
}

describe("ci-wait.sh", () => {
  const home = join(scratch, "wait-home");
  mkdirSync(home, { recursive: true });
  const env = gitEnv(home);
  const origin = join(scratch, "wait-origin.git");
  git(env, scratch, "init", "-q", "--bare", origin);
  const work = join(scratch, "wait-work");
  git(env, scratch, "clone", "-q", origin, work);
  const sha = commit(env, work, "a.txt", "one\n");
  git(env, work, "push", "-q", "origin", "HEAD:refs/heads/feat/x");
  const job = (name, conclusion) => ({ name, status: "completed", conclusion, startedAt: "2026-11-26T09:00:00Z", completedAt: "2026-11-26T09:07:30Z" });

  function wait(runs, views, ...args) {
    const dir = fakeGh(join(scratch, `gh-${Math.random().toString(36).slice(2)}`));
    writeFileSync(join(dir, "runs.json"), JSON.stringify(runs));
    for (const [id, view] of Object.entries(views)) writeFileSync(join(dir, `run-${id}.json`), JSON.stringify(view));
    const out = spawnSync("bash", [join(scripts, "ci-wait.sh"), "feat/x", ...args], {
      env: { ...env, PATH: `${dir}:${process.env.PATH}`, CI_WAIT_REMOTE: origin, CI_WAIT_POLL: "0", CI_WAIT_TRIES: "1", CI_WAIT_MINUTES: "0" },
      encoding: "utf8",
    });
    return { status: out.status, out: out.stdout + out.stderr };
  }

  it("passes when every job that ran passed, a skipped one included, and prints each job", () => {
    const { status, out } = wait([{ databaseId: 7, event: "push" }],
      { 7: { status: "completed", conclusion: "success", jobs: [job("What changed", "success"), job("Desktop Rust (macos-latest)", "skipped"), job("Typecheck", "success")] } });
    assert.equal(status, 0, out);
    assert.match(out, new RegExp(`CI for feat/x at ${sha.slice(0, 7)}`));
    assert.match(out, /success\tTypecheck\t7m 30s/);
    assert.match(out, /skipped\tDesktop Rust \(macos-latest\)\n/);
    assert.match(out, /green: every job that ran passed/);
  });

  it("refuses a run with a failed or cancelled job, or one that ended cancelled", () => {
    const failed = wait([{ databaseId: 8, event: "push" }], { 8: { status: "completed", conclusion: "failure", jobs: [job("Desktop Playwright (shard 3 of 8)", "failure")] } });
    assert.equal(failed.status, 1);
    assert.match(failed.out, /not green on .*the run ended as failure/);
    // A job cancelled inside a run GitHub still calls a success is not a pass either.
    const cancelledJob = wait([{ databaseId: 9, event: "push" }], { 9: { status: "completed", conclusion: "success", jobs: [job("Typecheck", "cancelled")] } });
    assert.equal(cancelledJob.status, 1);
    assert.match(cancelledJob.out, /a job did not pass/);
  });

  it("counts a push's or a person's run only, never a pull request's, which skips every job", () => {
    const onlyPr = wait([{ databaseId: 10, event: "pull_request" }], { 10: { status: "completed", conclusion: "success", jobs: [] } });
    assert.equal(onlyPr.status, 2);
    assert.match(onlyPr.out, /no CI run of .* on feat\/x yet/);
    const byHand = wait([{ databaseId: 11, event: "pull_request" }, { databaseId: 12, event: "workflow_dispatch" }],
      { 12: { status: "completed", conclusion: "success", jobs: [job("Typecheck", "success")] } });
    assert.equal(byHand.status, 0, byHand.out);
    assert.match(byHand.out, /run 12:/);
  });

  it("refuses a commit that is not the branch's head on GitHub, and gives up on a run that does not finish", () => {
    const other = wait([], {}, "f".repeat(40));
    assert.equal(other.status, 2);
    assert.match(other.out, /feat\/x on GitHub is at .*, not fffffff: push the commit you mean to merge/);
    const slow = wait([{ databaseId: 13, event: "push" }], { 13: { status: "in_progress", conclusion: null, jobs: [] } });
    assert.equal(slow.status, 2);
    assert.match(slow.out, /did not finish in 0 minutes/);
  });
});

describe("finish-item.sh --ci", () => {
  /** A clone with the lead's worktree and an item's worktree where the scripts expect them, under a HOME of its own,
   *  and the script beside a stand-in ci-wait.sh that answers `verdict` (and may push while it "waits"). */
  function world(name) {
    const home = join(scratch, name);
    const env = gitEnv(home);
    const origin = join(home, "origin.git");
    mkdirSync(home, { recursive: true });
    git(env, home, "init", "-q", "--bare", origin);
    const repo = join(home, "Developer", "manut-ai");
    git(env, home, "clone", "-q", origin, repo);
    commit(env, repo, "base.txt", "base\n");
    git(env, repo, "push", "-q", "origin", "HEAD:refs/heads/pilot/week-1");
    const lead = join(home, ".t3", "worktrees", "manut-ai", "t3-0c461873-e8dd6bc2489b4766");
    git(env, repo, "worktree", "add", "-q", "-b", "feat/continue-pilot-week-1", lead, "HEAD");
    const item = join(home, ".t3", "worktrees", "manut-ai", "cc-item1-x");
    git(env, repo, "worktree", "add", "-q", "-b", "feat/x", item, "feat/continue-pilot-week-1");
    const head = commit(env, item, "item.txt", "item\n");
    git(env, item, "push", "-q", "-u", "origin", "feat/x");
    const bin = join(home, "scripts");
    mkdirSync(bin);
    copyFileSync(join(scripts, "finish-item.sh"), join(bin, "finish-item.sh"));
    writeFileSync(join(bin, "ci-wait.sh"), `#!/bin/bash
echo "$@" >> "${bin}/asked"
[ -n "\${WAIT_PUSHES:-}" ] && ( cd "${item}" && echo more > late.txt && git add late.txt && git commit -q -m late && git push -q origin feat/x )
exit "\${WAIT_VERDICT:-0}"
`);
    chmodSync(join(bin, "ci-wait.sh"), 0o755);
    const message = join(home, "message");
    writeFileSync(message, "Merge item 1\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n");
    // The lead's worktree is named each time (LEAD_WORKTREE); `extra` may take it away or point it elsewhere, and `at`
    // may hand the script another folder as the item's.
    const finish = (extra = {}, ...args) => {
      const at = extra.ITEM ?? item;
      const out = spawnSync("bash", [join(bin, "finish-item.sh"), ...args, at, message], { env: { ...env, LEAD_WORKTREE: lead, ...extra }, encoding: "utf8" });
      return { status: out.status, out: out.stdout + out.stderr };
    };
    const asked = () => (existsSync(join(bin, "asked")) ? readFileSync(join(bin, "asked"), "utf8") : "");
    const leadHead = () => git(env, lead, "rev-parse", "HEAD");
    return { env, repo, lead, item, head, finish, asked, leadHead };
  }

  it("merges the exact commit CI passed, then removes the item's worktree and branch", () => {
    const w = world("green");
    const before = w.leadHead();
    const { status, out } = w.finish({}, "--ci");
    assert.equal(status, 0, out);
    assert.equal(w.asked(), `feat/x ${w.head}\n`);
    assert.equal(git(w.env, w.lead, "rev-parse", "HEAD^2"), w.head);
    assert.equal(git(w.env, w.lead, "rev-parse", "HEAD^1"), before);
    assert.ok(!existsSync(w.item));
    assert.equal(git(w.env, w.repo, "ls-remote", "origin", "refs/heads/feat/x"), "");
  });

  it("merges nothing when CI is not green", () => {
    const w = world("red");
    const before = w.leadHead();
    const { status, out } = w.finish({ WAIT_VERDICT: "1" }, "--ci");
    assert.equal(status, 1);
    assert.match(out, /CI is not green on .*: nothing merged/);
    assert.equal(w.leadHead(), before);
    assert.ok(existsSync(w.item));
  });

  it("refuses a head GitHub does not have, so CI checks the commit that merges", () => {
    const w = world("unpushed");
    commit(w.env, w.item, "later.txt", "later\n");
    const { status, out } = w.finish({}, "--ci");
    assert.equal(status, 1);
    assert.match(out, /GitHub has feat\/x at .*, the worktree at .*: push it/);
    assert.equal(w.asked(), "");
  });

  it("refuses when the branch moved on GitHub while CI ran", () => {
    const w = world("moved");
    const before = w.leadHead();
    const { status, out } = w.finish({ WAIT_PUSHES: "1" }, "--ci");
    assert.equal(status, 1);
    assert.match(out, /moved (here|on GitHub) while CI ran: nothing merged/);
    assert.equal(w.leadHead(), before);
  });

  it("refuses an item that does not hold the lead's newest commit, before asking CI", () => {
    const w = world("behind");
    commit(w.env, w.lead, "lead.txt", "lead moved\n");
    const { status, out } = w.finish({}, "--ci");
    assert.equal(status, 1);
    assert.match(out, /merge feat\/continue-pilot-week-1 into feat\/x, push, and let CI \(or the gate\) check it again first/);
    assert.equal(w.asked(), "");
  });

  it("refuses without the lead's worktree named, merging and removing nothing", () => {
    const w = world("no-lead");
    const before = w.leadHead();
    const unset = w.finish({ LEAD_WORKTREE: "" }, "--ci");
    assert.equal(unset.status, 1);
    assert.match(unset.out, /set LEAD_WORKTREE to the lead's worktree/);
    const gone = w.finish({ LEAD_WORKTREE: join(w.repo, "no-such-folder") }, "--ci");
    assert.equal(gone.status, 1);
    assert.match(gone.out, /set LEAD_WORKTREE/);
    assert.equal(w.asked(), "");
    assert.equal(w.leadHead(), before);
    assert.ok(existsSync(w.item));
  });

  it("never takes the lead's own worktree as the item, so it is never removed", () => {
    const w = world("lead-as-item");
    const before = w.leadHead();
    const { status, out } = w.finish({ ITEM: w.lead }, "--ci");
    assert.equal(status, 1);
    assert.match(out, /the item's worktree is the lead's: nothing merged or removed/);
    assert.equal(w.asked(), "");
    assert.ok(existsSync(w.lead));
    assert.equal(w.leadHead(), before);
  });

  it("takes only a helper's worktree that start-item.sh made, never a session's shared one", () => {
    const w = world("shared");
    // A worktree a lead session works in, elsewhere than ~/.t3/worktrees/manut-ai/cc-item…, on a branch GitHub has.
    const shared = join(dirname(w.repo), "..", ".paradev", "worktrees", "manut-ai", "continue-session");
    git(w.env, w.repo, "worktree", "add", "-q", "-b", "feat/shared", shared, "feat/continue-pilot-week-1");
    commit(w.env, shared, "shared.txt", "shared\n");
    git(w.env, shared, "push", "-q", "-u", "origin", "feat/shared");
    const before = w.leadHead();
    const { status, out } = w.finish({ ITEM: shared }, "--ci");
    assert.equal(status, 1);
    assert.match(out, /is not a helper's worktree from start-item.sh/);
    assert.equal(w.asked(), "");
    assert.ok(existsSync(shared));
    assert.notEqual(git(w.env, w.repo, "ls-remote", "origin", "refs/heads/feat/shared"), "");
    assert.equal(w.leadHead(), before);
  });
});
