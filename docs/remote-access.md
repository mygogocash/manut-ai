# Reaching your Mac from your phone (item 78)

The design for the features the owner pointed at on 25 Nov 2026 in another app's "Sharing and access" and "Labs"
settings: network access, a tunnel, new devices approved first, permissions, agent activity on a phone, guest links,
linked environments, a preview tunnel, webhooks held while offline. It was written by a read-only design pass over
this repository and GoSpark's remote access, which the relay in `apps/api` was lifted from. Nothing here is built yet
except that relay. The plan's rows are 78a to 78f.

## The first version

A paired phone watches Buddy and Kit's lanes live from anywhere, and answers their asks. Every Allow needs Face ID.

It covers: network access (through the relay, not a port on the local network), approval of new devices (always on),
permissions (one fixed set for every phone), and notifications with no content in them (the last phase).

What a person does:

1. On the Mac, Settings, Sharing and access, "Reach this Mac from your phone". A consent sheet comes first: what is
   encrypted, what the relay sees, how to stop (the words of GoSpark's `GoGoCode/Remote/RemoteRelayConsent.swift`). The
   switch stays off until the person accepts.
2. "Pair a phone" shows a QR code for two minutes.
3. On the phone, in the installed web app (`/app/`), Your Mac, Scan, or paste the link copied on the Mac. On an iPhone
   a link opened in Safari lands outside the installed app's storage, so it pairs nothing.
4. Both screens show the same four-digit check code. The Mac asks: "Allow 'iPhone, Safari' to watch your chats and
   answer their asks?" The person presses Allow on the Mac, and the phone makes a passkey (Face ID).
5. The phone lists the chats as Working, Needs you or Done. Opening one shows its messages, its current step and its
   asks, with the whole command as the card shows it. The person can Allow once (Face ID), say No, answer a question,
   or stop the turn.

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
  `read_item` and `write_item`, and imported by the page so script cannot read them back, as `shop-cache-key` is.
- No listener and no open port.

If the page's socket is held back while the window is hidden or the Mac is locked (to be checked in phase 2),
`link.ts` moves into the Rust shell with a WebSocket library.

**On the phone:** a Your Mac tab inside the existing `/app/` (new `apps/web/src/app/mac/`), usable without signing in.
Its service worker already never answers `/relay/`. Keys are kept in IndexedDB in a form script cannot read back, which
breaks `docs/web-app.md`'s "nothing kept" rule on purpose and must be written down there. Scanning needs a QR reader,
which the repository does not have.

**A new package `packages/remote-channel`, used by both sides:**

- **Pairing.** The QR code holds the Mac's host id, a one-use door to the relay and a 256-bit secret. Over the relay,
  both sides exchange throwaway keys and prove they know the secret (GoSpark's `Shared/Remote/RemoteHandshake.swift`,
  `proof`). The relay can neither read the exchange nor stand in the middle. After Allow, the Mac sends the phone its
  own id, door token and key K, then closes the pairing door.
- **Each connection.** A fresh key exchange proved with K, so each session gets new keys. Every message is encrypted
  and numbered, and split to fit the relay's 65,532-byte limit.
- **Each decision.** The Mac issues a challenge that can be used once, lasts 60 seconds, and is bound to the device,
  the request, its revision and the choice (a port of GoSpark's `RemoteDecisionChallenges.swift`). The phone answers
  with a passkey signature that requires Face ID or the passcode. The Mac checks the origin, the domain, that Face ID
  or the passcode was used, and the signature. Only then does it call `settleApproval`, so approval-core settles it
  once, with the phone's device id as who decided.

**Lifted from GoSpark:** `docs/relay-protocol-v1.md` and `docs/security/remote-relay-threat-model.md` (this
repository's relay code cites both, and neither is in `docs/` here yet); `GoGoCode/Remote/RemoteEventJournal.swift`
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

**What Settings says**, from a read-only `tailscale.rs` that only ever runs `tailscale status --json`:

- "Tailscale isn't installed."
- "Open Tailscale and sign in."
- "An admin of your tailnet turns on MagicDNS and HTTPS Certificates (the DNS page of Tailscale's admin console). This
  publishes this Mac's name in public certificate logs, for good."
- "Ready: mac.tail1234.ts.net", with a switch that starts off and opens its own consent sheet.

Manut never runs `serve` before HTTPS is on for the tailnet, because `serve` would send the person to a page that
turns it on.

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
- **A lost or stolen phone** can read the chats, say No and Stop. It cannot Allow without Face ID or the passcode.
  Unpair on the Mac sends `revoke`: the relay closes that phone's door and the Mac deletes its K. A copied token opens
  only the relay's door, never the session.
- **What the relay sees:** internet addresses (Cloudflare sees them; the relay object keeps only a digest), times, byte
  counts, the Mac's and phones' random ids, token hashes, and from phase 4 the push address. Never content.
- **Approval of a new device checks:** the QR secret (two minutes, one try), the matching check code, and Allow pressed
  at the Mac.
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
