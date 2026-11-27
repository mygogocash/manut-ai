// The owner's ask of 27 Nov 2026: the side menu slides and can be sized, a button hides or shows all of it, and Home's mode sits
// at the top left as ChatGPT names its model. Dragging the menu's edge sets its width and a double click gives the canvas's back;
// Hide in its top row hides it and the button at the top left (or ⌘⇧S) shows it again; both are kept after a reload. The mode
// picker opens a menu of the modes, and a pick changes what Home's box asks.
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { usePlatform } from "./term-find-helpers";
import { chatOpen } from "./start";

const SHOTS = process.env.SIDEBAR_SHOTS || "test-results";
const width = (page: Page) => page.getByTestId("sidebar").evaluate((el) => Math.round(el.getBoundingClientRect().width));

test("the side menu is sized by its edge, hidden and shown again by its buttons and ⌘⇧S, kept after a reload", async ({ page }) => {
  await usePlatform(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("__side")) {
      sessionStorage.setItem("__side", "1");
      localStorage.removeItem("manut.side.width");
      localStorage.removeItem("manut.side.hidden");
    }
  });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/");
  await chatOpen(page);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  const mod = mac ? "Meta" : "Control";
  await expect.poll(() => width(page)).toBe(196);

  // drag the edge 84px to the right: the menu follows, and the width is kept
  const edge = page.getByTestId("side-resizer");
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 84, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => width(page)).toBe(280);
  await page.reload();
  await chatOpen(page);
  await expect.poll(() => width(page)).toBe(280);

  // Hide: the menu goes, the button at the top left brings it back
  await page.getByTestId("menu-hide").click();
  await expect.poll(() => width(page)).toBe(0);
  await expect(page.getByTestId("side-show")).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "sidebar-hidden.png") });
  await page.getByTestId("side-show").click();
  await expect.poll(() => width(page)).toBe(280);
  await expect(page.getByTestId("side-show")).toHaveCount(0);

  // ⌘⇧S hides and shows it, and a hidden menu stays hidden after a reload
  await page.keyboard.press(`${mod}+Shift+S`);
  await expect.poll(() => width(page)).toBe(0);
  await page.reload();
  await expect(page.getByTestId("side-show")).toBeVisible();
  await expect.poll(() => width(page)).toBe(0);
  await page.keyboard.press(`${mod}+Shift+S`);
  await expect.poll(() => width(page)).toBe(280);

  // a double click on the edge gives the canvas's width back
  await page.getByTestId("side-resizer").dblclick();
  await expect.poll(() => width(page)).toBe(196);
});

test("Home's mode at the top left: a menu of the modes, and a pick changes what the box asks", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("menu-home").click();
  const pick = page.getByTestId("home-mode-pick");
  await expect(page.getByTestId("home-mode-now")).toHaveText("Team");
  await expect(page.getByTestId("home-ask")).toHaveAttribute("placeholder", "What should the team work on next?");
  await pick.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByTestId("home-mode-team")).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: join(SHOTS, "home-mode-picker.png") });
  await page.getByTestId("home-mode-chat").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("home-mode-now")).toHaveText("Chat");
  await expect(page.getByTestId("home-ask")).toHaveAttribute("placeholder", "Ask anything, in Thai or English");
  // Esc closes the menu and gives the focus back to the button
  await pick.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(pick).toBeFocused();
});
