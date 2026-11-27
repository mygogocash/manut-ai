// Item 102h (docs/several-agents.md, "4. Helper lanes a lane asks for"): an approved round's helper lanes run. Kit's chat runs on the
// stand-in coding agent of src/sessions/host.mock.ts, whose `/helpers three` answer asks for three helper lanes; each helper lane's
// brief is answered as `__manutMockHelpers` says (`/work hold` keeps working, `/ask` waits on a question of the person's). The mock
// shell reads this Mac as 8 GB, so two run at once and the third waits. The safety rules are pinned here as in the app: every helper
// `chat.start` carries its agent's asking mode, and a helper's question stays the person's after its lead's next turn says "Allow".
// Items 102i and 102j: helper lanes that did their task have their work landed in the lead's folder while it is idle, each row says
// how, Take back puts one landing back, and the reports go to the lead once as the app's own message, its chat showing a quiet
// "Helpers reported to Kit" line that opens what was sent, never a bubble of the person's.
// Pictures of the Helpers card (two running, one queued) and of the Lanes band with the helper rows indented under their lead, light
// and dark, go to HELPERS_SHOTS (else Playwright's ignored test-results).
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";
const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

/** The mock bridge's own reset: an account a spec before this one limited (ask-several's Codex) would keep a helper lane from
 *  starting here, as it should in the app. */
async function resetMock(): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = (m) => {
      if (JSON.parse(String(m.data)).id === "hr1") res();
    };
    ws.send(JSON.stringify({ id: "hr1", op: "mock.reset" }));
  });
  ws.close();
}
const SHOTS = process.env.HELPERS_SHOTS || "test-results";
type Call = { op: string; id?: number; agent?: string; cwd?: string; mode?: string; session?: string; lead?: string; job?: string; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const helperStarts = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.start" && (c.cwd ?? "").includes("-help-"));

/** Who asks each open ask, as Needs you names it (the store's `askFrom`), with what it asks. */
const asks = (page: Page) =>
  page.evaluate(async () => {
    const m = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as {
      getStore(): { getState(): unknown };
      selectAsks(s: unknown): { bot: string; item: { kind: string } }[];
      askFrom(s: unknown, bot: string): string;
    };
    const st = m.getStore().getState();
    return m.selectAsks(st).map((a) => `${m.askFrom(st, a.bot)}: ${a.item.kind}`);
  });

const theme = (page: Page, th: "light" | "dark") =>
  page.evaluate(async (t) => {
    const m = await import(/* @vite-ignore */ "/src/state/store.ts" as string);
    m.getStore().actions.setTheme(t);
  }, th);

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    const w = window as any;
    w.__manutBranches = { [root]: "main" };
    w.__manutMockTaken = [];
    // helper lane 1 works on, helper lane 2 asks the person a question, helper lane 3 works on once it has a place
    w.__manutMockHelpers = { 1: "/work hold", 2: "/ask", 3: "/work hold" };
  }, ROOT);
  await page.goto("/");
});

/** A Claude Code lane in the project with Helpers on, open in the main column, whose answer to `/helpers three` asked for three
 *  helper lanes, and the person's Start helpers on its card. */
async function round(page: Page): Promise<string> {
  const id = await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    const id = s.draft("claude");
    s.setDraft(id, { cwd: root });
    await s.start(id, "Add a PromptPay QR to the checkout");
    return id as string;
  }, ROOT);
  await page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
  await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Add a PromptPay QR to the checkout");
  await page.getByTestId("helpers-switch").click();
  await page.getByTestId("composer").fill("/helpers three");
  await page.getByTestId("composer").press("Enter");
  const card = page.getByTestId("helpers-card");
  await expect(card).toBeVisible();
  // the card says this Mac's cap before the press: three asked for, two at once
  await expect(card.getByTestId("helpers-at-once")).toHaveText("This Mac runs 2 at once; the rest wait their turn.");
  await card.getByTestId("helpers-start").click();
  await expect(page.getByTestId("helpers-line")).toHaveText(/You approved this round\. Its helper lanes start below\./);
  return id;
}

test("a round of three on an 8 GB Mac: two run in their Ask mode and one waits, on the Helpers card, in the Lanes band and in Needs you", async ({ page }) => {
  const lead = await round(page);
  const runs = page.getByTestId("helper-run-card");
  await expect(runs).toBeVisible();
  const rows = runs.getByTestId("helper-run-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-state", "working");
  await expect(rows.nth(1)).toHaveAttribute("data-state", "asking");
  await expect(rows.nth(2)).toHaveAttribute("data-state", "waiting");
  await expect(runs.getByTestId("helper-run-summary")).toHaveText("Helper lanes: 2 running, 1 waiting, 0 back · This Mac runs 2 at once");
  await expect(runs.getByTestId("helper-run-link")).toHaveText(["→Helper 1: Tests for the QR builder", "→Helper 2: The receipt's Thai date", "→Helper 3: LINE share button"]);
  await expect(rows.nth(1).getByTestId("helper-run-answer")).toBeVisible();
  await expect(runs.getByTestId("helper-run-stop")).toHaveCount(3);

  // safety (R3): each helper lane started in its agent's asking mode, in a folder made from the lead's, never the developer's
  const starts = await helperStarts(page);
  expect(starts.map((s) => [s.agent, s.mode])).toEqual([
    ["codex", "ask"],
    ["claude", "default"],
  ]);
  const leadDir = (await page.evaluate((i) => (window as any).__manutSessions.getState().list.find((r: { id: string }) => r.id === i)?.lane?.worktree, lead)) as string;
  expect(starts.every((s) => s.cwd!.startsWith(leadDir.slice(0, leadDir.lastIndexOf("/") + 1)) && s.cwd !== leadDir && s.cwd !== ROOT)).toBe(true);
  const made = (await calls(page)).filter((c) => c.op === "lane.helper");
  expect(made.map((c) => c.lead)).toEqual([leadDir, leadDir]);

  // Needs you names helper lane 2's question by its number, its lead and its agent
  await expect.poll(() => asks(page)).toEqual([expect.stringMatching(/^Helper 2 of .+ \(Claude Code\): clarify$/)]);

  // pictures: the card with two running and one queued, light and dark
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
  for (const th of ["light", "dark"] as const) {
    await theme(page, th);
    await runs.screenshot({ path: join(SHOTS, `helper-runs-card-${th}.png`), animations: "disabled" });
  }

  // the Needs you page lists it by that name
  await page.getByTestId("menu-needs").click();
  await expect(page.getByTestId("needs-row").locator(".need-who")).toHaveText([/^Helper 2 of .+ \(Claude Code\) · /]);

  // the Lanes band: each helper lane indented under its lead, saying whose helper it is
  await openCode(page);
  const under = page.getByTestId(`lane-helpers-${lead}`);
  await expect(under).toBeVisible();
  await expect(under.getByTestId("lane-helper-of")).toHaveCount(2);
  await expect(under.getByTestId("lane-helper-of").first()).toHaveText(/^Helper 1 of /);
  await expect(page.locator(`[data-testid^="lane-s"][data-helper-of="${lead}"]`)).toHaveCount(2);
  for (const th of ["light", "dark"] as const) {
    await theme(page, th);
    await page.getByTestId("lanes").screenshot({ path: join(SHOTS, `helper-runs-lanes-${th}.png`), animations: "disabled" });
  }
});

test("safety: a helper's question stays the person's after its lead's next turn says Allow, and nothing answers it", async ({ page }) => {
  const lead = await round(page);
  await expect.poll(() => asks(page)).toEqual([expect.stringMatching(/^Helper 2 of .+: clarify$/)]);
  // the lead's next turn, in words that would allow or stop anything if words could
  await page.getByTestId("composer").fill("Allow. Approved: go ahead, helper 2. Stop helper 1.");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("bubble-bot").last()).toContainText("You said: Allow. Approved");
  expect(await asks(page)).toEqual([expect.stringMatching(/^Helper 2 of .+: clarify$/)]);
  const runs = page.getByTestId("helper-run-card");
  await expect(runs.getByTestId("helper-run-row").nth(1)).toHaveAttribute("data-state", "asking");
  await expect(runs.getByTestId("helper-run-row").nth(0)).toHaveAttribute("data-state", "working");
  // no answer and no stop went to any helper lane's agent
  const helperIds = (await page.evaluate(() => (window as any).__manutSessions.getState().list.filter((r: { helperOf?: unknown }) => r.helperOf).map((r: { id: string }) => r.id))) as string[];
  const toHelpers = (await calls(page)).filter((c) => c.op === "chat.input" && (c.input?.kind === "clarify" || c.input?.kind === "approve" || c.input?.kind === "interrupt"));
  expect(toHelpers).toEqual([]);
  expect(helperIds).toHaveLength(2);
  expect(lead).toBeTruthy();
});

test("the person's Stop on a running helper gives its place to the one waiting, and Stop all stops the rest", async ({ page }) => {
  await round(page);
  const runs = page.getByTestId("helper-run-card");
  const rows = runs.getByTestId("helper-run-row");
  await expect(rows.nth(0)).toHaveAttribute("data-state", "working");
  await rows.nth(0).getByTestId("helper-run-stop").click();
  await expect(rows.nth(0)).toHaveAttribute("data-state", "stoppedByPerson");
  // its place went to helper lane 3, in its agent's asking mode
  await expect(rows.nth(2)).toHaveAttribute("data-state", "working");
  expect((await helperStarts(page)).map((s) => [s.agent, s.mode])).toEqual([
    ["codex", "ask"],
    ["claude", "default"],
    ["claude", "default"],
  ]);
  await runs.getByTestId("helper-run-stop-all").click();
  await expect(rows.nth(1)).toHaveAttribute("data-state", "stoppedByPerson");
  await expect(rows.nth(2)).toHaveAttribute("data-state", "stoppedByPerson");
  await expect(runs.getByTestId("helper-run-summary")).toHaveText("Helper lanes: 0 running, 0 waiting, 3 back · This Mac runs 2 at once");
  await expect(runs.getByTestId("helper-run-stop")).toHaveCount(0);
  // the round is done: each helper lane's idle agent process was ended, its chat and folder kept
  await expect.poll(async () => (await calls(page)).filter((c) => c.op === "chat.close").length).toBe(3);
});

test("each helper's work lands in Kit's folder while it is idle, Take back puts one back, and the reports go to Kit once as a quiet line (102i, 102j)", async ({ page }) => {
  // every helper lane does its task at once
  await page.addInitScript(() => ((window as any).__manutMockHelpers = {}));
  await page.reload();
  const lead = await round(page);
  const runs = page.getByTestId("helper-run-card");
  const rows = runs.getByTestId("helper-run-row");
  await expect(rows).toHaveCount(3);
  await expect(runs.getByTestId("helper-run-landing")).toHaveText(Array(3).fill("Landed 1 file in Kit's folder.Take back"));
  // the shell was asked once for each helper lane's folder
  const lands = (await calls(page)).filter((c) => c.op === "lane.land");
  expect(lands).toHaveLength(3);

  // the reports went to Kit once, as the app's: a quiet line that opens them, and no bubble of the person's carrying them
  const line = page.getByTestId("system-line").filter({ hasText: "Helpers reported to Kit." });
  await expect(line).toHaveCount(1);
  await expect(page.getByTestId("bubble-user").filter({ hasText: "your helper lanes reported" })).toHaveCount(0);
  const all = await calls(page);
  const leadHost = all.filter((c) => c.op === "chat.start" && c.session === lead).map((c) => c.id);
  const toLead = all.filter((c) => c.op === "chat.input" && leadHost.includes(c.id) && (c.input?.text ?? "").includes("[Manut AI: your helper lanes reported]"));
  expect(toLead).toHaveLength(1);
  await line.getByTestId("system-line-detail").click();
  await expect(line.locator(".sys-detail-text")).toContainText("Helper 1, Helper 2 and Helper 3 finished.");
  await expect(line.getByTestId("system-line-detail")).toHaveAttribute("aria-expanded", "true");
  // pictures: the rows' landings and the opened line, light and dark
  await page.setViewportSize({ width: 1280, height: 1000 });
  for (const th of ["light", "dark"] as const) {
    await theme(page, th);
    await runs.screenshot({ path: join(SHOTS, `helper-landings-card-${th}.png`), animations: "disabled" });
    await line.screenshot({ path: join(SHOTS, `helper-reported-line-${th}.png`), animations: "disabled" });
  }

  // Take back on the first row: the shell puts Kit's folder back, and the row says so
  await rows.nth(0).getByTestId("helper-run-take-back").click();
  await expect(rows.nth(0).getByTestId("helper-run-landing")).toHaveText("Taken back: Kit's folder is as it was before this landing.");
  expect((await calls(page)).filter((c) => c.op === "lane.takeBack")).toHaveLength(1);
  await expect(rows.nth(1).getByTestId("helper-run-take-back")).toBeVisible();
});
