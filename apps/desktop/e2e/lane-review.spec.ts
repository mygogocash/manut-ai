// Review in the pane beside a lane (src/code/PaneDiff.tsx, item 146), walked in a browser: the Diff unified and side by side with
// the choice kept, one file at a time with Prev and Next and the place ("2 of 7"), the work not committed and each of the lane's
// commits as sections, a note on lines selected in the Diff that carries the file and the line range and waits above the box
// unsent, and a lane row's line about its remote. A browser reads no folder, so the shell's three answers (`lane_diff`,
// `lane_review`, `lane_remote`) are staged for the mock host in their own JSON (`__manutLaneFolder`), which the page reads as it
// reads the shell's. MANUT_SHOTS=<dir> keeps pictures in dark and light (the last test; skipped without it).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const SHOTS = process.env.MANUT_SHOTS || "";

const patch = (path: string, body: string[], head: string[] = []) => [`diff --git a/${path} b/${path}`, ...head, `--- a/${path}`, `+++ b/${path}`, ...body].join("\n") + "\n";
const CHECKOUT = patch("src/checkout.tsx", [
  "@@ -12,4 +12,5 @@",
  "   const total = order.items.reduce(sum, 0);",
  "-  return <PayByTransfer amount={total} />;",
  "+  const qr = promptPayQR(SHOP_ID, total);",
  "+  return <PromptPayQR value={qr} />;",
  " }",
]);
const file = (path: string, diff: string, state = "changed") => ({ path, state, from: null, note: null, diff });
const small = (n: number) => file(`src/part${n}.ts`, patch(`src/part${n}.ts`, ["@@ -1,2 +1,2 @@", " export const a = 1;", `-export const b = ${n};`, `+export const b = ${n + 1};`]));
const CHECKOUT_FILE = file("src/checkout.tsx", CHECKOUT);
const NEW_FILE = file("src/promptpay.ts", patch("src/promptpay.ts", ["@@ -0,0 +1,3 @@", "+export function promptPayQR(id: string, amount: number) {", "+  return `00020101${id}${amount}`;", "+}"], ["new file mode 100644"]), "new");

// seven files since the lane started (the list, "2 of 7"), two not committed, and two commits
const STAGED = {
  diff: { start: "abc123abc123", files: [CHECKOUT_FILE, NEW_FILE, small(1), small(2), small(3), small(4), small(5)], more_files: 0 },
  review: {
    start: "abc123abc123",
    uncommitted: { files: [small(5), small(4)], more_files: 0 },
    commits: [
      { id: "3f2a1bcd9e01", subject: "Add the PromptPay QR", files: [CHECKOUT_FILE, NEW_FILE], more_files: 0, unread: false },
      { id: "9c8d7e6f5a43", subject: "Start the checkout page", files: [small(1)], more_files: 0, unread: false },
    ],
    more_commits: 0,
  },
  remote: { upstream: "origin/kit/promptpay-qr", ahead: 2, behind: 1 },
};

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
const pd = (page: Page) => page.getByTestId("lane-diff-pane");
const files = (page: Page) => page.getByTestId("lane-diff-file");
const radio = (page: Page, group: string, name: string) => page.getByTestId(group).getByRole("radio", { name });
const checkout = (page: Page) => page.locator('[data-testid="lane-diff-file"][data-path="src/checkout.tsx"]');

/** The lane open with its pane on Diff, the shell's answers staged. */
async function laneOpen(page: Page) {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openSession(page, id);
  await expect(page.getByTestId("lane-pane")).toBeVisible();
  await expect(files(page)).toHaveCount(7);
  // the stand-in agent has answered, so nothing it does later is mistaken for what a spec's own press did
  await expect(page.getByTestId("session-status")).toHaveText("Ready");
  return id;
}

/** Drag from the start of the text of `from` to the end of the text of `to`, as a person selects lines with the mouse: from the
 *  first line of the one to the last line of the other (a line wraps in the narrow cells of the split layout, and a press between
 *  two wrapped lines selects nothing). */
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 2, a.y + 9);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 2, b.y + b.height - 9, { steps: 6 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([root, staged]) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main" };
      (window as any).__manutMockTaken = [];
      (window as any).__manutLaneFolder = { "*": staged };
    },
    [ROOT, STAGED] as const,
  );
  await page.goto("/");
});

test("the Diff draws numbered lines, unified, with three scopes and the whole list as before", async ({ page }) => {
  await laneOpen(page);
  await expect(pd(page)).toHaveAttribute("data-layout", "unified");
  await expect(pd(page)).toHaveAttribute("data-one", "false");
  await expect(page.getByTestId("lane-diff-scope").getByRole("radio")).toHaveText(["All changes", "Not committed", "Commits"]);
  await expect(radio(page, "lane-diff-scope", "All changes")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("lane-diff-layout").getByRole("radio")).toHaveText(["Unified", "Side by side"]);
  await expect(page.getByTestId("lane-diff-show").getByRole("radio")).toHaveText(["List", "One at a time"]);
  // the first file's lines carry git's own numbers: the removed line is 13 in the old file, the added ones 13 and 14 in the new
  const removed = checkout(page).locator(".dv-l.del");
  await expect(removed.locator(".dv-n").first()).toHaveText("13");
  await expect(removed.locator(".dv-n").nth(1)).toHaveText("");
  await expect(checkout(page).locator(".dv-l.add .dv-n:nth-child(2)")).toHaveText(["13", "14"]);
  await expect(checkout(page).locator(".dv-l.add .dv-t")).toHaveText(["  const qr = promptPayQR(SHOP_ID, total);", "  return <PromptPayQR value={qr} />;"]);
  // the gutter is no part of what is selected or copied
  expect(await removed.locator(".dv-n").first().evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  await expect(page.getByTestId("lane-diff-prev")).toHaveCount(0);
});

test("side by side puts the removed line against the added one, and the choice is kept for the next lane and after a restart", async ({ page }) => {
  await laneOpen(page);
  await radio(page, "lane-diff-layout", "Side by side").click();
  await expect(pd(page)).toHaveAttribute("data-layout", "split");
  await expect(radio(page, "lane-diff-layout", "Side by side")).toHaveAttribute("aria-checked", "true");
  // the change is one row: the removed line on the left, the added line on the right, each with its own number
  const change = checkout(page).locator(".dv-sr", { has: page.locator(".dv-l.del") });
  await expect(change.locator(".dv-l.del")).toHaveAttribute("data-side", "old");
  await expect(change.locator(".dv-l.add")).toHaveAttribute("data-side", "new");
  await expect(change.locator(".dv-l.del .dv-t")).toHaveText("  return <PayByTransfer amount={total} />;");
  await expect(change.locator(".dv-l.add .dv-t")).toHaveText("  const qr = promptPayQR(SHOP_ID, total);");
  await expect(change.locator(".dv-l.del .dv-n")).toHaveText("13");
  await expect(change.locator(".dv-l.add .dv-n")).toHaveText("13");
  const left = (await change.locator(".dv-l.del").boundingBox())!;
  const right = (await change.locator(".dv-l.add").boundingBox())!;
  expect(right.x).toBeGreaterThan(left.x + left.width - 2);
  expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  // the second added line has no removed line to stand against: an empty cell on the left
  const alone = checkout(page).locator(".dv-sr", { has: page.locator(".dv-l.add", { hasText: "PromptPayQR value" }) });
  await expect(alone.locator(".dv-l.empty")).toHaveCount(1);
  // a line of context is on both sides
  await expect(checkout(page).locator(".dv-l.ctx").first().locator("xpath=..").locator(".dv-l.ctx")).toHaveCount(2);
  // nothing runs wider than the pane
  const pane = (await page.getByTestId("lane-pane").boundingBox())!;
  const body = (await checkout(page).locator(".dv-body").boundingBox())!;
  expect(body.x + body.width).toBeLessThanOrEqual(pane.x + pane.width + 1);

  // kept on this computer
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("manut.pane.diff") ?? "{}"))).toEqual({ layout: "split", one: false });
  // another lane opens in it at once
  const second = await startIn(page, "Fix the receipt.");
  await openSession(page, second);
  await expect(pd(page)).toHaveAttribute("data-layout", "split");
  // and so does the app after a restart
  await page.reload();
  const third = await startIn(page, "Print the QR on the receipt.");
  await openSession(page, third);
  await expect(pd(page)).toHaveAttribute("data-layout", "split");
  await expect(radio(page, "lane-diff-layout", "Side by side")).toHaveAttribute("aria-checked", "true");
  await radio(page, "lane-diff-layout", "Unified").click();
  await expect(pd(page)).toHaveAttribute("data-layout", "unified");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("manut.pane.diff") ?? "{}"))).toEqual({ layout: "unified", one: false });
});

test("one file at a time has Prev and Next and the file's place, and the list is one press away", async ({ page }) => {
  await laneOpen(page);
  await radio(page, "lane-diff-show", "One at a time").click();
  await expect(pd(page)).toHaveAttribute("data-one", "true");
  await expect(files(page)).toHaveCount(1);
  await expect(page.getByTestId("lane-diff-place")).toHaveText("1 of 7");
  await expect(files(page).first()).toContainText("src/checkout.tsx");
  await expect(page.getByTestId("lane-diff-prev")).toBeDisabled();
  await expect(page.getByTestId("lane-diff-next")).toBeEnabled();
  await page.getByTestId("lane-diff-next").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("2 of 7");
  await expect(files(page)).toHaveCount(1);
  await expect(files(page).first()).toContainText("src/promptpay.ts");
  await expect(page.getByTestId("lane-diff-prev")).toBeEnabled();
  for (let n = 3; n <= 7; n++) await page.getByTestId("lane-diff-next").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("7 of 7");
  await expect(files(page).first()).toContainText("src/part5.ts");
  await expect(page.getByTestId("lane-diff-next")).toBeDisabled();
  await page.getByTestId("lane-diff-prev").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("6 of 7");
  await expect(files(page).first()).toContainText("src/part4.ts");
  // the one file takes the height its lines need, where the list caps each file's box
  expect((await files(page).first().locator(".dv-body").evaluate((el) => getComputedStyle(el).maxHeight))).toBe("none");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("manut.pane.diff") ?? "{}"))).toEqual({ layout: "unified", one: true });

  // the list again: every file
  await radio(page, "lane-diff-show", "List").click();
  await expect(files(page)).toHaveCount(7);
  await expect(page.getByTestId("lane-diff-place")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("manut.pane.diff") ?? "{}"))).toEqual({ layout: "unified", one: false });
});

test("Not committed and Commits are sections with their files, and Prev and Next walk the files of every commit", async ({ page }) => {
  await laneOpen(page);
  await radio(page, "lane-diff-scope", "Not committed").click();
  await expect(pd(page)).toHaveAttribute("data-scope", "uncommitted");
  await expect(page.getByTestId("lane-diff-section")).toContainText("Not committed yet");
  await expect(page.getByTestId("lane-diff-section")).toContainText("2 files");
  await expect(files(page)).toHaveCount(2);
  await expect(files(page).first()).toContainText("src/part5.ts");

  await radio(page, "lane-diff-scope", "Commits").click();
  await expect(pd(page)).toHaveAttribute("data-scope", "commits");
  const commits = page.getByTestId("lane-diff-commit");
  await expect(commits).toHaveCount(2);
  await expect(commits.nth(0)).toContainText("3f2a1bcd9e01");
  await expect(commits.nth(0)).toContainText("Add the PromptPay QR");
  await expect(commits.nth(0)).toContainText("2 files");
  await expect(commits.nth(1)).toContainText("Start the checkout page");
  await expect(commits.nth(1)).toContainText("1 file");
  // the newest is open, the other shut until it is pressed
  await expect(commits.nth(0).getByTestId("lane-diff-commit-head")).toHaveAttribute("aria-expanded", "true");
  await expect(commits.nth(1).getByTestId("lane-diff-commit-head")).toHaveAttribute("aria-expanded", "false");
  await expect(files(page)).toHaveCount(2);
  await commits.nth(1).getByTestId("lane-diff-commit-head").click();
  await expect(files(page)).toHaveCount(3);
  await expect(commits.nth(1)).toContainText("src/part1.ts");
  await commits.nth(0).getByTestId("lane-diff-commit-head").click();
  await expect(files(page)).toHaveCount(1);

  // one at a time across the commits: three files, each under its commit
  await radio(page, "lane-diff-show", "One at a time").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("1 of 3");
  await expect(page.getByTestId("lane-diff-in")).toContainText("3f2a1bcd9e01 Add the PromptPay QR");
  await page.getByTestId("lane-diff-next").click();
  await page.getByTestId("lane-diff-next").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("3 of 3");
  await expect(page.getByTestId("lane-diff-in")).toContainText("9c8d7e6f5a43 Start the checkout page");
  await expect(files(page).first()).toContainText("src/part1.ts");

  // back to All changes: the whole list, with no heading
  await radio(page, "lane-diff-scope", "All changes").click();
  await expect(page.getByTestId("lane-diff-place")).toHaveText("1 of 7");
  await radio(page, "lane-diff-show", "List").click();
  await expect(files(page)).toHaveCount(7);
  await expect(page.getByTestId("lane-diff-section")).toHaveCount(0);
});

test("a note on selected lines becomes a chip with the file and the line range, nothing is sent, and the message carries it", async ({ page }) => {
  await laneOpen(page);
  // what the page sent to the agent so far: the first message's start and input (the app's own housekeeping, as `power.busy` when a
  // turn ends, is not a message)
  const sent = (ops: string[]) => ops.filter((op) => op === "chat.start" || op === "chat.input");
  const before = sent(await calls(page));
  expect(before.length).toBeGreaterThan(0);
  await drag(page, checkout(page).locator(".dv-l.add .dv-t").first(), checkout(page).locator(".dv-l.add .dv-t").nth(1));
  await expect(page.getByTestId("note-add")).toBeVisible();
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note-pop")).toBeVisible();
  await expect(page.getByTestId("note-at-place")).toContainText("src/checkout.tsx:L13-L14");
  await page.getByTestId("note-field").fill("check the QR size");
  await page.getByTestId("note-save").click();

  // above the box: the file and the lines, the first words of what was quoted, and the person's words
  const chip = page.getByTestId("carry-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("src/checkout.tsx:L13-L14");
  await expect(chip).toContainText("const qr = promptPayQR");
  await expect(chip).toContainText("check the QR size");
  // nothing was sent to the agent, and no message appeared
  expect(sent(await calls(page))).toEqual(before);
  await expect(page.getByTestId("bubble-carry")).toHaveCount(0);
  // the person sends it, as any message: one more input to the agent, and it carries the note
  await page.getByTestId("composer").fill("Please look at this.");
  await page.getByTestId("composer").press("Enter");
  const bubble = page.getByTestId("bubble-carry").first();
  await expect(bubble).toContainText("src/checkout.tsx:L13-L14");
  await expect(bubble).toContainText("+  const qr = promptPayQR(SHOP_ID, total);");
  await expect(bubble).toContainText("+  return <PromptPayQR value={qr} />;");
  await expect(page.getByTestId("bubble-carry-note").first()).toHaveText("check the QR size");
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);
  expect(sent(await calls(page))).toHaveLength(before.length + 1);
});

test("lines of the removed side are named as deleted lines, numbered as before the change, in either layout", async ({ page }) => {
  await laneOpen(page);
  const removed = checkout(page).locator(".dv-l.del .dv-t");
  await drag(page, removed, removed);
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note-at-place")).toContainText("src/checkout.tsx:L13 (deleted lines, numbered as before the change)");
  await page.getByTestId("note-save").click();
  await expect(page.getByTestId("carry-chip")).toContainText("src/checkout.tsx:L13");

  // the same in the split layout, where the left side is the old file
  await radio(page, "lane-diff-layout", "Side by side").click();
  const left = checkout(page).locator('.dv-l.del[data-side="old"] .dv-t');
  await drag(page, left, left);
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note-at-place")).toContainText("src/checkout.tsx:L13 (deleted lines, numbered as before the change)");
  await page.keyboard.press("Escape");
});

test("in the split layout a drag that begins on the right side takes the right side's lines only, the removed line between them left out", async ({ page }) => {
  await laneOpen(page);
  await radio(page, "lane-diff-layout", "Side by side").click();
  // from the line of context on the right, across the change (whose removed line is on the left), to the second added line
  const start = checkout(page).locator('.dv-l.ctx[data-side="new"] .dv-t').first();
  const end = checkout(page).locator('.dv-l.add[data-side="new"] .dv-t').nth(1);
  await drag(page, start, end);
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note-at-place")).toContainText("src/checkout.tsx:L12-L14");
  await page.getByTestId("note-field").fill("these three");
  await page.getByTestId("note-save").click();
  const chip = page.getByTestId("carry-chip");
  await expect(chip).toContainText("src/checkout.tsx:L12-L14");
  await expect(chip).not.toContainText("PayByTransfer");
  // the sent message quotes the right side's lines and not the removed one
  await page.getByTestId("composer").fill("Look.");
  await page.getByTestId("composer").press("Enter");
  const bubble = page.getByTestId("bubble-carry").first();
  await expect(bubble).toContainText("+  const qr = promptPayQR(SHOP_ID, total);");
  await expect(bubble).toContainText("+  return <PromptPayQR value={qr} />;");
  await expect(bubble).not.toContainText("PayByTransfer");
});

test("text selected outside the Diff's lines is a note as before, with no file or lines", async ({ page }) => {
  await laneOpen(page);
  // the heading of the Diff's own switches is text in the pane: a note on it names no file
  await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="lane-diff-pane"] .dv-path')!;
    const r = document.createRange();
    r.selectNodeContents(pane);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.getByTestId("note-add").click();
  await expect(page.getByTestId("note-at-place")).toHaveCount(0);
  await page.getByTestId("note-field").fill("this file");
  await page.getByTestId("note-save").click();
  const chip = page.getByTestId("carry-chip");
  await expect(chip).toContainText("src/checkout.tsx");
  await expect(chip).not.toContainText(":L");
});

test("a lane's row on the Code page says how far its branch is from its remote", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  const sync = page.getByTestId(`lane-${id}`).getByTestId("lane-sync");
  await expect(sync).toHaveText("2 ahead and 1 behind origin/kit/promptpay-qr");
  await expect(sync).toHaveAttribute("data-ahead", "2");
  await expect(sync).toHaveAttribute("data-behind", "1");
  await expect(sync).toHaveAttribute("title", /Nothing is fetched/);
});

test("pictures in dark and light: unified, side by side, one file, a commit, a note and a row", async ({ page }) => {
  test.skip(!SHOTS, "MANUT_SHOTS=<dir> keeps the pictures");
  mkdirSync(SHOTS, { recursive: true });
  const id = await laneOpen(page);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const shot = async (name: string) => page.screenshot({ path: join(SHOTS, `review-${name}-${scheme}.png`), animations: "disabled" });
    await radio(page, "lane-diff-scope", "All changes").click();
    await radio(page, "lane-diff-show", "List").click();
    await radio(page, "lane-diff-layout", "Unified").click();
    await shot("unified");
    await radio(page, "lane-diff-layout", "Side by side").click();
    await shot("split");
    await radio(page, "lane-diff-show", "One at a time").click();
    await shot("one-split");
    await radio(page, "lane-diff-layout", "Unified").click();
    await shot("one");
    await radio(page, "lane-diff-show", "List").click();
    await radio(page, "lane-diff-scope", "Commits").click();
    await shot("commits");
    await radio(page, "lane-diff-scope", "All changes").click();
    await drag(page, checkout(page).locator(".dv-l.add .dv-t").first(), checkout(page).locator(".dv-l.add .dv-t").nth(1));
    await shot("note-add");
    await page.getByTestId("note-add").click();
    await shot("note-pop");
    await page.getByTestId("note-field").fill("check the QR size");
    await page.getByTestId("note-save").click();
    await shot("note-chip");
    await page.getByTestId("carry-remove").click();
    await openCode(page);
    await expect(page.getByTestId(`lane-${id}`).getByTestId("lane-sync")).toBeVisible();
    await shot("row");
    await openSession(page, id);
    await expect(page.getByTestId("lane-pane")).toBeVisible();
  }
});
