// Use outside Manut AI (item 106): the Code page's lines under "Your coding plans", their table, and the one switch in
// Settings › Providers. A plain browser has no shell, so the spec stands in for it (`window.__manutOutsideHost`) with
// made-up numbers and records each read and cancel. Pictures go to MANUT_SHOTS_DIR, light and dark.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, openCode, openSettings } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS_DIR || join(dirname(fileURLToPath(import.meta.url)), "__shots__");

async function mock(op: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "o1", op }));
  });
  ws.close();
}

function installHost() {
  const w = window as any;
  w.__outside = { scans: [] as { tool: string; exclude: string[] }[], cancels: [] as number[] };
  const now = Math.floor(Date.now() / 1000);
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const row = (n: number, project: string, total: number) => ({ day: day(n), project, input: total / 4, output: total / 4, cache_read: total / 4, cache_write: total / 4, total });
  w.__manutOutsideHost = {
    scan: async (tool: string, exclude: string[]) => {
      w.__outside.scans.push({ tool, exclude });
      const rows = tool === "claude" ? [row(0, "shop-site", 182_400), row(0, "notes", 12_000), row(1, "shop-site", 1_240_000), row(3, "", 880)] : [row(2, "shop-api", 56_000)];
      const today = rows.filter((r) => r.day === day(0)).reduce((n, r) => n + r.total, 0);
      const week = rows.reduce((n, r) => n + r.total, 0);
      return { tool, rows, today, week, read_at: now, files_read: 4, files_cached: 0, skipped: { links: 0, too_big: 1, not_json: 0, compressed: tool === "codex" ? 6 : 0, app_started: 2, over_limit: 0 }, partial: false };
    },
    cancel: async (id: number) => void w.__outside.cancels.push(id),
  };
}

async function openOnCode(page: Page, theme: "dark" | "light", on: boolean) {
  await page.addInitScript((a) => {
    localStorage.setItem("manut.theme", a.theme);
    if (a.on) localStorage.setItem("manut.outsideuse", "1");
  }, { theme, on });
  await page.addInitScript(installHost);
  await page.goto("/");
  await chatOpen(page);
  await openCode(page);
  await expect(page.getByTestId("code-plans")).toBeVisible();
}

test.beforeEach(async () => {
  await mock("mock.reset");
  mkdirSync(SHOTS, { recursive: true });
});

for (const theme of ["light", "dark"] as const) {
  test(`off by default: one quiet line, nothing read (${theme})`, async ({ page }) => {
    await openOnCode(page, theme, false);
    await expect(page.getByTestId("outside-off")).toContainText("Counting them reads each tool's own files on this Mac.");
    expect(await page.evaluate(() => (window as any).__outside.scans.length)).toBe(0);
    await page.getByTestId("code-plans").screenshot({ path: join(SHOTS, `outside-off-${theme}.png`) });
  });

  test(`on: today and this week per tool, a table on a click, where it comes from (${theme})`, async ({ page }) => {
    await openOnCode(page, theme, true);
    const claude = page.getByTestId("outside-claude");
    await expect(claude).toContainText("Claude Code outside Manut AI");
    await expect(page.getByTestId("outside-claude-n")).toHaveText("194k today · 1.4M this week");
    await expect(page.getByTestId("outside-codex-n")).toHaveText("0 today · 56k this week");
    await expect(page.getByTestId("outside-note")).toContainText("A plan's percentage is only what the tool itself reported.");
    await expect(page.getByTestId("outside-note")).toContainText("Last read");
    await expect(page.getByTestId("outside-skipped")).toHaveText("8 files skipped: links, too large, not readable, or compressed files that could not be unpacked.");
    await expect(page.getByTestId("outside-claude-table")).toHaveCount(0);
    await page.getByTestId("outside-claude-details").click();
    const rows = page.getByTestId("outside-claude-table").locator("tbody tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("shop-site");
    await expect(rows.nth(3)).toContainText("No folder named");
    // no money anywhere on the lines
    expect(await page.getByTestId("outside-use").innerText()).not.toMatch(/[$฿€£]|USD/);
    // the plans' own rings are untouched
    await expect(page.getByTestId("usage-codex").getByTestId("usage-fill")).toHaveClass(/lv-amber/);
    await page.getByTestId("code-plans").screenshot({ path: join(SHOTS, `outside-on-${theme}.png`) });
  });
}

test("the switch in Settings turns the lines on and off, and a close cancels what is being read", async ({ page }) => {
  await openOnCode(page, "light", false);
  await page.getByTestId("outside-turn-on").click();
  await expect(page.getByTestId("settings-page-providers")).toBeVisible();
  const sw = page.getByTestId("outside-switch");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("outside-row")).toContainText("Nothing is changed or sent.");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  expect(await page.evaluate(() => localStorage.getItem("manut.outsideuse"))).toBe("1");
  await page.screenshot({ path: join(SHOTS, "outside-switch-light.png") });
  await openCode(page);
  await expect(page.getByTestId("outside-claude")).toBeVisible();
  // leaving the page (the lines unmount) cancels any read still running; here the reads are done, so only the page's own
  // switch off stops new ones
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await page.getByTestId("outside-switch").click();
  await openCode(page);
  await expect(page.getByTestId("outside-off")).toBeVisible();
  const scans = await page.evaluate(() => (window as any).__outside.scans.length);
  expect(scans).toBe(2);
});
