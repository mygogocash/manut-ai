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

**What needs the owner: a real sign-in for helpers.** The canvas has helpers sign in "with their own LINE or email".

- An invite to a LINE account can be made, but no one can accept it yet: nothing verifies a LINE account. That needs
  LINE Login (a LINE Login channel on the owner's LINE account), and LINE work is parked by the owner.
- An email invite works only for a helper whose Apple ID verifies that same address. Someone who chose Apple's "Hide My
  Email" signs in with a relay address and sees `wrong_account`. Signing in by email itself (a code or a link sent by
  email) needs an email sending service, which may cost money.

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

## Invites

An invite is for one LINE account id (compared exactly) or one email (compared without case), works once, and lasts
7 days. The owner makes it from their session, or the operator on the owner's word, with a name and that identity, and
gets a link to copy: `${WEB_ORIGIN}/join/<token>`. The API never sends it: LINE and email sending are parked by the
owner, so the owner sends the link themselves. The token is an HMAC-SHA256 under
`APPROVAL_LINK_SECRET` in its own domain, `manut-ai/pilot-invite/v1.`, over the shop's tenant, the invite's id and its
expiry, so no approval or deletion link can pass for an invite, and the reverse. Minting is deterministic, so the
console shows the same link again for a pending invite.

Accepting needs a signed-in session whose verified identity matches. The answers are `@manut/people-rules`':

- `joined`: the helper's id, the shop, and the device's first helper session;
- `wrong_account`: the shop's name and which kind of account the invite is for, never its value; the invite stays
  unused for the person it was made for;
- `expired`, `already_used`, `revoked`, `unknown`: nothing about the shop. A token that does not verify is `unknown`.

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
- **A join counts.** Accepting an invite is the helper's first device, so the owner hears of it as of any other.
- **Not in the export.** The sign-ins are not part of the shop's export. The audit log, which the export carries, already
  has each one as `helper.joined` or `helper.session_opened`, with the time.

The owner's desktop reads the route for each shop it owns, with that shop's own session, and never for a shop where the
person is a helper. It tells the owner once of each sign-in it has not told before, as a notification that
`@manut/notify-rules`' `new_device` alert rules on: "Mint signed in on a new device", then the shop, the time and the
canvas's "If this was not Mint, remove access." (the app writes these words, since the package has no helper to name).
Quiet hours never silence it, and with Hide details on it names no one. Look first
brings the app forward on that shop, and Later only dismisses. The first time the app looks at a shop it tells nothing, so
a first run does not ring for every helper; what it has seen is kept per shop on that computer and goes with the shop.
Each sign-in has a notification of its own. Switching Notify me off switches this off too.

## Not built yet

- (Built since, 24 Nov 2026: a helper's list of the shops they help is `GET /v1/shops`, with a session per shop from
  `POST /v1/shops/session`; see `docs/several-shops.md`. A helper who joined before it is listed once they open the
  shop again.)
- (Built since, 24 Nov 2026: the owner manages helpers from their own shop session, `GET /v1/people` and the changes
  under it; see `docs/pilot-api.md`, "The owner's own routes". The API is there; the app's screens for it are not yet.)
- (Built since, 24 Nov 2026: the owner's desktop tells them about a helper's new device, as above. The canvas does it on
  LINE, which is parked, so that is still not done.)
- The People screens in the app: seeing the helpers, and removing one from the notification's "remove access". The
  notification only says it; today the owner asks their operator, or removes the helper from a People screen when the
  app has one.
- (Built since, 24 Nov 2026: the owner's link page names the helper who approved or declined a reply, as the canvas's
  "Approved by Mint at 19:42." and "Mint approved this at 19:42", from `decidedByHelper` in `docs/pilot-api.md`.)
