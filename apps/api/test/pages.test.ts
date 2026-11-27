import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { APP_POLICY, JOIN_POLICY, PAGE_POLICY } from "../src/app-policy";
import pages from "../src/pages";

const bindings = env as unknown as Env;

type Seen = { url: string; method: string };

/// A stand-in for a service binding or the assets binding: records what reached it and answers like a page.
function fetcher(seen: Seen[], answer = () => new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } })) {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, method: request.method });
      return answer();
    },
  } as unknown as Fetcher;
}

async function call(path: string, withWeb: Fetcher | undefined, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`https://pilot.manut.test${path}`, init),
    withWeb ? { ...bindings, WEB: withWeb } : bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("one origin: the API Worker is the front door", () => {
  it("hands every path outside the API to the pages Worker, unchanged", async () => {
    const seen: Seen[] = [];
    const web = fetcher(seen);
    for (const path of ["/", "/ops", "/approve/tok_123", "/assets/index-abc.js", "/v1", "/relayed"]) {
      const response = await call(path, web);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe('<div id="root"></div>');
    }
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual(
      ["/", "/ops", "/approve/tok_123", "/assets/index-abc.js", "/v1", "/relayed"]);
  });

  it("answers every API path itself and never hands one to the pages Worker", async () => {
    const seen: Seen[] = [];
    const web = fetcher(seen);
    const health = await call("/v1/health", web);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { service: string }).service).toBe("manut-api");
    expect(await (await call("/v1/no-such-route", web)).json()).toEqual({ error: "not_found" });
    expect((await call("/v1/admin/pilot/shops", web)).status).toBe(403);
    expect((await call("/relay/v1/hosts/probe/phone", web)).headers.get("content-type")).toMatch(/^application\/json/);
    expect(seen).toEqual([]);
  });

  it("answers the API's own 404 for a page path when no pages Worker is bound", async () => {
    const response = await call("/approve/tok_123", undefined);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("the pages Worker", () => {
  async function page(path: string, answer?: () => Response) {
    const seen: Seen[] = [];
    const response = await pages.fetch(new Request(`https://pilot.manut.test${path}`), { ASSETS: fetcher(seen, answer) });
    return { response, seen };
  }

  it("gives every page a script policy of its own: the owner's web app, the join page and every other page", async () => {
    for (const path of ["/app/", "/app", "/app/sw.js", "/app/offline.html", "/app/manifest.webmanifest", "/app/elsewhere"]) {
      const { response } = await page(path);
      expect(response.headers.get("content-security-policy"), path).toBe(APP_POLICY);
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("cache-control"), path).toBeNull();
    }
    expect(APP_POLICY).toContain("script-src 'self';");
    // item 78f-2c: the web app's sockets may also reach a paired Mac's own door over a tailnet, on its one port, and nothing wider
    expect(APP_POLICY).toContain("connect-src 'self' wss://*.ts.net:47100;");
    expect(APP_POLICY.match(/connect-src[^;]*/)?.[0]).toBe("connect-src 'self' wss://*.ts.net:47100");
    for (const other of [PAGE_POLICY, JOIN_POLICY]) expect(other.match(/connect-src[^;]*/)?.[0]).toBe("connect-src 'self'");
    expect(APP_POLICY).toContain("frame-ancestors 'none'");
    expect(APP_POLICY).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    for (const path of ["/apps", "/application", "/ops", "/", "/approve/tok_123", "/delete/tok_123", "/no-such-page",
      "/assets/index-abc.js"]) {
      expect((await page(path)).response.headers.get("content-security-policy"), path).toBe(PAGE_POLICY);
    }
    for (const path of ["/join/inv_123", "/join/inv_123?from=line"]) {
      expect((await page(path)).response.headers.get("content-security-policy"), path).toBe(JOIN_POLICY);
    }
  });

  it("runs this origin's scripts alone on every page, nothing inline or from a string, and lets no page be framed", () => {
    const directives = (policy: string) => new Map(policy.split("; ").map((part) => {
      const [name, ...values] = part.split(" ");
      return [name!, values] as const;
    }));
    for (const [name, policy] of [["app", APP_POLICY], ["page", PAGE_POLICY], ["join", JOIN_POLICY]] as const) {
      const seen = directives(policy);
      expect(seen.get("script-src"), name).toEqual(["'self'"]);
      expect(seen.get("default-src"), name).toEqual(["'self'"]);
      // the web app alone may also open a socket to a paired Mac's own door over a tailnet, on its one port (item 78f-2c)
      expect(seen.get("connect-src"), name).toEqual(name === "app" ? ["'self'", "wss://*.ts.net:47100"] : ["'self'"]);
      expect(seen.get("frame-ancestors"), name).toEqual(["'none'"]);
      expect(seen.get("object-src"), name).toEqual(["'none'"]);
      expect(seen.get("base-uri"), name).toEqual(["'none'"]);
      expect(policy, name).not.toContain("unsafe-eval");
    }
    // The console and the links' pages take the brand's fonts from Google's two hosts and nothing else from anywhere.
    expect([...PAGE_POLICY.matchAll(/https:\/\/[^ ;]+/g)].map((found) => found[0]).sort())
      .toEqual(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);
    // The join page's path carries an invite token: its policy names no other origin at all.
    expect(JOIN_POLICY).not.toMatch(/https?:/);
  });

  it("serves the web app's files with headers that keep pages out of frames and tokens out of Referers", async () => {
    for (const path of ["/", "/ops", "/approve/tok_123", "/join/inv_123", "/assets/index-abc.js"]) {
      const { response, seen } = await page(path);
      expect(seen.map((entry) => new URL(entry.url).pathname), path).toEqual([path]);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("content-security-policy"), path).toBe(path.startsWith("/join/") ? JOIN_POLICY : PAGE_POLICY);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(response.headers.get("content-type"), path).toBe("text/html");
    }
  });

  it("never lets a browser or proxy store the page an approval, deletion or invite link opens", async () => {
    expect((await page("/approve/tok_123")).response.headers.get("cache-control")).toBe("no-store");
    expect((await page("/delete/tok_123")).response.headers.get("cache-control")).toBe("no-store");
    expect((await page("/join/inv_123")).response.headers.get("cache-control")).toBe("no-store");
    expect((await page("/ops")).response.headers.get("cache-control")).toBeNull();
    expect((await page("/joined")).response.headers.get("cache-control")).toBeNull();
  });

  it("keeps the asset answer's status and body", async () => {
    const { response } = await page("/missing.png", () => new Response("gone", { status: 404 }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("gone");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
