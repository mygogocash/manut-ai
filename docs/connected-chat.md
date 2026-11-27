# Buddy's chat on the Connected runtime (item 102l)

The design pass for item 102l, written 27 Nov 2026 after the owner chose to build it, deployed to the dev API only.
Status: 102l-1 (A) built on 27 Nov 2026, not yet deployed; 102l-2 (B, the desktop's side) built on 27 Nov 2026; 102l-3 proposed.
The phases at the end are the order to build it in, and "What 102l-1 built" and "What 102l-2 built" (below) say where the build
differs from this design.

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
  helper, if the owner allows it: an open question). A link session, an operator key and an outpost are refused. The
  shop is the session's, never a field of the body.
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
| 102l-3 | The reach cards over Connected chat threads (C) | Nothing |
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
- **No removal from the desktop yet.** The API's `POST /v1/chat/threads/remove` is not called: no screen offers to remove a thread now
  (the thread tree with its x is no longer drawn), so `thread.remove` stays "not yet". Deleting the shop's data still wipes every
  conversation (102l-1).
- **Not built:** older messages than a conversation's newest 50 (the API pages them; the desktop reads the first page only), and a live
  answer: the API answers whole, so nothing streams.

## Open questions for the owner

1. **Is Buddy's chat in the desktop's Connected mode wanted for the pilot, with each message a model call billed to the
   shop's cap?** Recommended: yes, behind its own switch, off until the key is set, so the cost is the owner's choice.
2. **Who may chat: the owner only, or helpers too?** Recommended: the owner only at first. A helper's chat would spend the
   owner's money.
3. **How long are chat messages kept?** Recommended: until the owner deletes the thread or the shop, like memory; in the
   export and the deletion from day one.
4. **May Buddy later start the team's work from a chat?** Recommended: not in 102l. If wanted, it is a card naming the job,
   settled once through approval-core, a later item.
