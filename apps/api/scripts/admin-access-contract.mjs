import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";

// All input is the committed synthetic local test configuration. This exercises
// the entry HTTP router, which populates actual workerd ctx.access; SELF service
// bindings skip that router. It is not evidence of live Access authentication.
const config = JSON.parse(await readFile(new URL("../wrangler.test.json", import.meta.url), "utf8"));
assert.equal(config.name, "manut-api-test");
// Reuse Wrangler's pinned build dependency directly, avoiding CLI user
// preference/metadata resolution. This runner needs no provider configuration.
const require = createRequire(import.meta.url);
const { build, stop } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const audience = config.vars.ADMIN_ACCESS_AUD;
const durableObjects = Object.fromEntries(config.durable_objects.bindings.map(({ name, class_name }) =>
  [name, { className: class_name, useSQLite: true }]));
let externalCalls = 0;
let checked = 0;

async function runContracts(scriptPath) {
  for (const scenario of ["matching", "mismatched", "absent", "unconfigured"]) {
    const bindings = { ...config.vars };
    if (scenario === "unconfigured") delete bindings.ADMIN_ACCESS_AUD;
    const scratch = await mkdtemp(join(tmpdir(), "manut-access-contract-"));
    let mf;
    try {
      mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, scriptPath, modulesRoot: dirname(scriptPath),
        compatibilityDate: config.compatibility_date,
        bindings, durableObjects, log: new Log(LogLevel.ERROR),
        ...(scenario === "absent" ? {} : { access: { aud: scenario === "mismatched" ? "another-application" : audience } }),
        outboundService: () => { externalCalls++; return new Response("fixture_outbound_forbidden", { status: 503 }); },
      }), resourcePersistencePath: scratch, resourceTmpPath: join(scratch, "tmp") });
      const headers = { authorization: `Bearer ${config.vars.CLOUD_API_KEY}`,
        "cf-access-jwt-assertion": "forged.fixture.jwt", "content-type": "application/json" };
      const admitted = await mf.dispatchFetch("https://fixture/v1/admin/flags", { headers });
      assert.equal(admitted.status, scenario === "matching" ? 200 : 403, `${scenario} platform context`);
      checked++;
      if (scenario !== "matching") continue;
      assert.equal((await mf.dispatchFetch("https://fixture/v1/admin/flags", {
        headers: { ...headers, authorization: "Bearer wrong-key" },
      })).status, 403);
      assert.equal((await mf.dispatchFetch("https://fixture/v1/admin/flags", { method: "DELETE", headers })).status, 404);
      assert.equal((await mf.dispatchFetch("https://fixture/v1/tasks/probe", { headers })).status, 401);
      checked += 3;
      const tenant = "apple:local-admin-contract";
      const account = "synthetic-linear-workspace";
      const stored = await mf.dispatchFetch("https://fixture/v1/admin/connections", { method: "POST", headers,
        body: JSON.stringify({ tenantId: tenant, provider: "linear", accountId: account,
          scopes: ["read"], resourceIds: ["synthetic-project"], refreshToken: "synthetic-fixture-only" }),
      });
      assert.equal(stored.status, 200);
      const created = await stored.json();
      const auth = await mf.getDurableObjectNamespace("AUTH");
      const index = await auth.get(auth.idFromName("auth")).fetch(`https://auth/inbound-routes?provider=linear&account=${account}`);
      assert.deepEqual(await index.json(), { routes: [{ tenant, connectionId: created.id }] });
      checked += 2;
    } finally {
      try { await mf?.dispose(); }
      finally { await rm(scratch, { recursive: true, force: true }); }
    }
  }
  assert.equal(externalCalls, 0);
  console.log(`PASS ${checked} local Access/admin contracts; outbound calls 0; live Access NOT VERIFIED`);
}

const bundleScratch = await mkdtemp(join(tmpdir(), "manut-access-bundle-"));
try {
  const scriptPath = join(bundleScratch, "index.js");
  await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    outfile: scriptPath, bundle: true, format: "esm", platform: "neutral",
    target: "es2024", keepNames: true, external: ["cloudflare:*"], logLevel: "silent" });
  await runContracts(scriptPath);
} finally {
  stop();
  await rm(bundleScratch, { recursive: true, force: true });
}
