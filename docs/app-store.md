# The Mac App Store build

Manut AI has two Mac builds from the same code. The GitHub download (`docs/releasing.md`) is unsandboxed, has the
identifier `xyz.manut.desktop` and updates itself. The Mac App Store build, described here, is a second build: it replaces
GoSpark's Mac app in GoSpark's existing App Store Connect record, runs in Apple's App Sandbox, and is updated by the App
Store. Building it changes nothing in the GitHub build.

The owner decided this on 26 Nov 2026: the record is app `6812282224`, bundle id `co.gogocash.gogocode`, team
`N66J8AA6TA` (GOGO HOLDING (THAILAND)). The full app is submitted, coding agents included, knowing that App Review refused
GoSpark the sandbox exceptions it needed (below), because the owner wants Apple's answer for Manut AI. Mac only: the
record's iOS app stays as it is.

## How it differs from the GitHub build

| | GitHub download | Mac App Store |
| --- | --- | --- |
| Identifier | `xyz.manut.desktop` | `co.gogocash.gogocode` |
| Version | `tauri.conf.json` (0.1.x) | 2.0.0 (the record's Mac version is 1.1.1, so the next must be higher; the owner may change it) |
| Build number | the version | a UTC timestamp, `YYYYMMDDHHmm`, so it only grows |
| Signed with | Developer ID (when the secrets exist) | Apple Distribution, then a `.pkg` signed with the Mac installer certificate |
| Sandbox | none (`Entitlements.plist`: the microphone only) | App Sandbox (`AppStore.entitlements`, below) |
| Updates | its own updater, from GitHub releases | the App Store; the updater plugin is not registered and the page asks nothing |
| Install lines for agents | shown, to copy | none; the page says why (Guideline 2.4.5) |
| Chips | Apple silicon and Intel | Apple silicon, macOS 12 or later |

One flag makes the difference: `MANUT_APP_STORE=1` at build time. The shell's `build.rs` turns it into `cfg(app_store)`
(`src-tauri/src/app_store.rs`) and `vite.config.ts` into the page's `isAppStore()` (`src/appStore.ts`). Nothing at run
time can turn it off. The rest comes from `src-tauri/tauri.appstore.conf.json`, merged over `tauri.conf.json`, and
`src-tauri/Info.appstore.plist`, merged after `Info.plist`.

In that edition:

- **No self-update.** The updater plugin is not registered (`lib.rs`), `updateHost()` returns nothing, and Settings ›
  General › System has an Updates row: "This edition comes from the Mac App Store, which keeps it up to date."
- **No program offered for install.** Where the GitHub build shows `npm i -g ...` or `curl ... | sh` for a missing agent
  (the new chat menu, Settings › Providers, the old-version note), this edition says that it does not install programs
  and that the person can install it themselves. Kit installing a project's own packages after asking, and skills
  installed from a Manut AI link (text only, never run, `skill_links.rs`), stay: neither installs a program for the app.
- **The real home folder.** The sandbox sets `HOME` to the app's container. Before anything else runs, `main()` points
  `HOME` at the person's home from the password database (as GoSpark's `LoginEnvironment.homeDirectory` did), so every
  part of the shell and every program it starts sees the person's own `~/.manut`, `~/.claude` and so on.
- **Claude Code's scratch folder** is `~/.manut/tmp` (`CLAUDE_CODE_TMPDIR`), because the sandbox refuses `/tmp`.
- **Real programs first on `PATH`.** Apple's `/usr/bin/git` refuses to run in a sandbox ("xcrun: error: cannot be used
  within an App Sandbox"), and an app opened from the Finder has only `/usr/bin:/bin:/usr/sbin:/sbin`. So Homebrew's
  folders and the active developer tools' own `usr/bin` come first.
- **Plain words for what the sandbox refuses**: a terminal (below) and computer use (Settings › Computer says so first).

The App Store edition and GoSpark's App Store app have the same bundle id, so on a Mac that had GoSpark from the store
the edition opens in GoSpark's sandbox container. It uses none of GoSpark's files there (they stay in
`Library/Application Support/GoGoCode/`).

## The entitlements, and why each

`apps/desktop/src-tauri/AppStore.entitlements`, with a comment beside each line. Every program the app starts inherits
the sandbox, so what an agent needs is listed too.

| Entitlement | Why |
| --- | --- |
| `app-sandbox` | Required for the Mac App Store. |
| `application-identifier`, `team-identifier` | `N66J8AA6TA.co.gogocash.gogocode` and `N66J8AA6TA`, as the provisioning profile names them (Tauri's App Store guide). |
| `network.client` | Manut AI's API and the phone relay (HTTPS, WSS), the agents' own services, git remotes. |
| `files.user-selected.read-write` | A project folder the person picks in the open panel. |
| `files.bookmarks.app-scope` | Keeping that grant across launches. The app does not make bookmarks yet, so a folder picked before a relaunch must be picked again. |
| `device.audio-input` | The chat box's microphone and voice mode. |
| `temporary-exception.files.home-relative-path.read-write` | `~/.manut/` (the app's own folder) and each agent's own folders: Claude Code (`~/.claude/`, `~/.claude.json` and its backup, its cache and state), Codex (`~/.codex/`, its runtimes cache), the shared skills folder `~/.agents/`, OmO, pi, oh-my-pi, Grok, oh-my-hermes (`~/.hermes/`), OpenCode (config, data, state, cache). |
| `temporary-exception.files.home-relative-path.read-only` | Where the agents' programs are installed (`~/.local/bin/`, Claude Code's versions, OpenCode's, Bun, Cargo, npm's prefix, Volta, nvm, pnpm, `~/Applications/`), git (`~/.gitconfig`, `~/.config/git/`, `~/.ssh/`), gh and glab, and the shell's rc files. |
| `temporary-exception.files.absolute-path.read-only` | `/opt/homebrew/` and `/usr/local/`: git, Node and agents installed with Homebrew. |

Nothing listens: there is no `network.server`. `src/appStore.test.ts` pins the file's keys and paths.

App Review refused these three temporary-exception kinds for GoSpark under Guideline 2.4.5(i): `absolute-path.read-only`
on 2026-09-30, and `home-relative-path.read-write` and `.read-only` on 2026-10-06 ("will not be granted"). GoSpark then
shipped without them and without its coding agents. Manut AI asks again, by the owner's choice. If Apple refuses again,
the choices are the owner's: submit without the agents (as GoSpark did), or keep the coding agents on the GitHub build.

## Building it

`apps/desktop/scripts/appstore-mac.sh`, on this Mac:

```sh
apps/desktop/scripts/appstore-mac.sh --dry-run   # print each step, run nothing
apps/desktop/scripts/appstore-mac.sh             # build, sign, package, check
apps/desktop/scripts/appstore-mac.sh --dev       # also a copy signed for development, which runs on this Mac
```

It finds the "GoSpark" Mac App Store profile among Xcode's profiles (by name, app id, team, not expired, and carrying the
Apple Distribution certificate), builds with the overlay and `MANUT_APP_STORE=1` in its own Rust folder, embeds the
profile as `Contents/embedded.provisionprofile`, signs nested code and then the app with the entitlements and
`--timestamp=none` (as Xcode signs for the store; no timestamp server is asked), and makes the `.pkg` with `productbuild`.
Every Apple credential is removed from the build's environment, so Tauri cannot notarize or upload. It never installs,
uploads or calls App Store Connect. The Rust build folder (about 1.4 GB) is removed at the end unless `KEEP_TARGET=1`.

What it makes, in `OUT` (printed at the start): `Manut AI.app`, `Manut-AI-2.0.0-<build>.pkg` (about 10 MB, the file to
upload), `dev/Manut AI.app` with `--dev`, `checks.txt` and `build.log`.

What it checks, each a line in `checks.txt`, and the run fails on the first that does not hold:

1. `codesign --verify --deep --strict` on the app.
2. The app is signed by "Apple Distribution: GOGO HOLDING (THAILAND) LIMITED PARTNERSHIP (N66J8AA6TA)", and no nested
   code by another certificate (ITMS-90284, which hit GoSpark 1.0.0 (5)).
3. No timestamp in the signature.
4. `codesign -d --entitlements :-` equals `AppStore.entitlements`, key for key.
5. The embedded profile is a store profile for `N66J8AA6TA.co.gogocash.gogocode`, team `N66J8AA6TA`, and the signed
   application identifier matches it.
6. Info.plist: `CFBundleIdentifier`, `CFBundleName` Manut AI, `CFBundleShortVersionString` 2.0.0, `CFBundleVersion` the
   build number, `LSApplicationCategoryType` `public.app-category.developer-tools`, `ITSAppUsesNonExemptEncryption`
   false, `LSMinimumSystemVersion` 12.0, and the microphone and speech recognition reasons.
7. The program is arm64.
8. `pkgutil --check-signature` names the "3rd Party Mac Developer Installer" certificate, and the app inside the package
   verifies again and installs to `/Applications`.
9. Not run, ever: `installer`, `altool`, `notarytool`, Transporter.

## What works in the sandbox

Measured on 26 Nov 2026 on this Mac (macOS 27.2, Apple silicon), on the build `Manut-AI-2.0.0-202611260739.pkg` came
from. The App Store-signed app does not run here: macOS killed it at launch (exit 137) and `spctl` rejected it, as for
any store-signed app before Apple re-signs it. So the same build, signed with Apple Development and the "Mac Team
Provisioning Profile: co.gogocash.gogocode" development profile with the same entitlements (`--dev`), was opened from the
build folder with the environment the Finder gives an app. A small probe with the same bundle id and entitlements checked
the sandbox's answers one call at a time. No coding agent was given a task; one practice message went to the demo team.

| What | In the sandbox | Seen how |
| --- | --- | --- |
| First run, Practice mode | Works | Continue on this computer, then Skip: Home in Practice mode (pictures 1, 2) |
| A member's chat | Works: a practice message got the demo team's answer | Nam (picture 3) |
| Side menu, Settings | Work; General › System shows the Updates row | picture 4 |
| Agents found | Every one installed: Claude Code, Codex, oh-my-pi, Grok, OpenCode, Gemini CLI, Cline, Cursor, Antigravity, with versions read (Claude Code 2.1.332, Codex 0.169.0, Grok 1.0.93) | the new chat menu (picture 5), Settings › Providers |
| Claude Code's sign-in | Read: Claude Code shows signed in, and `claude auth status` in the sandbox says so | picture 5, probe |
| git and gh | git 2.56.1 found and run; gh's accounts read. Apple's `/usr/bin/git` itself refuses ("cannot be used within an App Sandbox"), so `PATH` puts the real ones first | Settings › Source control (picture 8), probe |
| A terminal (Shell, or an agent in a terminal) | Does not start: the sandbox refuses a controlling terminal (`ioctl(TIOCSCTTY)`, EPERM); the app says so plainly | picture 6, probe |
| A coding chat with Claude Code | The draft opens in the home folder; Claude Code starts with the first message, which was not sent, so not confirmed | |
| Computer use | Off: binding its socket is refused; Settings › Computer says so first | the app's log, picture 7 |
| A dev server, or anything else listening on this Mac | Refused (no `network.server`) | probe |
| Writing in `/tmp` | Refused; Claude Code's scratch folder is `~/.manut/tmp` instead | probe |
| Claude Code saving `~/.claude.json` | Its temporary file beside that file is refused, so Claude may not save changes to it (a folder's trust, for one) | probe; Claude's own handling not seen |
| Folders outside the exceptions (`~/Documents`, the home folder's list) | Refused until picked in the open panel | probe |
| A lane | Not tried: it needs a project picked in the open panel | |
| The microphone prompt | Not tried: it puts a system prompt in front of the person | owner step |

The pictures and the probe's output are in the item's report folder, not in the repository. The runs left two small
folders on this Mac, `~/.manut/computer` and `~/.manut/terminals` (24 KB), and the edition's page data in the
`co.gogocash.gogocode` container.

## Export compliance

`ITSAppUsesNonExemptEncryption` is false. The app's connections use the system's HTTPS and TLS. Beyond that it encrypts
only through the system's own WebCrypto in WebKit: AES-256-GCM with ECDH and HKDF for the paired phone's end-to-end
channel (`packages/remote-channel`) and AES-GCM for the sealed shop cache. Standard algorithms in Apple's own
implementation; whether that changes the answer is the owner's call before the upload.

## What the owner does next

1. Run `apps/desktop/scripts/appstore-mac.sh` on a Mac with the signing assets and read `checks.txt`.
2. Validate and upload the `.pkg` (Transporter, or `xcrun altool --validate-app` then `--upload-app` with an App Store
   Connect API key).
3. In App Store Connect, add Mac version 2.0.0, rename the listing to Manut AI, paste the copy and App Review notes from
   `docs/app-store/2.0.0.md`, and add Mac screenshots of Manut AI.
4. Try the microphone once in the development copy and say whether macOS asks.
