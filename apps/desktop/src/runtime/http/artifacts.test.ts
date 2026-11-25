// Artifact links on the connected runtime (artifacts.ts; the routes are docs/pilot-api.md, "Artifact links"): the shop's links read
// with its owner's session, and a publish or a removal that sends exactly the page or the link its settled ask named, once. While
// Settings › Artifacts is off nothing is sent at all; a shop the person helps at is refused with nothing sent; an ask that was not
// settled with a yes publishes nothing; a change that got no answer is never sent again; and each refusal of the API is said in words.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { setArtifactSettings } from "../../lib/artifactLinks";
import { answerArtifactAsk, askToRemove, askToShare, resetArtifactAsks } from "../artifactAsks";
import type { SharePlan } from "../artifacts";
import { ShopCache } from "./cache";
import { decodeLink, decodeList } from "./artifacts";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, memoryCacheStore, memoryVault, ORIGIN, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, T0, useMicrotaskCrypto, type FakeApi } from "./testkit";

const NOW = T0 + 600_000;
const OWNER_A = shopToken(SHOP_A.id, "owner");
const PAGE = "<!doctype html><h1>Somtam</h1>";
const LINK = `https://links.example/a/${"S".repeat(43)}.${"k".repeat(32)}`;
const ARTIFACT = { id: "art-1", title: "Menu", kind: "html", bytes: PAGE.length, createdAt: NOW - 60_000, url: LINK };

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, length: 0 } as Storage;
}

async function opened() {
  const api = fakeApi();
  serveShops(api, [SHOP_A, SHOP_B], {}, () => NOW);
  const cache = new ShopCache(memoryCacheStore());
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), onEnd: () => cache.clear() });
  const rt = new HttpRuntime(new HttpHost({ session, cache }));
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params?: unknown) => Promise<any>;
  return { api, req };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);
const linkCalls = (api: FakeApi) => api.calls.filter((c) => c.path.startsWith("/v1/artifacts")).map((c) => [c.method, c.path, c.bearer, c.body]);

const plan = (over: Partial<SharePlan> = {}): SharePlan => ({ shop: SHOP_A.id, title: "Menu", kind: "html", text: PAGE, bytes: PAGE.length, ...over });

/** An ask to publish `p`, answered as the person answers it. */
async function settledShare(p: SharePlan, yes = true): Promise<string> {
  const id = await askToShare(p);
  expect(await answerArtifactAsk(id, yes)).toEqual({ ok: true, yes });
  return id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
  useMicrotaskCrypto();
  vi.stubGlobal("localStorage", fakeStorage());
  setArtifactSettings({ publish: true });
  resetArtifactAsks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("while Settings › Artifacts is off", () => {
  it("sends nothing, a read included, and keeps a settled ask unused", async () => {
    const { api, req } = await opened();
    const ask = await settledShare(plan());
    setArtifactSettings({ publish: false });
    for (const [op, params] of [["artifacts.list", {}], ["artifacts.publish", { ask }], ["artifacts.remove", { ask }]] as const) {
      expect(await refusal(req(op, params))).toEqual({ code: "switched_off", message: t("art.err.switchedOff") });
    }
    expect(linkCalls(api)).toEqual([]);
    // turned on again, the ask the person said yes to still publishes, once
    setArtifactSettings({ publish: true });
    api.on("POST", "/v1/artifacts", { status: 200, json: { artifact: ARTIFACT } });
    expect((await req("artifacts.publish", { ask })).link.id).toBe("art-1");
  });
});

describe("the shop's links", () => {
  it("reads the viewed shop's links with its owner session, their times in seconds, and whether publishing is open", async () => {
    const { api, req } = await opened();
    api.on("GET", "/v1/artifacts", { status: 200, json: { publishing: "feature_disabled", artifacts: [ARTIFACT] } });
    const listed = await req("artifacts.list", {});
    expect(linkCalls(api)).toEqual([["GET", "/v1/artifacts", OWNER_A, undefined]]);
    expect(listed).toEqual({ shop: SHOP_A.id, publishing: "feature_disabled",
      links: [{ ...ARTIFACT, createdAt: (NOW - 60_000) / 1000 }] });
  });

  it("refuses a shop the person only helps at with nothing sent, and says what the API refused", async () => {
    const { api, req } = await opened();
    await req("shops.switch", { shop: SHOP_B.id });
    expect(await refusal(req("artifacts.list", {}))).toEqual({ code: "owner_only", message: t("art.err.ownerOnly") });
    expect(linkCalls(api)).toEqual([]);
    await req("shops.switch", { shop: SHOP_A.id });
    api.on("GET", "/v1/artifacts", { status: 503, json: { error: "artifacts_unavailable" } });
    expect(await refusal(req("artifacts.list", {}))).toEqual({ code: "unavailable", message: t("art.err.unavailable") });
    api.on("GET", "/v1/artifacts", { status: 200, json: { publishing: "on", artifacts: [{ ...ARTIFACT, url: "http://links.example/a/x" }] } });
    expect(await refusal(req("artifacts.list", {}))).toEqual({ code: "unavailable", message: t("art.err.unreadable") });
  });
});

describe("publishing a page", () => {
  it("sends exactly the page its settled ask showed, with that shop's session, once", async () => {
    const { api, req } = await opened();
    api.on("POST", "/v1/artifacts", { status: 200, json: { artifact: ARTIFACT } });
    const ask = await settledShare(plan({ title: "  Menu " }));
    const made = await req("artifacts.publish", { ask });
    expect(made.link).toEqual({ ...ARTIFACT, createdAt: (NOW - 60_000) / 1000 });
    expect(linkCalls(api)).toEqual([["POST", "/v1/artifacts", OWNER_A, { title: "Menu", kind: "html", text: PAGE }]]);
    // the same ask a second time publishes nothing more
    expect(await refusal(req("artifacts.publish", { ask }))).toEqual({ code: "not_settled", message: t("art.err.notSettled") });
    expect(linkCalls(api)).toHaveLength(1);
  });

  it("publishes nothing for an ask that waits, was answered no, is the other kind, or was never made", async () => {
    const { api, req } = await opened();
    const waiting = await askToShare(plan());
    const declined = await settledShare(plan(), false);
    const removal = await askToRemove({ shop: SHOP_A.id, id: "art-1", title: "Menu", url: LINK });
    await answerArtifactAsk(removal, true);
    for (const ask of [waiting, declined, removal, "artifact-publish-never", undefined]) {
      expect((await refusal(req("artifacts.publish", { ask })))?.code, String(ask)).toBe("not_settled");
    }
    expect(linkCalls(api)).toEqual([]);
  });

  it("refuses a shop the person helps at, and a page the API would refuse, with nothing sent", async () => {
    const { api, req } = await opened();
    expect((await refusal(req("artifacts.publish", { ask: await settledShare(plan({ shop: SHOP_B.id })) })))?.code).toBe("owner_only");
    expect((await refusal(req("artifacts.publish", { ask: await settledShare(plan({ shop: "pilot:not-mine" })) })))?.code).toBe("not_found");
    expect(await refusal(req("artifacts.publish", { ask: await settledShare(plan({ text: "a".repeat(200 * 1024) })) })))
      .toEqual({ code: "too_large", message: t("art.err.tooLarge", { max: 128 }) });
    expect(linkCalls(api)).toEqual([]);
  });

  it("says each refusal of the API in words, and never sends a publish again that got no answer", async () => {
    const { api, req } = await opened();
    api.on("POST", "/v1/artifacts", { status: 403, json: { error: "feature_disabled", feature: "artifactLinks" } });
    expect(await refusal(req("artifacts.publish", { ask: await settledShare(plan()) })))
      .toEqual({ code: "feature_disabled", message: t("art.err.featureOff") });
    api.on("POST", "/v1/artifacts", { status: 503, json: { error: "artifact_origin_not_configured" } });
    expect(await refusal(req("artifacts.publish", { ask: await settledShare(plan()) })))
      .toEqual({ code: "artifact_origin_not_configured", message: t("art.err.noOrigin") });
    api.on("POST", "/v1/artifacts", { status: 409, json: { error: "too_many", max: 50 } });
    expect(await refusal(req("artifacts.publish", { ask: await settledShare(plan()) })))
      .toEqual({ code: "too_many", message: t("art.err.tooMany", { max: 50 }) });
    api.on("POST", "/v1/artifacts", "offline");
    const lost = await settledShare(plan());
    expect((await refusal(req("artifacts.publish", { ask: lost })))?.code).toBe("offline");
    api.on("POST", "/v1/artifacts", { status: 200, json: { artifact: ARTIFACT } });
    expect((await refusal(req("artifacts.publish", { ask: lost })))?.code).toBe("not_settled");
    expect(api.to("POST", "/v1/artifacts")).toHaveLength(4);
  });
});

describe("removing a link", () => {
  it("sends only the link's id after a yes, once, and nothing for a no", async () => {
    const { api, req } = await opened();
    api.on("POST", "/v1/artifacts/remove", { status: 200, json: { id: "art-1" } });
    const keep = await askToRemove({ shop: SHOP_A.id, id: "art-1", title: "Menu", url: LINK });
    await answerArtifactAsk(keep, false);
    expect((await refusal(req("artifacts.remove", { ask: keep })))?.code).toBe("not_settled");
    const ask = await askToRemove({ shop: SHOP_A.id, id: "art-1", title: "Menu", url: LINK });
    await answerArtifactAsk(ask, true);
    expect(await req("artifacts.remove", { ask })).toEqual({ id: "art-1" });
    expect(linkCalls(api)).toEqual([["POST", "/v1/artifacts/remove", OWNER_A, { id: "art-1" }]]);
    expect((await refusal(req("artifacts.remove", { ask })))?.code).toBe("not_settled");
  });
});

describe("reading the API's answers", () => {
  it("takes a link only whole, with an https address or none", () => {
    expect(decodeLink({ ...ARTIFACT, url: null })?.url).toBeNull();
    expect(decodeLink({ ...ARTIFACT, kind: "pdf" })).toBeNull();
    expect(decodeLink({ ...ARTIFACT, url: "javascript:alert(1)" })).toBeNull();
    expect(decodeLink({ ...ARTIFACT, bytes: "12" })).toBeNull();
    expect(decodeList({ publishing: "maybe", artifacts: [] })).toBeNull();
    expect(decodeList({ publishing: "on", artifacts: [ARTIFACT, { id: "x" }] })).toBeNull();
  });
});
