// The chat box (item 80, the owner's "please make chat feature support model, effort, approval, add context"): the same
// four in Kit's chat and in Buddy's. The model with its effort beside it, from what the person's own agent listed; the
// approval level, offering only the agent's own presets (and, in a coding chat, Kit's dial for the project); and a + that
// opens Add context with Files, Folder, Mention (Buddy's chat only) and Actions. Kit's chat runs on the stand-in coding
// agent of src/sessions/host.ts, as kit-lanes.spec.ts's do; Buddy's on Practice, the app's own runtime, whose Buddy
// answers through the same stand-in Claude Code on a list of its own (src/runtime/mock/buddy.ts).
import { expect, test, type Page } from "@playwright/test";
import { openChat } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
type Call = { op: string; id?: number; input?: { kind: string; text?: string; model?: string; effort?: string; mode?: string }; name?: string; path?: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));

test.describe("Kit's chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((root) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main" };
    }, ROOT);
    await page.goto("/");
  });

  /** A Claude Code lane in the project, started through the sessions store as the + menu's Chat with Kit does, then
   *  open in the main column. */
  async function lane(page: Page): Promise<string> {
    const id = await page.evaluate(async (root) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, "/status");
      return id as string;
    }, ROOT);
    await page.evaluate(async (i) => {
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
      store.getStore().actions.openSession(i);
    }, id);
    await expect(page.getByTestId("session-status")).toHaveText("Ready");
    return id;
  }

  test("the model and its effort are in the box, not the header, and a pick goes to the agent", async ({ page }) => {
    await lane(page);
    const box = page.getByTestId("composer-box");
    await expect(box.getByTestId("model-label")).toHaveText("Opus 5.5");
    await expect(box.getByTestId("reasoning-label")).toHaveText("High");
    await expect(page.getByTestId("head-right").getByTestId("model-pill")).toHaveCount(0);
    // the chip opens the effort card (item 132); its title opens the model list, and a pick comes back to the card
    await box.getByTestId("model-pill").click();
    await page.getByTestId("effort-title").click();
    await expect(page.getByTestId("model-opt")).toHaveText(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    await page.getByTestId("model-opt").filter({ hasText: "Haiku 5.5" }).click();
    await expect(page.getByTestId("effort-model")).toHaveText("Haiku 5.5");
    await page.getByTestId("effort-slider").press("Home");
    await expect(page.getByTestId("effort-level")).toHaveText("Low");
    await page.keyboard.press("Escape");
    await expect(box.getByTestId("reasoning-label")).toHaveText("Low");
    const sent = (await calls(page)).filter((c) => c.op === "chat.input").map((c) => c.input);
    expect(sent).toContainEqual({ kind: "model", model: "haiku" });
    expect(sent).toContainEqual({ kind: "effort", effort: "low" });
  });

  test("approval: the agent's own presets, then Kit's dial for the project, which the Code page's dial shares", async ({ page }) => {
    await lane(page);
    const mode = page.getByTestId("session-mode");
    await expect(mode).toHaveText("Ask");
    await mode.click();
    const menu = page.getByTestId("session-mode-menu");
    await expect(page.getByTestId("session-mode-opt")).toHaveText([/^Ask/, /^Plan/, /^Accept edits/]);
    await expect(menu).not.toContainText(/bypass|skip|danger/i);
    await expect(menu.getByTestId("kit-box-level")).toContainText("How much Kit does alone · baanmali-preorder");
    await expect(page.getByTestId("kit-box-level-asks_every_time")).toHaveAttribute("aria-pressed", "true");
    await expect(menu).toContainText("Going live always asks, at every level.");
    await page.getByTestId("kit-box-level-edits_alone").click();
    await expect(page.getByTestId("kit-box-level-edits_alone")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("kit-box-level-line")).toHaveText("Kit edits files alone. Every command that changes the project asks first.");
    // the same setting the Code page's dial writes
    const saved = await page.evaluate((root) => JSON.parse(localStorage.getItem("manut.kit.projects") ?? "{}")[root]?.level, ROOT);
    expect(saved).toBe("edits_alone");
    // the agent's own mode is still picked here, and sent as its own switch
    await page.getByTestId("session-mode-opt").filter({ hasText: "Plan" }).click();
    await expect(mode).toHaveText("Plan");
    expect((await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "mode").map((c) => c.input)).toEqual([{ kind: "mode", mode: "plan" }]);
  });

  test("Add context: files, a folder named by its path, and the agent's actions; no teammate to mention", async ({ page }) => {
    await lane(page);
    await page.getByTestId("attach").click();
    const menu = page.getByTestId("attach-menu");
    await expect(menu.getByRole("menuitem")).toHaveText([/^Add photos and files/, /^Folder/, /Actions and skills/, /^Bring context from…$/]);
    await expect(page.getByTestId("attach-mention")).toHaveCount(0);
    // Folder: the native picker (the mock's stand-in), a chip, then a line of its own under the text
    await page.evaluate((root) => ((window as any).__manutPickFolder = `${root}/src`), ROOT);
    await page.getByTestId("attach-folder").click();
    await expect(page.getByTestId("folder-chip")).toHaveAttribute("data-path", `${ROOT}/src`);
    await page.getByTestId("composer").fill("what is in here?");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("folder-chips")).toHaveCount(0);
    const send = (await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "send").pop();
    expect(send?.input?.text).toBe(`what is in here?\n\nFolder: ${ROOT}/src`);
    // Actions over text already typed: the agent's / menu opens, and the action goes in front
    await page.getByTestId("composer").fill("the checkout");
    await page.getByTestId("attach").click();
    await page.getByTestId("attach-actions").click();
    await expect(page.getByTestId("command-picker")).toBeVisible();
    await page.getByTestId("command-option").filter({ hasText: "/review" }).click();
    await expect(page.getByTestId("composer")).toHaveValue("/review the checkout");
  });
});

test.describe("Buddy's chat in Practice", () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${Number(process.env.MANUT_PORT || 5307)}`,
          localStorage: [
            { name: "manut.onboarded", value: "1" },
            { name: "manut.lang", value: "en" },
            { name: "manut.notify.quiet", value: "00:00-00:00" },
          ],
        },
      ],
    },
  });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
      (window as any).__manutPickFolder = "/home/you/Shop";
    });
    await page.goto("/");
    await openChat(page, "buddy", "Buddy");
  });

  const box = (page: Page) => page.getByTestId("composer-box");

  test("starts careful, with no model of ours: the agent's own list once it has started, and each choice goes to it", async ({ page }) => {
    await expect(page.getByTestId("head-right").getByTestId("model-pill")).toHaveCount(0);
    await expect(box(page).getByTestId("model-label")).toHaveText("Claude Code");
    await expect(page.getByTestId("box-approval")).toHaveText("Ask");
    await box(page).getByTestId("model-pill").click();
    // nothing listed yet: the card says why in the slider's place, and so does the list behind its title
    await expect(page.getByTestId("effort-none")).toHaveText("Claude Code lists its models once it has started. Send a message, then pick one here.");
    await page.getByTestId("effort-title").click();
    await expect(page.getByTestId("model-empty")).toHaveText("Claude Code lists its models once it has started. Send a message, then pick one here.");
    await page.keyboard.press("Escape");
    // the first message starts the person's agent, which lists its models and says what it runs
    await page.getByTestId("composer").fill("hi");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: hi");
    await expect(box(page).getByTestId("model-label")).toHaveText("Opus 5.5");
    await expect(box(page).getByTestId("reasoning-label")).toHaveText("High");
    await box(page).getByTestId("model-pill").click();
    await page.getByTestId("effort-title").click();
    await expect(page.getByTestId("model-opt")).toHaveText(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    await page.getByTestId("model-opt").filter({ hasText: "Haiku 5.5" }).click();
    await expect(page.getByTestId("effort-model")).toHaveText("Haiku 5.5");
    // Buddy answers through Claude Code: the card offers its Ultrathink row too
    await expect(page.getByTestId("ultrathink-row")).toBeVisible();
    await page.getByTestId("effort-slider").press("Home");
    await expect(page.getByTestId("effort-level")).toHaveText("Low");
    await page.keyboard.press("Escape");
    await expect(box(page).getByTestId("model-label")).toHaveText("Haiku 5.5");
    await expect(box(page).getByTestId("reasoning-label")).toHaveText("Low");
    // approval: Ask and Plan only, in plain words; never a level that skips asking
    await page.getByTestId("box-approval").click();
    const menu = page.getByTestId("box-approval-menu");
    await expect(page.getByTestId("box-approval-opt")).toHaveText([/^AskAsks you before it changes, sends or runs anything/, /^PlanSays what it would do, and changes nothing until you say yes/]);
    await expect(menu).not.toContainText(/Accept edits|bypass|skip|danger/i);
    await page.getByTestId("box-approval-opt").filter({ hasText: "Plan" }).click();
    await expect(page.getByTestId("box-approval")).toHaveText("Plan");
    const sent = (await calls(page)).filter((c) => c.op === "buddy.input").map((c) => c.input);
    expect(sent).toContainEqual({ kind: "model", model: "haiku" });
    expect(sent).toContainEqual({ kind: "effort", effort: "low" });
    expect(sent).toContainEqual({ kind: "mode", mode: "plan" });
  });

  test("Add context: a file's copy and a folder are named in the message, a teammate by @, and the demo's and agent's actions", async ({ page }) => {
    await page.getByTestId("attach").click();
    await expect(page.getByTestId("attach-menu").getByRole("menuitem")).toHaveText([/^Add photos and files/, /^Folder/, /Mention a teammate/, /Actions and skills/, /^Bring context from…$/]);
    // a file: the shell keeps a copy outside Buddy's folder, and the message names it, so the agent asks before reading
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("attach-files").click();
    await (await chooser).setFiles([{ name: "receipt.txt", mimeType: "text/plain", buffer: Buffer.from("total 120") }]);
    await page.getByTestId("attach").click();
    await page.getByTestId("attach-folder").click();
    await expect(page.getByTestId("folder-chip")).toHaveAttribute("data-path", "/home/you/Shop");
    await page.getByTestId("composer").fill("what is the total?");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said:");
    const c = await calls(page);
    expect(c.filter((x) => x.op === "buddy.file").map((x) => x.path)).toEqual(["/home/you/.manut/buddy/files/1-receipt.txt"]);
    const text = c.filter((x) => x.op === "buddy.input" && x.input?.kind === "send").pop()?.input?.text;
    expect(text).toBe("Attached file (a copy Manut AI saved; open it with your tools): /home/you/.manut/buddy/files/1-receipt.txt\n\nwhat is the total?\n\nFolder: /home/you/Shop");
    // a teammate: typing @ opens the menu, Enter puts the name a mention is written with
    await page.getByTestId("composer").fill("ask @");
    await expect(page.getByTestId("mention-option")).toHaveCount(4);
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("composer")).toHaveValue("ask @nam ");
    // actions from an empty box: the / menu, the demo's commands first
    await page.getByTestId("composer").fill("");
    await page.getByTestId("attach").click();
    await page.getByTestId("attach-actions").click();
    await expect(page.getByTestId("composer")).toHaveValue("/");
    await expect(page.getByTestId("command-option").first()).toContainText("/approve");
  });
});
