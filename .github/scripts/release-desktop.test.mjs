// Tests for the Release desktop workflow, run by `node --test` (the root `pnpm test` does). The workflow cannot be run
// without spending macOS minutes and touching a real release, so these read its text and pin the rules that matter:
// it runs only on purpose, never publishes, never releases a Windows file, and holds no secret value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/release-desktop.yml");
/** The workflow without its comment lines, so a rule is checked against what runs and not what is explained. */
const code = workflow
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");
/** The text of one top-level job, from its name to the next job. */
const job = (name) => {
  const start = code.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name}`);
  const next = code.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
  return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
};

describe("Release desktop: when it runs", () => {
  const on = code.slice(code.indexOf("\non:"), code.indexOf("\nconcurrency:"));

  it("starts only by hand or on a desktop-v tag", () => {
    assert.match(on, /workflow_dispatch:/);
    assert.match(on, /tags: \["desktop-v\*"\]/);
  });

  it("never names a pull request, a branch push or a schedule", () => {
    assert.doesNotMatch(code, /pull_request/);
    assert.doesNotMatch(on, /branches/);
    assert.doesNotMatch(on, /schedule:/);
    assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort(), ["push", "workflow_dispatch"]);
  });
});

describe("Release desktop: the release", () => {
  it("always makes the release a draft and never publishes it", () => {
    const drafts = [...code.matchAll(/releaseDraft:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(drafts.length >= 2, "both Mac build steps say so");
    assert.deepEqual([...new Set(drafts)], ["true"]);
    assert.doesNotMatch(code, /releaseDraft:\s*false/);
    assert.doesNotMatch(code, /gh release (edit|create|publish)/);
    assert.doesNotMatch(code, /--draft=false|draft:\s*false/);
  });

  it("does not make a prerelease or move latest.json by itself", () => {
    assert.doesNotMatch(code, /prerelease:\s*true/);
    assert.doesNotMatch(code, /releaseId/);
  });

  it("gives only the Mac job write access to the repository", () => {
    assert.match(code, /\npermissions:\n {2}contents: read\n/);
    assert.equal([...code.matchAll(/contents: write/g)].length, 1);
    assert.match(job("mac"), /contents: write/);
    assert.doesNotMatch(job("windows"), /contents: write|tauri-action|GITHUB_TOKEN/);
  });

  it("never attaches a Windows file to the release: the Windows job only uploads a workflow artifact", () => {
    const windows = job("windows");
    assert.match(windows, /actions\/upload-artifact@/);
    assert.doesNotMatch(windows, /gh release|releaseDraft|tagName|upload-release|softprops/);
    assert.doesNotMatch(job("mac"), /windows|nsis|\.exe|\.msi/i);
    assert.doesNotMatch(code, /windows-latest[\s\S]*tauri-apps\/tauri-action/);
  });

  it("builds the Windows installer only when a run started by hand asks for it, never for a release's tag", () => {
    const on = code.slice(code.indexOf("\non:"), code.indexOf("\nconcurrency:"));
    assert.match(on, /workflow_dispatch:\n {4}inputs:\n {6}windows:\n(?: {8}.*\n)*? {8}default: false\n/);
    assert.match(job("windows"), /\n {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.windows \}\}\n/);
    assert.doesNotMatch(job("mac"), /inputs\.windows/);
  });

  it("builds both Mac chips", () => {
    const mac = job("mac");
    assert.match(mac, /target: aarch64-apple-darwin/);
    assert.match(mac, /target: x86_64-apple-darwin/);
  });

  it("builds the two chips one after the other, so they share one draft and one latest.json", () => {
    // The action makes a draft when it finds none for the tag, and rewrites latest.json from the one it reads: two
    // builds finishing together could make two drafts, or leave a latest.json that names one chip only.
    const mac = job("mac");
    assert.match(mac, /strategy:\n(?: {6}.*\n)*? {6}max-parallel: 1\n/);
    assert.equal([...mac.matchAll(/tagName: (\S+)/g)].map((m) => m[1]).join(), "desktop-v__VERSION__,desktop-v__VERSION__");
  });
});

describe("Release desktop: secrets", () => {
  it("reads every secret from GitHub secrets and holds no value of its own", () => {
    const names = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];
    for (const name of names) {
      for (const [, value] of workflow.matchAll(new RegExp(`^\\s+${name}:\\s*(.*)$`, "gm"))) {
        assert.match(value, /^\$\{\{ secrets\.\w+ \}\}$/, `${name} is set from a secret`);
      }
    }
    assert.doesNotMatch(workflow, /BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it("falls back to an unsigned build and says so in the summary, so a missing secret does not fail the run", () => {
    assert.match(code, /steps\.apple\.outputs\.signed != 'true'/);
    assert.match(code, /UNSIGNED build/);
    assert.match(code, /GITHUB_STEP_SUMMARY/);
  });
});

describe("Release desktop: pinned actions", () => {
  it("pins every third-party action to a full commit, as ci.yml does", () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./"));
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  });
});

describe("the app's updater is tied to the release", () => {
  const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));

  it("pins Manut AI's own key, id C74B6B3F298928A7", () => {
    const pub = Buffer.from(conf.plugins.updater.pubkey, "base64").toString("utf8");
    assert.match(pub, /minisign public key: C74B6B3F298928A7/);
  });

  it("asks an https endpoint on this repository's latest release, which skips drafts", () => {
    const [endpoint, ...rest] = conf.plugins.updater.endpoints;
    assert.equal(rest.length, 0);
    assert.equal(endpoint, "https://github.com/mygogocash/manut-ai/releases/latest/download/latest.json");
  });

  it("makes updater files, which the workflow signs with the updater key", () => {
    assert.equal(conf.bundle.createUpdaterArtifacts, true);
    assert.match(job("mac"), /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  });

  it("matches the workflow's tag shape to the app's version", () => {
    assert.match(conf.version, /^\d+\.\d+\.\d+$/);
    assert.match(code, /desktop-v\$version/);
  });
});

describe("the Mac app may use the microphone for voice in the chat box", () => {
  // Item 81 (docs/voice.md): Tauri signs with the hardened runtime, with a Developer ID or ad hoc, and under it the
  // microphone needs the audio-input entitlement; macOS shows the two usage lines in its prompts, and an app that asks
  // for speech recognition without its line is closed by macOS.
  const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
  const plistKeys = (text) => [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);

  it("signs both builds with the one entitlement the microphone needs, and nothing else", () => {
    assert.equal(conf.bundle.macOS.entitlements, "./Entitlements.plist");
    const ent = read("apps/desktop/src-tauri/Entitlements.plist");
    assert.deepEqual(plistKeys(ent), ["com.apple.security.device.audio-input"]);
    assert.match(ent, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
    // the unsigned build only changes the identity, so it keeps the entitlement; neither turns the hardened runtime off
    assert.match(job("mac"), /--config '\{"bundle":\{"macOS":\{"signingIdentity":"-"\}\}\}'/);
    assert.notEqual(conf.bundle.macOS.hardenedRuntime, false);
    assert.doesNotMatch(code, /hardenedRuntime/);
  });

  it("says in Info.plist why it asks for the microphone and for speech recognition", () => {
    const info = read("apps/desktop/src-tauri/Info.plist");
    assert.deepEqual(plistKeys(info), ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]);
    assert.match(info, /Nothing is recorded or kept\./);
    assert.match(info, /Apple's servers do it, and Manut AI asks you first\./);
  });
});
