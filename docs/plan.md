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
| 2 Control plane | Tenancy and sign-in, the approval core, saved sessions | partial (lifted from GoSpark; `packages/approval-core` decides deletions and workers' requests; replies still use the lifted action proposals) |
| 2 Control plane | The model gateway with spending caps, and cost per shop | built (`docs/model-gateway.md`); no model is called until the owner adds an Anthropic key and settles the rate and the cap |
| 2 Control plane | Memory; the job queue; the audit log | partial: the job flow and the audit log are built; what the team knows is `@manut/shop-memory`, not yet stored by the API |
| 2 Control plane | Gate: the whole job flow end to end with a stand-in worker | built as a test (`apps/api/test/job-flow.test.ts`) |
| 3 Desktop MVP | Mission Control and the session view | partial (Home, side menu and pages; sessions from the fork) |
| 3 Desktop MVP | Three-step onboarding; offline cache; a real runtime adapter to `apps/api` | partial: the three-step first run and a read-only connected runtime (Settings › Developer) are built; real sign-in needs the owner (an Apple developer team, or LINE Login, which is parked); the offline cache is not yet |
| 4 Workers | Three agents (sales chat, content, light bookkeeping), permissions, memory in sessions | not yet: the workers' side of the job flow is built and tested with a stand-in; Ton's books are `@manut/books`; each member's jobs and practice mode are queued for the night build; real models cost money (the owner) |
| 4 Workers | Connections: LINE OA, Shopee, Lazada, FlowAccount, Google Sheets | partial (LINE built; the rest need the owner's applications, `docs/connectors.md`) |
| 5 Launch | Web and LINE clients, routines, browser control, the vault, PromptPay billing, two shop templates, the admin panel | partial (vault, schedules, the console). PromptPay billing: owner, parked for later (23 Nov); the payload writer and reader and the slip rules exist as packages. Routine rules and three shop templates are queued for the night build |
| 6 Expand | Phone apps, computer control, several shops in one view, more roles and businesses, the full code editor | partial (the desktop fork's terminals and coding-agent sessions; approval-core's helper role; the rules for invites, passing on and cover are queued for the night build) |

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
