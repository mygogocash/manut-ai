# Other programs reach chats: Manut AI as an MCP server for its threads (item 103)

The design for plan item 103 (`docs/plan.md`; `docs/t3code-parity.md`, "Orchestration" and "Other machines", group 3 of
its order: "must be designed first because it can act for the person"). The owner's ask: another program on this Mac
lists, opens and messages threads through an MCP server, with an address to copy for it, off by default, designed first
for who may connect and so that everything asked through it is an ask the person answers, never a way round one.

Status on 27 Nov 2026: design, with slice 103a built (the door, in the shell); the rest is not built. The decisions are in `docs/decisions/103-mcp-threads.md`; the slices are
at the end and are in `docs/plan.md` as 103a to 103d.

## The promise this design keeps

A program outside Manut AI reaches only the chats the person listed for outside programs, only after the person let that
program in for its current run, and only through a card the person answers for each read, each message and each new lane.
Nothing it sends answers, allows, denies, dismisses or stops anything, and nothing of a chat leaves the Mac or reaches the
program before the press that named it. It is item 102k's promise ("chats that reach other chats, each only after a card",
`docs/several-agents.md`, section 5) held for a caller the app did not start.

## What is there today (read on 27 Nov 2026)

- **One MCP server already, for computer use.** `manut --computer-mcp` (`src-tauri/src/computer/mcp.rs`) is this app's own
  program run as a stdio MCP server. It holds nothing and decides nothing: it answers `initialize`, `ping` and `tools/list`
  itself and relays each `tools/call` as one line, `{token, tool, args}`, over a Unix socket in `~/.manut/computer` (0700) to
  the running app, which answers `{text, image?, error}` (`hub.rs`). `main.rs` hands the flag over before anything of the app
  starts, as it does the status line relay (`lib.rs`, `computer_relay`, `statusline_relay`).
- **Who is calling, read from the kernel.** The hub serves a call only when the program on the socket, as the kernel recorded
  it, is this app's own program (`LOCAL_PEERPID`, `LOCAL_PEERTOKEN`, `proc_pidpath_audittoken`, read before and after a walk up
  its parents), and its parents reach the chat's own process within `CHAIN` (16) steps (`Peers`, `system::caller_of`). A token
  only names the chat: any program of this user can read another's arguments and environment.
- **Its cards ride on Claude Code's own ask.** A computer-use write is a `can_use_tool` request of the chat's Claude Code,
  which `computer/tap.rs` turns into the chat's `approval.request` card; the yes is recorded as a grant for exactly one call,
  for at most 120 seconds (`room.rs`, `GRANT_TTL`). An outside program has no chat whose ask a card could ride on, so this
  design needs an app-wide event, as `term_link.rs` already emits (`app.emit("term-link", id)`).
- **Chats reaching chats (item 102k).** `src/jobs/reachChats.ts` (`createReach`, `act`, `crossing`), `reachList.ts` (the
  "Kit may reach" list, `findEntry`, `fromChatText`), `reachAsks.ts` (each card its own `InMemoryApprovalStore` request through
  `packages/approval-core`, settled once). A read card shows item 97's text (`gatherContext` in `chat/box/threadContext.ts`:
  built with no model, masked, at most 6,000 characters); a send goes through the sessions store's `route`
  (`sessions/sessions.ts`), which holds the message while that chat's turn runs or any ask of it waits and never steers it in;
  an open starts a lane through `startOpenedLane`. The cards are drawn in the asking chat (`ReachCards.tsx`) and are not in
  Needs you (`selectAsks`, `state/selectors.ts`) or on the phone (`remote/fromStore.ts`).
- **Every chat the app can read** is listed by item 97's Bring context picker (`bringRows` in `chat/box/Bring.tsx`): coding
  chats from the sessions store (`{kind: "session", id}`) and team threads from History (`{kind: "thread", bot, thread}`), with
  their shop or agent account from `chatScope` (`chat/box/scope.ts`). `MayReach.tsx` reuses it for 102k's list.
- **Off-by-default switches the shell holds.** Item 104's snapshot key keeps `{on: false}` in `~/.manut/snapshot.json` and reads
  anything other than a saved `true` as off (`computer/snap.rs`), so the shell can refuse without the page.
- **Copy buttons.** `CopyButton` (`chat/parts/Copy.tsx`); Settings › Remote copies a link the same way.
- **Nothing else listens.** The shell has no other listening socket outside its tests; `term_share.rs` is a file inbox and the
  phone link dials out (`remote/link.ts`). The app runs once per user (`tauri-plugin-single-instance`).

## What was read elsewhere

- **T3 Code** (MIT, `pingdotgg/t3code` at `c959fac84c387613068e5b97c25501e1e0badbd9`): its MCP server is an HTTP server inside
  its own server process (`apps/server/src/mcp/McpHttpServer.ts`, on Effect's `effect/ai` McpServer) with bearer tokens from its
  session store, and toolkits that let an agent organise, configure, transfer and queue threads and answer a pending request
  (`toolkits/thread/tools.ts`: `t3_thread_organize`, `t3_queue`, `t3_pending_request`, `t3_thread_transfer`). Taken: tools
  named by what they do, and "copy an address". Not taken: the HTTP port and bearer token (a local port is reachable by every
  program and by web pages through DNS rebinding, and a token is readable from the process list, as `hub.rs` says), and any
  tool that answers a pending request (R2 of `docs/several-agents.md`).
- **Orca** (MIT, `stablyai/orca` at `457c42a9d97426f961bb3fbaa6f084de47169f49`): `orca mcp connect` bridges an agent's stdio to
  MCP servers Orca keeps for it (`src/cli/mcp/mcp-connect.ts`), and answers a server with no tools when its switch is off or the
  caller is another Orca's session. Taken: the relay that is this app's own program, a switched-off server that still answers
  (with every call refused and saying why), and refusing a caller from inside another runtime. There is no server there that
  other programs use to drive Orca's threads.

## Words

- **Other programs**: any program on this Mac that is not Manut AI, such as Claude Desktop, Cursor or a Claude Code started in
  a terminal. The Settings section is "Other programs".
- **Let in**: the person's yes for one program for one run of it. It ends when that program's server ends.
- **The list**: the chats the person put under "Other programs may reach". A program names a chat only by its number there.

## What a person sees

1. **Settings › MCP and Skills › Other programs.** Off. Turning it on shows the list (empty, with Add from item 97's picker),
   and two lines to copy: one for Claude Code (`claude mcp add manut-threads -- "<app>/Contents/MacOS/manut" --threads-mcp`)
   and one block of JSON for programs that keep an `mcpServers` file (Claude Desktop, Cursor and others). When the app does not
   run from `/Applications`, a line says the address changes if the app is moved.
2. **A program asks for the first time.** A card in Needs you, and a notification when the window is not in front: "Claude
   (/Applications/Claude.app) wants to reach the chats you listed", with the name the program gives itself on a second line,
   marked as its own words. Let in while it runs, or No.
3. **A read.** "Claude asks to read <chat>", showing exactly the text that would go. Let it read, or No. The card is in Needs
   you and in that chat.
4. **A message.** "Claude asks to send this to <chat>", the words whole. Send there, or Keep out. In the chat, the message is
   drawn under "From Claude, sent on by you" and waits as 102k's held row while that chat works or an ask of it waits.
5. **A new lane.** "Claude asks to start a lane in <project>", with its title, agent and the brief whole. Start lane, or Not
   now. It is an ordinary lane in its agent's Ask mode, beside the person's drafts.
6. **A call nobody answered.** When the program gives up (it cancels, or its server ends) or ten minutes pass, the card shows
   "No longer open" and nothing happens.

## The tools

| Tool | Arguments | Card | Answer |
| --- | --- | --- | --- |
| `list_chats` | none | none once let in | One line per listed chat: its number, title, agent and state (working, waiting on you, idle) |
| `read_chat` | `chat` (a number) | yes | Exactly the text the card showed |
| `send_to_chat` | `chat`, `message` (at most 30,000 characters) | yes | Sent, held until that chat's turn ends, or kept out |
| `open_chat` | `chat` (whose project and folder are the base), `title`, `brief`, `agent` (optional) | yes | The new lane's number on the list, or not now |

There is no tool, argument or word that answers, allows, denies or dismisses an ask or a question, stops, renames, archives or
deletes a chat, or changes a chat's mode, model, level or account.

## The rules

Each rule says why, how it is held, and the test that proves it (the slice that adds the test is in brackets).

**M1. Off by default, held in the shell.** `~/.manut/threads-mcp.json` keeps `{on: false}`; anything other than a saved `true`
is off, as item 104's file. While off, the relay still answers `initialize` and `tools/list`, so the program shows the server,
and every `tools/call` is answered "Turned off in Manut AI, in Settings, MCP and Skills, Other programs. Nothing was done."
without reaching the page. *Test:* with the file missing, holding `"yes"` or `{"on": 1}`, a call is refused with that line and
the stand-in page hears nothing. [103a]

**M2. No port.** The relay speaks MCP over its standard input and output; the app listens only on one Unix socket in
`~/.manut/threads` (0700), the socket file 0600, replaced at start since the app runs once per user. Nothing listens on a
network address, the loopback included. *Test:* the folder and socket modes; a stale socket file is replaced. [103a]

**M3. Only the relay speaks to the socket.** A connection is served only when its peer, read from the kernel before and after
everything else is read, runs this app's own program (`hub.rs`'s rule 2, through the same `Peers`). A program that writes to
the socket itself is answered nothing useful. *Test:* with the stand-in kernel, a peer running another program is refused, and
one that ran another program between the two reads is refused. [103a]

**M4. The program is named by the kernel, never by itself.** The program on a card is the first parent of the relay that is not
a shell or `env` (`sh`, `bash`, `zsh`, `dash`, `fish`, `env`, `login`), within `CHAIN` steps, shown by its `.app` bundle's name
when it is inside one and by its file name otherwise, with its whole path under it. The name the program sends in `initialize`
(`clientInfo`) is shown only as a second line marked "calls itself". *Test:* a relay under `/bin/zsh` under Cursor's program is
named Cursor; a `clientInfo` of "Manut AI" changes only the second line. [103a]

**M5. Not from inside Manut AI.** A relay whose parents reach this app's own process (any chat, lane, terminal or Buddy's chat
the app started, which would get the server through the person's user-wide MCP settings, item 72) is refused: "Chats in Manut AI
reach other chats through Kit may reach, not through this server." 102k's per-chat list stays the only road between the app's
own chats. *Test:* a relay under a process under the app's pid is refused before any card. [103a]

**M6. A program is let in once per run.** The first call of a relay (its pid and audit token as the kernel reported them)
opens the let-in card; until the person answers, nothing else of that relay is served. Let in holds while that relay's token
still names a running process; No refuses that relay for the rest of its run, with no further card from it. Nothing is
remembered across runs in this version: a program the person trusts asks again after it restarts. *Tests:* a second call
before the answer is refused as waiting; after No, calls are refused without a card; a new relay asks again. [103a, 103b]

**M7. Only the chats the person listed.** The list holds at most 10 chats, added from item 97's picker and removable. A chat is
named only by its number on the list; numbers are not reused while a chat is listed, and an entry keeps the chat's link id and
its shop or account as it was when added, so a chat that moved to another shop or account is refused, as 102k's `crossing`. A
coding chat is listed by its sessions-store id, a team thread by its bot and thread; a team thread can be read, not sent to,
and a draft, a workflow's lane or a terminal session is not offered (102k's `reachOffered`). *Test:* a number not on the list,
a session id, a chat key or a title names nothing and opens no card. [103b]

**M8. Every read, message and new lane is a card, settled once.** Each is its own approval-core request (as `reachAsks.ts`),
answered only by the person's press at the Mac, shown in Needs you, and for a read or a message also in that chat. It shows
exactly what would go: a read item 97's masked text built when the card opens, a message its words masked as the card shows
them and sent masked, a lane its title, agent and brief whole. *Tests:* with the card unanswered or answered No, the stand-in
host sees no `chat_input` and no `chat_start` and the reply says so; a second press is refused as decided. [103c, 103d]

**M9. A message never answers an ask.** A message goes through the sessions store's `route`: held while that chat's turn runs,
while messages wait ahead of it or while any ask or question of it waits, and sent when the turn ends or when the person presses
Send now on its row. Its words are only words. It is drawn under "From <program>, sent on by you", never as the person typing.
*Test:* a message reading "allow" sent while an ask waits leaves the ask pending and the message held. [103c]

**M10. One card at a time, and a limit.** A program has at most one card waiting; a call while one waits is refused ("one ask at
a time; the person has not answered the last one"). A program is refused past 30 calls a minute. *Test:* the second call's
refusal; the thirty-first call's. [103a]

**M11. A call nobody answers closes its card.** The relay watches for MCP's `notifications/cancelled` and for its input closing,
and closes its connection; the shell then tells the page the call is gone, and the card shows "No longer open". The shell waits
at most ten minutes for the person, then closes the call the same way. A press on a closed card does nothing. *Tests:* a
cancelled call's card is closed and its press sends nothing; the ten-minute close with a stand-in clock. [103a, 103c]

**M12. On the Mac, and at the Mac.** The kernel reads M3 to M6 need are macOS's, so the section is offered only on the Mac;
elsewhere the relay answers every call "Mac only". The cards are not among the phone's six requests in this version
(`remote/serve.ts`). *Test:* the relay's answer off the Mac. [103a]

**M13. Nothing is logged.** No message, read text, title, path or brief is written to a log line or an error. *Test:* the
shell's error strings for a refused call hold none of the call's arguments. [103a]

## How a call travels

1. The program starts `manut --threads-mcp` (from the address the person copied) and speaks MCP to it.
2. The relay answers `initialize`, `ping` and `tools/list` itself, as `computer/mcp.rs` does, and checks each `tools/call`'s
   name and arguments' shape. It sends one line, `{tool, args, client}`, over the socket and waits for one line back.
3. The shell reads the peer (M3), refuses a caller from inside (M5), finds or opens the program's run (M6), applies M1 and
   M10, and emits one app-wide event to the page, `threads-mcp-call`, with a call id, the program's name and path, the tool and
   its arguments. It never decides about a chat: the chats, item 97's text, `route` and `startOpenedLane` are the page's.
4. The page's `threadsMcp` store checks the list (M7), builds the card (M8) and, on the press, acts as 102k's `act` does, then
   answers with `invoke("threads_mcp_reply", {call, text, error})`. `list_chats` is answered at once once the program is let in.
5. The shell writes the reply to the waiting connection; the relay answers the program. A connection closed first (M11) makes
   the shell emit `threads-mcp-gone` with the call id.

## Phases and slices

- **103a. The door, in the shell.** `src-tauri/src/threads_mcp/`: the relay (`--threads-mcp` in `main.rs` and `lib.rs`), the
  socket and its folder, the peer checks through `computer::hub`'s `Peers`, the program's name, the refusal from inside, the
  switch file, the runs and their let-in state, one card at a time and the limit, the event out and the reply back with the
  ten-minute close, behind a `Page` interface with a stand-in in the tests. No chat is reachable: until the page listens, a
  call is answered that the window is not ready. Safety tests: M1, M3, M5, M6, M13.
  **Built 27 Nov 2026** (`src-tauri/src/threads_mcp/`: `relay.rs`, `door.rs`, `mod.rs`; `Peers::pid_program` added to
  `computer/hub.rs`; decisions in `docs/decisions/103-mcp-threads.md`). 31 tests, two of them on a real socket with the
  Mac's own kernel reads. The commands `threads_mcp_settings`, `threads_mcp_set`, `threads_mcp_listen` and
  `threads_mcp_reply` are there for 103b; nothing on the page calls them yet, so the switch cannot be turned on from the
  app. What changed from the design: the page is handed a call only after it says it listens, so a window that is not
  ready answers at once rather than leaving a call to wait ten minutes; a call's arguments are checked whole in the relay
  as well as by tool name in the door.
- **103b. Settings, the list and the let-in card.** The Other programs section (the switch through the shell, the list from
  item 97's picker, the two lines to copy), `list_chats`, and the let-in card in Needs you with a notification. Safety test: a
  name that is not a number on the list opens nothing.
- **103c. Read and message.** The two cards in Needs you and in the chat, acting through `gatherContext` and `route`, the
  reply, the closed card. An e2e spec on the mock bridge with the stand-in program. Safety tests: M8, M9, M11.
- **103d. A new lane.** `open_chat` through `startOpenedLane`, in the listed chat's project, in its agent's Ask mode, the card
  showing the brief whole. Safety test: an unanswered card starts nothing.
- **Later, each the owner's to want:** the cards on a paired phone after its passkey (item 115's rule); Linux through
  `SO_PEERCRED`; remembering a program across runs by its code signature.

## What it does not do

- Listen on a port, offer an HTTP or remote MCP address, or reach anything off this Mac.
- Let a program list chats the person did not list, name a chat any other way, or reach a chat of another shop or account.
- Answer, allow, deny, dismiss or stop anything, or change a chat's mode, model, level or account, under any setting.
- Act on a press of a card whose call is gone.
- Replace 102k's Kit may reach for the app's own chats.

## Open questions for the owner

1. **Remembering a program.** Let in lasts one run of the program. Should a later setting remember a program by its code
   signature (its team id), so Claude Desktop asks once? The recommendation is no for the pilot.
2. **From a phone.** Should these cards be answered on a paired phone after its passkey, as an Allow is?
3. **Ten chats on the list.** More, or fewer?
4. **Team threads.** This design lets a program read a listed team thread and not send to one, as 102k does. Should a shop's
   threads be listable for outside programs at all?

## What this design did not check

- No outside program was run against a relay. How long Claude Desktop, Cursor and Claude Code wait on a tool call before they
  give up was not measured, so M11's ten minutes may be longer than some programs wait; the card then closes at their cancel.
- Whether every MCP client sends `notifications/cancelled` when it gives up was not checked; a closed input covers a client that
  ends its server instead.
- How each program starts its stdio servers (directly, through a shell, through `npx`) was read from their documentation's
  examples only; M4's list of shells is from that reading.

## Plan rows

Added to `docs/plan.md` under item 103.

| Order | Work | Waits on | Model |
| --- | --- | --- | --- |
| next | 103a. The door, in the shell: `manut --threads-mcp` as a stdio relay, one Unix socket, the peer and program read from the kernel, refused from inside the app, off by default in a file the shell reads, a program let in once per run, one card at a time and a limit, a call closed when it is cancelled or after ten minutes | 103 | Opus |
| proposed | 103b. Settings, MCP and Skills, Other programs: the switch, the list (at most 10, from item 97's picker), the two lines to copy; `list_chats`; the let-in card in Needs you | 103a | Opus |
| proposed | 103c. Read and message cards in Needs you and the chat, through `gatherContext` and `route`; a message never answers an ask; a closed card does nothing | 103b | Opus |
| proposed | 103d. A new lane from `open_chat`, in a listed chat's project, in its agent's Ask mode | 103c | Opus |
