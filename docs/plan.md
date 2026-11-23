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
- [ ] A real-phone pass of the approval page, and a first real LINE push in a dev environment

Week 2, brought forward:

- [x] `apps/desktop`: fork of Oh My Hermes with the Hermes bridge removed (1,358 unit tests, `cargo check` passes)
- [ ] `apps/desktop`, next pass: the canvas side menu and screens, a real runtime adapter against `apps/api`, approvals through `packages/approval-core`, and a triage of the 156 Playwright specs (some still expect removed screens)
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
| 2 Control plane | Tenancy and sign-in, the approval core, saved sessions | partial (lifted from GoSpark; `packages/approval-core` decides every send: replies, deletions and workers' requests; sessions read approvals as its wire records; one person can own several shops and help at others, with a session per shop whose shop and role come from the shop's own record, `docs/several-shops.md`). Real sign-in needs the owner: an Apple developer team for Sign in with Apple, or LINE Login, which is parked |
| 2 Control plane | The model gateway with spending caps, and cost per shop | built (`docs/model-gateway.md`), with the console's Model spend page; no model is called until the owner adds an Anthropic key and settles the rate and the cap |
| 2 Control plane | Memory; the job queue; the audit log | built: the job flow, the audit log, and what the team knows (stored per shop, with the console's Memory page); workers read memory when they are built in Phase 4 |
| 2 Control plane | Gate: the whole job flow end to end with a stand-in worker | built as a test (`apps/api/test/job-flow.test.ts`) |
| 3 Desktop MVP | Mission Control and the session view | built: Home, the side menu and pages, the job view, the activity log and Pause everyone (in Practice; the connected runtime answers "not yet" until the API serves jobs) |
| 3 Desktop MVP | Three-step onboarding; offline cache; a real runtime adapter to `apps/api` | built: the three-step first run, a connected runtime (Settings › Developer) that reads the shop and answers its approvals through the session decide route, and the offline cache; real sign-in needs the owner (an Apple developer team, or LINE Login, which is parked) |
| 4 Workers | Three agents (sales chat, content, light bookkeeping), permissions, memory in sessions | built with a stand-in model: Nam, Pim and Ton draft through the job flow with member-grants' permissions and confirmed facts (`apps/api/src/workers.ts`); real models need the owner's key, and sending stays behind the approvals (LINE is parked) |
| 4 Workers | Connections: LINE OA, Shopee, Lazada, FlowAccount, Google Sheets | partial (LINE built; the Google Sheets append request for Ton's books is `@manut/sheets-rows`, sending it needs the owner's Google connection; the rest need the owner's applications, `docs/connectors.md`) |
| 5 Launch | Web and LINE clients, routines, browser control, the vault, PromptPay billing, two shop templates, the admin panel | partial: the vault's site sign-ins and outposts (browser control's first slice), routine and template rules, the desktop's routines page, the console (gate, audit, memory, model spend) are built; routines run on the schedule object and a shop made from a template gets its routines and first-week questions (runs wait for the owner's switches); the outpost's step channel (open, read and sign-in steps to one outpost and back, no password in either) with a rate limit, removal and credential rotation; the outpost in the desktop shell (this Mac, registered through the owner's session) is built. Parked by the owner: PromptPay billing and the LINE client |
| 6 Expand | Phone apps, computer control, several shops in one view, more roles and businesses, the full code editor | partial: more roles built (the owner's helpers, deciding from a session by role); three shop kinds as templates; the desktop fork's terminals and coding sessions; several shops in one view is built on the API side (`docs/several-shops.md`), with the desktop's switcher next; computer control is in the December plan (the outpost's step channel first); phone apps wait for the desktop |

## December engineering (the owner's go, 23 Nov 2026)

Everything here can be finished in December without the owner. LINE and payments stay parked; real sign-in,
real models, Thai copy and production wait for the owner. One helper per line, at most four at a time on this
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
| done | 4. Console: the People page | | Sonnet |
| done | 7. Several shops in one view: the design and the API side (`docs/several-shops.md`); the desktop switcher is next | | Opus |
| done | Several shops: the console's owner link, and ending a shop session (`docs/several-shops.md`, slices 3 and 5) | | Sonnet |
| done | The Playwright revival (pull request #15): 555 specs pass in CI | | Haiku |
| running | 11. Playwright follow-up: the 31 specs still failing (the old sidebar's Tasks bar, zoomed split panes, reply there, a font width on Linux) and the 219 the 35-minute cap leaves unrun (shard the job) | | Sonnet |
| done | 9. Desktop leftovers (the Team page's member menu and lines, Needs you, History's chips) and three app bugs the revival found (the undo toast, the folder reveal, the usage caret) | | Sonnet |
| running | 6. macOS notifications on `@manut/notify-rules` | | Sonnet |
| 10 | A join page for helpers' invite links (`/join/{token}`), once real sign-in exists | sign-in (owner) | Sonnet |
| done | 8b. The outpost in the desktop shell (this Mac): registering, heartbeat, fetching steps, typing a sign-in only on its origins, reporting; registered through the owner's session | | Opus |

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
