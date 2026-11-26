# Plan and task queue

The working copy of the implementation plan, kept in the repository so any session (on the owner's Mac or a
cloud routine) can pick up without other context. The full plan is the doc "Manut AI: implementation plan
(reuse first)". `CLAUDE.md` has the rules; `docs/decisions.md` has every decision.

## Branches

- `main`: only what the owner has merged. Nobody else pushes or merges to it.
- `pilot/*` (for example `pilot/week-1`): the active working branch. The most recently updated `pilot/*` branch
  on the remote is the active one.
- `cloud/<task-id>`: one branch per task done by a cloud routine, cut from the active branch, with a draft pull
  request into the active branch.

## Where things stand (23 Nov 2026)

Week 1, the pilot slice:

- [x] Repository and workspace; GoSpark's cloud backend lifted as `apps/api` (449 tests)
- [x] `packages/approval-core`: settle-once approval rules (46 tests)
- [x] `packages/promptpay`: PromptPay QR payloads (14 tests)
- [x] `docs/pilot-api.md`: the contract between `apps/api` and `apps/web`
- [x] LINE Official Account connector, signed approval link and payment records in `apps/api` (497 tests)
- [x] Owner's approval page and operator console in `apps/web` (37 tests)
- [x] Serve `apps/web` and `apps/api` from one origin, so the console needs no CORS and Cloudflare Access covers both: the API Worker is the front door and hands pages to a pages Worker (checked by `pnpm test`)
- [x] Operator routes to export and delete one shop's pilot data, and the console's Shop data tab for both; deleting a live shop waits for its owner's yes through a signed link
- [ ] A real-phone pass of the approval page, and a first real LINE push in a dev environment (the pass in a browser engine at
  phone sizes is built, December item 35, and runs in CI as "Web on phones"; a real phone and LINE's browser stay with the
  owner, `docs/phone-pass.md`)

Week 2, brought forward:

- [x] `apps/desktop`: fork of Oh My Hermes with the Hermes bridge removed (1,358 unit tests, `cargo check` passes)
- [x] `apps/desktop`, next pass: the canvas side menu and screens, a real runtime adapter against `apps/api`, approvals through `packages/approval-core`, and a triage of the 156 Playwright specs (some still expect removed screens). Done by 24 Nov: the side menu and its pages (Phase 3 below), the connected runtime (`docs/runtime-adapter.md`), answering approvals through the session decide route and approval-core (December item 5), and the Playwright revival and its follow-up (pull requests #15 and #17, December item 11), which run every spec in CI
- [x] `packages/agent-events`: the agent event contract ported from GoSpark (213 tests)
- [x] `docs/connectors.md`: what to apply for with LINE, Shopee, Lazada and Meta
- [ ] Dry run with two test shops: dev is deployed at https://dev.manut.xyz; waits for a test LINE Official Account

## Roadmap phases and coverage

The roadmap (`~/Developer/gospark-main/manut-ai-artifacts/pages/roadmap.html`, as of 22 November 2026) has
seven phases. Each ends at a gate that real results decide: paying shops, a full day on the desktop app, and
so on. Only the owner can pass a gate. Covering a phase here means building and testing its engineering
deliverables, and saying what its gate still needs. The owner approves anything that cannot be undone, every
phase goes through the one approval object and audit log, and cost per shop is measured from Phase 2 on.

Status: **built** (tested and merged), **being built** (a helper is on it), **partial**, **not yet**, or
**owner** (needs an account, money or a decision only the owner can give). The night build (a scheduled cloud
run, `docs/cloud-routine.md`) takes one queued package per run, from 22:00 Bangkok time.

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 Spikes | Drive the DeepSeek Harness; pause and resume approvals with LangGraph.js; draft the worker adapter contract | built: all three answered in `docs/phase-0-spikes.md` (the gate's question; a model account for `dsh` is the owner's) |
| 1 Pilot | Buddy on LINE run by operators; simple web approval view; tenant and owner records; simplest approval object | built |
| 1 Pilot | Approval cards and a morning brief sent to owners on LINE | owner: parked for later (23 Nov); built on `feat/owner-line-cards` (API, console, contract), not reviewed or merged |
| 1 Pilot | The gate's numbers: 14 free days, paid ฿499, active on day 14, per shop | built: `GET /v1/admin/pilot/gate` and the console's Pilot gate page; the gate itself waits for real shops |
| 1 Pilot | Audit log an operator can read | built: one log per shop, metadata only (`GET /v1/admin/audit`), and the console's Audit page |
| 2 Control plane | Tenancy and sign-in, the approval core, saved sessions | built, with real sign-in off until the owner turns it on: `packages/approval-core` decides every send (replies, deletions and workers' requests), and sessions read approvals as its wire records; one person can own several shops and help at others, with a session per shop whose shop and role come from the shop's own record (`docs/several-shops.md`); sign-in by a code sent by email is built and off (item 31, the API; item 33, the desktop's screen; the web's comes with the join page, item 10). Turning a real sign-in on is the owner's: a yes to codes by email with the Workers Paid plan and a sending domain, or an Apple developer team for Sign in with Apple, or LINE Login, which is parked |
| 2 Control plane | The model gateway with spending caps, and cost per shop | built (`docs/model-gateway.md`), with the console's Model spend page, which lists the shops near or at their caps (item 43), and a sweep that charges an abandoned call on a timer; no model is called until the owner adds an Anthropic key and settles the rate and the cap |
| 2 Control plane | Memory; the job queue; the audit log | built: the job flow, the audit log, and what the team knows (stored per shop, with the console's Memory page); workers read memory when they are built in Phase 4 |
| 2 Control plane | Gate: the whole job flow end to end with a stand-in worker | built as a test (`apps/api/test/job-flow.test.ts`) |
| 3 Desktop MVP | Mission Control and the session view | built: Home, the side menu and pages, the job view, the activity log and Pause everyone, in Practice and Connected, where a shop's work is read from its newest 50 tasks a page at a time rather than its whole export (item 44), with Show older on History and the activity log reading further back 25 at a time (item 52) (a shop the person owns is read whole with its owner session: the team, jobs, the activity log, routines; Buddy's chat waits for a model) |
| 3 Desktop MVP | Three-step onboarding; offline cache; a real runtime adapter to `apps/api` | built: the three-step first run; a connected runtime (Settings › Developer) that signs in with Apple or a code sent by email, reads the shop and answers its approvals through the session decide route; the offline cache; Settings › People for the owner (item 32); Customize's memory and routines for a shop the person owns (item 46). Real use waits for a sign-in the owner turns on |
| 4 Workers | Three agents (sales chat, content, light bookkeeping), permissions, memory in sessions | built with a stand-in model: Nam, Pim and Ton draft through the job flow with member-grants' permissions and confirmed facts (`apps/api/src/workers.ts`); real models wait for the owner's key, which the owner does not want yet (25 Nov: people bring their own model to the desktop, by a CLI login or their own API key), and sending stays behind the approvals (LINE is parked) |
| 4 Workers | Connections: LINE OA, Shopee, Lazada, FlowAccount, Google Sheets | partial: LINE built; Google Sheets for Ton's books is built and stays off until the owner's Google Cloud OAuth client exists (item 34: the `drive.file` scope only, so no Google review, the request from `@manut/sheets-rows`, each month's append asked first); FlowAccount's Open API is by application, with a paid Pro Business plan per shop; Shopee chat is closed, and Lazada and Meta need applications (`docs/connectors.md`) |
| 5 Launch | Web and LINE clients, routines, browser control, the vault, PromptPay billing, two shop templates, the admin panel | partial: routines run on the schedule object (each run waits for the owner's switches); browser control and the vault are built (site sign-ins and outposts, which the owner adds, changes and removes from the app, items 40 and 45, the step channel with its limit, removal and credential rotation, writes asked first and run once, this Mac as the outpost of the shop the switcher shows); the three shop templates, applied when a shop is made; the admin panel is the console (gate, audit, memory, model spend, people, shops, connections: a shop's sign-ins and outposts, item 50, and routines: a shop's routines and its team, paused, resumed or removed from the console, item 57, and made there, item 59). The web client: the owner's approval and deletion pages, checked at phone sizes in CI (item 35), the join page (item 10) and the installable web app at `/app/` (item 17, `docs/web-app.md`) are built; the web app signs in once email sign-in is on. The gate's self-serve onboarding is built and stays off until the owner opens sign-ups (item 36). Every switch the owner turns is listed in `docs/turning-on.md`. Parked by the owner: PromptPay billing and the LINE client |
| 6 Expand | Phone apps, computer control, several shops in one view, more roles and businesses, the full code editor | partial: several shops in one view is built (`docs/several-shops.md`: the API, the console's owner link, the desktop's switcher with one Needs you across the shops); more roles are built (the owner's helpers, deciding by role, Settings › People) and three kinds of shop as templates; computer control is built as far as the desktop outpost's browser (open, read, sign in, and writes asked first and run once, item 12, and real-world forms: frames told from the page, open shadow roots, check boxes, radio buttons, editors, settings pages that keep their form, and sign-ins over two pages, item 49), and the first real write on a real site waits for the owner's go-ahead and a supervised trial; the code editor's states for developers are built (items 18, 25, 26, 27, 28, 29, 39: Kit's dial and command asks, lanes on their own branches, each in a working folder of its own (item 47), with Checked or Tests failed, a preview with sample values, main moving, what keeps running with Stop, Rewind with Bring it back, and the pane beside a lane with Diff, Preview and Tests, item 51, whose Preview starts the project's own dev server in the lane's folder with sample secrets, item 53, and draws its page in a sandboxed frame beside the chat, item 58), and Kit's dial for a session in its own terminal (item 30) waits for the owner's call on chats and terminals; phone apps wait, as the roadmap says, until the desktop product is complete, and the installable web app (item 17) covers the owner's pages on a phone until then |

## December engineering (the owner's go, 23 Nov 2026)

Everything here can be finished in December without the owner. LINE and payments stay parked; turning real
sign-in on, real models, Thai copy and production wait for the owner. One helper per line, at most four at a time on this
Mac; each starts when a slot frees and what it waits on has merged.

| Order | Work | Waits on | Model |
| --- | --- | --- | --- |
| done | The desktop's Customize page (memory and routines) | | Sonnet |
| done | 1. Console: the workers' drafts and a shops overview | | Sonnet |
| done | 5. The desktop answering approvals (through the session decide route; real use waits for sign-in) | | Opus |
| done | The owner's helpers, and deciding approvals from a session | | Opus |
| done | 2 and 3. Routines running on schedule, and applying a shop template (runs wait for the owner's `officeRoutines` and `officeCloud` switches) | | Opus |
| done | Browser control, first slice: vault sign-ins and outposts | | Opus |
| done | 8a. The outpost's step channel in the API: workers' browser steps (open, read, sign in) reach an outpost and land in the attempt's events; removing an outpost and replacing its credential; an ingress limit on the outpost routes | | Opus |
| done | Browser control slice 2: submitting steps through approval-core (API). A write step (`submit`) is asked for through member-grants' decide and one approval-core request naming the exact site, page and values, of the kind a fixed table gives its action; once approved it is handed to its outpost once, through the broker's one-use begin gate, which now also holds against begins at the same time (`docs/browser-control.md`) | | Opus |
| done | 4. Console: the People page | | Sonnet |
| done | 7. Several shops in one view: the design and the API side (`docs/several-shops.md`); the desktop switcher is next | | Opus |
| done | Several shops: the console's owner link, and ending a shop session (`docs/several-shops.md`, slices 3 and 5) | | Sonnet |
| done | The Playwright revival (pull request #15): 555 specs pass in CI | | Haiku |
| done | 11. Playwright follow-up: the 31 specs still failing (the old sidebar's Tasks bar, zoomed split panes, reply there, a font width on Linux) and the 219 the 35-minute cap leaves unrun (shard the job): all 31 fixed or deleted, and six shards run every spec | | Sonnet |
| done | 9. Desktop leftovers (the Team page's member menu and lines, Needs you, History's chips) and three app bugs the revival found (the undo toast, the folder reveal, the usage caret) | | Sonnet |
| done | 6. macOS notifications on `@manut/notify-rules`: every notification and the Dock count follow its rules, Approve for messages and replies only, Hide details and quiet hours in Settings | | Sonnet |
| done | 10. A join page for helpers' invite links (`/join/{token}`), with the web's own sign-in by email code, its tokens kept in the page's memory only (a lasting web session is item 17's); real use waits for the owner to turn sign-in on | | Opus |
| done | 8b. The outpost in the desktop shell (this Mac): registering, heartbeat, fetching steps, typing a sign-in only on its origins, reporting; registered through the owner's session | | Opus |
| done | Several shops, slice 2: the desktop's switcher in the account row, one Needs you across the shops with each decision sent with its own shop's session, and each shop's offline cache kept apart | | Opus |
| done | 12. The desktop outpost running an approved submit step (today it fails a `submit` step as `browser_error`, which settles the write unknown; it should be a failure that means nothing was submitted). First, the desktop's cards and notifications show a request's whole text (the site, the page and every value), and a notification offers Approve only when that whole text is shown: today a browser write shows as "browser.submit on <site>", and a `send_reply` write is a `reply`, which a helper and a notification may approve (`docs/browser-control.md`, "Next slices") | | Opus |
| done | 13. Several shops, slice 4: an owner's shop session reaches the shop's consent, export and memory, and the owner manages helpers (invite, remove, cover) from it, each route its own decision (`docs/several-shops.md`, `docs/people.md` "Not built yet") | | Opus |
| done | 14. Who decided: the owner's link page names the helper who approved or declined a reply, from the names the shop's people record keeps | | Opus (coordinator) |
| done | 18. The code editor's states for developers (the canvas's Code, StatesCode, StatesCodeDev and KitCode boards): a gap list in `docs/code-editor.md`, then the states that need nothing from the owner (Kit's command asks and dial, a read outside the project blocked, secrets to the vault, rewinding a turn) | | Opus |
| done | 19. The outpost follows the shop sessions: this Mac registers and runs as the outpost of the shop the switcher shows, with that shop's owner session (`mos1.`). Today it follows the signed-in session's own tenant, so a pilot shop the operator made cannot have this Mac as its outpost (`docs/browser-control.md`, "Next slices", smaller gaps) | 12 | Opus |
| done | 20. The connected desktop shows the shop's whole work and does the owner's everyday writes: a pilot shop's tasks, history and routines for its owner (its shop session), Mission Control's team and jobs from the API instead of Buddy alone, and pausing routines and Pause everyone through the shop's session; `chat.send` to Buddy waits for a model | | Opus |
| done | 24. The console catches up: words on the Audit page for every action the API writes, the People page now that owners manage helpers from the app, and the outposts' and writes' new outcomes | | Sonnet |
| done | 25. The code editor: the shell names the tool and the path on an agent's ask, so Kit's dial reads them, not the ask's English title (`docs/code-editor.md`, "Left for later") | | Opus |
| done | 26. The code editor: rewinding a turn, files and chat together, from a snapshot the shell keeps when each turn starts | | Opus |
| done | 27. The code editor: each lane on a branch of its own, and the lane's states (Checked, Tests failed, Reverted) read from a test run's result | | Sonnet |
| done | 28. The code editor: what keeps running (each command still running, its age, its port, and Stop) | | Sonnet |
| done | 29. The code editor: a preview with sample values until the owner adds a real one, and the main branch moving while Kit worked (Let Kit merge, Show me both) | | Sonnet |
| 30 | The code editor: Kit's dial for a session in its own terminal (the shell starting the agent with the dial's permission mode and allowed commands) | the owner's call: chat or terminal | Opus |
| done | 31. Sign-in by a code sent by email (`docs/sign-in-options.md`), built and off until the owner turns it on: asking for a code, the exchange giving the same session as Apple's, its limits, a sender port with a test outbox, and the dev deploy check refusing test-only vars | | Opus |
| done | 33. The desktop's sign-in by a code sent by email, off with item 31: Settings › Developer and the first run's connected path ask for an email and then its code, and say plainly while it is off; the web's sign-in comes with the join page (item 10) | | Sonnet |
| done | 34. Google Sheets for Ton's books, built and off until the owner's Google Cloud OAuth client exists (`docs/connectors.md`, 4b): connecting the owner's Google account with the `drive.file` scope only, the refresh token sealed in the credential vault, a sheet the app makes, and each month's append (`@manut/sheets-rows`) asked through approval-core with its exact rows named | | Opus |
| done | 37. Google Sheets on the desktop and its two guards: Customize › Connections' Google Sheets row (connect in the system browser, send a month, disconnect, broken, off), the books append shown whole in Needs you before Approve, a month already appended never asked again silently, and a shop's deletion revoking its Google token | | Sonnet |
| done | 35. The owner's pages on phones (Phase 1's "real-phone pass" as far as a browser engine goes): every state of the approval and deletion pages on iPhone and Android sizes, WebKit and Chromium, light and dark, Thai text and larger text, in CI on every push, with fixes; `docs/phone-pass.md` lists what the owner's own phone check covers | | Sonnet |
| done | 36. Self-serve onboarding (Phase 5's gate: onboarding that converts without an operator): a signed-in person makes their own shop from a template and is its owner from the first write, off until the owner opens sign-ups; a self-serve shop stays out of the pilot gate unless an operator adds it | | Opus |
| done | 38. A shop make that stops part way leaves nothing half-made, for the operator's route and self-serve alike: it can be finished or cleared, a retry never makes two shops, a self-serve slot is never lost, and the console never lists a shop that cannot be opened | | Sonnet |
| done | 39. The code editor: Bring it back after a rewind (the pre-rewind files kept and put back, never through a link), and the main-moved note on each lane's own row from the branch it was made from | | Sonnet |
| done | 40. The owner adds a sign-in and changes who may use it, from the app: two owner routes under `/v1/vault/` through the vault's own operation, and Customize › Connections' Add a sign-in and members, the password crossing once and kept nowhere | | Opus |
| done | 41. The security review's front-door findings: JSON POSTs refuse any other content type, ingress limits keyed by an address's /64, a global and a per-source cap on code emails, `email:` sessions refused on the lifted routes and routines and outposts checked to be shops, and the test keys honoured only on a `.test` origin | | Opus |
| done | 42. The security review's session and self-serve findings: a global daily cap on self-serve makes and no model spending or routines for a self-serve shop until an operator counts it in; expired sessions swept, a wipe reading only its own tenant's sessions, paged shop-index scans and a limit on `DELETE /v1/tenant/data`; the web app's shop cookies needing the sign-in; a cap on helper sessions; script policies on every page | | Opus |
| done | 43. The model gateway's alerts and sweep (`docs/model-gateway.md`, "Not built yet"): an abandoned reservation charged on a timer by the shop's own alarm, settling once whichever finds it first, and a shop crossing 80% and 100% of its month's cap noted once a month, in the audit log and the usage answer, with the console's Model spend page listing the shops near or at their caps | | Opus |
| done | 44. A list of a session's own tasks (`GET /v1/tasks`, with state, paged) so the connected desktop stops reading a shop's whole export every minute, every screen keeping what it shows (`docs/runtime-adapter.md`, "Next slices" 3) | | Opus |
| done | 45. The rest of the owner's sign-ins from the app (`docs/browser-control.md`, "Next slices" 3 and 4): removing a sign-in, changing its account or its addresses without ever letting a password be typed somewhere new by someone who does not know it, and the operator's route to change who may use one | | Opus |
| done | 46. The connected desktop's owner writes for memory and routines: remembering, confirming, correcting and forgetting a fact, and making and removing a team routine, through the API's existing owner routes (`/v1/memory/*`, `/v1/routines`), refused with nothing sent for a helper's shop or while offline | | Sonnet |
| done | 47. The code editor: each lane in a git worktree of its own, on its own branch made from the branch the developer's folder is on, so lanes work at once without touching each other or the developer's folder; the dial, the test run, main moving, Rewind and what keeps running follow the lane there (`docs/code-editor.md`, "Left for later") | | Opus |
| done | 48. Approvals found without reading every task: a lookup kept per shop says which task holds each request and which may still be open, written before a request opens, so `GET /v1/approvals` reads only those tasks and deciding finds its task in one read; approval-core's records in each task stay the only truth, and a backfill builds the lookup for shops from before | | Opus |
| done | 49. The outpost's steps on real-world forms (`docs/browser-control.md`, "Next slices" 1 and 4): a sign-in over two pages, fields in a page's open shadow DOM, check boxes, radio buttons, select menus and editors that are not form fields, a settings page that keeps its form, and a frame's navigation told from the page's own; tested on local fixture pages in a browser engine, nothing run on a real site (merged 25 Nov; tested on local pages in WebKit and Chromium only, and the owner's supervised trial checklist is in `docs/browser-control.md`, "Next slices") | | Opus |
| done | 50. The console's Connections page for operators: a shop's sign-ins (working or broken, who may use them, last used) and outposts (online, last heartbeat), with the operator's existing actions behind a question (remove a sign-in, change who may use it, remove an outpost, replace its credential, shown once); no password is typed in the console (merged 25 Nov; the helper stopped when the API went silent, after the page and its tests, and the lead wrote its docs) | | Sonnet |
| done | 51. The pane beside a lane (the canvas's Code board, "What to look at"): Diff from the session's changes, Preview with the Sample rows until a preview runs in the app, and Tests from what the lane keeps (its last run's result, command and time, no output kept); and mocha, Playwright and Python's `unittest` read by `testRun.ts` with the same pass rule (merged 25 Nov; the helper stopped when Claude access for helpers was turned off, after its last commit, and the lead pushed, reviewed and merged it) | | Sonnet |
| done | 52. Show older on the connected desktop (`docs/runtime-adapter.md`, "Next slices" 4): History and the activity log say when a shop has more than its newest 50 tasks, and read the next 25 from the cursor the minute's read stopped at; older pages kept in memory only, never in the offline cache (merged 25 Nov; Mission Control's other lists show only the newest 3, so History's rows are its one list that grows; later on 25 Nov the lead made a press on the activity log widen a range of the last days to the days it read, so what it read shows) | | Sonnet |
| done | 53. The preview itself, first slice (`docs/code-editor.md`, "Left for later"): Start in the pane's Preview view runs the command `@manut/preview-command` chooses, never through a shell, in the lane's own folder only, with an environment that starts empty and every secret the preview knows of on its sample (`previewEnv`, and `.env.example` through `@manut/env-example`); `@manut/dev-url` finds the address, Open hands it to the system browser, Stop ends it, and "What keeps running" lists it; nothing drawn inside the app yet (merged 25 Nov; macOS and Linux only; refused with `changed` when `package.json` moved after the command was chosen; never run in a real app yet) | 51, the two packages | Opus |
| done | 54. The retention prune clears the approval lookup's entries of the requests it removes: the task object notes the ids before it deletes them and reports them to its shop's lookup as gone, keeping the note until the report lands, so a failed report is sent again by the next prune (merged 25 Nov; `prune_incomplete` with `approval-lookup` until a report lands) | | the lead |
| done | 55. Say how a request that left was decided (`docs/runtime-adapter.md`, "Next slices" 3): when an ask leaves the connected desktop's open approvals with no answer from this app, one read of `GET /v1/approvals?state=recent` for its shop closes the card as approved or declined, by whom when known, withdrawn, replaced or timed out; a read only, so approvals still settle one way (merged 25 Nov; the read waits 4 seconds at most, approve or decline comes from the option's own effect, and a helper's name only from a note they passed on) | | Sonnet |
| done | 56. The outpost's writes set switches and check boxes a page draws itself (`role="switch"` or `role="checkbox"`, state in `aria-checked`) as they set a check box: one click only when not already as asked, read back before the press, and refused while half on, disabled or read-only (`docs/browser-control.md`, "Next slices" 1; merged 25 Nov; local pages in WebKit and Chromium only) | 49 | the lead |
| done | 57. The console's Routines page for operators (`docs/pilot-api.md`, "Routines"): a shop's routines with their trigger, next run, whether paused, and their latest runs (skipped while the switches are off), with pause, resume and remove each asked first in its row, and Pause everyone and Resume for the shop's team, through the admin routes the API has; until an owner's account is linked, a pilot shop's routines are the operator's, and today only curl reaches them (merged 25 Nov; a shop that is not a pilot shop is said so on a change, as the API's read does not look for the shop; making a routine came with item 59) | | Sonnet |
| done | 58. The preview drawn in the pane (the canvas's Code board, Preview): while a lane's preview runs, its page in a sandboxed frame beside the chat, with Reload and Open in browser; the app's CSP widened for loopback frames only, the frame proved to get no IPC and to reach neither the app's window nor another site, and checked in macOS's own webview (merged 25 Nov; `frame-src` is localhost at any port; a framed page reached no command or plugin in this Mac's WKWebView and through Tauri's own check; `[::1]` and Windows keep Open in browser only; macOS 11 read from WebKit's source, not run) | 53 | Opus |
| done | 59. Make a routine from the console's Routines page: a form for its name, whose job it is, what it does (only what that member may run), when, its time zone and whether it asks first (always on for a reply, a send, a payment or a deletion), shown in the API's own words with its next run and asked first before `POST /v1/admin/routines`; each refusal beside its field, nothing typed lost (merged 25 Nov; each field checked by `@manut/routine-rules` itself; practice world v14) | 57 | Sonnet |
| done | 60. The connected desktop's offline cache sealed at rest: AES-GCM with a fresh nonce each write and the version, origin and tenant bound in, under a random key made once per install and held only in the OS keychain; version 6, a version-5 file deleted unread, a file that fails to open read as nothing kept; no cache at all where there is no keychain yet, rather than a plain one (merged 25 Nov; Web Crypto in the page, the key from SecRandomCopyBytes in the macOS keychain, deleted whenever the kept read is forgotten, so a key lasts one sign-in; the real app's keychain not used yet) | | Opus |
| done | 61. A shop's live feed, built and switched off (`docs/runtime-adapter.md`, "Next slices" 2): a WebSocket per shop session, accepted by the shop's TenantObject with hibernation, carrying no data but that something the screens read changed (coalesced to one a second), so the connected desktop reads that shop again within seconds; behind a feature flag that is off, listed in `docs/turning-on.md` with its Cloudflare cost; the minute's read stays as the fallback. Merged on 25 Nov with 61b: review found its socket sent the shop session in a header Cloudflare's logs keep, so the socket opens with a one-use ticket of 30 seconds that the session mints (`POST /v1/feed/ticket`) | | Opus |
| done | 62. The Runs layout tests made fast: `boxView.test.ts` takes about 50 seconds alone (six generator tests of 6.5 to 9.4 s each) and times out in every gate run beside another; find whether the time is the layout's or the checkers', and speed that side with every answer proved the same and no case, width or check removed. Merged on 25 Nov: the layout was 94% of the time; the file takes 19 seconds on this Mac, from about 50, with every answer of the old and the new layout compared and equal | | Sonnet |
| done | 63. The desktop's release builds in CI: a workflow that builds the Mac app (a `.dmg`, both chips), signed with the owner's Developer ID and notarized when the secrets are there, unsigned otherwise, into a draft release the owner publishes; the Windows installer built as CI files only (the first release is Mac only, the owner, 25 Nov); and the in-app updater turned on with Manut AI's own key (made 25 Nov, the private half only in GitHub secrets and the owner's own copy, the public half pinned in the app) and a `latest.json` that moves only when the owner publishes a release; every secret a GitHub secret, never in source or chat (the owner's Apple Developer account is the business's, an organization). Merged on 25 Nov (`docs/releasing.md`): the two chips build one after the other so they share one draft and one `latest.json`; the workflow has not run yet, and signing waits for the owner's five Apple secrets | | Sonnet |
| parked | 64. Sign in with Apple's precondition (`docs/turning-on.md`): Apple sessions (`apple:`) refused on the lifted routes a person outside any shop does not need, as email sessions are (`REFUSED_PERSON`), with those routes' own tests moved off Apple tenants, so turning Apple on lets no Apple ID use them (parked 25 Nov: the owner said sign-in is not needed for now) | | Opus |
| parked | 65. A Thai dictionary for the desktop (`th`), wired in as the fifth language with English for every word not yet written, checked by the dictionaries' own tests, so the owner's Thai words drop in without code (parked 25 Nov: the owner said Thai is not needed yet) | | Sonnet |
| done | 66. Kit as a chat from the + menu, beside the terminal (the owner, 25 Nov: both): the sidebar's + menu starts each coding agent as Kit's chat lane, as the canvas's Code board draws it, or in its own terminal as since 16 Nov, so the lanes, Kit's dial, the pane beside a lane (Diff, Preview, Tests), Rewind and Bring it back show in the real app for the first release. Merged on 25 Nov: Chat with Kit sits first in the menu and In a terminal is unchanged, focus and shortcuts included (`docs/code-editor.md`, "Starting a lane") | | Opus |
| done | 67. Buddy answers for real, through the person's own coding agent (the owner, 25 Nov, on trying 0.1.1: "it's doesn't response"): in the desktop app, Practice mode included, a message to Buddy is answered by a real model through the Claude Code or Codex the person has installed and signed in to, as a conversation only (it changes no file and runs no command), since the owner wants no model key of ours yet; with no agent installed or signed in Buddy says so and what to do, and never gives a sample answer as if it were one; the fork's leftover line about Slack and Discord goes. Merged on 25 Nov for Claude Code, with the person's own MCP servers and Skills and an ask before anything that acts (`apps/desktop/src-tauri/src/buddy_chat.rs`); Codex is not offered for Buddy yet, since its careful policy still runs commands it counts as safe without asking | | Opus |
| done | 68. Starting a lane from where lanes are: a New lane link in the Lanes band of Kit's panel, which opens the + menu's Chat with Kit choice, and an agent that is not signed in marked as such in the + menu before the first message, where the app can tell (`src-tauri/src/accounts.rs`). Merged on 25 Nov: Claude Code, Codex and Grok can be told; the others show nothing new | | Sonnet |
| done | 69. A helper's own session on the connected desktop (`docs/runtime-adapter.md`, "Next slices" 4): a person who helps at a shop reads and answers what that shop asks of them with their helper session, as the owner does with an owner session. Merged on 26 Nov: the owner's pages say whose they are and ask nothing (`apps/desktop/src/pages/OwnersOnly.tsx`); still an ask of the API: a worker's request carrying its action's own words, which a helper's card cannot show | | Opus |
| done | 70. A schedule's time zone shown when it is not this computer's (`docs/runtime-adapter.md`, "Next slices" 4): a routine's time and its next run say whose clock they are on whenever the routine's zone differs from the computer's, in Practice and Connected, so 09:00 is never read as local time by mistake. Merged on 25 Nov (`apps/desktop/src/lib/zone.ts`) | | Sonnet |
| done | 71. The lane pane's Diff read from the lane's own folder (`docs/code-editor.md`, "Left for later"): what really changed there, from git, so the pane is not empty after a restart and a subagent's own edits show. Merged on 25 Nov (`src-tauri/src/lane_diff.rs`, `apps/desktop/src/code/laneFolder.ts`), planned by the lead and built by Sonnet | | Sonnet |
| done | 72. MCP servers and Skills, as the person already has them, everywhere an agent runs (the owner, 25 Nov: "make sure it support MCP and Skills seamlessly for what user already have"). They already load for Claude Code and Codex in lanes and terminals, which run with the person's own home and nothing stripped. What is missing: a lane's folder holds only committed files, so the project's own untracked agent settings (`.claude/settings.local.json`, an untracked `.mcp.json`, untracked skills) are not there; an account the person added starts with an empty home, without their servers and skills; the ACP agents are handed no MCP servers; and no page shows what each agent has. Built: those three gaps closed, and a Settings page that lists each agent's MCP servers and skills by name, read from the agent's own configuration, never a secret. Merged on 25 Nov (`lane_config.rs`, `acp_mcp.rs`, `accounts.rs`, Settings, MCP and Skills); still open: servers added with `claude mcp add` do not reach an added Claude Code account, and the page reads Claude Code and Codex only | 67 | Opus |
| done | 73. Worktree settings for lanes (the owner, 25 Nov, from T3 Code's Worktrees page): where a lane's folder is made; starting a lane from the latest commit of its base branch on the remote, not only the local one; how a lane's branch is named (the prefix); and clean-up, removing a lane's folder when its chat is deleted and when its pull request has merged, never one with changes of its own. Merged on 25 Nov: Settings, Worktrees (`src/settings/WorktreesPage.tsx`, `src-tauri/src/lane_clean.rs`) | | Sonnet |
| done | 74. Providers (the owner, 25 Nov, from T3 Code's Providers page): one page for the coding agents, each with on or off, installed, signed in and version, a display name, the program's path, its home folder, extra arguments and environment variables; the Accounts page shown in Practice and Connected, where it is hidden today; Cursor and Antigravity added if their CLIs can run as a chat here. Merged on 25 Nov (`src-tauri/src/providers.rs`, `apps/desktop/src/settings/providers/`): both are added as ACP agents from their own help, with no message sent to either yet | 72 | Opus |
| done | 75. Source control (the owner, 25 Nov, from T3 Code's Source control page): git's and the GitHub and GitLab CLIs' versions and accounts on one page; the default branch pulled by itself when the checkout is clean; a pull request made and merged from a lane, each asked first as going live always is, with a default merge method; and agent credit lines taken out of a merge's message when the person wants. Merged on 25 Nov (`src-tauri/src/review.rs`, `git_pull.rs`, `credits.rs`, Settings, Source control); never yet run against a real remote | 73 | Opus |
| done | 76. The sidebar and threads (the owner, 25 Nov, from T3 Code's Labs): a chat or lane pinned on top, snoozed or settled below, its pull request on its row; an archive; and the next message suggested in an empty box after a turn, which costs a request on the person's own plan and so is off until they turn it on. Merged on 25 Nov (`apps/desktop/src/sidebar/rows.ts`); the suggestion works with Claude Code only and has not been seen from a real multi-turn chat yet | | Sonnet |
| done | 77a. A command palette (the owner, 25 Nov, from T3 Code's Labs; split from 77 by the lead): the box Command-K already opens to search chats also lists where to go (every page and Settings page) and what to do (the actions the app already offers: a new chat, a new session, a new lane, the microphone, a setting), so a person reaches anything by typing; it adds no power of its own, and anything that asks still asks. Merged on 25 Nov (`apps/desktop/src/palette/`), planned by the lead and built by Sonnet | | Sonnet |
| done | 77b. Workflows and coding work on a schedule (the rest of 77): steps kept as files in a folder of the app's home and run in order, with a history of runs; and coding work on a schedule, as the shop's routines already are. Started late on 25 Nov, when the owner said the account's credits were plentiful for a day and to use them: built switched off Merged 26 Nov: Settings, Workflows (off by default), a workflow as a JSON file in `~/.manut/workflows`, run as a lane step by step, never answering an ask. Open: a form to write one, a run surviving a restart, a try with a real agent. | 77a | Opus |
| done | 78a. Reaching your Mac from your phone, the channel (`docs/remote-access.md`, the design made on 25 Nov from the owner's screenshots of another app's Sharing and access): `packages/remote-channel`, the pairing, the session and the decision challenge that both sides use, ported from GoSpark's handshake, with every refusal tested. It needs nothing from the owner and no sign-in: a phone pairs to the Mac by a code on its screen Merged 26 Nov, after a second reviewer read it: no break of the channel, and seven things tightened first (the phone's side of pairing is one try too, the person types the phone's four digits into the Mac, Unpair ends that phone's waiting challenges). Nothing uses the package yet. | | Opus |
| done | 78b. The Mac side and Settings, Sharing and access: consent, the QR code, the Allow card, the phone list, Unpair, built off; tested against a fake socket and through the real relay object in the API's tests Merged 26 Nov, switched off: Settings, Sharing and access (an everyday page), the consent sheet, pairing with the typed digits, the six requests a phone may make and the Allow path with its challenge and passkey check, the journal. Not tried in the window or with a real relay or phone; the consent sheet's sentence on who runs the relay is a marked placeholder for the owner. | 78a | Opus |
| done | 78c. The phone's Your Mac tab in the web app. It can be built, but trying it needs the dev relay turned on (`RELAY_ENABLED`, on the Workers Paid plan the relay's cost is counted against) and a look on a real iPhone Started 26 Nov (`feat/remote-phone`): it is built and tested against the Mac's code through the relay object; trying it for real still needs the owner. Merged 26 Nov at 09:26, switched off: the Your Mac tab, pairing with the digits and a passkey, the chats and their asks, catch-up and Forget this Mac, tested against the Mac's code through the relay object. Paste only on an iPhone until a QR reader is chosen; how an answer to a question is signed must be matched to item 115 when it merges. A real phone and the relay are the owner's. | 78b | Opus |
| owner | 78d. A push with no content when an ask opens and no phone is connected. Needs the relay on and a push key | 78c | Sonnet |
| next | 78f. The second road, Tailscale (the owner, 25 Nov: "let's have both Relay and Tailscale the same as Orca"). Orca was read first (`docs/remote-access.md`, "The second road"): its road is an unencrypted socket on every network, which a phone that is a web page cannot use, so the same channel goes under Tailscale's own HTTPS name instead. Part 1, needing nothing: a read-only `tailscale.rs` that only runs `tailscale status --json`, and Settings' four states. Part 2: `remote_door.rs` on 127.0.0.1 behind `tailscale serve`, the phone's second road and the 1.5 second race; trying it needs a tailnet, an iPhone and an Android phone Part 1 started 26 Nov (`feat/tailscale-state`). Part 1 merged 26 Nov: the read-only `tailscale.rs` and the four lines, which no page shows until 78b's. Part 2 waits for 78b and for a tailnet and phones to try. | 78b | Opus |
| later | 78e. From the same list and not in the first version, each for the reason `docs/remote-access.md` gives: guest links, linked environments, a preview a paired phone can open; and not to be built: a port on the local network, a counted tunnel service, webhooks held offline, Live Activities | 78c | |
| later | 79. Not planned from that list: a pool of device simulators (another company's alpha service), and Jujutsu (not shipped in T3 Code either) | | |
| done | 80. The chat box, for Buddy and for Kit (the owner, 25 Nov, with four screenshots of another app's box: "please make chat feature support model, effort, approval, add context"): which model answers, how hard it thinks, how much it may do before asking, and a + for context (files, a folder, a mention, an action), all in the box and the same in both chats. A coding chat already has a model picker, effort, the agent's approval presets and attachments (`src/chat/model/`, `src/sessions/controls.ts`, `src/chat/parts/Attach.tsx`); Buddy's box in Practice has none of them. The approval choice offers the dial's own levels and never one that skips asking before something leaves the computer. Merged on 25 Nov (`apps/desktop/src/chat/box/`): Buddy's approval is Ask or Plan, checked in the shell; Home's ask box is unchanged, and Buddy's choices last until the app closes | 67 | Opus |
| done | 81. Voice in the chat box (the owner, 25 Nov: "record audio, voice mode"): a microphone that turns speech into the message's text, and a voice mode that listens, answers through the same agent and reads the answer aloud, with no key of ours: the Mac's own speech recognition and voices first, if they do Thai and English well enough, and what they cannot do said plainly. Merged on 25 Nov (`src-tauri/src/voice.rs`, `apps/desktop/src/voice/`, `docs/voice.md`): English is recognised on the Mac, Thai through Apple after a yes; not yet tried with a real microphone | 80 | Opus |
| done | 82. Computer use (the owner, 25 Nov, with a screenshot of Orca's Computer Use page: "also support this feature as well"): the person's agent can look at and work the windows of any app on this Mac when asked. Settings, Computer (a page that says Soon today) shows whether macOS has granted Accessibility and screen capture, opens the right pane of System Settings for each, and says when all is ready; the skill and the helper that read a window and act in it are lifted from Orca (MIT, `stablyai/orca`); and each action that changes something asks first and runs once, as the outpost's browser writes do (`docs/browser-control.md`). macOS ties both permissions to the app's signature, so they hold across updates only once builds are signed (item 63's Apple secrets). Merged on 25 Nov (`apps/desktop/src-tauri/src/computer/`, `docs/computer-use.md`): the page, looking and acting, for Claude Code chats; not yet run against a real window | 80 | Opus |
| done | 83. Artifacts shared by a link (the owner, 25 Nov, with a screenshot of Orca's Artifacts page: "please make it to support both of this"): an HTML or Markdown file published as a link anyone with it can open, from the file or by asking an agent, each publish asked first since it is public; the Artifacts page lists the person's links, with copy and remove; a switch for publishing at all. Built and switched off (`docs/turning-on.md`): it needs the owner for a sign-in turned on (a link belongs to an account), a web address of its own for other people's pages (never the app's own origin), what Cloudflare stores and what it costs, and the words of use for public content Merged 26 Nov, switched off: the Artifacts page's Share a file as a link, the links' list, Settings, Artifacts, and the API's routes and public read on a host of its own. Open: an agent asking to share a file, and everything the owner must provide (`docs/turning-on.md`). | 67 | Opus |
| done | 84. Skills shared by an unlisted link (the owner, 25 Nov, with a screenshot of Orca's Share Skills page): one skill or a bundle published behind a link that is not listed anywhere, after the person has looked over every file, script and program in it; anyone with the link can look inside and install all or some; the person's active links listed, with revoke. Off unless turned on, since a skill folder can hold scripts and secrets; it stands on item 83's storage, links and switch, and item 72's reading of the person's skills Merged 26 Nov, switched off: sharing from the Artifacts page after every file is looked at, installing from Settings, MCP and Skills, a second switch and an API flag of its own. Needs the owner as 83 does, and for whether skills may be shared at all. | 72, 83 | Opus |
| done | 86. Fixes from the security review of 25 Nov, source control and git: one high finding in merging a pull request from a lane and three lesser ones in the automatic pull, a repository's own git settings and a lane's clean-up. The details are in the fix's own commits and tests once merged, not here, since the repository is public Merged 26 Nov: four findings, each confirmed by a failing test first (the Merge ask and someone else's pull request; the automatic pull and ignored files; a repository's own git config in work the app starts; ignored files at clean-up). Not tried against a real remote or GitLab. | | Opus |
| done | 87. Fixes from the security review of 25 Nov, computer use, Providers and accounts: two medium findings in computer use and one in Providers' refused arguments, and two lesser ones Merged 26 Nov: five findings, each confirmed by a failing test first (who may call computer use's socket; what a card's label may hold; two system prompts; Providers' extra arguments, now a short allowed list; an added Codex account's config). Not tried with a real Claude Code or screen. | | Opus |
| done | 85a. The app moves as the brand's Motion board says, the foundation (the owner, 25 Nov: "make sure that UIUX is great with lively with animation for stage, details, to make user feel premium and classic with quiet luxury"). The canvas has the rules and the CSS (`BrandMotion`, `packages/ui-kit/app.css`: one curve, and the named moves Rise, Settle, Fill, Press, Switch, Hover, Shimmer, Pulse, Roll and Loading), and the desktop uses the curve in none of its 53 stylesheets. Built: the moves as one small set of classes and tokens the desktop's own styles use, every one off under reduced motion, the controls everything is made of (buttons, switches, menus, popovers, the palette) moving by them, and a test that no stylesheet types a curve or a long duration of its own Merged 26 Nov: `src/theme/motion.css`, `docs/motion.md`, and two tests that keep every stylesheet to the named moves. | | Opus |
| done | 85b. Motion in the chats: a message and an ask's card arrive once (Rise), a decision lands in its row (Settle), the working line shimmers, its words roll and its dot pulses only while someone works, and money, approvals and errors appear and stay still Merged 26 Nov: a message rises once, only when it arrived while the chat was open; an ask fades in and its settled line settles; the working line shimmers only while the turn is live. | 85a, 77b | Sonnet |
| done | 85c. Motion in the lists and pages: rows arrive in order on a page's first paint and never again, a row that is pinned, snoozed or settled moves to its place calmly, a page's content comes in quietly, bars and meters fill, and a page that loads shows the board's Loading Merged 26 Nov: rows rise once on a page's first paint, an ask fades where it stands, a pinned or settled row slides to its place, meters fill, and loading has the board's shape. | 85a, 69 | Sonnet |
| done | 85d. The finish, the look at every page beside its board: `docs/design-audit.md` (25 Nov), 21 findings and the order of work, which items 85e to 85i carry out | 85a | Opus |
| done | 85e. The brand's faces in place of the fork's mascots, everywhere a team member shows (`src/ui/Avatar.tsx`; the canvas's `KitFaces` and the Colour board's team colours) Merged 26 Nov: the kit's drawn faces on each member's colour, a state shown only where its word is written beside it. | 85a | Sonnet |
| done | 85f. The chat reads like the board: Buddy's answer in the serif at 17px with no bubble, the person's message alone in one, 15px the default, the serif bundled; and the header without other companies' logos Merged 26 Nov: answers in the bundled serif at 17px with no bubble, a 696px column, the header without a model or another company's logo. Not built: the header's Answer, Used and Steps tabs and cost line, which need a runtime field first. | 85a, 85b | Opus |
| done | 85g. An approval's card and Needs you rebuilt from the canvas: one black main button, no tints and no red bar, one card a decision with the line that says what follows Merged 26 Nov: the kit's card with one black button, and Needs you as one card a decision. Deny stays first and Needs you offers no Approve, where the board and the promise disagreed. | 85a, 87 | Opus |
| done | 85h. Settings as one quiet column, the developer pages under "Under the hood", its text on the scale and its labels as grey bands; the dark chip and the 900px width Merged 26 Nov: one column, the developer pages under Under the hood, text on the scale, Home's pill for every switch. | 85a, 83, 77b | Sonnet |
| done | 85i. One icon set, one grey that passes the contrast the board asks, a 196px side menu and its foot, the palette's rows, Team's Pause, the raw errors on Customize and the activity log, and the technical words the Voice board says plainly Merged 26 Nov: a 196px side menu with the person and their shop at its foot, one grey that passes the board's contrast and one icon set (each kept by a test), the palette's rows, a quiet Pause, plain words when a page fails to load, the Code page's Lanes band, no colour picker, and plainer words in four languages. | 85e to 85h | Sonnet |
| done | 88. Security, second review (26 Nov): Kit's dial read some commands as reads that write a file or run a program, and let an edit to a file that starts a program later go as an ordinary edit. Details are in the fix's commits and tests once merged, not here, since the repository is public Merged 26 Nov: an option is recognised in every form its program accepts, the network asks, and a change to an agent's settings, hooks, package.json or the app's own storage asks at every level; 170 hostile lines tested. Open, for the owner: at "edits alone" an agent may edit a test and run it alone. | | Opus |
| done | 89. Security, second review: a repository's own files must not change what a lane's agent may do, or start a program, before the person has seen them (the agent's project settings, a lane's MCP list, who may call computer use) Merged 26 Nov: Claude Code and OpenCode chats load the person's own settings only, every chat starts in a mode named at launch, a lane's MCP server must match the developer folder's entry, and computer use serves its first caller. Eleven other agents have no such switch (the table in `docs/code-editor.md`). | | Opus |
| done | 90. Security, second review: git work the app starts by itself runs no program a repository names, submodules included Merged 26 Nov: no automatic git command descends into a submodule, the config check reads every submodule's, and a folder with submodules is never removed or pulled past automatically. | 86 | Opus |
| done | 91. Security, second review: a workflow runs only what the person saw, in a project the app knows Merged 26 Nov: each workflow is allowed once from a card that shows every step; a run starts only while the file and the project's real path match what was allowed, and the project must be a repository's top folder. | 77b | Opus |
| done | 92. Security, second review: computer use says exactly what it will do, on any keyboard, and never presses the app's own Allow Merged 26 Nov: a stronger Replace card, keys sent by the current layout's character, only apps in the Applications folders as targets, the app's own windows and approval pages refused, a key tied to its window and control. | 87 | Opus |
| done | 93. A lane's agent reads the project's own instructions again, as plain text: item 89 leaves out a project's `CLAUDE.md` with its settings, and instructions cannot run anything, so the app reads them itself and hands them to the agent with a line saying they give no permission Merged 26 Nov: the project's CLAUDE.md, rules and local notes (AGENTS.md for OpenCode) read by the app, never through a link, capped and cleaned, and handed over behind a line that says they give no permission; the chat says once what was read. | 89 | Opus |
| done | 94. The sidebar as an inbox, the rest (`docs/t3code-parity.md`, the owner's list of 26 Nov): undo for Done for now, snooze and archive; snooze until a time the person picks or until the thread finishes; marks kept for lanes and terminals across a restart; an optional Working section that holds threads while they work and returns them to the top when they finish; several rows selected at once to snooze or settle; a thread settled by itself after some days untouched (3 by default) or when its pull request merges, each a setting Merged 26 Nov: Undo for a row's mark (a toast and Cmd+Z), marks that last for lanes and terminals, snooze until a picked time or until a chat finishes, a Working group (off by default), several rows at once, and settling by itself after quiet days or a merged pull request, with why on the row. | 76 | Opus |
| done | 95. The chat box, the rest (`docs/t3code-parity.md`, the owner's list of 26 Nov): Cmd+Enter sends without leaving the page and Enter sends and opens the thread, with the choice in Settings; a key to swap steer and queue and a default for it; several drafts kept, pictures included, and one stashed to use in another chat; a message written while an account is at its limit sent when the limit resets, shown as waiting and cancellable Merged 26 Nov: Cmd+Enter on Home sends and stays; while an answer runs the two keys choose between waiting and adding now, and until the person picks each kind of chat keeps its own way (a member takes it in, a coding chat waits); Drafts at the top of Home with Cmd+S; and Send at the time a limit resets, once, asking first when more than an hour late. | 80 | Opus |
| done | 96. Titles and words by a model the person picks (`docs/t3code-parity.md`, the owner's list of 26 Nov): which agent, model and effort writes a chat's title, a commit message and a pull request's words, a title made again for one row or several, each proposal shown before it is used and never sent anywhere by itself Merged 26 Nov, off by default: the person's own Claude Code writes a chat's title after its first answer and a pull request's words on Suggest, in a run with no tools, no project and no MCP server, bounded, with keys masked and nothing from a file that holds keys. Claude Code only; commit messages not done. | 75 | Sonnet |
| done | 97. Context from one thread to another (`docs/t3code-parity.md`, the owner's list of 26 Nov): a selection in an answer or in the preview annotated with a note and sent with the next message; a thread dragged into another to hand over what it holds; a thread handed to another agent or model mid-way, its context carried as text the person can read first Merged 26 Nov: a note on a selection as a chip, another chat's context as one chip the app writes with no model (shown in full, masked, capped, refused across shops or accounts), and Continue with another agent or model in the same lane, starting nothing. Where + opens the file picker directly, context comes by dragging only. | 85f | Opus |
| done | 98. A drawing in the chat (`docs/t3code-parity.md`, the owner's list of 26 Nov): an agent's HTML with its script (a chart, a diagram) shown in the chat in a sandboxed frame with no network, no storage and no way to reach the app, as an artifact link's page is served; opened larger on a click Merged 26 Nov: Show drawing under an answer's html or svg block draws it in a closed box (two empty sandboxes, a policy that loads nothing, an allow-list read twice). Scripts never run: in the macOS web view a script in a sandboxed frame could still reach the network by WebRTC and preconnect (`docs/security/chat-drawings.md`); running them is the owner's call. | 83 | Opus |
| owner | 99. The person's own keys, and settings for one project (`docs/t3code-parity.md`, the owner's list of 26 Nov): a page to set every shortcut, kept on this Mac; more of Settings saved for one project. Themes for the whole app (their own, or a VS Code theme), chat width and fonts wait for the owner: the brand's rule is one look with no accent to pick | 85i | Sonnet |
| done | 100. Pull requests, the rest (`docs/t3code-parity.md`, the owner's list of 26 Nov): a Buddy chat's pull request linked as a lane's is; a pull requests view sorted by readiness to merge, with merging from it through the same ask a lane's merge uses; conditional requests so watching costs little; Bitbucket, Azure DevOps and Forgejo or Gitea beside GitHub and GitLab, each only through its own signed-in tool; a new project, with a repository made on GitHub only after an ask; a project's icon Parts 1 to 3 merged 26 Nov: Tasks, Pull requests, every project's open requests by readiness, with a detail and Merge through the lane's own ask (a request of the project's own repository and branch only, bound to the head shown); a chat's own `gh pr create` linked both ways; a 304 for an unchanged list. The rest is 100b. | 75, 86 | Opus |
| done | 100b. Pull requests, the rest of item 100: Bitbucket, Azure DevOps (`az repos pr`) and Gitea (`gt`, which replaced the archived `tea`), each only through its own signed-in CLI and read only; a new project, with a repository made on GitHub only after an ask showing the exact `gh repo create` plan; a project's own icon read from its folder. GitLab's merge methods and `glab mr create` links Merged 26 Nov: project icons read by the shell and drawn only as images; New project with git started safely and GitHub made only through an ask (private by default, nothing pushed); GitLab merge methods and glab mr create links; Azure DevOps and Gitea listed read only. Bitbucket not offered (no CLI that lists requests). | 100 | Opus |
| next | 101. More agents, and what a person already has (`docs/t3code-parity.md`, the owner's list of 26 Nov): Grok and Muse Code as chats, Cursor and Antigravity run for real, the ACP registry's agents offered in Settings, Providers (read from a pinned copy, never fetched unasked), several accounts for Grok and pi, and on first launch the person's existing Claude Code and Codex conversations and projects offered to bring over | 74, 89 | Opus |
| next | 102. Several agents on one job (`docs/t3code-parity.md`, the owner's list of 26 Nov): one message that starts lanes on different agents and models side by side and gathers their answers, and an agent that opens, messages and reads other threads, on the connected runtime as the fork's thread cards do in Practice. Design first (GoSpark's Buddy heads: a budget for each helper, landing serialised, work that cannot land kept as a patch); every helper's ask reaches the person | 77b, 91 | Opus |
| next | 103. Manut AI as an MCP server for its threads (`docs/t3code-parity.md`, the owner's list of 26 Nov): another program on this Mac lists, opens and messages threads through it, and an address to copy for it. Design first: who may connect, and that everything asked through it is an ask the person answers, never a way round one. Off by default | 89, 102 | Opus |
| next | 104. A snapshot of any app (`docs/t3code-parity.md`, the owner's list of 26 Nov): a key pressed anywhere takes the front window's text and structure and opens a thread with it. It uses the macOS permissions computer use reads (item 82), a global shortcut the person sets, and shows what it took before anything is sent to an agent. Trying it needs the owner at the Mac | 82, 92 | Opus |
| done | 105. Report a problem (`docs/t3code-parity.md`, the owner's list of 26 Nov): one action gathers what is wrong (versions, the last errors, which tools are installed and signed in, with every key and path masked), shows it, and hands it to the person's own coding agent to fix on this Mac or drafts an issue. Nothing leaves the Mac without an ask Merged 26 Nov: Settings › Under the hood › Report a problem and a palette row show a masked report first (versions, agents installed and signed in, the last problems kept in memory, switches), then Copy, a coding chat with the report in the box (not sent), or an issue drafted after a confirmation that names the address. | 72 | Sonnet |
| done | 106. Use everywhere (`docs/t3code-parity.md`, the owner's list of 26 Nov): the usage page counts sessions run outside Manut AI too, read from each tool's own files on this Mac Merged 26 Nov, off by default: an "Outside Manut AI" line a tool on the Code page (tokens today and this week, a table on a click) from a bounded, read-only scan of Claude Code's and Codex's own files; only numbers, dates and a folder's name leave it. Codex's compressed sessions are not read (106b). | 74 | Sonnet |
| owner | 106b. Read Codex's compressed sessions for use outside Manut AI: every Codex session on the owner's Mac is a `.jsonl.zst`, so item 106 counts none of them and says so. It needs one new dependency, a zstd reader (a pure-Rust one exists), which is the owner's to allow. Also not read: Grok (its usage fields could be per turn or running totals), OpenCode (SQLite), pi | 106 | Sonnet |
| done | 107. Open in an editor (`docs/t3code-parity.md`, the owner's list of 26 Nov): a lane or a project opened in VS Code, Cursor or the editor the person names, from its row and the palette Merged 26 Nov: Open in an editor from a session's and a lane's row menu and the palette; a fixed list found on this computer (VS Code, Cursor, Windsurf, Zed, Xcode on a Mac), named by id, never a typed command; Settings, Developer, Editor. Not verified: a real editor opening. | 73 | Sonnet |
| later | 108. Manut AI on more than one machine (`docs/t3code-parity.md`, the owner's list of 26 Nov): the app run without a window on another machine, a small page in a browser against it, a thread started on the machine the person picks or the freest one, a terminal, a browser and pictures from that machine, a page that says how each machine is, updates for all at once, a project moved from one to another, permissions for each connection, and routes by relay, Tailscale or the local network. A design pass first, as item 78 had (T3 Code's is MIT and can be read), then phases built off. It revisits two earlier calls: no port on the local network and no counted tunnel (78e) | 78c, 78f | Opus |
| later | 109. A thread started by a webhook (`docs/t3code-parity.md`, the owner's list of 26 Nov): an address that starts one workflow the person allowed (item 91), in its careful lane, when a pull request opens or a payment arrives, held at the API for up to a day while the Mac is away. Earlier decided against (78e); planned now at the owner's ask. Needs the relay or the API's inbound on, so the owner turns it on | 91, 78c | Opus |
| later | 110. Phone simulators in the app (`docs/t3code-parity.md`, the owner's list of 26 Nov): an iOS or Android simulator on a Mac shown in the app and on the phone. After 108, and only with Xcode or Android's tools on that Mac. Item 79 had said not planned | 108 | Opus |
| owner | 111. Platforms and channels (`docs/t3code-parity.md`, the owner's list of 26 Nov): a Linux build released, a Windows build published (and Windows on ARM), a nightly channel beside the stable one, native iPhone and Android apps (Live Activities and swipes need one) or the installed web app kept, and a licence file, since the repository is public and has none. Each is the owner's: signing, stores, accounts, legal | | |
| done | 112. Security, third review (26 Nov): the dial's reading again. A second action in one `find`, a tool runner's own options, two of zsh's expansions and an output operand still read as harmless. Details are in the fix's commits and tests once merged Merged 26 Nov: every find action, the package runners' options, zsh's expansions, programs that write through an operand, files read from outside through an option, and an address or server option as a send; over 300 hostile lines in the table and 221 everyday commands pinned. The lead's 420 further lines found no way past. Open for the owner: option allow-lists for everything that goes alone. | 88 | Opus |
| done | 113. Security, third review: a skill installed from a link cannot carry a setting that runs or allows anything by itself, and the checks for keys catch the common forms Merged 26 Nov: an allow-list of a skill's settings, refused by name at the ask and before writing and at publish; the card says what a later chat may do; one masker for keys with 86 more cases. Skills by link stay off. | 84 | Opus |
| done | 114. Security, third review: the app's own git work ignores a repository's proxy and certificate settings, a lane made with nobody present has its config read first, and OpenCode 2.3.0 chats start again Merged 26 Nov: automatic git work stops at a repository's proxy, certificate, header, credential, url, ssh and protocol settings (ten http pacing settings pass); a lane made by the clock reads the config first and is skipped with a reason; OpenCode chats start with formatters and language servers off and start again on 2.3.0; a lane's MCP server that would run the lane's files is not started. Joined with item 93's instructions entry. | 90, 91 | Opus |
| done | 115. Security, third review: answering an agent's question from a phone needs the passkey as an Allow does, and the page never holds a phone's raw key Merged 26 Nov: an answer needs the challenge and passkey, bound to its exact words; Unpair ends sessions first; a decision counts only for the revision sent; the shell holds the relay key; computer use decodes a word before looking for an approval link. Not closed: a script in the page could still open a pairing. | 78b | Opus |
| done | 116. Security, fourth review (26 Nov): the dial's reading again, and its structure. A command read in the session's folder may run where an earlier `cd` left the agent's shell; a kept rule covers stricter steps that begin with the same words; and options of checkers still write files or run a program. The fix is an allow-list: for every program that goes without asking, only options known to be harmless pass (the lead's decision under the owner's standing rule, logged with its cost in asks). Details are in the fix's commits and tests once merged Merged 26 Nov: every Claude Code command starts in its session's folder and the reader follows each session's shell; checks go by per-program allow-lists of harmless options; a kept rule covers only its own step; reads that print outside secrets ask; git -C elsewhere asks and agents' git reads a bare repository only when named. None of 221 everyday commands newly asks. Still on deny-lists: everyday reads (cat, ls, git, gh, docker, kubectl, terraform, helm, jq, yq). | 112 | Opus |
| done | 117. Security, fourth review: what an approval shows is the whole command, never hidden by the masker for keys or cut short, on the Mac's card and on a phone; a key in what is being committed is counted from the changes themselves; the masker's missed forms; a pull request's suggested words carry no link or image Merged 26 Nov: an approval shows the whole command with only keys masked, never what runs, on the card and the phone; the phone's challenge binds the exact text; a commit or push that would go alone reads the lane's diff for a key first (outside a lane, it always asks); 29 more key forms; a model's titles and pull request words are plain words. | 113, 115, 96 | Opus |
| done | 118. Security, fourth review: the app's own git work reads a repository's conditional includes and large-file settings before it runs, and checks a lane made with nobody there from inside the lane before checking out Merged 26 Nov: any include in a repository's config stops the app's own git work; an unattended lane is added with no checkout, read again from inside, then checked out; every lfs setting and a .lfsconfig stop it, and the app's git downloads nothing through git-lfs and runs no gc or maintenance; an agent's own CLI as an MCP server is not started in a lane; a skill's load-time command after an argument mark is refused; OpenCode's placeholders are neutralised in a project's instructions. For the owner: a changed large file stays a pointer after an automatic pull. | 114 | Opus |
| done | 119. Manut AI on the Mac App Store, in GoSpark's listing (owner, 26 Nov): a second, sandboxed build with GoSpark's bundle id at 2.0.0, no self-updater, the narrowest exceptions the coding agents need, and what works inside the sandbox written down for App Review. The owner chose to submit the full app knowing Apple refused GoSpark the same exceptions; Mac only. The lead validates, uploads and submits with manual release Merged 26 Nov: `MANUT_APP_STORE=1` builds a sandboxed 2.0.0 with GoSpark's bundle id, no updater, the real home read from the system, the terminal refused with a plain reason inside the sandbox (`apps/desktop/scripts/appstore-mac.sh`, `docs/app-store.md`); filed under Business with Developer Tools second, encryption declared exempt. Upload and submission wait for the owner's privacy and support links, the App Privacy answers (item 123) and item 124's deletion in production. | 75, 117 | Opus |
| done | 120. Security, fifth review (26 Nov): the dial's reading again. A push after a branch switch read as the lane's; an optional option value hid the next option from an allow-list; a key reaching a commit or push by routes the diff read does not see; more reads that print secrets; tag pushes and branch resets; cd forms not followed Merged 26 Nov: a push with no branch named reads none once the branch may have moved; an option's value never hides the next option; a save or push whose key the folder's read cannot see asks, and a push reads the lane's unpushed commits; more secret-printing reads, tag pushes and branch resets read as they are; a cd not followed leaves the folder unknown; a chat links only to a request made from its own branch (GitLab too). | 116, 117 | Opus |
| done | 121. Security, fifth review: a masked value on an approval card never spans a word, and the masked line keeps the same words; invisible direction characters shown as marks; a drawing's nested shapes capped; a context chip remembers every shop it passed through Merged 26 Nov: a masked key stops at a blank, quote, `#` or glob character, and the masked command must keep the command's own shell words or it is shown whole with a note (and never leaves the Mac); one shell reader in both twins masks a key block only as data a writer prints; a key-shaped part of a path is shown; hidden and direction characters are visible marks on every surface; a drawing over 5,000 shapes is refused; a chip carries every shop it passed through. | 117, 98, 97 | Opus |
| done | 122. Every menu led by an icon, and each provider by its own logo (owner, 26 Nov, with a picture of Settings › Providers): Lobe Icons' marks (MIT) wherever an agent or provider is named, a refined monogram where none is published, and the app's icon set on Settings' list and every words-only menu. Reverses item 85i's rule of naming coding tools in words with no company logos Merged 26 Nov: Lobe Icons 1.106.0 (MIT) and Simple Icons (CC0) marks generated into `src/ui/agentMarks.ts` for every agent, provider and editor that publishes one, a Geist monogram otherwise (Xcode too: Apple allows no use of its icons in an app); a 16px icon on one column leads every menu entry, the row menu is the canvas's 34px row, and the Tasks scope switch is 28px. | 85i | Opus |
| done | 123. The App Store's App Privacy answers drafted from the code for the owner to confirm (`docs/app-store/2.0.0-privacy.md`), with the questions only the owner can answer. Merged 26 Nov | 119 | Opus |
| done | 124. Deleting an account from inside the app (App Store Guideline 5.1.1(v)): the API removes the account and its data and revokes a Sign in with Apple token, and Settings offers it with a confirmation. The API change needs the owner's deploy to production before the App Store build is submitted Merged 26 Nov: Settings › General › Delete account, two steps (an owner types each shop's name); `POST /v1/account/deletion` with the person's own session only, a record first, sessions last, retry finishes a stop; the Apple refresh token kept sealed from sign-in and revoked at deletion, retried for three days. Before submitting, the owner deploys it to production, sets `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and has Sign in with Apple send the authorization code. | 119 | Opus |
| done | 125a. Refactor, behaviour unchanged (owner, 26 Nov: "do code refactor"): one home in `src/lib/` for helpers the desktop copied file to file: the change-notification set and its `subscribe` (34 modules), `isObj` (15), `inTauri` (15), the reduced-motion check (5), and the identical copies of `errText`, `num`, `str` and others. Files items 105 and 124 are changing wait for them Merged 26 Nov: `changes()` in 36 stores, `inTauri`, `isObj`, `prefersReducedMotion`, `pad` and one `errText` in `src/lib/`, each tested; differing copies listed in the merge, and the files 105 and 124 held left for 125d. | | Sonnet |
| running | 125b. Refactor, behaviour unchanged: `src-tauri/src/agent_chat.rs` (8,998 lines, half tests) split along its own six sections into `src/agent_chat/` (shared, subagents, Claude Code, Codex, pi, live processes), each file with its own tests, moves only, the same test count before and after | | Sonnet |
| done | 125c. Refactor, behaviour unchanged: `src/sessions/sessions.ts` (3,108 lines) and `src/sessions/host.ts` (2,678) split by concern, after item 105 merges (it starts a coding chat) Merged 26 Nov: host.ts 2,678 to 332 lines (host.tauri.ts, host.mock.ts); sessions.ts lost its types, error words, saved lists and pure helpers to four files. The createSessions closure (about 2,770 lines) stays whole: splitting it needs a design change. | 125a | Sonnet |
| running | 125d. Refactor, behaviour unchanged: `src/state/store.ts` (3,767 lines) split into its reducer, its actions and its start-up, after item 124 merges (it edits the store); the copies 125a left there | 124, 125a | Opus |
| next | 125e. Refactor, behaviour unchanged: `src/code/command.ts` (2,486 lines, the dial's reader) split into one file per program family, moves only, after the sixth security read so that read sees one layout; every allow-list test and the fifth read's cases must pass untouched | 120 | Opus |
| running | 126. CI for many agents at once (owner, 26 Nov: faster, parallel, seamless): duration-balanced desktop Playwright shards (a full run is 16 to 18 minutes because two of six shards take 15 to 18 while the rest take 6 to 9), shards that fail the run, Web on phones split by engine, integration runs that always finish instead of cancelling each other, CI on every helper branch measured from pilot's last green commit, and the lead merging on a green CI run instead of the Mac's one-at-a-time gate | | Opus |
| done | 32. The desktop's Settings › People for the owner (the canvas's People board): the helpers, invites with Copy link and Cancel, Remove with its confirmation, and away dates, through the owner routes the API has; the new-device alert's "remove access" opens it | | Sonnet |
| done | 23. Browser control's smaller gaps: re-sealing after a vault key rotation, for sign-ins and connections alike (`POST /v1/admin/vault/reseal`), and a worker's list of the sign-ins its member may use (`port.signIns()`) | | Opus (coordinator) |
| done | 21. Customize › Connections for the owner (`docs/browser-control.md`, "Next slices"): the shop's sign-ins, with "Change" typing a new password into the vault from the app, and the owner renaming or removing an outpost, through owner routes a helper's session cannot reach | | Opus |
| done | 15. A helper's new device: the owner's session reads the shop's new helper sessions, and the desktop shows notify-rules' `new_device` alert | 13 | Sonnet |
| done | 16. Deletion follow-up: a shop whose wipe stopped after its registry row went stays in the console's list as deleting, and its wipe can be resumed. Today `tenantDelete` (`tenant-data.ts`) wipes the sessions and the registry row together (`auth-object.ts` `tenantWipe`) before the shop's own object, so a failure there leaves the shop unlisted | | Opus |
| done | 17. The owner's pages as an installable web app on a phone: a web session that lasts (an `HttpOnly` cookie unless the helper finds a reason not to), the owner's Needs you across their shops with Approve and Decline through the session decide route, a manifest and icons, and a service worker that caches only the shell and an offline page, never `/v1`, `/approve`, `/delete`, `/join` or `/ops`; off in effect until the owner turns sign-in on | | Opus |

## Queue for cloud routines

Take the first task below that has no `cloud/<task-id>` branch on the remote yet. One task per run. Every task
is a new, dependency-free TypeScript package (a task may name one workspace package it can use): copy
`package.json` and `tsconfig.json` from `packages/promptpay` (same scripts and dev dependencies), export
everything from `src/index.ts`, and write vitest tests. Do not touch `apps/` or any package that is not named
in your task: those are being changed on the Mac.

### format
`packages/format` (`@manut/format`). How the app writes money and times, in English for now, with a `locale`
argument so Thai can be added later.

- Money is integer satang in, text out, baht sign first, commas for thousands: 129000 gives `฿1,290`. Satang
  show only when they are not zero: 40 gives `฿0.40`, 123456789 gives `฿1,234,567.89`. An `always` option shows
  two decimals every time (`฿1,290.00`) for receipts.
- Parse what a person types (`1290`, `1,290`, `฿1,290.50`, `1290.5`) into satang; refuse anything else.
- VAT at 7 percent is inside the price. Split a total into before-VAT and VAT so the two always add up to the
  total: 129000 gives 120561 and 8439; 78300 gives 73178 and 5122; 390000 gives 364486 and 25514.
- Times, given `now`, a moment and a time zone (default `Asia/Bangkok`), 24-hour clock: under an hour ago
  `12 min ago`; earlier today `09:14`; yesterday `Yesterday 18:40`; earlier this year `Fri 20 Nov`; another year
  `20 Nov 2025`. Dates in full: `Sunday 22 November`.

Done when: the cases above and their edges (midnight, year change, zero and negative amounts refused) are tested.

Done on cloud/format, 23 Nov 2026: `packages/format` with money, typed-amount parsing, VAT split and relative times (55 tests).

### slip-rules
`packages/slip-rules` (`@manut/slip-rules`). Pure rules that compare a payment slip, already read into fields,
with an order. Reading the image is not part of this task.

- Input: the slip (`amountSatang`, `payeeName`, `paidAt`, `reference`, each possibly missing), the order
  (`orderRef`, `amountSatang`, `placedAt`), the shop's PromptPay name, and the references already used
  (`reference` to `orderRef`).
- Output: one verdict with the facts a screen needs: `matches`; `amount_differs` (both amounts); `other_payee`
  (the name on the slip); `older_than_order` (the slip is from before the order was placed, allowing five
  minutes of clock difference); `already_used` (the earlier order); `unreadable` (which fields are missing).
  When several apply, the order is: unreadable, already used, other payee, amount differs, older than order.
- Names compare without case, spaces or dots, so `Fon S.` equals `fon s`.
- A match never marks an order paid. It only says the slip agrees with the order: the owner still confirms
  the money arrived.

Done when: each verdict and the precedence between them is tested.

Done on cloud/slip-rules, 23 Nov 2026: `packages/slip-rules` with `checkSlip`, name matching and the five verdicts in their precedence (18 tests).

### promptpay-read
In `packages/promptpay` (already exists; add to it without changing what is there): `readPromptPayPayload(text)`
that takes a QR payload apart into its fields (id kind, id digits as typed locally, amount in satang if any,
static or dynamic) and checks the CRC. It must read back every payload `promptPayPayload` writes, and refuse a
payload whose CRC, lengths, GUID, country or currency is wrong.

Done when: round trips for every id kind with and without an amount are tested, and each refusal has a test.

Done on cloud/promptpay-read, 23 Nov 2026: `readPromptPayPayload` in `packages/promptpay` reads back every payload the writer makes and refuses a bad CRC, length, GUID, country, currency, id or amount (51 tests in the package).

### approval-wire
In `packages/approval-core` (already exists; add to it without changing its rules): a JSON wire format for
requests, decisions, records and standings, with decoders that never throw (a missing or unreadable field
takes a documented default; an unknown kind or status is kept as an explicit `unknown` value), and encoders
whose output the decoders read back unchanged.

Done when: round trips, missing fields, unknown values and a non-object input are tested.

Done on cloud/approval-wire, 23 Nov 2026: `wire.ts` in `packages/approval-core` with never-throwing decoders and matching encoders for requests, decisions, records and standings (unknowns kept explicitly; 19 tests).

### shop-memory
`packages/shop-memory` (`@manut/shop-memory`). The rules for what Buddy's team knows about one shop: the design
canvas board "Customize: memory and routines" ("What your team knows", "Where it came from", Correct, Forget,
"Waiting for your OK: not used until you confirm", "Tell Buddy something to remember"). Pure functions over a
plain state object; storing it is not part of this task. No operation throws: a refusal is a result value.

- A fact has an id, its text (trimmed, 1 to 280 characters), a status (`confirmed` or `waiting`), when it was
  made and changed (ms), `correctedAt` once the owner corrected it, and where it came from: `owner` (the owner
  said it), `document` (name and date: "From your price list, 3 November"), `edits` (how many of the owner's
  edits: "Learned from 12 of your edits"), `orders` (how many days of orders), `connection` (name and detail:
  "From your cost sheet in Google Sheets"), or `customer` (a chat reference: something a customer said).
- `remember(text)`: the owner's own fact, confirmed at once. A waiting fact with the same text is confirmed
  instead of added twice; a confirmed one answers `already_known`.
- `propose(text, source)`: the team learned something. A fact from a customer always waits for the owner; the
  other sources come from the owner's own data and are confirmed. The same text again answers `already_known`,
  except that a waiting fact proposed again from the owner's own data is confirmed.
- `confirm(id)` ("It's true"), `correct(id, text)` (new text, confirmed, `correctedAt` set) and `forget(id)`.
  An unknown id answers `not_found`.
- Forget removes the text. It keeps only a fingerprint of it (FNV-1a 64-bit of the compared form, as hex), so
  `propose` of the same text answers `forgotten` and the team does not learn it again. The owner saying it with
  `remember` clears the fingerprint.
- Texts compare after Unicode NFC, trimming, collapsing spaces and lower case, so `Closed on  Mondays ` equals
  `closed on mondays`. Thai text compares the same way.
- `usable(state)` lists only confirmed facts: a waiting fact is never used. At most 200 facts per shop; one more
  answers `full`.
- `exportFacts(state)` gives every fact, waiting ones included, and the number of fingerprints, never the
  fingerprints themselves.

Done when: each operation, each refusal, the customer rule, the fingerprint rule and Thai text are tested.

Done on cloud/shop-memory, 23 Nov 2026: `packages/shop-memory` with remember, propose, confirm, correct, forget, usable and exportFacts, FNV-1a fingerprints for Forget and the customer-waits rule (28 tests).

### books
`packages/books` (`@manut/books`). Ton's arithmetic for the daily sales summary and the month's books. It may
use `@manut/format` (`workspace:*`) for `splitVat`. Reading orders from a shop and sending books to FlowAccount
are not part of this task.

- Entries: a sale (`ref`, `channel` one of `line`, `shopee`, `lazada`, `shop`, `amountSatang`, `at` in ms), a
  refund (the sale's `ref`, `amountSatang`, `at`) and an expense (`ref`, `category`, `amountSatang`, `at`).
  Amounts are positive integer satang. Days are counted in a time zone, default `Asia/Bangkok`.
- A shop is VAT registered or not. When it is, VAT is split out of every sale and every refund on its own
  (each is its own receipt) with `splitVat`, and every total is the sum of those splits, so a day's rows add up
  to the day and the days add up to the month. When it is not, there are no VAT figures at all. Expenses have
  no VAT figures in this task.
- `dailySummary(entries, "2026-11-23", options)`: sales (count, total, by channel), refunds (count, total), net
  (sales less refunds), VAT before and VAT when registered, and expenses (count, total, by category).
- `monthBooks(entries, "2026-11", options)`: one row per day of the month, days with nothing included, and the
  month's totals.
- Flags that Ton raises and never fixes: `refund_without_sale`, `refund_exceeds_sale` (all refunds of one sale
  together), `duplicate_sale_ref`, and `invalid_amount` (zero, negative or not an integer: the entry is left
  out and flagged).
- `booksCsv(month)`: one line per entry (date, ref, kind, channel or category, amount, before VAT, VAT) with
  amounts as baht with two decimals (`1290.00`), made from integers. Fields are quoted as RFC 4180 says, and a
  field that starts with `=`, `+`, `-` or `@` gets a leading `'`, so a spreadsheet never runs it as a formula.

Done when: a day across midnight in Bangkok, a month of 28, 30 and 31 days, both VAT settings, each flag, CSV
quoting and the formula guard are tested.

Done on cloud/books, 23 Nov 2026: `packages/books` with `dailySummary`, `monthBooks`, the Ton flags and `booksCsv` with quoting and the formula guard (48 tests).

### routine-rules
`packages/routine-rules` (`@manut/routine-rules`). What a routine is, when it runs next, and how its timing is
said, for the Routines list on the canvas board "Customize: memory and routines" ("Every day at 08:00: Morning
brief", "Every Monday: Weekly growth brief", "When stock drops under 5: Tell me and draft a restock order", "On
the last day of the month: Send the books to FlowAccount. Asks first.", "Every night after 21:00: Answer
order-status questions"). Pure functions: running a routine is not part of this task. No function throws: a
refusal is a result value.

- A routine has an id, a name (1 to 80 characters), an action kind, a time zone (default `Asia/Bangkok`) and a
  trigger: `daily` at a time; `weekly` on one or more weekdays (0 is Sunday) at a time; `monthly` on a day from
  1 to 28 or on the last day, at a time; `window`, every day from one time to another, possibly past midnight
  (21:00 to 08:00); or `stockBelow` a whole number (an event, so it has no next run).
- Action kinds: `brief`, `draft` (something for the owner to look at), `reply` (to customers), `send` (a
  message, a post, or the books to a service), `pay` and `delete`. A routine that replies, sends, pays or deletes
  always asks first: `asksFirst` is true for those kinds and cannot be set false. `brief` and `draft` may run
  without asking.
- `nextRun(routine, now)`: the next start strictly after `now`, in ms; `null` for `stockBelow`.
  `inWindow(routine, now)` says whether a `window` routine is running now.
- `toSchedule(routine)`: the `{ hour, minute, weekdays, timeZone }` that `apps/api`'s schedule object
  (`ScheduleJSON` in `apps/api/src/schedule-object.ts`, read it, do not change it) can run, for `daily` and
  `weekly`; `null` for the kinds it cannot express.
- `describeTrigger(routine)`, in English: `Every day at 08:00`, `Every Monday at 08:00`, `Every Monday and
  Thursday at 09:30`, `On the 15th of each month at 09:00`, `On the last day of the month at 18:00`, `Every night
  after 21:00` (a window that crosses midnight), `Every day from 09:00 to 17:00`, `When stock drops under 5`.
- Time zones with daylight saving: a time that does not exist that day runs at the first minute after the gap;
  a time that happens twice runs once, at the first.

Done when: each trigger's next run around midnight, month ends of 28, 29, 30 and 31 days (29 February 2028), the
last-day rule, windows across midnight, the asks-first rule, `toSchedule`, `describeTrigger`, each refusal, and
one gap and one repeat in `Europe/London` are tested.

Done on cloud/routine-rules, 23 Nov 2026: `packages/routine-rules` with `createRoutine`, `nextRun`, `inWindow`, `toSchedule` and `describeTrigger`, daylight saving handled in any zone (47 tests).

### member-grants
`packages/member-grants` (`@manut/member-grants`). Which team member does which job, and what each job may do
without asking, from the canvas: "Nam uses it for orders and chat. Ton uses it for refunds, and always asks
first"; "Nam and Ton work there in practice mode for the first 3 days: drafts only, nothing sent"; "Refunds
are Ton's job, so Nam passed it on". It may use `@manut/approval-core` (`workspace:*`) for `ApprovalKind`; it
must not change approval-core.

- Members and their jobs, as data with these defaults: Buddy (the lead: routes work, writes nothing outside
  the app), Nam (sales chat: read orders, order status, reply to customers), Pim (content: draft posts, publish
  posts), Ton (books: read payments, check slips, draft books, send books to a service, ask for refunds), Kit
  (code: run commands).
- Each capability says whether it reads or writes, and which approval kind a write needs: a customer reply is
  `reply`, publishing a post is `public_post`, a refund is `money`, confirming a payment is
  `payment_confirmation`, sending the books is `message`, running a command is `command`.
- `decide(member, capability, connection, now)` answers one of: `allowed` (a read), `ask` with the approval
  kind, `draft_only` (practice mode), `not_my_job` with the member whose job it is, or `not_connected`.
- Practice mode: for 3 days from when a connection was made (a setting per connection), every write on it is
  `draft_only`, whatever its approval would be. The owner can end practice early.
- Rules that no data can change: a write never answers `allowed`; money and public posts always answer `ask`
  (or `draft_only`); an unknown member, capability or kind is refused, never guessed.

Done when: every default member's jobs, each answer, practice mode's edges (the moment it ends, ended early),
`not_my_job` naming the right member, and the rules that no data can change are tested.

Done on cloud/member-grants, 23 Nov 2026: `packages/member-grants` with the default roster, `decide` (allowed, ask, draft_only, not_my_job, not_connected, refused) and per-connection practice mode (18 tests).

### people-rules
`packages/people-rules` (`@manut/people-rules`). The rules for the people around a shop, from the canvas board
"States: people and roles": the owner and helpers, invites, passing a request on with a note, cover while the
owner is away, and removal. It may use `@manut/approval-core` (`workspace:*`) for `Role`, `ApprovalKind` and
`mayDecide`; it must not change approval-core. No function throws: a refusal is a result value.

- Invites: the owner invites one helper, bound to one identity (a LINE account id compared exactly, or an email
  compared without case). An invite works once, for 7 days. `acceptInvite` answers `joined`, `expired`,
  `already_used`, `revoked` or `wrong_account`. Only `joined` and `wrong_account` say which shop it is for; an
  expired invite shows nothing about the shop.
- Passing on: a helper may pass a request it cannot decide (`mayDecide` is false) to the owner with a note of
  1 to 500 characters. It decides nothing: the owner still decides. Passing on a request the helper may decide
  answers `decide_yourself`; one already decided answers `already_decided` with who decided and when (the
  first decision wins, and the other person sees what happened).
- Away: the owner sets an end date and one helper to cover. While away, the covering helper decides only what
  `mayDecide` already lets a helper decide: money and public posts never move to a helper, and stay waiting for
  the owner. `deciders(state, kind, now)` lists who may decide a kind now.
- Removal: removing a helper revokes every session they have (the list of session ids to end), their pending
  invites and any cover they hold. A removed helper's decision is refused.

Done when: each invite answer, passing on and its refusals, cover never moving money or posts, cover ending on
its date, and removal are tested.

Done on cloud/people-rules, 23 Nov 2026: `packages/people-rules` with invites, `acceptInvite`, `passOn`, away cover, `deciders`/`canDecide` and `removeHelper` (24 tests).

### shop-templates
`packages/shop-templates` (`@manut/shop-templates`). The starting setups for three kinds of online seller: the
roadmap's first kind plus its "two more shop templates". Data and checks only, in English for now; applying a
template to a shop is not part of this task. Use exactly the content below; do not add templates or routines.

- A template has an id, a name (up to 40 characters), one line saying which shops it fits, the team members on
  by default, its routines (a trigger in words, what the routine does, and whether it asks first), and the
  questions Buddy asks the owner in the first week, so that what the team knows comes from the owner.
- `handmade`, "Handmade and gifts" (candles, soap, crafts and gift sets, like Baan Mali): Nam, Pim and Ton.
  Routines: "Every day at 08:00": "Morning brief"; "Every Monday at 08:00": "Weekly growth brief"; "When stock
  drops under 5": "Tell me and draft a restock order"; "On the last day of the month at 18:00": "Send the books
  to FlowAccount", asks first. Questions: your price list; the order total for free shipping; how long
  pre-orders take; whether you gift-wrap, and what it costs.
- `fashion`, "Clothes and accessories": Nam, Pim and Ton. Routines: "Every day at 08:00": "Morning brief";
  "Every Friday at 10:00": "Draft a new-arrivals post", asks first before it is posted; "When a size drops under
  3": "Tell me and draft a restock order"; "On the last day of the month at 18:00": "Send the books to
  FlowAccount", asks first. Questions: your size chart; whether you take exchanges, and for how long; how
  pre-orders work; which items are never discounted.
- `food`, "Packaged food and drinks": Nam and Ton. Routines: "Every day at 08:00": "Morning brief"; "Every day
  at 09:00": "List what expires within 7 days"; "Every day at 15:00": "Remind me of today's delivery cut-off";
  "On the last day of the month at 18:00": "Send the books to FlowAccount", asks first. Questions: how long each
  product keeps; where you deliver, and the day's cut-off time; which products must stay cold; what to say
  when a customer asks about allergies (Buddy never answers allergy questions from guesswork).
- `templates()` lists them; `templateById(id)` finds one or answers `null`.
- `checkTemplate(template)` returns every problem: a routine that posts, sends, pays or replies must ask first;
  Buddy is always part of the team and is not listed; member ids are among `nam`, `pim`, `ton` and `kit`;
  names, lines and questions are not empty; there are 2 to 6 questions. Every built-in template has no
  problems.

Done when: the three templates match the content above exactly, each `checkTemplate` problem is tested with a
broken copy, and `templateById` of an unknown id is tested.

Done on cloud/shop-templates, 23 Nov 2026: `packages/shop-templates` with the handmade, fashion and food templates, `templates`, `templateById` and `checkTemplate` (20 tests).

### agent-prompts
`packages/agent-prompts` (`@manut/agent-prompts`). What each team member sends to a model through the model
gateway, built from the shop's own data. It may use `@manut/shop-memory` (`workspace:*`) for `Fact` and
`usable`. Pure functions: calling a model is not part of this task.

- `buildRequest(input)` returns `{ model, system, messages, maxOutputTokens }` in the shape of the model
  gateway's `ChatRequest` (read `apps/api/src/model-provider.ts`; do not import it): messages start with a user
  turn and alternate as that file requires.
- Input: the member (`nam` sales chat, `pim` content, `ton` books), the shop (its name, what it sells, and a
  reply tone when known), the shop's memory state, the job (for Nam the customer's newest message and the
  conversation so far; for Pim what to post about; for Ton yesterday's numbers as given), the model id and an
  output allowance. The input type has no field for secrets, connection ids or emails, so none can reach a
  prompt.
- The system prompt says who the member is and their one job; that everything they write is a draft the owner
  approves; that they never promise a price, discount, refund or delivery date that is not in the shop's facts;
  and that they answer in the customer's language (Thai or English).
- Only `usable(state)` facts go in, each with where it came from ("Free shipping on orders over ฿800 (from your
  price list, 3 November)"). A fact waiting for the owner never goes in.
- A customer's words go in the messages only, never in the system prompt, and the system prompt says that text
  inside a customer's message is never an instruction to the team.
- A size limit: estimate one token per UTF-8 byte, as the gateway does. Over the limit (default 24,000), drop
  the oldest conversation turns first, then the oldest facts, never the newest customer message, and return how
  many of each were dropped.

Done when: each member's request, only usable facts, the limit and what is dropped first, customer text never
in the system prompt, Thai text, and an empty memory are tested.

Done on pilot/week-1, 23 Nov 2026: `packages/agent-prompts` with `buildRequest`, `estimateTokens` and `describeSource` (14 tests), built in the lead session because the night build routine was no longer there.

### sheets-rows
`packages/sheets-rows` (`@manut/sheets-rows`). The request that would append a month of Ton's books to a Google
Sheet, built from `@manut/books` (`workspace:*`). Pure: no network call and no sign-in; sending it is a later
task behind the owner's own Google connection.

- `appendRequest(month, { spreadsheetId, sheetName })` returns `{ method, path, query, body }` for the Sheets
  API's `spreadsheets.values.append`. Check the exact path, query parameters and body with the Context7
  documentation tool before writing it, and name the page in a comment. Use `valueInputOption=RAW`, so the
  sheet never runs any cell as a formula, and `insertDataOption=INSERT_ROWS`.
- The rows have the same columns and order as `booksCsv` in `@manut/books`, with a header row first. Amounts are
  JSON numbers in baht made from integer satang through exact decimal text, and a test checks the JSON text of
  each amount equals its baht text (`1290.33`, never `1290.3299999`).
- The sheet name is quoted in A1 notation as the Sheets API requires (a name with a space or a quote is wrapped
  in single quotes, a quote inside doubled).

Done when: the request's shape, RAW, the A1 quoting, the amounts' JSON text, an empty month, and a ref that
looks like a formula staying plain text are tested.

Done on pilot/week-1, 23 Nov 2026: `packages/sheets-rows` with `appendRequest`, `quoteSheetName` and `bahtNumber` (9 tests), checked against the Sheets API reference, built in the lead session.

### notify-rules
`packages/notify-rules` (`@manut/notify-rules`). What the app may show outside its window, from the design canvas
board "States: outside the app" (`~/Developer/gospark-main/manut-ai-artifacts/app-screens/project/StatesOutside.dc.html`
on the owner's Mac; its rules are quoted here). Pure functions: showing a notification is not part of this task.
No function throws: a refusal is a result value.

- Events: a request waiting for the owner (its approval-core kind: `message`, `reply`, `money`, `public_post`,
  `payment_confirmation` or `command`, the member who asks, and a one-line summary), a live page that stopped
  working, a sign-in from a new device, and a job that waited while the Mac slept.
- `notificationFor(event, settings, now)` answers whether to show it, whether it makes a sound, its title and body,
  and its buttons. "A message request can be approved from the notification": a `message` or `reply` request gets
  "Approve" and "Look first". "Money never from a notification": every other kind gets "Look first" and "Later",
  never "Approve". The title names the member ("Nam needs you") and the body is the summary.
- Details hidden: on the lock screen, or with the setting "Hide details" on, "no names, amounts or customers are
  shown": the title is "Manut AI" and the body says how many requests need the owner ("1 request needs you.").
- Quiet hours (a start and an end time, which may cross midnight, in the owner's time zone; default 22:00 to
  08:00, Asia/Bangkok): "Nothing makes a sound. Requests wait in Updates." Only "A live page that stops working and
  a sign-in from a new device still alert you", with sound.
- A job that waited while the Mac slept is shown once after waking, and only if something had to wait.
- `badgeCount(requests)`: "The number on the Dock icon is the number of requests waiting, and nothing else."
- A request kind this build does not know is treated as owner-only: no "Approve" button.

Done when: each event kind, the Approve rule for every approval kind, hidden details on the lock screen and by the
setting, quiet hours across midnight with both exceptions, the badge, and an unknown kind are tested.

Done on cloud/notify-rules, 23 Nov 2026: `packages/notify-rules` with `notificationFor`, `inQuietHours`, `canApproveFromNotification` and `badgeCount` (20 tests).
Wired into the desktop on 24 Nov 2026 (December item 6, merged into `pilot/week-1`): every notification and the Dock badge
go through it, with a `notice` event added for news that asks nothing (24 tests).

### env-example
`packages/env-example` (`@manut/env-example`). Reads a project's `.env.example`, given as text, into the variables
the code editor's preview needs (`docs/code-editor.md`, "Left for later": the preview runs with sample values,
and should read what a project needs from its `.env.example` as well as from Kit's changes).

- `readEnvExample(text)` answers each variable in file order:
  - `name`;
  - `sample`, the value written there, or empty;
  - `comment`, the comment lines just above it, joined;
  - `secret`.
- `secret` is true when the name looks like one:
  - it ends in `_KEY`, `_SECRET`, `_TOKEN` or `_PASSWORD`;
  - or it contains `PRIVATE`;
  - or the sample looks like a real key (`sk-`, `ghp_`, `xoxb-`, a long run of base64).
- The forms a line may take:
  - `NAME=value` and `export NAME=value`;
  - a value in single quotes (kept as written);
  - a value in double quotes, where `\n` and `\"` are read;
  - an unquoted value, where a ` #` starts a comment;
  - blank lines and lines that are only a comment.

  A name is `[A-Za-z_][A-Za-z0-9_]*`.
- Any other line is listed in `skipped` with its line number, never thrown. A name written twice keeps the later
  value and is listed in `repeated`.
- `sampleEnv(vars)` gives an object for the preview: every secret gets a plainly fake value (`sample-` and the
  name in lower case), and every other variable its written sample.
- It never reads a file or the process's environment: text in, values out.

Done when: each line form above and each secret rule is tested, with Thai text in a comment and a value, CRLF line
endings, a repeated name, an empty file and a file of only comments.

Done on cloud/env-example, 24 Nov 2026: `packages/env-example` with `readEnvExample`, `looksSecret` and `sampleEnv` (44 tests).

### dev-url
`packages/dev-url` (`@manut/dev-url`). Finds the address a project's dev server says it serves on, in the lines it
prints, for the code editor's preview (`docs/code-editor.md`, "Left for later": "The preview itself").

- `findDevUrl(lines)` takes the output as lines and answers the first address that is on this machine:
  - `url`: the address, with `0.0.0.0`, `[::]` and `127.0.0.1` shown as `localhost`;
  - `port`;
  - `line`: the 1-based line it was found on.
  Or it answers null.
- It reads the forms these servers print, each with a sample in the tests:
  - Vite (`➜  Local:   http://localhost:5173/`);
  - Next.js (`- Local:        http://localhost:3000`);
  - webpack-dev-server (`Loopback: http://localhost:8080/`);
  - Astro (`┃ Local    http://localhost:4321/`);
  - wrangler dev (`Ready on http://localhost:8787`);
  - Python's `http.server` (`Serving HTTP on :: port 8000 (http://[::]:8000/) ...`);
  - Django (`Starting development server at http://127.0.0.1:8000/`);
  - Flask (` * Running on http://127.0.0.1:5000`);
  - Rails / Puma (`* Listening on http://127.0.0.1:3000`).
- Terminal colours and cursor escapes are stripped first.
- Only `http` and `https` addresses whose host is this machine count: `localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`
  or `[::]`. A network address (`Network: http://192.168.1.5:5173/`) or any other host is never answered.
- A port must be between 1 and 65535.
- Text in, value out: it never opens a connection.

Done when: each server's sample above is found, a network-only output answers null, a line with two addresses
answers the local one, the escapes are stripped, a port out of range is refused, and an empty output answers null.

Done on cloud/dev-url, 24 Nov 2026: `packages/dev-url` with `findDevUrl` reading nine servers' output, local hosts only, escapes stripped, ports checked (25 tests).

### preview-command
`packages/preview-command` (`@manut/preview-command`). Chooses the command that starts a JavaScript project's
preview, from its `package.json` text and the names of the files at its root, for the code editor's preview.

- `previewCommand({ packageJson, files })` answers one of two things:
  - `{ argv, manager, script }`: the command as a list of words (never one string for a shell), the package manager,
    and the script it runs;
  - `{ none: why }`, with `why` one of `no_package_json`, `unreadable`, `no_script` or `refused`.
- **The package manager** is read from the lockfile in `files`, first match wins:
  - `pnpm-lock.yaml` → pnpm;
  - `yarn.lock` → yarn;
  - `bun.lock` or `bun.lockb` → bun;
  - `package-lock.json` → npm;
  - none → npm.

  A `packageManager` field (`"pnpm@9.1.0"`) wins over the lockfile.
- **The script** is the first of `dev`, `start`, `preview` and `serve` that `scripts` has, and the argv is
  `[manager, "run", script]`.
- **A refused script.** A script whose text looks like it publishes is refused and never answered, so the preview
  never deploys anything: it contains `deploy`, `publish` or `release`, `vercel` with `--prod`, `netlify` with
  `--prod`, `firebase deploy`, `gh-pages`, or `npm publish`. The next script on the list is then tried.
- Text in, value out: it reads no file and runs nothing.

Done when: each lockfile, the `packageManager` field, each script name in order, each refused form (and the next
script answered after one), a broken `package.json`, an empty `scripts` and a project with no `package.json` are
tested.

Done on cloud/preview-command, 24 Nov 2026: `packages/preview-command` with `previewCommand`, choosing the manager, script and refusing publishing scripts (33 tests).
