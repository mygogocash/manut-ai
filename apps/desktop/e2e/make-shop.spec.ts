// Make your shop, in Settings › Developer (src/settings/MakeShop.tsx; docs/several-shops.md, "A shop its owner makes"): in
// Practice, where the shop is made on this computer with nothing sent and then sits in the switcher with the person's other
// shops, and, over a stubbed desktop shell, against an API that has not opened sign-ups, which is what every real
// environment answers until the owner opens them. Both run on the app's own runtime, so the page asks for it
// (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the mock bridge, which makes no shops.
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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

/** Settings › Developer, as a person gets there, with Make your shop on it. */
async function openDeveloper(page: Page) {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-developer").click();
  await expect(page.getByTestId("make-shop")).toBeVisible();
}

/** Every request this page makes to an API path. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/\/v1\//.test(r.url())) seen.push(`${r.method()} ${r.url()}`);
  });
  return seen;
}

const notice = (page: Page) => page.getByTestId("make-notice");

test.describe("in Practice", () => {
  test("makes a shop with nothing sent, says what is missing first, and puts it in the switcher as the person's own", async ({ page }) => {
    const requests = apiRequests(page);
    await openDeveloper(page);
    await expect(page.getByTestId("mode-line")).toHaveText("Practice mode");
    const form = page.getByTestId("make-shop");
    await expect(form).toContainText("Practice: the shop is made on this computer only. Nothing is sent, and it goes when the app closes.");
    for (const name of ["Handmade and gifts", "Clothes and accessories", "Packaged food and drinks", "None of these"]) {
      await expect(form).toContainText(name);
    }

    // Nothing typed: it says what is missing, field by field, and makes nothing.
    await page.getByTestId("make-submit").click();
    await expect(notice(page)).toHaveText("Give your shop a name.");
    await page.getByTestId("make-name").fill("Khao Hom");
    await expect(notice(page)).toHaveCount(0);
    await page.getByTestId("make-submit").click();
    await expect(notice(page)).toHaveText("Give your own name.");
    await page.getByTestId("make-owner").fill("Dao");
    await page.getByTestId("make-submit").click();
    await expect(notice(page)).toHaveText("Pick the kind of shop, or None of these.");

    // The kinds are a radio group: picking one by its label picks it, and Enter in a box makes the shop.
    await page.getByText("Packaged food and drinks", { exact: true }).click();
    await expect(page.getByTestId("make-kind-food")).toBeChecked();
    await page.getByTestId("make-owner").press("Enter");
    // Making a shop opens it, as choosing it in the switcher does: Settings gives way to the new shop's chat.
    await expect(page.getByTestId("make-shop")).toHaveCount(0);

    // The switcher has it, shown, as the person's own, among their other shops.
    await page.getByTestId("shop-switch").click();
    const items = page.getByTestId("shop-menu").getByTestId("shop-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(1)).toContainText("Khao Hom");
    await expect(items.nth(1)).toContainText("Owner");
    await expect(items.nth(1)).toHaveAttribute("aria-checked", "true");
    expect(requests).toEqual([]);
  });
});

test.describe("connected to an API that has not opened sign-ups", () => {
  // The desktop shell is stood in the page, as the connected runtime reaches the API only through its commands: someone is
  // signed in, is in no shop, and the API answers 403 sign_ups_closed to making one, as every environment does until the
  // owner opens sign-ups.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const origin = "https://dev.manut.xyz";
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin }));
      const w = window as unknown as { __sent: { method: string; path: string; body: unknown }[]; __TAURI_INTERNALS__: unknown };
      w.__sent = [];
      let n = 0;
      const kept = new Map<string, string>();
      const answer = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
      const now = Date.now();
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++n,
        invoke: async (cmd: string, args: { url: string; method: string; body: string | null; key?: string; text?: string }) => {
          if (cmd === "api_session_read") {
            return JSON.stringify({ v: 1, origin, tenant: "apple:dao", deviceId: "device-1", accessToken: "access-1",
              refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now - 60_000 });
          }
          if (cmd === "shop_cache_read") return kept.get(String(args.key)) ?? null;
          if (cmd === "shop_cache_write") return void kept.set(String(args.key), String(args.text));
          if (cmd !== "api_request") return null;
          const url = new URL(args.url);
          w.__sent.push({ method: args.method, path: url.pathname, body: args.body ? JSON.parse(args.body) : null });
          switch (url.pathname) {
            case "/v1/shops/new":
              return answer(403, { error: "sign_ups_closed" });
            case "/v1/shops":
              return answer(200, { shops: [] });
            case "/v1/approvals":
              return answer(200, { state: "open", approvals: [] });
            case "/v1/tenant/export":
              return answer(200, { tenant: "apple:dao", exportedAt: new Date(now).toISOString(), tasks: [], schedules: [], attention: [] });
            case "/v1/schedules":
              return answer(200, { schedules: [] });
            case "/v1/inbound/attention":
              return answer(200, { items: [] });
            default:
              return answer(404, { error: "not_found" });
          }
        },
      };
    });
  });

  test("offers it to a signed-in person in no shop, and says plainly that making your own shop isn't open yet", async ({ page }) => {
    await openDeveloper(page);
    await expect(page.getByTestId("mode-line")).toContainText("dev.manut.xyz");
    await expect(page.getByTestId("make-shop")).toContainText("You're signed in and not in a shop yet. Make yours here: you're its owner from the start.");

    await page.getByTestId("make-name").fill("  Khao Hom ");
    await page.getByTestId("make-owner").fill("Dao");
    await page.getByTestId("make-kind-none").check();
    await page.getByTestId("make-submit").click();
    await expect(notice(page)).toHaveText("Making your own shop isn't open yet. For now, Manut AI sets each shop up with its owner.");
    // Nothing moved on: what was typed stays, and the form can be sent again once sign-ups open.
    await expect(page.getByTestId("make-shop")).toHaveAttribute("data-state", "form");
    await expect(page.getByTestId("make-name")).toHaveValue("  Khao Hom ");
    await expect(page.getByTestId("make-submit")).toBeEnabled();
    const sent = await page.evaluate(() =>
      (window as unknown as { __sent: { method: string; path: string; body: unknown }[] }).__sent.filter((s) => s.path === "/v1/shops/new"));
    expect(sent).toEqual([{ method: "POST", path: "/v1/shops/new", body: { name: "Khao Hom", ownerName: "Dao", template: null } }]);
  });
});
