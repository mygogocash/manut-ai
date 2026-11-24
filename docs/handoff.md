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
- Dev was redeployed on 24 Nov at 06:21 from `e2ab4e7`, with macOS notifications' package changes and the owner's link
  page naming the helper who decided (pages `c2d41d40`, API `85c2dd36`); smoke-tested: a bad link answers 404, the
  shops route 401 without a session, the approval page loads, the admin routes are behind Access.
- Dev's API was redeployed on 24 Nov at 06:51 from `8b49ff9`, with browser control's slice 2 and the begin gate's
  race fix (API `66c25549`; the pages did not change); smoke-tested: the outpost's steps and the approvals answer 401
  without a credential, a bad link 404, the admin routes are behind Access.
- Dev's API was redeployed on 24 Nov at 07:02 from `88d6b15`, with the desktop outpost's registration route (API
  `941d9565`); smoke-tested: registering, the steps and the approvals answer 401 without a session.
- Dev's API was redeployed on 24 Nov at 07:17 from `abd2333`, with an owner's shop session on the memory, consent,
  export and helpers (API `fcfcfdaf`); smoke-tested: those routes answer 401 without a session.
- Dev was redeployed on 24 Nov at 07:32 from `e6d8f5a`, with the deletion follow-up in the API and the console
  (pages `0f73ff1f`, API `9c50074a`); smoke-tested: the console and the admin routes are behind Access, the owner's
  routes answer 401 without a session, the approval page loads, and the served bundle is the one just built.
- Dev's API was redeployed on 24 Nov at 07:57 from `df6094b`, with the new-device route and the outpost's `not_run`
  (API `8ec35ae7`); smoke-tested: the devices route answers 401 without a session.
- Dev's API was redeployed on 24 Nov at 08:39 from `601192a`, with re-sealing the vault (API `d7d4e7f2`);
  smoke-tested: the route is behind Access. To rotate the vault's key, follow `docs/pilot-api.md`, "Re-sealing the
  vault after a key rotation": keep `CRED_KEY_PREVIOUS` until every shop answers `remaining` 0.
- The night build's queue gained shop-memory, books and routine-rules; one run was started by hand for
  slip-rules.

## Next steps, in order

1. Four helpers are running (24 Nov). Items 20, 21 and 24 stopped at the account's 5-hour usage limit at 08:15 and
   were sent on again at 09:35 in their own threads (`t3_thread_send`, as for item 9), once a new helper (item 25)
   showed the limit no longer held. They run, each on its own branch from `pilot/week-1`; review each, merge it after the
   full root gate, add its decisions to `docs/decisions.md` and mark both trackers in `docs/plan.md`:
   - item 21, Customize › Connections for the owner: the shop's sign-ins and outposts (`feat/owner-connections`,
     Opus);
   - item 20, the connected desktop's whole shop: a pilot shop's pages for its owner, Mission Control's team and
     jobs from the API, routines' pause and Pause everyone (`feat/connected-whole-shop`, Opus);
   - item 24, the console catching up with the owner's new routes (`feat/console-catch-up`, Sonnet);
   - item 25, the shell naming the tool and the path on an agent's ask (`feat/ask-fields`, Opus; a Rust build).
   Merged: items 2 and 3 (routines running, shop templates), 5 (the desktop answering approvals), 6 (macOS
   notifications on `notify-rules`), 7 (several shops, the API side) and its console owner link and session end, the
   desktop's switcher with one Needs you across the shops (several shops, slice 2), 13 (an owner's shop session on
   the shop's memory, consent and export, and managing helpers; slice 4), 8a
   (the outpost's step channel), 23 (re-sealing the vault after a key rotation, `POST /v1/admin/vault/reseal`, and a
   worker's list of its sign-ins), 16 (a shop whose deletion stopped stays listed and can be finished), 8b (the outpost in the desktop shell; its Rust tests run in CI, and a shared target
   folder for local Rust builds is `~/Library/Caches/manut-ai-cargo-target`), browser control's slice 2 (a write asked for first, and the begin gate's race fixed),
   9 (desktop leftovers), 18 (the code editor's states for developers: Kit's dial, command asks, reads outside the
   project blocked, keys in changes; `docs/code-editor.md`), 12 (a browser write shown word for word, then submitted by the outpost), 15 (a helper's new
   device as an alert), 11 (the Playwright follow-up, #17: every spec runs, in six
   CI shards), 14 (the owner's link page naming the helper who decided), the Playwright revival (#15) and
   `notify-rules` (#16).
2. The night build's queue is empty: add pure packages to `docs/plan.md` as the phases need them.
3. Next, from the December list in `docs/plan.md`, as slots free (at most four helpers on this Mac):
   - item 17 (an installable web app) waits for owners' sign-in, as there is no owner home page yet;
   - item 19 (the outpost following the shop sessions), after 21, which changes the same outpost code; the cloud
     outpost after that (it may cost money).
   - items 25 to 29, the code editor's states left for later that need no owner (`docs/code-editor.md`), as slots
     free; item 30 (Kit's dial in a terminal) waits for the owner's chat-or-terminal call.
   - Checked 24 Nov: the rate limiters' namespace ids in `apps/api/wrangler.jsonc` (2026112301 to 2026112332) clash
     with no other Worker in the Cloudflare account, whose other limiters use only 1001 and 1002. Pick new ids from
     2026112333 up for the next limiter.
   Parked by the owner: LINE (`feat/owner-line-cards` holds owner cards and the morning brief, not reviewed or
   merged) and payments (the owner's billing page, anything new about payments, slips or refunds).
4. The dry run on dev with two test shops: a LINE message in, a draft, approval on the web, the reply out, an
   audit row. It waits for a test LINE Official Account. Turn on `officeInbound`, `officeCloud` and
   `officeExternalWrites` for dev only when that exists. Redeploy dev after the next merges.
5. Deletion: a stopped wipe now keeps the shop listed (item 16). Left: a deletion run through the session route keeps
   no pilot deletion record, and a shop mid-deletion still counts in the pilot gate (the owner's call).
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
- **Settle how an operator confirms an owner's link code before any real owner is linked.** Since item 13, a linked
  owner account gets the shop's whole export (customers' messages and LINE names, helpers' emails), can change
  consent and can remove helpers, so a wrong link now costs more. Also: whether helpers may read any of the memory
  (none today); and the words for giving and withdrawing consent in the app are legal terms.
- **Helpers:** a real sign-in for them (LINE Login is parked; email sign-in needs a sending service, which may
  cost money; today only an email Apple verified can accept an invite); whether helpers' decisions should count
  toward the pilot gate (they do not now).
- **The console's first page:** it opens on the first shop's messages; say if it should open on the new Shops
  overview instead.
- **Notifications (item 6):** try a built app, not `tauri dev` (dev borrows Terminal's identity), to see the
  Approve and Look first buttons; the new window and badge permissions take effect at the next Tauri build. Quiet
  hours are on from the first run, 22:00 to 08:00 Bangkok time, with no time zone picker; say if they should start
  off. The Dock number now counts only what waits for an answer, not unread automation answers.
- **From items 12 and 15:** the first real browser write on a real site (a Shopee chat reply, say) reaches a real
  customer, so it needs the owner's go-ahead and a supervised trial. A long LINE reply no longer offers Approve in a
  notification (only one line of at most 72 columns does). A browser write's sentence is the API's English in every
  language, since translating it would make the app's words what gets approved. The new-device alert says "remove
  access", but the app has no People screen yet, and "Notify me" off silences it: say if a security alert should ring
  regardless.
- **From item 18 (the code editor):** whether Kit's lanes are a chat (as the canvas's Code board draws) or a terminal
  (the 16 November decision); the dial reaches only chat sessions today. Also: a real GitHub account (projects from
  GitHub, checks on a pull request), a real sign-in to Claude Code, where developers' secrets live (the shop's vault
  or this Mac's keychain), and a native speaker's check of the new Korean, Japanese and Chinese words.
- **Connections for Ton's books (`docs/connectors.md`, 4a and 4b):** FlowAccount's Open API is by application
  (form.flowaccount.com/request-openapi, as an app partner for the OpenID flow), a 30-day sandbox first, and each shop
  needs its own Pro Business plan (฿457 a month, or ฿5,490 a year). Google Sheets needs a Google Cloud project of the
  owner's with an OAuth client for the `drive.file` scope only, which needs no Google review.
- **The cloud outpost** (`docs/browser-control.md`, "Next slices", 2): Cloudflare's hosted browser comes with Workers
  Paid (10 browser hours and 10 concurrent browsers a month included, then $0.09 an hour); ten pilot shops would cost
  about $8 a month above the plan. It needs the plan and the spending, and the owner's word that shops' sites may be
  reached from Cloudflare's addresses.
- **Sign-in, the biggest blocker:** `docs/sign-in-options.md` compares Sign in with Apple ($99 a year), a code sent by
  email (Cloudflare Email Service, about 3,000 emails a month with Workers Paid, then $0.35 a thousand) and LINE Login
  (free, parked), and recommends codes by email first. The owner chooses.
- **Sign-in for owners:** the desktop's connected runtime works only with a pasted test token against a local API
  today. A real sign-in needs an Apple developer team (Sign in with Apple for `xyz.manut.desktop`, team-signed
  builds, `APPLE_CLIENT_ID` on the Worker), or LINE Login, which is parked with LINE. Also: how an owner's
  identity links to their pilot shop (no session can read a `pilot:` tenant yet).

## Known flaky tests (they fail only under heavy load)

- `apps/desktop` `src/sessions/term/engine-osc52.test.ts`: builds clipboard-sized strings, can pass 5 seconds.
- `apps/desktop` `src/runs/boxView.test.ts`: its six layout property checks take 6 to 9 seconds each on an idle Mac
  (47 seconds for the file). Each now has 120 seconds (24 Nov); before that one had 30 and timed out under load.
- `apps/desktop` `src/pages/PausePage.test.tsx`, `src/sessions/attach.test.ts`, `packages/agent-events` and a few
  `apps/web` files: timed out only when the whole Mac stalled for half a minute with four helpers running; each passes
  alone.
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
