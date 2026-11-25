// The last sweep of the design audit (item 85i; docs/design-audit.md findings 5, 6, 9, 11, 12, 14, 15, 17, 20 and 21).
// QUIET_SHOTS=<dir> keeps pictures of every menu page and Settings at 1280 and 900 wide, in light and dark, to set beside
// the canvas's boards.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";

const SHOTS = process.env.QUIET_SHOTS;

/** The app on Home, as the canvas's sample owner who gave her name and her shop's in the first-run setup. */
async function start(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript((th) => {
    localStorage.setItem("manut.theme", th);
    localStorage.removeItem("manut.resume");
    localStorage.setItem("manut.shop", JSON.stringify({ person: "Fon", shop: "Baan Mali", sells: "", places: [], main: null }));
  }, theme);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
}

test("the side menu is the canvas's 196px, and its foot names the person with their shop; the coding tools' use is on Code, one click away", async ({ page }) => {
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 820 });
    await start(page);
    const side = page.getByTestId("sidebar");
    expect(Math.round((await side.boundingBox())!.width), `at ${width}`).toBe(196);
    await expect(side.locator(".acct-n")).toHaveText("Fon, Baan Mali");
    await expect(side.getByTestId("usage")).toHaveCount(0);
    // the account row is the last thing in the menu, as on the board
    const [acct, box] = await Promise.all([page.getByTestId("nav-settings").boundingBox(), side.boundingBox()]);
    expect(box!.y + box!.height - (acct!.y + acct!.height)).toBeLessThanOrEqual(12);
  }
  await page.getByTestId("menu-code").click();
  await expect(page.getByTestId("page-code").getByTestId("usage")).toBeVisible();
});

const PAGES = ["new", "needs", "team", "code", "artifacts", "customize", "history"] as const;

test("pictures of every menu page and Settings, at 1280 and 900, light and dark", async ({ page }) => {
  test.skip(!SHOTS, "QUIET_SHOTS=<dir> keeps the pictures");
  test.setTimeout(240_000);
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 820 });
      await start(page, theme);
      for (const row of PAGES) {
        await page.getByTestId(`menu-${row}`).click();
        await page.waitForTimeout(600);
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS!, `${row}-${width}-${theme}.png`), animations: "disabled" });
      }
      await page.getByTestId("nav-settings").click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS!, `settings-${width}-${theme}.png`), animations: "disabled" });
    }
  }
});
