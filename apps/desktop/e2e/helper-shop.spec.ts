// A shop the person helps at, over a stubbed desktop shell against an API that answers a helper's session as apps/api does
// (docs/runtime-adapter.md, "A shop the person helps at"; docs/people.md, "The helper's session"): the person owns Baan Mali and
// helps Noi at Ran Pa Noi. The switcher and the account row mark Ran Pa Noi as theirs to help at; its pages that are Noi's (the
// team and Pause everyone, past work, the routines, who is working on Home) say so instead of an empty list; Needs you holds its
// asks, a reply is approved through the decide route with the helper's own session and exactly the option and the revision seen,
// and money says only Noi may approve it and sends nothing. A helper's session is sent nothing but what the API lets it read and
// answer. It runs on the app's own runtime, so the page asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server
// is built for the mock bridge, which has no Connected.
import { expect, test, type Page } from "@playwright/test";

const PORT = Number(process.env.MANUT_PORT || 5307);

test.use({
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

/** The sessions the stubbed API gives: each shop's own, named for the shop (`mos1.` an owner's, `mhs1.` a helper's). */
const OWNER_MALI = "mos1.pilot-shop-a";
const HELPER_NOI = "mhs1.pilot-shop-b";

type Call = { method?: string; path?: string; query?: string; bearer?: string | null; body?: unknown };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

/** The desktop shell stood in the page, as the connected runtime reaches the API only through its commands. Ran Pa Noi has two
 *  requests waiting, as approval-core's wire records: a reply, which a helper decides, and a refund, which only Noi does. Every
 *  route a helper's session may not use answers it 403 `owner_only`, as apps/api does. Every request is kept on `window.__calls`. */
async function stubShell(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
    const w = window as unknown as { __calls: Call[] };
    w.__calls = [];
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
    const mali = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon" };
    const noi = { id: "pilot:shop-b", name: "Ran Pa Noi", ownerName: "Noi" };
    const list = [
      { ...mali, role: "owner" },
      { ...noi, role: "helper" },
    ];
    const options = [
      { id: "approve", label: "Approve", effect: "approve" },
      { id: "decline", label: "Decline", effect: "decline" },
    ];
    const request = (id: string, kind: string, ago: number, detail: Record<string, unknown>) => ({
      taskId: `task-${id}`,
      record: { status: "pending", request: { id, kind, options, revision: 1, createdAt: now - ago, expiresAt: now + 86_400_000, detail } },
      standing: { state: "open", reason: "waiting" },
    });
    const waiting = [
      request("reply-1", "reply", 600_000, { actionId: "reply-1", operationType: "line.message.push", targetResourceId: "bot-user-1", recipient: "U-customer", text: "We open at nine tomorrow.", payloadHash: "hash" }),
      request("refund-1", "money", 300_000, { actionId: "refund-1", operationType: "shopee.refund", targetResourceId: "RP-118" }),
    ];
    const decided = new Set<string>();
    const sessions = new Map<string, { shop: string; role: string }>();
    let n = 0;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++n,
      invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null }) => {
        if (cmd === "api_session_read") {
          return JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now });
        }
        if (cmd === "shop_cache_write" || cmd === "shop_cache_read" || cmd === "shop_cache_clear") return null;
        if (cmd !== "api_request") return null;
        const url = new URL(String(args.url));
        const body = args.body ? JSON.parse(args.body) : null;
        w.__calls.push({ method: args.method, path: url.pathname, query: url.search, bearer: args.bearer ?? null, body });
        const key = `${args.method} ${url.pathname}`;
        if (key === "GET /v1/shops") return reply(200, { shops: list });
        if (key === "POST /v1/shops/session") {
          const shop = list.find((s) => s.id === body?.shop);
          if (!shop) return reply(404, { error: "not_found" });
          const token = `${shop.role === "owner" ? "mos1" : "mhs1"}.${shop.id.replace(/[^a-z0-9]/g, "-")}`;
          sessions.set(token, { shop: shop.id, role: shop.role });
          return reply(200, { shop: { id: shop.id, name: shop.name, ownerName: shop.ownerName }, role: shop.role, session: { accessToken: token, expiresAt: iso(now + 30 * 86_400_000) }, ...(shop.role === "owner" ? { account: { id: "owner-account-1" } } : { helper: { id: "helper-1", name: "Mint" } }) });
        }
        const at = args.bearer ? sessions.get(args.bearer) : undefined;
        if (!at) return reply(404, { error: "not_found" });
        // the live feed's ticket, which either role may mint: this API is one from before the feed, so the feed is off
        if (key === "POST /v1/feed/ticket") return reply(404, { error: "not_found" });
        if (key === "GET /v1/approvals") {
          const state = url.searchParams.get("state");
          if (state === "recent") return reply(200, { state, approvals: [] });
          return reply(200, { state, approvals: at.shop === noi.id ? waiting.filter((a) => !decided.has(a.record.request.id)) : [] });
        }
        const decision = /^\/v1\/approvals\/([^/]+)\/decision$/.exec(url.pathname);
        if (args.method === "POST" && decision && at.shop === noi.id) {
          const id = decodeURIComponent(decision[1]);
          decided.add(id);
          return reply(200, { result: { ok: true, decision: { requestId: id, optionId: body?.optionId, seenRevision: body?.seenRevision, decidedBy: "helper-1", role: "helper", decidedAt: Date.now() } }, action: "confirmed" });
        }
        // everything below is the owner's: a helper's session is told so
        if (at.role !== "owner") return reply(403, { error: "owner_only" });
        if (key === "GET /v1/tasks") return reply(200, { tasks: [] });
        if (key === "GET /v1/schedules") return reply(200, { schedules: [] });
        if (key === "GET /v1/inbound/attention") return reply(200, { items: [] });
        if (key === "GET /v1/routines") return reply(200, { tenant: at.shop, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
        return reply(404, { error: "not_found" });
      },
    };
  });
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);

/** Shows Ran Pa Noi on every page, through the switcher in the account row, as a person does. */
async function helpAtNoi(page: Page): Promise<void> {
  await page.getByTestId("shop-switch").click();
  const items = page.getByTestId("shop-menu").getByRole("menuitemradio");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Baan Mali");
  await expect(items.nth(0)).toContainText("Owner");
  await expect(items.nth(1)).toContainText("Ran Pa Noi");
  await expect(items.nth(1)).toContainText("Helper");
  await items.nth(1).click();
  await expect(page.getByTestId("nav-settings")).toContainText("Ran Pa Noi");
}

test("marks Ran Pa Noi as a shop the person helps at, and each of Noi's pages says so instead of an empty list", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  // at the shop the person owns, the account row says nothing more
  await expect(page.getByTestId("acct-role")).toHaveCount(0);
  await helpAtNoi(page);
  await expect(page.getByTestId("acct-role")).toHaveText("Helper");

  await page.getByTestId("menu-new").click();
  await expect(page.getByTestId("home-shop")).toHaveText("Helping Noi at Ran Pa Noi");
  await expect(page.getByTestId("home-owners")).toHaveText("Only Noi sees who is working at Ran Pa Noi.");
  await expect(page.getByTestId("home-idle")).toHaveCount(0);

  await page.getByTestId("menu-team").click();
  await expect(page.getByTestId("owners-team")).toContainText("Only Noi sees this");
  await expect(page.getByTestId("owners-team")).toContainText("Its team, what each member is doing and Pause everyone are Noi's.");
  await expect(page.getByTestId("team-buddy")).toBeVisible();
  await expect(page.getByTestId("pause-open")).toHaveCount(0);
  await expect(page.getByTestId("pause-side")).toHaveCount(0);

  await page.getByTestId("menu-history").click();
  await expect(page.getByTestId("owners-history")).toContainText("You help at Ran Pa Noi. Its past work is Noi's to see.");
  await expect(page.getByTestId("history-find")).toHaveCount(0);
  // the words lead to what is the helper's: Needs you
  await page.getByTestId("owners-history").getByTestId("owners-needs").click();
  await expect(page.getByTestId("page-needs")).toBeVisible();

  // the helper's session was sent what waits there and nothing else; the owned shop's own session read the owned shop whole
  const sent = await calls(page);
  const helper = sent.filter((c) => c.bearer === HELPER_NOI).map((c) => `${c.method} ${c.path}${c.query}`);
  expect(helper.length).toBeGreaterThan(0);
  expect([...new Set(helper)].sort()).toEqual(["GET /v1/approvals?state=open", "POST /v1/feed/ticket"]);
  expect(sent.filter((c) => c.path === "/v1/routines").every((c) => c.bearer === OWNER_MALI)).toBe(true);
});

test("approves Ran Pa Noi's reply with the helper's own session, and money waits for Noi with nothing sent", async ({ page }) => {
  await stubShell(page);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
  await page.getByTestId("menu-needs").click();
  const rows = page.getByTestId("needs-row");
  await expect(rows).toHaveCount(2);
  // newest first, each naming its shop
  await expect(rows.nth(0)).toContainText("Ran Pa Noi");
  await expect(rows.nth(0)).toContainText("RP-118");
  await expect(rows.nth(1)).toContainText("We open at nine tomorrow.");

  await rows.nth(0).getByTestId("needs-open").click();
  const refund = page.getByTestId("card-approval").filter({ hasText: "RP-118" });
  await expect(refund.getByTestId("card-shop")).toHaveText("Ran Pa Noi");
  await expect(refund.getByTestId("card-only")).toHaveText("Only Noi can approve money");
  await expect(refund.locator("[data-choice]")).toHaveCount(0);

  const answer = page.getByTestId("card-approval").filter({ hasText: "We open at nine tomorrow." });
  await answer.locator('[data-choice="once"]').click();
  // the card becomes the line an answered ask is, once the API said it was decided
  await expect(page.getByTestId("card-line").filter({ hasText: "Allowed once" })).toHaveCount(1);
  const decisions = (await calls(page)).filter((c) => c.method === "POST" && /\/decision$/.test(c.path ?? ""));
  expect(decisions.map((c) => [c.path, c.bearer, c.body])).toEqual([["/v1/approvals/reply-1/decision", HELPER_NOI, { optionId: "approve", seenRevision: 1 }]]);
  // the refund still waits for Noi, in Needs you
  await page.getByTestId("menu-needs").click();
  await expect(page.getByTestId("needs-row")).toHaveCount(1);
  await expect(page.getByTestId("needs-row")).toContainText("RP-118");
});
