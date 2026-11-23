# Handoff: where the build stands (23 Nov 2026, about 12:40 Bangkok)

Written so a new session in any tool can continue without the earlier conversation. Read `CLAUDE.md` first
(rules and the owner's standing permissions), then this file, `docs/plan.md` and `docs/decisions.md`.

## What this is

Manut AI: one desktop app for Thai shop owners who are not technical. A chat with Buddy, an AI team (Nam sales
chat, Pim content, Ton books, Kit engineer) that asks the owner before anything public, costly or irreversible,
and a code editor. First step is a concierge pilot over LINE: Cohort A of 10 sellers goes live on 7 December
2026; operators play the team and owners approve each reply from a link.

The owner wants speed and maximum reuse: lift whole modules from existing code before writing new code.

## Where everything is

| Thing | Where |
| --- | --- |
| This repository | `~/Developer/manut-ai`, remote `mygogocash/manut-ai` (private) |
| Working branch | `pilot/week-1`, draft pull request #1 into `main` |
| Implementation plan | https://claude.ai/artifact/UBrAFtxwR159AM2rxbLTMr |
| Design canvas (screen spec) | https://claude.ai/artifact/Qd8PtNKK48ji7cFU4SpTsG, sources in `~/Developer/gospark-main/manut-ai-artifacts/app-screens/project/` |
| GoSpark (source of the backend and the rules) | `~/Developer/gospark` (clone of `mygogocash/gospark`) |
| Oh My Hermes (desktop base) | https://github.com/rlaope/oh-my-hermes, app in `apps/omher` (forked at commit `77b8646`) |
| Orca (agent protocol code, worktrees) | https://github.com/stablyai/orca |
| Night build (cloud routine) | https://claude.ai/code/routines/trig_01W1xtTKRySeLkPiqorkJohN |

Clones of Oh My Hermes and Orca used so far were in a temporary folder and may be gone: clone them again
read-only when needed, and never run their scripts.

## Done and pushed

- `apps/api`: GoSpark's Cloudflare Workers backend lifted whole, plus the LINE Official Account connector, the
  owner's signed approval link (24 hours, consent, settle-once, exactly-once send) and payment records. 497 tests.
- `apps/web`: the owner's approval page (`/approve/:token`) and the operator console (`/ops`), with a practice
  mode that needs no backend. 37 tests.
- `packages/approval-core` (46 tests), `packages/promptpay` (14 tests), `packages/ui-kit` (canvas tokens and CSS).
- `docs/pilot-api.md` (backend and web contract), `docs/connectors.md` (what each channel needs and costs),
  `docs/decisions.md`, `docs/plan.md` (state and the cloud task queue), `docs/cloud-routine.md`.

## In progress, not committed

Two background helpers of the earlier session were still writing these when this file was written:

- `apps/desktop`: the fork of Oh My Hermes's `apps/omher`: renamed to Manut AI, the Hermes bridge cut out behind
  a runtime adapter with a mock runtime, canvas tokens applied, CSP set, updater switched off. Goal: `pnpm
  typecheck`, `pnpm test` and one `CARGO_BUILD_JOBS=4 cargo check` in `src-tauri` pass.
- `packages/agent-events`: GoSpark's provider event contract ported to TypeScript, with tolerant decoders and a
  timeline reducer.

Before touching either folder, run `git status` and `git log`. If they are already committed, carry on. If not,
ask the owner whether the earlier session is still running; two sessions must not edit the same folder.
`pnpm-lock.yaml` already lists both folders, so `pnpm install --frozen-lockfile` fails on a clean checkout until
they are committed.

## Next steps, in order

1. Finish, verify and commit `apps/desktop` and `packages/agent-events`; then `pnpm install`, `pnpm test` and
   `pnpm typecheck` at the root must pass, and push.
2. Run the night build once by hand (its page has Run now) and read its log: no run has been tested yet.
3. Serve `apps/web` from the same Worker as `apps/api` (one origin, so the console needs no CORS and Cloudflare
   Access covers both). Check Cloudflare's current static-assets documentation before writing the config.
4. Operator routes to export and delete one shop's pilot data (the functions exist and are tested).
5. Dev deploy (`manut-api-dev` only) and a dry run with two test shops: a LINE message in, a draft, approval on
   the web, the reply out, an audit row. Needs the owner's Cloudflare token and a test LINE Official Account.
6. Desktop, next pass: turn the fork into Manut AI's screens from the design canvas (side menu: New, Needs you,
   Team, Code, Artifacts, Customize, History).
7. Each morning: review the night build's `cloud/<task>` branches and draft pull requests, merge the good ones
   into the working branch (never into `main`), and refill the queue in `docs/plan.md`.
8. Keep the implementation plan doc and the design canvas in step with what lands.

## Needs the owner

- GitHub Actions cannot run for the organisation: GitHub reports a failed payment or a spending limit to raise.
  The test workflow is manual until then; tests run locally before every commit.
- A Cloudflare token for the dev deploy, given through a secure prompt, never pasted into chat or a file.
- From `docs/connectors.md`: each approved reply is a LINE push, which counts against the shop's monthly quota
  (the free plan allows 300 a month); Shopee chat is closed to third parties; Lazada and Meta need applications
  started now.
- Merging pull request #1 into `main` when happy with it.
- A look at the approval page on a real phone, and a first real LINE message in dev.

## Practical notes for this Mac

- 8 GB of memory: run one Rust build at a time (`CARGO_BUILD_JOBS=4`), and no more than about five jobs at once.
- GitHub: `git push` works in this repository as it is. For `gh`, prefix commands with
  `GH_TOKEN="$(gh auth token --user KunanonJ)"`; the default `gh` account cannot see the organisation.
- pnpm 12 installs dependencies by itself before running a script. To run a script without that, add
  `--config.verify-deps-before-run=false`. Only esbuild and workerd may run install scripts.
- The backend's tests run in real workerd: `pnpm --filter @manut/api test`.
- Secrets never go into source, logs, tests or chat.
