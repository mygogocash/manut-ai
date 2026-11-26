// Item 102e (docs/several-agents.md, "4. Helper lanes a lane asks for"): the Helpers switch in a lane's box, a helper block hidden
// while the lead's answer streams, and the Start helpers card when the turn ends, one approval settled once. Kit's chat runs on the
// stand-in coding agent of src/sessions/host.mock.ts, whose `/helpers <word>` answer ends with helper blocks written a few words at a
// time, as kit-lanes.spec.ts's lanes run on it; Buddy's chat on Practice, whose Buddy answers through the same stand-in. Only Start
// helpers starts helper lanes (item 102h, e2e/helper-runs.spec.ts): Not now and a refused request leave the stand-in shell with no
// `chat.start` but the lead's own. Pictures of
// the card, light and dark, go to HELPERS_SHOTS (else Playwright's ignored test-results).
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openChat } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const SHOTS = process.env.HELPERS_SHOTS || "test-results";
type Call = { op: string; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const chatStarts = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.start").length;

/** Watches the chat from now on and remembers whether a helper block, or its JSON, was ever drawn in it. */
const watchForBlocks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __blockSeen?: boolean };
    w.__blockSeen = false;
    const look = () => {
      const text = document.querySelector("[data-testid=timeline]")?.textContent ?? "";
      if (text.includes("manut-helpers") || text.includes('"brief"')) w.__blockSeen = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    look();
  });
const blockSeen = (page: Page) => page.evaluate(() => (window as unknown as { __blockSeen?: boolean }).__blockSeen);

test.describe("a lane's chat", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((root) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main" };
    }, ROOT);
    await page.goto("/");
  });

  /** A Claude Code lane in the project, started through the sessions store as the + menu's Chat with Kit does, open in the main
   *  column, its first answer in. */
  async function lane(page: Page): Promise<string> {
    const id = await page.evaluate(async (root) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, "hello");
      return id as string;
    }, ROOT);
    await page.evaluate(async (i) => {
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
      store.getStore().actions.openSession(i);
    }, id);
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: hello");
    return id;
  }

  const send = async (page: Page, text: string) => {
    await page.getByTestId("composer").fill(text);
    await page.getByTestId("composer").press("Enter");
  };

  test("the switch is off until turned on; then a block streams in hidden, the card shows every brief, and Not now starts nothing", async ({ page }) => {
    await lane(page);
    const sw = page.getByTestId("composer-box").getByTestId("helpers-switch");
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(sw).toHaveText("Helpers");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    const lead = await chatStarts(page);
    expect(lead).toBe(1);

    await watchForBlocks(page);
    await send(page, "/helpers two");
    // while the answer is written: its words show, the block does not, and the activity line says what is being asked for
    await expect(page.locator('[data-kind="streaming"]')).toContainText("I'll split this in two");
    await expect(page.getByTestId("timeline")).toContainText(/Asking for (1 helper lane|2 helper lanes)/);
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);

    // the turn ended: the card, with both briefs whole and where each would run
    const card = page.getByTestId("helpers-card");
    await expect(card).toBeVisible();
    expect(await blockSeen(page)).toBe(false);
    await expect(card.locator(".card-title")).toHaveText("Kit asks for 2 helper lanes");
    await expect(card.getByTestId("helpers-agent")).toHaveText(["Codex · gpt-6.1 · high", "Claude Code · the lead's model"]);
    await expect(card.getByTestId("helpers-title")).toHaveText(["Tests for the QR builder", "The receipt's Thai date"]);
    await expect(card.getByTestId("helpers-brief").first()).toContainText("Run pnpm test src/qr.test.ts and report what you changed and how you checked it.");
    await expect(page.getByTestId("bubble-bot").last()).toHaveText(/I'll split this in two: the QR builder's tests, and the receipt's Thai date\./);

    // the person's bubble is what they typed; the lead's note went in front of it to the agent only
    await expect(page.getByTestId("bubble-user").last()).toContainText("/helpers two");
    const sent = (await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "send").map((c) => c.input!.text!);
    expect(sent.at(-1)).toMatch(/^\[Manut AI: helper lanes are on\]/);
    expect(sent.at(-1)).toMatch(/\/helpers two$/);

    // pictures, light and dark: the card whole (a window tall enough for all of it below the answer), and the lane with the
    // switch on in its box
    await page.setViewportSize({ width: 1280, height: 1180 });
    await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async (th) => {
        const m = await import(/* @vite-ignore */ "/src/state/store.ts" as string);
        m.getStore().actions.setTheme(th);
      }, theme);
      await card.screenshot({ path: join(SHOTS, `helpers-card-${theme}.png`), animations: "disabled" });
      await page.screenshot({ path: join(SHOTS, `helpers-lane-${theme}.png`), animations: "disabled" });
    }

    // Not now: one line, and no agent started
    await card.getByTestId("helpers-not-now").click();
    await expect(page.getByTestId("helpers-line")).toHaveText(/Not now: no helper lanes started\./);
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);
    expect(await chatStarts(page)).toBe(lead);
  });

  test("Start helpers is settled once, and its helper lanes start in their agents' Ask mode (item 102h)", async ({ page }) => {
    await lane(page);
    await page.getByTestId("helpers-switch").click();
    await send(page, "/helpers two");
    const card = page.getByTestId("helpers-card");
    await expect(card).toBeVisible();
    await card.getByTestId("helpers-start").click();
    await expect(page.getByTestId("helpers-line")).toHaveText(/You approved this round\. Its helper lanes start below\./);
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);
    await expect(page.getByTestId("helper-run-row")).toHaveCount(2);
    await expect.poll(() => chatStarts(page)).toBe(3);
    const modes = (await calls(page)).filter((c) => c.op === "chat.start").map((c) => (c as { mode?: string }).mode);
    expect(modes.slice(1)).toEqual(["ask", "default"]);
  });

  test("a block with a key a helper never takes is refused whole: a line, no card, no agent", async ({ page }) => {
    await lane(page);
    await page.getByTestId("helpers-switch").click();
    await watchForBlocks(page);
    await send(page, "/helpers mode");
    await expect(page.getByTestId("system-line").last()).toHaveText(
      "Kit asked for helper lanes, but Manut AI could not read the request: a block has a key Manut AI does not take (mode). Nothing started.",
    );
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);
    expect(await blockSeen(page)).toBe(false);
    expect(await chatStarts(page)).toBe(1);
  });

  test("with the switch off, a block is the agent's own words and no card shows", async ({ page }) => {
    await lane(page);
    await send(page, "/helpers two");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("Tests for the QR builder");
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);
    const sent = (await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "send").map((c) => c.input!.text!);
    expect(sent.at(-1)).toBe("/helpers two");
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
    });
    await page.goto("/");
    await openChat(page, "buddy", "Buddy");
  });

  test("has no Helpers switch, and a block Buddy writes is its own words: no card", async ({ page }) => {
    await expect(page.getByTestId("box-approval")).toBeVisible();
    await expect(page.getByTestId("helpers-switch")).toHaveCount(0);
    await page.getByTestId("composer").fill("/helpers two");
    await page.getByTestId("composer").press("Enter");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("Tests for the QR builder");
    await expect(page.getByTestId("helpers-switch")).toHaveCount(0);
    await expect(page.getByTestId("helpers-card")).toHaveCount(0);
  });
});
