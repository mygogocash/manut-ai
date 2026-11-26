import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS } from "../src/artifact-store";
import { artifactOrigin, forgetArtifactSwitch, PAGE_CACHE, PUBLIC_HEADERS } from "../src/artifacts";
import worker, { type Env } from "../src/index";
import { tenantDelete, tenantExport, tenantStub } from "../src/tenant-data";
import {
  auditEntries,
  bindings,
  joinHelper,
  linkedOwner,
  setFlags,
  setupShop,
  signIn,
  type Shop,
} from "./people-fixtures";

/// Artifact links (artifacts.ts, artifact-store.ts; docs/pilot-api.md, "Artifact links"): the owner's routes with a shop's
/// session, each of their refusals, the switch and the origin that keep publishing off, the caps, the public read's headers
/// on the artifact host and its 404 everywhere else, removal, export and deletion. Every session is minted through the real
/// routes; the artifact origin is the test's own, since no environment sets one.

const ORIGIN = "https://links.manut-pages.test";
const withOrigin = { ...bindings, ARTIFACT_ORIGIN: ORIGIN } as Env;
const PAGE = "<!doctype html><title>Menu</title><h1>Somtam</h1><script>alert(1)</script>";

type Answer = { status: number; headers: Headers; body: Record<string, unknown> };

/// A request to the Worker as the edge delivers it, from a source address of its own, on `host`, with `target`'s bindings.
async function send(path: string, init: RequestInit = {}, target: Env = withOrigin, host = "api.manut.test",
  source = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!.join(":")}`): Promise<Response> {
  const request = new Request(`https://${host}${path}`, init);
  request.headers.set("cf-connecting-ip", source);
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

async function asOwner(headers: { authorization?: string }, method: string, path: string, body?: unknown,
  target: Env = withOrigin): Promise<Answer> {
  const response = await send(path, { method, headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, target);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, unknown> };
}

const publish = (headers: { authorization?: string }, body: unknown, target: Env = withOrigin) =>
  asOwner(headers, "POST", "/v1/artifacts", body, target);
const listed = (headers: { authorization?: string }, target: Env = withOrigin) =>
  asOwner(headers, "GET", "/v1/artifacts", undefined, target);
const removed = (headers: { authorization?: string }, id: string) =>
  asOwner(headers, "POST", "/v1/artifacts/remove", { id });

/// The page a link opens, read on the artifact host as a visitor's browser reads it.
function visit(url: string, init: RequestInit = {}, target: Env = withOrigin): Promise<Response> {
  const parsed = new URL(url);
  return send(parsed.pathname, init, target, parsed.host);
}

/// What the shop's object keeps under artifact keys.
function storedKeys(shop: Shop): Promise<string[]> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) =>
    [...(await state.storage.list()).keys()].filter((key) => key.startsWith("artifact")));
}

/// A shop with its owner's session, as the desktop holds one.
async function ownedShop(name = "Baan Mali"): Promise<{ shop: Shop; owner: { authorization: string }; accountId: string }> {
  const shop = await setupShop(name);
  const owner = await linkedOwner(shop);
  return { shop, owner: owner.headers, accountId: owner.accountId };
}

/// Every header of an answer but its length, which the runtime adds.
const headersOf = (response: Response) =>
  Object.fromEntries([...response.headers].filter(([name]) => name !== "content-length"));

const NOT_FOUND_HEADERS = { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

beforeEach(() => forgetArtifactSwitch());

afterEach(async () => {
  expect((await setFlags({ artifactLinks: false })).status).toBe(200);
  forgetArtifactSwitch();
});

describe("the artifact origin", () => {
  it("is used only when it is https, an origin alone, and a host of its own, never the app's or one inside or around it", () => {
    const app = { PUBLIC_API_ORIGIN: "https://dev.manut.xyz", WEB_ORIGIN: "https://dev.manut.xyz" };
    expect(artifactOrigin({ ...app })).toBeNull();
    expect(artifactOrigin({ ...app, ARTIFACT_ORIGIN: "https://manut-pages.example" })).toBe("https://manut-pages.example");
    expect(artifactOrigin({ ...app, ARTIFACT_ORIGIN: "https://manut-pages.example/" })).toBe("https://manut-pages.example");
    for (const refused of ["https://dev.manut.xyz", "https://a.dev.manut.xyz", "https://manut.xyz", "http://manut-pages.example",
      "https://manut-pages.example/a", "https://manut-pages.example?x=1", "https://u:p@manut-pages.example", "not a url"]) {
      expect(artifactOrigin({ ...app, ARTIFACT_ORIGIN: refused }), refused).toBeNull();
    }
  });
});

describe("publishing while it is switched off", () => {
  it("answers feature_disabled and stores nothing while the switch is off, which it is by default", async () => {
    const { shop, owner } = await ownedShop();
    const refused = await publish(owner, { title: "Menu", kind: "html", text: PAGE });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "feature_disabled", feature: "artifactLinks" });
    expect(await storedKeys(shop)).toEqual([]);
    // Listing stays open, and says why nothing can be published.
    const list = await listed(owner);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ publishing: "feature_disabled", skillPublishing: "feature_disabled", origin: ORIGIN, artifacts: [] });
  });

  it("answers artifact_origin_not_configured and stores nothing while the switch is on and no origin is set", async () => {
    const { shop, owner } = await ownedShop();
    expect((await setFlags({ artifactLinks: true })).status).toBe(200);
    const refused = await publish(owner, { title: "Menu", kind: "html", text: PAGE }, bindings);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: "artifact_origin_not_configured" });
    expect(await storedKeys(shop)).toEqual([]);
    expect((await listed(owner, bindings)).body).toEqual({ publishing: "artifact_origin_not_configured",
      skillPublishing: "artifact_origin_not_configured", origin: null, artifacts: [] });
    // An origin on the app's own host is no origin at all.
    const own = { ...bindings, ARTIFACT_ORIGIN: "https://api.manut.test" } as Env;
    expect((await publish(owner, { title: "Menu", kind: "html", text: PAGE }, own)).body)
      .toEqual({ error: "artifact_origin_not_configured" });
  });
});

describe("the owner's routes", () => {
  beforeEach(async () => {
    expect((await setFlags({ artifactLinks: true })).status).toBe(200);
  });

  it("publishes a page as a link, lists it newest first, and records each change by the link's id alone", async () => {
    const { shop, owner, accountId } = await ownedShop();
    const first = await publish(owner, { title: "  Menu  ", kind: "html", text: PAGE });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const artifact = first.body.artifact as Record<string, unknown>;
    expect(artifact).toEqual({ id: expect.stringMatching(/^art-/), title: "Menu", kind: "html",
      bytes: new TextEncoder().encode(PAGE).length, createdAt: expect.any(Number),
      url: expect.stringMatching(new RegExp(`^${ORIGIN}/a/[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{32}$`)) });
    const second = (await publish(owner, { title: "Opening hours", kind: "markdown", text: "# Open\n\nEvery day" })).body
      .artifact as Record<string, unknown>;
    // Two links of one shop share the shop's part and nothing else.
    expect(String(second.url).split(".").at(-2)).toBe(String(artifact.url).split(".").at(-2));
    expect(second.url).not.toBe(artifact.url);

    const list = await listed(owner);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.body.publishing).toBe("on");
    expect((list.body.artifacts as Record<string, unknown>[]).map((one) => one.title)).toEqual(["Opening hours", "Menu"]);
    expect(list.body.artifacts as unknown[]).toContainEqual(artifact);

    const entries = (await auditEntries(shop.tenant)).filter((entry) => entry.action.startsWith("artifact."));
    expect(entries.map((entry) => entry.action)).toEqual(["artifact.published", "artifact.published"]);
    expect(entries[1]).toMatchObject({ actor: { kind: "owner", id: accountId }, subject: { artifactId: artifact.id },
      outcome: "ok" });
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain("Menu");
    expect(logged).not.toContain(String(artifact.url).split("/a/")[1]);
  });

  it("refuses each request it cannot take, before anything is stored", async () => {
    const { shop, owner } = await ownedShop();
    const page = { title: "Menu", kind: "html", text: PAGE };
    expect((await publish({}, page)).body).toEqual({ error: "unauthorized" });
    // A helper's session is told the links are the owner's.
    const helper = await joinHelper(shop);
    expect(await publish(helper.headers, page)).toMatchObject({ status: 403, body: { error: "owner_only" } });
    expect(await listed(helper.headers)).toMatchObject({ status: 403, body: { error: "owner_only" } });
    // A person's own sign-in is no shop.
    const person = await signIn();
    expect(await publish(person.headers, page)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await listed(person.headers)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await asOwner(owner, "PUT", "/v1/artifacts", page)).toMatchObject({ status: 405 });
    expect(await asOwner(owner, "GET", "/v1/artifacts/remove")).toMatchObject({ status: 405 });
    expect(await asOwner(owner, "POST", `/v1/artifacts?shop=${encodeURIComponent(shop.tenant)}`, page))
      .toMatchObject({ status: 400, body: { error: "invalid_request" } });
    // Only the session names the shop: a body with another field is refused, not read.
    expect(await publish(owner, { ...page, tenant: shop.tenant })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await publish(owner, { ...page, title: " " })).toMatchObject({ status: 400, body: { error: "invalid_title" } });
    expect(await publish(owner, { ...page, title: "two\nlines" })).toMatchObject({ status: 400, body: { error: "invalid_title" } });
    expect(await publish(owner, { ...page, title: "x".repeat(121) })).toMatchObject({ status: 400, body: { error: "invalid_title" } });
    expect(await publish(owner, { ...page, kind: "pdf" })).toMatchObject({ status: 400, body: { error: "invalid_kind" } });
    expect(await publish(owner, { ...page, text: "" })).toMatchObject({ status: 400, body: { error: "invalid_text" } });
    // Thai counts in UTF-8 bytes, three to a letter, as it is stored.
    const thai = "ก".repeat(Math.floor(MAX_ARTIFACT_BYTES / 3) + 1);
    expect(await publish(owner, { ...page, text: thai })).toMatchObject({ status: 413,
      body: { error: "too_large", max: MAX_ARTIFACT_BYTES } });
    // A body that does not say it is JSON never reaches the route.
    const typed = await send("/v1/artifacts", { method: "POST", headers: { ...owner, "content-type": "text/plain" },
      body: JSON.stringify(page) });
    expect(typed.status).toBe(415);
    expect(await removed(owner, "art-none")).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await storedKeys(shop)).toEqual([]);
  });

  it("holds at most MAX_ARTIFACTS links a shop, and the full size of a page", async () => {
    const { shop, owner } = await ownedShop();
    const full = await publish(owner, { title: "Full", kind: "markdown", text: "a".repeat(MAX_ARTIFACT_BYTES) });
    expect(full.status).toBe(200);
    for (let i = 1; i < MAX_ARTIFACTS; i++) expect((await publish(owner, { title: `Page ${i}`, kind: "markdown", text: "x" })).status).toBe(200);
    expect(await publish(owner, { title: "One more", kind: "markdown", text: "x" }))
      .toMatchObject({ status: 409, body: { error: "too_many", max: MAX_ARTIFACTS } });
    expect((await listed(owner)).body.artifacts as unknown[]).toHaveLength(MAX_ARTIFACTS);
    // Removing one makes room for one.
    expect((await removed(owner, (full.body.artifact as { id: string }).id)).status).toBe(200);
    expect((await publish(owner, { title: "One more", kind: "markdown", text: "x" })).status).toBe(200);
    expect(await storedKeys(shop)).toHaveLength(3 * MAX_ARTIFACTS);
  });
});

describe("the public read", () => {
  beforeEach(async () => {
    expect((await setFlags({ artifactLinks: true })).status).toBe(200);
  });

  async function published(kind: "html" | "markdown", text: string) {
    const { shop, owner } = await ownedShop();
    const made = await publish(owner, { title: "Menu", kind, text });
    expect(made.status).toBe(200);
    return { shop, owner, artifact: made.body.artifact as { id: string; url: string } };
  }

  it("serves HTML on the artifact host with no script, form, network or origin, and never a cookie", async () => {
    const { artifact } = await published("html", PAGE);
    const page = await visit(artifact.url, { headers: { cookie: "manut_session=should-never-be-read" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PAGE);
    expect(headersOf(page)).toEqual({
      "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "content-type": "text/html; charset=utf-8",
      "cache-control": PAGE_CACHE,
    });
    expect(PAGE_CACHE).toBe("private, max-age=60");
    expect(page.headers.has("set-cookie")).toBe(false);
  });

  it("serves Markdown as plain text, as written", async () => {
    const text = "# Opening hours\n\n<b>Every day</b>";
    const { artifact } = await published("markdown", text);
    const page = await visit(artifact.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(PUBLIC_HEADERS["content-security-policy"]);
    expect(await page.text()).toBe(text);
  });

  it("is never served on any other host, the app's own included", async () => {
    const { artifact } = await published("html", PAGE);
    const path = new URL(artifact.url).pathname;
    for (const host of ["api.manut.test", "web.manut.test", "other.example"]) {
      const answer = await send(path, {}, withOrigin, host);
      expect(answer.status, host).toBe(404);
      expect(await answer.text(), host).toBe("Not found");
    }
    // Nor anywhere while no origin is set.
    const unset = await send(path, {}, bindings, new URL(ORIGIN).host);
    expect(unset.status).toBe(404);
    // And the artifact host answers nothing but links: not the API, not the app's pages.
    for (const other of ["/v1/health", "/", "/approve/x", "/a/"]) {
      const answer = await send(other, {}, withOrigin, new URL(ORIGIN).host);
      expect(answer.status, other).toBe(404);
      expect(headersOf(answer), other).toEqual(NOT_FOUND_HEADERS);
    }
    const posted = await visit(artifact.url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });

  it("answers a removed link exactly as one that never was, at once", async () => {
    const { shop, owner, artifact } = await published("html", PAGE);
    expect((await visit(artifact.url)).status).toBe(200);
    expect(await removed(owner, artifact.id)).toMatchObject({ status: 200, body: { id: artifact.id } });
    expect((await listed(owner)).body.artifacts).toEqual([]);
    const gone = await visit(artifact.url);
    const [shopPart] = new URL(artifact.url).pathname.slice(3).split(".");
    const never = await visit(`${ORIGIN}/a/${shopPart}.${"A".repeat(32)}`);
    const garbled = await visit(`${ORIGIN}/a/${"B".repeat(43)}.${"A".repeat(32)}`);
    for (const answer of [gone, never, garbled]) {
      expect(answer.status).toBe(404);
      expect(headersOf(answer)).toEqual(NOT_FOUND_HEADERS);
      expect(await answer.text()).toBe("Not found");
    }
    // Removing it again finds nothing.
    expect(await removed(owner, artifact.id)).toMatchObject({ status: 404, body: { error: "not_found" } });
    const entries = await auditEntries(shop.tenant);
    expect(entries[0]).toMatchObject({ action: "artifact.removed", subject: { artifactId: artifact.id } });
  });

  it("answers every link 404 once the switch is off, while the owner can still list and remove them", async () => {
    const { owner, artifact } = await published("html", PAGE);
    expect((await setFlags({ artifactLinks: false })).status).toBe(200);
    forgetArtifactSwitch();
    const off = await visit(artifact.url);
    expect(off.status).toBe(404);
    expect(headersOf(off)).toEqual(NOT_FOUND_HEADERS);
    const list = await listed(owner);
    expect(list.body.publishing).toBe("feature_disabled");
    expect((list.body.artifacts as { id: string }[]).map((one) => one.id)).toEqual([artifact.id]);
    expect((await removed(owner, artifact.id)).status).toBe(200);
  });

  it("counts every request on the artifact host against its own limit, per source address, before any object", async () => {
    const { artifact } = await published("html", PAGE);
    const keys: string[] = [];
    let objects = 0;
    const limited = {
      ...withOrigin,
      ARTIFACT_READ_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: false }; } },
      TENANT: { ...bindings.TENANT, idFromString: () => { objects++; throw new Error("not reached"); },
        get: () => { objects++; throw new Error("not reached"); } },
    } as unknown as Env;
    const answer = await send(new URL(artifact.url).pathname, {}, limited, new URL(ORIGIN).host, "203.0.113.7");
    expect(answer.status).toBe(429);
    expect(answer.headers.get("retry-after")).toBe("60");
    expect(answer.headers.get("content-security-policy")).toBe(PUBLIC_HEADERS["content-security-policy"]);
    expect(await answer.json()).toEqual({ error: "rate_limited" });
    expect(keys).toEqual(["203.0.113.7"]);
    expect(objects).toBe(0);
    // Without its limiter, the host answers nothing.
    const { ARTIFACT_READ_LIMITER: _limiter, ...unbound } = withOrigin;
    const failed = await send(new URL(artifact.url).pathname, {}, unbound as Env, new URL(ORIGIN).host);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "rate_limit_unavailable" });
  });
});

describe("export and deletion", () => {
  beforeEach(async () => {
    expect((await setFlags({ artifactLinks: true })).status).toBe(200);
  });

  it("exports every page with its text and without its link, and deletion takes them all and closes every link", async () => {
    const { shop, owner } = await ownedShop();
    const made = (await publish(owner, { title: "Menu", kind: "html", text: PAGE })).body.artifact as { id: string; url: string };
    const other = await ownedShop("Cafe Lek");
    const kept = (await publish(other.owner, { title: "Kept", kind: "markdown", text: "kept" })).body.artifact as { url: string };

    const exported = (await (await tenantExport(bindings, shop.tenant)).json()) as { artifacts: Record<string, unknown>[] };
    expect(exported.artifacts).toEqual([{ id: made.id, title: "Menu", kind: "html", bytes: new TextEncoder().encode(PAGE).length,
      createdAt: expect.any(Number), text: PAGE }]);
    expect(JSON.stringify(exported)).not.toContain(made.url.split("/a/")[1]!.split(".")[1]);

    expect((await tenantDelete(bindings, shop.tenant)).status).toBe(200);
    expect(await storedKeys(shop)).toEqual([]);
    expect((await visit(made.url)).status).toBe(404);
    // Another shop's links stay.
    expect((await visit(kept.url)).status).toBe(200);
  });
});
