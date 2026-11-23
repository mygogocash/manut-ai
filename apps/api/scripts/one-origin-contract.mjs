import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_readConfig, unstable_startWorker } from "wrangler";

// One origin (docs/pilot-api.md): the API Worker (wrangler.jsonc) answers /v1/* and /relay/* and hands every
// other path to the pages Worker (wrangler.web.jsonc) over its WEB service binding. The API Worker must have no
// static assets: Cloudflare runs a Worker with assets behind an internal router that does not pass ctx.access,
// and the admin gate needs it. test/pages.test.ts covers the hand-off and the page headers in workerd; this
// checks what only the configuration and running Workers can show:
//   1. in every environment, the API Worker has no assets and binds WEB to that environment's pages Worker;
//   2. the pages Worker, started as `wrangler dev` starts it (custom build, assets, single-page fallback), serves
//      every page with its headers, whether or not the browser sends fetch metadata (older phones do not);
//   3. the API Worker, started beside it, hands it the pages and keeps every API path.
// Nothing leaves this machine: Worker fetches to the internet are refused, Miniflare's cf.json download is off,
// the only env file is an empty one, and no Cloudflare account is used. It is not evidence of a deployed Worker.

// Wrangler runs a custom build in a "cwd" taken from where it was started, so start where every package script does.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
process.env.CLOUDFLARE_CF_FETCH_ENABLED = "false";
const NO_SECRETS = fileURLToPath(new URL("./no-secrets.env", import.meta.url));
let outbound = 0;
let checked = 0;

// 1. Configuration, read by Wrangler itself, so what an environment inherits counts.
for (const env of [undefined, "dev", "staging", "prod"]) {
  const where = env ?? "top level";
  const api = unstable_readConfig({ config: "wrangler.jsonc", env }, { hideWarnings: true });
  const web = unstable_readConfig({ config: "wrangler.web.jsonc", env }, { hideWarnings: true });
  assert.equal(api.assets, undefined, `${where}: the API Worker must have no static assets, or ctx.access is lost`);
  assert.deepEqual(api.services?.find((service) => service.binding === "WEB"), { binding: "WEB", service: web.name },
    `${where}: WEB must name this environment's pages Worker`);
  assert.equal(web.assets?.binding, "ASSETS", where);
  assert.equal(web.assets?.run_worker_first, true, `${where}: the page headers are set in src/pages.ts`);
  // Only the front door has a host: the pages Worker is reached through WEB and nothing else.
  assert.deepEqual(web.routes ?? [], [], `${where}: the pages Worker must have no route of its own`);
  assert.equal(web.workers_dev, false, where);
  // The links the API mints (approval pages, LINE webhooks) must point at the host that serves both.
  for (const route of api.routes ?? []) {
    const host = typeof route === "string" ? route : route.pattern;
    assert.equal(api.vars?.WEB_ORIGIN, `https://${host}`, `${where}: WEB_ORIGIN must be the front door's host`);
    assert.equal(api.vars?.PUBLIC_API_ORIGIN, `https://${host}`, `${where}: PUBLIC_API_ORIGIN must be the front door's host`);
  }
  checked++;
}
// The owner's choice of host for dev (docs/decisions.md): the API Worker owns dev.manut.xyz as its custom domain.
const dev = unstable_readConfig({ config: "wrangler.jsonc", env: "dev" }, { hideWarnings: true });
assert.deepEqual(dev.routes, [{ pattern: "dev.manut.xyz", custom_domain: true }], "dev serves on dev.manut.xyz");
checked++;

// One local registry for both Workers, so the API Worker's WEB binding finds the pages Worker the way the
// deployed binding finds the deployed one.
const REGISTRY = mkdtempSync(join(tmpdir(), "manut-one-origin-"));

async function start(config) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${config} did not start within 60 seconds`)), 60_000);
  });
  let worker;
  try {
    worker = await Promise.race([unstable_startWorker({
      config,
      env: "dev",
      envFiles: [NO_SECRETS],
      sendMetrics: false,
      dev: {
        remote: false,
        persist: false,
        watch: false,
        liveReload: false,
        inspector: false,
        logLevel: "error",
        registry: REGISTRY,
        server: { hostname: "127.0.0.1", port: 0 },
        outboundService: () => {
          outbound++;
          return new Response("fixture_outbound_forbidden", { status: 503 });
        },
      },
    }), late]);
    await Promise.race([worker.ready, late]);
    return worker;
  } catch (error) {
    await worker?.dispose();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// What a browser sends when a person opens a link, and what an older one sends: nothing.
const NAVIGATIONS = [{ "sec-fetch-mode": "navigate", accept: "text/html" }, {}];

/// A page as an owner or an operator gets it: the app's one page, with headers that keep it out of every frame
/// (so no other site can trick an owner into pressing Approve) and the token in its path out of every Referer.
async function assertPage(response, label) {
  assert.equal(response.status, 200, label);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/, label);
  assert.equal(response.headers.get("x-frame-options"), "DENY", label);
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'", label);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", label);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/, label);
  return html;
}

const pages = await start("wrangler.web.jsonc");
let api;
try {
  // 2. The pages Worker on its own.
  const pagesBase = await pages.url;
  let home = "";
  for (const path of ["/approve/tok_123", "/ops", "/", "/no-such-page"]) {
    for (const headers of NAVIGATIONS) {
      const html = await assertPage(await pages.fetch(new URL(path, pagesBase), { headers }), `pages ${path}`);
      if (path === "/") home = html;
    }
    checked++;
  }
  const approve = await pages.fetch(new URL("/approve/tok_123", pagesBase), { headers: NAVIGATIONS[0] });
  assert.equal(approve.headers.get("cache-control"), "no-store", "an approval page is never stored");
  await approve.arrayBuffer();
  const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(home)?.[1];
  assert.ok(script, "index.html names its script");
  const js = await pages.fetch(new URL(script, pagesBase));
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  await js.arrayBuffer();
  checked += 2;

  // 3. The API Worker, the front door, beside it: its WEB binding finds the pages Worker through Wrangler's
  // local registry, as the deployed binding finds the deployed one.
  api = await start("wrangler.jsonc");
  const base = await api.url;
  for (const headers of NAVIGATIONS) await assertPage(await api.fetch(new URL("/approve/tok_123", base), { headers }), "front door /approve");
  const health = await api.fetch(new URL("/v1/health", base), { headers: NAVIGATIONS[0] });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "manut-api");
  const missing = await api.fetch(new URL("/v1/no-such-route", base), { headers: NAVIGATIONS[0] });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  const admin = await api.fetch(new URL("/v1/admin/pilot/shops", base), { headers: NAVIGATIONS[0] });
  assert.equal(admin.status, 403);
  assert.deepEqual(await admin.json(), { error: "forbidden" });
  const relay = await api.fetch(new URL("/relay/v1/hosts/probe/phone", base), { headers: NAVIGATIONS[0] });
  assert.match(relay.headers.get("content-type") ?? "", /^application\/json/);
  await relay.json();
  checked += 5;

  assert.equal(outbound, 0);
  console.log(`PASS ${checked} one-origin contracts; outbound calls 0; deployed Workers NOT VERIFIED`);
} finally {
  await api?.dispose();
  await pages.dispose();
  rmSync(REGISTRY, { recursive: true, force: true });
}
