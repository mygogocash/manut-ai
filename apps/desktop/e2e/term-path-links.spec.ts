// A file path in a terminal's output opens in the person's editor on Cmd/Ctrl+click (item 148; term/engine-paths.ts), on the
// mock host with the engine's real xterm: `path:line:col` and `path:line` inside the session's folder make a link that opens the
// file at its line through item 107's editor call (the mock records it and starts nothing); a plain click does not; a path outside
// the folder, a missing file and a link with no editor installed are not links at all.
import { expect, test, type Page } from "@playwright/test";
import { feed, mock, modKey, newTerminal, openApp, pointAt, settle } from "./term-find-helpers";

test.use({ colorScheme: "dark" });
test.beforeEach(async () => {
  await mock("mock.reset");
});

const FOLDER = "/home/you/code/web-app";
type Call = { op: string; cwd?: string; editor?: string; file?: string; row?: number; col?: number };
const opened = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []).filter((c) => c.op === "editor"));

const TEXT = "\r\nerror in src/app.ts:12:5 today\r\nsee src/checkout/cart.ts:42 and README.md:3\r\n/etc/passwd:1 and ../secret.ts:2\r\nsrc/nope.ts:3:1\r\n";

async function ready(page: Page, editors?: unknown[]) {
  if (editors) await page.addInitScript((e) => ((window as unknown as { __manutEditors?: unknown }).__manutEditors = e), editors);
  await openApp(page);
  await newTerminal(page);
  await feed(page, TEXT);
}

/** Move onto the text so xterm asks for the row's links, and give it a moment: the shell is asked first. */
async function hover(page: Page, text: string) {
  const p = await pointAt(page, text, 0, Math.min(text.length, 12));
  await page.mouse.move(p.x - 4, p.y);
  await page.mouse.move(p.x, p.y);
  return p;
}

test("Cmd/Ctrl+click on path:line:col opens that file at that line and column, once, in the editor the shell found", async ({ page }) => {
  await ready(page);
  const p = await hover(page, "src/app.ts:12:5");
  await expect(page.locator(".xterm .xterm-cursor-pointer")).toHaveCount(1);
  const key = await modKey(page);
  await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(key);
  await expect.poll(() => opened(page)).toEqual([{ op: "editor", cwd: FOLDER, editor: "vscode", file: "src/app.ts", row: 12, col: 5 }]);
  await settle(page);
  expect(await opened(page)).toHaveLength(1);
});

test("path:line (no column) and a file name with a line open at that line; the file is named from the folder", async ({ page }) => {
  await ready(page);
  const key = await modKey(page);
  for (const text of ["src/checkout/cart.ts:42", "README.md:3"]) {
    const p = await hover(page, text);
    await expect(page.locator(".xterm .xterm-cursor-pointer")).toHaveCount(1);
    await page.keyboard.down(key);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up(key);
  }
  await expect.poll(() => opened(page)).toEqual([
    { op: "editor", cwd: FOLDER, editor: "vscode", file: "src/checkout/cart.ts", row: 42 },
    { op: "editor", cwd: FOLDER, editor: "vscode", file: "README.md", row: 3 },
  ]);
});

test("a plain click, and the wrong key, only select: nothing opens", async ({ page }) => {
  await ready(page);
  const p = await hover(page, "src/app.ts:12:5");
  await page.mouse.click(p.x, p.y);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await page.keyboard.down(mac ? "Control" : "Meta");
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(mac ? "Control" : "Meta");
  await settle(page);
  expect(await opened(page)).toEqual([]);
});

test("a path outside the folder, and one that is not there, is not a link: no pointer, and nothing opens with the key held", async ({ page }) => {
  await ready(page);
  const key = await modKey(page);
  for (const text of ["/etc/passwd:1", "../secret.ts:2", "src/nope.ts:3:1"]) {
    const p = await hover(page, text);
    await settle(page, 250);
    await expect(page.locator(".xterm .xterm-cursor-pointer")).toHaveCount(0);
    await page.keyboard.down(key);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up(key);
  }
  await settle(page);
  expect(await opened(page)).toEqual([]);
});

test("the hover says which key to hold, as for a web address, and goes when the pointer leaves", async ({ page }) => {
  await ready(page);
  await hover(page, "src/app.ts:12:5");
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await expect(page.locator(".term-linktip")).toHaveText(mac ? "⌘+click to open" : "Ctrl+click to open");
  await page.mouse.move(5, 400);
  await expect(page.locator(".term-linktip")).toHaveCount(0);
});

test("with no editor installed a path is no link", async ({ page }) => {
  await ready(page, []);
  await hover(page, "src/app.ts:12:5");
  await settle(page, 300);
  await expect(page.locator(".xterm .xterm-cursor-pointer")).toHaveCount(0);
  expect(await opened(page)).toEqual([]);
});

test("a refused open says why beside the link, in the app's words", async ({ page }) => {
  await page.addInitScript(() => ((window as unknown as { __manutEditorFails?: string }).__manutEditorFails = "the editor exited with exit status: 1"));
  await ready(page);
  const p = await hover(page, "src/app.ts:12:5");
  const key = await modKey(page);
  await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(key);
  await expect(page.locator(".term-linktip")).toHaveText("The editor did not open. Nothing was changed.");
});
