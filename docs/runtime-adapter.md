# The desktop's runtime adapter to apps/api (first slice: read-only)

The desktop app's screens talk to one runtime through the protocol in `apps/desktop/src/lib/protocol.ts`
(`src/runtime/adapter.ts` is the seam). Until now the only runtime was the in-process demo (`src/runtime/mock`). This
slice adds a second one, Connected, that reads one shop's work from `apps/api`. It changes nothing on the API and
nothing in the shop: every write answers "not yet".

Status on 23 Nov 2026: built and tested on `feat/desktop-runtime-adapter`, behind a developer setting. Practice (the
demo) stays the default, so a fresh install still reaches no network. The offline cache (see Offline, below) is built and
tested on `feat/desktop-offline-cache`, on top of it.

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

One read of the shop is three requests, made together through the session (`src/runtime/http/shop.ts`):

| Request | Gives | Notes |
| --- | --- | --- |
| `GET /v1/tenant/export` | the tasks, each with its event log and its exact-action proposals | The only route a session can use today that lists its own tasks. It is heavy (every task's history), so it is read once a minute, or when a screen asks for a list more than 15 seconds after the last read; a list route is the first API ask below. `404 tenant_deleted` reads as no tasks. |
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
| `thread.list` (Buddy) | every task as one of Buddy's threads, newest activity first; `needs` marks a task with an action waiting for the owner. History and Recent list them. |
| `thread.open` | the task as Buddy's notes: what it is for, each action it asked for and how that settled, and where it stands now, in the app's language |
| `chat.open` (Buddy) | the attention items as notes ("A Linear issue was changed (ISS-9)"), then, as a runtime replays asks, one approval ask per action still `proposed` and not past its `expiresAt`, naming the exact action ("Send on LINE: “…”"). The answers offered are yes once and no. Needs you and Home show them. |
| `routines.list`, `automations.list` | the schedules, under Buddy, their days and time as cron and their next run exact; a schedule that is off shows as paused |
| `bots.info` | counts from the read |
| every other read the screens make | empty (`elsewhere.list`, `plugins.list`, `runs.*`, …), or `not_found` for one thing asked by name |
| every write (`chat.send`, `approval.respond`, `automations.pause`, …) | refused with `not_yet` and a translated "Not yet: Connected mode only reads for now." Nothing is sent to the API. |

The runtime's capabilities are `automations` only, so the Automations page shows and the screens that need a runtime on
this computer (other places, plugins, restarts, coding-CLI logins) stay hidden.

While anyone is connected the shop is read again every minute, and a list asked for more than 15 seconds after the
last read is read again first. What changed between two reads becomes the events the store already follows: a new
waiting action is an `approval.request`; one that left is a `prompt.expired` (`timeout` when it expired, `cancelled`
when its task is gone, `resolved` when it was decided); a new or vanished task is `thread.added` or `thread.removed`; a
new attention item is a `message` in Buddy's chat; a schedule change is `routines.update`; Buddy starting or stopping
work is `bots.update`. A task already listed changes its row only when the list is read again (after a reconnect or a
restart); following tasks live is the streaming slice below.

Not read in this slice: `/v1/consent/cloud`, `/v1/tasks/:id` and its events and actions one by one, `/v1/companies/*`,
`/v1/health`.

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

- **What is kept.** After every good read, the minute's poll included: the tasks with their actions (so what waits for
  the owner), the schedules, the inbound attention items, whether that feed is off, and the time of the read, copied
  field by field as the runtime already decodes them. The API's whole objects and the entries it could not read are left
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

1. **Answering approvals.** Through `packages/approval-core`'s settle-once rules, never a second way round. Today the
   API's session routes carry its own exact-action proposals (`ActionProposalJSON` in `apps/api/src/task-object.ts`),
   which this slice decodes itself. The API is meant to serve approvals as approval-core wire records
   (`packages/approval-core/src/wire.ts`): the job-flow work builds worker approvals as approval-core requests, and a
   later slice moves the pilot's reply approvals onto approval-core too (an operation type mapped to a kind: a LINE
   reply becomes `reply`), with no change to what the owner's page shows. When that lands, the desktop decodes them with
   `@manut/approval-core`'s decoders, shows a kind it does not know as "update the app", and takes that workspace
   dependency (a lockfile change). The decision then goes to the decision route the API already has
   (`POST /v1/tasks/:id/actions/:actionId/decision`, behind the cloud flag and the shop's consent).
2. **Streaming events.** The API long-polls one task's events (`GET /v1/tasks/:id/events/wait`); following a whole
   shop needs a tenant-wide feed, or the relay once the owner turns it on (gate G3). That replaces the one-minute
   re-read and lets a task's row change live.
3. **Asks of the API**, none built here: a list route for a session's own tasks (`GET /v1/tasks`, with state, paged) to
   replace the export; a way to link an owner's identity to their shop; `APPLE_CLIENT_ID` on dev, or a LINE Login
   provider; a tenant-wide event feed; approvals as wire records.
4. **Asks of the desktop:** the Sign in with Apple button; keychain support on Windows and Linux; showing a schedule's
   time zone when it is not this computer's.

## Undoing it

Practice is the default and Connected is reached only through Settings › Developer. To take the slice out, remove
`src/runtime/http/`, `src/runtime/setting.ts`, `src/runtime/link.ts`, `src/settings/DeveloperPage.tsx`,
`src/sidebar/ModeLine.tsx`, the `rt.`, `dev.` and `mode.` dictionary keys, `src-tauri/src/api_link.rs` with its four
commands in `lib.rs`, and the `security-framework` dependency in `Cargo.toml`. To take only the offline cache out, remove
`src/runtime/http/cache.ts` and `sha256.ts` with their tests, the `cache` and `keeping` options and the `cache` view in
`host.ts` (a failed read then drops the shop again), the `onEnd` option in `session.ts`, `shopCache`, `forgetShop` and
`shellCacheStore`, `saveRuntimeChoice` and `useShowingCache` in `link.ts`, the offline line in `Cards.slot.tsx`, the
`rt.connectToAnswer`, `mode.cached*` and `mode.old*` keys, and `src-tauri/src/shop_cache.rs` with its three commands in
`lib.rs`.
