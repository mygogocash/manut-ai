// Appearance: colour sets, bubble styles and text size change the chat live and are remembered.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatOpen } from "./start";
import { tokenColor } from "./tokens";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "__shots__");

test.use({ colorScheme: "dark" });

async function mock(op: string): Promise<any> {
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
    ws.send(JSON.stringify({ id: "x1", op }));
  });
  ws.close();
  return reply.result;
}

async function open(page: Page) {
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

const css = (page: Page, testId: string, prop: string) =>
  page
    .getByTestId(testId)
    .first()
    .locator(".b")
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

async function appearance(page: Page) {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("appearance")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mock("mock.reset");
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("kept")) {
      localStorage.removeItem("manut.look");
      localStorage.removeItem("manut.theme");
    }
  });
});

test("defaults: the manut colours, the Chat board's look (an answer on the page) at the board's sizes", async ({ page }) => {
  await open(page);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-palette", "manut");
  await expect(html).toHaveAttribute("data-bubbles", "open");
  await expect(html).toHaveAttribute("data-text", "medium");
  // item 85f: the answer in the serif at 17px / 1.65 with no bubble; the person's message alone in one, at 15px / 1.5
  expect(await css(page, "bubble-bot", "font-size")).toBe("17px");
  expect(parseFloat(await css(page, "bubble-bot", "line-height"))).toBeCloseTo(17 * 1.65, 1);
  expect(await css(page, "bubble-bot", "font-family")).toMatch(/^"Source Serif 4", "Noto Serif Thai", Georgia, serif$/);
  expect(await css(page, "bubble-bot", "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await css(page, "bubble-user", "font-size")).toBe("15px");
  expect(await css(page, "bubble-user", "line-height")).toBe("22.5px");
  // the default colour set takes the design tokens (packages/ui-kit), as the fork restyled it
  expect(await css(page, "bubble-user", "background-color")).toBe(await tokenColor(page, "--bub-me"));
  expect(await page.getByTestId("composer").evaluate((e) => getComputedStyle(e).fontSize)).toBe("15px");
});

test("a look saved before the board's: its old defaults read as today's, a real choice stays", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("kept")) localStorage.setItem("manut.look", JSON.stringify({ palette: "forest", bubbles: "soft", text: "small" }));
  });
  await open(page);
  const html = page.locator("html");
  // the colour set it had saved is read as the brand's (item 85i); its old default bubbles and text read as today's
  await expect(html).toHaveAttribute("data-palette", "manut");
  await expect(html).toHaveAttribute("data-bubbles", "open");
  await expect(html).toHaveAttribute("data-text", "medium");
});

test("no colour to pick: the brand's colours are everyone's, and a set the picker once saved reads as the brand's (item 85i)", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("kept")) localStorage.setItem("manut.look", JSON.stringify({ palette: "ocean", bubbles: "solid", text: "large" }));
  });
  await open(page);
  // the saved set is read and put aside without a word; the rest of the look is kept
  await expect(page.locator("html")).toHaveAttribute("data-palette", "manut");
  await expect(page.locator("html")).toHaveAttribute("data-bubbles", "solid");
  await expect(page.locator("html")).toHaveAttribute("data-text", "large");
  expect(await css(page, "bubble-user", "background-image")).toContain("linear-gradient");
  // Settings, General has no colour picker: the audit's first rule, "no accent for the person to pick"
  await appearance(page);
  await expect(page.getByTestId("appearance")).toBeVisible();
  await expect(page.getByTestId("appearance").getByRole("radiogroup", { name: "Colour" })).toHaveCount(0);
  await expect(page.locator("[data-testid^=palette-manut], [data-testid^=palette-ocean], .ap-sw")).toHaveCount(0);
  await expect(page.getByTestId("appearance")).not.toContainText("Graphite");
});

test("bubble styles: soft puts the answer in a bubble too; solid puts yours in the accent; open is the board's", async ({ page }) => {
  await open(page);
  await appearance(page);
  await page.getByTestId("bubbles-seg").getByRole("radio", { name: "Soft" }).click();
  await expect(page.getByTestId("bubbles-hint")).toHaveText("Both sides in quiet tinted bubbles");
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await css(page, "bubble-bot", "background-color")).toBe(await tokenColor(page, "--bub-bot"));
  expect(await css(page, "bubble-bot", "padding-left")).toBe("13px");
  // still the serif at the reading size inside its bubble
  expect(await css(page, "bubble-bot", "font-size")).toBe("17px");

  await appearance(page);
  await page.getByTestId("bubbles-seg").getByRole("radio", { name: "Solid" }).click();
  await expect(page.getByTestId("bubbles-hint")).toHaveText("Your messages in the accent colour");
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await css(page, "bubble-user", "background-image")).toContain("linear-gradient");
  expect(await css(page, "bubble-user", "color")).toBe(await tokenColor(page, "--on-accent"));

  await appearance(page);
  await page.getByTestId("bubbles-seg").getByRole("radio", { name: "Open" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await css(page, "bubble-bot", "background-color")).toBe("rgba(0, 0, 0, 0)");
  expect(await css(page, "bubble-bot", "padding-left")).toBe("0px");
  // your bubble is back to the soft tint under "open"
  expect(await css(page, "bubble-user", "background-image")).toBe("none");
});

test("text size moves answers, messages and the composer a step along the board's scale; every choice survives a reload", async ({ page }) => {
  await open(page);
  await appearance(page);
  await page.getByTestId("text-seg").getByRole("radio", { name: "Small" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await css(page, "bubble-bot", "font-size")).toBe("15px");
  expect(await css(page, "bubble-user", "font-size")).toBe("14px");
  await appearance(page);
  await page.getByTestId("text-seg").getByRole("radio", { name: "Large" }).click();
  await page.getByTestId("bubbles-seg").getByRole("radio", { name: "Soft" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(await css(page, "bubble-bot", "font-size")).toBe("20px");
  expect(await css(page, "bubble-user", "font-size")).toBe("17px");
  expect(await page.getByTestId("composer").evaluate((e) => getComputedStyle(e).fontSize)).toBe("17px");
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("manut.look"))) ?? "{}")).toEqual({
    palette: "manut",
    bubbles: "soft",
    text: "large",
    v: 2,
  });
  await page.evaluate(() => sessionStorage.setItem("kept", "1"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "manut");
  // chosen since the board's look: kept
  await expect(page.locator("html")).toHaveAttribute("data-bubbles", "soft");
  await expect(page.locator("html")).toHaveAttribute("data-text", "large");
});

test("a bad saved look falls back to the defaults", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("manut.look", '{"palette":"neon","bubbles":"round","text":9}'));
  await open(page);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "manut");
  await expect(page.locator("html")).toHaveAttribute("data-bubbles", "open");
  await expect(page.locator("html")).toHaveAttribute("data-text", "medium");
});

test("screenshots: the chat in several looks, and the Appearance page", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 760 });
  await open(page);
  await page.getByTestId("composer").fill("Check the 502s please");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "expired keep-alive" })).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("composer").blur();
  const set = (look: Record<string, string>, theme: string) =>
    page.evaluate(
      async ([l, t]) => {
        const m = await import(/* @vite-ignore */ "/src/state/store.ts");
        m.getStore().actions.setLook(l);
        m.getStore().actions.setTheme(t);
      },
      [look, theme] as const,
    );
  const looks: [string, Record<string, string>, string][] = [
    ["look-manut-soft-dark", { palette: "manut", bubbles: "soft", text: "small" }, "dark"],
    ["look-manut-solid-dark", { palette: "manut", bubbles: "solid", text: "small" }, "dark"],
    ["look-manut-open-dark", { palette: "manut", bubbles: "open", text: "medium" }, "dark"],
    ["look-manut-soft-light", { palette: "manut", bubbles: "soft", text: "small" }, "light"],
    ["look-manut-solid-light", { palette: "manut", bubbles: "solid", text: "small" }, "light"],
    ["look-manut-open-light", { palette: "manut", bubbles: "open", text: "medium" }, "light"],
  ];
  for (const [name, look, theme] of looks) {
    await set(look, theme);
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
  await set({ palette: "manut", bubbles: "soft", text: "small" }, "dark");
  await appearance(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, "appearance-dark.png") });
});
