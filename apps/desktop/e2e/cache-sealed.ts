// The cases for the offline cache sealed at rest (December item 60; docs/runtime-adapter.md, "The offline cache"), run by
// cache-sealed.spec.ts (Chromium, as CI runs the suite) and cache-sealed-webkit.spec.ts (WebKit, the macOS webview's engine, on a
// Mac that has it). The desktop shell is stood in the page, its disk and its keychain item kept in the page's sessionStorage so they
// outlive a reload as a file and a keychain item outlive a restart. The first good read of the shop is written sealed with a key
// the stand-in keychain makes when the page asks for one; the file says its version, holds none of the shop's words, and opens in
// the browser's own Web Crypto with that key, bound to its origin and tenant; after a restart with no network it stands in for
// the shop. Version 5's plain file is deleted unread, and signing out deletes the file and the key. seal.test.ts, cache.test.ts
// and offline.test.ts hold the rules in Node; these hold a browser engine to them. Both run on the app's own runtime, so the page
// asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts). The clock is fixed at 24 November 2026, 10:00 in Bangkok.
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { openHood } from "./start";

const PORT = Number(process.env.MANUT_PORT || 5307);
const ORIGIN = "https://dev.manut.xyz";
const TENANT = "apple:owner-1";
/** The file's name for this sign-in, as the page makes it (cache.ts `cacheKey`): it says neither the origin nor the tenant. */
const FILE = createHash("sha256").update(JSON.stringify([ORIGIN, TENANT])).digest("hex");
/** 24 November 2026, 10:00 in Bangkok. */
const NOW = new Date("2026-11-24T03:00:00Z");
/** The shop's words the read keeps: a task's title, a member's draft, a customer's LINE id and the reply waiting for them. */
const WORDS = ["Reply to Khun Mali", "New candles are in!", "U4af4980629c9a9d1e3f0b5d2c7e1a6b8", "ส่งพรุ่งนี้เช้าค่ะ"];

/** What the stand-in shell holds: its one file by name, its keychain's key (null when none), and the cache's calls to it. */
type Held = { disk: Record<string, string>; key: string | null; log: string[] };

/** The desktop shell, stood in the page for a person who owns one shop, Baan Mali, with one task in it: a draft Nam wrote and a
 *  LINE reply waiting for the owner. `disk` is what an earlier run left; `offline` starts the run with no way to the API. */
async function stubShell(page: Page, seed: { disk?: Record<string, string>; offline?: boolean } = {}) {
  await page.addInitScript(
    ({ seed, words }) => {
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
      const store = sessionStorage;
      if (store.getItem("stub.seeded") === null) {
        store.setItem("stub.seeded", "1");
        store.setItem("stub.disk", JSON.stringify(seed.disk ?? {}));
        store.setItem("stub.log", "[]");
        if (seed.offline) store.setItem("stub.offline", "1");
      }
      const disk = () => JSON.parse(store.getItem("stub.disk") ?? "{}") as Record<string, string>;
      const log = (entry: string) => store.setItem("stub.log", JSON.stringify([...(JSON.parse(store.getItem("stub.log") ?? "[]") as string[]), entry]));
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const shop = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
      const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
      const [title, draft, lineId, words4] = words;
      const listed = {
        task: { id: "task-1", title, objective: "Answer her question about delivery", state: "waitingForAuthorization", location: "cloud", funding: "managedAI", criteria: [], updatedAt: iso(now - 60_000), tenantId: shop.id, schema: 1, rev: 3 },
        events: [{ seq: 1, kind: "created", at: iso(now - 600_000), rev: 1, via: "put" }],
        actions: [{ id: "action-1", tenant: shop.id, connectionId: "conn-1", providerAccountId: "channel-1", operationType: "line.message.push", targetResourceId: "bot-user-1", resourceScope: ["bot-user-1"], payload: { text: words4 }, payloadHash: "hash", recipients: [lineId], grantRevision: 0, proposedAt: iso(now - 90_000), expiresAt: iso(now + 86_400_000), state: "proposed" }],
        attempts: [],
        attemptsTruncated: false,
        drafts: [{ attemptId: "attempt-1", member: "nam", job: "reply", text: draft, at: iso(now - 60_000) }],
      };
      let n = 0;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++n,
        invoke: async (cmd: string, args: { url?: string; method?: string; key?: string; text?: string; make?: boolean }) => {
          if (cmd === "api_session_read") {
            return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
          }
          if (cmd.startsWith("shop_cache")) log(cmd === "shop_cache_seal_key" ? `${cmd} ${args.make}` : cmd);
          switch (cmd) {
            // the keychain's item: made only when the page asks to make it, as shop_cache_key.rs does
            case "shop_cache_seal_key": {
              const held = store.getItem("stub.keychain");
              if (held !== null || !args.make) return held;
              const made = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
              store.setItem("stub.keychain", made);
              return made;
            }
            case "shop_cache_seal_key_clear":
              store.removeItem("stub.keychain");
              return null;
            // the one file of the one sign-in, as shop_cache.rs keeps it
            case "shop_cache_write":
              store.setItem("stub.disk", JSON.stringify({ [String(args.key)]: String(args.text) }));
              return null;
            case "shop_cache_read":
              return disk()[String(args.key)] ?? null;
            case "shop_cache_clear":
              store.setItem("stub.disk", "{}");
              return null;
          }
          if (cmd !== "api_request") return null;
          // with no network the shell says so, as curl reaching no host does
          if (store.getItem("stub.offline") === "1") throw "offline";
          const url = new URL(String(args.url));
          switch (`${args.method} ${url.pathname}`) {
            case "GET /v1/shops":
              return reply(200, { shops: [{ ...shop, role: "owner" }] });
            case "POST /v1/shops/session":
              return reply(200, { shop, role: "owner", account: { id: "owner-account-1" }, session: { accessToken: "mos1.shop-a", expiresAt: iso(now + 30 * 86_400_000) } });
            case "GET /v1/approvals":
              return reply(200, { state: url.searchParams.get("state") ?? "open", approvals: [] });
            case "GET /v1/tasks":
              return reply(200, { tasks: [listed], next: null });
            case "GET /v1/schedules":
              return reply(200, { schedules: [] });
            case "GET /v1/inbound/attention":
              return reply(200, { items: [] });
            case "GET /v1/routines":
              return reply(200, { tenant: shop.id, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
            default:
              return reply(404, { error: "not_found" });
          }
        },
      };
    },
    { seed, words: WORDS },
  );
}

const held = (page: Page): Promise<Held> =>
  page.evaluate(() => ({
    disk: JSON.parse(sessionStorage.getItem("stub.disk") ?? "{}") as Record<string, string>,
    key: sessionStorage.getItem("stub.keychain"),
    log: JSON.parse(sessionStorage.getItem("stub.log") ?? "[]") as string[],
  }));

/** Opens `text` in the page's own Web Crypto with `key`, as the file's format and seal are written down (docs/runtime-adapter.md,
 *  "Sealed"), not with the app's code: null when it does not open. */
const openIn = (page: Page, text: string, key: string, tenant = TENANT) =>
  page.evaluate(
    async ({ text, key, origin, tenant }) => {
      const m = /^\{"v":6,"iv":"([A-Za-z0-9_-]{16})","sealed":"([A-Za-z0-9_-]+)"\}$/.exec(text);
      if (!m) return null;
      const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
      const raw = Uint8Array.from((key.match(/../g) ?? []).map((h) => parseInt(h, 16)));
      const k = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
      const bound = new TextEncoder().encode(JSON.stringify(["manut.shop-cache", 6, origin, tenant]));
      try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(m[1]), additionalData: bound }, k, bytes(m[2])));
      } catch {
        return null;
      }
    },
    { text, key, origin: ORIGIN, tenant },
  );

/** Until the page has kept a read of the shop. */
async function keptOne(page: Page): Promise<Held> {
  await expect.poll(async () => Object.keys((await held(page)).disk)).toEqual([FILE]);
  return held(page);
}

export function sealedCacheCases(): void {
  test.use({
    timezoneId: "Asia/Bangkok",
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${PORT}`,
          localStorage: [
            { name: "manut.onboarded", value: "1" },
            { name: "manut.lang", value: "en" },
            // quiet hours would hold notifications back by the hour the suite runs at
            { name: "manut.notify.quiet", value: "00:00-00:00" },
          ],
        },
      ],
    },
  });

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await page.addInitScript(() => {
      (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
    });
  });

  test("keeps the first good read sealed, with a key made for it, and shows it after a restart with no network", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await expect(page.getByTestId("mode-line")).toHaveText("Connected to dev.manut.xyz");
    const { disk, key, log } = await keptOne(page);
    const text = disk[FILE];
    // one line that says its version before anything is opened, and none of the shop's words, nor who the shop is
    expect(text).toMatch(/^\{"v":6,"iv":"[A-Za-z0-9_-]{16}","sealed":"[A-Za-z0-9_-]+"\}$/);
    for (const word of [...WORDS, ORIGIN, TENANT, "Baan Mali", "access-1", "mos1.shop-a"]) expect(text, word).not.toContain(word);
    // the key was made for the first read kept, asked for once, and the file opens with it as this sign-in's, and as no other's
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(log.filter((l) => l.startsWith("shop_cache_seal_key"))).toEqual(["shop_cache_seal_key true"]);
    const opened = await openIn(page, text, key!);
    for (const word of WORDS) expect(opened, word).toContain(word);
    expect(await openIn(page, text, key!, "apple:owner-2")).toBeNull();

    // a restart with no way to the API: the kept read opens and stands in for the shop, and says when it was read
    await page.evaluate(() => sessionStorage.setItem("stub.offline", "1"));
    await page.reload();
    await expect(page.getByTestId("mode-line")).toHaveText("Offline. Showing what was here at 10:00");
    await page.getByTestId("menu-history").click();
    await expect(page.getByTestId("history-row").first()).toContainText("Reply to Khun Mali");
    expect((await held(page)).disk[FILE]).toBe(text);
  });

  test("deletes the file version 5 kept in plain text without reading it, and has nothing to show", async ({ page }) => {
    const five = JSON.stringify({
      v: 5,
      snapshot: { tasks: [{ id: "task-1", title: WORDS[0], draft: { text: WORDS[1] } }], approvals: [], schedules: [], attention: [], attentionOff: true, readAt: NOW.getTime() - 60_000 },
    });
    await stubShell(page, { disk: { [FILE]: five }, offline: true });
    await page.goto("/");
    await expect(page.getByTestId("mode-line")).toHaveText("Offline · dev.manut.xyz");
    await expect.poll(async () => (await held(page)).disk).toEqual({});
    const { key, log } = await held(page);
    // there was no key, so nothing on disk could be opened: it went unread, and no key was made for a look
    expect(key).toBeNull();
    expect(log).toEqual(["shop_cache_seal_key false", "shop_cache_clear"]);
  });

  test("signing out deletes the file and the key it was sealed with", async ({ page }) => {
    await stubShell(page);
    await page.goto("/");
    await keptOne(page);
    await page.getByTestId("nav-settings").click();
    await openHood(page);
    await page.getByTestId("settings-nav-developer").click();
    await page.getByTestId("dev-sign-out").click();
    await expect.poll(async () => {
      const { disk, key } = await held(page);
      return [Object.keys(disk), key];
    }).toEqual([[], null]);
    const { log } = await held(page);
    expect(log).toContain("shop_cache_clear");
    expect(log.at(-1)).toBe("shop_cache_seal_key_clear");
  });
}
