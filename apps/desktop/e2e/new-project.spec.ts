// Item 100b, parts 1 and 2, against the mock host (window.__manutProjectIcons for the icons, window.__manutFolders for folders
// already there, window.__manutRepoAsk for the GitHub ask's answers):
// 1. a project whose folder keeps an icon shows it, only as an image, on its folder header and in Kit's band; one without keeps
//    the folder glyph;
// 2. New project makes the folder (refusing one with files in it, and one outside the home folder) and lists it at once;
// 3. Make it on GitHub too is the ask: the exact command shown whole, private unless public is chosen, Change takes the ask back,
//    Not now makes nothing, and a Yes runs it once.
// Shots (MANUT_SHOTS=<dir>): the Code page with an icon, the form and the ask, light and dark.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCode } from "./start";

const SHOTS = process.env.MANUT_SHOTS || "";
const SITE = "/home/you/code/baanmali-site";
const APP = "/home/you/code/baanmali-app";
const NEW = "/home/you/code/shop-site";
// a project's own icon with a script and a link in it: drawn only as an image, neither may run
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 16 16"><script>window.__iconRan = true</script><a xlink:href="javascript:window.__iconRan=true"><rect width="16" height="16" rx="4" fill="#2f6f4f"/><path d="M4 8h8M8 4v8" stroke="#fff" stroke-width="2"/></a></svg>`;
const ICON = `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`;

async function setup(page: Page, theme: "dark" | "light" = "light", over: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([theme, site, app, icon, over]) => {
      localStorage.setItem("manut.theme", theme as string);
      // two projects the person added on the Code page, one with its own icon
      localStorage.setItem("manut.term.folders", JSON.stringify({ collapsed: [], order: [site, app], added: [site, app] }));
      const w = window as unknown as Record<string, unknown> & { __opened: string[] };
      w.__manutProjectIcons = { [site as string]: icon };
      w.__manutFolders = { "/home/you/code/full": "full" };
      Object.assign(w, over as Record<string, unknown>);
      w.__opened = [];
      window.open = ((u: string) => {
        w.__opened.push(String(u));
        return null;
      }) as typeof window.open;
    },
    [theme, SITE, APP, ICON, over] as const,
  );
  await page.goto("/");
  await openCode(page);
}

const calls = (page: Page) => page.evaluate(() => (((window as any).__manutSessionCalls ?? []) as any[]).filter((c) => ["project.new", "repo.ask", "repo.settle"].includes(c.op)));
const group = (page: Page, cwd: string) => page.locator(`[data-testid="term-group"][data-cwd="${cwd}"]`);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled", caret: "initial" });
}

async function makeProject(page: Page, path = "~/code/shop-site") {
  await page.getByTestId("np-open").click();
  await expect(page.getByTestId("np-path")).toHaveValue("~/");
  await page.getByTestId("np-path").fill(path);
  await page.getByTestId("np-make").click();
}

test("a project's own icon shows only as an image, on its folder header and in Kit's band; one without keeps the folder glyph", async ({ page }) => {
  await setup(page);
  const img = group(page, SITE).getByTestId("project-icon");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", ICON);
  expect(await img.evaluate((e) => e.tagName)).toBe("IMG");
  await expect(page.getByTestId("kit-panel").getByTestId("project-icon")).toHaveAttribute("src", ICON);
  // nothing of the file is in the page: no svg element of its, no script, and its script never ran
  expect(await page.evaluate(() => [...document.querySelectorAll("script")].some((s) => s.textContent?.includes("__iconRan")))).toBe(false);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__iconRan === true)).toBe(false);
  // the folder without an icon keeps its glyph
  await expect(group(page, APP).getByTestId("project-icon")).toHaveCount(0);
  await expect(group(page, APP).locator(".tg-ic svg")).toHaveCount(1);
});

test("New project makes the folder in the home folder, refuses one with files or one outside, and lists it at once", async ({ page }) => {
  await setup(page);
  await makeProject(page, "~/code/full");
  await expect(page.getByTestId("np-why")).toHaveText("That folder has files in it already. Choose a new folder or an empty one.");
  await page.getByTestId("np-path").fill("/srv/shop-site");
  await page.getByTestId("np-make").click();
  await expect(page.getByTestId("np-why")).toHaveText("A new project goes in a new folder inside your home folder.");
  await page.getByTestId("np-path").fill("~/code/shop-site");
  await page.getByTestId("np-make").click();
  await expect(page.getByTestId("np-made")).toHaveText("shop-site is ready: a new folder with git started in it. It is on this page now.");
  await expect(group(page, NEW)).toBeVisible();
  expect(await calls(page)).toEqual([{ op: "project.new", path: NEW }]);
  // Done closes the panel; nothing was asked of GitHub
  await page.getByTestId("np-done").click();
  await expect(page.getByTestId("np-panel")).toHaveCount(0);
});

test("Make it on GitHub too asks with the exact command, private unless chosen; Change takes it back, Not now makes nothing, a Yes runs it once", async ({ page }) => {
  await setup(page);
  await makeProject(page);
  await page.getByTestId("np-github").click();
  await expect(page.getByTestId("np-name")).toHaveValue("shop-site");
  await expect(page.getByTestId("np-private")).toBeChecked();
  await page.getByTestId("np-public").check();
  await page.getByTestId("np-ask-button").click();
  const ask = page.getByTestId("np-ask");
  await expect(ask).toHaveAttribute("data-visibility", "public");
  await expect(ask.getByTestId("np-plan")).toHaveText(`gh repo create shop-site --public --source ${NEW} --remote origin`);
  await expect(ask.getByTestId("np-ask-who")).toHaveText("Public: anyone on the internet can see it and copy it.");
  // Change: the ask is taken back and the step shows what it was made from
  await ask.getByTestId("np-change").click();
  await expect(page.getByTestId("np-public")).toBeChecked();
  await page.getByTestId("np-private").check();
  await page.getByTestId("np-ask-button").click();
  await expect(page.getByTestId("np-plan")).toHaveText(`gh repo create shop-site --private --source ${NEW} --remote origin`);
  // Not now: nothing is made, and Make it on GitHub too is still beside the project
  await page.getByTestId("np-no").click();
  await expect(page.getByTestId("np-github")).toBeVisible();
  await page.getByTestId("np-github").click();
  await page.getByTestId("np-ask-button").click();
  await page.getByTestId("np-yes").click();
  await expect(page.getByTestId("np-result")).toHaveAttribute("data-outcome", "created");
  await expect(page.getByTestId("np-result")).toContainText("Made you/shop-site on GitHub. Nothing was pushed.");
  await expect(page.getByTestId("np-yes")).toHaveCount(0);
  const c = await calls(page);
  expect(c.filter((x) => x.op === "repo.ask")).toHaveLength(3);
  expect(c.filter((x) => x.op === "repo.settle")).toEqual([
    { op: "repo.settle", path: NEW, yes: false },
    { op: "repo.settle", path: NEW, yes: true, command: `gh repo create shop-site --private --source ${NEW} --remote origin` },
  ]);
});

test("a GitHub ask the shell refuses says why and asks nothing", async ({ page }) => {
  await setup(page, "light", { __manutRepoAsk: { refuse: "not_signed_in" } });
  await makeProject(page);
  await page.getByTestId("np-github").click();
  await page.getByTestId("np-ask-button").click();
  await expect(page.getByTestId("np-why")).toContainText("gh auth login");
  await expect(page.getByTestId("np-ask")).toHaveCount(0);
  expect((await calls(page)).filter((x) => x.op !== "project.new")).toEqual([]);
});

test.describe("shots", () => {
  test.skip(!SHOTS, "MANUT_SHOTS unset");
  for (const theme of ["light", "dark"] as const)
    test(`new project ${theme}`, async ({ page }) => {
      await setup(page, theme);
      await page.mouse.move(2, 2);
      await shot(page, `np-icons-${theme}`);
      await page.getByTestId("np-open").click();
      await page.getByTestId("np-path").fill("~/code/shop-site");
      await shot(page, `np-form-${theme}`);
      await page.getByTestId("np-make").click();
      await page.getByTestId("np-github").click();
      await shot(page, `np-repo-${theme}`);
      await page.getByTestId("np-ask-button").click();
      await expect(page.getByTestId("np-ask")).toBeVisible();
      await shot(page, `np-ask-${theme}`);
      await page.getByTestId("np-yes").click();
      await expect(page.getByTestId("np-result")).toBeVisible();
      await shot(page, `np-done-${theme}`);
    });
});
