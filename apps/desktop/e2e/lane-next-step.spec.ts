// The lane's next step in its top bar (src/code/LaneStep.tsx, item 167e), walked in a browser: the header holds the lane's branch and its
// state as the Code board's tags, and one dark button naming the step the branch is at. With no pull request it is Put up for review;
// with one open it is Merge, with the request's checks and review beside it, read from the Pull requests list's own read
// (`window.__manutTasks.boards`). A press opens item 75's very steps under the header (the draft or the method, then the one ask), and
// nothing is pushed, opened or merged until Yes (`review.settle` in the mock shell's calls). The pane beside the lane starts with its
// chips: its quiet link is gone. MANUT_SHOTS=<dir> keeps pictures in dark and light (the last test; skipped without it).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = "/home/you/code/baanmali-preorder";
const REPO = "you/baanmali-preorder";
const BRANCH = "kit/add-promptpay-qr-checkout";
const SHOTS = process.env.MANUT_SHOTS || "";

/** The lane's pull request #12 as the Pull requests list reads it: open, one check of three still running, a review needed. */
const now = () => Math.floor(Date.now() / 1000);
const PULL = () => ({
  number: 12,
  title: "Add a PromptPay QR to the checkout",
  state: "open",
  url: `https://github.com/${REPO}/pull/12`,
  labels: [],
  author: "you",
  created: now() - 3600,
  updated: now() - 600,
  checks: { passed: 2, failed: 0, pending: 1, total: 3 },
  head: BRANCH,
  same: true,
  from: REPO,
  review: "required",
  conflict: false,
  base: "main",
});

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
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
type Call = { op: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []).map((c) => c.op));
const count = async (page: Page, op: string) => (await calls(page)).filter((o) => o === op).length;
const head = (page: Page) => page.getByTestId("header");
const button = (page: Page) => head(page).getByTestId("lane-step-button");
const panel = (page: Page) => page.getByTestId("lane-step-panel");

/** The lane open, with its stand-in agent answered so nothing it does later is taken for a press. */
async function laneOpen(page: Page) {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await expect(page.getByTestId("lane-pane")).toBeVisible();
  await expect(page.getByTestId("session-status")).toHaveText("Ready");
  return id;
}

/** The project is a clone of `you/baanmali-preorder`, whose open pull requests are `pulls`. */
async function setup(page: Page, pulls: unknown[]) {
  await page.addInitScript(
    ([root, repo, items]) => {
      localStorage.removeItem("manut.kit.projects");
      const w = window as any;
      w.__manutBranches = { [root as string]: "main" };
      w.__manutMockTaken = [];
      w.__manutTasks = { remotes: { [root as string]: { source: "github", repo } }, boards: { [`github:${repo}`]: items } };
    },
    [ROOT, REPO, pulls] as const,
  );
  await page.goto("/");
}

test("with no pull request the top bar names Put up for review, and its press opens item 75's draft and then its one ask, sent only on Yes", async ({ page }) => {
  await setup(page, []);
  await laneOpen(page);
  // the board's tags in the header: the lane's branch in mono, then the one dark button at its right
  await expect(head(page).getByTestId("lane-head-branch")).toHaveText(BRANCH);
  await expect(head(page).getByTestId("lane-head-branch")).toHaveAttribute("title", /^Made from main, in a folder of its own: \/home\/you\/\.manut\/lanes\/.*Kit never pushes or merges from here\.$/);
  await expect(button(page)).toHaveText("Put up for review");
  await expect(button(page)).toHaveAttribute("data-step", "review");
  await expect(button(page)).toHaveAttribute("aria-expanded", "false");
  await expect(head(page).getByTestId("lane-step-state")).toHaveCount(0);
  const b = (await button(page).boundingBox())!;
  const h = (await head(page).boundingBox())!;
  expect(b.y).toBeGreaterThanOrEqual(h.y);
  expect(b.y + b.height).toBeLessThanOrEqual(h.y + h.height);
  expect(b.x).toBeGreaterThan(h.x + h.width / 2);
  // the pane starts with its chips: the quiet link is the top bar's button now
  await expect(page.getByTestId("lane-pane").getByTestId("review-start")).toHaveCount(0);
  await expect(page.getByTestId("lane-pane").getByTestId("review")).toHaveCount(0);
  // nothing of the kind is offered anywhere on the lane
  await expect(page.getByRole("button", { name: /^(commit|push|discard)/i })).toHaveCount(0);

  await button(page).click();
  await expect(panel(page).getByTestId("review-draft")).toBeVisible();
  await expect(panel(page).getByTestId("review-title")).toHaveValue("Work in this lane");
  await expect(button(page)).toHaveAttribute("aria-expanded", "true");
  // under the header, above the chat and the pane
  expect((await panel(page).boundingBox())!.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
  expect((await panel(page).boundingBox())!.y).toBeLessThan((await page.getByTestId("lane-pane").boundingBox())!.y);
  expect(await count(page, "review.ask")).toBe(0);
  // a second press starts nothing over
  await panel(page).getByTestId("review-title").fill("Add the PromptPay QR");
  await button(page).click();
  await expect(panel(page).getByTestId("review-title")).toHaveValue("Add the PromptPay QR");

  await panel(page).getByTestId("review-ask-button").click();
  const ask = panel(page).getByTestId("review-ask");
  await expect(ask).toHaveAttribute("data-kind", "open");
  await expect(ask).toContainText(`Push ${BRANCH} and open a pull request?`);
  await expect(ask.getByTestId("review-repo")).toContainText(REPO);
  await expect(ask.getByTestId("review-ask-title")).toHaveText("Add the PromptPay QR");
  expect(await count(page, "review.ask")).toBe(1);
  expect(await count(page, "review.settle")).toBe(0);

  await ask.getByTestId("review-yes").click();
  await expect(panel(page).getByTestId("review-done")).toHaveAttribute("data-outcome", "opened");
  expect(await count(page, "review.settle")).toBe(1);
  // the request it opened is the lane's now: the button names the next step, with the request's number beside it
  await expect(button(page)).toHaveText("Merge");
  await expect(head(page).getByTestId("lane-step-pull")).toHaveText(/^#\d+$/);
});

test("with its request open the top bar names Merge with the request's checks and review beside it, and its press opens the merge's one ask", async ({ page }) => {
  await setup(page, [PULL()]);
  await laneOpen(page);
  await expect(button(page)).toHaveText("Merge");
  await expect(button(page)).toHaveAttribute("data-step", "merge");
  const state = head(page).getByTestId("lane-step-state");
  await expect(state).toHaveText("#12 · 1 running · Review needed");
  await expect(state.getByRole("button", { name: "Pull request #12" })).toHaveAttribute("title", "Open it in Tasks");
  await expect(state.getByTestId("lane-step-checks")).toHaveAttribute("data-tone", "run");
  // beside the button, before it
  expect((await state.boundingBox())!.x).toBeLessThan((await button(page).boundingBox())!.x);

  await button(page).click();
  await expect(panel(page).getByTestId("review-method-step")).toBeVisible();
  expect(await count(page, "review.ask")).toBe(0);
  await panel(page).getByTestId("review-merge-ask").click();
  const ask = panel(page).getByTestId("review-ask");
  await expect(ask).toHaveAttribute("data-kind", "merge");
  await expect(ask).toContainText("Merge pull request #12 into main?");
  await expect(ask.getByTestId("review-method")).toHaveAttribute("data-method", "merge");
  expect(await count(page, "review.ask")).toBe(1);
  expect(await count(page, "review.settle")).toBe(0);

  // Not now settles it too: nothing merges, and the button is there again
  await ask.getByTestId("review-no").click();
  await expect(panel(page)).toHaveCount(0);
  expect(await count(page, "review.settle")).toBe(1);
  await expect(button(page)).toHaveText("Merge");

  await button(page).click();
  await panel(page).getByTestId("review-merge-ask").click();
  await panel(page).getByTestId("review-yes").click();
  await expect(panel(page).getByTestId("review-done")).toHaveAttribute("data-outcome", "merged");
  // merged: no step is left, and the top bar says so
  await expect(head(page).getByTestId("lane-step-merged")).toHaveText("Pull request merged");
  await expect(button(page)).toHaveCount(0);
});

test("pictures in dark and light: Put up for review, its draft and ask, Merge with the request's state, its ask, and a narrow window", async ({ page }) => {
  test.skip(!SHOTS, "MANUT_SHOTS=<dir> keeps the pictures");
  mkdirSync(SHOTS, { recursive: true });
  await setup(page, []);
  await laneOpen(page);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const shot = async (name: string) => page.screenshot({ path: join(SHOTS, `step-${name}-${scheme}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(button(page)).toHaveText("Put up for review");
    await shot("review");
    await button(page).click();
    await expect(panel(page).getByTestId("review-draft")).toBeVisible();
    await shot("draft");
    await panel(page).getByTestId("review-ask-button").click();
    await expect(panel(page).getByTestId("review-ask")).toBeVisible();
    await shot("ask");
    await page.setViewportSize({ width: 900, height: 820 });
    await shot("ask-narrow");
    await panel(page).getByTestId("review-no").click();
    await expect(panel(page)).toHaveCount(0);
    await shot("review-narrow");
  }
  // the same lane with its request open, read again as the Pull requests list reads it
  const pulls = await page.evaluate(async (pull) => {
    (window as any).__manutTasks.boards[Object.keys((window as any).__manutTasks.boards)[0]] = [pull];
    const m = (await import(/* @vite-ignore */ "/src/tasks/pulls.ts" as string)) as { notePulls: (...a: unknown[]) => void };
    m.notePulls("github", "you/baanmali-preorder", [pull], Date.now(), true);
    return true;
  }, PULL());
  expect(pulls).toBe(true);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const shot = async (name: string) => page.screenshot({ path: join(SHOTS, `step-${name}-${scheme}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 1280, height: 820 });
    await expect(button(page)).toHaveText("Merge");
    await shot("merge");
    await button(page).click();
    await panel(page).getByTestId("review-merge-ask").click();
    await expect(panel(page).getByTestId("review-ask")).toBeVisible();
    await shot("merge-ask");
    await panel(page).getByTestId("review-no").click();
    await page.setViewportSize({ width: 900, height: 820 });
    await shot("merge-narrow");
  }
});
