// Tests for check-dev-deploys.mjs, run by `node --test` (the root `pnpm test` does). They run the script as the Deploy
// dev workflow does, from apps/api with Wrangler from there, on the repository's own configs and on small configs
// written here, and read what it prints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "check-dev-deploys.mjs");
const api = join(here, "..", "..", "apps", "api");
const root = mkdtempSync(join(tmpdir(), "dev-deploys-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** What the script does for these configs, run from apps/api. */
function check(...configs) {
  const run = spawnSync(process.execPath, [script, ...configs], { cwd: api, encoding: "utf8" });
  return { status: run.status, out: run.stdout };
}

/** A config file holding `value`, in its own directory. */
function config(name, value) {
  const path = join(root, `${name}.jsonc`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const BASE = { name: "manut-api", compatibility_date: "2026-09-16", env: { dev: { name: "manut-api-dev" } } };

describe("the dev deploy check", () => {
  it("passes the repository's own configs", () => {
    const run = check("wrangler.web.jsonc", "wrangler.jsonc");
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /wrangler\.web\.jsonc with --env dev deploys manut-web-dev/);
    assert.match(run.out, /wrangler\.jsonc with --env dev deploys manut-api-dev/);
  });

  it("refuses a config whose dev environment is not a dev Worker", () => {
    const run = check(config("prod-named", { ...BASE, env: { dev: { name: "manut-api-prod" } } }));
    assert.equal(run.status, 1);
    assert.match(run.out, /::error::.*would deploy "manut-api-prod", which is not a dev Worker.*Nothing was deployed\./);
  });

  for (const name of ["TEST_JWKS_JSON", "TEST_EMAIL_OUTBOX", "TEST_ANYTHING"]) {
    it(`refuses ${name} in the dev environment's vars and at the top level`, () => {
      const inDev = config(`dev-${name}`, { ...BASE, env: { dev: { name: "manut-api-dev", vars: { [name]: "on" } } } });
      const atTop = config(`top-${name}`, { ...BASE, vars: { [name]: "on" } });
      for (const [path, where] of [[inDev, "its dev environment"], [atTop, "its top level"]]) {
        const run = check(path);
        assert.equal(run.status, 1, run.out);
        const refusal = `::error::.* sets ${name} for ${where}: a TEST_ var belongs in wrangler\\.test\\.json only\\.`;
        assert.match(run.out, new RegExp(`${refusal} Nothing was deployed\\.`));
        assert.doesNotMatch(run.out, /deploys manut-api-dev/);
      }
    });
  }

  it("checks every config before anything deploys, so a bad second config stops the first", () => {
    const run = check(config("clean", BASE), config("outbox", { ...BASE, vars: { TEST_EMAIL_OUTBOX: "on" } }));
    assert.equal(run.status, 1);
    assert.match(run.out, /clean\.jsonc with --env dev deploys manut-api-dev/);
    assert.match(run.out, /::error::.*outbox\.jsonc sets TEST_EMAIL_OUTBOX/);
  });

  it("lets other vars through, the sign-in switch among them", () => {
    const run = check(config("vars", { ...BASE, vars: { EMAIL_SIGN_IN: "off" },
      env: { dev: { name: "manut-api-dev", vars: { WEB_ORIGIN: "https://dev.manut.xyz", ATTEST_MODE: "x" } } } }));
    assert.equal(run.status, 0, run.out);
  });
});
