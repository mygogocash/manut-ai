// Kit on the Code page and on a coding session's asks (src/code/, the design canvas's StatesCodeDev board): the
// stand-in coding agent asks for each of Kit's steps when told `/kit <step>` (src/sessions/host.ts), in a session
// started in the canvas's project. What Kit's dial settles by itself still shows in the chat, settled. The session
// runs as a chat, as the canvas's Code board draws Kit's lane. The spec starts it through the sessions store, as the + menu's
// Chat with Kit does (kit-lanes.spec.ts walks the menu itself).
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";

/** A Claude Code session in the project, started with `first`, its view open. */
async function startIn(page: Page, first: string): Promise<string> {
  await openCode(page);
  return page.evaluate(
    async ([root, text]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft("claude");
      s.setDraft(id, { cwd: root });
      await s.start(id, text);
      return id as string;
    },
    [ROOT, first],
  );
}

const send = (page: Page, id: string, text: string) => page.evaluate(([i, t]) => (window as any).__manutSessions.send(i, t), [id, text]);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("manut.kit.projects"));
  await page.goto("/");
});

test("Kit asks before an install, says what it does, and Always allow lets the next one run alone", async ({ page }) => {
  const id = await startIn(page, "/kit install");
  const card = page.getByTestId("card-approval");
  await expect(card.locator(".card-cmd")).toHaveText("pnpm add qrcode");
  await expect(page.getByTestId("card-kit-say")).toHaveText("Adds 1 package to the project.");
  await expect(card.locator("button")).toHaveText(["No", "Allow once", "Always allow in this project"]);
  await card.locator('[data-choice="always"]').click();
  await expect(page.getByTestId("card-line").last()).toContainText("Allowed once");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("manut.kit.projects") ?? "{}"))).toMatchObject({ [ROOT]: { rules: [{ words: ["pnpm", "add"] }] } });

  await send(page, id, "/kit install");
  await expect(page.getByTestId("card-line").last()).toContainText("Kit did it alone · always allowed in this project");
  await send(page, id, "/kit test");
  await expect(page.getByTestId("card-line").last()).toContainText("Kit did it alone · it changes nothing");
});

test("a read outside the project is stopped, shown on the Code page, and its folder can be allowed", async ({ page }) => {
  const id = await startIn(page, "/kit test");
  await expect(page.getByTestId("card-line").last()).toContainText("Kit did it alone");
  await send(page, id, "/kit outside");
  await expect(page.getByTestId("card-line").last()).toContainText("Blocked: outside baanmali-preorder");

  await openCode(page);
  const panel = page.getByTestId("kit-panel");
  await expect(panel.getByTestId("kit-blocked")).toContainText("Kit tried to read a file outside baanmali-preorder. It was stopped.");
  await expect(panel.getByTestId("kit-blocked")).toContainText("/home/you/Documents/tax-2026.xlsx");
  await panel.getByTestId("kit-allow-folder").click();
  await expect(panel.getByTestId("kit-blocked")).toHaveCount(0);
  await expect(panel.getByTestId("kit-folder")).toContainText("~/Documents");
});

test("the dial's level changes what Kit does alone, and going live still asks", async ({ page }) => {
  const id = await startIn(page, "/kit edit");
  await expect(page.getByTestId("card-kit-say")).toHaveText("Changes src/checkout.tsx.");
  await page.getByTestId("card-approval").locator('[data-choice="deny"]').click();

  await openCode(page);
  await expect(page.getByTestId("kit-level-asks_every_time")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("kit-level-everything_in_project").click();
  await expect(page.getByTestId("kit-line")).toHaveText("Kit edits, installs, deletes and pushes its own branch alone, inside this project. Anything outside it is stopped.");
  await expect(page.getByTestId("kit-panel")).toContainText("Going live always asks, at every level.");

  // open the session as a notification would (its row is in the Lanes band, which kit-lanes.spec.ts walks)
  await page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
  await send(page, id, "/kit edit");
  await expect(page.getByTestId("card-line").last()).toContainText("Kit did it alone · Everything in this project");
  await send(page, id, "/kit deploy");
  await expect(page.getByTestId("card-kit-say")).toHaveText("Puts it live. Customers can see it.");
  await expect(page.getByTestId("card-approval").locator("button")).toHaveText(["No", "Allow once"]);
});

test("a script run by its name shows what the script runs, from the lane's package.json", async ({ page }) => {
  await startIn(page, "/kit build");
  await expect(page.getByTestId("card-kit-say")).toHaveText("Builds the project.");
  await expect(page.getByTestId("card-kit-script")).toHaveText("The build script runs: vite build");
});

test("a key typed into the code is never shown, and a commit then asks with the file named", async ({ page }) => {
  const id = await startIn(page, "/kit key");
  await expect(page.getByText("I put the PromptPay key in src/config.ts.")).toBeVisible();
  await send(page, id, "/kit commit");
  await expect(page.getByTestId("card-kit-key")).toHaveText("This change holds a key (src/config.ts). Move it out before it is saved.");
  await expect(page.getByTestId("card-approval").locator("button")).toHaveText(["No", "Allow once"]);
  expect(await page.evaluate(() => document.body.innerText.includes("sk-FAKE0000000000000000TEST"))).toBe(false);

  await openCode(page);
  await expect(page.getByTestId("kit-key")).toContainText("A key was typed into src/config.ts.");
});
