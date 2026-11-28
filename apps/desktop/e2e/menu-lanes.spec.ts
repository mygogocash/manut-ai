// Lanes in the side menu while the code mode is open (item 167a; docs/paradev-ux.md, "Navigation: where a lane is"), as Paradev
// keeps its workspaces in a sidebar that is always there: while the Code row is current (the Code page or a lane open) the menu
// lists every project's lanes in Recent's place, the project the Code page shows first, each a row with its title and one state
// mark, the open lane marked, its More menu on hover and keyboard focus; ⌘⌥↑ and ⌘⌥↓ (Ctrl+Shift+Alt off macOS) open the
// previous and next lane in that order, wrapping. Opening a lane answers nothing: a lane that asks opens with its card in view.
// MENU_LANES_SHOTS=<dir> keeps pictures of the menu in light and dark.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { motionDone } from "./motion";
import { openCode } from "./start";

const SHOTS = process.env.MENU_LANES_SHOTS;
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const ROOT = "/home/you/code/baanmali-preorder";
const OTHER = "/home/you/code/gift-shop";

/** A Claude Code lane in `cwd`, started with `first`, as the + menu's Chat with Kit starts one (kit-lanes.spec.ts). */
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
/** One op to the mock bridge (as icon-menus.spec.ts sends them). */
async function mock(op: string, params: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "ml1", op, ...params }));
  });
  ws.close();
}
const send = (page: Page, id: string, text: string) => page.evaluate(([i, t]) => (window as any).__manutSessions.send(i, t), [id, text]);
type Call = { op: string; id?: string };
const inputs = async (page: Page) => (await page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []))).filter((c) => c.op === "chat.input").length;
const row = (page: Page, id: string) => page.getByTestId(`menu-lane-${id}`);
const open = (page: Page) => page.evaluate(async () => {
  const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { getState(): { ui: { view: string; session: string | null } } } };
  const ui = store.getStore().getState().ui;
  return ui.view === "session" ? ui.session : null;
});

/** Three lanes: Checked and Needs you in the shop's project, Working in another project, the newest session's. */
async function threeLanes(page: Page) {
  const a = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, a, "/kit pass");
  const b = await startIn(page, "Thai date format");
  await send(page, b, "/kit install");
  const c = await startIn(page, "Gift wrap option", OTHER);
  await send(page, c, "/kit slow");
  return { a, b, c };
}

/** The previous and next lane keys on the system the page reports, as keys.ts sets them. */
async function laneKeys(page: Page) {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  return mac ? { prev: "Meta+Alt+ArrowUp", next: "Meta+Alt+ArrowDown" } : { prev: "Control+Shift+Alt+ArrowUp", next: "Control+Shift+Alt+ArrowDown" };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([root, other]) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main", [other]: "main" };
      (window as any).__manutMockTaken = [];
    },
    [ROOT, OTHER],
  );
  await page.goto("/");
});

test("the menu lists every project's lanes in Recent's place while the code mode is open, the Code page's project first", async ({ page }) => {
  // a chat of Buddy's side, listed in Recent
  await mock("mock.reset");
  await mock("mock.threads", { bot: "kami", threads: [{ title: "Late parcels", ago: 60 }] });
  await page.reload();
  const { a, b, c } = await threeLanes(page);
  // a lane started opens it: the code mode, so the menu lists the lanes
  await expect(page.getByTestId("menu-lanes")).toHaveCount(2);
  // Home is Buddy's side: Recent, and no lanes
  await page.getByTestId("menu-home").click();
  await expect(page.getByTestId("page-home")).toBeVisible();
  await expect(page.getByTestId("menu-lanes")).toHaveCount(0);
  await expect(page.getByTestId("menu-recent").filter({ hasText: "Late parcels" })).toBeVisible();

  await openCode(page);
  const lists = page.getByTestId("menu-lanes");
  await expect(lists).toHaveCount(2);
  // the Code page shows the newest session's project, so the menu leads with it
  await expect(lists.nth(0)).toHaveAttribute("data-project", OTHER);
  await expect(lists.nth(1)).toHaveAttribute("data-project", ROOT);
  await expect(page.getByTestId("menu-lanes-h")).toHaveText(["gift-shop", "baanmali-preorder"]);
  await expect(lists.nth(1).getByTestId("menu-lane")).toHaveText(["Thai date format, Needs you", "Add a PromptPay QR to the checkout, Checked"]);
  await expect(page.getByTestId("menu-recent")).toHaveCount(0);
  // one mark a lane, in its state's colour
  await expect(row(page, a)).toHaveAttribute("data-status", "checked");
  await expect(row(page, a).getByTestId("menu-lane-mark")).toHaveAttribute("data-tone", "ok");
  await expect(row(page, b).getByTestId("menu-lane-mark")).toHaveAttribute("data-tone", "warn");
  await expect(row(page, c).getByTestId("menu-lane-mark")).toHaveAttribute("data-tone", "run");

  // picking the other project on the Code page brings its lanes to the top
  await page.getByTestId("kit-project").selectOption(ROOT);
  await expect(lists.nth(0)).toHaveAttribute("data-project", ROOT);

  // Tasks is the Code page's too
  await page.getByTestId("tasks-open").click();
  await expect(page.getByTestId("tasks-page")).toBeVisible();
  await expect(lists).toHaveCount(2);

  // Home is Buddy's: Recent comes back, and the lanes go
  await page.getByTestId("menu-home").click();
  await expect(page.getByTestId("page-home")).toBeVisible();
  await expect(page.getByTestId("menu-lanes")).toHaveCount(0);
  await expect(page.getByTestId("menu-recent").filter({ hasText: "Late parcels" })).toBeVisible();
  await mock("mock.reset");
});

test("walking the lanes from the menu and by the keys opens each, marks it, wraps at the ends, and answers nothing", async ({ page }) => {
  const { a, b, c } = await threeLanes(page);
  const keys = await laneKeys(page);
  await openCode(page);
  await expect(row(page, b)).toHaveAttribute("data-status", "needs_you");
  const sent = await inputs(page);
  await expect(page.getByTestId("menu-needs-count")).toHaveText("1");

  // the lane that asks, from its row: it opens with its card in view and unanswered, marked in the menu, the Code row still current
  await row(page, b).getByTestId("menu-lane").click();
  await expect(page.getByTestId("card-approval")).toBeVisible();
  await expect(page.getByTestId("card-approval").locator("button")).toHaveText(["No", "Allow once", "Always allow in this project"]);
  await expect(row(page, b).getByTestId("menu-lane")).toHaveAttribute("aria-current", "true");
  await expect(page.locator('[data-testid="menu-lane"][aria-current="true"]')).toHaveCount(1);
  await expect(page.getByTestId("menu-code")).toHaveAttribute("aria-current", "page");

  // the menu's order is gift-shop's lane, then the shop's (the newest first): c, b, a
  await page.keyboard.press(keys.next);
  await expect.poll(() => open(page)).toBe(a);
  await expect(row(page, a).getByTestId("menu-lane")).toHaveAttribute("aria-current", "true");
  // past the last: the first
  await page.keyboard.press(keys.next);
  await expect.poll(() => open(page)).toBe(c);
  // before the first: the last
  await page.keyboard.press(keys.prev);
  await expect.poll(() => open(page)).toBe(a);
  await page.keyboard.press(keys.prev);
  await expect.poll(() => open(page)).toBe(b);
  // the groups did not move as the lanes opened
  await expect(page.getByTestId("menu-lanes").nth(0)).toHaveAttribute("data-project", OTHER);

  // nothing was sent to any agent and the ask still waits, with its card
  await expect(page.getByTestId("card-approval").locator("button")).toHaveText(["No", "Allow once", "Always allow in this project"]);
  expect(await inputs(page)).toBe(sent);
  await expect(page.getByTestId("menu-needs-count")).toHaveText("1");
  await expect(row(page, b)).toHaveAttribute("data-status", "needs_you");
});

test("a lane's More menu opens from its row in the menu on hover and from the keyboard, and Pin moves it to the top", async ({ page }) => {
  const { a, b } = await threeLanes(page);
  await openCode(page);
  await page.getByTestId("kit-project").selectOption(ROOT);
  const more = row(page, a).getByTestId("row-more");
  await expect(more).toHaveCSS("opacity", "0");
  await row(page, a).hover();
  await expect(more).toHaveCSS("opacity", "1");
  await page.mouse.move(900, 600);
  await expect(more).toHaveCSS("opacity", "0");

  // from the keyboard: the row's focus shows its More button, which Tab reaches and Return opens
  await row(page, a).getByTestId("menu-lane").focus();
  await expect(more).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("row-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await menu.getByTestId("row-pin").click();
  // pinned: first of its project, with the pin, in the menu and in the band alike
  await expect(page.getByTestId("menu-lanes").nth(0).getByTestId("menu-lane").first()).toContainText("Add a PromptPay QR to the checkout");
  await expect(row(page, a).getByTestId("menu-lane-pin")).toBeVisible();
  await expect(page.getByTestId(`lane-${a}`).getByTestId("lane-pin")).toBeVisible();
  await expect(page.getByTestId(`lane-${b}`)).toBeVisible();
});

for (const theme of ["light", "dark"] as const)
  test(`pictures: the menu's lanes on the Code page and with a lane open (${theme})`, async ({ page }) => {
    test.skip(!SHOTS, "pictures only, with MENU_LANES_SHOTS");
    await page.addInitScript((th) => localStorage.setItem("manut.theme", th), theme);
    await page.reload();
    const { b } = await threeLanes(page);
    await openCode(page);
    await page.getByTestId("kit-project").selectOption(ROOT);
    await motionDone(page);
    await page.screenshot({ path: join(SHOTS!, `menu-lanes-code-${theme}.png`), animations: "disabled" });
    await row(page, b).getByTestId("menu-lane").click();
    await expect(page.getByTestId("card-approval")).toBeVisible();
    await row(page, b).hover();
    await motionDone(page);
    await page.screenshot({ path: join(SHOTS!, `menu-lanes-open-${theme}.png`), animations: "disabled" });
    await page.screenshot({ path: join(SHOTS!, `menu-lanes-menu-${theme}.png`), clip: { x: 0, y: 0, width: 260, height: 520 }, animations: "disabled" });
  });
