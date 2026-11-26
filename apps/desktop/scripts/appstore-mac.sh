#!/bin/bash
# Builds Manut AI for the Mac App Store and checks the result on this Mac. It never uploads, never installs and never
# calls an Apple service: validation and upload are the lead's, from App Store Connect's own tools (docs/app-store.md).
#
#   apps/desktop/scripts/appstore-mac.sh             build, sign, package, check
#   apps/desktop/scripts/appstore-mac.sh --dry-run   print each step, run nothing
#   apps/desktop/scripts/appstore-mac.sh --dev       also sign a copy for development, which runs on this Mac
#
# What it makes, in OUT (default: a new folder under $TMPDIR, printed at the start):
#   Manut AI.app                    the App Store build, signed with Apple Distribution
#   Manut-AI-<version>-<build>.pkg  that app in an installer package signed for the Mac App Store, the file to upload
#   dev/Manut AI.app                with --dev: the same build signed with Apple Development and the development profile
#   checks.txt, build.log           what was checked and the build's own output
#
# The build is the GitHub app with tauri.appstore.conf.json merged over tauri.conf.json and MANUT_APP_STORE=1, the one
# flag that makes the App Store edition (app_store.rs, src/appStore.ts): the identifier co.gogocash.gogocode, the
# sandbox (AppStore.entitlements), no updater. The build number (CFBundleVersion) is a UTC timestamp, so it only grows,
# and the Mac App Store provisioning profile is embedded as Contents/embedded.provisionprofile before signing.
#
# Signing is this script's, not Tauri's (`tauri build --no-sign`): nested code first and the app last, each with the
# entitlements file, and with --timestamp=none, as Xcode signs for the store, so no timestamp server is asked. The
# package is signed with --timestamp=none too. The environment's Apple credentials are taken away from the build, so
# Tauri can never notarize or upload anything.
#
# Options, from the environment:
#   OUT=dir            where everything goes
#   BUILD_NUMBER=n     CFBundleVersion, one to three period-separated whole numbers (default: date -u +%Y%m%d%H%M)
#   PROFILE_NAME=name  the Mac App Store profile to embed (default: GoSpark), found by name among Xcode's profiles
#   DEV_PROFILE_NAME   the development profile for --dev (default: Mac Team Provisioning Profile: co.gogocash.gogocode)
#   DEV_IDENTITY       the identity for --dev (default: Apple Development)
#   INSTALLER_IDENTITY the package's identity (default: 3rd Party Mac Developer Installer: <the team>)
#   KEEP_TARGET=1      keep the Rust build folder (OUT/target, several GB); by default it is removed at the end
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
TAURI="$DESKTOP/src-tauri"
OVERLAY="$TAURI/tauri.appstore.conf.json"
ENTITLEMENTS="$TAURI/AppStore.entitlements"
PROFILES_DIR="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"

DRY_RUN=0
DEV=0
for arg in "$@"; do
  case "$arg" in
  --dry-run) DRY_RUN=1 ;;
  --dev) DEV=1 ;;
  -h | --help) sed -n '2,31p' "$0"; exit 0 ;;
  *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# One reading of the overlay, so the identifier, version and identity live in one place.
overlay() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); v=d
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$OVERLAY" "$1"; }
IDENTIFIER="$(overlay identifier)"
VERSION="$(overlay version)"
PRODUCT="$(overlay productName)"
APP_IDENTITY="$(overlay bundle.macOS.signingIdentity)"
TEAM_ID="$(sed -nE 's/.*\(([A-Z0-9]{10})\)$/\1/p' <<<"$APP_IDENTITY")"
PROFILE_NAME="${PROFILE_NAME:-GoSpark}"
DEV_PROFILE_NAME="${DEV_PROFILE_NAME:-Mac Team Provisioning Profile: $IDENTIFIER}"
DEV_IDENTITY="${DEV_IDENTITY:-Apple Development}"
INSTALLER_IDENTITY="${INSTALLER_IDENTITY:-3rd Party Mac Developer Installer: ${APP_IDENTITY#Apple Distribution: }}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
if ! [[ "$BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]]; then
  echo "BUILD_NUMBER must be one to three period-separated whole numbers, such as 202611261400; got '$BUILD_NUMBER'." >&2
  exit 2
fi
[ -n "$TEAM_ID" ] || { echo "Could not read the team from the overlay's signingIdentity '$APP_IDENTITY'." >&2; exit 2; }
if [ -z "${OUT:-}" ]; then
  TMP_BASE="${TMPDIR:-/tmp}"
  TMP_BASE="${TMP_BASE%/}"
  if [ "$DRY_RUN" = 1 ]; then OUT="$TMP_BASE/manut-appstore.DRYRUN"; else OUT="$(mktemp -d "$TMP_BASE/manut-appstore.XXXXXX")"; fi
fi
APP="$OUT/$PRODUCT.app"
PKG="$OUT/${PRODUCT// /-}-$VERSION-$BUILD_NUMBER.pkg"
TARGET_DIR="$OUT/target"
CHECKS="$OUT/checks.txt"

step() { printf '\n==> %s\n' "$1"; }
# Runs a command, or with --dry-run prints it as it would run.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '  $'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
# Each check's line goes to the screen and to checks.txt (a dry run writes no file).
note() { if [ -d "$OUT" ] && [ "$DRY_RUN" = 0 ]; then printf '%s\n' "$1" | tee -a "$CHECKS"; else printf '%s\n' "$1"; fi; }
fail() { note "FAILED: $1" >&2; exit 1; }
pass() { note "ok    $1"; }

# The newest profile on this Mac with this name, for this team's App ID, for macOS, not expired; for the App Store
# (no device list) or for development (this Mac among its devices). Prints its path, or nothing.
find_profile() { # name kind(store|dev)
  python3 -I - "$PROFILES_DIR" "$1" "$2" "$TEAM_ID.$IDENTIFIER" <<'PY'
import datetime, glob, json, os, plistlib, subprocess, sys
folder, name, kind, appid = sys.argv[1:5]
udid = ""
if kind == "dev":
    hw = json.loads(subprocess.run(["system_profiler", "SPHardwareDataType", "-json"], capture_output=True, text=True).stdout or "{}")
    udid = (hw.get("SPHardwareDataType") or [{}])[0].get("provisioning_UDID", "")
best = None
for f in glob.glob(os.path.join(folder, "*.provisionprofile")):
    raw = subprocess.run(["security", "cms", "-D", "-i", f], capture_output=True).stdout
    try:
        p = plistlib.loads(raw)
    except Exception:
        continue
    ent = p.get("Entitlements", {})
    if p.get("Name") != name or ent.get("com.apple.application-identifier") != appid or "OSX" not in p.get("Platform", []):
        continue
    if p.get("ExpirationDate") and p["ExpirationDate"] <= datetime.datetime.now():
        continue
    devices = p.get("ProvisionedDevices")
    if kind == "store" and (devices or p.get("ProvisionsAllDevices")):
        continue
    if kind == "dev" and udid not in (devices or []):
        continue
    if best is None or p.get("CreationDate") > best[0]:
        best = (p.get("CreationDate"), f)
print(best[1] if best else "")
PY
}

# Whether the profile carries the certificate of the identity that signs with it (names only are printed).
profile_has_identity() { # profile identity
  python3 -I - "$1" "$2" <<'PY'
import hashlib, plistlib, re, subprocess, sys
profile, identity = sys.argv[1:3]
p = plistlib.loads(subprocess.run(["security", "cms", "-D", "-i", profile], capture_output=True).stdout)
held = {hashlib.sha1(c).hexdigest().upper() for c in p.get("DeveloperCertificates", [])}
out = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], capture_output=True, text=True).stdout
mine = [m.group(1) for m in re.finditer(r'\) ([0-9A-F]{40}) "([^"]+)"', out) if m.group(2).startswith(identity)]
sys.exit(0 if held & set(mine) else 1)
PY
}

# The Info.plist fields the store reads.
plist_value() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null; }

# Signs the app's nested code first, then the app, all with the entitlements and no timestamp.
sign_app() { # app identity
  local app="$1" identity="$2" item
  while IFS= read -r -d '' item; do
    run codesign --force --sign "$identity" --options runtime --timestamp=none --entitlements "$ENTITLEMENTS" "$item"
  done < <(find "$app/Contents" -mindepth 2 \( -name '*.framework' -o -name '*.dylib' -o -name '*.xpc' -o -name '*.app' -o -name '*.appex' \) -print0 2>/dev/null)
  # the helper programs beside the main one in MacOS (Tauri's sidecars), if any
  while IFS= read -r -d '' item; do
    [ "$(basename "$item")" = "$(plist_value "$app" CFBundleExecutable)" ] && continue
    run codesign --force --sign "$identity" --options runtime --timestamp=none --entitlements "$ENTITLEMENTS" "$item"
  done < <(find "$app/Contents/MacOS" -mindepth 1 -maxdepth 1 -type f -perm +111 -print0 2>/dev/null)
  run codesign --force --sign "$identity" --options runtime --timestamp=none --entitlements "$ENTITLEMENTS" "$app"
}

check_app() { # app identity-prefix profile-kind
  local app="$1" want="$2" kind="$3" leaf work
  work="$(mktemp -d)"
  codesign --verify --deep --strict "$app" 2>"$work/verify" || fail "codesign --verify --deep --strict: $(cat "$work/verify")"
  pass "codesign --verify --deep --strict $(basename "$app")"
  leaf="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
  [[ "$leaf" == "$want"* ]] || fail "the app is signed by '$leaf', not '$want'"
  pass "signed by $leaf"
  local item signer
  while IFS= read -r -d '' item; do
    codesign -d "$item" >/dev/null 2>&1 || continue
    signer="$(codesign -dvv "$item" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
    [ "$signer" = "$leaf" ] || fail "${item#"$app"/} is signed by '$signer', not the app's certificate (ITMS-90284)"
  done < <(find "$app/Contents" -mindepth 1 \( -name '*.bundle' -o -name '*.framework' -o -name '*.appex' -o -name '*.xpc' -o -name '*.app' -o -name '*.dylib' \) -print0)
  pass "no nested code signed by another certificate"
  codesign -dv "$app" 2>&1 | grep -q 'Timestamp=' && fail "the signature carries a timestamp from a server; it was meant to ask none"
  pass "no timestamp server was asked (--timestamp=none)"
  # the signed entitlements are exactly the file's
  codesign -d --entitlements :- "$app" >"$work/signed.plist" 2>/dev/null || fail "could not read the signed entitlements"
  plutil -convert json -o "$work/signed.json" "$work/signed.plist"
  plutil -convert json -o "$work/file.json" "$ENTITLEMENTS"
  python3 -I -c 'import json,sys; a,b=(json.load(open(f)) for f in sys.argv[1:3]); sys.exit(0 if a==b else 1)' "$work/signed.json" "$work/file.json" \
    || fail "the signed entitlements differ from $(basename "$ENTITLEMENTS")"
  pass "the signed entitlements are exactly $(basename "$ENTITLEMENTS")"
  # the embedded profile names this app and team, and is the kind asked for
  [ -f "$app/Contents/embedded.provisionprofile" ] || fail "no Contents/embedded.provisionprofile"
  security cms -D -i "$app/Contents/embedded.provisionprofile" >"$work/profile.plist" 2>/dev/null
  local appid team devices
  appid="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$work/profile.plist")"
  team="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$work/profile.plist")"
  [ "$appid" = "$TEAM_ID.$IDENTIFIER" ] || fail "the embedded profile is for '$appid', not '$TEAM_ID.$IDENTIFIER'"
  [ "$team" = "$TEAM_ID" ] || fail "the embedded profile's team is '$team', not '$TEAM_ID'"
  if /usr/libexec/PlistBuddy -c 'Print :ProvisionedDevices' "$work/profile.plist" >/dev/null 2>&1; then devices=dev; else devices=store; fi
  [ "$devices" = "$kind" ] || fail "the embedded profile is a $devices profile, not a $kind one"
  pass "embedded profile: $(/usr/libexec/PlistBuddy -c 'Print :Name' "$work/profile.plist") ($kind), $appid, team $team"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.application-identifier' "$work/signed.plist")" = "$appid" ] \
    || fail "the signed application-identifier is not the profile's"
  pass "the signed application-identifier matches the profile"
  # the Info.plist fields the store reads
  local want_fields=(
    "CFBundleIdentifier=$IDENTIFIER"
    "CFBundleName=$PRODUCT"
    "CFBundleShortVersionString=$VERSION"
    "CFBundleVersion=$BUILD_NUMBER"
    "LSApplicationCategoryType=public.app-category.developer-tools"
    "ITSAppUsesNonExemptEncryption=false"
    "LSMinimumSystemVersion=12.0"
  )
  local pair key val got
  for pair in "${want_fields[@]}"; do
    key="${pair%%=*}"; val="${pair#*=}"
    got="$(plist_value "$app" "$key")"
    [ "$got" = "$val" ] || fail "Info.plist $key is '$got', not '$val'"
  done
  pass "Info.plist: ${want_fields[*]}"
  plist_value "$app" NSMicrophoneUsageDescription >/dev/null || fail "Info.plist has no NSMicrophoneUsageDescription"
  pass "Info.plist carries the microphone's and speech recognition's reasons"
  [ "$(lipo -archs "$app/Contents/MacOS/$(plist_value "$app" CFBundleExecutable)")" = "arm64" ] || fail "the program is not arm64"
  pass "Apple silicon (arm64), from macOS 12"
  rm -rf "$work"
}

if [ "$DRY_RUN" = 1 ]; then
  printf 'DRY RUN: nothing is built, signed, packaged or checked. Each step prints what it would run.\n'
else
  mkdir -p "$OUT"
  : >"$CHECKS"
fi
printf 'Manut AI %s (%s) for the Mac App Store, %s\nInto: %s\n' "$VERSION" "$BUILD_NUMBER" "$IDENTIFIER" "$OUT"

step "Finding the provisioning profile '$PROFILE_NAME' for $TEAM_ID.$IDENTIFIER"
PROFILE="$(find_profile "$PROFILE_NAME" store)"
[ -n "$PROFILE" ] || fail "no Mac App Store profile named '$PROFILE_NAME' for $TEAM_ID.$IDENTIFIER in $PROFILES_DIR"
printf '  %s\n' "$(basename "$PROFILE")"
profile_has_identity "$PROFILE" "$APP_IDENTITY" || fail "the profile does not carry the certificate of '$APP_IDENTITY'"
security find-identity -v | grep -qF "\"$INSTALLER_IDENTITY\"" || fail "no '$INSTALLER_IDENTITY' in the keychain"
printf '  carries the certificate of %s; %s is in the keychain\n' "$APP_IDENTITY" "$INSTALLER_IDENTITY"
if [ "$DEV" = 1 ]; then
  DEV_PROFILE="$(find_profile "$DEV_PROFILE_NAME" dev)"
  [ -n "$DEV_PROFILE" ] || fail "no development profile named '$DEV_PROFILE_NAME' that lists this Mac"
  profile_has_identity "$DEV_PROFILE" "$DEV_IDENTITY" || fail "the development profile does not carry the certificate of '$DEV_IDENTITY'"
  printf '  --dev: %s lists this Mac and carries %s\n' "$(basename "$DEV_PROFILE")" "$DEV_IDENTITY"
fi

step "Building (MANUT_APP_STORE=1, tauri build --bundles app --no-sign, its own Rust folder)"
BUILD_CONF="$OUT/build.conf.json"
if [ "$DRY_RUN" = 0 ]; then
  cp "$PROFILE" "$OUT/embedded.provisionprofile"
  printf '{"bundle":{"macOS":{"bundleVersion":"%s","files":{"embedded.provisionprofile":"%s"}}}}\n' "$BUILD_NUMBER" "$OUT/embedded.provisionprofile" >"$BUILD_CONF"
fi
# Every Apple and updater credential is taken out of the build's environment: with none, Tauri neither notarizes nor
# signs an update, whatever the shell running this script holds.
BUILD=(env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH
  -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY -u TAURI_SIGNING_PRIVATE_KEY
  -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD MANUT_APP_STORE=1 CARGO_TARGET_DIR="$TARGET_DIR" CI=true
  pnpm --dir "$DESKTOP" --config.verify-deps-before-run=false tauri build --bundles app --no-sign
  --config "$OVERLAY" --config "$BUILD_CONF")
if [ "$DRY_RUN" = 1 ]; then
  run "${BUILD[@]}"
  printf '  (%s holds {"bundle":{"macOS":{"bundleVersion":"%s","files":{"embedded.provisionprofile":"%s/embedded.provisionprofile"}}}})\n' "$BUILD_CONF" "$BUILD_NUMBER" "$OUT"
else
  "${BUILD[@]}" >"$OUT/build.log" 2>&1 || { tail -40 "$OUT/build.log"; fail "the build failed; its log is $OUT/build.log"; }
  BUILT="$TARGET_DIR/release/bundle/macos/$PRODUCT.app"
  [ -d "$BUILT" ] || fail "no app at $BUILT"
  for f in "$TARGET_DIR/release/bundle/macos/"*.tar.gz "$TARGET_DIR/release/bundle/macos/"*.sig; do
    [ -e "$f" ] && fail "the build made an updater file: $(basename "$f")"
  done
  rm -rf "$APP"
  ditto "$BUILT" "$APP"
fi

step "Signing with $APP_IDENTITY (nested code first, then the app)"
sign_app "$APP" "$APP_IDENTITY"

step "Packaging for the Mac App Store, signed with $INSTALLER_IDENTITY"
run productbuild --component "$APP" /Applications --sign "$INSTALLER_IDENTITY" --timestamp=none "$PKG"

if [ "$DEV" = 1 ]; then
  step "Signing a development copy with $DEV_IDENTITY (runs on this Mac; never uploaded)"
  run rm -rf "$OUT/dev"
  run mkdir -p "$OUT/dev"
  run ditto "$APP" "$OUT/dev/$PRODUCT.app"
  run cp "$DEV_PROFILE" "$OUT/dev/$PRODUCT.app/Contents/embedded.provisionprofile"
  sign_app "$OUT/dev/$PRODUCT.app" "$DEV_IDENTITY"
fi

if [ "$DRY_RUN" = 1 ]; then
  step "Checks (each runs on the real build)"
  cat <<EOF
  codesign --verify --deep --strict, the leaf certificate, every nested signature by the same one, no timestamp
  codesign -d --entitlements :- compared with $(basename "$ENTITLEMENTS"), key for key
  the embedded profile: application identifier $TEAM_ID.$IDENTIFIER, team $TEAM_ID, a store profile
  Info.plist: CFBundleIdentifier, CFBundleName, CFBundleShortVersionString $VERSION, CFBundleVersion $BUILD_NUMBER,
    LSApplicationCategoryType developer-tools, ITSAppUsesNonExemptEncryption false, LSMinimumSystemVersion 12.0
  pkgutil --check-signature, then the app inside the package checked again
  Not run, ever: installer, altool, notarytool, Transporter, or any upload.
EOF
  exit 0
fi

step "Checking the app"
check_app "$APP" "Apple Distribution: " store

step "Checking the package"
pkgutil --check-signature "$PKG" >"$OUT/pkg-signature.txt" 2>&1 || true
grep -qE '^ +1\. (3rd Party Mac Developer Installer|Mac Installer Distribution): ' "$OUT/pkg-signature.txt" \
  || fail "the package is not signed with a Mac installer certificate: $(cat "$OUT/pkg-signature.txt")"
pass "pkgutil --check-signature: $(sed -nE 's/^ +1\. //p' "$OUT/pkg-signature.txt" | head -1)"
EXPANDED="$(mktemp -d)"
pkgutil --expand-full "$PKG" "$EXPANDED/x" >/dev/null
INNER="$(find "$EXPANDED/x" -maxdepth 4 -type d -name '*.app' | head -1)"
[ -n "$INNER" ] || fail "no app inside the package"
cat "$EXPANDED"/x/*.pkg/PackageInfo 2>/dev/null | grep -q 'install-location="/Applications"' || fail "the package does not install to /Applications"
codesign --verify --deep --strict "$INNER" 2>/dev/null || fail "the app inside the package does not verify"
pass "the app inside the package verifies, and installs to /Applications"
rm -rf "$EXPANDED"
note "not run  installer -pkg ... (the package is never installed here)"

if [ "$DEV" = 1 ]; then
  step "Checking the development copy"
  check_app "$OUT/dev/$PRODUCT.app" "Apple Development: " dev
fi

if [ "${KEEP_TARGET:-0}" != 1 ]; then
  step "Removing the Rust build folder ($(du -sh "$TARGET_DIR" 2>/dev/null | cut -f1))"
  rm -rf "$TARGET_DIR"
fi

printf '\nReady, not uploaded:\n  %s\n  %s\n' "$PKG" "$APP"
[ "$DEV" = 1 ] && printf '  %s (development, for this Mac only)\n' "$OUT/dev/$PRODUCT.app"
printf 'Checks: %s\nValidation and upload are App Store Connect steps for the owner (docs/app-store.md).\n' "$CHECKS"
