import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

// One origin serves the web app's pages and this Worker's API (docs/pilot-api.md), so the operator console
// needs no CORS and one Cloudflare Access application covers both. This starts the Worker the way
// `wrangler dev --env dev` does, from the committed wrangler.jsonc: its custom build (the web app, built for
// one origin), its static-asset routing and the web app's `_headers` rules. The vitest pool cannot show any
// of this, because its SELF binding skips the asset router. Nothing leaves this machine: every outbound fetch
// is refused, and no Cloudflare account or secret is used. It is not evidence of the deployed Worker.
let outbound = 0;
let checked = 0;

const worker = await unstable_startWorker({
  config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  env: "dev",
  sendMetrics: false,
  dev: {
    remote: false,
    persist: false,
    watch: false,
    liveReload: false,
    inspector: false,
    logLevel: "error",
    server: { hostname: "127.0.0.1", port: 0 },
    outboundService: () => {
      outbound++;
      return new Response("fixture_outbound_forbidden", { status: 503 });
    },
  },
});

// What a browser sends when a person opens a link; Cloudflare's asset router reads `sec-fetch-mode`.
const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };

try {
  await worker.ready;
  const base = await worker.url;
  const open = (path, init) => worker.fetch(new URL(path, base), init);

  // The owner's page and the console are the web app's one page. Its headers keep the approve button out
  // of every frame, so no other site can trick an owner into clicking it, and keep the token in the path out
  // of every Referer.
  let home = "";
  for (const path of ["/approve/tok_123", "/ops", "/"]) {
    const response = await open(path, { headers: navigate });
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/, path);
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    if (path === "/") home = html;
    checked++;
  }

  // A link names exactly one action, so the page that opens it is never stored by a browser or a proxy.
  const approve = await open("/approve/tok_123", { headers: navigate });
  assert.equal(approve.headers.get("cache-control"), "no-store");
  await approve.arrayBuffer();
  checked++;

  // The built script the page loads is served as a file.
  const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(home)?.[1];
  assert.ok(script, "index.html names its script");
  const js = await open(script);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  await js.arrayBuffer();
  checked++;

  // Every API path reaches the Worker, even when a person opens it in a browser: never the page in its place.
  const health = await open("/v1/health", { headers: navigate });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "manut-api");
  const missing = await open("/v1/no-such-route", { headers: navigate });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not_found" });
  const admin = await open("/v1/admin/pilot/shops", { headers: navigate });
  assert.equal(admin.status, 403);
  assert.deepEqual(await admin.json(), { error: "forbidden" });
  const relay = await open("/relay/v1/hosts/probe/phone", { headers: navigate });
  assert.match(relay.headers.get("content-type") ?? "", /^application\/json/);
  await relay.json();
  checked += 4;

  assert.equal(outbound, 0);
  console.log(`PASS ${checked} one-origin routing contracts; outbound calls 0; deployed Worker NOT VERIFIED`);
} finally {
  await worker.dispose();
}
