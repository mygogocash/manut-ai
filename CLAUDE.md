# CLAUDE.md: Manut AI

One app for Thai shop owners who are not technical: a chat with Buddy, an AI team that does the work and asks
before anything public, costly or irreversible, and a code editor. Write the product name as "Manut AI".

Read `README.md` for the layout and commands, `docs/plan.md` for where things stand and the task queue,
`docs/pilot-api.md` for the backend and web contract, and `docs/decisions.md` for every decision so far. The plan is the implementation plan doc
(https://claude.ai/artifact/UBrAFtxwR159AM2rxbLTMr); the screen spec is the design canvas
(https://claude.ai/artifact/Qd8PtNKK48ji7cFU4SpTsG).

## How to work here

- **Reuse first.** Lift whole modules from GoSpark (`mygogocash/gospark`), Oh My Hermes and Orca before writing
  new code. Keep each lifted module's tests. Add its source to the Credits in `README.md`.
- **Tests are the gate.** `pnpm test` and `pnpm typecheck` must pass before every commit. The backend's tests
  run in real workerd. A change with no test is not done.
- **Comments say why**, in full sentences, as the lifted backend's do.
- **Money is integer satang.** Never a float.
- **Approvals settle once.** Every path that sends, posts, pays or deletes goes through an approval that names
  the exact action, and through `packages/approval-core`'s rules. Never add a second way round.
- **Secrets** live in Wrangler secrets or the credential vault. Never in source, logs, tests or a URL.

## Skills (25 Nov 2026)

Work that repeats is written down once in `.claude/skills/`, with its scripts beside it (the owner, 25 Nov: make a
skill of anything repetitive). Read the one that fits before doing the work by hand:

- `helper`: the standing rules for building one plan item in a worktree. A helper reads it first, so a brief only
  says what to build.
- `lead-merge`: the lead's routine for an item (start a worktree, wait for CI on the helper's push, merge on green,
  mark, clean up), with `ci-wait.sh`, `finish-item.sh --ci`, `gate.sh` (for when CI is down), `keep-both.py` and
  `start-item.sh`.
- `release-desktop`: cutting a desktop release and checking its files and signatures (`verify-release.mjs`).
- `ci-read`: reading the newest CI run, failed browser specs included (`ci-failures.sh`).

Which model does what (the owner, 25 Nov): think with the strongest model, execute with a lighter one. The lead and
any item with unsettled design or a safety rule use Opus or Fable; carrying out a clear plan uses Sonnet;
mechanical edits use Haiku or a script. `lead-merge` has the table.

## Standing permissions (owner, 23 Nov 2026)

Do these without asking:

1. Push branches and open draft pull requests on `mygogocash/manut-ai`.
2. Decide product, design and technical calls that can be undone later, and add each to `docs/decisions.md`.
3. Update the design canvas and the implementation plan doc, and say afterwards what changed.
4. Deploy `apps/api` to the Cloudflare dev environment (`manut-api-dev`) only.

Always ask the owner first:

- Merging to `main`. The owner merges.
- Deploying to staging or production.
- Anything that reaches a real customer or a real shop account (a LINE message, a post, a payment).
- Spending money: a paid plan, a paid component, a paid service, a bigger machine.
- Deleting data, a repository, a branch someone else made, or an artifact.
- Anything about legal terms, launch dates or the pilot's customers.

`.claude/settings.json` denies the first two outright, so no mode can do them by accident.

## Working without the owner

Work in small commits on a branch per week or per feature (`pilot/week-1`), push after each green test run, and
keep one draft pull request per branch whose description lists what is done, what is left and what needs the
owner. When something needs the owner, write it under "Needs the owner" in the pull request and carry on with
everything that does not depend on the answer.
