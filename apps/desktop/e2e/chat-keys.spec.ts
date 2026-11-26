// The chat box's keys (item 95), pressed in the app on its own runtime (Practice, `__MANUT_IN_PROCESS__`), whose Buddy
// answers through the stand-in Claude Code (src/sessions/host.ts) and whose demo members take a message mid-answer.
// - Home's box: Enter sends and opens what it started; Cmd+Enter sends and stays on Home with a line that opens it;
//   Settings › General › Chat box swaps the two.
// What each key does in each state is pinned in src/chat/box/keys.test.ts; this spec presses them.
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, homeOpen } from "./start";

const CMD = "ControlOrMeta+Enter";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
    // start on Home, as a first open of the day does
    localStorage.removeItem("manut.resume");
  });
  await page.goto("/");
  await homeOpen(page);
});

const ask = (page: Page) => page.getByTestId("home-ask");

test.describe("Home's box", () => {
  test("Enter sends and opens the chat it went to, as it always has", async ({ page }) => {
    await ask(page).fill("Reply to waiting customers");
    await ask(page).press("Enter");
    await chatOpen(page, "buddy", "Buddy");
    await expect(page.getByTestId("bubble-user").last()).toContainText("Reply to waiting customers");
  });

  test("Cmd+Enter sends and stays on Home, with one line that says where it went and opens it", async ({ page }) => {
    await page.getByTestId("home-mode-chat").click();
    await ask(page).fill("Translate a message");
    await ask(page).press(CMD);
    const line = page.getByTestId("home-started");
    await expect(line).toContainText("Sent to Buddy: Translate a message");
    await expect(page.getByTestId("page-home")).toBeVisible();
    await expect(ask(page)).toHaveValue("");
    await expect(ask(page)).toBeFocused();
    // a second one, while the first works: the line says the newest
    await ask(page).fill("Explain yesterday's sales");
    await ask(page).press(CMD);
    await expect(line).toContainText("Sent to Buddy: Explain yesterday's sales");
    await page.getByTestId("home-started-open").click();
    await expect(page.getByTestId("thread-chat")).toBeVisible();
    await expect(page.getByTestId("bubble-user").first()).toContainText("Explain yesterday's sales");
  });

  test("Settings › General › Chat box swaps them: Enter stays, Cmd+Enter opens", async ({ page }) => {
    await page.getByTestId("nav-settings").click();
    const seg = page.getByTestId("set-after-send");
    await expect(seg.getByRole("radio", { checked: true })).toHaveText("Open the chat");
    await seg.getByRole("radio", { name: "Stay on Home" }).click();
    await page.getByTestId("menu-new").click();
    await ask(page).fill("Reply to waiting customers");
    await ask(page).press("Enter");
    await expect(page.getByTestId("home-started")).toContainText("Sent to Buddy: Reply to waiting customers");
    await expect(page.getByTestId("home-send")).toHaveAttribute("title", /^Send and stay here/);
    await ask(page).fill("Send today's sales summary");
    await ask(page).press(CMD);
    await chatOpen(page, "buddy", "Buddy");
    // the choice is kept on this computer
    await page.reload();
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("set-after-send").getByRole("radio", { checked: true })).toHaveText("Stay on Home");
  });
});
