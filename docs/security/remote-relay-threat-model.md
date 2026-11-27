# Threat model: the Remote relay, push and remote CLI updates

> **In Manut AI.** Copied from GoSpark (`mygogocash/gospark` at `a7537c80`,
> `docs/security/remote-relay-threat-model.md`), because this repository's relay (`apps/api/src/relay.ts`,
> `relay-object.ts`) was lifted from it and cites its rows. The relay door's rows (RT-1 to RT-4, RT-8, RT-9) and section
> 6, what the relay sees, hold here as written, with `cloud/` read as `apps/api/`. Where this app differs (item 78,
> `docs/remote-access.md`, "The safety model", which is this app's own threat list):
>
> - **The end-to-end session (section 5.2).** Not TLS-PSK: `@manut/remote-channel`'s handshake proved with K, with
>   forward secrecy, and its records. Pairing crosses the relay through a one-use door, so the relay is kept out of the
>   pairing by the code's secret and the typed four-digit check code with the phone's hash commitment
>   (`packages/remote-channel/README.md`), not by pairing in person.
> - **Decisions.** A passkey that needs Face ID or the phone's passcode answers a one-use challenge bound to the device,
>   the ask, its revision and Allow once (`apps/desktop/src/remote/serve.ts`), where GoSpark's phone signed with a Secure
>   Enclave key.
> - **Push (section 5.4).** Built as item 78d with Web Push instead of APNs (`apps/api/src/web-push.ts`;
>   `docs/remote-access.md`, "What building 78d added"). RT-11: a push carries no payload at all, not even a kind's fixed
>   text; the phone's service worker shows the same words, "Your Mac needs you", for every push. RT-12: the Mac pushes
>   at most once an ask and never twice within two minutes, only when no paired phone has a session open; the relay
>   takes at most 30 `push` messages a clock hour from one Mac, only to devices that Mac registered, and only to an
>   address on Apple's, Google's or Mozilla's push service; a 404 or 410 forgets the address; revoke deletes it; a tap
>   opens only the Your Mac tab. RT-13: the key is ours (a VAPID pair, both halves Wrangler secrets), and the signed
>   token is kept only in the isolate's memory, reused for up to 11 hours. Section 6 gains one row: each device's push
>   address, in `devices`, from the Mac's `webpush` until the Mac takes it away, the push service says it is gone, the
>   device is revoked, or deletion; and `pushes`, the hour's count.
> - **Commands and CLI updates (5.5), the A9 opt-in (7).** Not in this app. The Swift tests, plan tasks and gates named
>   below are GoSpark's.

**Date:** 9 Nov 2026 · **Revision:** v1.1 · **Task:** A0.1 (M0) in [`phase1-track-a-remote-2026-11-09.md`](../plans/phase1-track-a-remote-2026-11-09.md)
**Status:** Draft for the owner's security sign-off (gate G6). Nothing it describes is built yet unless a line says **Existing**, and none of it has been audited.

---

## 1. Scope and how to read this

Phase 1 lets an enrolled iPhone reach its Mac away from home through a per-Mac Cloudflare
Durable Object relay (founder decision D02, 2026-11-08). The relay is designed to forward the
existing end-to-end TLS-PSK session without being able to read it. Phase 1 also adds
content-free push through APNs, and typed commands that update a provider's CLI from the phone.
This document models the threats those three additions bring. The LAN and VPN path is unchanged
and keeps its own tests (`docs/remote.md`, **Verification and distribution**).

The design under review is Track A, tasks A4a to A9
(`docs/plans/phase1-track-a-remote-2026-11-09.md`), with C4 and C6 from
`docs/plans/phase1-track-c-freshness-2026-11-09.md` and D1 from
`docs/plans/phase1-track-d-interaction-2026-11-09.md`. The requirements are PRD §10 and §11
(`docs/plans/phase1-prd-2026-11-08.md`).

How to read the threat tables in section 5:

- Every mitigation names the task that will build it, such as (A4b). **Existing** marks
  behaviour on `main` today, with the file that holds it.
- The last column names the planned test that proves the row, as a quoted vitest name or a Swift
  `Suite.test`, or a manual line for `docs/phase1-verification.md`, which D5 creates. **Gap**
  marks a mitigation that no planned test proves yet. Section 10 collects them.
- A4 to A9, C4, C6 and D1 cite these `RT-` ids in their PR descriptions. Section 12 says which.

What must stay true whatever else changes (Track A's Global Constraints):

- The relay sees bytes, never task or control plaintext (GS-42-AC04).
- The relay authenticates doors (the Mac's host key, a phone's device token), never commands
  (GS-41-AC04).
- Pairing never crosses the relay. It stays in person, through the code on the Mac's screen.
- Remote is off by default, and **Away from home** is a second switch, off by default, that
  needs the relay consent (D1) and a relay URL built into the app.
- Remote actions are typed commands. Sensitive ones need a Mac-issued challenge signed by the
  phone's biometric key.
- No user accounts (D02, D05 and D08).

## 2. Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| Task content: prompts, replies, plans, approvals, questions, diffs, attachments | The Mac's library; the phone's memory while shown, at most 15 minutes after the Mac last confirmed it (**Existing**, A3) | It is the owner's work, and often holds source code or a secret an agent printed. |
| Authority to act on the Mac | `RemoteHost`, which decides which commands need a signature (**Existing**, `RemoteCommand.requiredAuth`) | Whoever can command the Mac can make agents change files and run tools there. |
| Device PSK, one 256-bit key per paired phone | The Mac's login keychain; the phone's Keychain, this device only (**Existing**) | It is enrollment. It opens the TLS-PSK session, and with it every unsigned command. |
| The phone's signing key | The phone's Secure Enclave, released only by Face ID or Touch ID (**Existing**) | It is the step-up authority for every sensitive command. |
| Relay host key, one P-256 key per Mac | The Mac's login keychain (A5b) | It opens the Mac's side of the relay door, and its hash names the Mac's relay object. |
| Relay device token, 32 random bytes per phone | The Mac's login keychain beside the PSK (A5a); the phone's Keychain inside its relay grant (A6); the relay keeps only its SHA-256 (A4b) | It opens a phone's side of the relay door. |
| APNs auth key and the provider token minted from it | Wrangler secrets; `ApnsTokenObject` storage (A7) | Whoever holds them can send notifications to GoSpark Remote. |
| APNs device tokens | The relay object (A7) | They address a person's phone. |
| Relay metadata: addresses, times, byte counts, ids, presence | Cloudflare: the Worker, the relay object, Workers Logs | It shows who uses GoSpark Remote, from where and when. |
| The relay service and GoGoCash's Cloudflare spend | Cloudflare | With no accounts, anyone can try to use it. |
| Honest Mac status on the phone | The phone's status line (A6, A8) | A false "paused" or "stopped" makes a person act on a wrong picture (GS-12-AC03). |
| The CLIs GoSpark launches | The owner's installs, updated through C4 and C6 | A bad update path would run code the owner did not choose. |
| Provider credentials | The Mac's Keychain and login environment (**Existing**) | They must never reach the relay or the phone (GS-21-AC02). |
| The locked Mac's privacy (D04) | macOS lock screen; `RemoteAccessCoordinator` (**Existing**) | Lock and Presentation mode disconnect phones unless the owner opts in (A9). |

## 3. Actors

| Actor | Who | Can | Cannot, by design |
| --- | --- | --- | --- |
| Relay operator | GoGoCash running the Worker; Cloudflare as the platform; anyone who takes over the Cloudflare account or deploys changed Worker code | See and keep everything in section 6; read each raw device token as a phone says hello; drop, delay, reorder or replay bytes; forge relay messages such as presence and close codes; record ciphertext; use the APNs key | Read or change the TLS-PSK session; authorize a command; produce a Face ID signature; pair a phone |
| Network attacker | Anyone on the phone's network (cellular, hotel Wi-Fi, a captive portal), on the Mac's network, or on the path to Cloudflare | See addresses, timing, sizes and the relay's domain; block or redirect traffic; show a captive portal; on the owner's LAN, reach the LAN listener as today | Read outer TLS without a root the device trusts; read or change the inner session |
| Holder of a stolen device token | Someone with one phone's relay token but not its PSK, taken from a backup, a log, a captured hello or a phone's Keychain | Open that phone's relay socket, and so push the real phone off the relay | Finish the TLS-PSK handshake, read anything, or send a command |
| Stolen unlocked phone | Someone holding the owner's iPhone unlocked, or knowing its passcode | Do everything in GoSpark Remote that needs no Face ID, now from anywhere the relay reaches | Sign a sensitive command (enrolling their own face invalidates the signing key); pair another phone |
| Local Mac user | A person at the Mac's keyboard, another macOS account on the same Mac, or a process running as the owner (an agent in Full access included) | Connect to anything on 127.0.0.1. A process running as the owner can read the owner's keychain items, as it can today | Without the account password: unlock the Mac, open GoSpark, pair or unpair. Without a device PSK: pass the relay listener's handshake |
| Malicious provider output | Text that an agent, a tool, a web page or a repository file writes into a task, which then reaches the phone | Say anything, imitate a control, carry links, and cause attention pushes by ending turns or raising decisions | Draw an approve button, pair, send a command, change a push's text, or start a CLI update |
| Anonymous abuser | Anyone on the internet who implements relay protocol v1 (A4a publishes it in `docs/relay-protocol-v1.md`), with no paired Mac | Mint any number of host keys, register tokens of their own, move traffic within the limits, and flood the routes | Join another Mac's object (RT-3), or read anyone's session |

## 4. Trust boundaries

Arrows show who dials. Data flows both ways on every connection.

```text
+------------------------------------------------------------------------+
| iPhone: GoSpark Remote                                                 |
|   Keychain, this device only: device PSK, relay grant with its token   |
|   Secure Enclave: signing key, released only by Face ID or Touch ID    |
|   Stack: TLS-PSK client, relay framer, outer TLS (system trust), TCP   |
+-----------------------------------+------------------------------------+
                                    |
                                    |  B1: cellular, another Wi-Fi,
                                    |      a captive portal
                                    v
+------------------------------------------------------------------------+
| Cloudflare, operated by GoGoCash                                       |
|   Worker, /relay/v1/hosts/<hostID>/phone and /socket:                  |
|     kill switch RELAY_ENABLED, upgrade gates per IPv4 address or /64   |
|   RelayObject "relay:<hostID>": door checks (host key, token hash),    |
|     caps, byte budget, presence, idle deletion; forwards opaque        |
|     binary frames                                                      |
|   ApnsTokenObject: provider token from the .p8 Wrangler secret --------+-B3-> APNs -> iPhone
+------------------------------------------------------------------------+
                                    ^
                                    |  B2: the Mac's network; the Mac
                                    |      dials out, no inbound port
                                    |
+-----------------------------------+------------------------------------+
| Mac: GoSpark, running as the owner's macOS account (B6)                |
|   RemoteRelayLink: one outbound WebSocket; signs the host challenge    |
|   RemoteRelayBridge: one loopback TCP connection per phone stream      |
|   . . . . . . . . . . . . B4: loopback, 127.0.0.1 . . . . . . . . . .  |
|   Relay listener: TLS-PSK, device keys only, no "pair" identity        |
|   RemoteHost: hello proof, ledger, challenges, typed commands          |
|   Login keychain: device PSKs, relay tokens, relay host key            |
+------------------------------------------------------------------------+
  B7: a person at the Mac's keyboard, in front of its lock screen

B5: one TLS-PSK session runs from the phone's TLS-PSK client to the relay
listener and RemoteHost. B1, Cloudflare, B2 and the bridge carry its
ciphertext and can neither read nor change it.
```

- **B1, the phone's network.** Cellular, another Wi-Fi or a captive portal. Outer TLS with
  system trust keeps the relay framing from it, and the inner session keeps everything else.
- **B2, the Mac's network.** The Mac only dials out to the relay, so no inbound port opens for
  it (GS-41-AC03). The LAN listener is unchanged.
- **B3, Cloudflare to Apple to the phone.** A push carries a kind and fixed text, nothing else.
- **B4, loopback on the Mac.** Any local process can connect to 127.0.0.1. None gets past the
  handshake without a device PSK.
- **B5, the end-to-end session.** The only boundary that protects content and commands. Its ends
  are the phone's TLS-PSK client and `RemoteHost` behind the relay listener. The networks, the
  Worker, the object and the bridge all sit outside it.
- **B6, the owner's macOS account.** GoSpark, its keychain items and every agent it runs share
  it. It is the boundary for everything on the Mac, as it is today.
- **B7, the person at the Mac.** The lock screen. A9 changes what a paired phone can reach while
  the Mac is locked, never what a person at the locked Mac can reach (section 7).

## 5. Threats

### 5.1 The relay door

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-1 | **The relay as a free tunnel.** An anonymous abuser mints a host key (a host id needs no account), registers tokens of their own and moves their own traffic through GoGoCash's relay, or floods it with upgrades, objects and log events. | The kill switch: every relay route answers `503 {"error":"relay_disabled"}` unless `RELAY_ENABLED` is exactly `"1"`, and it stays unset in staging and production until G3 (A4b); it is on in dev since 27 Nov 2026, the owner's choice for item 78d. Upgrade gates of 10 host sockets and 60 phone sockets per 60 s for each source group, which is an IPv4 address or an IPv6 /64 prefix, never a whole IPv6 address, so rotating addresses inside one /64 gains nothing; a denied upgrade gets 429 (A4b). Today's `ingressRateGate` keys on the whole `CF-Connecting-IP` (**Existing**, `apps/api/src/index.ts:66`), so the relay limiters must not inherit that key. Per object: 4 unauthenticated sockets per source group and 16 in all, 10 s to authenticate, 8 registered devices and 8 phone sockets (A4b, A4c). Messages of at most 65,536 bytes (close 4413) and 1 GiB per host per UTC day (close 4429) (A4c). Storage is deleted only once no host socket is open and the host was last seen, at its hello or when its socket closed, over 30 days ago. While a host socket is open the alarm refreshes `lastHostSeen`, because keying on the hello alone would delete the device list of a Mac that stays connected for longer than that (A4c). The alarm also prunes byte counts older than two days (A4c). The values are provisional until G9 (D12). | Host ids cost nothing, so the caps and the budget bound one object, not the service: one source group can start 10 new hosts a minute, each with its own budget. Only the kill switch bounds the service as a whole, and it stops every Mac at once; there is no per-host block. Cloudflare's limits are per location and eventually consistent, with no global quota or spend cap (`docs/cloud-ingress-boundaries.md`), and a carrier NAT can throttle real phones that share one address. | A4b "refuses relay routes unless RELAY_ENABLED is 1", "the relay limiters key IPv6 by its /64 prefix", "a denied upgrade gets 429", "a fifth unauthenticated socket from one source group is refused; an object holds at most sixteen", "closes an unauthenticated socket after the timeout", "caps registered devices at 8 with error device_limit". A4c "a message over 65,536 bytes is refused with 4413", "a ninth phone socket is refused", "over the daily budget closes streams with 4429 and refuses new ones until the next UTC day", "a host connected longer than the retention window keeps its storage", "the alarm prunes usage records older than two days", and its storage deletion test, against the rule above (section 10). |
| RT-2 | **Denial of service against one Mac's relay.** Someone who learns a host id holds that object's unauthenticated slots, the holder of a stolen token keeps replacing the real phone's socket, or a flood of streams fills the Mac's relay admission. | Host ids are not published: they travel in the grant inside the TLS-PSK welcome and in URL paths inside outer TLS. One source group may hold 4 unauthenticated sockets and an object 16, and each closes after 10 s (A4b). A device has one socket, and a second replaces the first with 4409 (A4c). The Mac holds at most 4 relay peers before authentication and 8 in all, and runs relayed connections through `RemoteTLSConnection`, whose watchdog closes one that has not proved itself within 2.5 s (A5a; the watchdog is **Existing**). The Mac's link refuses a ninth stream (A5b). Unpair revokes a stolen token (RT-4). At home, the LAN path still works. | One source group can hold only 4 of an object's 16 unauthenticated slots, but whoever learns a host id and controls four source groups can still hold them all and keep that Mac's phones off the relay. No host id rotation is designed (RT-23). The holder of a token can make the real phone's relay connection flap until Unpair, and can spend the day's byte budget, which turns every phone away until the next UTC day; bytes from sockets that never authenticate do not count (A4c). The relay operator can always refuse service. | A4b "a fifth unauthenticated socket from one source group is refused; an object holds at most sixteen", "closes an unauthenticated socket after the timeout". A4c "a device's second socket replaces its first with 4409", "revoke closes that device's socket with 4403 and refuses its token". A5a "a fifth relay pre-auth connection is refused", "a ninth relay peer is refused". A5b "a ninth stream is refused". |
| RT-3 | **Claiming another Mac's object, or copying a Mac's host key.** An abuser or a rogue host connects to another Mac's `/relay/v1/hosts/<hostID>/socket` to receive its phones, or someone copies the Mac's relay host key. | Host ids are self-certifying. The id is base64url(SHA-256) of the Mac's P-256 public key, 43 characters, checked against `^[A-Za-z0-9_-]{43}$`, and the object is `idFromName("relay:" + hostID)`. The Mac must sign a fresh nonce on every connection, and the relay checks both that the key hashes to the id and that the signature verifies (A4a, A4b, and the note below). The private key stays in the Mac's keychain under the account `relayHostKey`, written through `RemoteKeychain` with the same accessibility as the device secrets (A5b, section 7). A fake host still cannot finish TLS-PSK with any phone (RT-6). | Whoever holds the private key holds the door, not the house. They can replace the Mac's socket (4409), learn the relay's device ids (a host is sent ids, never token hashes), register or revoke relay devices, send content-free pushes and post false presence, but every phone still needs the Mac's PSK. A replaced Mac waits for a settings change instead of reconnecting (A5b), so one takeover keeps it off the relay until the owner acts. No key rotation is designed (RT-23). | A4a `RemoteRelayWireTests.hostID`, `.signature`. A4b "refuses a hello whose key does not hash to the host id (4401)" (GS-41-AC04), "refuses a bad signature (4401)", "a second authenticated host replaces the first with 4409". A5b `RemoteRelayLinkTests.signsChallenge`, `.noRetryOnAuthFailure`. |
| RT-4 | **Device token theft.** Someone obtains one phone's relay token, from a phone's Keychain, a backup, a log or a relay that keeps hellos, and uses it. | The Mac mints the token at pairing, or lazily for a phone paired earlier, and hands it over only in the TLS-PSK welcome (A5a, A5b). The Mac sends the relay only the token's SHA-256, and the relay stores only that hash (A4a, A4b, A5b). The token opens the relay door only: the stream ends at the Mac's loopback listener, which still needs that phone's PSK and the hello proof inside the session (A5a, reusing the **Existing** hello check), and sensitive commands still need the Face ID signature. The token travels in the first WebSocket message, never in a URL or a header (A4a, A6). Unpair deletes the PSK and revokes the token: the relay closes the socket with 4403 and refuses the token, and a link that was down revokes unknown devices at its next `ready` (A4c, A5b). Turning Away from home off revokes every device (A5b). A relayed peer never records 127.0.0.1 as its address, and a switch between LAN and relay raises no new-address notice (A5a). Over the relay, the clone signal is the object's one-socket-per-device rule: two copies of one device keep replacing each other with 4409 (A4c). Nothing logs a raw token (A4c). | The token never expires and is never rotated, so it works at the door until Unpair. The relay operator sees each raw token at hello. A holder can make the real phone's relay connection flap (RT-2). Someone with both the token and the PSK has everything the phone has except its signing key (RT-17). The Mac's "connected from a new address" notice (**Existing**, `RemoteAccessCoordinator.swift:38`) has no address to compare for a relayed peer, so over the relay a clone shows only while both copies are online, as connections that keep replacing each other, and not at all while the real phone is offline. | A4a `RemoteRelayWireTests.tokenHash`. A4c "a wrong token is refused with 4401 and the host hears nothing" (GS-41-AC04), "revoke closes that device's socket with 4403 and refuses its token" (GS-02-AC04). A5a `RemoteRelayHostTests.relayHello`, `.lazyToken`, `.unpairDrops`. A5a "a relay peer never records loopback as its address", "switching between LAN and relay raises no new-address notice". A4c "a device's second socket replaces its first with 4409". A5b `RemoteRelayLinkTests.syncsDevices`. A5b `awayOffRevokesEveryDevice`. Existing `RemoteTransportTests` "a different PSK cannot exchange application messages". |
| RT-5 | **Pairing through the relay.** Someone pairs a phone without being at the Mac, turning a leaked code or a relay compromise into enrollment. | The relay listener holds device identities only, never `"pair"`, and `RemoteHost.authenticate` refuses `.pair` from a `.relay` peer and stages nothing (A5a). A pairing link may carry only private addresses, and pairing still needs the Pair sheet open on an unlocked Mac, within two minutes, and the person there to choose Allow (**Existing**). No link can pair a phone (**Existing**). | Today's in-person risk remains: someone on the owner's network who sees the code within its two minutes can ask to pair, and the person at the Mac still has to allow it. | A5a `RemoteRelayHostTests.noPairIdentity` (GS-02-AC02), `.pairRefused`. A6 `RemoteRelayEndToEndTests.noPairing` (GS-02-AC02). Existing `RemoteAuthenticationTests` "pairing links require private literal addresses and an exact 256-bit key", `RemoteLaunchLinkTests` "a pairing link never parses, so opening a URL cannot pair a phone", `RemoteTransportTests` "nothing is persisted before confirmation; the ask names model and name". |

**The host challenge (RT-3).** The relay sends a fresh nonce on each host connection. The Mac
signs the UTF-8 string `gospark-relay-v1|host|<hostID>|<nonce>` with ECDSA P-256 over SHA-256,
and the relay verifies it with WebCrypto against the key whose hash is the host id (A4a, A4b).
Because the string names the host id and the nonce, a signature is good for one Mac and one
connection, and a recorded hello is useless on the next socket (RT-8).

### 5.2 The end-to-end session

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-6 | **The relay reads or rewrites the session.** The relay operator, changed Worker code or a network attacker reads prompts, replies, approvals or attachments, or injects or alters commands. | One TLS-PSK session runs end to end, from the phone's TLS-PSK client to the Mac's loopback relay listener. The relay forwards opaque binary frames and only adds or strips a 4-byte stream number (A4c, A5a, A6). TLS encrypts and authenticates every record, so a changed, dropped, repeated or reordered byte ends the connection instead of reaching `RemoteHost`. The Mac redacts paths, its own credentials, terminal escapes and bidi controls before anything leaves it (**Existing**, `RemoteRedaction.swift`). | The suite, `TLS_PSK_WITH_AES_128_GCM_SHA256`, has no ephemeral key exchange, so there is no forward secrecy: whoever records relayed ciphertext and later obtains that phone's PSK can decrypt the recording, and the relay is a natural place to record. Message sizes and timing stay visible (section 6). All of this assumes A0.2 returns verdict M1. | A0.2 pass criteria (the inner handshake completes; 1 MiB echoes both ways byte-equal). A4c "phone binary reaches the host with its stream prefix; host frames reach the phone without it". A6 `RemoteRelayEndToEndTests.opaque` (GS-42-AC04, GS-21-AC02), `.reaches` (GS-41-AC02, GS-42-AC01). A6b `RelayLiveTests`. |
| RT-7 | **Downgrade.** The relay or a network attacker strips TLS-PSK, negotiates something weaker, swaps the outer transport for plain text, or points the phone at another host. | Both ends pin TLS 1.2 as minimum and maximum and offer one suite, `TLS_PSK_WITH_AES_128_GCM_SHA256` (**Existing**, `RemoteTLSConnection.swift:9-11`). The TLS Finished messages check the whole handshake under the PSK, so a changed negotiation fails. On the phone, TLS-PSK sits above the relay framer, so no app byte leaves without it, and the connection reports ready only after the inner handshake (A0.2, A6). The Mac's relay listener speaks only TLS-PSK, and there is no plain listener (A5a). The phone dials only private addresses or the configured relay host over `wss`, and keeps a grant only if its URL passes the same check (`RemoteRelayEndpoint.allows`, A5b, A6); only a Debug build also allows `ws://` to a local address. The egress scan keeps one connection site in the phone app (A6). | The outer TLS ends at Cloudflare. A network the phone trusts to inspect TLS, such as a managed phone with an installed root, sees the relay framing and so the device token (RT-4), but not the inner session. If A0.2 returns M2, the inner layer is no longer TLS, and this row, RT-6 and RT-8 must be rewritten and signed off before A5 and A6 (section 11). | A0.2 criterion "the phone connection reports `.ready` only after the inner handshake". A5a `RemoteRelayHostTests.noPairIdentity`. A5b `RemoteRelayEndpointTests` "allows only wss to the configured host", "Debug allows ws only to private addresses". A6 `RemoteEgressTests` (widened rule), `RemoteRelayEndToEndTests.opaque`. Existing `RemoteTransportTests` "a different PSK cannot exchange application messages". |
| RT-8 | **Replay and duplicates.** Recorded hellos, TLS records or signed commands are played again, or a switch between Wi-Fi and cellular makes the phone send a command twice. | The relay's host challenge is a fresh nonce on every connection, so a recorded host hello fails on a new socket (A4b). Inside the session, TLS derives fresh keys for each connection and numbers its records, and the Mac's hello challenge is a fresh nonce answered with an HMAC under the PSK (**Existing**, `RemoteHost.swift:712`). A signed command answers a 60 s single-use challenge bound to the device, the command id and the whole command, consumed even when the signature is wrong (**Existing**, `RemoteDecisionChallenges.swift`). The A2 ledger keeps each changing command's id, digest and outcome for a week, 200 per phone, across restarts, so a retried command is answered and not run again, over the relay too (**Existing**, A5a, J3). No relay message carries a timestamp that authentication depends on, so clock skew cannot break it. | A phone hello carries a bearer token, so replaying one equals holding the token (RT-4), and it still needs the PSK. Only a new task reuses its command id when sent again; a message sent again from a task screen after a lost answer is a second message (`docs/remote.md`). | A4b "a hello replayed on a new connection is refused" (GS-42-AC02). A5a `RemoteRelayHostTests.retriedCommandOverRelayReplaysLedger` (GS-06-AC01, GS-42-AC02, GS-43-AC02). J3. Existing `RemoteLedgerTests` "a command run before the Mac restarted is answered after it, and not run again", `RemoteHostDispatchTests` "a replayed nonce is refused, so one signature starts one task", `RemoteAuthenticationTests` "a verified signature is consumed once and bound to the device and command". |
| RT-9 | **The relay as an authorization oracle.** The relay's door checks, or anything the relay says, are treated as permission to act. | The relay never sees a command, so it cannot judge one (GS-41-AC04). The Mac authenticates every relayed peer itself, through the same TLS-PSK handshake and hello as a LAN peer, so a peer's identity comes from its hello and never from the relay's `open` message (A5a). The Mac decides `requiredAuth` from the command it decoded and checks each signature against the phone's stored public key (**Existing**). Relay messages such as presence and close codes only change what the phone shows (RT-20). | For admission alone the Mac leans on the relay: every relayed peer arrives from 127.0.0.1, so `acceptRelay` skips `RemoteAdmission`'s per-source failure groups and relies on its relay caps instead (A5a). A flood through the relay costs the Mac slots, never authority. | A4c "a wrong token is refused with 4401 and the host hears nothing". A5a `RemoteRelayHostTests.relayHello`. C6 `RemoteFreshnessTests.needsChallenge` (GS-42-AC03). Existing `RemoteHostDispatchTests` "a replayed nonce is refused, so one signature starts one task". **Gap:** a relayed peer's identity comes from its hello, not from `open` (A5b). |

### 5.3 Metadata

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-10 | **Metadata exposure.** The relay, Cloudflare's logs or a storage leak show who uses GoSpark Remote, from where, when and how much, or relay traffic starts before the person agreed to it or goes on after they turn Away from home off. | On the Mac, the relay link opens no socket until Remote is on, Away from home is on, D1's current consent is given and the build carries a relay URL (A5b, D1). Turning Away from home off makes the link revoke every device, then send `off`, then close (A5b). On the phone, the stored grant is dropped when a LAN welcome carries none or the relay refuses the phone with 4401 (unauthenticated) or 4403 (revoked), and after such a refusal, or after the relay reports the Mac off, the phone stops dialing the relay until its next LAN welcome (A6). The object stores only what section 6 lists, deletes it on the rule given there, and prunes byte counts older than two days (A4b, A4c). The relay logs nothing about keys, tokens or frames (A4b, A4c), and the Worker's observability is metadata only, never bodies (**Existing**, `apps/api/wrangler.jsonc`). A push names only a kind (RT-11). R2 publishes section 6 and its retention before any production traffic (G4). | Addresses, times, sizes, ids and presence are visible by design. Sizes and timing show when a person is working, presence changes show when the Mac locks or sleeps, and a phone's address gives a rough location. A phone that was not on the relay when Away from home was turned off makes one more relay dial, which shows the relay its address once; the relay refuses it, because its token is gone, and the phone drops its grant (A6). The same rule means a fault in the relay's own authentication costs a phone the relay until its next LAN welcome (section 11). After Away from home is off, the object keeps the Mac's public key, last presence, last-seen time and two days of byte counts until deletion. Workers Logs keeps what Cloudflare records for 3 or 7 days (section 6), which G9 decides. | A5b `RemoteRelayLinkTests.needsConsent` (GS-21-AC01). A5b `awayOffRevokesEveryDevice`. A6 `grantDroppedWhenWelcomeHasNone`, `grantDroppedOnRevoked`, `grantDroppedOnUnauthenticated`, `relayDialsStopAfterOff`. D1 `RemoteRelayConsentTests.gated` (GS-21-AC01), `.declineSendsNothing`, `.noticeWording` (GS-21-AC02). A4c "logs nothing containing keys, tokens or frame bytes" (GS-42-AC06, GS-21-AC05), "a host connected longer than the retention window keeps its storage", "the alarm prunes usage records older than two days", and its storage deletion test (section 10). R2 `PrivacyPolicyMirrorTests`, `PrivacyClaimsTests`. Manual (D5, before G4): a deployed environment's Workers Logs hold no bodies, tokens or keys. |

### 5.4 Push

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-11 | **Content in a push.** A notification shows task content to Apple, to Cloudflare, or to anyone who can see the phone's Lock Screen. | The Mac sends only a kind: decision, finished or failed. The relay sends a fixed body ("Your Mac needs a decision.", "A task on your Mac finished.", "A task on your Mac ran into a problem."), collapses notifications by kind, and sends no thread id (A7). Push stays off until the person turns on **Tell me when my Mac needs me**, and nothing sends unless `REMOTE_PUSH` is `"1"`, which stays unset in every deployed environment until G1 to G4 (A7). | Apple and Cloudflare learn that a phone has GoSpark Remote, that its Mac had a decision, a finished task or a failure, and when. Anyone holding the phone sees the fixed text. | A7 "the payload carries only the fixed text and kind" (GS-16-AC02, GS-21-AC05), "sends nothing unless REMOTE_PUSH is 1". |
| RT-12 | **Push abuse.** A flood of pushes (a looping agent, malicious output, a host-key holder), pushes to a phone that was unpaired, or a forged notification meant to make a person act. | The Mac sends at most one push per thread and kind per 120 s (A7). The relay sends at most 10 a minute per host, only to devices that have a push token and no open socket, and drops a token that APNs answers with `410 Unregistered` (A7). A push token reaches the relay only from the Mac, after the phone sends `registerPush` inside the session, and a nil token removes it (A7). Revoking a device, at Unpair or when Away from home turns off, deletes its push token (A7, A5b). A tap only opens the inbox (`gospark-remote://inbox`), and that link can never approve, pair or send (GS-16-AC03; **Existing** link rules). Decisions live on the Mac, so a lost or doubled push loses or doubles none (GS-16-AC05). | The Worker holds the APNs key and every push token, so a compromised Worker can show any text on those phones; a tap still opens only the inbox, whose content comes from the Mac. | A7 "skips devices with an open socket", "rate limits to 10 per minute per host", "410 Unregistered removes the device token". A7 `RemoteAttentionNotifierTests.throttles`, `.dedupes` (GS-16-AC05), `.registers`. A7 "revoke deletes that device's push token". Existing `RemoteLaunchLinkTests`. |
| RT-13 | **APNs key custody.** The APNs auth key or its provider token leaks, or several isolates mint tokens at once and APNs throttles the key. | The `.p8` exists only as Wrangler secrets (`APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`), which the owner sets at G2. It is never in source or storage. Only `ApnsTokenObject`, one per key (`idFromName("apns:<keyID>")`), mints the provider token, inside `blockConcurrencyWhile`: it reuses a token under 40 minutes old, never mints within 20 minutes of the last, and stores only `{ jwt, iat, keyID }` (A7, `docs/plans/worker-apns-spike.md`). `InvalidProviderToken` trips the push kill switch and stops minting (A7). | Anyone who can deploy to the Worker or read its runtime can use the key, so Cloudflare account access is the boundary. A leaked key lets its holder push to any token they also hold; the spike calls for a key limited to the `co.gogocash.gogocode.remote` topic. Rotating the key is an owner step. | A7 "reuses a provider token under 40 minutes and never mints within 20", "InvalidProviderToken trips the kill switch and stops minting". R1 (the G2 runbook). **Gap:** a log check for `apps/api/src/apns.ts` like A4c's (A7). |

### 5.5 Commands and CLI updates

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-14 | **A remote CLI update runs code the owner did not choose.** A shell string, another binary, a forged or replayed request, or an update while a session is busy. | `updateCLI` carries only `provider` and `installPath`, and needs the Mac-issued challenge signed with the phone's Face ID key (C6). The Mac refuses it unless `installPath` is the launched executable's path, runs it only while that provider is idle, replies only after its own version check, and the ledger runs a retried command once (C6, A2). The runner executes only an entry of `CLIUpdater.commands`, which is code and cites the provider's documentation for each entry: the CLI's own updater or the package manager that owns the install, launched as a program with arguments and no shell (C4; **Existing**, "One update, run without a shell", `CLIUpdater.swift:130`). An install whose channel GoSpark cannot recognize (`.unknown`) is never updated (**Existing**). A permission failure answers "needs you on this Mac" and never retries with more privilege (C4). The App Store build answers unsupported (C6). `refreshModels` reloads a catalog and changes no model, so it cannot bring in executable code, and `providerFreshness` only reads (C6). | GoSpark checks the version it ends up with, not the package's contents: the provider's channel and package manager are the trust root, and a bad release installs from the phone as it would from the Mac. The package manager is found on the owner's login PATH, so whoever controls the owner's account controls what runs. An update can break an adapter while the owner is away, and there is no automatic rollback (C4 says so in Settings). | C6 `RemoteFreshnessTests.needsChallenge` (GS-42-AC03), `.wrongPath` (GS-32-AC01, GS-30-AC01), `.once` (GS-32-AC02, GS-42-AC02), `.verified` (GS-32-AC05), `.busy`, `.typedOnly` (GS-42-AC05), `.refresh` (GS-32-AC06, GS-29-AC04). C4 `CLIUpdaterTests.entriesValid`, `.unknownGuidance` (GS-30-AC02); `CLIUpdateRunnerTests.unchanged` (GS-30-AC05), `.timedOutUpdateReportsFailed`, `.noOverlap`, `.busy` (GS-30-AC03, GS-31-AC03), `.needsAdmin` (GS-32-AC04). J5. Manual (D5): a real update requested from a physical phone (G7, G1). |
| RT-15 | **Remote reaches further than tasks.** Seeing and supervising tasks quietly grants a terminal, the file system, the screen or the keyboard (least privilege, GS-45). | Remote is a closed set of typed commands, and an unknown one decodes as `.unknown` and does nothing (**Existing**). C6 pins the set to a reviewed list with no screen, input, shell or file-write command. Every command that lets an agent act unasked needs the signed challenge: approving, implementing a plan, a mode above Supervised, a new task above Supervised, messages and answers in Auto or Full access tasks, and `updateCLI` (**Existing**, `RemoteCommand.requiredAuth`; C6). D1's notice and A9's confirmation say the phone controls tasks only. | A Supervised task still runs an agent with no signature. A new task can make a worktree, which runs `git worktree add` and the project's already-trusted setup scripts, and depending on the provider a Supervised agent may read project files and print them before its first approval (`docs/remote.md`). | C6 `RemoteFreshnessTests.boundary` (GS-45-AC02, GS-45-AC03), `.typedOnly`. D1 `RemoteRelayConsentTests.controlBoundary` (GS-45-AC01). Existing `RemoteAuthenticationTests` "a signed new task cannot be widened, redirected, reworded or replayed", `RemoteHostDispatchTests` "supervised sends, queue-send-now and answers stay unsigned". |
| RT-16 | **Malicious tool or source text** (PRD §10). Text that an agent, a tool, a web page or a repository writes into a task tries to act with the app's authority: a fake approval, a link that pairs or sends, a relay command, a push with content, a CLI update. | Only the Mac's pending decisions draw an approve button on the phone. Links open only through a sheet that shows the real host, and only http and https can open; a pairing link can only be copied; launch links only navigate or prefill (**Existing**). Provider output never reaches the relay's control messages or a push: `RemoteRelayLink` builds every control message from the Mac's own state, and push bodies are fixed (A5b, A7). Agents have no path to Remote commands, which come only from authenticated phones, and a CLI update needs a phone's signature (C6). | Words can still persuade a person to approve something; the decision card shows the full command so the person can judge. The scrub covers the Mac's configured credentials and secret-shaped text, not every secret an agent could print (`RemoteSecretHarvest.swift`). Output that ends turns or raises decisions causes pushes within RT-12's limits. An agent in Full access runs as the owner and sits inside the boundary (RT-21). | Existing `RemoteTranscriptTests` (link policy), `RemoteLaunchLinkTests` "a pairing link never parses, so opening a URL cannot pair a phone", `RemoteRuntimeMirrorRedactionTests`, `RemoteRedactionTests`. A7 "the payload carries only the fixed text and kind". C6 `RemoteFreshnessTests.boundary`. |

### 5.6 Devices, the Mac and the connection's lifecycle

| ID | Threat | Mitigation | Residual risk | Proved by |
| --- | --- | --- | --- | --- |
| RT-17 | **Stolen unlocked phone.** Someone holding the owner's unlocked iPhone, or knowing its passcode, uses GoSpark Remote, now from anywhere the relay reaches. | Every sensitive command needs a signature from a Secure Enclave key created with `.biometryCurrentSet` and no passcode fallback, and enrolling a new face or finger invalidates it (**Existing**, `RemoteSigningKey.swift:15`). The phone holds task content in memory only, at most 15 minutes after the Mac last confirmed it, and the Lock Screen shows no titles (**Existing**, A3). Unpair at the Mac revokes the PSK, and the relay token as soon as the link is up (RT-18). A9's confirmation tells the owner to unpair a lost iPhone from this Mac as soon as possible (A9). Away from home and A9 are off by default. | Until Unpair, the holder can read every task the phone can show and send everything unsigned (RT-15), and with the relay they no longer need to be on the owner's network. Unpair needs the unlocked Mac, so an owner away from home cannot cut the phone off until they, or someone at home who can unlock the Mac, get to it (section 7). GoSpark Remote does not ask for Face ID when it opens. | Existing `RemoteAuthenticationTests` "expired, tampered, and revoked signing grants cannot approve". A6 `RemoteRelayEndToEndTests.revokeCloses` (GS-02-AC04, GS-15-AC04, GS-43-AC04). Manual (D5): the lost-phone drill. |
| RT-18 | **Access that should end goes on over the relay,** including PRD §10's "Remote device revoked". Unpair, Remote off, Away from home off or the default lock (D04) ends the LAN session but leaves a relayed session or the relay door open, or the app implies that revoking erased what the phone already showed. | Unpair deletes the PSK, sends a connected phone the off notice and calls `revoke`: the relay closes that device's socket with 4403 and refuses its token, and a link that was down revokes unknown devices at its next `ready` (**Existing** for the PSK; A4c, A5a, A5b). Remote off sends `off`, which closes every phone socket, and stops the link (A4c, A5b, A8). Turning Away from home off first revokes every device, then sends `off` and closes (A5b). The phone drops its grant on a 4401 or 4403 refusal or on a LAN welcome that carries none, and after such a refusal, or after the relay reports the Mac off, it stops dialing the relay until its next LAN welcome (A6). Lock, display sleep, Presentation mode and a session switch drop relayed peers as they drop LAN peers, and tell phones `paused` (A5a, A5b), unless A9 is on (RT-22). The phone clears its kept view on the paused or off notice (**Existing**) and shows "revoked" on 4403 (A6). | A phone that is not connected learns nothing until it next tries to connect. One that was not on the relay when Away from home was turned off makes one more refused dial, which shows the relay its address once, and then drops its grant (A6, section 11). What a phone already showed can be remembered, photographed or copied, and GoSpark promises no erasure (GS-02-AC05, GS-21-AC04), but the Mac's Unpair button has no words that say so today. | A4c "revoke closes that device's socket with 4403 and refuses its token" (GS-02-AC04), "status off closes every phone socket with host{off}" (GS-41-AC06). A5a `RemoteRelayHostTests.unpairDrops` (GS-02-AC04), `.lockDropsRelay` (GS-44-AC04). A5b `RemoteRelayLinkTests.offCloses` (GS-41-AC06), `.presence` (GS-44-AC04). A5b `awayOffRevokesEveryDevice`. A6 `RemoteRelayEndToEndTests.revokeCloses`. A6 `grantDroppedOnRevoked`, `grantDroppedOnUnauthenticated`, `grantDroppedWhenWelcomeHasNone`, `relayDialsStopAfterOff`. A8 "Remote off sends off". Existing `RemoteTransportTests` "revoking a connected peer closes both ends", `RemoteHostDispatchTests` "revokeSelf answers ok, removes the device, and a later hello fails". **Gap:** GS-02-AC05's words at Unpair (D5). |
| RT-19 | **Relay outage, captive portal or blocked relay** (PRD §10). When the relay cannot be reached, the phone or the Mac weakens security to get through, retries in a tight loop, or tells the person something false. | Nothing falls back past authentication. The phone tries private LAN addresses and the configured relay only, and a network change never asks it to pair again (A6). Its outer TLS uses system trust with the grant's host as SNI, so a captive portal's certificate fails and the phone shows "relay blocked" with a next step (A6). Retries follow `ReconnectDelay`, capped at 60 s, and a path change resets the backoff (A6). The Mac's link backs off on network failures and does not retry after `unauthenticated`, `replaced` or `disabled` (A5b). Status text names the problem without task content and never says the Mac stopped (A6). | Some networks block the relay outright. The phone says so, and works again only on another network or on the owner's LAN or VPN. GoSpark promises no universal connectivity (GS-41-AC05). | A6 `RemoteConnectionPlannerTests.relayFailureBacksOffWithCap` (GS-43-AC06), `.pathChange` (GS-43-AC01), `.offline`; `RemoteLinkStatusTests.blockedRelayHasActionableText` (GS-41-AC05), `.neverStopped` (GS-12-AC03, GS-43-AC06, GS-08-AC03). A5b `RemoteRelayLinkTests.backsOff`, `.noRetryOnAuthFailure`. Manual (R4, D5 physical matrix): a captive portal, cellular and a separate Wi-Fi. |
| RT-20 | **False, stale, malformed or excessive messages from the relay.** The relay operator or a host-key holder forges presence (paused, sleeping, off or offline), sends malformed or oversized frames, or opens streams without end. | Presence only explains why no session started. Once connected, the phone learns the Mac's state from the Mac, inside the session. With no host socket the relay reports offline with the time the host was last seen, the `at` field is informational, and no status claims that the Mac stopped or that the relay can wake it (A4c, A6, A8). The Mac sends `sleeping` before it sleeps and `available` when it wakes (A8). Unknown relay message types decode as `.unknown` (A4a), and the Mac's link refuses a ninth stream, so `open` messages cannot multiply bridges (A5b). | A compromised relay can show a wrong reason and keep phones out: a denial of service, never a false command or a false task state. Because the phone treats a 4401 or 4403 refusal as final, one forged refusal keeps that phone off the relay until its next LAN welcome (A6, section 11). Presence can lag the Mac by a round trip. The plan sets no cap on inbound frame size in the phone's framer or the Mac's link. | A4c "with no host socket a phone gets host{offline, at: lastHostSeen} and 4404" (GS-44-AC01, GS-12-AC03), "after status paused a phone gets host{paused}". A6 `RemoteRelayEndToEndTests.pausedThroughRelay` (GS-44-AC01), `RemoteLinkStatusTests.neverStopped`. A8 `RemoteActivityReadinessTests.asleep` (GS-44-AC01), `RemoteReadinessTests.neverPromisesRemoteWake` (GS-44-AC02), "sleep sends sleeping, wake sends available". A4a `RemoteRelayWireTests.unknown`. A5b "a ninth stream is refused". **Gap:** inbound frame caps (A5b, A6). |
| RT-21 | **Local Mac user or process.** Someone at or logged in to the Mac, or a local process, uses the loopback relay listener or reads the stored keys. | The relay listener binds 127.0.0.1 with a loopback-only interface, so nothing off the Mac reaches it, and it offers device identities only; a local process without a PSK fails the handshake (A5a). The relay opens no inbound port, because the Mac dials out (GS-41-AC03). Device PSKs, relay tokens and the relay host key live in the owner's login keychain under `GoGoCode.Remote`, never in `remote-devices.json` or the ledger (**Existing**; A5a, A5b). Another macOS account cannot read the owner's login keychain, and another user's session suppresses Remote even with A9 on (A9). | A process running as the owner, an agent in Full access included, is inside the boundary: it can read these items, as it can already read provider credentials (`docs/plans/ios-remote-2026-09-17.md`, **Trust model**). Any local process can briefly hold the Mac's relay slots (RT-2). | A5a `RemoteRelayHostTests.loopbackOnly` (GS-41-AC03), `.noPairIdentity`. A9 `RemoteLockPolicyTests.session`. Existing `AppStoreEntitlementsTests`. |
| RT-22 | **Reachable while locked (A9).** The opt-in makes the locked Mac more useful to the wrong person, at the Mac or holding a phone. | Off by default, and merged only after G5. With it on, only a locked screen and a sleeping display stop suppressing Remote; Presentation mode, another user's session and system sleep still disconnect phones (A9). It reaches tasks only, never the screen or input, and sensitive actions still need Face ID on the phone. The confirmation lists those points, recommends Keep this Mac awake on power, and tells the owner to unpair a lost iPhone from this Mac as soon as possible (A9). Section 7 covers the person at the Mac, Keychain reads and the lost phone. | Agent work started from a phone runs while nobody watches the screen. A stolen unlocked phone keeps the owner's reach while the Mac is locked (RT-17). If the locked Keychain read fails and A9 moves the device secrets and the relay host key to after-first-unlock, those keys become readable while the screen is locked by processes running as the owner. | A9 `RemoteLockPolicyTests.defaultUnchanged` (GS-44-AC04), `.optIn` (GS-12-AC01, GS-44-AC05), `.presenting`, `.session`; the addition to `RemoteSleepPolicyTests`. J2 `j2Locked`. Manual (D5, before G5): the locked Keychain read. |
| RT-23 | **A copied credential stays good.** A device PSK, relay token or relay host key copied without the owner knowing stays useful for as long as the pairing lasts. | Recovery is in person and needs no account: Unpair removes a phone's PSK, relay token and ledger rows, and pairing again mints new ones (D05; **Existing** for the PSK and the ledger, A5b for the token). The APNs provider token renews every 40 minutes (RT-13). | Phase 1 rotates none of the PSKs, the relay tokens or the host key, and has no way to replace a host key: a new key is a new host id, so every phone would need a new grant at home. With no forward secrecy (RT-6), a copied PSK also opens recorded sessions. Section 11 asks G6 to accept or change this. | Existing `RemoteLedgerTests` "unpairing forgets the device's rows". A5a `RemoteRelayHostTests.unpairDrops`. No rotation test, by design. |

## 6. Metadata the relay sees

R2 builds the privacy text from this table. "Kept" means stored by the relay object unless the
cell says otherwise. Retention values are provisional until G9 (D12).

| What | Seen by | Kept | For how long |
| --- | --- | --- | --- |
| The Mac's and the phone's public IP addresses | The Worker, at every socket upgrade, where the address, or its IPv6 /64, keys the rate limit (A4b) | Not in the object. To cap unauthenticated sockets per source group, the object holds an unkeyed SHA-256 of the source group, salted with the host id, in the attachment of a socket that has not authenticated, and drops it when the socket authenticates or closes. An IPv4 address can be recovered from it by brute force (A4b). Cloudflare keeps rate-limit counters, and Workers Logs may record the address | The digest: 10 s at most. Counters: their 60 s window. Logs: as below |
| A rough location and network: country, city, ASN, data centre | The Worker, in Cloudflare's request properties (`request.cf`) | Workers Logs may record them | As below |
| When each socket opened and closed | The Worker and the object | `lastHostSeen`, when the host was last seen: its hello, its socket closing, or the alarm while its socket is open (A4c); Workers Logs | `lastHostSeen` until the object's storage is deleted; logs as below |
| The Mac's presence (available, paused, sleeping, off) and when it changed | The object, and phones that dial in | `status` | Until the next change, or deletion |
| Byte counts | The object, per message | `usage:<YYYY-MM-DD>`, per host per day | Two days: the alarm prunes older records (A4c) |
| The host id (a hash of the Mac's relay public key) and that public key | URL paths, the object's name, the host hello | `hostKey`; the object's name; Workers Logs, in URLs | Until deletion; logs as below |
| Device ids (random UUIDs) | Phone hellos and `open` messages | `devices` | Until revoked at Unpair, or with every device when Away from home turns off (A5b), or deletion |
| Device token hashes | The Mac's `device` messages | `devices` | Until revoked at Unpair, or with every device when Away from home turns off (A5b), or deletion |
| Raw device tokens | Each phone hello | Never stored or logged (A4c) | One connection, in memory |
| APNs device tokens and their environment (A7) | The Mac's `pushToken` messages | `devices` | Until the Mac sends nil, APNs answers 410, the device is revoked (A7), or deletion |
| Push kind and time (A7) | The object, and Apple | Not stored; Workers Logs may record the event | As below |
| Stream numbers and close codes | The object | Socket tags, in memory | One connection |
| Session bytes, which are ciphertext | The object, in flight | Never stored or logged (A4c) | In flight only |

The relay never sees prompts, replies, task titles, project names, paths, commands, approvals,
diffs, attachments or provider credentials. It does see their sizes and their timing.

**Deletion.** The object deletes its storage only when no host socket is open and the host was
last seen, at its hello or when its socket closed, more than 30 days ago. While a host socket is
open, the alarm refreshes `lastHostSeen` (A4c). Keying on the hello alone would delete the device
list of a Mac that stays connected for more than 30 days without a fresh hello, and its phones
would then be refused under an open socket. Turning Away from home off revokes every device,
which deletes each token hash and push token, then sends `off` and closes the link (A5b, A7). The
Mac's public key, last presence, last-seen time and at most two days of byte counts stay until
deletion.

**Workers Logs.** `apps/api/wrangler.jsonc` turns observability on, sampling every request, with the
rule "metadata-only logs, never bodies" (**Existing**). Cloudflare's Workers Logs page, read on
2026-11-09, says that each invocation writes one invocation log with details of the request and
response, and that a fetch is logged with its method and URL. For relay routes that URL contains
the host id. The page lists WebSocket events among the invocations that write a log, so a busy
session may write one event per message, with its time and never its bytes, which also spends
the log allowance. It gives retention of 3 days on Workers Free and 7 days on Workers Paid, says
that Workers Logs moves to Cloudflare Observability pricing on 1 December 2026, and documents an
`invocation_logs = false` setting. Which plan applies, whether relay invocation logs stay on, and
what to tell people are G9 decisions. This document sets no retention period of its own. Before
G4, a manual line checks a deployed environment's logs for bodies, tokens and keys (RT-10).

## 7. The A9 opt-in: reachable while the Mac is locked

A9's switch, **Reach this Mac while it's locked**, is off by default and merges only after G5
(D04). This section is what G5 and G6 approve.

What a person at the locked Mac can and cannot do while the opt-in is on:

| They can | They cannot, without the account password |
| --- | --- |
| See what macOS shows on the lock screen under the owner's notification settings, as today | Open GoSpark, read tasks, or see what a phone is doing |
| Cut power or the network, close the lid or restart. Phones then see asleep or offline, never stopped, and tasks stop with the Mac | Pair a phone: that needs the Pair sheet on an unlocked Mac, and the relay listener has no pairing identity (RT-5) |
| If they have their own account on the Mac, switch to it, which suppresses Remote for the owner's session (A9) | Unpair a phone, change Remote settings, or turn the opt-in off |
| Notice that the Mac is busy (fans, disk, network) while tasks started from a phone run | Approve anything: approvals come only from a paired phone's signature or from the unlocked Mac |
| | See or drive the screen through Remote, which has no screen or input commands (RT-15) |

With the account password, the person is the owner as far as the Mac can tell, as today. Attacks
on macOS itself, such as starting the Mac from recovery, are outside this model.

**Keychain reads while locked.** The Mac keeps device secrets in the owner's login keychain:
`RemoteKeychain` writes them with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and does not set
`kSecUseDataProtectionKeychain` (**Existing**, `RemoteKeychain.swift:24`). A5a adds the relay
token to the same item, and A5b stores the relay host key through the same write path, with the
same accessibility. The link has to reconnect while the screen is locked when A9 is on, and
nobody has yet checked that GoSpark can read those items then. Before A9 merges, a manual line in
`docs/phase1-verification.md` (D5) does: with the opt-in on and the screen locked, a phone
connects through the relay and authenticates, which needs both the host key and the device
secret. If the read fails, A9 changes only those items' accessibility to after-first-unlock, and
only while the opt-in is on. `RemoteKeychain`'s update path writes only an item's data
(**Existing**), so an existing item keeps its accessibility class, and the change has to set it on
each existing item. This section must then say that a process running as the owner can read the
device keys and the host key while the screen is locked (RT-22).

**The lost phone.** Unpair, on the unlocked Mac in Settings › Connections, deletes the phone's
PSK, sends it the off notice if it is connected, and revokes its relay token, which closes its
relay socket with 4403 (RT-18). A9's confirmation tells the owner to unpair a lost iPhone from
this Mac as soon as possible. Phase 1 adds no other way to cut a phone off, because it has no
accounts (D05). An owner away from home therefore has to reach the Mac, or ask someone at home
who can unlock it, to unpair the phone or to turn Away from home or Remote off. With the opt-in
on, the locked Mac stays reachable for the whole absence, so a stolen unlocked phone can read
tasks and send unsigned commands until then (RT-17). It still cannot sign, pair another phone or
reach the screen. Afterwards the owner pairs again in person, which mints a new PSK and token.

## 8. Keys, rotation and recovery

PRD §11.1 asks for rotation and recovery to be chosen after threat modelling. Phase 1's answer is
revocation plus pairing again in person, with no scheduled rotation (RT-23). G6 accepts or
changes that.

| Credential | Made by | Kept | Rotation | Ended by |
| --- | --- | --- | --- | --- |
| Device PSK, 256 bits | The Mac, at pairing | The Mac's login keychain; the phone's Keychain, this device only, never synced (**Existing**) | None | Unpair; Forget this Mac on the phone; local data deletion on the Mac |
| Phone signing key, P-256 | The phone's Secure Enclave, at pairing; the Mac keeps the public key | The Secure Enclave, released by Face ID or Touch ID (**Existing**) | Enrolling new biometrics invalidates it, and the phone must pair again | Unpair |
| Relay device token, 32 bytes | The Mac, at pairing or lazily (A5a) | The Mac's login keychain with the PSK; the phone's Keychain inside the grant (A6); the relay keeps its SHA-256 (A4b) | None | Unpair, or turning Away from home off, through `revoke` (A5b, A4c); the phone drops it on a 4401 or 4403 refusal, or on a LAN welcome without a grant (A6) |
| Relay host key, P-256 | The Mac, once (`RemoteRelayHostKey.loadOrCreate`, A5b) | The Mac's login keychain, account `relayHostKey`, written like the device secrets (A5b); the relay keeps the public key | None designed | None designed; a new key means a new host id and a new object |
| APNs auth key, `.p8` | The owner, in Apple Developer (G2) | Wrangler secrets, per environment | The owner's step | The owner revokes it with Apple |
| APNs provider token, an ES256 JWT | `ApnsTokenObject` (A7) | That object's storage | Every 40 minutes, never within 20 | Expiry within the hour |
| APNs device token | iOS | The relay's `devices` (A7) | When iOS changes it | nil from the Mac, 410 from APNs, revoke (A7), or deletion |
| TLS session keys | Each handshake | Memory | Every connection | The connection's end |

## 9. Coverage of the PRD

PRD §11.1 is two paragraphs, so it is split here into its nine requirements.

| PRD requirement | Threat rows |
| --- | --- |
| §11.1 (a) Enrollment, identity and login, project permission and action authorization are separate. Phase 1 has no logins (D02, D05, D08), so the paired device is the identity. | RT-4 (the relay door is not enrollment), RT-5 (enrollment happens only in person), RT-9 (the door is not authorization), RT-15 (project permission and modes stay with the Mac) |
| §11.1 (b) Least privilege: viewing a task does not imply terminal or shell access. | RT-14, RT-15 |
| §11.1 (c) Sensitive remote actions need current authorization and a bound step-up challenge. | RT-8, RT-14, RT-15, RT-17 |
| §11.1 (d) The final mechanism needs security review; a Face ID button alone proves nothing. | RT-9 and RT-17 (the Mac verifies the signature; the phone's button is not the check), section 11 (G6) |
| §11.1 (e) The relay is a connectivity service, not an agent executor or an authorization oracle. | RT-9, RT-6, RT-20 |
| §11.1 (f) Authenticated device channels with end-to-end payload protection, so operators never need task or control plaintext. | RT-4, RT-6, RT-7 |
| §11.1 (g) Minimize routing metadata and document its retention. | RT-10, RT-11, section 6 |
| §11.1 (h) Choose transport, key rotation and recovery after threat modelling. | RT-6 and RT-7 (transport, pending A0.2), RT-23 and section 8 (rotation and recovery), section 11 items 1, 2 and 6 |
| §11.1 (i) Do not imply that the encryption design is implemented or audited. | Section 1 (status), RT-6 and RT-7 (they hold only for verdict M1), section 11 item 1 |
| §10 "Relay outage/captive portal" | RT-19, with RT-20 |
| §10 "Remote device revoked" | RT-18, with RT-4 and RT-17 |
| §10 "Malicious tool/source text" | RT-16, with RT-12 and RT-14 |

## 10. Evidence still to add

Each item is a mitigation above that no planned test or manual line proves yet. The named task
should add it; none changes that task's design.

1. A4c: the plan's storage deletion test ("the alarm deletes storage 30 days after the last host
   hello") must check the rule in section 6 instead: storage goes only when no host socket is
   open and the host was last seen, at its hello or when its socket closed, more than 30 days ago
   (RT-1, RT-10).
2. A5b: a relayed peer's identity comes from its hello, never from the relay's `open` message
   (RT-9).
3. A5b and A6: inbound relay frames over 65,536 bytes are refused (RT-20).
4. A7: nothing in the push path logs the provider token, a push token or the key (RT-13).
5. D5 manual lines: the locked Keychain read (RT-22), the lost-phone drill (RT-17), a deployed
   environment's Workers Logs (RT-10), and the captive portal row of the physical matrix (RT-19).
6. D5: words at Unpair that say revoking cannot erase what the phone already showed
   (GS-02-AC05), or a gap issue (RT-18).

## 11. Open items for sign-off (G6)

G6 is the owner's security sign-off on this document and on the A0.2 mechanism (master plan,
**Owner gates**). It blocks R3, and the M2 path if the spike fails.

1. **The A0.2 mechanism.** With verdict M1, RT-6 to RT-8 stand as written. With M2, A5 and A6 are
   replanned around an application-layer channel keyed from the PSK with CryptoKit. That is a
   protocol of GoSpark's own, so its key schedule, nonces, framing, replay and downgrade handling
   need review here, and RT-6 to RT-8 rewriting, before A5a starts.
2. **No forward secrecy.** Phase 1 keeps the PSK-only suite, because changing it would also change
   the LAN path that current phones use. G6 accepts that residual, or asks for a suite with an
   ephemeral key exchange; whether Network.framework offers one to both ends is not verified, and
   A0.2 can try it.
3. **Free host ids.** Host ids stay free to mint, so only the kill switch bounds the service as a
   whole. Accept that, or add a global daily budget that trips the switch, or a proof of a genuine
   GoSpark build before an object accepts a host.
4. **Unauthenticated slots.** With 4 per source group and 16 per object, whoever learns a host id
   and controls four source groups can still hold every slot. Accept that, or evict the oldest
   unauthenticated socket instead of refusing the newest.
5. **A lost phone away from home.** A9's confirmation tells the owner to unpair a lost iPhone as
   soon as possible, but no phone can be cut off without the unlocked Mac. Accept that, or add a
   way, such as from another paired phone, or an optional Face ID lock when GoSpark Remote opens.
6. **Rotation.** Accept no rotation for PSKs, relay tokens and the host key in Phase 1, and decide
   how a host key would be replaced.
7. **Relayed clones.** Accept that over the relay a clone shows only as two copies of a device
   replacing each other (4409), never as a notice on the Mac, and not at all while the real phone
   is offline.
8. **A relay refusal ends the phone's relay access.** A6 treats a 4401 or 4403 refusal as final:
   the phone drops its grant and stops relay dials until its next LAN welcome, while the relay's
   codes stay as A4c defines them. A phone that missed Away from home turning off therefore makes
   one more refused dial, which shows the relay its address once. In exchange, a fault in the
   relay's own authentication, or a forged refusal, costs that phone the relay until its next LAN
   welcome. Accept that trade-off (RT-10, RT-18, RT-20).
9. **Metadata (G9).** The Workers Logs plan and retention, and whether relay invocation logs stay
   on.
10. **Relay limits (D12, G9).** The provisional values in RT-1.
11. **The A9 opt-in (G5),** and the Keychain change for the device secrets and the host key if the
    locked read fails.
12. **Push.** Accept that a compromised Worker can show any notification text on registered
    phones.
13. **CLI updates.** Accept the provider's channel and package manager as the trust root for what
    an update installs.
14. **Unsigned reach.** Accept that over the relay, as on the LAN, Supervised new tasks (and the
    trusted worktree setup scripts they run) and Supervised messages need no signature.

## 12. Which task cites which rows

| Task | Rows |
| --- | --- |
| A4a, relay protocol v1 and its wire types | RT-3, RT-4, RT-8, RT-20 |
| A4b, `RelayObject` route and host socket | RT-1, RT-2, RT-3, RT-8, RT-10 |
| A4c, phone sockets, forwarding, budget and cleanup | RT-1, RT-2, RT-4, RT-6, RT-10, RT-18, RT-20 |
| A5a, the Mac's relay listener and relay tokens | RT-2, RT-4, RT-5, RT-6, RT-7, RT-8, RT-9, RT-18, RT-21, RT-23 |
| A5b, the Mac's relay link, bridge and host key | RT-2, RT-3, RT-4, RT-7, RT-9, RT-10, RT-12, RT-18, RT-19, RT-20, RT-21, RT-23 |
| A6, phone path, framer and status | RT-4, RT-5, RT-6, RT-7, RT-10, RT-17, RT-18, RT-19, RT-20 |
| A6b, the live check against a local Worker | RT-6 |
| A7, content-free push | RT-11, RT-12, RT-13, RT-16 |
| A8, readiness and the sleep notice | RT-18, RT-20 |
| A9, reachable while locked | RT-17, RT-21, RT-22 |
| C4, the CLI update table | RT-14 |
| C6, remote freshness commands | RT-9, RT-14, RT-15, RT-16 |
| D1, relay consent | RT-10, RT-15 |
| R2, privacy text | RT-10 and section 6 |
