// The chat box's keys (item 95), pressed in the app.
// - Home's box, on the app's own runtime (Practice, `__MANUT_IN_PROCESS__`), whose Buddy answers through the stand-in
//   Claude Code (src/sessions/host.ts): Enter sends and opens what it started; Cmd+Enter sends and stays on Home with a
//   line that opens it; Settings › General › Chat box swaps the two.
// - An open chat while its answer runs, on the mock bridge with Kami's turns driven by hand: Enter waits for the answer
//   (the default) and Cmd+Enter hands that one message in now; Settings swaps them; the line under the box says which.
//   Buddy's own coding agent takes no message mid-answer, so there both keys wait and the line says so.
// - Drafts (Practice): words left in Home's box wait in Drafts at the top of Home; Cmd+S in a chat box puts the draft
//   aside there, picture and all; from there it is put back, or moved into another chat's box, and nothing is sent.
// - Send when the limit resets (mock bridge, a Claude Code chat on the stand-in agent): with its account at its limit the
//   box offers Send at <time>; the message waits above the box and Cancel gives it back; once the reset passes and the
//   account is usable it goes once; long past the reset it asks first, in the chat and on Home.
// What each key does in each state is pinned in src/chat/box/keys.test.ts, the list in src/app/stash.test.ts and the
// reset's rules in src/chat/box/later.test.ts; this spec presses them.
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

  test("with nothing picked a team member's chat takes a message in at once, as it always did, and Cmd+Enter waits; Settings shows Usual", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("set-follow-up").getByRole("radio", { name: "Usual" })).toHaveAttribute("aria-checked", "true");
    await mock("mock.manual", { bot: "kami" });
    await running(page);
    await expect(page.getByTestId("composer-keys")).toHaveCount(0);
    await box(page).fill("keep the old timeout too");
    await expect(page.getByTestId("composer-keys")).toHaveText(/^Enter adds it to this answer now · (⌘|Ctrl\+)Enter waits until it is done$/);
    await box(page).press("Enter");
    await expect.poll(async () => (await calls("chat.steer")).map((c) => c.params.text)).toEqual(["keep the old timeout too"]);
    await expect(page.locator("[data-testid=bubble-user]", { hasText: "keep the old timeout too" })).toHaveAttribute("data-steered", "true");
    await box(page).fill("then run the tests");
    await box(page).press(CMD);
    await expect(held(page, "then run the tests").getByTestId("queue-mark")).toBeVisible();
    expect((await calls("chat.steer")).length).toBe(1);
  });

  test("Settings on Wait for it: Enter waits for the answer and Cmd+Enter adds that one message now; the line under the box says so", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("set-follow-up").getByRole("radio", { name: "Wait for it" }).click();
    await mock("mock.manual", { bot: "kami" });
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

test.describe("send when the limit resets", () => {
  const ROOT = "/home/you/code/baanmali-preorder";
  type SessionCall = { op: string; input?: { kind: string; text?: string } };
  const sessionSends = (page: Page) =>
    page.evaluate(() => ((window as unknown as { __manutSessionCalls?: SessionCall[] }).__manutSessionCalls ?? []).filter((c) => c.op === "chat.input" && c.input?.kind === "send").map((c) => c.input!.text));

  /** A Claude Code chat in a project, open, its agent ready; its account (Claude Code's own login) then at its limit. */
  async function limited(page: Page, clock = false) {
    await mock("mock.reset");
    if (clock) await page.clock.install();
    await page.addInitScript((root) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main" };
    }, ROOT);
    await page.goto("/");
    await chatOpen(page);
    const id = await page.evaluate(async (root) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, "/status");
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
      store.getStore().actions.openSession(id);
      return id as string;
    }, ROOT);
    await expect(page.getByTestId("session-status")).toHaveText("Ready");
    await mock("mock.accounts", { cli: "claude", limit: "default" });
    return id;
  }

  test("the box offers Send at the reset; the message waits above it, and Cancel gives it back", async ({ page }) => {
    await limited(page);
    await box(page).fill("run the tests");
    const offer = page.getByTestId("composer-limit");
    await expect(offer).toContainText(/This account is at its limit until \d\d:\d\d\. Enter sends now anyway\./);
    await offer.getByTestId("composer-wait").click();
    await expect(box(page)).toHaveValue("");
    const row = page.getByTestId("later-row");
    await expect(row).toContainText(/Waiting to send at \d\d:\d\d: run the tests/);
    expect(await sessionSends(page)).not.toContain("run the tests");
    // kept on this computer: a reload brings it back
    await page.reload();
    await expect(page.getByTestId("later-row")).toContainText("run the tests");
    await page.getByTestId("later-cancel").click();
    await expect(page.getByTestId("later-row")).toHaveCount(0);
    await expect(box(page)).toHaveValue("run the tests");
  });

  test("after the reset, once the account is usable again, it goes once", async ({ page }) => {
    await limited(page, true);
    await box(page).fill("run the tests");
    await page.getByTestId("composer-wait").click();
    await expect(page.getByTestId("later-row")).toBeVisible();
    // before the reset nothing goes, however long the app looks
    await page.clock.fastForward("01:00:00");
    expect(await sessionSends(page)).not.toContain("run the tests");
    await mock("mock.accounts", { cli: "claude", lift: "default" });
    await page.clock.fastForward("01:01:00");
    await expect.poll(() => sessionSends(page)).toContain("run the tests");
    await expect(page.getByTestId("later-row")).toHaveCount(0);
    await page.clock.fastForward("00:02:00");
    expect((await sessionSends(page)).filter((t) => t === "run the tests")).toHaveLength(1);
  });

  test("long past the reset it asks first, in the chat and on Home, and goes only on the person's yes", async ({ page }) => {
    await limited(page, true);
    await box(page).fill("run the tests");
    await page.getByTestId("composer-wait").click();
    await page.clock.fastForward("03:05:00");
    const row = page.getByTestId("later-row");
    await expect(row).toHaveAttribute("data-late", "true");
    // three hours on from a run that starts after 21:00 is the next day, and the time then carries its day ("Thu 21:44")
    await expect(row).toContainText(/This was waiting since (?:[A-Z][a-z]{2} )?\d\d:\d\d\. Send it now\?/);
    expect(await sessionSends(page)).not.toContain("run the tests");
    await page.getByTestId("menu-new").click();
    const home = page.getByTestId("home-later");
    await expect(home).toContainText(/A message to .+ was waiting since (?:[A-Z][a-z]{2} )?\d\d:\d\d\. Send it now\?/);
    await home.getByTestId("later-send-now").click();
    await expect.poll(() => sessionSends(page)).toContain("run the tests");
    await expect(page.getByTestId("home-later")).toHaveCount(0);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`shots ${theme}`, async ({ page }) => {
      const DIR = process.env.CHAT_KEYS_SHOTS || "";
      test.skip(!DIR, "CHAT_KEYS_SHOTS not set");
      const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}-${theme}.png`, animations: "disabled" });
      await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
      await limited(page, true);
      await box(page).fill("run the tests, then write the PR description");
      await expect(page.getByTestId("composer-limit")).toBeVisible();
      await shot("limit-offer");
      await page.getByTestId("composer-wait").click();
      await expect(page.getByTestId("later-row")).toBeVisible();
      await shot("limit-waiting");
      await page.clock.fastForward("03:05:00");
      await expect(page.getByTestId("later-row")).toHaveAttribute("data-late", "true");
      await page.getByTestId("menu-new").click();
      await expect(page.getByTestId("home-later")).toBeVisible();
      await shot("limit-late-home");
    });
  }
});

// Pictures of each new state, light and dark, at 1280x820: CHAT_KEYS_SHOTS=<dir>.
test.describe("shots", () => {
  const DIR = process.env.CHAT_KEYS_SHOTS || "";
  for (const theme of ["light", "dark"] as const) {
    test(`shots ${theme}`, async ({ page }) => {
      test.skip(!DIR, "CHAT_KEYS_SHOTS not set");
      const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}-${theme}.png`, animations: "disabled" });
      await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
      // Home: a send that stayed, and three drafts
      await practice(page);
      for (const words of ["Plan the 12.12 sale", "Reply to Khun Mali about the late parcel", "Price list for the jasmine candles"]) {
        await ask(page).fill(words);
        await ask(page).press("ControlOrMeta+s");
      }
      await page.getByTestId("home-mode-chat").click();
      await ask(page).fill("Translate a message");
      await ask(page).press(CMD);
      await expect(page.getByTestId("home-started")).toBeVisible();
      await shot("home-drafts");
      // Settings › General › Chat box
      await page.getByTestId("nav-settings").click();
      await page.getByTestId("set-box").scrollIntoViewIfNeeded();
      await shot("settings-chat-box");
      // Buddy's chat after Cmd+S: the line under the box
      await page.getByTestId("menu-team").click();
      await page.getByTestId("team-buddy").click();
      await box(page).fill("Which shelf is the jasmine candle on?");
      await box(page).press("ControlOrMeta+s");
      await expect(page.getByTestId("composer-stashed")).toBeVisible();
      await shot("chat-put-aside");
    });
    test(`shots running ${theme}`, async ({ page }) => {
      test.skip(!DIR, "CHAT_KEYS_SHOTS not set");
      const shot = (name: string) => page.screenshot({ path: `${DIR}/${name}-${theme}.png`, animations: "disabled" });
      await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
      await mock("mock.reset");
      await mock("mock.manual", { bot: "kami" });
      await page.goto("/");
      await chatOpen(page);
      await box(page).fill("Refactor the gateway retry code");
      await box(page).press("Enter");
      await expect(page.getByTestId("stop")).toBeVisible();
      await box(page).fill("keep the old timeout too");
      await expect(page.getByTestId("composer-keys")).toBeVisible();
      await shot("chat-keys-caption");
    });
  }
});
