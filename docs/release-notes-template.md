# Release notes template

Copy this into the draft release's notes when publishing (`docs/releasing.md`, "Cutting a release"), and delete the
lines for a platform whose file is not in the release. Write it for the people who download it, not for developers.

```markdown
## Manut AI <version>

<One or two plain sentences on what changed for a shop owner.>

### Download

| Your computer | File |
| --- | --- |
| Mac with Apple silicon (M1 or later) | `Manut.AI_<version>_aarch64.dmg` |
| Mac with an Intel chip | `Manut.AI_<version>_x64.dmg` |
| Windows 10 or 11 | `Manut.AI_<version>_x64-setup.exe` |
| Linux, any recent distribution | `Manut.AI_<version>_amd64.AppImage` |
| Linux, Debian or Ubuntu | `Manut.AI_<version>_amd64.deb` |

### Opening it the first time

- **Mac, unsigned build:** macOS does not open an unsigned app that was downloaded until you allow it. Open the `.dmg`,
  drag Manut AI to Applications, open it once (macOS says it could not verify the app), then System Settings, Privacy &
  Security, scroll to Security, Open Anyway, and confirm. A signed build opens with no warning.
- **Windows:** the installer is not code-signed yet, so Windows SmartScreen warns ("Windows protected your PC") until it
  is code-signed. Choose More info, then Run anyway. It installs for your own account and needs no administrator.
- **Linux AppImage:** make it executable (`chmod +x Manut.AI_*.AppImage`) and run it. The `.deb` installs with
  `sudo apt install ./Manut.AI_*.deb`.

### Updates

The Mac, Windows and Linux AppImage builds update themselves from inside the app. The `.deb` does not: download the next
one. In Settings > General > Updates you can choose the Nightly channel, which gets a new, less tested build most nights.
```

The file names above are the ones Tauri 2 gives its bundles (`<productName>_<version>_<arch>.<ext>`); check them against
the draft's asset list before publishing, because the names are Tauri's and not ours.

The Windows installer stays unsigned until the owner buys a code-signing certificate. SmartScreen's warning does not go
away at once even then for a certificate that is not "extended validation"; it fades as the file is downloaded and run by
more people. A signed Mac build needs the five Apple secrets (`docs/releasing.md`, "The secrets").
