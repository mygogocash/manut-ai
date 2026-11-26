# Several agents on one job (item 102)

The design for plan item 102 (`docs/plan.md`; `docs/t3code-parity.md`, "Orchestration", group 3 of its order: "must be
designed first because it can act for the person"). Status on 27 Nov 2026: design, with slice 102a built (Ask several agents: the + menu row, its panel, one send starting one lane for each row, the job saved with each session and its row in the Lanes band; see "Phases and slices"). The rest is not built. It covers three
things:

1. **Ask several agents.** One message from the person starts lanes on different agents and models side by side, and their
   answers are gathered in one place.
2. **Helper lanes.** A lane's agent (the lead) asks for helper lanes that work in parallel, each in its own copy of the
   lead's work, and their work lands back in the lead's lane one at a time; work that cannot land is kept as a patch.
3. **Chats that reach other chats.** An agent opens, messages or reads another chat, as the fork's thread cards do.

The decisions are in `docs/decisions/102-several-agents.md`. The slices proposed for the plan are at the end; the lead
adds them to `docs/plan.md`.

## The promise this design keeps

Every agent this design starts is an ordinary lane, started in the mode in which its agent asks, and every ask any of
them makes is a card the person answers through the one ask path (`settleApproval`, `packages/approval-core`; "How an ask
is read" in `docs/code-editor.md`). No agent answers, allows, denies or dismisses another agent's ask or question, and
nothing an agent writes starts another agent, sends a message to another chat or reads one until the person pressed a
button that named it.

## What is there today (read on 27 Nov 2026)

- **Lanes.** A coding chat started from Chat with Kit works on a branch and in a folder of its own (`src-tauri/src/lane.rs`,
  `code/laneBranch.ts`, `sessions/sessions.ts`), made from the branch the developer's folder is on, with the committed tree
  only. Several lanes already run at once, and no cap on how many was found. Each starts with its mode named on its command line, Ask
  unless the person picked another (item 89, `agent_chat::start_mode`; `ASK_MODE` in `sessions/controls.ts`), and an agent
  whose own settings would skip asks does not start (items 101a, 101b).
- **Asks.** A lane's asks are cards (`chat/cards/Cards.slot.tsx`) settled through `settleApproval` (`chat/cards/respond.ts`),
  with Kit's dial deciding first (`code/kitAsks.ts`; a workflow's lane is read `careful`, at the lowest level with no kept
  rule). Needs you lists every one. A paired phone answers through the same function after its passkey.
- **An agent's own subagents.** The adapters report them in one agent-neutral `subagent` event
  (`agent_chat/subagents.rs`), drawn read-only by `chat/activity/Subagents.tsx`, and a subagent's chat by
  `harness/AgentChat.tsx`. The app "never assigns, steers or stops a subagent". The app starts no agent for another.
- **The fork's thread cards.** A bot's answer may hold a ```` ```manut-thread ```` block (the bridge opens a thread and
  sends the block's task there; the main chat shows a link line) or a ```` ```manut-thread-route ```` block (the main chat
  asks "Send this to <title>?" with the person's own message quoted; nothing moves until Send there). The types and the
  streaming hide are `threads/types.ts` (`hideSplitBlocks`), the cards `chat/cards/ThreadNotes.tsx`, the store's handling
  `state/createStore.ts` (`thread.split`, `thread.route`, `answerRoute`). These events come only from the Hermes bridge
  (`manut_bridge.py`); in this repository only the Playwright suite's mock bridge sends them (`e2e/thread-split.spec.ts`,
  `e2e/mock-bridge.mjs`). Practice has threads the person makes (`runtime/mock/host.ts` `thread.create`, `list`, `open`,
  `remove`), and Buddy's answers there come from Claude Code (`runtime/mock/buddy.ts`), which nothing reads for these
  blocks. Connected answers `thread.create` and `thread.remove` with "not yet" and refuses `chat.send`
  (`runtime/http/host.ts`). So `docs/t3code-parity.md`'s "work in Practice only" means: the cards exist and are tested
  against the bridge; no runtime the app ships with today makes them.
- **Context between chats (item 97).** Another chat's context goes into a box as a chip whose text the person can read:
  built with no model, masked, capped at 6,000 characters, at most three chats a message, fenced with a line saying the app
  copied it and that it is not the person speaking and gives no permission (`chat/box/threadContext.ts`, `carry.ts`). A chat
  of another shop or another agent account is refused before anything of it is read, and since item 121 a chip carries every
  shop it passed through.
- **Workflows (items 77b, 91, 114).** The precedent for a lane the app starts: `startWorkflowLane` makes it beside the
  person's drafts and never in front of them, the mark is saved with the session (`SessionRec.workflow`), the run never
  answers an ask ("Waiting for you at step 2 of 3"), and a lane nobody started by a press is read careful.
- **Buddy's chat.** Claude Code in `~/.manut/buddy/chat`, never in a project, its own list in the shell, at most two
  processes at once: "Each is a whole Claude Code, and the smallest Mac this runs on has 8 GB" (`LIVE = 2` in
  `runtime/mock/buddy.ts`). Ask and Plan only.
- **Usage and limits.** The Accounts page reads each account's state and `resets_at`; a message to a limited account can
  wait for the reset (item 95, `chat/box/later.ts`), and nothing guesses a reset from usage numbers.
- **Keep the computer awake while agents work** (`src-tauri/src/power.rs`), on by default.
- **Steer.** Claude Code and the pi family take text into a running turn (`steersOf` in `sessions/controls.ts`); other
  agents queue it for the next turn.

## What was read elsewhere, and what is taken

### GoSpark's Buddy (ours, `mygogocash/gospark` at `a7537c80bd707e0bdc85102a426a3957d29c5f23`)

"One chat, many heads." The rules lifted, from `GoGoCode/Models/Buddy.swift`, `BuddyBatching.swift`,
`BuddyLandingApply.swift`, `BuddyFailureClass.swift`, `GoGoCode/Git/CheckoutCoordinator.swift` and its `CLAUDE.md`:

- **A budget per head** (`BuddyBudget`): a nudge at 24 tool calls with no file changed, a word to wrap up at 50 calls or 12
  minutes, a stop at 90 calls or 20 minutes, then 3 minutes for its report, with the three notes' words. A head's watchdog
  leaves it alone while an approval or a question of it is open (`ThreadRuntime.isAwaitingUser`). A head stopped by its
  budget is marked so (`budgetExhausted`), never read as a finished task.
- **How many at once** (`BuddyPair`, `BuddyHeadCap`): 4 by default, 1 to 8. For a Claude lead the cap also holds Claude
  Code's own concurrent subagents, "which keeps an 8 GB Mac responsive".
- **Rounds** (`BuddyBatchQueue`): a round's reports hand over together, once every head is back and the lead is idle; at
  most twice the hard cap waiting in a round; at most two rounds for one request of the person's
  (`maxDelegationRounds`); two heads in a row that never got to try trip a breaker that drops the round's waiting heads
  (`HeadFailureClass.infra`).
- **Landing** (`BuddyCheckoutGate`, `BuddyLand.applyHeadWork`): one landing at a time per checkout; the head's change
  since its base tree, binary included, build output cut out; a patch aimed at another repository or naming files outside
  the project is kept without being tried (`foreignTarget`); `git apply` three-way, conflicts counted as landed and named;
  a patch that will not apply kept as a file, owner-read-only (0600), under `~/.gospark/patches`.
- **Reports** (`BuddyReport`, `fallbackReportNote`, `closedPolicy`): each head's words, how its work landed, whether its
  budget stopped it, sent to the lead as its next message with the team's status, and whether one more round is open.
- **The delegation block parser** (`delegationOutcome`, `streamingOutcome`): one fenced block per head, a block that
  cannot be read told apart from no block, and a block still open while the lead writes.
- **The heads' brief** (`workerPrompt`, `workplaceRules`): work in your own copy; never commit, branch, stash, push or make
  worktrees; check with the narrowest test; report what you changed and how you checked it.

What Manut AI does differently: GoSpark sends heads out without a question once Buddy is on, runs them in the lead's
mode, and lets them land while the lead works. Here every round starts from a card, helpers start in the asking mode, and a
landing waits for the lead to be idle (rules R4, R3 and R8 below).

### T3 Code (MIT, `pingdotgg/t3code` at `56196d892fbc015d3fc61bfcd07255f55b940b67`)

Read in `apps/server/src/mcp/` and `packages/contracts/src/orchestratorMcp.ts`. T3 Code gives each thread's agent an MCP
server of its own with tools to start and steer other threads:

- `delegate_task` starts a child agent on any provider and model from the catalog (`target.providerInstanceId`, `model`,
  `options`), in the parent's checkout or a new worktree (`isolation: "worktree"`), with no parent history; its completion
  wakes the parent. `task_status`, `task_cancel` follow it.
- `t3_thread_list`, `t3_thread_read`, `t3_thread_send` (start, steer, queue or restart another thread), `t3_thread_wait`,
  `t3_thread_interrupt`, `create_threads`, `t3_thread_update` reach any thread of the environment.
- **A child is never broader than its parent** (`delegatedTaskModes.ts`, `resolveRuntimeMode`): a requested mode above the
  parent's is refused; an inherited one the target does not offer steps down. **An agent's own mode pick is refused below
  full access** (`refuseAgentModePick`), because the app cannot rank it. `t3_thread_send` refuses a target that runs in
  broader modes than the caller (`threadAccess.ts`, `assertTargetWithinLimits`).
- **Approvals are not an agent's to give**: `pendingApproval` "grants no approval rights", and `t3_pending_request`
  "cannot approve a permission request". A parent may answer a child's question through it, though.

Taken: the mode ceiling (a helper is never broader than its lead), refusing a mode the agent names, the verbs (start, read,
send, wait) as the shape item 103's tools will take. Not taken: a parent answering a child's question, reaching any thread
without the person, and starting children without a card.

### Orca (MIT, `stablyai/orca` at `31c0c26daa69af1abacb0f43a6dfe518790a9b35`)

Read in `docs/site/content/docs/cli/orchestration.mdx` and `src/shared/rpc-contract/orchestration/`. A Run holds Tasks; a
Dispatch is one attempt of a Task on a worker; `worker_done` is sent exactly once and names both the task and the dispatch,
"so stale retries cannot complete the wrong dispatch"; silence or a timeout is "no proof of exit"; mail is never typed
into an agent's input. When a worker stops at a permission prompt, "only a person can allow it", the coordinator may deny
it with a reason, and a setting ("Let coordinators approve worker permission prompts") lets a coordinator allow it too.

Taken: a helper's report bound to the round and the helper that sent it (a late report of a stopped helper never fills a
later round), and a stop that is believed only when the process is gone. Not taken: a coordinator denying or allowing a
worker's prompt, under any setting.

## Words

- **Job**: the lanes one message started (Ask several), or a lead and its helper lanes. Saved with each lane's session.
- **Lead lane**: the lane whose agent asked for helpers. **Helper lane**: a lane started for a lead. The app says "helper
  lane", never "helper" alone, because approval-core's `helper` is a person who helps at a shop, and a card's "decided by"
  line must never be read as an agent.
- **Round**: the helper lanes one Start helpers card started. **Landing**: a helper lane's work carried into its lead's
  folder. **Kept patch**: a landing that could not apply, saved as a file. **Report**: what the lead hears back.

## What a person sees

### 1. Ask several agents

The + menu (the Code page's +, and New lane in the Lanes band, which opens it) gains one row after the Chat with Kit rows:
**Ask several agents…**, offered when two or more chat rows can start (two agents, or one agent with two models). It opens
a panel under the folder chip:

- Up to three rows, each an agent from the Chat with Kit list with the account it runs as and that account's state as
  Settings › Providers › Accounts words it ("Limited until 14:00" cannot be picked), its model and its effort (what that
  agent listed; before it listed any, its default).
- One message box: the chat box of item 80 (text, files, a folder by path), with no Mention.
- A line for this Mac's limit when the picks pass it: "This Mac runs 2 at once. The third starts when one finishes."

Send starts one lane per row, each exactly as Chat with Kit starts one with that first message: a branch and a folder of
its own from the developer's folder, its agent in its Ask mode. The lanes are one job. The Lanes band shows the job as one
row ("3 agents: Add the PromptPay QR", each agent's mark with its state tag), which opens the side-by-side view, and each
lane is still its own row under it.

### 2. Watching them side by side

The job view has a column for each lane (three side by side at 1280 wide; tabs, each with its state tag, at 900 or
narrower):

- On top: the agent's mark, its model and its branch. Under it the lane's state tag as `laneStatus` reads it: Working with
  the real step and its time, Needs you, Checked, Tests failed, Failed.
- The lane's chat, compact and read-only: its words and steps as `harness/AgentChat.tsx` draws a subagent's.
- An ask card when one waits: the same card as in the lane's own chat, the same approval. Answered in either place, it is
  settled once and the other shows it decided.
- Open lane (the lane as any lane, with its pane and its box), and Stop, which stops that lane's turn. Stop all stops every
  turn of the job.

There is no box in the view that writes to every lane. **Ask them again** opens the panel with the same rows and sends the
next message to each lane's own chat, queued behind a running turn as item 95 queues.

### 3. The gathered answers

Once every lane has ended its turn, under the columns: "Gathered: 3 of 3 answered", and for each lane its last answer
whole (scrolling), the files it changed with their counts (from `lane_diff`), and its tests as the lane read them. A lane
that failed shows its words. While a lane waits on an ask the line says "2 of 3 answered" with Answer.

**Compare in a chat…** opens item 97's Bring context picker with the job's lanes ticked; the chat picked gets one chip
per lane in its box, unsent, so the person can ask one agent to compare. The app picks no winner and merges nothing:
keeping one is the person's own step with what is there (Put up for review on the lane they like, Continue with… on its
agent chip, Remove on the others' folders).

### 4. Helper lanes a lane asks for

Off until the person turns on **Helpers** in a lane's box (one switch for that chat, beside the approval level). While it
is on, the app tells the lane's agent how to ask for helper lanes (GoSpark's `fallbackPolicy`, adapted, handed over the
way item 93 hands over a project's instructions), and the agent may end an answer with one block per helper:

````
```manut-helpers
{"title": "Tests for the QR builder", "brief": "Complete instructions: the files, what to change, how to check it.", "agent": "codex", "model": "gpt-6.1", "effort": "high"}
```
````

The blocks are hidden while the answer streams, as the fork's thread blocks are. When the turn ends, one card:

> **Kit asks for 3 helper lanes**
>
> Helper 1 · Codex · gpt-6.1 · high: Tests for the QR builder. Show the whole brief
> Helper 2 · Claude Code (the lead's model): The receipt's Thai date
> Helper 3 · Codex: not signed in, will not start
>
> Each works in its own copy of this lane's work as it is now. Nothing here changes until a helper's work lands, one at a
> time, after it reports. Each has up to 20 minutes and 90 steps; time waiting for you does not count. This Mac runs 2 at
> once. When they are done, Kit gets their reports and carries on.
>
> **Start helpers** · Not now

The brief is shown whole, as a workflow's steps are. A model the agent did not list shows as "the agent's default (Kit
asked for <name>, which it does not list)". The card is an approval of the lead lane, settled once. Not now starts nothing,
and the lead's chat says so in a line.

After Start helpers:

- The lead's chat has a **Helpers** card, one row per helper lane in the form of the Subagents card (the agent's mark, the
  title, its state, its current step, its time; "waiting for you" in amber with Answer while its ask waits), with Stop on
  each row and Stop all. Only the person can press them. A link line per helper ("→ Helper 1: Tests for the QR builder",
  the fork's `ThreadLinkLine`) opens its chat.
- The Lanes band lists each helper lane under its lead, indented, "Helper of Add the PromptPay QR".
- A helper lane's asks are cards in its own chat, on its row and in Needs you, named "Helper 1 of Add the PromptPay QR
  (Codex) asks: …". The person answers them there, and only there.
- The lead is idle meanwhile (its turn ended with the request). The person may write to it as usual; landings then wait
  for that turn to end.

As each helper lane ends, its row says how: "Landed 3 files", "Landed 2 files, 1 with conflicts: src/qr.ts", "Changed
nothing", "Kept as a patch: it would not apply" (with Show patch), "Stopped by its budget", or "Failed: <its words>". Under
a landed row, **Take back this landing** puts the lead's folder back as it was before that landing, while nothing changed
there since. When the whole round is back and landed, the lead gets one message from the app with the reports and carries
on; its chat shows a quiet line, "Helpers reported to Kit", with Show what was sent.

### 5. What an agent may do to other chats

| What | Allowed | How |
| --- | --- | --- |
| Hear its own helper lanes' reports | Yes | The person's Start helpers covers the round's reports (R9) |
| Read another chat | Only after the person's yes | A card "Kit asks to read <title>", showing exactly the text that would go (item 97's), Let Kit read or No; or the person brings it themselves, as today |
| Send words to another chat | Only after the person's yes | A card "Send this to <title>?" with the words whole (the fork's route card), Send there or Keep here |
| Open a new lane with a task | Only after the person's yes | A card with the title, the brief whole and the agent, Start lane or Not now; it is an ordinary lane, not a helper: nothing of it lands anywhere |
| Name a chat | Only one the person put in front of it | The chats listed under its box as "Kit may reach" (added by the person, removable); an agent cannot list chats |
| Reach a chat of another shop or another agent account | Never | Refused before anything of it is read (item 97, item 121) |
| Answer, allow, deny or dismiss another chat's ask or question | Never | There is no verb for it (R2) |
| Stop, rename, archive or delete another chat, or change its mode, model or level | Never | There is no verb for it |

## The rules

Each rule says why, how it is held, and the test that proves it (the slice that adds the test is in brackets).

**R1. Every agent here is a lane.** Ask several's lanes and helper lanes start through the code that starts a person's
lane (`draftChat` and `start` in `sessions/sessions.ts`, or `startWorkflowLane`'s form for a lane the app makes), each
with a branch and a folder of its own; none runs in the developer's folder or in another lane's. A lead must itself be a
lane: a chat in the developer's own folder (no lane could be made), Buddy's chat and a terminal offer no Helpers switch,
because a landing there would write into the developer's own files. *Test:* every `chat_start` of a job names a lane
folder the stand-in shell made, and a chat with no lane of its own never shows the switch. [102a, 102f]

**R2. Every helper's ask reaches the person, and no agent answers one.** A helper lane's permission asks and questions are
its own cards, in its chat, on its row in the Helpers card and the job view, and in Needs you: one approval each, settled
once through `settleApproval`, with Kit's dial deciding first as for every lane. `settleApproval` is called only from a
person's press (a card's buttons, Home's Approve, a paired phone after its passkey). Nothing between agents (the blocks
now, item 103's tools later) has a verb that answers, allows, denies, dismisses or stops an ask, and a message whose words
say "allow" or "approved" is only words. This is stricter than T3 Code, where a parent may answer a child's question, and
than Orca, where a coordinator may deny a prompt and, with a setting, allow it. *Tests:* a helper's ask is pending in Needs
you after its lead's next turn ends, whatever that turn's text says; a lead's answer holding a block or JSON that names
the ask's id settles nothing; pressing Allow on the Helpers row and then in Needs you settles it once and the second press
shows it decided. [102h]

**R3. No helper in a mode that skips asks.** Each helper lane starts in its agent's Ask mode, named on its command line
(item 89), whatever mode the lead runs in, and the person cannot switch a helper to another mode while it runs: its box
shows "Ask, set by the job". An agent whose own settings would skip asks does not start (the refusals of items 101a and
101b), and its row says why. A helper is never broader than its lead (T3 Code's ceiling), and here it is narrower: its
agent asks for everything, and Kit's dial reads those asks at the project's level, as for any lane of the project; a lead
read careful (a workflow's lane) has no Helpers switch at all. A block can name an agent, a model and an effort, never a
mode: a block with any key outside its list is refused whole, as a workflow file's unknown field is. *Tests:* every helper
`chat_start` carries `ASK_MODE`'s value for its agent, also when the lead runs in Accept edits; a block with
`"mode": "bypassPermissions"`, `"permission"` or `"approve"` starts nothing and the card says it could not be read.
[102e, 102h]

**R4. Starting agents is the person's press.** Ask several is the person's own send. Helper lanes start only from Start
helpers on their round's card. A second round needs a second card, and there are at most two rounds for one message of
the person's (GoSpark's `maxDelegationRounds`); after that the lead is told to finish by itself (GoSpark's
`closedPolicy`). A helper lane cannot ask for helpers: its blocks are shown as text with a line that only a lead may. A
workflow's lane, Buddy's chat and a chat with Helpers off never show the card. *Tests:* with the card unanswered, declined
or refused, the stand-in shell sees no `chat_start`; a second press of Start helpers is refused as already decided; a
third round's blocks show no card. [102e]

**R5. A budget for each helper lane.** GoSpark's numbers, counted per helper:

| Limit | What happens |
| --- | --- |
| 24 steps with no file changed | A nudge: report findings now, or act on what you know |
| 50 steps, or 12 minutes | A word to wrap up: finish the smallest correct version and report |
| 90 steps, or 20 minutes | The app stops the turn (the chat's own Stop), then sends one message: the budget is spent, report now |
| 3 minutes after that message | That turn is stopped too. The report is the helper's last words, marked "stopped by its budget" for the lead and on its row |

A step is a tool call of the helper's chat or of its own subagents (`tool.start` and `subagent` events). The clock and the
count stand still while an ask or a question of that helper waits on the person, so a slow answer never costs a helper its
work, and a stop never fires while an ask waits: the budget never answers or withdraws an ask. The nudge and the word to
wrap up go as a steer where the agent takes one (`steersOf`); other agents get only the stop. The person's Stop on a row is
not a budget: it stops at once and the report says the person stopped it. *Tests:* with an ask pending for 30 minutes of
the stand-in clock, no note is sent and no stop fires; at 90 steps exactly one stop and one final message go out; a report
after a budget stop is marked so. [102d, 102h]

**R6. Trouble that is not the task stops the round.** Two helper lanes in a row that never got to try (the agent did not
start, was not signed in, its account was limited, its folder was refused, it ended at once) drop the round's helpers
still waiting, and the report says how many and why (GoSpark's breaker, `HeadFailureClass.infra`). A helper whose account
is limited is not started at all; its row names the reset time and offers Start again. *Test:* two refused starts drop the
waiting ones, and the report counts them. [102d]

**R7. How many at once on this Mac.** Helper lanes and Ask several's lanes, across every job, run at most 2 at once when
the Mac has 8 GB of memory or less, 3 up to 16 GB, and 4 above, read once by the shell (`hw.memsize`, with no program run).
Settings may lower it and never raise it above 4. The rest wait in order, at most 8 waiting in one round (twice the
ceiling, as GoSpark caps its queue). The person's own lanes, terminals and Buddy's chat never wait for a helper and are
not counted. A helper lane that has reported and is idle has its agent process ended, as Buddy closes its idle processes;
its chat and folder stay, and a message to it starts it again. Keep the computer awake covers a running helper as any
running turn. Why these numbers: Buddy keeps two whole Claude Code processes on 8 GB (`LIVE = 2`), each helper is a whole
agent CLI plus what it runs (an install, a test run), GoSpark's default of 4 is the most here, and this Mac's own rule for
building the app is four helpers at a time. *Test:* with the cap at 2, a round of 4 starts 2, starts the third when one
ends, and never runs 3; the person's own new lane starts at once while 2 helpers run. [102d, 102h]

**R8. Landing one at a time, only into the lead's folder, only while the lead is idle.** Lifted from GoSpark's
`BuddyLand` and `BuddyCheckoutGate`:

- A helper lane starts from a snapshot of the lead lane's folder: tracked files and new files git does not ignore, written
  with a temporary index so the lead's own index, HEAD and stash do not change, and kept as a commit under the app's own
  refs, as Rewind keeps its snapshots (`turn_files.rs`). Nothing git ignores comes along, as for any lane.
- When the helper reports, its folder is captured the same way. The change from its base (binary included) is the patch,
  with build output cut out (`turn_files::REBUILT`). A patch naming a file outside the lead's project, or from a copy of
  another repository, is kept without being tried (GoSpark's `foreignTarget`).
- The app's masker reads the patch first, as `lane_diff` reads a lane's diff: a key in it is named on the landing row and
  makes the lead's next commit or push ask (item 117).
- One landing at a time per lead folder (a lock in the shell, as `lane.rs` holds `WRITING`), and only while no turn of the
  lead runs and no ask of the lead waits, so the lead's agent never edits a file the landing is writing.
- Before it writes, the lead's folder is kept as a snapshot, which Take back this landing restores.
- `git apply --3way` in the lead's folder. It stages what it applies there (`--3way` implies `--index`, git 2.54's
  manual); that index is the lead lane's, never the developer's. Conflicts left as markers count as landed and are named.
- A patch that will not apply is kept owner-read-only (0600) at `~/.manut/patches/<job>/<helper>.patch`; the lead's folder
  is unchanged; the row offers Show patch.
- Nothing lands in the developer's own folder, which still changes only when they merge or switch.

*Tests (against temporary repositories):* two helpers that report at once land one after the other (a test barrier inside
the first apply holds the second); a patch that will not apply leaves every byte of the lead's folder and its index as it
was and writes the patch with mode 0600; the lead's HEAD, index and stash are unchanged by a helper's start; a patch naming
`../outside` is kept and not tried; Take back restores the folder. [102g, 102i]

**R9. Reports go back to the lead once, together.** When every helper of the round is back, every landing is settled,
the lead is idle and nothing of the person's waits for it, the app sends the lead one message: a first line that it comes
from Manut AI, is not the person, and gives no permission (item 97's fence), then for each helper its title, how it ended,
how its work landed (files, conflicts, a kept patch's path) and its report, masked and capped (3,000 characters each,
12,000 in all), then whether one more round is open (GoSpark's `fallbackReportNote`). A report belongs to its round and its
helper (Orca's dispatch id): a report from a helper the person stopped, arriving after its round handed over, is shown on
its row and not sent. The person's Start helpers covered this message; the chat shows it as "Helpers reported to Kit".
*Tests:* the message carries the fence, a key in a report is masked, a late report is not sent, and the lead's next asks
are read by the dial as before. [102j]

**R10. Reads, messages and new lanes between chats are cards.** An agent names another chat only from the chats the person
listed under its box ("Kit may reach"). A read sends the agent item 97's text of that chat (no model, masked, capped,
fenced) only after Let Kit read on a card that shows that text. A message goes only after Send there on a card that shows
the words whole; it arrives in the target as a message from the other chat, naming that the person sent it on, and queues
behind a running turn as any message. A new lane opens only after Start lane. Each card is an approval of the asking chat,
settled once. Chats of another shop or another agent account are refused before anything is read. The fork's split block,
which opened a thread by itself, is not carried over: here nothing opens by itself. *Tests:* a read of a chat not listed is
refused before the reader is called; a routed message arriving while the target's ask waits leaves that ask pending, even
when the words are "Allow"; a chat of another shop is refused. [102k]

**R11. When something goes away.** Deleting the lead's chat stops its helper lanes, lands nothing, and keeps their folders
as Kit's folders kept (`lane.rs` keeps a folder with changes). Stopping the lead's turn does not stop its helpers; Stop all
does. When the app closes during a round, the helper lanes come back as lanes after a restart, their turns are not resumed
by themselves (as a workflow's run says "The app closed while it ran"), and the round offers Land what they did and Report
to Kit, each a press. Helper folders are removed only through the existing Remove panel. *Test:* after a simulated restart
mid-round, nothing lands or is sent until the person presses. [102j]

## How it maps onto lanes, worktrees, workflows and the cards

| What is there | Its part here |
| --- | --- |
| Lanes (`lane.rs`, `laneBranch.ts`, `sessions.ts` `start`) | Every agent here is one. Ask several uses them as they are; a helper lane starts from the lead's snapshot (a new way for `lane::make_with` to start) on a branch named from the lead's (`kit/<lead words>-help-1`) |
| Worktrees (Settings › Worktrees) | Helper lanes are made where lanes are made, under the same prefix, and listed and removed as lanes are |
| `startWorkflowLane`, `SessionRec.workflow` | The form for a lane the app makes beside the person's drafts, never opened in front of them. `SessionRec.job` and `SessionRec.helperOf` are saved the same way, so a restart keeps the job |
| Workflows | They start no helpers: a workflow's lane has no Helpers switch, and Ask several is not a workflow step in this design |
| Kit's dial (`kitAsks.ts`, `AskContext`) | Reads every helper's asks at the project's level, as for any lane; a careful lane (`careful`) offers no helpers |
| `settleApproval`, approval-core | The only way any ask here settles. The Start helpers card and the cards of R10 are approvals of the asking chat |
| The fork's thread cards (`ThreadNotes.tsx`, `threads/types.ts`) | The link line for each helper lane; the route card's form for a message to another chat; `hideSplitBlocks`'s line walk for hiding the new blocks while they stream |
| The Subagents card, `harness/AgentChat.tsx` | The Helpers card's rows (with the person's Stop added); the job view's compact columns |
| Item 97 (`threadContext.ts`, `carry.ts`) | Compare in a chat; a read's text; the fence on the reports |
| `turn_files.rs` | The snapshot a helper starts from, the snapshot before a landing, Take back |
| `lane_diff.rs` and the masker | Keys in a helper's patch |
| Needs you | Every helper ask, named with its helper and its job |
| Buddy's chat | No helpers; its two processes are the precedent for R7 |
| Accounts (limits) | A helper on a limited account is not started; its row names the reset |
| `power.rs` | Keeps the Mac awake while a helper's turn runs |
| A paired phone | Answers a helper's ask as any ask. Start helpers is not one of the phone's requests |
| Connected runtime | Not in the first three phases (see Phase 4) |
| Item 103 (the app as an MCP server) | Will expose these same verbs as tools, under these same rules and cards |

## Phases and slices

Each slice is one helper's day of work, with its tests and the safety test that proves its rule. Pure rules come first so
the screens are built on tested ground.

### Phase 1: several agents from one message (no agent starts anything)

- **102a. Ask several: the job and its lanes. Built 27 Nov 2026** (`src/jobs/ask.ts`, `choices.ts`, `AskSeveralPanel.tsx`, `startJob` in `sessions/sessions.ts`, `jobGroups` in `code/Lanes.tsx`; decisions in `docs/decisions/102a-ask-several.md`). The + menu row and its panel (agents, models, efforts, accounts and their
  limit state, the shared box), one send starting one lane per row through `start`, `SessionRec.job` saved and read back,
  the job's row in the Lanes band. Tests: `newMenu.test.ts` (when the row shows), a sessions store test (one send, three
  `chat_start`s, each with its agent's Ask mode, one job), a restart test. Safety test: each lane's `chat_start` names its
  own lane folder and `ASK_MODE`'s value, and a limited account's row cannot be sent.
  What changed from the design: the panel replaces the menu as a second step and shows the folder chip read-only (Back to
  change it); models and efforts come from what each agent last listed, kept on this computer, so a fresh Mac offers
  "Agent's own" until a lane of that agent has run; the job's row is closed until pressed and groups only two or more lanes;
  there is no "This Mac runs 2 at once" line and the lanes start one after the other until 102d and 102h give the cap; a
  folder that is not a repository starts nothing.
- **102b. The side-by-side view.** Columns at wide, tabs at narrow, each with its state tag, compact chat, ask card, Open
  lane and Stop; Stop all; Ask them again. Tests: the view's props-only component, an e2e spec on the stand-in agent
  (`e2e/several-agents.spec.ts`) with pictures at 1280 and 900, light and dark. Safety test: an ask answered in a column is
  shown decided in Needs you and in the lane's own chat, and a second press there is refused.
- **102c. The gathered answers.** The Gathered block, each answer whole, files and tests, Compare in a chat through item
  97's picker. Tests: `gathered.test.ts` (when a job counts as answered, a lane waiting on an ask), the e2e spec. Safety
  test: Compare in a chat only fills a box: no `chat.send` reaches the stand-in host.

### Phase 2: helper lanes

- **102d. The rules, pure.** `src/jobs/rules.ts`: GoSpark's `BuddyBatchQueue` (rounds, the waiting cap, hand-over when
  all are back, the breaker, two rounds), `BuddyBudget` (the steps, the clock, the pause while an ask waits) and the cap
  from memory (R7), ported with GoSpark's `BuddyBatchingTests`, `BuddyHeadCapTests` and `BuddyReportTests` as tables.
  Safety test: the budget clock does not move while an ask waits, and a round never hands over while any helper's ask
  waits.
  **Built 27 Nov 2026** (`src/jobs/rules.ts` and `rules.test.ts`; `docs/decisions/102d-helper-rules.md`). Plain data and pure
  functions with the time passed in. What changed from the design or was settled on the way: Settings' number only lowers
  the memory's (R7's "may lower it"), and memory the shell could not read counts as 8 GB; GoSpark's 60-second
  `answeredGrace` is kept, so a time stop (not the step stop) waits a minute after the person's last answer; a report for
  a round already handed over, or from a helper that never started in it, is not kept, and one sent again before the
  hand-over replaces the earlier; the breaker drops the waiting helpers itself and counts them on their round; the budget
  answers actions (nudge, wrap up, stop, the report's stop), and the notes' words are 102h's, through the dictionaries;
  GoSpark's `failureKindOf` fragments are ported for an agent's own failure words, while the runtime marks the troubles
  the app knows of itself. Not ported: GoSpark's unsealed rounds and company waves, and the message's words (102j).
- **102e. The helper blocks and the Start helpers card.** The block parser (GoSpark's `delegationOutcome` and
  `streamingOutcome`, with the fork's top-level fence walk), hidden while streaming; the card with every brief whole,
  settled once through approval-core; the Helpers switch in a lane's box; not offered in a workflow's lane, Buddy's chat or
  a chat with no lane; the lead's instructions when the switch is on. Tests: `helperBlocks.test.ts`, the card's
  component, the switch's absence where it does not belong. Safety tests: a block with an unknown key (`mode`, `approve`)
  is refused whole; an unanswered, declined or refused card starts no agent; a third round shows no card.
  **Built 27 Nov 2026** (`src/jobs/helperBlocks.ts`, `helperPolicy.ts`, `helperAsks.ts`, `leadLanes.ts`, `HelpersCard.tsx`,
  `HelpersSwitch.tsx`, their tests, and `e2e/helper-blocks.spec.ts`; `docs/decisions/102e-helper-blocks.md`). Nothing starts
  a helper lane yet: Start helpers settles the card once through approval-core, records the round with 102d's `openRound` and
  calls the sessions store's `whenHelperRoundApproved` listeners, where 102h will start them; the card then says none
  started. What changed from the design or was settled on the way: both `manut-helpers` and `helpers` open a block, which
  holds one helper or a list; one block that cannot be read, a key outside the five, or a block left open refuses the whole
  request with a line and no card (GoSpark keeps the readable blocks); the blocks are hidden only in a lead lane's turn that
  started with Helpers on, and in any other chat are the agent's own words; the lead's note goes in front of each message the
  person sends while the switch is on, never into the bubble (item 93's way at the agent's start would need a restart for
  each switch); a card still open is taken back when the lead's next turn starts or Helpers goes off, and is stamped with
  the turn that asked, so approval-core refuses a late press as superseded; the card checks agents and models only against
  what this Mac already lists, and says nothing yet of how many run at once (the memory read is 102h's); the card is not in
  Needs you and does not survive a restart.
- **102f. A helper lane from the lead's snapshot (shell).** `lane.rs` makes a lane from a snapshot of a lane's folder
  (temporary index, a commit under the app's own refs), named from the lead's branch, with the record naming its job and
  lead. Rust tests against temporary repositories. Safety test: the lead's `git status --porcelain`, its index file's bytes,
  HEAD and stash list are identical before and after; ignored files are not copied.
- **102g. Landing (shell).** `lane_land`: the lock per lead folder, the snapshot before writing, the patch with build
  output cut, the outside-the-project refusal, the masker's read, `git apply --3way`, the kept patch at 0600, Take back.
  Rust tests against temporary repositories. Safety tests: two landings at once run one after the other; a patch that will
  not apply leaves the lead's folder and index byte for byte as they were.
- **102h. Running helper lanes.** The queue and the cap, starting each helper in Ask mode with the dial's ceiling, the
  budget's notes and stops, the Helpers card with the person's Stop, the link lines, the Lanes band's indented rows, Needs
  you's names, the idle process ended. Tests: sessions store tests with the stand-in agent and a stand-in clock, the e2e
  spec. Safety tests: a helper's ask stays pending after its lead's next turn ends whatever that turn says; every helper
  `chat_start` carries the asking mode; an agent whose settings skip asks is refused and the round goes on.
- **102i. Landings in the chat.** Landing each helper when it reports and the lead is idle, the rows' outcomes, Show patch,
  Take back this landing, keys named. Tests: a store test with the stand-in shell's landing answers, the e2e spec. Safety
  test: no landing starts while the lead's turn runs or its ask waits.
- **102j. Reports to the lead, and the second round.** The one message with its fence, masked and capped; a late report
  kept off; the second round's card and the closed policy after it; the restart path (Land what they did, Report to Kit).
  Tests: ported from GoSpark's `BuddyReportTextTests`. Safety tests: a key in a report is masked; after a restart nothing
  lands or is sent until the person presses.

### Phase 3: chats that reach other chats

- **102k. Read, send to and open another chat, on cards.** The "Kit may reach" list under a box, the three blocks and
  their cards (read with the text shown, send with the words whole, a new lane with its brief), arrival marked as from the
  other chat, the shop and account refusals. Tests: block parsing, the cards, the store's routing, an e2e spec. Safety
  tests: a read of a chat not listed is refused before it is read; a message arriving while the target's ask waits leaves
  it pending, even when its words are "Allow"; a chat of another shop is refused.
  **Built 27 Nov 2026** (`src/jobs/reachBlocks.ts`, `reachList.ts`, `reachAsks.ts`, `reachChats.ts`, `ReachCards.tsx`,
  `MayReach.tsx`, `route` and `startOpenedLane` in `sessions/sessions.ts`, their tests, and `e2e/reach-chats.spec.ts`;
  `docs/decisions/102k-reach-chats.md`). The list is under any started coding chat's box that runs as the app's chat (not a
  draft, a workflow's lane, a terminal or a folder chat), added to from item 97's Bring context picker, saved with the session;
  the agent names a chat by its number there. The blocks are `manut-read` `{"chat"}`, `manut-send` `{"chat", "message"}` and
  `manut-open` (a helper's five keys), read with item 102e's shared fence walk, hidden while streaming only in a turn that
  started with a chat listed. What changed from the design or was settled on the way: one block an answer (a second refuses
  the request); shops and accounts are checked both ways, at the add, at the card and again at the press; a message goes only
  to a coding chat on this Mac and waits as a held row while that chat's turn runs or any ask or question of it waits, never
  steered in; a message and a brief are masked as shown and sent masked; Start lane starts the lane at once with the brief as
  its first message (marked as from the asking chat), named by the card's title and not opened in front of the person; open is
  offered only while the list holds a chat; the cards are not in Needs you and do not survive a restart.

### Phase 4: later, with others

- **102l. The same cards on the Connected runtime.** Connected refuses `chat.send` and `thread.create` today, so its
  threads can be read through item 97 and nothing more. When `apps/api` lets a chat send and open a thread, the cards of
  R10 work there too, each still an approval settled once. Needs the owner (see the questions).
- **Item 103** exposes these verbs as MCP tools under the same rules; its own design decides who may connect.

## What it does not do

- Start an agent, send a message or read a chat without a press that named it. No setting turns that off in this design.
- Let an agent answer, allow, deny, dismiss or stop anything of another agent's, under any setting (Orca's "Let
  coordinators approve" is not built).
- Run a helper in Accept edits, Auto, Full access or any mode that skips asks, or let a lead set a helper's mode.
- Start helper lanes from a helper lane, from a workflow, from Buddy's chat, by the clock, from a webhook (item 109) or from a
  phone.
- Land anything in the developer's own folder, push or open a pull request for a helper lane (a push from one asks as
  any push does), or merge for the person.
- Pick a best answer, vote, or write a summary of the answers with a model (item 96's runs could later plug in where item
  97's text is built, still shown before it goes).
- Spend money: every agent runs on the person's own sign-in; nothing here uses the AI budget.
- Run helpers on other machines (item 108) or offer an MCP server (item 103).
- Count a helper's tokens or baht: the budget is steps and minutes, which every agent reports.

## Open questions for the owner

1. **Starting helpers always asks.** This design shows a card for every round. Should a later setting let a person start
   rounds without it for one project? The recommendation is no for the pilot.
2. **How many at once.** 2 on an 8 GB Mac, 3 up to 16 GB, 4 at most. A different ceiling, or the person's own lanes
   counted too?
3. **The budget.** GoSpark's 24, 50 and 90 steps, 12 and 20 minutes, and 3 minutes to report. Keep them, or give the
   person a "Let it go on" press on a helper that reached its stop?
4. **Ask several: three agents a message**, as item 97 caps three chats a message. More?
5. **"On the connected runtime".** Connected refuses `chat.send` and `thread.create` today, and the fork's thread cards
   come only from the Hermes bridge. This design builds on this Mac's lanes first (Phases 1 to 3) and leaves Connected to
   Phase 4. Is the API side wanted for the pilot?
6. **May a lead stop its own helper lanes?** A stop is not an answer, but it ends a helper's waiting ask with its turn.
   This design lets only the person stop one.
7. **Buddy and a shop owner.** May Buddy's chat ever start lanes or helper lanes for a shop owner, or does this stay in
   the code editor?
8. **Starting helpers from a phone.** Not one of the phone's requests today. Leave it so?

## What this design did not check

- No agent was run. How long a real helper takes, how often a three-way apply conflicts, and whether agents follow the
  helper brief (never commit, report in the asked form) are from GoSpark's experience, not measured here.
- The memory each agent CLI uses was not measured; R7's numbers follow Buddy's `LIVE = 2` and GoSpark's cap.
- How each agent takes a steer mid-turn was read from `steersOf` and item 95, not tried with a budget note.
- Whether the lead's instructions reach every agent the way item 93's project instructions do was not checked per agent.
- T3 Code's own concurrency or depth limits for children were not found in the files read; nothing here relies on them.
- Orca's `approve` and `deny` paths were read in its documentation and parameter types only.
- The Connected runtime's API side (Phase 4) was not designed; `docs/pilot-api.md` has no route for a chat to send.

## Proposed plan rows

For the lead to add to `docs/plan.md` after reading.

| Order | Work | Waits on | Model |
| --- | --- | --- | --- |
| proposed | 102a. Ask several agents: one message from the + menu starts up to three lanes on different agents and models as one job, each an ordinary lane in its Ask mode; the job's row in the Lanes band; kept across a restart | 102 | Sonnet |
| proposed | 102b. The job's side-by-side view: a column per lane (tabs when narrow) with its state, its chat, its ask card (one approval, settled once), Open lane, Stop and Stop all, Ask them again | 102a | Sonnet |
| proposed | 102c. The gathered answers: each lane's last answer whole with its files and tests, and Compare in a chat through item 97's chips, unsent | 102b | Sonnet |
| proposed | 102d. Helper lanes, the pure rules: rounds, hand-over, the waiting cap, the breaker and two rounds (GoSpark's `BuddyBatchQueue`), the budget with its pause while an ask waits (`BuddyBudget`), and the cap from the Mac's memory, with GoSpark's tests ported | 102 | Opus |
| proposed | 102e. The helper blocks and the Start helpers card: the parser (GoSpark's and the fork's), a block with an unknown key refused whole, the card settled once, the Helpers switch only on a lane's chat, no card in a workflow's lane or Buddy's chat | 102d | Opus |
| proposed | 102f. A helper lane made from a snapshot of its lead's folder (shell), the lead's index, HEAD and stash untouched | 102d | Opus |
| proposed | 102g. Landing (shell): one at a time per lead folder, a snapshot first for Take back, build output cut, a patch outside the project kept untried, keys read, three-way apply, a patch that will not apply kept at 0600 | 102f | Opus |
| proposed | 102h. Running helper lanes: the queue and the cap, Ask mode whatever the lead's mode, the budget's notes and stops, the Helpers card with the person's Stop, Needs you's names | 102e, 102f | Opus |
| proposed | 102i. Landings in the chat: each helper's work landed while the lead is idle, its outcome on its row, Show patch, Take back this landing | 102g, 102h | Sonnet |
| proposed | 102j. Reports to the lead, once and together, fenced, masked and capped; the second round and the closed policy; a restart mid-round lands and sends nothing until the person presses | 102i | Opus |
| proposed | 102k. Chats that reach other chats: read, send to and open, each only after a card the person answers, only among the chats the person listed, never across shops or accounts, never answering the target's asks | 102 | Opus |
| proposed | 102l. The same cards on the Connected runtime, once `apps/api` lets a chat send and open a thread | 102k | Opus (owner) |
