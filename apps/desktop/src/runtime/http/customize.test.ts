// What the connected runtime says to the Customize page's ops. What the team knows is "not yet": the API serves a shop's
// memory to operators only (admin routes), and no session can read or change it. Nothing but reads ever reaches the API,
// and none of these ops reaches it at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../../i18n";
import type { BridgeError } from "../../lib/protocol";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, memoryVault, ORIGIN, serveShop, storedSession, T0 } from "./testkit";

const NOW = T0 + 600_000;

async function connected() {
  const api = fakeApi();
  serveShop(api);
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)), deviceId: () => "device-2" });
  const rt = new HttpRuntime(new HttpHost({ session }));
  await rt.connect();
  const req = rt.request.bind(rt) as unknown as (op: string, params: unknown) => Promise<unknown>;
  return { api, rt, req };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setLang("en");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("what the team knows on the connected runtime", () => {
  it("cannot be shown yet, and says so in words that fit a read", async () => {
    const { req } = await connected();
    expect(await refusal(req("memory.list", {}))).toEqual({ code: "not_yet", message: t("rt.notYetShow") });
    // a read's refusal is not the write's: it must not say that Connected only reads
    expect(t("rt.notYetShow")).not.toMatch(/only reads/);
  });

  it("cannot be changed yet, and says so as every other write does", async () => {
    const { req } = await connected();
    for (const [op, params] of [
      ["memory.remember", { text: "We ship on weekdays" }],
      ["memory.confirm", { fact: "f5" }],
      ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { fact: "f1" }],
    ] as const)
      expect(await refusal(req(op, params)), op).toEqual({ code: "not_yet", message: t("rt.notYet") });
  });

  it("sends nothing to the API for any of them, so nothing the owner typed leaves the computer", async () => {
    const { api, req } = await connected();
    const sent = api.calls.length;
    for (const [op, params] of [
      ["memory.list", {}],
      ["memory.remember", { text: "We ship on weekdays" }],
      ["memory.confirm", { fact: "f5" }],
      ["memory.correct", { fact: "f1", text: "Free shipping on orders over ฿900" }],
      ["memory.forget", { fact: "f1" }],
    ] as const)
      await refusal(req(op, params));
    expect(api.calls).toHaveLength(sent);
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says the same in every language it is shown in", () => {
    for (const l of LANGS) for (const k of ["rt.notYet", "rt.notYetShow"] as const) expect(t(k, undefined, l).trim(), `${l} ${k}`).not.toBe("");
  });
});
