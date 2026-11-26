// What keeps running on the Code page (src/running/, the design canvas's StatesCodeDev board, "Watching it run"): the
// commands this app's terminals and chats started that still run, each with how long it has run, its port and Stop, under
// Kit's panel and for the project that panel shows. The shell reads them from the system; a plain browser has none, so the
// mock host lists what the spec seeds through `window.__manutMockRunning` and records each stop on
// `window.__manutRunningCalls`. The Code page lists a project once a session runs in its folder, so each test starts one.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const OTHER = "/home/you/code/storefront";
const MIN = 60_000;

/** A command the shell would list: the canvas's dev server by default, in a terminal of the project. */
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

/** A Shell terminal started in `folder`: the project is then one the Code page lists, and the terminal's pty id is what a
 *  command of it names. Starting it opens its view, so the caller opens Code again. */
async function terminalIn(page: Page, folder: string): Promise<{ id: string; pty: number }> {
  const id = await page.evaluate((f) => (window as any).__manutSessions.startTerminal("shell", f) as string, folder);
  await expect.poll(() => page.evaluate((i) => (window as any).__manutSessions.ptyOf(i) as number | null, id)).not.toBeNull();
  return { id, pty: await page.evaluate((i) => (window as any).__manutSessions.ptyOf(i) as number, id) };
}

/** The session open in the main column, as the store has it. */
const openSession = (page: Page) =>
  page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { getState(): { ui: { session: string | null } } } };
    return store.getStore().getState().ui.session;
  });

let terminal: { id: string; pty: number };

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the app is up once its menu answers; a session started before that has no terminal to run in
  await openCode(page);
  terminal = await terminalIn(page, ROOT);
  await openCode(page);
});

test("says nothing runs, then lists a dev server with its age and port, and Stop ends it", async ({ page }) => {
  const panel = page.getByTestId("running-panel");
  await expect(panel).toContainText("What keeps running");
  await expect(page.getByTestId("running-none")).toHaveText("Nothing started here is still running.");

  const started = Date.now() - 42 * MIN;
  await seed(page, [row({ started, session: terminal.pty })]);
  const r = page.getByTestId("running-row");
  await expect(r).toHaveCount(1);
  await expect(r).toContainText("Running");
  await expect(r.getByTestId("running-command")).toHaveText("pnpm dev");
  await expect(r.getByTestId("running-meta")).toContainText("42m");
  await expect(r.getByTestId("running-meta")).toContainText("port 3000");
  await expect(page.getByTestId("running-none")).toHaveCount(0);

  await r.getByTestId("running-stop").click();
  // the shell is told which command it is, and nothing of its words
  await expect.poll(() => stops(page)).toEqual([{ op: "stop", kind: "pty", session: terminal.pty, pid: 4242, started }]);
  // it ends, and the row goes with it
  await expect(r).toHaveCount(0);
  await expect(page.getByTestId("running-none")).toBeVisible();
});

test("sits under Kit's panel, before the terminals", async ({ page }) => {
  const kit = await page.getByTestId("kit-panel").boundingBox();
  const run = await page.getByTestId("running-panel").boundingBox();
  const terms = await page.getByTestId("side-sessions").boundingBox();
  expect(kit && run && terms).toBeTruthy();
  expect(run!.y).toBeGreaterThan(kit!.y + kit!.height - 1);
  expect(terms!.y).toBeGreaterThan(run!.y + run!.height - 1);
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

test("shows the commands of the project Kit's panel shows, and counts the ones in the others", async ({ page }) => {
  // the newest session's folder is the panel's first project: storefront
  await terminalIn(page, OTHER);
  await openCode(page);
  await seed(page, [
    row({ pid: 1, started: Date.now() - 10 * MIN, argv: ["vitest", "--watch"], ports: [] }),
    row({ pid: 2, session: 7, folder: OTHER, started: Date.now() - 90 * MIN, argv: ["/bin/zsh", "-lc", "pnpm dev"], ports: [5173, 24678] }),
  ]);
  const rows = page.getByTestId("running-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId("running-command")).toHaveText("pnpm dev");
  await expect(rows.getByTestId("running-meta")).toContainText("1h 30m");
  await expect(rows.getByTestId("running-meta")).toContainText("ports 5173, 24678");
  await expect(page.getByTestId("running-others")).toHaveText("1 more running in other projects");

  // picking the other project in Kit's panel switches the list with it
  await page.getByTestId("kit-project").selectOption(ROOT);
  await expect(rows).toHaveCount(1);
  await expect(rows.getByTestId("running-command")).toHaveText("vitest --watch");
  await expect(page.getByTestId("running-others")).toHaveText("1 more running in other projects");

  // nothing running elsewhere: no line about it
  await seed(page, [row({ pid: 1, started: Date.now() - 10 * MIN, argv: ["vitest", "--watch"], ports: [] })]);
  await expect(page.getByTestId("running-others")).toHaveCount(0);
});

test("names the terminal a command runs in, and its name opens that terminal", async ({ page }) => {
  // a command of a session this page has no row for (a shell of the bottom panel) names none
  await seed(page, [row({ session: terminal.pty }), row({ pid: 77, session: terminal.pty + 100, started: Date.now() - 50 * MIN })]);
  await expect(page.getByTestId("running-row")).toHaveCount(2);
  await expect(page.getByTestId("running-lane")).toHaveCount(1);
  await expect(page.getByTestId("running-lane")).toHaveText("Shell");
  await page.getByTestId("running-lane").click();
  await expect.poll(() => openSession(page)).toBe(terminal.id);
});

test("names the lane a chat's command runs in, and its name opens that session", async ({ page }) => {
  const chat = await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    const id = s.draft("claude");
    s.setDraft(id, { cwd: root });
    await s.start(id, "/kit test");
    return id as string;
  }, ROOT);
  await expect.poll(() => page.evaluate((i) => (window as any).__manutSessions.chatIdOf(i) as number | null, chat)).not.toBeNull();
  const chatId = await page.evaluate((i) => (window as any).__manutSessions.chatIdOf(i) as number, chat);
  await openCode(page);
  await seed(page, [row({ kind: "chat", session: chatId, argv: ["/bin/zsh", "-c", "pnpm dev"] })]);
  await expect(page.getByTestId("running-row")).toHaveCount(1);
  const lane = page.getByTestId("running-lane");
  await expect(lane).toHaveCount(1);
  await expect(lane).not.toHaveText("Shell");
  await lane.click();
  await expect.poll(() => openSession(page)).toBe(chat);
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
