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
- [x] Operator routes to export and delete one shop's pilot data, and the console's Shop data tab for both (the owner's confirmation for a live shop is being built)
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

Status: **built** (tested and merged), **partial**, **not yet**, or **owner** (needs an account, money or a
decision only the owner can give).

| Phase | Deliverable | Status |
| --- | --- | --- |
| 0 Spikes | Drive the DeepSeek Harness; pause and resume approvals with LangGraph.js; draft the worker adapter contract | not yet (the event contract exists in `packages/agent-events`) |
| 1 Pilot | Buddy on LINE run by operators; simple web approval view; tenant and owner records; simplest approval object | built |
| 1 Pilot | Approval cards and a morning brief sent to owners on LINE | not yet; sending to real owners needs the owner's go and Manut's own LINE Official Account |
| 1 Pilot | The gate's numbers: 14 free days, paid ฿499, active on day 14, per shop | not yet |
| 1 Pilot | Audit log an operator can read | partial (task history and deletion records) |
| 2 Control plane | Tenancy and sign-in, the approval core, saved sessions | partial (lifted from GoSpark; `packages/approval-core` used by deletion only) |
| 2 Control plane | The model gateway with spending caps, and cost per shop | not yet |
| 2 Control plane | Memory; the job queue; the audit log | partial (tasks and schedules lifted) |
| 2 Control plane | Gate: the whole job flow end to end with a stand-in worker | not yet (can be a test) |
| 3 Desktop MVP | Mission Control and the session view | partial (Home, side menu and pages; sessions from the fork) |
| 3 Desktop MVP | Three-step onboarding; offline cache; a real runtime adapter to `apps/api` | not yet |
| 4 Workers | Three agents (sales chat, content, light bookkeeping), permissions, memory in sessions | not yet (models cost money: the owner) |
| 4 Workers | Connections: LINE OA, Shopee, Lazada, FlowAccount, Google Sheets | partial (LINE built; the rest need the owner's applications, `docs/connectors.md`) |
| 5 Launch | Web and LINE clients, routines, browser control, the vault, PromptPay billing, two shop templates, the admin panel | partial (vault, schedules, PromptPay payloads, the console) |
| 6 Expand | Phone apps, computer control, several shops in one view, more roles and businesses, the full code editor | partial (the desktop fork's terminals and coding-agent sessions) |

## Queue for cloud routines

Take the first task below that has no `cloud/<task-id>` branch on the remote yet. One task per run. Every task
is a new, dependency-free TypeScript package: copy `package.json` and `tsconfig.json` from `packages/promptpay`
(same scripts and dev dependencies), export everything from `src/index.ts`, and write vitest tests. Do not touch
`apps/` or any package that is not named in your task: those are being changed on the Mac.

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

### promptpay-read
In `packages/promptpay` (already exists; add to it without changing what is there): `readPromptPayPayload(text)`
that takes a QR payload apart into its fields (id kind, id digits as typed locally, amount in satang if any,
static or dynamic) and checks the CRC. It must read back every payload `promptPayPayload` writes, and refuse a
payload whose CRC, lengths, GUID, country or currency is wrong.

Done when: round trips for every id kind with and without an amount are tested, and each refusal has a test.

### approval-wire
In `packages/approval-core` (already exists; add to it without changing its rules): a JSON wire format for
requests, decisions, records and standings, with decoders that never throw (a missing or unreadable field
takes a documented default; an unknown kind or status is kept as an explicit `unknown` value), and encoders
whose output the decoders read back unchanged.

Done when: round trips, missing fields, unknown values and a non-object input are tested.
