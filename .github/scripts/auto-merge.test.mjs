// Tests for the lead's automatic merge of low-risk work (.claude/skills/lead-merge/scripts/auto-merge.sh and
// auto-merge-dependabot.sh, item 130). The rules that keep it safe are pinned: nothing merges unless the classifier
// (the LEAD's copy of it) says low AND CI is green on the exact head, a `low` answer never skips CI, a dry run changes
// nothing, and a branch cannot loosen the classifier that judges it. Everything runs against temporary git
// repositories, a stand-in `gh` and a stand-in ci-wait.sh on PATH or beside the script; nothing reaches GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, "..", "..", ".claude", "skills", "lead-merge", "scripts");
const classifier = join(here, "merge-risk.mjs");
const scratch = mkdtempSync(join(tmpdir(), "auto-merge-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The scripts run `node`; under a made-up HOME a version manager's shim would find nothing, so the running node's own
// folder leads PATH.
const gitEnv = (home) => ({
  ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GH_TOKEN: "made-up",
});
const git = (env, cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();
/** Writes files (a map of path to text) and commits them; returns the new commit. */
const commitFiles = (env, cwd, files, message = "change") => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(env, cwd, "add", "-A");
  git(env, cwd, "commit", "-q", "-m", message);
  return git(env, cwd, "rev-parse", "HEAD");
};
const pkg = (version) => JSON.stringify({ name: "x", dependencies: { left: version } }, null, 2) + "\n";
const BASE = { "docs/a.md": "one\n", "src/a.ts": "export const a = 1;\n", "package.json": pkg("^1.0.0") };
const MESSAGE = "Merge item 9\n\nRisk: refactor\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n";
const PLAIN = "Merge item 9\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n";

describe("auto-merge.sh", () => {
  /** The lead's and an item's worktrees where the script expects them, under a HOME of its own, the real classifier
   *  committed in the lead's branch, and a stand-in ci-wait.sh beside the script that answers WAIT_VERDICT. */
  function world(name, itemFiles, { message = PLAIN, itemBranchFirst = false } = {}) {
    const home = join(scratch, name);
    const env = gitEnv(home);
    const origin = join(home, "origin.git");
    mkdirSync(home, { recursive: true });
    git(env, home, "init", "-q", "--bare", origin);
    const repo = join(home, "Developer", "manut-ai");
    git(env, home, "clone", "-q", origin, repo);
    commitFiles(env, repo, BASE, "base");
    mkdirSync(join(repo, ".github", "scripts"), { recursive: true });
    copyFileSync(classifier, join(repo, ".github", "scripts", "merge-risk.mjs"));
    git(env, repo, "add", "-A");
    git(env, repo, "commit", "-q", "-m", "classifier");
    git(env, repo, "push", "-q", "origin", "HEAD:refs/heads/pilot/week-1");
    const lead = join(home, ".t3", "worktrees", "manut-ai", "t3-0c461873-e8dd6bc2489b4766");
    git(env, repo, "worktree", "add", "-q", "-b", "feat/continue-pilot-week-1", lead, "HEAD");
    const item = join(home, ".t3", "worktrees", "manut-ai", "cc-item9-x");
    git(env, repo, "worktree", "add", "-q", "-b", "feat/x", item, "feat/continue-pilot-week-1");
    const head = commitFiles(env, item, itemFiles, "item");
    git(env, item, "push", "-q", "-u", "origin", "feat/x");
    if (itemBranchFirst) commitFiles(env, lead, { "lead.txt": "moved\n" }, "lead moved");
    const bin = join(home, "scripts");
    mkdirSync(bin);
    for (const f of ["auto-merge.sh", "finish-item.sh"]) copyFileSync(join(scripts, f), join(bin, f));
    writeFileSync(join(bin, "ci-wait.sh"), `#!/bin/bash\necho "$@" >> "${bin}/asked"\nexit "\${WAIT_VERDICT:-0}"\n`);
    chmodSync(join(bin, "ci-wait.sh"), 0o755);
    const msg = join(home, "message");
    writeFileSync(msg, message);
    const merge = (extra = {}, ...args) => {
      const out = spawnSync("bash", [join(bin, "auto-merge.sh"), ...args, item, msg], { env: { ...env, LEAD_WORKTREE: lead, ...extra }, encoding: "utf8" });
      return { status: out.status, out: out.stdout + out.stderr };
    };
    const asked = () => (existsSync(join(bin, "asked")) ? readFileSync(join(bin, "asked"), "utf8") : "");
    const leadHead = () => git(env, lead, "rev-parse", "HEAD");
    const pilot = () => git(env, repo, "ls-remote", "origin", "refs/heads/pilot/week-1").split("\t")[0];
    return { env, repo, lead, item, head, merge, asked, leadHead, pilot, msg };
  }

  it("merges a documentation change on a green run of the exact head, pushes the lead's branch, and clears the item", () => {
    const w = world("docs-green", { "docs/a.md": "two\n" });
    const before = w.leadHead();
    const { status, out } = w.merge();
    assert.equal(status, 0, out);
    assert.match(out, /^low\n/);
    assert.match(out, /pushed feat\/continue-pilot-week-1 to pilot\/week-1/);
    assert.equal(git(w.env, w.lead, "rev-parse", "HEAD^2"), w.head);
    assert.equal(git(w.env, w.lead, "rev-parse", "HEAD^1"), before);
    assert.equal(w.pilot(), w.leadHead());
    assert.ok(!existsSync(w.item));
    // ci-wait ran for the exact head: once here, once inside finish-item --ci.
    assert.equal(w.asked(), `feat/x ${w.head}\nfeat/x ${w.head}\n`);
  });

  it("never skips CI: a low change with a red run merges nothing and pushes nothing", () => {
    const w = world("docs-red", { "docs/a.md": "two\n" });
    const before = w.leadHead();
    const pilotBefore = w.pilot();
    const { status, out } = w.merge({ WAIT_VERDICT: "1" });
    assert.equal(status, 1);
    assert.match(out, /auto-merge refused: CI is not green on/);
    assert.equal(w.leadHead(), before);
    assert.equal(w.pilot(), pilotBefore);
    assert.ok(existsSync(w.item));
  });

  it("refuses a change the classifier calls review, says why, and never asks CI", () => {
    const w = world("source", { "src/a.ts": "export const a = 2;\n" });
    const before = w.leadHead();
    const { status, out } = w.merge();
    assert.equal(status, 1);
    assert.match(out, /^review\n/);
    assert.match(out, /review\tsrc\/a\.ts\tno rule covers it/);
    assert.match(out, /auto-merge refused: the classifier says review, not low: the lead reviews this one/);
    assert.equal(w.asked(), "");
    assert.equal(w.leadHead(), before);
  });

  it("merges source only when the message file declares Risk: refactor", () => {
    const w = world("refactor", { "src/a.ts": "export const a = 2;\n" }, { message: MESSAGE });
    const { status, out } = w.merge();
    assert.equal(status, 0, out);
    assert.equal(w.pilot(), w.leadHead());
  });

  it("refuses a minor bump's neighbour: a major bump is review, a minor one low", () => {
    const major = world("dep-major", { "package.json": pkg("^2.0.0") });
    assert.equal(major.merge().status, 1);
    const minor = world("dep-minor", { "package.json": pkg("^1.4.0") });
    const { status, out } = minor.merge();
    assert.equal(status, 0, out);
  });

  it("judges with the lead's classifier, so a branch that loosens its own is still review", () => {
    const w = world("loosened", { "docs/a.md": "two\n", ".github/scripts/merge-risk.mjs": 'console.log("low"); process.exit(0);\n' });
    const before = w.leadHead();
    const { status, out } = w.merge();
    assert.equal(status, 1);
    assert.match(out, /review\t\.github\/scripts\/merge-risk\.mjs/);
    assert.equal(w.leadHead(), before);
    assert.equal(w.asked(), "");
  });

  it("refuses a change to CI or the agents' rules even with the refactor trailer", () => {
    const w = world("rules", { ".claude/skills/x/SKILL.md": "x\n", "src/a.ts": "export const a = 2;\n" }, { message: MESSAGE });
    const { status, out } = w.merge();
    assert.equal(status, 1);
    assert.match(out, /review\t\.claude\/skills\/x\/SKILL\.md/);
  });

  it("with --dry-run prints the decision and changes nothing, CI untouched", () => {
    const w = world("dry", { "docs/a.md": "two\n" });
    const before = w.leadHead();
    const { status, out } = w.merge({}, "--dry-run");
    assert.equal(status, 0, out);
    assert.match(out, /^low\n/);
    assert.match(out, /dry run: low risk; CI was not waited for and nothing was merged/);
    assert.equal(w.asked(), "");
    assert.equal(w.leadHead(), before);
    assert.ok(existsSync(w.item));
    const refused = world("dry-review", { "src/a.ts": "export const a = 2;\n" }).merge({}, "--dry-run");
    assert.equal(refused.status, 1);
  });

  it("with --no-push merges and leaves the lead's branch for the lead", () => {
    const w = world("nopush", { "docs/a.md": "two\n" });
    const pilotBefore = w.pilot();
    const { status, out } = w.merge({}, "--no-push");
    assert.equal(status, 0, out);
    assert.match(out, /not pushed \(--no-push\)/);
    assert.equal(w.pilot(), pilotBefore);
    assert.notEqual(w.leadHead(), pilotBefore);
  });

  it("refuses an item that does not hold the lead's newest commit, and a message with no Co-Authored-By", () => {
    const behind = world("behind", { "docs/a.md": "two\n" }, { itemBranchFirst: true });
    const r = behind.merge();
    assert.equal(r.status, 1);
    assert.match(r.out, /is not in feat\/x: merge it in, push, and ask again/);
    const bare = world("bare", { "docs/a.md": "two\n" }, { message: "Merge item 9\n" });
    assert.match(bare.merge().out, /no Co-Authored-By line/);
    assert.equal(bare.asked(), "");
  });

  it("refuses an item worktree with uncommitted files, and a branch that is main or a pilot branch", () => {
    const w = world("dirty", { "docs/a.md": "two\n" });
    writeFileSync(join(w.item, "stray.txt"), "x");
    assert.match(w.merge().out, /uncommitted files/);
    const p = world("pilot-branch", { "docs/a.md": "two\n" });
    git(p.env, p.item, "checkout", "-q", "-b", "pilot/other");
    assert.match(p.merge().out, /pilot\/other is not an item branch/);
  });

  it("refuses a head that was never pushed, through finish-item's own check", () => {
    const w = world("unpushed", { "docs/a.md": "two\n" });
    commitFiles(w.env, w.item, { "docs/b.md": "late\n" }, "late");
    const before = w.leadHead();
    const { status } = w.merge();
    assert.equal(status, 1);
    assert.equal(w.leadHead(), before);
  });

  it("refuses without the lead's worktree named: no classifier read, no CI asked, nothing merged", () => {
    const w = world("no-lead", { "docs/a.md": "two\n" });
    const before = w.leadHead();
    const { status, out } = w.merge({ LEAD_WORKTREE: "" });
    assert.equal(status, 1);
    assert.match(out, /auto-merge refused: set LEAD_WORKTREE to the lead's worktree/);
    assert.equal(w.asked(), "");
    assert.equal(w.leadHead(), before);
    assert.ok(existsSync(w.item));
  });
});

/** A stand-in gh for the Dependabot script: lists pull requests from prs.json, answers run list and run view from files
 *  (runs-<sha>.json for a commit, run-<id>.json), and records `pr merge` and `api` calls; GH_REFUSE=1 makes pr merge fail; async-put.json is the merge-async answer (async-put.fail
 *  makes it exit 1, as gh does for a 409 or 400) and each line of async-status answers one poll. */
function fakeGh(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "gh"), `#!/bin/bash
echo "$@" >> "${dir}/calls"
jqarg() { while [ $# -gt 0 ]; do if [ "$1" = "--jq" ]; then echo "$2"; return; fi; shift; done; }
commit() { while [ $# -gt 0 ]; do if [ "$1" = "--commit" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "auth token") exit 1 ;;
  "pr list") f="${dir}/prs.json" ;;
  "run list") f="${dir}/runs-$(commit "$@").json"; [ -f "$f" ] || { echo "[]" > "$f"; } ;;
  "run view") f="${dir}/run-$3.json" ;;
  "pr merge") [ -n "\${GH_REFUSE:-}" ] && exit 1; exit 0 ;;
  "api -X") f="${dir}/async-put.json"; [ -f "$f" ] || echo '{"status":"pending","details":{"uuid":"u1"}}' > "$f"
            cat "$f"; [ -f "${dir}/async-put.fail" ] && exit 1; exit 0 ;;
  "api repos/"*"/merge-async/"*) l=$(head -1 "${dir}/async-status" 2>/dev/null); sed -i.bak 1d "${dir}/async-status" 2>/dev/null; echo "\${l:-pending}"; exit 0 ;;
  *) echo "unexpected gh $*" >&2; exit 3 ;;
esac
jq -r "$(jqarg "$@")" < "$f"
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

describe("auto-merge-dependabot.sh", () => {
  const job = (name, conclusion) => ({ name, status: "completed", conclusion, startedAt: "2026-11-26T09:00:00Z", completedAt: "2026-11-26T09:05:00Z" });

  /** An origin with pilot/week-1, a clone and a lead worktree holding the classifier, and a pull request per entry of
   *  `prs`: a branch dependabot/... and refs/pull/N/head at one commit, with its run recorded as `run`
   *  (undefined for none, "success", "failure", or "running"). */
  function world(name, prs) {
    const home = join(scratch, name);
    const env = gitEnv(home);
    const origin = join(home, "origin.git");
    mkdirSync(home, { recursive: true });
    git(env, home, "init", "-q", "--bare", origin);
    const repo = join(home, "Developer", "manut-ai");
    git(env, home, "clone", "-q", origin, repo);
    commitFiles(env, repo, BASE, "base");
    mkdirSync(join(repo, ".github", "scripts"), { recursive: true });
    copyFileSync(classifier, join(repo, ".github", "scripts", "merge-risk.mjs"));
    git(env, repo, "add", "-A");
    git(env, repo, "commit", "-q", "-m", "classifier");
    git(env, repo, "push", "-q", "origin", "HEAD:refs/heads/pilot/week-1");
    const lead = join(home, ".t3", "worktrees", "manut-ai", "t3-0c461873-e8dd6bc2489b4766");
    git(env, repo, "worktree", "add", "-q", "-b", "feat/continue-pilot-week-1", lead, "HEAD");
    const bin = fakeGh(join(home, "bin"));
    const list = [];
    prs.forEach((pr, i) => {
      const number = i + 1;
      const branch = `dependabot/npm/${pr.name}`;
      const work = join(home, `work-${number}`);
      git(env, home, "clone", "-q", "-b", "pilot/week-1", origin, work);
      const sha = commitFiles(env, work, pr.files, pr.name);
      git(env, work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      git(env, work, "push", "-q", "origin", `HEAD:refs/pull/${number}/head`);
      list.push({ number, title: `Bump ${pr.name}`, headRefName: branch, headRefOid: sha });
      if (pr.run) {
        const id = 100 + number;
        writeFileSync(join(bin, `runs-${sha}.json`), JSON.stringify([{ databaseId: id, event: "pull_request" }, { databaseId: 1, event: "schedule" }]));
        const done = pr.run !== "running";
        writeFileSync(join(bin, `run-${id}.json`), JSON.stringify({
          status: done ? "completed" : "in_progress", conclusion: done ? (pr.run === "success" ? "success" : "failure") : null,
          jobs: [job("Typecheck", pr.run === "failure" ? "failure" : "success")],
        }));
      }
      pr.sha = sha;
    });
    writeFileSync(join(bin, "prs.json"), JSON.stringify(list));
    const scriptDir = join(home, "scripts");
    mkdirSync(scriptDir);
    for (const f of ["auto-merge-dependabot.sh", "ci-wait.sh"]) copyFileSync(join(scripts, f), join(scriptDir, f));
    const calls = () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8") : "");
    const run = (extra = {}, ...args) => {
      const out = spawnSync("bash", [join(scriptDir, "auto-merge-dependabot.sh"), ...args], {
        env: { ...env, LEAD_WORKTREE: lead, ...extra, PATH: `${bin}:${env.PATH}`, CI_WAIT_POLL: "0", AUTO_MERGE_POLL: "0", AUTO_MERGE_POLL_TRIES: "5" }, encoding: "utf8",
      });
      return { status: out.status, out: out.stdout + out.stderr };
    };
    return { run, calls, prs };
  }
  const merges = (calls) => calls.split("\n").filter((l) => l.startsWith("pr merge"));

  const minor = { name: "minor", files: { "package.json": pkg("^1.4.0") }, run: "success" };

  it("is a dry run by default: it says what it would merge and merges nothing", () => {
    const w = world("dep-dry", [{ ...minor }]);
    const { status, out } = w.run();
    assert.equal(status, 0, out);
    assert.match(out, /would merge {2}#1 Bump minor \(low risk, CI green on /);
    assert.match(out, /done: 0 merged, 0 left for the lead \(dry run: nothing is merged without --yes\)/);
    assert.deepEqual(merges(w.calls()), []);
  });

  it("with --yes merges a low-risk pull request with a green run of its head, matched to that head", () => {
    const w = world("dep-yes", [{ ...minor }]);
    const { status, out } = w.run({}, "--yes");
    assert.equal(status, 0, out);
    assert.match(out, /merged {3}#1 Bump minor/);
    const [call] = merges(w.calls());
    assert.match(call, new RegExp(`^pr merge 1 --repo mygogocash/manut-ai --merge --match-head-commit ${w.prs[0].sha}$`));
  });

  it("reads the pull request's own run, and ignores a run of another kind", () => {
    const w = world("dep-event", [{ ...minor }]);
    writeFileSync(join(scratch, "dep-event", "bin", `runs-${w.prs[0].sha}.json`), JSON.stringify([{ databaseId: 7, event: "schedule" }]));
    const { out } = w.run({}, "--yes");
    assert.match(out, /waiting {2}#1 Bump minor: low risk, but CI has no finished run of/);
    assert.deepEqual(merges(w.calls()), []);
  });

  it("lists, and does not merge, a major bump, a source change and a change to CI, with why", () => {
    const w = world("dep-review", [
      { name: "major", files: { "package.json": pkg("^2.0.0") }, run: "success" },
      { name: "source", files: { "src/a.ts": "export const a = 2;\n" }, run: "success" },
      { name: "ci", files: { ".github/workflows/ci.yml": "x: 1\n" }, run: "success" },
    ]);
    const { status, out } = w.run({}, "--yes");
    assert.equal(status, 0, out);
    assert.match(out, /review {3}#1 Bump major: the classifier says review/);
    assert.match(out, /dependencies: left: major bump/);
    assert.match(out, /review {3}#2 Bump source/);
    assert.match(out, /review {3}#3 Bump ci/);
    assert.match(out, /done: 0 merged, 3 left for the lead/);
    assert.deepEqual(merges(w.calls()), []);
  });

  it("never merges a low-risk pull request whose CI is red, still running, or has no run", () => {
    const w = world("dep-ci", [
      { ...minor, name: "red", run: "failure" }, { ...minor, name: "running", run: "running" }, { ...minor, name: "none", run: undefined },
    ]);
    const { out } = w.run({}, "--yes");
    assert.match(out, /review {3}#1 Bump red: low risk, but CI is red/);
    assert.match(out, /waiting {2}#2 Bump running/);
    assert.match(out, /waiting {2}#3 Bump none/);
    assert.deepEqual(merges(w.calls()), []);
  });

  it("merges the low ones and lists the rest in one pass", () => {
    const w = world("dep-mixed", [{ ...minor, name: "a" }, { name: "major", files: { "package.json": pkg("^3.0.0") }, run: "success" }, { ...minor, name: "b", files: { "package.json": pkg("^1.2.5") } }]);
    const { out } = w.run({}, "--yes");
    assert.match(out, /done: 2 merged, 1 left for the lead/);
    assert.equal(merges(w.calls()).length, 2);
  });

  const asyncCalls = (calls) => calls.split("\n").filter((l) => l.includes("merge-async"));
  const setup = (name, put, statuses, fail = false) => {
    const w = world(name, [{ ...minor }]);
    const bin = join(scratch, name, "bin");
    if (put) writeFileSync(join(bin, "async-put.json"), put);
    if (fail) writeFileSync(join(bin, "async-put.fail"), "");
    writeFileSync(join(bin, "async-status"), statuses.map((x) => `${x}\n`).join(""));
    return w;
  };

  it("falls back to the asynchronous merge when gh pr merge is refused: PUT merge-async with the checked head, then polls its uuid until merged", () => {
    const w = setup("dep-async", "", ["pending", "pending", "merged"]);
    const { out } = w.run({ GH_REFUSE: "1" }, "--yes");
    assert.match(out, /merged {3}#1 Bump minor/);
    const calls = asyncCalls(w.calls());
    assert.equal(calls[0], `api -X PUT repos/mygogocash/manut-ai/pulls/1/merge-async -f merge_method=merge -f merge_action=direct_merge -f sha=${w.prs[0].sha}`);
    assert.deepEqual(calls.slice(1), Array(3).fill("api repos/mygogocash/manut-ai/pulls/1/merge-async/u1 --jq .status"));
    // The synchronous endpoint, which GitHub refuses for stacked pull requests, is never used.
    assert.ok(!w.calls().split("\n").some((l) => /^api .*pulls\/1\/merge( |$)/.test(l)));
  });

  it("takes an already merged answer (200) without polling", () => {
    const w = setup("dep-async-done", '{"status":"merged","details":{"sha":"abc"}}', []);
    const { out } = w.run({ GH_REFUSE: "1" }, "--yes");
    assert.match(out, /merged {3}#1 Bump minor/);
    assert.equal(asyncCalls(w.calls()).length, 1);
  });

  it("waits on the pending request's uuid when GitHub answers 409", () => {
    const w = setup("dep-async-409", '{"message":"already pending","status":"pending","details":{"uuid":"u9"}}', ["merged"], true);
    const { out } = w.run({ GH_REFUSE: "1" }, "--yes");
    assert.match(out, /merged {3}#1 Bump minor/);
    assert.match(asyncCalls(w.calls()).at(-1), /merge-async\/u9 /);
  });

  it("lists the pull request when the asynchronous merge fails, is refused (400) or never finishes", () => {
    for (const [name, put, statuses, fail] of [["dep-async-failed", "", ["failed"], false], ["dep-async-400", '{"message":"Pull request is a draft"}', [], true],
      ["dep-async-slow", "", ["pending", "pending", "pending", "pending", "pending", "pending"], false]]) {
      const w = setup(name, put, statuses, fail);
      const { out } = w.run({ GH_REFUSE: "1" }, "--yes");
      assert.match(out, /review {3}#1 Bump minor: low risk and green, but GitHub refused the merge/, name);
      assert.match(out, /done: 0 merged, 1 left/, name);
    }
  });

  it("does not use the asynchronous endpoint when gh pr merge worked", () => {
    const w = world("dep-sync-ok", [{ ...minor }]);
    w.run({}, "--yes");
    assert.deepEqual(asyncCalls(w.calls()), []);
  });

  it("lists a pull request whose head moved after it was listed", () => {
    const w = world("dep-moved", [{ ...minor }]);
    const home = join(scratch, "dep-moved");
    const env = gitEnv(home);
    const work = join(home, "work-1");
    commitFiles(env, work, { "package.json": pkg("^1.9.0") }, "pushed after the listing");
    git(env, work, "push", "-q", "origin", "HEAD:refs/pull/1/head");
    const { out } = w.run({}, "--yes");
    assert.match(out, /review {3}#1 Bump minor: its head could not be fetched, or moved while listing/);
    assert.deepEqual(merges(w.calls()), []);
  });

  it("refuses without the lead's worktree named, whose classifier is the only one trusted", () => {
    const w = world("dep-no-lead", [{ ...minor }]);
    const { status, out } = w.run({ LEAD_WORKTREE: "" }, "--yes");
    assert.equal(status, 1);
    assert.match(out, /set LEAD_WORKTREE to the lead's worktree/);
    assert.equal(w.calls(), "");
  });

  it("says so when there is nothing to do, and reads only Dependabot's pull requests into pilot/week-1", () => {
    const w = world("dep-none", []);
    const { status, out } = w.run();
    assert.equal(status, 0);
    assert.match(out, /no open Dependabot pull requests into pilot\/week-1/);
    assert.match(w.calls(), /pr list --repo mygogocash\/manut-ai --base pilot\/week-1 --author app\/dependabot --state open/);
  });
});
