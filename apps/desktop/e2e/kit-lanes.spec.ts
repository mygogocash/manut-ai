// Kit's lanes on the Code page (src/code/Lanes.tsx, the design canvas's Code and StatesCode boards): each coding session
// that runs as a chat is a lane with a branch of its own and a state read from what happened in it. The stand-in coding
// agent (src/sessions/host.ts) edits a file and runs the tests when told `/kit pass`, `fail`, `unread` or `slow`, with the
// output on the step's end as the shell sends it; the page reads the result from that output. As in kit-code.spec.ts the
// session runs as a chat, so the spec starts it through the sessions store (the + menu starts terminals only).
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockTaken = [];
  }, ROOT);
  await page.goto("/");
});

test("a lane gets a branch of its own, named from its work and made from the branch the folder is on", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  // the developer's branch is left as it was, and the folder is now on the lane's
  await expect.poll(() => branchOf(page)).toBe("kit/add-promptpay-qr-checkout");
  await openSession(page, id);
  await expect(page.getByTestId("session-branch")).toContainText("kit/add-promptpay-qr-checkout");
  await openCode(page);
  const row = lane(page, id);
  await expect(page.getByTestId("lanes")).toBeVisible();
  await expect(row.getByTestId("lane-branch")).toHaveText("kit/add-promptpay-qr-checkout");
  await expect(row.getByTestId("lane-branch")).toHaveAttribute("title", "Made from main. Kit never pushes or merges from here.");
  await expect(row).toContainText("Add a PromptPay QR to the checkout");
  await expect(row).toContainText("Kit · Claude Code");
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

test("a lane that starts while another works in the folder shares its branch, and one that starts after gets its own", async ({ page }) => {
  const a = await startIn(page, "Thai date format");
  await send(page, a, "/kit slow");
  const b = await startIn(page, "Fix stock sync with Shopee");
  await openCode(page);
  await expect(lane(page, a).getByTestId("lane-branch")).toHaveText("kit/thai-date-format");
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveText("kit/thai-date-format");
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveAttribute("data-kind", "shared");
  // the first lane's run ends, so the folder is free of work and the next lane is made its own branch
  await expect(lane(page, a).getByTestId("lane-state")).toHaveText("Checked", { timeout: 10_000 });
  const c = await startIn(page, "Rename the pre-order page");
  // a new session opens in the main column, so the Code page is opened again
  await openCode(page);
  await expect(lane(page, c).getByTestId("lane-branch")).toHaveText("kit/rename-pre-order-page");
  await expect(lane(page, c).getByTestId("lane-branch")).toHaveAttribute("title", "Made from kit/thai-date-format. Kit never pushes or merges from here.");
});

test("a name that is taken gets a number, and a folder that is no repository gets no branch", async ({ page }) => {
  await page.evaluate(() => ((window as any).__manutMockTaken = ["kit/thai-date-format"]));
  const a = await startIn(page, "Thai date format");
  await expect.poll(() => branchOf(page)).toBe("kit/thai-date-format-2");
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
