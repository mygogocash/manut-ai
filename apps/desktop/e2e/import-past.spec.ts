// Item 101e, against the mock host (window.__manutImportFound is what the shell's look finds, window.__manutPastChats the
// conversations Claude Code and Codex keep):
// 1. on a first launch the offer opens by itself with what was found, nothing picked, a folder that is a project already marked,
//    what was skipped, and the one line that nothing is copied or sent; nothing is added before the confirmation;
// 2. the picks, confirmed, become projects on the Code page, and their conversations show in History, where one continues as a
//    session; a folder not brought over keeps its conversations out of History;
// 3. bringing over again (History's Bring over…) adds nothing twice, and the offer never opens by itself again;
// 4. Not now adds nothing, and the offer does not open by itself again.
// Shots (MANUT_SHOTS=<dir>): the offer, the confirmation, the result, History and the Code page after, light and dark.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCode } from "./start";

const SHOTS = process.env.MANUT_SHOTS || "";
const WEB = "/home/you/code/web-app";
const API = "/home/you/code/shop-api";
const SITE = "/home/you/code/baanmali-site";
const OTHER = "/home/you/code/not-brought";
const now = () => Date.now() / 1000;

const FOUND = {
  projects: [
    { cwd: API, claude: 0, codex: 4, at: 0 },
    { cwd: WEB, claude: 10, codex: 2, at: 0 },
    { cwd: SITE, claude: 3, codex: 0, at: 0 },
  ],
  skipped: { gone: 2, compressed: 14, unreadable: 1, over_limit: 0 },
  partial: false,
};
const PAST = [
  { agent: "codex", id: "01a1d060-4ab7-72b2-b02b-1dbee1d5f52c", cwd: API, title: "Add a dark theme", named: true },
  { agent: "claude", id: "aaaaaaaa-1111-4222-8333-444444444444", cwd: WEB, title: "Fix the login redirect", named: true },
  { agent: "claude", id: "cccccccc-1111-4222-8333-444444444444", cwd: OTHER, title: "Not brought over", named: true },
];

async function setup(page: Page, theme: "dark" | "light" = "light") {
  await page.addInitScript(
    ([theme, found, past, site]) => {
      const w = window as unknown as Record<string, unknown>;
      // what the look finds, with each folder's newest conversation an hour, a day and a week ago
      const t = Date.now() / 1000;
      const f = found as { projects: { at: number }[] };
      [3_600, 86_400, 7 * 86_400].forEach((ago, i) => (f.projects[i].at = t - ago));
      w.__manutImportFound = f;
      w.__manutPastChats = (past as Record<string, unknown>[]).map((c, i) => ({ ...c, at: t - 600 - i * 3_600 }));
      // seeded once per test: a reload keeps what the app wrote since
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("manut.theme", theme as string);
      localStorage.removeItem("manut.importPast");
      localStorage.removeItem("manut.resume");
      // one project the person added before: found again, it is marked as one already
      localStorage.setItem("manut.term.folders", JSON.stringify({ collapsed: [], order: [site], added: [site] }));
    },
    [theme, FOUND, PAST, SITE] as const,
  );
  await page.goto("/");
}

const dialog = (page: Page) => page.getByTestId("imp-dialog");
const row = (page: Page, cwd: string) => dialog(page).locator(`[data-testid="imp-row"][data-cwd="${cwd}"]`);
const folders = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("manut.term.folders") || "{}") as { added?: string[]; order?: string[] });
const record = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("manut.importPast") || "null") as { offered: boolean; folders: string[] } | null);
const looks = (page: Page) => page.evaluate(() => (window as unknown as { __manutImportLooks?: number }).__manutImportLooks ?? 0);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled", caret: "initial" });
}

test("on a first launch the offer shows what was found, nothing picked, and adds nothing until it is confirmed", async ({ page }) => {
  await setup(page);
  await expect(dialog(page)).toHaveAttribute("data-step", "pick");
  await expect(dialog(page)).toContainText("Bring over your Claude Code and Codex work");
  await expect(page.getByTestId("imp-promise")).toHaveText("Only read: nothing in those agents' files is copied, moved or changed, and nothing leaves this Mac.");
  // newest first, each with its conversations; the folder added before is marked, with no box
  await expect(dialog(page).getByTestId("imp-row")).toHaveCount(3);
  expect(await dialog(page).getByTestId("imp-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-cwd")))).toEqual([API, WEB, SITE]);
  await expect(row(page, WEB)).toContainText("web-app");
  await expect(row(page, WEB)).toContainText("~/code/web-app");
  await expect(row(page, WEB)).toContainText("12 conversations");
  await expect(row(page, SITE).getByTestId("imp-here")).toHaveText("Already a project");
  await expect(row(page, SITE).getByTestId("imp-pick")).toHaveCount(0);
  await expect(page.getByTestId("imp-skipped")).toHaveText(
    "Skipped: 2 folders no longer on this Mac, 14 compressed Codex conversations that could not be unpacked, 1 file that could not be read.",
  );
  // nothing is picked, and the button waits for a pick
  for (const box of await dialog(page).getByTestId("imp-pick").all()) await expect(box).not.toBeChecked();
  await expect(page.getByTestId("imp-next")).toBeDisabled();
  expect(await looks(page)).toBe(1);
  await shot(page, "import-offer-light");

  await row(page, WEB).getByTestId("imp-pick").check();
  await row(page, API).getByTestId("imp-pick").check();
  await expect(page.getByTestId("imp-next")).toHaveText("Bring over 2 projects…");
  await page.getByTestId("imp-next").click();
  await expect(dialog(page)).toHaveAttribute("data-step", "confirm");
  await expect(dialog(page).getByRole("heading")).toHaveText("Bring over 2 projects?");
  await expect(page.getByTestId("imp-picked").locator("li")).toHaveCount(2);
  // still nothing added while it asks
  expect((await folders(page)).added).toEqual([SITE]);
  expect(await record(page)).toBeNull();
  await shot(page, "import-confirm-light");

  await page.getByTestId("imp-go").click();
  await expect(dialog(page)).toHaveAttribute("data-step", "done");
  await expect(dialog(page).getByRole("heading")).toHaveText("Brought over 2 projects");
  await expect(page.getByTestId("imp-done-body")).toHaveText("They are on the Code page now, and their conversations are in History.");
  expect((await folders(page)).added).toEqual([API, WEB, SITE]);
  expect(await record(page)).toEqual({ offered: true, folders: [API, WEB] });
  await shot(page, "import-done-light");

  // History lists the conversations of the folders brought over, and only theirs
  await page.getByTestId("imp-history").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("page-history")).toBeVisible();
  const past = page.locator('[data-testid="history-row"][data-kind="past"]');
  await expect(past).toHaveCount(2);
  await expect(past.nth(0)).toContainText("Add a dark theme");
  await expect(past.nth(0).getByTestId("history-folder")).toHaveText("shop-api");
  await expect(past.nth(1)).toContainText("Fix the login redirect");
  await expect(past.nth(1)).toContainText("Claude Code");
  await expect(page.getByTestId("history-row").filter({ hasText: "Not brought over" })).toHaveCount(0);
  await shot(page, "import-history-light");

  // the Code page lists both as projects
  await openCode(page);
  await expect(page.locator(`[data-testid="term-group"][data-cwd="${WEB}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="term-group"][data-cwd="${API}"]`)).toBeVisible();
  await shot(page, "import-code-light");
});

test("a conversation brought over continues from History as a session, showing what was said before", async ({ page }) => {
  await setup(page);
  await row(page, WEB).getByTestId("imp-pick").check();
  await page.getByTestId("imp-next").click();
  await page.getByTestId("imp-go").click();
  await page.getByTestId("imp-history").click();
  await page.locator('[data-testid="history-row"][data-kind="past"]').filter({ hasText: "Fix the login redirect" }).click();
  // the same path as the + menu's past conversations: its last messages read, then the agent continues it
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as { __manutPastReads?: { op: string; id?: string }[] }).__manutPastReads ?? []).filter((r) => r.op === "read")))
    .toEqual([{ op: "read", agent: "claude", id: "aaaaaaaa-1111-4222-8333-444444444444", cwd: WEB }]);
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: { op: string; resume?: string; cwd?: string }[] }).__manutSessionCalls ?? []).find((c) => c.op === "chat.start")))
    .toMatchObject({ agent: "claude", cwd: WEB, resume: "aaaaaaaa-1111-4222-8333-444444444444" });
});

test("bringing over again adds nothing twice, and the offer never opens by itself again", async ({ page }) => {
  await setup(page, "dark");
  await row(page, WEB).getByTestId("imp-pick").check();
  await page.getByTestId("imp-next").click();
  await page.getByTestId("imp-go").click();
  await page.getByTestId("imp-ok").click();
  await expect(dialog(page)).toHaveCount(0);
  const once = await folders(page);

  // a new launch: no look, no offer
  await page.reload();
  await expect(page.getByTestId("window")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(dialog(page)).toHaveCount(0);
  expect(await looks(page)).toBe(0);

  // by hand from History: web-app is a project now, so only shop-api is new; bringing it adds it once
  await page.getByTestId("menu-history").click();
  await page.getByTestId("history-import").click();
  await expect(dialog(page)).toHaveAttribute("data-step", "pick");
  await expect(row(page, WEB).getByTestId("imp-here")).toBeVisible();
  await expect(row(page, SITE).getByTestId("imp-here")).toBeVisible();
  await expect(dialog(page).getByTestId("imp-pick")).toHaveCount(1);
  await shot(page, "import-again-dark");
  await page.getByTestId("imp-all").click();
  await page.getByTestId("imp-next").click();
  await page.getByTestId("imp-go").click();
  await page.getByTestId("imp-ok").click();
  // and once more: nothing new is left to bring over
  await page.getByTestId("history-import").click();
  await expect(page.getByTestId("imp-nothing")).toContainText("Nothing new to bring over");
  await page.getByTestId("imp-close").click();
  const twice = await folders(page);
  expect(twice.added).toEqual([API, ...(once.added ?? [])]);
  expect(new Set(twice.added).size).toBe(twice.added?.length);
  expect(new Set(twice.order).size).toBe(twice.order?.length);
  expect(await record(page)).toEqual({ offered: true, folders: [API, WEB] });
});

test("Not now adds nothing, and the offer does not open by itself again", async ({ page }) => {
  await setup(page, "dark");
  await expect(dialog(page)).toHaveAttribute("data-step", "pick");
  await shot(page, "import-offer-dark");
  await row(page, WEB).getByTestId("imp-pick").check();
  await page.getByTestId("imp-not-now").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await folders(page)).added).toEqual([SITE]);
  expect(await record(page)).toEqual({ offered: true, folders: [] });
  await page.getByTestId("menu-history").click();
  await expect(page.locator('[data-testid="history-row"][data-kind="past"]')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("window")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(dialog(page)).toHaveCount(0);
});
