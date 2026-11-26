// Every menu led by an icon, and each provider by its own logo (item 122, the owner's request of 26 Nov 2026).
// ICON_SHOTS=<dir> keeps pictures of the screens the owner named, at 1280 and 900 wide, in light and dark, to set beside
// the canvas's boards.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";
import { openCode, openSettings } from "./start";

const SHOTS = process.env.ICON_SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await motionDone(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
}

async function start(page: Page, theme: "light" | "dark", width: number) {
  await page.setViewportSize({ width, height: 820 });
  await page.addInitScript((th) => localStorage.setItem("manut.theme", th), theme);
  await page.goto("/");
}

for (const theme of ["light", "dark"] as const)
  for (const width of [1280, 900])
    test(`pictures: Settings › Providers, the Settings list and the Code page's coding plans (${theme}, ${width})`, async ({ page }) => {
      test.skip(!SHOTS, "pictures only, with ICON_SHOTS");
      await start(page, theme, width);
      await openSettings(page, "providers");
      await shoot(page, `providers-${theme}-${width}`);
      await page.getByTestId("settings-nav-general").click();
      await shoot(page, `settings-list-${theme}-${width}`);
      await page.getByTestId("menu-code").click();
      await expect(page.getByTestId("page-code")).toBeVisible();
      const plans = page.getByTestId("code-plans");
      if (await plans.count()) await plans.scrollIntoViewIfNeeded();
      await shoot(page, `code-${theme}-${width}`);
      void openCode;
    });
