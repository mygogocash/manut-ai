// Item 102k (docs/several-agents.md, "5. What an agent may do to other chats", rule R10): the "Kit may reach" list under a lane's
// box, and the read, send and open cards. Both lanes run on the stand-in coding agent of src/sessions/host.mock.ts, whose
// `/reach <word>` answer ends with a reach block written a few words at a time. Nothing of the other chat moves before a card's press:
// the stand-in shell sees no message to it and no new `chat.start` until then. A message sent into a lane whose question waits
// leaves that question waiting, even when its words begin "Allow". Pictures of the list and of each card, light and dark, go to REACH_SHOTS (else
// Playwright's ignored test-results).
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const ROOT = "/home/you/code/baanmali-preorder";
const SHOTS = process.env.REACH_SHOTS || "test-results";
type Call = { op: string; id?: number; session?: string; agent?: string; mode?: string; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
/** The stand-in shell's host id of session `sid`'s chat. */
const hostOf = async (page: Page, sid: string) => (await calls(page)).find((c) => c.op === "chat.start" && c.session === sid)?.id;
/** Every input the stand-in shell got for session `sid`. */
const inputsOf = async (page: Page, sid: string) => {
  const id = await hostOf(page, sid);
  return (await calls(page)).filter((c) => c.op === "chat.input" && c.id === id).map((c) => c.input!);
};

/** Watches the chat from now on and remembers whether a reach block, or its JSON, was ever drawn in it. */
const watchForBlocks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __reachSeen?: boolean };
    w.__reachSeen = false;
    const look = () => {
      const text = document.querySelector("[data-testid=timeline]")?.textContent ?? "";
      if (/manut-(read|send|open)/.test(text) || text.includes('"chat"')) w.__reachSeen = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    look();
  });
const blockSeen = (page: Page) => page.evaluate(() => (window as unknown as { __reachSeen?: boolean }).__reachSeen);

const theme = (page: Page, th: "light" | "dark") =>
  page.evaluate(async (t) => {
    const m = await import(/* @vite-ignore */ "/src/state/store.ts" as string);
    m.getStore().actions.setTheme(t);
  }, th);

test.describe("chats that reach other chats", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((root) => {
      localStorage.removeItem("manut.kit.projects");
      (window as any).__manutBranches = { [root]: "main" };
    }, ROOT);
    await page.goto("/");
  });

  /** A lane in the project on `agent`, started through the sessions store as the + menu's Chat with Kit does, its first answer in. */
  async function lane(page: Page, agent: string, first: string): Promise<string> {
    return page.evaluate(
      async ([root, a, f]) => {
        const s = (window as any).__manutSessions;
        await s.loadAgents();
        const id = s.draft(a);
        s.setDraft(id, { cwd: root });
        await s.start(id, f);
        return id as string;
      },
      [ROOT, agent, first] as const,
    );
  }
  const open = (page: Page, id: string) =>
    page.evaluate(async (i) => {
      const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
      store.getStore().actions.openSession(i);
    }, id);
  const send = async (page: Page, text: string) => {
    await page.getByTestId("composer").fill(text);
    await page.getByTestId("composer").press("Enter");
  };

  /** Lane A (Claude Code) with lane B (Codex) on its list, A open. */
  async function twoLanes(page: Page): Promise<{ a: string; b: string }> {
    const b = await lane(page, "codex", "Print the receipt in Thai");
    const a = await lane(page, "claude", "Add the PromptPay QR");
    await open(page, a);
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Add the PromptPay QR");
    const list = page.getByTestId("reach-list");
    await expect(list).toHaveText("Let Kit reach another chat…");
    await list.getByTestId("reach-add").click();
    await page.getByTestId("bring-option").filter({ hasText: "Print the receipt in Thai" }).click();
    await expect(list.getByTestId("reach-chip")).toHaveText(["1Print the receipt in Thai"]);
    return { a, b };
  }

  test("the list under the box: added from Bring context's picker, told to Kit with each message, removable", async ({ page }) => {
    const { a } = await twoLanes(page);
    const list = page.getByTestId("reach-list");
    await expect(list).toContainText("Kit may reach");

    // pictures of the box with its list, light and dark
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const th of ["light", "dark"] as const) {
      await theme(page, th);
      await page.locator(".cw").filter({ has: list }).screenshot({ path: join(SHOTS, `reach-list-${th}.png`), animations: "disabled" });
    }
    await theme(page, "light");

    await send(page, "Hello again");
    await expect(page.getByTestId("bubble-user").last()).toHaveText(/Hello again/);
    const sent = (await inputsOf(page, a)).filter((i) => i.kind === "send").map((i) => i.text!);
    expect(sent.at(-1)).toMatch(/^\[Manut AI: chats you may reach\]/);
    expect(sent.at(-1)).toContain('- "1": Print the receipt in Thai (Codex, a coding chat)');
    expect(sent.at(-1)).toMatch(/Hello again$/);

    await list.getByTestId("reach-remove").click();
    await expect(list).toHaveText("Let Kit reach another chat…");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Hello again");
    await send(page, "Thanks");
    await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Thanks");
    expect((await inputsOf(page, a)).filter((i) => i.kind === "send").at(-1)?.text).toBe("Thanks");
  });

  test("read: the block streams in hidden, the card shows the text Kit would get, and Let Kit read sends exactly that", async ({ page }) => {
    const { a } = await twoLanes(page);
    await watchForBlocks(page);
    await send(page, "/reach read");
    const card = page.getByTestId("reach-card");
    await expect(card).toBeVisible();
    expect(await blockSeen(page)).toBe(false);
    await expect(card.locator(".card-title")).toHaveText("Kit asks to read “Print the receipt in Thai”");
    await expect(card.getByTestId("reach-text")).toContainText('Context from the chat "Print the receipt in Thai":');
    await expect(card.getByTestId("reach-text")).toContainText("First message: Print the receipt in Thai");
    await expect(page.getByTestId("bubble-bot").last()).toHaveText(/I'll look at how the other lane built the QR first\./);
    const shown = (await card.getByTestId("reach-text").textContent()) ?? "";
    const before = (await inputsOf(page, a)).length;

    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
    for (const th of ["light", "dark"] as const) {
      await theme(page, th);
      await card.screenshot({ path: join(SHOTS, `reach-read-${th}.png`), animations: "disabled" });
    }
    await theme(page, "light");
    expect((await inputsOf(page, a)).length).toBe(before);

    await card.getByTestId("reach-yes").click();
    await expect(page.getByTestId("reach-line")).toHaveText(/Kit read “Print the receipt in Thai”\./);
    // it went to Kit as its next message, drawn as that chat's context folded under its title
    await expect(page.getByTestId("bubble-context").last()).toBeVisible();
    const sent = (await inputsOf(page, a)).slice(before).filter((i) => i.kind === "send");
    expect(sent).toHaveLength(1);
    expect(sent[0].text!.slice(sent[0].text!.indexOf("Context from the chat"))).toBe(shown);
  });

  test("send: nothing goes before Send there; it arrives marked as from this chat and leaves the other lane's question waiting", async ({ page }) => {
    const { a, b } = await twoLanes(page);
    // the receipt lane asks the person a question and waits on it (its turn runs until they answer)
    await page.evaluate((id) => (window as any).__manutSessions.send(id, "/ask"), b);
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const m = await import(/* @vite-ignore */ "/src/state/store.ts" as string);
          return (m.getStore().getState().chats[`agent:${id}`]?.items ?? []).some((i: { kind: string }) => i.kind === "clarify");
        }, b),
      )
      .toBe(true);
    await send(page, "/reach send");
    const card = page.getByTestId("reach-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".card-title")).toHaveText("Send this to “Print the receipt in Thai”?");
    await expect(card.getByTestId("reach-text")).toHaveText(/^Allow\. The PromptPay payload now ends with a CRC-16 checksum/);
    const toB = (await inputsOf(page, b)).length;

    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
    for (const th of ["light", "dark"] as const) {
      await theme(page, th);
      await card.screenshot({ path: join(SHOTS, `reach-send-${th}.png`), animations: "disabled" });
    }
    await theme(page, "light");
    expect((await inputsOf(page, b)).length).toBe(toB);

    await card.getByTestId("reach-yes").click();
    await expect(page.getByTestId("reach-line")).toHaveText(/Sent to “Print the receipt in Thai”, marked as from this chat\./);

    // in the receipt lane: the message waits behind the turn, marked as from the QR lane, and the question is still there to answer
    await open(page, b);
    const from = page.getByTestId("bubble-reached-from").last();
    await expect(from).toHaveText("From “Add the PromptPay QR”, sent on by you");
    await expect(page.getByTestId("bubble-user").last()).toContainText("Allow. The PromptPay payload now ends with a CRC-16 checksum");
    await expect(page.getByTestId("card-clarify")).toBeVisible();
    await expect(page.getByTestId("card-clarify")).toContainText("Which greeting should go in greet.txt?");
    const after = (await inputsOf(page, b)).slice(toB);
    expect(after.filter((i) => i.kind === "approve" || i.kind === "clarify")).toEqual([]);
    expect(after.filter((i) => i.kind === "send")).toEqual([]);
    for (const th of ["light", "dark"] as const) {
      await theme(page, th);
      await page.screenshot({ path: join(SHOTS, `reach-arrived-${th}.png`), animations: "disabled" });
    }
    await theme(page, "light");
    expect(await inputsOf(page, a)).not.toContainEqual(expect.objectContaining({ kind: "clarify" }));
  });

  test("open: Start lane opens an ordinary lane in its agent's Ask mode with the brief as its first message, and nothing before", async ({ page }) => {
    await twoLanes(page);
    await send(page, "/reach open");
    const card = page.getByTestId("reach-card");
    await expect(card).toBeVisible();
    await expect(card.locator(".card-title")).toHaveText("Kit asks to open a new lane");
    await expect(card.getByTestId("reach-agent")).toHaveText("Codex · its default model");
    await expect(card.getByTestId("reach-lane-title")).toHaveText("Thai date on the receipt");
    await expect(card.getByTestId("reach-text")).toContainText("Check with pnpm test src/receipt.test.ts.");
    const starts = (await calls(page)).filter((c) => c.op === "chat.start").length;

    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
    for (const th of ["light", "dark"] as const) {
      await theme(page, th);
      await card.screenshot({ path: join(SHOTS, `reach-open-${th}.png`), animations: "disabled" });
    }
    await theme(page, "light");
    expect((await calls(page)).filter((c) => c.op === "chat.start").length).toBe(starts);

    await card.getByTestId("reach-yes").click();
    await expect(page.getByTestId("reach-line")).toHaveText(/Lane started: Thai date on the receipt\./);
    const started = (await calls(page)).filter((c) => c.op === "chat.start");
    expect(started).toHaveLength(starts + 1);
    const lane = started.at(-1)!;
    expect(lane.agent).toBe("codex");
    expect(lane.mode).toBe(await page.evaluate(async () => ((await import(/* @vite-ignore */ "/src/sessions/controls.ts" as string)) as any).ASK_MODE.codex));
    const first = (await calls(page)).find((c) => c.op === "chat.input" && c.id === lane.id && c.input?.kind === "send")!;
    expect(first.input!.text).toMatch(/^\[Manut AI: a message from the chat "Add the PromptPay QR"\]/);
    await page.getByTestId("reach-open-lane").click();
    await expect(page.getByTestId("bubble-reached-from").first()).toHaveText("From “Add the PromptPay QR”, sent on by you");
  });

  test("a chat that is not listed, and a block with a key it does not take, are refused with a line and no card", async ({ page }) => {
    const { a } = await twoLanes(page);
    await send(page, "/reach unlisted");
    await expect(page.getByTestId("system-line").last()).toHaveText("Kit asked to read “Payments”, which is not on the list of chats it may reach. Nothing was read.");
    await send(page, "/reach mode");
    await expect(page.getByTestId("system-line").last()).toHaveText(
      "Kit asked to reach another chat, but Manut AI could not read the request: a block has a key Manut AI does not take (mode). Nothing was read, sent or opened.",
    );
    await expect(page.getByTestId("reach-card")).toHaveCount(0);
    expect((await inputsOf(page, a)).filter((i) => i.kind === "send")).toHaveLength(3);
  });
});
