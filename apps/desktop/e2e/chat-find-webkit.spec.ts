// WebKit is the macOS webview's engine (item 150, find in a chat): the bar opens on Cmd+F, a match in a folded step opens its
// group while it is the current match, matches are painted with the engine's own highlights where it has them and with the
// layer of boxes where it has not (CSS.highlights removed, as the macOS 11 web view has none), and Esc gives the chat box the
// keyboard. e2e/chat-find.spec.ts runs the same in Chromium. CI's macOS job installs WebKit; a local run on a Mac without it
// (`pnpm exec playwright install webkit`) skips this file.
import { existsSync } from "node:fs";
import { expect, test, webkit } from "@playwright/test";
import { bar, bubbles, count, find, goTo, group, input, painted, stage } from "./chat-find";

test.use({ browserName: "webkit", colorScheme: "dark" });
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

const expanded = (page: Parameters<typeof group>[0]) => group(page, 0).getByTestId("activity-toggle").getAttribute("aria-expanded");

test("in WebKit: Cmd+F finds across messages and folded steps, opens the group of the current match, paints it, and Esc gives the box the keyboard", async ({ page }) => {
  await stage(page);
  const before = await bubbles(page);
  await page.getByTestId("composer").focus();
  await find(page);
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await input(page).fill("checkout");
  await expect(count(page)).toHaveText(/^[1-4] of 4$/);
  await goTo(page, "2 of 4");
  await expect.poll(() => expanded(page)).toBe("true");
  const p = await painted(page);
  // this engine has the highlight API, or the boxes mark the match: either way something marks it, and nothing in the messages changed
  expect(p.api ? p.current.length : p.rings).toBe(1);
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("3 of 4");
  await expect.poll(() => expanded(page)).toBe("false");
  expect(await bubbles(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
});

test("in WebKit with no highlight API: boxes mark the matches, the current one ringed, over the very words", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true }));
  await stage(page);
  await find(page);
  await input(page).fill("checkout");
  await goTo(page, "3 of 4");
  expect(await painted(page)).toMatchObject({ api: false, plain: [], current: [] });
  await expect.poll(async () => (await painted(page)).rings).toBe(1);
  await expect.poll(async () => (await painted(page)).boxes).toBeGreaterThanOrEqual(2);
  const ring = (await page.locator(".cf-cur").first().boundingBox())!;
  const words = (await page.getByTestId("bubble-bot").filter({ hasText: "read the checkout file" }).boundingBox())!;
  expect(ring.y).toBeGreaterThanOrEqual(words.y);
  expect(ring.y + ring.height).toBeLessThanOrEqual(words.y + words.height);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cf-box")).toHaveCount(0);
});
