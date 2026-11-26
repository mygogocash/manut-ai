// Ask several agents (item 102a, docs/several-agents.md): the + menu's row, its panel (agents, models, efforts, accounts and their
// limit state, the shared box) and one send against the mock bridge. One send starts one lane for each row, each as an ordinary
// lane in its agent's Ask mode, all one job; the Lanes band shows the job as one row that opens to its lanes, each of which opens
// as any lane does. With MANUT_SHOTS=<dir> the last tests also write the panel's pictures, light and dark.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const LANES = "/home/you/.manut/lanes/baanmali-preorder";
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS || "";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const out = await new Promise<{ result: unknown }>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
  return out.result;
}

type Call = { op: string; agent?: string; cwd?: string; mode?: string; session?: string; input?: { kind: string; text?: string; model?: string; effort?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []) as Call[]);
const starts = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.start");

/** The Code page with the project listed (a terminal in it, as the Lanes band's own spec does) and the + menu open on Chat with Kit,
 *  in the project's folder, as New lane in the Lanes band opens it. `models` is what the agents listed before (kept on this computer). */
async function menu(page: Page, over: { agents?: string[]; theme?: "light" | "dark"; models?: boolean; limited?: string } = {}) {
  await mock("mock.reset");
  // every login of the CLI, since Settings › Accounts' auto-switch would move new sessions to another login that is not limited
  if (over.limited) for (const id of ["default", "work"]) await mock("mock.accounts", { cli: over.limited, limit: id });
  await page.addInitScript(
    ([root, agents, theme, models]) => {
      localStorage.removeItem("manut.kit.projects");
      localStorage.removeItem("manut.agentChoices");
      if (theme) localStorage.setItem("manut.theme", theme as string);
      if (models)
        localStorage.setItem(
          "manut.agentChoices",
          JSON.stringify({
            claude: { models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }], efforts: ["low", "medium", "high"] },
            codex: { models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol" }], efforts: ["low", "medium", "high"] },
          }),
        );
      const w = window as unknown as Record<string, unknown>;
      w.__manutBranches = { [root as string]: "main" };
      w.__manutMockTaken = [];
      if (agents) w.__manutMockAgents = agents;
    },
    [ROOT, over.agents ?? null, over.theme ?? null, over.models ?? false] as const,
  );
  await page.goto("/");
  await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    s.startTerminal("claude", root);
  }, ROOT);
  await openCode(page);
  await page.getByTestId("lane-new").click();
  const m = page.getByTestId("session-menu");
  await expect(m).toBeVisible();
  return m;
}

test("the + menu offers Ask several agents when two chat agents are installed, and not when only one is", async ({ page }) => {
  const m = await menu(page);
  const row = m.getByTestId("session-ask-several");
  await expect(row).toBeVisible();
  await expect(row).toHaveText("Ask several agents…");
  // it follows the Chat with Kit rows
  const order = await m.locator('[role="menuitem"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("session-ask-several")).toBeGreaterThan(order.indexOf("session-chat-codex"));
  await page.keyboard.press("Escape");
});

test("with one agent installed the row is not there", async ({ page }) => {
  const m = await menu(page, { agents: ["claude"] });
  await expect(m.getByTestId("session-chat-claude")).toBeVisible();
  await expect(m.getByTestId("session-ask-several")).toHaveCount(0);
});

test("one agent that listed two models is enough for the row", async ({ page }) => {
  const m = await menu(page, { agents: ["claude"], models: true });
  await expect(m.getByTestId("session-ask-several")).toBeVisible();
});

test("the panel opens under the folder, with two rows and the shared box; Back returns to the menu", async ({ page }) => {
  const m = await menu(page);
  await m.getByTestId("session-ask-several").click();
  const panel = page.getByTestId("ask-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("ask-folder")).toHaveText("baanmali-preorder");
  await expect(panel.getByTestId("ask-row-0")).toHaveAttribute("data-agent", "claude");
  await expect(panel.getByTestId("ask-row-1")).toHaveAttribute("data-agent", "codex");
  await expect(panel.getByTestId("ask-row-2")).toHaveCount(0);
  await expect(panel.getByTestId("ask-box").getByTestId("composer")).toBeVisible();
  // nothing started by opening it
  expect(await starts(page)).toEqual([]);
  await panel.getByTestId("ask-back").click();
  await expect(page.getByTestId("session-menu")).toBeVisible();
});

test("a third row can be added, no fourth, and a row can be removed down to two", async ({ page }) => {
  const m = await menu(page);
  await m.getByTestId("session-ask-several").click();
  const panel = page.getByTestId("ask-panel");
  await panel.getByTestId("ask-add").click();
  await expect(panel.getByTestId("ask-row-2")).toBeVisible();
  await expect(panel.getByTestId("ask-add")).toHaveCount(0);
  await expect(panel.getByTestId("ask-cap")).toContainText("3 agents a message");
  await panel.getByTestId("ask-remove-2").click();
  await expect(panel.getByTestId("ask-row-2")).toHaveCount(0);
  await expect(panel.getByTestId("ask-remove-0")).toHaveCount(0);
});

test("one send starts one lane for each row, each in its agent's Ask mode and a lane folder of its own, as one job in the Lanes band", async ({ page }) => {
  const m = await menu(page, { models: true });
  await m.getByTestId("session-ask-several").click();
  const panel = page.getByTestId("ask-panel");
  // Claude Code listed two models, so the panel opens on them: one agent with two models is two rows
  await expect(panel.getByTestId("ask-model-0")).toHaveValue("opus");
  await expect(panel.getByTestId("ask-model-1")).toHaveValue("sonnet");
  // row 0: Claude Code on Opus, high; row 1: Codex on its own; row 2: Claude Code on Sonnet
  await panel.getByTestId("ask-effort-0").selectOption("high");
  await panel.getByTestId("ask-agent-1").selectOption("codex");
  await expect(panel.getByTestId("ask-model-1")).toHaveValue("");
  await panel.getByTestId("ask-add").click();
  await panel.getByTestId("ask-agent-2").selectOption("claude");
  await panel.getByTestId("ask-model-2").selectOption("sonnet");
  await panel.getByTestId("composer").fill("Add a PromptPay QR to the checkout.");
  expect(await starts(page)).toEqual([]);
  await panel.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("ask-panel")).toHaveCount(0);

  await expect.poll(async () => (await starts(page)).length).toBe(3);
  const s = await starts(page);
  expect(s.map((c) => c.agent)).toEqual(["claude", "codex", "claude"]);
  // each in its agent's Ask mode, and in a lane folder of its own: never the developer's folder
  expect(s.map((c) => c.mode)).toEqual(["default", "ask", "default"]);
  expect(s.every((c) => c.cwd?.startsWith(`${LANES}/`))).toBe(true);
  expect(new Set(s.map((c) => c.cwd)).size).toBe(3);
  expect(s.map((c) => c.cwd)).not.toContain(ROOT);
  // the model and the effort picked on a row went to that lane only
  const inputs = (await calls(page)).filter((c) => c.op === "chat.input");
  expect(inputs.filter((c) => c.input?.kind === "model").map((c) => c.input?.model).sort()).toEqual(["opus", "sonnet"]);
  expect(inputs.filter((c) => c.input?.kind === "effort").map((c) => c.input?.effort)).toEqual(["high"]);
  expect(inputs.filter((c) => c.input?.kind === "send").map((c) => c.input?.text)).toEqual(Array(3).fill("Add a PromptPay QR to the checkout."));

  // the Lanes band: one job row, its lanes under it once opened, each opening as any lane does
  const job = page.locator('[data-testid^="lane-job-j"]');
  await expect(job).toHaveCount(1);
  await expect(job).toContainText("3 agents: Add a PromptPay QR to the checkout");
  await expect(job.locator('[data-testid^="lane-job-agent-"]')).toHaveCount(3);
  await expect(job.getByTestId("lane-job-lanes")).toHaveCount(0);
  await job.getByTestId("lane-job-open").click();
  const lanes = job.locator(".job-lanes > .lane");
  await expect(lanes).toHaveCount(3);
  await expect(lanes.first()).toContainText("Kit · Claude Code");
  await lanes.nth(1).locator(".rowl").click();
  await expect(page.getByTestId("lane-pane")).toBeVisible();
  await expect(page.getByTestId("session-branch")).toContainText("kit/");
  // the job survives a reload: the lanes are one job again
  await page.reload();
  await openCode(page);
  await expect(page.locator('[data-testid^="lane-job-j"]')).toHaveCount(1);
});

test("an agent whose account is at its limit is not counted: with one other agent left the row is not offered", async ({ page }) => {
  const m = await menu(page, { limited: "codex" });
  await expect(m.getByTestId("session-chat-claude")).toBeVisible();
  await expect(m.getByTestId("session-ask-several")).toHaveCount(0);
});

test("a limited account's row in a panel that is already open cannot be sent", async ({ page }) => {
  const m = await menu(page);
  await m.getByTestId("session-ask-several").click();
  const panel = page.getByTestId("ask-panel");
  await expect(panel.getByTestId("ask-limit-1")).toHaveCount(0);
  // the account reaches its limit while the panel is open
  for (const id of ["default", "work"]) await mock("mock.accounts", { cli: "codex", limit: id });
  await expect(panel.getByTestId("ask-limit-1")).toContainText("Limited until");
  await expect(panel.getByTestId("ask-blocked")).toContainText("Codex is at its limit");
  // the box is held: it is disabled and says why, so no Enter reaches any row
  await expect(panel.getByTestId("composer")).toBeDisabled();
  await expect(panel.getByTestId("composer")).toHaveAttribute("placeholder", /at its limit/);
  expect(await starts(page)).toEqual([]);
  // the limited agent cannot be picked on another row either
  await expect(panel.getByTestId("ask-agent-0").locator('option[value="codex"]')).toBeDisabled();
});

for (const theme of ["light", "dark"] as const) {
  test(`pictures: the panel with three rows, ${theme}`, async ({ page }) => {
    test.skip(!SHOTS, "set MANUT_SHOTS=<dir> to write the pictures");
    mkdirSync(SHOTS, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 860 });
    const m = await menu(page, { theme, models: true });
    await m.getByTestId("session-ask-several").click();
    const panel = page.getByTestId("ask-panel");
    await panel.getByTestId("ask-effort-0").selectOption("high");
    await panel.getByTestId("ask-agent-1").selectOption("codex");
    await panel.getByTestId("ask-add").click();
    await panel.getByTestId("ask-agent-2").selectOption("claude");
    await panel.getByTestId("ask-model-2").selectOption("sonnet");
    await panel.getByTestId("composer").fill("Add a PromptPay QR to the checkout.");
    await page.screenshot({ path: join(SHOTS, `ask-several-panel-${theme}.png`), animations: "disabled" });
    await panel.getByTestId("composer").press("Enter");
    await expect(page.locator('[data-testid^="lane-job-j"]')).toHaveCount(1);
    await page.locator('[data-testid^="lane-job-j"]').getByTestId("lane-job-open").click();
    await page.screenshot({ path: join(SHOTS, `ask-several-job-${theme}.png`), animations: "disabled" });
  });
}
