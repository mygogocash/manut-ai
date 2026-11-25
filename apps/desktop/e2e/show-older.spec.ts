// Show older on History and the activity log (src/pages/older.ts, ShowOlder.tsx; docs/runtime-adapter.md, "Older tasks"), over a stubbed
// desktop shell against an API that lists a shop's tasks as apps/api does: newest first, 25 to a page, each page giving the cursor of the
// page after it. The shop's newest 50 tasks are read each minute; the lists say there is older work, and Show older reads the next page with
// the shop's own session, press after press, to the end. Both run on the app's own runtime, so the page asks for it
// (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the mock bridge, which has no Connected. The clock is fixed
// at 24 November 2026, so every task is within the activity log's last seven days whatever day the suite runs.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DICT } from "../src/i18n";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.MANUT_SHOTS;

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

/** 24 November 2026, 10:00 in Bangkok. */
const NOW = new Date("2026-11-24T03:00:00Z");

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

type Call = { cmd: string; method?: string; path?: string; query?: string; bearer?: string | null };
type Stage = { __calls: Call[] };

/** The desktop shell is stood in the page, as the connected runtime reaches the API only through its commands: a person who owns one shop,
 *  Baan Mali, with `total` tasks (`task-1` the oldest), each with a draft a member wrote on it, so each is one job and one event of the
 *  log. `failing` is how many times the API answers the first page after the newest 50 with a 503 before it answers it. */
async function stubShell(page: Page, total: number, failing = 0) {
  await page.addInitScript(
    ({ total, failing }) => {
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
      const w = window as unknown as Stage;
      w.__calls = [];
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const shop = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
      const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
      const cache = new Map<string, string>();
      // the shop's index, newest first: task-N is the newest and task-1 the oldest, each a minute older than the one before
      const ids = Array.from({ length: total }, (_, i) => `task-${total - i}`);
      const listed = (id: string) => {
        const n = Number(id.slice(5));
        const at = now - (total - n + 1) * 60_000;
        return {
          task: { id, title: `Task ${n}`, objective: `Do task ${n}`, state: "completed", location: "cloud", funding: "managedAI", criteria: [], updatedAt: iso(at), tenantId: shop.id, schema: 1, rev: 3 },
          events: [{ seq: 1, kind: "created", at: iso(at - 1_000), rev: 1, via: "put" }],
          actions: [],
          attempts: [],
          attemptsTruncated: false,
          drafts: [{ attemptId: `attempt-${n}`, member: "nam", job: "reply", text: `Draft ${n}`, at: iso(at) }],
        };
      };
      let failed = 0;
      /** `GET /v1/tasks`, as apps/api answers it (task-list.ts): at most 25, from just after the cursor, and the cursor of the next page */
      const taskPage = (url: URL) => {
        const cursor = url.searchParams.get("cursor");
        const start = cursor === null ? 0 : ids.indexOf(cursor) + 1;
        if (cursor !== null && start === 0) return reply(400, { error: "invalid_cursor" });
        // the first page after the newest 50 fails as many times as the test says
        if (cursor === `task-${total - 49}` && failed < failing) {
          failed += 1;
          return reply(503, { error: "tasks_unavailable" });
        }
        const looked = ids.slice(start, start + 25);
        return reply(200, { tasks: looked.map(listed), next: start + looked.length < ids.length ? looked[looked.length - 1] : null });
      };
      let n = 0;
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++n,
        invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null; key?: string; text?: string }) => {
          if (cmd === "api_session_read") {
            return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
          }
          if (cmd === "shop_cache_write") return void cache.set(String(args.key), String(args.text));
          if (cmd === "shop_cache_read") return cache.get(String(args.key)) ?? null;
          if (cmd !== "api_request") return null;
          const url = new URL(String(args.url));
          w.__calls.push({ cmd, method: args.method, path: url.pathname, query: url.search, bearer: args.bearer ?? null });
          switch (`${args.method} ${url.pathname}`) {
            case "GET /v1/shops":
              return reply(200, { shops: [{ ...shop, role: "owner" }] });
            case "POST /v1/shops/session":
              return reply(200, { shop, role: "owner", account: { id: "owner-account-1" }, session: { accessToken: "mos1.shop-a", expiresAt: iso(now + 30 * 86_400_000) } });
            case "GET /v1/approvals":
              return reply(200, { state: "open", approvals: [] });
            case "GET /v1/tasks":
              return taskPage(url);
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
    { total, failing },
  );
}

/** History, as a person gets there: the side menu. */
async function openHistory(page: Page) {
  await page.goto("/");
  await page.getByTestId("menu-history").click();
  await expect(page.getByTestId("page-history")).toBeVisible();
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as Stage).__calls);
/** The requests for a page of the task list after a cursor, as the query they carried and the session they were sent with. */
const pagesAfter = async (page: Page) =>
  (await calls(page)).filter((c) => c.path === "/v1/tasks" && c.query?.includes("cursor=")).map((c) => [c.query, c.bearer]);
/** A picture of the page when `MANUT_SHOTS` names a folder, as the other Connected specs take them, to look at a state by eye. */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // the line is under the whole list, so it is brought into the picture
  await page.getByTestId("older").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS, `show-older-${name}.png`) });
}
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const rows = (page: Page) => page.getByTestId("history-row");
const line = (page: Page) => page.getByTestId("older-line");
const show = (page: Page) => page.getByTestId("older-show");

test.describe("connected to a shop with more tasks than the newest 50", () => {
  test("History says there is older work and reads the last of three pages with the shop's own session, then says everything is shown", async ({ page }) => {
    await stubShell(page, 75);
    await openHistory(page);
    // the newest 50, which the minute's read took as two pages; the third is older work
    await expect(rows(page)).toHaveCount(50);
    await expect(rows(page).first()).toContainText("Task 75");
    await expect(rows(page).last()).toContainText("Task 26");
    await expect(line(page)).toHaveText("Only the newest work is shown here. There is older work.");
    await expect(show(page)).toHaveText("Show older");
    expect(await pagesAfter(page)).toEqual([["?limit=25&cursor=task-51", "mos1.shop-a"]]);

    await show(page).click();
    // the page after the cursor the minute's read stopped at, task-26 .. task-1, joins the list below the newest
    await expect(rows(page)).toHaveCount(75);
    await expect(rows(page).last()).toContainText("Task 1");
    await expect(line(page)).toHaveText("That is everything. There is no older work.");
    await expect(show(page)).toHaveCount(0);
    expect(await pagesAfter(page)).toEqual([["?limit=25&cursor=task-51", "mos1.shop-a"], ["?limit=25&cursor=task-26", "mos1.shop-a"]]);
    expect(await fits(page)).toBe(true);
  });

  test("the activity log says the same, with the same pages, and keeps what the person had set", async ({ page }) => {
    await stubShell(page, 75);
    await openHistory(page);
    await page.getByTestId("history-activity").click();
    await expect(page.getByTestId("act-row")).toHaveCount(50);
    await expect(page.getByTestId("act-count")).toHaveText("50 events in the last 7 days");
    await expect(line(page)).toHaveText("Only the newest work is shown here. There is older work.");
    // a search typed before is still there after the page is read: Show older leaves what the page holds as it is
    await page.getByTestId("act-find").fill("Draft");
    await show(page).click();
    await expect(page.getByTestId("act-row")).toHaveCount(75);
    await expect(page.getByTestId("act-find")).toHaveValue("Draft");
    await expect(page.getByTestId("act-count")).toHaveText("75 events in the last 7 days");
    await expect(line(page)).toHaveText("That is everything. There is no older work.");
    await expect(show(page)).toHaveCount(0);
    expect(await pagesAfter(page)).toHaveLength(2);
    // back at History, the older work is there as well, and nothing is read for it again
    await page.getByTestId("act-tab-jobs").click();
    await expect(rows(page)).toHaveCount(75);
    expect(await pagesAfter(page)).toHaveLength(2);
  });

  test("walks to the end a page at a time: Show older stays while there is more, and says everything is shown after the last page", async ({ page }) => {
    await stubShell(page, 90);
    await openHistory(page);
    await expect(rows(page)).toHaveCount(50);
    await show(page).click();
    await expect(rows(page)).toHaveCount(75);
    await expect(line(page)).toHaveText("Only the newest work is shown here. There is older work.");
    await expect(show(page)).toBeVisible();
    await show(page).click();
    await expect(rows(page)).toHaveCount(90);
    await expect(line(page)).toHaveText("That is everything. There is no older work.");
    await expect(show(page)).toHaveCount(0);
    // the minute's second page (from the first's cursor, task-66), then each press from the cursor the page before gave: the newest 50
    // stopped at task-41, the first older page at task-16, and the last of the 90 tasks ended the list
    expect(await pagesAfter(page)).toEqual([
      ["?limit=25&cursor=task-66", "mos1.shop-a"],
      ["?limit=25&cursor=task-41", "mos1.shop-a"],
      ["?limit=25&cursor=task-16", "mos1.shop-a"],
    ]);
  });

  test("says a page could not be read, leaves what is shown, and reads it when the person tries again", async ({ page }) => {
    await stubShell(page, 75, 1);
    await openHistory(page);
    await expect(rows(page)).toHaveCount(50);
    await show(page).click();
    await expect(page.getByTestId("older")).toHaveAttribute("data-state", "failed");
    await expect(line(page)).toHaveText("Older work could not be read. What is shown here has not changed.");
    await expect(line(page)).toHaveAttribute("role", "alert");
    await expect(show(page)).toHaveText("Try again");
    await expect(rows(page)).toHaveCount(50);
    await show(page).click();
    await expect(rows(page)).toHaveCount(75);
    await expect(line(page)).toHaveText("That is everything. There is no older work.");
  });

  test("shows nothing of it for a shop of 50 tasks or fewer", async ({ page }) => {
    await stubShell(page, 50);
    await openHistory(page);
    await expect(rows(page)).toHaveCount(50);
    await expect(page.getByTestId("older")).toHaveCount(0);
    expect(await pagesAfter(page)).toEqual([["?limit=25&cursor=task-26", "mos1.shop-a"]]);
    await page.getByTestId("history-activity").click();
    await expect(page.getByTestId("act-row")).toHaveCount(50);
    await expect(page.getByTestId("older")).toHaveCount(0);
  });

  for (const [name, scheme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["narrow", "light", 900]] as const) {
    test(`draws every state in ${name}, History and the log, with nothing wider than the window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await stubShell(page, 75, 1);
      await openHistory(page);
      await expect(line(page)).toBeVisible();
      expect(await fits(page), "there is more").toBe(true);
      await shot(page, `history-more-${name}`);
      // the page could not be read
      await show(page).click();
      await expect(page.getByTestId("older")).toHaveAttribute("data-state", "failed");
      expect(await fits(page), "could not be read").toBe(true);
      await shot(page, `history-failed-${name}`);
      // everything is shown
      await show(page).click();
      await expect(page.getByTestId("older")).toHaveAttribute("data-state", "end");
      expect(await fits(page), "everything is shown").toBe(true);
      await shot(page, `history-end-${name}`);
      // the activity log, with its line under the last day
      await page.getByTestId("history-activity").click();
      await expect(page.getByTestId("act-row")).toHaveCount(75);
      await expect(line(page)).toBeVisible();
      expect(await fits(page), "the log").toBe(true);
      await shot(page, `log-end-${name}`);
    });
  }

  test("speaks the owner's language: Korean, Japanese and Chinese, with nothing wider than the window", async ({ page }) => {
    await stubShell(page, 75);
    for (const lang of ["ko", "ja", "zh"] as const) {
      await page.addInitScript((l) => localStorage.setItem("manut.lang", l), lang);
      await openHistory(page);
      await expect(line(page), lang).toHaveText(DICT[lang]["older.more"]);
      await expect(show(page), lang).toHaveText(DICT[lang]["older.show"]);
      expect(await fits(page), lang).toBe(true);
      await show(page).click();
      await expect(line(page), lang).toHaveText(DICT[lang]["older.end"]);
      await expect(show(page), lang).toHaveCount(0);
    }
    expect(DICT.ko["older.show"]).toBe("이전 작업 보기");
  });
});
