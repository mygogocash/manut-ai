// The Mac App Store edition (docs/app-store.md) as the page shows it. No App Store build here: `window.__manutAppStore`
// is the stand-in src/appStore.ts reads (it can only turn the edition on), and `window.__manutUpdateHost` holds an update
// that the edition must never even ask about (Guideline 2.4.5(vii)). A missing agent offers no install line: its
// tooltip and the Providers page say why instead.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatOpen, openCode } from "./start";

const SHOTS = process.env.MANUT_SHOTS || "";

async function open(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t: string) => {
    localStorage.setItem("manut.theme", t);
    localStorage.removeItem("manut.sessions.recent");
    const w = window as unknown as Record<string, unknown>;
    w.__manutAppStore = true;
    w.__manutPickFolder = "/home/you/code/web-app";
    w.__manutMockAgents = ["claude", "codex"];
    const calls: string[] = [];
    w.__updCalls = calls;
    w.__manutUpdateHost = {
      check: async () => {
        calls.push("check");
        return { version: "9.9.9", install: async () => calls.push("install") };
      },
      relaunch: async () => calls.push("relaunch"),
    };
  }, theme);
  await page.goto("/");
  await chatOpen(page);
}

const updCalls = (page: Page) => page.evaluate(() => (window as unknown as { __updCalls: string[] }).__updCalls);

async function shot(page: Page, testId: string, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.getByTestId(testId).screenshot({ path: join(SHOTS, name) });
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Settings › General says the Mac App Store keeps it up to date, and no update is asked for`, async ({ page }) => {
    await open(page, theme);
    await page.getByTestId("nav-settings").click();
    const system = page.getByTestId("set-system");
    await expect(system).toContainText("Updates");
    await expect(system).toContainText("This edition comes from the Mac App Store, which keeps it up to date. It does not update itself.");
    await expect(system).toContainText("Mac App Store");
    await system.scrollIntoViewIfNeeded();
    await shot(page, "set-system", `app-store-updates-${theme}.png`);
    // an update was waiting, and nothing asked for it: no check, no button
    expect(await updCalls(page)).toEqual([]);
    await expect(page.getByTestId("update-btn")).toHaveCount(0);
  });
}

test("a missing agent offers no install line, and says why where the line was", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "dark");
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  await openCode(page);
  await page.getByTestId("session-new").click();
  const menu = page.getByTestId("session-menu");
  await menu.getByTestId("session-more").click();
  const row = menu.getByTestId("session-agent-qwen");
  await expect(row).toContainText("Not installed");
  await expect(row).toHaveAttribute("title", "qwen was not found on this computer · The App Store edition does not install programs: install it yourself, and Manut AI finds it here");
  await expect(menu.getByTestId("session-install-qwen")).toHaveCount(0);
  // pressed, it copies nothing and starts nothing
  await row.click({ force: true });
  await expect(row).not.toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("untouched");
  await page.keyboard.press("Escape");

  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await page.getByTestId("provider-open-qwen").click();
  const note = page.getByTestId("provider-install-store");
  await expect(note).toHaveText("The App Store edition does not install programs: install it yourself, and it is found here");
  await expect(page.getByTestId("provider-detail")).not.toContainText("npm install");
  await shot(page, "provider-detail", "app-store-provider-dark.png");
});
