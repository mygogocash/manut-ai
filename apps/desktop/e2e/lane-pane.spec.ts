// The pane beside a lane (src/code/LanePane.tsx, the design canvas's Code board, "What to look at"), walked in a browser: Diff, Preview
// and Tests beside the session's chat. The stand-in coding agent (src/sessions/host.ts) edits a file and runs the tests when told
// `/kit pass`, `fail`, `unread` or `slow`, and reads the shop ID from the environment when told `/kit shop`. The lane runs as a chat,
// as the canvas's Code board draws it; the + menu starts agents in their own terminal only (docs/code-editor.md), so the spec starts
// it through the sessions store, as kit-lanes.spec.ts does, and opens it as a notification would.
import { expect, test, type Page } from "@playwright/test";

const ROOT = "/home/you/code/baanmali-preorder";

/** A Claude Code session in the project, running as a chat, started with `first`. */
async function startIn(page: Page, first: string): Promise<string> {
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

/** The session fills the main column, as a notification would open it: the Code page lists only terminals. */
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
const send = (page: Page, id: string, text: string) => page.evaluate(([i, t]) => (window as any).__manutSessions.send(i, t), [id, text]);
const pane = (page: Page) => page.getByTestId("lane-pane");
const chip = (page: Page, view: "diff" | "preview" | "tests") => page.getByTestId(`lane-chip-${view}`);
type Call = { op: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []).map((c) => c.op));
/** The turn is over: the session says it is ready. */
const ready = (page: Page) => expect(page.getByTestId("session-status")).toHaveText("Ready");
/** A box's place on the page, which a test of a layout reads. */
async function box(page: Page, id: string) {
  const b = await page.getByTestId(id).boundingBox();
  if (!b) throw new Error(`${id} has no box`);
  return b;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockTaken = [];
  }, ROOT);
  await page.goto("/");
});

test("a lane has the pane beside its chat, opened on Diff, and the terminal view of the same session has none", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await expect(pane(page)).toBeVisible();
  await expect(page.getByRole("group", { name: "What to look at" })).toBeVisible();
  await expect(page.getByRole("group", { name: "What to look at" }).getByRole("button")).toHaveText(["Diff", "Preview", "Tests"]);
  await expect(chip(page, "diff")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "preview")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(page, "tests")).toHaveAttribute("aria-pressed", "false");
  await expect(pane(page)).toHaveAttribute("data-view", "diff");
  // the chat is still the session's chat, and the pane is not part of it
  await expect(page.getByTestId("session-chat")).toBeVisible();
  await expect(page.getByTestId("session-chat").getByTestId("lane-pane")).toHaveCount(0);

  // beside it, at the top, to its right
  const chat = await box(page, "session-chat");
  const side = await box(page, "lane-pane");
  expect(side.x).toBeGreaterThanOrEqual(chat.x + chat.width - 2);
  expect(Math.abs(side.y - chat.y)).toBeLessThan(2);
  expect(side.width).toBeGreaterThan(300);

  // the session's own terminal is no chat: nothing is beside it
  await page.getByTestId("session-terminal-toggle").click();
  await expect(page.getByTestId("terminal")).toBeVisible();
  await expect(pane(page)).toHaveCount(0);
  await page.getByTestId("session-terminal-toggle").click();
  await expect(pane(page)).toBeVisible();
});

test("Diff lists each file Kit changed with its counts, drawn as the timeline draws a change, and keeps the newest change to a file", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await expect(page.getByTestId("lane-diff-none")).toHaveText("Kit has not changed any file yet.");
  await send(page, id, "/kit pass");
  const files = page.getByTestId("lane-diff-file");
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText("src/checkout.tsx");
  await expect(files.first().locator(".dv-add")).toHaveText("+6");
  await expect(files.first().locator(".dv-del")).toHaveText("−1");
  await expect(files.first().locator(".dv-l.add")).toHaveText("  const qr = promptPayQR(SHOP_ID, total);");
  await expect(files.first().locator(".dv-l.del")).toHaveText("  return <PayByTransfer amount={total} />;");
  await expect(page.getByTestId("lane-diff-none")).toHaveCount(0);
  // the timeline's own diffs are drawn when a step is opened, and are the only ones with its ids
  await expect(page.getByTestId("diff-view")).toHaveCount(0);
  await ready(page);

  // the same file changed again is one file, and its newest change
  await send(page, id, "/kit fail");
  await expect(page.getByTestId("activity")).toHaveCount(3);
  await ready(page);
  await expect(files).toHaveCount(1);
  await expect(files.first()).toContainText("src/checkout.tsx");
});

test("Preview says the app has no preview yet, and shows a Sample for the secret the code reads, and starts nothing", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await chip(page, "preview").click();
  await expect(chip(page, "preview")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "diff")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("lane-preview-note")).toHaveText("The preview does not run in the app yet.");
  // the code reads no secret yet: no Sample
  await expect(page.getByTestId("kit-sample")).toHaveCount(0);

  // a change whose code reads the shop ID from the environment: a Sample row, as the Code page has it
  await send(page, id, "/kit shop");
  const sample = page.getByTestId("kit-sample");
  await expect(sample).toHaveCount(1);
  await expect(sample).toContainText("Sample");
  await expect(sample).toContainText("The preview has no shop ID yet, so the QR code is a sample.");
  await expect(page.getByTestId("lane-preview-note")).toBeVisible();
  const before = await calls(page);
  await page.getByTestId("kit-sample-add").click();
  await expect(page.getByTestId("kit-sample-vault")).toContainText("The vault for a project's secrets comes later.");
  // pressing Add changed nothing and started nothing: the shell was asked for no more than before
  expect(await calls(page)).toEqual(before);
  // no value of the secret is on the page, nor the sample the preview would run with
  expect(await page.evaluate(() => document.body.innerText.includes("0000000000"))).toBe(false);
  await ready(page);
});

test("Tests shows the last result with its command and when it finished, and says when a file changed since", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await chip(page, "tests").click();
  await expect(page.getByTestId("lane-tests-none")).toHaveText("No tests have run in this lane yet.");

  await send(page, id, "/kit pass");
  const last = page.getByTestId("lane-tests-last");
  await expect(last).toBeVisible();
  await expect(page.getByTestId("lane-tests-command")).toHaveText("$ pnpm test");
  await expect(page.getByTestId("lane-tests-result")).toHaveText("14 tests passed.");
  await expect(page.getByTestId("lane-tests-result")).toHaveAttribute("data-tone", "ok");
  await expect(page.getByTestId("lane-tests-at")).toHaveText(/^Finished at \d{1,2}:\d{2}\.$/);
  await expect(page.getByTestId("lane-tests-stale")).toHaveCount(0);
  await ready(page);

  // an edit after the run: the result is of older code, and is still shown
  await send(page, id, "/kit shop");
  await expect(page.getByTestId("lane-tests-stale")).toHaveText("A file changed after this run, so the result is of older code.");
  await expect(page.getByTestId("lane-tests-result")).toHaveText("14 tests passed.");
  await ready(page);

  // a run that fails, with the test the run named
  await send(page, id, "/kit fail");
  await expect(page.getByTestId("lane-tests-result")).toHaveText("1 of 14 tests failed. Nothing is live.");
  await expect(page.getByTestId("lane-tests-result")).toHaveAttribute("data-tone", "err");
  await expect(page.getByTestId("lane-tests-names")).toHaveText("promptpay > locks the amount into the QR");
  await expect(page.getByTestId("lane-tests-stale")).toHaveCount(0);
  await ready(page);

  // output that no runner printed: not confirmed, with why in words, and nothing is marked as passed
  await send(page, id, "/kit unread");
  await expect(page.getByTestId("lane-tests-result")).toHaveText("Kit ran the tests, but the result could not be read. Nothing is marked as passed.");
  await expect(page.getByTestId("lane-tests-why")).toHaveText("What it printed has no test summary that the app can read.");
  await expect(page.getByTestId("lane-tests-result")).toHaveAttribute("data-tone", "");
  await expect(page.getByTestId("lane-view-tests")).not.toContainText(/tests? passed/);
  await ready(page);
});

test("Tests says a run is in progress, with its command, until it ends", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await chip(page, "tests").click();
  await send(page, id, "/kit slow");
  const running = page.getByTestId("lane-tests-running");
  await expect(running).toContainText("A test run is in progress.");
  await expect(running).toContainText("$ pnpm test");
  await expect(page.getByTestId("lane-tests-none")).toHaveCount(0);
  // it ends with its result, and the line about it goes
  await expect(page.getByTestId("lane-tests-result")).toHaveText("14 tests passed.", { timeout: 10_000 });
  await expect(running).toHaveCount(0);
});

test("a Rewind to before a turn takes that turn's files and its result out of the pane", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit pass");
  await openSession(page, id);
  await expect(page.getByTestId("lane-diff-file")).toHaveCount(1);
  await chip(page, "tests").click();
  await expect(page.getByTestId("lane-tests-result")).toHaveText("14 tests passed.");
  await ready(page);

  await page.getByTestId("rewind-open").click();
  await expect(page.getByTestId("rewind-count")).toBeVisible();
  await page.getByTestId("rewind-go").click();
  await expect(page.getByTestId("rewind-panel")).toHaveCount(0);
  // the lane forgot the run and the chat forgot the turn: nothing of either is shown as if it were still there
  await expect(page.getByTestId("lane-tests-none")).toBeVisible();
  await chip(page, "diff").click();
  await expect(page.getByTestId("lane-diff-none")).toBeVisible();
  await expect(page.getByTestId("lane-diff-file")).toHaveCount(0);
});

test("at a narrow width the pane goes under the chat, which keeps its box for typing", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await send(page, id, "/kit pass");
  await expect(page.getByTestId("lane-diff-file")).toHaveCount(1);
  await ready(page);

  await page.setViewportSize({ width: 900, height: 760 });
  const chat = await box(page, "session-chat");
  const side = await box(page, "lane-pane");
  // under the chat, across the same column, and no taller than the share it is given
  expect(side.y).toBeGreaterThanOrEqual(chat.y + chat.height - 2);
  expect(Math.abs(side.x - chat.x)).toBeLessThan(2);
  expect(Math.abs(side.width - chat.width)).toBeLessThan(2);
  expect(side.height).toBeLessThanOrEqual(760 * 0.45 + 2);
  // the chat keeps room: its box for typing is on the screen, above the pane
  const composer = await box(page, "composer");
  expect(composer.y + composer.height).toBeLessThanOrEqual(side.y + 2);
  expect(chat.height).toBeGreaterThan(250);
  // nothing makes the page wider than the window
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // each chip still works under the chat
  await chip(page, "tests").click();
  await expect(page.getByTestId("lane-tests-result")).toHaveText("14 tests passed.");

  // wide again: beside it, as before
  await page.setViewportSize({ width: 1280, height: 820 });
  const wideChat = await box(page, "session-chat");
  const wideSide = await box(page, "lane-pane");
  expect(wideSide.x).toBeGreaterThanOrEqual(wideChat.x + wideChat.width - 2);
});
