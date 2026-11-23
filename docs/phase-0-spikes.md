# Phase 0: the three spikes, answered (23 Nov 2026)

The roadmap's Phase 0 asked three questions before the platform is built: how to drive the DeepSeek Harness,
whether LangGraph.js can pause and resume for approvals, and what a worker adapter looks like. Its gate is that
both spikes are answered. Neither blocks the pilot, which people run. This note answers all three from code
already in this repository. The third began as a draft for Phase 2 and is now built and tested (section 3). Section 4
is the three workers Phase 4 runs on it: Nam, Pim and Ton.

## 1. Driving the DeepSeek Harness

**Answer: as a headless chat agent, one process per message, continued by session. The desktop fork already
does this.**

- The DeepSeek Harness (`dsh`) is DeepSeek's open-source agent harness (MIT, developer preview). The model
  adapter, tools, sessions, sandbox and agent loop are each a plugin. It ships as the npm package
  `@deepseek-ai/dsh`, reads `AGENTS.md` and `CLAUDE.md`, and speaks MCP and the Agent Client Protocol
  ([DeepSeek](https://deepseek.com/harness/en/), [Ollama's integration](https://docs.ollama.com/integrations/deepseek-harness)).
- `apps/desktop` lists `dsh` as a built-in chat agent (`src-tauri/src/sessions.rs`, `AGENTS`; `src/sessions/agents.ts`).
  `src-tauri/src/dsh_chat.rs` runs `dsh --profile headless --json` for each message and continues the
  conversation with `--session-id`, with tests.
- What is left needs the owner: a model account for `dsh` to call, which costs money.
- Upstream settings can change between preview releases. The adapter lives in one module, so a change touches
  one file.

## 2. Pausing and resuming for approvals

**Answer: approvals pause in the control plane's own approval record, not inside a worker's graph. LangGraph.js
is not needed for them.**

Approvals already pause and resume in two places, each settling once:

- **The backend.** A reply is an exact-action proposal on the shop's task object, which accepts one decision.
  The broker's begin gate dispatches it at most once, and it settles as confirmed, failed or unknown. Nothing
  runs until the owner approves; in the pilot the owner decides through a signed link. Owner-confirmed deletion
  runs its whole lifecycle through `packages/approval-core`'s transitions: open, decide once, expiry, and
  owner-only kinds.
- **The desktop.** An agent's approval waits in its chat until it is answered once, through `settleApproval`
  (`apps/desktop/src/chat/cards/respond.ts`), which is the store's `respondApproval`. The runtime refuses a
  second answer.

A worker built on LangGraph.js can still use its interrupts. It maps an interrupt to an approval request
through the contract below, and resumes when the decision comes back. The pause itself belongs to the control
plane, where one rule settles it.

## 3. The worker adapter contract (built)

This is how a worker plugs into the control plane, as built in Phase 2. A worker is one of Buddy's team members
running in the cloud (Phase 4), a person in the pilot, or a coding agent on the owner's computer. The control plane's
side is `apps/api/src/job-flow.ts`, over routes on the task object (`apps/api/src/task-object.ts`) that no public
route reaches: the control plane calls them in code, as workers call the model gateway. The Phase 2 gate runs the
whole flow in workerd with a deterministic stand-in worker (`apps/api/test/stand-in-worker.ts`,
`apps/api/test/job-flow.test.ts`).

- **Job.** `startAttempt` gives a worker one attempt at a task: the tenant, the task id, the attempt and its fencing
  token (the task object's claim), the goal (the task's objective), a spending cap in satang and a deadline (the
  attempt's, 20 minutes unless asked otherwise). The cap is what is left of the shop's monthly model cap when the
  attempt starts: the gateway holds every call against the shop's cap, so an attempt can never spend more, and there
  is no separate cap per attempt. Nothing is claimed while `officeCloud` is off or the owner's consent is missing.
- **The port.** `workerPort(env, job)` is everything the worker holds: `report`, `heartbeat`, `callModel`, `ask`,
  `outcome`, `draft`, `waitForOwner` and `finish`, bound to that one attempt. The port keeps the environment and has no method that returns a
  credential, so the worker never holds a secret. Every step but `finish` re-reads the kill switches and the owner's
  consent, as the session routes do, and every step checks the attempt first (its fence, lease and deadline), so a
  worker whose attempt ended learns so before anything else happens (`ended: true`). A worker waiting for a person
  keeps its attempt alive by reading `outcome`, which extends the lease as a heartbeat does.
- **Events.** `report` takes agent events in the wire shape of `packages/agent-events` (one object with a `type`) and
  appends them to the task's own event log (`kind: "agent"`, the event kept exactly as reported, with the attempt that
  reported it), the log that already orders, replays (`GET /v1/tasks/:id/events`) and exports the task's history.
  The kind is not checked against any list, so a kind the contract does not know yet is kept; readers decode it
  tolerantly as `unknown`. Each event may be up to 8 KiB, a report up to 100 events, and the log keeps its last 100
  entries as before, so a long attempt's early events fall out of it. A report is a sign of life, like a heartbeat.
- **Cost.** `callModel` goes only through the model gateway (`model-gateway.ts`, `callModel`), metered against the
  shop's cap. A 402 `budget_exceeded` ends the attempt, failed with the reason `budget`: the control plane ends it,
  not the worker, so a worker that ignores the refusal still cannot go on.
- **Drafts.** `draft` keeps what the worker wrote on the task for the owner to read (`DraftJSON` in task-object.ts:
  who wrote it and for which job as codes, the words, what it is about as ids, and what sending it would take). One per
  attempt, so a retried write never leaves two (`draft_exists`). A draft is not an action: it proposes nothing and opens
  no request. The task object lists them (`GET /drafts`) and the task export carries them.
- **Asking.** Before an external write the worker stops and calls `ask` with the operation, the target and the
  payload. The control plane picks the shop's live connection whose grant covers the target and allows writes, and
  stamps its grant revision. In one storage transaction the task object stores the exact action (bound to its
  request, `requestId`) and opens an approval-core request with `openTransition`: the kind set from the operation and
  never from the worker (`linear.issue.create` is `command`, which only the owner decides), the options approve and
  decline, the action's 24-hour expiry, and the stamp of the asking attempt. Only `linear.issue.create` is open to
  workers so far; a LINE reply needs the record that binds it to the message it answers, which only the pilot's
  reply flow writes, so it stays there.
- **Deciding.** `decideRequest` reads the switches and consent first, as the pilot's link does (any decision needs
  `officeCloud`; approving needs `officeExternalWrites` and consent), then settles the request once with approval-core's
  `decideTransition` inside a task object transaction: who decided first, `mayDecide` (a helper cannot decide a
  command), `bindingHolds`, expiry, revision and option. The running attempt comes from the task object itself: the
  newest claim, while it is active and its lease and deadline hold, and otherwise `none`, so a request whose attempt
  ended is refused as `attempt_ended` (approval-core reads a missing attempt as unknown and would let it through).
  An approval moves the action to approved and a decline rejects it, in the same transaction. The older route that
  decides an action directly refuses an action that has a request (`decide_by_request`), so there is no way round.
- **Effects.** A worker never performs an external write. On approval, `dispatchApproved` hands the action to the
  broker (`broker-actions.ts`): the task object's begin gate moves it to dispatching once and hands over the approved
  copy, and the finish half re-checks the live grant, takes the credential from the vault and settles it confirmed,
  failed or unknown. A retry after a crash at any point never sends twice: before the send began, the next try
  (the worker's `outcome` read, or another `dispatchApproved`) begins it once; after it began, the begin gate refuses,
  and a send orphaned for five minutes settles unknown for a person to check.
- **Ending.** An attempt ends done, failed with a reason, or cancelled: the worker's `finish` (through the control
  plane, with its fence), the control plane on its own (`budget`), `cancelAttempt`, or `endSilentAttempts`, which ends
  each attempt whose lease lapsed (`silent`) or whose deadline passed (`deadline`). The requests an ended attempt left
  waiting are superseded (`attempt_ended`) by approval-core's binding, from the moment the attempt stops running,
  before any sweep writes the end down. Nothing schedules the sweep yet.
- **Waiting for the owner.** An owner may take longer than an attempt's 20 minutes to answer, so a worker that asked
  ends its attempt with `waitForOwner`: the attempt ends `awaiting_owner`, can do nothing more, and supersedes nothing.
  While it is the task's newest claim it still holds the task for approval-core's binding (`runningAttemptSync`), so
  its request stays open until the request's own expiry (24 hours), and neither the lease nor the deadline cuts it off;
  the sweep passes it by. The owner's decision settles and dispatches as before, and the control plane then gives the
  worker a new attempt to read the outcome (`outcome`) and carry on. A newer claim made before the owner answers
  supersedes the question, as any newer attempt does, so the control plane resumes only after the decision. It is the
  worker's own end, with its fence, and only while a request it asked still waits (`nothing_waiting` otherwise).
- **Audit.** Every step is written to the shop's audit log (`docs/pilot-api.md`, "Audit log"): the attempt's start
  and end, each request, decision (refusals included) and superseded request, and each dispatch with its outcome.
- **The Phase 2 gate** drives this contract with the stand-in worker, in real workerd against the real objects:
  scripted agent events with an unknown kind, one model call through the gateway's stand-in provider, one approval,
  the owner's decision, and the write sent once with the vault's credential to a provider whose fetch is a stub. It
  also covers a helper refused for a command, a second decision refused, a decision after the attempt ended refused,
  budget exhaustion, a send retried after a crash before and after it began, a silent worker ended and its request
  superseded, a cancelled attempt, the switches and consent, a target no grant covers, one draft per attempt, and a
  worker that waits for the owner: its request still open and sent once half an hour after the deadline, still
  expiring at its own time, and superseded by a newer claim.

Not built yet: a queue that hands jobs to workers in the background (the operator's route in section 4 runs one job
while it waits), a schedule for the sweep, a cap per attempt, and a way for the control plane to resume a worker that
waits for the owner once the owner has answered: the waiting is built, and a test resumes it by hand.

## 4. The three workers (Phase 4, built)

Nam (sales chat), Pim (content) and Ton (books) run on this contract (`apps/api/src/workers.ts`), with the model
gateway's stand-in provider until the owner adds a model key, which costs money. They make drafts only. The owner has
parked LINE and payment features, so no worker sends, posts, pays or refunds, and none asks for an external write: the
approval paths that already exist stay the only way anything leaves the app.

- **Jobs.** Nam drafts a reply to a customer's message the shop holds (`{ kind: "reply", messageId }`). Pim drafts a
  post about a topic an operator gives (`{ kind: "post", topic }`). Ton writes the owner a short summary of yesterday
  in Bangkok (`{ kind: "daily_summary" }`) from the order payments the shop has recorded, each counted as a LINE sale
  at the moment it was confirmed, through `@manut/books`' `dailySummary`.
- **Starting.** An operator starts a job from the console (`POST /v1/admin/workers/run`, `docs/pilot-api.md`,
  "Workers"). The runner reads `officeCloud` and the owner's consent first (a draft is not an external write, so
  `officeExternalWrites` is not read), then the shop and the message a reply names, and creates nothing for a job that
  cannot run. Each job gets a task of its own in the shop's index, so export and deletion find it, and an attempt for
  the member asked, which the log names the operator as starting. The route waits for the job and answers how it ended.
- **Permissions.** Before anything else in the attempt, `@manut/member-grants`' `decide` answers for the member, the
  job's capability (`reply_customers`, `draft_posts` or `draft_books`) and, for a reply, the shop's connection the
  customer wrote to:
  - `not_my_job`: the member reports a `handoffNote` agent event (`{ from, to, job }`, the canvas's "Passed to Ton"),
    ends its attempt done, and the member whose job it is gets an attempt of its own on the same task, which the log
    names the system as starting. A job is passed on once at most.
  - `not_connected`: the attempt ends failed with the reason `not_connected`, before any model is called.
  - `draft_only` (practice mode: the first three days of a connection, since nothing records an owner ending practice
    early yet) and `ask` (after practice): the reply is drafted with what sending it would take
    (`send: { answer, kind: "reply" }`), and nothing is asked. It reaches a customer only if an operator proposes it
    through the pilot's reply flow and the owner approves it on the link.
  - `allowed`: Pim's post and Ton's summary, which stay in the app.
- **Memory.** `@manut/agent-prompts`' `buildRequest` builds the request from the shop's name, the facts the owner's
  own data says or the owner confirmed (`usableFacts` in `apps/api/src/memory.ts`; a fact still waiting is never read),
  and the job. A customer's words go in the messages only, never the system prompt. Nam reads only the message it
  answers: the earlier turns need the shop's own replies with them, which live on the pilot's task.
- **Cost.** One call through the port's `callModel`: the gateway, metered against the shop's cap, with
  `claude-haiku-5-5` and at most 600 output tokens for a reply or a summary and 1,200 for a post. Past the cap the
  control plane ends the attempt (`budget`). Ton with no sales or flags for the day says so ("No sales were recorded
  on 2026-11-22.") and calls no model.
- **Events and the draft.** Each attempt reports `turnStarted`, `spend` after the call, and `turnCompleted` (failed
  with the reason as its `error` when it fails), and keeps its result with `draft`. The words live in the draft only,
  never in an event or the audit log.
- **Audit.** Metadata only: each attempt's start, by the operator or, after a handover, the system, and its end with
  the reason. Tests show that no customer's words, draft or connection secret reach an entry.
- **Tests** (`apps/api/test/workers.test.ts`, in workerd against the real objects): each member's job end to end,
  only confirmed facts reaching the model, a customer's words kept out of the system prompt, practice mode and after
  it asking nothing, both handovers, `not_connected`, budget exhaustion, Ton with no sales, the kill switch and
  missing consent at the runner and the route, the route's checks, and the audit log holding no secret or customer
  text.
