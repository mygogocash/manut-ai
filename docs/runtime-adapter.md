# The desktop's runtime adapter to apps/api (reading a shop, and answering its approvals)

The desktop app's screens talk to one runtime through the protocol in `apps/desktop/src/lib/protocol.ts`
(`src/runtime/adapter.ts` is the seam). Until now the only runtime was the in-process demo (`src/runtime/mock`). This
adds a second one, Connected, that reads one shop's work from `apps/api` and answers what waits for the owner through
the API's decide route, where approval-core settles each request once. It changes nothing else: every other write answers
"not yet".

Status on 23 Nov 2026: built and tested on `feat/desktop-runtime-adapter`, behind a developer setting. Practice (the
demo) stays the default, so a fresh install still reaches no network. The offline cache (see Offline, below) is built and
tested on `feat/desktop-offline-cache`, on top of it. Answering approvals (below) is built and tested on
`feat/desktop-answers-approvals`, 24 Nov 2026, with fakes of the API and no real sign-in yet. Several shops (below) is
built and tested on `feat/desktop-shop-switcher`, 24 Nov 2026, the same way. A shop the person owns, whole (below), is
built and tested on `feat/connected-whole-shop`, 24 Nov 2026, the same way: its tasks, its team, Mission Control's jobs
and activity log, and the owner's routine and pause writes. Customize › Memory and routines (below) is built and tested on
`feat/connected-memory-routines`, 24 Nov 2026, the same way: what the team knows, and making and removing a routine. The task
list (below) is built and tested on `feat/task-list`, 24 Nov 2026 (December item 44): every read takes the newest tasks from
`GET /v1/tasks`, a page at a time, and never the export, which carries every task's whole history. Older tasks (below) are built
and tested on `feat/show-older`, 25 Nov 2026 (December item 52), the same way: a shop with more than its newest 50 says so on
History and the activity log, and Show older reads the next page from the cursor the minute's read stopped at. How a card closes
when nobody here answered it (below) is built and tested on `feat/how-decided`, 25 Nov 2026 (December item 55), the same way: an ask
that left the open approvals on its own closes saying whether it was approved or declined and by whom, taken back, ended or timed out.
The live feed (below) is built and tested on `feat/live-feed`, 25 Nov 2026 (December item 61), and switched off: while the API says
it is on, a change at a shop the person is in shows within seconds instead of at the next minute's read.

## Choosing it

Settings › Developer has a Runtime row: Practice or Connected. Connected asks for the API origin: `https://host[:port]`,
or plain `http://` to this computer only (`localhost`, `127.0.0.1`, `[::1]`), with no path and no user name
(`src/runtime/setting.ts`). The choice is kept on this computer in `manut.runtime` (the mode and the origin, never a
token) and applies at the next start, because the store is built around one runtime. The page offers Restart to
apply; like any reload, that stops the terminals and coding sessions the app runs, and the page says so. Saving
Practice, or another origin, also deletes the last read of the shop that was kept for offline use (`saveRuntimeChoice`
in `src/runtime/link.ts` is the only code that saves the choice, and a test keeps it so).

A quiet line above the account row says which runtime this is: "Practice mode", or "Connected to dev.manut.xyz", or
how the link stands ("Signed out · …", "Offline · …", "Not answering · …"); while the API cannot be reached and a read
is kept, "Offline. Showing what was here at 14:05". Clicking it opens Settings › Developer.
It is not drawn for a WebSocket runtime, which only the Playwright suite configures.

## Buddy in Practice mode

Practice's team is staged, but Buddy's answers are not (item 67, 25 Nov 2026). Manut AI has no model key of its own yet, so a
message to Buddy, in its main chat or a thread, goes to the coding agent the person already has on this computer, signed in
with their own account (`src/runtime/mock/buddy.ts`), and the agent's answer streams back as Buddy's, with the turn's usual
working, done and failed states. Only Claude Code answers as Buddy for now; Codex and the others are not offered (see
`docs/decisions.md`). The members (Nam, Pim, Ton, Kit) keep their scripted, labelled demo answers, and the demo's commands
(`/approve`, `/clarify`, `/interview`, `/delegate`, `/shops`) stay scripted in Buddy's chat for the sample shop; any other
slash command goes to the agent, so the person's own skills run by name.

How Claude Code is started (`src-tauri/src/buddy_chat.rs`): in its chat mode on pipes, through the same Claude adapter the
coding sessions use, with the person's normal configuration (their MCP servers, skills, plugins, `CLAUDE.md` and settings, read
from their own home) and the account picked for new sessions. Buddy adds `--permission-mode default`, so everything that acts
asks first whatever the person's settings say; `--no-session-persistence`; and `--append-system-prompt-file` with Buddy's
instructions (`buddyPrompt` in `packages/agent-prompts`: who Buddy is, that it speaks briefly and plainly to an owner who is not
technical, that in Practice the shop is a sample one, and the facts the team may use), written by the shell to a file under
`~/.manut/buddy/prompts` so no page text becomes an argument. It runs in `~/.manut/buddy/chat`, an empty folder of its own,
never in a project. Buddy's chats are their own list in the shell (`buddy_start`, `buddy_input`, `buddy_close`,
`buddy_close_all`, `buddy_file_save`): the page sends only a message, Stop, an answer and the chat box's three choices (below),
and a coding session's reset never stops one. Each conversation has its own process, at most two at once; a conversation that
comes back starts a new one that is first told what was said.

The chat box (item 80): Buddy's box, in its main chat and each thread, is the coding chat's box (`src/chat/box/`), in two rows as
the design canvas draws its ask box: the text, then a + for Add context, the model with its effort, the approval level and Send.

- **Model and effort.** What the person's Claude Code itself listed (`session.models`, `session.efforts`), never a list of ours.
  Before Claude Code has started once since the app opened there is none, and the button names the agent; after, the button
  names the model the chat picked, else the one Claude Code says it runs. Each conversation keeps its own choice
  (`AgentBuddy.box` and `set` in `src/runtime/mock/buddy.ts`, read through the runtime's `agent.box` and `agent.set`). A running
  agent takes a choice at once; a new process is set to it before the conversation's next message, the model once that process
  has listed its models.
- **Approval.** Ask (Claude Code's `default`, where everything that acts asks first; every conversation starts there) or Plan
  (`plan`: Claude Code says what it would do, changes nothing, and asks to start on its plan, whose card shows the plan whole).
  Nothing else: never `acceptEdits`, which would change files unasked in a folder the person names, and never a mode that skips
  the asks. A plan the person says yes to takes Claude Code back to Ask by itself, and the box follows. The menu's last line says
  the person's own Claude Code settings can still let a tool run unasked, as Buddy's start always allowed.
- **What the shell takes** (`buddy_chat::check`): an approval level of `BUDDY_MODES` (`default`, `plan`), an effort of Claude
  Code's own levels (`CLAUDE_EFFORTS`), and a model only when that very process listed it at its start (`Adapter::models`, which
  the Claude adapter keeps from its `initialize` answer); before it has listed any, no model is taken. Still refused: a picture as
  the agent's image input, a rewind, a steer, and every mode outside the list (`acceptEdits`, `bypassPermissions`, `dontAsk`,
  `auto`, and a flag such as `--dangerously-skip-permissions` in a mode's or a model's place).
- **Add context.** Files: the shell keeps a copy under `~/.manut/buddy/files` (`buddy_file_save`, outside the folder the agent
  runs in; a copy older than a day goes at the next save), and the message names it by its path (`Attached file (a copy Manut AI
  saved; open it with your tools): <path>`), so Claude Code asks before it reads it; this was checked with one real message
  through Claude Code 2.1.332 in Buddy's start. Threads take files too. Folder: the native picker; the folder is never copied and
  never added to the agent's folders, the message names it on a line of its own ("Folder: <path>", in the person's language),
  and Claude Code asks before each read there. Mention a teammate: the `@` menu of the team (also by typing `@` at a word's
  start), written `@slug` as a bubble draws a mention. Actions and skills: the `/` menu, the demo's commands then the commands
  and skills Claude Code listed, from an empty box or over text already typed (the action then goes first). No Browser or Drive
  row: Manut AI has neither.
- **Voice** (item 81, the Mac app). Between the controls and Send: the microphone, which puts the words heard into the text
  for the person to correct and send, and voice mode, which sends what was said at a pause through this same chat, reads
  Claude Code's answer aloud and listens again. An ask is never answered by voice: voice mode stops, says there is something
  to approve, and waits for the card. The listening is the shell's (`src-tauri/src/voice.rs`, the Mac's Speech framework,
  on the Mac or, for a language it cannot do by itself, through Apple's servers after the person's yes); nothing reaches
  Claude Code but the message, as if typed. See `docs/voice.md`.

Connected has no box of its own (`agent.box` answers none), and the WebSocket bridge, Hermes', is never asked.

Asks: every permission the agent asks (a command, a file change, an MCP tool) is Buddy's card in its chat or thread, and in
Needs you, offering Allow once and No. The runtime opens it in approval-core's `InMemoryApprovalStore`, stamped with the turn,
and sends the agent only an answer the store settled, once; an ask ends with its turn. An MCP tool's card says the tool and its
server and shows its whole input. A question the agent asks is a question card and goes back the same way.

When it cannot answer, Buddy says why in the person's language and the turn ends Failed: no agent that can answer (which one
works, that its install line is under More agents in the Code page's + menu, and to sign in with `claude auth login`), not
signed in, a Claude Code too old for Buddy's start, or the agent's own words. The model line says what answers: "Claude Code",
or "No coding agent". In a plain browser the stand-in Claude Code of `src/sessions/host.ts` answers, saying it is one, and lists
its stand-in models (`e2e/chat-box.spec.ts` walks the box on it).

Practice therefore reaches the shell for Buddy (which agents are installed, and Buddy's chat) and for nothing else. Connected is
unchanged: its `chat.send` is still refused, as below.

## What it reads, and how each call maps to the API

Each read first asks which shops the person is in (`GET /v1/shops`; Several shops, below). In none, as before shops, the
read is the signed-in tenant's, four reads made together through the session, the task list's pages one after the other
(`src/runtime/http/shop.ts`):

| Request | Gives | Notes |
| --- | --- | --- |
| `GET /v1/tasks?limit=25`, then `&cursor=` | the newest 50 tasks, each with its exact-action proposals, its runs, its newest draft and the entries of its log the screens read | The task list (`docs/pilot-api.md`, "The shop's tasks, a page at a time"): two pages at most, each from the cursor the page before gave, so no task is read twice or skipped while tasks are made. The screens keep the tasks oldest first, as the export listed them, so a sort with ties shows as before. A shop with more than 50 shows its newest 50, keeps the cursor the read stopped at, and says there is more; Show older reads the pages after it (Older tasks, below). Until 24 Nov 2026 this was `GET /v1/tenant/export`, every task with its whole history, read whole every minute; nothing reads the export now. `404 tenant_deleted` reads as no tasks, as the export's did. |
| `GET /v1/approvals?state=open` | approval-core's requests still waiting for an answer, each with where it stands and any note a helper passed on | Read with `@manut/approval-core`'s own decoders (Answering approvals, below). These are the asks. Any refusal fails the read: the API answers 503 rather than leave one out, and a missing ask would read as nobody having asked. |
| `GET /v1/schedules` | the schedules | |
| `GET /v1/inbound/attention` | the inbound attention items | `403 feature_disabled` (the API's inbound flag is off) reads as "no feed", not as a failure. |

A read fails as a whole, with the worst reason first (signed out, then offline, then unavailable), so half a shop is
never shown as the whole one. Decoding never throws: every record keeps the API's whole object in `raw`, a state, an
operation or an event kind the app does not know is kept and shown as the API wrote it, and an entry with no id is kept
in `unreadable` rather than dropped.

The protocol ops are answered from the latest read (`src/runtime/http/host.ts`, `view.ts`):

| Op | Answer |
| --- | --- |
| `hello` | the runtime itself (`bridge: "real"`) |
| `bots.list` | for a shop the person owns, Buddy and the members it has on (A shop the person owns, below); otherwise Buddy alone, standing for the team: online once the shop has been read, working while any task is `running`, `verifying` or `recovering`, or its newest run can still act |
| `thread.list` (Buddy) | every task as one of Buddy's threads, newest activity first; `needs` marks a task with a request waiting for an answer. History and Recent list them. A member has none: their work is their jobs. |
| `thread.open` | the task as Buddy's notes: what it is for, each action it asked for and how that settled, the draft a member wrote on it (saying nothing was sent), and where it stands now, in the app's language |
| `chat.open` (Buddy) | the attention items as notes ("A Linear issue was changed (ISS-9)"), then, as a runtime replays asks, one approval ask per request still open, oldest first, naming the exact action ("Send on LINE: “…”"). The answers offered are yes once and no. Needs you and Home show them. |
| `routines.list`, `automations.list` | the schedules, under Buddy, their days and time as cron and their next run exact; a schedule that is off shows as paused. For a shop the person owns, also each team routine under its member |
| `bots.info` | counts from the read |
| `jobs.list`, `jobs.get`, `activity.list`, `team.state` | Mission Control from the read (A shop the person owns, below): every task as a job, the activity log, and for a shop the person owns its team's state. `jobs.list` and `activity.list` also say `older: "more"` while the shop has older tasks than they hold and `older: "end"` once Show older has read the last page, and say nothing for a shop whose newest read held every task (Older tasks, below) |
| `jobs.older` | Show older: reads the next page of the shop's older tasks and adds it to what `jobs.list` and `activity.list` list; answers `{ older: "more" \| "end" }` (Older tasks, below) |
| every other read the screens make | empty (`elsewhere.list`, `plugins.list`, `runs.*`, …), or `not_found` for one thing asked by name |
| `approval.respond` | the person's answer, through the decide route (Answering approvals, below) |
| `routine.list` | the shop's team routines, then its other schedules as routines, for the shop the switcher shows, with the shop they were read for (`shop`). A shop the person only helps at is refused `owner_only` (Customize › Memory and routines, below) |
| `routine.create`, `routine.remove`, `routine.pause`, `routine.resume`, `team.pause`, `team.resume`, and `automations.pause` and `.resume` of a team routine | for a shop the person owns, through apps/api's routines routes with that shop's session (A shop the person owns, and Customize › Memory and routines, below). Every `routine.*` change names the shop its list was read for |
| `memory.list` | what the team knows, `GET /v1/memory`, for the shop the switcher shows, read live when the page asks and kept nowhere (Customize › Memory and routines, below) |
| `memory.remember`, `memory.confirm`, `memory.correct`, `memory.forget` | the owner's say over a fact, to `POST /v1/memory/remember`, `/confirm`, `/correct` or `/forget`, with the shop its list was read for |
| `connections.list` | the shop's site sign-ins and outposts, `GET /v1/vault/sign-ins` and `GET /v1/vault/outposts`, for Customize › Connections (below) |
| `connections.add`, `connections.password`, `connections.members`, `connections.rename`, `connections.remove` | the owner's change, to `POST /v1/vault/sign-ins`, `/v1/vault/sign-ins/password`, `/v1/vault/sign-ins/members`, `/v1/vault/outposts/rename` or `/remove` (below) |
| `people.list` | who can use Manut AI for the shop the switcher shows, `GET /v1/people`, for Settings › People (below) |
| `people.invite`, `people.cancelInvite`, `people.remove`, `people.setAway`, `people.clearAway` | the owner's change, to `POST /v1/people/invites`, `/invites/revoke`, `/remove`, `/away` or `/away/clear` (below) |
| every other write (`chat.send`, `thread.create`, `automations.add`, …) | refused with `not_yet` and a translated "Not yet: Connected mode answers approvals, looks after what your team knows and its routines, and manages Connections and People for now." Nothing is sent to the API. Buddy's chat needs a model, the owner's key. |

The runtime's capabilities are `automations` only, so the Automations page shows and the screens that need a runtime on
this computer (other places, plugins, restarts, coding-CLI logins) stay hidden.

While anyone is connected the shop is read again every minute, and a list asked for more than 15 seconds after the
last read is read again first. What changed between two reads becomes the events the store already follows: a new
waiting request is an `approval.request` (one per revision); one that left is a `prompt.expired` (`timeout` when its
action expired, `cancelled` when its task is gone or the request was asked again at a new revision, `resolved` when it
was decided, with the API's own words in `note` when the person's answer here was refused, and, when nobody here answered it, the
words of how its request was settled from the shop's recent requests, read once for each shop that has such an ask: When nobody
here answered it, below); a new or vanished task is
`thread.added` or `thread.removed`; a
new attention item is a `message` in Buddy's chat; a schedule or team routine change is `routines.update`; the team
changing (a member starting or stopping work, Pause everyone, a member switched on or off) is `bots.update`. A task already listed changes its row only when the list is read again (after a reconnect or a
restart). While the API's live feed is on, a ping from any shop the read shows brings that read, and the events it emits, forward
to within seconds (The live feed, below); a row of a task already listed still changes only when its list is read again. A task that falls out of the newest 50 as newer ones are made
is `thread.removed`, as a task that is gone; it is no thread of Buddy's, but once Show older has read older tasks it stays a job and
in the activity log (Older tasks, below).

Not read in this slice: `/v1/consent/cloud`, `/v1/tasks/:id` and its events and actions one by one, `/v1/companies/*`,
`/v1/health`, and since the task list `/v1/tenant/export`, which the desktop has no page to ask for. A shop the person owns
is read differently: below.

## Answering approvals

Built on `feat/desktop-answers-approvals` (`src/runtime/http/approvals.ts`, `answer.ts`, `host.ts`, `session.ts`).
The API side is `apps/api/src/approvals.ts` (docs/pilot-api.md, "Approvals for a session" and "Deciding from a session").

### Where the asks come from

- **approval-core's records, decoded by approval-core.** Each entry of `GET /v1/approvals?state=open` is read with
  `decodeRecord` and `decodeStanding` from `@manut/approval-core`, and answered with `toKnownRequest`, never by hand.
  Each request still open is one ask in Buddy's chat, so Needs you and Home show it. An action a task lists as
  proposed but no request decides is not an ask: nothing on this path could decide it (it still shows in its task's
  notes, "waiting for you").
- **The exact action.** A reply's ask says the reply's own words from its request ("Send on LINE: “…”"). A worker's
  request carries no words, so its ask says its action's, from its task in the task list ("Create a Linear issue: “…”"),
  as it said them from the export before. Otherwise, a task older than the newest 50 among them (also one Show older has read: an ask's words
  come from the newest read's tasks), it says the operation and where it goes, as the API wrote them. A request's `detail` is cut down to the words the card
  shows (the action id, the operation, where it goes, the customer it goes to, the text) before anything keeps it.
- **The revision the person saw.** An ask's id is `<requestId>@<revision>`. The store keeps one card per id, so a
  request revised since is a new card, and the old one closes with "It changed since you saw it. Answer the new
  version". An answer always names the revision in its card's id, never a later one the person has not seen.
- **What this build does not know.** A kind, an option's effect, a record's status or a standing's state it does not
  know is kept as approval-core keeps it (an `unknown` value with the text sent), never dropped: the ask is shown with
  its exact action, offers no answer (`outdated` on the ask, no choices, so Home offers no Approve either) and says
  "Update the app to answer this", online and offline; the runtime refuses an answer to it and sends nothing. A request
  that offers more than one option of the same effect is treated the same, since each answer the card shows must be
  exactly one option.

### Answering

- **One path.** The card's buttons and Home's Approve both call `settleApproval` (`src/chat/cards/respond.ts`), the
  store's `respondApproval`, which sends `approval.respond` to the runtime. The host's `answer` is the only code that
  sends a decision.
- **By what it does, never by label.** Allow once is the request's one option that approves, Deny its one option that
  declines. Allow for session and Allow always are never offered and are refused: approval-core has no standing
  approval.
- **Exactly `{ optionId, seenRevision }`.** `POST /v1/approvals/{requestId}/decision` (the id one path segment), with
  the session's bearer token, which the shell's `api_request` keeps apart from the address and the body. No role and no
  `decidedBy`: the API takes who decides from the session (the shop's own session decides as the owner,
  `owner-session`), and refuses a body with anything else.
- **Refused here, with nothing sent:** an ask id the runtime did not make, or for a request the latest read does not
  hold (`not_found`); a card whose revision the latest read has moved past (`changed`); an ask this build cannot answer
  (`update_app`); a choice the request does not offer (`not_offered`); and, while only a kept read is shown, every ask
  ("Connect to answer this").
- **Answered only when the API says so.** The card is marked answered, with the choice, only after a 200 whose
  `result.ok` is true. No answer at all is never taken for one either way.
- **Read again after every answer.** Once the API has answered, the shop is read again at once (a read already on its
  way is waited out first), so Needs you, the card and the task's notes show what the API holds, and the card of a
  request that is over closes in the API's words. A task's row in History changes its `needs` dot only when the list
  is read again, as before.
- **The session's rules for the write** (`ApiSession.write`): refreshed five minutes before expiry like a read; a 401
  gets one refresh and one resend of the same body, which is safe because the API answers 401 from the session before
  it reads the body; a request that got no answer (offline, timed out, a 5xx) is never sent again from here, since the
  API may have it.

### What the person reads

| The API answered | Words (under the card, and on Home's row) | The card |
| --- | --- | --- |
| 200, `result.ok` | | "Allowed once" or "Denied" |
| 403 `not_permitted` | "Only the owner can approve money", "… public posts", "Only the owner can confirm that a payment arrived", "Only the owner can approve changes to the shop's own records" (a command), else "Only the owner can decide this" | stays open for the owner |
| 409 `already_decided` | "Already decided by Mint at 19:42"; "… by you …" (the shop's own session), "… from your LINE link …" (the owner's link), "… by a helper …" (a helper whose name this app was not told), "Already decided at 19:42" (a role this build does not know) | closes with those words |
| 409 `changed` | "It changed since you saw it. Answer the new version" | closes; the new version is a card of its own |
| 409 `superseded` | "No longer asked: the work it was for has stopped" (its attempt or turn ended), "Withdrawn: the team took it back" | closes |
| 410 `expired` | "Expired at 19:42" | closes as timed out |
| 404 `not_found` | "That is not in this shop any more." | closes |
| 403 `consent_required` | "The shop has not agreed yet to let Manut AI send for it" | stays open |
| 403 `feature_disabled` | "Answering is switched off on this API for now" | stays open |
| 400 `invalid_request`, `not_offered`, any other 4xx | "The API could not read the answer, so nothing was decided", "That answer is not offered here", "The API did not take this answer, so nothing was decided" | stays open |
| 401 `removed` | "The owner removed you on Sunday, November 22. Ask them if this is a mistake" | the session ends here, with the kept read |
| 401, twice | "Signed out. Sign in under Settings › Developer." | |
| no answer, a 5xx, a body that does not say | "No reply from the API. Checking whether your answer arrived" | the read that follows says where it stands |

A time is "19:42" on its own day and "Nov 22 19:42" on another. A helper is named by the name the owner gave them when
the listing has told this app (a note they passed on carries it); the session routes give no other way to a helper's
name yet. A card closes in these words through the protocol's `prompt.expired`, which now carries an optional `note`
the store keeps on the card (`expiredNote`).

### When nobody here answered it

Built on `feat/how-decided` (December item 55): `src/runtime/http/decided.ts` (the words), `host.ts` (`emitLeft`, `closeFromRecent`,
`readRecent`, `settledClosings`) and `answer.ts` (`whoDecided`, `expiredWords` and `supersededWords`, which this and the answer path say
alike). Before it, an ask decided anywhere but this app (the web app, the owner's link page, another device, a helper) closed as
"Answered elsewhere": a shop session reads no tasks, so nothing here could tell a decision from a withdrawal, or say which way it went.

- **One read.** When a read finds asks that left the open approvals and the person did not answer them here, the host asks the shop's
  recent requests how each was settled: `GET /v1/approvals?state=recent`, with no `limit`, so the API's own newest 50 requests that
  stopped waiting, newest asked first, each as approval-core's record and where it stands (`docs/pilot-api.md`, "Approvals for a
  session"). It is read once for each shop that has such an ask, all at the same time, with that shop's own session, or with the
  sign-in's for a person in no shop: at most one read for each shop for each of the minute's reads, and none when no ask left. It is
  a read and nothing else. Nothing here decides, answers or passes on anything, so approval-core's rules (the decide route) stay the
  only way round a request.
- **When it is not made.** For an ask the person answered here: a refusal closes it in the API's own words, and an answer the API took
  is now kept as a closing too, `resolved` (the store has marked the card answered, and `prompt.expired` leaves an answered card as it
  is), so the read that finds the ask gone has nothing to look up. For a request asked again at another revision ("It changed since you
  saw it. Answer the new version": it is still open, and its new version is an ask of its own). For a shop the person's place in ended
  (its asks close in the words that say when, and its session is gone). And when no ask left.
- **Held a few seconds.** The card stays open for the read for 4 seconds at most (`LEFT_READ_MS`). It then closes as it always did
  (`resolved` when the action was decided, `timeout` when it ran out of time, `cancelled` when its task is gone, with no words of its
  own) in every case the read does not speak for: it has not answered by then, fails, answers anything but that list (the open list,
  or a body with no list in it), does not list the request, lists it at another revision than the card showed, says it still
  waits, or says it stands in a way this build does not know. An answer that comes later is never used, and each card closes
  once. One shop's slow read does not hold another shop's cards. A person who signs out, or an app that lets go of the runtime,
  while a read is on its way, closes nothing. If saying how fails for any reason, the card closes as it did before.
- **The words** (`rt.how.*` in en, ko, ja and zh; the others are the answer path's own):

  | Where the record says the request stands | The card closes as | Words |
  | --- | --- | --- |
  | decided, by an option whose effect is approve | `resolved` | "Approved by you at 19:42", "Approved from your LINE link at 19:42", "Approved by Noi at 19:42", "Approved by Mint at 19:42", "Approved by a helper at 19:42", "Approved at 19:42" |
  | decided, by an option whose effect is decline | `resolved` | the same, with "Declined" |
  | decided, by an option the request does not offer, offers twice or whose effect this build does not know | `resolved` | "Already decided by you at 19:42" (the answer path's own words, with no verb) |
  | decided, with no time | `resolved` | "Approved" or "Declined": who is not said either, as "Already decided" does not |
  | withdrawn | `cancelled` | "Withdrawn: the team took it back" |
  | superseded, its attempt or turn ended | `cancelled` | "No longer asked: the work it was for has stopped" |
  | superseded, any other reason | `cancelled` | "No longer waiting for an answer" |
  | expired | `timeout` | "Expired at 19:42", or "Timed out" when the API said no time |

  A time is "19:42" on its own day and "Nov 22 19:42" on another, as everywhere else.
- **Approved or declined is what the option does.** The request's one option with the decision's id says its effect (`approve` or
  `decline`, approval-core's own), and that is read; never the option's id or its label, which can be any words in any language, and a
  request can offer an option called "decline" that approves. The record's own decision is read when the standing is one this build
  does not know, and the standing's when the record's status is one it does not know.
- **Who.** From the decision's `role` and `decidedBy`, which the API takes from the session. The owner's own session or account is "you"
  to the owner, and the owner's name to a helper reading it ("Approved by Noi"; to a helper the owner's decision is never "yours"); the
  owner's link on LINE is "from your LINE link" to the owner. A helper is named by the name a note they passed on carries
  (`passedOn`: in the shop's open list as the app held it, or in the recent list), the one place this app learns a helper's name; the
  shop's people record is not read for it (`GET /v1/people` is the owner's alone, and a second request). Otherwise it is "a helper". A
  role this build does not know is no one in particular, and the words say none. A helper reading another helper's decision may be
  reading their own on another device, so "a helper" is all that can be said. The words never say "on another device" either: the
  API names no device, and an answer this app sent whose reply was lost reaches the read as the owner's own, so "by you" is true of it
  and of a decision made on a phone alike.
- **Ended work.** A request superseded because its attempt or turn ended says "No longer asked: the work it was for has stopped", the
  decide route's own words for the same standing, and not that a newer ask replaced it: approval-core says only that the attempt or
  turn that asked no longer holds the task, and a newer ask may not exist.
- **The revision.** A record at another revision than the card showed says nothing, and the card closes as it did before: a request
  revised after the card was shown and then decided was decided at other words than the card showed, and "Approved" on the old card
  would say the exact words it showed were approved.
- **Only what the API's list holds.** It lists the newest 50 requests that stopped waiting, by when they were asked. A request asked
  before all of them (a busy shop, an ask that waited a long time) is not listed, and its card closes as it did before; `&limit=`
  (up to 200) would reach further, at more reading on the API's side. A helper's name with a decision stays an ask of the API (Next
  slices, 3), so a helper who decided a reply is "a helper" unless they passed something else on.
- **Order.** A closing that waits for the read comes after the other changes the same read shows (a task gone, a new ask); every
  other closing is as soon as the read is taken, as it was.
- **What is kept.** Nothing. The read is not kept in the snapshot or the offline cache (whose version did not change for it), and the
  words are not kept. An ask the kept read showed, and that is not waiting when the API answers again, closes in how it left by the same read, as
  any other. Practice is unchanged: its demo settles its own asks and reaches no API.
- **A helper's refused answer.** The same words now name the owner, where a helper's answer refused because the owner decided first
  said "Already decided by you" or "from your LINE link" (`AnswerContext.owner`, set for a shop where the person is a helper).
- **Tests.** `decided.test.ts` (every closing in the table, the option read by its effect, who, the revision, every record that does not
  speak, the words in four languages) and `decided.host.test.ts` (the runtime end to end over a fake API that lists recent requests as
  apps/api does: each closing under the app's own store, one read for several asks, one for each shop with that shop's session, no read
  when none left or for an ask answered here or asked again or for a shop left, every way the read can say nothing, the wait cut at
  4 seconds with a late answer unused, a sign-out or a stop while it is on the way, a failure in saying how, the person's place in a
  shop ending in the read, and the file on disk the same whether or not the read said how); `several.test.ts` (a helper's refused answer
  names the owner, and the owner's own is "you"); `e2e/google-sheets.spec.ts` (Connected over a stubbed shell: Ton's request settled four
  ways elsewhere and one read that fails, the page's clock moved by hand).

### From a notification

The canvas allows one answer from a notification: "A message request can be approved from the notification", and
"Money never from a notification". Every notification the desktop shows goes through `@manut/notify-rules`
(`src/lib/outside.ts`, `src/lib/notify.ts`), which decides from the request's approval-core kind (the connected runtime's
asks carry it in the protocol event's `kind`; any other ask has none and is owner-only):

- A `message` or a `reply` carries Look first and Approve. Money, public posts, payments, commands and any kind this build
  does not know carry Look first and Later, and nothing that could approve. No notification carries Approve while
  Settings' Hide details is on, or for an ask the card itself offers no Allow once (Update the app to answer this).
- **Approve needs the exact action, whole.** A body that is not the card's exact action, unchanged (cut to fit, a link
  shortened to its host, marks dropped), or that is too long for the system to show whole, is a hidden detail, so it
  carries Look first only: an owner must not approve words they never saw. notify-rules measures it: one line of at most
  72 columns (`WHOLE_COLUMNS`), a wide letter counting two and a mark on a letter none. A browser write's sentence
  (`docs/browser-control.md`) always holds links, so its notification never carries Approve.
- **Approve is the card's own Allow once.** `approveFromNotification` (`store.ts`) calls `settleApproval`, the one path every
  button uses, so the host's `answer` sends exactly `{ optionId, seenRevision }` for the revision the notification named,
  through the decide route, and never a role. If the request is not waiting any more, or the answer is refused, or no word
  came back, the app comes forward on that card (from the menu bar or minimised too) and the card says what happened under
  its buttons, in the API's words (`src/chat/cards/askNote.ts`). A notification answers once; a second press is ignored.
- Look first opens the app on that request, scrolled into view and focused; a click on the notification itself is Look first.
  Later only dismisses.
- Nothing is shown in quiet hours (the request waits in the app), and an ask notifies once per id and revision.
- `src/lib/notify.ask.test.ts` pins all of it for every approval kind, end to end over the fake API, and
  `src/lib/notify.outside.test.ts` pins what reaches the system.

What the plugin does on macOS, read from its installed sources (`@tauri-apps/plugin-notification` 2.8.1,
`tauri-plugin-notification` 2.8.0, `notify-rust` 4.19.0; not run in a live app): a notification shows its action type's
buttons only if an `onAction` listener existed when it was shown, so the page listens once before its first notification;
two or more buttons fold into an "Options" menu, and a click on that menu button itself reports the first button, so the
system is given Approve last; the pressed button is reported by id (`tap` for a click on the notification). The window
badge and Look first need `core:window:allow-set-badge-count`, `allow-show`, `allow-unminimize` and `allow-set-focus`
(`src-tauri/capabilities/default.json`); no Rust changed.

### Offline

As before: an ask from the kept read is shown with its exact action, cannot be answered ("Connect to answer this"),
and nothing is queued or sent later. The cache keeps the open requests as approval-core's wire JSON, their detail cut to
the card's words, with any note passed on, and reads them back with the same decoders as the live read; every version of
the file since 2 keeps them, and the current one is 6 (The offline cache, below). An ask this build cannot answer says
"Update the app to answer this" offline too.

### What a real owner needs

- **A sign-in that reaches their shop.** The answering path is the real one, but the desktop can only sign in by hand
  with a test identity today (Signing in, below), and a pilot shop is a tenant of its own (`pilot:<uuid>`) that no
  session can carry. So an owner needs real sign-in (Sign in with Apple in the app, or LINE Login, which is parked) and
  the API's link from their identity to their shop. With a session for the shop, the desktop decides as the owner, once
  the shop has consented and the API's `officeCloud` and `officeExternalWrites` switches are on.
- **Helpers on the desktop.** Built since (Several shops, below): a person who helps at a shop holds a helper session for
  it (`mhs1.`, from `POST /v1/shops/session`), decides its messages and replies, and passes the rest on to the owner.
- **How it was tested.** The desktop's tests use a fake API whose answers are built with approval-core's own encoders,
  as the API builds them (`approvalJson` in `testkit.ts`); the routes themselves are tested in real workerd in
  `apps/api` (`approvals-route.test.ts`, `session-decisions.test.ts`). By hand, the local API and test identity of
  Signing in, below, reach the routes, but nothing waits for that tenant: a request is opened by a reply proposed
  through a LINE connection (parked) or by a worker's run, which only the operator's `POST /v1/admin/workers/run` starts,
  for a pilot shop no session can carry.

## Several shops

Built on `feat/desktop-shop-switcher` (`src/runtime/http/shops.ts`, `host.ts`, `session.ts`, `cache.ts`, `view.ts`), the
desktop's slice of `docs/several-shops.md`. The API side is `apps/api/src/shops.ts` and `people.ts` (`docs/pilot-api.md`,
"Several shops").

- **The list.** Every read starts with `GET /v1/shops`, with the sign-in. An API from before shops answers it 404, which
  reads as none. In none, the read is the signed-in tenant's, as above; in some, the signed-in tenant is not read at all.
- **A session per shop.** Each shop is opened with `POST /v1/shops/session` and exactly `{ shop }`, with the sign-in (its
  refresh rules apply). The answer's role and token, and its end, are kept with the sign-in in the keychain item, under
  the shop's id (Where the tokens live, below). A shop's requests carry only its own session. A session within a minute of
  its 30 days is opened again before it is sent; one the API answers 401 for any reason but `removed` or `unlinked` is
  opened again once and the request sent once more, a decision too, since the API answers 401 from the credential before
  it reads the body. Two requests that find it ended open it once.
- **What a shop reads.** `GET /v1/approvals?state=open`, with its own session. A shop the person owns is read whole as
  well (A shop the person owns, below): its task list, schedules, attention items and routines, with the same session,
  and its helpers' devices (A helper's new device, below). A shop they help at is read for its asks and nothing else: what a helper sees is the
  owner's call, so it shows Buddy, its asks, no tasks (History is empty), no schedules and no notes. Every listed shop is
  read each time, at once; one shop that fails (offline, 5xx) fails the whole read, and the kept read stands in for all of
  them.
- **One Needs you.** Every shop's open requests are asks in Buddy's chat, sorted by when each was asked (the protocol
  event's new `asked_at`, which the card keeps as its time). An ask's id is `<shop>/<requestId>@<revision>`, the shop
  written as `encodeURIComponent` writes it, so two shops' asks never share a card and an answer finds its shop from the
  card alone. The event names the shop (`shop`: id, name, owner, the person's role) and, where the role may not decide
  the kind (`mayDecide`), offers no choices and `pass_on` instead; a note passed on rides as `passed_on`. A read that
  shows a waiting ask differently (a note passed on since, a role that moved) sends it again, and the open card takes the
  new fields.
- **Answering.** `approval.respond` on a shop's ask goes to that shop's decide route with that shop's session, exactly
  `{ optionId, seenRevision }`, as above. It is refused here, with nothing sent, when the role there may not decide the
  kind ("Only Noi can approve money"). `approval.pass_on` (new) sends `POST /v1/approvals/{id}/pass-on` with exactly
  `{ note }`, trimmed, with that shop's session; refused here for an owner ("Only a helper passes a request on"), a kind
  the helper decides ("You can decide this one yourself"), a request passed on already, and a note that is empty or over
  500 characters. While only a kept read is shown both answer "Connect to answer this". The shop the switcher shows never
  enters either path.
- **Switching.** `shops.list` gives the shops (owned first), the one viewed and the ones whose place ended this run;
  `shops.switch` changes the one viewed and sends `shops.update`. Nothing new is read for a switch. The store then drops
  what the last shop's pages showed (chats but for the shops' asks, threads, schedules, places) and reads every page again.
- **Making a shop** (`shops.make`, `src/runtime/makeShop.ts`; `docs/several-shops.md`, "A shop its owner makes"). `POST
  /v1/shops/new` with the sign-in and exactly `{ name, ownerName, template }`; a name or a kind the API would refuse is
  refused here with nothing sent. The owner session the API answers is kept in the keychain item with the sign-in, as an
  opened shop's is, the new shop becomes the one viewed, and the read that follows lists it before the op answers. A refusal
  keeps the API's code (`sign_ups_closed`, `too_many_shops` and the rest), and a request that got no answer is never sent
  again. Practice makes the shop in memory, with nothing sent.
- **A place that ended.** 401 `removed` or `unlinked` from a shop's session drops its session and kept read at once and
  closes its asks in words that say when. Each read also looks once, with its own session, at a shop it holds a session
  for that the list no longer has, to say why and when, then drops it. `shops.update` follows either.
- **A helper's new device** (`devices.ts`; `docs/people.md`, "A helper's new device"). After each read is taken, a shop the
  person owns is asked `GET /v1/people/devices` with its own session, in the background, so a slow or failing route never
  holds back the read. A shop they help at is never asked: the API answers a helper's session 403. The answer lists one sign-in for each helper session opened, signed out or not, as `{ id,
  helperId, name, openedAt }`. The host says each one it has not said yet as the protocol's `device.new` (the helper's
  name, the shop, when), once, oldest first. The first look at a shop says none, so a first run does not ring for every
  helper. What it has seen is the ids listed, per shop, in this computer's own storage (`manut.devices.seen`, at most 200
  for a shop). It is not in the kept read, which lasts 7 days and goes at sign-out, and it is no secret, so not in the
  keychain. A shop the person leaves, or no longer owns, takes it with it; signing out leaves it. A read of the devices
  that fails (offline, 5xx, a refusal, an answer this build cannot read) says and forgets nothing, as does one that
  answers after the person signed out. The store shows each one with `showNewDevice` (`notify.ts`) as "Mint signed in on a new device",
  through `showOutside` and notify-rules: quiet hours never silence it and Hide details hides who and where. Look first (and a
  click on the notification) brings the app forward and opens Settings › People for that shop, where its owner can remove
  access (`openPeopleOf`, `store.ts`: it shows the shop, then opens the page, and opens no page when the shop could not be
  shown); the notification is as it was. Later only dismisses. "Notify me" off switches it off, as every notification.
- **Signing out** ends each shop session with `POST /v1/shops/session/end` (the session as the bearer, exactly `{}`),
  together with `DELETE /v1/auth/session`, then clears the keychain item and the kept read whatever the API said; Settings
  says the API was not told when any of them got no answer. A sign-in the API ends has its shop sessions ended the same
  way, without waiting.
- **This Mac's outpost** (`outpost.ts`; `docs/browser-control.md`, "This Mac for the shop the switcher shows"). Register
  this Mac goes with the owner session of the shop the switcher shows, through the host's owner link
  (`HttpHost.ownerLink`, `ShopSessions.writeVia`) and the shell's own command, or with the sign-in while the person is in
  no shops; a shop they help at is refused here with nothing sent. `followSignIn` hears the sign-in and the shop sessions
  held (`ApiSession.onShops`, which also fires as a sign-out lets the sign-in go) and tells the shell every tenant the
  person acts for as owner (`outpost_signed_in` with `tenants`): the signed-in tenant and each shop whose owner session is
  held and has not ended. The shell runs the outpost while the shop its keychain item is for is among them. Calls go one
  at a time, the latest, never twice the same, and the follower looks again when the first of those sessions ends.

## A shop the person owns

Built on `feat/connected-whole-shop` (`src/runtime/http/shop.ts`, `shops.ts`, `view.ts`, `work.ts`, `customize.ts`,
`host.ts`, `cache.ts`), the desktop's half of `docs/several-shops.md`, slice 4. Before it a pilot shop showed only its
asks, Mission Control showed Buddy alone, and every write but an answer was "not yet".

- **What it reads.** Each read asks a shop the person owns, with its own owner session (`mos1.`) and at once, for what
  waits there (`GET /v1/approvals?state=open`), its newest tasks from the task list (`GET /v1/tasks`, two pages of 25 at
  most: each task with its actions, each member's run, the newest draft one wrote, and the entries of its log the screens
  read), its schedules (`GET /v1/schedules`), its attention items (`GET /v1/inbound/attention`) and its team with its
  routines (`GET /v1/routines`). Until 24 Nov 2026 the tasks, schedules and attention items came from the shop's export,
  every task's whole history read every minute; the API now answers an owner session on the schedules and attention
  routes with what the export carried, and the desktop never reads the export (`docs/decisions.md`). A schedule that names
  a `routineId` is that routine's clock and is not listed twice. A shop the person helps at is read for its asks only,
  and every one of those reads answers a helper's session 403 `owner_only`, which reads as "asks only" rather than a
  failure. Anything else that fails (offline, a 5xx, a page of the list that cannot be read) fails the whole read, as
  before: half a shop is never shown as the whole one. A deleted shop's list (404 `tenant_deleted`) reads as no tasks.
- **What the list carries, and what it does not.** Every screen shows what it showed from the export, for a shop of 50
  tasks or fewer (`screens.test.ts` pins each one as the export showed it): Mission Control's team and jobs, the job view,
  History's rows and chips, each task's notes, the activity log and Needs you's words. A job view shows each run's claim,
  handoff, model, tokens and cost, which the list carries from the log, so opening it reads nothing more; the log itself
  stays in the task. The activity log is the listed tasks' drafts and actions, so its span is the newest 50 tasks, and the older ones once Show older
  has read them (Older tasks, below); it reads nothing of its own.
- **Its pages.** The shop being viewed shows its tasks as Buddy's threads in History and Recent, as the signed-in tenant's
  are; opening one shows Buddy's notes, now with the draft a member wrote on it ("Nam's draft, for you to read. Nothing was
  sent."). Buddy's chat shows its attention items and every shop's asks.
- **Its team.** `bots.list` is Buddy, who leads, and then the members `GET /v1/routines` says the shop has on, in
  `@manut/member-grants`' order (Nam, Pim, Ton), each with what they do in the onboarding's words. Kit is not listed: the
  API's team has no Kit, who works on this computer. A member is working while a job of theirs runs (its newest run can
  still act, as apps/api's `endingOf` reads it), and while Pause everyone is on every member but Buddy is `paused`. A
  member's chat is empty and they have no threads: the API keeps no chat with a member, and each task is listed once, as
  Buddy's thread. A member's Schedule tab lists their routines, the timing as cron where the tab can say it in the app's
  language (every day, weekdays, one weekday, one day of the month) and the API's own words otherwise.
- **Mission Control.** A job is a task (`work.ts`): its member is the one whose run has it now (the newest claimed; a job
  passed on is the member it went to), else Buddy. Where it stands: waiting for the owner first; then the member's run
  (running, drafted, checked when a run found nothing to write, failed, cancelled; a run that stopped to ask, once its
  request is over, stands where its action settled); then its actions (sent, approved, failed, or cancelled when every one
  was declined or ran out of time); then the task's own state. Its timeline is each run's claim and each action's
  proposal, approval and send, at the times the API kept. A job's page shows the goal (the task's objective), the draft as
  what happened, the cost its runs reported in whole satang, how long the runs took (none while one runs or a time is
  missing), and one trace step per run in the API's own codes. No recipient is listed: the API names a customer only by a
  LINE id. The activity log is each draft a member wrote (`drafted`, a new status; a reply's words private), each action
  waiting for the owner (`needs_you`) and each one that went out (`sent`, with who approved it), newest first, and it
  claims no span (`keptMonths: null`), since the tasks are kept until the shop deletes them. `team.state` is the team, the
  routines a pause would hold and the jobs running now, with `holds: "routines"`; for a shop the person helps at it is
  refused, "Only Noi can see and change the team at Ran Pa Noi.", and for the signed-in tenant it is still "not yet".
- **The owner's writes.** Pausing and resuming one of the team's routines (Customize's routines, and the Automations
  page's pause for a team routine) is `POST /v1/routines/pause` or `/resume` with exactly `{ routineId }`; Pause everyone
  and Resume everyone are `POST /v1/team/pause` and `/resume` with exactly `{}`. Each goes with its shop's own owner
  session, only for a routine the read lists for that shop, and is refused here with nothing sent for a shop the person
  helps at and for the signed-in tenant. A routine change names the shop its list was read for (`shop`), so it goes with that
  shop's session whichever shop the switcher shows by then, and an op that names none is refused (`not_found`), never read as
  the shop viewed; Pause everyone and the Automations page's pause are for the shop viewed. The API's answer is shown at once
  and the shop is read again. A refusal is said in words ("The API did not make this change, so nothing changed."), and a
  change that got no answer is never sent again from here ("No reply from the API. Checking whether it changed."): the read
  that follows says, and is waited for before the refusal is thrown, so the list the page asks for next is that read. None of
  these sends, posts, pays or deletes anything, and approvals still settle only through the decide route. Making and removing
  a routine and the owner's say over what the team knows are Customize › Memory and routines, below. A schedule of the shop's
  own, Buddy's chat (which needs a model, the owner's key) and every other write stay "not yet".
- **Pause everyone's words.** apps/api's pause holds the team's routines and nothing else: a job already running finishes
  and a request keeps its own expiry. The page's canvas words ("stop at the next safe point", "Nothing expires while the
  team is paused") would promise the owner what the API does not do, so `TeamState.holds` says which pause it is and the
  page says "Nam, Pim and Ton run no routines until you resume.", "Jobs already running are not stopped." and "Requests in
  Needs you keep waiting until they expire." for the API's (`pause.ts` `pauseWords`). Practice keeps the canvas's.
- **Offline.** Each shop's record in the kept read holds that shop's own read under its id: its asks, and for a shop the
  person owns its tasks (with each run and the newest draft), schedules, attention items, team and routines, copied field
  by field (since version 5 of the file, from the task list: a task no longer keeps how many entries its log holds, which
  the list does not carry. Version 6 seals the same read. A file of any other version is not read, and the next good read
  writes over it). The viewed shop's work is its record's alone. A record of a shop the person helps at that claims any work, or
  work that is not whole, makes the whole file ignored.
- **Tests.** `owned.test.ts` (the shop whole, its team, its routines, Mission Control, the writes and their refusals, a
  helper's view, offline, and under the app's own store), `work.test.ts` (how a task reads as a job), `mission.test.ts`
  (the signed-in tenant's Mission Control), `screens.test.ts` (every screen as the export showed it, kept in
  `screens.export.json`, now from the list), `shop.test.ts` (the list's pages and cursor, the newest 50, a page that fails),
  `cache.test.ts` (version 6, and every earlier version read as nothing kept), and `serveShops` and `serveShop` in
  `testkit.ts`, which answer the task list as apps/api does (`listedJson`, `taskPage`), an owner's schedules, attention
  items, routines and team writes, and a helper's 403. The API's side is `apps/api/test/task-list.test.ts`. Show older's own tests are in Older tasks, below.

## Older tasks

Built on `feat/show-older` (December item 52): `src/runtime/http/older.ts` (the rules), `shop.ts`, `shops.ts`, `host.ts`, `work.ts`,
and on the pages `src/pages/older.ts`, `ShowOlder.tsx`, `HistoryPage.tsx` and `ActivityPage.tsx`. Before it, a shop with more than its
newest 50 tasks showed only those, and an owner could not reach older ones.

- **Knowing there are more.** The minute's read keeps the cursor it stopped at (`more`, on the shop's work and on the signed-in
  tenant's read): the cursor the second page gave, which is the id of the last task the list looked at, and none when the list ended
  within the 50. A shop of 50 tasks or fewer has none, so nothing is said of older work. `jobs.list` and `activity.list` say
  `older: "more"` while the shop has older tasks than they hold, and `older: "end"` once Show older has read the last page. A list that
  says nothing (Practice's, a shop of 50 tasks or fewer, a read kept from an earlier run) draws nothing.
- **Reading them.** `jobs.older` reads the next page of 25 (`GET /v1/tasks?limit=25&cursor=`) from that cursor with the shop's own owner
  session, or with the sign-in for a person in no shop, as the minute's read does, and adds those tasks to what the lists show, below
  the newest. Pressed again it reads the page after, from the cursor the last page gave. When a page gives none, the lists say `end`,
  and a press after that asks nothing. Two presses at once are one request. A shop the person only helps at lists no tasks, so Show
  older is refused `owner_only` there, with nothing sent.
- **Keeping them** (`older.ts` holds the rules; each is tested alone, and a random walk of making tasks, reading the shop and pressing
  checks that the list stays whole). The pages are kept in memory for each shop while the app runs, so switching shops loses none,
  and they are never written to disk. The cursor is a task's id, so a task made while a person pages moves no cursor. But each
  minute's read holds the newest 50 as of that minute, so a task made pushes the 50th newest out of it, and that task now lies between
  the new read and the older pages. The minute's read takes the tasks it pushes out into the older list (they are already read, so it
  asks the API for nothing), and no task is skipped. A task in both lists shows once, as the newer read has it. A task the shop deleted
  from the newest read is gone, and is not carried. If the new read holds none of the tasks the last one held (50 or more tasks were
  made in between, after a long sleep above all), the tasks between are unread, so the older pages are let go and Show older starts
  again from the new read's cursor: this is the only way the minute's read drops them. A press notes itself before it is sent, so a
  read that lands while its page is on its way carries into the same list, and the page is added only if it starts where the list's
  older tasks end.
- **What is live is only the newest read's.** An older task shows as it was when it was read. It is a job and has its events in the
  activity log, and `jobs.get` opens it. But it makes no member work, it is no job running now (`bots.list`, `team.state`), and it is no
  thread of Buddy's: `thread.list`, `thread.added` and `thread.removed` follow the newest 50 as before, and an ask's words still come
  from the newest read's tasks.
- **When a page cannot be read.** What is shown stays as it was, and the press fails with words that Try again follows: `offline` for
  no network ("Show older needs a connection."), and `unavailable` for a 5xx, an answer that is not JSON, and a 200 that is not a page
  (a `tasks` list and a `next` that is a cursor or null; it is never read as an empty page, or as the end of the list). Any answer that
  is not a page is handled as the minute's read handles it. A 401 gets one new shop session and one resend. A 401 `removed` or
  `unlinked` ends the person's place in the shop (`depart`: the shop leaves, and its asks close in words that say when). A refused
  sign-in signs the person out. Any other refusal, and a 200 that is not a page, has the shop read again, so what changed shows as the
  minute's read shows it. A 400 `invalid_cursor` (the task the cursor named was deleted) also lets the older pages go, so the next
  press starts from the newest read's cursor.
- **Offline.** While only a kept read is shown, Show older is refused `offline` ("Show older needs a connection.") with nothing sent.
  The read shown while the API cannot be reached is this run's last good read, so the older pages already read stay shown, with Show
  older still offered, and are still there when the API answers. The kept read on disk is as it was: the newest 50 (cache version 5,
  6 now that it is sealed), with no cursor and no older task. After a restart with no network the lists therefore say nothing of older work.
- **The screens.** History and the activity log draw one line under their list ("Only the newest work is shown here. There is older
  work.") with a Show older button. Pressing it reads the page and has the page read its list again, so the filters, the search, the
  event picked and the messages shown stay. A press while one is on its way does nothing, and the button keeps its focus. A page that
  could not be read says why in the runtime's own words (as an alert) and offers Try again. Once the list has no more, the line says
  "That is everything. There is no older work." and there is no button. The activity log still draws it when its newest events are
  none, or the filters leave none, since older work may hold some. The words are in en, ko, ja and zh (`older.*`). On the activity
  log, a press also widens the dates when a range of the last days (today, 7 or 30) would hide what it read: the read after the press
  sets the dates from the day of the oldest event the log holds to today, so the older work shows (`widenFor`, `src/pages/activity.ts`).
  A range of the person's own dates stays, and so do the other filters; going back to the last 7 days is a press of its chip. Mission
  Control's jobs are listed in History (a job for each task, with the threads that are not jobs); Home's and a member's Recent work
  show the newest three by design and say nothing of more.
- **Practice.** The demo's lists never say there is more (its sample shop has 6 jobs), so no screen draws Show older there. Its
  `jobs.older` answers `end`, and its sample data is as it was.
- **Tests.** `older.test.ts` (the rules, and the random walk), `older.host.test.ts` (the runtime end to end over a fake API that pages
  as apps/api does: knowing there are more, the next page and the end, one request for two presses, each shop's own session, the pages
  kept through the minute's read, tasks made, deleted, or 50 and more made, a page on its way while a read lands, what is live, every
  way a page can fail, offline, the cache file, and the app's own store), `shop.test.ts` (the cursor, `readTaskPage`),
  `src/pages/older.test.tsx` (the words in four languages, the line and button under History's and the log's lists, each state of the
  press) and `e2e/show-older.spec.ts` (Connected over a stubbed shell: three pages, a walk to the end, a page that fails, the log,
  four languages). `screens.test.ts` and `screens.export.json` are unchanged: a shop of 50 tasks or fewer shows what it showed.
- **Not in this slice.** Older tasks are not Buddy's threads. An older task is not read again until the app restarts or its pages are
  let go. Nothing follows tasks live (the streaming slice). Older pages are never kept for offline use.

## The live feed

Built on `feat/live-feed` (December item 61, 25 Nov 2026) and switched off: `src/runtime/http/feed.ts` (each shop's follower),
`host.ts`, `index.ts` and the app's CSP. The API's half is `apps/api/src/feed.ts` (`docs/pilot-api.md`, "The shop's live feed");
turning it on is the owner's (`docs/turning-on.md`).

- **What it does.** While the API says the feed is on, the host keeps one socket open for each shop the latest read shows, owned
  or helped at, opened with that shop's own session. A ping on any of them moves the next read to a second from now
  (`FEED_DEBOUNCE_MS`), and never sooner than 15 seconds (`FRESH_MS`) after the last read, so the feed never reads more often
  than a screen may. Pings from several shops, or several from one, are one read; a ping that comes while a read is on its way
  gets one more read after it, since that read may have been asked before the change. The read is the minute's read, with each
  shop's own session, so the feed shows nobody anything their sessions could not read, and the minute's timer starts again from
  it. Before the first read and during an outage a ping changes nothing: the host's own retries decide.
- **What a ping carries.** Nothing but that something changed: `{ "v": 1, "seq": n }`. Any other message is ignored, and nothing of
  a message reaches the screens.
- **Asking first.** Before each socket it opens, each shop's follower mints a ticket: `POST /v1/feed/ticket` with exactly `{}` and
  the shop's own session, sent through `shopSessions.write` like every write of the shop's, which opens the session again when it
  has ended. 200 `{ feed: "on", ticket }` opens the socket with that ticket (`ticketOf` takes it only as characters a protocol
  entry may hold). 403 `feature_disabled`, and the 404 of an API from before the feed, are off, and asked again an hour later
  (`FEED_OFF_MS`): a running app takes up a switch turned on within the hour, and at its next start at once. A 401 that ends the
  person's place in the shop ends it as the minute's read does (`depart`). Anything else, a 200 this build cannot read among
  them, is tried again later.
- **The socket.** The page's own `WebSocket`, the only socket the desktop has: macOS's curl (8.7.1) speaks no WebSocket, and the
  shell has no WebSocket crate. A page's WebSocket can send no `Authorization` header, so the ticket goes as one of the
  handshake's protocol entries, `manut-ticket.<ticket>`, beside `manut-feed.v1`, the one protocol the API answers; never in the
  address. A session never goes there: the API's host writes that header into its logs as it is, and a ticket there was spent
  by the socket it opened and is dead 30 seconds after it was minted, so every socket mints its own, a renewal or a try after a
  drop as much as the first. The packaged app's CSP lets the page connect to `wss://manut.xyz` and `wss://*.manut.xyz` and no
  other outside origin (`connect-src` in `src-tauri/tauri.conf.json`, `csp` and `devCsp` alike), so a runtime connected to any
  other origin, a local API among them, has no feed and asks nothing about it (`feedUrl`); `feed.test.ts` keeps the rule and
  the CSP in step.
- **When it drops.** A drop backs off: 2 seconds, doubling each time, up to an hour (`FEED_RETRY_MIN_MS`, `FEED_RETRY_MAX_MS`), so a
  socket that a network or a proxy keeps refusing costs one look an hour. A socket that stayed open a minute (`FEED_STEADY_MS`)
  starts the backoff over. The API closes each socket after its hour (4000), and the next one opens at once after a good run;
  4503 (switched off) waits an hour like an off answer. Every 50 seconds the socket says `ping` (`KEEPALIVE_MS`), which the API's
  runtime answers `pong` without waking the shop's object; no answer in 15 seconds (`PONG_WAIT_MS`) is a drop. The minute's read
  goes on whatever the feed does.
- **Closing.** Signing out, or the API ending the sign-in; the person's place in a shop ending, whichever read, look or answer
  finds it; and the host stopping when its last client lets go, all close the sockets at once. A shop the read no longer shows
  lets its socket go at that read.
- **A person in no shop** is read as their own sign-in's tenant, which is no shop and has no feed: the API answers a person's own
  sign-in 404 there, and the host asks nothing.
- **Unchanged.** Practice, which reaches no network; the offline cache, which keeps nothing of the feed; and every screen's words.
  The feed brings forward the reads the minute's read made and the events they emit, no more: a row of a task already listed still
  changes when its screen reads its list again.
- **Tests.** `feed.test.ts` (each shop's follower over a fake socket and fake timers: the address and the protocols, a fresh
  ticket for every socket, a ping and nothing else, off, the backoff and its cap, a good run starting it over, 4000 and 4503, the
  keepalive, letting shops go, `feedUrl` and the CSP, and what a mint's answer must hold to be a ticket), `feed.host.test.ts`
  (the host over a fake API: a socket for each shop with a ticket its own session minted as a JSON write, no session token in
  any protocol entry, when a ping's read comes, one read for several pings, one more after a read on its way, the session opened
  again, off and missing, a 200 it cannot read, a drop, an origin with no feed, a person in no shop, a ping offline, sign-out,
  the host stopping, a departure found by a read, by an answer and by a look, and a look that ends after the host stopped),
  and `feed.protocols.test.ts` (no file in the repository names the protocol entry that once carried a session). The CSP's
  other directives stay pinned in `src/code/previewFrame.test.ts`. The Connected Playwright specs read the feed's mint as an
  API from before the feed (their fake answers 404); `e2e/memory-routines.spec.ts` leaves it out of the owner's changes it
  lists.

## Customize › Connections

The shop's vault and outposts, for its owner (`src/runtime/http/connections.ts`; the routes are `docs/pilot-api.md`, "The
owner's vault and outposts"; the design is `docs/browser-control.md`, "The owner's Connections").

- **Which session.** `connections.list` reads the shop the switcher shows, with that shop's own session, or the signed-in
  tenant with the sign-in while the person is in no shops. Each change names the shop its row was read for (`shop`,
  null for the signed-in tenant) and goes with that shop's session. A shop the person helps at is refused `owner_only`
  here with nothing sent, and nothing is sent while only a kept read is shown (`offline`). The API answers a person's own
  sign-in 404 `not_found` on the vault routes (24 Nov 2026: a vault is a pilot shop's), which these ops read as
  `no_shop` (`conn.err.noShop`), and `registerThisMac` as `no_shop` (`outpost.err.noShop`).
- **The password** crosses once, a new sign-in's (`connections.add`) as a new password, and as one typed again with a
  change (`connections.change`): the same session reads the sign-ins first, so it is one that works, the shop still has
  the sign-in a new password or a change is for (`sign_in_not_found` otherwise, with nothing sent), and the vault has room
  for a new one (`too_many_sign_ins` at 50, with nothing sent); then one send with no second try after a 401
  (`ApiSession.writeOnce`, or the shop's session as it is held), which answers `not_saved` and asks the owner to type it
  again. What the vault would not take is refused here first: a password empty or over 1,024 characters, and for a new
  sign-in its name, its addresses, its account or its members, by the vault's own rules said once in
  `src/runtime/connections.ts` (`newSignInRefusal`), which Practice keeps too.
- **Who may use a sign-in** (`connections.members`) carries no secret, so it goes as every other change does; members the
  vault would not take (none, a repeat, anyone but Nam, Pim, Ton and Kit) are refused here first.
- **A sign-in's account or addresses** (`connections.change`) sends exactly `{ signInId, origins, username, password }`, the
  password typed again or null. The vault's rule is said once in `src/runtime/connections.ts` (`signInChangeRefusal`) and
  kept here and in Practice: the values by adding's rules first, with nothing read; then, against the account and
  addresses the read lists, `no_change` for the same ones and `password_required` for anything but addresses taken away
  with no password typed, each with nothing sent. A change with no password carries no secret and goes as every other
  change does. The page sends a new password alone, with the account and addresses as they were, as `connections.password`.
- **Removing a sign-in** (`connections.removeSignIn`) carries no secret and goes as every other change does, after the
  page asked the owner in the sign-in's row; it answers the id removed, and `sign_in_not_found` for one already gone.
- **What the tab is shown.** Each sign-in with its account and its sites' addresses (for Remove's question and Change's
  fields; the row itself shows the canvas's lines only), and each outpost, times in seconds; an entry this build cannot
  read whole, an account or an address included, is left out. The page keeps none of it in the store or the kept read: the
  tab asks through a client of the runtime of its own (`src/pages/ConnectionsPane.tsx`).
- **This Mac's own record.** The shell's view of this Mac for the shop shown (`outpost_status`) carries the id its outpost
  has on the shop's list, only when this Mac is that shop's outpost, and never its credential. The tab folds that record
  into this Mac's row (its name, Rename and Remove) and leaves it out of the shop's list; with no id, or an id the list
  does not have, every outpost is listed.

## Customize › Memory and routines

What the team knows, and making and removing its routines, for their owner (`src/runtime/http/memory.ts` for the facts, `host.ts` for
the routines, beside pause and resume; the routes are `docs/pilot-api.md`, "Memory" and "Routines"; the page is
`src/pages/CustomizePage.tsx`, its rules `memory.ts` and `routines.ts` there). The ops are in `src/runtime/memory.ts` and
`src/runtime/routines.ts`: `memory.list`, `memory.remember`, `memory.confirm`, `memory.correct`, `memory.forget`, `routine.list`,
`routine.create`, `routine.pause`, `routine.resume` and `routine.remove` (new: the page, the store and Practice had no way to
remove a routine).

- **Which session.** `memory.list` and `routine.list` read the shop the switcher shows, with that shop's own owner session, and say
  which shop they read (`shop`; null for a person in no shops). Each change names the shop its list was read for and goes with that
  shop's session, never the one the switcher shows by then. An op that names none is refused, never read as the shop viewed. The
  page reads both halves again when the switcher shows another shop, and does not put a change's answer on a page that shows
  another shop by then (the change itself went to the shop it named).
- **Owner only.** A shop the person only helps at is refused `owner_only` with nothing sent, for the lists as well as the changes,
  as the API refuses a helper's session ("Only Noi can see and change the team at Ran Pa Noi."; for what the team knows, "Only the
  shop's owner sees and changes what the team knows."); the page says so in place of the list, so a helper is not offered a form it
  could only be refused. A shop that is not theirs is `not_found`. A person in no shops has none: the API answers their own
  sign-in 404, so `memory.list`, a fact's four changes, `routine.create` and `routine.remove` say `no_shop` ("No shop is linked to
  your account yet, ...") and send nothing. Their own sign-in's schedules are still listed as routines, shown and never changed:
  pausing one is still "not yet".
- **While offline.** With only a kept read shown, nothing is sent: every change is refused `offline`, and so is `memory.list`,
  since the kept read holds none of what the team knows. `routine.list` still lists the kept read's routines.
- **What a fact's change sends.** Exactly what each route reads and nothing more: `{ text }` to `POST /v1/memory/remember`, `{ id }` to
  `/confirm`, `{ id, text }` to `/correct`, `{ id }` to `/forget`, with the words trimmed. Never a `shop`, `tenant` or `role`, which
  the API refuses. What the API would refuse is refused here first, by rules said once beside the protocol (`src/runtime/memory.ts`):
  words that cannot be a fact (empty, only spaces, over 280 characters, Thai counted as letters) are `invalid_text`, said by
  asking `@manut/shop-memory` itself (its `remember` on an empty memory), and an id that is not 1 to 64 characters is a fact that is
  gone (`not_found`). The answer is read field by field: it must be a whole fact, and the one asked about, or the change is
  `unavailable`, never taken as done. Forget's answer names the fact and holds none of it.
- **What a routine's change sends.** `POST /v1/routines` with exactly `{ name, action, trigger }` (the name trimmed, the timing with
  only the fields of its kind), and `asksFirst` only when it was said. It sends no time zone and no member: the API's own apply, the
  shop's Asia/Bangkok, Nam for a reply and Ton for the rest. The shape is checked first, with nothing sent, by `newRoutineRefusal`
  (`src/runtime/routines.ts`), which asks `@manut/routine-rules` itself (a routine that replies, sends, pays or deletes and says it
  need not ask is `must_ask_first`, never quietly changed), and refuses an `asksFirst` that is not true or false as the API does
  (`invalid_request`). `POST /v1/routines/remove` is exactly `{ routineId }`, only for a routine the read lists for that shop, never
  for a schedule of the shop's own. A new routine is listed at once, switched on, and the shop is read again.
- **Whose clock a routine's time is on** (item 70). A routine keeps a time zone of its own (the shop's, Asia/Bangkok unless the API
  was told another), so "Every day at 09:00" is 09:00 there. Wherever the app writes a routine's time or next run it now names that
  zone, "Every day at 09:00 (Bangkok time)", whenever the zone is not this computer's clock, and adds nothing otherwise, so a shop owner
  in Thailand on a Mac set to Bangkok time sees what they saw before. `src/lib/zone.ts` is the one place: `zoneNote`, `withZone` and
  `zoneName`. The computer's zone is read with `Intl` (`computerZone`), and a test pins it with `pinComputerZone` (`src/testSetup.ts`
  pins Bangkok before every test, so no test depends on the machine). Two zones are the same when they show the same offset from UTC at
  thirteen points across a year, so Asia/Calcutta equals Asia/Kolkata and a zone that only shares today's offset does not count. A zone is
  named by its city and "time" ("New York time"), or by its offset ("GMT+5:30") when it has no city (an offset zone, UTC, Etc/GMT-7). A next
  run stays on the routine's own calendar, with the zone named, so its day is the day there. The places: Customize's routines
  (`whenLine` and `nextLine` in `src/pages/routines.ts`; Practice and Connected), and, for the Connected shop's routines and schedules,
  the Automations page (`scheduleLine` in `src/pages/watch.ts`) and a member's Schedule tab and details panel (`cadence`), through
  `Routine.time_zone`, which a job that runs on this computer's own clock does not have. Those two show a next run on the computer's
  clock, which needs no zone. Words with no clock time ("When stock drops under 5") gain none. Tests: `src/lib/zone.test.ts`,
  `routines.test.ts`, `watch.test.ts`, `CustomizePage.test.tsx`, and `view.test.ts` and `owned.test.ts` for the field.
- **Refusals in words** (en, ko, ja and zh; Thai waits):

  | The API answered | Words |
  | --- | --- |
  | 409 `already_known` | "Your team already knows this." |
  | 400 `invalid_text` | "Say it in 1 to 280 characters." |
  | 409 `full` (memory) | "Your team already holds 200 facts. Forget one first." |
  | 404 `not_found` (a fact) | "That fact is gone already." |
  | 403 `owner_only` | the owner-only words above |
  | 400 `invalid_name`, `invalid_weekdays`, `invalid_time`, `invalid_day`, `invalid_window`, `invalid_threshold` | the form's own words ("Say what it does in a short sentence.", "Pick at least one day.", ...) |
  | 400 `invalid_action`, `invalid_trigger`, `invalid_time_zone` | "That kind of work is not something a routine can do.", "Say when it should run.", "That is not a time zone this app knows." |
  | 400 `must_ask_first` | "A routine like this always asks you first, so it cannot be set to run without asking." |
  | 400 `unknown_member`, `wrong_member` | "That team member does not do this kind of work." |
  | 409 `full` (routines) | "Your team already has 50 routines, the most it keeps. Remove one first." |
  | 404 `not_found` (a routine, or a shop the API has no record of) | "That is not in this shop any more." |
  | 400 `invalid_request`, `invalid_json`, 413 `body_too_large`, 405, `forgotten`, `invalid_source`, any other code | "The API did not make this change, so nothing changed." |
  | no answer, a 5xx (`memory_unavailable`, `routines_unavailable`, `clock_unavailable`, `shop_unavailable`) | "No reply from the API. Checking whether it changed." |
  | 200 with an answer this build cannot read | "The answer was not one this version of the app can read, so it is not shown as done. Checking whether it changed." |

  A read that failed says "What your team knows did not load. Try again." or, for an answer it cannot read whole, "The answer was not
  one this version of the app can read, so nothing is shown.": one fact it cannot read makes the whole list unreadable, since half of
  what the team knows is never shown as all of it.
- **A change that got no answer** (offline, too slow, a 5xx) is never sent again from here, as for pause: the API may have it. The
  host waits for the read that follows before it says so, and the page then reads its list again (without blanking it), so the list
  the owner sees is how things stand. A 401 is the one case that is sent again, as for every shop request: the API answers it
  from the session before it reads the body.
- **What the form offers.** The New routine form offers the kinds of work brief, draft, reply and send (the API also takes pay and
  delete, which the form has never offered), at every kind of time the API takes: every day, chosen days, a day of the month, a window,
  and stock. Each is taken by the API's own rules; a test makes every pair through the fake API and reads `apps/api/src/routine-setup.ts`
  as text to pin who does which kind of work. The API takes a stock routine but gives it no clock, since there is no stock feed (the
  routine says `waitsFor: "stock_feed"`), so it waits and never runs. The form says so plainly, under the stock number: "Stock levels
  are not connected yet, so this routine waits and does not run." The same test fails when the API stops saying it, so the note goes
  with the missing feed. The form sends no time zone, so a time of day means the shop's own (Asia/Bangkok), and a routine's next run
  is read in its own zone.
- **Nothing is kept.** What the team knows is read when the page asks and held in the page's state only: not in the shop's read, the
  offline cache (a plain file; what the team knows can hold the owner's costs and suppliers), an event or an error's words. Routines
  are read with the shop as before, and a created or removed one is shown at once and read again.
- **Practice** answers the same ten ops with `@manut/shop-memory` and `@manut/routine-rules` themselves (`src/runtime/mock/host.ts`):
  the shop its ops name must be the person's own sample shop or one they made (a made shop shows the demo team), Ran Pa Noi, where
  they help, is refused `owner_only` in words, a team keeps at most 50 routines, and it removes a routine for good.
- **Tests.** `src/runtime/http/memory.test.ts` and `routines.test.ts` (each op's request, every refusal and its words, a helper's shop,
  offline, the shop a change names, no resend after no answer, an answer it cannot read), `owned.test.ts` (pause and resume naming
  their shop), `src/runtime/rules.test.ts` (the shared rules), the Practice tests, the pages' tests (the Remove question, the stock
  note, the shop each call names), and `e2e/memory-routines.spec.ts` (Practice, and Connected over a stubbed shell, in four languages
  and three sizes).

## Settings › People

Who can use Manut AI for the shop, for its owner (`src/runtime/http/people.ts`; the routes are `docs/pilot-api.md`, "The owner's
own routes"; the rules are `docs/people.md`). It is a page of Settings, under Shop (`src/pages/PeoplePane.tsx`,
`src/pages/people.ts`), with six ops (`src/runtime/people.ts`).

- **Which session.** `people.list` reads the shop the switcher shows, with that shop's own owner session. Each change names the
  shop its list was read for (`shop`) and goes with that shop's session, never the shop the switcher shows by then. A shop the
  person helps at is refused `owner_only` here with nothing sent, so a helper's session never carries a name, a LINE ID or an
  email to the API, and the page says whose people they are without asking. A person in no shops has none to manage: the API
  answers a person's own sign-in 404 (People exist for pilot shops), so `people.list` says `no_shop` and nothing is sent. Nothing
  is sent either while only a kept read is shown (`offline`).
- **What a change sends.** Exactly what each route reads and nothing more: `{ name, identity }` with the identity exactly
  `{ kind: "line", id }` or `{ kind: "email", address }`; `{ inviteId }`; `{ helperId }`; `{ helperId, until }` with `until`
  as an ISO time (the page makes it the end of the chosen day on this computer's calendar); and `{}`. A name the shop's record
  would not keep (empty, over 80 characters, a control character) and an account the rules would not take are refused here
  first, with nothing sent; whether a cover's day is in the future is the API's to say (`bad_date`), by its clock.
- **What the page is shown.** The owner, each helper and each invite that waits or ran out, field by field; an entry this build
  cannot read is left out, and an answer that is not a people list is `unavailable`. An answer to a change that this build cannot
  read (an invite with no readable status, a removal with no counts) is `unavailable` too, never done. The invite's link is
  `inviteUrl`, shown only if it is an http or https address. Every 5xx reaches the runtime as no answer, because the session keeps
  no body for one, so `not_configured` (an invite link cannot be made) and `people_unavailable` are both said as "No reply from the
  API. Checking whether it changed.", and the page reads the list again to see.
- **Nothing is kept.** The page asks through a client of the runtime of its own (`usePeople`), as Connections does, so the helpers'
  names and accounts and the invite links are in the page's state only: not the store, the kept read of the shop, an event or a
  log. On the loopback bridge the Playwright suite uses (which logs what it is sent, and has no people), Settings has no People.
- **Practice** answers the same six ops with `@manut/people-rules` itself (`src/runtime/mock/people.ts`), so its rules are the
  shop's: the canvas's Fon, Mint and Beam, an invite for one account at a time, removal ending sessions, invites and cover, and
  cover until a day that has not passed. Its invite links end in `.invalid`, which can never be a real address.

## Signing in

### What the lifted sign-in supports today

`apps/api` has the sign-in GoSpark had (`src/auth.ts`, `src/auth-object.ts`), and only that:

- `POST /v1/auth/exchange` with `{ provider: "apple", identityToken, nonce, deviceId }`: a Sign in with Apple identity
  token, the raw nonce whose SHA-256 the token's `nonce` claim carries, and a device id. It answers
  `{ accessToken, refreshToken, csrf, expiresIn: 3600, tenant }`. Each identity token works once. The tenant is
  `apple:<subject>`.
- `POST /v1/auth/refresh` with `{ refreshToken, deviceId }` rotates both tokens. The refresh grant lasts 30 days from
  its last use and 90 days at most from the first sign-in (`session_expired`).
- `DELETE /v1/auth/session` with the access token ends the session.
- One behaviour shapes the client: when a request carries an expired access token, the API's verify step deletes the
  refresh grant as well. So the desktop refreshes five minutes before expiry and never sends an expired token.

The `csrf` token is only for company-console writes, which this runtime never makes, so it is not kept.

### What the desktop does (`src/runtime/http/session.ts`)

- Sign in: the exchange above with a new random device id; the session goes into the keychain.
- Every read sends the access token. Five minutes before it expires the session is refreshed first. Refreshes run one
  at a time, because each one rotates both tokens and a second would spend the same refresh token and end the session.
  A 401 gets one refresh and one retry; a second 401, or a refresh the API refuses, ends the session here and clears the
  keychain item.
- Sign out: `DELETE /v1/auth/session`, with `POST /v1/shops/session/end` for each shop session held (Several shops,
  below), then the keychain item is cleared whatever the API said. When the API could not be told, Settings says so; the
  session then ends on its own.
- A new sign-in first ends the session the keychain held, including another origin's (on that origin's own API), so
  replacing the one keychain item never leaves a live session behind.

### The smallest honest path, and what it cannot do yet

The desktop cannot get an Apple identity token by itself, and no deployed environment can exchange one: `dev` has no
`APPLE_CLIENT_ID`, so its exchange answers `400 identity_not_configured`. Settings › Developer therefore takes an
identity token and its nonce by hand. Everything after that is the real path. It works today against a local API that
trusts the backend's committed test key:

1. In `apps/api/.dev.vars` (ignored by git), set `TEST_JWKS_JSON` to the test key set in `apps/api/wrangler.test.json`.
   To create tasks and schedules to read, also set `OFFICE_CLOUD=1` and `OFFICE_ROUTINES=1`; `OFFICE_INBOUND=1` turns
   the attention feed on. Then `pnpm --filter @manut/api dev`.
2. Mint an identity token the way `mintIdentity` in `apps/api/test/auth.test.ts` does: ES256 with the test key `kid
   test-key-1`, `iss` `https://appleid.apple.com`, `aud` `test-client`, any `sub`, an `exp` in the future, and `nonce`
   the SHA-256 hex of a raw nonce you choose.
3. In Settings › Developer choose Connected, save `http://localhost:8787`, paste the token and the raw nonce, sign in,
   and restart.

The other way in is a code sent by email, which Settings › Developer takes too (`docs/sign-in-options.md`, "The desktop"):
the API has it switched off in every environment, so the screen says it isn't on yet, and in Practice it runs on a
pretend code. The session it makes is kept and refreshed as an Apple one is.

The signed-in tenant is the identity's own (`apple:<subject>`, or `email:` and a hash of the address), so it starts empty. A pilot shop is a tenant of its own
(`pilot:<uuid>`), and `apps/api/src/pilot.ts` says no session can ever carry such a tenant. So even signed in, the
desktop cannot read a pilot shop's work until the API links an owner's identity to a shop (an API ask below).

### What a shop owner on a Mac would actually do

- Today: nothing on the desktop. Owners have no accounts in week 1; they approve each reply from a signed link on LINE
  (`docs/decisions.md`).
- The intended path is a Sign in with Apple button in the app: the system sheet with Touch ID gives an identity token
  and nonce, and the same exchange runs. It needs, from the owner, an Apple developer team, the App ID
  `xyz.manut.desktop` with the Sign in with Apple capability, builds signed with that team (today's are ad-hoc), and
  `APPLE_CLIENT_ID=xyz.manut.desktop` on the Worker; and, in the app, a small native bridge to AuthenticationServices.
- Thai shop owners live in LINE, so LINE Login would be the friendlier sign-in. That is a second provider in
  `/v1/auth/exchange` (LINE's ID token is a signed JWT with its own key set), plus the link from a signed-in owner to
  their shop.

## Where the tokens live

- In the operating system's keychain, one generic password item (service `xyz.manut.desktop.api`, account `session`),
  holding `{ v, origin, tenant, deviceId, accessToken, refreshToken, accessExpiresAt, signedInAt, shops }` as JSON, where
  `shops` is each shop session by shop id: `{ role, accessToken, expiresAt }` (version 2; a value of version 1, which
  has no `shops`, is read as one with none, and nothing is written for it until something changes). Every write to the
  item, a refresh's new tokens or a shop session kept or dropped, takes its turn and writes what is held at that moment,
  so a refresh never writes back a shop list that a later change replaced, and nothing written after a sign-out brings the
  item back. The shell's
  `api_session_read`, `api_session_write` and `api_session_clear` commands (`apps/desktop/src-tauri/src/api_link.rs`)
  are the only way to it, and the page cannot name any other item. The app makes the item, so macOS lets it read the
  item without asking and asks the person before any other program reads it. Ad-hoc signed development builds change
  signature on each build, so macOS may ask once after a rebuild. A second item beside it (account `outpost`) holds this
  Mac's outpost and its credential (`docs/browser-control.md`); only the shell reads it, and no command gives it to the
  page. The page does not even learn which shop it is for: it tells the shell which shops it acts for as owner, and the
  shell decides (Several shops, above). It learns only the outpost's id, for the shop it asks about. A third item (account
  `shop-cache-key`) holds the key the offline cache is sealed with (The offline cache, below), 64 hex digits; the page is
  handed it, as it is handed the session, and imports it at once as a key script cannot read back.
- In memory, in the page's one `ApiSession` per origin, while the app runs.
- Never in localStorage (which holds only `manut.runtime`), a log, an address, or a command line. A session is never
  sent to any origin but its own.
- Never in the offline cache's file either: it holds what the screens read of the shop and nothing from the session, and
  that sealed (see Offline).
- macOS only for now. On Windows and Linux the keychain commands answer `unavailable`, Settings says "This computer
  cannot keep a session yet", and Connected cannot sign in; nor is any offline copy kept there. The crates either would use are already in the build
  (`windows-sys` for Windows' Credential Manager, `zbus` for Linux's Secret Service); the code is not written.

## How requests reach the API

The webview's own `fetch` cannot be used: the API's session routes answer no CORS, on purpose, and the packaged app's
content security policy allows no outside origin. The fork reaches the outside through programs the shell runs (`gh`
for GitHub), so the shell's `api_request` command runs the system's `curl`, which adds no HTTP library:

- The request (address, method, token, body) goes to curl on its standard input as a config file, so no token is on a
  command line. `-q` keeps the person's `.curlrc` out; `SSLKEYLOGFILE` is removed from curl's environment; curl runs by
  its full system path (`/usr/bin/curl`), so a `curl` earlier on PATH never sees a token.
- The shell itself allows only an https origin or plain http on this computer, only `/v1/` paths with no `..` or `//`,
  only GET, POST and DELETE, a bearer token of the API's own characters, and a body of at most 256 KiB. Redirects are not
  followed. curl gets 10 seconds to connect and 30 in all.
- The page learns the status and the body, or `offline` (curl could not reach the host) or `failed`. Nothing else
  crosses, so curl's own messages, which could carry an address, stay in the shell.

## Offline, and other failures

The shared host's link is one of: connecting, open, signed out, offline, unavailable. Open is a live read of the API.
A runtime with nothing to show in any other state is closed to the store, which marks its chats stale and ends any turn
it was showing, and reads everything again when the runtime opens: after an outage nothing is replayed, the app's own
re-read brings it back, except that an ask which stopped waiting meanwhile is closed in Needs you (the store keeps the ask
cards it already has). With a kept read (below), offline and unavailable keep the runtime open instead.

- Offline (no network, no such host, nothing listening, too slow): the mode line says "Offline", the host tries again
  after 2 seconds, doubling up to a minute, and, with nothing kept to show, requests are refused with a translated
  "Offline: the Manut AI API cannot be reached.".
- Unavailable (a 5xx, an answer that is not JSON, any 4xx on a read the runtime needs): the same, as "Not answering".
- Signed out (no session, or the API ended it): the host waits until someone signs in in Settings, then reads at once;
  no restart is needed for that. Nothing is shown and nothing is kept (the saved read is deleted).

### The offline cache

Built. When a read fails because the API is offline or not answering, the app shows the last good read of the shop
instead of an empty screen, and says so (`src/runtime/http/cache.ts`, `host.ts`, `shop_cache.rs`).

- **What is kept.** After every good read, the minute's poll included: the tasks with their actions, the requests
  waiting for an answer (so what waits for the owner; approval-core's wire JSON, since version 2 of the file), the schedules,
  the inbound attention items, whether that feed is off, and the time of the read, copied field by field as the runtime
  already decodes them. The API's whole objects and the entries it could not read are left
  out. Never an older task or the cursor Show older reads from (Older tasks, below): the file keeps the newest 50 as it did.
  Never a token, a refresh token, the device id or anything else from the keychain, and not the origin or the tenant
  either: the file's name is the only link to them. It does hold the shop's own words: task titles, the exact words of
  replies waiting for the owner and the LINE ids they go to, and schedule prompts. So the file is sealed (below), and the
  owner's alone (0600) as well.
- **Sealed.** Since version 6 the page writes the read sealed with AES-GCM (`src/runtime/http/seal.ts`), under a random
  256-bit key that only the keychain holds: one more item beside the session (account `shop-cache-key`), made by the
  shell from the system's random source (`SecRandomCopyBytes`) the first time a read is kept (`shop_cache_key.rs`,
  `shop_cache_seal_key`), never on a look, and never in a file or a log. Every write has a fresh random 96-bit nonce and
  GCM's 128-bit tag; the version, the origin and the tenant are bound in as associated data, so a file opens only as the
  version and the shop it was written for, even with the key. The file is one line that says its version before anything
  is opened: `{"v":6,"iv":"<16 base64url>","sealed":"<base64url>"}`; its shape is checked whole, with no JSON parser, so a
  file that is not one is never parsed. The page seals with the webview's Web Crypto, a public standard, where
  CommonCrypto's AES-GCM is private interface; it is handed the key as it is handed the session, imports it at once as a
  key script cannot read back, and asks for it once a run. The packaged page (`tauri://localhost`) is a secure context
  with `crypto.subtle`, checked on this Mac in a throwaway Tauri program on the app's Tauri and CSP; so is the development
  server's `http://localhost`. A file that does not open (changed, cut short, of another version, sealed with another key
  or for another shop) is deleted at the look that found it, and with no key in the keychain whatever is on disk is
  deleted without being read: version 5's plain file goes the first time the upgraded app looks during an outage, or is
  written over by the first good read. A keychain that refuses (locked, a denied prompt) keeps and deletes nothing that
  time. On a computer with no keychain (Windows and Linux today) no copy is kept at all, a file found is deleted, and while
  the API cannot be reached the line says "Offline. This computer cannot keep a saved copy yet, so none is shown"
  ("Not answering. …"); during an outage the run's last read in memory still stands in.
- **Where.** `~/.manut/shop-cache/<key>.json`, one file for the one sign-in. With several shops (since version 3 of the
  file), every shop's record in it is under that shop's id, with its name, owner and the person's role, so a shop's asks
  are only ever read back as that shop's (each owned shop's work too, A shop the person owns, above); the shell needs no
  change, since it keeps one file per sign-in and removes any other. The current version is 6 (5's read, sealed), and a file of
  any other is not opened: it is deleted (Sealed, above). A file written while the person was in no shop is the signed-in tenant's own. The key is the SHA-256, in hex, of the
  origin and the tenant, made by the page (`cacheKey`, with a small synchronous SHA-256 in `sha256.ts`, because the Web
  Crypto digest is asynchronous and exists only in a secure context); the shell accepts nothing but 64 hex digits as a
  name, never a path. It is written to a temporary file and renamed, so a crash never leaves half a file; at most 11 MiB of
  sealed text, which holds a read of up to 8 MiB; never through a link; and writing one shop's file removes any other's.
  Three shell commands do it (`shop_cache_write`, `shop_cache_read`, `shop_cache_clear`) and two more give and delete the
  key (`shop_cache_seal_key`, `shop_cache_seal_key_clear`), reached only through `shellCacheStore` in `shell.ts`, and nothing
  there ever raises: a disk that refuses is a cache that is empty. Calls to it run one at a time, in order.
- **When it is shown.** On a failed read (offline or unavailable) the host answers every screen from the last good read of
  this run, else from the file an earlier run kept, looked at once for the outage (an app that starts with no network).
  The runtime stays open, so the screens show it; no request is made per screen, and the host keeps trying as above. The
  line reads "Offline. Showing what was here at 14:05" ("Not answering. Showing what was here at 14:05" for an API that
  answers 5xx), with the day first for a read from another day ("Nov 22 14:05"). Buddy's row, Needs you, Home, History
  and Automations show the read as it was, which is what "at 14:05" qualifies. When the API answers again the host reads,
  replaces the cache with the new read, and the runtime closes and opens once, so the store reads everything again; an
  ask the kept read showed that is not waiting now (decided or expired meanwhile, or its task gone) is closed in Needs you.
- **Asks and writes.** An ask from the kept read is shown with its exact action in Needs you, Home and Buddy's chat, but
  cannot be answered: answering needs the live record. The chat card's answers are greyed out and it says "Connect to
  answer this", and the runtime refuses `approval.respond` with that same message, so Home's Approve, which is not greyed
  out, is refused with the same words when it is pressed. Every other write is refused with the offline message. No write
  is ever queued or sent later; when the app is back online it reads again, and the person does it again. An ask whose
  expiry passes while offline still shows as it was at the time of the read.
- **7 days.** A read more than 7 days old, counted from when it was read, is not shown: the line says "Offline. The saved
  copy is more than 7 days old, so it is not shown" and the runtime is closed, as with nothing kept. A read that was
  showing stops showing when it reaches 7 days. A file that is damaged, from another version of the app, for another
  origin or tenant, or dated more than 5 minutes ahead of this computer's clock is ignored as if none were kept, and one
  bad entry ignores the whole file: half a shop is never shown as the whole one. Such a file stays until the next good read
  writes over it; one that does not open goes at once (Sealed, above).
- **Never how it left.** How a request that left the open approvals was settled (When nobody here answered it, above) is read when it
  leaves and shown on the card; it is kept nowhere, so the file holds what it held before and its version did not change for it.
- **Forgotten.** Signing out in Settings, a session the API ends, a new sign-in over another session (this origin's or
  another's), and saving Practice or another origin in Settings › Developer all delete the file, and then the key it was
  sealed with, even when the disk refuses to remove the file: a copy of it that outlived the forgetting (a backup, a sync
  folder) can never be opened. The next read kept makes a new key.
- **Tests.** `seal.test.ts` (the format, a fresh nonce for every write, a changed byte, a file cut short, another key,
  another version, origin or tenant, no word of the shop in the file, the key that cannot be read back, and the clock-driven
  tests' stand-in held to Web Crypto byte for byte), `cache.test.ts` (what is kept, and the key's life: made at the first read
  kept, deleted with the file, a file that does not open deleted, version 5's deleted unread, no keychain, a keychain that
  refuses), `offline.test.ts` (the runtime over all of it), `shell.test.ts` (the five commands), `shop_cache_key.rs`'s tests
  on a throwaway keychain, and `e2e/cache-sealed.ts` in Chromium and in WebKit (the browser's own Web Crypto, and a restart
  with no network). A read that is on its
  way when the person signs out is not kept afterwards. After the saved choice moves away from the origin the page runs,
  it goes on reading until the next start but keeps nothing more, so the deletion is not undone. Practice never reads the
  cache: its runtime reaches no command of the shell.

## Next slices

1. **Answering approvals: built** (above), through the decide route for a session and approval-core's settle-once
   rules, never a second way round.
2. **Streaming events: the live feed is built, and switched off** (The live feed, above; `docs/pilot-api.md`, "The shop's
   live feed"; December item 61): a tenant-wide feed of pings over a WebSocket each shop's object holds, so a change shows
   within seconds; it brings the one-minute re-read forward and leaves it running underneath. Turning it on is the owner's
   (`docs/turning-on.md`). What it leaves for later: a task's row changing live (the store follows `thread.added` and
   `thread.removed` only, so a row of a task already listed changes when its screen reads its list again); reading only the
   shop that pinged rather than every shop; and the relay, once the owner turns it on (gate G3), as another way to carry the
   same pings.
3. **Asks of the API**, none built here: a way for Pause everyone to stop a job already running, and for a request to wait
   while the team is paused, if the owner wants the canvas's pause; a way to link an owner's identity to their shop; `APPLE_CLIENT_ID` on dev, or a LINE Login
   provider; a tenant-wide event feed (built since: the live feed); and a helper's name with a decision (so "Already decided by Mint" does not depend on
   a note she passed on). A way to say how a request that left on its own was decided is built (When nobody here answered it, above:
   `GET /v1/approvals?state=recent` read when an ask leaves, at one more request). So is the index of a shop's open requests
   this list asked for: the API's approval lookup (December item 48, `docs/pilot-api.md`, "How the shop's approvals are
   found"), so `GET /v1/approvals?state=open` reads only the tasks that may hold an open request, and `state=recent` costs a
   few more reads, not a walk of every task.
4. **Asks of the desktop:** the Sign in with Apple button; keychain support on Windows and Linux; a helper's own session on the desktop. (A note a helper passed on with its
   request is drawn on the owner's card, "Passed on by Mint" and the note, and on the helper's as "Passed on to Noi":
   `shopAskLines` in `src/lib/shops.ts`, drawn by `chat/cards/Cards.slot.tsx`.) (Older tasks than the newest 50, which a screen asks for with Show older, are
   built: Older tasks, above. What it leaves for later is at the end of that section.)

## Undoing it

To take only the live feed out: drop `feed`, `feeds`, `timerAt`, `pinged`, `readBy`, `onFeedPing` and `lookAtFeed` in `host.ts`
(`schedule` and `clearTimer` then set no due time), `src/runtime/http/feed.ts` with `feed.test.ts` and `feed.host.test.ts`,
`FakeSocket` and `socketOpener` in `testkit.ts`, `pageSocket` in `index.ts`, and `wss://manut.xyz wss://*.manut.xyz` from
`connect-src` in `src-tauri/tauri.conf.json` (both entries) with the pins in `src/code/previewFrame.test.ts`. With the switch
off nothing needs taking out: every look reads off and no socket opens.

To take only how a card closes when nobody here answered it out: drop `closeFromRecent`, `readRecent`, `settledClosings`, `emitClosing`
and `keepClosing` in `host.ts` (the answer paths set `closings` as they did: only for an answer the API refused with a closing), the
`over` of `leftHow` and `leftShopHow` and the `Unsettled`, `Gone` and `Recent` types, `LEFT_READ_MS` and the `forgotten` counter,
`decided.ts` with `decided.test.ts` and `decided.host.test.ts`, the `rt.how.*` words, and the `recent` list of the fake API in
`testkit.ts` (`settledJson`, `approvalsListing`'s second list); `runtime.test.ts` then expects the closing before the changes again.
`AnswerContext.owner` and `whoDecided`'s `owner` may stay: they are what makes a helper's refused answer name the owner, and `answerAtShop`
gives it.

To take only the seal on the offline cache out (December item 60): remove `src/runtime/http/seal.ts` with `seal.test.ts`;
in `cache.ts` make `keep` write `encodeSnapshot` and `load` read `decodeCached` straight from the store again, and drop
`sealFile`, `openFile`, `key`, `sealing`, `NoKeychain`, `sealKey`, `dropSealKey` and the `unkept` read, with `CACHE_VERSION` 5
again (every sealed file then reads as another version's and the next good read writes a plain one); drop the same two calls
from `shellCacheStore` (`shell.ts`), `UNKEPT` from `host.ts`, the `unkept` line from `modeLine` (`link.ts`) and the
`mode.unkept*` keys; in the shell remove `shop_cache_key.rs` and the `shop_cache_seal_key` and `shop_cache_seal_key_clear`
commands in `lib.rs`, and give `MAX_BYTES` its 8 MiB; in the tests, remove `microtaskCrypto`, `useMicrotaskCrypto`,
`sealedFile`, `openedFile` and `keptPlain` from `testkit.ts` and look at the files' text as it is. A key the keychain
already holds stays there, unused, until someone deletes the item.

To take only the answering out: make `approval.respond` `notYet` again in `host.ts` and remove `answer`, `refresh`,
`closings` and `leftHow` there, `src/runtime/http/answer.ts` with its tests, `ApiSession.write` and the `removed` rule
in `session.ts`, `answering.test.ts`, the `note` of `prompt.expired` and the card's `expiredNote`, and the `rt.no.*`,
`rt.decided.*` and `rt.ask.*` keys. To read the asks from the export again as well: restore `pendingAsks` and `needs`
from the actions in `view.ts`, remove `src/runtime/http/approvals.ts`, the fourth read in `shop.ts`, the requests in the
cache (version 1 again), the `outdated` field (protocol, store, card) and `rt.updateToAnswer`, and the
`@manut/approval-core` dependency.

To take only several shops out: drop `readAll` and `depart` in `host.ts` (each read is `readShop` again), with
`src/runtime/http/shops.ts`, the `shops` of the keychain value (session.ts; version 1 again), the `shops` and `viewing`
of a read and of the cache file (version 2 again), the shop asks in `view.ts` and `approvals.ts`, the protocol's `shop`,
`asked_at`, `pass_on`, `passed_on`, `approval.pass_on`, `shops.list`, `shops.switch` and `shops.update`, the store's
`shops`, the switcher (`ShopSwitcher.tsx` and its place in `Sidebar.tsx`), the card's shop lines, the Practice shops
(`src/runtime/mock/shops.ts`), and the `shops.`, `card.pass*`, `card.askOwner`, `rt.only.*`, `rt.pass.*` and
`note.atShop` keys.

To take only the whole owned shop out (A shop the person owns): drop the export and routines reads in `shops.ts`
(`readShop`, `workOf`, `SHOP_EXPORT`, `TEAM_ROUTINES`) so a shop reads its asks only, `decodeWork`, `decodeTeam`,
`decodeTeamRoutines` and the attempts and draft of a task in `shop.ts`, the `work`, `team` and `routines` of a part and a
read, `src/runtime/http/work.ts` with `owned.test.ts` and `work.test.ts`, the members in `view.ts` (`team` is Buddy alone
again), the team writes in `host.ts` (`ownedTeam`, `change`, `pauseTeam`, `switchRoutine`, `switchAutomation`,
`showTeam`; the ops answer `not_yet` and `notYetShow` again), version 4 of the cache (3 again), `drafted` and `holds`
and the nullable `keptMonths` in `src/runtime/mission.ts` with the pages' uses of them (`pause.ts` `pauseWords`,
`TeamPage.tsx`, `job.ts`, `teamLine.ts`, `ActivityPage.tsx`), `serveShops`' work in `testkit.ts`, and the `rt.taskDraft`,
`rt.ownerOnly`, `rt.change.*`, `rt.ev.*`, `pause.r.*`, `job.step.drafted` and `act.st.drafted` keys; and give `rt.notYet`
its earlier words.

To take only Customize › Memory and routines out: make `memory.*`, `routine.create` and `routine.remove` `notYet` in `host.ts` (and
`memory.list` `notYetShow`), remove `src/runtime/http/memory.ts` with `memory.test.ts` and `routines.test.ts`, `makeRoutine`,
`removeRoutine`, `noTeam`, `routineWords` and the routine paths in `host.ts`, `routine.create` and `routine.remove` from `TEAM_CHANGES`,
the memory and routine routes in `testkit.ts`; give `rt.notYet` its earlier words; and, in the page, the shop each call names
(`memoryCallsFor`, `routineCallsFor`, the `shop` of every op in `src/runtime/memory.ts` and `routines.ts`), the Remove question
(`ask`, `removing` and `RoutineRow.removable`, with the `routines.remove*`, `routines.keep` and `routines.err.*` keys), the stock note
(`routines.form.stockNote`) and the reload on a shop switch in `CustomizePage.tsx`.

To read the export again in place of the task list (December item 44): read `GET /v1/tenant/export` in `readShop`
(`shop.ts`) and in `ShopSessions.readShop` (`shops.ts`) instead of `readTaskList`, `SHOP_SCHEDULES` and `SHOP_ATTENTION`,
and decode its `tasks`, `schedules` and `attention` in `decodeWork` again; keep the tasks in the export's order, which is
the order `decodeTasks` restores; put version 4 of the cache back with each task's `events` count (`cache.ts`); serve the
export again in `testkit.ts`; and move `screens.test.ts` back onto it, where it must still pass. The API's list
(`apps/api/src/task-list.ts`, `task-listing.ts`, the task object's `/listing`) and the owner's schedules and attention
reads in `shops.ts` can stay or go on their own.

To take only Show older out (December item 52): remove `jobs.older` from `MissionOps`, with the `older` of `jobs.list` and
`activity.list` there, the host's `showOlder`, `readOlder`, `listOf`, `editOlder`, `keepingOlder`, `pressing` and the `more` and `older`
that `atShops` copies, the mock host's `jobs.older` and the store's `missionOlder`; `src/runtime/http/older.ts`, `readTaskPage` and the
`more` and `older` of `ShopWork` and `ShopSnapshot` (`decodeWork`, `readShop`, `workOf` in `shops.ts`) and the `next` of
`TaskListRead`; `shownTasks` in `work.ts` (jobs and the log read `s.tasks` again); `src/pages/older.ts`, `ShowOlder.tsx`, the `older` of
`HistoryView` and `ActivityView`, `useJobList` (`useJobs` alone again) and the `.older` rules in `menuPages.css`; the `older.*` keys; and
the tests `older.test.ts`, `older.host.test.ts`, `src/pages/older.test.tsx`, `e2e/show-older.spec.ts` and the cursor tests in
`shop.test.ts`. The offline cache needs nothing: it never held any of it.

To take only the buttons out of notifications: pass no `approve` handler in `notifySessionEvent` (`store.ts`) and remove
`approveFromNotification`, `src/chat/cards/askNote.ts` and its use in `Cards.slot.tsx`; notifications then carry Look first and
Later. The protocol event's `kind` (`view.ts`, `protocol.ts`) is read only for this.

Practice is the default and Connected is reached only through Settings › Developer. To take the slice out, remove
`src/runtime/http/`, `src/runtime/setting.ts`, `src/runtime/link.ts`, `src/settings/DeveloperPage.tsx`,
`src/sidebar/ModeLine.tsx`, the `rt.`, `dev.` and `mode.` dictionary keys, `src-tauri/src/api_link.rs` with its four
commands in `lib.rs`, and the `security-framework` dependency in `Cargo.toml`. To take only the offline cache out, remove
`src/runtime/http/cache.ts` and `sha256.ts` with their tests, the `cache` and `keeping` options and the `cache` view in
`host.ts` (a failed read then drops the shop again), the `onEnd` option in `session.ts`, `shopCache`, `forgetShop` and
`shellCacheStore`, `saveRuntimeChoice` and `useShowingCache` in `link.ts`, the offline line in `Cards.slot.tsx`, the
`rt.connectToAnswer`, `mode.cached*` and `mode.old*` keys, and `src-tauri/src/shop_cache.rs` with its three commands in
`lib.rs`.
