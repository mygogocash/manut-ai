# Releasing the desktop app

How the desktop app is built, signed, put into a draft release and updated in place. The workflow is
`.github/workflows/release-desktop.yml`; its rules are pinned by `.github/scripts/release-desktop.test.mjs`. The first
releases were Mac only (`docs/decisions.md`, 25 Nov 2026); from 27 Nov 2026 the draft also holds a Linux AppImage and
.deb and a Windows installer, both unsigned (`docs/decisions/111-licence-and-channels.md`). The nightly channel is
`.github/workflows/nightly-desktop.yml` (below). Release notes start from `docs/release-notes-template.md`. Since item
141 every job that reads a signing secret names a GitHub Environment (`release` or `nightly`) that holds it, and the
nightly signs with a key of its own ("The two environments and the nightly key", below).

## Cutting a release

1. Set the version in `apps/desktop/src-tauri/tauri.conf.json` (and `Cargo.toml` and `package.json`, which should match) and merge it.
2. Start the build, either way. Both cost macOS minutes, so do it once the version is final.
   - Push a tag that is exactly `desktop-v` and the version, for example `desktop-v0.1.0`. The run refuses a tag that
     does not equal `tauri.conf.json`'s version.
   - Or, on GitHub, Actions, "Release desktop", Run workflow, on `main`: the `release` environment refuses any other
     branch.

   Each job that names `release` waits for the owner's approval before it starts (the run shows "Waiting"; Review
   deployments, Approve and deploy): the two Mac builds, Linux and Windows, each as it comes up. Approve only a run you
   started.
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
the commit into that release's body.

The updater files are signed with the nightly's own key (item 141), never the stable one: the nightly builds whatever
`pilot/week-1` holds, Dependabot bumps merged on a green run included, and the build runs with the key in its
environment. The key is `NIGHTLY_SIGNING_PRIVATE_KEY` and its password, secrets of the `nightly` environment. Each
nightly build is made with the public half (the repository variable `NIGHTLY_UPDATER_PUBKEY`, checked by `nightly.mjs
updater`) and the nightly feed as its updater config, so it trusts only nightly files and reads only `nightly.json`.
With no such variable the run stops before building and says why, and the feed job refuses a night whose signatures name
another key. Nothing else is signed: no Apple secret is read, the Mac app is ad hoc, the Windows installer is unsigned.

- **Choosing it.** Settings > General > Updates > Channel, Stable or Nightly, kept on this Mac. Stable reads the endpoint in
  `tauri.conf.json`; Nightly reads `https://github.com/mygogocash/manut-ai/releases/download/nightly/nightly.json`
  through a shell command (`src-tauri/src/update_channel.rs`), because the plugin's page API cannot name an endpoint.
  The App Store edition has no channel.
- **Moving between channels** means installing the other channel's build once, since item 141: a stable build refuses
  a nightly's files, which its key did not sign, and a nightly build reads only `nightly.json`, whichever choice its
  Settings row shows. Join Nightly from the newest `nightly-<date>` release; leave it by installing the stable release.
  The row still offers Nightly in a stable build, where it finds an update that fails its check after the download: the
  row needs to say so, or to go, before a stable release carries it (0.1.1 does not).
- **When it runs.** A `schedule` trigger runs only from the default branch, so the workflow does nothing nightly until it
  is on `main`. "Run workflow" works from `main` only, since the `nightly` environment lets no other branch reach the
  key, and its `force` box builds an unchanged branch.
- **Cost.** A changed night is four builds, two of them on macOS. Nothing deletes old `nightly-<date>` releases.
- **Never stable.** A prerelease is never GitHub's `latest`, so `releases/latest/download/latest.json` is untouched.
  Any other release in this repository must still be a prerelease or a draft.

## The secrets

All are GitHub Actions secrets of `mygogocash/manut-ai`, kept in the environment the table names (Settings, Environments),
and one repository variable (Settings, Secrets and variables, Actions, Variables). Never put a value in source, a chat or
a log. The workflows print names only.

| Name | Kept in | What it is | Where it comes from | Status |
| --- | --- | --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `release` | Manut AI's updater signing key (minisign key id `C74B6B3F298928A7`) | Made 25 Nov; one copy is in `~/manut-ai-updater-key` on the Mac it was made on, for the owner's password manager | Added to the repository; to move (below, step 3) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `release` | That key's password | Same folder | Added to the repository; to move |
| `APPLE_CERTIFICATE` | `release` | The Developer ID Application certificate with its private key, as a `.p12` file turned into one line of base64 | See "Needs the owner", step 1 | Not added |
| `APPLE_CERTIFICATE_PASSWORD` | `release` | The password chosen when exporting that `.p12` | Same step | Not added |
| `APPLE_ID` | `release` | The email of an Apple ID that belongs to the business's developer team | The person who will notarize | Not added |
| `APPLE_PASSWORD` | `release` | An app-specific password for that Apple ID (not its real password) | See step 3 | Not added |
| `APPLE_TEAM_ID` | `release` | The team's ten-character ID | See step 2 | Not added |
| `NIGHTLY_SIGNING_PRIVATE_KEY` | `nightly` | The nightly's own updater signing key, which only nightly builds trust | Below, step 4 | Not added |
| `NIGHTLY_SIGNING_PRIVATE_KEY_PASSWORD` | `nightly` | That key's password | Same step | Not added |
| `NIGHTLY_UPDATER_PUBKEY` | a repository variable | The nightly key's public half (`nightly.key.pub`), public by nature | Same step | Not added |

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
4. Add the five secrets to the `release` environment (never the repository), then run the workflow once on `main` with
   `workflow_dispatch` and read the summary.

An App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) is Tauri's other way to
notarize; this workflow does not use it.

## The two environments and the nightly key (item 141)

The sixth security read (27 Nov 2026) found the signing secrets kept in the repository, where a run of any branch can
read them, and helpers push branches here every day. A secret kept in an environment reaches only the jobs that name it,
and only in the runs the environment lets in. The release's three jobs name `release`; the nightly's build job names
`nightly`. Do these steps before item 141 reaches `main`: a run that names an environment that does not exist creates
it, with no rules and no secrets (GitHub's "Managing environments for deployment"). They work because the repository is
public: on GitHub's Free, Pro and Team plans required reviewers, and on Free environment secrets too, are only
available to public repositories.

1. **`release`.** Settings, Environments, New environment, `release`, Configure environment.
   - Required reviewers: yourself. Leave "Prevent self-review" off: every run here starts under your login, helpers'
     pushes included, so with it on nobody could approve.
   - Deselect "Allow administrators to bypass configured protection rules".
   - Deployment branches and tags: Selected branches and tags. Add deployment branch or tag rule: Ref type Branch, `main`.
     Add another: Ref type Tag, `desktop-v*`.
   - Save protection rules.
2. **`nightly`.** New environment, `nightly`. Deployment branches and tags: Selected branches and tags, one rule, Ref
   type Branch, `main`. That is the branch the nightly's schedule runs from: a `schedule` runs on the default branch,
   and the rule is matched against the run's ref (`GITHUB_REF`), not the `pilot/week-1` commit the nightly checks out.
   No reviewer: it runs at 02:17 in Bangkok.
3. **Move the secrets.** In `release`, Environment secrets, Add secret, once for each: `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from your password manager's copy (GitHub never shows a secret again), and the
   five `APPLE_` secrets when they exist. Then Settings, Secrets and variables, Actions, Repository secrets: delete
   each of them. Until the repository copy is gone, any branch can still read it.
4. **The nightly key pair.** In the repository on your Mac:
   `pnpm --filter @manut/desktop exec tauri signer generate -w "$HOME/manut-ai-nightly-key/nightly.key"`, and choose a
   password when it asks. It writes the private key to `nightly.key` and the public key to `nightly.key.pub`.
   - In `nightly`, Environment secrets: `NIGHTLY_SIGNING_PRIVATE_KEY` is the whole of `nightly.key`, and
     `NIGHTLY_SIGNING_PRIVATE_KEY_PASSWORD` that password.
   - Settings, Secrets and variables, Actions, Variables, New repository variable: `NIGHTLY_UPDATER_PUBKEY` is the whole
     of `nightly.key.pub`.
   - Keep `nightly.key` and its password in your password manager, then delete the folder.
5. **Check.** The next nightly, from `main`, passes "Check the nightly's own updater key" and its feed job's key check;
   the release skill's `verify-release.mjs` checks its files against the nightly key. The next release asks you to
   approve each of its jobs.

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
- A nightly build pins the nightly's own key and reads `nightly.json`, from the release tagged `nightly` (above). A
  stable build on the Nightly channel reads `nightly.json` too, and refuses its files, which the stable key did not sign.
- The key cannot be changed after a release ships: installed apps trust only this key (`docs/decisions.md`, 25 Nov).

A local `pnpm tauri build` now makes the updater's files too and so needs `TAURI_SIGNING_PRIVATE_KEY`; for a local build
without it add `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.

## Signing apart from the build (item 141b, proposed)

Item 141 keeps the keys from every branch but `main` and the `desktop-v` tags, but the build itself still runs with them
in its environment: the app's `beforeBuildCommand` (`pnpm build`), `build.rs`, every npm and cargo package those load,
and `tauri-action`. A dependency release that steals them needs to be built once. The fix is to build with no secret at
all and sign afterwards, in a job that runs nothing from the repository or its dependencies. It waits for the owner's
first signed release (0.1.2), so the signed path as it is has run once to compare with.

What the pinned tools offer, read in their source and `--help` and not run:

- Tauri CLI 2.12.6, `tauri build --no-sign`: "Skip code signing when bundling the app". Its `bundle.rs` skips the updater
  signatures with the same flag ("Updater signing is skipped due to --no-sign flag") and still makes the update files
  (the Mac `.app.tar.gz`, the AppImage, the `-setup.exe`), unsigned.
- `tauri signer sign <file>`, with the key and password in `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `--app-version <version>`, which puts the version into the signature's
  trusted comment as `tauri build` does.
- `tauri-action` at `action-v1.0.0` makes or fills a release only when `tagName` or `releaseId` is set, and uploads the
  bundles as workflow artifacts with `uploadWorkflowArtifacts`. It has no step that signs a build it did not make.

The steps, per workflow (the nightly's are the same with its own environment, key and feed):

1. **Build**, the four platforms as today, with no `environment:`, no secret and `contents: read`: `tauri-action` with
   `--no-sign` in `args`, no release inputs and `uploadWorkflowArtifacts: true`. Wanted from it: the Mac `.app` (its
   unsigned `.dmg` and `.app.tar.gz` are made again later), the AppImage and `.deb`, and the `-setup.exe`.
2. **Sign**, one macOS job with `environment: release`, so a release asks for one approval instead of four. It checks
   out only `Entitlements.plist` from the same commit (a sparse checkout, read as data), downloads the artifacts, and
   uses only Apple's tools on the runner image (`security`, `codesign`, `ditto`, `xcrun notarytool`, `xcrun stapler`,
   `hdiutil`) and the Tauri CLI installed alone at 2.12.6 with `npm install --ignore-scripts` into an empty folder,
   checked against the integrity `pnpm-lock.yaml` records, for `signer sign`. For each chip: the certificate into a
   throwaway keychain (as today); `codesign --force --options runtime --timestamp --entitlements` with the Developer ID
   identity; `ditto -c -k --keepParent`, `notarytool submit --wait`, `stapler staple`; the checks the release runs today
   (`codesign --verify`, the authority, `stapler validate`, `spctl --assess`); then the update bundle (`tar -czf` of the
   stapled app) and its `.sig` with `signer sign --app-version`, and the `.dmg` from the stapled app with
   `hdiutil create -format UDZO`. Then the `.sig` of the AppImage and of the `-setup.exe`: a signature is the same made
   on any machine.
3. **Publish**, on Linux with `contents: write` and no signing secret, so it may run the repository's own reviewed code:
   the draft `desktop-v<version>` made with `gh release create --draft`, every file and `.sig` uploaded under the names
   tauri-action 1.0 gives them, and `latest.json` written from them by a script beside `nightly.mjs`, in tauri-action
   1.0's shape (the version, and per platform the signature and the asset's address).

What changes in the outputs:

- The `.dmg` is made by `hdiutil`, not Tauri's bundler, so it loses the arranged window (background and icon places)
  unless the job copies that layout. The app inside is the same signed and stapled one.
- The update files, their names, the signatures (the same key, the version in the trusted comment) and `latest.json`
  stay as today, so `verify-release.mjs` checks them unchanged. Linux and Windows files are exactly what `--no-sign`
  builds (they were never code-signed); only where their `.sig` is made moves.
- One approval per release, and no job that runs the app's build holds a key or a token that can write a release.
- What it does not change: the sign job signs whatever the build made, so a dependency that alters the app is still
  signed. What it removes is the theft of a key, which would let anyone sign anything, for good.

How its first run is checked: on a `desktop-v` tag after 0.1.2, the sign job's own checks pass; the build jobs' logs say
"Updater signing is skipped due to --no-sign flag" and their steps name no secret; `verify-release.mjs` passes on the
draft with its asset list; the `.dmg` opens with no warning on a Mac that has not seen it; and an installed 0.1.2 takes
the update. For the nightly: the first night's feed job passes its key check, and a Nightly Mac takes the update.

## Not verified yet

Item 141's environments have not run: the first release and nightly after the owner's steps above should confirm that
each `release` job waits for an approval, that both environments let `main` in (and `release` the tag), and that the
nightly's key check and its feed's key check pass. Neither workflow was run for item 141 (they spend build minutes);
the static tests and `actionlint` check them.


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
