---
name: ci-read
description: Read Manut AI's newest CI run - which jobs ran, which failed, and the failing tests' own lines, browser specs included. Use after a push, before cutting a release, or when a check is red.
---

# Reading CI

```bash
.claude/skills/ci-read/scripts/ci-failures.sh            # the newest push run on pilot/week-1
.claude/skills/ci-read/scripts/ci-failures.sh 7ef8505    # the run for one commit
```

What to know when reading it:

- **CI runs only what a push needs** (`.github/scripts/changed-areas.mjs`): its first job, What changed, says which jobs
  run and why, measured from the last commit CI passed on. A skipped job counts as passed. To run everything on a
  branch, start CI by hand (Actions, CI, Run workflow).
- **On `pilot/week-1` and `main` a push never cancels the run in progress** (since item 126, 26 Nov 2026): one runs, the
  newest waits, and a run already waiting is replaced by a newer one. On any other branch a newer push cancels it.
- **A failing desktop browser spec fails the run** (since item 126). The nine shards are balanced by each spec file's
  measured time; "Desktop Playwright (all shards)" adds them up, names a test that passed only on its retry as flaky,
  and fails when any shard failed or left no report.
- **A helper's branch has CI too**: `.claude/skills/lead-merge/scripts/ci-wait.sh <branch>` waits for the run of its
  head and prints each job.
- **A test that passed five seconds once on a slow runner** and passes on the next commit is the runner. Give it thirty
  seconds, as the other heavy tests have, and add it to `docs/handoff.md`, "Known flaky tests". Anything that fails
  twice is real.
- For `gh`, the token of the account that sees the organisation is `gh auth token --user KunanonJ`.
