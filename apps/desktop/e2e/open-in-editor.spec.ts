// Open in <editor> (item 107) on the mock host, which records the call and never starts anything: a terminal session row's menu, a
// lane's row menu (the lane's own folder, never the developer's) and the command palette (the open project's folder, the
// developer's own), the failure said in the app's own words, no item while no editor is installed, and Settings › Developer ›
// Editor. Pictures of the menu and the setting go to $MANUT_SHOTS when it is set.
import { expect, test, type Page } from "@playwright/test";
import { openCode, openSettings } from "./start";
import { mock, newTerminal, openApp, usePlatform } from "./term-find-helpers";

const ROOT = "/home/you/code/baanmali-preorder";
const LANES = "/home/you/.manut/lanes/baanmali-preorder";
const SHOTS = process.env.MANUT_SHOTS || "";
const THEME = process.env.MANUT_THEME || "light";

type Call = { op: string; cwd?: string; editor?: string };
const opened = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []).filter((c) => c.op === "editor"));

/** Settings the mock shell answers with, before the page loads. */
const before = (page: Page, o: { editors?: { id: string; label: string }[]; fails?: string; pref?: string } = {}) =>
  page.addInitScript((v) => {
    const w = window as unknown as { __manutEditors?: unknown; __manutEditorFails?: string };
    if (v.editors) w.__manutEditors = v.editors;
    if (v.fails) w.__manutEditorFails = v.fails;
    if (v.theme) localStorage.setItem("manut.theme", v.theme);
    if (v.pref) localStorage.setItem("manut.editor", v.pref);
    else localStorage.removeItem("manut.editor");
  }, { ...o, theme: process.env.MANUT_THEME || "" });

async function startLane(page: Page, first: string): Promise<string> {
  return page.evaluate(
    async ([root, text]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, text);
      return id as string;
    },
    [ROOT, first],
  );
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("a terminal session's menu offers Open in the first editor installed, after the two folder actions, and opens its folder", async ({ page }) => {
  await before(page);
  await openApp(page);
  await newTerminal(page);
  // the session fills the main column; its row is in the Code page's list
  await openCode(page);
  const row = page.locator(".ss-row.tr").first();
  await row.click({ button: "right" });
  const menu = page.getByTestId("session-row-menu");
  await expect(menu.getByRole("menuitem").filter({ hasText: /^(Show in|Open in)/ })).toHaveText([/^Show in (Finder|Explorer|file manager)$/, "Open in Terminal", "Open in Visual Studio Code"]);
  await expect(menu).toBeVisible();
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/menu-${THEME}.png` });
  await menu.getByTestId("session-open-editor").click();
  await expect.poll(() => opened(page)).toEqual([{ op: "editor", cwd: "/home/you/code/web-app", editor: "vscode" }]);
});

test("the editor the person named is the one it says and opens; one not installed falls back to the first", async ({ page }) => {
  await before(page, { editors: [{ id: "vscode", label: "Visual Studio Code" }, { id: "zed", label: "Zed" }], pref: "zed" });
  await openApp(page);
  await newTerminal(page);
  // the session fills the main column; its row is in the Code page's list
  await openCode(page);
  await page.locator(".ss-row.tr").first().click({ button: "right" });
  await page.getByTestId("session-open-editor").click();
  await expect.poll(() => opened(page)).toEqual([{ op: "editor", cwd: "/home/you/code/web-app", editor: "zed" }]);
  await page.locator(".ss-row.tr").first().click({ button: "right" });
  await expect(page.getByTestId("session-open-editor")).toHaveText("Open in Zed");
});

test("with no editor installed no menu offers it and the palette lists no row for it", async ({ page }) => {
  await before(page, { editors: [] });
  await openApp(page);
  await newTerminal(page);
  // the session fills the main column; its row is in the Code page's list
  await openCode(page);
  await page.locator(".ss-row.tr").first().click({ button: "right" });
  await expect(page.getByTestId("session-row-menu")).toBeVisible();
  await expect(page.getByTestId("session-open-editor")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press(`${(await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control"}+k`);
  await page.getByTestId("palette-input").fill("Open");
  await expect(page.getByTestId("palette-row").filter({ hasText: /Open (in|the project|this session)/ }).filter({ hasText: /Visual|Cursor|Zed/ })).toHaveCount(0);
});

test("a failed open says why in the row's second line, in the app's own words", async ({ page }) => {
  await before(page, { fails: "the folder is not there" });
  await openApp(page);
  await newTerminal(page);
  // the session fills the main column; its row is in the Code page's list
  await openCode(page);
  await page.locator(".ss-row.tr").first().click({ button: "right" });
  await page.getByTestId("session-open-editor").click();
  await expect.poll(() => opened(page)).toHaveLength(1);
  // the words are the app's, never the shell's text
  await expect(page.getByTestId("term-editor-why")).toHaveText("The folder is not there any more, so it was not opened.");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/row-why-${THEME}.png` });
  await expect(page.getByText("the folder is not there", { exact: true })).toHaveCount(0);
});

test("a lane's menu opens the lane's own folder and not the developer's; a refusal is said under the lane", async ({ page }) => {
  await before(page);
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
  }, ROOT);
  await usePlatform(page);
  await page.goto("/");
  const id = await startLane(page, "Fix the totals");
  await openCode(page);
  const lane = page.getByTestId(`lane-${id}`);
  await expect(lane).toBeVisible();
  await lane.click({ button: "right" });
  await expect(page.getByTestId("lane-open-editor")).toHaveText("Open in Visual Studio Code");
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lane-menu-${THEME}.png` });
  await page.getByTestId("lane-open-editor").click();
  await expect.poll(() => opened(page)).toHaveLength(1);
  const [call] = await opened(page);
  expect(call.editor).toBe("vscode");
  expect(call.cwd!.startsWith(LANES)).toBe(true);
  expect(call.cwd).not.toBe(ROOT);

  await page.evaluate(() => ((window as any).__manutEditorFails = "not a folder"));
  await lane.click({ button: "right" });
  await page.getByTestId("lane-open-editor").click();
  await expect(page.getByTestId("lane-editor-why")).toHaveText("That is not a folder, so it was not opened.");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lane-why-${THEME}.png` });
});

test("the palette opens the open project's own folder, and the open lane's own folder", async ({ page }) => {
  await before(page);
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
  }, ROOT);
  await usePlatform(page);
  await page.goto("/");
  const id = await startLane(page, "Fix the totals");
  await openCode(page);
  const key = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control";
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("Open the project");
  const row = page.getByTestId("palette-row").filter({ hasText: "Open the project in Visual Studio Code" });
  await expect(row).toHaveCount(1);
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/palette-${THEME}.png` });
  await row.click();
  await expect.poll(() => opened(page)).toEqual([{ op: "editor", cwd: ROOT, editor: "vscode" }]);

  // the lane in view in the main column: its own folder
  await page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("Open this session");
  await page.getByTestId("palette-row").filter({ hasText: "Open this session's folder in Visual Studio Code" }).click();
  await expect.poll(async () => (await opened(page)).length).toBe(2);
  const second = (await opened(page))[1];
  expect(second.cwd!.startsWith(LANES)).toBe(true);
});

test("Settings › Developer › Editor: Automatic or one installed, no typed command, and the choice is the one menus use", async ({ page }) => {
  await before(page, { editors: [{ id: "vscode", label: "Visual Studio Code" }, { id: "cursor", label: "Cursor" }] });
  await openApp(page);
  await openSettings(page, "developer");
  const sel = page.getByTestId("dev-editor");
  await expect(sel).toBeVisible();
  await expect(sel.locator("option")).toHaveText(["Automatic", "Visual Studio Code", "Cursor"]);
  await expect(sel).toHaveValue("auto");
  await expect(page.getByTestId("dev-editor-group").locator("input")).toHaveCount(0);
  await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/setting-${THEME}.png` });
  await sel.selectOption("cursor");
  expect(await page.evaluate(() => localStorage.getItem("manut.editor"))).toBe("cursor");
  await sel.selectOption("auto");
  expect(await page.evaluate(() => localStorage.getItem("manut.editor"))).toBeNull();
});
