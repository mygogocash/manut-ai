// Tests for the nightly desktop workflow: its decisions (nightly.mjs) and the rules in its text that matter, because the
// workflow itself cannot be run here without spending build minutes and touching real releases. Run by `node --test`
// (the root `pnpm test` does).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { FEED_TAG, REQUIRED_PLATFORMS, buildFeed, lastBuiltSha, nightlyTag, nightlyVersion, releaseNotes, shouldBuild } from "./nightly.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/nightly-desktop.yml");
const code = workflow
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

const A = "a".repeat(40);
const B = "b".repeat(40);

/** Compares two versions as the updater does (semver 2: a prerelease is older than its release). */
function cmp(x, y) {
  const parse = (v) => {
    const [core, pre] = v.split("-");
    return { core: core.split(".").map(Number), pre: pre?.split(".") };
  };
  const a = parse(x);
  const b = parse(y);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [p, q] = [a.pre[i], b.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

describe("the nightly's tag and version", () => {
  it("tags a night nightly-<date> and refuses anything that is not a date", () => {
    assert.equal(nightlyTag("2026-11-27"), "nightly-2026-11-27");
    for (const bad of ["", "20261127", "2026-1-27", "nightly-2026-11-27", "2026-11-27\nx"]) assert.throws(() => nightlyTag(bad), /not a date/);
  });

  it("takes the next patch number as a prerelease, so it is newer than the stable it follows and older than the next stable", () => {
    assert.equal(nightlyVersion("0.1.1", "2026-11-27"), "0.1.2-nightly.20261127");
    assert.ok(cmp("0.1.2-nightly.20261127", "0.1.1") > 0, "newer than the stable it follows");
    assert.ok(cmp("0.1.2-nightly.20261127", "0.1.2") < 0, "older than the next stable");
    assert.ok(cmp("0.1.2-nightly.20261128", "0.1.2-nightly.20261127") > 0, "each night is newer than the one before");
    assert.ok(cmp("0.1.2-nightly.20261201", "0.1.2-nightly.20261130") > 0, "across a month's end");
    assert.ok(cmp("0.1.10-nightly.20261201", "0.1.9") > 0, "numbers, not text");
  });

  it("refuses a version that is not x.y.z", () => {
    for (const bad of ["", "0.1", "0.1.1-beta", "v0.1.1"]) assert.throws(() => nightlyVersion(bad, "2026-11-27"), /x\.y\.z/);
  });

  it("is the base version of the app's own tauri.conf.json that the workflow would start from", () => {
    const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json"));
    assert.match(nightlyVersion(conf.version, "2026-11-27"), /^\d+\.\d+\.\d+-nightly\.20261127$/);
  });
});

describe("building only when the branch changed", () => {
  const body = releaseNotes(A, "2026-11-27", "mygogocash/manut-ai");

  it("reads the last built commit from the feed release's body", () => {
    assert.equal(lastBuiltSha(body), A);
    assert.equal(lastBuiltSha(""), null);
    assert.equal(lastBuiltSha(null), null);
    assert.equal(lastBuiltSha("Built from commit abc"), null);
    assert.equal(lastBuiltSha(`See Built from commit ${A} somewhere in a line`), null, "only a line of its own counts");
  });

  it("skips a night when the branch has not moved, builds when it has, and builds when there is no nightly yet", () => {
    assert.equal(shouldBuild(A, body), false);
    assert.equal(shouldBuild(B, body), true);
    assert.equal(shouldBuild(A, ""), true);
    assert.equal(shouldBuild(A, "a hand-written note"), true);
  });

  it("builds an unchanged branch when a person asks for it by hand", () => {
    assert.equal(shouldBuild(A, body, true), true);
  });

  it("refuses a head that is not a full commit id", () => {
    for (const bad of ["", "main", "abc123", "A".repeat(40)]) assert.throws(() => shouldBuild(bad, body), /commit id/);
  });

  it("makes notes that say the build is unsigned and may break, and that carry the marker", () => {
    assert.match(body, /^Built from commit a{40}\n/);
    assert.match(body, /unsigned/);
    assert.match(body, /may break/);
    assert.match(body, /releases\/tag\/nightly-2026-11-27/);
    assert.match(body, /releases\/latest/);
  });
});

describe("the nightly feed", () => {
  const version = "0.1.2-nightly.20261127";
  const entry = (n) => ({ signature: `sig-${n}`, url: `https://api.github.com/repos/mygogocash/manut-ai/releases/assets/${n}` });
  const latest = (over = {}) => ({
    version,
    notes: "",
    pub_date: "2026-11-27T02:00:00Z",
    platforms: Object.fromEntries(REQUIRED_PLATFORMS.map((p, i) => [p, entry(i + 1)])),
    ...over,
  });

  it("names the four platforms the nightly builds", () => {
    assert.deepEqual(REQUIRED_PLATFORMS, ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]);
  });

  it("copies a complete latest.json as it is, signatures and all", () => {
    const out = JSON.parse(buildFeed(JSON.stringify(latest()), version));
    assert.deepEqual(out, latest());
  });

  it("keeps the extra platform entries tauri-action writes (the per-installer ones)", () => {
    const l = latest();
    l.platforms["linux-x86_64-appimage"] = entry(9);
    assert.ok(JSON.parse(buildFeed(JSON.stringify(l), version)).platforms["linux-x86_64-appimage"]);
  });

  it("refuses a feed for another version, so last night's files are never offered as tonight's", () => {
    assert.throws(() => buildFeed(JSON.stringify(latest({ version: "0.1.2-nightly.20261126" })), version), /version/);
  });

  it("refuses a feed that misses a platform, so a half-built night is never published", () => {
    for (const p of REQUIRED_PLATFORMS) {
      const l = latest();
      delete l.platforms[p];
      assert.throws(() => buildFeed(JSON.stringify(l), version), new RegExp(p));
    }
  });

  it("refuses an empty signature or an address that is not https", () => {
    const noSig = latest();
    noSig.platforms["linux-x86_64"].signature = " ";
    assert.throws(() => buildFeed(JSON.stringify(noSig), version), /signature/);
    const http = latest();
    http.platforms["windows-x86_64"].url = "http://example.com/x.exe";
    assert.throws(() => buildFeed(JSON.stringify(http), version), /https/);
  });

  it("works from the command line the workflow uses, and refuses with a message and a failing exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-"));
    const src = join(dir, "latest.json");
    const out = join(dir, "nightly.json");
    writeFileSync(src, JSON.stringify(latest()));
    const run = (...args) => execFileSync("node", [join(here, "nightly.mjs"), ...args], { encoding: "utf8" }).trim();
    assert.equal(run("tag", "2026-11-27"), "nightly-2026-11-27");
    assert.equal(run("version", "0.1.1", "2026-11-27"), version);
    assert.equal(run("decide", A, ""), "build=true");
    assert.equal(run("decide", A, `Built from commit ${A}`), "build=false");
    assert.equal(run("decide", A, `Built from commit ${A}`, "force"), "build=true");
    run("feed", src, out, version);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), latest());
    assert.throws(() => execFileSync("node", [join(here, "nightly.mjs"), "feed", src, out, "9.9.9"], { stdio: "pipe" }), /version/);
  });
});

describe("Nightly desktop: when it runs and what it may do", () => {
  const on = code.slice(code.indexOf("\non:"), code.indexOf("\nconcurrency:"));

  it("runs on a schedule and by hand, never on a push or a pull request", () => {
    assert.match(on, /schedule:\n {4}- cron: "\d+ \d+ \* \* \*"/);
    assert.match(on, /workflow_dispatch:/);
    assert.doesNotMatch(code, /pull_request/);
    assert.doesNotMatch(on, /push:/);
    assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort(), ["schedule", "workflow_dispatch"]);
  });

  it("builds pilot/week-1 and nothing else", () => {
    assert.match(code, /BRANCH: pilot\/week-1/);
    assert.match(code, /ref: \$\{\{ needs\.decide\.outputs\.sha \}\}/);
    assert.doesNotMatch(code, /ref: (main|\$\{\{ github\.ref)/);
  });

  it("decides first and builds only when it said so", () => {
    assert.match(code, /\n {2}decide:\n/);
    assert.match(code, /nightly\.mjs decide/);
    assert.match(code, /if: \$\{\{ needs\.decide\.outputs\.build == 'true' \}\}/);
  });

  it("makes each night a published prerelease named nightly-<date>, never a full release and never latest", () => {
    assert.match(code, /releaseDraft: false/);
    assert.match(code, /prerelease: true/);
    assert.doesNotMatch(code, /prerelease: false/);
    assert.doesNotMatch(code, /releaseDraft: true/);
    assert.match(code, /tagName: \$\{\{ needs\.decide\.outputs\.tag \}\}/);
    assert.match(code, /--prerelease/);
    assert.doesNotMatch(code, /--latest(?!=false)/);
    assert.doesNotMatch(code, /gh release (delete|edit .*--draft=false)/);
  });

  it("builds one platform after the other, so all share one release and one latest.json", () => {
    assert.match(code, /max-parallel: 1/);
    for (const t of ["aarch64-apple-darwin", "x86_64-apple-darwin", "ubuntu", "windows"]) assert.match(code, new RegExp(t));
    assert.equal([...code.matchAll(/uses: tauri-apps\/tauri-action@/g)].length, 1, "one build step for the whole matrix");
  });

  it("signs the updater files with the secrets the stable release uses, by name, and holds no value of its own", () => {
    assert.match(code, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
    assert.match(code, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
    for (const [, value] of workflow.matchAll(/^\s+TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?:\s*(.*)$/gm)) assert.match(value, /^\$\{\{ secrets\.\w+ \}\}$/);
    assert.doesNotMatch(workflow, /BEGIN [A-Z ]*PRIVATE KEY/);
    assert.doesNotMatch(code, /APPLE_/, "a nightly is never notarized, so it needs no Apple secret");
    assert.doesNotMatch(code, /echo .*\$\{?TAURI_SIGNING/);
  });

  it("overrides the version with the nightly's, and signs the Mac app ad hoc", () => {
    assert.match(code, /nightly\.mjs version/);
    assert.match(code, /"signingIdentity":"-"/);
  });

  it("publishes the feed only after every build passed, to the fixed nightly release", () => {
    const feed = code.slice(code.indexOf("\n  feed:\n"));
    assert.match(feed, /needs: \[decide, build\]/);
    assert.match(feed, /if: \$\{\{ needs\.build\.result == 'success' \}\}/);
    assert.match(feed, /nightly\.mjs feed/);
    assert.match(feed, /gh release upload "\$FEED_TAG" nightly\.json --clobber/);
    assert.match(code, new RegExp(`FEED_TAG: ${FEED_TAG}\\n`));
    // the marker that says "built from" is written last, so a night that failed is tried again
    assert.ok(feed.indexOf("gh release upload") < feed.indexOf("--notes-file"), "the notes (and so the marker) come after the feed");
  });

  it("gives write access only to the jobs that make or edit a release", () => {
    assert.match(code, /\npermissions:\n {2}contents: read\n/);
    const decide = code.slice(code.indexOf("\n  decide:\n"), code.indexOf("\n  build:\n"));
    assert.doesNotMatch(decide, /contents: write/);
    assert.equal([...code.matchAll(/contents: write/g)].length, 2, "build and feed");
  });

  it("pins every third-party action to a full commit", () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith("./"));
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
    // the same tauri-action commit as the stable release's workflow
    const stable = read(".github/workflows/release-desktop.yml").match(/tauri-apps\/tauri-action@([0-9a-f]{40})/)[1];
    assert.match(code, new RegExp(`tauri-apps/tauri-action@${stable}`));
  });
});
