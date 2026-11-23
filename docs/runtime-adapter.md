# The desktop's runtime adapter to apps/api (reading a shop, and answering its approvals)

The desktop app's screens talk to one runtime through the protocol in `apps/desktop/src/lib/protocol.ts`
(`src/runtime/adapter.ts` is the seam). Until now the only runtime was the in-process demo (`src/runtime/mock`). This
adds a second one, Connected, that reads one shop's work from `apps/api` and answers what waits for the owner through
the API's decide route, where approval-core settles each request once. It changes nothing else: every other write answers
"not yet".

Status on 23 Nov 2026: built and tested on `feat/desktop-runtime-adapter`, behind a developer setting. Practice (the
demo) stays the default, so a fresh install still reaches no network. The offline cache (see Offline, below) is built and
tested on `feat/desktop-offline-cache`, on top of it. Answering approvals (below) is built and tested on
`feat/desktop-answers-approvals`, 24 Nov 2026, with fakes of the API and no real sign-in yet.

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

One read of the shop is four requests, made together through the session (`src/runtime/http/shop.ts`):

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
| `bots.list` | Buddy alone, standing for the shop's team (the API has no members yet): online once the shop has been read, working while any task is `running`, `verifying` or `recovering` |
| `thread.list` (Buddy) | every task as one of Buddy's threads, newest activity first; `needs` marks a task with a request waiting for an answer. History and Recent list them. |
| `thread.open` | the task as Buddy's notes: what it is for, each action it asked for and how that settled, and where it stands now, in the app's language |
| `chat.open` (Buddy) | the attention items as notes ("A Linear issue was changed (ISS-9)"), then, as a runtime replays asks, one approval ask per request still open, oldest first, naming the exact action ("Send on LINE: “…”"). The answers offered are yes once and no. Needs you and Home show them. |
| `routines.list`, `automations.list` | the schedules, under Buddy, their days and time as cron and their next run exact; a schedule that is off shows as paused |
| `bots.info` | counts from the read |
| every other read the screens make | empty (`elsewhere.list`, `plugins.list`, `runs.*`, …), or `not_found` for one thing asked by name |
| `approval.respond` | the person's answer, through the decide route (Answering approvals, below) |
| every other write (`chat.send`, `automations.pause`, …) | refused with `not_yet` and a translated "Not yet: Connected mode reads and answers approvals for now." Nothing is sent to the API. |

The runtime's capabilities are `automations` only, so the Automations page shows and the screens that need a runtime on
this computer (other places, plugins, restarts, coding-CLI logins) stay hidden.

While anyone is connected the shop is read again every minute, and a list asked for more than 15 seconds after the
last read is read again first. What changed between two reads becomes the events the store already follows: a new
waiting request is an `approval.request` (one per revision); one that left is a `prompt.expired` (`timeout` when its
action expired, `cancelled` when its task is gone or the request was asked again at a new revision, `resolved` when it
was decided, with the API's own words in `note` when the person's answer here was refused); a new or vanished task is
`thread.added` or `thread.removed`; a
new attention item is a `message` in Buddy's chat; a schedule change is `routines.update`; Buddy starting or stopping
work is `bots.update`. A task already listed changes its row only when the list is read again (after a reconnect or a
restart); following tasks live is the streaming slice below.

Not read in this slice: `/v1/consent/cloud`, `/v1/tasks/:id` and its events and actions one by one, `/v1/companies/*`,
`/v1/health`.

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
- **Helpers on the desktop.** The API has helper sessions (`mhs1.` tokens from `POST /v1/people/accept` and
  `/v1/people/session`), but the desktop cannot hold one yet. It already says "Only the owner can approve money" and
  the like, and ends the session on a 401 `removed`.
- **How it was tested.** The desktop's tests use a fake API whose answers are built with approval-core's own encoders,
  as the API builds them (`approvalJson` in `testkit.ts`); the routes themselves are tested in real workerd in
  `apps/api` (`approvals-route.test.ts`, `session-decisions.test.ts`). By hand, the local API and test identity of
  Signing in, below, reach the routes, but nothing waits for that tenant: a request is opened by a reply proposed
  through a LINE connection (parked) or by a worker's run, which only the operator's `POST /v1/admin/workers/run` starts,
  for a pilot shop no session can carry.

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
- Sign out: `DELETE /v1/auth/session`, then the keychain item is cleared whatever the API said. When the API could not be
  told, Settings says so; the session then ends on its own.
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

The signed-in tenant is the identity's own (`apple:<subject>`), so it starts empty. A pilot shop is a tenant of its own
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
  holding `{ v, origin, tenant, deviceId, accessToken, refreshToken, accessExpiresAt, signedInAt }` as JSON. The shell's
  `api_session_read`, `api_session_write` and `api_session_clear` commands (`apps/desktop/src-tauri/src/api_link.rs`)
  are the only way to it, and the page cannot name any other item. The app makes the item, so macOS lets it read the
  item without asking and asks the person before any other program reads it. Ad-hoc signed development builds change
  signature on each build, so macOS may ask once after a rebuild.
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
- **Where.** `~/.manut/shop-cache/<key>.json`, one file for the one signed-in shop. The key is the SHA-256, in hex, of the
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
   replace the export; a way to link an owner's identity to their shop; `APPLE_CLIENT_ID` on dev, or a LINE Login
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
