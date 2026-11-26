# The owner's web app

A shop owner, or one of their helpers, adds Manut AI to their phone's home screen and gets an app: they sign in with a
code sent to their email, see what waits for them across their shops, and approve or decline each request with its
exact words. It is the roadmap's web client for owners, and it stands in for phone apps until the desktop is complete.

It lives at `/app/` on the API's own origin (`https://dev.manut.xyz/app/` in dev), as a page of its own
(`apps/web/app/index.html`, `apps/web/src/app/`). Signing in by email is built and off (`email_not_configured`) until the
owner turns it on (`docs/sign-in-options.md`), so today the app opens, says "Signing in isn't on yet", and does nothing
else in a real environment. Practice mode shows everything else.

## What it shows

- **Signing in**: the join page's two steps and words (an address, then the 6-digit code), shared with it
  (`apps/web/src/signin/`). A wrong code, an ended one, a wait for a new one and every other answer read as they do there.
- **Today**: the phone board's greeting ("Good morning, Fon", on the shop's clock, with the name of a shop the person
  owns), Buddy's morning brief, and the two oldest requests. The API has no brief yet: Buddy writes one once the team's AI
  model is switched on, and the card says so, with how many requests wait.
- **Needs you**: every request still waiting, across the shops, oldest asked first. Each card names its shop and when it
  was asked, says in one sentence what approving does, and shows the exact words: a LINE reply's text exactly as it will
  be sent, or the control plane's own sentence for a browser write or Ton's books. Approve and Decline choose the option
  by what it does, at the revision shown, and go to `POST /v1/approvals/{requestId}/decision` with that shop's own session.
  What may be decided is approval-core's `mayDecide`: a helper decides messages and replies, and money, public posts,
  payment confirmations and commands say "Only the owner can …" and "It waits for {owner}", with no buttons.
- **Every answer** reads as the approval page reads it: sent, being sent, refused by LINE, not sure it was sent, said no;
  already decided, by whom (you, the owner from the LINE link, a helper) and when, with "Nothing was sent twice"; changed
  since you saw it; taken back; nobody answered in time; the shop has not agreed yet; switched off; removed from the shop.
  No answer at all is never read as taken or as lost: the app reads the shop again before offering the buttons.
- **Answered lately**: the newest requests decided or run out, with who and when.
- **Chat**: chatting with Buddy waits for the model, and the tab says so.
- **Shops**: each shop, whether the person owns it or helps, what a helper may approve, and Sign out.
- **Your Mac** (`src/app/mac/`, item 78c, `docs/remote-access.md`): this phone paired with the person's own Mac, with no
  sign-in, so it shows in the nav before signing in too (Today and Your Mac). The person scans the Mac's code (where the
  browser can read one) or pastes its link, the phone shows four digits to type on the Mac, and then makes a passkey.
  Paired, it lists the Mac's chats as Needs you, Working and Done, and a chat shows its messages, its current step and its
  asks whole, with Allow once and an answer to a question (each with Face ID or the passcode), No and Stop, and nothing
  else. It says "not available yet" while the API's `/v1/health` says the relay is off, or when the page is not on the
  API's own origin.

The web is not told helpers' names, so another helper's decision reads "a helper". What waits is read on opening, every
minute while the app is in view, when it comes back into view or online, and after each answer.

## The session

The app's sign-in lasts after it is closed, in cookies the API sets and the page's script cannot read
(`docs/pilot-api.md`, "The web app's session"; `apps/api/src/web-session.ts`). The other way, tokens the page keeps
itself in `localStorage` or IndexedDB, was weighed and not chosen:

| | Cookies the API sets (chosen) | Tokens the page keeps |
| --- | --- | --- |
| What a script on the page can read | nothing: no answer carries a token, and the cookies are `HttpOnly` | the sign-in (refreshable for 90 days) and every shop session (30 days, decides) |
| What a script that should not be there can do | act while it runs; it can take nothing away | take the tokens and use them anywhere until they end |
| Requests another site makes a browser send | refused: `SameSite=Strict`, the header `x-manut-web: 1`, this origin | no cookie, so none |
| Refresh | the API, inside the web routes; the page never sees a token | the page |
| What the existing routes accept | unchanged: bearer only; five web routes are the only cookie readers | unchanged |
| Lasting on an iPhone's home screen | first-party cookies the server sets | script-written storage, which Safari may clear |

- **Five routes**, all under `/v1/web/`: sign in with a code, the person's shops (each with a session ready), a shop's
  approvals, a decision, and sign out. Each hands its request to the route that does the work, with the bearer from the
  cookies, so a decision is the desktop's decision: the same route, the same shop session, approval-core's rules.
- **The cookies** are `__Host-` (this host, every path), `Secure`, `HttpOnly`, `SameSite=Strict`: the sign-in's device id
  and refresh token for 30 days (renewed by each refresh, ended by the lifted auth at 90), its access token for its hour,
  and one shop session per shop for its 30 days less an hour. A phone keeps its shop sessions, so it counts as one device
  in the owner's People list, not one each time the app opens.
- **A shop cookie needs the sign-in.** A shop session can outlive the sign-in it was opened under (the lifted auth's 90
  days, or the person's data wiped), so reading a shop's approvals and deciding one check the sign-in first. Once it is
  over the app is told `signed_out`, nothing is read or decided, and every shop cookie is cleared with the access cookie
  (`docs/pilot-api.md`, "A shop cookie needs the sign-in").
- **The page's policy.** `/app/` runs only this origin's scripts (`apps/api/src/app-policy.ts`): no script written into
  the page, from another site, or from a string. Every other page on the origin has one too (the console, the links'
  pages, the practice home and the join page; `docs/pilot-api.md`, "One origin"), since a script on any of them could use
  the app's cookies while it runs.
- **Signing out** ends every shop session and the sign-in on the API, then clears every cookie. It needs the API: offline,
  the app says to sign out when back online, since a page cannot clear cookies it cannot read.
- **Signing out everywhere** is not built, as the desktop has none: the lifted auth has no route that ends all of one
  person's sign-ins. A shop's owner can still end a helper's sessions by removing them, and the operator an owner's by
  unlinking the account.
- **Nothing else is kept**: no `localStorage`, `sessionStorage`, IndexedDB or cache holds anything of the session or of a
  request, and no token is ever in a URL. What was read lives in the page's memory until the next read. The one exception
  is Your Mac's pairing, below.

## What Your Mac keeps

This breaks the rule above on purpose (docs/decisions.md, 26 Nov 2026): a pairing that a reload forgot would be no
pairing. Exactly this is kept, in this origin's IndexedDB, in one database named `manut-mac` (`src/app/mac/vault.ts`):

- **`mac`**, once the Mac said the phone is paired: the Mac's host id (the relay's name for it), this phone's device id,
  its relay door token (32 bytes), K, the passkey's credential id, the passkey's relying party (this page's host) and when
  it paired. K is a Web Crypto key made with `extractable: false`, so no script, the page's own included, can read its
  bytes back; it can only derive a session's keys. The door token is kept as bytes because the relay's hello carries it
  as text; it opens only the relay's door for this phone, never a session, which needs K.
- **`spent`**: the door ids of the last 32 pairing codes this phone started, so a code is one try also after a reload. A
  door id is random and names nothing.

Nothing of a chat is ever kept: chats, asks, messages, answers and the Mac's state live in the page's memory, are dropped
when the person leaves the tab, and are cleared 15 minutes after the Mac last confirmed them. None of it goes in the
address (the tab is always `#mac`), a log or a notification, and a pairing link the page was opened with is taken out of
the address at once.

**Forget this Mac** deletes `mac` and closes the session; `spent` stays, so a code started before is still refused. The
phone's passkey stays in its passwords (iCloud Keychain, or Google Password Manager) until the person deletes it there,
under Manut AI's address: a page cannot delete one, and without K and the Mac's record it answers nothing. The Mac keeps
listing the phone until it is unpaired there, which is what revokes its door on the relay.

Practice mode keeps the pretend Mac's pairing in memory only, so a reload forgets it.

## What is cached, and what never is

A service worker (`apps/web/src/app/sw.ts`, built to `/app/sw.js`, rules in `swRules.ts`) keeps the app's shell so it
opens offline and says so. Its scope is `/app/`, so it controls no other page.

- **Cached**: the app's page (`/app/`, from the network first, the kept copy offline), the build's files that page names
  (`/assets/…`, which a newer page replaces), the manifest, the icons, and an offline page (`/app/offline.html`) for when
  even the shell is gone.
- **Never cached, never answered by the worker**: anything under `/v1/` or `/relay/` (the Your Mac tab's relay socket is a
  WebSocket, which a service worker never sees anyway), and `/approve/`, `/delete/`,
  `/join/` and `/ops`, any request that is not a `GET`, and anything on another origin (the brand's fonts). These go to
  the network exactly as with no worker.
- **A cached request is never answerable.** No request is ever cached, and the page keeps none past a read. Offline, the
  app says so; the requests it read before are shown greyed with when they were read, and no Approve or Decline, since
  they may have changed and an answer must reach the API to count. Back online, it reads them again.

## Installing it

The owner opens the app's address in their phone's browser.

- **iPhone** (Safari): tap Share, then **Add to Home Screen**, then **Add**. The icon is Manut AI's mark, and the app opens
  full screen from it. (Other browsers on iOS 16.4 and later offer the same from their own Share menu.)
- **Android** (Chrome): tap **Install app** when Chrome offers it, or the menu (⋮), then **Add to home screen**, then
  **Install**. The icon takes the phone's own shape.

Signing in happens in the installed app, which keeps its own cookies.

## Practice mode

With no `VITE_API_ORIGIN`, the app runs on the in-memory fake (`apps/web/src/api/practiceOwner.ts`): any address, the
pretend code 123456 (said on the screen), and a person who owns Baan Mali and helps at Khao Soi Nimman, with requests
whose answers show each outcome: sent, refused by LINE, not sure it was sent, answered first from the LINE link, and
Ton's books, which a helper sees wait for the owner. approval-core's own store decides each one. `/app/?demo=sign-in-off`
shows what a real environment shows today. Practice keeps its sign-in in the page's memory, so a reload signs out.

Your Mac in practice pairs with a pretend Mac (`src/app/mac/practice.ts`): any pasted text pairs, the four digits are
4821 and "Type them for me" stands for typing them at the Mac, the passkey is pretend (the browser is never asked), and
its three chats answer Allow once, No, an answer and Stop. The phone going offline greys the view.
`/app/?demo=mac-off#mac` shows the tab as it is wherever the relay is off.

## Not in it yet

Push notifications (they need the owner's call and keys), app stores, LINE, Thai words (the owner's writer), passing a
request on to the owner with a note, and helpers' names.
