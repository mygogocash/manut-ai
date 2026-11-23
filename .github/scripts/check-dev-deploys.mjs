// Stops the Deploy dev workflow unless every config it is about to deploy resolves, for `--env dev`, to a Worker
// whose name ends in -dev. The workflow already writes `--env dev` into each command; this covers the configs, so
// a later edit that pointed a config's dev environment at a staging or production Worker is caught here, before
// anything is deployed. Every config is checked before the first deploy starts, so a bad second config never
// leaves half a deploy behind.
//
// Usage, from apps/api: node ../../.github/scripts/check-dev-deploys.mjs <wrangler config>...
// Wrangler comes from the working directory's package (apps/api), at the version pnpm-lock.yaml pins. Its own
// config reader resolves each config, environment names included, the way `wrangler deploy` does.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// pnpm's strict layout puts wrangler in apps/api/node_modules only, so it is resolved from there, not from here.
const { unstable_readConfig } = createRequire(join(process.cwd(), "package.json"))("wrangler");

const refuse = (message) => {
  // A workflow command on stdout, so the reason shows on the run's page as well as in its log.
  console.log(`::error::${message} Nothing was deployed.`);
  process.exit(1);
};

const configs = process.argv.slice(2);
if (configs.length === 0) refuse("No wrangler config was named to check.");
for (const config of configs) {
  if (!existsSync(config)) refuse(`${config} does not exist in ${process.cwd()}.`);
  const { name } = unstable_readConfig({ config, env: "dev" });
  if (typeof name !== "string" || !name.endsWith("-dev")) {
    refuse(`${config} with --env dev would deploy "${name}", which is not a dev Worker (its name must end in -dev).`);
  }
  console.log(`${config} with --env dev deploys ${name}`);
}
