---
name: release-desktop
description: Cut a Manut AI desktop release - set the version, tag, watch the build, check the draft's files and signatures, and publish only when the owner said so. Use when the owner asks for a new build or a release, or to check a draft release.
---

# Releasing the desktop app

`docs/releasing.md` is the full account. This is the order of work, and what went wrong before.

**Only the owner publishes**, or the lead when the owner said so for that one release. A tag is public the moment it
is pushed, so push one only when the owner asked for a build.

1. **Version**, the same in four places: `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`,
   the `manut` entry in `apps/desktop/src-tauri/Cargo.lock`, and `apps/desktop/package.json`. Check the lock with
   `cargo check --locked`. Run the gate (the `lead-merge` skill's `gate.sh`), commit, push, and let CI pass on that
   commit (the `ci-read` skill).
2. **Tag** exactly `desktop-v<version>` on that commit, with a message in a file, and push the tag. The run refuses a
   tag that is not the app's version. It builds Apple silicon, then Intel, about ten minutes each, into one draft.
3. **Check the draft** before anything else:
   ```bash
   dir=$(mktemp -d) && gh release download desktop-v<version> --repo mygogocash/manut-ai --dir "$dir"
   node .claude/skills/release-desktop/scripts/verify-release.mjs "$dir" apps/desktop/src-tauri/tauri.conf.json
   ```
   It verifies every update file's signature against the key pinned in the app, and that `latest.json` names both
   chips. Then open each `.dmg` read-only (`hdiutil attach -nobrowse -readonly`), and check the app's version, chip
   (`lipo -archs`), identifier and `codesign --verify --deep --strict`. Look at the icon. Start the Apple silicon app
   once from a copy and see that it stays up with no crash report.
4. **Publish** only on the owner's word: `gh release edit desktop-v<version> --draft=false --prerelease --latest=false`
   for an unsigned build, with a title and notes written for the people who download it (how to open an unsigned
   app is in `docs/releasing.md`). A signed build is a full release, which is what offers the update to installed
   apps. Then confirm the public download answers without a login.
5. **Record it**: `docs/handoff.md` (where the download is, how it was checked, what was not), `docs/releasing.md`,
   and the pull request's description.

What went wrong before, so it does not again:

- The first build shipped the fork's placeholder icon. Look at the icon taken out of the BUILT app, not the source.
- A tag that is already public is not moved: a corrected build takes the next version.
- macOS ties the microphone, speech, Accessibility and screen capture grants to the app's signature. An unsigned build
  loses them at every update: say so in the notes until builds are signed (five Apple secrets, `docs/releasing.md`).
- What a person sees when they download in a browser (the quarantine warning) is not what a copy fetched with `gh`
  shows. Only a person can check that.
