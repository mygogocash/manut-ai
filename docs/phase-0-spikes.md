# Phase 0: the three spikes, answered (23 Nov 2026)

The roadmap's Phase 0 asked three questions before the platform is built: how to drive the DeepSeek Harness,
whether LangGraph.js can pause and resume for approvals, and what a worker adapter looks like. Its gate is that
both spikes are answered. Neither blocks the pilot, which people run. This note answers all three from code
already in this repository; the third is a draft for Phase 2 to build against.

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

## 3. The worker adapter contract (draft)

This is how a worker plugs into the control plane. A worker is one of Buddy's team members running in the cloud
(Phase 4), a person in the pilot, or a coding agent on the owner's computer.

- **Job.** The control plane gives a worker one attempt at a task: the tenant, the task id, the attempt (its
  fencing stamp, `Stamp` in `packages/approval-core`), the goal, the grants the task allows, a spending cap in
  satang for the attempt, and a deadline.
- **Events.** The worker reports what it does as `packages/agent-events` events: turns, text, tool calls and
  results, coding, research and documents. The timeline reducer builds every view from them, and unknown kinds
  are kept, not dropped.
- **Asking.** Before anything public, costly or irreversible, the worker stops and opens an approval request
  naming the exact action. It is an approval-core `NewApprovalRequest`, of kind `message`, `reply`, `money`,
  `public_post`, `payment_confirmation` or `command`, stamped with its attempt. The control plane lets the right
  role decide (`mayDecide`), settles it once, and resumes the worker with the `Decision`. A decision for an
  attempt that has ended is refused (`bindingHolds`).
- **Effects.** A worker never performs an external write itself. It proposes the action, and the broker
  dispatches it once with the vault's credentials, so the worker never holds a secret.
- **Cost.** Every model call goes through the model gateway (Phase 2), which meters satang per shop and
  refuses past the cap. A refusal ends the attempt with the reason `budget`.
- **Ending.** An attempt ends done, failed (with a reason) or cancelled. An attempt that stops reporting is
  ended, and its open approval requests are superseded (`attempt_ended`).
- **The Phase 2 gate** drives this contract with a deterministic stand-in worker: scripted events, one
  approval, a decision, and the effect dispatched once.
