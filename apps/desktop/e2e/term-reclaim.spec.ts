// An agent that dies with its input modes on gives the keyboard and mouse back (item 148; term/engine-reclaim.ts), on the mock
// host with the engine's real xterm: a TERMINALS agent row whose program ends after it turned on the Kitty keyboard
// protocol, mouse and focus reporting, bracketed paste, application keys and the alternate screen has them all off once, as
// the terminal goes on as the login shell; a Shell row, and an agent the person started by hand inside a shell (the app only
// sees which program is in front, never that it ended), give nothing back.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";
import { feed, mock, newTerminal, openApp, settle } from "./term-find-helpers";

test.use({ colorScheme: "dark" });
test.beforeEach(async () => {
  await mock("mock.reset");
});

/** What the program turns on: Kitty keys, mouse (any event) with SGR reports, focus reports, bracketed paste, application keys, the alternate screen. */
const ARM = "\x1b[?1049h\x1b[>1u\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h";

/** The shown terminal's real input modes, as xterm itself holds them. */
const modes = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __manutTerms?: Set<any> };
    const host = document.querySelector('[data-testid="terminal"] .xterm');
    const t = [...(w.__manutTerms ?? [])].find((x) => x.element === host);
    return {
      kitty: !!t._core?.coreService?.kittyKeyboard?.flags,
      mouse: t.modes.mouseTrackingMode !== "none",
      focus: t.modes.sendFocusMode as boolean,
      paste: t.modes.bracketedPasteMode as boolean,
      keys: t.modes.applicationCursorKeysMode as boolean,
      alt: t.buffer.active.type === "alternate",
    };
  });

const ON = { kitty: true, mouse: true, focus: true, paste: true, keys: true, alt: true };
const OFF = { kitty: false, mouse: false, focus: false, paste: false, keys: false, alt: false };

const ptyOf = (page: Page, id: string) => page.evaluate((i) => (window as any).__manutSessions.ptyOf(i) as number, id);

/** Counts what is written into the shown terminal that turns mouse reporting off (the reclaimer's own escape). */
const watchWrites = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __manutTerms?: Set<any>; __disarms?: number };
    const host = document.querySelector('[data-testid="terminal"] .xterm');
    const t = [...(w.__manutTerms ?? [])].find((x) => x.element === host);
    w.__disarms = 0;
    const write = t.write.bind(t);
    t.write = (d: unknown, cb?: () => void) => {
      if (typeof d === "string" && d.includes("\x1b[?1003l")) w.__disarms = (w.__disarms ?? 0) + 1;
      return write(d, cb);
    };
  });
const disarms = (page: Page) => page.evaluate(() => (window as unknown as { __disarms?: number }).__disarms ?? 0);

/** The mock program ends itself `ms` after this line: typed before the modes are on, since turning focus reporting on while
 *  the terminal has the keyboard makes xterm send the program `ESC [ I`, which would be the start of the line. */
async function endsLater(page: Page, ms: number, code: number) {
  await page.locator('[data-testid="terminal"] .xterm-helper-textarea').focus();
  await page.keyboard.type(`after ${ms} exit ${code}`);
  await page.keyboard.press("Enter");
}

test("an agent that dies with its modes on gives them back, once, as the terminal goes on as the login shell", async ({ page }) => {
  await openApp(page);
  const id = await newTerminal(page);
  const p = await ptyOf(page, id);
  await endsLater(page, 1500, 3);
  await page.evaluate(([i, d]) => (window as any).__manutMockOut(i, d), [p, ARM] as const);
  await expect.poll(() => modes(page)).toEqual(ON);
  await watchWrites(page);

  await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText("Claude Code ended with exit 3 — back to your shell", { timeout: 15_000 });
  await expect.poll(() => modes(page)).toEqual(OFF);
  await settle(page);
  expect(await modes(page)).toEqual(OFF);
  expect(await disarms(page)).toBe(1);
});

test("an agent that turned its modes off itself (a clean exit) gets nothing written", async ({ page }) => {
  await openApp(page);
  const id = await newTerminal(page);
  const p = await ptyOf(page, id);
  await endsLater(page, 1500, 0);
  await page.evaluate(([i, d]) => (window as any).__manutMockOut(i, d), [p, ARM] as const);
  await expect.poll(() => modes(page)).toEqual(ON);
  await page.evaluate(([i, d]) => (window as any).__manutMockOut(i, d), [p, "\x1b[<u\x1b[?1003l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?1049l"] as const);
  await expect.poll(() => modes(page)).toEqual(OFF);
  await watchWrites(page);
  await expect(page.locator('[data-testid="terminal"] .xterm-rows')).toContainText("back to your shell", { timeout: 15_000 });
  await settle(page);
  expect(await disarms(page)).toBe(0);
});

test("a Shell row gives nothing back, and neither does an agent the person started by hand in it", async ({ page }) => {
  await openApp(page);
  await newTerminal(page);
  // the Code page's menu starts a Shell row beside it
  await openCode(page);
  await page.getByTestId("session-new").click();
  await page.getByTestId("session-folder").click();
  await page.getByTestId("session-choose").click();
  await page.getByTestId("session-agent-shell").click();
  await expect(page.getByTestId("terminal")).toBeVisible();
  const id = (await page.getByTestId("terminal").getAttribute("data-session")) as string;
  await expect.poll(() => ptyOf(page, id)).not.toBeNull();
  const p = await ptyOf(page, id);
  await feed(page, ARM);
  await expect.poll(() => modes(page)).toEqual(ON);
  // the shell reports an agent in front and then not: it may have ended, or may be stopped with Ctrl+Z, which the app cannot tell
  await page.evaluate((i) => (window as any).__manutEmitSessionFg({ id: i, agent: "claude" }), p);
  await page.evaluate((i) => (window as any).__manutEmitSessionFg({ id: i, agent: null }), p);
  await settle(page);
  expect(await modes(page)).toEqual(ON);
});
