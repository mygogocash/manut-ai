# Releasing the desktop app

How the desktop app is built, signed, put into a draft release and updated in place. The workflow is
`.github/workflows/release-desktop.yml`; its rules are pinned by `.github/scripts/release-desktop.test.mjs`. The first
releases were Mac only (`docs/decisions.md`, 25 Nov 2026); from 27 Nov 2026 the draft also holds a Linux AppImage and
.deb and a Windows installer, both unsigned (`docs/decisions/111-licence-and-channels.md`). The nightly channel is
`.github/workflows/nightly-desktop.yml` (below). Release notes start from `docs/release-notes-template.md`.

## Cutting a release

1. Set the version in `apps/desktop/src-tauri/tauri.conf.json` (and `Cargo.toml` and `package.json`, which should match) and merge it.
2. Start the build, either way. Both cost macOS minutes, so do it once the version is final.
   - Push a tag that is exactly `desktop-v` and the version, for example `desktop-v0.1.0`. The run refuses a tag that
     does not equal `tauri.conf.json`'s version.
   - Or, on GitHub, Actions, "Release desktop", Run workflow, on the branch to build.
3. The run builds Apple silicon and then Intel, one after the other, and makes one draft release `desktop-v<version>`
   holding a `.dmg` for each, the updater bundles, their `.sig` files and `latest.json`. Open the run's summary: it says
   "signed and notarized" or "UNSIGNED build" for each chip. The second build adds its files to the draft the first
   one made, and its chip to that draft's `latest.json`; that is why they do not run side by side. Then the Linux job
   adds an `.AppImage` (with its `.sig`) and a `.deb`, and the Windows job a `-setup.exe` (with its `.sig`), and each
   adds `linux-x86_64` or `windows-x86_64` to `latest.json`. Both are unsigned, and only run when the Mac job passed.
4. Download a `.dmg` from the draft and check it (below).
5. Publish the draft (Edit, Publish release). Nothing else publishes. From that moment `latest.json` is what installed
   apps are told, so Publish is the switch that sends an update to everyone.

Never publish a draft titled UNSIGNED: macOS warns on it and it is not notarized.

## The first download: 0.1.1, unsigned, a pre-release

The owner chose on 25 Nov 2026 to offer the first build from GitHub before the Apple secrets exist. So the first
download is built unsigned and published as a pre-release, and a signed build follows as a full release. It is 0.1.1:
0.1.0 was built from the tag `desktop-v0.1.0` and checked, and then the owner saw that its icon was still the
placeholder "M", so it stayed an unpublished draft and the next number carries the real mark. The signed build after
it is 0.1.2.

- **Opening it.** macOS does not open an unsigned app that was downloaded until the person allows it: open the
  `.dmg`, drag Manut AI to Applications, open it once (macOS says it could not verify the app), then System Settings,
  Privacy & Security, scroll to Security, Open Anyway, and confirm. It opens normally from then on. The release's notes
  on GitHub say this too.
- **Which file.** `aarch64` is for Apple silicon (M1 and later), `x64` for Intel Macs.
- **Updates.** GitHub's latest release is the newest one that is not a pre-release, so while this pre-release is the only one
  the app's update check finds nothing and stays quiet. Publishing 0.1.2 as a full release is what offers it to every
  installed 0.1.1.
- **Publishing a pre-release:** `gh release edit desktop-v<version> --draft=false --prerelease --latest=false`, with a
  title and notes written for the people who download it, after the checks below. Only the owner, or Claude when the
  owner said so for that release, publishes. 0.1.1 was published so on 25 Nov 2026.
- **Checking the update files:** each `.sig` is a minisign signature by the key pinned in `tauri.conf.json` over the
  `.app.tar.gz` beside it, and `latest.json` carries the same signatures for `darwin-aarch64` and `darwin-x86_64`. For
  0.1.0 and 0.1.1 every one verified (Ed25519 over the file's BLAKE2b-512, and the trusted comment), which also proves
  that the key in GitHub's secrets is the one the app trusts.

## Where Linux and Windows are

Since 27 Nov 2026 (item 111, the owner's decision) every release run builds a Linux AppImage and .deb and a Windows NSIS
installer into the same draft. Linux needs no signing. The Windows installer is unsigned until the owner buys a
code-signing certificate, so Windows SmartScreen warns before it opens; the release notes template says so. They are
the files the old hand-started Windows job built as a workflow artifact (it built on its first try, for
`desktop-v0.1.0`), now released. The `.deb` is not updated in place: the updater uses the AppImage on Linux. None of
the three jobs has been run as part of a release yet, so the first run should confirm that the draft holds all of
them and that `latest.json` names `linux-x86_64` and `windows-x86_64`.

## The nightly channel

`.github/workflows/nightly-desktop.yml` builds `pilot/week-1` every night it changed since the last nightly (its first
job compares the branch with the commit named in the feed release's body). It builds Apple silicon, Intel, Linux and
Windows, one after another, into a published prerelease `nightly-<date>`, with the version `<next patch>-nightly.<date>`
(so a stable Mac is offered it). Only when all four built does a last job copy that release's `latest.json` into
`nightly.json` (checked by `.github/scripts/nightly.mjs`), upload it to the fixed prerelease tagged `nightly`, and write
the commit into that release's body. The updater files are signed with `TAURI_SIGNING_PRIVATE_KEY` and its password,
the same two secrets as the stable build, so the key pinned in the app verifies both. Nothing else is signed: no Apple
secret is read, the Mac app is ad hoc, the Windows installer is unsigned.

- **Choosing it.** Settings > General > Updates > Channel, Stable or Nightly, kept on this Mac. Stable reads the endpoint in
  `tauri.conf.json`; Nightly reads `https://github.com/mygogocash/manut-ai/releases/download/nightly/nightly.json`
  through a shell command (`src-tauri/src/update_channel.rs`), because the plugin's page API cannot name an endpoint.
  The App Store edition has no channel.
- **When it runs.** A `schedule` trigger runs only from the default branch, so the workflow does nothing nightly until it
  is on `main`; "Run workflow" works from any branch that has it, and its `force` box builds an unchanged branch.
- **Cost.** A changed night is four builds, two of them on macOS. Nothing deletes old `nightly-<date>` releases.
- **Never stable.** A prerelease is never GitHub's `latest`, so `releases/latest/download/latest.json` is untouched.
  Any other release in this repository must still be a prerelease or a draft.

## The secrets

All are GitHub Actions secrets of `mygogocash/manut-ai` (Settings, Secrets and variables, Actions). Never put a value in
source, a chat or a log. The workflow prints names only.

| Secret | What it is | Where it comes from | Status |
| --- | --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Manut AI's updater signing key (minisign key id `C74B6B3F298928A7`) | Made 25 Nov; one copy is in `~/manut-ai-updater-key` on the Mac it was made on, for the owner's password manager | Added |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | That key's password | Same folder | Added |
| `APPLE_CERTIFICATE` | The Developer ID Application certificate with its private key, as a `.p12` file turned into one line of base64 | See "Needs the owner", step 1 | Not added |
| `APPLE_CERTIFICATE_PASSWORD` | The password chosen when exporting that `.p12` | Same step | Not added |
| `APPLE_ID` | The email of an Apple ID that belongs to the business's developer team | The person who will notarize | Not added |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (not its real password) | See step 3 | Not added |
| `APPLE_TEAM_ID` | The team's ten-character ID | See step 2 | Not added |

The five `APPLE_` names are the ones Tauri's macOS signing guide uses (https://v2.tauri.app/distribute/sign/macos/). With
any of the five missing the build still runs, unsigned, and the summary names which are missing.

The updater key and Apple's are different things: the updater key lets the app trust an update file; Apple's certificate
lets macOS open the app without a warning.

## Needs the owner

The steps below are Apple's own and could not be checked from here; where Apple's screens differ, Apple's is right.
The Apple Developer account is the business's, an organization, so the Account Holder does step 1.

1. **Certificate.** In developer.apple.com, Certificates, IDs and Profiles, make a Developer ID Application certificate
   (an organization's Account Holder can; others usually cannot). It asks for a certificate signing request: in Keychain
   Access, Certificate Assistant, Request a Certificate from a Certificate Authority, saved to disk. Download the `.cer`,
   double-click it, then in Keychain Access, My Certificates, right-click the certificate (with its key), Export as a
   `.p12` and set a password (that is `APPLE_CERTIFICATE_PASSWORD`). Then in Terminal:
   `openssl base64 -A -in certificate.p12 -out certificate-base64.txt`, and paste the file's contents as
   `APPLE_CERTIFICATE`. Delete both files afterwards.
2. **Team ID.** developer.apple.com, Account, Membership details, Team ID: `APPLE_TEAM_ID`.
3. **Notarization login.** At appleid.apple.com, Sign-In and Security, App-Specific Passwords, make one for the Apple ID
   that is a member of the team (it needs two-factor authentication on): that is `APPLE_PASSWORD`, and the ID's email is
   `APPLE_ID`. The team's agreements on developer.apple.com must be accepted or Apple refuses the submission.
4. Add the five secrets, then run the workflow once on a branch with `workflow_dispatch` and read the summary.

An App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) is Tauri's other way to
notarize; this workflow does not use it.

## Checking a build is signed and notarized

The run checks the app itself when the secrets are present (`codesign --verify`, the Developer ID authority, the stapled
ticket, Gatekeeper's assessment) and fails if any does not hold. By hand, on the downloaded `.dmg`, after dragging the
app out of it:

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Manut AI.app"
codesign -dv --verbose=2 "/Applications/Manut AI.app" 2>&1 | grep Authority
xcrun stapler validate "/Applications/Manut AI.app"
spctl --assess --type execute --verbose=2 "/Applications/Manut AI.app"
```

Authority should name "Developer ID Application" and the business's team, and `spctl` should say "accepted" with
"source=Notarized Developer ID". On a Mac that has not seen the file before, the `.dmg` opening with no warning is the
real test.

## How the updater decides

- `apps/desktop/src-tauri/tauri.conf.json` pins the public key (id `C74B6B3F298928A7`) and one endpoint:
  `https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json`.
- GitHub serves that address from the newest release that is published and not a prerelease. A draft is skipped, so the
  run's `latest.json` does nothing until the owner publishes. That needs the repository to be public, which it is.
- `latest.json` carries the version and, per chip, the update bundle's address and signature. The app compares the
  version with its own (semver), downloads the bundle for its chip and installs it only if the signature verifies against
  the pinned key. A bundle signed with any other key is refused.
- Since `tauri-apps/tauri-action` 1.0 (pinned from 26 Nov 2026, item 127), that address is the GitHub API's address of
  the asset, `https://api.github.com/repos/mygogocash/manut-ai/releases/assets/<id>`, not a `releases/download/` one
  (its `upload-version-json.ts` at action-v1.0.0). The updater asks for it with `Accept: application/octet-stream`
  (`tauri-plugin-updater` 2.14.1, `updater.rs`), which GitHub answers with the file; an asset keeps its id when its
  draft is published. Such a request carries no token, and GitHub allows 60 of them an hour from one IP address, so a
  shop with many Macs behind one connection updates them over more than an hour. 1.0 also puts the version into the
  update bundles' names (`Manut.AI_<version>_aarch64.app.tar.gz`).
- The app asks when it opens, every 6 hours, and when its window comes back after half an hour (`src/sidebar/updater.ts`).
- Any other release in this repository must be marked a prerelease, or it becomes `latest` and the updater finds no
  `latest.json` (the check fails quietly and retries). The nightly releases are prereleases for this reason.
- A Mac on the Nightly channel (Settings > General > Updates) reads `nightly.json` instead, from the release tagged
  `nightly` (above); the pinned key is the same.
- The key cannot be changed after a release ships: installed apps trust only this key (`docs/decisions.md`, 25 Nov).

A local `pnpm tauri build` now makes the updater's files too and so needs `TAURI_SIGNING_PRIVATE_KEY`; for a local build
without it add `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.

## Not verified yet

The unsigned path has run twice (25 Nov 2026, for `desktop-v0.1.0` and `desktop-v0.1.1`), about ten minutes a chip:
each made one draft with both `.dmg` files and a `latest.json` that names both chips, and the Windows installer built
on its first try. The signed path has never run: it is checked by `actionlint`, by its test, and against the
documentation of Tauri's GitHub guide, macOS signing guide and `tauri-apps/tauri-action`. Its
first run, for 0.1.2, should confirm that signing, notarization and the run's own check of the built app all pass. How the action finds the draft and adds to
`latest.json` was read in its own source at the pinned commit (`src/create-release.ts`, `src/upload-version-json.ts`).

The two runs so far used tauri-action 0.6.2: the workflow named commit `84b9d35` as "action-v1.0.0", but that commit is
GitHub's tag `action-v0.6.2`. From 26 Nov 2026 (item 127) it is pinned at `1deb371`, the tag `action-v1.0.0`, read
from the repository's tags and checked by reading only, as the workflow builds release files and was not run. None of
the inputs it uses was renamed or removed in 1.0 (its release notes, and `action.yml` at both commits). What 1.0 changes
for this workflow: `latest.json`'s addresses (above), the version in the update bundles' names, a failure when
`releaseDraft` is true and the tag's release is already published, and pnpm found from the lockfile at the repository's
root, so the build runs `pnpm tauri build`. The first 1.0 run, for 0.1.2, should therefore also confirm one draft with
both chips in `latest.json`, and the release skill's `verify-release.mjs` passing with the release's asset list.
