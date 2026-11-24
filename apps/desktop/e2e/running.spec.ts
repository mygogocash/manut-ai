// What keeps running on the Code page (src/running/, the design canvas's StatesCodeDev board, "Watching it run"): the
// commands this app's terminals and chats started that still run, each with how long it has run, its port and Stop.
// The shell reads them from the system; a plain browser has none, so the mock host lists what the spec seeds through
// `window.__manutMockRunning` and records each stop on `window.__manutRunningCalls`.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const MIN = 60_000;

/** A command the shell would list: the canvas's dev server by default. */
const row = (o: Record<string, unknown> = {}) => ({
  kind: "pty",
  session: 1,
  folder: ROOT,
  pid: 4242,
  started: Date.now() - 42 * MIN,
  argv: ["node", "/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs", "dev"],
  ports: [3000],
  ...o,
});

const seed = (page: Page, rows: unknown[]) => page.evaluate((r) => (window as any).__manutMockRunning.set(r), rows);
const stops = (page: Page) => page.evaluate(() => ((window as any).__manutRunningCalls ?? []) as Record<string, unknown>[]);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await openCode(page);
});

test("says nothing runs, then lists a dev server with its age and port, and Stop ends it", async ({ page }) => {
  const panel = page.getByTestId("running-panel");
  await expect(panel).toContainText("What keeps running");
  await expect(page.getByTestId("running-none")).toHaveText("Nothing started here is still running.");

  const started = Date.now() - 42 * MIN;
  await seed(page, [row({ started })]);
  const r = page.getByTestId("running-row");
  await expect(r).toHaveCount(1);
  await expect(r).toContainText("Running");
  await expect(r.getByTestId("running-command")).toHaveText("pnpm dev");
  await expect(r.getByTestId("running-meta")).toContainText("42m");
  await expect(r.getByTestId("running-meta")).toContainText("port 3000");
  await expect(page.getByTestId("running-none")).toHaveCount(0);

  await r.getByTestId("running-stop").click();
  // the shell is told which command it is, and nothing of its words
  await expect.poll(() => stops(page)).toEqual([{ op: "stop", kind: "pty", session: 1, pid: 4242, started }]);
  // it ends, and the row goes with it
  await expect(r).toHaveCount(0);
  await expect(page.getByTestId("running-none")).toBeVisible();
});

test("a command that would not stop says so, and Stop can be pressed again", async ({ page }) => {
  await seed(page, [row()]);
  await page.evaluate(() => ((window as any).__manutMockRunning.stopMode = "refuse"));
  const r = page.getByTestId("running-row");
  await r.getByTestId("running-stop").click();
  await expect(page.getByTestId("running-failed")).toHaveText("Could not stop it. Try again.");
  await expect(r.getByTestId("running-stop")).toHaveText("Stop");
  await expect(r.getByTestId("running-stop")).not.toHaveAttribute("aria-busy", "true");

  await page.evaluate(() => ((window as any).__manutMockRunning.stopMode = "end"));
  await r.getByTestId("running-stop").click();
  await expect(r).toHaveCount(0);
  await expect(page.getByTestId("running-failed")).toHaveCount(0);
});

test("a Stop that was pressed says Stopping and cannot be pressed again", async ({ page }) => {
  await seed(page, [row()]);
  await page.evaluate(() => ((window as any).__manutMockRunning.stopMode = "ignore"));
  const stop = page.getByTestId("running-row").getByTestId("running-stop");
  await stop.click();
  await expect(stop).toHaveText("Stopping");
  await expect(stop).toHaveAttribute("aria-busy", "true");
  await expect(stop).toHaveAttribute("aria-disabled", "true");
  // Playwright waits for a button marked disabled, as a person's tools do; forced, a press still does nothing
  await stop.click({ force: true });
  await stop.click({ force: true });
  expect(await stops(page)).toHaveLength(1);
});

test("a command is listed only once it has run a few seconds", async ({ page }) => {
  // a start a little ahead of the clock counts as no time at all, so this one stays too young however slow the machine is
  await seed(page, [row({ pid: 1, started: Date.now() + MIN, argv: ["git", "status"], ports: [] })]);
  await expect(page.getByTestId("running-none")).toBeVisible();
  await seed(page, [row({ pid: 1, started: Date.now() - 8_000, argv: ["sleep", "60"], ports: [] })]);
  await expect(page.getByTestId("running-row")).toHaveCount(1);
  await expect(page.getByTestId("running-command")).toHaveText("sleep 60");
  await expect(page.getByTestId("running-meta")).not.toContainText("port");
});

test("hides a key in the command, in the words and in what a screen reader reads", async ({ page }) => {
  const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  await seed(page, [row({ argv: ["node", "/code/app/server.js", `--token=${key}`] })]);
  await expect(page.getByTestId("running-command")).toContainText("••••");
  expect(await page.content()).not.toContain(key);
  expect(await page.content()).not.toContain("ghp_abcdefgh");
  await expect(page.getByTestId("running-stop")).not.toHaveAttribute("aria-label", new RegExp(key));
});

test("names the project of each command when the list reaches more than one, oldest first", async ({ page }) => {
  await seed(page, [
    row({ pid: 1, started: Date.now() - 10 * MIN, argv: ["vitest", "--watch"], ports: [] }),
    row({ pid: 2, session: 7, folder: "/home/you/code/storefront", started: Date.now() - 90 * MIN, argv: ["/bin/zsh", "-lc", "pnpm dev"], ports: [5173, 24678] }),
  ]);
  const rows = page.getByTestId("running-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByTestId("running-command")).toHaveText("pnpm dev");
  await expect(rows.nth(0).getByTestId("running-meta")).toContainText("1h 30m");
  await expect(rows.nth(0).getByTestId("running-meta")).toContainText("ports 5173, 24678");
  await expect(rows.nth(0).getByTestId("running-meta")).toContainText("storefront");
  await expect(rows.nth(1).getByTestId("running-meta")).toContainText("baanmali-preorder");
});

test("names the terminal a command runs in, and its name opens that terminal", async ({ page }) => {
  const id = await page.evaluate((root) => (window as any).__manutSessions.startTerminal("shell", root) as string, ROOT);
  await expect.poll(() => page.evaluate((i) => (window as any).__manutSessions.ptyOf(i) as number | null, id)).not.toBeNull();
  const pty = await page.evaluate((i) => (window as any).__manutSessions.ptyOf(i) as number, id);
  await openCode(page);
  // a command of a terminal this page has no row for (a chat's, or a shell of the bottom panel) names none
  await seed(page, [row({ session: pty }), row({ pid: 77, session: pty + 100, started: Date.now() - 50 * MIN })]);
  await expect(page.getByTestId("running-row")).toHaveCount(2);
  await expect(page.getByTestId("running-lane")).toHaveCount(1);
  await expect(page.getByTestId("running-lane")).toHaveText("Shell");
  await page.getByTestId("running-lane").click();
  const open = () =>
    page.evaluate(async () => {
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { getState(): { ui: { session: string | null } } } };
      return store.getStore().getState().ui.session;
    });
  await expect.poll(open).toBe(id);
});

test("draws nothing where this computer cannot say what runs", async ({ page }) => {
  await seed(page, [row()]);
  await expect(page.getByTestId("running-row")).toHaveCount(1);
  await page.evaluate(() => {
    const m = (window as any).__manutMockRunning;
    m.unsupported = true;
    m.set([]);
  });
  await expect(page.getByTestId("running-panel")).toHaveCount(0);
});
