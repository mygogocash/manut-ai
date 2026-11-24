// Kit's lanes on the Code page (src/code/Lanes.tsx, the design canvas's Code and StatesCode boards): each coding session
// that runs as a chat is a lane with a branch of its own, in a folder of its own (a git worktree the mock shell stands in
// for, under ~/.manut/lanes), and a state read from what happened in it. The developer's folder stays on its own branch. The stand-in coding
// agent (src/sessions/host.ts) edits a file and runs the tests when told `/kit pass`, `fail`, `unread` or `slow`, with the
// output on the step's end as the shell sends it; the page reads the result from that output. As in kit-code.spec.ts the
// session runs as a chat, so the spec starts it through the sessions store (the + menu starts terminals only).
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
/** Where the mock shell makes this project's lanes' folders, as lane.rs names them. */
const LANES = "/home/you/.manut/lanes/baanmali-preorder";

/** A Claude Code session in `cwd`, started with `first`. */
async function startIn(page: Page, first: string, cwd = ROOT): Promise<string> {
  return page.evaluate(
    async ([root, text]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, text);
      return id as string;
    },
    [cwd, first],
  );
}

/** The session fills the main column, as a notification would open it: the Code page lists only terminals. */
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
const send = (page: Page, id: string, text: string) => page.evaluate(([i, t]) => (window as any).__manutSessions.send(i, t), [id, text]);
const lane = (page: Page, id: string) => page.getByTestId(`lane-${id}`);
const branchOf = (page: Page, cwd = ROOT) => page.evaluate((c) => (window as any).__manutBranches[c], cwd);
/** The session's lane, as the sessions store keeps it. */
const laneRec = (page: Page, id: string) => page.evaluate((i) => (window as any).__manutSessions.getState().list.find((r: { id: string }) => r.id === i)?.lane, id);
type Call = { op: string; cwd?: string; path?: string; branch?: string; size?: number };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const close = (page: Page, id: string) => page.evaluate((i) => (window as any).__manutSessions.close(i), id);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockTaken = [];
  }, ROOT);
  await page.goto("/");
});

test("a lane gets a branch and a folder of its own, made from the branch the developer's folder is on, which stays on it", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  const dir = `${LANES}/add-promptpay-qr-checkout`;
  await expect.poll(() => laneRec(page, id)).toEqual({ name: "kit/add-promptpay-qr-checkout", base: "main", dir, worktree: dir });
  // the developer's folder is left on its own branch, and the agent works in the lane's folder, which is on the lane's
  expect(await branchOf(page)).toBe("main");
  expect(await branchOf(page, dir)).toBe("kit/add-promptpay-qr-checkout");
  expect((await calls(page)).filter((c) => c.op === "chat.start").map((c) => c.cwd)).toEqual([dir]);
  await openSession(page, id);
  await expect(page.getByTestId("session-branch")).toContainText("kit/add-promptpay-qr-checkout");
  // the chat says where Kit works, and that nothing is installed there yet
  await expect(page.getByTestId("session-chat")).toContainText(`Kit works on kit/add-promptpay-qr-checkout in a folder of its own, made from main: ${dir}.`);
  await expect(page.getByTestId("session-chat")).toContainText("Nothing is installed in it yet. Kit asks before it installs anything.");
  await openCode(page);
  const row = lane(page, id);
  await expect(page.getByTestId("lanes")).toBeVisible();
  await expect(row.getByTestId("lane-branch")).toHaveText("kit/add-promptpay-qr-checkout");
  await expect(row.getByTestId("lane-branch")).toHaveAttribute("title", `Made from main, in a folder of its own: ${dir}. Kit never pushes or merges from here.`);
  await expect(row).toContainText("Add a PromptPay QR to the checkout");
  await expect(row).toContainText("Kit · Claude Code");
});

test("the chat says how many of the developer's changed files did not come along", async ({ page }) => {
  await page.evaluate((root) => ((window as any).__manutLeft = { [root]: 2 }), ROOT);
  const id = await startIn(page, "Fix the totals");
  await openSession(page, id);
  await expect(page.getByTestId("session-chat")).toContainText("2 changed files in your folder did not come along: Kit starts from the last commit on main.");
});

test("is Checked only after a run whose output says its tests passed, with their number", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Not run yet");
  await send(page, id, "/kit pass");
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Checked");
  await expect(lane(page, id).getByTestId("lane-state")).toHaveClass(/\bok\b/);
  await expect(lane(page, id).getByTestId("lane-line")).toHaveText("14 tests passed.");
});

test("is Tests failed after a run that failed, with how many, and which test", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit fail");
  await openCode(page);
  const row = lane(page, id);
  await expect(row.getByTestId("lane-state")).toHaveText("Tests failed");
  await expect(row.getByTestId("lane-state")).toHaveClass(/\berr\b/);
  await expect(row.getByTestId("lane-line")).toHaveText("1 of 14 tests failed. Nothing is live.");
  await expect(row.getByTestId("lane-failed")).toHaveText("promptpay > locks the amount into the QR");
});

test("never says Checked for a run it could not read", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit unread");
  await openCode(page);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Not confirmed");
  await expect(lane(page, id).getByTestId("lane-line")).toHaveText("Kit ran the tests, but the result could not be read. Nothing is marked as passed.");
  await expect(page.getByTestId("lanes")).not.toContainText("Checked");
});

test("is Working while the turn runs, names the step and the time, and says nothing is live", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  await send(page, id, "/kit slow");
  const state = lane(page, id).getByTestId("lane-state");
  await expect(state).toHaveClass(/\brun\b/);
  await expect(state).toContainText("Running tests");
  await expect(state).toContainText(/\d+s/);
  await expect(lane(page, id).getByTestId("lane-line")).toHaveText("Kit works on a separate branch. Nothing is live.");
  // the run ends, and its output says the tests passed
  await expect(state).toHaveText("Checked", { timeout: 10_000 });
});

test("is Needs you while Kit asks, and Answer Kit opens the lane", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit install");
  await openCode(page);
  const row = lane(page, id);
  await expect(row.getByTestId("lane-state")).toHaveText("Needs you");
  await expect(row.getByTestId("lane-line")).toContainText("Kit asks: Allow pnpm add qrcode?");
  await row.getByRole("button", { name: "Answer Kit" }).click();
  await expect(page.getByTestId("card-approval")).toBeVisible();
});

test("is Reverted after the turn is taken back, and the next turn is a lane at work again", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit pass");
  await openCode(page);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Checked");
  await page.evaluate((i) => (window as any).__manutSessions.rewind(i), id);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Reverted");
  await expect(lane(page, id).getByTestId("lane-line")).toContainText("The files stay as they are.");
  await send(page, id, "/kit slow");
  await expect(lane(page, id).getByTestId("lane-state")).toContainText("Running tests");
});

test("two lanes work at once, each in a folder of its own on its own branch, both made from the developer's branch", async ({ page }) => {
  const a = await startIn(page, "Thai date format");
  await send(page, a, "/kit slow");
  const b = await startIn(page, "Fix stock sync with Shopee");
  await openCode(page);
  // the second lane is made while the first works, from main: never joined to the first's branch, never stacked on it
  await expect(lane(page, a).getByTestId("lane-branch")).toHaveText("kit/thai-date-format");
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveText("kit/fix-stock-sync-shopee");
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveAttribute("title", `Made from main, in a folder of its own: ${LANES}/fix-stock-sync-shopee. Kit never pushes or merges from here.`);
  await expect(lane(page, a).getByTestId("lane-state")).toContainText("Running tests");
  // each agent works in its own folder, at the same time
  await send(page, b, "/kit pass");
  await expect(lane(page, b).getByTestId("lane-state")).toHaveText("Checked");
  await expect(lane(page, a).getByTestId("lane-state")).toHaveText("Checked", { timeout: 10_000 });
  expect((await calls(page)).filter((c) => c.op === "chat.start").map((c) => c.cwd)).toEqual([`${LANES}/thai-date-format`, `${LANES}/fix-stock-sync-shopee`]);
  expect(await branchOf(page)).toBe("main");
  // a lane started after the first stopped is made from main too
  const c = await startIn(page, "Rename the pre-order page");
  await openCode(page);
  await expect(lane(page, c).getByTestId("lane-branch")).toHaveAttribute("title", `Made from main, in a folder of its own: ${LANES}/rename-pre-order-page. Kit never pushes or merges from here.`);
});

test("a name that is taken gets a number, and a folder that is no repository gets no branch", async ({ page }) => {
  await page.evaluate(() => ((window as any).__manutMockTaken = ["kit/thai-date-format"]));
  const a = await startIn(page, "Thai date format");
  await expect.poll(() => laneRec(page, a)).toMatchObject({ name: "kit/thai-date-format-2", dir: `${LANES}/thai-date-format-2` });
  expect(await branchOf(page)).toBe("main");
  const plain = "/home/you/code/notes";
  const b = await startIn(page, "Tidy the notes", plain);
  await openCode(page);
  // the Code page shows the project of the newest session: the folder that is no repository
  await expect(lane(page, b)).toBeVisible();
  await expect(lane(page, a)).toHaveCount(0);
  await page.getByTestId("kit-project").selectOption(ROOT);
  await expect(lane(page, a).getByTestId("lane-branch")).toHaveText("kit/thai-date-format-2");
  // no branch tag, and its words do not say it works on a separate branch
  await page.getByTestId("kit-project").selectOption(plain);
  await expect(lane(page, b)).toBeVisible();
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveCount(0);
  await send(page, b, "/kit slow");
  await expect(lane(page, b).getByTestId("lane-line")).toHaveText("Kit is working in this folder. Nothing is live.");
});

test("the lane's states are in the owner's language", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit fail");
  await page.evaluate(async () => {
    const i18n = (await import(/* @vite-ignore */ "/src/i18n/index.ts" as string)) as { setLang(l: string): void };
    i18n.setLang("zh");
  });
  await openCode(page);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("测试未通过");
  await expect(lane(page, id).getByTestId("lane-line")).toHaveText("14 个测试中有 1 个未通过。没有任何内容上线。");
});

test("closing a lane lets its folder go when nothing in it would be lost, and its branch stays", async ({ page }) => {
  const id = await startIn(page, "Thai date format");
  await close(page, id);
  await expect.poll(async () => (await calls(page)).filter((c) => c.op === "lane.remove").map((c) => c.path)).toEqual([`${LANES}/thai-date-format`]);
  expect((await calls(page)).find((c) => c.op === "lane.remove")?.branch).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__manutMockTaken)).toContain("kit/thai-date-format");
  await openCode(page);
  await expect(page.getByTestId("kept-lane")).toHaveCount(0);
});

test("a lane's folder with changes is kept when its session closes, listed with its project, and Remove asks first", async ({ page }) => {
  const id = await startIn(page, "Thai date format");
  const dir = `${LANES}/thai-date-format`;
  await page.evaluate((d) => {
    (window as any).__manutLaneChanged = { [d]: 2 };
    (window as any).__manutLaneAhead = { [d]: 1 };
  }, dir);
  await close(page, id);
  await openCode(page);
  // its project stays on the Code page for the kept folder, though no session is left in it
  const kept = page.getByTestId("kept-lane");
  await expect(kept).toHaveCount(1);
  await expect(kept).toContainText("kit/thai-date-format");
  await expect(kept.getByTestId("kept-line")).toHaveText("2 changed files in it are not on the branch.");
  expect((await calls(page)).filter((c) => c.op === "lane.remove")).toEqual([]);

  await kept.getByTestId("kept-remove").click();
  const panel = kept.getByTestId("kept-confirm");
  await expect(panel.getByTestId("kept-lose")).toHaveText("2 changed files in it go with it.");
  await expect(panel.getByTestId("kept-ahead")).toHaveText("The branch stays, with its commits.");
  await panel.getByTestId("kept-branch").check();
  await expect(panel.getByTestId("kept-ahead")).toHaveText("1 commit on it is not on main. It goes with the branch.");
  // a file changed in it before the press: nothing is removed, and the panel shows the number there is now
  await page.evaluate((d) => ((window as any).__manutLaneChanged = { [d]: 3 }), dir);
  await panel.getByTestId("kept-confirm-remove").click();
  await expect(panel.getByTestId("kept-changed")).toHaveText("What is in it changed since. Nothing was removed: look again.");
  await expect(panel.getByTestId("kept-lose")).toHaveText("3 changed files in it go with it.");
  expect((await calls(page)).filter((c) => c.op === "lane.remove")).toEqual([]);
  await panel.getByTestId("kept-confirm-remove").click();
  await expect(page.getByTestId("kept-lane")).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.op === "lane.remove")).toEqual([expect.objectContaining({ path: dir, branch: "kit/thai-date-format", size: 3 })]);
});
