# People: the owner and their helpers

How the backend holds the people around one shop, as the design canvas's board "States: people and roles" and the
People screen draw them: Fon is the owner, Mint is a helper who approves messages and replies but never money or public
posts. The rules are two packages, used as they are: `@manut/approval-core` decides who may decide what
(`mayDecide`) and settles each request once, and `@manut/people-rules` decides invites, passing a request on, cover
while the owner is away, and removal. This note says how the API wires them in (`apps/api/src/people.ts`,
`people-store.ts` and `approvals.ts`). The routes are in `docs/pilot-api.md`, "Deciding from a session" and "Helpers".

## A helper is not a company member

The lifted backend already has company membership (`companies.ts`, `company-object.ts`): an Apple-verified person
belongs to a company in a role, and the role is a ceiling for explicit grants such as `approvals.decide`. A helper is
not built on it, for four reasons.

- **A shop is a tenant, not a company.** A pilot shop is a tenant of its own (`pilot:<uuid>`) and its tasks carry no
  `companyId`, so the company's read and write assertions (`x-company-member`, `x-company-writer`) never reach them.
  Using membership would mean moving every shop's tasks into a company first.
- **Two rules for one question.** A company grant answers "may this member approve" for every kind at once.
  approval-core's `mayDecide(role, kind)` already answers it per kind (a helper decides `message` and `reply` only).
  Mapping a helper onto `approver` plus `approvals.decide` would put a second rule beside approval-core's, which
  CLAUDE.md forbids ("never add a second way round").
- **Nothing to reuse for invites, cover or passing on.** Membership has no invite bound to one identity, no 7-day
  once-only link, no cover and no note to the owner. `@manut/people-rules` has all four as pure rules with tests.
- **Revoking a member ends no session.** Removing a helper must sign them out of the shop on every device at once.

What is reused instead: the lifted sign-in proves who the helper is; the shop's TenantObject keeps the people beside
its other records (as memory, the model meter and the audit log are kept), so the tenant export reads them and the
tenant deletion wipes them; the signed links of `approval-link.ts` carry invites; the task object settles every
decision through approval-core; the job flow's `decideRequest` and the broker's one-use begin gate send what was
approved; and the company model's first principle, that a role comes from the verified session and never from the
request, holds here too.

## Where the people live

One record per shop, `people:<tenant>`, in that shop's TenantObject. It holds `@manut/people-rules`' whole state (the
owner, the helpers, invites, cover, notes passed on, and the ids of removed helpers), the name the owner gave each
invite and helper, and the SHA-256 of every helper session token. Every change is one `transactionSync`: read the
record, apply one rule, write the record and its audit entry, with no `await` between, so two clicks on one shop are
decided one after the other. A refusal writes nothing.

People exist for pilot shops today: the routes need the shop's record, which gives the shop's name for the invite and
its answers. The owner manages helpers from their own shop session once the operator has linked their account
(`docs/several-shops.md`, slice 4): `GET /v1/people`, and inviting, revoking, removing and cover under it. The operator
console does the same on the owner's word, for an owner with no account linked or one who asks, as it does for memory.
The console's People page says which of the two can change the list (the owner can when an account is linked) and, last,
shows who made each recent change, the owner or an operator, read from the audit log, because the people answer does not say.
Both make each change through the same operation of the shop's record, so there is one way to make it, and the log says
who: the owner's linked account by its id, or the operator's Access identity.

## Who is deciding: the role comes from the session

A decision names only the option and the revision the person saw (`{ optionId, seenRevision }`); a body with any other
field is refused. The role comes from the credential, verified by the backend:

| Credential | Role | `decidedBy` in the decision |
| --- | --- | --- |
| The shop's own session: a lifted session whose tenant is the shop | `owner` | `owner-session` |
| The owner's signed link (unchanged, `pilot.ts`) | `owner` | `owner-link` |
| A helper session of that shop | `helper` | the helper's id |

Then approval-core, in the task object, decides the rest: who may decide the request's kind, that it is decided once,
at the revision the person saw, before it expires, and while the attempt that asked still runs. The same switches and
consent as the owner's link apply before anything is recorded (`officeCloud` for any decision; for an approval,
`officeExternalWrites` and the shop's consent), and an approved reply goes to the same one-use begin gate the link uses,
so it is sent once whichever path approved it. Nothing settles an action without its request.

## What a helper signs in with

**Today: the lifted Sign in with Apple** (`POST /v1/auth/exchange`). The tenant stays the Apple subject, and two Apple
accounts are never joined by an email. What is new is that the session keeps the email Apple verified, when the signed
identity token carries one with `email_verified` true (Apple sends `true` or `"true"`), lower-cased, through every
refresh. That email is the verified identity an email invite is checked against. A session without one cannot join.

**In tests: the lifted auth's test-token path.** Identity tokens signed with the committed test key, whose public half
is `TEST_JWKS_JSON` in `wrangler.test.json`, go through the real exchange, so the claims, including the email, are
checked exactly as Apple's would be.

**Built, off until the owner turns it on: a code sent by email** (`docs/pilot-api.md`, "Signing in by email"). A
helper asks for a code at their address and gives it back to the same exchange. Their session is the lifted auth's, as
Apple's is, and keeps the address as its email, so an email invite matches it. Turning it on needs the owner's yes, the
Workers Paid plan and a sending domain the owner controls; until then both of its routes answer `email_not_configured`.

- **Two identities, one helper.** Signing in by email gives a tenant of its own (`email:` and the address's SHA-256),
  never the Apple one, even for the same address, as two Apple accounts are never joined. The shop knows its helper by
  the address the owner invited, so whichever of the two verified it opens the helper's sessions: the owner sees one
  helper, the other sign-in as a new device, and removal ends both. Each sign-in has its own list of shops until the
  helper opens the shop with it.
- **In tests:** the code goes to an in-memory outbox (`TEST_EMAIL_OUTBOX` in `wrangler.test.json`) that the tests read,
  as the test key stands in for Apple's.

**What needs the owner: a real sign-in for helpers.** The canvas has helpers sign in "with their own LINE or email".

- An invite to a LINE account can be made, but no one can accept it yet: nothing verifies a LINE account. That needs
  LINE Login (a LINE Login channel on the owner's LINE account), and LINE work is parked by the owner.
- An email invite works only for a helper whose Apple ID verifies that same address. Someone who chose Apple's "Hide My
  Email" signs in with a relay address and sees `wrong_account`. Signing in by email itself is built, off until the
  owner turns it on (above): it needs the owner's yes, the Workers Paid plan and a sending domain the owner controls.

## The helper's session

Joining (accepting an invite) and opening the shop on another device each give the device a **helper session** for
that one shop: a bearer token `mhs1.<shop, base64url>.<64 hex characters>`. The backend keeps only its SHA-256, in the
shop's people record, with the helper's id, the session's id and its end, 30 days on. Opening the shop again, with the
same signed-in identity, gives a new one.

- **Scoped to the shop, as a helper.** It is accepted only by the approval routes (list, decide, pass on) for its own
  shop. The owner's routes that take a shop session (the team's routines, what the team knows, the shop's consent,
  export and people) answer it 403 `owner_only`, so the helper's app does not read its session as ended. The lifted
  AuthObject has no record of it, so every other session route (tasks, deletion, connections, schedules) answers 401 to
  it, and no helper can act as the shop.
- **Removing a helper signs them out on every device at once.** `removeHelper` names every session of theirs, and the
  same storage write that removes the helper marks each one ended. From then on a request with any of their tokens
  answers 401 `removed` with the time, so their app can say "Fon removed you on Sunday 22 November", and a decision
  that arrives after the removal is refused before anything is read.
- **What they approved stays.** The audit log names a helper by id, and the people record keeps the names of removed
  helpers, so the activity log can still show "Mint".
- **On the desktop** (`docs/runtime-adapter.md`, "A shop the person helps at"; 25 Nov 2026). The helper's app opens the shop
  with this session and sends it only those routes: what waits, how an ask that left was settled, the live feed's ticket, a
  decision, a note passed on, and the end of the session. The pages that are the owner's (the team and Pause everyone, past
  work, the activity log, the routines, what the team knows, the connections, the people) say whose they are and read
  nothing.

## Invites

An invite is for one LINE account id (compared exactly) or one email (compared without case), works once, and lasts
7 days. The owner makes it from their session, or the operator on the owner's word, with a name and that identity, and
gets a link to copy: `${WEB_ORIGIN}/join/<token>`. The API never sends it: LINE and email sending are parked by the
owner, so the owner sends the link themselves. (The only email the API can send is a sign-in code, and only once the
owner turns signing in by email on.) The token is an HMAC-SHA256 under
`APPROVAL_LINK_SECRET` in its own domain, `manut-ai/pilot-invite/v1.`, over the shop's tenant, the invite's id and its
expiry, so no approval or deletion link can pass for an invite, and the reverse. Minting is deterministic, so the
console shows the same link again for a pending invite.

Accepting needs a signed-in session whose verified identity matches. The answers are `@manut/people-rules`':

- `joined`: the helper's id, the shop, and the device's first helper session;
- `wrong_account`: the shop's name and which kind of account the invite is for, never its value; the invite stays
  unused for the person it was made for;
- `expired`, `already_used`, `revoked`, `unknown`: nothing about the shop. A token that does not verify is `unknown`.

**The join page** (`apps/web/src/join/`) is what the link opens, built and **off until signing in by email is on**: in
every environment today asking for a code answers `email_not_configured`, and the page says "Joining by email isn't on
yet" and asks the person to have the shop's owner try again later. Once it is on:

- **The first screen names no shop**, because the API names the shop and its owner only to a signed-in accept. It says,
  in the canvas's voice, that the person was invited to help with a shop on Manut AI and asks them to sign in with the
  email the invite was sent to.
- **Signing in** is the canvas's ("States: sign-in, files and forms"): type the address, Send code, type the six digits
  (the box has `autocomplete="one-time-code"` and `inputmode="numeric"`, and the sixth digit signs in), with words for a
  wrong code and its tries left, a code that ended, too many codes and the wait, too many tries from one network, being
  offline, and the API's `invalid_request`.
- **The answer.** `joined` says "You've joined Baan Mali.", names the owner and what a helper may approve, and says what
  comes next: open Manut AI on a Mac and sign in with the same email, where the shop is listed (`GET /v1/shops`) and opens
  with a helper session (`POST /v1/shops/session`, the same one `POST /v1/people/session` gives). `wrong_account` names the
  shop and only the kind of account the invite is for (for a LINE invite, that Manut AI cannot sign in with LINE yet), with
  Switch account. `expired`, `revoked`, `already_used` and `unknown` are plain words that name no shop.
- **What the page holds, it holds for this visit only.** The sign-in's access token is kept in memory, never in
  `localStorage`, `sessionStorage`, a cookie or a URL, so a reload means signing in again; a web session that lasts is
  December item 17's to design. Once the invite has its answer, the page ends the sign-in (`DELETE /v1/auth/session`) and
  the helper session a join gave (`POST /v1/shops/session/end`; the web has no helper screens yet), so the owner's People
  list counts no device for the browser, while the join is still told to the owner as a new device.
- **The token does not leak.** It stays in the page's own path and goes only in the accept's body; the page sends no
  Referer (`no-referrer` in `index.html` and from the pages Worker, which also marks join pages `no-store`) and asks no
  other origin for anything: the brand's fonts, which every other page loads from Google, are left out of it.
- **Practice** serves the whole flow from the fake, says its pretend code on the page, and has a demo link for each answer
  and one for signing in turned off. An invite link from a practice People page opens it too, and joining with the address
  it names adds the helper to that shop.

## Cover while the owner is away

The owner sets cover from their session, or the operator on their word: until a date, one current helper covers. Cover
adds no power: approval-core decides with the same rule whoever covers, so money, public posts, payment confirmations
and commands still wait for the owner. The people list shows the cover and whether it is in force (`coverAt`). Removing the covering helper ends
the cover.

## Passing a request on

A helper may pass a request it may not decide to the owner, with a note of 1 to 500 characters. It decides nothing.
The note is kept with the request in the shop's people record, never in the audit log, and is shown with the request
wherever the shop's approvals are listed and in the operator's people list. A request a helper may decide answers
`decide_yourself`, a request already decided answers who decided and when, and a request is passed on once.

## The audit log

Every change writes one entry, metadata only: the actor (the owner's linked account by its id when the owner made the
change from their session, the operator's Access identity, or the helper's id), a fixed
action (`invite.created`, `invite.revoked`, `helper.joined`, `helper.session_opened`, `helper.session_ended` when a
device signs out, `helper.removed`, `away.set`, `away.cleared`, `request.passed_on`) and ids (`inviteId`, `helperId`,
`requestId`, `taskId`). Never a name, a note or an identity's value. A decision from a session is the job flow's
`approval.decided` entry, naming the owner or the helper.

## A helper's new device

The canvas tells the owner on LINE when a helper signs in on a new device ("Mint signed in on a new device"), even in
quiet hours. LINE is parked, so the owner's desktop says it instead (`docs/runtime-adapter.md`, "Several shops").

Every helper session that is opened, a join (the helper's first device) or opening the shop on another device, writes one
sign-in to the shop's people record in the same change: the session's id, whose it is and when, by the shop's clock. It is
not the session and gives no access: nothing that checks a session reads it. The owner's session reads them with
`GET /v1/people/devices` (`docs/pilot-api.md`, "The owner's own routes"): the helper's id and the name the owner gave them,
when, and the session's id, and nothing else. A helper's session is refused (403 `owner_only`), as on the owner's other
routes.

- **Signed out is not unseen.** A sign-in stays listed after its device signs out, for 30 days (as long as a session
  lasts) and up to the newest 50, so an owner whose app was closed still hears that someone signed in as Mint. The
  sign-ins of a helper the owner removed are not listed.
- **A device is a session.** The backend cannot tell two devices from one device that signed in twice, so signing in
  again (after signing out, or after the 30 days) is a new device here, as it is in `devices` of the people list.
- **Ten at a time, and twenty a minute.** A helper keeps at most 10 sessions open: an eleventh ends their oldest, as
  signing out of that device would. And one person opens at most 20 shop sessions a minute, so a helper signing in over
  and over can neither grow the shop's record nor flood the owner with new devices (`docs/pilot-api.md`, "Opening a shop
  session").
- **A join counts.** Accepting an invite is the helper's first device, so the owner hears of it as of any other.
- **Not in the export.** The sign-ins are not part of the shop's export. The audit log, which the export carries, already
  has each one as `helper.joined` or `helper.session_opened`, with the time.

The owner's desktop reads the route for each shop it owns, with that shop's own session, and never for a shop where the
person is a helper. It tells the owner once of each sign-in it has not told before, as a notification that
`@manut/notify-rules`' `new_device` alert rules on: "Mint signed in on a new device", then the shop, the time and the
canvas's "If this was not Mint, remove access." (the app writes these words, since the package has no helper to name).
Quiet hours never silence it, and with Hide details on it names no one. Look first
(or a click on the notification) brings the app forward, shows that shop and opens Settings › People, where the owner can
remove access ("The People screen on the desktop", below), and Later only dismisses. The first time the app looks at a shop it tells nothing, so
a first run does not ring for every helper; what it has seen is kept per shop on that computer and goes with the shop.
Each sign-in has a notification of its own. Switching Notify me off switches this off too.

## The People screen on the desktop

The owner sees and manages who can use Manut AI for a shop in Settings, under **Shop**, in **People**
(`apps/desktop/src/pages/PeoplePane.tsx` and `people.ts`; the design is the canvas's "Settings: people" board). It reads and
changes, for the shop the switcher shows, with that shop's own owner session (`docs/runtime-adapter.md`, "Settings › People"):

- **The list.** The owner first, marked "(you)", with how many devices they are signed in on; each helper with when they
  joined, the account they signed in with and on how many devices (and "Covering" while the cover is theirs); then the invites
  that wait, each with Copy link and Cancel invite, and the ones that ran out, marked Expired, with neither (the API gives no link
  for them and refuses to cancel them). An invite that was used is a helper now, and one that was cancelled is gone, so neither
  is listed.
- **Only the owner.** A shop the person only helps at has a People page that says whose it is ("Only Noi can see and change who
  can use Manut AI for Ran Pa Noi. Ask Noi if someone should be added or removed.") and nothing else: nothing is read for it and
  nothing sent, so a helper's session never carries a name, a LINE ID or an email to the API (it would answer 403 `owner_only`).
  A person in no shops has no shop to manage here ("No shop is linked to your account yet").
- **Invite a helper.** A name and a LINE ID or an email in one box. **Manut AI does not send the invite**: the API makes a link
  (`inviteUrl`) and the page shows it with Copy link, and says plainly that the owner sends it themselves ("Send this link to Mint
  yourself. Manut AI does not send it."). Where it matters the page says that an invite for a LINE ID cannot be opened yet,
  because nothing signs in as a LINE account until LINE Login exists: in the form as soon as a LINE ID is typed, and in the invite's
  row. For an email it says the invite opens only for someone who signs in with an Apple ID that uses that address. The link is
  held by the page while it is open and nowhere else.
- **Remove.** Asks first in the helper's row ("Remove Mint?", with Remove Mint and Keep Mint, the safe answer holding the focus),
  then says that Mint "was removed and signed out on every device", with the invites for them and the cover that the API says it
  also ended. **There is no Undo**: removing a helper ends every session of theirs in one write and the API has no way to bring
  them back, so the page says they can be invited again (a new invite makes a new helper). What they approved stays as it was, and
  Manut AI keeps their name with it.
- **While you are away.** One current helper covers messages until a day (the end of that day on this computer's calendar), and
  End cover ends it. The API's own refusals are said in words: a day that has passed (`bad_date`), a person who is no longer a
  helper (`not_a_helper`). Cover adds no power: money, public posts and settings still wait, as the line under the heading says.
- **What each role can do.** Only rows that are true of the app as built. The four approval rows are read from approval-core's
  `mayDecide`, so they cannot drift from it: a helper approves messages and replies, and asks the owner about money, public posts
  and payments. A helper's session reads the requests that wait and nothing of what the team knows, its past work, the team, its
  routines, the connections, the consent, the export or the people (403 `owner_only`), which are the last three rows. The canvas's
  "Helpers are free, up to 3 (example)", "Use Code", "See sales, the AI budget and the plan", "See customer chats and orders" and
  "Usually online 18:00 to 22:00" are not there: pricing and limits are the owner's call, Code is on the person's own computer
  whatever their role, the app shows no sales or plan yet, a helper sees requests and not chats or orders, and the API does not
  know when a helper is online.
- **Sign-in and safety.** "Everyone signs in with their own Apple ID. Nobody shares a password. Signing in with LINE is not
  available yet." and "Every approval is recorded with who made it." The canvas's row about a helper's devices being listed in
  Security is gone (there is no Security page; each helper's row says on how many devices they are signed in). Signing in by an
  email code is built and switched off (see "What a helper signs in with"): the line, and the note under an email invite, name
  Apple only until the owner turns it on, and then they should say so too.
- **The new-device notification** is as it was; Look first, or a click on it, now shows that shop and opens this page, where the
  owner can remove access.
- **Practice** shows the canvas's sample (Fon the owner, Mint a helper, Beam invited by LINE ID) and changes by the same rules,
  because it runs `@manut/people-rules` itself. Its invite links end in `.invalid` and go nowhere.

## Not built yet

- (Built since, 24 Nov 2026: a helper's list of the shops they help is `GET /v1/shops`, with a session per shop from
  `POST /v1/shops/session`; see `docs/several-shops.md`. A helper who joined before it is listed once they open the
  shop again.)
- (Built since, 24 Nov 2026: the owner manages helpers from their own shop session, `GET /v1/people` and the changes
  under it; see `docs/pilot-api.md`, "The owner's own routes". The app's screens for it are built too, above.)
- (Built since, 24 Nov 2026: the owner's desktop tells them about a helper's new device, as above. The canvas does it on
  LINE, which is parked, so that is still not done.)
- (Built since, 24 Nov 2026: the People screens in the app, Settings › Shop › People: seeing the helpers, inviting one,
  cancelling an invite, removing a helper, and cover while the owner is away, as in "The People screen on the desktop"
  above. The notification's "If this was not Mint, remove access" now opens that page for the shop. Not built: an Undo after
  a removal (the API has none: invite them again), sending an invite (LINE and email sending are parked, so the owner
  sends the link), and opening an invite made for a LINE ID, which waits for LINE Login.)
- (Built since, 24 Nov 2026: the owner's link page names the helper who approved or declined a reply, as the canvas's
  "Approved by Mint at 19:42." and "Mint approved this at 19:42", from `decidedByHelper` in `docs/pilot-api.md`.)
- (Built since, 24 Nov 2026: the join page an invite link opens, as in "Invites" above. It is off until signing in by email
  is on, which needs the owner. Not built: signing in there with Apple or LINE, and a web session that outlasts the visit.)
