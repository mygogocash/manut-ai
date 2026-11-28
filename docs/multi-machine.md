# Manut AI on more than one machine (item 108)

The design for plan item 108 (`docs/plan.md`; `docs/t3code-parity.md`, "Other machines", group 4 of its order: "a design
pass first, as item 78 had, then phases; built off"). The owner's list of 26 Nov 2026 asked for: the app run without a
window on another machine, a small page in a browser against it, a thread started on the machine the person picks or
the freest one, a terminal, a browser and pictures from that machine, a page that says how each machine is, updates for
all at once, a project moved from one to another, permissions for each connection, and routes by relay, Tailscale or
the local network.

Status on 27 Nov 2026: design only. The decisions are in `docs/decisions/108-multi-machine.md`; the phases are at the
end and are in `docs/plan.md` as 108a to 108j, proposed. On 28 Nov 2026 108b was built (part 11, "What 108b built"),
on the design's recommended answers, which the owner's goal of 27 Nov took as the go-ahead. This design follows item 78's
(`docs/remote-access.md`) and builds on what it built: the relay, the channel, pairing, the decision challenge, the
passkey and the Tailscale door. It revisits two of 78's refusals (78e): no port on the local network, and no counted
tunnel service. Its answer to both is in "Roads".

## The promise this design keeps

Every machine is its own Manut AI, with its own chats, lanes and asks. Whatever a person starts on a machine from
afar is an ordinary lane on that machine, started in its agent's Ask mode, and every ask it makes is that machine's own
approval-core request, settled once by a person's press: at the machine's window, or from a paired device after the
passkey for that one ask. No connection, road, agent or outside program adds a way round that. Nothing reaches a
machine before it was paired, every pairing can be revoked from anywhere, and each connection holds only what the
person gave it.

## What the person gets

### In a shop owner's words

"My old MacBook sits in the back office, plugged in. It keeps working on my shop's website while I am at the market.
On my phone I see what it is doing, and when it wants to publish or delete something it asks me first and I press
Allow with Face ID. When I am at home I start a new job on it from my laptop's browser."

### In a developer's words

"I run Manut AI with no window on a Mac mini. From my laptop's browser, or from the desktop app on my laptop, I see
every machine's lanes, start a new one on the Mac mini or on whichever machine has room, answer its asks, open a
terminal there, watch its preview as pictures, update every machine with one press, and copy a project from my laptop
to the Mac mini. It reaches the Mac mini through the relay, or through my tailnet with no server of Manut's at all."

### What it does not do

- Let an agent on one machine reach another machine: no agent, helper lane, workflow or outside program gets a tool to
  start, read or message anything on another machine (T3 Code's linked environments are not built; 78's reason stands:
  each ask must reach whoever answers for the machine doing the work, which needs a design of its own).
- Answer an ask from afar without a passkey, or let any setting skip asks on a machine.
- Make a shop's sends, posts or payments from a machine. Those stay `apps/api`'s, behind its own signed approvals.
- Share a machine's whole screen. macOS's own Screen Sharing does that; this shows a lane's preview and, later, a
  simulator (item 110), as pictures.
- Keep projects in step between machines. A move is a copy at one moment, and deletes nothing.
- Move a coding agent's sign-in, the credential vault, a keychain item, a shop's sign-in, `.env` or any ignored file.
- Serve the browser page from a machine, or keep a chat's words in the browser after it closes.
- Open a port on the local network unless the person turned that road on for that machine (108j, if the owner wants it).
- Sell, count or host tunnels per machine.
- Run a machine on Linux, Windows or a cloud computer we pay for, in this version (question 3).
- Wake a sleeping machine.

## Words

- **Machine**: a computer running Manut AI that a person reaches from elsewhere. It may have its window open or not.
- **Windowless**: a machine running with its window hidden, started when its user logs in.
- **This Mac**: the computer the person sits at.
- **Connection**: one paired device's access to one machine, with its own level. A phone paired with two machines has
  two connections.
- **Client**: what the person reaches machines from: the browser page (`/app/`) or the desktop app.
- **Road**: how a client reaches a machine: the relay, Tailscale, or the local network.
- **Freest**: the machine with the most room for one more agent, by the rule in "Threads on a chosen or the freest
  machine".

## What is there today (read on 27 Nov 2026)

- **A Mac that serves a phone.** `apps/desktop/src/remote/` (78b): `link.ts` dials the relay, `serve.ts` serves exactly seven
  requests (`REQUESTS`: `list`, `open`, `catchup`, `allow`, `reply`, `stop`, and 78d's `notify`) and refuses others by name
  (`STAYS_ON_MAC`: Always allow, the session, a folder, the dial, pairing, Unpair, the switch and the consent; since 108b,
  `levels.ts`'s `STAYS_ON_MACHINE`, part 11's fifteen names), `project.ts` masks what a
  phone sees, `journal.ts` lets it catch up, `roads.ts` (78f-2b) joins the relay and the Tailscale door into one link.
  The keys live in one keychain item through `src-tauri/src/remote_keys.rs`. All of it runs in the desktop's page,
  where the store and `settleApproval` live.
- **The channel and pairing.** `packages/remote-channel` (78a): the pairing code (two minutes, one try on both sides),
  the four digits the phone shows typed at the Mac, K per device, a fresh key exchange proved with K for each session,
  AES-256-GCM records, and `DecisionChallenges` (one use, 60 seconds, bound to the device, the request, its revision and
  the choice) answered by a passkey with user verification.
- **The phone's side.** `apps/web/src/app/mac/` (78c): the Your Mac tab in the installed `/app/` page, its vault in
  IndexedDB with keys script cannot read back, the greyed view cleared 15 minutes after the Mac last confirmed it.
- **The relay.** `apps/api/src/relay-object.ts`: eight devices a host (`MAX_DEVICES`, so seven phones and one pairing
  door), frames of at most 65,532 bytes, a daily budget of 1 GiB a host (`dailyBudgetBytes`), and nothing read.
- **The Tailscale door.** `src-tauri/src/remote_door.rs` and `tailscale_serve.rs` (78f-2a): one listener on 127.0.0.1:47100
  behind `tailscale serve`, the relay's hello and token hash, caps counted together; `tailscale.rs` reads the state.
- **Windowless, almost.** `src-tauri/src/tray.rs`: closing the window keeps Manut AI running with a menu bar icon, the
  terminals, the bridge and the bots going on. Item 136 stopped the page drawing while hidden. Nothing starts the app at
  login, and its window always opens at launch.
- **What a machine knows of itself.** `machine.rs` (memory, and from it how many agents run at once, `agentsAtOnce` in
  `src/jobs/rules.ts`), `disk.rs` (free space and its level), `power.rs` (keep awake while agents work), `running.rs`
  (what the app's own terminals, chats and previews run), `providers.rs` and `accounts.rs` (agents installed and signed
  in), `report_system.rs` (item 105's version, macOS and chip).
- **Lanes and starting one from elsewhere.** The sessions store's `openLane` (item 103d) starts an ordinary lane in a
  project in its agent's Ask mode (item 89, `ASK_MODE`); `route` (103c) is the one road a message from elsewhere takes
  into a chat, held while a turn runs or an ask waits.
- **A window that shows a site and reaches nothing.** `src-tauri/src/outpost/browser.rs`: a webview window of its own
  that no capability names, whose commands the shell refuses, whose navigation stays on its origins.
- **Previews.** `preview.rs`: a lane's dev server on a port the app started, which `running.rs` attributes to it.
- **Updates.** The signed in-app updater (`tauri_plugin_updater` in `lib.rs`), whose feed and minisign key are compiled in
  (`tauri.conf.json`, `plugins.updater`).
- **An older idea.** `src/peers/peerKey.ts` keeps Oh My Hermes' naming of a bot on another computer (`<peer>:<name>`);
  `lib.rs` says the fork's SSH links to other computers were not kept: "the shell owns only local processes".

## What was read elsewhere

### T3 Code (MIT, `pingdotgg/t3code` at `186f6aac5740f2662e6fa2e2d4a66ad39caa6410`)

Read its documentation only, through GitHub's API, no code: `docs/user/remote-access.md`, `background-service.md`,
`updating.md`, `devices.md`, `diagnostics.md`, `terminal.md`, `thread-migration.md`, `portable-handoffs.md`;
`docs/internals/04_environment-auth.md`, `05_remote.md`, `06_t3-connect.md`, `07_server-updates.md`,
`09_connection-runtime.md`; and `SECURITY.md`.

What it does. Each machine runs a server (an "environment") that keeps its own sessions; desktop, browser and phone are
clients. Routes are LAN, Tailscale HTTPS, SSH and T3 Connect, its hosted service, which hands out a paid tunnel for each
host: three free, ten or a hundred on a paid T3 Chat plan. That is the counted tunnel 78e refused. The CLI service
binds to localhost by default; `--lan` listens on LAN and Tailscale addresses, and "anyone on that network can reach the
port (gated by pairing)". Plain HTTP on a LAN is "the user's choice", and its phone app allows any load to reach it; the
hosted web app needs HTTPS (T3 Connect or Tailscale). Pairing hands out scoped sessions (`terminal:operate`,
`filesystem:read` and others) that only narrow, and its security notes say a full grant equals a shell as the server's
user. Load balancing is kept per client, with Prefer, Normal, Less often and Manual only. Update everything at once
shows which machines are skipped and how many threads pause. Each machine updates itself through a launcher that stages,
snapshots its database and rolls back, and it never continues a turn that was waiting on an approval. Browser tabs live
on the host and stream to web and phone; simulators run on the host machine.

Taken:

- **Routes are hints; identity is the key** (`05_remote.md`: "Routes are untrusted hints", verify that a route "answers
  as the expected environment before sending credentials", never downgrade from HTTPS). Rule R10.
- **Narrowing only** (`04_environment-auth.md`): a grant is never widened by a client, and "revoking is not capped by
  the caller's scopes". Rules R4 and R5.
- **The hosted page is a client** that keeps its list of machines in the browser and connects to each directly, with the
  pairing secret in the link's fragment. Already 78's.
- **Update all** naming skipped and busy machines, and never continuing a turn that waits on an approval after a
  restart. Rule R11.
- **Load balancing's four preferences**, kept per client. "Threads on a chosen or the freest machine".
- **Repository identity across machines**: T3 Code matches clones by their remotes, and "work never silently crosses
  environments". Here the first commit is added to the remote's address. "Threads on a chosen or the freest machine".
- **Take control** before typing into a streamed browser. "The browser and pictures from that machine".
- **A terminal's scrollback held on the machine**: 5,000 lines and 8 MiB. "A terminal from that machine".

Not taken:

- **Its LAN listener and plain HTTP.** Our client is a page over HTTPS, which cannot open an unencrypted socket, and a
  port on shop Wi-Fi is reachable by every customer's phone. Only a narrow local road between two Manut AI apps is
  proposed, last and off (108j).
- **T3 Connect's managed tunnels and their count.** Our relay carries the same encrypted channel with no slot to count.
- **SSH environments** that download and run a server over SSH: the machine here installs Manut AI itself, signed.
- **Peer links and `delegate_task` to another machine**: not in this design (question 8).
- **A full grant that equals a shell by default.** Here the default is Answer, and a terminal is its own permission.
- **A browser tab that loads the remote page locally through a tunnel**: here the client gets pictures only.

### Orca and GoSpark

Not read again for this design. Item 78's reads stand: Orca at `stablyai/orca` commit `bc471d51` (its Tailscale road is
an unencrypted socket on every network, which `docs/remote-access.md` explains we cannot copy), and GoSpark's remote
access, which the relay and the channel were lifted from.

## The parts

### 1. The windowless machine

**What process.** The same Manut AI app, the same signed bundle, with nothing new to install. A setting turns it on:
Settings, Sharing and access, "Run as a machine" (off; a consent sheet first: what keeps running, that the Mac must stay
logged in and awake, what the relay sees, how to stop). With it on:

- A login item starts Manut AI when the person logs in, with its window hidden and no Dock icon. The menu bar icon
  (`tray.rs`) says "Manut AI is running as a machine", with Open Manut AI and Quit. Which way the login item is made
  (Tauri's autostart plugin, or macOS's own login item service with no crate) is read in 108a; a new crate is the
  owner's to allow.
- The page runs hidden, so everything that lives in it today keeps working: the store, the sessions, `settleApproval`,
  the remote host and its roads. Item 136 already holds drawing still while hidden; the link's own timers are not the
  page's clock.
- Opening the window shows the whole app, for setting up and for work at the machine.
- "Keep awake while agents work" (`power.rs`) stays on. Closing a laptop's lid still sleeps it, and the consent sheet
  says so: a Mac mini or a laptop left open and plugged in is the machine this is for.
- The machine is offline after a restart until its user logs in. With FileVault on, macOS does not log in by itself.

**What it exposes.** Nothing that listens, by default. It dials out to the relay as `link.ts` does, and, when the person
turned the Tailscale road on, listens on 127.0.0.1:47100 behind `tailscale serve` as `remote_door.rs` does. Both carry
the same channel, and inside it the requests of "Permissions for each connection", served by `serve.ts` widened. The
local road (108j) is a third door, off unless turned on.

**The open risk.** 78b left one thing unobserved: whether the page's socket and timers hold while the window is hidden
for long. A windowless machine depends on it. 108a's acceptance is an hour hidden, with a lane running and the relay's
`lastHostSeen` steady; if it does not hold, `link.ts` moves into the Rust shell, as 78b planned.

### 2. Pairing and trust

Pairing is 78's, unchanged, on every road: a code from the machine, the four digits the new device shows typed at the
machine, a passkey made by the new device, and the device's record in the machine's keychain item. What changes:

- **Setting up a windowless machine.** The person sets it up once with its window open (install, sign in to the coding
  agents, turn on Run as a machine, pair the first device), then closes the window. macOS's Screen Sharing serves the
  same when the machine has no screen.
- **Pairing from afar** (108h). A connection with Manage asks the machine for a new code, which it shows; the new device
  reads it and shows its digits; the person types them into the managing connection and answers its passkey; the
  machine records the new device with the level the person picked, never above the manager's own. The machine still
  makes the code and checks the digits once; the managing connection only carries them.
- **Each connection has a level** (part 11), kept in the device's record and checked by the machine.
- **Revoking from anywhere.** Any connection may revoke any other on the same machine, after its passkey. Revoke
  everywhere on the machines page sends one revoke to each machine the device reached.
- **A connection unused for 30 days** is dropped by the machine, as the relay forgets a Mac unseen for 30 days; the
  device pairs again.
- **No shortcut on a private network.** As 78f says of the tailnet: a network being private says nothing about the
  person's yes to this one ask. The local road has the same pairing, K and challenges.

### 3. Roads: relay, Tailscale, and the local network

| Road | How | Who it suits | What it costs | What it exposes |
| --- | --- | --- | --- | --- |
| Relay | The machine and the client both dial `apps/api`'s relay | Everyone, no setup | Cloudflare's Workers Paid plan and Durable Object use (78's figures), and each machine's 1 GiB a day | Addresses, times and byte counts to the relay; no content |
| Tailscale | 78f's door behind `tailscale serve`, under the machine's `ts.net` name | A person with a tailnet; no server of ours | Nothing of ours; Tailscale's own plan | Every tailnet device can reach the door and gets nothing without a token and K |
| Local network | A door on the machine's private addresses, desktop to machine only (108j) | A shop with a machine in the back room and no tailnet | Nothing | Every device on that network, customers' phones on shop Wi-Fi included, can reach the door and gets nothing without a token and K |

**The local network, revisited.** 78 refused a port on the local network for two reasons. The first still holds for
the browser page: a page over HTTPS cannot open an unencrypted socket, a local address has no certificate a browser
trusts, and a page over plain HTTP is not a secure context, so it has neither Web Crypto's keys nor passkeys. The second
was a port on shop Wi-Fi that customers share. Two Manut AI apps are different: the desktop's Rust shell can open a
plain socket to the machine, and the channel inside it is already end to end, so the network carries only ciphertext,
as the tailnet does. What is left is the door itself, reachable by everyone on that network: new code that reads bytes
before the hello, a place to make the machine busy, and the fact that a machine is there.

Recommendation: allow it narrowly, last, and only if the owner wants it (question 1). Desktop to machine only, never
the browser page. Its own switch and consent sheet on each machine ("Anyone on this network can try to reach this
machine. It answers only devices you paired. Do not turn this on over Wi-Fi your customers use."). Bound to the
machine's private addresses only, never announced on the network (no Bonjour), the same hello, token hash, caps and
idle close as 78f's door, and its address learned only inside the channel. Tailscale is the recommended road for
speed: it is direct between two machines on the same network when it can be, and opens nothing on the shop's Wi-Fi.

**The counted tunnel, revisited.** Still not built. A hosted service that hands out and counts a tunnel for each
machine is what T3 Connect sells; it would make us a tunnel provider and put a price on each machine. The relay already
carries the channel for any number of machines, each a host of its own with its own 1 GiB a day, and limits are about
cost and abuse, never a tier. What this design adds is care about bytes: chats, asks, terminals and a picture a second
fit the relay; a project move over the relay is capped at 256 MB so a machine's day still has room for its chats, and
larger moves go by Tailscale or the local road. Whether the relay's cost is acceptable for this traffic is question 2.

**Which road a client takes.** As 78f-2c: the client dials the roads it knows for that machine, the faster ones first
(the local road, for the desktop only, then the tailnet, then the relay after 1.5 seconds), and the first to say `ready`
carries the session.
Every road learns its address inside the channel, never from the network.

### 4. The browser page

The hosted `/app/` page, never a page a machine serves: one origin, one installed app, one passkey per pairing, checked
the same way on every road (78f's reasons). Its Your Mac tab becomes Your machines:

- A list of the machines this browser paired with, each with its state (part 8 in short: online or when last seen,
  working, waiting on you), and Pair a machine.
- A machine opens on its chats as Your Mac shows them today, Working, Needs you and Done, with their asks.
- With Work: New thread (part 5), a box to message a coding chat, pictures, the preview as pictures (part 7).
- With Terminal: Open a terminal (part 6).
- With Manage: Update, Pair a device, the connections and their levels.
- A wide layout for a laptop's browser: the machine list on the left, the chat on the right. The phone keeps today's.
- The vault keeps one record per machine (host id, device id, door token, K as a key script cannot read back, passkey
  id, the roads it knows). Nothing of a chat is kept; the greyed view clears 15 minutes after the machine last
  confirmed it, as 78c's.

### 5. Threads on a chosen or the freest machine

New thread asks for a project, an agent (with its model and effort) and the first message, as Chat with Kit does, and
shows a machine chip: Freest (named, for example "Freest: Mac mini") or a machine the person picks. The pick is shown
before Start, never made silently.

**Which machines can take it.** Online now; the person's connection there holds Work; the machine has the project; the
agent is installed, turned on and signed in there; its disk is not at the critical level (`disk.rs`); and the person did
not mark it Manual only.

**Which is freest.** By the person's preference for each machine (Prefer, Normal, Less often, Manual only; T3 Code's,
kept on this client), then by room: how many agents that machine runs at once (`agentsAtOnce` from its memory) less the
lanes working or waiting there; then by free disk; then by name, so the same state always picks the same machine. When
none has room, the chip says so and the lane waits on the machine picked, as lanes past the memory cap wait (102h). A
pure function, `machines/pick.ts`, with table tests.

**The same project on two machines.** A project is the same when its remote's address (host and path, no user or
password) and its first commit match, read by each machine's shell with the app's own git rules (item 114). A machine
that lacks the project offers Move it there (part 10).

**What starts.** The `start` request names the project, the agent, the model, the effort, a title and the message.
The machine starts an ordinary lane through the sessions store, as 103d's `openLane` does, in the agent's Ask mode,
beside the person's own lanes; its asks are the machine's, and every connection with Answer sees them. A message to an
existing coding chat goes through `route`.

### 6. A terminal from that machine

With Terminal, Open a terminal starts a login shell on the machine in a project folder there or its user's home,
never a command named by the request. Each opening needs a passkey. The machine keeps the scrollback (5,000 lines and
8 MiB, T3 Code's); the client keeps it in memory only. A terminal from afar closes after 15 minutes without input, and
whenever its session drops. The machine's window lists terminals opened from afar, with which device opened each and
Close; the journal records that one opened and closed, never what was typed or printed.

A terminal is the person's own typing, as SSH would be: it is not an agent and is not read by Kit's dial. That is why
it is its own permission, off for every connection until the person gives it, and why nothing an agent writes reaches
it. On the client a terminal from afar does not let a program write to the clipboard.

The browser page needs a terminal emulator; the desktop has `@xterm/xterm`, and adding it to `apps/web` is the owner's
to allow.

### 7. The browser and pictures from that machine

**Pictures** in a chat (what the person or an agent attached, a screenshot an agent took) come with Watch, on request,
as PNG, JPEG or WebP of at most 4 MiB, scaled down by the machine when larger. SVG is refused: it can carry script
(item 98's lesson). The client shows them from memory and keeps none.

**The browser** is a lane's preview. With Work, View preview has the machine open the preview in a window of its own
built as the outpost's is: no capability names it, the shell refuses its commands, its navigation stays on the
preview's origin, pop-ups are refused. It opens only addresses on ports that machine's own previews started (`preview.rs`,
`running.rs`), so it cannot be pointed at the shop's network or the internet. The machine sends a picture of that
window at most once a second while the client shows it, and when it changes. Clicks and typing go to that window only
while the person holds Take control, and the window shows that someone is in control. The page's own scripts run on the
machine; nothing of it runs in the client's origin. How the shell takes the window's picture is read in 108g.

### 8. The machines page

On the client (the browser page and the desktop), one row per machine:

- Its name, online or when last seen, and the road in use.
- Version, and whether an update is ready.
- What runs: lanes working, lanes waiting, asks waiting on the person.
- Room: "2 of 3 agents" from its memory and lanes, its disk level, keep awake on or off.
- Agents installed, turned on and signed in, by name only.
- Tailscale's state (78f's four lines), and which roads are on.
- This connection's own level, and Narrow it.

Details, with Manage: item 105's masked report (versions, the last errors with every key and path masked) and the
machine's connections with their levels, last seen and Revoke. After a loss (R8): what that machine last reported as
signed in, as a list of what to sign out of at each provider.

A `status` request answers the row; a machine sends it again when anything on it changes, at most every 5 seconds.

### 9. Updates for all at once

Update all, on the machines page, needs Manage on each machine it updates. A confirmation lists each machine with its
version and the newest, which will restart, and which are skipped (offline, Manual only, or a connection without
Manage), and how many lanes are working on each. Then each machine is sent `update` with its passkey answer.

The request has no field for an address, a file or a version. The machine checks the feed compiled into it with its own
updater, which checks the signature with the key compiled in, and installs when no turn runs and no ask waits, at most
a day later; "Now" on the confirmation stops those turns, and names them first. After the restart nothing resumes by
itself: a lane that waited on an ask still waits. The client sees the new version in the machine's next `status`, or
"did not update" and why. This Mac's own app updates as it does today.

A machine on an older version answers `status` with the requests it serves, and the client offers only those, so a
newer client never sends an older machine what it cannot read.

### 10. Moving a project

Move to another machine, from a project's menu on the client, copies a project from this Mac or one machine to another,
through the client: the desktop reads its own project directly; between two machines the client carries the chunks.
With Work on both.

1. The source lists what would go: each branch the person picks (the current one and its base by default) as a git
   bundle; uncommitted changes to tracked files as one patch; untracked files that are not ignored. Ignored files
   (`.env`, build output), `.git/config`'s credentials, hooks, lane folders and the app's own refs never go. The
   remote's address goes without any user or password in it.
2. The shared masker (`lib/secrets.json`) reads the patch and those files. A file with a key is held, named, for the
   person to leave out.
3. The person picks a folder on the target that does not exist yet, under its user's home, and presses Move: a passkey
   for the source and one for the target, each bound to a digest of the list shown.
4. The chunks travel in the channel (4 MiB messages). Over the relay a move is at most 256 MB.
5. The target clones from the bundle with the app's own git rules (item 114), applies the patch, writes the files, sets
   the remote, and adds the project. Nothing is deleted on either side; the old copy goes only through that machine's
   own Remove ask.

A thread does not move with it: Continue on another machine starts a new lane there with item 97's context text,
which the person reads first, as Continue with does for another agent.

### 11. Permissions for each connection

Three levels, each with everything of the one before, and two permissions added to Work:

- **Watch**: see the chats and their asks, say No, Stop a turn, see pictures and the machine's state.
- **Answer**: also Allow once and answer questions, each with a passkey. Today's phones have exactly this.
- **Work**: also start lanes, message coding chats, view the preview, move projects.
- **Terminal** (with Work): open a terminal.
- **Manage** (with Work): update the machine, pair a device from afar, change levels, see its masked report.

A new pairing is Answer unless the person picks otherwise. The machine checks the level for every request, by the
channel's device id, never by anything the client says.

| Request | What it does | Needs | Passkey |
| --- | --- | --- | --- |
| `list`, `open`, `catchup` | The chats, one chat, what was missed | Watch | No |
| `reply` with No, `stop` | Hold back | Watch | No |
| `status`, `picture` | The machine's state; a picture in a chat | Watch | No |
| `notify` | This device's push address (78d), so the machine can wake it with a push that says nothing | Watch | No |
| `allow`, `reply` with an answer | As today | Answer | Each one |
| `projects` | The projects there, with their identity | Work | No |
| `start`, `send` | A new lane in Ask mode; a message to a coding chat | Work | The first of a session, and after 15 minutes without one |
| `view_open`, `view_input`, `view_close` | The preview as pictures, Take control | Work | As `start` |
| `move_list`, `move_out`, `move_in` | A move | Work | Each move, on each side |
| `term_open`, `term_input`, `term_resize`, `term_close` | A terminal | Work and Terminal | Each opening |
| `update`, `report` | Update itself; the masked report | Work and Manage | `update` only |
| `pair_code`, `pair_allow`, `set_level` | A device from afar; a level | Work and Manage | Each |
| `revoke` | Remove a device | Any | Yes, unless it removes itself |
| `always`, `allow_always`, `session`, `allow_session`, `folder`, `dial`, `mode`, `pair`, `unpair`, `switch`, `consent`, `road`, `sign_in`, `vault`, `settings` | Refused by name: `stays_on_machine` | Never | |

Stays on the machine, as 78's list stays on the Mac: Kit's dial and a project's level, Always allow and Allow this
folder, a lane's mode, turning a road or the main switch on, the consent sheets, the coding agents' sign-ins, the
credential vault, and Settings. A connection with Manage changes levels and pairs devices, never these.

**What 108b built** (28 Nov 2026, built switched off: nothing new reaches a phone that was not already paired).

- `apps/desktop/src/remote/levels.ts`, pure: the levels and permissions, the whole table above as `REQUEST_TABLE` (with
  each request's level, permission and passkey), `STAYS_ON_MACHINE`, `covers`, `ruleFor` and `mayGive`. The table's
  grouped rows are read so: a move asks for a passkey at `move_out` and `move_in`, not at `move_list`; a terminal at
  `term_open` only; `update` asks and `report` does not. `reply` is a No only when it says no and carries no `answer` or
  `answers`, so no request passes as a No and is then read as an answer. `revoke` and `set_level` each have an `own` form
  (removing itself; narrowing its own level, which `mayGive` checks narrows) that any level may send without a passkey.
  `levels.test.ts` writes every cell out by hand.
- `serve.ts` serves the same seven requests and no more; every other name of the table is still `unknown_request`. Each
  request is checked against the level in the device's own record, read by `channel.deviceId`, before anything is looked
  up, challenged or settled, and again right before anything is settled, as Unpair is. A request the level does not cover
  is refused whole as `level`; a device whose record has no level this Mac can read is refused everything as
  `unknown_device`. The names refused by name still answer `stays_on_mac` on the wire, which phones already read.
- The level lives in the device's record in the keychain item (`remote_keys.rs`: `level`, `terminal`, `manage`). A record
  from before has none and reads as Answer; Answer is written as no level at all, so a build from before 108b still reads
  every record whose phone was never narrowed; a level this build does not know makes the whole item unreadable, as any
  field it cannot read does, never Answer. A new pairing is Answer. `remote_keys_set_level` changes it, switch on or off.
- Settings, Sharing and access shows each phone's level and sets Watch or Answer (`OFFERED_LEVELS`); a narrower level is
  held in the page before the keychain write, so the phone's next request meets it. The phone says the Mac's `level` in
  plain words on the ask it answered.

### 12. The desktop as a client

The desktop on this Mac reaches machines as the browser page does (108e): Settings, Machines (pair with a machine, its
level, Forget), a machine chip in the + menu's Chat with Kit and New lane, a remote lane's row marked with its machine
in the sidebar and in Needs you, and the machines page. The client's code (`apps/web/src/app/mac/`'s session, decision,
vault and pairing) moves into a package both apps use. The desktop's content policy gains `wss://*.ts.net:47100` and
nothing wider; the local road, when on, is a socket the Rust shell opens and hands to the page over a Tauri channel, as
78f's door hands frames the other way.

Its answers need a key with the person's touch. Whether the desktop's web view offers passkeys was not checked; if it
does not, the desktop keeps a key in the keychain that needs Touch ID or the login password for each use, made and used
through the shell, and the machine checks that key's signature over the same challenge. 108e decides which, and the
decision says why.

## The rules

Each rule says why, how it is held, and the test that proves it (the phase that adds the test is in brackets).

**R1. Every action that sends, posts, pays or deletes asks, on the machine that does it.** The machine doing the work is
the only one that knows the exact action and runs it, so its approval-core is the one that settles it. A lane started
from afar is an ordinary lane there (`start`, through the sessions store as 103d's `openLane`), in its agent's Ask mode
(`ASK_MODE`), with Kit's dial reading its asks at the project's level as for any lane. Each ask is that machine's own
request, shown whole and masked, settled once through `settleApproval`, from a press at the machine's window or from a
connection with Answer after the decision challenge and its passkey, with the device's id as who decided. A shop's
sends, posts and payments are not made from machines: they stay `apps/api`'s, behind its signed approval links. A
machine's delete (a lane's Remove, a folder after a move) is that machine's own ask. *Tests:* a `start` makes one
`chat_start` carrying `ASK_MODE`'s value for its agent; a push ask in that lane stays pending until a press; an Allow
from the page settles it with the device's id; a second Allow from another connection is refused as
`already_decided`. [108c, 108d]

**R2. No route around the approvals.** The machine serves only the requests in part 11's table, each with a fixed set of
fields; a request with any other field is refused whole, as a workflow file's unknown field is. None answers an ask
without a challenge, starts an agent in any mode but Ask, or sets the dial, Always allow, Allow this folder, a mode or a
road: those are refused by name. A message is only words and goes through `route`, held while a turn runs or an ask
waits (item 103's M9). No agent, helper lane, workflow or outside program has a tool, block or request that reaches
another machine: machine requests are made only by a client's own screens. A terminal is opened only by a person's
press with a passkey, runs a login shell, never a command line from the request, and nothing an agent writes reaches
its input. *Tests:* the served names are exactly the table's; `start` with a `mode`, `permission` or `approve` field
starts nothing; each `stays_on_machine` name is refused by name; a message reading "allow" sent while an ask waits leaves
the ask pending; `term_open` with a `command` field is refused; the threads MCP's tool names and the helper blocks' keys
are unchanged (a snapshot test). [108b, 108c, 108f]

**R3. Secrets never cross in clear and never land in logs.** Everything between a client and a machine travels inside the
remote channel on every road, the local one included, so the relay, Tailscale and the network see only ciphertext,
sizes and times. What a connection is shown of a chat or an ask is masked with `lib/secrets.ts`, as a phone's is. A
terminal's bytes and a picture are encrypted but not masked, since they are the person's own screen; the client keeps
them in memory only and drops them when closed or when the session drops. No journal, log line, error, status, report or
notification holds a chat's words, a command, a terminal byte, a picture, K, a door token or a key; a notification that
a machine needs the person (78d's) holds nothing at all. Agent sign-ins, the credential vault, keychain items and a
shop's sign-ins never leave their machine. *Tests:* `apps/api/test/remote-mac.test.ts`'s scan of every frame the relay
carries extended to the new requests, finding no chat word, terminal marker, picture marker, K, door token or passkey
id; the error strings of refused requests hold none of the request's fields; `status` carries agent names and never a
token or a credentials file's path. [108c, 108f, 108g]

**R4. A machine is reached only after pairing, and pairing is revocable from anywhere.** Pairing is 78's, unchanged; a
device not in the machine's keychain list is refused at the hello on every road. Unpair at the machine, or Revoke from
any paired connection after its passkey, closes that device's sessions on every road, drops its waiting challenges,
deletes its K and revokes its relay door. Forget on a client deletes the client's K for that machine and tells the
machine. A connection unused for 30 days is dropped. *Tests:* a hello from an unknown device is refused on the relay and
on the door; a revoke from connection B ends A's session on both roads and refuses A's next hello; Revoke without a
passkey is refused; Forget sends `revoke` for itself and empties the vault's record; a record unseen for 30 days is
dropped at the machine's daily sweep. [108b, 108c, 108d]

**R5. Least privilege for each connection.** A connection holds the level in its record, Answer unless the person picked
otherwise. The machine checks it for every request by the channel's device id. A connection with Manage gives levels up
to its own, never above (it cannot give Terminal without holding it). A connection may narrow its own level without a
passkey. A record written before this item reads as Answer, so today's phones keep today's six requests exactly.
*Tests:* every cell of the request-by-level table; a level claimed in a hello or a request changes nothing; Manage
without Terminal cannot give Terminal; an old record is Answer. [108b, 108h]

**R6. A passkey for each act that does something from afar.** The machine issues a decision challenge (one use, 60
seconds, bound to the device, the request, its revision and the choice) and acts only after the device's passkey, or the
desktop's key, answers it with the person's touch: for Allow once and every answer, as today; for each terminal opened
(the choice names the folder); for the first Work request of a session and the first after 15 minutes without one; for a
move, on each side (the choice is a digest of the list shown); for an update (the version); and for approving a device,
changing a level and revoking another device. No and Stop need none: they only hold back. *Tests:* each of those
without a valid answer is refused; a terminal's challenge answered for an Allow is refused; a Work challenge older than
15 minutes is refused; No and Stop pass without one. [108c, 108f, 108h, 108i]

**R7. A lost or stolen device opens little, and is shut out from anywhere.** Without the device's own unlock at each act
(R6), an unlocked device with the page open can watch, say No and Stop, and nothing else. An open terminal closes after
15 minutes without input and when the session drops. Revoke everywhere, from any other paired device, sends one revoke
to each machine the lost device reached. The weak spot is the one 78 named: a passkey also accepts the device's
passcode, and it can sync through iCloud Keychain. *Tests:* a terminal with no input for 15 minutes
is closed on a stand-in clock; Revoke everywhere sends one `revoke` to each machine and each refuses the device's next
hello. [108d, 108f, 108h]

**R8. A lost or stolen machine opens nothing else.** Each pairing has its own K and device id, so a key a machine holds
opens only that machine's channel. Machines are never paired with each other here, so a machine holds no key to another
machine, and a machine never dials a device. On a client, Forget this machine deletes its K, and the machines page
lists what that machine last reported as signed in (agent names, the GitHub account), as a list of what to sign out of
at each provider. The machine's keychain item and the agents' sign-ins are behind macOS's login password and FileVault,
which the consent sheet asks the person to keep on. *Tests:* two machines paired with one browser have different K and
device ids, and a session opened with machine A's K to machine B fails its handshake; Forget empties the vault's record;
the after-loss list holds names only. [108c, 108d, 108h]

**R9. No port on any network unless the person turned that road on for that machine.** A machine dials out to the
relay. 78f's door listens on 127.0.0.1 only, reached through `tailscale serve`, on a port Funnel cannot use. The local
door (108j) exists only while its own switch is on, binds only to the machine's private addresses (10.0.0.0/8,
172.16.0.0/12, 192.168.0.0/16, fd00::/8 and link-local), on one fixed port, answers nothing but the relay protocol's hello
within 10 seconds, holds at most 8 sockets before a hello, closes a silent device after three minutes, and is never
announced on the network. The browser page never uses it. *Tests:* with the switch off no local door is made (a stand-in
listener factory sees no call); the door refuses to bind to `0.0.0.0`, `::` or a public address; turning the switch off
closes every socket; the pre-hello cap and timeout. [108j]

**R10. Roads are hints; the key says who a machine is.** A client learns a machine's tailnet or local address only
inside the channel (as 78f-2c's `road`), sends nothing but the hello before the machine proves K, and drops a road whose
machine proves another host id. The page's and the desktop's content policies name only the relay and
`wss://*.ts.net:47100`. A road never changes a level: a connection's level is the same on every road. *Tests:* a door
that answers as another host is refused before any request; both policies name nothing wider; one device's level holds
on the relay and on the door alike. [108d, 108e, 108j]

**R11. Updates come only from the signed feed, when the machine is idle.** `update` has no field for an address, a file
or a version. The machine checks the feed compiled into it with its own updater, which checks the signature with the
key compiled in, and installs when no turn runs and no ask waits, or at once only after a confirmation that named the
lanes that will stop. After the restart nothing resumes by itself. *Tests:* `update` with a `url` field is refused
whole; a busy machine answers `waiting` and does not install; the updater's feed is the config's (a test reads
`tauri.conf.json`); after a stand-in restart a waiting ask is still pending and no turn was sent. [108h]

**R12. A move copies, asks first, and carries no secret.** As part 10: the list shown first, ignored files, credentials,
hooks and the app's refs never in it, a file with a key held, a passkey on each side bound to the list, a new folder only
on the target, the app's own git rules, nothing deleted, at most 256 MB over the relay. *Tests:* an existing target folder
is refused; a patch with a key is held and the file named; the source folder is byte for byte unchanged after a move; an
ignored `.env` is in neither the bundle nor the list; a remote address with `user:token@` arrives without it; a 300 MB
move over the relay is refused with its reason. [108i]

**R13. What comes from a machine is shown, never run, on the client.** A picture is PNG, JPEG or WebP, decoded as an
image; SVG is refused. A lane's preview runs on the machine, in a window with no app commands, only on ports that
machine's previews opened, and reaches the client as pictures; input reaches it only while the person holds Take
control. Links in a chat's text stay plain text (78c). A terminal's output goes into the terminal only, and a program's
request to write the clipboard is refused. *Tests:* an SVG picture is refused; `view_open` naming a port the machine's
previews did not open is refused; the preview window has no capability (the outpost's capability test extended); input
without Take control is dropped; a clipboard sequence in a terminal's output does not reach the clipboard. [108f, 108g]

## The threat model

| Who | What they could try | What answers it |
| --- | --- | --- |
| Someone on the same Wi-Fi, a customer | Find a machine and reach it | No port unless 108j's road is on (R9); with it on, only a hello before K, caps, private addresses, never announced (R9, R4) |
| Whoever runs or breaks into the relay | Read or change traffic, pair a device, replay a decision | The channel (R3); the code's secret and the typed digits (R4); challenges bound and used once (R6). It sees addresses, times and sizes |
| Tailscale's coordination server, or another device on the tailnet | Add a device to the tailnet; open the door | A token and K (R4, R10); TLS ends in Tailscale, the channel does not |
| A thief with a locked phone or laptop | Use its connections | The device's unlock at each act (R6); Revoke everywhere (R7) |
| A thief with an unlocked device and the page open | Allow, start work, open a terminal, move, update | Watch, No and Stop only (R6, R7); the passcode fallback stays the weak spot |
| A thief who takes a machine | Use its agents' sign-ins and projects, reach the person's other devices | No key to anything else (R8); Forget, and the list of what to sign out of (R8); macOS's login and FileVault |
| An agent misled by what it read, on one machine | Approve its own asks, reach another machine, open a terminal, update | Asks settle only by a person's press (R1); no tool reaches another machine, terminals and updates are only a person's requests (R2, R6) |
| An outside program on a machine (item 103) | Drive other machines through Manut AI | It reaches only listed chats on its own Mac (`docs/mcp-threads.md`, M5, M7); no machine request through it (R2) |
| A paired machine that turned bad | Mislead the person, attack the client, plant code in a move | Asks masked and whole, links plain, pictures raster only, no clipboard writes (R13, R3); a move brings files the person listed, never hooks (R12) |
| Whoever deploys the hosted page | Ship script that misuses the keys while it is open | The risk 78 named, which a native app removes (item 111); keys cannot be read out |
| Whoever controls the update feed or the road to it | Install their own build | The signature checked with the key compiled in; no address in a request (R11) |
| Someone who photographs a pairing code | Pair their own device | Two minutes, one try on both sides, the digits typed at the machine or a Manage connection (R4) |
| Someone who floods a machine | Spend its relay budget or its door | The relay's daily budget and per-source limits; the doors' caps (R9) |

## Phases

Each phase is one pull request, built switched off, with its tests and the safety test of its rules. Pure rules and the
machine's side come before screens. 108a and 108b can run side by side; 108f to 108i follow 108d in any order; 108j comes
last and only if the owner says yes.

| Item | What it delivers | Needs the owner |
| --- | --- | --- |
| 108a | Run as a machine: the setting and its consent sheet, a login item that starts Manut AI hidden with no Dock icon, the menu bar line, and the machine's status read in the shell (version, memory and room, disk level, lanes, asks, agents signed in by name, keep awake). Acceptance: an hour hidden with a lane running and the relay link steady | An hour's look on a real Mac (this one locked, or a second Mac); a crate if the login item needs one |
| 108b | Permissions, pure and on the machine: the levels, the request table, `stays_on_machine`, the level in the keychain record (old records read as Answer), the check in `serve.ts`, Settings' list showing and narrowing each | Nothing |
| 108c | Work requests on the machine: `status`, `projects` with identity, `start` through `openLane`, `send` through `route`, `picture`, `revoke`, the Work passkey, and `machines/pick.ts`; tested through the real relay object | Nothing |
| 108d | Your machines in `/app/`: the list, each machine's chats and asks, New thread with the machine chip, messages, pictures, Forget and Revoke everywhere, the laptop layout, one vault record per machine | The dev relay on (78c's ask) or a tailnet, and a real browser with Touch ID or Face ID |
| 108e | The desktop as a client: Settings, Machines, the chip in the + menu, rows marked by machine, the shared client package, the desktop's key | A second Mac; the key's kind confirmed from 108e's check |
| 108f | Terminals from afar: Terminal, a login shell in a known folder, a passkey each opening, scrollback on the machine, the idle close, the list on the machine | `@xterm/xterm` in `apps/web` (a dependency); a second Mac, or the page against this Mac |
| 108g | The preview as pictures: the machine's own window with no commands, its ports only, a picture a second, Take control | A second Mac |
| 108h | The machines page and Update all: details, preferences, the confirmation, updates from the signed feed when idle; pairing a device from afar | A published release, and a machine on the one before it, to try an update (releases are the owner's) |
| 108i | Moving a project: the list, the masker, the passkeys, a new folder only, the 256 MB relay cap | A second Mac; Tailscale for a large project |
| 108j | The local road, desktop to machine: its switch and consent, private addresses only, never announced, 78f's door rules | The owner's yes (question 1), and a second Mac on the same network |

Pushes ("A machine needs you", with no content) are 78d's, unchanged except for the words, once 78d is built.

## Open questions for the owner

1. **A road on the local network.** Recommended: yes, narrowly and last (108j): desktop to machine only, never the
   browser page, off on each machine with its own consent, private addresses only, never announced. Tailscale stays the
   recommended road.
2. **A counted tunnel, and the relay's cost.** Recommended: still no counted tunnel. The relay carries machines as it
   carries phones, each machine within today's 1 GiB a day, moves over it capped at 256 MB. Turning the dev relay on is
   78c's same ask (Workers Paid, $5 a month at least, from 78's reading of Cloudflare's prices).
3. **Which computers can be machines.** Recommended: Macs only for the first version. A Linux server needs a way to run
   the page with no display, and Linux has no released build yet (item 111); it is an item of its own.
4. **A terminal from afar in the pilot.** Recommended: yes, as its own permission, off for every connection, a passkey
   for each opening, closed after 15 minutes idle.
5. **Someone else's device as a connection.** Recommended: only the person's own devices in the pilot. The levels allow
   a helper's phone with Watch or Answer later, once the machine's journal says which device did what.
6. **Pairing from afar.** Recommended: yes, by a connection with Manage, with a passkey, never wider than its own.
7. **When a machine installs an update.** Recommended: Update all is the person's press; each machine installs when no
   turn runs and no ask waits, within a day, and says so if it could not.
8. **Agents reaching other machines** (T3 Code's linked environments and `delegate_task` to another machine).
   Recommended: no in item 108. If wanted, a design of its own with item 102's helper lanes, where each helper's ask
   reaches the person through the machine it runs on.
9. **The words** of the two consent sheets (Run as a machine, and the local road), naming who runs the relay. These are
   the owner's, as 78's were.

## What 110 and 109 would build on

**Item 110, phone simulators.** A simulator runs on a machine with Xcode, or Android's tools: the machine's `status` adds
which tools it has (names and versions only), and the freest rule gains that filter. Its screen reaches the client by
108g's pictures and Take control, pointed at the simulator's window rather than a preview window, under Work, with R13
unchanged: pictures only, no script of the app on the client. How a simulator's picture and input are read (the
simulator's own command-line tools, or computer use's reader with its macOS permissions, item 82) is 110's own design
and was not checked here.

**Item 109, a thread started by a webhook.** The API holds the event for up to a day. The workflow the person allowed
names the machine that runs it, or Freest among the machines it allows; that machine dials in and takes the event, so
no machine opens a port to receive it. The start is 108c's `start`, in the workflow's careful lane and its agent's Ask
mode, and its asks reach every connection with Answer and 78d's push. R1 and R2 carry over whole: a webhook starts only
a workflow the person allowed, and never opens a terminal, moves a project or updates a machine.

## What this design did not check

- Whether the desktop's page keeps its relay socket and timers while hidden for hours (78b's open check); 108a measures it.
- How a login item is best made for this app (Tauri's autostart plugin or macOS's own service), and how a hidden start
  with no Dock icon is set in Tauri 2; read in 108a.
- Whether passkeys work in the desktop's web view; read in 108e.
- How the shell takes a picture of a webview window; read in 108g.
- How iCloud Keychain shows several passkeys for one site, one per machine paired.
- The relay's real cost with terminals and pictures; 78's figures counted only a phone watching.
- What `tailscale serve` does with a WebSocket on port 47100 on a real tailnet (78f's open check).
- That Tailscale finds a direct path between two machines on the same network in practice.
- A restart with FileVault on, and how long a machine stays offline after a power cut.
- T3 Code was read in its documentation only, not its code; its own limits and failure paths were not checked.
- Orca and GoSpark were not read again.

## Plan rows

Added to `docs/plan.md` under item 108, each proposed.

| Order | Work | Waits on | Model |
| --- | --- | --- | --- |
| proposed | 108a. Run as a machine: the setting and consent, a login item that starts Manut AI hidden with no Dock icon, the menu bar line, and the machine's status read in the shell; an hour hidden with the relay link steady | 108 | Opus |
| proposed | 108b. Permissions for each connection: Watch, Answer, Work, Terminal and Manage, the request table, `stays_on_machine`, old records read as Answer, the check in `serve.ts` | 108 | Opus |
| proposed | 108c. Work requests on the machine: `status`, `projects`, `start` in Ask mode, `send` through `route`, `picture`, `revoke`, the Work passkey, and the freest machine rule | 108b | Opus |
| proposed | 108d. Your machines in the browser page: each machine's chats and asks, New thread with the machine chip, messages, pictures, Forget and Revoke everywhere | 108c | Sonnet |
| proposed | 108e. The desktop as a client: Settings, Machines, the machine chip, rows marked by machine, the shared client package, the desktop's key | 108d | Opus |
| proposed | 108f. A terminal from a machine: its own permission, a passkey each opening, a login shell in a known folder, closed after 15 minutes idle | 108d | Opus |
| proposed | 108g. The preview from a machine as pictures, in a window with no app commands, with Take control | 108d | Opus |
| proposed | 108h. The machines page and Update all from the signed feed when idle; pairing a device from afar | 108d | Sonnet |
| proposed | 108i. Moving a project: listed first, keys held, a passkey on each side, a new folder only, nothing deleted | 108d | Opus |
| proposed | 108j. The local network road, desktop to machine only, off, private addresses, never announced (if the owner says yes) | 108e | Opus |
