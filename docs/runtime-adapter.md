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
and activity log, and the owner's routine and pause writes.

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

## What it reads, and how each call maps to the API

Each read first asks which shops the person is in (`GET /v1/shops`; Several shops, below). In none, as before shops, the
read is the signed-in tenant's, four requests made together through the session (`src/runtime/http/shop.ts`):

| Request | Gives | Notes |
| --- | --- | --- |
| `GET /v1/tenant/export` | the tasks, each with its event log and its exact-action proposals | The only route a session can use today that lists its own tasks. It is heavy (every task's history), so it is read once a minute, or when a screen asks for a list more than 15 seconds after the last read; a list route is the first API ask below. `404 tenant_deleted` reads as no tasks. |
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
| `jobs.list`, `jobs.get`, `activity.list`, `team.state` | Mission Control from the read (A shop the person owns, below): every task as a job, the activity log, and for a shop the person owns its team's state |
| every other read the screens make | empty (`elsewhere.list`, `plugins.list`, `runs.*`, …), or `not_found` for one thing asked by name |
| `approval.respond` | the person's answer, through the decide route (Answering approvals, below) |
| `routine.pause`, `routine.resume`, `team.pause`, `team.resume`, and `automations.pause` and `.resume` of a team routine | for a shop the person owns, through apps/api's routines routes with that shop's session (A shop the person owns, below) |
| `connections.list` | the shop's site sign-ins and outposts, `GET /v1/vault/sign-ins` and `GET /v1/vault/outposts`, for Customize › Connections (below) |
| `connections.add`, `connections.password`, `connections.members`, `connections.rename`, `connections.remove` | the owner's change, to `POST /v1/vault/sign-ins`, `/v1/vault/sign-ins/password`, `/v1/vault/sign-ins/members`, `/v1/vault/outposts/rename` or `/remove` (below) |
| `people.list` | who can use Manut AI for the shop the switcher shows, `GET /v1/people`, for Settings › People (below) |
| `people.invite`, `people.cancelInvite`, `people.remove`, `people.setAway`, `people.clearAway` | the owner's change, to `POST /v1/people/invites`, `/invites/revoke`, `/remove`, `/away` or `/away/clear` (below) |
| every other write (`chat.send`, `routine.create`, …) | refused with `not_yet` and a translated "Not yet: Connected mode answers approvals, pauses your team's routines and looks after Connections for now." Nothing is sent to the API. Buddy's chat needs a model, the owner's key. |

The runtime's capabilities are `automations` only, so the Automations page shows and the screens that need a runtime on
this computer (other places, plugins, restarts, coding-CLI logins) stay hidden.

While anyone is connected the shop is read again every minute, and a list asked for more than 15 seconds after the
last read is read again first. What changed between two reads becomes the events the store already follows: a new
waiting request is an `approval.request` (one per revision); one that left is a `prompt.expired` (`timeout` when its
action expired, `cancelled` when its task is gone or the request was asked again at a new revision, `resolved` when it
was decided, with the API's own words in `note` when the person's answer here was refused); a new or vanished task is
`thread.added` or `thread.removed`; a
new attention item is a `message` in Buddy's chat; a schedule or team routine change is `routines.update`; the team
changing (a member starting or stopping work, Pause everyone, a member switched on or off) is `bots.update`. A task already listed changes its row only when the list is read again (after a reconnect or a
restart); following tasks live is the streaming slice below.

Not read in this slice: `/v1/consent/cloud`, `/v1/tasks/:id` and its events and actions one by one, `/v1/companies/*`,
`/v1/health`. A shop the person owns is read differently: below.

## Answering approvals

Built on `feat/desktop-answers-approvals` (`src/runtime/http/approvals.ts`, `answer.ts`, `host.ts`, `session.ts`).
The API side is `apps/api/src/approvals.ts` (docs/pilot-api.md, "Approvals for a session" and "Deciding from a session").

### Where the asks come from

- **approval-core's records, decoded by approval-core.** Each entry of `GET /v1/approvals?state=open` is read with
  `decodeRecord` and `decodeStanding` from `@manut/approval-core`, and answered with `toKnownRequest`, never by hand.
  Each request still open is one ask in Buddy's chat, so Needs you and Home show it. An action the export lists as
  proposed but no request decides is not an ask: nothing on this path could decide it (it still shows in its task's
  notes, "waiting for you").
- **The exact action.** A reply's ask says the reply's own words from its request ("Send on LINE: “…”"). A worker's
  request carries no words, so its ask says its action's, from the export ("Create a Linear issue: “…”"). Otherwise it
  says the operation and where it goes, as the API wrote them. A request's `detail` is cut down to the words the card
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
the card's words, with any note passed on, and reads them back with the same decoders as the live read; its version is
2, and a file of version 1, which holds no requests, is not read. An ask this build cannot answer says "Update the app
to answer this" offline too.

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
  well (A shop the person owns, below): its export and its routines, with the same session, and its helpers' devices (A
  helper's new device, below). A shop they help at is read for its asks and nothing else: what a helper sees is the
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
  waits there (`GET /v1/approvals?state=open`), its export (`GET /v1/tenant/export`: its tasks, each with its event log,
  its actions, each member's run and the drafts they wrote; its schedules; its attention items) and its team with its
  routines (`GET /v1/routines`). The API answers a shop session 401 on `GET /v1/schedules` and
  `GET /v1/inbound/attention`, and the export carries both, so those two are never sent with one (`docs/decisions.md`). A
  schedule that names a `routineId` is that routine's clock and is not listed twice. A shop the person helps at is read for
  its asks only, and the export and the routines answer a helper's session 403 `owner_only`, which reads as "asks only"
  rather than a failure. Anything else that fails (offline, a 5xx, `export_incomplete`) fails the whole read, as before:
  half a shop is never shown as the whole one. A deleted shop's export (404 `tenant_deleted`) reads as no tasks.
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
  and Resume everyone are `POST /v1/team/pause` and `/resume` with exactly `{}`. Each goes with the viewed shop's own owner
  session, only for a routine the read lists, and is refused here with nothing sent for a shop the person helps at and for
  the signed-in tenant. The API's answer is shown at once and the shop is read again. A refusal is said in words ("The API
  did not make this change, so nothing changed."), and a change that got no answer is never sent again from here ("No reply
  from the API. Checking whether it changed."): the read that follows says. None of these sends, posts, pays or deletes
  anything, and approvals still settle only through the decide route. Making a routine, a schedule of the shop's own,
  memory, Buddy's chat (which needs a model, the owner's key) and every other write stay "not yet".
- **Pause everyone's words.** apps/api's pause holds the team's routines and nothing else: a job already running finishes
  and a request keeps its own expiry. The page's canvas words ("stop at the next safe point", "Nothing expires while the
  team is paused") would promise the owner what the API does not do, so `TeamState.holds` says which pause it is and the
  page says "Nam, Pim and Ton run no routines until you resume.", "Jobs already running are not stopped." and "Requests in
  Needs you keep waiting until they expire." for the API's (`pause.ts` `pauseWords`). Practice keeps the canvas's.
- **Offline.** Each shop's record in the kept read holds that shop's own read under its id: its asks, and for a shop the
  person owns its tasks (with each run and the newest draft), schedules, attention items, team and routines, copied field
  by field (version 4 of the file; files of 3 and 2 are still read, a task from them with no runs or draft and a shop with
  no work). The viewed shop's work is its record's alone. A record of a shop the person helps at that claims any work, or
  work that is not whole, makes the whole file ignored.
- **Tests.** `owned.test.ts` (the shop whole, its team, its routines, Mission Control, the writes and their refusals, a
  helper's view, offline, and under the app's own store), `work.test.ts` (how a task reads as a job), `mission.test.ts`
  (the signed-in tenant's Mission Control), `cache.test.ts` (version 4), and `serveShops` in `testkit.ts`, which answers an
  owner's export, routines and team writes, and a helper's 403, as apps/api does.

## Customize › Connections

The shop's vault and outposts, for its owner (`src/runtime/http/connections.ts`; the routes are `docs/pilot-api.md`, "The
owner's vault and outposts"; the design is `docs/browser-control.md`, "The owner's Connections").

- **Which session.** `connections.list` reads the shop the switcher shows, with that shop's own session, or the signed-in
  tenant with the sign-in while the person is in no shops. Each change names the shop its row was read for (`shop`,
  null for the signed-in tenant) and goes with that shop's session. A shop the person helps at is refused `owner_only`
  here with nothing sent, and nothing is sent while only a kept read is shown (`offline`). The API answers a person's own
  sign-in 404 `not_found` on the vault routes (24 Nov 2026: a vault is a pilot shop's), which these ops read as
  `no_shop` (`conn.err.noShop`), and `registerThisMac` as `no_shop` (`outpost.err.noShop`).
- **The password** crosses once, a new sign-in's (`connections.add`) as a new password: the same session reads the
  sign-ins first, so it is one that works, the shop still has the sign-in a new password is for (`sign_in_not_found`
  otherwise, with nothing sent), and the vault has room for a new one (`too_many_sign_ins` at 50, with nothing sent); then
  one send with no second try after a 401 (`ApiSession.writeOnce`, or the shop's session as it is held), which answers
  `not_saved` and asks the owner to type it again. What the vault would not take is refused here first: a password empty
  or over 1,024 characters, and for a new sign-in its name, its addresses, its account or its members, by the vault's own
  rules said once in `src/runtime/connections.ts` (`newSignInRefusal`), which Practice keeps too.
- **Who may use a sign-in** (`connections.members`) carries no secret, so it goes as every other change does; members the
  vault would not take (none, a repeat, anyone but Nam, Pim, Ton and Kit) are refused here first.
- **What the tab is shown.** Each sign-in without its account or its sites' addresses, and each outpost, times in
  seconds; an entry this build cannot read is left out. The page keeps none of it in the store or the kept read: the tab
  asks through a client of the runtime of its own (`src/pages/ConnectionsPane.tsx`).
- **This Mac's own record.** The shell's view of this Mac for the shop shown (`outpost_status`) carries the id its outpost
  has on the shop's list, only when this Mac is that shop's outpost, and never its credential. The tab folds that record
  into this Mac's row (its name, Rename and Remove) and leaves it out of the shop's list; with no id, or an id the list
  does not have, every outpost is listed.

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
  shell decides (Several shops, above). It learns only the outpost's id, for the shop it asks about.
- In memory, in the page's one `ApiSession` per origin, while the app runs.
- Never in localStorage (which holds only `manut.runtime`), a log, an address, or a command line. A session is never
  sent to any origin but its own.
- Never in the offline cache's file either: it holds what the screens read of the shop and nothing from the session (see
  Offline).
- macOS only for now. On Windows and Linux the keychain commands answer `unavailable`, Settings says "This computer
  cannot keep a session yet", and Connected cannot sign in. The crates either would use are already in the build
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
  waiting for an answer (so what waits for the owner; approval-core's wire JSON, version 2 of the file), the schedules,
  the inbound attention items, whether that feed is off, and the time of the read, copied field by field as the runtime
  already decodes them. The API's whole objects and the entries it could not read are left
  out. Never a token, a refresh token, the device id or anything else from the keychain, and not the origin or the tenant
  either: the file's name is the only link to them. It does hold the shop's own words in plain text: task titles, the
  exact words of replies waiting for the owner and the LINE ids they go to, and schedule prompts. The file is the owner's
  alone (0600), so it is as private as the rest of the app's folder, and no more; it is not encrypted.
- **Where.** `~/.manut/shop-cache/<key>.json`, one file for the one sign-in. With several shops (version 3 of the file),
  every shop's record in it is under that shop's id, with its name, owner and the person's role, so a shop's asks are only
  ever read back as that shop's (version 4 adds each owned shop's work, A shop the person owns, above); the shell needs no change, since it keeps one file per sign-in and removes any other. A
  file of version 2 is read as the signed-in tenant's own. The key is the SHA-256, in hex, of the
  origin and the tenant, made by the page (`cacheKey`, with a small synchronous SHA-256 in `sha256.ts`, because the Web
  Crypto digest is asynchronous and exists only in a secure context); the shell accepts nothing but 64 hex digits as a
  name, never a path. It is written to a temporary file and renamed, so a crash never leaves half a file; at most 8 MiB;
  never through a link; and writing one shop's file removes any other's. Three shell commands do it (`shop_cache_write`,
  `shop_cache_read`, `shop_cache_clear`), reached only through `shellCacheStore` in `shell.ts`, and nothing there ever
  raises: a disk that refuses is a cache that is empty. Calls to it run one at a time, in order.
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
  bad entry ignores the whole file: half a shop is never shown as the whole one.
- **Forgotten.** Signing out in Settings, a session the API ends, a new sign-in over another session (this origin's or
  another's), and saving Practice or another origin in Settings › Developer all delete the file. A read that is on its
  way when the person signs out is not kept afterwards. After the saved choice moves away from the origin the page runs,
  it goes on reading until the next start but keeps nothing more, so the deletion is not undone. Practice never reads the
  cache: its runtime reaches no command of the shell.

## Next slices

1. **Answering approvals: built** (above), through the decide route for a session and approval-core's settle-once
   rules, never a second way round.
2. **Streaming events.** The API long-polls one task's events (`GET /v1/tasks/:id/events/wait`); following a whole
   shop needs a tenant-wide feed, or the relay once the owner turns it on (gate G3). That replaces the one-minute
   re-read and lets a task's row change live.
3. **Asks of the API**, none built here: a list route for a session's own tasks (`GET /v1/tasks`, with state, paged) to
   replace the export, which an owned shop is now read through every minute (A shop the person owns, above); a way for
   Pause everyone to stop a job already running, and for a request to wait while the team is paused, if the owner wants
   the canvas's pause; a way to link an owner's identity to their shop; `APPLE_CLIENT_ID` on dev, or a LINE Login
   provider; a tenant-wide event feed; a helper's name with a decision (so "Already decided by Mint" does not depend on
   a note she passed on), and a way to say how a request that left on its own was decided (reading
   `GET /v1/approvals?state=recent` when an ask leaves would do it, at one more request).
4. **Asks of the desktop:** the Sign in with Apple button; keychain support on Windows and Linux; showing a schedule's
   time zone when it is not this computer's; showing a note a helper passed on with its request (it is read and kept
   already); a helper's own session on the desktop.

## Undoing it

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
