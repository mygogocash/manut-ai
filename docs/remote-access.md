# Reaching your Mac from your phone (item 78)

The design for the features the owner pointed at on 25 Nov 2026 in another app's "Sharing and access" and "Labs"
settings: network access, a tunnel, new devices approved first, permissions, agent activity on a phone, guest links,
linked environments, a preview tunnel, webhooks held while offline. It was written by a read-only design pass over
this repository and GoSpark's remote access, which the relay in `apps/api` was lifted from. Built so far: that relay,
the channel (78a, `packages/remote-channel`), the Mac's side with Settings › Sharing and access, switched off (78b,
below), the phone's Your Mac tab (78c, below), and the read of Tailscale's state (78f's first part, below). The plan's
rows are 78a to 78f.

## The first version

A paired phone watches Buddy and Kit's lanes live from anywhere, and answers their asks. Every Allow and every answer
to a question needs Face ID.

It covers: network access (through the relay, not a port on the local network), approval of new devices (always on),
permissions (one fixed set for every phone), and notifications with no content in them (the last phase).

What a person does:

1. On the Mac, Settings, Sharing and access, "Reach this Mac from your phone". A consent sheet comes first: what is
   encrypted, what the relay sees, how to stop (the words of GoSpark's `GoGoCode/Remote/RemoteRelayConsent.swift`). The
   switch stays off until the person accepts.
2. "Pair a phone" shows a QR code for two minutes.
3. On the phone, in the installed web app (`/app/`), Your Mac, Scan, or paste the link copied on the Mac. On an iPhone
   a link opened in Safari lands outside the installed app's storage, so it pairs nothing.
4. The phone shows a four-digit check code. The Mac asks: "To allow 'iPhone, Safari' to watch your chats and answer
   their asks, type the four digits your phone shows." The person types them at the Mac, once (a wrong entry spends
   the code, and the Mac shows a new one), and the phone makes a passkey (Face ID). The Mac never shows a code of its
   own, so there is nothing to compare and press Allow on by habit: a phone that was raced by someone who photographed
   the code is refused and shows no digits, so there is nothing to type.
5. The phone lists the chats as Working, Needs you or Done. Opening one shows its messages, its current step and its
   asks, with the whole command as the card shows it. The person can Allow once (Face ID), say No, answer a question
   (Face ID), or stop the turn.

Left out on purpose: sending messages, Always allow, Kit's dial, modes, diffs and files, Live Activities, guest links,
linked environments, the preview, and a listener on the local network (Tailscale is the second road, below). The need
is "something waits on me and I am not at the Mac", and this reuses the relay and the ask path as they are, and adds
no server to the Mac.

## The architecture

**On Cloudflare.** `apps/api/src/relay.ts`, `relay-object.ts`, the two relay limiters in `index.ts` and `RELAY_ENABLED`
stay as they are for phases 1 to 3. They already check the Mac's key signature and each phone's token hash, and
forward binary frames without reading them. Phase 4 adds one message from the Mac (`webpush`: a device id and its push
address) and makes the relay act on `push`, which does nothing today. No new route or object.

**On the Mac: in the desktop's page, not the Rust shell.** The page's WebSocket is the desktop's only socket, the
app's content policy already lets it reach `wss://*.manut.xyz`, and the store and `settleApproval`
(`chat/cards/respond.ts`) live in the page. A new folder `apps/desktop/src/remote/`:

- `link.ts`: one outbound socket to `/relay/v1/hosts/<hostID>/socket`. It signs the relay's challenge with a P-256 key
  as `apps/api/test/fixtures/relay-v1-vectors.json` pins, sends `device`, `revoke` and `status`, pings every 50 seconds,
  and retries with a wait capped at 60 seconds.
- `serve.ts`: the only code that turns a phone's request into a store action, and only for six allowed requests.
- `project.ts`: what the phone sees, masked with `lib/secrets.ts`.
- Keys live in a new keychain item (account `remote`), read and written by a new `remote_keys.rs` with `api_link.rs`'s
  `read_item` and `write_item`. The relay key's private half stays in the shell, which makes it and signs with it;
  each phone's K is imported by the page so script cannot read it back, as `shop-cache-key` is.
- No listener and no open port.

If the page's socket is held back while the window is hidden or the Mac is locked (to be checked in phase 2),
`link.ts` moves into the Rust shell with a WebSocket library.

**On the phone:** a Your Mac tab inside the existing `/app/` (new `apps/web/src/app/mac/`), usable without signing in.
Its service worker already never answers `/relay/`. Keys are kept in IndexedDB in a form script cannot read back, which
breaks `docs/web-app.md`'s "nothing kept" rule on purpose and is written down there ("What Your Mac keeps"). Scanning
needs a QR reader, which the repository does not have: the browser's own is used where there is one (78c, below).

**A new package `packages/remote-channel`, used by both sides:**

- **Pairing.** The QR code holds the Mac's host id, a one-use door to the relay and a 256-bit secret. Over the relay,
  both sides exchange throwaway keys and prove they know the secret (GoSpark's `Shared/Remote/RemoteHandshake.swift`,
  `proof`). The relay can neither read the exchange nor stand in the middle. Once the phone's code is typed at the
  Mac, the Mac sends the phone its own id, door token and key K, then closes the pairing door.
- **Each connection.** A fresh key exchange proved with K, so each session gets new keys. Every message is encrypted
  and numbered, and split to fit the relay's 65,532-byte limit.
- **Each decision.** The Mac issues a challenge that can be used once, lasts 60 seconds, and is bound to the device,
  the request, its revision and the choice (a port of GoSpark's `RemoteDecisionChallenges.swift`). The phone answers
  with a passkey signature that requires Face ID or the passcode. The Mac checks the origin, the domain, that Face ID
  or the passcode was used, and the signature. Only then does it call `settleApproval`, so approval-core settles it
  once, with the phone's device id as who decided.

**What building 78a added to the design** (`packages/remote-channel/README.md` has every byte):

- The pairing exchange keeps the relay out only while the relay lacks the code's secret. Someone who photographed the
  code within its two minutes and controls the relay can pair with each side separately; the check code typed from
  the phone into the Mac is what catches that, and only because the phone commits to its throwaway key before it sees
  the Mac's (ZRTP's hash commitment). Without that order the check code could be steered and would prove nothing.
  Pairing is therefore four messages, and the codes match by chance one time in ten thousand.
- A code is one try on both sides. On the Mac the first commit spends it, and so does a wrong or late typed code. On
  the phone starting pairing spends it, and the phone never tries again on its own: a review on 25 Nov showed that a
  phone that retried would let someone with the photographed code play the Mac to it until its code matched the
  Mac's, about one chance in ten thousand per attempt. The typed code is taken only within the code's two minutes.
- The code travels in the link's fragment (`#pair=`), which no browser sends to a server.
- K is drawn by the Mac once the code is typed, so the code's secret, photographed or not, never opens a session.
- Unpair ends what is open on the Mac's own side: it closes that phone's sessions and drops its waiting decision
  challenges, since the relay's `revoke` is not trusted to end anything and a phone that comes another way has no
  relay. Since the third review (26 Nov 2026) it forgets the phone's K in the page before anything awaits, so while the
  keychain write waits a relay that ignores the revoke gets that phone no new session, and nothing is sent to a phone
  no longer paired, checked at the moment each message is sealed. A pairing cancelled while the keychain wrote ends
  the new phone's streams the same way.
- The Mac cannot tell that the grant reached the phone, so 78b counts a phone as paired only once its passkey
  registration has come back over the pairing channel. The passkey's key is read from the authenticator's own data
  (WebAuthn Level 3, section 7.1), and every answer is also refused from another site's frame or with a counter that
  did not move on.
- Records are authenticated one by one, but the end of a stream is not: a relay that cuts a stream short is noticed
  by the journal's cursors (phase 2), not by the channel.

**What building 78b added** (`apps/desktop/src/remote/`, built switched off):

- **The pieces.** `link.ts` (the relay socket), `keys.ts` with `remote_keys.rs` (the keychain item), `pairing.ts` (one
  pairing at a time), `serve.ts` (the six requests), `project.ts` (what a phone is shown), `journal.ts` (catch-up),
  `host.ts` (all of them together), `fromStore.ts` (the store's chats and actions), `fromShell.ts` (the keychain, the
  page's socket, the health probe), `state.ts` (the switch, the consent and the page's view), and Settings › Sharing and
  access (`src/settings/RemotePage.tsx`). Nothing opens a socket or makes a key until the switch is turned on after the
  consent sheet; the app turns it back on at launch only for a person who did (`resumeRemote`).
- **The keychain item** (account `remote`) is one JSON document: the relay key as its JWK's `d`, `x` and `y`, and per
  phone its id, name, `pairedAt`, `lastSeen`, K (64 hex digits), door token hash, passkey credential id and public key
  (base64url) and counter. The shell checks every field, refuses a second relay key and a passkey that belongs to
  another phone, and never takes a counter back.
- **What the page may hold of it** (third review, 26 Nov 2026). A script injected into the main window can call every
  command the page can, so the shell hands out as little as the page needs:
  - The relay key's private half never reaches the page. The shell makes the key (`remote_host_make`, with Security's
    own generator, on a key never put in any keychain but the item) and signs the relay's challenge itself
    (`remote_host_sign`), and signs nothing but `gospark-relay-v1|host|<this key's host id>|<a 32-byte nonce>`. The
    page's read (`remote_keys_read`) carries only the public half.
  - Each phone's K is in that read only while the shell's own switch is on (`remote_switch`, turned on by the page after
    the consent and off with the switch); the page imports it at once as a key script cannot read back.
  - A phone is added (`remote_keys_add_device`) only while the shell has a pairing open (`remote_pairing`, opened while
    a code is shown, at most five minutes, only while the switch is on), one phone a pairing. A counter moves
    (`_touch_device`) only while the switch is on. Unpair (`_remove_device`) is never held back.
  - Not closed: the shell cannot tell the page from a script in it. A script that turns the shell's switch on and opens
    a pairing first still gets K and can still add a phone, and while it runs it can have the shell sign a relay
    challenge. What it can no longer do is read the relay key, or read K or add a phone with one call while the switch
    is off. Closing the rest needs either a confirmation the shell shows itself (a native window the page cannot
    press) before a phone is added, or the session handshake moved into the shell so K never reaches the page; both
    are the owner's call.
- **Messages inside a pairing channel**, after the grant (the package's 82 bytes): the Mac sends
  `{"t":"passkey","challenge","rp":{"id"},"user"}`; the phone answers `{"t":"registered","name","credentialId",
  "clientDataJSON","authenticatorData"}` (base64url); the Mac answers `{"t":"paired"}` or `{"t":"refused","reason"}`
  and closes the stream. Only then is the phone kept, its own door registered and the pairing door revoked. The phone's
  name arrives only here, so the Mac's field reads "Type the four digits your phone shows." without it.
- **Messages inside a session** are JSON with a number `id` the phone picks: `list`, `open` (`chat`), `catchup`
  (`chat`, `cursor`), `allow` (`chat`, `ask`, `revision`; then again with `option: "once"` and the passkey's `answer`
  to the challenge), `reply` (`chat`, `ask`, `revision`, and `no: true` for No; or `answer`, or `answers` for an
  interview, then again with the same answer and the passkey's answer to the challenge as `passkey`), `stop`
  (`chat`). The Mac answers `chats`, `chat` (a view and a cursor), `events`, `challenge`, `done` or `refused`
  (`request`, `reason`), and pushes `event` for each change of a chat the phone has open. Anything else is refused by
  name: `stays_on_mac` for Always allow, the session, a folder, the dial, pairing, Unpair, the switch and the consent;
  `unknown_request` for the rest. The challenge binds the device, `["<chat>","<ask>"]` as JSON, the revision and the
  choice: `once` for an Allow, and for an answer `answer:` with a digest of the exact words (the package's
  `answerOption`), so the words sent, the words challenged and the words the passkey signed must all be the same.
- **Answers need Face ID too** (third review, 26 Nov 2026). An answer to a question steers the agent as much as an
  Allow does, so it takes the same one-use challenge, for a typed answer and a picked choice alike. Only No to an
  approval and Stop go without one: they can only hold something back.
- **Revisions.** The store's approvals carry none, so the Mac counts them for a phone: 1 when an ask is first shown, one
  more whenever what it shows changes. An Allow, a No or an answer on another revision is refused as `changed`, also
  when the ask changed while the person looked at Face ID. Since the third review (26 Nov 2026) a revision is never
  given twice to one ask while the app runs: it is kept when every phone leaves and across the switch going off and on
  (one `Projector` for the RemoteMac's life), and an ask that leaves the store and comes back with the same id goes on
  counting. The Mac also keeps, per phone, the newest revision of each ask it sent that phone, and acts only on that
  one: a phone answering a chat it never opened, or a Mac started again, is refused as `changed`, and the phone opens
  the chat again.
- **What a phone sees** is masked with `lib/secrets.ts`, the command included (the card masks it too), and shown whole.
  An ask the card marks as needing an app update, or that the person may only pass on to the shop's owner, offers
  nothing; an approval offers at most Allow once and No.
- **The relay's state.** The API's public `/v1/health` now says `relay: "on"` or `"off"`. After a socket that never came
  up, the link asks it through the shell (the page may open sockets to the API origin but send it no plain request):
  off is "not available yet" and a try every 15 minutes, as is a socket closed with 4503 or 4429.
- **At most seven phones**, so the relay's eight devices always leave one for the pairing door.
- **Tested** against a fake relay and a bare socket in the desktop's tests, and through the real relay object in
  `apps/api/test/remote-mac.test.ts`, where a scan of every message either side sent or received finds no chat or ask
  words, no phone name and no key.
- **Not observed: the page's socket while the window is hidden or the Mac is locked.** The desktop's tests drive the
  link with a fake socket and the API's with workerd's; neither is the app's WebKit view, and no window was opened for
  this item. WebKit may slow a hidden page's timers, which would stretch the 50-second ping past the relay's patience
  for an idle socket only if Cloudflare closes idle sockets sooner than a slowed timer fires; that is to be checked in
  phase 2 with the window hidden for an hour and the Mac locked, watching the relay's `lastHostSeen`. If it does not
  hold, `link.ts` moves into the Rust shell as planned.

**What building 78c added** (`apps/web/src/app/mac/`, the phone's side, built so it does nothing while the relay is off):

- **The pieces.** `relay.ts` (the phone's relay socket: `hello`, `ready`, the close codes read as reasons, a `ping`
  every 30 seconds), `vault.ts` (what the phone keeps, `docs/web-app.md` "What Your Mac keeps"), `passkeys.ts` (the
  browser's WebAuthn), `pair.ts` (pairing), `session.ts` (a session and its requests), `decision.ts` (the answers the
  passkey signs, and every field they use), `remote.ts` (the tab's state: `MacRemote`), `live.ts` and `setup.ts` (the
  relay on this page's own origin), `practice.ts` (practice mode's pretend Mac), `scan.ts` (the camera) and
  `MacTab.tsx`. The tab is in the nav whether or not the person signed in, and says "not available yet" while
  `/v1/health` says `relay: "off"`, or when the page is not on the API's own origin (the passkey and the relay are tied
  to that exact host).
- **Pairing.** A code's door is written to the vault as spent before the relay is dialled, so the code is one try on the
  phone across reloads, tabs and Forget; nothing ever starts again on its own. A link for another Manut AI address is
  refused before anything is spent. The digits show, 44 pixels high, only once the Mac's proof checked out; nothing is
  sent on the pairing channel until the grant. The Mac's passkey request must name this page's host and the grant's
  device id. The passkey is made from the person's tap on "Make a passkey" (Safari opens a passkey prompt only from a
  tap), may be pressed again after the prompt was closed while the Mac waits, and the phone is kept only after the Mac's
  `paired`. Every failure says what to do next, which is always to start again on the Mac.
- **A link opened outside the installed app** pairs nothing: the page takes it out of the address at once and offers
  Copy link, to paste inside the app on the Home Screen. Inside the installed app the field is filled and waits for Pair.
- **Scanning** uses the browser's own `BarcodeDetector` (Chrome on Android), and the camera only after Scan is pressed.
  Safari on an iPhone has no reader, so there it is paste only, and no reader of our own is shipped yet
  (docs/decisions.md). On an iPhone the quickest road is Copy link on the Mac and paste, which Universal Clipboard carries
  when both are signed in to the same Apple Account.
- **The six requests.** `list` on connecting, every 20 seconds while the list is shown, and on going back to it; `open`;
  `catchup` after a reconnect and after an event that skips a number; `allow` in its two steps; `reply` for No (never
  signed) and for an answer; `stop`. A challenge is checked against the screen (chat, ask, revision, choice) before any
  prompt, and the passkey signs what the phone computed from its own screen. Allow once tries the prompt at once and,
  when the browser refuses one that did not come from a tap, offers Confirm while the challenge lasts.
- **Answers to questions** go through the same signed path as Allow once (`#decide`), following the security review of
  26 Nov 2026 (item 115): the Mac's challenge is checked against the package's `answerOption` of the exact answer (an
  interview's questions in the order the ask lists them) before any prompt, and step two repeats the request with the
  passkey's answer as `passkey` (`decision.ts`). The phone sends exactly the questions its screen shows. Through the
  real relay, `remote-phone.test.ts` has the Mac take a correct answer and refuse one with no challenge, a replayed
  challenge, and a signature over other words than the ones sent.
- **The greyed view.** When the session drops, what was shown stays greyed with when the Mac last confirmed it, offers
  no answer, and is cleared from memory 15 minutes after that time (checked again when the app comes back into view,
  since a phone that slept ran no timer). The phone dials again after one second, doubling to a minute. A phone the Mac
  revoked, or the relay no longer knows, says "Your Mac doesn't know this phone" and dials once a minute, since the relay
  also forgets a Mac unseen for 30 days and the Mac registers its phones again when it returns.
- **Links in replies** are plain text, never something to tap, and the chat says so.
- **The content policy** is unchanged: `connect-src 'self'` covers a `wss:` socket to the page's own host in CSP Level 3.
- **Tested** in `apps/web/test` (`macPair`, `macSession`, `macRemote`, `MacTab`) against a relay socket whose Mac the test
  plays from the package's Mac side, and a hand-answered Mac; through the real relay object in
  `apps/api/test/remote-phone.test.ts`, where the web app's own code pairs with the desktop's `RemoteMac`, registers its
  passkey (the desktop's stand-in authenticator), does all six requests, drops, catches up, and hears Unpair, and no
  frame holds a chat's or an ask's words, the phone's name, K or the code's secret; in the web app's phone tests
  (`e2e/states.ts`, every Your Mac state on four phones, light and dark, three text sizes); and the IndexedDB vault in each
  real engine (`e2e/mac-vault.spec.ts`).

**What only a real phone shows, and what the owner should try** (with the dev relay on, which is the owner's call):

1. On the iPhone, open `https://dev.manut.xyz/app/` in Safari, Share, Add to Home Screen, and open Manut AI from the Home
   Screen. Go to Your Mac: it should offer the paste field and say the browser cannot scan.
2. On the Mac, Settings, Sharing and access: turn on reaching the Mac from a phone, accept the consent sheet, press Pair a
   phone, then Copy link. Paste on the iPhone (Universal Clipboard) and press Pair.
3. The iPhone shows four digits. Type them on the Mac. The iPhone says "Your Mac took the code": press Make a passkey and
   answer Face ID. The Mac should list "iPhone, Safari", and the iPhone the Mac's chats.
4. Start a chat on the Mac that asks for an approval. On the iPhone open it: the command must read exactly as the Mac's
   card. Press Allow once: Face ID should open at once, or the card should offer Confirm, whose tap opens it. The Mac's
   card should settle as allowed by the phone.
5. Try No, an answer to a question, and Stop on a running turn.
6. Lock the iPhone for a minute and open the app again: the view should catch up. Turn on Airplane Mode: the view greys
   and says when it was last current. Leave it over 15 minutes: it clears.
7. Scan the Mac's code with the iPhone's Camera app: Safari opens and says to pair from the Home Screen app, with Copy
   link. Then try the same code again in the installed app: it should be refused as used if it was started there before.
8. Unpair the phone on the Mac: the iPhone says the Mac no longer knows it. Press Forget this Mac. In Settings,
   Passwords, the passkey for `dev.manut.xyz` is still there until deleted.
9. On an Android phone with Chrome: install from the menu, press Scan, allow the camera, and pair from the QR code.

Only a real phone shows: Face ID and the passcode prompt, and whether Safari opens it straight after the Mac's challenge
or needs Confirm; the camera and Chrome's QR reading; the installed app's own storage partition on iOS (that a pairing
there survives Safari's clearing of website data, and that Safari's own tab keeps nothing for it); Universal Clipboard;
how the relay socket behaves while the phone is locked or the app is in the background; that an iCloud Keychain passkey's
public key comes in the COSE form the Mac requires; and that Safari takes a `wss:` socket under `connect-src 'self'`.

**Lifted from GoSpark:** `docs/relay-protocol-v1.md` and `docs/security/remote-relay-threat-model.md` (this
repository's relay code cites both; copied into `docs/` by 78b, each with a note on where this app differs); `GoGoCode/Remote/RemoteEventJournal.swift`
(the last 500 events or 1 MB a chat, so a phone catches up or gets the whole chat again); `docs/remote.md`'s rules (the
view clears 15 minutes after the Mac last confirmed it, and links in replies never open directly); and
`docs/plans/worker-apns-spike-probe.ts` for the signed token Web Push needs. GoSpark's TLS with a shared key cannot be
lifted, because no browser has it; its own fallback is the design above. Its command ledger can wait: approval-core
already refuses a repeated decision as `already_decided`.

## The second road: Tailscale (decided 25 Nov 2026)

The owner asked for both roads, "the same as Orca": the relay, and Tailscale for a person who has it. A read of Orca
at `stablyai/orca` commit `bc471d51` came first. Orca's Tailscale road is its local-network road pointed at a tailnet
address: one unencrypted `ws://` listener that every pairing offer moves from 127.0.0.1 to every network, with the
tailnet's address listed first, and no Tailscale command ever run. That works for Orca because its phone is a native
app that allows unencrypted traffic. It cannot be copied here: the phone is a page served over HTTPS, and a browser
refuses an unencrypted socket from a secure page. It also breaks two rules of this design, which stay: no port opened
on every network, and no ask answered from a phone without a challenge for that one ask.

So the same channel is carried over Tailscale's own HTTPS name instead.

**On the Mac.** The page cannot listen, so this road is the first listener in the Rust shell, a new `remote_door.rs`:

- It binds to 127.0.0.1 only. Tailscale reaches it through `tailscale serve --bg --https=<port>
  http://127.0.0.1:<port>`, which gives the Mac a real certificate under its `ts.net` name and ends TLS there.
- The port is never 443, 8443 or 10000. Those are the only ports Tailscale's Funnel can make public, and serve and
  Funnel share one setting a port, so on any other port this road cannot become public by a slip.
- It runs only while the main switch and this road's own switch are both on. Turning either off removes the serve
  entry and closes the listener.
- It speaks the phone's side of the relay's protocol (the hello, the token hash and the limits of `relay-object.ts`)
  and hands the frames to the page over a Tauri channel, so `link.ts` gets a second door and the keys stay in the
  page. The desktop's content policy does not change. It needs one new crate, `tokio-tungstenite`, with no TLS.
- Every connection arrives from 127.0.0.1, so its limits count all connections together, never by address.

**On the phone.** The same hosted `/app/` page, never a page the Mac serves: one origin, one installed app, one
pairing and one passkey, checked the same way on both roads. A page the Mac served would be a second origin (a second
Home Screen app, a second passkey) and code the Mac ships. The phone page's policy (`APP_POLICY` in
`apps/api/src/app-policy.ts`) gains `wss://*.ts.net:<port>` and nothing wider.

**Which road.** The QR code carries the Mac's tailnet name beside the relay's door, and the one-use pairing door opens
on either. The Mac sends its current name again inside the encrypted channel at each session. A phone tries the
tailnet first and starts the relay if the tailnet has not answered in 1.5 seconds; the first road to finish the
handshake proved with K wins, and a phone has one session across both roads. With the relay switched off, a phone on
the tailnet still pairs and works, so this road needs no server of ours.

**What Settings says**, from a read-only `tailscale.rs` that only ever runs `tailscale status --json --peers=false`:

- "Tailscale isn't installed."
- "Open Tailscale and sign in."
- "An admin of your tailnet turns on MagicDNS and HTTPS Certificates (the DNS page of Tailscale's admin console). This
  publishes this Mac's name in public certificate logs, for good."
- "Ready: mac.tail1234.ts.net", with a switch that starts off and opens its own consent sheet.

Manut never runs `serve` before HTTPS is on for the tailnet, because `serve` would send the person to a page that
turns it on.

**Built: the read (78f's first part, 26 Nov 2026).** `apps/desktop/src-tauri/src/tailscale.rs`, the command
`tailscale_state`, and `apps/desktop/src/remote/tailscale.ts`, which reads it and holds the four lines above in all four
dictionaries (`tailscale.*`). Nothing shows them yet: the Sharing and access page is 78b's.

- It runs exactly `tailscale status --json --peers=false` (the flag is in the CLI's own help on 1.104.7, so the answer
  holds no other device), with no shell, at most 5 seconds and 1 MiB read. The CLI is looked for in PATH's absolute
  folders, then `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale` and
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. On this Mac the first of those is Tailscale's own two-line
  script that runs the app's binary with the same arguments.
- Ready needs all of: `BackendState` exactly `Running`; `CurrentTailnet.MagicDNSEnabled` true (read by name on
  1.104.7's answer: a name that does not resolve on a phone is no use, whatever its certificate); `MagicDNSSuffix` under
  `ts.net`; `Self.DNSName`, its trailing dot dropped and lowercased, plain DNS labels (letters, digits, hyphens, none
  starting or ending with a hyphen, at most 253 bytes) under that suffix; and that name among `CertDomains`.
- A CLI that is missing is "isn't installed". One that fails, exits non-zero, does not answer in time, answers more than
  the cap or answers what is not read, and any state but `Running`, is "Open Tailscale and sign in". A running answer
  that fails any other check is the HTTPS line. Nothing is ever ready by default.
- Only the state and, when ready, the name leave the shell: the parser reads only the five fields above, so addresses,
  the user, keys and peers never become values. The page checks the name again by the same rule.
- Tested with a stand-in CLI whose call log holds only `status --json --peers=false`; on this Mac, with Tailscale
  stopped, the real read says `signed_out`.

**No shortcut for "the tailnet is already private".** Pairing, K and the decision challenge are the same on this road.
A tailnet holds teammates' devices, shared devices and compromised ones; its access rules change; TLS ends in
Tailscale, not in Manut; and a private network says nothing about Face ID for this one ask. The `Tailscale-User-Login`
header is never read as who someone is.

**Checked, and not.** On this Mac's Tailscale 1.104.7 the CLI's own help has `serve --bg`, `--https <port>`,
`serve status --json` and `serve reset`, and `status --json` has `BackendState`, `Self.DNSName` (ending `.ts.net.`),
`CertDomains` and `MagicDNSSuffix`; the help warns that the JSON changes between releases, so the reader accepts only
what it understands and says "not ready" otherwise. Tailscale's pages say Funnel uses only 443, 8443 and 10000, that
serve needs HTTPS turned on, and that `--bg` survives a restart. Not confirmed, and to be tried on a real tailnet
before the door ships: that serve passes a WebSocket upgrade through, that it takes a port other than 443, that an
installed iPhone web app opens the socket, what Android Chrome asks, and how fast a phone with Tailscale off gives up.

## The safety model

- **An approval from the phone is as trustworthy as one on the Mac.** It goes through the same `settleApproval`, on the
  same revision, with the whole words shown, and needs two things only that phone holds: K, and Face ID or the passcode
  at that moment.
- **Stays on the Mac:** the dial, Always allow, Allow this folder, pairing, Unpair, the switch, and any ask the card
  marks as needing an app update.
- **A lost or stolen phone** can read the chats, say No and Stop. It cannot Allow, or answer an agent's question,
  without Face ID or the passcode.
  Unpair on the Mac sends `revoke`: the relay closes that phone's door and the Mac deletes its K. A copied token opens
  only the relay's door, never the session.
- **What the relay sees:** internet addresses (Cloudflare sees them; the relay object keeps only a digest), times, byte
  counts, the Mac's and phones' random ids, token hashes, and from phase 4 the push address. Never content.
- **Approval of a new device checks:** the QR secret (two minutes, one try on the Mac and one on the phone), and the
  four digits the phone shows, typed at the Mac once within those two minutes.
- **Attacks considered:** the relay reading or standing in the middle at pairing or later; a photographed QR code;
  replayed messages or decisions; a stolen relay token; a stolen phone that is unlocked; a script injected into the
  site (only the site's own scripts run, and keys cannot be read out); the relay used as a free tunnel (limits, a daily
  budget, the off switch); a push address pointing somewhere else (only known push services) and push contents (there
  are none); misleading agent text shown on the phone.
- **On the Tailscale road:** Tailscale's coordination server sees device names, addresses and when they are online,
  and it hands out keys, so it could add a device to the tailnet; the handshake proved with K leaves such a device
  only encrypted bytes. Every device on the tailnet can open the socket and take a waiting place, and gets nothing
  without a token and K. The listener is new code that the tailnet and every program on the Mac can reach.
- **What remains:** whoever deploys the page could ship script that misuses the keys while the page is open, which only
  a native app removes; and a passkey also accepts the phone's passcode and syncs through iCloud, which is weaker than
  GoSpark's key that needs Face ID alone.

## Phases

| Item | What it delivers | Needs the owner |
| --- | --- | --- |
| 78a | `packages/remote-channel`: pairing, the session, the decision challenge, each with its refusals tested (a wrong K, swapped keys, a changed, repeated or reordered message, a challenge used twice or late, a passkey answer with the wrong origin or no Face ID) | Nothing |
| 78b | The Mac side and Settings, Sharing and access: consent, the QR code, the Allow card, the phone list, Unpair; tested against a fake socket, and through the real relay object in the API's tests, where no readable text may cross | Nothing |
| 78c | The phone's Your Mac tab, with catch-up from the journal and the greyed view; two browsers against a local relay | The dev relay turned on, and a real iPhone check |
| 78d | A push with no content ("Your Mac needs you") when an ask opens and no phone is connected | The relay on, and a push key made as a Wrangler secret |
| 78f | The Tailscale road. First the read-only `tailscale.rs` and Settings' four states, tested with a stand-in CLI whose call log shows only `status --json`. Then `remote_door.rs`, the serve entry, the phone's second road and the 1.5 second race | The first part, nothing. The door: a tailnet, an iPhone and an Android phone |

## What the owner decides or provides

- **Sign-in:** none for this version. A phone pairs to the Mac by the code on its screen. Email codes, built and off,
  are for when guest links come.
- **The relay's cost.** Cloudflare's Workers Paid plan is $5 a month at least. From `relay-object.ts`, one Mac with one
  phone makes about 6,500 Durable Object requests a month (the Mac's ping every 50 seconds about 2,600, the hourly
  alarm 720, a phone watching 30 minutes a day about 2,700). Ten of them is about 65,000 a month, inside the plan; a
  thousand is about 6.5 million, roughly $1 above it. Read on 25 Nov 2026 from Cloudflare's Durable Objects and Workers
  pricing pages. Not confirmed: whether a ping the relay answers by itself counts as a request (it was counted), how
  long each message keeps the object billed, real phone use, and that Apple's and Google's push services cost nothing.
  The design's advice: yes, and turn `RELAY_ENABLED` on in dev.
- **The Tailscale road's words:** its consent sheet, the warning that turning on HTTPS publishes the Mac's name, and
  what to say to a person whose tailnet belongs to a team. The person installs Tailscale and signs in themselves; an
  admin of their tailnet turns on MagicDNS and HTTPS Certificates.
- **Domain:** keep manut.xyz, and tie the passkey to the exact host, so a passkey made on dev never approves in
  production.
- **Words:** the consent notice and the privacy policy's lines, naming the business that runs the relay. The relay
  forgets a Mac 30 days after it last saw it.
- **Push key:** one key pair for Web Push, made by us and kept as a Wrangler secret. No outside account.
- **Apple:** nothing for this version. Web Push works on iOS 16.4 and later from the Home Screen.

## What should not be built

- **Network access as a port on the local network.** The other apps have it because one is a web server and the
  other a native phone app. A page loaded over plain HTTP on the local network is not a secure context, so the browser
  blocks the encryption and passkeys this design needs, and it would open a port on shop Wi-Fi that customers share.
  Tailscale is built instead, under its HTTPS name (the second road, above).
- **A hosted connect service with a count of tunnels.** That is the other app's paid tunnel for each machine. This
  relay has no slots to count.
- **Webhooks held while offline.** LINE and Linear already arrive at the Worker (`/v1/inbound/`) and wait there.
- **Live Activities.** Only a native iPhone app can have them.
- **The preview as a public address.** It would make a page with sample secrets public and the relay a free tunnel.
  Later it could open only on a paired phone.
- **Guest links and linked environments:** not now. Guest links can come on the same channel (the guest only watches,
  and their messages arrive on the Mac as asks). Linked environments need a design of their own, because each ask must
  reach whoever answers for the machine doing the work.
