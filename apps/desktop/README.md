# apps/desktop

Manut AI's desktop app: Tauri 2 with a React 19 front end. It is a fork of **omher**, the desktop app of
[Oh My Hermes](https://github.com/rlaope/oh-my-hermes) (`apps/omher` at commit `77b8646`, version 1.1.3, MIT).
`NOTICE.md` carries their licence and says what the fork changed; `THIRD_PARTY_NOTICES.md` carries the notices of the
fonts and terminal themes the app ships.

This is the first pass of the fork: the app copied in, renamed, cut loose from Hermes, and restyled with the design
tokens. The screens are still omher's (a list of bots, a chat, terminals, tasks). Turning them into Manut AI's
screens is the next pass.

## Run it

```bash
pnpm --filter @manut/desktop dev         # the front end in a browser, http://localhost:5207
pnpm --filter @manut/desktop typecheck
pnpm --filter @manut/desktop test        # vitest
pnpm --filter @manut/desktop tauri dev   # the desktop app (needs Rust; compiles src-tauri)
```

The app starts with no other process. In a browser the terminals and coding agents are stand-ins
(`src/sessions/host.ts`, `src/terminal/host.ts`); in the desktop app they are real.

## The runtime seam

The screens speak one protocol, `src/lib/protocol.ts` (requests by op name, events by name), and reach whatever
answers it through `src/runtime`:

| File | What it is |
| --- | --- |
| `src/runtime/adapter.ts` | `RuntimeAdapter`: `connect`, `close`, `request(op, params)`, `on`, `onAny`, `onStatus`, plus `kind` and `capabilities` |
| `src/runtime/index.ts` | `createRuntime()` picks the adapter from the choice this page started with; `can(feature)` asks what the runtime has |
| `src/runtime/setting.ts` | Settings › Developer's choice, kept in `manut.runtime`: Practice or Connected with an API origin |
| `src/runtime/mock/` | The in-process runtime: Buddy and a small team, scripted turns, approvals that settle once. The default, called Practice |
| `src/runtime/http/` | Connected: a read-only runtime over `apps/api` at one origin, signed in through the backend's own sign-in, with the session in the macOS keychain and requests through the shell's `api_request` command (`src-tauri/src/api_link.rs`). Every write answers "not yet". See `docs/runtime-adapter.md` |
| `src/lib/bridge.ts` | The WebSocket adapter (omher's original transport). Used only when `VITE_MANUT_BRIDGE` or the page's `__MANUT_BRIDGE_URL__` names a URL, which is how the Playwright suite reaches `e2e/mock-bridge.mjs`. A page that sets `__MANUT_IN_PROCESS__` to `true` before it loads gets the in-process runtime whatever is configured, so a spec can walk Practice (`e2e/people.spec.ts`) |

In the demo runtime, type anything for a sample answer, or `/approve`, `/clarify`, `/interview`, `/delegate`.

Feature groups a runtime lacks are declared in its `RuntimeCapabilities` (`elsewhere`, `automations`, `plugins`,
`restart`, `accounts`); the app hides those screens instead of showing ones that cannot work. The in-process
runtime has none of them; Connected has `automations` (read-only). A quiet line above the account row says which
runtime the app runs on. **A release build runs on the demo runtime by default**, and Connected only reads and needs a
developer to sign it in: do not ship this build to an owner.

## What was removed from omher, and why

- **The Hermes bridge.** `bridge/` (Python) was not copied; `src-tauri/src/bridge.rs` and its commands are gone.
  The shell starts no process of its own at launch.
- **Hermes install and sign-in.** The first-run gate (`BridgeGate`), the "add oh-my-hermes" offer, Settings ›
  Providers (`hermes auth add`) and the chat's connect block, with `setup.rs` and `hermes_auth.rs`.
- **Hermes on another computer.** The SSH peers (`peers.rs`, Settings › Remote machines, the Connect over SSH card).
- **Hermes profiles.** The sidebar's + menu, which listed profiles to add. Every team member the runtime reports
  is listed from the first run.
- **The oh-my-hermes session row** is not offered (its chat was a Hermes chat through the bridge), and Tasks no
  longer offers Linear (it was reached through a bot's Hermes).
- **Hidden behind capabilities**, not deleted: Automations, Plugins, Accounts and usage, Restart, and the "other
  places" chip. Their code and dictionary strings are still there.
- **Other companies' logos.** `src/assets/agents/` was not copied; agents draw the first letter of their name.
  Model, link and source marks drawn from inline path data (`src/ui/modelMarks.ts`, `brandIcons.tsx`,
  `SourceIcon.tsx`, `src/tasks/marks.tsx`) are still in the code.
- **In-app updates.** The update endpoint and signing key were omher's. They are removed from
  `tauri.conf.json`, the updater plugin is not registered, and `UPDATER_ENABLED` in `src/sidebar/updater.ts` is
  false. Turning it on needs our own key and endpoint (the steps are in that file).
- **Their packaging.** The site preview (`preview/`), benchmarks (`bench/`), the AppImage smoke test and CI runner
  scripts, the product screenshots, and their app icon and logo. The icon and `src/assets/manut-mark.svg` here are
  Manut AI's own mark (the design canvas's Logo board), drawn by `node scripts/app-icons.mjs`, which writes every
  file in `src-tauri/icons` at its own size; change the drawing there and run it again on a Mac.

Kept whole: the terminal (`src-tauri/src/sessions.rs`, `src/sessions/term/`), the coding-agent adapters
(`agent_chat.rs`, `acp_chat.rs`, `acp_agents.rs`, `dsh_chat.rs`), tasks through `gh` and `glab`, the tray,
notifications, and the four languages (English, Korean, Japanese, Chinese). Thai is not added yet.

## Names

The product is "Manut AI". Identifiers that were `omher` are now `manut`: the crate, `~/.manut/` on disk, the
`manut://` link scheme, `manut.*` keys in local storage, `MANUT_*` variables. The bundle identifier is
`xyz.manut.desktop`. Comments that cite "BOUNDARY rule N" mean Oh My Hermes' `docs/OMHER-BOUNDARY.md`, which was
not copied.

## Tokens

`src/theme/tokens.css` has two layers: the values of `packages/ui-kit/tokens.json` under the kit's own names, and
the names omher's screens use, each pointed at a design token. `src/theme/tokens.test.ts` fails when the first
layer drifts from `tokens.json`. Geist, Geist Mono and IBM Plex Sans Thai are bundled (`src/theme/fonts.css`,
`src/assets/fonts/`), because the app allows no remote font.

## The command palette

Command-K (Ctrl+K off macOS) and the side menu's Search open one box over whatever is showing (`src/palette`): a
text field over a list in three groups, filtered as you type by plain, case-insensitive matching on the words the rows
show, in the app's language. **Go to** is every page of the side menu and every Settings page. **Do** is what the app
already offers somewhere else: a new thread with Buddy, New session, New lane, the microphone and voice mode, Pause
everyone (which only opens the Team page's own question), the language, and Practice or Connected. **Chats** is what
History's search finds for the same words, and the last row, "Search History for ...", opens History with them in its
box. Up and Down move, Enter picks, Esc closes and gives the focus back to where it was; Command-K again closes it too.
It does not open while an input method is composing, and a terminal keeps its own Command-K (clear) and Ctrl+K.

It has no power of its own. `src/palette/registry.ts` lists the actions as data, each naming where else the app presses
the same thing (`elsewhere`), and `registry.test.ts` fails when an action settles an ask, sends, removes or pays, or
when its other place is gone. An action that needs a place that is not open (a chat box, a project, the Team page,
Settings › Developer) is not listed, because that place registers it while it shows (`src/palette/places.ts`), and a
later item adds an action with one entry in `ACTIONS`.

## Safety settings

`src-tauri/tauri.conf.json` has a content security policy for the packaged app (scripts and styles from the app
only, no remote origin, no socket) and a looser one for `tauri dev` (Vite on `localhost:5207`). macOS signing is
ad hoc (`"-"`); there is no signing identity, notarisation or release workflow here.

## Not done in this pass

- The Playwright suite (`e2e/`, 156 spec files) runs in CI as six shards (job `e2e` in `.github/workflows/ci.yml`; run
  one file locally with `pnpm exec playwright test e2e/<file>`). Specs of removed screens were deleted or skipped, each
  skip with its reason beside it.
- Rust tests were not run, only `cargo check`.
- Dictionary strings of the hidden and removed screens were left in the four language files.
