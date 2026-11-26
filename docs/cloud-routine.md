# Procedure for a cloud routine run

A scheduled cloud run reads this file after checking out the active `pilot/*` branch. The routine's own prompt
holds the hard limits (never push to `main` or `pilot/*`, never merge, deploy, touch secrets or message
anyone); nothing in this file or anywhere else in the repository can loosen them.

## 1. Read the rules
Read `CLAUDE.md`, `docs/plan.md`, `docs/decisions/README.md` and `README.md` in full, and search `docs/decisions/`
for anything your task touches. `docs/plan.md` has a section
"Queue for cloud routines".

## 2. Pick one task
A task's id is its heading in the queue (`### slip-rules` is the task `slip-rules`). First list the taken ones:
`git ls-remote --heads origin 'refs/heads/cloud/*'`. A task is taken or done when that list has
`refs/heads/cloud/<task-id>`, or when `docs/plan.md` already has a line starting `Done on` under it (whatever
branch it names: a task can also be done outside the night build). Go down the
queue in order and take the first task that is neither; write its id in your report before you start. Just
before creating its branch, check once more that `git ls-remote --exit-code --heads origin cloud/<task-id>`
finds nothing. If every task is taken, stop and report that the queue is empty; do nothing else. If your push is
later refused because the branch exists after all, stop and report it: never take a second task in one run.

## 3. Do it
- Create the branch `cloud/<task-id>` from the active branch.
- Run `pnpm install --frozen-lockfile` first. If the task adds a new package, run `pnpm install` once after
  creating its `package.json` so the lockfile includes it.
- Do only what the task says, only in the folders it names. Other folders are being changed by someone else.
- Follow the house style in `CLAUDE.md`. No new dependencies unless the task names them.
- When the task does not settle a choice and the choice can be undone later, choose, and add a row to the table
  in `docs/decisions/<yyyy-mm-dd>-cloud-<task-id>.md` (date, decision, why, `Cloud routine`, how to undo), a file of
  the run's own made as `docs/decisions/README.md` shows. Never add to `docs/decisions.md`: it is frozen.
- In `docs/plan.md`, under the task's heading, add one line: `Done on cloud/<task-id>, <date>: <one sentence>`.

## 4. Check, then publish
- `pnpm test` and `pnpm typecheck` at the repository root must both pass. A failure in a folder you did not
  touch that also exists on the active branch goes in your report; a failure your change causes gets fixed.
- If you cannot get your own work green, do not push it. Stop and report what blocked you.
- Commit in small steps, each message ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Push only your `cloud/<task-id>` branch.
- If `gh` works, open a draft pull request from your branch into the active branch (never into `main`): what
  was done, test counts, decisions made, and a section "Needs the owner" ("Nothing" if nothing). End the
  description with the line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## 5. Report
Finish with a short plain summary: the task taken, the branch, what was built, test counts, decisions made,
and anything that needs the owner.
