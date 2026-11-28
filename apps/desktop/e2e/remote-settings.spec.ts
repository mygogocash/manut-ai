// Settings › Sharing and access (item 78b, src/settings/RemotePage.tsx). In the app on its own runtime: the page is
// listed, starts off, and turning the switch on shows the consent sheet first; "Not now" leaves it off, and nothing dials
// the relay. Then each of the page's states drawn on the app's own stylesheets (e2e/remote.html), in light and in dark.
// REMOTE_SHOTS=<dir> keeps each as a PNG to look at.
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.MANUT_PORT || 5307);
const DIR = process.env.REMOTE_SHOTS || "";

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [
          { name: "manut.onboarded", value: "1" },
          { name: "manut.lang", value: "en" },
          { name: "manut.notify.quiet", value: "00:00-00:00" },
        ],
      },
    ],
  },
});

test("the page starts off and asks for consent before anything is turned on", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
  const relay: string[] = [];
  page.on("websocket", (ws) => {
    if (ws.url().includes("/relay/")) relay.push(ws.url());
  });
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-remote").click();
  await expect(page.getByTestId("remote-page")).toBeVisible();
  const toggle = page.getByTestId("remote-switch");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("remote-pair")).toBeDisabled();
  await expect(page.getByTestId("remote-consent")).toHaveCount(0);
  await toggle.click();
  const sheet = page.getByTestId("remote-consent");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("encrypted end to end");
  await expect(sheet).toContainText("[Owner to write:");
  // The switch stays off while the sheet asks.
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  if (DIR) {
    mkdirSync(DIR, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(DIR, "app-consent.png") });
  }
  await page.getByTestId("remote-consent-no").click();
  await expect(page.getByTestId("remote-consent")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(relay).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem("manut.remote"))).toBeNull();
});

for (const theme of ["light", "dark"] as const) {
  test(`each state of the page draws on the app's stylesheets (${theme})`, async ({ page }) => {
    for (const state of ["off", "consent", "unavailable", "ready", "showing", "code", "finishing", "wrong", "paired"]) {
      await page.goto(`/e2e/remote.html?state=${state}&theme=${theme}`);
      await expect(page.getByTestId("remote-page")).toBeVisible();
      if (state === "showing") await expect(page.getByTestId("remote-qr")).toBeVisible();
      if (state === "code") await expect(page.getByTestId("remote-code")).toBeFocused();
      if (state === "ready") {
        // Each paired phone shows its level (item 108b): Watch and Answer offered, its own chosen, Work not offered.
        const levels = page.getByTestId("remote-level");
        await expect(levels).toHaveCount(2);
        await expect(levels.nth(0)).toHaveAttribute("aria-label", "What Somchai's iPhone can do");
        await expect(levels.nth(0).getByRole("radio", { name: "Answer" })).toHaveAttribute("aria-checked", "true");
        await expect(levels.nth(1).getByRole("radio", { name: "Watch" })).toHaveAttribute("aria-checked", "true");
        await expect(levels.nth(1).getByRole("radio")).toHaveText(["Watch", "Answer"]);
        await expect(page.getByTestId("remote-levels-note")).toContainText("A change applies to the phone's next request.");
      }
      // No text under 12px, and no capitals by style, on what this page adds.
      const small = await page.evaluate(() =>
        [...document.querySelectorAll(".rm-card *, .rm-live, .rm .btn, .rm .ui-mode")].filter((el) => parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent),
      );
      expect(small).toEqual([]);
      if (DIR) {
        mkdirSync(DIR, { recursive: true });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(DIR, `${state}-${theme}.png`), fullPage: true });
      }
    }
  });
}
