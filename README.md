# Manut AI

One app for Thai shop owners: a chat with Buddy, an AI team that does the work and asks before anything public,
costly or irreversible, and a code editor. This repository starts with the pilot (December 2026): a concierge
service over LINE, where operators play the team and owners approve each reply from a link.

The plan this follows is the implementation plan doc ("Manut AI: implementation plan (reuse first)"). The screen
spec is the Manut AI design canvas.

## Layout

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
| `packages/ui-kit` | Design tokens and component classes | The design canvas (`app.css`, `tokens.json`) |
| `docs/pilot-api.md` | The contract between `apps/api` and `apps/web` | |

## Run it

```bash
pnpm install          # only esbuild and workerd may run install scripts (pnpm-workspace.yaml)
pnpm test             # every package's tests
pnpm typecheck
pnpm --filter @manut/web dev    # the web app against an in-memory fake of the API
pnpm --filter @manut/web e2e    # the owner's pages in WebKit and Chromium at phone sizes (docs/phone-pass.md)
pnpm --filter @manut/api dev    # both Workers on localhost:8787: the API and the web app on one origin
```

Set `VITE_API_ORIGIN` to point the web app at a running backend, or to `same-origin` for the API that served
the page. The backend's tests run in real workerd (`pnpm --filter @manut/api test`), followed by two contracts
on local Workers: the admin gate, and the one-origin configuration, pages and front door (`docs/pilot-api.md`). Nothing here
deploys anything.

## Deploying

Dev is deployed at `https://dev.manut.xyz` (staging and production are not). `apps/api` deploys two Workers per environment: the pages Worker
(`wrangler deploy -c wrangler.web.jsonc --env dev`, which builds the web app first) and then the API Worker
(`wrangler deploy --env dev`), the front door that hands every non-API path to the pages
(`docs/pilot-api.md`, "One origin"). Before the first deploy: create the Wrangler secrets (`CLOUD_API_KEY`,
`APPROVAL_LINK_SECRET`, and the vault key `CRED_KEY`); give the API Worker the host's route; put `/ops` and
`/v1/admin/*`, and nothing else, behind one Cloudflare Access application and set `ADMIN_ACCESS_AUD` to its
audience; set `WEB_ORIGIN` and `PUBLIC_API_ORIGIN`, both that host's origin; and turn on the feature flags the
pilot needs. The worker names are `manut-api-*` and `manut-web-*`, so a deploy from here can never replace one
of GoSpark's services.

## Credits

Code lifted from other projects keeps its notice here: GoSpark (`mygogocash/gospark`, our own); Oh My Hermes
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
plain-text steps in place of its TypeScript workflows, no code copied. Orca
(MIT, Copyright (c) 2026 Lovecast Inc., `stablyai/orca` at `a634526a1d0995af34a75cc4845e3eef17610085`) for computer use
(`apps/desktop/src-tauri/src/computer/`, `docs/computer-use.md`): its command names as the MCP tools, its
`orca-computer-use` skill adapted as `computer/SKILL.md`, the macOS shortcuts it never sends
(`computer-blocked-key-combos.ts`, which Orca ported from vercel-labs/agent-desktop, Apache-2.0), its lock check
(`SessionLockProbe.swift`), the window number through `_AXUIElementGetWindow` (`AccessibilityWindowIdentity.swift`),
the window picture and which windows count (`main.swift`), and the two System Settings addresses.

Libraries added for one feature are named here too: `objc2-speech`, `objc2-avf-audio` and `objc2-av-foundation`
(the objc2 project's bindings to Apple's Speech, AVFAudio and AVFoundation frameworks, Zlib OR Apache-2.0 OR MIT), which
reach the Mac's own speech recognition and the microphone for voice in the chat box (`apps/desktop/src-tauri/src/voice.rs`,
`docs/voice.md`).
