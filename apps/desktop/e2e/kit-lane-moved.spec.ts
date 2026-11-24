// "The main branch moved" on a lane's own row (src/code/MainMoved.tsx, Lanes.tsx; the design canvas's StatesCodeDev board): each
// lane records the branch it was made from (`lane.base`), which the shell's `session_main_moved` takes as `base`, so the note
// sits on the row of each lane whose own base moved, with Let Kit merge and Show me both working from the row. There is no shell
// in a browser, so the mock host answers what git would say for the canvas's project (src/code/mockMoved.ts), for the branch the
// folder has checked out (`__manutBranches`, which a lane's branch changes) against the base the page names. The lane runs as a
// chat, as the canvas's Code board draws it, so the spec starts it through the sessions store, as kit-lanes.spec.ts does.
// kit-preview-moved.spec.ts keeps the project's own note, for a folder no lane's row covers.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";

type Call = { op: string; id?: number; base?: string; show?: string[]; input?: { kind: string; text?: string } };
const calls = (page: Page) => page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? []));

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
const lane = (page: Page, id: string) => page.getByTestId(`lane-${id}`);

/** The branch the folder is on before a lane is made from it: the lane's base. */
async function startFrom(page: Page, base: string) {
  await page.addInitScript(([root, b]) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: b };
    (window as any).__manutMockTaken = [];
  }, [ROOT, base]);
  await page.goto("/");
}

test("main changed while Kit worked: the note is on the lane's own row, read for the branch the lane was made from, and not under the dial", async ({ page }) => {
  await startFrom(page, "main");
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  const note = lane(page, id).getByTestId("kit-moved");
  await expect(note.getByTestId("kit-moved-line")).toHaveText("main changed while Kit worked. 1 file needs both changes.");
  await expect(note.getByTestId("kit-moved-files")).toHaveText("src/checkout.tsx");
  await expect(note.getByTestId("kit-moved-merge")).toHaveText("Let Kit merge");
  await expect(note.getByTestId("kit-moved-show")).toHaveText("Show me both");
  // the project's own note stands down while a row covers the folder's branch: one note on the page, and none under the dial
  await expect(page.getByTestId("kit-moved")).toHaveCount(1);
  // read for the lane's own base, which the lane recorded when it was made
  await expect.poll(async () => (await calls(page)).some((c) => c.op === "main.moved" && c.base === "main")).toBe(true);
  expect((await calls(page)).filter((c) => c.op === "main.moved").every((c) => c.base === "main")).toBe(true);
});

test("a lane made from another branch is read for that branch, and says so", async ({ page }) => {
  await startFrom(page, "develop");
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  const note = lane(page, id).getByTestId("kit-moved");
  await expect(note.getByTestId("kit-moved-line")).toHaveText("develop changed while Kit worked. 1 file needs both changes.");
  await note.getByTestId("kit-moved-show").click();
  await expect(note.getByTestId("kit-moved-theirs")).toContainText("What develop changed");
  await expect.poll(async () => (await calls(page)).some((c) => c.op === "main.moved" && c.base === "develop")).toBe(true);
});

test("Show me both works from the row: the two sides of the file, read for the lane's base, shut again by the same button", async ({ page }) => {
  await startFrom(page, "main");
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  const note = lane(page, id).getByTestId("kit-moved");
  // nothing is read until it is asked for
  expect((await calls(page)).filter((c) => c.op === "main.moved").every((c) => (c.show ?? []).length === 0)).toBe(true);
  await note.getByTestId("kit-moved-show").click();
  await expect(note.getByTestId("kit-moved-show")).toHaveText("Hide both");
  await expect(note.getByTestId("kit-moved-pair")).toHaveCount(1);
  await expect(note.getByTestId("kit-moved-theirs")).toContainText("const total = order.items.reduce(sum, 0) + shipping(order);");
  await expect(note.getByTestId("kit-moved-ours")).toContainText("const qr = promptPayQR(SHOP_ID, total);");
  expect((await calls(page)).some((c) => c.op === "main.moved" && c.base === "main" && (c.show ?? []).includes("src/checkout.tsx"))).toBe(true);
  await note.getByTestId("kit-moved-show").click();
  await expect(note.getByTestId("kit-moved-both")).toHaveCount(0);
  await expect(note.getByTestId("kit-moved-show")).toHaveText("Show me both");
});

test("Let Kit merge goes to the lane of the row it was pressed on, not to the project's newest lane", async ({ page }) => {
  await startFrom(page, "main");
  // the first lane works while the second starts, so the second joins its branch: one checkout, two rows
  const a = await startIn(page, "Thai date format");
  await send(page, a, "/kit slow");
  const b = await startIn(page, "Fix stock sync with Shopee");
  await openCode(page);
  await expect(lane(page, a).getByTestId("lane-branch")).toHaveText("kit/thai-date-format");
  await expect(lane(page, b).getByTestId("lane-branch")).toHaveText("kit/thai-date-format");
  await expect(lane(page, a)).toHaveAttribute("data-status", "checked", { timeout: 10_000 });
  await expect(lane(page, a).getByTestId("kit-moved")).toBeVisible();
  await expect(lane(page, b).getByTestId("kit-moved")).toBeVisible();

  await lane(page, a).getByTestId("kit-moved-merge").click();
  // the ask is the first lane's own message, and the session opens in the main column
  await expect.poll(async () => (await calls(page)).some((c) => c.op === "chat.input" && (c.input?.text ?? "").includes("Merge main into kit/thai-date-format."))).toBe(true);
  const starts = (await calls(page)).filter((c) => c.op === "chat.start");
  const ask = (await calls(page)).find((c) => c.op === "chat.input" && (c.input?.text ?? "").includes("Merge main into kit/thai-date-format."))!;
  expect(starts).toHaveLength(2);
  expect(ask.id, "the first lane's chat, not the newest").toBe(starts[0].id);
  await expect(page.getByTestId("session-chat")).toContainText("Merge main into kit/thai-date-format.");
});

test("the note goes away from the row when main is where the lane left it", async ({ page }) => {
  await startFrom(page, "main");
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  await expect(lane(page, id).getByTestId("kit-moved")).toBeVisible();
  // the window is looked at again, and git has nothing to say
  await page.evaluate(() => {
    (window as any).__manutMoved = {};
    window.dispatchEvent(new Event("focus"));
  });
  await expect(lane(page, id).getByTestId("kit-moved")).toHaveCount(0);
  await expect(page.getByTestId("kit-moved")).toHaveCount(0);
});

test("the words on the row are in the person's language", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("manut.lang", "ko"));
  await startFrom(page, "main");
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  const note = lane(page, id).getByTestId("kit-moved");
  await expect(note.getByTestId("kit-moved-merge")).toHaveText("Kit이 병합하게 하기");
  await expect(note.getByTestId("kit-moved-show")).toHaveText("양쪽 다 보기");
});
