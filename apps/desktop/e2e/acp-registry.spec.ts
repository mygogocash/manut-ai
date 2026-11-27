// Settings › Providers › From the ACP registry (item 101c, mock host): the registry's agents from the pinned copy, with a
// search; an agent already in Providers says so and has no Add…; Add… on one that is offered opens the custom agent
// confirm card pre-filled from the registry, with the exact command, the archive to download or the line to install it
// with (never run or fetched by the app), Cancel first; Cancel writes nothing; Change… opens the Add agent form with the
// same values; Add writes the one entry, and the agent is then in Providers and the person's own on the list. Shots with
// MANUT_SHOTS=<dir> (MANUT_SHOT_TAG=after by default).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatOpen } from "./start";

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
    ws.send(JSON.stringify({ id: "r1", op, ...args }));
  });
  ws.close();
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

type Call = { op: string; agent?: string };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const file = (page: Page) => page.evaluate(() => (window as unknown as { __manutCustomFile?: unknown[] }).__manutCustomFile ?? null);

async function open(page: Page, theme = "dark") {
  await page.addInitScript(
    ([t]) => {
      localStorage.setItem("manut.theme", t as string);
      const w = window as unknown as { __manutMockAgents: string[]; __manutMockPrograms: Record<string, string> };
      w.__manutMockAgents = ["claude", "codex", "opencode", "gemini"];
      // goose is installed on this pretend Mac; Dirac is not
      w.__manutMockPrograms = { goose: "/opt/homebrew/bin/goose" };
    },
    [theme] as const,
  );
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-providers").click();
  await expect(page.getByTestId("providers-page")).toBeVisible();
  await expect(page.getByTestId("acpreg-pin")).toBeVisible();
}

async function shot(page: Page, name: string, target = page.getByTestId("acpreg")) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: join(SHOTS, `${name}-${TAG}.png`) });
}

test("the registry's agents are listed with a search, the ones already in Providers say so, and the pin is said once", async ({ page }) => {
  await open(page);
  const list = page.getByTestId("acpreg-list");
  await expect(page.getByTestId("acpreg-pin")).toHaveText(/^ACP registry v2026\.11\.26-3667256, published 26 Nov 2026$/);
  // with nothing typed, the ones that can be added come first
  await expect(list.locator("[data-testid^=acpreg-row-]").first()).toHaveAttribute("data-state", "offered");
  await page.getByTestId("acpreg-row-goose").scrollIntoViewIfNeeded();
  await shot(page, "acp-registry-list");
  // Claude Code and Gemini CLI are agents the app already offers: no Add…, and where they are
  await page.getByTestId("acpreg-search").fill("claude");
  await expect(page.getByTestId("acpreg-why-claude-acp")).toHaveText("In Providers as Claude Code");
  await expect(page.getByTestId("acpreg-add-claude-acp")).toHaveCount(0);
  await page.getByTestId("acpreg-search").fill("gemini");
  await expect(page.getByTestId("acpreg-why-gemini")).toHaveText("In Providers as Gemini CLI");
  // one the registry's own checks set aside, and one manut does not offer
  await page.getByTestId("acpreg-search").fill("vt code");
  await expect(page.getByTestId("acpreg-why-vtcode")).toContainText("Set aside by the registry's own checks");
  await page.getByTestId("acpreg-search").fill("kilo");
  await expect(page.getByTestId("acpreg-why-kilo")).toHaveText("Kilo Code is not offered.");
  // rows that can be added and rows that cannot, side by side
  await page.getByTestId("acpreg-search").fill("open source");
  await expect(page.getByTestId("acpreg-why-opencode")).toHaveText("In Providers as OpenCode");
  await shot(page, "acp-registry-search");
  // a maker's name finds its agent, and nothing matching says so
  await page.getByTestId("acpreg-search").fill("jetbrains");
  await expect(page.getByTestId("acpreg-row-junie")).toBeVisible();
  await page.getByTestId("acpreg-search").fill("zzzz no such agent");
  await expect(page.getByTestId("acpreg-none")).toHaveText("No agent in the registry matches.");
  // reading the list wrote nothing and asked for no card
  expect(await file(page)).toBeNull();
  expect((await calls(page)).filter((c) => c.op === "registry.preview" || c.op === "custom.confirm")).toEqual([]);
});

test("Add… opens the confirm card from the registry; Cancel writes nothing; Add puts the agent in Providers", async ({ page }) => {
  await open(page);
  await page.getByTestId("acpreg-search").fill("goose");
  await expect(page.getByTestId("acpreg-row-goose")).toHaveAttribute("data-state", "offered");
  await page.getByTestId("acpreg-add-goose").click();
  const card = page.getByTestId("agent-confirm");
  await expect(card).toBeVisible();
  await expect(card.locator("#ag-card-t")).toHaveText("Add goose?");
  await expect(page.getByTestId("agent-confirm-command")).toHaveText("/opt/homebrew/bin/goose acp");
  await expect(page.getByTestId("agent-confirm-registry")).toContainText("From the ACP registry (v2026.11.26-3667256): goose 1.61.1");
  await expect(page.getByTestId("agent-confirm-archive")).toHaveText(/^https:\/\/github\.com\/block\/goose\/releases\/download\/v1\.61\.1\/.+aarch64-apple-darwin\.tar\.bz2$/);
  await expect(page.getByTestId("agent-confirm-registry")).toContainText("Manut AI never downloads it");
  await expect(card).toContainText("Approvals follow this agent's own settings.");
  // Cancel first, then Change…, then Add
  expect(await card.locator(".ag-acts button").allTextContents()).toEqual(["Cancel", "Change…", "Add"]);
  await shot(page, "acp-registry-card", card);
  await page.getByTestId("agent-confirm-cancel").click();
  await expect(card).toHaveCount(0);
  expect(await file(page)).toBeNull();

  // Change… is the Add agent form with the registry's values, for the person to change before Save
  await page.getByTestId("acpreg-add-goose").click();
  await page.getByTestId("agent-confirm-change").click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("agent-form-label")).toHaveValue("goose");
  await expect(page.getByTestId("agent-form-program")).toHaveValue("goose");
  await expect(page.getByTestId("agent-form-args")).toHaveValue("acp");
  await page.getByTestId("agent-form-cancel").click();
  expect(await file(page)).toBeNull();

  // Add: the one entry is written, and the agent is in Providers and the person's own on the list
  await page.getByTestId("acpreg-add-goose").click();
  await page.getByTestId("agent-confirm-add").click();
  await expect(card).toHaveCount(0);
  expect(await file(page)).toEqual([{ id: "goose", label: "goose", program: "goose", args: ["acp"], install: "" }]);
  await expect(page.getByTestId("agents-mine-goose")).toContainText("/opt/homebrew/bin/goose acp");
  await expect(page.getByTestId("provider-row-goose")).toBeVisible();
  await expect(page.getByTestId("acpreg-why-goose")).toHaveText("Added as goose");
  await expect(page.getByTestId("acpreg-add-goose")).toHaveCount(0);
  expect((await calls(page)).filter((c) => c.op === "custom.confirm").map((c) => c.agent)).toEqual(["goose"]);
});

test("an npm agent's card shows the line to install it with, which the app never runs, and says it is not installed yet", async ({ page }) => {
  await open(page, "light");
  await page.getByTestId("acpreg-search").fill("dirac");
  await page.getByTestId("acpreg-add-dirac").click();
  await expect(page.getByTestId("agent-confirm-install")).toHaveText("npm install -g dirac-cli@0.6.2");
  await expect(page.getByTestId("agent-confirm-registry")).toContainText("Install it yourself first, in a terminal. Manut AI never runs this:");
  await expect(page.getByTestId("agent-confirm-command")).toHaveText("dirac --acp");
  await expect(page.getByTestId("agent-confirm-missing")).toHaveText("dirac: not found on the search path");
  await shot(page, "acp-registry-card-npm", page.getByTestId("agent-confirm"));
  await page.getByTestId("agent-confirm-cancel").click();
  expect(await file(page)).toBeNull();
});
