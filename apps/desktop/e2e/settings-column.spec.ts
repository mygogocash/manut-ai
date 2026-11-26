// Settings as one quiet column (item 85h; docs/design-audit.md findings 4, 10, 13, 19 and 20): the everyday pages first,
// the developer pages under one "Under the hood" entry that a deep link opens, Home's pill as the one segmented switch,
// the canvas's scale and rhythm, tokens in the dark Appearance preview, and the list stacked above the page at 900 wide.
// Every other spec starts with the hood left open (playwright.config.ts); these start as everyone does, with it closed.
// SETTINGS_SHOTS=<dir> keeps pictures of General, Voice, a bot's page and two developer pages, at 1280 and 900 wide, in
// light and dark, to set beside the canvas's Settings board.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";

const SHOTS = process.env.SETTINGS_SHOTS;

/** The app as a returning person who never opened "Under the hood": its remembered state removed once, before the first
 *  load, so a reload keeps what the page itself writes. */
async function fresh(page: Page, theme: "light" | "dark" = "light") {
  await page.addInitScript((th) => {
    if (sessionStorage.getItem("hood-fresh")) return;
    sessionStorage.setItem("hood-fresh", "1");
    localStorage.removeItem("manut.settings.hood");
    localStorage.setItem("manut.theme", th);
  }, theme);
  await page.goto("/");
}

async function settings(page: Page) {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
}

const mod = (page: Page) => page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));

test("the everyday pages come first; the developer pages wait under one entry, which opens, turns and is remembered", async ({ page }) => {
  await fresh(page);
  await settings(page);
  const hood = page.getByTestId("settings-hood");
  await expect(hood).toHaveText("Under the hood");
  await expect(hood).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("settings-hood-list")).toHaveCount(0);
  await expect(page.getByTestId("settings-nav-terminal")).toHaveCount(0);
  const names = await page.locator(".st-nav button").allTextContents();
  expect(names.slice(0, 2)).toEqual(["General", "Voice"]);
  expect(names.at(-1)).toBe("Under the hood");

  // the chevron turns with the Switch move, as the kit's accordion's does
  const chevron = hood.locator(".st-hood-ic");
  expect(await chevron.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.25s");
  await hood.click();
  await expect(hood).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("settings-hood-list").locator("button")).toHaveText([
    "Terminal", "Providers", "Computer", "Worktrees", "Source control", "Artifacts", "MCP and Skills", "Workflows", "Developer", "Report a problem",
  ]);
  await motionDone(page);
  // turned half a turn: the matrix of rotate(180deg), read to two places
  expect(await chevron.evaluate((el) => Array.from(new DOMMatrix(getComputedStyle(el).transform).toFloat64Array().slice(0, 2), (v) => Math.round(v * 100) / 100 + 0))).toEqual([-1, 0]);
  await page.getByTestId("settings-nav-workflows").click();
  await expect(page.getByTestId("settings-page-workflows")).toBeVisible();
  await expect(page.getByTestId("settings-nav-workflows")).toHaveAttribute("aria-current", "page");

  // left open, it stays open next time; closed, it is closed next time
  await page.reload();
  await settings(page);
  await expect(page.getByTestId("settings-hood")).toHaveAttribute("aria-expanded", "true");
  await page.getByTestId("settings-hood").click();
  await expect(page.getByTestId("settings-hood-list")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("manut.settings.hood"))).toBeNull();
});

test("a deep link to a developer page opens the hood with that page chosen: the palette, and a page's own button", async ({ page }) => {
  await fresh(page);
  const key = await mod(page);
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("settings terminal");
  // the list has taken the words before Enter picks its first row: on a loaded machine the press could land on the list
  // as it was before them, whose first row is New (seen in a batch at load 8.7, 26 Nov)
  await expect(page.getByTestId("palette-row").first()).toHaveText("Settings › Terminal");
  // the row is clicked, not taken by Enter: a pointer resting over the list can move the palette's cursor to another row
  // (a chat that matches the words) as the list fills in, which Enter then opens; the palette's own spec covers its keys
  await page.getByTestId("palette-row").first().click();
  // a cold dev server compiles the Settings pages on first use
  await expect(page.getByTestId("settings-page-terminal")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("settings-hood")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("settings-nav-terminal")).toHaveAttribute("aria-current", "page");

  // closed while one of its pages shows, the page stays and the entry holds it
  await page.getByTestId("settings-hood").click();
  await expect(page.getByTestId("settings-page-terminal")).toBeVisible();
  await expect(page.getByTestId("settings-hood")).toHaveClass(/holds/);

  // a link from elsewhere (the Artifacts page's Settings button calls the same openSettings) opens the hood again
  await page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSettings(p: string): void } } };
    store.getStore().actions.openSettings("artifacts");
  });
  await expect(page.getByTestId("settings-page-artifacts")).toBeVisible();
  await expect(page.getByTestId("settings-hood")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("settings-nav-artifacts")).toHaveAttribute("aria-current", "page");
});

test("the text is on the scale, groups are grey bands in sentence case, and rows, buttons and fields keep the rhythm", async ({ page }) => {
  await fresh(page);
  await settings(page);
  const view = page.getByTestId("settings-view");
  await motionDone(page);
  const look = await view.evaluate((root) => {
    const small: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || !el.getClientRects().length || el.closest("[aria-hidden=true]")) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) small.push(`${el.className} ${size}px "${n.textContent.trim().slice(0, 20)}"`);
    }
    const css = (sel: string) => getComputedStyle(root.querySelector(sel)!);
    const heights = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
    const band = css(".st-gh");
    return {
      small,
      band: { transform: band.textTransform, spacing: band.letterSpacing, weight: band.fontWeight, size: band.fontSize, height: Math.round(root.querySelector(".st-gh")!.getBoundingClientRect().height) },
      bandBg: band.backgroundColor,
      pageBg: getComputedStyle(root).backgroundColor,
      rows: heights(".st-row"),
      buttons: heights(".st-btn"),
      fields: heights("input.dev-in"),
      body: css(".st-k b").fontSize,
      page: Math.round(root.querySelector(".st-page")!.getBoundingClientRect().width),
    };
  });
  expect(look.small).toEqual([]);
  expect(look.band).toEqual({ transform: "none", spacing: "normal", weight: "600", size: "13px", height: 32 });
  expect(look.bandBg).not.toBe(look.pageBg);
  expect(Math.min(...look.rows)).toBeGreaterThanOrEqual(44);
  expect(look.buttons.length).toBeGreaterThan(0);
  for (const h of look.buttons) expect(h).toBe(34);
  expect(look.fields.length).toBeGreaterThan(0); // the quiet hours' two time fields
  for (const h of look.fields) expect(h).toBe(40);
  expect(look.body).toBe("14px");
  expect(look.page).toBeLessThanOrEqual(696);
});

test("Settings' segmented switches are Home's 28px pill", async ({ page }) => {
  await fresh(page);
  await page.getByTestId("menu-home").click();
  const pill = (el: Element) => {
    const cs = getComputedStyle(el);
    return { height: Math.round(el.getBoundingClientRect().height), size: cs.fontSize, weight: cs.fontWeight, radius: parseFloat(cs.borderTopLeftRadius) > 100 };
  };
  const home = await page.getByTestId("home-mode-team").evaluate(pill);
  await settings(page);
  const theme = await page.getByTestId("theme-seg").getByRole("radio", { name: "System" }).evaluate(pill);
  expect(theme).toEqual(home);
  expect(theme).toEqual({ height: 28, size: "13px", weight: "500", radius: true });
});

test("dark: the Appearance preview's chip reads, dark words on the light accent", async ({ page }) => {
  await fresh(page, "dark");
  await settings(page);
  const [fg, bg] = await page.locator(".ap-pv-chip").evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.color, cs.backgroundImage];
  });
  const lum = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const stop = bg.match(/rgba?\([^)]*\)/)![0];
  const [hi, lo] = [lum(fg), lum(stop)].sort((a, b) => b - a);
  expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThan(4.5);
});

for (const width of [1280, 900]) {
  test(`at ${width} wide the page has room: ${width === 900 ? "the list stacks above it" : "the list sits beside it"}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await fresh(page);
    await settings(page);
    await motionDone(page);
    const box = await page.getByTestId("settings-view").evaluate((root) => {
      const r = (sel: string) => root.querySelector(sel)!.getBoundingClientRect();
      return { nav: r(".st-nav").toJSON(), body: r(".st-body").toJSON(), view: root.getBoundingClientRect().toJSON(), over: document.documentElement.scrollWidth > innerWidth };
    });
    expect(box.over).toBe(false);
    if (width === 900) {
      // two columns, the side menu and the page; the list runs across the top
      expect(box.nav.bottom).toBeLessThanOrEqual(box.body.top + 1);
      expect(box.body.width).toBe(box.view.width);
      expect(box.nav.width).toBe(box.view.width);
    } else {
      expect(box.nav.right).toBeLessThanOrEqual(box.body.left + 1);
      expect(box.nav.width).toBe(196);
    }
    expect(box.body.width).toBeGreaterThan(560);
    // the developer pages join the run when opened, and nothing scrolls sideways
    await page.getByTestId("settings-hood").click();
    await page.getByTestId("settings-nav-providers").click();
    await expect(page.getByTestId("settings-page-providers")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

test("pictures of Settings beside the canvas's board (SETTINGS_SHOTS)", async ({ page }) => {
  test.skip(!SHOTS, "set SETTINGS_SHOTS to a folder to keep the pictures");
  await fresh(page);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((th) => localStorage.setItem("manut.theme", th), theme);
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await settings(page);
      for (const id of ["general", "voice", "bot:kami", "terminal", "providers"]) {
        await page.evaluate(async (pid) => {
          const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSettings(p: string): void } } };
          store.getStore().actions.openSettings(pid);
        }, id);
        await expect(page.getByTestId(`settings-page-${id.replace(":", "-")}`)).toBeVisible();
        await page.mouse.move(5, 5);
        await motionDone(page);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(SHOTS!, `settings-${id.replace(":", "-")}-${width}-${theme}.png`) });
      }
    }
  }
});
