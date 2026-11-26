---
name: lead-merge
description: The lead's routine for one plan item in Manut AI - start a helper's worktree, wait for CI on its pushed branch (or gate it when CI is down), merge it, mark it and clean up. Use when a helper reports an item finished, when starting a new item, or when a merge conflicts in the decisions or the dictionaries.
---

# Merging an item as the lead

One item is one branch in one worktree, built by a helper, merged by the lead. `docs/handoff.md` says what runs now and
`docs/plan.md` has the items. The owner merges to `main`; the lead never does.

Scripts are in `scripts/` beside this file. Section 4 says when the lead need not review an item at all. Run them from anywhere; they know the paths on the owner's Mac.

## 1. Start an item

```bash
.claude/skills/lead-merge/scripts/start-item.sh 71 lane-diff feat/lane-diff   # prints the worktree's path
```

Then brief the helper (see the `helper` skill: its rules are one file, so a brief only says what to build). Pick the
model by the work, as the owner asked on 25 Nov 2026: think with the strongest model, execute with a lighter one.

| The item is | Who |
| --- | --- |
| Design that is not settled, a safety rule, native code, anything that can lose work or act for the person | Opus |
| A clear plan to carry out, a page, wiring what exists, tests, docs | Sonnet |
| Mechanical edits with no judgement (a rename, marking docs, moving text) | Haiku, or a script |

When an item is large, the lead settles the design first and hands a lighter model the plan, rather than a strong model
the whole thing. The Mac was the limit while every item's gate ran on it, one at a time; since item 126 CI checks each
helper's push on GitHub, several at once (one full run is 18 jobs, and the organisation's free plan runs 20 at a
time), so the lead's own review is the queue. Helpers still share the Mac for their own tests: keep heavy local runs to
one or two at once.

## 2. When the helper reports

The order since 26 Nov 2026 (item 126): **the helper merges the lead's branch in and pushes, CI checks that commit on
GitHub, and the lead merges on green.** CI runs on every push of a `feat/`, `fix/`, `refactor/`, `test/`, `docs/`, `ci/`
or `chore/` branch, measured from the newest green commit of `pilot/week-1` the branch holds, so several items are
checked at once in the cloud instead of one at a time on this Mac. CI runs everything the gate does, and the browser
specs the gate never ran.

Read its report for what it did NOT do or could not check, then:

1. Read the risky part of the diff yourself: anything that removes, sends, pays, runs a command, starts a program, or
   keeps a secret. Check a flag it used against the tool's own `--help`.
2. Make sure the item's branch holds the lead's newest commit. The helper merged it in before pushing; if the lead's
   branch has moved since, merge it again in the item's worktree (`git merge --no-edit feat/continue-pilot-week-1`) and
   push. Conflicts are nearly always two items adding at one place:
   ```bash
   .claude/skills/lead-merge/scripts/keep-both.py $(git diff --name-only --diff-filter=U -- apps/desktop/src/i18n)
   ```
   Since item 128 each language's words are a folder of area files, one per key prefix (`apps/desktop/src/i18n/README.md`),
   so two items meet only when both add to one area, at the end of its object, or both add an area (its import and
   spread in `<lang>.ts`); `keep-both.py` keeps both of either. A conflict in `src/i18n/snapshot/*.json` is settled by
   taking either side and writing it again once the dictionaries are merged: `UPDATE_I18N_SNAPSHOT=1 pnpm
   --filter @manut/desktop exec vitest run src/i18n/snapshot.test.ts`. A branch made before item 128 adds its keys to
   the old one-file `en.ts`, `ja.ts`, `ko.ts` and `zh.ts`: take the lead's four (`git checkout --theirs
   apps/desktop/src/i18n/{en,ja,ko,zh}.ts`), then carry the branch's keys into their areas:
   ```bash
   for l in en ja ko zh; do
     git diff <merge base> <item branch> -- apps/desktop/src/i18n/$l.ts | sed -n 's/^+\( *[/"]\)/\1/p' |
       .claude/skills/lead-merge/scripts/place-keys.py apps/desktop/src/i18n $l
   done
   ```
   It adds or replaces each key in its area and makes a new area's files; a key the branch removed is yours to remove.
   Decisions no longer conflict: since item 128 each item writes its own `docs/decisions/<item>-<short-name>.md`, and
   `docs/decisions.md` and `docs/decisions/archive.md` are frozen. A branch made before item 128 still adds rows to
   `docs/decisions.md`: keep the lead's short note there (`git checkout --theirs docs/decisions.md`, since the lead's
   branch is the one merged in), and put the branch's own rows, `git diff <merge base> <item branch> -- docs/decisions.md |
   sed -n 's/^+| /| /p'`, at the top of a new `docs/decisions/<item>-<short-name>.md` under the README's heading and
   table head.
   Read any other conflict yourself. Two functions added at one place share the closing brace after the marker; a
   sentence both sides extended is joined by hand.
3. Wait for CI on that exact commit:
   ```bash
   .claude/skills/lead-merge/scripts/ci-wait.sh feat/lane-diff      # prints each job; exits 0 only when green
   ```
   A skipped job counts as passed (it could not see the change). A red job is the item's to fix on its branch: push the
   fix and wait again. `gh run view <id> --log-failed` shows why. A browser spec that failed once and passed on its retry
   shows as flaky, not red. A test that fails only under load is in `docs/handoff.md`, "Known flaky tests".
4. Several items ready together need not wait for each other: each was checked on its own push. Merge them one after
   another; each merge moves the lead's branch, so the next item merges it in, pushes and waits once more. A full run
   took about 12 minutes on 26 Nov when runners were free (its longest shard is `panel-max.spec.ts` alone, about 8
   minutes), and a docs-only push a few. When the organisation's 20 job places are taken (a burst of Dependabot pull
   requests, each a full run, held one run queued for 30 minutes that day), a run waits for places.

**When CI is down** (GitHub's status page, or runs that never start), gate on this Mac instead:
`.claude/skills/lead-merge/scripts/gate.sh <item worktree>` installs, runs every package's tests, type checks and the
whole Rust suite, one cargo at a time (a second time by itself when the first run fails), behind a lock so only one runs
at a time. It does not run the browser specs: run the Playwright specs for any menu, Settings page, chat box or lane's
life the item changed (`apps/desktop`, `pnpm exec playwright test e2e/<spec>`). Then finish without `--ci`.

## 3. Merge, mark, push, clean up

1. Write the merge message to a file (what it does for a person, the safety rule if it has one, what the lead checked,
   what is not verified, the CI run it merged on; `Co-Authored-By` for the helper's model and for the lead).
   `git commit -F -` cannot read stdin in this shell, so always a file.
2. `.claude/skills/lead-merge/scripts/finish-item.sh --ci <item worktree> <message file>`: requires the item's head to be
   the branch's head on GitHub, waits for CI's run of exactly that commit and refuses unless it is green, merges that
   commit `--no-ff`, checks the merged tree is the checked one, and removes the worktree and the branch. A push while it
   waits, or a lead's branch that moved, refuses the merge. Without `--ci` (when CI is down) it trusts the gate and
   pushes the branch itself.
3. Mark `docs/plan.md` (the row to `done`, with one line on what merged and what is still open) and `docs/handoff.md`
   (the running list, the Merged list, anything the owner must do). Commit, then push:
   `git push origin HEAD:pilot/week-1` from the lead's worktree. A run on `pilot/week-1` is never cancelled by the next
   push: one runs, the newest waits, and a run already waiting is replaced by a newer one, so quick merges are all
   covered by the runs that finish (each measures from the last green commit).
4. Start the next item.

## 4. Low-risk work merges itself (item 130)

The owner agreed on 26 Nov 2026 that documentation, a refactor that changes nothing visible and minor and patch
dependency bumps merge on a green CI run, and that the lead keeps reviewing features and security work. GitHub's own
auto-merge and branch protection need repository settings the owner has not given, so this runs from the lead's Mac, by
hand, with two scripts and one classifier.

**The classifier** is `.github/scripts/merge-risk.mjs <base> <head> [--message <file>]`. It prints `low` or `review` and
one line a file saying why. `low` only when every changed file is documentation (`docs/**`, `*.md`, pictures under
`docs/assets/`); a dependency bump whose every version in `package.json`, `pnpm-lock.yaml`, `Cargo.toml` and
`Cargo.lock` is a minor or patch step (a 0.x minor counts as major, and a package added or removed, a version that went
down or a lockfile entry that changed without a new version is `review`); or source changed by a refactor the merge
message declares with a `Risk: refactor` trailer (last paragraph), touching no dictionary, stylesheet, e2e spec,
tauri capability, entitlement, Info plist or tauri config, deleting no test file and lowering no test count. Anything
else, any file it cannot read, and anything under `.github/` or `.claude/`, `CLAUDE.md`, a security document or the
classifier itself is `review`. The merge message's trailer is the lead's word: only a message file counts, never a
commit message on the branch.

**A `low` answer never skips CI.** It says the change is of a kind CI can judge alone; both scripts still need a green
run of the exact head, read by `ci-wait.sh`.

Which to use:

| When | Run |
| --- | --- |
| A helper reports a docs item, or a refactor the lead has read and means to merge on CI alone (write `Risk: refactor` as the last paragraph of the merge message) | `auto-merge.sh [--dry-run] [--no-push] <item worktree> <message file>` instead of `finish-item.sh --ci` |
| Dependabot's pull requests into `pilot/week-1` are waiting | `auto-merge-dependabot.sh` (a dry run: lists what it would merge and what is left for the lead), then `auto-merge-dependabot.sh --yes` |
| A feature, anything that touches security, a Settings page, words, a permission, CI or these rules | `finish-item.sh --ci` after the lead's own review, as in section 3 |

`auto-merge.sh` refuses, and prints why, unless both worktrees are clean, the lead's branch is in the item's, the message
has a `Co-Authored-By` line, the LEAD's copy of the classifier (never the branch's) answers `low`, and `ci-wait.sh`
reports a green run of the exact head. It then runs `finish-item.sh --ci` and pushes the lead's branch to `pilot/week-1`
(a fast-forward; `--no-push` leaves the push for when the lead has marked the plan and handoff). `--dry-run` prints the
classifier's decision and stops, with no wait for CI and no merge.

`auto-merge-dependabot.sh` lists Dependabot's open pull requests into `pilot/week-1`, fetches each head, and merges
only those the classifier calls `low` with a green pull request run on that head, using `gh pr merge --merge
--match-head-commit <sha>`. Dependabot's branches are not ones CI runs on a push of, so it reads the pull request's own
run (`CI_WAIT_EVENTS` in `ci-wait.sh`). A run still going is listed as waiting: run it again, or pass `--wait`. If
`gh pr merge` is refused (GitHub refuses the synchronous endpoint for a stacked pull request, as it did for #1) it uses the
asynchronous one, never `PUT .../pulls/N/merge`:

```bash
gh api -X PUT repos/mygogocash/manut-ai/pulls/N/merge-async -f merge_method=merge -f merge_action=direct_merge -f sha=<checked head>
# 202 {status: "pending", details: {uuid}}; 200 already merged; 409 returns the pending request's uuid; 400 draft or closed
gh api repos/mygogocash/manut-ai/pulls/N/merge-async/<uuid> --jq .status   # poll until "merged" (details.sha is the merge commit) or "failed" (details.message)
```

A failed or refused merge lists the pull request for the lead. It never closes, comments on or touches a pull request that
is not Dependabot's. Dependabot's major bumps, new
packages and 0.x minors come back as `review`: read them like any other item.

## When the Mac or the account stops

- Gates that time out after about 925 seconds mean the Mac slept (`pmset -g log`): it sleeps fifteen minutes in
  seventeen once the owner is away. `caffeinate -i -s -t <seconds>` holds it awake without changing a setting.
- A helper that ends with a usage-limit error keeps its work: when the limit resets, send it on in its own thread
  (SendMessage) rather than starting a new one.

## Never

- Merge to `main`, deploy beyond dev, publish a release, or delete a remote `cloud/*` branch (the night build reads
  those to know which tasks are done).
- Force anything, or remove a worktree with uncommitted or unmerged work.
