# Relay protocol v1

> **In Manut AI.** Copied from GoSpark (`mygogocash/gospark` at `a7537c80`, `docs/relay-protocol-v1.md`), whose relay
> `apps/api/src/relay.ts` and `relay-object.ts` were lifted unchanged, so sections 2 to 11 and 14 to 16 hold here as
> written, with `cloud/` read as `apps/api/`. Where this app differs (item 78, `docs/remote-access.md`):
>
> - **What crosses the relay (sections 1 and 7).** No TLS-PSK session: the phone is a web page, and no browser offers
>   one. Each stream carries `@manut/remote-channel`'s records instead (`packages/remote-channel/README.md`): a key
>   exchange proved with K at each session, then numbered AES-GCM records, which the relay can neither read nor change.
> - **Pairing crosses the relay (section 1).** GoSpark paired in person on the LAN. Here the QR code names a one-use
>   relay door (a device the Mac registers with `device` for two minutes and revokes with `revoke` once pairing ends in
>   any way), and the pairing exchange, the typed four-digit code and the grant travel through it, sealed.
> - **The Mac's side (sections 3 and 5).** The desktop's page dials, not a Swift link: `apps/desktop/src/remote/link.ts`,
>   to the relay on the API origin the app is connected to, never a build setting. It learns that the relay is switched
>   off from the API's public `/v1/health` (`relay: "on" | "off"`), because a page cannot read a refused upgrade's 503.
> - **The grant (section 12).** No relay URL is granted: the phone runs on the API's own origin (`/app/`), so the relay
>   is that origin's. The grant's layout is the package's (`40 01 | device id | door token | K`).
> - **Push (`push`, `pushToken`).** Not yet: item 78d. The Swift types, tests and plan files named below are GoSpark's.

**Date:** 11 Nov 2026 · **Version:** 1 · **Task:** A4a in [`phase1-track-a-remote-2026-11-09.md`](plans/phase1-track-a-remote-2026-11-09.md)
**Status:** Partly built. The Worker side is built (A4b, A4c); the Mac side arrives in A5a and
A5b, the phone side in A6 and push in A7. Every relay route stays switched off until the owner sets
`RELAY_ENABLED` (gate G3). The security review is
[`remote-relay-threat-model.md`](security/remote-relay-threat-model.md), whose rows RT-3, RT-4, RT-8
and RT-20 cite this document. Nothing here is audited yet (gate G6).

The Swift types are in [`Shared/Remote/RemoteRelayWire.swift`](../Shared/Remote/RemoteRelayWire.swift).
The test vectors are in [`apps/api/test/fixtures/relay-v1-vectors.json`](../apps/api/test/fixtures/relay-v1-vectors.json),
and both languages test against them: Swift in `Tests/RemoteRelayWireTests.swift`, the Worker in
`apps/api/test/relay.test.ts` (A4b, A4c).

## 1. What the relay does

At home, GoSpark Remote reaches its Mac directly, on the owner's LAN or VPN. Away from home it goes
through the relay: one Cloudflare Durable Object per Mac, which forwards bytes between that Mac and
its paired phones.

- The relay carries the existing end-to-end TLS-PSK session, from the phone's TLS-PSK client to the
  Mac's loopback relay listener, as opaque binary messages. It cannot read or change that session.
  Every task, command, approval and attachment travels inside it (GS-42-AC04).
- The relay authenticates doors only. The Mac proves it holds its relay host key, and a phone proves
  it holds a device token that the Mac registered. The relay never sees a command, so it can never
  authorize one (GS-41-AC04).
- Pairing never crosses the relay. A phone pairs in person, with the code on the Mac's screen, and
  the Mac's relay listener holds no pairing identity (A5a).
- There are no accounts. A Mac's relay is named after the Mac's own public key.

```text
iPhone, GoSpark Remote            Cloudflare                          Mac, GoSpark
  TLS-PSK client                    Worker, /relay/v1/hosts/...         RemoteRelayLink: one outbound
  relay framer (WebSocket)  ----->  RelayObject "relay:<hostID>"  <---    WebSocket, signs the challenge
  outer TLS, TCP                    checks doors, forwards binary       RemoteRelayBridge -> 127.0.0.1
                                    messages unread                     relay listener (TLS-PSK) -> RemoteHost
```

Arrows show who dials. Both the phone and the Mac dial out, so no port opens on the Mac (GS-41-AC03).

## 2. Encodings

| Value | Encoding |
| --- | --- |
| Binary values inside JSON: keys, signatures, tokens, hashes, nonces | base64url (RFC 4648 section 5): `+` becomes `-`, `/` becomes `_`, and there is no `=` padding |
| Host id | base64url of the SHA-256 of the Mac's P-256 public key in X9.63 form (65 bytes: `04`, then X, then Y). Always 43 characters, matching `^[A-Za-z0-9_-]{43}$` |
| Device id | A UUID in upper-case 8-4-4-4-12 form, as Swift writes one, such as `E621E1F8-C36C-495A-93FC-0C247A3E6E5F`. The relay accepts only that form and compares ids exactly |
| Device token | 32 random bytes the Mac mints for each phone (A5a): 43 characters of base64url on the wire |
| Token hash | base64url of the SHA-256 of the 32 token bytes, not of their text: 43 characters |
| Nonce | 32 random bytes the relay draws for each Mac socket: 43 characters of base64url |
| Stream | An unsigned 32-bit number: a JSON integer from 0 to 4,294,967,295, or 4 big-endian bytes at the front of a stream frame |
| `at` | Unix time in whole seconds, as a JSON integer. It is informational: no check depends on it |
| Text message | One UTF-8 JSON object per WebSocket text message |
| Binary message | Opaque bytes. From the Mac, and to the Mac, a stream frame (section 7) |

Neither side offers a WebSocket subprotocol or extension, so no message is ever compressed.

Nothing secret goes in a URL, a header or a query string. A phone's token travels only in its
`hello` message, inside the outer TLS (RT-4).

## 3. Routes

Both routes are `GET` requests with `Upgrade: websocket`, under the relay's base URL: the
`GOSPARK_RELAY_URL` build setting on the Mac (A5b), and the grant's `url` on a phone (section 12).
The base URL is an origin, a scheme with a host and an optional port, and has no path.

| Route | Who opens it |
| --- | --- |
| `/relay/v1/hosts/<hostID>/socket` | The Mac whose host id it is. One socket at a time |
| `/relay/v1/hosts/<hostID>/phone` | A phone paired with that Mac. One socket per device |

Both reach the Durable Object named `relay:<hostID>`. Before the upgrade, the relay can answer:

| Status | Body | When |
| --- | --- | --- |
| 503 | `{"error":"relay_disabled"}` | The kill switch is off: the environment's `RELAY_ENABLED` is not exactly `"1"`. No socket opens |
| 400 | `{"error":"invalid_host_id"}` | The host id is not 43 base64url characters |
| 426 | `{"error":"upgrade_required"}` | The request is not a `GET` with `Upgrade: websocket` |
| 429 | `{"error":"rate_limited"}`, with the header `retry-after: 60` | An upgrade gate is spent for this source group, or the object already holds as many unauthenticated sockets as section 9 allows |
| 404 | `{"error":"not_found"}` | Any other path under `/relay/` |

The bodies use the Worker's existing `{"error":"<snake_case>"}` shape. The Worker's rate gate runs
before the relay route, so a request can meet 429 `rate_limited`, or 503
`{"error":"rate_limit_unavailable"}` when the gate itself fails, before the kill switch is checked.
Only the body `relay_disabled` means the relay is switched off. A client treats every other answer
that is not 101 as temporary, and retries with backoff.

## 4. Messages

Every text message is a JSON object that carries its type in `"t"` and the protocol version as
`"v":1`. These are all of them, and the field names are fixed. A field marked optional may be
missing, and a receiver reads an unreadable one as missing; every other field is required. The
vectors hold one example of each.

**From the Mac to the relay** (`RemoteRelayHostOutbound`):

| `t` | Fields | Example |
| --- | --- | --- |
| `hello` | `key`: the X9.63 public key; `sig`: the raw signature, `r` then `s`, 64 bytes | `{"t":"hello","v":1,"key":"BC5q...","sig":"Vb0m..."}` |
| `device` | `id`: a device id; `tokenHash`: that device's token hash | `{"t":"device","v":1,"id":"E621E1F8-...","tokenHash":"q4Xc..."}` |
| `revoke` | `id`: a device id | `{"t":"revoke","v":1,"id":"E621E1F8-..."}` |
| `status` | `state`: `available`, `paused`, `sleeping` or `off`; `at`: when the Mac's state changed, by its own clock | `{"t":"status","v":1,"state":"paused","at":1789000000}` |
| `close` | `stream` | `{"t":"close","v":1,"stream":4275878552}` |
| `push` | `kind`: `decision`, `finished` or `failed` (A7) | `{"t":"push","v":1,"kind":"decision"}` |
| `pushToken` | `id`: a device id; `token`: the device's APNs token as lower-case hex, or `null` to remove it; `env`: `sandbox` or `production` (A7) | `{"t":"pushToken","v":1,"id":"E621E1F8-...","token":null,"env":"sandbox"}` |

**From the relay to the Mac** (`RemoteRelayHostInbound`):

| `t` | Fields | Example |
| --- | --- | --- |
| `challenge` | `nonce` | `{"t":"challenge","v":1,"nonce":"J0Zk..."}` |
| `ready` | `devices`: the registered device ids, never their hashes (optional, default none) | `{"t":"ready","v":1,"devices":["E621E1F8-..."]}` |
| `open` | `stream`; `device`: the device that opened it | `{"t":"open","v":1,"stream":4275878552,"device":"E621E1F8-..."}` |
| `close` | `stream`; `reason`: one word for the log (optional, default `closed`) | `{"t":"close","v":1,"stream":4275878552,"reason":"closed"}` |
| `error` | `code` | `{"t":"error","v":1,"code":"device_limit"}` |

**From a phone to the relay** (`RemoteRelayPhoneHello`), its only text message:

| `t` | Fields | Example |
| --- | --- | --- |
| `hello` | `device`: its device id; `token`: its device token | `{"t":"hello","v":1,"device":"E621E1F8-...","token":"3sPa..."}` |

**From the relay to a phone** (`RemoteRelayPhoneInbound`):

| `t` | Fields | Example |
| --- | --- | --- |
| `ready` | none | `{"t":"ready","v":1}` |
| `host` | `state`: `paused`, `sleeping`, `off` or `offline`; `at` (optional: present when the relay has a time) | `{"t":"host","v":1,"state":"offline","at":1789003600}` |
| `error` | `code`. Reserved: a v1 relay sends no `error` to a phone, and a phone that gets one acts on the close that follows | `{"t":"error","v":1,"code":"over_budget"}` |

The literal text messages `ping` and `pong` are keepalives, not JSON (section 11).

## 5. The Mac's socket

1. The Mac opens `/relay/v1/hosts/<hostID>/socket` with its own host id, from its relay host key
   (A5b).
2. The relay sends `challenge` with a fresh nonce for this socket.
3. The Mac signs the UTF-8 string `gospark-relay-v1|host|<hostID>|<nonce>` with ECDSA on P-256 over
   SHA-256, and sends `hello` with its public key and the raw signature.
4. The relay checks that the SHA-256 of the key is the host id in the path, and that the signature
   verifies over that string with the nonce it gave this socket. It then sends `ready` with the
   registered device ids. If either check fails, it closes the socket with 4401.
5. Right after `ready`, the Mac sends its `status`, then brings the relay's devices in step with its
   own (A5b): first `revoke` for each id in `ready` that it no longer has, then `device` for each
   paired phone, at most 8. Revoking first frees the places that stale devices held, and closes
   their doors sooner.

The rules:

- A signature is good for one Mac, because the signed string names the host id, and for one socket,
  because it names that socket's nonce. Nothing in the exchange carries a time, so clock skew cannot
  break it, and a `hello` recorded on one socket fails on the next (RT-3, RT-8).
- Until `ready`, the Mac may send only `hello`, besides the `ping` keepalive (section 11). Any other
  message, an unreadable `hello`, or no valid `hello` within 10 seconds of the upgrade closes the
  socket with 4401.
- When a second Mac socket authenticates, the relay closes the earlier Mac socket with 4409, and
  closes every phone socket that was streaming through it with 4409 too (A4b).
- `device` registers a device, or replaces its token hash. Sending the same hash again changes
  nothing. A different hash closes that device's open socket with 4403. A ninth device is not
  registered, and the relay answers `error` with the code `device_limit`.
- `revoke` deletes the device with its token hash and push token, and closes its socket with 4403
  (GS-02-AC04). An unknown id is ignored. The relay keeps no record of revoked devices, so a later
  `hello` from that device is refused like any unknown device, with 4401.
- `status` records the Mac's presence and its `at`. The Mac never sends `offline`, which is the
  relay's word for "no Mac socket". The last status outlives the socket (section 8).
- `close` closes that stream's phone socket with 1000. An unknown stream is ignored.
- A binary message from the Mac is a stream frame. The relay forwards its payload to the phone on
  that stream, without the stream number. A frame for a stream that is not open is dropped. A
  binary message shorter than 4 bytes closes the socket with 4400.
- After `ready`, a text message whose `t` the relay does not know, or whose `v` is not 1, is
  ignored, so a newer Mac can talk to an older relay. A message the relay knows but cannot read,
  such as one with a missing field or a `status` of `offline`, closes the socket with 4400.
- `push` and `pushToken` belong to v1, but only a relay with push support (A7) acts on them. Before
  that, a relay accepts both and does nothing with them.

## 6. A phone's socket

1. The phone opens `/relay/v1/hosts/<hostID>/phone` with the host id from its grant.
2. Its first message is `hello`, with its device id and its device token.
3. The relay checks that the device is registered and that the SHA-256 of the 32 token bytes equals
   the registered hash, compared in constant time. If not, it closes the socket with 4401, and the Mac
   hears nothing (GS-41-AC04).
4. If the Mac can take the phone, the relay picks a stream number, sends the Mac `open` with the
   stream and the device, then sends the phone `ready`. The Mac can take a phone when its socket is
   open and its last status is `available`, or when it has sent none. Otherwise the relay sends the
   phone `host` (section 8) and closes the socket with 4404.
5. After `ready`, binary messages flow both ways (section 7). The phone starts TLS-PSK only after
   `ready`, so the inner handshake is the first thing on the stream (A0.2, A6).

The rules:

- After `hello`, the phone sends nothing until `ready` or a close.
- A first message that is not a readable `hello`, or no valid `hello` within 10 seconds of the
  upgrade, closes the socket with 4401. The `ping` keepalive is never a first message (section 11).
- After `ready`, a phone sends only binary messages, of at most 65,532 bytes each (section 9),
  besides the `ping` keepalive. Any other text message closes its socket with 4400.
- The Mac never takes a phone's identity from `open`. The phone proves who it is inside the
  session, with its own hello to the Mac's relay listener (A5a), so the device in `open` is only
  bookkeeping (RT-9).
- A device has one socket. When a newer socket says `hello` for the same device, the older one closes
  with 4409, and the Mac gets `close` for the old stream, with the reason `replaced`, before `open`
  for the new one. Two copies of one phone therefore keep replacing each other, which is the only
  sign of a copied device that the relay can give (RT-4).
- When a phone socket with a stream closes, for any reason other than the Mac's own `close`, the
  relay sends the Mac `close` with that stream.
- After `ready`, the relay sends a phone only binary messages, except for one `host` message just
  before it closes the socket with 4404.

## 7. Streams and frames

- A stream is one phone socket's session. The relay numbers it with a random 32-bit value that no
  open stream on that object is using.
- Between the Mac and the relay, in both directions, a binary message is a stream frame: the stream
  number as 4 big-endian bytes, then the payload. Between a phone and the relay, a binary message is
  the payload alone. The relay adds the stream number on the way to the Mac and removes it on the way
  to the phone.
- For example, stream `0x01020304` (16,909,060) with the payload `09 08` is the frame
  `01 02 03 04 09 08`. A frame may have an empty payload, and carries at most 65,532 payload bytes,
  in either direction (section 9).
- The relay sends the Mac `open` for a stream before it forwards the first byte on it.
- The relay keeps the order of a stream's messages. It never splits, joins or reads a payload.

## 8. What a phone is told when the Mac cannot take it

| The Mac | The `host` message the phone gets, before close 4404 |
| --- | --- |
| Its socket is open and its last status is `paused`, `sleeping` or `off` | That state, with that status's `at` |
| It has no socket, and its last status is `paused`, `sleeping` or `off` | That state, with that status's `at` |
| It has no socket, and its last status is `available`, or it never sent one | `offline`, with `at` set to when the relay last saw the Mac, or with no `at` if it never has |

- The relay last saw the Mac at its `hello`, when its socket closed, and at each alarm while its
  socket is open (`lastHostSeen`).
- A `status` of `off` also closes every phone socket, each after a `host` message with the state
  `off` (GS-41-AC06).
- When the Mac's socket closes, other than by being replaced, every phone socket gets the `host`
  message the table gives, then closes with 4404.
- `paused` and `sleeping` change only what a new phone is told. While it is paused, the Mac drops its
  relayed sessions itself (A5a), and its paused notice inside the session reaches the phone first.
- `at` is informational. No state says that the Mac stopped or that the relay can wake it (RT-20).

## 9. Limits

These values are provisional until the owner sets final ones (D12, gate G9). They follow the
threat model's rows RT-1 and RT-2 and its section 6.

| Limit | Value | When it is reached |
| --- | --- | --- |
| Message size, text or binary, on every hop | 65,536 bytes. Because the relay adds or removes the 4-byte stream number, a stream carries at most 65,532 payload bytes per message, in either direction | The relay closes with 4413 a socket that sends a message it could not forward within 65,536 bytes: over 65,536 bytes from the Mac, or over 65,532 bytes from a phone. The Mac and the phone may each refuse any message over 65,536 bytes |
| Time to authenticate | 10 seconds from the upgrade | 4401 |
| Unauthenticated sockets per object, Mac and phone sockets together | 4 from one source group, 16 in all | The upgrade gets 429 |
| Registered devices per Mac | 8 | `error` with the code `device_limit` |
| Phone sockets per Mac | 8 | A further phone's `hello` gets close 4429 |
| Bytes per Mac per UTC day, counting every message the object receives on an authenticated socket, so a stranger who knows the host id cannot spend it | 1 GiB (1,073,741,824 bytes), counted approximately | Every phone socket closes with 4429, and each new phone's `hello` gets 4429 until the next UTC day. The Mac's socket stays open |
| Mac socket upgrades | 10 per 60 seconds per source group | 429 |
| Phone socket upgrades | 60 per 60 seconds per source group | 429 |
| Stored state | Deleted once no Mac socket is open and the relay last saw the Mac more than 30 days ago. Byte counts older than two days are pruned | The object forgets the Mac's key, devices and status |

A source group is one IPv4 address, or one IPv6 /64 prefix, never a whole IPv6 address (RT-1).

**The kill switch.** Every relay route answers 503 `{"error":"relay_disabled"}` unless the
environment's `RELAY_ENABLED` is exactly `"1"`. A relay that finds itself switched off while a socket
is open closes that socket with 4503.

## 10. Close codes

| Code | Swift (`RemoteRelayCloseCode`) | Meaning |
| --- | --- | --- |
| 1000 | | A normal close: the Mac closed the stream, or a side stopped |
| 4400 | `badRequest` | After authentication, a message the relay knows but cannot read |
| 4401 | `unauthenticated` | Authentication failed or did not finish within 10 seconds: an unreadable `hello`, a key that does not hash to the host id, a bad signature, an unknown device or a wrong token |
| 4403 | `revoked` | The Mac revoked this device, or changed its token |
| 4404 | `hostUnavailable` | The Mac cannot take the phone. A `host` message came first |
| 4409 | `replaced` | A newer socket took over: the Mac's, or this device's |
| 4413 | `tooLarge` | A message over the size limit: 65,536 bytes from the Mac, 65,532 bytes from a phone |
| 4429 | `overBudget` | The daily byte budget is spent, or the phone socket limit is reached |
| 4503 | `disabled` | The kill switch went off while the socket was open |

A close may carry a short reason text. Receivers act on the code alone.

The relay sends the Mac one `error` code, `device_limit`. The `reason` in a `close` sent to the Mac
is `closed`, `replaced`, `revoked`, `too_large`, `over_budget`, `disabled` or `off`, and is only for
the log: the Mac treats a reason it does not know as `closed`.

## 11. Keepalives

The relay answers the text message `ping` with the text message `pong`, without waking the object
(A4b). Either side may also send WebSocket ping frames, which the other answers with pong frames, as
RFC 6455 requires. `ping` and `pong` are not JSON, and a receiver skips them before it decodes a
message. Either socket may send `ping` at any time, before `ready` included: it never counts as a
first message, or as a text message that sections 5 and 6 refuse.

## 12. The grant

A phone learns the relay's address and its credentials only inside the end-to-end session, in the
Mac's welcome (A5b). The grant (`RemoteRelayGrant`) holds:

- `url`: the relay's base URL, an origin that is always `wss://` (a Debug build may use `ws://` to a
  private address, A5b). The phone adds the route from section 3.
- `hostID`: the Mac's host id.
- `deviceToken`: this phone's 32-byte device token.

The grant is not a relay message. It is JSON inside the session, written by Swift's own encoding, so
its `deviceToken` is standard base64. The relay never sees the grant: it sees the token only in the
phone's `hello`, inside the outer TLS, and keeps only its hash.

The Mac puts a grant in a welcome only while its relay socket is ready, and only after it has sent
that device's `device` message on it. The relay never acknowledges `device`, and a phone that dials
before its device is registered is refused with 4401, which costs it the relay until its next LAN
welcome (A6).

A phone decodes a grant whole or not at all. If any field is missing or malformed (an unreadable
address, a host id that is not 43 base64url characters, or a token that is not 32 bytes), the
grant's address becomes one that no relay check accepts. The phone then never dials it, keeps its
LAN path, and takes a fresh grant from the Mac's next welcome. A printed or logged grant, and a
printed or logged phone `hello`, show the token as `redacted` (RT-4).

## 13. Receiving

- **The Mac and the phone** ignore a message whose `t` they do not know, whose `v` is not 1, or that
  lacks a required field or carries one they cannot read. In Swift, that message decodes as
  `unknown`. A missing or unreadable optional field takes its default.
- **The relay** follows sections 5 and 6. From the Mac, it ignores unknown types and versions, and
  closes the socket with 4400 on a message it knows but cannot read. From a phone, anything but a
  readable `hello` first closes the socket with 4401, and a text message after `ready` closes it with
  4400. The `ping` keepalive is the one exception to both (section 11).

## 14. What the relay keeps and logs

The relay object keeps only what the threat model's section 6 lists: `hostKey`, `devices` (each
with its token hash, and with A7 its push token and environment), `status`, `lastHostSeen` and
`usage:<YYYY-MM-DD>`. It never stores a raw token, a nonce, a signature or a byte of a session.

Besides storage, each socket carries an attachment that lives only as long as the socket. While a
socket waits to authenticate, its attachment holds that socket's nonce, the host id and the
Worker's digest of the upgrade's source group (section 9), never the address itself. All three are
dropped when the socket authenticates.

The relay logs nothing that contains a key, a token, a token hash, a nonce, a signature or the
bytes of a frame (A4b, A4c).

## 15. Test vectors

[`apps/api/test/fixtures/relay-v1-vectors.json`](../apps/api/test/fixtures/relay-v1-vectors.json) holds:

- `wire`: the version, the message size limit, the stream header size, the payload limit and the
  token length.
- `closeCodes`: every close code under its Swift name, so the Worker and the apps cannot disagree on
  a number unnoticed.
- `httpErrors`: the answers a relay route gives before an upgrade (section 3).
- `hostKey`: a P-256 key as a JWK private key (`privateJwk`), its X9.63 public key, and its host id.
- `hostChallenge`: a nonce, the exact string the Mac signs for it, and a valid raw signature.
- `deviceToken`: a device id, a 32-byte token and the token's hash.
- `streamFrames`: stream frames in hex, one with a stream number above 2^31 and one with an empty
  payload.
- `messages`: one example of every message, grouped by direction. The Mac's `hello` carries the
  challenge's signature, so it doubles as a recorded hello for the replay test (A4b), and the phone's
  `hello` carries the token whose hash the `device` example registers.

**Every key, token, nonce and signature in that file is test-only.** They were generated once with
CryptoKit for these vectors and sign nothing outside the tests. No build uses them. The private key
is a JWK so that WebCrypto can import it (`importKey("jwk", ...)`).

## 16. Versions

This is version 1: paths under `/relay/v1/`, and `"v":1` in every message. A new message type or a
new optional field can join version 1, because an older peer ignores both. Any other change needs
version 2, under `/relay/v2/`, served beside version 1 for as long as older builds remain.
