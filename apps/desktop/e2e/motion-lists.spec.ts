// Lists and pages arrive once (item 85c, docs/motion.md "Lists and pages"): the first time Team opens in a session its
// rows rise in order, the page's body fades in under a header that stays still, and a second visit, a re-render or a
// filter animates nothing. Each move is held at its start, middle and end with the Web Animations API (as
// motion-shots.spec.ts does), so a frame is the same on a fast Mac and a loaded runner. With reduced motion the rows are
// already in place. LIST_SHOTS=<dir> keeps the frames as PNGs to look at.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { usePlatform } from "./term-find-helpers";
import { chatOpen } from "./start";

const DIR = process.env.LIST_SHOTS || "";

type Moment = "start" | "middle" | "end";

/** The finite moves running under `root` now (loops such as a working dot are not arrivals). */
const arrivals = (root: Locator) => root.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).map((a) => (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? "?").length);

/** Hold every finite move under `root` at `at` of its own length, delay included. */
const hold = (root: Locator, at: Moment) =>
  root.evaluate((el, at) => {
    const anims = el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    for (const a of anims) {
      a.pause();
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      a.currentTime = at === "start" ? 0 : at === "middle" ? end / 2 : end;
    }
    return anims.length;
  }, at);

const release = (root: Locator) => root.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).forEach((a) => a.finish()));

const opacity = (row: Locator) => row.evaluate((el) => Number(getComputedStyle(el).opacity));

const still = (page: Page) =>
  page.waitForFunction(() => !document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity), undefined, { polling: "raf" });

async function begin(page: Page, theme: "dark" | "light", reduced: boolean) {
  if (DIR) mkdirSync(DIR, { recursive: true });
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await usePlatform(page);
  await page.goto("/");
  await chatOpen(page);
  await still(page);
}

test.describe("lists arrive once", () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  for (const theme of ["light", "dark"] as const) {
    test(`Team's rows rise in order the first time, and the header stays still (${theme})`, async ({ page }) => {
      await begin(page, theme, false);
      await page.getByTestId("menu-team").click();
      const body = page.locator('[data-testid="page-team"] .mpage-body');
      const rows = page.locator('[data-testid="page-team"] li.tli');
      await expect(rows.first()).toBeVisible();
      const last = rows.last();
      expect(await rows.count(), "there is a list to arrive").toBeGreaterThan(1);
      const header = page.locator('[data-testid="page-team"] header.top');
      expect(await header.evaluate((el) => el.getAnimations({ subtree: true }).length), "the header does not move").toBe(0);
      const page_ = page.getByTestId("page-team");
      expect(await hold(page_, "start")).toBeGreaterThan(0);
      expect(await opacity(rows.first()), "the first row starts out of sight").toBeLessThan(0.1);
      if (DIR) await page.screenshot({ path: join(DIR, `team-${theme}-start.png`) });
      await hold(page_, "middle");
      const mid = await opacity(rows.first());
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThanOrEqual(1);
      if (DIR) await page.screenshot({ path: join(DIR, `team-${theme}-middle.png`) });
      await hold(page_, "end");
      expect(await opacity(rows.first())).toBe(1);
      expect(await opacity(last)).toBe(1);
      if (DIR) await page.screenshot({ path: join(DIR, `team-${theme}-end.png`) });
      await release(page_);
      await expect(body).not.toHaveClass(/arriving/);
    });
  }

  test("a second visit and a re-render animate nothing", async ({ page }) => {
    await begin(page, "light", false);
    await page.getByTestId("menu-team").click();
    await expect(page.locator('[data-testid="page-team"] li.tli').first()).toBeVisible();
    await still(page);
    await page.getByTestId("menu-history").click();
    await expect(page.getByTestId("page-history")).toBeVisible();
    await still(page);
    await page.getByTestId("menu-team").click();
    const team = page.getByTestId("page-team");
    await expect(team.locator("li.tli").first()).toBeVisible();
    // the list itself: the pause side's own hint has a Rise of its own, which is not this item's
    expect(await arrivals(team.locator("ul.rows")), "the rows do not move on the way back").toBe(0);
    expect(await team.locator(".mo-rise").count()).toBe(0);
    await expect(team.locator(".mpage-body")).not.toHaveClass(/arriving/);
    // a re-render: the page's clock ticks and the members are read again
    await page.waitForTimeout(300);
    expect(await arrivals(team.locator("ul.rows"))).toBe(0);
  });

  test("Home does not rise again when it is drawn again by typing and picking a suggestion", async ({ page }) => {
    await begin(page, "light", false);
    await page.getByTestId("menu-new").click();
    await expect(page.getByTestId("page-home")).toBeVisible();
    await still(page);
    const home = page.getByTestId("page-home");
    await page.getByTestId("home-ask").fill("hello");
    await page.getByTestId("home-mode-chat").click().catch(() => {});
    await expect(home.locator(".mo-rise")).toHaveCount(0);
    expect(await arrivals(home)).toBe(0);
  });

  test("with reduced motion the rows are already in place", async ({ page }) => {
    await begin(page, "light", true);
    await page.getByTestId("menu-team").click();
    const rows = page.locator('[data-testid="page-team"] li.tli');
    await expect(rows.first()).toBeVisible();
    await expect.poll(() => arrivals(page.getByTestId("page-team")), { timeout: 300, intervals: [16, 16, 32, 50] }).toBe(0);
    expect(await opacity(rows.first())).toBe(1);
  });
});
