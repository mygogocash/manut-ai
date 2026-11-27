---
name: helper
description: The standing rules for a helper building one plan item of Manut AI in its own worktree - tests, Rust, secrets, commits, what never to do, and what to report. Read it first when a lead hands you an item; the brief then only says what to build.
---

# Building one item as a helper

A lead hands you one item, one branch and one worktree. You build it, test it, push your branch, and report. The lead
reviews and merges. Work only in your worktree.

## Before you write

1. Read `CLAUDE.md` (the project's rules), then the docs your brief names, then the code they point at.
2. Reuse first: lift from what is here, and from GoSpark, Oh My Hermes, Orca and T3 Code (all ours or MIT), before
   writing new code. Clone another project read-only into `mktemp -d`, never run its scripts, and credit it in
   `README.md`'s Credits with the commit you read.
3. Do not guess a CLI flag, a file name, an API, a plist key or a JSON field. Read the tool's own `--help` or
   documentation, the installed types in `node_modules`, or the code that already uses it. Say in your report what you
   could not check.

## The one promise

Anything public, costly or irreversible asks the person first, through the one ask path that settles once
(`packages/approval-core`; `docs/code-editor.md`, "How an ask is read"). Never add a second way round, never start an
agent in a mode that skips its asks, never force a removal or a push.

## Tests are the gate

- A change with no test is not done. Follow the test style next to each file you touch.
- While you work, run only the files you touch:
  `pnpm --config.verify-deps-before-run=false --filter @manut/desktop exec vitest run <file>`.
- Rust: RUN the tests, a check is not enough.
  `CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR="$HOME/Library/Caches/manut-ai-cargo-target" cargo test --locked` in
  `apps/desktop/src-tauri`. Write `$HOME`, never `~`. One cargo at a time: `pgrep cargo` first, and wait. Never a
  release build, never `tauri dev`, never open the app's window.
- Playwright: update and run only the specs you change. If you change a menu, a Settings page, the chat box or a
  lane's life, find the specs that assert it (`grep -rl` in `apps/desktop/e2e`) and run those.
- Before you push, unless your brief asks for the whole gate: every test file you touched, the type check
  (`pnpm --config.verify-deps-before-run=false typecheck`, or the desktop's alone when you changed only the desktop),
  the whole Rust suite if you changed Rust, and the Playwright specs you changed or that assert what you changed. Say
  in your report exactly what you ran, with counts. CI then runs the whole check on GitHub when you push (every
  package's tests, the type check, Rust and every browser spec), and the lead merges on its green run (item 126, 26
  Nov 2026): a whole gate from each helper on this Mac kept its one lock busy for most of an hour.
  `.claude/skills/lead-merge/scripts/gate.sh` is for when CI is down. A test that fails only under load and passes
  alone is in `docs/handoff.md`, "Known flaky tests"; anything else is yours.
- Look at what you built. A page or a move that only tests have seen is not checked: take the screenshots your brief
  names, open them, and say in your report what you saw and what you changed because of it.
- This Mac has 8 GB and several helpers are running. Run only the files you touch while you work, and nothing heavy
  beside the gate.

## On this Mac

- The owner is working on it. Do not trigger a macOS permission prompt, open System Settings, capture the screen, or
  click or type in another app. What needs a real microphone, window or sign-in goes behind an interface a test drives
  with a stand-in, and becomes steps for the owner in your report.
- Real messages to a coding agent spend the owner's own plan: at most three very short ones, only when your brief
  allows it, and say exactly what you sent and saw.

## Secrets

Never print, log, commit or send to the page a token, a key, a credentials file, an environment value or a URL with a
key. Tests use made-up values in temporary folders. When you look at this Mac's real configuration to learn its shape,
list names only.

## Words and docs

- Every string goes through `apps/desktop/src/i18n/` in all four dictionaries (`en`, `ja`, `ko`, `zh`), in the area
  file named after the key's prefix (`i18n/en/lane.ts` for `lane.*`; a new feature adds its own area file in all four,
  as `src/i18n/README.md` says), and then writes `src/i18n/snapshot/` again with `UPDATE_I18N_SNAPSHOT=1`. No Thai yet. A
  word the app keeps in English everywhere stays so (`src/i18n/i18n.test.ts`); a new Settings page whose name stays
  English joins the names `e2e/i18n-zh.spec.ts` keeps.
- Comments say why, in full sentences. No emojis and no em-dashes anywhere.
- Each reversible call you make is a row in your item's own file, `docs/decisions/<item>-<short-name>.md` (newest
  first, five columns, "By" is "Claude"; `docs/decisions/README.md` has the form). Never add to
  `docs/decisions.md` or `docs/decisions/archive.md`: they are frozen.
  Update the doc that describes what you changed. Do not edit `docs/handoff.md` or the status column of
  `docs/plan.md`: the lead does that at merge.

## Commits

- Small commits, each after its tests pass. `git commit -F -` cannot read stdin here: write the message to a file in
  `mktemp -d` and use `git commit -F <file>`.
- End each message with `Co-Authored-By:` and the model you are, for example
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- When those checks are green, merge the lead's branch in (`git merge --no-edit feat/continue-pilot-week-1`, unless
  your brief names another), so CI checks the very commit the lead will merge, and run your tests again if the merge
  brought anything in. Then push your branch: `git push -u origin <your branch>`. CI runs on every push of a `feat/`,
  `fix/`, `refactor/`, `test/`, `docs/`, `ci/` or `chore/` branch, measured from the newest green `pilot/week-1` commit
  your branch holds.
- Wait for that run: `.claude/skills/lead-merge/scripts/ci-wait.sh <your branch>` prints each job and exits 0 only when
  green. A red job is yours: read it (`gh run view <id> --log-failed`), fix it, push, and wait again. Say in your report
  the run's id and that it is green.
- Never push to `main` or `pilot/week-1`, never merge, deploy, tag, publish a release or change a GitHub setting.

## If it does not fit

If a part cannot be done safely or well within the item, finish the rest and report exactly what is missing and why. A
safe partial result is better than an unsafe whole one.

## Your report (all the lead sees)

Under 400 words: what a person now sees; what you reused and what you added (files); each decision and why; how the
safety rule is enforced and the test for it; what you verified for real and what only by tests; what you ran, with
counts; the commits and whether the branch is pushed; what is left, and what needs the owner.
