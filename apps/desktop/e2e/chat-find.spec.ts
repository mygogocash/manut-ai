// Find in a chat (item 150), on the mock bridge: Kami's chat with two finished turns whose steps are folded (e2e/chat-find.ts).
// Cmd+F (Ctrl+F off macOS) opens a bar at the chat's top right; typing counts matches across the messages and the steps,
// folded ones included; Enter and Shift+Enter move and wrap; a match in a folded step opens its group while it is the
// current match and shuts it when the person moves on, unless they had opened it; Esc closes the bar and the chat box has
// the keyboard. Matches are painted without touching the messages: with the CSS Custom Highlight API, and, where a web
// view has none (CSS.highlights removed here, as the macOS 11 web view has none), with a layer of boxes. A key the chat
// shows masked is found masked. The terminal keeps its own find. Shots (dark/light): MANUT_SHOTS=<dir>.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mock, modKey, usePlatform } from "./term-find-helpers";
import { bar, bubbles, count, find, goTo, group, input, KEY, painted, stage, tl } from "./chat-find";

const SHOTS = process.env.MANUT_SHOTS || "";
test.use({ colorScheme: "dark" });

const toggle = (page: Page, n: 0 | 1) => group(page, n).getByTestId("activity-toggle");
const expanded = (page: Page, n: 0 | 1) => toggle(page, n).getAttribute("aria-expanded");
const composer = (page: Page) => page.getByTestId("composer");

test("Cmd/Ctrl+F opens a bar at the chat's top right; typing counts across messages and folded steps; Enter and Shift+Enter move and wrap; Match case narrows; Esc closes it and the chat box has the keyboard", async ({ page }) => {
  await stage(page);
  await composer(page).focus();
  await expect(bar(page)).toHaveCount(0);
  await find(page);
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  // at the column's top right, inside it
  const [b, t] = await Promise.all([bar(page).boundingBox(), tl(page).boundingBox()]);
  expect(b!.y - t!.y).toBeLessThan(24);
  expect(t!.x + t!.width - (b!.x + b!.width)).toBeLessThan(40);
  expect(b!.x).toBeGreaterThan(t!.x + t!.width / 2);

  // nothing to say before a word is typed; then the count, which is of the folded steps' words and the answers' alike
  await expect(count(page)).toHaveText("");
  await input(page).fill("checkout");
  await expect(count(page)).toHaveText(/^[1-4] of 4$/);
  // in the order the page draws them: A's two steps, A's answer, B's answer
  await goTo(page, "1 of 4");
  for (const at of ["2 of 4", "3 of 4", "4 of 4", "1 of 4"]) {
    await page.keyboard.press("Enter");
    await expect(count(page)).toHaveText(at);
  }
  // back round the other way
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("4 of 4");
  await page.keyboard.press("Shift+Enter");
  await expect(count(page)).toHaveText("3 of 4");
  // the buttons do the same
  await page.getByTestId("chat-find-next").click();
  await expect(count(page)).toHaveText("4 of 4");
  await page.getByTestId("chat-find-prev").click();
  await expect(count(page)).toHaveText("3 of 4");

  // Match case: Checkout of B's answer is out
  await page.getByTestId("chat-find-case").click();
  await expect(page.getByTestId("chat-find-case")).toHaveAttribute("aria-pressed", "true");
  await expect(count(page)).toHaveText(/^[1-3] of 3$/);
  await input(page).focus();
  await page.keyboard.press("Alt+c");
  await expect(page.getByTestId("chat-find-case")).toHaveAttribute("aria-pressed", "false");
  await expect(count(page)).toHaveText(/ of 4$/);

  // a word nowhere, and an empty field
  await input(page).fill("zzz-nothing");
  await expect(count(page)).toHaveText("No matches");
  await expect(page.getByTestId("chat-find-next")).toBeDisabled();
  await input(page).fill("");
  await expect(count(page)).toHaveText("");

  // Esc: the bar goes with its highlights, and the keyboard is the chat box's again
  await input(page).fill("checkout");
  await expect(count(page)).toHaveText(/ of 4$/);
  await page.keyboard.press("Escape");
  await expect(bar(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();
  expect(await painted(page)).toMatchObject({ plain: [], current: [], boxes: 0 });
  await page.keyboard.type("hi");
  await expect(composer(page)).toHaveValue("hi");
  // the steps were drawn hidden for the bar and are not left behind
  await expect(page.getByTestId("activity-details")).toHaveCount(0);
});

test("a match in a folded step opens its group while it is the current match and shuts it when the person moves on; a click shuts it for good; a group the person opened stays open", async ({ page }) => {
  await stage(page);
  await expect(await expanded(page, 0)).toBe("false");
  await find(page);
  await input(page).fill("checkout");
  await goTo(page, "1 of 4");
  // the group of A opens to show the step the match is in
  await expect.poll(() => expanded(page, 0)).toBe("true");
  await expect(group(page, 0).getByTestId("activity-details")).toBeVisible();
  await expect(group(page, 0).getByTestId("activity-step").first()).toContainText("pnpm test checkout");
  // the match itself is painted and inside the view
  await expect.poll(async () => (await painted(page)).current.length + (await painted(page)).rings).toBeGreaterThan(0);
  const inView = async () => {
    const [view, step] = await Promise.all([tl(page).boundingBox(), group(page, 0).getByTestId("activity-step").first().boundingBox()]);
    return step!.y >= view!.y && step!.y + step!.height <= view!.y + view!.height;
  };
  await expect.poll(inView).toBe(true);
  // the second step is in the same group: it stays open
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("2 of 4");
  await expect(await expanded(page, 0)).toBe("true");
  // A's answer is not in a fold: the group shuts again
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("3 of 4");
  await expect.poll(() => expanded(page, 0)).toBe("false");
  await expect(group(page, 0).getByTestId("activity-step").first()).toBeHidden();
  // wrapped round to the first step: it opens again; the person then shuts it by hand
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("1 of 4");
  await expect.poll(() => expanded(page, 0)).toBe("true");
  await toggle(page, 0).click();
  await expect.poll(() => expanded(page, 0)).toBe("false");
  // the page changes (a message comes) and the find reads it again: it does not open the group behind the click
  await mock("mock.emit", { events: [{ event: "message", bot: "kami", id: "late", text: "One more word about the checkout." }] });
  await expect(count(page)).toHaveText("1 of 5");
  await page.waitForTimeout(400);
  await expect(await expanded(page, 0)).toBe("false");
  // moving on to another match brings it back
  await page.getByTestId("chat-find-next").click();
  await expect(count(page)).toHaveText("2 of 5");
  await expect.poll(() => expanded(page, 0)).toBe("true");
  await page.keyboard.press("Escape");
  await expect.poll(() => expanded(page, 0)).toBe("false");

  // a group the person opened is theirs: the find passes through it and leaves it open
  await toggle(page, 0).click();
  await expect.poll(() => expanded(page, 0)).toBe("true");
  await find(page);
  await input(page).fill("checkout");
  await goTo(page, "3 of 5");
  await expect.poll(() => expanded(page, 0)).toBe("true");
  await page.keyboard.press("Escape");
  await expect(await expanded(page, 0)).toBe("true");
  await toggle(page, 0).click();
  await expect.poll(() => expanded(page, 0)).toBe("false");
});

test("matches are painted by the browser's highlights, the current one apart; nothing is added to the messages and nothing moves", async ({ page }) => {
  await stage(page);
  const before = await bubbles(page);
  await find(page);
  await input(page).fill("checkout");
  await goTo(page, "3 of 4");
  const p = await painted(page);
  test.skip(!p.api, "this web view has no CSS Custom Highlight API: the boxes are the next test's");
  // A's answer is the current match; the others, folded steps among them, are painted with it
  expect(p.current).toEqual(["checkout"]);
  expect(p.plain).toHaveLength(3);
  expect(p.plain.map((w) => w.toLowerCase())).toEqual(["checkout", "checkout", "checkout"]);
  expect(p.boxes).toBe(0);
  // the messages are the very markup they were, where they were: no wrapper round a word, no extra node
  expect(await bubbles(page)).toEqual(before);
  await expect(tl(page).locator("mark, .cf-box")).toHaveCount(0);
  // another match in another message
  await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText("4 of 4");
  expect((await painted(page)).current).toEqual(["Checkout"]);
  expect(await bubbles(page)).toEqual(before);
});

test("where the web view has no highlights, a layer of boxes marks each match in view, the current one ringed, and follows a scroll", async ({ page }) => {
  // the macOS 11 web view has no CSS.highlights: the page is told so before it loads
  await page.addInitScript(() => Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true }));
  await stage(page);
  const before = await bubbles(page);
  await find(page);
  await input(page).fill("checkout");
  await goTo(page, "3 of 4");
  expect(await painted(page)).toMatchObject({ api: false, plain: [], current: [] });
  await expect.poll(async () => (await painted(page)).rings).toBe(1);
  const layer = page.locator(".cf-layer");
  await expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(await layer.evaluate((l) => getComputedStyle(l).pointerEvents)).toBe("none");
  // the ringed box lies exactly over the current match's words, in A's answer
  const over = () =>
    page.evaluate(() => {
      const ring = document.querySelector<HTMLElement>(".cf-cur")!.getBoundingClientRect();
      const answer = [...document.querySelectorAll<HTMLElement>('[data-testid="bubble-bot"]')].find((b) => b.textContent?.includes("read the checkout file"))!;
      const w = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = w.nextNode())) {
        const at = (n.textContent ?? "").indexOf("checkout");
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + 8);
        const m = r.getBoundingClientRect();
        return { dx: Math.abs(ring.left - m.left), dy: Math.abs(ring.top - m.top), dw: Math.abs(ring.width - m.width), dh: Math.abs(ring.height - m.height) };
      }
      return null;
    });
  const at = await over();
  expect(at!.dx).toBeLessThan(2);
  expect(at!.dy).toBeLessThan(2);
  expect(at!.dw).toBeLessThan(2);
  expect(at!.dh).toBeLessThan(2);
  // nothing in the messages changed
  expect(await bubbles(page)).toEqual(before);
  // the boxes follow the column's scroll
  const ringY = async () => (await page.locator(".cf-cur").first().boundingBox())?.y ?? Number.NaN;
  await expect.poll(ringY).not.toBeNaN();
  const y0 = await ringY();
  await tl(page).evaluate((el) => (el.scrollTop -= 60));
  await expect.poll(async () => Math.round((await ringY()) - y0)).toBe(60);
  await expect.poll(over).toMatchObject({ dx: expect.any(Number) });
  const moved = await over();
  expect(moved!.dy).toBeLessThan(2);
  // and go with the bar
  await page.keyboard.press("Escape");
  await expect(page.locator(".cf-cur, .cf-box")).toHaveCount(0);
});

test("Thai text is found as any other text", async ({ page }) => {
  await stage(page);
  await find(page);
  await input(page).fill("ยอดรวม");
  await expect(count(page)).toHaveText("1 of 1");
  await expect.poll(async () => (await painted(page)).current.length + (await painted(page)).rings).toBe(1);
  const p = await painted(page);
  if (p.api) expect(p.current).toEqual(["ยอดรวม"]);
  await input(page).fill("ครับ");
  await expect(count(page)).toHaveText("1 of 1");
});

test("a key the chat shows masked is found masked: the key itself is never a match", async ({ page }) => {
  await stage(page);
  // the file edit's change, opened by hand as a person does: its line is drawn with the key hidden
  await toggle(page, 1).click();
  await group(page, 1).getByTestId("activity-step").click();
  const line = group(page, 1).locator(".dv-l.add");
  await expect(line).toBeVisible();
  const drawn = ((await line.textContent()) ?? "").trim();
  expect(drawn).toContain("PROMPTPAY_KEY");
  expect(drawn).not.toContain(KEY);
  expect(await tl(page).textContent()).not.toContain(KEY);
  await find(page);
  await input(page).fill(KEY);
  await expect(count(page)).toHaveText("No matches");
  await input(page).fill("PROMPTPAY_KEY");
  await expect(count(page)).toHaveText("1 of 1");
  // what is drawn there, mask and all, is found by what is drawn
  await input(page).fill(drawn);
  await expect(count(page)).toHaveText("1 of 1");
});

test("the terminal keeps its own find: the bottom panel's bar opens there and the chat's does not, and with the keyboard back in the chat box the chat's opens", async ({ page }) => {
  await stage(page);
  await page.evaluate(async () => {
    const m = (await import("/src/terminal/state.ts" as string)) as { setTerminalCwd(p: string | null): void };
    m.setTerminalCwd("/home/you/code/web-app");
  });
  await page.keyboard.press("Control+Backquote");
  await expect(page.getByTestId("termpanel")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="termpanel-terminal"]'))).toBe(true);
  await find(page);
  await expect(page.getByTestId("term-find")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("term-find")).toHaveCount(0);
  // the chat box: the chat's bar, and the terminal's does not open
  await composer(page).focus();
  await find(page);
  await expect(bar(page)).toBeVisible();
  await expect(page.getByTestId("term-find")).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeFocused();
});

test("the pane beside a lane keeps the key: with the keyboard in it, Cmd+F opens nothing; from the lane's chat box it opens the lane chat's bar", async ({ page }) => {
  const ROOT = "/home/you/code/baanmali-preorder";
  await mock("mock.reset");
  await usePlatform(page);
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as unknown as { __manutBranches: object }).__manutBranches = { [root]: "main" };
    (window as unknown as { __manutMockTaken: string[] }).__manutMockTaken = [];
  }, ROOT);
  await page.goto("/");
  // a Claude Code session in a project, running as a chat: a lane, with the pane beside its chat (as lane-pane.spec.ts does)
  const id = await page.evaluate(async (root) => {
    const sessions = (window as unknown as { __manutSessions: { loadAgents(): Promise<void>; draft(a: string): string; setDraft(id: string, d: object): void; start(id: string, text: string): Promise<void> } }).__manutSessions;
    await sessions.loadAgents();
    const sid = sessions.draft("claude");
    sessions.setDraft(sid, { cwd: root });
    await sessions.start(sid, "Add a PromptPay QR to the checkout.");
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(sid);
    return sid;
  }, ROOT);
  expect(id).toBeTruthy();
  await expect(page.getByTestId("lane-pane")).toBeVisible();
  await expect(page.getByTestId("session-status")).toHaveText("Ready");
  await page.getByTestId("lane-chip-tests").focus();
  await expect(page.getByTestId("lane-chip-tests")).toBeFocused();
  await find(page);
  await page.waitForTimeout(300);
  await expect(bar(page)).toHaveCount(0);
  // from the chat box of the same view: the bar opens in the chat's column, not over the pane
  await composer(page).focus();
  await find(page);
  await expect(bar(page)).toBeVisible();
  const [b, chat, side] = await Promise.all([bar(page).boundingBox(), page.getByTestId("session-chat").boundingBox(), page.getByTestId("lane-pane").boundingBox()]);
  expect(b!.x).toBeGreaterThanOrEqual(chat!.x);
  expect(b!.x + b!.width).toBeLessThanOrEqual(chat!.x + chat!.width);
  expect(b!.x + b!.width).toBeLessThanOrEqual(side!.x + 1);
  await input(page).fill("PromptPay");
  await expect(count(page)).toHaveText(/ of \d+$/);
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeFocused();
});

test("the palette and a field of another page keep the key; with no chat on screen it does nothing", async ({ page }) => {
  await stage(page);
  const mod = await modKey(page);
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.press(`${mod}+f`);
  await expect(bar(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  // Settings has no chat: the key is left alone
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
  await page.keyboard.press(`${mod}+f`);
  await page.waitForTimeout(200);
  await expect(bar(page)).toHaveCount(0);
});

test.describe("shots", () => {
  test.skip(!SHOTS, "MANUT_SHOTS unset");
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  for (const theme of ["dark", "light"] as const) {
    test(`chat-find-${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await stage(page, { theme });
      await find(page);
      await input(page).fill("checkout");
      await goTo(page, "2 of 4");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `chat-find-${theme}.png`) });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(SHOTS, `chat-find-${theme}-answer.png`) });
    });
  }
  for (const theme of ["dark", "light"] as const) {
    test(`chat-find-boxes-${theme}: no highlight API`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript(() => Object.defineProperty(CSS, "highlights", { value: undefined, configurable: true }));
      await stage(page, { theme });
      await find(page);
      await input(page).fill("checkout");
      await goTo(page, "3 of 4");
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `chat-find-boxes-${theme}.png`) });
    });
  }
});
