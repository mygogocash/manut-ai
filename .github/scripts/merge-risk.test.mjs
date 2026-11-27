// Tests for the classifier that decides whether a change may merge on a green CI run alone (merge-risk.mjs, item 130).
// A wrong `low` would let work past the lead's review, so each rule is pinned from both sides: what it lets through and
// what it refuses. The rules run on synthetic file contents, and the command line runs against a temporary git
// repository. Nothing reaches GitHub.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { bumpProblem, classify, cargoSpecProblem, declaresRefactor, npmSpecProblem } from "./merge-risk.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "merge-risk-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Classifies a change given as `{status, path, old, new}` rows. */
function run(rows, message = "") {
  const byPath = new Map(rows.map((r) => [r.path, r]));
  return classify({
    files: rows.map((r) => ({ status: r.status ?? "M", path: r.path, oldMode: r.oldMode, newMode: r.newMode })),
    readOld: (p) => byPath.get(p).old ?? "",
    readNew: (p) => byPath.get(p).new ?? "",
    message,
  });
}
const risk = (rows, message) => run(rows, message).risk;
const why = (rows, message) => run(rows, message).lines.filter((l) => !l.ok).map((l) => `${l.path}: ${l.text}`).join("\n");
const REFACTOR = "Merge item 9\n\nRisk: refactor\nCo-Authored-By: Claude <noreply@anthropic.com>\n";

describe("versions", () => {
  it("lets a minor and a patch step up through, and nothing else", () => {
    assert.equal(bumpProblem("1.2.3", "1.2.4"), "");
    assert.equal(bumpProblem("1.2.3", "1.3.0"), "");
    assert.equal(bumpProblem("1.2.3", "1.2.3"), "");
    assert.match(bumpProblem("1.2.3", "2.0.0"), /major/);
    assert.match(bumpProblem("1.2.3", "1.2.2"), /went down/);
    assert.match(bumpProblem("1.2.3", "1.3.0-beta.1"), /cannot be read/);
  });

  it("counts a 0.x minor as major, and a 0.x patch as a patch", () => {
    assert.match(bumpProblem("0.4.1", "0.5.0"), /0\.x minor/);
    assert.equal(bumpProblem("0.4.1", "0.4.9"), "");
    assert.match(bumpProblem("0.0.1", "0.1.0"), /0\.x minor/);
  });

  it("reads npm ranges and aliases, and refuses a changed operator or a range it cannot read", () => {
    assert.equal(npmSpecProblem("^1.2.0", "^1.3.1"), "");
    assert.equal(npmSpecProblem("~1.2.0", "~1.2.5"), "");
    assert.equal(npmSpecProblem("workspace:*", "workspace:*"), "");
    assert.equal(npmSpecProblem("npm:@typescript/typescript6@6.0.2", "npm:@typescript/typescript6@6.0.3"), "");
    assert.match(npmSpecProblem("^1.2.0", "~1.2.0"), /operator/);
    assert.match(npmSpecProblem("^1.2.0", "^2.0.0"), /major/);
    assert.match(npmSpecProblem("latest", "next"), /cannot be read/);
    assert.match(npmSpecProblem("npm:a@1.0.0", "npm:b@1.0.1"), /alias changed/);
    assert.match(npmSpecProblem("^1.2.0", ">=1.2.0 <3"), /cannot be read/);
  });

  it("reads cargo requirements, with missing parts as zero", () => {
    assert.equal(cargoSpecProblem("1.2", "1.3"), "");
    assert.equal(cargoSpecProblem("0.11.1", "0.11.2"), "");
    assert.match(cargoSpecProblem("0.10", "0.11"), /0\.x minor/);
    assert.match(cargoSpecProblem("1", "2"), /major/);
    assert.match(cargoSpecProblem("1.2", ">=1.2, <2"), /cannot be read/);
  });
});

describe("documentation", () => {
  it("is low for Markdown anywhere, docs text and pictures under docs/assets", () => {
    assert.equal(risk([{ path: "docs/code-editor.md", old: "a", new: "b" }, { path: "README.md", old: "a", new: "b" },
      { path: "docs/notes.txt", old: "a", new: "b" }, { status: "A", path: "docs/assets/shot.png", new: "" },
      { status: "A", path: "docs/assets/photo.JPG", new: "" }]), "low");
  });

  it("is review for a picture outside docs/assets, an svg, a script or data under docs/", () => {
    assert.equal(risk([{ status: "A", path: "docs/shot.png", new: "" }]), "review");
    assert.equal(risk([{ status: "A", path: "docs/assets/art.svg", new: "" }]), "review");
    assert.equal(risk([{ status: "A", path: "docs/tool.mjs", new: "x" }]), "review");
    assert.equal(risk([{ status: "A", path: "docs/data.json", new: "{}" }]), "review");
  });

  it("is review for what steers agents or describes security, even though it is Markdown", () => {
    for (const path of ["CLAUDE.md", "apps/desktop/CLAUDE.md", "AGENTS.md", ".claude/skills/helper/SKILL.md", "docs/security.md",
      "docs/threat-model.md", "SECURITY.md", "docs/security/reads.md", "docs/privacy.md"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }]), "review", path);
    }
  });

  it("is review for the plan, the handoff and the decisions, which agents read as their rules", () => {
    for (const path of ["docs/plan.md", "docs/handoff.md", "docs/decisions/139-omp-asks.md", "docs/decisions/README.md"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }]), "review", path);
      assert.match(why([{ path, old: "a", new: "b" }]), /the plan, the handoff or a decision/);
    }
    // A doc beside them that agents do not read as rules stays low.
    assert.equal(risk([{ path: "docs/plan-notes.md", old: "a", new: "b" }]), "low");
  });

  it("is review for CI, the classifier itself and the agents' rules, whatever the change", () => {
    for (const path of [".github/workflows/ci.yml", ".github/scripts/merge-risk.mjs", ".github/dependabot.yml",
      ".claude/skills/lead-merge/scripts/auto-merge.sh", ".claude/settings.json"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }], REFACTOR), "review", path);
    }
  });

  it("is review for an empty diff, a symlink, a changed mode and a new executable", () => {
    assert.equal(risk([]), "review");
    assert.equal(risk([{ path: "docs/a.md", old: "", new: "x", oldMode: "120000", newMode: "120000" }]), "review");
    assert.equal(risk([{ path: "docs/a.md", old: "a", new: "a", oldMode: "100644", newMode: "100755" }]), "review");
    assert.equal(risk([{ status: "A", path: "docs/a.md", new: "x", newMode: "100755" }]), "review");
  });

  it("is review for any file no rule names, so one source file among docs holds the whole change back", () => {
    const rows = [{ path: "docs/plan.md", old: "a", new: "b" }, { path: "apps/api/src/index.ts", old: "a", new: "b" }];
    assert.equal(risk(rows), "review");
    assert.match(why(rows), /apps\/api\/src\/index\.ts: no rule covers it/);
  });
});

const pkg = (deps, extra = {}) => JSON.stringify({ name: "x", version: "1.0.0", ...extra, dependencies: deps }, null, 2);

describe("package.json", () => {
  it("is low when every changed version is a minor or patch step", () => {
    assert.equal(risk([{ path: "apps/a/package.json", old: pkg({ a: "^1.0.0", b: "~2.1.0" }), new: pkg({ a: "^1.4.2", b: "~2.1.9" }) }]), "low");
  });

  it("is low for the package manager's own pin stepping up, review for a major step", () => {
    const m = (v) => JSON.stringify({ name: "r", packageManager: `pnpm@${v}` });
    assert.equal(risk([{ path: "package.json", old: m("12.21.0"), new: m("12.23.0") }]), "low");
    assert.equal(risk([{ path: "package.json", old: m("12.21.0"), new: m("13.0.0") }]), "review");
    assert.equal(risk([{ path: "package.json", old: m("12.21.0"), new: JSON.stringify({ name: "r", packageManager: "yarn@4.0.0" }) }]), "review");
  });

  it("is review for a major, a 0.x minor, a version that went down, and a package added or removed", () => {
    const one = (o, n) => risk([{ path: "package.json", old: pkg(o), new: pkg(n) }]);
    assert.equal(one({ a: "^1.0.0" }, { a: "^2.0.0" }), "review");
    assert.equal(one({ a: "^0.4.0" }, { a: "^0.5.0" }), "review");
    assert.equal(one({ a: "^0.4.0" }, { a: "^0.4.3" }), "low");
    assert.equal(one({ a: "^1.2.0" }, { a: "^1.1.0" }), "review");
    assert.equal(one({ a: "^1.0.0" }, { a: "^1.0.0", b: "^1.0.0" }), "review");
    assert.equal(one({ a: "^1.0.0", b: "^1.0.0" }, { a: "^1.0.0" }), "review");
    assert.equal(one({ a: "^1.0.0" }, { a: "github:someone/a#main" }), "review");
  });

  it("is review when anything but a dependency version changed, a script or the package's own version included", () => {
    assert.equal(risk([{ path: "package.json", old: pkg({ a: "^1.0.0" }, { scripts: { test: "x" } }), new: pkg({ a: "^1.0.1" }, { scripts: { test: "y" } }) }]), "review");
    assert.equal(risk([{ path: "package.json", old: pkg({ a: "^1.0.0" }), new: pkg({ a: "^1.0.1" }, { version: "1.0.1" }) }]), "review");
    assert.equal(risk([{ path: "package.json", old: pkg({ a: "^1.0.0" }), new: pkg({ a: "^1.0.1" }, { postinstall: "x" }) }]), "review");
  });

  it("is review for a package.json that cannot be read, or one that was added", () => {
    assert.equal(risk([{ path: "package.json", old: "{", new: "{}" }]), "review");
    assert.equal(risk([{ status: "A", path: "apps/b/package.json", new: pkg({}) }]), "review");
  });
});

const lock = (version, integrity = "aaa", extra = "") => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^${version.split(".").slice(0, 2).join(".")}.0
        version: ${version}(react@19.0.0)

packages:

  left-pad@${version}:
    resolution: {integrity: sha512-${integrity}}
${extra}
snapshots:

  left-pad@${version}(react@19.0.0):
    dependencies:
      react: 19.0.0
`;

describe("pnpm-lock.yaml", () => {
  it("is low for a minor and a patch step, importers and packages together", () => {
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: lock("1.1.2", "bbb") }]), "low");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: lock("1.2.0", "bbb") }]), "low");
  });

  it("is review for a major step", () => {
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: lock("2.0.0", "bbb") }]), "review");
  });

  it("is review for an entry whose contents changed with no new version, which is what a tampered release looks like", () => {
    const rows = [{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: lock("1.1.0", "evil") }];
    assert.equal(risk(rows), "review");
    assert.match(why(rows), /changed without a new version/);
  });

  it("is review for a package added or removed", () => {
    const added = lock("1.1.0").replace("snapshots:", "  extra@1.0.0:\n    resolution: {integrity: sha512-ccc}\n\nsnapshots:");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: added }]), "review");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: added, new: lock("1.1.0") }]), "review");
  });

  it("is review for a dependency added to an importer, or a line that is not a version", () => {
    const more = lock("1.1.0").replace("    dependencies:\n      left-pad:", "    dependencies:\n      extra:\n        specifier: ^1.0.0\n        version: 1.0.0\n      left-pad:");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: more }]), "review");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: lock("1.1.0").replace("'9.0'", "'10.0'") }]), "review");
  });

  it("is review for an old and a new version of a package that is not a step up from any old one", () => {
    const two = lock("1.1.0").replace("snapshots:", "  left-pad@3.0.0:\n    resolution: {integrity: sha512-ddd}\n\nsnapshots:");
    assert.equal(risk([{ path: "pnpm-lock.yaml", old: lock("1.1.0"), new: two }]), "review");
  });
});

const toml = (version, extra = "") => `[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = "${version}"
tokio = { version = "1.40", features = ["rt"] }
${extra}
[dev-dependencies.tempfile]
version = "3.10"
`;

describe("Cargo.toml", () => {
  it("is low for a bump in a plain entry, an inline table and a dependency table", () => {
    assert.equal(risk([{ path: "src-tauri/Cargo.toml", old: toml("1.0.100"), new: toml("1.0.200") }]), "low");
    assert.equal(risk([{ path: "src-tauri/Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100").replace('"1.40"', '"1.41"') }]), "low");
    assert.equal(risk([{ path: "src-tauri/Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100").replace('"3.10"', '"3.11"') }]), "low");
  });

  it("is review for a major step, the crate's own version, a feature change and a new line", () => {
    assert.equal(risk([{ path: "Cargo.toml", old: toml("1.0.100"), new: toml("2.0.0") }]), "review");
    assert.equal(risk([{ path: "Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100").replace('version = "0.1.0"', 'version = "0.1.1"') }]), "review");
    assert.equal(risk([{ path: "Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100").replace('["rt"]', '["rt", "fs"]') }]), "review");
    assert.equal(risk([{ path: "Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100", 'extra = "1"\n') }]), "review");
    assert.equal(risk([{ path: "Cargo.toml", old: toml("1.0.100"), new: toml("1.0.100").replace('name = "app"', 'name = "other"') }]), "review");
  });
});

const crates = (serde, checksum = "c1", more = "") => `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde ${serde}",
]

[[package]]
name = "serde"
version = "${serde}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${checksum}"
${more}`;

describe("Cargo.lock", () => {
  it("is low for a step up, though the repository's own crate lists its dependency differently", () => {
    assert.equal(risk([{ path: "src-tauri/Cargo.lock", old: crates("1.0.100"), new: crates("1.0.200", "c2") }]), "low");
    assert.equal(risk([{ path: "src-tauri/Cargo.lock", old: crates("1.0.100"), new: crates("1.1.0", "c2") }]), "low");
  });

  it("is review for a major, a 0.x minor, a changed checksum, a new crate and a change to the repository's own crate", () => {
    assert.equal(risk([{ path: "Cargo.lock", old: crates("1.0.100"), new: crates("2.0.0", "c2") }]), "review");
    assert.equal(risk([{ path: "Cargo.lock", old: crates("0.10.1"), new: crates("0.11.0", "c2") }]), "review");
    assert.equal(risk([{ path: "Cargo.lock", old: crates("1.0.100"), new: crates("1.0.100", "evil") }]), "review");
    const more = '\n[[package]]\nname = "extra"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "x"\n';
    assert.equal(risk([{ path: "Cargo.lock", old: crates("1.0.100"), new: crates("1.0.100", "c1", more) }]), "review");
    assert.equal(risk([{ path: "Cargo.lock", old: crates("1.0.100"), new: crates("1.0.100").replace('version = "0.1.0"', 'version = "0.2.0"') }]), "review");
  });

  it("is review for a crate from git or a path", () => {
    const git = (rev) => crates("1.0.100").replace("registry+https://github.com/rust-lang/crates.io-index", `git+https://example.com/serde#${rev}`);
    assert.equal(risk([{ path: "Cargo.lock", old: git("a"), new: git("b") }]), "review");
  });
});

describe("a declared refactor", () => {
  const src = (n) => `import { it } from "vitest";\n${Array.from({ length: n }, (_, i) => `it("case ${i}", () => {});`).join("\n")}\n`;

  it("declares itself only by a Risk: refactor trailer in the last paragraph", () => {
    assert.equal(declaresRefactor("Merge\n\nRisk: refactor\nCo-Authored-By: A <a@b.c>"), true);
    assert.equal(declaresRefactor("Merge\n\nrisk:  Refactor"), true);
    assert.equal(declaresRefactor("Merge\n\nRisk: refactor\n\nA later paragraph."), false);
    assert.equal(declaresRefactor("Merge\n\nRisk: feature"), false);
    assert.equal(declaresRefactor("Risk: refactor is the plan"), false);
    assert.equal(declaresRefactor(""), false);
  });

  it("is low for source files, new and removed ones included, when declared", () => {
    const rows = [{ path: "apps/desktop/src/a.ts", old: "export const a = 1;\n", new: "export const a = 2;\n" },
      { status: "A", path: "apps/desktop/src/b.tsx", new: "export {};\n" }, { status: "D", path: "apps/desktop/src/c.ts", old: "export {};\n" },
      { path: "apps/desktop/src-tauri/src/lib.rs", old: "fn a() {}\n", new: "fn b() {}\n" }];
    assert.equal(risk(rows, REFACTOR), "low");
  });

  it("is review for the same change with no trailer, with a trailer in a middle paragraph or a different one", () => {
    const rows = [{ path: "apps/desktop/src/a.ts", old: "a", new: "b" }];
    assert.equal(risk(rows, ""), "review");
    assert.equal(risk(rows, "Merge\n\nRisk: refactor\n\nBody."), "review");
    assert.equal(risk(rows, "Merge\n\nRisk: feature\n"), "review");
  });

  it("is review for a dictionary, a web string file and a snapshot of the words", () => {
    for (const path of ["apps/desktop/src/i18n/en/lane.ts", "apps/desktop/src/i18n/en.ts", "apps/desktop/src/i18n/snapshot/en.json",
      "apps/web/src/app/strings.ts", "apps/web/src/join/strings.ts"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }], REFACTOR), "review", path);
    }
  });

  it("is review for a stylesheet, an e2e spec, a capability, an entitlement, a plist and a tauri config", () => {
    for (const path of ["apps/desktop/src/theme/motion.css", "apps/web/src/app.css", "apps/desktop/e2e/polish.spec.ts", "apps/desktop/e2e/motion.ts",
      "apps/desktop/src/x.spec.ts", "apps/desktop/src-tauri/capabilities/default.json", "apps/desktop/src-tauri/AppStore.entitlements",
      "apps/desktop/src-tauri/Entitlements.plist", "apps/desktop/src-tauri/Info.plist", "apps/desktop/src-tauri/Info.appstore.plist",
      "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/tauri.appstore.conf.json"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }], REFACTOR), "review", path);
    }
  });

  it("is review for the approval code, even when declared a refactor", () => {
    for (const path of ["packages/approval-core/src/index.ts", "packages/approval-core/test/rules.test.ts", "apps/api/src/approvals.ts",
      "apps/api/src/approval-index.ts", "apps/api/src/approval-link.ts"]) {
      assert.equal(risk([{ path, old: "export {};\n", new: "export {};\n// moved\n" }], REFACTOR), "review", path);
    }
    // Other API source under the same declaration still may merge.
    assert.equal(risk([{ path: "apps/api/src/chat.ts", old: "export {};\n", new: "export {};\n// moved\n" }], REFACTOR), "low");
  });

  it("is review for a file type it cannot classify, even when declared", () => {
    for (const path of ["apps/desktop/tsconfig.json", "scripts/run.sh", "apps/desktop/index.html", "apps/desktop/src/data.json", "apps/desktop/icon.png"]) {
      assert.equal(risk([{ path, old: "a", new: "b" }], REFACTOR), "review", path);
    }
  });

  it("is review when a test file is deleted, whatever its kind, and when a rename leaves one behind", () => {
    for (const path of ["apps/desktop/src/a.test.ts", "packages/x/src/b.test.tsx", "apps/desktop/src-tauri/tests/ledger.rs",
      "apps/desktop/src-tauri/src/x_test.rs", "apps/api/test/c.ts", ".github/scripts/x.test.mjs"]) {
      assert.equal(risk([{ status: "D", path, old: src(2) }], REFACTOR), "review", path);
    }
  });

  it("is review when the changed files hold fewer tests than before, and low when they hold as many or more", () => {
    const fewer = [{ path: "apps/desktop/src/a.test.ts", old: src(3), new: src(2) }];
    assert.equal(risk(fewer, REFACTOR), "review");
    assert.match(why(fewer, REFACTOR), /fewer tests: 3 before, 2 after/);
    assert.equal(risk([{ path: "apps/desktop/src/a.test.ts", old: src(3), new: src(3) }], REFACTOR), "low");
    assert.equal(risk([{ path: "apps/desktop/src/a.test.ts", old: src(3), new: src(5) }], REFACTOR), "low");
  });

  it("counts a Rust test, a test inside a source file, and a test moved to another file", () => {
    const rust = (n) => Array.from({ length: n }, () => "#[test]\nfn t() {}\n").join("");
    assert.equal(risk([{ path: "apps/desktop/src-tauri/src/lib.rs", old: rust(2), new: rust(1) }], REFACTOR), "review");
    assert.equal(risk([{ path: "apps/desktop/src/a.test.ts", old: src(3), new: src(1) }, { path: "apps/desktop/src/b.test.ts", old: src(0), new: src(2) }], REFACTOR), "low");
  });

  it("is review when a test is skipped, marked todo or marked only", () => {
    for (const marker of ['it.skip("a", () => {});', 'it.todo("a");', 'it.only("a", () => {});', 'xit("a", () => {});', "#[ignore]"]) {
      const rows = [{ path: "apps/desktop/src/a.test.ts", old: src(2), new: `${src(2)}${marker}\nit("b", () => {});\n` }];
      assert.equal(risk(rows, REFACTOR), "review", marker);
    }
  });

  it("does not let a declared refactor change a manifest beyond a minor or patch step, or a document that steers agents", () => {
    assert.equal(risk([{ path: "package.json", old: pkg({ a: "^1.0.0" }), new: pkg({ a: "^2.0.0" }) }], REFACTOR), "review");
    assert.equal(risk([{ path: "CLAUDE.md", old: "a", new: "b" }], REFACTOR), "review");
  });
});

describe("the command line", () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.c", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.c" };
  const git = (cwd, ...a) => execFileSync("git", ["-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" }).trim();
  const repo = join(scratch, "cli");
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(join(repo, "docs", "a.md"), "one\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "branch", "base");
  const cli = (base, head, ...extra) => spawnSync("node", [join(here, "merge-risk.mjs"), base, head, "--repo", repo, ...extra], { encoding: "utf8" });

  it("prints low and exits 0 for documentation, measured from the merge base", () => {
    git(repo, "checkout", "-q", "-b", "docs-change", "base");
    writeFileSync(join(repo, "docs", "a.md"), "two\n");
    git(repo, "commit", "-qam", "docs");
    // The base has moved on since the branch was made; its own change must not count against the branch.
    git(repo, "checkout", "-q", "base");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 9;\n");
    git(repo, "commit", "-qam", "base moved");
    const out = cli("base", "docs-change");
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(out.stdout.split("\n")[0], "low");
    assert.match(out.stdout, /ok\tdocs\/a\.md\tdocumentation/);
  });

  it("prints review and exits 1 for source with no trailer, then low with the trailer in a message file", () => {
    git(repo, "checkout", "-q", "-b", "src-change", "base");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 5;\n");
    git(repo, "commit", "-qam", "src");
    const refused = cli("base", "src-change");
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout.split("\n")[0], "review");
    assert.match(refused.stdout, /review\tsrc\/a\.ts\tno rule covers it/);
    const file = join(scratch, "message");
    writeFileSync(file, "Merge\n\nRisk: refactor\nCo-Authored-By: A <a@b.c>\n");
    const allowed = cli("base", "src-change", "--message", file);
    assert.equal(allowed.status, 0, allowed.stdout);
    assert.equal(allowed.stdout.split("\n")[0], "low");
  });

  it("answers review, exit 2, for a revision it cannot read, and usage for missing arguments", () => {
    const bad = cli("base", "no-such-branch");
    assert.equal(bad.status, 2);
    assert.equal(bad.stdout.split("\n")[0], "review");
    assert.equal(spawnSync("node", [join(here, "merge-risk.mjs")], { encoding: "utf8" }).status, 2);
  });

  it("never reads a trailer from the commit messages of the branch, only from the message file", () => {
    git(repo, "checkout", "-q", "-b", "sneaky", "base");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 6;\n");
    git(repo, "commit", "-qam", "sneaky\n\nRisk: refactor");
    assert.equal(cli("base", "sneaky").status, 1);
  });
});
