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

  it("builds both Mac chips", () => {
    const mac = job("mac");
    assert.match(mac, /target: aarch64-apple-darwin/);
    assert.match(mac, /target: x86_64-apple-darwin/);
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
