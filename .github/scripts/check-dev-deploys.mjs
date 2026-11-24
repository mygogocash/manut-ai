// Stops the Deploy dev workflow unless every config it is about to deploy resolves, for `--env dev`, to a Worker
// whose name ends in -dev. The workflow already writes `--env dev` into each command; this covers the configs, so
// a later edit that pointed a config's dev environment at a staging or production Worker is caught here, before
// anything is deployed. Every config is checked before the first deploy starts, so a bad second config never
// leaves half a deploy behind.
//
// It also refuses a config that sets a test-only var: any var whose name starts with TEST_, which only
// apps/api/wrangler.test.json may set. TEST_JWKS_JSON is the test Apple key's public half, and with it deployed anyone
// holding the committed private half could sign in as anyone; TEST_EMAIL_OUTBOX keeps every sign-in code in memory
// instead of sending it. Every block of a config is read: its top level and each environment it defines (dev, staging
// and prod in this repository), since vars are not inherited, a command without --env deploys the top level, and a
// staging or production deploy, which this workflow never makes, reads its own block. A secret of that name set with
// `wrangler secret put` is not in any config, so this cannot see one. So the API honours the test-only settings only on
// a Worker whose PUBLIC_API_ORIGIN is an https origin under .test (apps/api/src/test-origin.ts), and this refuses such
// an origin in every block too: with it, a secret named TEST_JWKS_JSON would work again.
//
// Usage, from apps/api: node ../../.github/scripts/check-dev-deploys.mjs <wrangler config>...
// Wrangler comes from the working directory's package (apps/api), at the version pnpm-lock.yaml pins. Its own
// config readers resolve each config, environment names included, the way `wrangler deploy` does.
// .github/scripts/check-dev-deploys.test.mjs runs it as the workflow does.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// pnpm's strict layout puts wrangler in apps/api/node_modules only, so it is resolved from there, not from here.
const { experimental_readRawConfig, unstable_readConfig } = createRequire(join(process.cwd(), "package.json"))("wrangler");

/// An https origin under .test: a test Worker's, on which the API honours the test-only settings. The same pattern as
/// TEST_ORIGIN in apps/api/src/test-origin.ts, which the test checks by their text.
const TEST_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.test$/;

const refuse = (message) => {
  // A workflow command on stdout, so the reason shows on the run's page as well as in its log.
  console.log(`::error::${message} Nothing was deployed.`);
  process.exit(1);
};

/// The names of the test-only vars a resolved config sets.
const testVars = (resolved) => Object.keys(resolved.vars ?? {}).filter((key) => key.startsWith("TEST_"));

/// The names of the environments a config defines, as Wrangler reads the file.
const environments = (config) => Object.keys(experimental_readRawConfig({ config }).rawConfig.env ?? {});

const configs = process.argv.slice(2);
if (configs.length === 0) refuse("No wrangler config was named to check.");
for (const config of configs) {
  if (!existsSync(config)) refuse(`${config} does not exist in ${process.cwd()}.`);
  const dev = unstable_readConfig({ config, env: "dev" });
  const { name } = dev;
  if (typeof name !== "string" || !name.endsWith("-dev")) {
    refuse(`${config} with --env dev would deploy "${name}", which is not a dev Worker (its name must end in -dev).`);
  }
  const blocks = [["its top level", unstable_readConfig({ config }, { hideWarnings: true })],
    ...environments(config).map((env) => [`its ${env} environment`,
      env === "dev" ? dev : unstable_readConfig({ config, env }, { hideWarnings: true })])];
  for (const [where, resolved] of blocks) {
    const named = testVars(resolved);
    if (named.length > 0) {
      refuse(`${config} sets ${named.join(", ")} for ${where}: a TEST_ var belongs in wrangler.test.json only.`);
    }
    const origin = resolved.vars?.PUBLIC_API_ORIGIN;
    if (typeof origin === "string" && TEST_ORIGIN.test(origin)) {
      refuse(`${config} sets PUBLIC_API_ORIGIN to ${origin} for ${where}: an origin under .test is a test Worker's, ` +
        "where the test-only settings work.");
    }
  }
  console.log(`${config} with --env dev deploys ${name}`);
}
