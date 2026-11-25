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
- Dev was redeployed on 24 Nov at 09:53 from `87891ce`, with the owner's vault and outposts routes (pages `704d2f11`,
  API `3c019e17`); smoke-tested: `/v1/vault/sign-ins` and `/v1/vault/outposts` answer 401 without a session.
- Dev's pages were redeployed on 24 Nov at 10:22 from `44a0c99` (pages `335dc6c5`), with the console's words for every audit action;
  smoke-tested: the console is behind Access and the approval page loads.
- Dev's API was redeployed on 24 Nov at 10:41 from `edd9ae4`, with the operator's start keeping Pause everyone (API
  `0316e338`); the admin route is behind Access.
- Dev's API was redeployed on 24 Nov at 12:12 from `fb889a2`, with sign-in by email code built and off, and its
  `AUTH_CODE_LIMITER` (API `48d340ac`); smoke-tested: both email routes answer 400 `email_not_configured`, a malformed
  body 400 `invalid_request`, Apple's exchange still refuses a bad token, and the console and admin routes are behind
  Access. The pages are unchanged since 10:22.
- Dev's API was redeployed on 24 Nov at 13:38 from `fe23fbe`, with Google Sheets for Ton's books built and off, and its
  `GOOGLE_CALLBACK_LIMITER` (API `c8f3f5b0`); smoke-tested: `/v1/google`, `/v1/google/connect` and the callback answer
  503 `google_not_configured`, email sign-in still answers `email_not_configured`, and the console and admin routes are
  behind Access. The pages are unchanged since 10:22.
- Dev was redeployed on 24 Nov at 13:45 from `a0e2fe5`, with the join page (pages `93c91c45`, API `c735118e`);
  smoke-tested: `/join/{token}` answers 200 with `no-store` and `no-referrer` (header and meta), the served bundle is the
  one just built, the approval page loads, and the console is behind Access.
- Dev's pages were redeployed on 24 Nov at 14:24 from `5dd244c`, with the owner's pages fitted to phones (pages
  `9d595c7b`); smoke-tested: every page serves the new bundle and loads, and the console is behind Access. For about a
  minute after a pages deploy a plain URL can still name the old bundle (the static assets' edge copy shows
  `cf-cache-status: HIT` whatever the page's `no-store`); a URL with a query string shows the new one at once.
- Dev was redeployed on 24 Nov at 14:33 from `52a8073`, with self-serve onboarding built and off and its
  `SELF_SERVE_SHOP_LIMITER` (pages `8d55119a`, API `2b70c478`); smoke-tested: `POST /v1/shops/new` answers 403
  `sign_ups_closed`, Google and email sign-in still answer that they are not on, every page serves the new bundle, and
  the console is behind Access.
- Dev was redeployed on 24 Nov at 15:22 from `754495b`, with the owner's web app and the shop-making journal (pages
  `03a467f6`, API `2a59734e`); smoke-tested: `/app/` loads with its own-origin script policy and `no-referrer`, its
  manifest is served, `POST /v1/web/shops` answers 403 `csrf_required` without `x-manut-web`, 403 `origin_forbidden`
  from another origin and 401 `signed_out` (with `emailSignIn: false`) from this one, and email sign-in and self-serve
  still answer that they are off.
- Dev was redeployed on 24 Nov at 15:38 from `445d47c`, with Google Sheets' two guards and its desktop row (pages
  `4ead247d`, API `17b0aeac`); smoke-tested: `/v1/google` still answers 503 `google_not_configured`, the pages and
  `/app/` load, and the console is behind Access.
- Dev was redeployed on 24 Nov at 16:49 from `0ff3d84`, with the owner adding a sign-in and changing its members (pages
  `38e22bea`, API `6e337079`); smoke-tested: `POST /v1/vault/sign-ins` and `/members` answer 401 without a session,
  the pages and `/app/` load, and the console is behind Access. The first try at 16:42 failed: this Mac's resolver
  held a failed answer for `api.cloudflare.com` for a few minutes while `dig` resolved it; Wrangler said "Unable to
  resolve Cloudflare's API hostname". Waiting it out worked; flushing the cache needs `sudo`.
- Dev's API was redeployed on 24 Nov at 17:22 from `d0670c3`, with the review's front-door fixes (API `de4ad72d`);
  smoke-tested: a `text/plain` POST from another origin answers 415 `json_required`, a JSON one
  `email_not_configured`, self-serve `sign_ups_closed`, the vault 401 without a session, and the console is behind
  Access. For about a minute after an API deploy the old version still answers some requests, as the pages' edge
  copy does; check a change again after a minute before calling it missing.
- Dev was redeployed on 24 Nov at 17:57 from `4f77bd7`, with the review's session and self-serve fixes (pages
  `19fb6c3d`, API `0dca257c`); smoke-tested: every page has a strict script policy (`script-src 'self'`; the join
  page names no other origin), self-serve answers `sign_ups_closed`, `DELETE /v1/tenant/data` answers 401 without a
  session, a `text/plain` POST 415, and the console is behind Access.
- Dev was redeployed on 24 Nov at 19:00 from `ce301c5`, with items 45 and 43 (pages `b3dba5ac`, API `9ef0a514`);
  smoke-tested: `POST /v1/vault/sign-ins/remove` and `/change` answer 401 without a session and 415 for `text/plain`,
  `GET /v1/admin/model/alerts` and `POST /v1/admin/vault/sign-ins/members` are behind Access, `/v1/google` still
  answers `google_not_configured`, and the pages, `/app/` and the join page load. The shops' TenantObjects now set an
  alarm (the model sweep); one with no alarm sets it when it next starts.
- Dev was redeployed on 24 Nov at 19:38 from `e9e9a71`, with item 44's task list (API `282a481c` first, then pages
  `ef7f070f`, since the desktop needs the new route); smoke-tested: `GET /v1/tasks`, `/v1/schedules` and
  `/v1/inbound/attention` answer 401 without a session and with a session that is not one, before any query check,
  `POST /v1/tasks` still 401, and the pages, `/app/` and the console's Access load.
- Dev's API was redeployed on 24 Nov at 20:53 from `9224fb1`, with item 48's approval lookup (API `4c340b5d`, deployed
  whole, not as a gradual rollout); smoke-tested: `GET /v1/approvals?state=open` and a decision answer 401 without a
  session, and the approval page, `/app/` and the console's Access load. The pages are unchanged since 19:38.
- Dev's pages were redeployed on 25 Nov at 02:39 from `1ea1207`, with item 50's Connections page (pages `7821c338`;
  the API is unchanged since 20:53); smoke-tested: `/` and `/app/` answer 200, and `/ops` and the admin vault and
  outpost routes answer 302 to Cloudflare Access without a key.
- Dev was redeployed on 25 Nov at 06:42 from `1e1e58c`, with item 49's two step failures (API `37beffbf`, deployed
  whole, then pages `d4e5c73c` with the console's words for them).
- Dev's API was redeployed on 25 Nov at 09:59 from `2692402`, with item 54's prune clearing the approval lookup (API
  `a9f869ba`, deployed whole; the pages are unchanged since `d4e5c73c`). Smoke-tested: the pages 200, `/ops` and
  `/v1/admin/prune` 302 to Access, and the session routes 401 with no session.
- Dev's pages were redeployed on 25 Nov at 11:47 from `caa40c3`, with item 57's Routines page in the console (pages
  `1258aef6`; the API is unchanged since 09:59). Only the pages Worker went; it has no route of its own, as the API's
  custom domain hands it the pages.
- Dev's pages were redeployed on 25 Nov at 13:05 from `8f77e43`, with item 59's Make a routine form (pages `e64ce7e6`;
  the API is unchanged since 09:59).
- The night build's queue gained shop-memory, books and routine-rules; one run was started by hand for
  slip-rules.

## Next steps, in order

1. One helper is running (24 Nov). Items 27, 28 and 29 stopped at the account's 5-hour usage limit at about 11:00
   and were sent on again at 11:17 in their own threads (`t3_thread_send`), as items 20, 21 and 24 were at 09:35. At
   13:02 items 10, 34, 35 and 36 stopped at the limit ("resets 4:10pm"); 35, 34 and 10 were sent on at 13:16 to 13:20
   and ran, and 36's follow-up stayed queued so that three work at a time; it was sent on once 34 finished.
   At 15:45 items 39 and 40 and the security review stopped at the limit again ("resets 6:10pm"), before either item
   pushed anything. At 16:02 the review and item 40 were sent on in their own threads; item 39 waits for one of them
   to finish, as three heavy helpers at once reached the limit three times on 24 Nov. A
   helper that ends its turn while its own gate runs in the background is marked finished without a report: send it on
   to wait with `t3_background_wait`.
   On 25 Nov at 16:06 the owner moved the lead from T3 Code to a Claude Code session on this Mac ("continue this
   session"). Nothing runs in T3 Code now. The two helpers that were running there (items 61b and 62) had stopped
   with their commits made but not pushed and one uncommitted edit each; the lead finished and merged both (below).
   Helpers are now that Claude Code session's own subagents, each in a worktree the lead made beside T3's
   (`~/.t3/worktrees/manut-ai/cc-item<N>-<name>`), and they stop when that session ends: check each worktree for
   commits that were never pushed before starting anything again.
   They run, each on its own branch from `pilot/week-1`; review each, merge it after
   the full root gate, add its decisions to `docs/decisions.md` and mark both trackers in `docs/plan.md`:
   - item 63, the desktop's release builds in CI and the updater turned on (`feat/release-builds`, Sonnet, worktree
     `cc-item63-release`), started 25 Nov at 16:13.
   - item 66, Kit as a chat from the + menu, beside the terminal (`feat/kit-chat-lane`, Opus, worktree
     `cc-item66-kit-chat`), started 25 Nov at 16:13.
   A helper's run can also fail when the API sends nothing for 10 minutes; that is not a usage limit and nothing sends
   it on. Item 50 failed so at 00:39 on 25 Nov, after its page, tests and visual check: its last commit was local only.
   Push such a commit from the helper's worktree, review it and finish what is left as the lead.
   A Stop on the lead's thread also stops its helpers, and nothing resumes them: on 25 Nov items 53 and 55 were sent on
   in their own threads (`t3_thread_send`), which keeps their context, after checking each worktree for unpushed work.
   On 25 Nov item 51's run failed with "Your organization has disabled Claude subscription access for Claude Code":
   it did not last, since a new helper started at 09:50 runs. Nothing resumes such a run; item 51's commits were all made, so the
   lead pushed its branch from its worktree. If it happens again, build as the lead and don't switch providers unasked.
   Merged at the same time: the night build's `dev-url` (PR #19) and `preview-command` (PR #20), with the lead's fix
   that also refuses a script whose `pre` or `post` script publishes.
   The security review of 24 Nov (findings only) found no critical issue, two high and three medium ones that need
   `EMAIL_SIGN_IN` or `SELF_SERVE_SHOPS` on, and three low ones; its proofs are in the review thread's report, and
   `docs/turning-on.md` says to keep both switches off until items 41 and 42 merge.
   Merged: 61 with 61b (a shop's live feed, switched off: a hibernating WebSocket per shop session that says only
   that something changed, opened with a one-use ticket of 30 seconds that the session mints in `Authorization`,
   so no session reaches a header Cloudflare's logs keep; the helper's last uncommitted edit was a probe that took
   out the mint's refusal of a body with fields, a test fails with it out, and the lead put the line back), 62
   (the Runs layout made faster without changing an answer: the lead ran every exported function of `boxView.ts`
   beside the file from before the speed-up, on every call the tests make and on 750 layouts of 150 fresh seeded
   runs, 13,254 calls in all, and every pair of answers was equal; the file takes 19 seconds here, from about 50),
   60 (the offline cache sealed at rest: AES-256-GCM in the webview's Web Crypto, a fresh nonce each write
   and the version, origin and tenant bound in, under a key made from SecRandomCopyBytes and held only in the macOS
   keychain; version 6, a version-5 file deleted unread; the key deleted whenever the kept read is forgotten; no copy
   kept where there is no keychain; both usage-limit stops resumed by themselves at 13:50; desktop only, Rust changed),
   59 (making a routine from the console: a form whose every field `@manut/routine-rules` checks, every fault
   beside its field, asked first with the routine in the API's words and its next run, then exactly the route's body;
   asks first locked on for a reply, a send, a payment or a deletion; practice world v14; pages Worker redeployed),
   58 (the preview drawn in the pane: a sandboxed frame, `allow-scripts allow-same-origin allow-forms`, of the
   lane's own running preview at a localhost address; `frame-src` widened to localhost only; a navigation hook keeps
   the app's window to its own pages and this computer's addresses; a framed page was shown to reach no command or
   plugin in a scratch Tauri program on this Mac and in a Rust test through Tauri's own check; `[::1]` and Windows
   keep Open in browser only; macOS 11 itself and the real app binary not run; desktop only, Rust changed),
   57 (the console's Routines page: a shop's routines, whose job, when, the next run or why none, the last run,
   and its team, with pause, resume, remove and Pause everyone each asked first in its row; no making of routines yet;
   practice world v13; only the pages Worker is redeployed),
   53 (the preview itself, first slice: Start in a lane's Preview view runs the command `preview-command`
   chooses, as arguments, in the lane's own folder only, refused with `changed` if `package.json` moved since; the
   environment starts empty, takes what a dev server needs and sets each secret to its sample; `dev-url` finds the
   address, Open hands only a loopback address to the system browser, Stop ends the process group, and the app
   quitting, a reload or the lane closing stops it too; macOS and Linux only; Rust changed, desktop only, no deploy),
   55 (how a request that left was decided: when an ask leaves the connected desktop's open approvals with no
   answer from this app, one `state=recent` read for its shop, with that shop's own session, closes the card as approved
   or declined by whom, withdrawn, ended or timed out, or as before when it cannot say; at most 4 seconds; desktop only),
   56 (the outpost sets switches and check boxes a page draws itself, `role="switch"` or `role="checkbox"`
   with `aria-checked`, as it sets a check box, and refuses one half on, disabled or read-only; local pages in WebKit
   and Chromium only; the Rust tests run in CI, as `step.rs` changed only inside its `FIELDS` script),
   54 (the retention prune clears the approval lookup's entries of the requests it removes: the task notes
   the ids before it deletes them, reports them gone through the lookup's own report, and keeps what did not land
   for its next prune, the prune answering `prune_incomplete` with `approval-lookup` meanwhile; the API changed, so
   the next dev deploy carries it),
   51 (the pane beside a lane: Diff lists each file the session changed, from the chat's own steps, so a
   rewound turn's files leave it; Preview says the app has no preview yet and shows the Sample rows; Tests shows the
   last run's result, when, and its command with any key masked before it is cut, never its output; mocha, Playwright
   Test and `unittest` are read with the same pass rule, a flaky Playwright test counting as passed as its exit status
   does; desktop only, so nothing to deploy),
   52 (Show older on the connected desktop: History and the activity log say when a shop has more than its
   newest 50 tasks and read 25 more at a time from the list's cursor, with the shop's own session; the older pages live
   in memory only and the offline cache stays at version 5; the minute's read carries the tasks it pushes out into them,
   and lets them go only when 50 or more tasks were made between two reads; desktop only, so nothing to deploy),
   49 (the outpost on real-world forms: on macOS a hook of the outpost's own in front of wry's navigation
   delegate tells a frame from the page, so a refused frame fails no read and stops a write before its press with
   `navigation_refused`, nothing sent; fields in open shadow roots, check boxes, radio buttons and editors; every field
   read back before the press; a settings page that keeps its form read back after a fresh load; a sign-in over two
   pages, the password typed only on a page of the sign-in's own origins that asks for it, and `sign_in_interrupted`
   when a site asks for more; local pages only, and the owner's trial checklist is in `docs/browser-control.md`),
   50 (the console's Connections page: a shop's sign-ins and outposts from the admin vault routes, each list
   with its own failure; remove a sign-in, change who may use it, remove an outpost and give it a new credential, each
   asked first in its row; the credential shown once and held only in the page's state; no password typed in the
   console; practice world version 12; no API change, so only the pages Worker is redeployed),
   48 (a per-shop approval lookup in the TenantObject, written by the task object before a request opens,
   so `GET /v1/approvals` reads only the tasks it names and deciding finds its task in one read; approval-core's
   records stay the only truth; old shops build the lookup 25 tasks per read, walking every task until it is done;
   deploy dev plainly, never as a gradual rollout, so no old task object opens a request without an entry),
   47 (each coding lane in a git worktree of its own under `~/.manut/lanes`, on a branch made from the
   developer's, so lanes work at once and the developer's folder never moves; a folder goes only when its record, its
   path and git's own list agree it is the app's, never pruned, and forced only after the person's yes to what goes;
   Kit no longer sees the developer's uncommitted changes, and the chat says how many stayed behind), 46 (the owner's memory and routines on the connected desktop: remember, confirm, correct and forget a
   fact, make and remove a team routine, each change bound to the shop its list was read for; it also fixed the
   Connected Playwright stubs item 44 had left serving only the export, which failed nine `google-sheets` specs and one
   `make-shop` spec in CI on `d74eaf1`. The root gate runs no Playwright: when a merge changes what Connected reads, run
   the Connected specs that stub the API before pushing), 44 (`GET /v1/tasks`, the session's own tasks newest first, 25 a page with a stable cursor, each task
   answering for itself in its own object; an owner's shop session also reads `/v1/schedules` and
   `/v1/inbound/attention`; the connected desktop reads the newest 50 tasks instead of the export, with cache version
   5, and a screens test pinned from the export-based code), 43 (the model gateway's sweep and alerts: the shop's TenantObject now has an alarm, a list of jobs, which
   charges a reservation nothing settled a minute after it expires; each month notes 80% and 100% of its cap once, from
   charged spend only, with `model.cap_near` and `model.cap_reached` in the audit log; the console's Model spend page lists
   the shops near or at their caps from rows kept in AuthObject beside the registry, `GET /v1/admin/model/alerts`), 45 (the owner removes a sign-in, and changes its account or addresses, from the app: `POST /v1/vault/sign-ins/remove`
   and `/change` through the vault's own operations; a change that could send a saved password somewhere new needs it typed
   again in the same change, and only taking addresses away may keep it; the operator's `POST /v1/admin/vault/sign-ins/members`
   through the owner's vault operation), 39 (Bring it back after a rewind: `turn_files.rs` keeps the files from just before a rewind the agent agreed
   to until the next turn starts, puts them back with no file changed by hand since overwritten unless the person
   unticks it, and never through a link; the chat is not brought back, since neither agent has a message for it; the
   main-moved note reads each lane's own base and shows on its row), 42 (the review's sessions and self-serve: 20 self-serve shops a Bangkok day, a self-serve shop's team waiting
   until an operator counts it in, a per-tenant session index and a swept auth object, paged shop scans, a limit on
   `DELETE /v1/tenant/data`, the web app's shop cookies needing the sign-in, ten sessions a helper and a limit on opening
   them, and a strict script policy on every page; `SHOP_SESSION_LIMITER` took 2026112349 to 52), 41 (the review's front door: limits per IPv4 address or IPv6 /64, JSON-only POSTs, code emails capped per
   source (20 a day) and in all (300), an address's own limit per source, `email:` sessions refused on the lifted routes
   and the shop routes answering a non-shop 404, test keys only on a `.test` origin, the deploy check reading every
   block; Apple sessions still reach the lifted routes and must not when Apple sign-in is turned on), 40 (the owner adds a sign-in and changes who may use it, from the app: `POST /v1/vault/sign-ins` and
   `/members`, through the vault's own operations), 37 (Google Sheets on the desktop: Customize › Connections' row, the append shown whole before Approve, a
   month already sent asked again only with words that say so, and a shop's deletion revoking its Google token first),
   38 (a shop make is journalled first and the same request finishes the same shop, nothing is listed until
   whole, and a self-serve slot is never lost; `docs/pilot-api.md`, "A make that stops part way"), 17 (the owner's web app at `/app/`: `__Host-` HttpOnly SameSite=Strict cookies read only by five routes
   under `/v1/web/`, which need `x-manut-web` and this origin; a service worker that caches the shell only, never `/v1`;
   `docs/web-app.md`), 36 (self-serve onboarding, built and off: `POST /v1/shops/new`, three shops an account, `sign_ups_closed`
   until `SELF_SERVE_SHOPS` is on, left out of the pilot gate unless an operator counts it in), 35 (the owner's pages on phones: Playwright in `apps/web/e2e` on four phones, run in CI as "Web on phones";
   it found and fixed a 34px button and a long name that widened the page; the join page's states are added by item
   17), 10 (the join page at `/join/{token}`, with the web's sign-in by email code kept in the page's memory
   only, `no-referrer` and `no-store`, and no request to another origin), 34 (Google Sheets for Ton's books, built and off: the owner's Google sign-in with `drive.file` only, the
   append asked as an owner-only command and sent once; the broker now sends an operation only through a connection of
   its own provider; turning it on is in `docs/connectors.md` 4b), 33 (the desktop's sign-in by email code in Settings › Developer, kept and refreshed as Apple's is), 32
   (Settings › People for the owner: helpers, invite links to copy, Cancel, Remove, cover dates; the
   new-device notification opens it), 31 (sign-in by a code sent by email, built and off: both routes answer `email_not_configured` until
   `EMAIL_SIGN_IN` is on, a sender is bound and `APPROVAL_LINK_SECRET` is set; the dev deploy check now refuses any `TEST_`
   var), 26 (rewinding a turn, files and chat together: `turn_files.rs` keeps each turn's files as git trees under
   `refs/manut/snapshots` or an owner-only copy, and never writes through a link; a lane now says when the files went
   back), 28 (what keeps running, with its age, its ports and Stop; `running.rs` reads only the process trees under
   the app's own sessions, and Stop checks each process again by its start time before each signal), 29 (a preview with sample values, and main moving while Kit worked, with Let Kit merge and Show me both;
   the shell's `git_moved.rs` only reads), 27 (Kit's lanes on their own branches, with Checked, Tests failed and
   Reverted; `lane.rs` makes a lane's branch with `git checkout -b`), items 2 and 3 (routines running, shop templates), 5 (the desktop answering approvals), 6 (macOS
   notifications on `notify-rules`), 7 (several shops, the API side) and its console owner link and session end, the
   desktop's switcher with one Needs you across the shops (several shops, slice 2), 13 (an owner's shop session on
   the shop's memory, consent and export, and managing helpers; slice 4), 8a
   (the outpost's step channel), 23 (re-sealing the vault after a key rotation, `POST /v1/admin/vault/reseal`, and a
   worker's list of its sign-ins), 16 (a shop whose deletion stopped stays listed and can be finished), 8b (the outpost in the desktop shell; its Rust tests run in CI, and a shared target
   folder for local Rust builds is `~/Library/Caches/manut-ai-cargo-target`), browser control's slice 2 (a write asked for first, and the begin gate's race fixed),
   9 (desktop leftovers), 19 (this Mac's outpost registered and run for the shop the switcher shows, and shown once
   on Connections), 20 (the connected desktop shows a shop the person owns whole, and pauses routines and
   everyone), 24 (the console's words for every audit action, held by a test that reads `audit-log.ts`),
   25 (each coding ask carries the agent's own tool, command and paths; Kit reads those, and a word the shell would
   expand asks), 21 (Customize › Connections for the owner: sign-ins with Change, outposts with Rename and
   Remove), 18 (the code editor's states for developers: Kit's dial, command asks, reads outside the
   project blocked, keys in changes; `docs/code-editor.md`), 12 (a browser write shown word for word, then submitted by the outpost), 15 (a helper's new
   device as an alert), 11 (the Playwright follow-up, #17: every spec runs, in six
   CI shards), 14 (the owner's link page naming the helper who decided), the Playwright revival (#15) and
   `notify-rules` (#16).
2. The night build's queue is empty: `env-example` (`9fa8151`), `dev-url` (PR #19) and `preview-command` (PR #20) were
   merged on 25 Nov, all three for the code editor's preview itself (item 53), which is the first to import them. Add pure
   packages to `docs/plan.md` as the phases need them; a run that finds the queue empty stops and says so.
3. Next, from the December list in `docs/plan.md`, as slots free (two heavy helpers at a time on this Mac; three or four
   at once swapped hard and reached the usage limit on 24 and 25 Nov):
   - running, for the desktop's first release, which is Practice mode and the code editor on the Mac (the owner, 25 Nov;
     the owner's Apple Developer account is the business's, an organization; sign-in and a model key are not needed for
     now): item 63 (release builds in CI, signed and notarized once the owner adds the secrets, Mac only in the draft
     release, and the updater on with the key made on 25 Nov, whose owner's copy is in `~/manut-ai-updater-key`), item
     66 (Kit as a chat from the + menu, beside the terminal, the owner's choice). Item 65 (a Thai dictionary for the
     desktop) is parked: on 25 Nov the owner said Thai is not needed yet. Item 64 (Apple sessions refused on the lifted routes, which turning
     Sign in with Apple on needs first) is parked until sign-in is wanted;
   - candidates that need no owner:
     - a helper's own session on the desktop (`docs/runtime-adapter.md`, "Next slices" 4);
     - a schedule's time zone shown when it is not this computer's (the same list);
     - the lane pane's Diff read from the lane folder's own git, so a restart does not start it empty, and a subagent's
       own edits in it (`docs/code-editor.md`, "Left for later");
     - keychain support on Windows and Linux, for the session and the sealed cache: CI has no Windows runner, so it
       would be built untested there;
   - the cloud outpost, once the owner approves its cost (`docs/browser-control.md`);
   - item 30 (Kit's dial in a terminal): the owner chose both on 25 Nov, so Kit's chat lanes come from the + menu
     (item 66) and the dial in a terminal stays a later idea.
   - Checked 24 Nov: the rate limiters' namespace ids in `apps/api/wrangler.jsonc` (2026112301 to 2026112332) clash
     with no other Worker in the Cloudflare account, whose other limiters use only 1001 and 1002. Items 31 to 42 took
     2026112333 to 2026112352 (four each: dev, staging, production and the top level); pick the next limiter's ids
     from 2026112353 up.
   Parked by the owner: LINE (`feat/owner-line-cards` holds owner cards and the morning brief, not reviewed or
   merged) and payments (the owner's billing page, anything new about payments, slips or refunds).
4. The dry run on dev with two test shops: a LINE message in, a draft, approval on the web, the reply out, an
   audit row. It waits for a test LINE Official Account. Turn on `officeInbound`, `officeCloud` and
   `officeExternalWrites` for dev only when that exists. Redeploy dev after the next merges.
5. Deletion: a stopped wipe now keeps the shop listed (item 16). Left: a deletion run through the session route keeps
   no pilot deletion record, and a shop mid-deletion still counts in the pilot gate (the owner's call).
6. Keep these docs, and where a session can reach them, the plan doc and the design canvas, in step with what lands.

## Needs the owner

Every switch that turns a built part on, and what each needs from the owner, is in `docs/turning-on.md`.

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
- **Model gateway (money): not wanted yet.** On 25 Nov the owner said people bring their own model: on the desktop
  each person signs in to their own coding agent with its CLI's login, or sets their own API key in that CLI, and
  the app reads which (`src-tauri/src/accounts.rs`). The cloud team members (Nam, Pim and Ton) keep drafting with the
  stand-in model until the owner wants them real. Then: an Anthropic API key from a paid account, as a Worker secret;
  the exchange rate (default ฿35.00 a dollar) and each shop's monthly cap (default ฿200); a check of the prices in
  `docs/model-gateway.md` against Anthropic's pricing page.
- **The gate's rules:** shops that ask for deletion leave the cohort (keeping them needs a snapshot at deletion);
  subscription payments are deleted with the shop (whether Manut AI must keep its own billing records is a legal
  question); a payment before day 15 counts as paid.
- **First run:** who writes the Thai copy; whether the Team screen gets the practice-mode switch that step 3's
  canvas text promises.
- **Mission Control's words:** a native speaker's check of the new Korean, Japanese and Chinese strings; the
  activity log's "Kept for 12 months, then deleted for good" is a policy promise the API must keep before any
  shop sees it.
- **The offline cache's contents:** the desktop keeps reply drafts, recipients' LINE ids and schedule prompts in an
  owner-only file for up to 7 days, sealed since December item 60 (AES-GCM, its key only in the keychain and deleted at
  sign-out, `docs/runtime-adapter.md`); say if 7 days is wrong.
- **Workers:** whether drafts should age out after 7 days like the messages they quote; whether the owner can end
  practice mode early and whether 3 days is right.
- **Routines' switches:** `officeRoutines` and `officeCloud` are off in every environment, so each routine run is
  written down as `skipped` (`routines_off`) until someone turns them on with `PUT /v1/admin/flags`. Real drafts
  also need the model key, which the owner does not want yet; stock routines need a stock feed; "Send the books" only drafts until FlowAccount is
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
- **Pause everyone (from item 20):** the API stops routines and new jobs (the operator's start too, since 24 Nov),
  but a job already running finishes and a request in Needs you can still expire; the canvas says everyone stops at
  the next safe point and nothing expires. Decide whether the API should match the canvas, or the canvas the API.
- **Sign-in, the biggest blocker:** `docs/sign-in-options.md` compares Sign in with Apple ($99 a year), a code sent by
  email (Cloudflare Email Service, about 3,000 emails a month with Workers Paid, then $0.35 a thousand) and LINE Login
  (free, parked), and recommends codes by email first. The owner chooses.
- **Sign-in for owners:** the desktop's connected runtime works only with a pasted test token against a local API
  today. A real sign-in needs an Apple developer team (Sign in with Apple for `xyz.manut.desktop`, team-signed
  builds, `APPLE_CLIENT_ID` on the Worker), or LINE Login, which is parked with LINE. Also: how an owner's
  identity links to their pilot shop (no session can read a `pilot:` tenant yet).

## Known flaky tests (they fail only under heavy load)

- `apps/desktop` `src/sessions/term/engine-osc52.test.ts`: builds clipboard-sized strings, can pass 5 seconds.
- `apps/desktop` `src/lib/sounds.test.ts` and `apps/web` `test/RoutinesView.test.tsx` ("pauses everyone in practice"): each
  failed once in the gate of 25 Nov at load 7 with a helper's gate beside it (the second waited past testing-library's one
  second for "Everyone is paused since 10:00 today."), and both passed when run alone. The web tests' waits are three
  seconds since `6771bc3` (`apps/web/test/setup.ts`).
- `apps/desktop` `src/runs/boxView.test.ts`: its six layout property checks take about 3 seconds each on an idle Mac
  (19 seconds for the file) since item 62 merged on 25 Nov; before it they took 6 to 9 (47 seconds). Each has 120
  seconds. GitHub's runner is far slower at them than this Mac: before item 62 the file took 615 seconds in CI's
  Desktop tests on `ab8521e` and one check passed its 120 seconds, which failed that run. If CI still comes near
  the limit, profile the layout again rather than raise the limit.
- `apps/desktop` `src/pages/PausePage.test.tsx`, `src/sessions/attach.test.ts`, `packages/agent-events` and a few
  `apps/web` files: timed out only when the whole Mac stalled for half a minute with four helpers running; each passes
  alone.
- `apps/web` `test/ShopDataTab.test.tsx`, "says when the API could not be reached": failed once in a loaded full run.
- `apps/desktop` `src/runtime/http/browserWrite.test.tsx`, "the chat's card, Home and Needs you": its first imports of
  three whole pages take about two seconds alone and went past the five-second default in four loaded gates on 24 Nov;
  it has thirty seconds since.
- `apps/api` `test/shop-making.test.ts`, the two "at every step" tests: each makes and checks a whole shop once for
  every step a make takes, and one went past the five-second default in a loaded gate on 24 Nov; both have thirty
  seconds since.
- Two API tests compared times written by two reads of the clock (24 Nov): the worker's oldest-first sign-in list
  (`browser-steps.test.ts`, its two sign-ins now made in different milliseconds) and a self-serve shop's audit entries
  (now written with the shop's own time). A Worker's clock moves only between requests, so watch for this pattern.

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
