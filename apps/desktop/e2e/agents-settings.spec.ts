// Settings › Providers (item 74, mock host; Settings › Agents until then): every agent the app knows with a switch, its
// status and version, in four languages; an agent turned off leaves both parts of the + menu at once and comes back when
// turned on; the chosen agent's settings, where an argument that skips the asks is refused by name and a variable's value
// is never shown again once saved; Your agents (the person's own ACP agents): Add agent -> Save opens a confirm card with
// the exact command and nothing is written until Add; Cancel writes nothing; the new agent appears in the SESSIONS + menu
// after the generic ACP agents and opens a session chat (the mock speaks what the generic ACP adapter emits), whose view
// says once that approvals follow the agent's own settings; Remove asks once, then ends its open session. Shots with
// MANUT_SHOTS=<dir> (MANUT_SHOT_TAG=after by default).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatOpen, openCode } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS || "";
const TAG = process.env.MANUT_SHOT_TAG || "after";

async function mock(op: string, args: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "x1", op, ...args }));
  });
  ws.close();
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

type Call = { op: string; agent?: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const file = (page: Page) => page.evaluate(() => (window as unknown as { __manutCustomFile?: unknown[] }).__manutCustomFile ?? null);

async function open(page: Page, opts: { theme?: string; lang?: string; file?: unknown[] } = {}) {
  await page.addInitScript(
    ([t, l, f]) => {
      localStorage.setItem("manut.theme", t as string);
      if (l) localStorage.setItem("manut.lang", l as string);
      localStorage.removeItem("manut.sessions.recent");
      const w = window as unknown as { __manutPickFolder: string; __manutMockAgents: string[]; __manutCustomFile?: unknown[] };
      w.__manutPickFolder = "/home/you/code/web-app";
      w.__manutMockAgents = ["claude", "codex", "omh", "opencode", "gemini"];
      if (f) w.__manutCustomFile = f as unknown[];
    },
    [opts.theme ?? "dark", opts.lang ?? "", opts.file ?? null] as const,
  );
  await page.goto("/");
  await chatOpen(page);
}

async function agentsPage(page: Page) {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await expect(page.getByTestId("providers-page")).toBeVisible();
  await expect(page.getByTestId("provider-row-cline")).toBeVisible();
  await expect(page.getByTestId("agents-page")).toBeVisible();
}

async function fill(page: Page, label: string, program: string, args = "acp") {
  await page.getByTestId("agents-add").click();
  await page.getByTestId("agent-form-label").fill(label);
  await page.getByTestId("agent-form-program").fill(program);
  await page.getByTestId("agent-form-args").fill(args);
}

async function plus(page: Page) {
  await openCode(page);
  await page.getByTestId("session-new").click();
  await expect(page.getByTestId("session-agent-claude")).toBeVisible();
  await page.waitForFunction(() => document.querySelector(".ss-pop")?.getAnimations().every((a) => a.playState !== "running"));
}

test("the page lists every agent with a switch and its status, between Terminal and Computer", async ({ page }) => {
  await open(page);
  await agentsPage(page);
  const rows = page.locator("[data-testid=providers-list] [data-testid^=provider-row-]");
  // every agent the app knows: the built-ins, then the ACP agents, Cursor and Antigravity among them (item 74)
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("provider-row-".length)))).toEqual([
    "claude", "codex", "omo", "dsh", "pi", "omp", "grok", "opencode", "gemini", "qwen", "kimi", "copilot", "cline", "cursor-agent", "agy",
  ]);
  // oh-my-hermes is offered nowhere, so it is not listed either
  await expect(page.getByTestId("provider-status-gemini")).toHaveText("Installed");
  await expect(page.getByTestId("provider-status-qwen")).toHaveText("Not installed");
  await expect(page.getByTestId("provider-version-claude")).toHaveText("2.1.332");
  await expect(page.getByTestId("provider-switch-claude")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("agents-mine")).toContainText("No agents of your own yet");
  // the page sits where Agents was, between Terminal and Computer, and Accounts is a part of it, not a page of its own
  const names = await page.locator(".st-nav button").allTextContents();
  expect(names.indexOf("Providers")).toBe(names.indexOf("Terminal") + 1);
  expect(names.indexOf("Computer")).toBe(names.indexOf("Providers") + 1);
  expect(names).not.toContain("Accounts");
  expect(names).not.toContain("Agents");
  await expect(page.getByTestId("accounts-page")).toBeAttached();
});

test("an agent turned off leaves both parts of the + menu at once, and comes back when turned on", async ({ page }) => {
  await open(page);
  await agentsPage(page);
  await page.getByTestId("provider-switch-claude").click();
  await expect(page.getByTestId("provider-switch-claude")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("provider-status-claude")).toHaveText("Turned off");
  await page.getByRole("button", { name: "Close settings" }).click();
  await openCode(page);
  await page.getByTestId("session-new").click();
  await expect(page.getByTestId("session-agent-codex")).toBeVisible();
  // neither Chat with Kit nor In a terminal (nor More agents) offers it
  await expect(page.getByTestId("session-chat-claude")).toHaveCount(0);
  await expect(page.getByTestId("session-agent-claude")).toHaveCount(0);
  await expect(page.getByTestId("session-chat-codex")).toBeVisible();
  await page.keyboard.press("Escape");
  await agentsPage(page);
  await page.getByTestId("provider-switch-claude").click();
  await expect(page.getByTestId("provider-switch-claude")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Close settings" }).click();
  await plus(page);
  await expect(page.getByTestId("session-chat-claude")).toBeVisible();
});

test("an agent's settings: a refused argument is refused by name, and a variable's value is never shown again", async ({ page }) => {
  const secret = "sk-live-7f3a9c2e1b";
  await open(page);
  await agentsPage(page);
  await page.getByTestId("provider-open-claude").click();
  const detail = page.getByTestId("provider-detail");
  await expect(detail).toBeVisible();
  await expect(page.getByTestId("provider-detail-status")).toBeVisible();
  // an argument that would skip the asks: refused with its name, nothing saved
  await page.getByTestId("provider-args").fill("--model=opus\n--dangerously-skip-permissions");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-error")).toHaveText("--dangerously-skip-permissions would let Claude Code act without asking first, or outside its sandbox, so Manut AI does not pass it.");
  // one the app sets itself
  await page.getByTestId("provider-args").fill("--permission-prompt-tool=x");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-error")).toContainText("--permission-prompt-tool is set by Manut AI itself");
  // a path that is not a program
  await page.getByTestId("provider-args").fill("--model=opus");
  await page.getByTestId("provider-path").fill("/nowhere/claude");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-error")).toHaveText("That path is not a program this account may run.");
  await page.getByTestId("provider-path").fill("");
  // a variable: saved once, then only its name
  await page.getByTestId("provider-var-add").click();
  await page.getByTestId("provider-var-name").fill("MY_KEY");
  await page.getByTestId("provider-var-value").fill(secret);
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-note")).toHaveText("Saved");
  await expect(page.getByTestId("provider-runs-chat")).toContainText("--model=opus");
  await expect(page.getByTestId("provider-var-name")).toHaveValue("MY_KEY");
  await expect(page.getByTestId("provider-var-value")).toHaveValue("");
  await expect(page.getByTestId("provider-var-value")).toHaveAttribute("placeholder", "Saved, hidden. Type to replace it.");
  expect(await page.content()).not.toContain(secret);
  const log = await page.evaluate(() => JSON.stringify((window as unknown as { __manutSessionCalls?: unknown[] }).__manutSessionCalls ?? []));
  expect(log).not.toContain(secret);
  // a display name is the agent's name in the list
  await page.getByTestId("provider-name").fill("Claude at work");
  await page.getByTestId("provider-save").click();
  await expect(page.getByTestId("provider-row-claude").locator(".prov-n b")).toHaveText("Claude at work");
  expect(await page.content()).not.toContain(secret);
});

test("Save opens the confirm card with the exact command; Cancel writes nothing", async ({ page }) => {
  await open(page);
  await agentsPage(page);
  await fill(page, "Acme Agent", "acme-agent");
  await expect(page.getByTestId("agent-form-nokeys")).toHaveText("No keys, tokens or environment variables here: the agent signs in on its own.");
  await expect(page.getByTestId("agent-form-args")).toHaveValue("acp");
  await page.getByTestId("agent-form-save").click();
  const card = page.getByTestId("agent-confirm");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("agent-confirm-command")).toHaveText("/opt/homebrew/bin/acme-agent acp");
  await expect(card).toContainText("In the folder you pick for each session.");
  // Cancel comes first, Add second
  expect(await card.locator("button").allTextContents()).toEqual(["Cancel", "Add"]);
  expect(await file(page)).toBeNull();
  await page.getByTestId("agent-confirm-cancel").click();
  await expect(card).toHaveCount(0);
  expect(await file(page)).toBeNull();
  expect((await calls(page)).filter((c) => c.op === "custom.confirm")).toEqual([]);
  // a program that is not on the search path: the card shows it as typed with every argument, and says it is missing
  await page.getByTestId("agent-form-program").fill("not-here");
  await page.getByTestId("agent-form-args").fill("--unshown");
  await page.getByTestId("agent-form-save").click();
  await expect(page.getByTestId("agent-confirm-command")).toHaveText("not-here --unshown");
  await expect(page.getByTestId("agent-confirm-missing")).toHaveText("not-here: not found on the search path");
  await page.getByTestId("agent-confirm-cancel").click();
  // OpenCode and Kilo Code are refused with one line, no card
  for (const [program, line] of [["opencode", "Use the built-in OpenCode."], ["kilo", "Kilo Code is not offered."], ["acme-agent; rm -rf ~", "Give a program name on your search path or a full path, with no shell characters."]]) {
    await page.getByTestId("agent-form-program").fill(program);
    await page.getByTestId("agent-form-save").click();
    await expect(page.getByTestId("agents-error")).toHaveText(line);
    await expect(page.getByTestId("agent-confirm")).toHaveCount(0);
  }
  expect(await file(page)).toBeNull();
});

// chat-mode CLI sessions replaced by bot threads (2026-11-16: terminals kept)
test.skip("Add writes it; it appears in the + menu after the generic ACP agents and opens a session chat; Remove ends it", async ({ page }) => {
  await open(page);
  await agentsPage(page);
  await fill(page, "Stub ACP", "stub-acp");
  await page.getByTestId("agent-form-save").click();
  await expect(page.getByTestId("agent-confirm-command")).toHaveText("/usr/local/bin/stub-acp acp");
  await page.getByTestId("agent-confirm-add").click();
  await expect(page.getByTestId("agent-confirm")).toHaveCount(0);
  expect(await file(page)).toEqual([{ id: "stub-acp", label: "Stub ACP", program: "stub-acp", args: ["acp"], install: "" }]);
  await expect(page.getByTestId("agents-mine-stub-acp")).toContainText("/usr/local/bin/stub-acp acp");

  // the + menu: installed, after Gemini CLI (the generic ACP tier)
  await page.getByRole("button", { name: "Close settings" }).click();
  await plus(page);
  const items = await page.locator("[data-testid=session-menu-list] > [data-testid^=session-agent-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(items.indexOf("session-agent-stub-acp")).toBe(items.indexOf("session-agent-gemini") + 1);
  await page.getByTestId("session-agent-stub-acp").click();
  await expect(page.getByTestId("session-agent-fixed")).toContainText("Stub ACP");
  await expect(page.getByTestId("session-own-approvals")).toHaveText("Approvals follow this agent's own settings");
  await page.getByTestId("composer").fill("hello");
  await page.getByTestId("composer").press("Enter");
  await expect(page.locator("[data-testid=timeline]")).toContainText("(mock Stub ACP) You said: hello", { timeout: 10_000 });
  expect((await calls(page)).find((c) => c.op === "chat.start")).toMatchObject({ agent: "stub-acp" });
  // said once in the session view
  await expect(page.getByTestId("session-own-approvals")).toHaveCount(1);
  const session = await page.evaluate(() => document.querySelector("[data-testid=session-chat]")?.getAttribute("data-pane"));

  // remove: one confirm, then gone; its open session ends cleanly
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await page.getByTestId("agents-remove-stub-acp").click();
  await expect(page.getByTestId("agents-remove-confirm")).toContainText("Remove Stub ACP? Its open sessions end.");
  await page.getByTestId("agents-remove-yes").click();
  await expect(page.getByTestId("agents-mine-stub-acp")).toHaveCount(0);
  expect(await file(page)).toEqual([]);
  expect((await calls(page)).some((c) => c.op === "chat.close")).toBe(true);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator(`[data-testid="session-${session!.slice("agent:".length)}"] .ss-open`).click();
  await expect(page.locator(`[data-pane="${session}"]`).getByTestId("session-ended")).toBeVisible();
  await plus(page);
  await expect(page.getByTestId("session-agent-stub-acp")).toHaveCount(0);
});

// chat-mode CLI sessions replaced by bot threads (2026-11-16: terminals kept)
test.skip("a broken entry of the file is listed as broken, never offered, and can be removed", async ({ page }) => {
  await open(page, { file: [{ id: "evil", label: "Evil", program: "sh", args: ["-c", "rm -rf ~"], install: "" }, { id: "acme", label: "Acme", program: "acme-agent", args: ["acp"], install: "" }] });
  await agentsPage(page);
  await expect(page.getByTestId("agents-broken-evil")).toContainText("evil cannot run");
  await expect(page.getByTestId("agents-mine-acme")).toBeVisible();
  await page.getByRole("button", { name: "Close settings" }).click();
  await plus(page);
  await expect(page.getByTestId("session-agent-evil")).toHaveCount(0);
  await expect(page.getByTestId("session-agent-acme")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await page.getByTestId("agents-remove-evil").click();
  await page.getByTestId("agents-remove-yes").click();
  await expect(page.getByTestId("agents-broken-evil")).toHaveCount(0);
  expect(await file(page)).toEqual([{ id: "acme", label: "Acme", program: "acme-agent", args: ["acp"], install: "" }]);
});

for (const [lang, title, off, add, card] of [
  ["en", "Providers", "Turned off", "Add agent", "Add Acme?"],
  ["ko", "프로바이더", "꺼짐", "에이전트 추가", "Acme을(를) 추가할까요?"],
  ["ja", "プロバイダー", "オフ", "エージェントを追加", "Acme を追加しますか？"],
  ["zh", "提供方", "已关闭", "添加智能体", "添加 Acme？"],
] as const) {
  test(`the page and its card read in ${lang}`, async ({ page }) => {
    await open(page, { lang });
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("settings-nav-providers")).toHaveText(title);
    await page.getByTestId("settings-nav-providers").click();
    await page.getByTestId("provider-switch-gemini").click();
    await expect(page.getByTestId("provider-status-gemini")).toHaveText(off);
    await expect(page.getByTestId("agents-add")).toHaveText(add);
    await fill(page, "Acme", "acme-agent");
    await page.getByTestId("agent-form-save").click();
    await expect(page.getByTestId("agent-confirm")).toContainText(card);
    await expect(page.getByTestId("agent-confirm-command")).toHaveText("/opt/homebrew/bin/acme-agent acp");
  });
}

// ---- shots --------------------------------------------------------------------------------------

const FILE = [{ id: "acme-agent", label: "Acme Agent", program: "acme-agent", args: ["acp"], install: "" }];

for (const theme of ["dark", "light"]) {
  test(`shots: Settings › Providers, the confirm card and the + menu (${theme})`, async ({ page }) => {
    test.skip(!SHOTS, "set MANUT_SHOTS to take the shots");
    await mock("bots.rename", { bot: "default", name: "Milo" });
    await page.setViewportSize({ width: 1280, height: 820 });
    await open(page, { theme, file: FILE });
    mkdirSync(SHOTS, { recursive: true });
    await agentsPage(page);
    await expect(page.getByTestId("agents-mine-acme-agent")).toBeVisible();
    // the top of the page: the list with an agent open, then the end: Your agents and Add agent
    await page.getByTestId("provider-open-claude").click();
    await page.mouse.move(1200, 780);
    await page.screenshot({ path: join(SHOTS, `providers-${TAG}-${theme}.png`), animations: "disabled" });
    await page.getByTestId("agents-add").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `agents-settings-${TAG}-${theme}.png`), animations: "disabled" });
    await fill(page, "Stub ACP", "stub-acp");
    await page.getByTestId("agent-form-save").click();
    await expect(page.getByTestId("agent-confirm")).toBeVisible();
    await page.getByTestId("agent-confirm").locator("b").first().click();
    await page.screenshot({ path: join(SHOTS, `agents-confirm-${TAG}-${theme}.png`), animations: "disabled" });
    await page.getByTestId("agent-confirm-cancel").click();
    await page.getByRole("button", { name: "Close settings" }).click();
    await plus(page);
    await page.mouse.move(900, 400);
    await page.screenshot({ path: join(SHOTS, `agents-menu-custom-${TAG}-${theme}.png`), animations: "disabled" });
  });
}
