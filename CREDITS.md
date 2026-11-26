# Credits

Manut AI is built on other people's good work. This file names every project we took code, ideas, wording or test vectors from, what we took and under which licence. It moved here from the README on 26 Nov 2026, word for word. The desktop app's own notices are in [`apps/desktop/NOTICE.md`](apps/desktop/NOTICE.md) and [`apps/desktop/THIRD_PARTY_NOTICES.md`](apps/desktop/THIRD_PARTY_NOTICES.md), which also list the coding agents' and editors' marks (Lobe Icons, MIT; Simple Icons, CC0).

## Where each part started

| Path | What it is | Started from |
| --- | --- | --- |
| `apps/api` | Cloudflare Workers backend: tenants, members, tasks with exact-action approvals, a one-use dispatch broker, an encrypted credential vault, schedules, retention | GoSpark's `cloud/` at `a7537c80`, lifted whole |
| `apps/web` | The owner's approval page (`/approve/:token`), the page an invite link opens (`/join/:token`, off until signing in by email is on), the owner's web app for the phone's home screen (`/app/`, `docs/web-app.md`, off until signing in by email is on) and the operator console (`/ops`), served from the API's own origin by a pages Worker behind the API Worker | The design canvas's classes and states; the desktop's reading of approvals (`apps/desktop/src/runtime/http/approvals.ts`) |
| `apps/desktop` | The desktop app (Tauri 2 + React 19): shell, chat, Needs you, terminal and coding-agent adapters, running on a demo runtime until the real one exists | A fork of Oh My Hermes (`apps/omher` at `77b8646`), Hermes bridge removed |
| `packages/approval-core` | Settle-once approval rules shared by every client | GoSpark's decision binding and Orca's settle-once journal |
| `packages/agent-events` | The one event contract every agent reports through, with tolerant decoders and a timeline reducer | GoSpark's provider events (`ProviderSession.swift`) and their tests |
| `packages/format` | How the app writes money and times (satang to text, typed text to satang, VAT split, relative times) | Written for Manut AI |
| `packages/notify-rules` | What the app may show outside its window: notifications, buttons, quiet hours, hidden details, the Dock badge | Written for Manut AI |
| `packages/promptpay` | PromptPay QR payloads for manual payments | dtinth/promptpay-qr's format and test vectors |
| `packages/remote-channel` | A paired phone's channel to the Mac through the relay: pairing, an encrypted session, the one-use challenge a passkey signs for one Allow | GoSpark's pairing proof and decision challenges with their tests; WebAuthn Level 3's test vectors |
| `packages/ui-kit` | Design tokens and component classes | The design canvas (`app.css`, `tokens.json`) |
| `docs/pilot-api.md` | The contract between `apps/api` and `apps/web` | |


## What we took, and from whom

Code lifted from other projects keeps its notice here: GoSpark (`mygogocash/gospark`, our own; for the Mac App Store build, its App Store work as read in the checkout on the owner's Mac on 26 Nov 2026: the password database's home, Claude Code's scratch folder in the sandbox, and the package checks in `apps/desktop/scripts/appstore-mac.sh`); Oh My Hermes
(MIT, `apps/desktop`, see its `NOTICE.md` and `THIRD_PARTY_NOTICES.md`; its `omher-release.yml` for the release workflow's tag check and target matrix, `.github/workflows/release-desktop.yml`); Orca (MIT) as its code arrives; dtinth/promptpay-qr (MIT) for the PromptPay format and test vectors. T3 Code (MIT, `pingdotgg/t3code` at `dca3ab2`) for the
idea behind an added account's home: Codex's own home shared entry by entry as links, its sign-in kept apart
(`apps/desktop/src-tauri/src/accounts.rs`, `share`; rewritten in Rust with an allow-list, no code copied); and for the
idea of the sidebar's places (pinned on top, snoozed and done-for-now below, an archive, the pull request on a row, a suggested
next message): `apps/desktop/src/sidebar/rows.ts`, written here from the description, no code copied; and (at `1c3f0ee`) for
Settings › Providers' layout and field names (a list of the agents with a switch each; for the chosen one a display name,
the program's path, its home folder, launch arguments and environment variables whose values are never sent back):
`apps/desktop/src/settings/providers/` and `src-tauri/src/providers.rs`, read for behaviour and wording, no code copied. T3 Code again (MIT, at `8f5fd28`) for
Settings › Source control (item 75): the page's shape and its words (Automatically pull, keeping the default branch current
when the checkout has no local changes or commits; Default merge method with the last one chosen; Remove agent credits when
merging, keeping human co-authors), and `removeAgentCredits` with its tests and its list of agent addresses and names
(`packages/source-control-core/src/server/mergeMessage.ts`), ported to Rust in `apps/desktop/src-tauri/src/credits.rs` and
`apps/desktop/src/lib/agentCredits.json`. T3 Code again (MIT, at `b61af8a`) for Settings › Workflows (item 77b): the
Labs switch that is off by default and runs nothing in the workflows folder while off, "Skipped runs kept" with its bounds,
a time missed while the app was down kept as skipped rather than made up, and "Run workflow" in the command palette
(its `docs/user/workflows.md`, `apps/server/src/workflows/triggers.ts` and `packages/contracts/src/settings.ts`, read for
behaviour and wording); `apps/desktop/src/workflows/` and `src-tauri/src/workflows.rs` are written here, with a JSON file of
plain-text steps in place of its TypeScript workflows, no code copied. T3 Code again (MIT, at `e75534b`) for the sidebar as an
inbox (item 94): undoing a settle, a snooze, a pin or an archive (`packages/client-runtime/src/state/threadUndo.ts`), a snooze
until a picked time with its check that the date and time exist and are ahead (`resolveCustomSnooze` in `threadSettled.ts`,
lifted into `pickedTime` in `apps/desktop/src/sidebar/rows.ts`), a Working group and settling by itself (`threadInbox.ts`, read
for behaviour); the rest of `rows.ts`, `selection.ts` and `inbox.ts` is written here. Orca
(MIT, Copyright (c) 2026 Lovecast Inc., `stablyai/orca` at `a634526a1d0995af34a75cc4845e3eef17610085`) for computer use
(`apps/desktop/src-tauri/src/computer/`, `docs/computer-use.md`): its command names as the MCP tools, its
`orca-computer-use` skill adapted as `computer/SKILL.md`, the macOS shortcuts it never sends
(`computer-blocked-key-combos.ts`, which Orca ported from vercel-labs/agent-desktop, Apache-2.0), its lock check
(`SessionLockProbe.swift`), the window number through `_AXUIElementGetWindow` (`AccessibilityWindowIdentity.swift`),
the window picture and which windows count (`main.swift`), and the two System Settings addresses.

GoSpark again (at `a7537c80`) for the remote channel (item 78a, `packages/remote-channel`): `RemoteAuthentication.proof` and
`RemotePairingInvitation` (`Shared/Remote/RemoteHandshake.swift`), `RemoteDecisionChallenges` and the refusals in
`Tests/Shared/RemoteAuthenticationTests.swift`, ported to TypeScript and Web Crypto; and the W3C Web Authentication Level 3
specification's section 16 test vectors (read 25 Nov 2026), copied into its tests. GoSpark again (at `a7537c80`) for the
Mac's side of it (item 78b, `apps/desktop/src/remote/`): `RemoteEventJournal` (the last 500 events or 1 MB a chat, catch-up
from a cursor or the whole chat again), ported as `journal.ts` with its rules; the consent sheet's points, their order and
the consent kept with the version of its words (`RemoteRelayConsent.swift`, `Shared/Remote/RemoteRelayNotice.swift`),
reworded for this app with the operator's sentence left for the owner; and `docs/relay-protocol-v1.md` and
`docs/security/remote-relay-threat-model.md`, copied into `docs/` with a note on where this app differs.

GoSpark again (at `a7537c80`, read in the checkout on the owner's Mac on 26 Nov 2026) for Cursor and Antigravity as chats
(item 101a, `apps/desktop/src-tauri/src/acp_chat.rs`, `ask_tool.rs`, `providers.rs`): no code, the facts its adapters
hold. From `AntigravitySession.swift`, Antigravity's own input names (`CommandLine`, `TargetFile`, `AbsolutePath`,
`Query`, `Url`) and reading its sign-in from `agy models` (a list of model ids when signed in, the words that mean it is
not); from `ACPSession.swift`, that an agent's `session/new` reports its modes and models both as `modes` and `models`
and as configuration options, and that a mode is set with `session/set_config_option` or else `session/set_mode`.

Libraries added for one feature are named here too: `qrcode` 1.5.4 (MIT, soldair/node-qrcode), already the web app's,
pinned in the desktop for the pairing code's QR image (`apps/desktop/src/remote/QrCode.tsx`, lifted from
`apps/web/src/ops/QrCode.tsx`); only its `create` is used, which returns the modules and reaches no network; `objc2-speech`, `objc2-avf-audio` and `objc2-av-foundation`
(the objc2 project's bindings to Apple's Speech, AVFAudio and AVFoundation frameworks, Zlib OR Apache-2.0 OR MIT), which
reach the Mac's own speech recognition and the microphone for voice in the chat box (`apps/desktop/src-tauri/src/voice.rs`,
`docs/voice.md`).
