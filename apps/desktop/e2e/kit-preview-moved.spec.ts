// Two states of the Code page from the design canvas's StatesCodeDev board, in a browser (src/code/): "The main branch
// moved" (main changed while Kit worked: the file, Let Kit merge, Show me both) and "No secret in the preview" (a sample
// until the owner adds one). There is no shell in a browser, so the mock host answers what git would say for the canvas's
// project (src/code/mockMoved.ts), and the stand-in coding agent writes a change that reads the shop ID (`/kit shop`).
// The lane runs as a chat, as the canvas's Code board draws it. The spec starts it through the sessions store, as the + menu's
// Chat with Kit does (kit-lanes.spec.ts walks the menu itself).
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";

type Call = { op: string; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));
const sentTexts = async (page: Page) => (await calls(page)).filter((c) => c.op === "chat.input" && c.input?.kind === "send").map((c) => c.input?.text ?? "");

/** A Claude Code session in the project, running as a chat, started with `first`. */
async function startIn(page: Page, first: string): Promise<string> {
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
  await openCode(page);
});

test("main changed while Kit worked: the Code page names the file, and Show me both shows the two sides", async ({ page }) => {
  await startIn(page, "/kit test");
  await openCode(page);
  const moved = page.getByTestId("kit-moved");
  await expect(moved.getByTestId("kit-moved-line")).toHaveText("main changed while Kit worked. 1 file needs both changes.");
  await expect(moved.getByTestId("kit-moved-files")).toHaveText("src/checkout.tsx");
  await expect(moved.getByTestId("kit-moved-merge")).toHaveText("Let Kit merge");
  await expect(moved).toContainText("Kit can merge, and shows the result as a diff before anything is pushed.");
  // nothing is read until it is asked for
  expect((await calls(page)).filter((c) => c.op === "main.moved").every((c) => (c as unknown as { show: string[] }).show.length === 0)).toBe(true);
  await expect(moved.getByTestId("kit-moved-both")).toHaveCount(0);

  await moved.getByTestId("kit-moved-show").click();
  await expect(moved.getByTestId("kit-moved-show")).toHaveText("Hide both");
  await expect(moved.getByTestId("kit-moved-pair")).toHaveCount(1);
  await expect(moved.getByTestId("kit-moved-theirs")).toContainText("What main changed");
  await expect(moved.getByTestId("kit-moved-theirs")).toContainText("const total = order.items.reduce(sum, 0) + shipping(order);");
  await expect(moved.getByTestId("kit-moved-ours")).toContainText("What Kit changed");
  await expect(moved.getByTestId("kit-moved-ours")).toContainText("const qr = promptPayQR(SHOP_ID, total);");

  await moved.getByTestId("kit-moved-show").click();
  await expect(moved.getByTestId("kit-moved-both")).toHaveCount(0);
  await expect(moved.getByTestId("kit-moved-show")).toHaveText("Show me both");
});

test("Let Kit merge goes to Kit's lane as a message, and the merge Kit then runs asks through its own card", async ({ page }) => {
  const id = await startIn(page, "/kit test");
  await openCode(page);
  await page.getByTestId("kit-moved-merge").click();

  // the lane opens, and the ask is the developer's own message in it
  await expect.poll(async () => (await sentTexts(page)).some((t) => t.includes("Merge main into kit/promptpay-qr."))).toBe(true);
  const ask = (await sentTexts(page)).find((t) => t.includes("Merge main into kit/promptpay-qr."));
  expect(ask).toContain("main changed while you worked on kit/promptpay-qr.");
  expect(ask).toContain("This file changed on both sides: src/checkout.tsx.");
  expect(ask).toContain("show me the result as a diff");
  expect(ask).toContain("Do not push anything until I say so.");
  await expect(page.getByTestId("session-chat")).toContainText("Merge main into kit/promptpay-qr.");

  // nothing settled by itself: Kit's next step, the merge, is an ask like any other, and the card is the one way to answer it
  await send(page, id, "/kit merge");
  const card = page.getByTestId("card-approval");
  await expect(card.locator(".card-cmd")).toHaveText("git merge main");
  await expect(page.getByTestId("card-kit-say")).toHaveText("Changes files in the project.");
  await expect(card.locator("button")).toHaveText(["No", "Allow once", "Always allow in this project"]);
});

test("with no lane running as a chat, Let Kit merge opens a new session with the ask in its box and starts nothing", async ({ page }) => {
  // a session in its own terminal lists the project on the Code page, as the + menu does
  await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    s.startTerminal("claude", root);
  }, ROOT);
  await openCode(page);
  const before = (await calls(page)).filter((c) => c.op === "chat.start").length;
  await page.getByTestId("kit-moved-merge").click();

  await expect(page.getByTestId("composer")).toHaveValue(/Merge main into kit\/promptpay-qr\./);
  await expect(page.getByTestId("draft-note")).toBeVisible();
  expect((await calls(page)).filter((c) => c.op === "chat.start").length).toBe(before);
  expect(await sentTexts(page)).toEqual([]);
});

test("a project whose main has not moved under it says nothing, and the note goes away when it stops being true", async ({ page }) => {
  await startIn(page, "/kit test");
  await openCode(page);
  await expect(page.getByTestId("kit-moved")).toBeVisible();
  // main is where the lane left it: the window is looked at again, and git has nothing to say
  await page.evaluate(() => {
    (window as any).__manutMoved = {};
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.getByTestId("kit-moved")).toHaveCount(0);
});

test("a secret the code reads is a sample until the owner adds one, and Add the shop ID says the vault comes later", async ({ page }) => {
  await startIn(page, "/kit shop");
  await expect(page.getByText("The QR code reads the shop ID from PROMPTPAY_SHOP_ID.")).toBeVisible();
  await openCode(page);
  const row = page.getByTestId("kit-sample");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".tag")).toHaveText("Sample");
  await expect(row).toContainText("The preview has no shop ID yet, so the QR code is a sample.");
  await expect(row.getByTestId("kit-sample-add")).toHaveText("Add the shop ID");
  await expect(page.getByTestId("kit-sample-vault")).toHaveCount(0);

  await row.getByTestId("kit-sample-add").click();
  await expect(page.getByTestId("kit-sample-vault")).toContainText("The vault for a project's secrets comes later.");
  await expect(page.getByTestId("kit-sample-vault")).toContainText("a test payment can't reach your account");
  // only the name of the secret is ever on the page: not a value, not the sample
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain("0000000000");
});

test("the words are the person's language", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("manut.lang", "ko"));
  await page.reload();
  await openCode(page);
  await startIn(page, "/kit shop");
  await openCode(page);
  await expect(page.getByTestId("kit-moved-merge")).toHaveText("Kit이 병합하게 하기");
  await expect(page.getByTestId("kit-moved-show")).toHaveText("양쪽 다 보기");
  await expect(page.getByTestId("kit-sample-add")).toHaveText("가게 ID 추가");
});
