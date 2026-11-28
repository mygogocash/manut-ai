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

GoSpark again (at `a7537c80`, read in the checkout on the owner's Mac on 26 Nov 2026) for the sounds (item 131,
`apps/desktop/src/sound/`, `docs/sounds.md`): the notes, partials, envelopes, durations and volumes of `ToneSynth.swift`,
`FinishChime.swift`, `SettleChime.swift`, `EffortChime.swift` and `TooltipSound.swift`, ported to Web Audio with their
numbers unchanged; and the five selectable notification tones (Heaven, Highwire, Iridium, Krypton, Kzurb Sonar) from the
Android Open Source Project (`platform/frameworks/base` at `1cdfff555f4a21f71ccc978290e2e212e2f8b168`, Apache-2.0;
Highwire and Kzurb Sonar credit Dr. MAD), which GoSpark had converted to AIFF and `afconvert` turned into WAV here
(`apps/desktop/src/assets/sounds/`; their hashes are in `AndroidSoundSources.json` and the licence is in
`apps/desktop/THIRD_PARTY_NOTICES.md`).

GoSpark again (at `a7537c80`, read in the checkout on the owner's Mac on 26 Nov 2026) for the chat box's effort card
(item 132, `apps/desktop/src/chat/box/EffortCard.tsx`, `effort.ts`, `ultrathink.ts`): `ModelEffortButton`,
`EffortSliderCard`, `EffortSlider`, `EffortBrand` and `visibleEfforts` / `defaultEffort` from
`GoGoCode/Views/Composer/EffortSlider.swift`, and `UltrathinkDraft.swift`, ported to React and this app's tokens with
their rules (the title words, the default, the nearest stop, the brand at the top level, and when the Ultrathink line may
be added or taken out); its sizes and spacing are GoSpark's, its moves the Motion board's.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for Grok as a chat (item 101b, `apps/desktop/src-tauri/src/acp_chat.rs`
and `sessions.rs`): no code, the facts its adapters hold. From `ACPSession.swift`, that Grok's ACP server is `grok agent
stdio` and is started supervised as `grok --permission-mode default agent stdio`; from `ACPToolMapping.swift`, that Grok
names a call's tool in `_meta["x.ai/tool"]` (`kind`, else `name`: `bash`, `search_replace`, `write_file`, `edit_file`,
`read_file`) rather than in `kind`; and from its migration plan (`docs/plans/migrate-from-grok-muse-2026-09-25.md`), what
Muse Code is and where it keeps its settings and sessions.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for the helper lanes' rules (item 102d,
`apps/desktop/src/jobs/rules.ts`): Buddy's round queue (`BuddyBatchQueue` in `GoGoCode/Models/BuddyBatching.swift`), its budget
(`BuddyBudget` in `GoGoCode/Models/Buddy.swift`, with how `ThreadRuntime.swift`, `OpenAICompatibleSession.swift` and
`APIKeyToolTally` apply it, and `BuddyHangWatchdog.answeredGrace`), its head cap (`BuddyHeadCap`), its landing predicates
(`BuddyLanding`), what `BuddyPrompts.reportMessage` tells the lead about each head, and `BuddyFailureClass` with its fragments,
ported to TypeScript with their numbers; and their tests (`BuddyBatchingTests`, `BuddyHeadCapTests`, `BuddyReportTests`,
`BuddyFailureClassTests`, `BuddyBudgetTests`, the tally in `APIKeyToolsTests`), ported case by case as tables in `rules.test.ts`.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for a helper lane's snapshot of its lead's folder (item 102f,
`apps/desktop/src-tauri/src/lane_helper.rs`): `Git.captureTree()` (a temporary `GIT_INDEX_FILE` copied from the real index,
`add -A`, `write-tree`), `commitTree` and `captureCheckpoint` (`commit-tree` on top of HEAD under the app's own name, kept by a
ref of the app's own) in `GoGoCode/Git/Git.swift`, and the isolated copy each Buddy head starts from (`makeBuddyCopy` in
`GoGoCode/App/AppModel+Buddy.swift`, `BuddyCopySnapshots` in `GoGoCode/Models/BuddyCopySnapshot.swift`), rewritten in Rust.
Here the ref is under `refs/manut/helpers/` and the copy is a worktree on a branch of its own rather than a detached one.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for the helper blocks (item 102e,
`apps/desktop/src/jobs/helperBlocks.ts`): Buddy's delegation block parser in `GoGoCode/Models/Buddy.swift`
(`delegationOutcome`, `streamingOutcome`, `partialDelegations`, `delegatingReply`, `displayText`, `withoutDelegationBlock` and
`firstDelegationBlock`'s nested fences), ported to TypeScript and made stricter, walked with the fork's own top-level fence walk
(`hideSplitBlocks`, from Oh My Hermes); its tests (`BuddyDelegationTests`, `BuddyDelegationFenceTests`,
`BuddyStreamingDelegationTests` and the `delegatingReply` cases of `BuddyHeldBackTests`), ported case by case as tables in
`helperBlocks.test.ts`; and its `fallbackPolicy`, adapted as the lead's note (`apps/desktop/src/jobs/helperPolicy.ts`).

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for landing a helper lane's work in its lead's folder (item 102g,
`apps/desktop/src-tauri/src/lane_land.rs`): `BuddyLand.applyHeadWork`, `foreignTarget`, `pathsOutside`, `excludingBuildOutput`
and the kept patch written owner-read-only (`GoGoCode/Models/BuddyLandingApply.swift`), `TouchedPaths.isBuildOutput`'s cache
names (`GoGoCode/Git/TouchedPaths.swift`), `Git.apply` (a three-way apply against a throwaway copy of the index, its conflicts
read from it) and `captureTree` (`GoGoCode/Git/Git.swift`), and one writer per checkout with a copy never taken mid-patch
(`BuddyCheckoutGate`, `CheckoutCoordinator` in `GoGoCode/Git/CheckoutCoordinator.swift`, `AppModel.landBuddyHead` in
`GoGoCode/App/AppModel+Buddy.swift`), rewritten in Rust; their tests (`BuddyLandingTests`, `BuddyCheckoutGateTests` and
`pathsOutsideTheCheckout` in `BuddyForeignPatchTests`), ported against temporary repositories in `lane_land.rs`. Here the cut
is made in the index before the patch, a landing is kept so it can be taken back, and the kept patch is under `~/.manut/patches`.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for running helper lanes (item 102h,
`apps/desktop/src/jobs/helperRuns.ts` and `helperBrief.ts`): a helper lane's brief is `delegatedHeadPrompt` with the own-copy
case of `workplaceRules`, `howToWork` and `howToReport` (`GoGoCode/Models/Buddy.swift`), and the budget's three notes are
`BuddyBudget.pacingNote`, `wrapUpNote` and `finalNote` (its final note without "your tools are gone", since a helper lane keeps
its tools for its report), written through the four dictionaries.

GoSpark again (at `a7537c80`, the same checkout, 27 Nov 2026) for the relay's Web Push (item 78d,
`apps/api/src/web-push.ts`): the ES256 token signed with WebCrypto, whose raw `r || s` signature is used as the JWS
signature as it comes (`fakeTokenOnce` in `docs/plans/worker-apns-spike-probe.ts`), here as RFC 8292's VAPID token for
Web Push instead of an APNs provider token; and its threat model's push rows (RT-11, RT-12), followed with Web Push in
place of APNs.

The Agent Client Protocol's agent registry (Apache-2.0, `agentclientprotocol/registry`, release `v2026.11.26-3667256` at
commit `36672565f76e7fb9796eb15182e0e14fb9e77c33`) for Settings › Providers › From the ACP registry (item 101c): its
published `registry.json` is pinned byte for byte in `apps/desktop/src-tauri/acp-registry/` with its `quarantine.json`
read into `pin.json`, and its `FORMAT.md` read for the fields and platform targets; its licence is in
`apps/desktop/THIRD_PARTY_NOTICES.md`. Each agent it lists keeps its own licence. T3 Code again (MIT, at `ae945dd`) for the
registry's search: `searchRank` in `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`, lifted as `searchRank`
in `apps/desktop/src/settings/agents/acpRegistry.ts`; its live fetch, downloads and `npx` runs were read and left out.

Paradev (MIT, Copyright (c) 2025-2026 Superset Inc., `paradevai/paradev` at `2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20`)
for item 138's study of the code mode (`docs/paradev-parity.md`), and for the code item 148 lifted from it, each file with its tests
ported from bun:test to vitest and its Paradev notice kept in its header: `packages/shared/src/leaked-input-mode-reclaim.ts`
(`apps/desktop/src/sessions/term/leaked-input-modes.ts`, which decides what a killed agent left on: the Kitty keyboard protocol,
mouse and focus reporting) with the cases of `apps/desktop/src/renderer/lib/terminal/terminalInputModeReclaimer.ts`'s test;
`apps/desktop/src/renderer/lib/terminal/terminal-copy.ts` with `terminal-copy.test.ts` and `terminal-copy.ghostty.test.ts`
(`engine-copy.ts`: copying by Ghostty's whitespace rules, whose own `selectionString` tests at Ghostty `e88c6c099` are among
the cases); `packages/shared/src/terminal-link-parsing/link-parsing.ts` and `fallback-matchers.ts` with their tests
(`link-parsing.ts` and `link-fallbacks.ts`), `apps/desktop/src/renderer/lib/fileLocation/fileLocation.ts`
(`file-location.ts`) and `apps/desktop/src/renderer/lib/terminal/links/buffer-helpers.ts` (`link-buffer.ts`). Paradev's
`local-link-detector.ts`, `link-resolver.ts` and `link-detector-adapter.ts` were read and written again as
`engine-paths.ts`, around the shell's own check of the files; its `bareWebUrl` (which needs the `tldts` package), `pathText`,
word and styled-text links were left out. Its link parser is VS Code's (`terminalLinkParsing.ts`, `terminalLinkHelpers.ts`,
MIT, Copyright (c) 2015 - present Microsoft Corporation, which stays in those files' headers); the licences are in
`apps/desktop/THIRD_PARTY_NOTICES.md`. Later items name what they lift here too; the study lists the candidates, among them
VS Code's fuzzy scorer as Paradev ported it, which keeps Microsoft's MIT notice beside Paradev's.
Item 146 (review in the pane beside a lane) took one more thing from it, a form: its line that names where a comment on selected
lines is, `<path>:L<start>-L<end>` with a few words for deleted lines and for a range across deletions and additions
(`formatAgentPromptWithFileContext`, `apps/desktop/src/renderer/hooks/host-service/useSendToTerminalAgent/useSendToTerminalAgent.ts`),
written here as `atText` in `apps/desktop/src/chat/box/carry.ts`, the first line of a note's quote, with its words changed to say
which file's numbers the lines are; and it read, to write anew, its Changes pane's scope control (all changes, uncommitted, one
commit; `DiffPaneScope`, `ChangesScopeControl`). Its diff library `@pierre/diffs` is not used.
Item 167a (lanes in the side menu) took, at `b0b0cdc6bd7eadf205a3fe8c45801affefbd89c5`, its previous and next workspace keys and
their rule (`PREV_WORKSPACE` and `NEXT_WORKSPACE` in `apps/desktop/src/renderer/hotkeys/registry.ts`: ⌘⌥↑ and ⌘⌥↓ on macOS,
Ctrl+Shift+Alt with the arrow elsewhere, through the sidebar's order and wrapping at its ends, as
`useDashboardSidebarShortcuts.ts` steps), as the `lane-prev` and `lane-next` actions of `apps/desktop/src/app/keys.ts`; and it read
its workspaces sidebar's rows (one line, a status glyph before the name, actions on hover) for the menu's lane rows, drawn in Manut
AI's look (`apps/desktop/src/sidebar/MenuLanes.tsx`).

Item 167d (keys where the actions are) read, to write anew in this app's own registry and look, Paradev's `hotkeys/display.ts` (a
chord as a cap for each key), `CommandPaletteFooter`, `WorkspaceEmptyState`, `HotkeyTooltip` and `HotkeyLabel`, and the keys settings
page's groups and search, all at `b0b0cdc6bd7eadf205a3fe8c45801affefbd89c5`; no file of Paradev's was lifted for it.

Libraries added for one feature are named here too: `qrcode` 1.5.4 (MIT, soldair/node-qrcode), already the web app's,
pinned in the desktop for the pairing code's QR image (`apps/desktop/src/remote/QrCode.tsx`, lifted from
`apps/web/src/ops/QrCode.tsx`); only its `create` is used, which returns the modules and reaches no network; `objc2-speech`, `objc2-avf-audio` and `objc2-av-foundation`
(the objc2 project's bindings to Apple's Speech, AVFAudio and AVFoundation frameworks, Zlib OR Apache-2.0 OR MIT), which
reach the Mac's own speech recognition and the microphone for voice in the chat box (`apps/desktop/src-tauri/src/voice.rs`,
`docs/voice.md`); and `tauri-plugin-global-shortcut` 2.4.1 with `global-hotkey` 0.8.0 (Tauri's own, Apache-2.0 OR MIT),
on the Mac only, which registers the snapshot key a person turns on in Settings › Computer
(`apps/desktop/src-tauri/src/computer/snap.rs`, `docs/computer-use.md`, item 104).
