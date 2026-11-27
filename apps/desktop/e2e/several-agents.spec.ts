// The job's side-by-side view (item 102b, docs/several-agents.md "2. Watching them side by side") against the stand-in agent: the
// Lanes band's job row opens it, a column for each lane (tabs at a narrow width), each with its state tag, its chat, its ask card,
// Open lane and Stop; Stop all asks once; Ask them again fills Ask several's panel, unsent. The safety test: an ask answered in a
// column is shown decided in Needs you and in the lane's own chat, and a second press is refused. With MANUT_SHOTS=<dir> the last
// tests also write the view's pictures, light and dark, at 1280 and 900 wide.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const SHOTS = process.env.MANUT_SHOTS || "";

type Call = { op: string; id?: number; agent?: string; cwd?: string; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []) as Call[]);
const starts = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.start");
/** The folders of the lanes whose turn was stopped: a chat's input is logged under its chat id, and its start names the folder. */
async function stopped(page: Page): Promise<string[]> {
  const all = await calls(page);
  const folder = new Map(all.filter((c) => c.op === "chat.start").map((c) => [c.id, c.cwd] as const));
  return all.filter((c) => c.op === "chat.input" && c.input?.kind === "interrupt").map((c) => folder.get(c.id) ?? "");
}

type Theme = "light" | "dark";
/** The Code page with a job of `agents` started from one message, as the panel's Send starts it. */
async function jobPage(page: Page, text: string, over: { agents?: string[]; theme?: Theme; width?: number } = {}) {
  const agents = over.agents ?? ["claude", "codex", "claude"];
  if (over.width) await page.setViewportSize({ width: over.width, height: 860 });
  await page.addInitScript(
    ([root, theme]) => {
      localStorage.removeItem("manut.kit.projects");
      localStorage.removeItem("manut.agentChoices");
      if (theme) localStorage.setItem("manut.theme", theme as string);
      const w = window as unknown as Record<string, unknown>;
      w.__manutBranches = { [root as string]: "main" };
      w.__manutMockTaken = [];
    },
    [ROOT, over.theme ?? null] as const,
  );
  await page.goto("/");
  const res = await page.evaluate(
    async ([root, words, list]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      return s.startJob({ cwd: root, text: words, picks: (list as string[]).map((agent) => ({ agent, model: "", effort: "" })) });
    },
    [ROOT, text, agents] as const,
  );
  expect(res.ok).toBe(true);
  await openCode(page);
  const job = page.locator('[data-testid^="lane-job-j"]');
  await expect(job).toHaveCount(1);
  return job;
}
/** Opens the view: the job's row. */
async function watch(page: Page) {
  await page.locator('[data-testid^="lane-job-j"]').getByTestId("lane-job-open").click();
  await expect(page.getByTestId("jv")).toBeVisible();
}
const laneIds = (page: Page) => page.evaluate(() => ((window as any).__manutSessions.getState().list as { id: string; job?: string }[]).filter((r) => r.job).map((r) => r.id).reverse());

test("the job's row in the Lanes band opens the side-by-side view, with a column for each lane at 1280", async ({ page }) => {
  await jobPage(page, "Add a PromptPay QR to the checkout.", { width: 1280 });
  await watch(page);
  await expect(page.getByTestId("jv-title")).toHaveText("3 agents: Add a PromptPay QR to the checkout");
  const ids = await laneIds(page);
  expect(ids).toHaveLength(3);
  const cols = page.locator('[data-testid^="jv-col-"]');
  await expect(cols).toHaveCount(3);
  // three columns side by side, none stacked, and no tabs
  const boxes = await cols.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
  expect(boxes[0].right).toBeLessThanOrEqual(boxes[1].left + 1);
  expect(boxes[1].right).toBeLessThanOrEqual(boxes[2].left + 1);
  await expect(page.getByTestId("jv-tabs")).toBeHidden();
  for (const [i, id] of ids.entries()) {
    const col = page.getByTestId(`jv-col-${id}`);
    await expect(col.getByTestId(`jv-agent-${id}`)).toHaveText(i === 1 ? "Codex" : "Claude Code");
    await expect(col.getByTestId(`jv-branch-${id}`)).toContainText("kit/");
    await expect(col.getByTestId(`jv-state-${id}`)).toBeVisible();
    // the lane's own chat, compact: the message it was given
    await expect(col.getByTestId(`jv-chat-${id}`)).toContainText("Add a PromptPay QR to the checkout.");
    await expect(col.getByTestId(`jv-open-${id}`)).toBeVisible();
    await expect(col.getByTestId(`jv-stop-${id}`)).toBeVisible();
  }
  // there is no box in the view that writes to a lane
  await expect(page.getByTestId("jv").getByTestId("composer")).toHaveCount(0);
});

test("at 900 wide the columns are tabs, each with its state tag, and a tab shows one lane", async ({ page }) => {
  await jobPage(page, "Add a PromptPay QR to the checkout.", { width: 900 });
  await watch(page);
  const ids = await laneIds(page);
  await expect(page.getByTestId("jv-tabs")).toBeVisible();
  for (const id of ids) await expect(page.getByTestId(`jv-tab-${id}`)).toBeVisible();
  await expect(page.getByTestId(`jv-col-${ids[0]}`)).toBeVisible();
  await expect(page.getByTestId(`jv-col-${ids[1]}`)).toBeHidden();
  await page.getByTestId(`jv-tab-${ids[1]}`).click();
  await expect(page.getByTestId(`jv-col-${ids[1]}`)).toBeVisible();
  await expect(page.getByTestId(`jv-col-${ids[0]}`)).toBeHidden();
  await expect(page.getByTestId(`jv-tab-${ids[1]}`)).toHaveAttribute("aria-selected", "true");
});

test("Open lane opens the lane as any lane, with its pane and its box", async ({ page }) => {
  await jobPage(page, "Add a PromptPay QR to the checkout.", { width: 1280 });
  await watch(page);
  const ids = await laneIds(page);
  await page.getByTestId(`jv-open-${ids[1]}`).click();
  await expect(page.getByTestId("lane-pane")).toBeVisible();
  await expect(page.getByTestId("session-chat").getByTestId("composer")).toBeVisible();
});

test("Stop stops that lane's turn only, and Stop all asks once before it stops every lane that works", async ({ page }) => {
  await jobPage(page, "Add a PromptPay QR to the checkout.", { width: 1280, agents: ["claude", "claude"] });
  const ids = await laneIds(page);
  // both lanes run a slow step, so their turns are open
  await page.evaluate(async (list) => {
    for (const id of list) await (window as any).__manutSessions.send(id, "/kit slow");
  }, ids);
  await watch(page);
  await expect(page.getByTestId(`jv-col-${ids[0]}`).getByTestId(`jv-state-${ids[0]}`)).toHaveClass(/\brun\b/);
  await expect(page.getByTestId(`jv-col-${ids[1]}`).getByTestId(`jv-state-${ids[1]}`)).toHaveClass(/\brun\b/);
  await page.getByTestId(`jv-stop-${ids[0]}`).click();
  await expect.poll(async () => (await stopped(page)).length).toBe(1);
  // Stop all: the first press asks, and nothing more stops
  await page.getByTestId("jv-stopall").click();
  await expect(page.getByTestId("jv-stopall-ask")).toContainText("Stop all");
  expect((await stopped(page)).length).toBe(1);
  await page.getByTestId("jv-stopall-keep").click();
  await expect(page.getByTestId("jv-stopall-ask")).toHaveCount(0);
  expect((await stopped(page)).length).toBe(1);
  // Keep going left it as it was; asking again and confirming stops the lanes that still work
  const running = await page.locator('[data-testid^="jv-stop-"]:not([disabled])').count();
  if (running > 0) {
    await page.getByTestId("jv-stopall").click();
    await page.getByTestId("jv-stopall-yes").click();
    await expect.poll(async () => (await stopped(page)).length).toBeGreaterThan(1);
  }
});

test("Ask them again opens Ask several's panel with the same rows and message, unsent", async ({ page }) => {
  await jobPage(page, "Add a PromptPay QR to the checkout.", { width: 1280, agents: ["claude", "codex"] });
  await watch(page);
  const before = (await starts(page)).length;
  await page.getByTestId("jv-again").click();
  const panel = page.getByTestId("ask-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("ask-row-0")).toHaveAttribute("data-agent", "claude");
  await expect(panel.getByTestId("ask-row-1")).toHaveAttribute("data-agent", "codex");
  await expect(panel.getByTestId("ask-row-2")).toHaveCount(0);
  await expect(panel.getByTestId("composer")).toHaveValue("Add a PromptPay QR to the checkout.");
  // nothing was sent by opening it
  expect((await starts(page)).length).toBe(before);
});

test("SAFETY: an ask answered in a column is decided in Needs you and in the lane's own chat, and a second press is refused", async ({ page }) => {
  await jobPage(page, "/kit install", { width: 1280, agents: ["claude", "claude"] });
  await watch(page);
  const ids = await laneIds(page);
  // each lane asks, and each ask card is in its own column
  for (const id of ids) await expect(page.getByTestId(`jv-col-${id}`).getByTestId("card-approval")).toBeVisible();
  await expect(page.getByTestId(`jv-col-${ids[0]}`).getByTestId(`jv-state-${ids[0]}`)).toHaveText("Needs you");
  // Needs you lists both
  const asks = () => page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as any;
    const st = store.getStore().getState();
    return store.selectAsks(st).map((a: { bot: string; item: { request_id: string } }) => ({ bot: a.bot, request: a.item.request_id }));
  });
  expect(await asks()).toHaveLength(2);
  // the ask of the first lane's chat (the list is oldest first, and the first lane started first)
  const key = await page.evaluate((id) => (window as any).__manutSessions.chatKey(id), ids[0]);
  const first = ((await asks()) as { bot: string; request: string }[]).find((a) => a.bot === key)!;

  // answer the first lane's ask in its column
  const column = page.getByTestId(`jv-col-${ids[0]}`);
  await column.getByRole("button", { name: "Allow once" }).click();
  await expect(column.getByTestId("card-line")).toBeVisible();
  await expect(column.getByTestId("card-approval")).toHaveCount(0);

  // Needs you now lists the other lane's ask only
  await expect.poll(async () => (await asks()).length).toBe(1);
  expect(((await asks())[0] as { bot: string }).bot).not.toBe(first.bot);

  // a second press on the same ask, as any card of it would send it, is refused and the first answer stands
  const second = await page.evaluate(async ([bot, request]) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as any;
    const s = store.getStore();
    await s.actions.respondApproval(request, "deny", bot);
    const item = s.getState().chats[bot].items.find((i: { request_id?: string }) => i.request_id === request);
    return { resolved: item.resolved, error: s.getState().lastError };
  }, [first.bot, first.request]);
  expect(second.resolved).toBe("once");
  expect(second.error).toMatch(/no such request|no pending approval/);

  // the lane's own chat shows it decided: its card is one grey line, and there is no open card to press
  await page.getByTestId(`jv-open-${ids[0]}`).click();
  const chat = page.getByTestId("session-chat");
  await expect(chat.getByTestId("card-line")).toBeVisible();
  await expect(chat.getByTestId("card-approval")).toHaveCount(0);
  // and Needs you lists the other lane's ask alone
  await page.getByTestId("menu-needs").click();
  await expect(page.getByTestId("needs-row")).toHaveCount(1);
});

// ---- the gathered answers (item 102c) ------------------------------------------------------------------------------------

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
/**
 * The calls the stand-in bridge has logged for `op` (member and thread chats go through it). The bridge is the worker's
 * for the whole run and this file never resets it, so its log also holds what earlier spec files in the same worker
 * sent: a test counts only the calls made after it started.
 */
async function bridgeCalls(op: string): Promise<unknown[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<{ result: { calls: { op: string }[] } }>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "g1") res(msg);
    };
    ws.send(JSON.stringify({ id: "g1", op: "mock.calls" }));
  });
  ws.close();
  return reply.result.calls.filter((c) => c.op === op);
}
const sends = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "send").length;

test("the Gathered block under the columns: each lane's last answer whole, its files and its tests, once all three answered", async ({ page }) => {
  // On 27 Nov CI ran prompt-history's two sends in this worker just before this file, and an empty log was expected.
  const bridgeBefore = (await bridgeCalls("chat.send")).length;
  await jobPage(page, "/kit pass", { width: 1280 });
  await watch(page);
  const ids = await laneIds(page);
  await expect(page.getByTestId("gt-count")).toHaveText("Gathered: 3 of 3 answered", { timeout: 15_000 });
  // under the columns, not beside them
  const cols = await page.getByTestId("jv-cols").boundingBox();
  const block = await page.getByTestId("gt").boundingBox();
  expect(block!.y).toBeGreaterThanOrEqual(cols!.y + cols!.height - 1);
  for (const id of ids) {
    const lane = page.getByTestId(`gt-lane-${id}`);
    await expect(lane).toHaveAttribute("data-state", "answered");
    await expect(lane.getByTestId(`gt-answer-${id}`)).toHaveText("I replaced bank transfer with a PromptPay QR. All 14 tests pass.");
    await expect(lane.getByTestId(`gt-files-${id}`)).toContainText("src/checkout.tsx");
    await expect(lane.getByTestId(`gt-result-${id}`)).toHaveAttribute("data-tone", "ok");
  }
  // nothing was started or sent by looking at it
  expect((await bridgeCalls("chat.send")).slice(bridgeBefore)).toEqual([]);
});

test("a lane waiting on an ask is shown as waiting, not answered, with Answer, which brings its column forward", async ({ page }) => {
  await jobPage(page, "/kit install", { width: 900, agents: ["claude", "claude"] });
  await watch(page);
  const ids = await laneIds(page);
  await expect(page.getByTestId("gt-count")).toBeHidden();
  await page.getByTestId("jv-tab-gathered").click();
  await expect(page.getByTestId("gt-count")).toHaveText("Gathered: 0 of 2 answered");
  await expect(page.getByTestId("jv-cols")).toBeHidden();
  for (const id of ids) {
    await expect(page.getByTestId(`gt-lane-${id}`)).toHaveAttribute("data-state", "waiting");
    await expect(page.getByTestId(`gt-answer-${id}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("gt-wait")).toContainText("2 waiting on you");
  await expect(page.getByTestId("gt-compare")).toBeDisabled();
  await page.getByTestId(`gt-answer-${ids[1]}-btn`).click();
  await expect(page.getByTestId(`jv-col-${ids[1]}`)).toBeVisible();
  await expect(page.getByTestId(`jv-col-${ids[1]}`).getByTestId("card-approval")).toBeVisible();
});

test("at 900 wide the Gathered block is a tab of its own, with the count in its name", async ({ page }) => {
  await jobPage(page, "/kit pass", { width: 900, agents: ["claude", "codex"] });
  await watch(page);
  await expect(page.getByTestId("jv-tab-gathered")).toHaveText("Gathered 2/2", { timeout: 15_000 });
  await expect(page.getByTestId("gt")).toBeHidden();
  await page.getByTestId("jv-tab-gathered").click();
  await expect(page.getByTestId("gt")).toBeVisible();
  await expect(page.getByTestId("jv-tab-gathered")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId(`jv-tab-${(await laneIds(page))[0]}`).click();
  await expect(page.getByTestId("gt")).toBeHidden();
});

test("SAFETY: Compare in a chat only fills a box, with a chip for each answer, and no chat.send reaches the stand-in host", async ({ page }) => {
  await jobPage(page, "/kit pass", { width: 1280 });
  await watch(page);
  const ids = await laneIds(page);
  await expect(page.getByTestId("gt-count")).toHaveText("Gathered: 3 of 3 answered", { timeout: 15_000 });
  const startsBefore = (await starts(page)).length;
  const sendsBefore = await sends(page);
  const bridgeBefore = (await bridgeCalls("chat.send")).length;
  await page.getByTestId("gt-compare").click();
  // item 97's own list, with the job's lanes among the chats it offers
  await expect(page.getByTestId("bring-pop")).toBeVisible();
  await page.locator(`[data-testid="bring-option"][data-ref="session:${ids[0]}"]`).click();
  await expect(page.getByTestId("gt-note")).toContainText("In the box of");
  await expect(page.getByTestId("gt-note")).toContainText("2 answers");
  // the lane picked does not carry itself: the other two answers are its chips, and its box still holds nothing to send
  await page.getByTestId("gt-open").click();
  const chat = page.getByTestId("session-chat");
  await expect(chat.getByTestId("carry-chip")).toHaveCount(2);
  await expect(chat.getByTestId("composer")).toHaveValue("");
  // nothing started, nothing sent, to any lane or through the bridge, until the person presses Send
  expect((await starts(page)).length).toBe(startsBefore);
  expect(await sends(page)).toBe(sendsBefore);
  expect((await bridgeCalls("chat.send")).length).toBe(bridgeBefore);
});

for (const [theme, width] of [["light", 1280], ["dark", 1280], ["light", 900], ["dark", 900]] as const) {
  test(`pictures: the side-by-side view, ${theme}, ${width} wide`, async ({ page }) => {
    test.skip(!SHOTS, "set MANUT_SHOTS=<dir> to write the pictures");
    mkdirSync(SHOTS, { recursive: true });
    await jobPage(page, "/kit install", { theme, width, agents: ["claude", "codex", "claude"] });
    const ids = await laneIds(page);
    // one lane is working, one asks, one is done: the three states side by side
    await page.evaluate(async (list) => {
      const s = (window as any).__manutSessions;
      await s.send(list[2], "/kit pass");
    }, ids);
    await watch(page);
    await expect(page.getByTestId(`jv-col-${ids[0]}`)).toBeVisible();
    await page.screenshot({ path: join(SHOTS, `several-agents-view-${theme}-${width}.png`), animations: "disabled" });
  });
}

for (const [theme, width] of [["light", 1280], ["dark", 1280], ["light", 900], ["dark", 900]] as const) {
  test(`pictures: the Gathered block, ${theme}, ${width} wide`, async ({ page }) => {
    test.skip(!SHOTS, "set MANUT_SHOTS=<dir> to write the pictures");
    mkdirSync(SHOTS, { recursive: true });
    await jobPage(page, "/kit pass", { theme, width, agents: ["claude", "codex", "claude"] });
    const ids = await laneIds(page);
    // two lanes answered with their tests; the third one is told to fail its tests, so the block shows both readings
    await page.evaluate(async (id) => {
      await (window as any).__manutSessions.send(id, "/kit fail");
    }, ids[2]);
    await watch(page);
    await expect(page.getByTestId("gt-count")).toHaveText("Gathered: 3 of 3 answered", { timeout: 20_000 });
    await expect(page.getByTestId(`gt-result-${ids[2]}`)).toHaveAttribute("data-tone", "err");
    if (width < 1000) await page.getByTestId("jv-tab-gathered").click();
    await page.screenshot({ path: join(SHOTS, `several-agents-gathered-${theme}-${width}.png`), animations: "disabled" });
  });
}
