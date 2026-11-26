/// The pages Worker (wrangler.web.jsonc): serves apps/web's build, the owner's approval page and the operator
/// console, to the API Worker, which hands it every path outside the API over the `WEB` service binding
/// (index.ts). Together they are one origin, so the console needs no CORS and one Cloudflare Access application
/// covers the console and the operator routes.
///
/// The pages live in a Worker of their own because Cloudflare runs any Worker that has static assets behind an
/// internal asset router, and that router does not pass `ctx.access` to the Worker's code. The API's admin gate
/// needs `ctx.access`, so the API Worker must have no assets
/// (https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations).
///
/// Every request runs this script first (`run_worker_first`), so the headers below are set here, in code the
/// tests run, rather than through a `_headers` file whose reach depends on how a request arrived.

import { APP_POLICY, JOIN_POLICY, PAGE_POLICY } from "./app-policy";

export type PagesEnv = { ASSETS: Fetcher };

/// No page may be framed, so no other site can trick an owner into pressing Approve; the token in an approval
/// link's path never leaves in a Referer; nothing is indexed.
const PAGE_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
};

/// The page an approval or deletion link opens names exactly one thing the owner may decide, and the page an invite link
/// opens carries the invite's token in its path, so no browser or proxy keeps any of them.
const NEVER_STORED = /^\/(approve|delete|join)\//;

const APP_PAGES = /^\/app(\/|$)/;
const JOIN_PAGES = /^\/join\//;

/// Every page's script policy (app-policy.ts): this origin's scripts only, nothing inline, never framed. The owner's web
/// app has its own, the join page one that names no other origin, and every other page the rest's.
function policyFor(pathname: string): string {
  if (APP_PAGES.test(pathname)) return APP_POLICY;
  return JOIN_PAGES.test(pathname) ? JOIN_POLICY : PAGE_POLICY;
}

export function withPageHeaders(response: Response, pathname: string): Response {
  const answer = new Response(response.body, response);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) answer.headers.set(name, value);
  answer.headers.set("content-security-policy", policyFor(pathname));
  if (NEVER_STORED.test(pathname)) answer.headers.set("cache-control", "no-store");
  return answer;
}

export default {
  /// The assets binding applies the single-page fallback: a path that names no file gets the app's one page,
  /// which picks the screen from the path.
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    const response = await env.ASSETS.fetch(request);
    return withPageHeaders(response, new URL(request.url).pathname);
  },
};
