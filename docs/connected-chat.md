# Buddy's chat on the Connected runtime (item 102l)

The design pass for item 102l, written 27 Nov 2026 after the owner chose to build it, deployed to the dev API only.
Status: proposed. Nothing here is built yet; the phases at the end are the order to build it in.

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
| 102l-1 | The chat route and its store (A), with the stand-in provider in tests; deployed to dev, where it answers `not_configured` | Nothing to build. A key in dev to try it for real |
| 102l-2 | Chat threads (B) and the Connected runtime's `chat.send` and `thread.create` over them | Nothing |
| 102l-3 | The reach cards over Connected chat threads (C) | Nothing |
| 102l-4 | Real answers: the owner's key set, first in dev, then staging and production at the owner's word | The paid Anthropic account, the cap (`MODEL_DEFAULT_CAP_SATANG`) and the rate (`MODEL_SATANG_PER_USD`) |

## Open questions for the owner

1. **Is Buddy's chat in the desktop's Connected mode wanted for the pilot, with each message a model call billed to the
   shop's cap?** Recommended: yes, behind its own switch, off until the key is set, so the cost is the owner's choice.
2. **Who may chat: the owner only, or helpers too?** Recommended: the owner only at first. A helper's chat would spend the
   owner's money.
3. **How long are chat messages kept?** Recommended: until the owner deletes the thread or the shop, like memory; in the
   export and the deletion from day one.
4. **May Buddy later start the team's work from a chat?** Recommended: not in 102l. If wanted, it is a card naming the job,
   settled once through approval-core, a later item.
