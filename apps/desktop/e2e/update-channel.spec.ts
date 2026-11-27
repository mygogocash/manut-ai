// Settings › General › Updates › Channel (item 111): Stable or Nightly, kept on this Mac. The page names a channel to the
// shell and never an address (src/sidebar/updateChannel.ts), so what is checked here is the choice, that it is kept, and
// that the Mac App Store edition shows no such row (its own spec, app-store.spec.ts, shows the store's line instead).
import { expect, test } from "@playwright/test";
import { chatOpen } from "./start";

test("Settings › General › Updates offers Stable and Nightly, starts on Stable and keeps the choice on this Mac", async ({ page }) => {
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  const system = page.getByTestId("set-system");
  await expect(system).toContainText("Updates");
  const seg = page.getByTestId("update-channel-seg");
  await expect(seg).toBeVisible();
  await expect(seg).toContainText("Stable");
  await expect(seg).toContainText("Nightly");
  await expect(seg.getByRole("radio", { name: "Stable" })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("manut.update.channel"))).toBeNull();

  await seg.getByRole("radio", { name: "Nightly" }).click();
  expect(await page.evaluate(() => localStorage.getItem("manut.update.channel"))).toBe("nightly");

  // kept: a reload comes back on Nightly
  await page.reload();
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("update-channel-seg").getByRole("radio", { name: "Nightly" })).toBeChecked();

  // and back to Stable leaves nothing behind
  await page.getByTestId("update-channel-seg").getByRole("radio", { name: "Stable" }).click();
  expect(await page.evaluate(() => localStorage.getItem("manut.update.channel"))).toBeNull();
});

test("the Mac App Store edition has no channel row", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__manutAppStore = true;
  });
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("set-system")).toContainText("Mac App Store");
  await expect(page.getByTestId("update-channel-seg")).toHaveCount(0);
});
