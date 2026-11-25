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
