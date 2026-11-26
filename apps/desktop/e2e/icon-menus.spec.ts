// Every menu led by an icon, and each provider by its own logo (item 122, the owner's request of 26 Nov 2026).
// ICON_SHOTS=<dir> keeps pictures of the screens the owner named, at 1280 and 900 wide, in light and dark, to set beside
// the canvas's boards.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";
import { chatOpen, openSettings } from "./start";

const SHOTS = process.env.ICON_SHOTS;
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

/** One op to the mock bridge (as inbox.spec.ts sends them). */
async function mock(op: string, params: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "im1", op, ...params }));
  });
  ws.close();
}

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
    });

/** Each entry of the open menu `menu`: the left edge of its icon and of its words, its icon's size, and its height. */
async function column(page: Page, menu: string, entry: string, icon: string, words: string) {
  return page.locator(menu).locator(entry).evaluateAll(
    (els, [ic, w]) =>
      els.map((e) => {
        const i = e.querySelector(ic)!.getBoundingClientRect();
        // the entry's words: its first text that is not inside the icon's slot
        const scope = [...e.querySelectorAll(w)].find((n) => n.textContent?.trim()) ?? e;
        const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        let node: Node | null = null;
        while ((node = walk.nextNode()) && (!node.textContent?.trim() || node.parentElement?.closest(ic)));
        const range = document.createRange();
        range.selectNodeContents(node ?? scope);
        const r = [...range.getClientRects()].find((x) => x.width > 0) ?? range.getBoundingClientRect();
        return { icon: Math.round(i.left), size: `${Math.round(i.width)}x${Math.round(i.height)}`, words: Math.round(r.left), gap: Math.round(r.left - i.right), h: Math.round(e.getBoundingClientRect().height) };
      }),
    [icon, words] as const,
  );
}

/** Every entry leads with a 16px icon, all icons on one column, all words on one column, the same 10px between. */
function oneColumn(rows: { icon: number; size: string; words: number; gap: number }[], gap = 10) {
  expect(rows.length).toBeGreaterThan(1);
  expect(new Set(rows.map((r) => r.size))).toEqual(new Set(["16x16"]));
  expect(new Set(rows.map((r) => r.icon)).size).toBe(1);
  expect(new Set(rows.map((r) => r.words)).size).toBe(1);
  expect(new Set(rows.map((r) => r.gap))).toEqual(new Set([gap]));
}

test("Settings' list: every entry leads with its icon, on one column of icons and one of words", async ({ page }) => {
  await start(page, "light", 1280);
  await openSettings(page, "providers");
  const rows = await column(page, ".st-nav", ":scope > button, .st-hood-list > button", ".st-nav-i, .face, .ui-av", ".st-nav-n");
  // the team's members lead with their faces at 18px; every other entry with a 16px icon
  const icons = rows.filter((r) => r.size === "16x16");
  expect(icons.length).toBeGreaterThanOrEqual(14);
  expect(new Set(icons.map((r) => r.icon)).size).toBe(1);
  expect(new Set(icons.map((r) => r.words)).size).toBe(1);
  expect(new Set(icons.map((r) => r.gap))).toEqual(new Set([10]));
});

for (const theme of ["light", "dark"] as const)
  for (const width of [1280, 900])
    test(`the chat box's + menu, its model menu and a History row's menu lead every entry with an icon (${theme}, ${width})`, async ({ page }) => {
      await mock("mock.reset");
      await mock("mock.threads", { bot: "kami", threads: [{ title: "Late parcels", ago: 60 }, { title: "The 12.12 teaser", ago: 120 }] });
      await start(page, theme, width);
      await chatOpen(page);
      await page.getByTestId("attach").click();
      await expect(page.getByTestId("attach-menu")).toBeVisible();
      oneColumn(await column(page, "[data-testid=attach-menu]", ":scope > .att-row", ".att-ic > *", ".att-n"));
      await shoot(page, `plus-menu-${theme}-${width}`);
      await page.keyboard.press("Escape");
      const pill = page.getByTestId("model-pill");
      if (await pill.count()) {
        await pill.click();
        await expect(page.getByTestId("model-pop")).toBeVisible();
        await shoot(page, `model-menu-${theme}-${width}`);
        await page.keyboard.press("Escape");
      }
      // a chat's row in the side menu's Recent chats, as inbox.spec.ts opens its menu
      const row = page.locator(".sb-recent .rec-li").filter({ hasText: "Late parcels" });
      await row.hover();
      await row.getByTestId("row-more").click();
      const menu = page.getByTestId("row-menu");
      await expect(menu).toBeVisible();
      const rows = await column(page, "[data-testid=row-menu]", "[role=menuitem]", ".mi-ic > *", ":scope");
      oneColumn(rows);
      // the canvas's menu row: 34px
      expect(new Set(rows.map((r) => r.h))).toEqual(new Set([34]));
      // keyboard focus is unchanged: the first entry has it, and the icons are hidden from a screen reader
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      expect(await menu.locator(".mi-ic").evaluateAll((els) => els.every((e) => e.getAttribute("aria-hidden") === "true"))).toBe(true);
      await shoot(page, `row-menu-${theme}-${width}`);
    });

