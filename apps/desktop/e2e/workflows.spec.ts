// Settings › Workflows (item 77b) in a browser, against the stand-in shell: the workflow files the mock folder holds
// (`window.__manutMockWorkflows`), the switch off at first, Run now starting a lane that takes each step in order from the
// stand-in coding agent (src/sessions/host.ts), the history saying it is done, the lane in the Code page's Lanes band, and the
// command palette's "Run workflow: <name>", which presses the page's own Run now and is offered only while Workflows is on.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";
import { usePlatform } from "./term-find-helpers";

const ROOT = "/home/you/code/baanmali-preorder";

test.beforeEach(async ({ page }) => {
  await usePlatform(page);
  await page.addInitScript((root) => {
    for (const k of ["manut.workflows", "manut.workflows.runs", "manut.workflows.clock", "manut.workflows.seen", "manut.kit.projects"]) localStorage.removeItem(k);
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockWorkflows = {
      path: "/home/you/.manut/workflows",
      state: "ok",
      reads: 0,
      files: [
        { name: "nightly.json", text: JSON.stringify({ name: "Nightly tests", project: root, agent: "claude", steps: ["Run the tests.", "Tidy the README."], schedule: { kind: "daily", at: "02:00" } }) },
        { name: "broken.json", text: "{" },
      ],
    };
  }, ROOT);
  await page.goto("/");
});

async function openWorkflows(page: Page) {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-workflows").click();
  await expect(page.getByTestId("workflows-page")).toBeVisible();
}

/** What the lane a workflow started was sent, in order, as its chat shows it. */
const laneSaid = (page: Page) =>
  page.evaluate(async () => {
    const s = (window as any).__manutSessions;
    const row = s.getState().list.find((r: { workflow?: string }) => r.workflow);
    if (!row) return null;
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { getState(): { chats: Record<string, { items: { kind: string; text?: string }[] }> } } };
    const items = store.getStore().getState().chats[s.chatKey(row.id)]?.items ?? [];
    return { id: row.id as string, title: row.title as string, said: items.filter((i) => i.kind === "user").map((i) => i.text) };
  });

test("off at first; turned on, Run now starts a lane that takes each step in order, and the history says it is done", async ({ page }) => {
  await openWorkflows(page);
  const on = page.getByTestId("workflows-on");
  await expect(on).toHaveAttribute("aria-checked", "false");
  const card = page.getByTestId("workflow").filter({ hasText: "Nightly tests" });
  await expect(card).toContainText("Claude Code · baanmali-preorder · 2 steps");
  await expect(card.getByTestId("workflow-run-now")).toBeDisabled();
  // a file that is not a workflow is listed with why, and left as it is
  await expect(page.getByTestId("workflow-bad")).toContainText("broken.json");
  await expect(page.getByTestId("workflow-bad")).toContainText("It is not valid JSON.");
  await expect(page.getByTestId("workflows-careful")).toContainText("Kit asks before every change in it, whatever the project's dial says");

  await on.click();
  await expect(on).toHaveAttribute("aria-checked", "true");
  await expect(card.getByTestId("workflow-when")).toContainText("Every day at 02:00 · Next:");
  await card.getByTestId("workflow-run-now").click();
  // step by step, then done
  await expect(card.getByTestId("workflow-run").first()).toHaveAttribute("data-state", "done", { timeout: 15_000 });
  await expect(card.getByTestId("workflow-run").first()).toContainText("Done · step 2 of 2");
  const lane = await laneSaid(page);
  expect(lane?.title).toBe("Nightly tests");
  expect(lane?.said).toEqual(["Run the tests.", "Tidy the README."]);
  // the person's settings page stayed where it was: the lane did not open in front of them
  await expect(page.getByTestId("workflows-page")).toBeVisible();

  // the lane is listed where every lane is
  await openCode(page);
  await expect(page.getByTestId(`lane-${lane!.id}`)).toBeVisible();
});

test("the palette offers Run workflow only while Workflows is on, and presses the page's Run now", async ({ page }) => {
  const key = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control";
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("run workflow");
  await expect(page.locator('[data-row^="do:workflow:"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openWorkflows(page);
  await page.getByTestId("workflows-on").click();
  await page.keyboard.press(`${key}+k`);
  await page.getByTestId("palette-input").fill("run workflow");
  const row = page.locator('[data-row="do:workflow:nightly.json"]');
  await expect(row).toHaveText("Run workflow: Nightly tests");
  await row.click();
  await expect(page.getByTestId("palette")).toHaveCount(0);
  // the page with the button it pressed, and the run it started
  await expect(page.getByTestId("workflows-page")).toBeVisible();
  await expect(page.getByTestId("workflow-run").first()).toHaveAttribute("data-state", "done", { timeout: 15_000 });
  expect((await laneSaid(page))?.said).toEqual(["Run the tests.", "Tidy the README."]);
});
