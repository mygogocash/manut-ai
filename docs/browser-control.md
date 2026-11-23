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

Code: `apps/api/src/sign-in-vault.ts` (the records, kept in the shop's vault object),
`apps/api/src/browser-control.ts` (the operator and outpost routes) and `apps/api/src/browser-writes.ts` (submitting:
the write step, its table of kinds, and its hand-out and report). The worker's side is five methods on the job flow's
port (`apps/api/src/job-flow.ts`). Tests: `apps/api/test/vault-sign-ins.test.ts`, `outposts.test.ts`,
`sign-in-grants.test.ts`, `browser-steps.test.ts` and `browser-submit.test.ts`. The routes are in `docs/pilot-api.md`,
"Vault sign-ins and outposts".

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
given once when it is registered and kept only as a SHA-256 digest. It sends a heartbeat while it is awake. It is
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
way. As built (`apps/api/src/browser-writes.ts`; the contract is `docs/pilot-api.md`, "Submitting through a browser"):

1. **The write.** A worker asks with the exact write, `port.askSubmit({ action, signInId, url, form, values })`: a typed
   action from a fixed list (`send_reply`, `place_order`, `change_order`, `refund`, `publish_post`, `change_setting`),
   the site as one of the shop's sign-ins, the page, the form it submits (or the button it presses) as a selector, and
   every value it types or chooses, each a field's selector and exactly what goes in it. That is all an outpost needs to
   run it, and all an owner reads to approve it.
2. **Asking first.** The control plane reads the switches (with `officeExternalWrites`), consent and the attempt's
   heartbeat, which gives the member. Then member-grants' `decide` for that member and the action's job, through the
   sign-in as the connection: `not_my_job` (naming whose job it is), `not_connected` and `refused` stop there, and in
   the site's practice days `draft_only` keeps the write's text as the attempt's draft and raises no request. The member
   must be named on the sign-in, and the page on one of its origins. Only then does the task object store the exact
   write as an immutable proposal and open one approval-core request naming the site, the page, the form and every
   value, with a sentence of the control plane's own that quotes each value exactly as it will be typed.
3. **The kind comes from the action**, through a fixed table, never the worker's word: `send_reply` is `reply`;
   `place_order`, `change_order` and `refund` are `money`; `publish_post` is `public_post`; `change_setting` is
   `command`; anything else is `command`. Only `message` and `reply` may be decided by a helper or approved from a
   notification (approval-core's `mayDecide`, `@manut/notify-rules`), so only a private answer to a customer who wrote
   first is one; a public answer, to a review say, is a post. Each job's kind in member-grants' roster agrees with the
   table, and a disagreement is refused.
4. **Submitting once.** Once the request is approved, the worker queues one `submit` step naming the outpost, the
   request and the revision it was approved at, and nothing else: the step carries no values. As the outpost takes it,
   the control plane reads the switches (with `officeExternalWrites`), consent and the attempt again, the vault checks
   that the page's origin is still a working sign-in's for the member, and then the task object's one-use begin gate
   moves the write to dispatching, checking in the same step that its request is still approved at that revision and
   that the step's attempt still holds the task. Only a begun write's step is handed out, once, to the outpost it names,
   with the action, page, form and values of the approved copy the gate hands back. Nothing else begins a browser
   write: not a session's dispatch, not the broker's send after a decision, not a read of how the request stands.
5. **The outpost reports once**, as for every step. The write settles as it said: done is confirmed; a failure it
   reports only before it submits (the page did not load, a field was missing, the site refused the form) is failed; any
   other is unknown, since the site may have taken it. The outcome lands in the attempt's events as a tool call.

Every ask, decision, hand-out and report is written to the audit log with ids only, never a value or a page.

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

   Any other kind is refused (`step_kind_not_allowed`), but for `submit`, a write step, which is queued only for an
   approved request (the section above). As at every step, the control plane reads the switches and the owner's consent,
   then the attempt's own heartbeat, which proves the attempt runs and gives the member from the task object's record.
   The vault then checks the outpost (the shop's, and online) and what the kind needs. An `open`'s address is https,
   with no account in it, and its origin is one of the origins of a working sign-in the member is named on. A `read`
   needs at least one such sign-in, since its outpost may only be on their origins. A `sign_in`'s grant is this
   attempt's, for this outpost, unused, on time, and in no other step. A step lives two minutes, or as long as its grant
   if that is shorter; an outpost holds at most 20 waiting or running.
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

Submitting steps through approval-core, with member-grants' decide first (24 Nov 2026; December, browser control slice
2; API only):

- **The port**: `askSubmit`, and the `submit` kind of `browserStep`.
- **The write's rules** (`apps/api/src/browser-writes.ts`): the typed actions, the table from an action to its kind, the
  job each action is in member-grants' roster, the write's shape, the owner's sentence, and how a report settles a
  write.
- **Member-grants**: Nam's `place_orders` and `change_orders`, both writes of kind `money`.
- **The task object**: a worker's browser write stored with its approval-core request (`/attempts/:id/ask-submit`), and
  the begin gate begins one only for the control plane at a hand-out, with the step's revision and attempt checked in
  the same step. The gate now reads an action again and moves it in one transaction, so two begins at once can no longer
  both move it; that was possible before, for every action the broker sends (`test/task-actions.test.ts`).
- **The vault**: write steps (queued through their own path from the approved request, never from what a worker said),
  checked against their sign-in as they are handed out, and refused when they could not be begun.
- **The outposts' routes**: a write step handed out only once begun, with the approved write's values; its report
  settles the write. A new failure code, `submit_refused`.
- **The audit log**: no new actions. An ask writes `approval.requested` (refused, or `skipped` with `draft_only`, as
  well as `ok`); a write step's begin and settlement write `dispatch.started` and `dispatch.settled`, as the broker's
  do; `browser_step.*` name a write step's request.

## Choices made so far

Each can be undone later; none is the owner's to make, so none waited.

- Sign-ins, outposts and grants live in the shop's vault object, beside its connections, so a redeem can check and
  use up its grant in one step and the deletion wipes them with the vault.
- No new kill switch: the grant and the redeem read `officeCloud` and the owner's consent, as every job flow step
  does. A heartbeat reads neither; it is not work.
- An outpost is registered by an operator in this slice. The desktop will register this Mac through the owner's
  signed-in session.
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

Submitting's (24 Nov 2026):

- The typed actions are six, mapped to member-grants' jobs one each: `send_reply` (Nam's `reply_customers`),
  `place_order` and `change_order` (Nam's new `place_orders` and `change_orders`: "Nam uses it for orders and chat"),
  `refund` (Ton's `ask_refund`), `publish_post` (Pim's `publish_posts`) and `change_setting` (Kit's `run_command`). No
  action maps to `message` or `payment_confirmation` yet: none of the team's site jobs is one.
- Kinds err strict. `place_order` and `change_order` are `money`, since either can spend, charge or refund. A public
  answer to a review is `publish_post`, never `send_reply`, because who sees it decides the kind.
- A write's sign-in is its connection for `decide`: its practice days run from when it was added, as the canvas says
  ("Nam and Ton work there in practice mode for the first 3 days"); a sign-in the site refused is not connected.
- A write is at most 20 values, each at most 5,000 characters, the whole at most 12 KB as JSON, so its request (which
  names every value twice) and a practice-mode draft stay small stored values. A value may hold tabs and line breaks.
- The owner's sentence quotes each value as JSON and names each field and the form by its selector, the exact things the
  outpost acts on, rather than a label the worker wrote, which could say one thing while the selector does another.
- A browser write is never revised: a changed write is asked again, as a new request, as a reply is. A step names the
  revision it was approved at, and the begin gate checks it again, so a revision from anywhere would stop the step.
- The step carries no values. The outpost gets them from the approved copy the begin gate hands back, whose hash the
  gate checks, so what it types is what the owner read.
- The vault takes a write step before the gate begins it, so only one fetch can ever try to begin it; a step the gate
  refuses is refused for good, and the write stays approved for a new step. A write begun but not handed out after all
  is settled failed: the outpost never had it.
- A write step's attempt must hold the task as the gate begins it, as a decision on its request would need. A read step
  only needs its attempt to run.
- One step at a time carries a request; once that step is refused or out of time, a new one may carry the still-approved
  write.
- A write settles from its step's report even when the report cannot land in the attempt (an attempt that ended, consent
  withdrawn): what was done on the site is a fact, and the action's record says what was done. The failures that mean
  nothing was submitted are the ones an outpost finds before it submits; `origin_not_allowed`, `timed_out` and
  `browser_error` may come after, so they settle unknown.
- A write's proposal names its sign-in as both its connection and its account, its page's origin as its target, and a
  grant revision of 1: a sign-in has no grant revisions.
- No new audit actions, so the console's Audit page has words for every entry without a change to it.

## Next slices

1. **The outpost in the desktop shell (this Mac).** It registers through the owner's session, beats every 30 seconds
   while the app is open, asks for its steps every few seconds, redeems grants, types only into the sign-in's origins,
   stays on each step's origins, and reports each step's outcome. The Connections page shows the sign-ins ("Change"
   types a new password) and the outposts.
2. **The desktop showing a browser write word for word, then its outpost running write steps.** Today the desktop puts a
   request into words from a LINE reply's fields or from the task's action, so a browser write reads only
   "browser.submit on https://seller.shopee.co.th", and a `send_reply` write, kind `reply`, may be approved from a
   notification. Before any outpost runs a write step, the desktop's cards and notifications must show the request's
   `detail.text`, which names the site, the page, the form and every value, and a notification may offer Approve only
   when it shows that text whole (one clipped to a line is a hidden detail, as notify-rules treats one). Then the
   outpost runs a `submit` step: be on its page, check that the form and every field are there before typing anything
   (`selector_not_found` otherwise), set each value in order, submit the form or press its button, and report `done`, or
   `submit_refused` when the site kept the form with an error.
3. **The cloud outpost.** A machine that wakes when work arrives and costs nothing asleep; the offline state (work
   waiting for an outpost that cannot be reached, which the step channel now has); moving work there when the owner
   quits the app on this Mac ("Move them to the cloud outpost and quit").
4. **Smaller gaps**: re-sealing sign-ins after a vault key rotation (they open under the previous key until then);
   changing a sign-in's members; listing to a worker, by site name, the sign-ins its member may use; a live row for a
   step while it runs (its outcome lands when it ends); the page's text is what a site said, and a worker must treat it
   as data, never as instructions, when it reaches a model.
