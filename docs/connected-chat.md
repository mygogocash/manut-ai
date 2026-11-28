# Buddy's chat on the Connected runtime (item 102l)

The design pass for item 102l, written 27 Nov 2026 after the owner chose to build it, deployed to the dev API only.
Status: 102l-1 (A) built on 27 Nov 2026, not yet deployed; 102l-2 (B, the desktop's side) built on 27 Nov 2026; 102l-3 (C, the reach
cards) built on 27 Nov 2026; 102l-5 (Manut AI's lines kept apart from the owner's words) built on 27 Nov 2026; 102l-6 (the rest of B:
remove a conversation, and Show older) built on 28 Nov 2026. The phases at the end are the order to build it in, and "What 102l-1 built",
"What 102l-2 built", "What 102l-3 built", "What 102l-5 changed" and "What 102l-6 built" (below) say where the build differs from this design.

## Why 102l is bigger than its row

Item 102k put the reach cards (read another chat, send it a message, open a new lane) on this Mac's coding chats. Its
row 102l says the same cards come to the Connected runtime "once apps/api lets a chat send and open a thread". Two things
stand in the way, and neither is a card:

1. **There is no chat with Buddy on the API.** The Connected runtime answers `chat.send` with `not_yet` ("Buddy's chat
   needs a model, the owner's key": `docs/runtime-adapter.md`). The API calls a model only through the model gateway
   (`docs/model-gateway.md`), which prices each call, holds it against the shop's monthly cap and bills it, and which has
   deliberately no HTTP route: "A route would let anyone holding the operator key spend money from outside." A chat
   route is exactly such a route, so it has to be designed, not added.
2. **A Connected thread is a task, and a shop session cannot make one.** `thread.list` lists the shop's tasks as Buddy's
   threads, and `POST /v1/tasks` answers a shop session 405 `method_not_allowed`: the team's work runs only in the
   Worker's job flow (`docs/pilot-api.md`, "Tasks").

So 102l is three things in order: Buddy's chat on the owner's session (A), chat threads that are not tasks (B), and then
the reach cards over them (C).

## A. The owner's chat with Buddy

- **One route, on the owner's session only.** `POST /v1/chat/messages` with `{ thread, text }` from the shop's owner (or a
  helper, if the owner allows it: an open question), and since 102l-5 an optional `note` and `sentOnFrom` beside the text (below). A
  link session, an operator key and an outpost are refused. The shop is the session's, never a field of the body.
- **Through the gateway, under the shop's cap.** Each message is one `callModel` call (`claude-haiku-5-5` by default,
  the gateway's price table) with a short system prompt for Buddy and the thread's last messages, capped in tokens. The
  answer is what the gateway answers: `budget_exceeded` says the month's cap is reached, `not_counted_in` that an
  operator has not counted the shop in, and `not_configured` that the owner's key is not set. No answer is made up.
- **The owner's key.** Until `ANTHROPIC_API_KEY` is set (the owner's paid account), every message answers
  `not_configured`, in words: "Buddy cannot answer yet: the team's model is not set up." Dev runs the gateway's
  `stand-in` provider only for tests and local runs, as the gateway says; dev's deployed Worker answers
  `not_configured` until the owner sets a key there.
- **Buddy only talks.** No tool use in the first version (the gateway's interface is plain text). Buddy may suggest that
  the team do something. Starting work, sending, posting, paying or deleting stays where it is today: the team's job
  flow and its approvals (`packages/approval-core`). There is no second way round.
- **What reaches the model is fenced and masked.** What the shop knows (`/v1/memory`) goes in as item 97's kind of fenced
  context, customers' words marked as customers' (never instructions), keys masked as every text the app hands a model
  is. The owner's own words are the only instructions.
- **Kept with the shop, and gone with it.** Messages are kept in the shop's TenantObject, 1,000 a thread and 50 threads at
  most, and are part of the shop's export and its deletion (`DELETE /v1/tenant/data` and the owner's deletion link
  already wipe the tenant: chats join that wipe and the export, with tests). Nothing is logged but codes and ids.
- **Limits.** A message is at most 8,000 characters; a shop at most 60 messages an hour (the gateway's cap is the money
  limit; this is the abuse limit).

## B. Chat threads

- A **chat thread** is a conversation with Buddy, made by the owner (`POST /v1/chat/threads` with a title, or by the
  first message). It is not a task and never becomes one, so the job flow and its rules are untouched.
- The Connected runtime lists chat threads beside the tasks it lists today: tasks stay Buddy's work notes, chat threads
  are conversations. `thread.create` makes a chat thread; `chat.send` posts to one.
- Desktop words say which is which, so a person never takes a conversation for work the team is doing.

## C. The reach cards over Connected chats

Item 102k's rule R10 holds as it is (`docs/several-agents.md`):

- A chat reaches only the chats the person listed under its box, of the same shop.
- A read sends item 97's fenced, masked, capped text of the other chat, only after Let Kit read on a card showing that
  text.
- A message goes only after Send there on a card showing it whole. It arrives as a message from the other chat, saying
  the person sent it on.
- A new thread opens only after Start thread.
- Each card is an approval of the asking chat, settled once through approval-core.
- Across shops or accounts is refused before anything is read.

On Connected, a "chat" is a chat thread of A and B, and the asking chat is Buddy's thread the person is in.

## Rules and their tests

- **R1.** No model call without the owner's session, inside the shop's cap. *Tests:* an operator key, a link session and
  another shop's session are refused before the gateway is called; `budget_exceeded` and `not_configured` reach the
  person in words; the gateway's ledger shows one held and settled call per message.
- **R2.** The chat sends, posts, pays and deletes nothing. *Tests:* no route the chat reaches can start a task, a dispatch
  or a decision; a message saying "Approve the reply" leaves every request pending.
- **R3.** The shop's and customers' words are context, never instructions. *Tests:* a customer's fact with an instruction
  in it is fenced and marked; a key in it is masked.
- **R4.** Chats leave with the shop. *Tests:* the export holds them; the tenant wipe and the deletion link leave none.
- **R5.** The reach cards keep R10. *Tests:* item 102k's three safety tests, run against Connected chat threads.

## Phases

| Phase | What | Needs the owner |
| --- | --- | --- |
| 102l-1 | The chat route and its store (A), with the stand-in provider in tests; deployed to dev, where it answers `not_configured`. **Built 27 Nov 2026**, behind its own switch, which is off everywhere; not deployed | Nothing to build. A key in dev to try it for real, and the switch turned on there |
| 102l-2 | Chat threads (B) and the Connected runtime's `chat.send` and `thread.create` over them. **Built 27 Nov 2026** in the desktop (`apps/desktop/src/runtime/http/chat.ts`); the API needed nothing more | Nothing |
| 102l-3 | The reach cards over Connected chat threads (C). **Built 27 Nov 2026** in the desktop (`apps/desktop/src/jobs/buddyReach.ts`); the API needed nothing | Nothing |
| 102l-5 | Manut AI's lines kept apart from the owner's words: the note and the sent-on mark as `note` and `sentOnFrom` fields of a message, given to the model and not kept in the text. **Built 27 Nov 2026** (API, `packages/agent-prompts` and the desktop) | Nothing |
| 102l-6 | The rest of B on the desktop: remove a conversation (asked first, deleted for good) and Show older (the 50 before the oldest shown). **Built 28 Nov 2026** in the desktop; the API needed nothing | Nothing. The question's wording is Claude's call, which the owner may change |
| 102l-4 | Real answers: the owner's key set, first in dev, then staging and production at the owner's word | The paid Anthropic account, the cap (`MODEL_DEFAULT_CAP_SATANG`) and the rate (`MODEL_SATANG_PER_USD`) |

## What 102l-1 built

Section A, with rules R1 to R4 and their tests (`apps/api/src/chat.ts`, `chat-store.ts`, `buildBuddyChat` in
`packages/agent-prompts`; `apps/api/test/chat.test.ts`). The routes, bodies and refusals are in `docs/pilot-api.md`,
"Chat". The four open questions below are answered for now by their own recommendations, as Claude's calls pending the
owner (`docs/decisions/102l-connected-chat.md`). Where it differs from the design above:

- **Its own switch.** `buddyChat` (`PUT /v1/admin/flags`, default the var `BUDDY_CHAT`), off in every environment, as the
  other dev-only switches are: none of them is set on in `apps/api/wrangler.jsonc`. With it off a message answers 403
  `feature_disabled`; reading and removing threads stay open.
- **Owner only.** A helper's session answers 403 `owner_only` on every chat route, not only the message.
- **The shop's consent.** A message also needs the shop's consent to cloud work (403 `consent_required`), which the design
  did not name: what goes to the model holds the shop's facts and customers' words, as a worker's request does.
- **Kept masked.** The owner's message and Buddy's answer are kept masked, not only sent masked, so a key the owner pastes is
  never stored. The masker is the app's one, the workspace package `@manut/mask-secrets` (`packages/mask-secrets`), which the
  desktop, its shell and the API share; the API had none of its own.
- **Nothing kept for a refusal.** A message is let through (thread, caps and the hour) before the call, and kept with
  Buddy's answer only after it, so a gateway refusal leaves the thread as it was. A let-through message counts against the
  hour whatever the gateway answers.
- **Full is refused.** At 50 threads a new one is refused (409 `threads_full`); a thread that cannot take two more messages
  is refused the next (409 `thread_full`). Nothing is dropped to make room.
- **Threads, as A needs them.** A message without a thread makes one, titled with its first words; the owner lists threads,
  reads one a page at a time and removes one (`POST /v1/chat/threads/remove`, a POST as the owner's other changes are).
  There is no `POST /v1/chat/threads` to make an empty one, and nothing in the Connected runtime yet: that is 102l-2.
- **Not deployed.** The design's phase deploys to dev; this build is not deployed, and the switch stays off until the owner
  says.

## What 102l-2 built

Section B in the desktop's Connected runtime (`apps/desktop/src/runtime/http/chat.ts`, wired in `host.ts`; the words a screen shows in
`src/threads/kind.ts`; tests in `chat.test.ts` and `src/threads/kind.test.ts`, over a stand-in of the API's chat in `testkit.ts`). The ops
and their refusals are in `docs/runtime-adapter.md`, "Buddy's chat on Connected"; the calls are Claude's
(`docs/decisions/102l-connected-chat.md`). Where it differs from the design above:

- **No `POST /v1/chat/threads`.** `thread.create` prepares a conversation in the desktop, with nothing sent, and its first message makes
  it on the API (a message with no `thread`). The store asks for a conversation before the person has typed anything, the API has no
  route that makes an empty one, and an empty conversation would be a record with nothing in it, so the API was left as 102l-1 built it.
  The prepared conversation keeps the id the screens gave it for the rest of the run.
- **Buddy's main chat is a conversation too.** A message typed in Buddy's main chat on Connected goes to the API's chat: its first
  message makes a conversation, listed with the others, and the next ones go to it until the chat is opened again. The design spoke of
  `chat.send` posting to a chat thread; the main chat is where an owner types first, so it had to answer too.
- **The shop is the chat's.** The main chat's messages go with the owner session of the shop it was opened for, a conversation's with
  that of the shop it was made for, never the shop the switcher shows by then, as the owner's other changes go.
- **The turn comes with the answer.** The API answers a message whole, after the model call, so the answer is shown as one turn once the
  API answered, and a refusal starts no turn: the message is marked not sent with its reason, as other failed sends are.
- **Which is which.** Every thread row says what it is (`kind`: `chat` or `task`). A conversation's header says "Conversation" and a
  task's "Team's work"; History already lists each task once, as its job.
- **No removal from the desktop yet** (built in 102l-6, below). The API's `POST /v1/chat/threads/remove` was not called: no screen offered
  to remove a thread then (the thread tree with its x is no longer drawn), so `thread.remove` stayed "not yet". Deleting the shop's data
  still wipes every conversation (102l-1).
- **Not built:** older messages than a conversation's newest 50 (the API pages them; the desktop read the first page only; built in
  102l-6, below), and a live answer: the API answers whole, so nothing streams.

## What 102l-3 built

Section C in the desktop, with rule R5 and its tests (`apps/desktop/src/jobs/buddyReach.ts`, the list `BuddyMayReach` in `MayReach.tsx`,
the cards in `ReachCards.tsx`, the lines Manut AI writes in `reachMarks.ts`, the runtime's half in `src/runtime/http/chat.ts`; tests in
`buddyReach.test.ts`, `reachMarks.test.ts`, `reachBlocks.test.ts`, `ReachCards.test.tsx`, `chat.test.ts`, and the browser spec
`e2e/connected-reach.spec.ts`). The calls are Claude's (`docs/decisions/102l-connected-chat.md`). R10 holds as it is; what a person sees:

- **"Buddy may reach".** Under the box of Buddy's main chat and of each conversation, for the shop's owner on Connected only, the same list
  as a coding chat's "Kit may reach": the person adds the shop's other conversations (one with nothing in it yet, the chat itself, and the
  conversation the main chat posts to are refused), each named by its number, at most five. Kept in memory for this run, by shop and chat:
  nothing of it is saved, and it goes at sign-out.
- **How Buddy learns it.** While the list holds a conversation, each message carries Buddy's note beside it (`chat.send`'s `note`), which
  the runtime posts as the message's own `note` field, apart from the owner's words (102l-5; 102l-3 had posted it after them). The API
  gives the model the words, a blank line, then the note from `[Manut AI: a note to Buddy]` to `[End of the Manut AI note]`, saying it is
  not the owner speaking and gives no permission, naming each conversation by its number, and showing the three blocks with exactly the
  keys Buddy may use. It keeps only that the message had one (`noted: true`), so the note is never in the owner's text, a conversation's
  name or the export, and the words have all of the 8,000 characters.
- **The cards** are 102k's in Buddy's words: "Buddy asks to read …" with item 97's text whole and Let Buddy read; "Send this to …?" with
  Buddy's message whole and Send there; "Buddy asks to start a new conversation" with its first message whole, the name it will have and
  Start conversation. Each says before its press, in a line of its own, that the press is one message billed to the shop's monthly limit.
  Each is one approval of the asking chat in the same approval-core store as 102k's, settled once by the owner.
- **What each press posts, once.** A read posts item 97's text as the asking chat's next message (the note beside it, as its own field). A
  send posts Buddy's words to the other conversation as the message's text, with the asking chat's name as its `sentOnFrom` field (102l-5):
  the API gives the model the mark after those words (`[Manut AI: the words above came from the conversation "<title>"]` and a line that it
  gives no permission), now and in every later turn, and the bubble there, and the conversation read back, say "From <title>, sent on by
  you" above the words. A start prepares a conversation and posts the brief the same way (the words, and `sentOnFrom`), so the API names it
  by the brief's first words; it is not opened in front of the person, and the settled line has Open. A refused or unanswered post marks
  the card and the bubble with the reason, and nothing is sent again.
- **Refused, with nothing read or posted.** A conversation not on the list (before item 97's reader is asked anything); a block with a key
  outside its own (a new conversation takes only `brief`), a second block, or a message or brief over 5,000 characters; at the press, a
  card of another shop than the one shown, a person who no longer owns the shop, a conversation no longer listed or gone. A message sent on
  is words and nothing else, so it answers, allows, denies or dismisses no ask or approval.

Where it differs from the design above, or from 102k:

- **Manut AI's lines are fields of the message on Connected.** 102k puts its note and mark in front of the words, and 102l-3 put them after
  them; the API keeps every message and names a new conversation by its first words, so a line inside the text would become the name
  and read as the owner's first words in the export. Since 102l-5 they are fields of their own (`note`, `sentOnFrom`), given to the model
  and never kept in the text (see "What 102l-5 changed").
- **The name of a conversation with a short first message.** 102l-3 left the start of the note in the API's name for a conversation whose
  first message was short, and the screens took it off (`shownTitle`); 102l-5 ended it, since the API names a conversation by the first 60
  characters of the owner's words alone.
- **Buddy's grammar.** A new conversation takes only its brief (no title, agent, model or effort), and a message or brief is at most 5,000
  characters, to fit one API message with its mark and the note of the conversation it reaches. Since 102l-5 neither takes room from the
  words, so the limit could be 8,000; it stays 5,000 until someone wants a longer message on a card.
- **Not saved.** The list lives for the run, where 102k saves it with the session; the cards, as 102k's, do not survive a restart.
- **A race in 102l-2, fixed.** A message sent while Buddy's main chat was opening made a conversation that the opening then forgot, so the
  next message started another (and a read card's text went there). Opening the chat now keeps it.
- **Not built:** the cards are not in Needs you (as 102k's); a helper sees no list, since only the owner chats on Connected.

## What 102l-5 changed

Manut AI's two lines, Buddy's note and a sent-on message's mark, stopped riding inside the owner's message text (the API's `chat.ts` and
`chat-store.ts`, `buildBuddyChat` in `packages/agent-prompts`; the desktop's `runtime/http/chat.ts`, `jobs/buddyReach.ts` and
`jobs/reachMarks.ts`; tests in `apps/api/test/chat.test.ts`, `packages/agent-prompts/test`, the desktop's `chat.test.ts`,
`buddyReach.test.ts` and `reachMarks.test.ts`, and the browser specs `e2e/connected-chat.spec.ts` and `e2e/connected-reach.spec.ts`). The
routes, bodies and refusals are in `docs/pilot-api.md`, "Chat"; the calls are Claude's (`docs/decisions/102l-connected-chat.md`). What
changed:

- **Two fields of `POST /v1/chat/messages`.** `note` (a whole note and nothing else, at most 2,000 characters) and `sentOnFrom` (the title
  of the conversation the words were sent on from: 1 to 120 characters, one line, no double quote), each only when there is one. Any other
  key is still refused, and a bad note or title is refused before anything is counted or called.
- **Given to the model, never kept in the words.** The model reads the words, then the mark, then the note, byte for byte what it read
  before this item. The owner's kept message is the words alone (masked), with `sentOnFrom` (masked) and `noted: true`; the note is kept
  nowhere. A conversation is named by the words alone, and the shop's export holds the owner's words, not ours.
- **The safety rule: the mark is rebuilt in every later turn (R10).** The kept `sentOnFrom` is what the API hands back with the history,
  and the prompt builder gives each such turn the mark after its words, so words Buddy wrote in another conversation never read as the
  owner speaking, in the turn they came in or in any later one. A note is never in history: only the newest message carries the one it
  came with. `apps/api/test/chat.test.ts` and `packages/agent-prompts/test` pin both, and a mutation that takes the mark out of history
  fails them.
- **In the desktop**, `chat.send` posts the two fields as their own (`sent_on_from`, posted as `sentOnFrom`), refuses first what the API
  would refuse, gives the words all 8,000 characters (the "at most N" refusal is gone), draws a message sent on with the mark in front
  from its `sentOnFrom` (as on this Mac), and hides Buddy's reach block after a message with `noted: true`, not for the look of its words.
  A conversation's name is the API's.
- **Removed:** `withBuddyNote`, `withoutBuddyNote`, `fromChatAfter`, `readFromChatAfter`, `shownTitle`, `keptAsShown` and the dictionary
  line `rt.chat.tooLongNoted`. Nothing was ever kept in the old form (the chat is off in every environment and no model key is set, so a
  message was never kept outside tests), so there is nothing to read back.
- **Left as it was:** a read card's text (item 97's copy of another conversation) is still the message's words, and Buddy's blocks still
  take at most 5,000 characters.

## What 102l-6 built

The two things 102l-2 left out, in the Connected runtime and the screens that draw Buddy's conversations (`apps/desktop/src/runtime/http/chat.ts`
and `host.ts`; the question in `src/threads/removeAsk.ts` and `RemoveConversation.tsx`, the entry in `src/sidebar/Sidebar.tsx` and
`src/pages/HistoryPage.tsx`; Show older in `src/threads/ShowOlderMessages.tsx`, `src/chat/parts/Timeline.tsx` and the store's `threadOlder`;
tests in `chat.test.ts`, `removeAsk.test.ts`, `RemoveConversation.test.tsx`, `ShowOlderMessages.test.ts`, `chatOlder.test.ts`,
`TimelineJump.test.ts`, and the browser spec `e2e/connected-chat.spec.ts`, over a stand-in of the API that pages and removes as apps/api
does, `ownerChatRoutes` in `testkit.ts`). The ops and their refusals are in `docs/runtime-adapter.md`, "Buddy's chat on Connected"; the calls
are Claude's (`docs/decisions/102l-connected-chat.md`). What a person sees:

- **Remove.** A conversation's row menu (in Recent, in History and in History's Archive) ends, after a line, with "Remove conversation…" in
  red. It opens a question over the app: "Remove this conversation?", the conversation's name, "This deletes every message in it for good.
  It cannot be taken back.", Cancel (which holds the focus, as Forget's "Keep it" does) and the red "Remove conversation". Cancel, Escape and
  a press outside send nothing. The red button sends one `POST /v1/chat/threads/remove` with exactly `{ id }` and the owner session of the
  shop the conversation was listed or made for, never the shop the switcher shows by then; the conversation leaves the list, and its view
  closes when it was open. The entry is for a conversation only, and only the owner has conversations (a helper sees none): the team's
  work, several rows selected at once and Practice's threads never offer it.
- **A refusal is said in the question, and the row stays**, with the runtime's words under the text and both buttons still there: the
  API's 403 (only the owner may remove), no answer (it is not known whether it went through, and pressing again is safe), offline, signed
  out, the person's place in the shop ended. One the API no longer has, `thread_not_found`, says "This conversation is not there any more."
  and drops the row at once, as the list would on its next read.
- **A conversation made in the desktop and never sent to** has nothing on the API: it is dropped there, with nothing sent (the question
  is still asked, since the row's count can be a message behind). A message sent a moment before the removal is posted first, then the
  conversation is removed with it.
- **Show older.** A conversation with more than its newest 50 messages starts with a quiet "Show older" button above its first message. A
  press reads the 50 before the oldest shown (`GET /v1/chat/threads/{id}?before=<the API's next>&limit=50`, with the owner session of the
  conversation's shop) and puts them above, keeping what the person was reading where it was; the button stays while there are older ones
  and is gone once the first message is shown. Messages read back are drawn as the first page is (a sent-on mark in front, no reach block
  after `noted: true`). A page that cannot be read says why next to the button and offers Try again, and what is shown has not changed.
  The "Jump to bottom" pill does not count them as new messages. Nothing read is kept on disk.

Where it differs from the design above:

- **The API needed nothing.** The removal route and the paged read were built in 102l-1; this item only calls them.
- **The main chat is not a conversation's view**, so it has no Show older, and removing the conversation it posts to leaves what that chat
  already shows on screen until it is opened again (its next message starts another conversation).
- **Not built:** removing several conversations at once (deleting is one question for one conversation), an undo (the API deletes for good),
  and a count of how many older messages there are (the API gives a cursor, not a total).

## Open questions for the owner

1. **Is Buddy's chat in the desktop's Connected mode wanted for the pilot, with each message a model call billed to the
   shop's cap?** Recommended: yes, behind its own switch, off until the key is set, so the cost is the owner's choice.
2. **Who may chat: the owner only, or helpers too?** Recommended: the owner only at first. A helper's chat would spend the
   owner's money.
3. **How long are chat messages kept?** Recommended: until the owner deletes the thread or the shop, like memory; in the
   export and the deletion from day one.
4. **May Buddy later start the team's work from a chat?** Recommended: not in 102l. If wanted, it is a card naming the job,
   settled once through approval-core, a later item.
