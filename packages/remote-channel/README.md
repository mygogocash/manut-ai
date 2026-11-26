# @manut/remote-channel

The channel between a paired phone and the Mac (`docs/remote-access.md`, item 78a). The desktop's page and the web
app on the phone both use it, to pair, to open an encrypted session through the relay in `apps/api` that the relay
cannot read or change, and to make and check the challenge that binds one Allow, or one answer, to one ask. Pure functions over bytes
with Web Crypto only (`crypto.subtle`, `crypto.getRandomValues`), which the browser, the desktop's webview and Node
all have. No dependency.

## What each export is for

| Export | Who calls it | For |
| --- | --- | --- |
| `newPairingOffer`, `encodePairingOffer`, `pairingLink` | Mac | A new code: host id, a one-use relay door, a 256-bit secret; the link the QR code shows |
| `readPairingLink`, `decodePairingOffer` | Phone | Read a scanned or pasted code |
| `macPairing` → `receiveCommit`, `receiveProof`, `allow` | Mac | Its side of pairing: one try, two minutes; `allow` takes the four digits the person types from the phone, once, and only then gives the channel |
| `startPairing` → `receiveKey`, `receiveConfirm` | Phone | Its side of pairing: spends the code on the phone, then gives the check code to show and a channel |
| `newPairingGrant`, `encodePairingGrant`, `decodePairingGrant` | Mac, phone | Once the code is typed: the phone's device id, its relay door token and K |
| `doorTokenHash` | Mac | The token hash the relay's `device` message registers |
| `startSession` → `receiveWelcome` | Phone | Open a session with K |
| `acceptSession` → `receiveFinish` | Mac | Answer a hello, with the K kept for the device it names |
| `Channel.seal`, `Channel.open`, `Channel.close` | Both | Encrypted, numbered messages, split into relay frames |
| `importSharedSecret` | Both | Turn K into a Web Crypto key that script cannot read back |
| `DecisionChallenges.issue`, `.verify`, `.revoke` | Mac | The one-use 60-second challenge for one decision, the check of the phone's answer, and dropping a device's challenges at Unpair |
| `decisionChallenge` | Phone | Recompute the challenge from what its screen shows, to pass to `navigator.credentials.get` |
| `answerOption` | Both | The choice an answer to a question binds its challenge to: a digest of the exact words |
| `verifyPasskeyRegistration` | Mac | Check the passkey the phone makes at pairing, and keep its key |
| `verifyPasskeyAssertion` | Mac | Check a passkey answer (used by `DecisionChallenges.verify`) |
| `RemoteChannelError`, `REMOTE_CHANNEL_MESSAGES` | Both | The one error, with a fixed sentence per problem |

Times are milliseconds since the Unix epoch, given by the caller. Random bytes come from `crypto.getRandomValues`
unless the caller passes a source, so every test is exact. Throwaway key pairs are always fresh: only
`src/testing.ts`, which `index.ts` does not export and the package's `exports` do not reach, lets a test pass fixed
ones (and play several phones on one code), so no caller can make a handshake reuse a key pair.

## Byte layouts

All integers are big-endian. `||` is concatenation. Labels are ASCII.

**Pairing code** (113 bytes, base64url without padding, 151 characters; in a link after `#pair=`, a fragment no
browser sends to a server): `01` version | host id (32, the SHA-256 the relay names the Mac by) | door id (16, UUID
bytes) | door token (32) | secret (32).

**Pairing** (phone dials through the door; the relay forwards each message as one binary frame):

```text
commit   phone -> Mac   10 01 | SHA-256("manut-remote-v1 pair commit" || phone key)       34 bytes
key      Mac -> phone   11 01 | Mac key (65, uncompressed P-256)                          67 bytes
proof    phone -> Mac   12 01 | phone key (65) | phone proof (32)                         99 bytes
confirm  Mac -> phone   13 01 | Mac proof (32)                                            34 bytes

th          = SHA-256("manut-remote-v1 pair" || host id || door id || commit || key || proof[0..67))
k(label)    = HKDF-SHA-256(IKM = secret, salt = ECDH secret, info = "manut-remote-v1 pair " label || 00 || th)
phone proof = HMAC-SHA-256(k("phone confirm"), th);   Mac proof = HMAC-SHA-256(k("mac confirm"), th)
check code  = (first 4 bytes of k("check code") as a 32-bit number) mod 10000, as four digits
```

The phone shows the check code after the Mac's proof checks out; the person types it into the Mac (`allow`), which
compares it once with its own and never shows its own. A code is one try on each side: the Mac's first commit spends
it on the Mac (as does a wrong or late typed code), and starting pairing spends it on the phone (the door is refused
again in the page and the offer's secret is zeroed). Someone in the middle with the code's secret therefore gets one
chance in ten thousand in all. The package retries nothing.

**Grant** (inside the pairing channel, 82 bytes): `40 01` | device id (16) | door token (32) | K (32).

**Session**:

```text
hello    phone -> Mac   20 01 | device id (16) | phone key (65)                          83 bytes
welcome  Mac -> phone   21 01 | Mac key (65) | Mac proof (32)                             99 bytes
finish   phone -> Mac   22 01 | phone proof (32)                                          34 bytes

th = SHA-256("manut-remote-v1 session" || host id || hello || welcome[0..67)), keys as above with K and "session"
```

**Records**, one per relay frame, at most 65,532 bytes (the relay's `MAX_PAYLOAD_BYTES`):

```text
30 | AES-256-GCM(key, nonce, AAD = 30 01, flags (1) || chunk) with its 16-byte tag
key, IV  = k("phone to mac key"), k("phone to mac iv") (12 bytes), or the "mac to phone" pair
nonce    = IV XOR the record number (64-bit, right-aligned in 12 bytes), never sent
flags    = 00 more chunks follow, 01 last chunk of the message
```

A message is split into chunks of at most 65,514 bytes. A session seals at most 2^24 records each way, and a whole
message is at most 4 MiB unless both sides set less.

**Decision challenge** (what the passkey signs): `SHA-256("manut-remote-v1 decision" || 00 || nonce (32) || len16
device id || len16 request id || u32 revision || len16 option id)`, texts as UTF-8 after a 16-bit length. The
answer names the challenge by the nonce as base64url.

**Answer option** (the option id of an answer to a question): `answer:` || base64url(SHA-256("manut-remote-v1
answer" || 00 || json)), where json is `JSON.stringify(["text", <text>])` for one answer, or
`JSON.stringify(["answers", [[<question id>, <text or null>], ...]])` for an interview, its questions in the order
the ask lists them.

**Passkey answers** are read as WebAuthn Level 3 lays them out: `authenticatorData` = rpIdHash (32) | flags (1: UP
bit 0, UV bit 2, BE bit 3, BS bit 4, AT bit 6, ED bit 7) | signCount (4) | attested credential data (aaguid 16 |
length 2 | credential id | COSE key) only at creation | extensions only with ED; the ES256 signature is DER over
`authenticatorData || SHA-256(clientDataJSON)`. The COSE key must be the spec's CTAP2 canonical ES256 form
`a5 01 02 03 26 20 01 21 58 20 <x> 22 58 20 <y>`.

`test/construction.test.ts` recomputes every layout above straight from Web Crypto, and
`test/__snapshots__/pairing.test.ts.snap` pins one whole pairing byte for byte.

## Where each part came from

| Part | GoSpark (read only, `mygogocash/gospark` at `a7537c80`) |
| --- | --- |
| The code, its 256-bit secret, the 4,096-character link cap | `Shared/Remote/RemoteHandshake.swift`, `RemotePairingInvitation` |
| Proving the secret or K with an HMAC over fresh values | `Shared/Remote/RemoteHandshake.swift`, `RemoteAuthentication.proof` and `verify` |
| One-use, 60-second, at most 16, spent by a wrong answer, bound to device and command | `Shared/Remote/RemoteDecisionChallenges.swift` |
| The device id comes from the proved hello, never the relay's `open` | `docs/security/remote-relay-threat-model.md`, RT-9 |
| Frame limit, token hash, upper-case device ids | `docs/relay-protocol-v1.md`, sections 2, 7, 9; this repository's `relay-object.ts` |
| Printing a grant with its secrets as `redacted` | `docs/relay-protocol-v1.md`, section 12 (RT-4) |
| Refusal tests | `Tests/Shared/RemoteAuthenticationTests.swift` (identity proof, decisions, tampered and replayed commands) |

GoSpark's session was TLS 1.2 with a pre-shared key (`TLS_PSK_WITH_AES_128_GCM_SHA256`), which no browser offers, so
the session and the pairing exchange are built here from these named constructions instead:

- **ECDH on P-256** (SEC 1), **HKDF-SHA-256** (RFC 5869), **HMAC-SHA-256** (RFC 2104), **AES-256-GCM** (NIST SP
  800-38D), all Web Crypto's own.
- **TLS 1.3's PSK with (EC)DHE** (RFC 8446, 4.2.9 `psk_dhe_ke`): a fresh ECDH secret and the pre-shared secret both
  feed HKDF with labels and the transcript hash (7.1), and each side proves the keys with an HMAC over the transcript
  hash, as Finished does (4.4.4). The record nonce is RFC 8446 5.3's, and the record limit follows 5.5: its margin
  of about 2^-57 is for 16 KiB records, and these are up to 64 KiB, so at 2^24 records it is about 2^-54. Unlike
  GoSpark's suite, each session has forward secrecy.
- **A hash commitment before a short authentication string** (ZRTP, RFC 6189, 4.4.1.1; Bluetooth's numeric
  comparison): the phone commits to its key before it sees the Mac's, so the four-digit check code cannot be steered
  by someone in the middle who has the code's secret. The code is typed rather than compared on two screens: a
  photographer who races the real phone leaves it refused with no digits, so there is nothing to type.
- **WebAuthn Level 3** (W3C), sections 7.1 and 7.2, with its section 16 test vectors in
  `test/fixtures/webauthn-l3-vectors.json`; ES256 signatures as RFC 3279's DER `Ecdsa-Sig-Value`.

## Comparisons and errors

- Commitment, both handshake proofs, the typed check code, credential id, RP id hash and the WebAuthn challenge:
  `equalBytes`, which ORs every byte's XOR into one value and reads it once, with no early exit. Lengths are public
  (a typed code of another length is simply wrong).
- AES-GCM tags: inside Web Crypto's `decrypt`; the package never compares a tag itself.
- ECDSA signatures: Web Crypto's `verify`; nothing secret is compared.
- A decision challenge is found by its nonce in a `Map`; the nonce is not secret (the phone is sent it).

Every refusal is a `RemoteChannelError` whose message is one fixed sentence per problem, or a `{ ok: false,
refused }` result for passkeys and decisions. Nothing formats a value into a message, platform errors are replaced,
nothing logs, and a pairing code or grant printed with `JSON.stringify` or Node's printer shows its secrets as
`redacted`.

## What is held as plain bytes

Held as Web Crypto keys that cannot be exported: the code's secret and K once imported (an exportable K is refused),
both confirm keys, both AES keys, and every throwaway ECDH private key.

Held by the package as plain bytes, and zeroed as stated (best effort: JavaScript cannot promise that no copy made by
the engine or Web Crypto survives):

- A `Channel`'s two 12-byte IVs, for as long as it is open; `close` zeroes them.
- `macPairing`'s own copy of the code's secret, until the first `receiveCommit`, which zeroes it whatever it brings.
- The check code's four ASCII digits on the Mac between `receiveProof` and `allow`, and on the phone between
  `receiveKey` and `receiveConfirm`; each is zeroed there, or on a refusal.
- For moments only: the ECDH secret, the derived key and IV bytes, the raw check-code bytes and `importSharedSecret`'s
  copy of its input, each zeroed as soon as it is imported or used.

Not held by the package, and left to the caller: the `PairingOffer` and `PairingGrant` objects with their secrets and
door tokens (`startPairing` zeroes the phone's offer secret; the Mac drops its offer after `macPairing` and
`pairingLink`; the phone imports K with `importSharedSecret` and zeroes the grant's bytes), the link text, the check
code string the phone shows, and the bytes of every opened message. A handshake drops what it held once its step is
read: the phone's session handshake its K and throwaway key at the welcome, the Mac's its keys at the finish.

## What the callers must do (78b, 78c)

- Keep one `MacPairing` per code shown and hide the QR code at its first `receiveCommit`, since the code is spent then.
  Revoke the code's relay door when it expires or pairs. Ask for the four digits the phone shows with a field for
  exactly that, and call `allow` once with what was typed. Count a phone as paired only once its passkey registration
  has arrived over the pairing channel (which shows the phone has the grant).
- On the phone, never retry pairing on its own, and never start again on a code it has started, a reload included
  (`startPairing` refuses only within the page). Send nothing on the pairing channel until the grant arrives.
- At Unpair, the Mac closes every `Channel` of that device id itself and calls `DecisionChallenges.revoke` for it: the
  relay's `revoke` is not trusted to end anything, and a phone that comes another way, such as over Tailscale, has no
  relay at all.
- Treat `channel.deviceId` as who is speaking, never the relay's `open`, and issue decision challenges for that id.
- Send `No` and `Stop` without a challenge, and nothing else: ask for one for an Allow and for every answer to a
  question, a typed answer and a picked choice alike, since an answer steers the agent as much as an Allow does. Bind
  an answer's challenge to its exact words with `answerOption`. Pass the decision on (`settleApproval`, or the
  question's answer) only after `verify` says `ok`, storing its `signCount`, and only if the ask still shows the
  revision the challenge was bound to. If two answers from one device are checked at once, store their counters in
  the order they were checked, or check one device's answers one at a time.
- Refuse a credential id already registered to another device, and keep K, the door token and the passkey record
  where the design says (keychain on the Mac, IndexedDB as non-extractable keys on the phone).
- Close the channel and open a new session on any refusal, on `exhausted`, and when the relay closes the stream. The
  end of a message stream is not authenticated here (as TLS without `close_notify`): the journal's cursors tell a
  phone what it missed.

## Deliberately not here

Storage of any key or record, sockets and the relay link, the relay's own messages, the QR image and scanner, the
app-level messages inside a channel (beyond the grant), UI and words, push, and attestation (the passkey's key
arrives over the authenticated pairing channel, so who made the authenticator is not checked). Backup eligibility
and state are read only to refuse a backed-up credential that says it cannot be.
