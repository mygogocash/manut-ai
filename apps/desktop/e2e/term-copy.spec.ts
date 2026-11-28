// Copying a selection follows Ghostty's whitespace rules (item 148; term/engine-copy.ts), in a real xterm on the mock host:
// the menu's Copy and the terminal's own `copy` event (what Cmd+C in the Edit menu raises) put the text without the spaces
// each row ends in, and the selection mode xterm keeps in a private field is still there (a bump of xterm that renames it
// would turn this back into xterm's own text, and this spec would say so).
import { expect, test, type Page } from "@playwright/test";
import { clipWrites, feed, mock, newTerminal, openApp, pointAt } from "./term-find-helpers";

test.beforeEach(async () => {
  await mock("mock.reset");
});

/** Rows that end in spaces the program printed, a blank row between, and trailing blank rows. */
const TEXT = "\r\ncopy-a   x  \r\n   indented  \r\n\r\ncopy-b  \r\n\r\n\r\n";

async function selectAll(page: Page) {
  const p = await pointAt(page, "copy-a");
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.getByTestId("term-menu-selectAll").click();
}

test("the menu's Copy puts the selection without the padding of each row, blank rows at its end, and keeps the blank row between", async ({ page }) => {
  await openApp(page);
  await newTerminal(page);
  await feed(page, TEXT);
  await selectAll(page);
  const p = await pointAt(page, "copy-a");
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.getByTestId("term-menu-copy").click();
  await expect.poll(() => clipWrites(page)).toHaveLength(1);
  const [text] = await clipWrites(page);
  expect(text).toContain("copy-a   x\n   indented\n\ncopy-b");
  expect(text).not.toMatch(/ \n/);
  expect(text.endsWith("copy-b")).toBe(true);
});

test("the terminal's copy event is answered with the same text, and xterm still holds its selection mode where this reads it", async ({ page }) => {
  await openApp(page);
  await newTerminal(page);
  await feed(page, TEXT);
  await selectAll(page);
  const got = await page.evaluate(() => {
    const w = window as unknown as { __manutTerms?: Set<any> };
    const host = document.querySelector('[data-testid="terminal"] .xterm');
    const t = [...(w.__manutTerms ?? [])].find((x) => x.element === host);
    const mode = t._core?._selectionService?._activeSelectionMode;
    const data = new DataTransfer();
    const ev = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    host!.querySelector("textarea")!.dispatchEvent(ev);
    return { mode, text: data.getData("text/plain"), prevented: ev.defaultPrevented };
  });
  expect(typeof got.mode).toBe("number");
  expect(got.prevented).toBe(true);
  expect(got.text).toContain("copy-a   x\n   indented\n\ncopy-b");
  expect(got.text).not.toMatch(/ \n/);
  expect(got.text.endsWith("copy-b")).toBe(true);
});
