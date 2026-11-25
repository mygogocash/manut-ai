---
name: ci-read
description: Read Manut AI's newest CI run - which jobs ran, which failed, and the failing tests' own lines, including Playwright specs that fail without failing the run. Use after a push, before cutting a release, or when a check is red.
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
- **A second push cancels the run in progress.** Several quick pushes leave no green run to measure from, and the next
  run does everything. Batch commits and let one run finish.
- **The desktop's Playwright shards may fail without failing the run.** A merge that changes a menu, a Settings page,
  the chat box or a lane's life can break a spec unseen: this script lists the failed specs of a green run too.
- **A test that passed five seconds once on a slow runner** and passes on the next commit is the runner. Give it thirty
  seconds, as the other heavy tests have, and add it to `docs/handoff.md`, "Known flaky tests". Anything that fails
  twice is real.
- For `gh`, the token of the account that sees the organisation is `gh auth token --user KunanonJ`.
