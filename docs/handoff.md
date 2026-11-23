# Handoff: where the build stands (23 Nov 2026, about 14:45 Bangkok)

Written so a new session in any tool can continue without the earlier conversations. Read `CLAUDE.md` first
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
| This repository | `~/Developer/manut-ai`, remote `mygogocash/manut-ai` (public since 23 Nov 2026) |
| Working branch | `pilot/week-1`, draft pull request #1 into `main` |
| Dev deployment | https://dev.manut.xyz: `manut-api-dev` (the front door) and `manut-web-dev` (the pages), GoGoCash Cloudflare account |
| Console login | Cloudflare Access application "Manut AI dev console" on `/ops` and `/v1/admin`, one allowed email |
| Dev secrets | the Worker, and the owner's macOS Keychain: `manut-dev-operator-key`, `manut-dev-approval-link-secret`, `manut-dev-cred-key` |
| Cloudflare token | GitHub environment `dev` (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) |
| Implementation plan | https://claude.ai/artifact/UBrAFtxwR159AM2rxbLTMr (not reachable from T3 Code sessions) |
| Design canvas (screen spec) | https://claude.ai/artifact/Qd8PtNKK48ji7cFU4SpTsG, sources in `~/Developer/gospark-main/manut-ai-artifacts/app-screens/project/` |
| GoSpark (source of the backend and the rules) | `~/Developer/gospark` (clone of `mygogocash/gospark`) |
| Oh My Hermes (desktop base) | https://github.com/rlaope/oh-my-hermes, app in `apps/omher` (forked at commit `77b8646`) |
| Orca (agent protocol code, worktrees) | https://github.com/stablyai/orca |
| Night build (cloud routine) | https://claude.ai/code/routines/trig_01W1xtTKRySeLkPiqorkJohN |

## Done and pushed (all green: about 2,600 tests plus two local-Worker contracts)

- `apps/api`: GoSpark's Workers backend lifted whole, plus the LINE connector, the owner's signed approval link
  and payment records.
  - **One origin:** the API Worker is the front door and hands every page to a pages Worker over a `WEB` service
    binding. It must never get static assets: Cloudflare's asset router drops `ctx.access`, and the admin gate
    needs it.
  - **Export and delete one shop's data:** operator routes that leave an audit record of who deleted what and when.
- `apps/web`: the owner's approval page, and the operator console with a Shop data tab (export, delete by name),
  plus practice mode.
- `apps/desktop`: the Oh My Hermes fork as Manut AI, with the design canvas's side menu.
  - Rows: New, Needs you, Team, Code, Artifacts, Customize, History, Recent, the account row. Each row opens a page.
  - New opens Buddy's chat until a Home page exists.
- Packages: `approval-core`, `promptpay`, `agent-events`, `ui-kit`, and `format` (from the first night build, PR #2).
- The night build works end to end: its first run opened PR #2, which was reviewed and merged into the working branch.

## Landed since the first version of this note

- Owner-confirmed deletion of a live shop (the owner's decision): signed deletion links, run through
  `packages/approval-core`, a one-step owner page at `/delete/{token}`, and the console's waiting state.
- GitHub: CI on every pull request and push, CodeQL, Dependabot, secret scanning and push protection, and a
  `main` ruleset (pull request #4). All four code-scanning findings were fixed; two test-only findings were
  dismissed as "used in tests". No alert is open.
- The desktop's Home page (the canvas's Main board), which the app now opens on; New and the brand mark open it.
- Two real bugs behind flaky tests are fixed: pilot ids now keep their order within a millisecond, and the
  desktop's argv cache ignores a parent pid that could not be read (the macOS Rust job caught it).
- The roadmap's phases are tracked in `docs/plan.md` ("Roadmap phases and coverage"). Since then:
  - Phase 0 is answered in `docs/phase-0-spikes.md`.
  - Phase 1's gate is measured: trial starts, subscription payments, owner activity, and a Pilot gate page in
    the console (`GET /v1/admin/pilot/gate`).
  - Phase 2's model gateway holds each call's worst case against the shop's monthly cap and settles it at what
    the provider bills (`docs/model-gateway.md`). Nothing calls a model until the owner adds a key.
  - Phase 3's desktop opens on a three-step first run on a new computer (Welcome, Your shop, One channel, Your
    team).
- Dev was redeployed on 23 Nov at 17:10, and again at 21:35 with the audit log, memory, Model spend, approvals
  through approval-core and the workers; both times smoke-tested (pages, Access on every operator route, the
  session approvals route refusing without a session, no-store and frame headers).
- Dev was redeployed on 24 Nov at 03:40 from `2a8fb77`, with the People page, routines running, shop templates and
  the drafts and shops pages (pages `55687ba9`, API `45d1a91e`); smoke-tested the same way, plus the routines and
  team routes refusing without a session and the templates route behind Access.
- Dev was redeployed on 24 Nov at 04:23 from `91fc300`, with the desktop's approvals contract, several shops, the console's
  owner link and the outpost's step channel (pages `d40cf7a7`, API `a20dfc84`, the new `OUTPOST_LIMITER` bound);
  smoke-tested: the step and shop-session routes answer 401 without a credential, the admin routes are behind Access.
- The night build's queue gained shop-memory, books and routine-rules; one run was started by hand for
  slip-rules.

## Next steps, in order

1. Four helpers are running (24 Nov), each on its own branch from `pilot/week-1`; review each, merge it after the
   full root gate, add its decisions to `docs/decisions.md` and mark both trackers in `docs/plan.md`:
   - item 11, the Playwright follow-up: the failing specs and a sharded CI job (`test/playwright-follow-up`, Sonnet;
     it opens a draft pull request into `pilot/week-1`: watch its CI, merge when the Playwright shards are green);
   - item 8b, the outpost in the desktop shell (`feat/desktop-outpost`, Opus; the first local Rust build, in the
     shared target folder `~/Library/Caches/manut-ai-cargo-target`);
   - browser control's slice 2, submitting steps through approval-core (`feat/browser-submit-steps`, Opus, API only);
   - the desktop's switcher, combined Needs you and per-shop offline cache (`docs/several-shops.md`, slice 2,
     `feat/desktop-shop-switcher`, Opus).
   Merged: items 2 and 3 (routines running, shop templates), 5 (the desktop answering approvals), 6 (macOS
   notifications on `notify-rules`), 7 (several shops, the API side) and its console owner link and session end, 8a
   (the outpost's step channel), 9 (desktop leftovers), the Playwright revival (#15) and `notify-rules` (#16).
2. The night build's queue is empty: add pure packages to `docs/plan.md` as the phases need them.
3. Next, from the December list in `docs/plan.md`, as slots free (at most four helpers on this Mac):
   - the desktop running submit steps, after 8b and browser control's slice 2; the cloud outpost after that.
   - Checked 24 Nov: the rate limiters' namespace ids in `apps/api/wrangler.jsonc` (2026112301 to 2026112332) clash
     with no other Worker in the Cloudflare account, whose other limiters use only 1001 and 1002. Pick new ids from
     2026112333 up for the next limiter.
   Parked by the owner: LINE (`feat/owner-line-cards` holds owner cards and the morning brief, not reviewed or
   merged) and payments (the owner's billing page, anything new about payments, slips or refunds).
4. The dry run on dev with two test shops: a LINE message in, a draft, approval on the web, the reply out, an
   audit row. It waits for a test LINE Official Account. Turn on `officeInbound`, `officeCloud` and
   `officeExternalWrites` for dev only when that exists. Redeploy dev after the next merges.
5. Deletion follow-up: a shop whose wipe stopped after its registry row went leaves the console's list; only
   the owner's page then shows it as deleting.
6. Keep these docs, and where a session can reach them, the plan doc and the design canvas, in step with what lands.

## Needs the owner

- **Confirm the console behind Access:** open https://dev.manut.xyz/ops, log in with the emailed code, and
  paste the operator key (`security find-generic-password -s manut-dev-operator-key -w | pbcopy`). The shop
  list should load. That proves the admin gate gets `ctx.access` on the deployed front door.
- **Merge pull request #1 into `main`** when happy. That also switches on Dependabot, the weekly CodeQL scan and
  the Deploy dev button, because GitHub reads those from the default branch.
- **A test LINE Official Account** for the dry run (later, by the owner's choice).
- **Staging and production in a separate Cloudflare account** before they exist. A Cloudflare token cannot be
  limited to one Worker.
- **After a week of green CI,** require the checks on `main`; the command is in pull request #4.
- **pnpm 12 writes a two-document lockfile** that GitHub's dependency graph cannot read, so npm packages get no
  Dependabot alerts. The fix (`pmOnFail: ignore`) changes the lockfile and how pnpm is pinned.
- **From `docs/connectors.md`:** each approved reply is a LINE push, which counts against the shop's monthly
  quota (300 on the free plan). Shopee chat is closed to third parties. Lazada and Meta need applications started now.
- **A look at the approval page on a real phone.**
- **Model gateway (money):** an Anthropic API key from a paid account, as a Worker secret, only when models
  should run; the exchange rate (default ฿35.00 a dollar) and each shop's monthly cap (default ฿200); a check of
  the prices in `docs/model-gateway.md` against Anthropic's pricing page.
- **The gate's rules:** shops that ask for deletion leave the cohort (keeping them needs a snapshot at deletion);
  subscription payments are deleted with the shop (whether Manut AI must keep its own billing records is a legal
  question); a payment before day 15 counts as paid.
- **First run:** who writes the Thai copy; whether the Team screen gets the practice-mode switch that step 3's
  canvas text promises.
- **Mission Control's words:** a native speaker's check of the new Korean, Japanese and Chinese strings; the
  activity log's "Kept for 12 months, then deleted for good" is a policy promise the API must keep before any
  shop sees it.
- **The offline cache's contents:** the desktop keeps reply drafts, recipients' LINE ids and schedule prompts
  unencrypted in an owner-only file for up to 7 days; say if that is acceptable, or if 7 days is wrong.
- **Workers:** whether drafts should age out after 7 days like the messages they quote; whether the owner can end
  practice mode early and whether 3 days is right.
- **Routines' switches:** `officeRoutines` and `officeCloud` are off in every environment, so each routine run is
  written down as `skipped` (`routines_off`) until someone turns them on with `PUT /v1/admin/flags`. Real drafts
  also need the model key; stock routines need a stock feed; "Send the books" only drafts until FlowAccount is
  connected. The console's new words (New shop, First week) need Thai copy.
- **Night replies:** the canvas's routine "Every night after 21:00: Answer order-status questions" reads as Nam
  replying alone; the rules (and CLAUDE.md) make every reply to a customer ask first, so the desktop shows
  "Asks first" on it. Say if night replies about order status may go without asking.
- **Helpers:** a real sign-in for them (LINE Login is parked; email sign-in needs a sending service, which may
  cost money; today only an email Apple verified can accept an invite); whether helpers' decisions should count
  toward the pilot gate (they do not now).
- **The console's first page:** it opens on the first shop's messages; say if it should open on the new Shops
  overview instead.
- **Notifications (item 6):** try a built app, not `tauri dev` (dev borrows Terminal's identity), to see the
  Approve and Look first buttons; the new window and badge permissions take effect at the next Tauri build. Quiet
  hours are on from the first run, 22:00 to 08:00 Bangkok time, with no time zone picker; say if they should start
  off. The Dock number now counts only what waits for an answer, not unread automation answers.
- **Sign-in for owners:** the desktop's connected runtime works only with a pasted test token against a local API
  today. A real sign-in needs an Apple developer team (Sign in with Apple for `xyz.manut.desktop`, team-signed
  builds, `APPLE_CLIENT_ID` on the Worker), or LINE Login, which is parked with LINE. Also: how an owner's
  identity links to their pilot shop (no session can read a `pilot:` tenant yet).

## Known flaky tests (they fail only under heavy load)

- `apps/desktop` `src/sessions/term/engine-osc52.test.ts`: builds clipboard-sized strings, can pass 5 seconds.
- `apps/desktop` `src/runs/boxView.test.ts`: can pass 30 seconds when the machine is saturated.
- `apps/web` `test/ShopDataTab.test.tsx`, "says when the API could not be reached": failed once in a loaded full run.

## Practical notes for this Mac

- 8 GB of memory: one Rust build at a time (`CARGO_BUILD_JOBS=4`). Run tests one command at a time when helpers
  are running. CI now runs the Rust and Playwright suites on GitHub.
- `pnpm install --frozen-lockfile` works on a clean checkout. `pnpm test` (about one minute) and `pnpm typecheck`
  must pass before every commit; push only after they pass (`pnpm test && git push`).
- `pnpm --filter @manut/api dev` runs both Workers on one origin at localhost:8787.
- Deploy dev from `apps/api`: `wrangler deploy -c wrangler.web.jsonc --env dev`, then `wrangler deploy --env dev`.
  Wrangler on this Mac is signed in with the owner's Cloudflare login, which sees more than one account, so set
  `CLOUDFLARE_ACCOUNT_ID` for the command (the value is in the GitHub `dev` environment's secrets). Run
  `node ../../.github/scripts/check-dev-deploys.mjs wrangler.web.jsonc wrangler.jsonc` first: it refuses any
  Worker whose name does not end in `-dev`.
- GitHub: `git push` works as it is. For `gh`, prefix commands with
  `GH_TOKEN="$(gh auth token --user KunanonJ)"`; the default `gh` account cannot see the organisation.
- Secrets never go into source, logs, tests or chat. A secret the owner gives arrives through T3 Code's secure
  prompt as a file only a command reads.
