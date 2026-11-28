// The decisions of the nightly desktop workflow (.github/workflows/nightly-desktop.yml) as plain functions, so a test can
// run them: the workflow itself cannot be run without spending build minutes and touching real releases.
//
// Usage from the workflow (each prints one value or writes one file, and exits 1 with a reason on a refusal):
//   node nightly.mjs tag <YYYY-MM-DD>                       -> nightly-2026-11-27
//   node nightly.mjs version <base version> <YYYY-MM-DD>    -> 0.1.2-nightly.20261127
//   node nightly.mjs decide <head sha> <body of the nightly release or ""> [force]   -> build=true|false
//   node nightly.mjs updater <the nightly's public key>    -> pubkey=... and updater={...}, the build's updater config
//   node nightly.mjs feed <latest.json> <nightly.json> <version> <the nightly's public key>
//                                                           (checks the feed names every platform, then writes it)
//   node nightly.mjs notes <head sha> <date> <repo>         -> the body of the nightly release, on stdout
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The platforms a nightly must name before its feed is published, as tauri-action 1.0 names them in latest.json. */
export const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"];

/** The fixed release that holds nightly.json (src-tauri/src/update_channel.rs reads its download address). */
export const FEED_TAG = "nightly";

/** That download address, the same as update_channel.rs's NIGHTLY_FEED (a test pins the two together). */
export const NIGHTLY_FEED = `https://github.com/mygogocash/manut-ai/releases/download/${FEED_TAG}/nightly.json`;

/** The repository variable that holds the nightly's public key, and where the owner reads how to make it. */
export const PUBKEY_VAR = "NIGHTLY_UPDATER_PUBKEY";
const PUBKEY_DOC = `docs/releasing.md, "The nightly's own updater key"`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The line the feed's release body carries, which is the whole memory of "what was the last nightly built from". */
const MARKER = /^Built from commit ([0-9a-f]{40})$/m;

/** The tag of a night's release. */
export function nightlyTag(date) {
  if (!DATE.test(date)) throw new Error(`not a date like 2026-11-27: ${date}`);
  return `nightly-${date}`;
}

/**
 * The version a night's build carries. The updater installs only a version newer than the running one (semver), and
 * `0.1.1-nightly.x` is OLDER than `0.1.1`, so a Mac on stable 0.1.1 would never be offered it. So the nightly takes the
 * next patch number as a prerelease: newer than the stable it follows, older than the stable release that comes next, and
 * each night's date is a larger number than the night before.
 */
export function nightlyVersion(base, date) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!m) throw new Error(`the app's version is not x.y.z: ${base}`);
  const tag = nightlyTag(date);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}-nightly.${tag.slice("nightly-".length).replaceAll("-", "")}`;
}

/** The commit the last nightly was built from, read from the feed release's body, or null when it names none. */
export function lastBuiltSha(body) {
  return MARKER.exec(body ?? "")?.[1] ?? null;
}

/** Whether tonight builds: when the branch moved since the last nightly, or a person asked for one by hand. */
export function shouldBuild(headSha, body, force = false) {
  if (!SHA.test(headSha)) throw new Error(`not a full commit id: ${headSha}`);
  return force || lastBuiltSha(body) !== headSha;
}

/** The body of the feed release: the marker, then what a person needs to know before trying a nightly. */
export function releaseNotes(headSha, date, repo) {
  if (!SHA.test(headSha)) throw new Error(`not a full commit id: ${headSha}`);
  return [
    `Built from commit ${headSha}`,
    "",
    `The newest nightly build of Manut AI, from the ${nightlyTag(date)} release: https://github.com/${repo}/releases/tag/${nightlyTag(date)}`,
    "",
    "This release holds only nightly.json, the update feed the app reads when Settings > General > Updates > Channel is Nightly.",
    "A nightly is unsigned (macOS and Windows warn before opening it), is made from work in progress, and may break.",
    "Its updates are signed with a key of the nightly channel's own, so a nightly build updates only to the next nightly; to go back to Stable, install the stable release.",
    "Install a stable release instead from https://github.com/" + repo + "/releases/latest",
  ].join("\n");
}

/**
 * The 8-byte key id of a minisign public key as tauri.conf.json carries one: base64 of "untrusted comment: ...", a
 * newline, then base64 of "Ed", the id and the 32-byte key. The same decoding as the release skill's verify-release.mjs.
 * Only one line of base64 is accepted, so nothing else (a quote, a space, a second line) can ride into a build's config.
 */
export function publicKeyId(pubkey) {
  if (typeof pubkey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)) throw new Error("it is not one line of base64");
  const [comment, line] = Buffer.from(pubkey, "base64").toString("utf8").split("\n");
  const key = Buffer.from(line ?? "", "base64");
  if (!/^untrusted comment: minisign public key/.test(comment) || key.length !== 42 || key.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("it is not a minisign public key");
  }
  return key.subarray(2, 10);
}

/** The key id a minisign signature names: base64 of its text, whose second line is "ED" or "Ed", the id, then 64 bytes. */
export function signatureKeyId(signature) {
  const line = Buffer.from(signature, "base64").toString("utf8").split("\n")[1] ?? "";
  const sig = Buffer.from(line, "base64");
  if (sig.length !== 74 || !["ED", "Ed"].includes(sig.subarray(0, 2).toString("latin1"))) throw new Error("not a minisign signature");
  return sig.subarray(2, 10);
}

/**
 * The updater config every nightly build is made with (item 141): the nightly's own public key, which the owner keeps
 * in the repository variable NIGHTLY_UPDATER_PUBKEY, and Nightly's feed as the endpoint. A nightly build then trusts only
 * files signed with the nightly key and reads only nightly.json, whichever channel its Settings row shows, since the
 * stable feed's files could never pass its check. It refuses no key (tonight's builds would trust nothing), anything that
 * is not a public key, and the stable channel's own key, so the nightly can never sign with that again.
 */
export function nightlyUpdater(pubkey, stablePubkey) {
  const key = (pubkey ?? "").trim();
  if (!key) throw new Error(`${PUBKEY_VAR} is not set, so tonight's builds would trust no update key. Nothing was built (${PUBKEY_DOC}).`);
  let id;
  try {
    id = publicKeyId(key);
  } catch (e) {
    throw new Error(`${PUBKEY_VAR} is not the .pub file of a Tauri signer key: ${e.message}. Nothing was built (${PUBKEY_DOC}).`);
  }
  if (id.equals(publicKeyId(stablePubkey))) {
    throw new Error(`${PUBKEY_VAR} is the stable channel's key, and the nightly must have one of its own. Nothing was built (${PUBKEY_DOC}).`);
  }
  return { pubkey: key, endpoints: [NIGHTLY_FEED] };
}

/**
 * Checks tauri-action's latest.json for this night and returns the text of nightly.json. It refuses a feed that names a
 * different version, misses a platform, or holds an address or signature that is empty or not https, so a build that
 * failed half way never reaches the people who follow Nightly. The signatures are copied as they are, after checking each
 * names the key nightly builds trust: the Tauri CLI only warns when its signing key does not match the build's public key,
 * and a feed signed with another key would be offered to every Nightly Mac and refused by each after the download.
 */
export function buildFeed(latestText, version, pubkey) {
  const trusted = publicKeyId(pubkey);
  const latest = JSON.parse(latestText);
  if (latest.version !== version) throw new Error(`latest.json says version ${latest.version}, this night is ${version}`);
  const platforms = latest.platforms ?? {};
  const missing = REQUIRED_PLATFORMS.filter((p) => !platforms[p]);
  if (missing.length) throw new Error(`latest.json names no ${missing.join(", ")}`);
  for (const [name, p] of Object.entries(platforms)) {
    if (typeof p?.signature !== "string" || !p.signature.trim()) throw new Error(`${name} has no signature`);
    if (typeof p?.url !== "string" || !p.url.startsWith("https://")) throw new Error(`${name} has no https address`);
    if (!signatureKeyId(p.signature).equals(trusted)) throw new Error(`${name} is signed with another key than ${PUBKEY_VAR}`);
  }
  return `${JSON.stringify(latest, null, 2)}\n`;
}

function main(argv) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case "tag":
      return nightlyTag(a[0]);
    case "version":
      return nightlyVersion(a[0], a[1]);
    case "decide":
      return `build=${shouldBuild(a[0], a[1], a[2] === "force")}`;
    case "updater": {
      // the stable key is read from the app's own config, so a rotated stable key is refused too
      const conf = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop", "src-tauri", "tauri.conf.json");
      const updater = nightlyUpdater(a[0], JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey);
      return `pubkey=${updater.pubkey}\nupdater=${JSON.stringify(updater)}`;
    }
    case "feed":
      writeFileSync(a[1], buildFeed(readFileSync(a[0], "utf8"), a[2], a[3]));
      return `wrote ${a[1]}`;
    case "notes":
      return releaseNotes(a[0], a[1], a[2]);
    default:
      throw new Error("usage: nightly.mjs tag|version|decide|updater|feed|notes ...");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`nightly.mjs: ${e.message}`);
    process.exit(1);
  }
}
