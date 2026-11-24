// Customize › Connections' Google Sheets row (src/pages/GooglePane.tsx, google.ts; docs/connectors.md, 4b): in Practice, where the row
// shows a sample sheet with two months already sent and sends nothing, and over a stubbed desktop shell against an API that has
// Google off (which is what every real environment answers until the owner's Google client exists) and one that lets the owner
// connect, where Google's page opens in the system browser and the row reads again when the window comes back to the front. Both run
// on the app's own runtime, so the page asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the
// mock bridge, which has no Practice and no Connected. The clock is fixed at 24 November 2026, so the sample's months are October
// and September 2026 whatever day the suite runs.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.MANUT_SHOTS;

test.use({
  // the days in the sample's words are this computer's: Bangkok's, as the shop's own are
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

/** 24 November 2026, 10:00 in Bangkok. */
const NOW = new Date("2026-11-24T03:00:00Z");

test.beforeEach(async ({ page }) => {
  // The date is fixed and the timers run, so the sample's months do not move with the day the suite runs.
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    const w = window as unknown as { __MANUT_IN_PROCESS__: boolean; __opened: unknown[][] };
    w.__MANUT_IN_PROCESS__ = true;
    // Practice opens no window: a call to window.open is counted, and none is expected.
    w.__opened = [];
    window.open = (...args: unknown[]) => {
      w.__opened.push(args);
      return null;
    };
  });
});

/** Every request this page makes to an API path, which Practice must make none of, and to any other origin. */
function requests(page: Page) {
  const api: string[] = [];
  const outside: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (/\/v1\//.test(r.url())) api.push(`${r.method()} ${r.url()}`);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && !r.url().startsWith("data:")) outside.push(r.url());
  });
  return { api, outside };
}

/** Customize › Connections, as a person gets there: the side menu, then the tab. */
async function openConnections(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("menu-customize").click();
  await page.getByTestId("customize-tab-connections").click();
  await expect(page.getByTestId("google")).toBeVisible();
}

const row = (page: Page) => page.getByTestId("google-row");
const notice = (page: Page) => page.getByTestId("google-notice");
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe("in Practice", () => {
  test("shows the sample sheet with the months already sent, and nothing leaves this computer", async ({ page }) => {
    const seen = requests(page);
    await openConnections(page);
    await expect(page.getByTestId("google")).toContainText("Ton can keep each month's books in a Google Sheet in your Google Drive. Ton asks you first, every time.");
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await expect(page.getByTestId("google-tag")).toHaveText("Connected");
    // the row is named for the sheet, with what was last sent under it
    await expect(page.getByTestId("google-name")).toHaveText("Manut AI books: Baan Mali");
    await expect(page.getByTestId("google-line")).toHaveText("Last sent: October 2026, on 22 November.");
    for (const id of ["google-send", "google-sheet", "google-disconnect"]) await expect(page.getByTestId(id), id).toBeVisible();
    await expect(page.getByTestId("google-connect")).toHaveCount(0);
    // the row sits above the vault, as the canvas puts the apps first
    const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="google"], [data-testid="vault"]')].map((e) => e.getAttribute("data-testid")));
    expect(order).toEqual(["google", "vault"]);
    expect(seen.api).toEqual([]);
    expect(seen.outside).toEqual([]);
  });

  test("asks which month, says Ton asks first, and keeps a draft of one that has ended, sending nothing", async ({ page }) => {
    const seen = requests(page);
    await openConnections(page);
    await page.getByTestId("google-send").click();
    const month = page.getByTestId("google-month");
    await expect(month).toBeFocused();
    await expect(month.locator("option")).toHaveCount(12);
    await expect(month.locator("option").nth(0)).toHaveText("October 2026, sent 22 November");
    await expect(month.locator("option").nth(1)).toHaveText("September 2026, sent 22 October, not confirmed");
    await expect(month.locator("option").nth(2)).toHaveText("August 2026");
    await expect(page.getByTestId("google-pick")).toContainText("Ton asks you first. Nothing goes to your sheet until you approve it in Needs you.");
    // November has not ended, so it is not offered
    await expect(month.locator("option", { hasText: "November 2026" })).toHaveCount(0);
    await month.selectOption({ label: "August 2026" });
    await page.getByTestId("google-ask").click();
    await expect(notice(page)).toHaveText("Ton kept a draft of August 2026 and sent nothing, because Google Sheets is still in its practice days.");
    // The picker is closed, the row says the same, and nothing was sent anywhere.
    await expect(page.getByTestId("google-pick")).toHaveCount(0);
    await expect(page.getByTestId("google-line")).toHaveText("Last sent: October 2026, on 22 November.");
    expect(seen.api).toEqual([]);
    expect(seen.outside).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual([]);
  });

  test("asks first about a month that was sent: that it went, when, how many rows, and what asking again does", async ({ page }) => {
    await openConnections(page);
    await page.getByTestId("google-send").click();
    await page.getByTestId("google-ask").click();
    const question = page.getByTestId("google-again-text");
    await expect(question).toHaveText("October 2026 was already sent on 22 November (41 rows). Sending it again adds the same rows a second time.");
    // the safe answer holds the focus, and the picker waits behind the question
    await expect(page.getByTestId("google-again-keep")).toBeFocused();
    await expect(page.getByTestId("google-pick")).toHaveCount(0);
    await page.getByTestId("google-again-keep").click();
    await expect(page.getByTestId("google-again")).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);

    // a send whose answer never came says the doubt, and Ask Ton anyway still only drafts in Practice
    await page.getByTestId("google-send").click();
    await page.getByTestId("google-month").selectOption({ label: "September 2026, sent 22 October, not confirmed" });
    await page.getByTestId("google-ask").click();
    await expect(page.getByTestId("google-again-text")).toContainText("September 2026 may already be in your sheet: it was sent on 22 October (38 rows), but Google did not say whether the rows arrived. Look in the sheet first.");
    await page.getByTestId("google-again-yes").click();
    await expect(notice(page)).toHaveText("Ton kept a draft of September 2026 and sent nothing, because Google Sheets is still in its practice days.");
  });

  test("closes the questions on Escape, and sends no month with a key that only finishes a character", async ({ page }) => {
    await openConnections(page);
    await page.getByTestId("google-send").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("google-pick")).toHaveCount(0);
    await page.getByTestId("google-disconnect").click();
    await expect(page.getByTestId("google-disconnect-keep")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("google-disconnect-ask")).toHaveCount(0);
    await expect(row(page)).toHaveAttribute("data-state", "working");
  });

  test("asks one question before Disconnect, keeps the sheet and what was sent, and connects again with no window to open", async ({ page }) => {
    const seen = requests(page);
    await openConnections(page);
    await page.getByTestId("google-disconnect").click();
    await expect(page.getByTestId("google-disconnect-question")).toHaveText("Disconnect Google Sheets? Ton stops adding the books. Your sheet and what is in it stay in your Google Drive.");
    await expect(page.getByTestId("google-disconnect-keep")).toBeFocused();
    // "Keep it connected" leaves everything as it was
    await page.getByTestId("google-disconnect-keep").click();
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await page.getByTestId("google-disconnect").click();
    await page.getByTestId("google-disconnect-yes").click();
    await expect(notice(page)).toHaveText("Google Sheets is disconnected.");
    await expect(row(page)).toHaveAttribute("data-state", "none");
    await expect(page.getByTestId("google-tag")).toHaveText("Not connected");
    await expect(page.getByTestId("google-send")).toHaveCount(0);

    // Connect: no Google page opens in Practice, and the connection is made at once, with its sheet and months where they were
    await page.getByTestId("google-connect").click();
    await expect(notice(page)).toHaveText("Practice: no Google page opens and nothing is sent. The sample sheet is connected.");
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await expect(page.getByTestId("google-waiting")).toHaveCount(0);
    await expect(page.getByTestId("google-line")).toHaveText("Last sent: October 2026, on 22 November.");
    expect(seen.api).toEqual([]);
    expect(seen.outside).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened)).toEqual([]);
  });

  for (const [start, state, tag, line] of [
    ["off", "off", "Not available yet", "Google Sheets isn't set up for Manut AI yet."],
    ["none", "none", "Not connected", "Not connected. Connect it and Ton can add each month's books to a sheet in your Google Drive, after you approve."],
    ["broken", "broken", "Needs connecting again", "Google no longer lets Manut AI into your sheet: the access was removed or ran out."],
  ] as const) {
    test(`starts ${start}: ${tag}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("manut.practice.google", value), start);
      await openConnections(page);
      await expect(row(page)).toHaveAttribute("data-state", state);
      await expect(page.getByTestId("google-tag")).toHaveText(tag);
      await expect(page.getByTestId("google-line").first()).toHaveText(line);
      const buttons = await page.getByTestId("google").locator("button").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      expect(buttons).toEqual(start === "off" ? [] : start === "none" ? ["google-connect"] : ["google-connect", "google-disconnect"]);
      if (start === "broken") await expect(page.getByTestId("google-connect")).toHaveText("Connect again");
    });
  }

  test("a broken connection is mended by connecting again", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("manut.practice.google", "broken"));
    await openConnections(page);
    await page.getByTestId("google-connect").click();
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await expect(page.getByTestId("google-send")).toBeVisible();
  });

  for (const [lang, title, tag, ask] of [
    ["ko", "Google 스프레드시트", "연결됨", "Ton에게 요청"],
    ["ja", "Google スプレッドシート", "接続済み", "Ton に頼む"],
    ["zh", "Google 表格", "已连接", "请 Ton 处理"],
  ] as const) {
    test(`speaks ${lang}`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem("manut.lang", l), lang);
      await openConnections(page);
      await expect(page.getByTestId("google").locator("h2")).toHaveText(title);
      await expect(page.getByTestId("google-tag")).toHaveText(tag);
      await page.getByTestId("google-send").click();
      await expect(page.getByTestId("google-ask")).toHaveText(ask);
      await expect(page.getByTestId("google-month").locator("option").nth(0)).toContainText(lang === "ko" ? "2026년 10월" : "2026年10月");
    });
  }

  // Every state in light, in dark and in the narrowest window the app has (900 pixels): all of it shows, and nothing pushes the page
  // wider than the window.
  for (const [name, scheme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["narrow", "light", 900]] as const) {
    test(`draws every state in ${name}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      const shot = async (label: string) => {
        if (!SHOTS) return;
        mkdirSync(SHOTS, { recursive: true });
        await page.getByTestId("google").screenshot({ path: join(SHOTS, `google-${info.title.replace(/\W+/g, "-")}-${label}.png`) });
      };
      await openConnections(page);
      for (const id of ["google-tag", "google-send", "google-sheet", "google-disconnect"]) await expect(page.getByTestId(id), id).toBeVisible();
      expect(await fits(page), "connected").toBe(true);
      await shot("connected");
      // the whole tab, to judge the row above the Vault box in its place
      if (SHOTS) await page.getByTestId("connections").screenshot({ path: join(SHOTS, `google-tab-${name}.png`) });
      await page.getByTestId("google-send").click();
      await expect(page.getByTestId("google-pick")).toBeVisible();
      expect(await fits(page), "month picker").toBe(true);
      await shot("picker");
      await page.getByTestId("google-ask").click();
      await expect(page.getByTestId("google-again-text")).toBeVisible();
      expect(await fits(page), "month sent before").toBe(true);
      await shot("again");
      await page.getByTestId("google-again-yes").click();
      await expect(notice(page)).toBeVisible();
      expect(await fits(page), "ton kept a draft").toBe(true);
      await shot("drafted");
      await page.getByTestId("google-disconnect").click();
      await expect(page.getByTestId("google-disconnect-yes")).toBeVisible();
      expect(await fits(page), "disconnect question").toBe(true);
      await shot("disconnect");
      await page.getByTestId("google-disconnect-yes").click();
      await expect(page.getByTestId("google-connect")).toBeVisible();
      expect(await fits(page), "not connected").toBe(true);
      await shot("none");
      // what went wrong is not in the quiet colour of the lines beside it, and the tag of a broken one is the warning's
      await page.addInitScript(() => localStorage.setItem("manut.practice.google", "broken"));
      await page.reload();
      await page.getByTestId("menu-customize").click();
      await page.getByTestId("customize-tab-connections").click();
      await expect(page.getByTestId("google-tag")).toHaveText("Needs connecting again");
      const [tagColour, lineColour] = await Promise.all([
        page.getByTestId("google-tag").evaluate((el) => getComputedStyle(el).color),
        page.getByTestId("google-line").first().evaluate((el) => getComputedStyle(el).color),
      ]);
      expect(tagColour).not.toBe(lineColour);
      expect(await fits(page), "broken").toBe(true);
      await shot("broken");
    });
  }
});

// ---- over a stubbed desktop shell -----------------------------------------------------------------------------------------

type Stage = { __calls: { cmd: string; method?: string; path?: string; bearer?: string | null; body?: unknown }[]; __opened: string[]; __consent: () => void };

/** The desktop shell is stood in the page, as the connected runtime reaches the API only through its commands: a person who owns one
 *  shop, Baan Mali, and an API that answers `google` for it. `off` is what every environment says until the owner's Google client
 *  exists; `open` lets the owner connect, and the owner's coming back from Google's page is `__consent()`. */
async function stubShell(page: Page, google: "off" | "open", books = false) {
  await page.addInitScript(({ mode, books }) => {
    localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
    const w = window as unknown as Stage;
    w.__calls = [];
    w.__opened = [];
    const consent = { given: false };
    w.__consent = () => void (consent.given = true);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const shop = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
    const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
    const cache = new Map<string, string>();
    // Ton's request to add October's books to the owner's sheet, as the API lists it for the owner (docs/pilot-api.md): approval-core's
    // own wire record, of the kind `command`, with the month sent two days ago said first
    const append = {
      taskId: "task-books",
      record: {
        status: "pending",
        request: {
          id: "append-1",
          kind: "command",
          options: [{ id: "approve", label: "Approve", effect: "approve" }, { id: "decline", label: "Decline", effect: "decline" }],
          revision: 1,
          createdAt: now - 600_000,
          expiresAt: now + 86_400_000,
          detail: {
            actionId: "append-1",
            operationType: "google.sheets.append",
            sheet: { id: "sheet1", title: "Manut AI books: Baan Mali", tab: "Books" },
            month: "2026-10",
            rows: 41,
            totals: { sales: "฿12,300", salesCount: 30, refunds: "฿350", refundsCount: 1, expenses: "฿0", expensesCount: 0, net: "฿11,950" },
            flags: 1,
            earlier: { count: 1, at: iso(now - 2 * 86_400_000), rows: 41, outcome: "confirmed" },
            lines: [{ date: "2026-10-10", ref: "SP-2291", kind: "sale", channelOrCategory: "line", amountSatang: 129033, beforeVatSatang: null, vatSatang: null }],
            text: "Append the books for 2026-10 to the Google Sheet.",
            payloadHash: "hash",
          },
        },
      },
      standing: { state: "open", reason: "waiting" },
    };
    let n = 0;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++n,
      invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null; key?: string; text?: string }) => {
        if (cmd === "api_session_read") {
          return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
        }
        if (cmd === "open_external") {
          w.__opened.push(String(args.url));
          return null;
        }
        if (cmd === "shop_cache_write") return void cache.set(String(args.key), String(args.text));
        if (cmd === "shop_cache_read") return cache.get(String(args.key)) ?? null;
        if (cmd !== "api_request") return null;
        const url = new URL(String(args.url));
        const body = args.body ? JSON.parse(args.body) : null;
        w.__calls.push({ cmd, method: args.method, path: url.pathname, bearer: args.bearer ?? null, body });
        const key = `${args.method} ${url.pathname}`;
        switch (key) {
          case "GET /v1/shops":
            return reply(200, { shops: [{ ...shop, role: "owner" }] });
          case "POST /v1/shops/session":
            return reply(200, { shop, role: "owner", account: { id: "owner-account-1" }, session: { accessToken: "mos1.shop-a", expiresAt: iso(now + 30 * 86_400_000) } });
          case "GET /v1/approvals":
            return reply(200, { state: "open", approvals: books ? [append] : [] });
          case "GET /v1/tenant/export":
            return reply(200, { tenant: shop.id, exportedAt: iso(now), tasks: [], schedules: [], attention: [] });
          case "GET /v1/routines":
            return reply(200, { tenant: shop.id, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
          case "GET /v1/vault/sign-ins":
            return reply(200, { tenant: shop.id, signIns: [] });
          case "GET /v1/vault/outposts":
            return reply(200, { tenant: shop.id, outposts: [] });
          case "GET /v1/google":
            if (mode === "off") return reply(503, { error: "google_not_configured" });
            return reply(200, consent.given
              ? { connected: true, connection: { id: "conn-1", connectedAt: iso(now), state: "working", sheet: null } }
              : { connected: false, connection: null });
          case "POST /v1/google/connect":
            if (mode === "off") return reply(503, { error: "google_not_configured" });
            return reply(200, { url: "https://accounts.google.test/o/oauth2/v2/auth?client_id=c&state=mgs1.SECRET-STATE&code_challenge=SECRET-CHALLENGE", expiresAt: iso(now + 600_000) });
          case "POST /v1/google/books":
            return reply(200, { taskId: "task-1", member: "ton", outcome: "asked", requestId: "request-1", kind: "command" });
          default:
            return reply(404, { error: "not_found" });
        }
      },
    };
  }, { mode: google, books });
}

test.describe("connected to an API", () => {
  test("that has Google off says plainly that it isn't set up for Manut AI yet, offers nothing, and sends nothing but the read", async ({ page }) => {
    await stubShell(page, "off");
    await openConnections(page);
    await expect(row(page)).toHaveAttribute("data-state", "off");
    await expect(page.getByTestId("google-tag")).toHaveText("Not available yet");
    await expect(page.getByTestId("google-line")).toHaveText("Google Sheets isn't set up for Manut AI yet.");
    await expect(page.getByTestId("google").locator("button")).toHaveCount(0);
    // the row was read with the shop's own owner session, and nothing else of Google's was asked
    const google = (await page.evaluate(() => (window as unknown as Stage).__calls)).filter((c) => c.path?.startsWith("/v1/google"));
    expect(google.map((c) => [c.method, c.path, c.bearer])).toEqual([["GET", "/v1/google", "mos1.shop-a"]]);
    expect(await page.evaluate(() => (window as unknown as Stage).__opened)).toEqual([]);
  });

  test("opens Google's page in the system browser once, waits, says when it is not connected yet, and reads again when the window is back", async ({ page }) => {
    await stubShell(page, "open");
    await openConnections(page);
    await expect(row(page)).toHaveAttribute("data-state", "none");
    await page.getByTestId("google-connect").click();

    // Google's page opened once in the browser, by the shell's own command, with the address the API gave
    await expect(page.getByTestId("google-waiting")).toBeVisible();
    const opened = await page.evaluate(() => (window as unknown as Stage).__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/accounts\.google\.test\/o\/oauth2\/v2\/auth\?/);
    const posts = (await page.evaluate(() => (window as unknown as Stage).__calls)).filter((c) => c.path === "/v1/google/connect");
    expect(posts.map((c) => [c.method, c.bearer, c.body])).toEqual([["POST", "mos1.shop-a", {}]]);
    // the address is a credential: it is on no page, in no attribute and in no saved state
    const html = await page.content();
    for (const secret of ["SECRET-STATE", "SECRET-CHALLENGE", "accounts.google.test"]) expect(html).not.toContain(secret);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("SECRET");
    await expect(page.getByTestId("google-connect")).toBeDisabled();

    // The owner comes back before they allowed it: it says so, and goes on waiting
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(notice(page)).toHaveText("Google Sheets is not connected yet. If you allowed it on Google's page, wait a moment and check again.");
    await expect(page.getByTestId("google-waiting")).toBeVisible();

    // They allow it on Google's page and come back: the row reads again and is connected, with no sheet until Ton first asks
    await page.evaluate(() => {
      (window as unknown as Stage).__consent();
      window.dispatchEvent(new Event("focus"));
    });
    await expect(notice(page)).toHaveText("Google Sheets is connected.");
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await expect(page.getByTestId("google-waiting")).toHaveCount(0);
    await expect(page.getByTestId("google-line")).toHaveText("Connected. Ton makes the sheet in your Google Drive the first time you send a month.");
    // Check now does the same by hand, and Not now gives the wait up without connecting anything
    expect(await page.evaluate(() => (window as unknown as Stage).__opened)).toHaveLength(1);
  });

  test("Check now reads the status by hand, and Not now gives the wait up", async ({ page }) => {
    await stubShell(page, "open");
    await openConnections(page);
    await page.getByTestId("google-connect").click();
    await expect(page.getByTestId("google-waiting")).toBeVisible();
    await page.getByTestId("google-check").click();
    await expect(notice(page)).toContainText("not connected yet");
    await page.getByTestId("google-not-now").click();
    await expect(page.getByTestId("google-waiting")).toHaveCount(0);
    await expect(page.getByTestId("google-connect")).toBeEnabled();
    // Connect again asks the API for a new address, since the first was used
    await page.getByTestId("google-connect").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Stage).__opened.length)).toBe(2);
  });

  test("asks Ton for a month with that shop's session, says Ton asked, and offers Needs you", async ({ page }) => {
    await stubShell(page, "open");
    await page.addInitScript(() => {
      // already connected, with its sheet, when the page starts
      (window as unknown as Stage).__consent();
    });
    await openConnections(page);
    await expect(row(page)).toHaveAttribute("data-state", "working");
    await page.getByTestId("google-send").click();
    await page.getByTestId("google-ask").click();
    await expect(notice(page)).toContainText("Ton asked you. Open Needs you to read it and approve it. Nothing goes to your sheet until you do.");
    const sent = (await page.evaluate(() => (window as unknown as Stage).__calls)).filter((c) => c.path === "/v1/google/books");
    expect(sent.map((c) => [c.method, c.bearer, c.body])).toEqual([["POST", "mos1.shop-a", { month: "2026-10" }]]);
    await page.getByTestId("google-open-needs").click();
    await expect(page.getByTestId("needs-empty")).toBeVisible();
  });

  /** What the owner reads of Ton's request for October, line for line, with the month sent two days ago said first. */
  const WHOLE = [
    "Already sent: this month went to the sheet on 22 November (41 rows) and Google confirmed it. Approving adds its rows a second time.",
    "",
    "Add the books for October 2026 to the Google Sheet “Manut AI books: Baan Mali”, tab “Books”.",
    "41 rows, after the header row.",
    "Sales ฿12,300 (30)",
    "Refunds ฿350 (1)",
    "Expenses ฿0 (0)",
    "Net sales ฿11,950",
    "Ton flagged 1 entry for you to check.",
  ].join("\n");

  test("shows Ton's request whole in Needs you and on its card, the month sent before first, and offers Approve only there", async ({ page }) => {
    await stubShell(page, "open", true);
    await page.goto("/");
    await page.getByTestId("menu-needs").click();
    const needs = page.getByTestId("needs-row");
    await expect(needs).toHaveCount(1);
    await expect(needs).toContainText("Ton asks to add the books for October 2026 to Google Sheets");
    await expect(needs.locator("code.act.whole")).toHaveText(WHOLE, { useInnerText: true });
    // nothing is approved from this list: Look first opens the card, which shows the same text in a block that is never cut
    await expect(page.getByTestId("needs-approve")).toHaveCount(0);
    await page.getByTestId("needs-look").click();
    const card = page.getByTestId("card-approval");
    await expect(card).toBeVisible();
    await expect(card.locator("pre.card-cmd.whole")).toHaveText(WHOLE, { useInnerText: true });
    await expect(card.locator("button[data-choice]")).toHaveText(["Deny", "Allow once"]);
    await expect(card.getByTestId("card-outdated")).toHaveCount(0);
    // the block grows with its words: nothing is scrolled out of sight
    const clipped = await card.locator("pre.card-cmd.whole").evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(clipped).toBe(false);
  });

  test("Home offers Approve beside the whole text, and a notification-sized summary is no part of it", async ({ page }) => {
    await stubShell(page, "open", true);
    await page.goto("/");
    await page.getByTestId("menu-home").click();
    const need = page.getByTestId("home-need");
    await expect(need).toHaveCount(1);
    await expect(need.locator("code.act.whole")).toHaveText(WHOLE, { useInnerText: true });
    await expect(page.getByTestId("home-approve")).toBeVisible();
  });

  for (const [name, scheme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["narrow", "light", 900]] as const) {
    test(`draws Ton's request in ${name}: the whole text on Needs you and on its card, with nothing wider than the window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await stubShell(page, "open", true);
      await page.goto("/");
      await page.getByTestId("menu-needs").click();
      await expect(page.getByTestId("needs-row").locator("code.act.whole")).toHaveText(WHOLE, { useInnerText: true });
      expect(await fits(page), "needs you").toBe(true);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `books-needs-${name}.png`) });
      }
      await page.getByTestId("needs-look").click();
      await expect(page.getByTestId("card-approval")).toBeVisible();
      expect(await fits(page), "card").toBe(true);
      if (SHOTS) await page.getByTestId("card-approval").screenshot({ path: join(SHOTS, `books-card-${name}.png`) });
    });
  }
});
