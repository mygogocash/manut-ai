import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
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

  it("serves the web app's files with headers that keep pages out of frames and tokens out of Referers", async () => {
    for (const path of ["/", "/ops", "/approve/tok_123", "/assets/index-abc.js"]) {
      const { response, seen } = await page(path);
      expect(seen.map((entry) => new URL(entry.url).pathname), path).toEqual([path]);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-frame-options"), path).toBe("DENY");
      expect(response.headers.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(response.headers.get("content-type"), path).toBe("text/html");
    }
  });

  it("never lets a browser or proxy store the page an approval or deletion link opens", async () => {
    expect((await page("/approve/tok_123")).response.headers.get("cache-control")).toBe("no-store");
    expect((await page("/delete/tok_123")).response.headers.get("cache-control")).toBe("no-store");
    expect((await page("/ops")).response.headers.get("cache-control")).toBeNull();
  });

  it("keeps the asset answer's status and body", async () => {
    const { response } = await page("/missing.png", () => new Response("gone", { status: 404 }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("gone");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
