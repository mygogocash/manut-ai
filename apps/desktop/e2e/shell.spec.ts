// Shell: sidebar, timeline bubbles, composer send/stop, theme, header right side, screenshots.
import { expect, test, type Page } from "@playwright/test";
import { tokenColor } from "./tokens";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatOpen, openChat } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "__shots__");

// Headless Chromium reports a light OS scheme; the sketch default is dark.
test.use({ colorScheme: "dark" });

/** One request to the mock bridge over its own websocket (mock.reset, mock.calls). */
async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

async function setTheme(page: Page, theme: "system" | "dark" | "light") {
  await page.evaluate(async (t) => {
    const m = await import(/* @vite-ignore */ "/src/state/store.ts");
    m.getStore().actions.setTheme(t);
  }, theme);
}

async function open(page: Page) {
  await page.goto("/");
  // the start opens Kami's chat (playwright.config.ts)
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("sidebar lists the mock bots and search filters them", async ({ page }) => {
  test.skip(true, "the sidebar's bot list, live ring and bot search left with it; Team lists the members, Customize holds Automations and Plugins, History has the search");
  await open(page);
  const side = page.getByTestId("sidebar");
  for (const name of ["Kami", "Friren", "Hermes"]) await expect(side.getByText(name, { exact: true })).toBeVisible();
  await expect(side.getByText("manut", { exact: true })).toBeVisible();
  for (const nav of ["Settings", "You"]) await expect(side.getByText(nav, { exact: true })).toBeVisible();
  // Automations (with every bot's job count) and Plugins open their pages
  await expect(side.getByTestId("nav-automations")).toHaveText("Automations6");
  await expect(side.getByTestId("nav-plugins")).toHaveText("Plugins");
  for (const id of ["nav-automations", "nav-plugins"]) await expect(side.getByTestId(id)).toBeEnabled();
  // Kami starts running in the mock -> live ring around its face
  await expect(page.getByTestId("bot-kami").getByTestId("live-ring")).toBeVisible();
  await page.getByLabel("Search bots and terminals").fill("fri");
  await expect(page.getByTestId("bot-friren")).toBeVisible();
  await expect(page.getByTestId("bot-kami")).toHaveCount(0);
  await expect(page.getByTestId("bot-default")).toHaveCount(0);
  await page.getByLabel("Search bots and terminals").fill("");
  await expect(page.getByTestId("bot-default")).toBeVisible();
});

test("select Kami shows history as the Chat board draws it; switching bots swaps the chat", async ({ page }) => {
  await open(page);
  await openChat(page, "friren");
  await expect(page.getByTestId("timeline").getByText("Summarise the Tauri 2 updater docs.")).toBeVisible();
  await openChat(page, "kami");
  const tl = page.getByTestId("timeline");
  await expect(tl.getByText("gateway 502 로그 좀 봐줄래?")).toBeVisible();
  await expect(tl.getByText("Thanks. Ping me when the retry fix is up.")).toBeVisible();
  // markdown: inline code inside the bot bubble
  await expect(tl.getByTestId("bubble-bot").locator("code").first()).toHaveText("/v1/responses");
  // item 85f: the answer stands on the page (no fill, no border, no corner); only the person's message is a bubble,
  // filled with the design tokens' quiet fill, no border, the corner --r-bubble (the design kit's 16px)
  const look = (id: string) =>
    tl.getByTestId(id).first().locator(".b").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopWidth, radius: parseFloat(cs.borderTopLeftRadius) };
    });
  expect(await look("bubble-bot")).toEqual({ bg: "rgba(0, 0, 0, 0)", border: "0px", radius: 0 });
  expect(await look("bubble-user")).toEqual({ bg: await tokenColor(page, "--bub-me"), border: "0px", radius: 16 });
  await expect(page.getByTestId("header").getByText("Kami", { exact: true })).toBeVisible();
});

test("Enter sends: user bubble, Stop during the turn, reply bubble arrives", async ({ page }) => {
  await open(page);
  const box = page.getByTestId("composer");
  await box.fill("line one");
  await box.press("Shift+Enter");
  await box.pressSequentially("line two");
  await expect(box).toHaveValue("line one\nline two");
  await box.fill("Check the 502s please");
  await box.press("Enter");
  await expect(box).toHaveValue("");
  const tl = page.getByTestId("timeline");
  await expect(tl.getByTestId("bubble-user").filter({ hasText: "Check the 502s please" })).toBeVisible();
  await expect(page.getByTestId("stop")).toBeVisible();
  await expect(tl.getByTestId("bubble-bot").filter({ hasText: "expired keep-alive connections" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("stop")).toHaveCount(0);
  await expect(page.getByTestId("send")).toBeVisible();
  const calls = (await mock("mock.calls")).calls.filter((c: any) => c.op === "chat.send");
  expect(calls).toEqual([expect.objectContaining({ params: expect.objectContaining({ bot: "kami", text: "Check the 502s please" }) })]);
});

test("Stop interrupts the running turn", async ({ page }) => {
  await open(page);
  await page.getByTestId("composer").fill("long job");
  await page.getByTestId("composer").press("Enter");
  await page.getByTestId("stop").click();
  await expect(page.getByTestId("stop")).toHaveCount(0);
  const ops = (await mock("mock.calls")).calls.map((c: any) => c.op);
  expect(ops).toContain("chat.interrupt");
});

test("slash shows the skill hint when the bot has no skill list", async ({ page }) => {
  await mock("mock.noSkills", { bot: "kami" });
  await open(page);
  await page.getByTestId("composer").fill("/pl");
  await expect(page.getByTestId("skill-hint")).toBeVisible();
  await page.getByTestId("composer").fill("hello /plan");
  await expect(page.getByTestId("skill-hint")).toHaveCount(0);
});

test("header right holds the panel button alone, the model is in the chat box; name toggles the details column", async ({ page }) => {
  await open(page);
  const right = page.getByTestId("head-right");
  // item 85f: no model name and no maker's mark in the header (the Chat board); the model and its effort moved into the
  // box, beside where item 80 put Buddy's
  await expect(right.locator(":scope > *")).toHaveCount(1);
  await expect(right.locator(":scope > *").last()).toHaveAttribute("data-testid", "panel-button");
  await expect(page.getByTestId("header")).not.toContainText("Opus 5.5");
  await expect(page.getByTestId("header").locator("[data-testid=model-pill], .src-ic, .model-ic")).toHaveCount(0);
  const box = page.locator(".cw");
  await expect(box.getByTestId("model-label")).toHaveText("Opus 5.5");
  await expect(box.getByTestId("reasoning-label")).toHaveText("high");
  const details = page.getByTestId("details");
  expect((await details.boundingBox())?.width ?? 0).toBeLessThan(2);
  await page.getByTestId("who").click();
  await expect.poll(async () => Math.round((await details.boundingBox())?.width ?? 0)).toBe(300);
  await page.getByTestId("who").click();
  await expect.poll(async () => Math.round((await details.boundingBox())?.width ?? 0)).toBeLessThan(2);
});

test("theme follows the store; dark and light screenshots", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.removeItem("manut.theme"));
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // a finished turn in the timeline makes the shot closer to the sketch
  await page.getByTestId("composer").fill("Check the 502s please");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "expired keep-alive" })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer").blur();
  await page.screenshot({ path: join(SHOTS, "shell-dark.png") });

  // The store's setTheme (same module instance the app uses; Vite serves it by URL).
  await setTheme(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
  const bg = await page.getByTestId("bubble-user").first().locator(".b").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(await tokenColor(page, "--bub-me"));
  await page.getByTestId("composer").blur();
  await page.waitForTimeout(400); // let the 0.2s colour transitions settle
  await page.screenshot({ path: join(SHOTS, "shell-light.png") });

  // persisted, and "system" follows the OS live
  expect(await page.evaluate(() => localStorage.getItem("manut.theme"))).toBe("light");
  await setTheme(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
