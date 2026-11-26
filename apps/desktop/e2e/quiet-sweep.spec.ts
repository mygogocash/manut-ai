// The last sweep of the design audit (item 85i; docs/design-audit.md findings 5, 6, 9, 11, 12, 14, 15, 17, 20 and 21).
// QUIET_SHOTS=<dir> keeps pictures of every menu page and Settings at 1280 and 900 wide, in light and dark, to set beside
// the canvas's boards.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";

const SHOTS = process.env.QUIET_SHOTS;

/** The app on Home, as the canvas's sample owner who gave her name and her shop's in the first-run setup. */
async function start(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript((th) => {
    localStorage.setItem("manut.theme", th);
    localStorage.removeItem("manut.resume");
    localStorage.setItem("manut.shop", JSON.stringify({ person: "Fon", shop: "Baan Mali", sells: "", places: [], main: null }));
  }, theme);
  await page.goto("/");
  await expect(page.getByTestId("page-home")).toBeVisible();
}

test("the side menu is the canvas's 196px, and its foot names the person with their shop; the coding tools' use is on Code, one click away", async ({ page }) => {
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 820 });
    await start(page);
    const side = page.getByTestId("sidebar");
    expect(Math.round((await side.boundingBox())!.width), `at ${width}`).toBe(196);
    await expect(side.locator(".acct-n")).toHaveText("Fon, Baan Mali");
    await expect(side.getByTestId("usage")).toHaveCount(0);
    // the account row is the last thing in the menu, as on the board
    const [acct, box] = await Promise.all([page.getByTestId("nav-settings").boundingBox(), side.boundingBox()]);
    expect(box!.y + box!.height - (acct!.y + acct!.height)).toBeLessThanOrEqual(12);
  }
  await page.getByTestId("menu-code").click();
  await expect(page.getByTestId("page-code").getByTestId("usage")).toBeVisible();
});

const PAGES = ["new", "needs", "team", "code", "artifacts", "customize", "history"] as const;

/** Every icon a person can see on the page that is not 16px with a 1.4 line (the line measured as drawn, so a 24-unit
 *  drawing at 14px reads 1.17). Marks, faces, meters and state glyphs are not icons of the set (src/ui/icons.test.tsx
 *  names them). */
async function offSetIcons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const notIcon = ".face, .sb-mark, [data-agent], .usage-ring, .src-ic, .tk-mark, .th-g, .ss-st, .agent-ic, .model-ic";
    for (const svg of Array.from(document.querySelectorAll("svg"))) {
      const r = svg.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || svg.closest(notIcon) || svg.matches(notIcon)) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(svg.contains(hit) || hit.contains(svg) || svg.parentElement?.contains(hit))) continue;
      const shape = svg.querySelector("path, circle, rect");
      const vb = Number((svg.getAttribute("viewBox") ?? "0 0 16 16").split(/\s+/)[2]);
      const line = shape ? (parseFloat(getComputedStyle(shape).strokeWidth) * r.width) / vb : 0;
      if (Math.round(r.width) !== 16 || Math.round(r.height) !== 16 || Math.abs(line - 1.4) > 0.02)
        out.push(`${Math.round(r.width)}x${Math.round(r.height)} line ${line.toFixed(2)} in ${svg.parentElement?.className}`);
    }
    return out;
  });
}

test("one icon set: every icon on the menu's pages and in Settings is the brand's, 16px with a 1.4 line", async ({ page }) => {
  test.setTimeout(90_000);
  await start(page);
  for (const row of PAGES) {
    await page.getByTestId(`menu-${row}`).click();
    await expect(page.getByTestId(row === "new" ? "page-home" : `page-${row}`)).toBeVisible();
    expect(await offSetIcons(page), row).toEqual([]);
  }
  await page.getByTestId("nav-settings").click();
  for (const id of ["general", "voice", "terminal", "providers", "worktrees", "source", "artifacts", "mcp", "workflows", "developer"]) {
    await page.getByTestId(`settings-nav-${id}`).click();
    await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible();
    expect(await offSetIcons(page), id).toEqual([]);
  }
});

test("the command menu is the Search board's: 34px rows of an icon and its word, groups in sentence case on grey bands", async ({ page }) => {
  await start(page);
  await page.getByTestId("menu-search").click();
  await expect(page.getByTestId("palette")).toBeVisible();
  const rows = page.getByTestId("palette-row");
  expect(await rows.count()).toBeGreaterThan(5);
  for (const r of await rows.all()) {
    expect(Math.round((await r.boundingBox())!.height)).toBe(34);
    await expect(r.locator("> svg.ic")).toHaveCount(1);
    expect(Math.round((await r.locator("> svg.ic").boundingBox())!.width)).toBe(16);
  }
  const head = page.getByTestId("palette-group-go").locator(".pal-h");
  await expect(head).toHaveText("Go to");
  expect(await head.evaluate((e) => [getComputedStyle(e).textTransform, getComputedStyle(e).letterSpacing, getComputedStyle(e).fontSize])).toEqual(["none", "normal", "13px"]);
  expect(await head.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  if (SHOTS) for (const theme of ["light", "dark"] as const) {
    await page.evaluate((th) => document.documentElement.setAttribute("data-theme", th), theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `palette-${theme}.png`), animations: "disabled" });
  }
});

test("Team's Pause everyone is the quiet button, and Customize says it did not load in the board's words, the raw error under Details", async ({ page }) => {
  await start(page);
  await page.getByTestId("menu-team").click();
  const pause = page.getByTestId("pause-open");
  await expect(pause).toBeVisible();
  const [c, b, danger] = await pause.evaluate((e) => {
    const probe = document.createElement("i");
    probe.style.color = "var(--aui-danger)";
    document.body.append(probe);
    const d = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(e).color, getComputedStyle(e).borderTopColor, d];
  });
  expect(c).not.toBe(danger);
  expect(b).not.toBe(danger);

  // the stand-in runtime has no memory or routines to read: a failure the app did not word for people
  await page.getByTestId("menu-customize").click();
  const failed = page.getByTestId("memory-failed");
  await expect(failed.locator(".banner")).toHaveText("This page did not load. Nothing was changed.Try again");
  await expect(page.getByTestId("memory-failed-details")).toBeHidden();
  // what shows (not what is in the shut Details) has no raw error
  expect(await page.getByTestId("page-customize").innerText()).not.toContain("no such op");
  await failed.locator("summary").click();
  await expect(page.getByTestId("memory-failed-details")).toHaveText("no such op: memory.list");
  await page.getByTestId("memory-failed-retry").click();
  await expect(page.getByTestId("memory-failed")).toBeVisible();
  if (SHOTS) for (const theme of ["light", "dark"] as const) {
    await page.evaluate((th) => document.documentElement.setAttribute("data-theme", th), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `customize-failed-${theme}.png`), animations: "disabled" });
  }
});

test("pictures of every menu page and Settings, at 1280 and 900, light and dark", async ({ page }) => {
  test.skip(!SHOTS, "QUIET_SHOTS=<dir> keeps the pictures");
  test.setTimeout(240_000);
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 820 });
      await start(page, theme);
      for (const row of PAGES) {
        await page.getByTestId(`menu-${row}`).click();
        await page.waitForTimeout(600);
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS!, `${row}-${width}-${theme}.png`), animations: "disabled" });
      }
      await page.getByTestId("nav-settings").click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(SHOTS!, `settings-${width}-${theme}.png`), animations: "disabled" });
    }
  }
});
