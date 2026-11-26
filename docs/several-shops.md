# Several shops: one person, several shops

How one signed-in person reaches several shops, owning some and helping others, without weakening tenancy; how a
session names the one shop it acts for; how the desktop shows the shops together; what links an owner's account to a
pilot shop the operator created; and the slices that follow. This is the roadmap's Phase 6 "several shops in one
view" (`docs/plan.md`, December item 7). The first slice is built in `apps/api`: `shops.ts` and `shops-store.ts`, with
the owner's account kept beside the helpers in `people.ts` and `people-store.ts`. The routes are in
`docs/pilot-api.md`, "Several shops". The console's owner link (slice 3), owner sessions on more routes (slice 4) and
ending a shop session (slice 5) are built too, and so is the desktop (slice 2, 24 Nov 2026): the switcher, one Needs
you across the shops, and each shop kept apart offline. Since then the desktop shows a shop the person owns whole (24 Nov
2026, `feat/connected-whole-shop`): its tasks, its team, Mission Control and the owner's routine and pause writes. And a
shop the person helps at is theirs to help at on the desktop (25 Nov 2026, `feat/helper-session`, December item 69): marked
so, its asks read and answered with their helper session, and each page that is the owner's saying whose it is.

## Where things stood

- **One signed-in identity is one tenant.** The lifted Sign in with Apple (`auth.ts`, `auth-object.ts`) makes the
  verified Apple subject the tenant (`apple:<sub>`), and every session route acts for that tenant and no other.
- **A pilot shop is a tenant of its own** (`pilot:<uuid>`) that an operator creates. No session can carry it, because
  a session's tenant always comes from a verified provider subject.
- **A helper reaches one shop** with a helper session (`mhs1.`), given when they join through an invite or open the
  shop on another device (`docs/people.md`). Only that shop's approval routes accept it.
- **Nothing linked an owner's account to their shop.** The owner decided through signed links only.

## The model

Three things, each kept where that kind of thing already lives.

1. **Who a person is: the verified provider subject.** The identity is the lifted session's tenant (`apple:<sub>`),
   never an email and never anything a request says. The email Apple verified rides along only for the one check that
   needs it: a helper's invite names an email.
2. **Who may act for a shop, and as what: the shop's own record.** The shop's people record (its TenantObject,
   `people:<shop>`, `people-store.ts`) is the authority for both roles. The helpers were already there, matched by the
   identity their invite named. The record now also keeps the owner's linked account, `{ id, subject, linkedAt }`, one
   per shop, and the owner's shop sessions beside the helpers' ones. So linking, unlinking, opening a session and
   ending sessions are each one `transactionSync` with its audit entry, the shop's export carries the link, and
   deleting the shop wipes it.
3. **Which shops a person is in: an index per identity.** AuthObject keeps `identity-shops:<subject>`, rows of
   `{ shop, role, ref, at }`, written when the operator links an owner's account and when a helper joins or opens a
   shop. It answers "which shops am I in" without reading every shop, as the lifted company membership index answers
   "which companies am I in" (`auth-object.ts`). It is never the authority: every use reads each shop's record again,
   so a row the shop no longer holds (an unlinked owner, a removed helper, a deleted shop, or a row planted by mistake)
   lists nothing and opens nothing. A shop's deletion removes the rows that name it, as the lifted wipe removes the
   inbound routes that name a tenant, reading the index 128 rows at a time; a person's own deletion does not read it at
   all, since a person's tenant never names a shop (`docs/pilot-api.md`, "Sessions").

Tenancy is not weakened:

- No session ever carries a shop's tenant, and a person's own session still acts only for their own tenant.
- A shop session (below) names one shop, and only that shop's routes that learn who is calling from `callerOf`
  (`people.ts`) accept it: the approval routes for both roles, and for an owner the team's routines, what the team
  knows, the shop's consent and export, and its helpers, which are the owner's. Those answer a helper's session 403
  `owner_only`. Every other session route (tasks, deletion, connections, schedules) answers a shop session 401, so
  nobody acts as the shop through it.
- The role comes from the shop's record of the session: an owner session is held under the shop's linked account, a
  helper session under a current helper. Never from a body, a query or a header.
- A shop the person is not linked to answers 404, the same answer as a shop that does not exist.

## How a session names its shop

A person signs in once, with the lifted session, and asks for a **shop session** for each shop they act for:
`POST /v1/shops/session` with `{ shop }`. The shop's record decides the role, and the answer is a bearer token for that
one shop:

- as its owner, `mos1.<shop, base64url>.<64 hex characters>`, held in the shop's record under its linked account;
- as a helper, `mhs1.<shop, base64url>.<64 hex characters>`, the same helper session `POST /v1/people/session` gives.

The shop keeps only the token's SHA-256. A shop session lasts 30 days with no refresh, as a helper session does; the
app opens the shop again with the signed-in session after that. Unlinking the owner's account ends every owner session
of that shop in the same write. Removing a helper ends that helper's sessions of that shop. Nothing done to one shop
ends a session of another. When the person signs out of a device, the app ends its own session of each shop with
`POST /v1/shops/session/end`: exactly that session, in one write, and no other of theirs. The route takes the shop
session itself as its bearer, so the shop and the role come from the session and nothing else.

With a shop session, every read and every decision works as it did, scoped to the session's shop: `GET /v1/approvals`
lists that shop's requests, the decision route finds requests only in that shop's index, and approval-core decides
with the role the session holds. A linked owner decides as role `owner` with `decidedBy` the account's id
(`owner-<uuid>`), so the audit log says which account decided. The shop's own lifted session still decides as
`owner-session` and the owner's signed link as `owner-link`. The team's routines (`/v1/routines`, `/v1/team/*`) learn
who is calling the same way, so a linked owner's session reads and changes that shop's routines and pauses its team,
and the log names the account there too; a helper's session is refused there, as before.

From slice 4, the same owner session also reaches, each for its own shop only:

- **What the team knows** (`/v1/memory`): every fact, and the owner's say over each, "It's true", Correct, Forget and
  their own words, through the same operations the operator relays them with.
- **The shop's consent to cloud work** (`/v1/consent/cloud`): the owner reads it, gives it and withdraws it. No operator
  route writes it, as before. A shop stays live once its owner has answered, so withdrawing consent stops the team's
  work and never lets an operator delete the shop without the owner's yes.
- **The shop's export** (`/v1/tenant/export`): everything stored for the shop, the same export the operator gets. It is
  the answer's body: the app reads it with the session in the `Authorization` header and saves the file itself, so no
  link is made and no token is put in a URL.
- **The shop's helpers** (`/v1/people`): the owner invites (a name and a LINE id or an email), revokes an invite,
  removes a helper (which ends their sessions on every device at once) and sets and clears cover, through the same
  operations of `@manut/people-rules` the operator routes use, each one write with its audit entry.

Consent and the export keep the lifted routes' own paths, so an app reads them the same way whichever session it holds;
only a token shaped as a shop session is answered differently there. Every change names the linked account by its id
in the shop's audit log, never its subject, an email or a name. Bodies are exact, and a shop, a tenant or a role named
in a body or a query is refused rather than read. Nothing here sends anything to a customer, posts or pays, and none of
it deletes the shop's data: the only things that go are what the owner asks to go, one fact's words when they say
Forget, and a helper's sessions when they remove the helper. The operator keeps every one of these routes, to relay the
owner's word, linked or not.

Why a session per shop, rather than one session naming a shop in each request: the shop is fixed when the session is
made, from the person's verified link, so no later request can point it at another shop; unlinking or removal ends
exactly the sessions it should, in the same write; and the approval routes needed no change to their scope.

## What links an owner's account to a pilot shop

Nothing did. Now a one-use link code does, with one step for the owner and one for the operator.

1. **The owner** signs in with Apple in the app and asks for a link code (`POST /v1/shops/owner-code`). The app shows
   it: eight characters, `XXXX-XXXX`, good for 15 minutes. The owner sends it to their operator through the channel
   they already use for the shop: the shop's LINE chat with the operator, or a call to the owner's known number.
2. **The operator** checks that the code came from the shop's owner through that channel, then enters it on the shop
   (`POST /v1/admin/shops/owner` with `{ tenant, code }`, behind the admin gate). The code works once and names only the
   account that asked for it. The shop's record links that account as its owner, in one write with an `owner.linked`
   audit entry under the operator's Access identity. The entry names the link by its id, never the account's subject or
   the code.
3. The owner's app now lists the shop as theirs (`GET /v1/shops`) and opens an owner session for it.

Why a code and not an email: the code names the exact account, the Apple subject, so two Apple accounts are never
joined by an email (the lifted sign-in's rule), an owner who chose "Hide My Email" can be linked, and a mistyped code
links nobody. AuthObject keeps only the code's SHA-256, and asking for a new code replaces the last. A code proves that
whoever sent it was signed in as that account in the last 15 minutes. It does not prove they are the shop's owner: that
check is the operator's, through the channel they already trust, as it is for every change the operator makes on the
owner's word.

A shop has one linked owner account at a time. Linking a second answers 409 `already_linked` until the operator
unlinks the first (`POST /v1/admin/shops/owner/unlink`), which ends that account's owner sessions at once and writes
`owner.unlinked`. Linking the same account again changes nothing and writes its index row again, which mends a row a
failed write left out. The operator sees the link on the shop's People answer (`owner.account`), and the console's People
page does everything with it: the owner's row says whether an account is linked and on how many devices; with none, a box
takes the code the owner reads out, with the line "Take the code only from the owner, on a call or in the shop's own
chat."; with one, Unlink asks once more ("{owner}'s app will be signed out of this shop on every device.") and says how many
sessions it ended. That line says where a code may come from and no more: how operators confirm a code is not settled by the
owner (`docs/decisions.md`).

## A shop its owner makes

Built, and off until the owner opens sign-ups (`apps/api/src/self-serve.ts`; `docs/pilot-api.md`, "Making a shop of your
own"). A signed-in person, with Apple or with a code sent by email, makes their own shop from one of the three shop
templates or none, with `POST /v1/shops/new` and exactly `{ name, ownerName, template }`, and is its owner from the first
write. No operator makes it, and no link code links it.

- **The same shop.** It is made by the operator's own code (`writeNewShop` in `pilot.ts`), template and all, so it is a
  pilot shop like any other: its own tenant, its records in its own objects, its export and its deletion unchanged.
- **Owned from the first write.** The write that makes the shop's record also writes its people record with the person's
  account linked as its owner and this device's first owner session, and the template's setup, so the shop never exists
  without its owner or half set up. The model above holds: the shop's record is the authority, and the person's index row,
  written last, only finds it.
- **Its log.** That write holds `shop.created`, `shop.made_by_owner`, `owner.linked` and `owner.session_opened`, then
  `template.applied` and a `routine.created` for each routine, each by the owner's linked account, named by its id, never its
  subject or an email.
- **Listed together.** The console's list and the person's own list get the shop in one AuthObject transaction, last, so
  the operator never sees a shop its owner cannot, nor the other way round.
- **A make that stops part way.** It is on AuthObject's journal of makes from the transaction that takes its slot, before
  anything of the shop is written, and is never listed until whole. Asking again with the same name, owner name and template
  finishes that very shop, on a slot it takes again, and gives this device an owner session of its own, since the first
  one's token never reached anyone; it never makes a second shop, and never loses a slot. `docs/pilot-api.md`, "A make that
  stops part way", has each step and what a stop at it leaves.
- **Its limits.** While sign-ups are open, every try counts against a per-address rate limit. An account may have made 3
  shops that still exist, decided in AuthObject before anything is made; shops an operator linked to it never count. And
  since one mailbox can have as many accounts as it likes, at most 20 shops are begun in a Bangkok day, all accounts
  together, in the same transaction: past that the answer is `sign_ups_full` until the next day.
- **Its team waits for Manut AI.** Until an operator counts the shop in (the console's Count it), its team makes no model
  call and runs no routine, each refused or skipped with `not_counted_in`, so nothing such a shop asks for is sent to a
  model or spent on the owner's key (`apps/api/src/shop-waits.ts`). The API's answer says so (`teamWaits`), and so does
  the person's list of shops until it is counted in.
- **Where it shows.** The console's Shops overview marks it "Made by its owner", and the pilot gate lists it without counting it
  in the cohort unless an operator adds it.
- **Off.** Until the var `SELF_SERVE_SHOPS` is `"on"`, which no environment sets, the route answers `sign_ups_closed` and
  reads nothing. Who may sign up, the pilot's customers and any price are the owner's calls; a self-serve shop has no
  payment step while billing is parked.
- **On the desktop** (`src/settings/MakeShop.tsx`, `makeShopFlow.ts`; the op `shops.make`, `src/runtime/makeShop.ts`).
  Settings › Developer offers "Make your shop" in a group of its own below the sign-in, while a signed-in person is in no
  shop: the shop's name, their own name, and which kind of shop it is (Handmade and gifts, Clothes and accessories,
  Packaged food and drinks, or None of these). The connected runtime sends it with the sign-in, keeps the owner session
  the API answers with the sign-in (the keychain item), reads the shop with the person's others and shows it, so it is in the
  switcher by the time the answer arrives; the app then opens it, as choosing it in the switcher does. While the API
  answers `sign_ups_closed` the page says so plainly: "Making your own shop isn't open yet. For now, Manut AI sets each shop
  up with its owner." Once a shop is made, the page says why its team waits: "Your team starts work once someone at Manut
  AI has checked your new shop: until then nothing runs and no AI is used." A day whose sign-ups are full says "Manut AI
  has opened as many new shops today as it can. Try again tomorrow." Practice offers the same form whenever it runs and makes the shop in memory, with nothing sent, up to
  3 of them, listed after the person's own shop. The first run does not offer it: it does not sign in at all.

## How the desktop shows them

Built in `apps/desktop` (`src/runtime/http/shops.ts`, `host.ts`, `session.ts`, `cache.ts`; the switcher in
`src/sidebar/ShopSwitcher.tsx`). `docs/runtime-adapter.md`, "Several shops", says how each part reaches the API.

- **A session per shop, kept with the sign-in.** After sign-in the app reads `GET /v1/shops` and opens each shop with
  `POST /v1/shops/session` and exactly `{ shop }`. Each shop session (its token, its role, its end) is kept in the one
  keychain item that holds the sign-in, under the shop's id, and nowhere else; every write to that item takes its turn
  with the sign-in's refreshes. A session that ended, or that answers 401 for any reason but `unlinked` or `removed`, is
  opened again once with the sign-in.
- **What a shop shows.** A shop the person owns is read with its owner session for its requests, its export (its tasks
  with each member's runs and drafts, its schedules and attention items) and its team with its routines
  (`GET /v1/routines`), so its pages show what the signed-in tenant's show and more: its tasks as Buddy's threads in
  History, its team (Buddy, then Nam, Pim and Ton as the shop has them on), Mission Control's jobs, activity log and Pause
  everyone, and its routines (`docs/runtime-adapter.md`, "A shop the person owns"). A shop the person helps at shows Buddy
  with its requests and nothing more: what a helper sees is the owner's call, and the task list, the schedules, the
  attention items and the routines answer a helper's session 403 `owner_only`. So each page that is the owner's says whose
  it is, in place of an empty list (below).
- **A shop the person helps at** (`docs/runtime-adapter.md`, "A shop the person helps at"). It is opened with the person's
  helper session (`mhs1.`) as an owned shop is with its owner session: asked for with the sign-in and exactly `{ shop }`,
  kept with the sign-in, opened again when it ends, and ended at sign-out. That session is sent what waits there
  (`GET /v1/approvals?state=open`, and `state=recent` when an ask left with no answer from here), the live feed's ticket, a
  decision and a note passed on, and nothing else. While the switcher shows it, the account row marks it "Helper" and Home
  says "Helping Noi at Ran Pa Noi". The Team page lists Buddy, who holds what waits, and says the team and Pause everyone
  are Noi's, with no Pause offered; History, the activity log and Automations say its past work, its log and its routines
  are Noi's to see; Home says only Noi sees who is working; each with a way to Needs you. Customize and Settings › People
  say whose they are as they already did. The helper approves and declines what their role may decide, through the same
  decide route, and every refusal names the owner ("Only Noi can approve money", "Already decided by Noi at 19:42"). A
  removal closes the shop's asks in the API's words. Offline, its record in the kept read holds its asks and nothing of its
  work, sealed with the rest.
- **One switcher, in the account row.** The account row still opens Settings, and names the person and the shop being
  viewed. With two or more shops a small button at the row's end (two chevrons, "Switch shop") opens the list above it:
  the shops the person owns first, each with "Owner" or "Helper" and a tick on the one shown. Choosing one switches every
  page to that shop and reads them again. A person with one shop sees no button. The shop viewed is not remembered between
  starts: the app opens on the first one listed.
- **One "Needs you" across the shops.** Each shop's `GET /v1/approvals?state=open` is read with that shop's own session,
  and every shop's asks are one list, newest first by when each was asked. Each card, row and notification names its shop
  ("Buddy at Ran Pa Noi needs your approval"). Each card offers only what the person's role there allows, as approval-core's
  `mayDecide` says: where a helper may not decide (money, a public post, a payment, a command), the card says "Only Noi can
  approve money" and offers "Ask Noi", the canvas's words for passing it on, which sends `POST
  /v1/approvals/{id}/pass-on` with exactly `{ note }` (1 to 500 characters). A note passed on shows on the card: "Passed
  on by Mint" and "Mint: <note>" for the owner, "Passed on to Noi" for the helper. A decision is always sent with the
  session of the card's own shop, which the ask's id names, never the shop the switcher shows; the card's buttons, Home's
  Approve and Approve on a notification all take that one path (`src/runtime/http/several.test.ts` fails if any does not).
- **Each shop's data kept apart offline.** The kept read is one file per sign-in, as before, and every shop's record in it
  is under that shop's id; a shop that leaves is dropped the next time the file is written. Signing out ends every shop
  session with `POST /v1/shops/session/end` (the session itself as the bearer, exactly `{}`), then clears every shop's
  session and kept read; a sign-out that cannot reach the API still clears this computer.
- **A helper's new device.** For each shop the person owns, the app also reads `GET /v1/people/devices` with that shop's
  own session and tells them once of each helper sign-in it has not told before, as a notification: "Mint signed in on a
  new device" (`docs/people.md`, "A helper's new device"). It never asks about a shop where the person is a helper. The
  first look at a shop tells nothing, and what it has seen is kept per shop on this computer and goes with the shop.
- **A shop the person's place in ended.** An answer of 401 `removed` or `unlinked` drops that shop's session and kept read
  at once. A shop that leaves the list is looked at once with its own session, so the app can say why and when, and then
  dropped. Its asks close in those words, and a notice above the account row says them until dismissed: "You no longer
  have access to Ran Pa Noi. Noi removed you on Sunday, November 22. Ask Noi if this is a mistake".
- **Practice** lists two sample shops: the person's own (the demo team's, named as the first-run setup named it) and Ran
  Pa Noi, where they help Noi. Typing `/shops` in a chat puts both shops' requests in Needs you; viewing Ran Pa Noi shows
  Buddy alone with them, and the pages that are Noi's say so, as a helper's shop shows when connected.
- **This Mac as a shop's outpost** (`docs/browser-control.md`, "This Mac for the shop the switcher shows"). Register this
  Mac goes with the owner session of the shop the switcher shows, so a pilot shop can have this Mac as its outpost; a shop
  the person helps at is refused with nothing sent. The outpost runs while the person holds a live owner session of the
  shop it is registered for, or is signed in to it, and stops when they no longer do: at sign-out, an unlinking, a shop
  gone from their list, or an owner session that ended and was not opened again. A helper's session never runs it.
  Customize › Connections knows which of the shop's outposts is this Mac and shows it once, in its own row.

## The slices that follow

1. **Done here (API):** the owner's linked account, the identity index, link codes, `GET /v1/shops`,
   `POST /v1/shops/session`, owner sessions on the approval routes and the team's routines, the operator's link and
   unlink, and the link in People.
2. **Done here (desktop):** the switcher, the combined "Needs you" and the per-shop offline cache (24 Nov 2026), above.
3. **Done here (console):** the shop's People page shows the owner's linked account on the owner's row, with a box for the
   link code and an Unlink that asks first (24 Nov 2026). The Audit page has words for `owner.linked`, `owner.unlinked` and
   the shop sessions' entries, and the practice mode answers both routes as the API does, with sample codes on its home
   page.
4. **Done here (API): owner sessions on more routes** (24 Nov 2026), each its own decision (`docs/decisions.md`): what
   the team knows, the shop's consent and export, and the shop's helpers, as above. The console's Audit page names the
   owner by how they acted (their linked account by its id, the shop's own session, or a link), and its People page says
   whether the owner can change the list and who changed it. A helper's session reaches none of
   them (403 `owner_only`), what the team knows included, since it can hold the owner's costs and suppliers. Not in this
   slice: deleting the shop's data from an owner session, which stays with the owner's confirmation link (the operator
   asks, the owner says yes on the link), and a shop session on `DELETE /v1/tenant/data` still answers 401; answering the
   first-week questions from the app. The desktop now reads the export and the routines with an owner session, shows the
   shop whole and pauses and resumes its routines and its team (24 Nov 2026); its screens for what the team knows, the
   consent and saving the export as a file are still to come; the helpers have their screen now (Settings › People, 24 Nov 2026,
   `docs/people.md`).
5. **Done here (API):** ending a shop session from the app, `POST /v1/shops/session/end` (24 Nov 2026). It ends the one
   session it is called with, an owner's or a helper's, and the desktop calls it on sign-out for each shop session it holds.
   A sign-out that cannot reach the API leaves that session to its 30 days, or to an unlink or a removal.
6. **Co-owners:** more than one linked owner account per shop, if the owner wants it.
7. **LINE Login as an identity**, parked with the rest of LINE.
8. **Done here (desktop):** this Mac as a pilot shop's outpost, registered and run through the owner session of the shop
   (24 Nov 2026), above. The API needed no change: `POST /v1/outposts/register` already took an owner session.
9. **Done here (desktop):** a helper's own session on the desktop (25 Nov 2026, December item 69), "A shop the person helps
   at", above. The API needed no change, and was not widened: what a helper's session reads is what `docs/people.md` says a
   helper may.

## Known limits of the first slice

- A helper who joined before this slice has no row in the index until they open the shop once more
  (`POST /v1/people/session` or `POST /v1/shops/session`). There are no real helpers yet, so nothing is backfilled.
- A helper row is written for the Apple account that joined or opened the shop. Another Apple account that verifies
  the same email can still open the shop by its id, but does not see it listed until it has.
- A person who deletes their own tenant's data keeps their links: those are the shops' records, and leaving a shop is
  unlinking or removal. Their pending link code is deleted with their data.
- A person's index has no cap on its rows. An operator's link, an invite an operator made, and a shop the person made
  themselves add one each, and the last is capped at 3 made shops that still exist ("A shop its owner makes"), so what a
  person does alone grows it by 3 rows at most.
- A shop's people record keeps at most 10 open sessions for each helper and 10 for the owner's account: opening one more
  ends the oldest, as signing out of that device would. And one person opens at most 20 shop sessions a minute, on
  `POST /v1/shops/session` and `POST /v1/people/session` together, whatever address they come from (`docs/pilot-api.md`,
  "Opening a shop session"). Someone who uses more than 10 devices at once signs one of them in again now and then.

## Known limits of the desktop slice

- A shop the person helps at shows only what waits there, and says the rest is its owner's. Whether a helper sees more of
  it (its tasks, its team) is the owner's to decide. Its card says a worker's request by its operation and where it goes,
  since a helper's session reads no tasks; a request that carried its action's words would say more (an ask of the API,
  `docs/runtime-adapter.md`, "Next slices").
- The owner's writes from the desktop are pausing and resuming a routine and Pause everyone, the shop's vault and outposts
  (Customize › Connections), and the shop's helpers (Settings › People, 24 Nov 2026). Making a routine, the shop's own
  schedules, what the team knows and the consent have routes an owner session reaches, and no screen on the desktop that
  uses them yet.
- A request that leaves a shop's open list with no answer from this computer closes as "Answered elsewhere", or as timed
  out once past its expiry: a shop session reads no tasks, so the app cannot tell a decision from a withdrawal there.
  Reading `GET /v1/approvals?state=recent` when an ask leaves would tell, at one more request.
- The shop viewed and the dismissed notices are not kept between starts.
- One shop whose read fails (offline, or the API answering 5xx) fails the whole read, so the kept read stands in for every
  shop until it answers again: one shop's asks never vanish because its read did not answer.
- At the app's start, a shop session kept in the keychain counts as live for this Mac's outpost before the API is asked.
  An owner unlinked while the app was closed sees the outpost start for that shop and stop again at the first read,
  seconds later.
