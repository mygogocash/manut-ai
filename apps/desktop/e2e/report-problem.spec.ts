// Settings › Report a problem (item 105): the report shows, Copy puts it on the clipboard, the agent action puts it in a new
// coding chat's box without sending it, and the issue action asks first, naming the address, before the browser is opened.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { motionDone } from "./motion";
import { chatOpen, openSettings } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
/** Where the pictures go (unset: none are taken). */
const SHOTS = process.env.MANUT_SHOTS || "";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
}

type Call = { op: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));

test.beforeEach(async ({ page }) => {
  await mock("mock.reset");
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__manutReportSystem = { app: "0.1.1", macos: "26.1", chip: "Apple M2" };
    // the clipboard and the browser are stood in, so what they were given can be read
    w.__written = [];
    w.__opened = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s: string) => void (w.__written as string[]).push(s) }, configurable: true });
    window.open = ((u: string) => void (w.__opened as string[]).push(String(u))) as typeof window.open;
  });
  await page.goto("/");
  await chatOpen(page);
  // a problem this run met, from the page's own error hook
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { message: "the agent would not start: exit 1" })));
  await openSettings(page, "report");
  await expect(page.getByTestId("report-text")).toHaveAttribute("data-ready", "true");
});

test("shows the report in a read-only block, with the facts and the last problem", async ({ page }) => {
  const text = await page.getByTestId("report-text").innerText();
  expect(text).toContain("Manut AI problem report");
  expect(text).toContain("App: Manut AI 0.1.1 (GitHub)");
  expect(text).toContain("macOS: 26.1");
  expect(text).toContain("Chip: Apple M2");
  expect(text).toContain("the agent would not start: exit 1");
  expect(text).not.toMatch(/\/home\/you|@/);
  expect(await page.getByTestId("report-text").evaluate((e) => e.tagName)).toBe("PRE");
});

test("Copy puts the report on the clipboard and says so", async ({ page }) => {
  await page.getByTestId("report-copy").click();
  await expect(page.getByTestId("report-copy")).toHaveText("Copied");
  const written = await page.evaluate(() => (window as unknown as { __written: string[] }).__written);
  expect(written).toHaveLength(1);
  expect(written[0]).toContain("Manut AI problem report");
});

test("the agent action puts the report in a new coding chat's box and sends nothing", async ({ page }) => {
  // the agent chip opens the app's agent menu; the three controls of the row share one 34px line
  const heights = await page.evaluate(() => ["report-agent", "report-folder", "report-ask"].map((id) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!.getBoundingClientRect().height));
  expect(heights).toEqual([34, 34, 34]);
  await page.getByTestId("report-agent").click();
  await expect(page.getByTestId("report-agent-menu").getByTestId("report-agent-pick").first()).toBeVisible();
  await page.getByTestId("report-agent-pick").first().click();
  await page.getByTestId("report-ask").click();
  await expect(page.getByTestId("composer")).toHaveValue(/Manut AI problem report/);
  await expect(page.getByTestId("composer")).toHaveValue(/the agent would not start/);
  await page.waitForTimeout(300);
  const ops = (await calls(page)).map((c) => c.op);
  expect(ops.filter((o) => o === "chat.start" || o === "start" || o === "input" || o === "chat.input")).toEqual([]);
});

test("the issue action asks first, naming the address, and opens the browser only on a yes", async ({ page }) => {
  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  await page.getByTestId("report-issue").click();
  const ask = page.getByTestId("report-issue-ask");
  await expect(ask).toContainText("https://github.com/mygogocash/manut-ai/issues/new");
  await expect(ask).toContainText("anyone who can see that repository's issues");
  expect(await opened()).toEqual([]);
  // no is no
  await page.getByTestId("report-issue-cancel").click();
  await expect(ask).toHaveCount(0);
  expect(await opened()).toEqual([]);
  await page.getByTestId("report-issue").click();
  await page.getByTestId("report-issue-open").click();
  const urls = await opened();
  expect(urls).toHaveLength(1);
  expect(urls[0]).toMatch(/^https:\/\/github\.com\/mygogocash\/manut-ai\/issues\/new\?title=/);
  expect(decodeURIComponent(urls[0])).toContain("Manut AI problem report");
});

test("the palette lists the action and opens the page", async ({ page }) => {
  const key = (await page.evaluate(() => navigator.platform)).includes("Mac") ? "Meta" : "Control";
  await page.keyboard.press(`${key}+k`);
  const input = page.getByTestId("palette-input");
  await expect(input).toBeVisible();
  await input.fill("Report a problem");
  const row = page.getByTestId("palette-row").filter({ hasText: /^Report a problem$/ }).first();
  await expect(row).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("report-page")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  for (const width of [1280, 900]) {
    test(`picture: ${theme} at ${width}`, async ({ page }) => {
      test.skip(!SHOTS, "pictures only when MANUT_SHOTS names a folder");
      await page.setViewportSize({ width, height: 820 });
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await motionDone(page);
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `report-${theme}-${width}.png`) });
      await page.getByTestId("report-issue").click();
      await motionDone(page);
      await page.screenshot({ path: join(SHOTS, `report-ask-${theme}-${width}.png`) });
    });
  }
}
