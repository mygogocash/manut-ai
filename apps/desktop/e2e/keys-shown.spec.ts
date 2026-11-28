// Item 167d: each key is taught where its action is. The palette's rows, a button's tooltip and an empty state beside what it
// opens show the key the person set on Settings › General › Keyboard, drawn for this keyboard; the palette's foot says what
// Return and Esc do; and the key sheet (⌘/) lists every key by group with a search, read only, each settable one opening its row
// on the key page. Against the mock bridge. MANUT_SHOTS=<folder> also takes the pictures, dark and light.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { usePlatform } from "./term-find-helpers";
import { chatOpen, openCode } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS || "";

async function mock(op: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "k1", op }));
  });
  ws.close();
}

/** The app on Kami's chat with this Mac's keys as they come (or as `keys` sets them before it loads, as a kept `manut.keys`). */
async function open(page: Page, o: { keys?: Record<string, string[]>; theme?: "dark" | "light" } = {}) {
  await usePlatform(page);
  await page.addInitScript(
    ([keys, theme]) => {
      if (sessionStorage.getItem("__keys")) return;
      sessionStorage.setItem("__keys", "1");
      if (keys) localStorage.setItem("manut.keys", keys as string);
      else localStorage.removeItem("manut.keys");
      if (theme) localStorage.setItem("manut.theme", theme as string);
    },
    [o.keys ? JSON.stringify(o.keys) : "", o.theme ?? ""],
  );
  await page.goto("/");
  await chatOpen(page);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  return { mod: mac ? "Meta" : "Control", shown: (k: string) => (mac ? `⌘${k}` : `Ctrl+${k}`), caps: (...k: string[]) => (mac ? ["⌘", ...k] : ["Ctrl", ...k]) };
}

const esc = (text: string) => text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

/** The panel button's words are Panel, or how many subagents work when some do (the mock's Kami has one): the key ends either. */
const endsWith = (key: string) => new RegExp(`\\(${esc(key)}\\)$`);

/** The caps a key is drawn with, one text for each cap. */
const capsOf = (where: ReturnType<Page["getByTestId"]>) => where.getByTestId("keycaps").first().locator("kbd").allTextContents();

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("⌘/ opens the key sheet over the page: every key by group, a search that filters, and Esc closes it and gives the focus back", async ({ page }) => {
  const { mod, shown } = await open(page);
  await page.getByTestId("composer").focus();
  await page.keyboard.press(`${mod}+/`);
  const sheet = page.getByTestId("keysheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("keysheet-input")).toBeFocused();
  // the page behind did not move
  await expect(page.getByTestId("who").locator(".head-title")).toHaveText("Kami");
  // every group, and every key the app lets the person set, each with its keys as they read them
  for (const g of ["go", "chat", "panels", "terminals", "help"]) await expect(page.getByTestId(`keysheet-group-${g}`)).toBeVisible();
  // a Change for each key the app lets the person set (twelve while this was written), and no more
  const settable = await page.locator('[data-row^="key:"]').count();
  expect(settable).toBeGreaterThanOrEqual(12);
  await expect(page.locator("[data-testid=keysheet-change]")).toHaveCount(settable);
  await expect(sheet.locator('[data-row="key:search"]').getByTestId("keysheet-keys")).toHaveText(shown("K"));
  await expect(sheet.locator('[data-row="key:key-sheet"]').getByTestId("keysheet-keys")).toHaveText(shown("/"));
  // fixed keys are listed with nothing to change
  const card = sheet.locator('[data-row="fixed:key.cardKeys"]');
  await expect(card).toContainText("1 · 2 · 3");
  await expect(card.getByTestId("keysheet-change")).toHaveCount(0);
  // the search keeps the rows whose words or keys hold every word
  await page.getByTestId("keysheet-input").fill("details");
  await expect(page.getByTestId("keysheet-row")).toHaveCount(1);
  await expect(page.getByTestId("keysheet-row")).toContainText("Show or hide Details");
  await expect(page.getByTestId("keysheet-keys")).toHaveText(shown("."));
  await page.getByTestId("keysheet-input").fill(shown("K"));
  await expect(page.getByTestId("keysheet-row").first()).toContainText("Command palette");
  await page.getByTestId("keysheet-input").fill("zzzz");
  await expect(page.getByTestId("keysheet-none")).toHaveText("No shortcut matches “zzzz”");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  // its key closes it too
  await page.keyboard.press(`${mod}+/`);
  await expect(sheet).toBeVisible();
  await page.keyboard.press(`${mod}+/`);
  await expect(sheet).toHaveCount(0);
});

test("the sheet holds the keyboard while it is open: nothing opens behind it, Tab stays inside it, and a click outside closes it", async ({ page }) => {
  const { mod } = await open(page);
  await page.keyboard.press(`${mod}+/`);
  await expect(page.getByTestId("keysheet")).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await page.keyboard.press(`${mod}+,`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("settings-view")).toHaveCount(0);
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=keysheet]")), `Tab ${i}`).toBe(true);
  }
  await page.getByTestId("keysheet-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId("keysheet")).toHaveCount(0);
});

test("Change on a row opens Settings › General › Keyboard at that action, with its Change focused; the foot opens the list", async ({ page }) => {
  const { mod } = await open(page);
  await page.keyboard.press(`${mod}+/`);
  await page.getByTestId("keysheet-input").fill("details");
  await page.getByTestId("keysheet-change").click();
  await expect(page.getByTestId("keysheet")).toHaveCount(0);
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await expect(page.getByTestId("keys-details").getByTestId("keys-change")).toBeFocused();
  // from Settings itself, the sheet's link takes the eye to the list's head
  await page.keyboard.press(`${mod}+/`);
  await page.getByTestId("keysheet-settings").click();
  await expect(page.getByTestId("keysheet")).toHaveCount(0);
  await expect(page.getByTestId("keyboard-head")).toBeInViewport();
  // and Settings has its own button for the sheet
  await page.getByTestId("keys-sheet-open").click();
  await expect(page.getByTestId("keysheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("keysheet")).toHaveCount(0);
});

test("the key the person set is the key every place shows: the menu's tooltips, the palette's foot and rows, the sheet and the Details button", async ({ page }) => {
  const { mod, shown, caps } = await open(page);
  const search = page.getByTestId("menu-search");
  await expect(search).toHaveAttribute("title", `Search (${shown("K")})`);
  await expect(page.getByTestId("who")).toHaveAttribute("title", `Details (${shown(".")})`);
  await expect(page.getByTestId("panel-button")).toHaveAttribute("aria-label", endsWith(shown(".")));
  // set the palette's key to ⌘B on the key page, and Details' to ⌘J's free neighbour ⌘U
  await page.keyboard.press(`${mod}+,`);
  await page.getByTestId("keys-search").getByTestId("keys-change").click();
  await page.keyboard.press(`${mod}+b`);
  await expect(page.getByTestId("keys-search").getByTestId("keys-now")).toHaveText(shown("B"));
  await page.getByTestId("keys-details").getByTestId("keys-change").click();
  await page.keyboard.press(`${mod}+u`);
  await expect(page.getByTestId("keys-details").getByTestId("keys-now")).toHaveText(shown("U"));
  // the menu's Search tooltip follows, and so does the key it names to assistive technology
  await expect(search).toHaveAttribute("title", `Search (${shown("B")})`);
  await expect(search).toHaveAttribute("aria-keyshortcuts", shown("B").replace("⌘", "Meta+").replace("Ctrl+", "Control+"));
  // back on the chat: the Details button's tooltip and the panel button's follow
  await page.keyboard.press(`${mod}+,`);
  await expect(page.getByTestId("settings-view")).toHaveCount(0);
  await expect(page.getByTestId("who")).toHaveAttribute("title", `Details (${shown("U")})`);
  await expect(page.getByTestId("panel-button")).toHaveAttribute("aria-label", endsWith(shown("U")));
  // the palette opens on the new key, and its foot names it
  await page.keyboard.press(`${mod}+b`);
  await expect(page.getByTestId("palette")).toBeVisible();
  expect(await capsOf(page.getByTestId("palette-foot-key"))).toEqual(caps("B"));
  await page.keyboard.press("Escape");
  // the sheet lists both, and Reset all puts the defaults back everywhere
  await page.keyboard.press(`${mod}+/`);
  await page.getByTestId("keysheet-input").fill("palette");
  await expect(page.getByTestId("keysheet-keys")).toHaveText(shown("B"));
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${mod}+,`);
  await page.getByTestId("keys-reset-all").click();
  await expect(search).toHaveAttribute("title", `Search (${shown("K")})`);
  await page.keyboard.press(`${mod}+,`);
  await expect(page.getByTestId("who")).toHaveAttribute("title", `Details (${shown(".")})`);
});

test("an action the person gave no key shows none: a tooltip is its words, a row has no cap, the foot names no key", async ({ page }) => {
  await open(page, { keys: { search: [], "new-session": [], details: [] } });
  const search = page.getByTestId("menu-search");
  await expect(search).toHaveAttribute("title", "Search");
  await expect(search).not.toHaveAttribute("aria-keyshortcuts", /.+/);
  await expect(page.getByTestId("who")).toHaveAttribute("title", "Details");
  await expect(page.getByTestId("panel-button")).not.toHaveAttribute("aria-label", /\(/);
  await expect(page.getByTestId("panel-button")).not.toHaveAttribute("aria-keyshortcuts", /.+/);
  // the palette's own key is none, so the menu's Search button opens it
  await search.click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("palette-foot")).toBeVisible();
  await expect(page.getByTestId("palette-foot-key")).toHaveCount(0);
  await expect(page.locator('[data-testid=palette-row][data-row="do:new-session"]').getByTestId("keycaps")).toHaveCount(0);
  // another action's key is still shown
  await expect(page.locator('[data-testid=palette-row][data-row="do:key-sheet"]').getByTestId("keycaps")).toHaveCount(1);
  await page.keyboard.press("Escape");
  // the sheet says None for them and still offers Change
  await page.keyboard.press(`${(await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control"}+/`);
  const none = page.locator('[data-row="key:new-session"]');
  await expect(none.getByTestId("keysheet-keys")).toHaveText("None");
  await expect(none.getByTestId("keysheet-change")).toHaveCount(1);
});

test("an empty Code page shows the + menu's key beside what opens it: New lane, and the empty terminals' row", async ({ page }) => {
  const { caps, shown } = await open(page);
  await openCode(page);
  const lanes = page.getByTestId("lanes-empty");
  await expect(lanes).toBeVisible();
  expect(await capsOf(lanes.getByTestId("lanes-band"))).toEqual(caps("N"));
  await expect(page.getByTestId("lane-new")).toHaveAttribute("title", new RegExp(`\\(${esc(shown("N"))}\\)$`));
  const start = page.getByTestId("session-start");
  await expect(start).toBeVisible();
  expect(await capsOf(start)).toEqual(caps("N"));
  await expect(page.getByTestId("session-new")).toHaveAttribute("title", `New chat or terminal (${shown("N")})`);
});

test.describe("shots", () => {
  test.skip(!SHOTS, "MANUT_SHOTS unset");
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  for (const theme of ["dark", "light"] as const) {
    test(`keys-shown-${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      const { mod } = await open(page, { theme });
      await page.waitForTimeout(300);
      await page.keyboard.press(`${mod}+k`);
      await expect(page.getByTestId("palette-foot")).toBeVisible();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `palette-${theme}.png`) });
      await page.getByTestId("palette-input").fill("new");
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(SHOTS, `palette-new-${theme}.png`) });
      await page.keyboard.press("Escape");
      await page.keyboard.press(`${mod}+/`);
      await expect(page.getByTestId("keysheet")).toBeVisible();
      await page.mouse.move(2, 2);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `sheet-${theme}.png`) });
      await page.getByTestId("keysheet-input").fill("terminal");
      await page.locator('[data-row="key:terminal"]').hover();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `sheet-terminal-${theme}.png`) });
      await page.keyboard.press("Escape");
      await openCode(page);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `code-empty-${theme}.png`) });
      await page.keyboard.press(`${mod}+,`);
      await page.getByTestId("keys-sheet-open").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(SHOTS, `settings-keyboard-${theme}.png`) });
    });
  }
});
