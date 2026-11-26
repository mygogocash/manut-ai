// Delete account (item 124; src/settings/DeleteAccount.tsx; docs/pilot-api.md, "Deleting your own account"), on the app's
// own runtime, as a person reaches it: the "You" row at the foot of the side menu opens Settings › General, whose Account
// group has the row. In Practice it says there is no account to delete. Connected, over a stubbed desktop shell, an owner
// reads what goes and what stays, continues, types their shop's name and presses the red Delete account; a helper presses
// the red Delete with nothing to type. Afterwards the person is signed out, the saved runtime is Practice for the next
// start, and the page says it is done. Pictures go to MANUT_SHOTS (a mktemp folder) in light and dark.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MANUT_PORT || 5307);
const SHOTS = process.env.MANUT_SHOTS;

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [
          { name: "manut.onboarded", value: "1" },
          { name: "manut.lang", value: "en" },
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

type Call = { cmd: string; method?: string; path?: string; bearer?: string | null; body?: unknown };

/** The desktop shell stood in the page: someone signed in at dev.manut.xyz, in `role` at Baan Mali. The API answers the
 *  shop's reads with nothing, and `POST /v1/account/deletion` as apps/api does once it is done. Every shell command is kept
 *  on `window.__calls`. */
async function stubShell(page: Page, role: "owner" | "helper") {
  await page.addInitScript((who) => {
    localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
    const w = window as unknown as { __calls: Call[] };
    w.__calls = [];
    const now = Date.now();
    const reply = (status: number, json: unknown) => ({ status, body: JSON.stringify(json) });
    const shop = { id: "pilot:shop-a", name: "Baan Mali", ownerName: "Fon", role: who };
    let n = 0;
    let signedIn = true;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
      transformCallback: () => ++n,
      invoke: async (cmd: string, args: { url?: string; method?: string; bearer?: string | null; body?: string | null }) => {
        if (cmd === "api_session_read") {
          return signedIn ? JSON.stringify({ v: 1, origin: "https://dev.manut.xyz", tenant: "apple:fon", deviceId: "device-1", accessToken: "access-1", refreshToken: "refresh-1", accessExpiresAt: now + 3_600_000, signedInAt: now }) : null;
        }
        if (cmd === "api_session_clear") {
          signedIn = false;
          w.__calls.push({ cmd });
          return null;
        }
        if (cmd.startsWith("shop_cache_") || cmd === "api_session_write") return null;
        if (cmd !== "api_request") return null;
        const url = new URL(String(args.url));
        const body = args.body ? JSON.parse(args.body) : null;
        w.__calls.push({ cmd, method: args.method, path: url.pathname, bearer: args.bearer ?? null, body });
        const key = `${args.method} ${url.pathname}`;
        if (key === "GET /v1/shops") return reply(200, { shops: [shop] });
        if (key === "POST /v1/shops/session") {
          const token = `${who === "owner" ? "mos1" : "mhs1"}.shop-a`;
          return reply(200, { shop: { id: shop.id, name: shop.name, ownerName: shop.ownerName }, role: who, session: { accessToken: token, expiresAt: new Date(now + 86_400_000).toISOString() }, ...(who === "owner" ? { account: { id: "owner-account-1" } } : { helper: { id: "helper-1", name: "Mint" } }) });
        }
        if (key === "POST /v1/account/deletion") {
          return reply(200, { deleted: true, shops: who === "owner" ? [{ id: shop.id, name: shop.name }] : [], left: who === "helper" ? [{ id: shop.id, name: shop.name }] : [], apple: "revoked" });
        }
        if (key === "GET /v1/tasks") return reply(200, { tasks: [] });
        if (key === "GET /v1/schedules") return reply(200, { schedules: [] });
        if (key === "GET /v1/inbound/attention") return reply(200, { items: [] });
        if (key === "GET /v1/approvals") return reply(200, { state: url.searchParams.get("state"), approvals: [] });
        if (key === "GET /v1/routines") return reply(200, { tenant: shop.id, team: { paused: false, since: null, members: ["nam", "pim", "ton"] }, routines: [] });
        return reply(404, { error: "not_found" });
      },
    };
  }, role);
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: Call[] }).__calls);

/** Settings › General, as a person opens it: the "You" row at the foot of the side menu. */
async function openGeneral(page: Page) {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-page-general")).toBeVisible();
}

/** A picture of `what` into MANUT_SHOTS, when it is set, in the theme now showing. */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}

async function theme(page: Page, t: "light" | "dark") {
  await page.evaluate((x) => {
    localStorage.setItem("manut.theme", x);
    document.documentElement.dataset.theme = x;
  }, t);
}

test("in Practice the row says there is no account to delete, and offers nothing", async ({ page }) => {
  await openGeneral(page);
  const row = page.getByTestId("account-delete-row");
  await expect(row).toHaveAttribute("data-status", "practice");
  await expect(row).toContainText("There is no account to delete. Practice mode keeps everything on this Mac.");
  await expect(page.getByTestId("account-delete-open")).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `practice-row-${t}`);
  }
});

test("an owner reads what goes, types the shop's name, deletes, and is signed out and back to Practice", async ({ page }) => {
  await stubShell(page, "owner");
  await openGeneral(page);
  const row = page.getByTestId("account-delete-row");
  await expect(row).toHaveAttribute("data-status", "signed_in");
  await row.scrollIntoViewIfNeeded();
  await shot(page, "owner-row");
  await page.getByTestId("account-delete-open").click();

  const pageEl = page.getByTestId("delete-account");
  await expect(pageEl).toHaveAttribute("data-step", "what");
  await expect(page.getByTestId("delete-goes")).toContainText("Baan Mali, the shop you own: its customers' messages, the replies, the payments, the LINE connection, the team and what it remembers, and your helpers' access.");
  await expect(page.getByTestId("delete-stays")).toContainText("Nothing on this Mac is touched: your coding agents, your files and git stay as they are.");
  await expect(page.getByTestId("delete-stays")).toContainText("Practice mode is unaffected.");
  await expect(pageEl).toContainText("This cannot be undone.");
  // General stays marked in Settings' list while its page shows.
  await expect(page.getByTestId("settings-nav-general")).toHaveAttribute("aria-current", "page");
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `owner-step1-${t}`);
  }

  await page.getByTestId("delete-continue").click();
  await expect(pageEl).toHaveAttribute("data-step", "confirm");
  await expect(page.getByTestId("delete-confirm-step")).toContainText("Delete Baan Mali and your account for good?");
  const confirm = page.getByTestId("delete-confirm");
  const field = page.getByTestId("delete-name-0");
  // The name field takes the focus as the step opens; a name not typed as shown is said beside it, and nothing is sent.
  await expect(field).toBeFocused();
  await field.fill("Baan Mal");
  await confirm.click();
  await expect(page.getByTestId("delete-error")).toHaveText("That is not the shop's name. Type it exactly as it is shown above. Nothing was deleted.");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toBeFocused();
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `owner-step2-wrong-${t}`);
  }
  await field.fill("Baan Mali");
  await expect(page.getByTestId("delete-error")).toHaveCount(0);
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `owner-step2-${t}`);
  }
  expect((await calls(page)).filter((c) => c.path === "/v1/account/deletion")).toEqual([]);

  // Enter in the name field presses Delete account, as the form's one submit.
  await field.press("Enter");
  await expect(pageEl).toHaveAttribute("data-step", "done");
  await expect(page.getByTestId("delete-done")).toContainText("Your account is deleted.");
  await expect(page.getByTestId("delete-done")).toContainText("Deleted with it: Baan Mali.");
  await expect(page.getByTestId("delete-apple")).toHaveText("Sign in with Apple no longer lets Manut AI in.");
  await expect(page.getByTestId("delete-done")).toContainText("This Mac goes back to Practice mode at the next start.");
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `owner-done-${t}`);
  }

  const sent = await calls(page);
  expect(sent.filter((c) => c.path === "/v1/account/deletion")).toEqual([
    { cmd: "api_request", method: "POST", path: "/v1/account/deletion", bearer: "access-1", body: { owned: [{ shop: "pilot:shop-a", name: "Baan Mali" }] } },
  ]);
  // Signed out here without calling the API back, and Practice saved for the next start.
  expect(sent.some((c) => c.cmd === "api_session_clear")).toBe(true);
  expect(sent.filter((c) => c.path === "/v1/auth/session")).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("manut.runtime"))).toBe(JSON.stringify({ mode: "practice" }));
  // General's row says it is done.
  await page.getByTestId("settings-nav-general").click();
  await expect(page.getByTestId("account-delete-row")).toContainText("Your account is deleted.");
});

test("a helper reads that only their account and access go, and presses the red Delete", async ({ page }) => {
  await stubShell(page, "helper");
  await openGeneral(page);
  await page.getByTestId("account-delete-open").click();
  await expect(page.getByTestId("delete-goes")).toContainText("Your access to Baan Mali as a helper. The shop and everything in it stay with its owner.");
  await expect(page.getByTestId("delete-goes")).not.toContainText("payments");
  await page.getByTestId("delete-continue").click();
  await expect(page.getByTestId("delete-confirm-step")).toContainText("Delete your account for good?");
  await expect(page.locator("[data-testid^='delete-name-']")).toHaveCount(0);
  // The safe answer holds the focus.
  await expect(page.getByTestId("delete-keep")).toBeFocused();
  for (const t of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: t });
    await theme(page, t);
    await shot(page, `helper-step2-${t}`);
  }
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("delete-done")).toContainText("You no longer help at Baan Mali.");
  const sent = (await calls(page)).filter((c) => c.path === "/v1/account/deletion");
  expect(sent.map((c) => c.body)).toEqual([{ owned: [] }]);
});

test("Keep my account deletes nothing and goes back to General", async ({ page }) => {
  await stubShell(page, "owner");
  await openGeneral(page);
  await page.getByTestId("account-delete-open").click();
  await page.getByTestId("delete-continue").click();
  await page.getByTestId("delete-keep").click();
  await expect(page.getByTestId("settings-page-general")).toBeVisible();
  expect((await calls(page)).filter((c) => c.path === "/v1/account/deletion")).toEqual([]);
});
