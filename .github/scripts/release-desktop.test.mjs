// Tests for the Release desktop workflow, run by `node --test` (the root `pnpm test` does). The workflow cannot be run
// without spending macOS minutes and touching a real release, so these read its text and pin the rules that matter:
// it runs only on purpose, never publishes, releases Mac, Linux and Windows files into one draft, and holds no secret value.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { updateFileName } from "../../.claude/skills/release-desktop/scripts/release-assets.mjs";

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
/** Every top-level job as [name, text]. */
const jobs = () => [...code.slice(code.indexOf("\njobs:\n")).matchAll(/\n {2}([a-z][a-z-]*):\n/g)].map((m) => [m[1], job(m[1])]);
/** A signing secret: Apple's five, the stable updater key, or the nightly's. */
const SIGNING = /secrets\.(APPLE_|TAURI_SIGNING_|NIGHTLY_SIGNING_)/;

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

  it("gives write access only to the three jobs that put a build into the draft", () => {
    assert.match(code, /\npermissions:\n {2}contents: read\n/);
    assert.equal([...code.matchAll(/contents: write/g)].length, 3);
    for (const name of ["mac", "linux", "windows"]) assert.match(job(name), /contents: write/);
  });

  it("releases a Linux AppImage and .deb, and a Windows NSIS installer, into the same draft as the Mac builds", () => {
    const linux = job("linux");
    assert.match(linux, /args: --bundles appimage,deb\n/);
    assert.match(linux, /uses: tauri-apps\/tauri-action@/);
    assert.match(linux, /tagName: desktop-v__VERSION__/);
    assert.match(linux, /releaseDraft: true/);
    const windows = job("windows");
    assert.match(windows, /args: --bundles nsis\n/);
    assert.match(windows, /uses: tauri-apps\/tauri-action@/);
    assert.match(windows, /tagName: desktop-v__VERSION__/);
    assert.match(windows, /releaseDraft: true/);
    assert.doesNotMatch(job("mac"), /windows|nsis|\.exe|\.msi|appimage|\.deb/i);
    // no workflow-artifact stand-in any more: the files are in the release
    assert.doesNotMatch(code, /upload-artifact/);
  });

  it("builds Linux and Windows without any signing secret but the updater's, which signs their update files", () => {
    for (const name of ["linux", "windows"]) {
      const text = job(name);
      assert.doesNotMatch(text, /APPLE_/);
      assert.match(text, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
      assert.match(text, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
    }
    assert.match(job("windows"), /UNSIGNED. SmartScreen warns/);
  });

  it("builds every platform on every release run, one after the other: Mac, then Linux, then Windows", () => {
    const on = code.slice(code.indexOf("\non:"), code.indexOf("\nconcurrency:"));
    assert.doesNotMatch(on, /inputs:/);
    assert.doesNotMatch(code, /inputs\.windows/);
    assert.match(job("linux"), /\n {4}needs: mac\n/);
    assert.match(job("windows"), /\n {4}needs: \[mac, linux\]\n/);
    // neither runs unless the Mac job, which checks the tag, succeeded
    assert.match(job("linux"), /needs\.mac\.result == 'success'/);
    assert.match(job("windows"), /needs\.mac\.result == 'success'/);
  });

  it("has a release notes template that tells Windows people SmartScreen warns until the build is code-signed", () => {
    const template = read("docs/release-notes-template.md");
    assert.match(template, /SmartScreen/);
    assert.match(template, /code-sign/i);
    assert.match(template, /AppImage/);
    assert.match(template, /\.deb/);
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
    // every job that adds to the draft names the same tag
    assert.equal([...code.matchAll(/tagName: (\S+)/g)].length, 4);
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

  // Item 141 (the sixth security read's M2): a secret a job reads without naming an environment is a repository secret,
  // which a run of any branch can read. The release environment lets only main and desktop-v tags in, with the owner's
  // approval, so every job that reads a signing secret must name it, and a job that reads none must not ask for approval.
  it("names the release environment on every job that reads a signing secret, and on no other", () => {
    const named = [];
    for (const [name, text] of jobs()) {
      const environment = text.match(/\n {4}environment: (\S+)\n/)?.[1];
      if (SIGNING.test(text)) {
        assert.equal(environment, "release", `${name} reads a signing secret`);
        named.push(name);
      } else assert.equal(environment, undefined, `${name} reads no signing secret`);
    }
    assert.deepEqual(named, ["mac", "linux", "windows"]);
    // no secret is read above the jobs, where no environment could hold it
    assert.doesNotMatch(code.slice(0, code.indexOf("\njobs:\n")), /secrets\./);
    assert.equal([...code.matchAll(/environment:/g)].length, 3, "an environment is named only at a job's top level");
  });

  it("never reads the nightly's key, which signs only nightly builds", () => {
    assert.doesNotMatch(code, /NIGHTLY_SIGNING|NIGHTLY_UPDATER/);
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

  it("builds every platform with the same tauri-action commit", () => {
    const pins = [...code.matchAll(/uses:\s*tauri-apps\/tauri-action@([0-9a-f]{40})/g)].map((m) => m[1]);
    assert.equal(pins.length, 4);
    assert.equal(new Set(pins).size, 1);
  });
});

describe("checking a draft: the file each latest.json address names", () => {
  // tauri-action 0.6 wrote download addresses; from 1.0 it writes the asset's GitHub API address, which names no file,
  // so the release skill's verify-release.mjs reads the name from the release's asset list (`gh release view --json`).
  const api = (id) => `https://api.github.com/repos/mygogocash/manut-ai/releases/assets/${id}`;
  const assets = [
    { apiUrl: api(791021204), name: "Manut.AI_0.1.2_aarch64.app.tar.gz" },
    { apiUrl: api(791036773), name: "latest.json" },
  ];

  it("reads the file from a download address, as 0.6 wrote one", () => {
    const url = "https://github.com/mygogocash/manut-ai/releases/download/desktop-v0.1.1/Manut.AI_aarch64.app.tar.gz";
    assert.deepEqual(updateFileName(url, undefined), { name: "Manut.AI_aarch64.app.tar.gz" });
    assert.deepEqual(updateFileName(url, assets), { name: "Manut.AI_aarch64.app.tar.gz" });
  });

  it("reads the file from an asset address through the release's asset list, as 1.0 writes one", () => {
    assert.deepEqual(updateFileName(api(791021204), assets), { name: "Manut.AI_0.1.2_aarch64.app.tar.gz" });
  });

  it("asks for the asset list rather than guess a file, and refuses what is not this release's", () => {
    assert.match(updateFileName(api(791021204), undefined).error, /asset list/);
    assert.match(updateFileName(api(1), assets).error, /no asset/);
    assert.match(updateFileName("https://api.github.com/repos/someone/else/releases/assets/791021204", assets).error, /not this repository/);
    assert.match(updateFileName("https://github.com/someone/else/releases/download/v1/x.app.tar.gz", assets).error, /not this repository/);
    assert.match(updateFileName(`${api(791021204)}/extra`, assets).error, /not this repository/);
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
