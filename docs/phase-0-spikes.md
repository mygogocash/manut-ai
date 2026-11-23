# Phase 0: the three spikes, answered (23 Nov 2026)

The roadmap's Phase 0 asked three questions before the platform is built: how to drive the DeepSeek Harness,
whether LangGraph.js can pause and resume for approvals, and what a worker adapter looks like. Its gate is that
both spikes are answered. Neither blocks the pilot, which people run. This note answers all three from code
already in this repository. The third began as a draft for Phase 2 and is now built and tested (section 3).

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
  `outcome` and `finish`, bound to that one attempt. The port keeps the environment and has no method that returns a
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
- **Audit.** Every step is written to the shop's audit log (`docs/pilot-api.md`, "Audit log"): the attempt's start
  and end, each request, decision (refusals included) and superseded request, and each dispatch with its outcome.
- **The Phase 2 gate** drives this contract with the stand-in worker, in real workerd against the real objects:
  scripted agent events with an unknown kind, one model call through the gateway's stand-in provider, one approval,
  the owner's decision, and the write sent once with the vault's credential to a provider whose fetch is a stub. It
  also covers a helper refused for a command, a second decision refused, a decision after the attempt ended refused,
  budget exhaustion, a send retried after a crash before and after it began, a silent worker ended and its request
  superseded, a cancelled attempt, the switches and consent, and a target no grant covers.

Not built yet: a route or queue that hands jobs to real workers (Phase 4), a schedule for the sweep, a cap per
attempt, and pausing an attempt's deadline while it waits for a person, so an owner who takes longer than the
attempt's deadline to answer finds the request superseded.
