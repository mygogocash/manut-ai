// Tests for setup.sh, the script Paradev runs in each new local workspace (config.toml beside it), run by `node --test`
// (the root `pnpm test` does, and CI's Desktop tests job). Each test makes a stand-in main checkout and worktree in a
// temporary folder, with made-up values, and runs a copy of the real script there with only PATH and the variables the
// test gives it, so a run inside a real Paradev workspace never reaches the real main checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "paradev-setup-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes each file under a folder, with the folders it needs. */
function write(root, entries) {
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A main checkout and, beside it, a worktree holding a copy of the script, as Paradev checks it out. */
function workspace(name) {
  const main = join(scratch, name, "main");
  const worktree = join(scratch, name, "worktree");
  mkdirSync(main, { recursive: true });
  mkdirSync(join(worktree, ".paradev"), { recursive: true });
  copyFileSync(join(here, "setup.sh"), join(worktree, ".paradev", "setup.sh"));
  chmodSync(join(worktree, ".paradev", "setup.sh"), 0o755);
  return { main, worktree };
}

/** Runs the worktree's script from another folder, so a script that relied on being started in the worktree fails. */
function setup(worktree, env = {}) {
  const result = spawnSync(join(worktree, ".paradev", "setup.sh"), [], { cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const read = (root, path) => readFileSync(join(root, path), "utf8");

describe("copying env files from the main checkout", () => {
  it("copies each ignored env file to the same place, a folder with a space in its name too, and a secret stays private", () => {
    const { main, worktree } = workspace("copies");
    const copied = [".env", "apps/api/.dev.vars", "apps/web/.env.local", "apps/with space/.env"];
    write(main, { ".env": "A=1\n", "apps/api/.dev.vars": "ANTHROPIC_API_KEY=made-up\n", "apps/web/.env.local": "B=2\n", "apps/with space/.env": "C=3\n" });
    chmodSync(join(main, "apps/api/.dev.vars"), 0o600);
    // The main checkout's path is given with a slash at its end, which must not reach the copies' names.
    const out = setup(worktree, { SUPERSET_ROOT_PATH: `${main}/` });
    for (const path of copied) assert.equal(read(worktree, path), read(main, path), path);
    assert.equal(statSync(join(worktree, "apps/api/.dev.vars")).mode & 0o777, 0o600);
    assert.match(out, /copied apps\/api\/\.dev\.vars from the main checkout/);
    assert.match(out, /copied 4 env file\(s\)/);
    // Names only: no value reaches the output, which Paradev shows in the workspace's setup terminal.
    assert.doesNotMatch(out, /made-up|A=1/);
  });

  it("leaves a file the worktree already has as it is, so running again changes nothing", () => {
    const { main, worktree } = workspace("keeps");
    write(main, { "apps/desktop/.env": "theirs\n", "apps/api/.dev.vars": "X=1\n" });
    write(worktree, { "apps/desktop/.env": "mine\n" });
    assert.match(setup(worktree, { SUPERSET_ROOT_PATH: main }), /left apps\/desktop\/\.env as it is[\s\S]*copied 1 env file\(s\)/);
    assert.equal(read(worktree, "apps/desktop/.env"), "mine\n");
    write(worktree, { "apps/api/.dev.vars": "X=changed here\n" });
    assert.match(setup(worktree, { SUPERSET_ROOT_PATH: main }), /copied 0 env file\(s\)/);
    assert.equal(read(worktree, "apps/api/.dev.vars"), "X=changed here\n");
  });

  it("skips git's, dependency, build, Rust target and Wrangler folders, and anything below an app's or a package's own folder", () => {
    const { main, worktree } = workspace("skips");
    // Each skipped folder sits at the top, well within the depth the script reads, so only its name can keep it out.
    const skipped = ["node_modules/.env", ".git/.env", "target/.env", "dist/.env", ".wrangler/.dev.vars", "packages/x/deeper/.env"];
    write(main, Object.fromEntries(skipped.map((path) => [path, "no\n"])));
    assert.match(setup(worktree, { SUPERSET_ROOT_PATH: main }), /copied 0 env file\(s\)/);
    for (const path of skipped) assert.equal(existsSync(join(worktree, path)), false, path);
  });
});

describe("when there is nothing to copy from", () => {
  it("says so and succeeds with no main checkout named, one that is not there, or the main checkout itself", () => {
    const { main, worktree } = workspace("nothing");
    write(worktree, { ".env": "here\n" });
    assert.match(setup(worktree), /no main checkout was named/);
    assert.match(setup(worktree, { SUPERSET_ROOT_PATH: join(main, "gone") }), /is not there/);
    assert.match(setup(worktree, { SUPERSET_ROOT_PATH: worktree }), /this is the main checkout itself/);
  });
});

describe("config.toml", () => {
  it("runs only scripts in this folder that exist and may run, so a renamed script cannot break every new workspace", () => {
    const scripts = [...readFileSync(join(here, "config.toml"), "utf8").matchAll(/"\.\/\.paradev\/([^"\s]+)/g)].map((m) => m[1]);
    assert.ok(scripts.includes("setup.sh"), "config.toml runs setup.sh");
    for (const name of scripts) assert.notEqual(statSync(join(here, name)).mode & 0o111, 0, `${name} is not executable`);
  });
});
