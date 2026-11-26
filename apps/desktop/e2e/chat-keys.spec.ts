// The chat box's keys (item 95), pressed in the app.
// - Home's box, on the app's own runtime (Practice, `__MANUT_IN_PROCESS__`), whose Buddy answers through the stand-in
//   Claude Code (src/sessions/host.ts): Enter sends and opens what it started; Cmd+Enter sends and stays on Home with a
//   line that opens it; Settings › General › Chat box swaps the two.
// - An open chat while its answer runs, on the mock bridge with Kami's turns driven by hand: Enter waits for the answer
//   (the default) and Cmd+Enter hands that one message in now; Settings swaps them; the line under the box says which.
//   Buddy's own coding agent takes no message mid-answer, so there both keys wait and the line says so.
// - Drafts (Practice): words left in Home's box wait in Drafts at the top of Home; Cmd+S in a chat box puts the draft
//   aside there, picture and all; from there it is put back, or moved into another chat's box, and nothing is sent.
// What each key does in each state is pinned in src/chat/box/keys.test.ts, and the list in src/app/stash.test.ts; this
// spec presses them.
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, homeOpen, openChat } from "./start";

const CMD = "ControlOrMeta+Enter";
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const out = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
  return out.result;
}
const calls = async (op: string) => ((await mock("mock.calls")).calls as { op: string; params: any }[]).filter((c) => c.op === op);

/** On the app's own runtime, starting on Home. */
async function practice(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
    // start on Home, as a first open of the day does
    localStorage.removeItem("manut.resume");
  });
  await page.goto("/");
  await homeOpen(page);
}

const ask = (page: Page) => page.getByTestId("home-ask");
const box = (page: Page) => page.getByTestId("composer");

test.describe("Home's box", () => {
  test.beforeEach(async ({ page }) => practice(page));

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

test.describe("an open chat while its answer runs", () => {
  test.beforeEach(async () => {
    await mock("mock.reset");
    await mock("mock.manual", { bot: "kami" });
  });

  /** Kami's chat with a turn running (the mock runs no script: the test ends it). */
  async function running(page: Page) {
    await page.goto("/");
    await chatOpen(page);
    await page.getByTestId("composer").fill("Refactor the gateway retry code");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("stop")).toBeVisible();
  }
  const held = (page: Page, text: string) => page.locator("[data-testid=bubble-user][data-held]", { hasText: text });

  test("by default Enter waits for the answer and Cmd+Enter adds that one message now; the line under the box says so", async ({ page }) => {
    await running(page);
    await expect(page.getByTestId("composer-keys")).toHaveCount(0);
    await box(page).fill("keep the old timeout too");
    await expect(page.getByTestId("composer-keys")).toHaveText(/^Enter sends it when this answer is done · (⌘|Ctrl\+)Enter adds it now$/);
    await box(page).press(CMD);
    await expect.poll(async () => (await calls("chat.steer")).map((c) => c.params.text)).toEqual(["keep the old timeout too"]);
    await expect(page.locator("[data-testid=bubble-user]", { hasText: "keep the old timeout too" })).toHaveAttribute("data-steered", "true");
    await box(page).fill("then run the tests");
    await box(page).press("Enter");
    const b = held(page, "then run the tests");
    await expect(b.getByTestId("queue-mark")).toBeVisible();
    expect((await calls("chat.steer")).length).toBe(1);
    await mock("mock.endTurn", { bot: "kami", outcome: "done" });
    await expect.poll(async () => (await calls("chat.send")).map((c) => c.params.text)).toEqual(["Refactor the gateway retry code", "then run the tests"]);
  });

  test("Settings on Add it now: Enter adds it now and Cmd+Enter waits", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("set-follow-up").getByRole("radio", { name: "Add it now" }).click();
    await mock("mock.manual", { bot: "kami" });
    await running(page);
    await box(page).fill("hold this one");
    await expect(page.getByTestId("composer-keys")).toHaveText(/^Enter adds it to this answer now · (⌘|Ctrl\+)Enter waits until it is done$/);
    await box(page).press(CMD);
    await expect(held(page, "hold this one")).toBeVisible();
    expect((await calls("chat.steer")).length).toBe(0);
  });
});

test.describe("an agent that cannot take a message mid-answer", () => {
  test("Buddy's coding agent: both keys wait, and the line under the box says so", async ({ page }) => {
    await practice(page);
    await openChat(page, "buddy", "Buddy");
    // the stand-in Claude Code streams `/slow` for a while without ending its turn
    await page.evaluate(async () => {
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { send(t: string): Promise<void> } } };
      await store.getStore().actions.send("/slow");
    });
    await expect(page.getByTestId("stop")).toBeVisible();
    await box(page).fill("and the docs");
    await expect(page.getByTestId("composer-keys")).toHaveText(/^Buddy takes it when this answer is done, with Enter or (⌘|Ctrl\+)Enter$/);
    await box(page).press(CMD);
    await expect(page.locator("[data-testid=bubble-user][data-held]", { hasText: "and the docs" })).toBeVisible();
  });
});

test.describe("Drafts at the top of Home", () => {
  test.beforeEach(async ({ page }) => practice(page));
  const rows = (page: Page) => page.getByTestId("home-draft");

  test("words left in Home's box wait in Drafts; the row puts them back in the box", async ({ page }) => {
    await expect(page.getByTestId("home-drafts")).toHaveCount(0);
    await ask(page).fill("Plan the 12.12 sale");
    await page.getByTestId("menu-team").click();
    await page.getByTestId("menu-new").click();
    await expect(ask(page)).toHaveValue("");
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Plan the 12.12 sale");
    await expect(rows(page)).toContainText("From Home");
    await rows(page).getByTestId("home-draft-back").click();
    await expect(ask(page)).toHaveValue("Plan the 12.12 sale");
    await expect(page.getByTestId("home-drafts")).toHaveCount(0);
  });

  test("Cmd+S in Home's box puts it aside; five are kept, a sixth lets the oldest go with an Undo; × deletes one", async ({ page }) => {
    for (let n = 1; n <= 6; n++) {
      await ask(page).fill(`draft ${n}`);
      await ask(page).press("ControlOrMeta+s");
      await expect(ask(page)).toHaveValue("");
    }
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).first()).toContainText("draft 6");
    await expect(page.getByTestId("home-draft-dropped")).toContainText("draft 1");
    await page.getByTestId("home-draft-undo").click();
    await expect(rows(page)).toHaveCount(6);
    await expect(page.getByTestId("home-draft-dropped")).toHaveCount(0);
    await rows(page).filter({ hasText: "draft 3" }).getByTestId("home-draft-delete").click();
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).filter({ hasText: "draft 3" })).toHaveCount(0);
  });

  test("Cmd+S in a chat puts the draft aside with its picture; Move to puts it into another chat's box, and nothing is sent", async ({ page }) => {
    await openChat(page, "buddy", "Buddy");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach").click();
    await page.getByTestId("attach-files").click();
    await (await chooser).setFiles([{ name: "shelf.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }]);
    await expect(page.getByTestId("attach-chips").locator("[data-testid=attach-remove]")).toHaveCount(1);
    await box(page).fill("Which shelf is the jasmine candle on?");
    await box(page).press("ControlOrMeta+s");
    await expect(box(page)).toHaveValue("");
    await expect(page.getByTestId("attach-chips")).toHaveCount(0);
    await expect(page.getByTestId("composer-stashed")).toHaveText("Put aside in Drafts, at the top of Home.");
    await expect(page.getByTestId("bubble-user").filter({ hasText: "jasmine candle" })).toHaveCount(0);

    await page.getByTestId("menu-new").click();
    const row = rows(page);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("1 file · From Buddy");
    await row.getByTestId("home-draft-move").click();
    // a draft with a picture goes to a chat whose box holds pictures: no Home box, no coding session
    await expect(page.getByTestId("home-draft-place").first()).toHaveText("Nam's chat");
    await page.locator("[data-testid=home-draft-place][data-place=nam]").click();
    await chatOpen(page, "nam", "Nam");
    await expect(box(page)).toHaveValue("Which shelf is the jasmine candle on?");
    await expect(page.getByTestId("attach-chips").locator("[data-testid=attach-remove]")).toHaveCount(1);
    await expect(page.getByTestId("attach-chips")).toContainText("shelf.png");
    await expect(page.getByTestId("bubble-user").filter({ hasText: "jasmine candle" })).toHaveCount(0);
    await page.getByTestId("menu-new").click();
    await expect(page.getByTestId("home-drafts")).toHaveCount(0);
  });
});
