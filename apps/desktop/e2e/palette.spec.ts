// The command palette (item 77a): ⌘K and the menu's Search open one box that lists where to go, what to do and the chats
// History finds, against the mock bridge. It adds no power of its own: it goes somewhere or presses what a button presses.
import { expect, test, type Page } from "@playwright/test";
import { usePlatform } from "./term-find-helpers";
import { chatOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "p1") res(msg);
    };
    ws.send(JSON.stringify({ id: "p1", op, ...params }));
  });
  ws.close();
  return reply.result;
}
const calls = async (op: string) => ((await mock("mock.calls")).calls as { op: string }[]).filter((c) => c.op === op);

async function open(page: Page) {
  await usePlatform(page);
  await page.goto("/");
  await chatOpen(page);
}
const mod = (page: Page) => page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));
/** The caps a key is drawn with in a row or in the foot, one text for each cap: ⌘ and N, or Ctrl and N. */
const capsOf = (where: ReturnType<Page["getByTestId"]>) => where.getByTestId("keycaps").first().locator("kbd").allTextContents();
const caps = (page: Page, ...k: string[]) => page.evaluate((keys) => (/Mac/.test(navigator.platform) ? ["⌘", ...keys] : ["Ctrl", ...keys]), k);

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("⌘K opens the palette over the page, Esc closes it and the focus goes back to the chat box", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.getByTestId("composer").focus();
  await page.keyboard.press(`${key}+k`);
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("palette-input")).toBeFocused();
  // the page behind did not move: the chat is still the view
  await expect(page.getByTestId("who").locator(".head-title")).toHaveText("Kami");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  // the same key closes it too
  await page.keyboard.press(`${key}+k`);
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press(`${key}+k`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
});

test("the menu's Search opens the palette; Go to lists the pages and the arrows and Enter pick", async ({ page }) => {
  await open(page);
  await page.getByTestId("menu-search").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  await expect(page.getByTestId("palette-group-go")).toBeVisible();
  await page.getByTestId("palette-input").fill("team");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("menu-team")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("page-team")).toBeVisible();
});

test("typing goes to a Settings page and starts a new chat, and an ask is never settled from it", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("settings voice");
  await expect(page.getByTestId("palette-row")).toHaveCount(2); // the Voice page and the History row
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-page-voice")).toBeVisible();

  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("new thread with");
  await page.getByTestId("palette-row").first().click();
  await expect.poll(async () => (await calls("thread.create")).length).toBe(1);
  await expect(page.getByTestId("thread-chat")).toBeVisible();
  // nothing was approved, sent or removed on the way
  expect((await calls("chat.send")).length).toBe(0);
  expect((await calls("approval.respond")).length).toBe(0);
});

test("Search History for ... opens History with the words in its box", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("502");
  await page.getByTestId("palette-row").last().click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  const box = page.getByRole("searchbox", { name: "Search history" });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("502");
});

test("an action whose place is not open is not listed: the microphone only with a chat box, Pause everyone only on Team", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.getByTestId("menu-code").click();
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("pause");
  await expect(page.getByTestId("palette-row")).toHaveCount(1); // the History row alone
  await page.keyboard.press("Escape");
  await page.getByTestId("menu-team").click();
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("pause everyone");
  await expect(page.getByTestId("palette-row").first()).toContainText("Pause everyone");
  await page.keyboard.press("Enter");
  // only the page's own question opened (or, on a bridge that cannot pause, its own "not yet"); nothing was paused
  await expect(page.getByTestId("pause-dialog").or(page.getByTestId("pause-error"))).toBeVisible();
  expect((await calls("team.pause")).length).toBe(0);
});

test("a row shows the key of its action as the person set it, and the foot says what Return and Esc do and which key opens the palette (item 167d)", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.keyboard.press(`${key}+k`);
  const foot = page.getByTestId("palette-foot");
  await expect(foot).toBeVisible();
  await expect(foot).toContainText("opens the marked row");
  await expect(foot).toContainText("closes");
  await expect(foot.getByTestId("palette-foot-key")).toContainText("opens this menu from any screen");
  expect(await capsOf(page.getByTestId("palette-foot-key"))).toEqual(await caps(page, "K"));
  await expect(foot.locator("kbd").first()).toHaveText(await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Return" : "Enter")));
  const row = (id: string) => page.locator(`[data-testid=palette-row][data-row="${id}"]`);
  // New chat or terminal: its key opens the same + menu; the side menu's and the key sheet's own rows carry theirs
  expect(await capsOf(row("do:new-session"))).toEqual(await caps(page, "N"));
  await expect(row("do:new-session")).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+N$/);
  expect(await capsOf(row("do:key-sheet"))).toEqual(await caps(page, "/"));
  await expect(row("do:key-sheet")).toContainText("Show every shortcut");
  await expect(row("do:side-menu")).toContainText("Show or hide the side menu");
  // Settings › General is found by typing, and ⌘, opens Settings
  await page.getByTestId("palette-input").fill("settings general");
  expect(await capsOf(row("go:settings:general"))).toEqual(await caps(page, ","));
  // a row whose action has no key shows none
  await page.getByTestId("palette-input").fill("report");
  await expect(row("do:report-problem")).toBeVisible();
  await expect(row("do:report-problem").getByTestId("keycaps")).toHaveCount(0);
  // picking the key sheet's row opens it, with the palette gone and nothing else changed
  await page.getByTestId("palette-input").fill("every shortcut");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("keysheet")).toBeVisible();
  await expect(page.getByTestId("who").locator(".head-title")).toHaveText("Kami");
});

test("the palette follows the key set on the key page: its foot and its rows name the new key, and a key the person gave none is not shown", async ({ page }) => {
  await open(page);
  const key = await mod(page);
  await page.keyboard.press(`${key}+,`);
  await page.getByTestId("keys-new-session").getByTestId("keys-change").click();
  await page.keyboard.press(`${key}+u`);
  await page.getByTestId("keys-search").getByTestId("keys-change").click();
  await page.keyboard.press(`${key}+b`);
  await page.keyboard.press(`${key}+,`);
  await expect(page.getByTestId("settings-view")).toHaveCount(0);
  await page.keyboard.press(`${key}+b`);
  await expect(page.getByTestId("palette")).toBeVisible();
  expect(await capsOf(page.getByTestId("palette-foot-key"))).toEqual(await caps(page, "B"));
  expect(await capsOf(page.locator('[data-testid=palette-row][data-row="do:new-session"]'))).toEqual(await caps(page, "U"));
  // the old key opens nothing now
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${key}+k`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
});
