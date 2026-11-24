// Customize › Memory and routines for a shop's owner (src/pages/CustomizePage.tsx, memory.ts, routines.ts; docs/runtime-adapter.md,
// "Customize › Memory and routines"): in Practice, where the owner remembers, confirms, corrects and forgets a fact and makes and removes a
// routine with no API, and over a stubbed desktop shell against an API that serves the owner's own memory and routines routes (as
// apps/api does, docs/pilot-api.md, "Memory" and "Routines"), where each change goes with the shop's own owner session and exactly the
// fields its route reads, a refusal is said in the owner's words, a change that got no answer is sent once and the list is read again to
// see, and a shop the person only helps at has nothing to show or change. Both run on the app's own runtime, so the page asks for it
// (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the mock bridge, which has no memory, routines or shops.
// The clock is fixed at 24 November 2026, so a routine's next run reads the same whatever day the suite runs.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.MANUT_SHOTS;

test.use({
  // a routine's time is the shop's own: Bangkok's
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

/** The sessions the stubbed API gives: each shop's own, named for the shop (`mos1.` an owner's, `mhs1.` a helper's). */
const OWNER_MALI = "mos1.pilot-shop-a";
const OWNER_SUK = "mos1.pilot-shop-c";

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

/** Customize › Memory and routines, as a person gets there: the side menu. */
async function openCustomize(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("menu-customize").click();
  await expect(page.getByTestId("memory-pane")).toBeVisible();
  await expect(page.getByTestId("routines")).toBeVisible();
}

/** Every request this page makes to an API path (Practice must make none), and to any other origin. */
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

const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const known = (page: Page) => page.getByTestId("memory-known").getByTestId("fact");
const waiting = (page: Page) => page.getByTestId("memory-waiting").getByTestId("fact-waiting");
const fact = (page: Page, words: string) => page.locator('[data-testid="fact"], [data-testid="fact-waiting"]').filter({ hasText: words });
const routine = (page: Page, words: string) => page.getByTestId("routine").filter({ hasText: words });

/** The owner makes a routine in the New routine form: what it does, and every day at a time. */
async function makeRoutine(page: Page, name: string, kind: string, at: string): Promise<void> {
  await page.getByTestId("routine-new").click();
  await expect(page.getByTestId("routine-form")).toBeVisible();
  await page.locator("#routine-name").fill(name);
  await page.getByTestId("routine-kind").selectOption(kind);
  await page.getByTestId("routine-when").selectOption("daily");
  await page.locator("#routine-at").fill(at);
  await page.getByTestId("routine-add").click();
}

// ---- in Practice ----------------------------------------------------------------------------------------------------------------

test.describe("in Practice", () => {
  test("lists what the team knows, remembers a fact the owner tells it and sends nothing anywhere", async ({ page }) => {
    const seen = requests(page);
    await openCustomize(page);
    await expect(known(page)).toHaveCount(4);
    await expect(waiting(page)).toHaveCount(1);
    await page.getByTestId("remember-input").fill("  We ship on weekdays  ");
    await page.getByTestId("remember-submit").click();
    await expect(known(page)).toHaveCount(5);
    await expect(fact(page, "We ship on weekdays")).toContainText("You told Buddy");
    await expect(page.getByTestId("remember-input")).toHaveValue("");
    // the same words again are the team's already, in the owner's words
    await page.getByTestId("remember-input").fill("we ship on WEEKDAYS");
    await page.getByTestId("remember-submit").click();
    await expect(page.getByTestId("memory-error")).toHaveText("Your team already knows this.");
    expect(seen.api).toEqual([]);
    expect(seen.outside).toEqual([]);
  });

  test("confirms a fact that waits, corrects one, and forgets one after asking, and nothing of a forgotten fact stays on the page", async ({ page }) => {
    await openCustomize(page);
    await fact(page, "Closed on Mondays").getByTestId("fact-confirm").click();
    await expect(waiting(page)).toHaveCount(0);
    await expect(known(page)).toHaveCount(5);

    await fact(page, "Free shipping").getByTestId("fact-correct").click();
    await page.getByTestId("correct-input").fill("Free shipping on orders over ฿1,000");
    await page.getByTestId("correct-save").click();
    await expect(fact(page, "Free shipping on orders over ฿1,000")).toContainText("Corrected by you");

    await fact(page, "Jasmine is the best seller").getByTestId("fact-forget").click();
    await expect(page.getByTestId("forget-question")).toContainText("Forget this?");
    // the safe answer holds the focus and nothing is forgotten until the owner says so
    await expect(page.getByTestId("forget-keep")).toBeFocused();
    await page.getByTestId("forget-keep").click();
    await expect(fact(page, "Jasmine is the best seller")).toHaveCount(1);
    await fact(page, "Jasmine is the best seller").getByTestId("fact-forget").click();
    await page.getByTestId("forget-yes").click();
    await expect(fact(page, "Jasmine is the best seller")).toHaveCount(0);
    expect(await page.content()).not.toContain("Jasmine is the best seller");
  });

  test("makes a routine, asks before removing it, and removes it with nothing sent", async ({ page }) => {
    const seen = requests(page);
    await openCustomize(page);
    const before = await page.getByTestId("routine").count();
    await makeRoutine(page, "Remind me about parcels", "draft", "15:00");
    await expect(page.getByTestId("routine")).toHaveCount(before + 1);
    await expect(routine(page, "Remind me about parcels")).toContainText("Every day at 15:00");

    await routine(page, "Remind me about parcels").getByTestId("routine-remove").click();
    await expect(page.getByTestId("routine-remove-question")).toContainText("Remove this routine? It stops running and its past runs are deleted. This cannot be undone.");
    await expect(page.getByTestId("routine-remove-keep")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("routine-remove-question")).toHaveCount(0);
    await expect(page.getByTestId("routine")).toHaveCount(before + 1);

    await routine(page, "Remind me about parcels").getByTestId("routine-remove").click();
    await page.getByTestId("routine-remove-yes").click();
    await expect(page.getByTestId("routine")).toHaveCount(before);
    await expect(routine(page, "Remind me about parcels")).toHaveCount(0);
    expect(seen.api).toEqual([]);
  });

  test("says in the form, under the stock number, that no stock levels are connected, so that routine waits and does not run", async ({ page }) => {
    await openCustomize(page);
    await page.getByTestId("routine-new").click();
    await expect(page.getByTestId("routine-stock-note")).toHaveCount(0);
    await page.getByTestId("routine-when").selectOption("stock");
    await expect(page.getByTestId("routine-stock-note")).toHaveText("Stock levels are not connected yet, so this routine waits and does not run.");
    await page.getByTestId("routine-when").selectOption("weekly");
    await expect(page.getByTestId("routine-stock-note")).toHaveCount(0);
  });

  test("at Ran Pa Noi, where the person helps, there is nothing to show or change: only the owner sees what the team knows", async ({ page }) => {
    await openCustomize(page);
    // Choosing a shop shows it on every page, which leaves Customize for the chat; Customize is opened again.
    await page.getByTestId("shop-switch").click();
    await page.getByTestId("shop-menu").getByRole("menuitemradio").nth(1).click();
    await page.getByTestId("menu-customize").click();
    await expect(page.getByTestId("memory-unavailable")).toContainText("Only Noi, the shop's owner, sees or changes what the team knows at Ran Pa Noi.");
    await expect(page.getByTestId("routines-unavailable")).toContainText("Only Noi, the shop's owner, sees or changes the team's routines at Ran Pa Noi.");
    for (const id of ["remember-form", "routine-new", "fact-forget", "fact-correct", "routine-remove", "routine-switch"]) await expect(page.getByTestId(id), id).toHaveCount(0);
  });

  test("speaks the owner's language: the Remove question in Korean, Japanese and Chinese", async ({ page }) => {
    for (const [lang, ask, yes] of [
      ["ko", "이 루틴을 삭제할까요?", "삭제하기"],
      ["ja", "このルーティンを削除しますか？", "削除する"],
      ["zh", "要删除这个定时任务吗？", "删除它"],
    ] as const) {
      await page.addInitScript((l) => localStorage.setItem("manut.lang", l), lang);
      await openCustomize(page);
      await page.getByTestId("routine-remove").first().click();
      await expect(page.getByTestId("routine-remove-question"), lang).toContainText(ask);
      await expect(page.getByTestId("routine-remove-yes"), lang).toHaveText(yes);
    }
  });

  for (const [name, scheme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["narrow", "light", 900]] as const) {
    test(`draws the Remove question and the form's stock note in ${name}, with nothing wider than the window`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await openCustomize(page);
      const shot = async (label: string) => {
        if (!SHOTS) return;
        mkdirSync(SHOTS, { recursive: true });
        await page.getByTestId("routines").screenshot({ path: join(SHOTS, `routines-${label}-${name}.png`) });
      };
      await page.getByTestId("routine-remove").first().click();
      await expect(page.getByTestId("routine-remove-question")).toBeVisible();
      expect(await fits(page), "remove question").toBe(true);
      await shot("remove");
      await page.getByTestId("routine-remove-keep").click();
      await page.getByTestId("routine-new").click();
      await page.getByTestId("routine-when").selectOption("stock");
      await expect(page.getByTestId("routine-stock-note")).toBeVisible();
      expect(await fits(page), "stock note").toBe(true);
      await shot("stock");
    });
  }
});

// ---- over a stubbed desktop shell -----------------------------------------------------------------------------------------------

type Call = { cmd: string; method?: string; path?: string; bearer?: string | null; body?: unknown };
type Stage = {
  __calls: Call[];
  /** make the next request to `METHOD /path` end as the shell says it ended (`failed` or `offline`); `kept` makes the API keep the change first */
  __lose: (key: string, how: "failed" | "offline", kept: boolean) => void;
};

/** The desktop shell is stood in the page, as the connected runtime reaches the API only through its commands: a person who owns Baan Mali
 *  (and, with `shops: "several"`, Baan Suk too) and helps at Ran Pa Noi, and an API that serves each owned shop's own memory and routines
 *  as apps/api's owner routes do, by the shop session the request carries. Every request is recorded on `window.__calls`. */
async function stubShell(page: Page, shops: "one" | "several" = "one") {
  await page.addInitScript(({ several }) => {
    localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
    const w = window as unknown as Stage;
    w.__calls = [];
    const lose = new Map<string, { how: "failed" | "offline"; kept: boolean }>();
    w.__lose = (key, how, kept) => void lose.set(key, { how, kept });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
    const mali = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
    const suk = { id: "pilot:shop-c", name: "Baan Suk", ownerName: "Fon" };
    const noi = { id: "pilot:shop-b", name: "Ran Pa Noi", ownerName: "Noi" };
    const list = [
      { ...mali, role: "owner" },
      ...(several ? [{ ...suk, role: "owner" }] : []),
      { ...noi, role: "helper" },
    ];
    type Fact = { id: string; text: string; status: "confirmed" | "waiting"; createdAt: number; updatedAt: number; correctedAt?: number; source: unknown };
    type Rt = Record<string, unknown>;
    const world: Record<string, { facts: Fact[]; next: number; routines: Rt[]; made: number }> = {
      [mali.id]: {
        facts: [
          { id: "f1", text: "Free shipping on orders over ฿800", status: "confirmed", createdAt: now - 5e6, updatedAt: now - 5e6, source: { kind: "document", name: "price list", date: now - 20 * 86_400_000 } },
          { id: "f2", text: "Reply warmly and end with ค่ะ", status: "confirmed", createdAt: now - 4e6, updatedAt: now - 4e6, source: { kind: "edits", count: 12 } },
          { id: "f3", text: "Closed on Mondays", status: "waiting", createdAt: now - 3e6, updatedAt: now - 3e6, source: { kind: "customer", chat: "chat-17" } },
        ],
        next: 4,
        routines: [
          { id: "rt-0001-brief", name: "Morning brief", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: "Asia/Bangkok", asksFirst: false, member: "ton", when: "Every day at 08:00", paused: false, next: iso(now + 86_400_000), createdAt: iso(now - 86_400_000), lastRun: null },
        ],
        made: 0,
      },
      [suk.id]: {
        facts: [{ id: "f1", text: "Baan Suk opens at ten", status: "confirmed", createdAt: now - 2e6, updatedAt: now - 2e6, source: { kind: "owner" } }],
        next: 2,
        routines: [],
        made: 0,
      },
    };
    const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const words = (t: { kind: string; at?: string; weekdays?: number[]; threshold?: number }) =>
      t.kind === "daily" ? `Every day at ${t.at}` : t.kind === "weekly" ? `Every ${(t.weekdays ?? []).map((d) => DAYS[d]).join(" and ")} at ${t.at}` : t.kind === "stockBelow" ? `When stock drops under ${t.threshold}` : t.kind;
    const nextDaily = (at: string) => {
      const [h, m] = at.split(":").map(Number);
      const bkk = new Date(now + 7 * 3_600_000);
      let at0 = Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate(), h - 7, m);
      if (at0 <= now) at0 += 86_400_000;
      return at0;
    };
    const sessions = new Map<string, { shop: string; role: "owner" | "helper" }>();
    let n = 0;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++n,
      invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null; key?: string; text?: string }) => {
        if (cmd === "api_session_read") {
          return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
        }
        if (cmd === "shop_cache_write" || cmd === "shop_cache_read" || cmd === "shop_cache_clear") return null;
        if (cmd !== "api_request") return null;
        const url = new URL(String(args.url));
        const body = args.body ? JSON.parse(args.body) : null;
        w.__calls.push({ cmd, method: args.method, path: url.pathname, bearer: args.bearer ?? null, body });
        const key = `${args.method} ${url.pathname}`;
        const lost = lose.get(key);
        if (lost) lose.delete(key);
        // a request that never arrived changed nothing; one the API answered and the answer was lost may have changed it
        if (lost && !lost.kept) throw lost.how;
        const answer = (() => {
          if (key === "GET /v1/shops") return reply(200, { shops: list });
          if (key === "POST /v1/shops/session") {
            const shop = list.find((s) => s.id === body?.shop);
            if (!shop) return reply(404, { error: "not_found" });
            const token = `${shop.role === "owner" ? "mos1" : "mhs1"}.${shop.id.replace(/[^a-z0-9]/g, "-")}`;
            sessions.set(token, { shop: shop.id, role: shop.role as "owner" | "helper" });
            return reply(200, { shop: { id: shop.id, name: shop.name, ownerName: shop.ownerName }, role: shop.role, session: { accessToken: token, expiresAt: iso(now + 30 * 86_400_000) }, ...(shop.role === "owner" ? { account: { id: "owner-account-1" } } : { helper: { id: "helper-1", name: "Mint" } }) });
          }
          const at = args.bearer ? sessions.get(args.bearer) : undefined;
          if (!at) return reply(404, { error: "not_found" });
          if (key === "GET /v1/approvals") return reply(200, { state: "open", approvals: [] });
          // everything below is the owner's: a helper's session is told so
          if (at.role !== "owner") return reply(403, { error: "owner_only" });
          const shop = world[at.shop];
          // an owner's session reads the task list, its schedules and its attention items (src/runtime/http/shops.ts), not the export
          if (key === "GET /v1/tasks") return reply(200, { tasks: [] });
          if (key === "GET /v1/schedules") return reply(200, { schedules: [] });
          if (key === "GET /v1/inbound/attention") return reply(200, { items: [] });
          if (key === "GET /v1/routines") return reply(200, { tenant: at.shop, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: shop.routines });
          if (key === "GET /v1/memory") return reply(200, { tenant: at.shop, facts: shop.facts, forgottenCount: 0 });
          if (key === "POST /v1/memory/remember") {
            const text = String(body?.text ?? "").trim();
            if ([...text].length < 1 || [...text].length > 280) return reply(400, { error: "invalid_text" });
            const same = shop.facts.find((f) => norm(f.text) === norm(text));
            if (same && same.status === "confirmed") return reply(409, { error: "already_known" });
            if (same) {
              same.status = "confirmed";
              same.updatedAt = Date.now();
              return reply(200, same);
            }
            const made: Fact = { id: `f${shop.next++}`, text, status: "confirmed", createdAt: Date.now(), updatedAt: Date.now(), source: { kind: "owner" } };
            shop.facts.push(made);
            return reply(200, made);
          }
          if (key === "POST /v1/memory/confirm") {
            const f = shop.facts.find((x) => x.id === body?.id);
            if (!f) return reply(404, { error: "not_found" });
            f.status = "confirmed";
            f.updatedAt = Date.now();
            return reply(200, f);
          }
          if (key === "POST /v1/memory/correct") {
            const f = shop.facts.find((x) => x.id === body?.id);
            if (!f) return reply(404, { error: "not_found" });
            f.text = String(body?.text).trim();
            f.status = "confirmed";
            f.updatedAt = f.correctedAt = Date.now();
            return reply(200, f);
          }
          if (key === "POST /v1/memory/forget") {
            const i = shop.facts.findIndex((x) => x.id === body?.id);
            if (i < 0) return reply(404, { error: "not_found" });
            shop.facts.splice(i, 1);
            return reply(200, { id: body?.id });
          }
          if (key === "POST /v1/routines") {
            const t = body?.trigger as { kind: string; at?: string; weekdays?: number[]; threshold?: number };
            const asks = body?.action === "reply" || body?.action === "send";
            const routineMade: Rt = {
              id: `rt-made-${++shop.made}`,
              name: String(body?.name).trim(),
              action: body?.action,
              trigger: t,
              timeZone: "Asia/Bangkok",
              asksFirst: asks,
              member: body?.action === "reply" ? "nam" : "ton",
              when: words(t),
              paused: false,
              next: t.kind === "daily" && t.at ? iso(nextDaily(t.at)) : null,
              ...(t.kind === "stockBelow" ? { waitsFor: "stock_feed" } : {}),
              createdAt: iso(Date.now()),
              lastRun: null,
            };
            shop.routines.push(routineMade);
            return reply(200, { routine: routineMade });
          }
          if (key === "POST /v1/routines/remove") {
            const i = shop.routines.findIndex((r) => r.id === body?.routineId);
            if (i < 0) return reply(404, { error: "not_found" });
            shop.routines.splice(i, 1);
            return reply(200, { removed: body?.routineId });
          }
          return reply(404, { error: "not_found" });
        })();
        if (lost) throw lost.how;
        return answer;
      },
    };
  }, { several: shops === "several" });
}

/** The calls to the API that are not the shop's own read, in order: what the owner's changes sent, and with which session. */
const changes = async (page: Page) =>
  (await page.evaluate(() => (window as unknown as Stage).__calls))
    .filter((c) => c.method === "POST" && c.path !== "/v1/shops/session")
    .map((c) => [c.path, c.bearer, c.body]);
const calls = (page: Page) => page.evaluate(() => (window as unknown as Stage).__calls);

test.describe("connected to an API", () => {
  test("reads what the team knows with the shop's own owner session, and remembers, confirms, corrects and forgets with exactly the fields each route reads", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await expect(known(page)).toHaveCount(2);
    // read with the shop's own owner session and nothing else (a page opened before the shop list is in reads once more when it is)
    const reads = (await calls(page)).filter((c) => c.path === "/v1/memory");
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads.map((c) => `${c.method} ${c.bearer}`))).toEqual(new Set([`GET ${OWNER_MALI}`]));
    await expect(waiting(page)).toHaveCount(1);
    await expect(fact(page, "Free shipping")).toContainText("From your price list, ");

    await page.getByTestId("remember-input").fill("  We ship on weekdays  ");
    await page.getByTestId("remember-submit").click();
    await expect(fact(page, "We ship on weekdays")).toContainText("You told Buddy");
    await fact(page, "Closed on Mondays").getByTestId("fact-confirm").click();
    await expect(waiting(page)).toHaveCount(0);
    await fact(page, "Reply warmly").getByTestId("fact-correct").click();
    await page.getByTestId("correct-input").fill("Reply warmly and end with ค่ะ or ครับ");
    await page.getByTestId("correct-save").click();
    await expect(fact(page, "ค่ะ or ครับ")).toContainText("Corrected by you");
    await fact(page, "Free shipping").getByTestId("fact-forget").click();
    await page.getByTestId("forget-yes").click();
    await expect(fact(page, "Free shipping")).toHaveCount(0);

    expect(await changes(page)).toEqual([
      ["/v1/memory/remember", OWNER_MALI, { text: "We ship on weekdays" }],
      ["/v1/memory/confirm", OWNER_MALI, { id: "f3" }],
      ["/v1/memory/correct", OWNER_MALI, { id: "f2", text: "Reply warmly and end with ค่ะ or ครับ" }],
      ["/v1/memory/forget", OWNER_MALI, { id: "f1" }],
    ]);
    // nothing of a forgotten fact stays on the page, and what the team knows is in no saved read or storage
    expect(await page.content()).not.toContain("Free shipping on orders over ฿800");
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain("We ship on weekdays");
  });

  test("says what the API refused in the owner's words: the team already knows it, and the fact is gone", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await page.getByTestId("remember-input").fill("free SHIPPING on orders over ฿800");
    await page.getByTestId("remember-submit").click();
    await expect(page.getByTestId("memory-error")).toHaveText("Your team already knows this.");
    // words the package would refuse are said before anything is sent
    const before = (await changes(page)).length;
    await page.getByTestId("remember-input").fill("x".repeat(281));
    await page.getByTestId("remember-submit").click();
    await expect(page.getByTestId("memory-error")).toHaveText("Say it in 1 to 280 characters.");
    expect((await changes(page)).length).toBe(before);
  });

  test("sends a change that got no answer once, says so, and reads the list again to see whether it happened", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await expect(known(page)).toHaveCount(2);
    // the API made the change, and its answer never came
    await page.evaluate(() => (window as unknown as Stage).__lose("POST /v1/memory/remember", "failed", true));
    await page.getByTestId("remember-input").fill("We ship on weekdays");
    await page.getByTestId("remember-submit").click();
    await expect(page.getByTestId("memory-error")).toHaveText("No reply from the API. Checking whether it changed.");
    // the list is read again after it, and shows what the API holds: the fact is there, and was sent once
    await expect(fact(page, "We ship on weekdays")).toHaveCount(1);
    const all = await calls(page);
    const sentAt = all.findIndex((c) => c.path === "/v1/memory/remember");
    expect(all.slice(sentAt + 1).some((c) => c.method === "GET" && c.path === "/v1/memory")).toBe(true);
    expect((await changes(page)).filter(([path]) => path === "/v1/memory/remember")).toHaveLength(1);
    await page.waitForTimeout(500);
    expect((await changes(page)).filter(([path]) => path === "/v1/memory/remember")).toHaveLength(1);
  });

  test("makes a routine with exactly { name, action, trigger } and removes one with exactly { routineId }, each with the shop's own session", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await expect(page.getByTestId("routine")).toHaveCount(1);
    await expect(routine(page, "Morning brief")).toContainText("Every day at 08:00");
    await makeRoutine(page, "Remind me about parcels", "draft", "15:00");
    await expect(routine(page, "Remind me about parcels")).toContainText("Every day at 15:00");
    await expect(routine(page, "Remind me about parcels")).toContainText("Next: Today 15:00");
    // a reply asks first, as the form says before it is added, and the API says so too
    await makeRoutine(page, "Answer parcel questions", "reply", "09:30");
    await expect(routine(page, "Answer parcel questions")).toContainText("Asks first.");

    await routine(page, "Remind me about parcels").getByTestId("routine-remove").click();
    await page.getByTestId("routine-remove-yes").click();
    await expect(routine(page, "Remind me about parcels")).toHaveCount(0);

    expect(await changes(page)).toEqual([
      ["/v1/routines", OWNER_MALI, { name: "Remind me about parcels", action: "draft", trigger: { kind: "daily", at: "15:00" } }],
      ["/v1/routines", OWNER_MALI, { name: "Answer parcel questions", action: "reply", trigger: { kind: "daily", at: "09:30" } }],
      ["/v1/routines/remove", OWNER_MALI, { routineId: "rt-made-1" }],
    ]);
  });

  test("says a stock routine waits for a feed that is not connected, and the API still holds it with no next run", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await page.getByTestId("routine-new").click();
    await page.locator("#routine-name").fill("Tell me when candles run low");
    await page.getByTestId("routine-when").selectOption("stock");
    await expect(page.getByTestId("routine-stock-note")).toHaveText("Stock levels are not connected yet, so this routine waits and does not run.");
    await page.getByTestId("routine-add").click();
    const row = routine(page, "Tell me when candles run low");
    await expect(row).toContainText("When stock drops under 5");
    await expect(row).not.toContainText("Next:");
    expect(await changes(page)).toEqual([["/v1/routines", OWNER_MALI, { name: "Tell me when candles run low", action: "brief", trigger: { kind: "stockBelow", threshold: 5 } }]]);
  });

  test("shows a shop the person only helps at its owner's words in place of both lists, and sends it nothing of memory or routines", async ({ page }) => {
    await stubShell(page);
    await openCustomize(page);
    await page.getByTestId("shop-switch").click();
    await page.getByTestId("shop-menu").getByRole("menuitemradio").filter({ hasText: "Ran Pa Noi" }).click();
    await page.getByTestId("menu-customize").click();
    await expect(page.getByTestId("memory-unavailable")).toHaveText("Only the shop's owner sees and changes what the team knows.");
    await expect(page.getByTestId("routines-unavailable")).toContainText("Only Noi can see and change the team at Ran Pa Noi.");
    for (const id of ["remember-form", "routine-new", "fact-forget", "routine-remove"]) await expect(page.getByTestId(id), id).toHaveCount(0);
    // the helper's session was never sent a memory or routines request
    const helper = (await calls(page)).filter((c) => (c.bearer ?? "").startsWith("mhs1.") && /^\/v1\/(memory|routines)/.test(c.path ?? ""));
    expect(helper).toEqual([]);
  });

  test("reads the other shop's lists when the switcher shows it, and a change then goes with that shop's session", async ({ page }) => {
    await stubShell(page, "several");
    await openCustomize(page);
    await expect(fact(page, "Free shipping")).toHaveCount(1);
    await page.getByTestId("shop-switch").click();
    await page.getByTestId("shop-menu").getByRole("menuitemradio").filter({ hasText: "Baan Suk" }).click();
    await page.getByTestId("menu-customize").click();
    await expect(fact(page, "Baan Suk opens at ten")).toHaveCount(1);
    await expect(fact(page, "Free shipping")).toHaveCount(0);
    await page.getByTestId("remember-input").fill("Baan Suk ships on Fridays");
    await page.getByTestId("remember-submit").click();
    await expect(fact(page, "Baan Suk ships on Fridays")).toHaveCount(1);
    expect(await changes(page)).toEqual([["/v1/memory/remember", OWNER_SUK, { text: "Baan Suk ships on Fridays" }]]);
  });
});
