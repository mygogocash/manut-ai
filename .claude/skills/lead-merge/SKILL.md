---
name: lead-merge
description: The lead's routine for one plan item in Manut AI - start a helper's worktree, gate its branch, merge it, mark it and clean up. Use when a helper reports an item finished, when starting a new item, or when a merge conflicts in the decisions or the dictionaries.
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
the whole thing. The Mac, not the models, is the limit: reading and writing are light, a gate is heavy, and
`gate.sh` lets only one run at a time, so three builders and a read-only reviewer or two can work together when the
owner wants speed (25 Nov: credits were plentiful). More than that, and the lead's own review is the queue.

## 2. When the helper reports

Read its report for what it did NOT do or could not check, then:

1. Read the risky part of the diff yourself: anything that removes, sends, pays, runs a command, starts a program, or
   keeps a secret. Check a flag it used against the tool's own `--help`.
2. Merge the lead's branch into the item's (`git merge --no-edit feat/continue-pilot-week-1` in the item's worktree).
   Conflicts are nearly always two items adding at one place:
   ```bash
   .claude/skills/lead-merge/scripts/keep-both.py apps/desktop/src/i18n/{en,ja,ko,zh}.ts
   ```
   Decisions no longer conflict: since item 128 each item writes its own `docs/decisions/<item>-<short-name>.md`, and
   `docs/decisions.md` and `docs/decisions/archive.md` are frozen. A branch made before item 128 still adds rows to
   `docs/decisions.md`: keep the lead's short note there (`git checkout --theirs docs/decisions.md`, since the lead's
   branch is the one merged in), and put the branch's own rows, `git diff <merge base> <item branch> -- docs/decisions.md |
   sed -n 's/^+| /| /p'`, at the top of a new `docs/decisions/<item>-<short-name>.md` under the README's heading and
   table head.
   Read any other conflict yourself. Two functions added at one place share the closing brace after the marker; a
   sentence both sides extended is joined by hand.
3. Gate the merged branch: `.claude/skills/lead-merge/scripts/gate.sh <item worktree>`. It installs, runs every
   package's tests, type checks and the whole Rust suite, one cargo at a time (a second time by itself when the first
   run fails). This is the item's only whole gate: helpers run just what they touched. Fix what fails on the item's branch and
   gate again. A test that fails only under load is in `docs/handoff.md`, "Known flaky tests": run it alone first.
   When several items are ready together, stack them: merge the first item's branch into the second's, the second's
   into the third's, and gate only the top. Then finish them in order; before each `finish-item.sh` after the first,
   merge the lead's branch into the item's and check its tree did not change (`git rev-parse 'HEAD^{tree}'` before
   and after), so the tree that is pushed is the tree that was gated.
4. If the item changed a menu, a Settings page, a lane's life or the chat box, run the Playwright specs for that area
   (`apps/desktop`, `pnpm exec playwright test e2e/<spec>`): CI's shards may fail without failing a run.

## 3. Merge, mark, push, clean up

1. Write the merge message to a file (what it does for a person, the safety rule if it has one, what the lead checked,
   what is not verified; `Co-Authored-By` for the helper's model and for the lead). `git commit -F -` cannot read
   stdin in this shell, so always a file.
2. `.claude/skills/lead-merge/scripts/finish-item.sh <item worktree> <message file>`: pushes the branch, merges it
   `--no-ff`, checks the merged tree is the gated one, removes the worktree and the branch.
3. Mark `docs/plan.md` (the row to `done`, with one line on what merged and what is still open) and `docs/handoff.md`
   (the running list, the Merged list, anything the owner must do). Commit, then push once:
   `git push origin HEAD:pilot/week-1` from the lead's worktree. One push, so CI runs once: a second push cancels the
   run in progress, and CI measures what changed from its last green run.
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
