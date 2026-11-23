# Browser control and the vault

How Buddy's team works on the sites a shop already uses, such as Shopee Seller Centre or a carrier's portal, with
sign-ins the owner keeps in the vault, on machines called outposts (roadmap Phase 5, "browser control, the vault").
The design canvas says it in the owner's words:

- Connections: "Sign-ins your team may use. The vault types the password in. The AI never sees it." A row reads
  "Shopee Seller Centre. Used by Nam and Ton, last today 09:02".
- Connections: "Outposts. The machines your team works on." "This Mac. Running 2 jobs. Online" and "Cloud outpost.
  Wakes when work arrives. Costs nothing asleep."
- States: customize: "The saved password stopped working. Nam cannot track parcels until Fon types a new one."
- States: limits and States: outside the app: the work carries on in the cloud outpost, and quitting never silently
  stops work.

Code: `apps/api/src/sign-in-vault.ts` (the records, kept in the shop's vault object) and
`apps/api/src/browser-control.ts` (the operator, owner and outpost routes). The worker's side is four methods on the
job flow's port (`apps/api/src/job-flow.ts`). Tests: `apps/api/test/vault-sign-ins.test.ts`, `outposts.test.ts`,
`outpost-register.test.ts`, `sign-in-grants.test.ts` and `browser-steps.test.ts`. The routes are in
`docs/pilot-api.md`, "Vault sign-ins and outposts". This Mac's outpost is `apps/desktop/src-tauri/src/outpost/` (the
shell runs it) and `apps/desktop/src/pages/OutpostPane.tsx` (Customize › Connections).

## The promises

1. **No AI ever holds a password.** Not the model, its prompt, the task's events, a log, the audit log or the export.
   The password is sealed in the vault, and it leaves only to the outpost that types it, for one step, once.
2. **Reading is the default.** An outpost's browser reads the shop's own sites and nothing else. Every step that
   would submit something other than a read (an order, a reply, a refund, a post) asks first, through an
   approval-core request that names the exact action.
3. **Only the members named on a sign-in may use it.** The owner says who: "Used by Nam and Ton".
4. **Nothing stops silently.** A broken sign-in says so and waits for the owner; an outpost that is asleep says so.

## The parts

### A vault sign-in

One sign-in to one site, kept in the shop's own vault object (the per-shop `CredObject` that already holds its
connections, sealed with the same AES-GCM keys, `cred-crypto.ts`):

- `site`: the name people use, "Shopee Seller Centre".
- `origins`: the web origins the sign-in belongs to, one to five, `https` only, such as
  `https://seller.shopee.co.th` and `https://accounts.shopee.co.th`. This is the site's allowlist: the vault types
  the password only into a page on one of them, and the outpost browses only them for this sign-in.
- `username`: the account's name on the site. The owner sees it, so they can tell which account it is. It is not
  given to the model.
- the password: sealed at rest, and answered by one route only, the redeem, to the outpost a grant names. The owner
  sees only that it is set.
- `members`: who may use it. Members come from `@manut/member-grants`' roster, and only those whose jobs run through
  a connection may be named: Nam, Pim, Ton and Kit. Buddy routes work and never signs in to a site. Member-grants
  still decides which jobs each member does; the sign-in decides whose jobs may use it.
- `state`: `working`, or `broken` when a member reported that the site refused the saved password. A broken sign-in
  is used by nobody until the owner types a new password.
- when it was last used, and by whom ("last today 09:02").

### An outpost

A machine that runs the team's browser: **this Mac**, through the desktop app, or a **cloud outpost**, a machine
that wakes when work arrives. An outpost has a name, a kind (`this_mac` or `cloud`) and a credential of its own,
given once when it is registered (by an operator, or for this Mac by the owner in the desktop app) and kept only as a
SHA-256 digest. It sends a heartbeat while it is awake. It is
`online` while its last heartbeat is under 90 seconds old (it beats every 30) and `asleep` otherwise, including
before its first beat.

An operator can give an outpost a new credential, shown once and kept as its digest like the first: the old one stops
working at once, and the outpost is asleep until the holder of the new one beats, so nothing new is sent to a machine
that may not hold it. An operator can also remove an outpost: its credential stops working at once, and whatever
waited for it (a step waiting or running, a grant not yet redeemed) is refused in the same step. Every outpost route
is limited per source address before its credential is even read.

### The sign-in step

The model asks for a sign-in by name only: "sign in to Shopee Seller Centre". It never sees a username, a password
or the grant that carries them. The worker turns the name into the sign-in's id and asks through its port:

1. **The worker asks** `port.signIn(signInId, outpostId)`. The control plane reads the switches and the owner's
   consent, as at every step; then the attempt's own heartbeat, which proves the attempt still runs and gives the
   member it belongs to from the task object's record, never from the worker's word. The vault then checks that the
   member is named on the sign-in, that the sign-in is working, and that the outpost is online.
2. **The vault issues a grant**: a one-time permission bound to that attempt, that outpost, that sign-in and that
   member, valid for 60 seconds. The worker gets its id and expiry, and passes the id to the outpost with the browser
   step. The id alone is worth nothing: only the outpost it names can use it, with its own credential.
3. **The outpost redeems it** with its credential. In one step in the vault object, the grant is checked (the
   outpost's own, not used, not late) and used up. Then the switches and consent are read again, and the task object
   is asked whether the attempt still runs, by reading it, not by a heartbeat, so an outpost can never keep a silent
   worker's attempt alive. Only then is the password unsealed and answered, with the username and the origins, to
   that outpost alone. Redeeming twice, late, from another outpost, for an ended attempt, or for a sign-in that was
   removed or reported broken meanwhile, is refused. Another outpost's try leaves the grant for its own; any refusal
   after the grant was found to be the outpost's own, unused and on time, leaves it used up.
4. **The outpost types it** into a page whose origin is one of the sign-in's origins, and keeps it nowhere: not on
   disk, not in a log, not in what it reports back.

Every change and every redeem writes an audit entry with ids only: the sign-in, the outpost, the grant, the task and
the attempt. The grant id may be written down, since it is worthless without the outpost's credential and dead after
one use or a minute. A redeem without the outpost's credential is refused before anything is written, so nobody can
fill a shop's log from outside.

### Reading by default, and asking before submitting

An outpost's browser visits only the origins of the sign-ins it was granted, and on them it reads: opening pages,
searching, reading orders and parcel status. A step that would submit anything other than a read is a write: placing
or changing an order, sending a customer a reply, asking for a refund, publishing a post, changing a shop setting. A
write goes the way every write goes:

- `@manut/member-grants`' `decide` says whether the member does that job at all, and whether it is in practice mode
  (draft only) or asks.
- The worker stops before the write and asks for it through the port, as an approval-core request that names the
  exact action: the site, the page, and exactly what will be submitted. The request's kind comes from the write
  (`reply`, `money`, `public_post`, `message`, or `command` for a shop setting), never from the worker.
- The owner decides it once. The outpost submits only for an approved request, once, through the same one-use begin
  gate the broker uses, and reports how it went.

So there is no second way round: a browser step is just another place a write can be made, and it is made the same
way.

### A broken sign-in

When a site refuses the saved password, the outpost tells the worker, and the member reports it:
`port.signInBroken(signInId)`. Only a member named on the sign-in can, from an attempt that still runs. The sign-in
then reads "Needs a new password", no grant is issued for it, and an unredeemed grant for it is refused. The owner
types a new password (in the pilot an operator relays it); the sign-in is working again, and the next grant gives the
new password.

### The step channel

How a worker's browser step reaches an outpost, and how what the outpost did comes back into the attempt's events,
with no password in either.

1. **The worker queues a step** through its port: `port.browserStep({ kind, outpostId, ... })`. There are three
   kinds, and each of them reads:
   - `open` goes to a page (`url`);
   - `read` reads the text of the page the outpost has open, or of the part a `selector` names;
   - `sign_in` carries a grant from `port.signIn` (`grantId`); the outpost redeems it as above and types into the page
     it has open.

   Any other kind is refused (`step_kind_not_allowed`): a step that submits is the next slice. As at every step, the
   control plane reads the switches and the owner's consent, then the attempt's own heartbeat, which proves the
   attempt runs and gives the member from the task object's record. The vault then checks the outpost (the shop's,
   and online) and what the kind needs. An `open`'s address is https, with no account in it, and its origin is one of
   the origins of a working sign-in the member is named on. A `read` needs at least one such sign-in, since its outpost
   may only be on their origins. A `sign_in`'s grant is this attempt's, for this outpost, unused, on time, and in no
   other step. A step lives two minutes, or as long as its grant if that is shorter; an outpost holds at most 20
   waiting or running.
2. **The outpost asks for its steps** every few seconds while it is awake, with its own credential, and sees only its
   own: another outpost's steps, and another shop's, are not there for it. Before any step is handed out, the control
   plane reads the switches and consent again, and reads the task object to see that the step's attempt still runs
   (a read, never a heartbeat). Each step is handed out once, five at most at a time, with the origins its browser may
   be on for it, read from the sign-ins at that moment: a sign-in removed or broken since takes its origins with it. A
   step that may no longer run is refused for good, with the reason.
3. **The outpost runs it** and stays on the step's origins: a page anywhere else stops the step
   (`origin_not_allowed`).
4. **The outpost reports how it went**, once: `done` (with the text, for a read, at most 4 KB once written as JSON), or
   `failed` with a code from a fixed list. A second report, a late one, one for a step it was not handed, or one from
   another outpost is refused. The control plane reads the switches and consent again, then lands the outcome in the
   attempt's events as a tool call in the agent event contract (`toolStarted` as it was queued, then `toolUpdated` with
   how it ended), through the task object's control path: only while the attempt runs, and without extending its lease,
   so an outpost can never keep a silent worker's attempt alive. Only then does the worker see the outcome
   (`port.browserStepOutcome(stepId)`). An outcome that cannot land is taken back: the step reads refused, and what it
   read is dropped.
5. **A sign-in the site refused** comes back as `failed`, `sign_in_refused`, with the sign-in's id, and the worker
   reports it broken (`port.signInBroken`) as above.

No password is in a step, its outcome or its audit entries. A step carries a grant's id, never what it unlocks, and
the outpost types the password and keeps it nowhere. The control plane checks this too: a read whose text holds the
password of any of the shop's sign-ins is withheld (`failed`, `text_withheld`) and the text is kept nowhere. The vault
makes that comparison inside itself, so no password leaves it for the check.

Every queue, every step handed out or refused at a fetch, and every report is written to the audit log with ids only
(`browser_step.queued`, `browser_step.fetched`, `browser_step.reported`): the step, the outpost, the task and the
attempt, and for a sign-in step the sign-in and the grant. Never a page, a selector or what a step read. An empty fetch
writes nothing, as a heartbeat writes nothing.

## Built so far

`apps/api`, with the outpost's side played by a stub in tests (no real browser and no real site).

The first slice, the vault and its outposts (23 Nov 2026):

- **Operator routes** (exact `ADMIN_METHODS` entries): create a sign-in, list them without any secret, replace a
  password, remove one; register an outpost (its credential is answered once), list them with `online` or `asleep`.
- **Outpost routes** (the outpost's credential): its heartbeat, and redeeming a grant.
- **The port**: `signIn` and `signInBroken` on the job flow's worker port.
- **The audit log**: `signin.created`, `signin.password_replaced`, `signin.removed`, `signin.broken`,
  `signin.requested`, `signin.redeemed` and `outpost.registered`, with ids only; a redeem's actor is the outpost.
- **Export and deletion**: the export carries the sign-ins and outposts without any secret or credential digest; the
  shop's deletion wipes them and every grant with its vault.

The step channel, and two of the smaller gaps (24 Nov 2026):

- **The port**: `browserStep` and `browserStepOutcome`.
- **Outpost routes**: asking for its steps (`POST /v1/outposts/steps`) and reporting one
  (`POST /v1/outposts/steps/report`).
- **The task object**: a control-plane path that lands an outpost's events in a running attempt's log without the
  fence and without extending the lease (`/attempts/:id/outpost-events`).
- **Operator routes**: removing an outpost (`POST /v1/admin/outposts/remove`) and giving it a new credential
  (`POST /v1/admin/outposts/credential`).
- **An ingress limit** on every outpost route, per source address, failing closed (`OUTPOST_LIMITER`).
- **The audit log**: `browser_step.queued`, `browser_step.fetched`, `browser_step.reported`, `outpost.removed` and
  `outpost.credential_rotated`, with ids only, and words for each on the console's Audit page.
- **Export and deletion**: steps are not exported (an outcome that landed is in the task's events, which are); the
  shop's deletion wipes them with its vault.

The outpost in the desktop shell, this Mac (24 Nov 2026):

- **Registering through the owner's session**: `POST /v1/outposts/register` takes an owner session of the shop's
  linked account or the shop's own signed-in session, and `{ name, kind: "this_mac" }`; a helper's session is refused
  (`owner_only`). The credential is answered once and kept as its digest, and `outpost.registered` names the owner.
  The page sends it through its session (refreshed as every request is), but through the shell's own command, which
  keeps the credential in the login keychain (account `outpost`, beside the session's item) and gives the page only the
  shop and the outpost's name. No command returns the credential to the page.
- **The loop, in Rust** (`src-tauri/src/outpost/run.rs`), while the app is open and someone is signed in to that shop:
  a heartbeat every 30 seconds on a thread of its own, steps asked for every 3 seconds, each run in the outpost's
  browser and each outcome reported once. Every call goes from the shell with the outpost's credential. It stops at
  sign-out, at the owner's Stop (kept in the keychain item, so it stays stopped) and when the app quits; a step it still
  holds then is reported failed rather than left to run out. A credential the API refuses (removed, or given a new one)
  ends the loop, and the page asks for a new registration.
- **The outpost's browser** (`browser.rs`): a Tauri webview window of its own, never the main one. No capability names
  it or any remote page, so its pages reach none of the app's commands (Tauri refuses any command from a remote page
  without a `remote` capability), a test reads every capability to keep it so, and the app's command handler refuses
  every command from its webview as well. Its navigation hook keeps it on the step's origins. It is incognito, refuses
  pop-ups, saves no downloads and has no web inspector. It is visible while the outpost runs, opened without taking
  focus, so the owner can watch.
- **Steps** (`step.rs`): `open` goes only to an address on the step's origins and waits for the page; `read` answers
  the page's or a selector's text, cut to the API's 4 KB as JSON; `sign_in` checks for a sign-in form on the step's
  origins first, redeems the grant from Rust, types only if the page is on one of the sign-in's own origins, checks that
  again inside the script that types, and submits the form. Pages are read through WKWebView's `callAsyncJavaScript`,
  in a content world of the outpost's own, with the arguments passed as values: no channel from the page to the app.
- **The password's path**: the redeem's answer is read into a buffer that is wiped when dropped, the username and
  password are written out of it into wiped buffers of their own, moved without a copy into the call that types them,
  and wiped there once WebKit has its own copies. Nothing logs, stores or reports them; a test puts a known password
  through a fake redeem and finds it in no request the outpost sent, nothing it noted and nothing the page is shown.
- **Customize › Connections** (`OutpostPane.tsx`): the canvas's Outposts box for this Mac, Online or Asleep, how many
  steps it holds, and Register this Mac, Stop or Start, in all four of the app's languages.

## Choices made so far

Each can be undone later; none is the owner's to make, so none waited.

- Sign-ins, outposts and grants live in the shop's vault object, beside its connections, so a redeem can check and
  use up its grant in one step and the deletion wipes them with the vault.
- No new kill switch: the grant and the redeem read `officeCloud` and the owner's consent, as every job flow step
  does. A heartbeat reads neither; it is not work.
- An outpost is registered by an operator, or, for this Mac, by the owner's session through the desktop (below).
- Online means a heartbeat in the last 90 seconds. "Offline" (the canvas's third state: work waiting for an outpost
  that cannot be reached) needs work queued for outposts, which comes with the cloud outpost.
- Heartbeats are not written to the audit log: they are frequent and change nothing but the time.
- The username is shown to the owner and the operator, never to the model.
- The members a sign-in may name are the roster's members whose jobs run through a connection (Nam, Pim, Ton, Kit).
- A sign-in's origins are kept exactly as a browser writes an origin, so the outpost's check is a plain comparison.
- A grant asks for an online outpost: one that is asleep could not use it within a minute.
- The members on a sign-in are set when it is added; changing them means removing it and adding it again. The redeem
  still checks the member against the sign-in, ready for when they can change.
- Grants are not exported: they live a minute, and the audit log keeps their history. Dead grants are deleted ten
  minutes after their minute ends, when the next grant is issued.

The step channel's (24 Nov 2026):

- Steps live in the shop's vault object beside the outposts and grants, so an outpost's fetch and report are checked
  against its credential in the same place, and removing an outpost refuses its steps in the same step.
- The outpost asks for its steps (it polls); nothing is pushed to it. Every few seconds is expected (3 is what the
  ingress limit is sized for), and an empty ask reads one list and writes nothing.
- A step's origins are those of every working sign-in its member is named on, read again as it is handed out; a
  `sign_in` step's are its sign-in's. A `read` has no address of its own: it reads the page the outpost has open, which
  the outpost keeps on those origins.
- A step lives two minutes, or as long as its grant: long enough for a slow site, well inside the attempt's
  five-minute lease, and short enough that a step for an outpost that stopped answering fails quickly. Dead steps are
  deleted ten minutes after their time ends, when the next step is queued.
- A step is handed out once (at most once is enough for reads, and a lost answer just runs out of time); five at most
  per fetch, and an outpost holds at most 20 waiting or running.
- A read brings back at most 4 KB as JSON, which fits one agent event with room to spare and keeps what a worker's
  model reads small. Longer is refused without using the step up, so the outpost can cut it and report again.
- An outpost says a step failed with a code from a fixed list, never free text: `origin_not_allowed`,
  `page_unavailable`, `selector_not_found`, `sign_in_refused`, `grant_refused`, `timed_out`, `browser_error`.
- An outcome lands in the attempt's events as a tool call (`toolStarted`, then `toolUpdated`), the agent event
  contract's existing kinds, so no reader needs a new one. It lands when it is reported, so a step's row appears once
  it ended; the worker sees an outcome only once it has landed.
- The switches, consent and the attempt are read when a step is queued, when it is handed out, and when it is
  reported; a refusal when it is handed out or reported is for good (the step reads refused with the code).
- A read whose text holds a sign-in's password is withheld whole (`text_withheld`), rather than having the password
  cut out, which would show where it was. A seal the vault cannot open counts as a match.
- Steps are not exported: an outcome that landed is in the task's events, and the audit log keeps every step's history.
- The outposts' routes share one ingress limit per source address, 300 a minute: an outpost asking every 3 seconds and
  beating every 30 uses some 25, so a dozen can share an address.
- Removing an outpost deletes its record rather than leaving a tombstone: the record is only its name, its kind and a
  credential's digest, and nothing can authenticate as an outpost that is not there. A new credential puts the outpost
  to sleep until its new holder beats; the grants and steps waiting for it stay, for the new credential.

The desktop outpost's (24 Nov 2026), each in `docs/decisions.md`:

- Registering takes the owner's session only, `this_mac` only, and is not behind the outposts' ingress limit (it
  needs a session, and a shop holds 20 outposts).
- One keychain item, so a Mac is one outpost at a time. Signing out keeps it (the outpost is the shop's machine) and
  stops the loop; it runs again only for a sign-in to that same shop, unless the owner pressed Stop.
- A heartbeat every 30 seconds on its own thread; steps asked for every 3 seconds (what the ingress limit is sized
  for), at once again after an ask that brought five; asks spaced out to a minute while the API cannot be reached.
  Budgets: open 30 seconds, read 15, sign-in 40. A report that got no answer is sent again, the same, at most three
  times; a step held when the outpost stops is reported `browser_error`.
- The window is visible, without taking focus, and incognito. The navigation hook cannot tell a page's frames from the
  page, so any navigation it refuses during a step fails the step, a frame from another origin included.
- A sign-in submits the form it typed into. The site's answer must hold for 3 seconds: no password field left is done,
  the same address with the password fields emptied is `sign_in_refused`, anything else is `timed_out`, never a guessed
  refusal.
- Connections counts steps, not the canvas's jobs, and names the outpost "This Mac" in the app's language.

## Next slices

1. **Submitting steps** through approval-core, as above, with member-grants' decide first.
2. **The cloud outpost.** A machine that wakes when work arrives and costs nothing asleep; the offline state (work
   waiting for an outpost that cannot be reached, which the step channel now has); moving work there when the owner
   quits the app on this Mac ("Move them to the cloud outpost and quit").
3. **The rest of Customize › Connections on the desktop**: the shop's sign-ins ("Change" types a new password), the
   cloud outpost's row, and an owner's route to remove or rename an outpost (today only an operator can remove one).
4. **Smaller gaps**: re-sealing sign-ins after a vault key rotation (they open under the previous key until then);
   changing a sign-in's members; listing to a worker, by site name, the sign-ins its member may use; a live row for a
   step while it runs (its outcome lands when it ends); the page's text is what a site said, and a worker must treat it
   as data, never as instructions, when it reaches a model. From the desktop outpost: telling a page's frames from the
   page in the navigation hook (wry gives the hook only an address), sign-in forms inside frames or over two pages
   (the username first), a failure code of its own for a step held when the outpost stopped, the outpost on Windows
   and Linux (no keychain support there yet), and the shop sessions of the several-shops switcher (the outpost follows
   the session the page holds, which is the shop's own signed-in session today).
