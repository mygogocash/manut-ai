// Item 99: the person sets an app-wide shortcut in Settings › General › Keyboard. Change waits for the new keys, and nothing
// else takes them meanwhile (the palette does not open); keys another action has are refused with why; the new keys work at
// once and after a reload (kept on this Mac); Reset all puts every default back.
import { expect, test } from "@playwright/test";
import { usePlatform } from "./term-find-helpers";
import { chatOpen } from "./start";

test("a shortcut set in Settings: refused when taken, works at once and after a reload, and Reset all puts it back", async ({ page }) => {
  await usePlatform(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__keys")) {
      sessionStorage.setItem("__keys", "1");
      localStorage.removeItem("manut.keys");
    }
  });
  await page.goto("/");
  await chatOpen(page);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const mod = mac ? "Meta" : "Control";
  const shown = (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`);

  await page.keyboard.press(`${mod}+,`);
  await expect(page.getByTestId("settings-view")).toBeVisible();
  const row = page.getByTestId("keys-details");
  await expect(row.getByTestId("keys-now")).toHaveText(shown("."));

  // Change, then the palette's keys: refused, and the palette did not open behind
  await row.getByTestId("keys-change").click();
  await expect(row.getByTestId("keys-wait")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("keys-refused")).toHaveText(`${shown("K")} is already used for Command palette: go anywhere, do anything.`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  // then free keys: set
  await page.keyboard.press(`${mod}+b`);
  await expect(row.getByTestId("keys-now")).toHaveText(shown("B"));
  await expect(row.getByTestId("keys-reset")).toBeVisible();

  // they work at once: Details opens from the chat
  await page.keyboard.press(`${mod}+,`);
  await expect(page.getByTestId("settings-view")).toHaveCount(0);
  const details = page.getByTestId("details");
  await page.keyboard.press(`${mod}+b`);
  await expect.poll(async () => Math.round((await details.boundingBox())?.width ?? 0)).toBe(300);
  await page.keyboard.press(`${mod}+b`);
  await expect.poll(async () => Math.round((await details.boundingBox())?.width ?? 0)).toBeLessThan(2);

  // and after a reload, from this Mac's storage
  await page.reload();
  await chatOpen(page);
  await page.keyboard.press(`${mod}+b`);
  await expect.poll(async () => Math.round((await details.boundingBox())?.width ?? 0)).toBe(300);

  // Reset all: the default is back
  await page.keyboard.press(`${mod}+,`);
  await page.getByTestId("keys-reset-all").click();
  await expect(page.getByTestId("keys-details").getByTestId("keys-now")).toHaveText(shown("."));
  await expect(page.getByTestId("keys-reset-all")).toHaveCount(0);
});
