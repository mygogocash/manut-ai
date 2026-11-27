// Decides whether a change may merge on a green CI run alone (item 130, 26 Nov 2026), or needs the lead's own review.
//
//   node .github/scripts/merge-risk.mjs <base> <head> [--message <file>] [--repo <dir>]
//
// It prints `low` or `review` on the first line and one line a file after it, then exits 0 for `low` and 1 for
// `review` (2 when it cannot read the repository or the revisions, which a caller must treat as `review`). The
// diff is measured from the merge base of <base> and <head>.
//
// `low` is only ever a statement that the change is of a kind that CI can judge by itself. It never skips CI: the
// scripts that act on it (.claude/skills/lead-merge/scripts/auto-merge*.sh) still wait for a green run of the exact
// head. Every file must be one of these, and anything else, or anything this cannot read, is `review`:
//
//   1. Documentation: `docs/**` and `*.md` (text, and pictures under docs/assets/), except what steers agents or
//      describes security (see PROTECTED below).
//   2. A dependency bump: package.json, pnpm-lock.yaml, Cargo.toml and Cargo.lock where every changed version is a
//      minor or patch step up (a 0.x minor counts as major), and nothing else in those files changed. A package
//      added or removed, a version that went down, a range this cannot read and a lockfile entry whose contents
//      changed without a new version are all `review`.
//   3. A refactor the merge message declares with a `Risk: refactor` trailer, whose diff touches only source files
//      (ts, tsx, js, jsx, mjs, cjs, rs) and no dictionary, no stylesheet, no e2e spec, no tauri capability,
//      entitlement, Info plist or tauri config, deletes no test file, and does not lower the number of tests (counted
//      in the changed files, before and after, which is cheaper than listing every test and catches a deleted test
//      inside a source file) or add a skipped or `.only` test.
//
// Always `review`: anything under `.github/` (CI and this file) or `.claude/` (the agents' rules), CLAUDE.md,
// AGENTS.md, a security document, a symlink, a submodule, a mode change, an empty diff.
//
// The lead's own copy of this file must be the one that runs (auto-merge.sh reads it from the lead's worktree), never
// the copy in the branch being judged: a change to this file is `review`, but a branch could carry a loosened one.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// Versions

/** A version with up to three numbers and no pre-release part; null for anything else. */
function parseVersion(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether going from one version to another is a minor or patch step up. Returns "" when it is, else the reason. */
export function bumpProblem(from, to) {
  if (from === to) return "";
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return `version ${from} to ${to} cannot be read as numbers (a pre-release, a tag or a range)`;
  const c = compare(a, b);
  if (c === 0) return "";
  if (c > 0) return `version went down, ${from} to ${to}`;
  if (a[0] !== b[0]) return `major bump, ${from} to ${to}`;
  if (a[0] === 0 && a[1] !== b[1]) return `0.x minor bump counts as major, ${from} to ${to}`;
  return "";
}

/** The same for an npm range such as `^1.2.3`, `~1.2.3`, `1.2.3` or `npm:name@1.2.3`; the operator must not change. */
export function npmSpecProblem(from, to) {
  if (from === to) return "";
  const alias = /^npm:(.+)@([^@]+)$/;
  const fa = alias.exec(from);
  const ta = alias.exec(to);
  if (fa || ta) {
    if (!fa || !ta || fa[1] !== ta[1]) return `alias changed, ${from} to ${to}`;
    return npmSpecProblem(fa[2], ta[2]);
  }
  const range = /^(\^|~|>=|<=|>|<|=)?\s*(\d[^\s|]*)$/;
  const f = range.exec(from);
  const t = range.exec(to);
  if (!f || !t) return `range ${from} to ${to} cannot be read`;
  if ((f[1] ?? "") !== (t[1] ?? "")) return `range operator changed, ${from} to ${to}`;
  return bumpProblem(f[2], t[2]);
}

/** The same for a Cargo requirement: a bare, `^`, `~` or `=` version. */
export function cargoSpecProblem(from, to) {
  if (from === to) return "";
  const range = /^(\^|~|=)?\s*(\d+(?:\.\d+){0,2})$/;
  const f = range.exec(from);
  const t = range.exec(to);
  if (!f || !t) return `requirement ${from} to ${to} cannot be read`;
  if ((f[1] ?? "") !== (t[1] ?? "")) return `requirement operator changed, ${from} to ${to}`;
  return bumpProblem(f[2], t[2]);
}

// ---------------------------------------------------------------------------------------------------------------
// package.json

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"];

function readJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The dependency maps of a manifest, by section name; `pnpm.overrides` is read as `overrides`. */
function depMaps(json) {
  const maps = {};
  for (const name of DEP_SECTIONS) if (json[name] && typeof json[name] === "object") maps[name] = json[name];
  if (json.pnpm?.overrides && typeof json.pnpm.overrides === "object") maps["pnpm.overrides"] = json.pnpm.overrides;
  return maps;
}

/** The manifest with its dependency maps taken out, to compare everything else exactly. */
function withoutDeps(json) {
  const copy = JSON.parse(JSON.stringify(json));
  for (const name of DEP_SECTIONS) delete copy[name];
  delete copy.packageManager;
  if (copy.pnpm && typeof copy.pnpm === "object") delete copy.pnpm.overrides;
  return copy;
}

function packageJsonProblems(oldText, newText) {
  const o = readJson(oldText);
  const n = readJson(newText);
  if (!o || !n || typeof o !== "object" || typeof n !== "object") return ["a package.json that cannot be read"];
  const problems = [];
  if (JSON.stringify(withoutDeps(o)) !== JSON.stringify(withoutDeps(n))) problems.push("package.json changed beyond its dependency versions");
  // The package manager's own pin, `pnpm@12.23.0`, may step up like any other version.
  if (o.packageManager !== n.packageManager) {
    const pm = /^([\w-]+)@(.+)$/;
    const a = pm.exec(String(o.packageManager));
    const b = pm.exec(String(n.packageManager));
    const p = !a || !b || a[1] !== b[1] ? "packageManager changed to something else" : bumpProblem(a[2], b[2]);
    if (p) problems.push(`packageManager: ${p}`);
  }
  const om = depMaps(o);
  const nm = depMaps(n);
  for (const section of new Set([...Object.keys(om), ...Object.keys(nm)])) {
    const a = om[section] ?? {};
    const b = nm[section] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(name in a)) problems.push(`${section}: ${name} added`);
      else if (!(name in b)) problems.push(`${section}: ${name} removed`);
      else if (typeof a[name] !== "string" || typeof b[name] !== "string") problems.push(`${section}: ${name} is not a plain range`);
      else {
        const p = npmSpecProblem(a[name], b[name]);
        if (p) problems.push(`${section}: ${name}: ${p}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// pnpm-lock.yaml (lockfile v9: importers, packages and snapshots at column 0)

/** Splits `name@1.2.3` or `@scope/name@1.2.3(peer)` into its name and version. */
function splitKey(key) {
  const k = key.replace(/\(.*$/, "");
  const at = k.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: k.slice(0, at), version: k.slice(at + 1) };
}

/** The lockfile cut into its top-level sections, each a list of lines (the header excluded). */
function lockSections(text) {
  const sections = new Map();
  let current = "";
  sections.set(current, []);
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z][\w-]*):/.exec(line);
    if (m) {
      current = m[1];
      if (!sections.has(current)) sections.set(current, []);
      sections.get(current).push(line);
    } else sections.get(current).push(line);
  }
  return sections;
}

/** The `packages:` section as entries: key to the entry's whole text. */
function lockEntries(lines) {
  const entries = new Map();
  let key = null;
  for (const line of lines.slice(1)) {
    const m = /^ {2}(['"]?)([^\s'"].*?)\1:\s*$/.exec(line);
    if (m) { key = m[2]; entries.set(key, []); } else if (key !== null) entries.get(key).push(line);
  }
  return new Map([...entries].map(([k, v]) => [k, v.join("\n").trimEnd()]));
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");

/** One differing pair of lines outside packages and snapshots: both must be the same `version:` or `specifier:`. */
function lockLinePairProblem(a, b) {
  const ma = /^(\s*)(version|specifier): (.*)$/.exec(a);
  const mb = /^(\s*)(version|specifier): (.*)$/.exec(b);
  if (!ma || !mb || ma[1] !== mb[1] || ma[2] !== mb[2]) return `a line changed that is not a version: ${b.trim().slice(0, 60)}`;
  // The peer suffix in brackets, `1.2.3(react@19)`, only repeats packages the packages section already shows moving.
  const from = unquote(ma[3]).replace(/\(.*$/, "");
  const to = unquote(mb[3]).replace(/\(.*$/, "");
  if (ma[2] === "specifier") return npmSpecProblem(from, to);
  const f = splitKey(from.lastIndexOf("@") > 0 ? from : `x@${from}`);
  const t = splitKey(to.lastIndexOf("@") > 0 ? to : `x@${to}`);
  if (/^(link|file|workspace):/.test(from) || /^(link|file|workspace):/.test(to)) return from === to ? "" : `a linked package changed, ${from} to ${to}`;
  if (!f || !t || f.name !== t.name) return `resolved package changed, ${from} to ${to}`;
  return bumpProblem(f.version, t.version);
}

/** Compares the name sets of two package listings, name to the set of versions. */
function versionSetProblems(oldSets, newSets, label) {
  const problems = [];
  for (const name of new Set([...oldSets.keys(), ...newSets.keys()])) {
    const a = oldSets.get(name) ?? new Set();
    const b = newSets.get(name) ?? new Set();
    const removed = [...a].filter((v) => !b.has(v));
    const added = [...b].filter((v) => !a.has(v));
    if (!removed.length && !added.length) continue;
    if (!a.size) { problems.push(`${label}: ${name} added`); continue; }
    if (!b.size) { problems.push(`${label}: ${name} removed`); continue; }
    for (const v of added) {
      if (![...a].some((r) => compare(parseVersion(r) ?? [0, 0, 0], parseVersion(v) ?? [0, 0, 0]) < 0 && !bumpProblem(r, v))) {
        problems.push(`${label}: ${name} ${v}: ${[...a].map((r) => bumpProblem(r, v)).find(Boolean) || "no older version to come from"}`);
      }
    }
    for (const r of removed) {
      if (![...b].some((v) => compare(parseVersion(r) ?? [0, 0, 0], parseVersion(v) ?? [0, 0, 0]) < 0 && !bumpProblem(r, v))) {
        problems.push(`${label}: ${name} ${r} removed without a minor or patch step up to replace it`);
      }
    }
  }
  return problems;
}

function pnpmLockProblems(oldText, newText) {
  const problems = [];
  const os = lockSections(oldText);
  const ns = lockSections(newText);
  // Everything outside packages and snapshots (importers, settings, overrides, catalogs): line for line, where only
  // a version or a specifier may differ.
  const rest = (s) => [...s].filter(([name]) => name !== "packages" && name !== "snapshots").flatMap(([, lines]) => lines);
  const ol = rest(os);
  const nl = rest(ns);
  if (ol.length !== nl.length) problems.push("pnpm-lock.yaml: a dependency was added or removed in importers or settings");
  else for (let i = 0; i < ol.length; i += 1) {
    if (ol[i] === nl[i]) continue;
    const p = lockLinePairProblem(ol[i], nl[i]);
    if (p) problems.push(`pnpm-lock.yaml: ${p}`);
  }
  // packages: an entry that stays must be byte for byte the same (a changed integrity under the same version is
  // exactly what a tampered release looks like); the rest must be minor and patch steps.
  const oe = lockEntries(os.get("packages") ?? []);
  const ne = lockEntries(ns.get("packages") ?? []);
  const sets = (entries) => {
    const m = new Map();
    for (const key of entries.keys()) {
      const s = splitKey(key);
      if (!s) { problems.push(`pnpm-lock.yaml: a package key that cannot be read: ${key}`); continue; }
      if (!m.has(s.name)) m.set(s.name, new Set());
      m.get(s.name).add(s.version);
    }
    return m;
  };
  for (const [key, body] of oe) if (ne.has(key) && ne.get(key) !== body) problems.push(`pnpm-lock.yaml: ${key} changed without a new version`);
  problems.push(...versionSetProblems(sets(oe), sets(ne), "pnpm-lock.yaml"));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Cargo.toml and Cargo.lock

const DEP_HEADER = /^\[(?:[^\]]*\.)?(?:dev-|build-)?dependencies(\.[^\]]*)?\]\s*$/;

function cargoTomlProblems(oldText, newText) {
  const ol = oldText.split("\n");
  const nl = newText.split("\n");
  if (ol.length !== nl.length) return ["Cargo.toml: lines were added or removed"];
  const problems = [];
  let header = "";
  let inDeps = false;
  let table = false;
  for (let i = 0; i < nl.length; i += 1) {
    const h = /^\s*\[.*\]\s*$/.exec(nl[i]) ? nl[i].trim() : null;
    if (h) {
      header = h;
      const m = DEP_HEADER.exec(h);
      inDeps = Boolean(m);
      table = Boolean(m && m[1]);
      if (ol[i].trim() !== h) { problems.push("Cargo.toml: a section header changed"); }
      continue;
    }
    if (ol[i] === nl[i]) continue;
    if (!inDeps) { problems.push(`Cargo.toml: a line changed outside the dependencies (${header || "top"})`); continue; }
    const version = table ? /^(\s*version\s*=\s*)"([^"]*)"(.*)$/ : /^(\s*[\w.-]+\s*=\s*\{?[^"]*?\bversion\s*=\s*|\s*[\w.-]+\s*=\s*)"([^"]*)"(.*)$/;
    const a = version.exec(ol[i]);
    const b = version.exec(nl[i]);
    if (!a || !b || a[1] !== b[1] || a[3] !== b[3]) { problems.push(`Cargo.toml: a line changed that is not a version: ${nl[i].trim().slice(0, 60)}`); continue; }
    const p = cargoSpecProblem(a[2], b[2]);
    if (p) problems.push(`Cargo.toml: ${nl[i].trim().split(/\s*=/)[0]}: ${p}`);
  }
  return problems;
}

/** Cargo.lock's [[package]] blocks, each as name, version, source, checksum and the whole text. */
function cargoLockBlocks(text) {
  const blocks = [];
  const outside = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "[[package]]") { cur = { lines: [] }; blocks.push(cur); continue; }
    if (!cur) { outside.push(line); continue; }
    cur.lines.push(line);
  }
  for (const b of blocks) {
    const get = (k) => new RegExp(`^${k} = "([^"]*)"`, "m").exec(b.lines.join("\n"))?.[1] ?? "";
    b.name = get("name");
    b.version = get("version");
    b.source = get("source");
    b.checksum = get("checksum");
    // A crate of this repository lists its dependencies, which move with every bump: compare it without that list.
    b.text = b.lines.join("\n").replace(/^dependencies = \[[\s\S]*?^\]$/m, "").trimEnd();
  }
  return { blocks, outside };
}

function cargoLockProblems(oldText, newText) {
  const problems = [];
  const o = cargoLockBlocks(oldText);
  const n = cargoLockBlocks(newText);
  if (o.outside.join("\n") !== n.outside.join("\n")) problems.push("Cargo.lock: its header changed");
  const key = (b) => `${b.name}@${b.version}@${b.source}`;
  const ob = new Map(o.blocks.map((b) => [key(b), b]));
  const nb = new Map(n.blocks.map((b) => [key(b), b]));
  for (const [k, b] of nb) {
    if (!ob.has(k)) continue;
    // A package that stays keeps its identity: a changed checksum under the same version is a changed release. Its
    // dependency list may differ, because a crate it uses moved.
    if (ob.get(k).checksum !== b.checksum) problems.push(`Cargo.lock: ${b.name} ${b.version} changed its checksum`);
    if (!b.source && ob.get(k).text !== b.text) problems.push(`Cargo.lock: ${b.name} (a crate of this repository) changed`);
  }
  // Only registry crates may step up. A crate of this repository (no source) or one from git or a path must be the
  // same in both files.
  const registry = (b) => /^registry\+/.test(b.source);
  for (const [k, b] of ob) if (!registry(b) && !nb.has(k)) problems.push(`Cargo.lock: ${b.name} ${b.version} (${b.source ? "not from a registry" : "a crate of this repository"}) was removed or changed`);
  for (const [k, b] of nb) if (!registry(b) && !ob.has(k)) problems.push(`Cargo.lock: ${b.name} ${b.version} (${b.source ? "not from a registry" : "a crate of this repository"}) is new or changed`);
  const sets = (blocks) => {
    const m = new Map();
    for (const b of blocks.filter(registry)) {
      const name = `${b.name} (${b.source})`;
      if (!m.has(name)) m.set(name, new Set());
      m.get(name).add(b.version);
    }
    return m;
  };
  problems.push(...versionSetProblems(sets(o.blocks), sets(n.blocks), "Cargo.lock"));
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

const DOC_IMAGE = /^docs\/assets\/.+\.(png|jpe?g|gif|webp)$/i;
const SECURITY_DOC = /(security|threat|vulnerab|pentest|secrets?|safety|privacy)/i;
const AGENT_RULES = /(^|\/)(CLAUDE|AGENTS)\.md$|(^|\/)SKILL\.md$/i;

/** Parts that only the lead reviews. Returns the reason, or "". */
function protectedReason(path) {
  if (path.startsWith(".github/")) return "CI, its scripts and this classifier are the lead's to review";
  if (path.startsWith(".claude/")) return "the agents' rules and skills are the lead's to review";
  if (AGENT_RULES.test(path)) return "a file that steers agents";
  // Agents read the plan, the handoff and the decisions as their rules (the sixth security read, 27 Nov 2026, L7), so a
  // change to them is the lead's to read, though it is only Markdown.
  if (path === "docs/plan.md" || path === "docs/handoff.md" || path.startsWith("docs/decisions/")) {
    return "the plan, the handoff or a decision, which agents read as their rules";
  }
  if ((path.startsWith("docs/") || path.endsWith(".md")) && SECURITY_DOC.test(path)) return "a security document";
  return "";
}

const isDoc = (path) => path.startsWith("docs/") || path.endsWith(".md");
const isManifest = (path) => /(^|\/)(package\.json|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock)$/.test(path);
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|rs)$/;
const TEST_FILE = [/\.(test|spec)\.[cm]?[tj]sx?$/, /(^|\/)(tests?|__tests__|e2e)\//, /_test\.rs$/];

/** Why a refactor may not touch this path, or "". */
function refactorForbids(path) {
  if (/(^|\/)i18n\//.test(path) || /(^|\/)strings\.[tj]sx?$/.test(path) || /(^|\/)(locales?|dictionar(y|ies))\//.test(path)) return "a dictionary or its words";
  if (/\.(css|scss|sass|less|pcss|styl)$/.test(path)) return "a stylesheet";
  if (/(^|\/)e2e\//.test(path) || /\.spec\.[cm]?[tj]sx?$/.test(path)) return "an e2e spec";
  if (/(^|\/)src-tauri\/capabilities\//.test(path) || /\.entitlements$/.test(path) || /(^|\/)Info[^/]*\.plist$/.test(path) ||
      /(^|\/)Entitlements\.plist$/.test(path) || /(^|\/)tauri[^/]*\.conf\.json$/.test(path)) return "a permission, entitlement, plist or tauri config";
  // The one ask path settles every send, post, payment and deletion (CLAUDE.md), so a change to it is never merged on a
  // declared refactor alone (the sixth security read, 27 Nov 2026, L7).
  if (path.startsWith("packages/approval-core/") || /^apps\/api\/src\/approval[^/]*\.ts$/.test(path)) return "the approval code";
  return "";
}

const testCount = (text) => (text.match(/\b(?:it|test)(?:\.\w+)*\s*\(|#\[(?:\w+::)*test\b/g) ?? []).length;
const skipCount = (text) => (text.match(/\b(?:it|test|describe)\.(?:skip|todo|only)\b|\bx(?:it|describe)\(|#\[ignore\b/g) ?? []).length;

/** A `Risk: refactor` trailer in the last paragraph of a merge message. */
export function declaresRefactor(message) {
  if (!message) return false;
  const paragraphs = message.replace(/\r/g, "").trim().split(/\n\s*\n/);
  return paragraphs.at(-1).split("\n").some((l) => /^Risk:\s*refactor\s*$/i.test(l.trim()));
}

// ---------------------------------------------------------------------------------------------------------------
// The decision

/**
 * @param {{files: {status: string, path: string, oldMode?: string, newMode?: string}[],
 *          readOld: (path: string) => string, readNew: (path: string) => string, message?: string}} change
 * @returns {{risk: "low" | "review", lines: {path: string, ok: boolean, text: string}[]}}
 */
export function classify({ files, readOld, readNew, message }) {
  const lines = [];
  const say = (path, ok, text) => lines.push({ path, ok, text });
  const refactor = declaresRefactor(message);
  if (!files.length) say("(diff)", false, "no changes to judge");
  let testsBefore = 0;
  let testsAfter = 0;
  let skipsBefore = 0;
  let skipsAfter = 0;
  for (const { status, path, oldMode = "100644", newMode = "100644" } of files) {
    const blocked = protectedReason(path);
    if (blocked) { say(path, false, blocked); continue; }
    if ([oldMode, newMode].some((m) => m === "120000" || m === "160000")) { say(path, false, "a symlink or a submodule"); continue; }
    if (status !== "D" && status !== "A" && oldMode !== newMode) { say(path, false, "its file mode changed"); continue; }
    if (status === "A" && newMode === "100755") { say(path, false, "a new executable file"); continue; }

    if (isManifest(path)) {
      if (status !== "M") { say(path, false, `a manifest or lockfile was ${status === "A" ? "added" : "removed"}`); continue; }
      let problems;
      try {
        const base = path.split("/").at(-1);
        const [a, b] = [readOld(path), readNew(path)];
        problems = base === "package.json" ? packageJsonProblems(a, b)
          : base === "pnpm-lock.yaml" ? pnpmLockProblems(a, b)
            : base === "Cargo.toml" ? cargoTomlProblems(a, b) : cargoLockProblems(a, b);
      } catch (error) {
        problems = [`could not be read: ${error.message}`];
      }
      if (problems.length) for (const p of problems.slice(0, 8)) say(path, false, p);
      else say(path, true, "dependency versions, minor and patch only");
      continue;
    }

    if (isDoc(path)) {
      if (DOC_IMAGE.test(path) || (/\.(md|mdx|txt)$/i.test(path))) say(path, true, "documentation");
      else say(path, false, "a file in docs/ that is not text or a picture under docs/assets/");
      continue;
    }

    if (!refactor) { say(path, false, "no rule covers it: only a Risk: refactor trailer in the merge message lets source change"); continue; }
    const forbidden = refactorForbids(path);
    if (forbidden) { say(path, false, `a refactor may not touch ${forbidden}`); continue; }
    if (status === "D" && TEST_FILE.some((re) => re.test(path))) { say(path, false, "a test file was deleted"); continue; }
    if (!SOURCE.test(path)) { say(path, false, "not a source file this can classify"); continue; }
    try {
      if (status !== "A") { const t = readOld(path); testsBefore += testCount(t); skipsBefore += skipCount(t); }
      if (status !== "D") { const t = readNew(path); testsAfter += testCount(t); skipsAfter += skipCount(t); }
    } catch (error) {
      say(path, false, `could not be read: ${error.message}`);
      continue;
    }
    say(path, true, "refactor (declared by the merge message)");
  }
  if (testsAfter < testsBefore) say("(tests)", false, `the changed files hold fewer tests: ${testsBefore} before, ${testsAfter} after`);
  if (skipsAfter > skipsBefore) say("(tests)", false, "a test was skipped, marked todo or marked only");
  return { risk: lines.every((l) => l.ok) && lines.length ? "low" : "review", lines };
}

// ---------------------------------------------------------------------------------------------------------------
// The command line

const MAX = 256 * 1024 * 1024;

export function classifyRange({ repo, base, head, message }) {
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX });
  const from = git("merge-base", base, head).trim();
  const raw = git("diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, head).split("\0");
  const files = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const m = /^:(\d+) (\d+) \w+ \w+ (\w)/.exec(raw[i]);
    if (m) files.push({ oldMode: m[1], newMode: m[2], status: m[3], path: raw[i + 1] });
  }
  const show = (rev) => (path) => git("show", `${rev}:${path}`);
  return classify({ files, readOld: show(from), readNew: show(head), message });
}

// The path is compared after symlinks are resolved: a script reached through one (macOS's /var is /private/var) would
// otherwise match nothing and print nothing, which a caller must never read as an answer.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args.splice(i, 2)[1]; };
  const messageFile = take("--message");
  const repo = take("--repo") ?? process.cwd();
  const [base, head] = args;
  if (!base || !head) { console.error("usage: merge-risk.mjs <base> <head> [--message <file>] [--repo <dir>]"); process.exit(2); }
  try {
    const message = messageFile ? readFileSync(messageFile, "utf8") : "";
    const { risk, lines } = classifyRange({ repo, base, head, message });
    console.log(risk);
    for (const l of lines) console.log(`  ${l.ok ? "ok" : "review"}\t${l.path}\t${l.text}`);
    process.exit(risk === "low" ? 0 : 1);
  } catch (error) {
    console.log("review");
    console.log(`  review\t(classifier)\tcould not read the change: ${String(error.message).split("\n")[0]}`);
    process.exit(2);
  }
}
