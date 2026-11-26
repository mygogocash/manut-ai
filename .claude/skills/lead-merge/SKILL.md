---
name: lead-merge
description: The lead's routine for one plan item in Manut AI - start a helper's worktree, wait for CI on its pushed branch (or gate it when CI is down), merge it, mark it and clean up. Use when a helper reports an item finished, when starting a new item, or when a merge conflicts in docs/decisions.md or the dictionaries.
---

# Merging an item as the lead

One item is one branch in one worktree, built by a helper, merged by the lead. `docs/handoff.md` says what runs now and
`docs/plan.md` has the items. The owner merges to `main`; the lead never does.

Scripts are in `scripts/` beside this file. Run them from anywhere; they know the paths on the owner's Mac.

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
helper's push on GitHub, several at once (one full run is 17 jobs, and the organisation's free plan runs 20 at a
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
   .claude/skills/lead-merge/scripts/keep-both.py docs/decisions.md apps/desktop/src/i18n/{en,ja,ko,zh}.ts
   ```
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
   another; each merge moves the lead's branch, so the next item merges it in, pushes and waits once more (a docs-only
   change takes about two minutes, a desktop change about ten).

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

## When the Mac or the account stops

- Gates that time out after about 925 seconds mean the Mac slept (`pmset -g log`): it sleeps fifteen minutes in
  seventeen once the owner is away. `caffeinate -i -s -t <seconds>` holds it awake without changing a setting.
- A helper that ends with a usage-limit error keeps its work: when the limit resets, send it on in its own thread
  (SendMessage) rather than starting a new one.

## Never

- Merge to `main`, deploy beyond dev, publish a release, or delete a remote `cloud/*` branch (the night build reads
  those to know which tasks are done).
- Force anything, or remove a worktree with uncommitted or unmerged work.
