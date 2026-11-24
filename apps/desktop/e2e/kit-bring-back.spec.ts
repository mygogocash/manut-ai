// Bring it back (src/code/BringBack.tsx, the design canvas's StatesCode "Reverted"), walked in a browser: Rewind to before a
// turn puts the files and the chat back, the lane says Reverted, and Bring it back puts the files back as they were just before
// the rewind while the chat stays where the rewind left it. The stand-in coding agent (src/sessions/host.ts) writes one note for
// each turn into a pretend folder (src/sessions/turnFiles.ts), which the spec changes as the person would by hand
// (`__manutMockFolders`). The lane runs as a chat, as the canvas's Code board draws it; the + menu starts agents in their own
// terminal only (docs/code-editor.md), so the spec starts it through the sessions store, as kit-lanes.spec.ts does.
import { expect, test, type Page } from "@playwright/test";
import { openCode } from "./start";

const ROOT = "/home/you/code/baanmali-preorder";

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

/** The session fills the main column, as a notification would open it: the Code page lists only terminals. */
const openSession = (page: Page, id: string) =>
  page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
const send = (page: Page, id: string, text: string) => page.evaluate(([i, t]) => (window as any).__manutSessions.send(i, t), [id, text]);
const lane = (page: Page, id: string) => page.getByTestId(`lane-${id}`);
/** The folder the lane works in: its own (a worktree of the project), where the stand-in keeps the lane's files. */
const LANE = "/home/you/.manut/lanes/baanmali-preorder/add-promptpay-qr-checkout";
/** The pretend folder the stand-in keeps the lane's files in. */
const files = (page: Page) => page.evaluate((dir) => Object.keys((window as any).__manutMockFolders[dir]).sort(), LANE);
/** The person changes the pretend folder by hand, as an editor would. */
const byHand = (page: Page, path: string, text: string) => page.evaluate(([dir, p, t]) => ((window as any).__manutMockFolders[dir][p] = t), [LANE, path, text]);

/** Two turns, the second ending in a test run, then Rewind to before it through the panel under the box. Leaves the Code page open.
 *  The lane's state is read from its `data-status`, so this holds in any language. */
async function rewound(page: Page): Promise<string> {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await openCode(page);
  await expect(lane(page, id)).toHaveAttribute("data-status", "not_run");
  await send(page, id, "/kit pass");
  await expect(lane(page, id)).toHaveAttribute("data-status", "checked");
  await openSession(page, id);
  await page.getByTestId("rewind-open").click();
  // the newest turn is picked first: its note is the one file that goes back
  await expect(page.getByTestId("rewind-count")).toBeVisible();
  await page.getByTestId("rewind-go").click();
  await expect(page.getByTestId("rewind-panel")).toHaveCount(0);
  await openCode(page);
  await expect(lane(page, id)).toHaveAttribute("data-status", "reverted");
  return id;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutMockTaken = [];
  }, ROOT);
  await page.goto("/");
});

test("a rewound lane offers Bring it back, which puts the files back and says the chat stays where the rewind left it", async ({ page }) => {
  const id = await rewound(page);
  const row = lane(page, id);
  await expect(row.getByTestId("lane-line")).toContainText("The files are back as they were.");
  await expect(row.getByTestId("lane-back")).toHaveText("Bring it back");
  // the rewind took the turn's note away
  expect(await files(page)).toEqual(["README.md", "notes/turn-1.md", "src/checkout.tsx"]);

  await row.getByTestId("lane-back").click();
  const panel = row.getByTestId("bring-back");
  await expect(panel.getByTestId("bring-back-count")).toHaveText("1 file goes back as it was just before the rewind.");
  // said whatever else is in the panel: the files come back, the chat does not
  await expect(panel.getByTestId("bring-back-chat")).toHaveText("The chat stays where the rewind left it. Kit will not remember the turns you rewound.");
  await expect(panel.getByTestId("bring-back-hand")).toHaveCount(0);
  // nothing is written until the person presses
  expect(await files(page)).toEqual(["README.md", "notes/turn-1.md", "src/checkout.tsx"]);

  await panel.getByTestId("bring-back-go").click();
  await expect(row.getByTestId("bring-back")).toHaveCount(0);
  expect(await files(page)).toEqual(["README.md", "notes/turn-1.md", "notes/turn-2.md", "src/checkout.tsx"]);
  // the lane reads by its tests again, and says the chat did not come back; there is nothing more to bring back
  await expect(row.getByTestId("lane-state")).toHaveText("Not run yet");
  await expect(row.getByTestId("lane-line")).toHaveText(/^You brought the files back at \d{1,2}:\d{2}\. The chat stays where the rewind left it\.$/);
  await expect(row.getByTestId("lane-back")).toHaveCount(0);

  // the chat is where the rewind left it: the message the rewind took back did not come back, and a line says what did
  await openSession(page, id);
  await expect(page.getByTestId("session-chat")).toContainText("1 file is back as it was just before the rewind. The chat stays where the rewind left it.");
  await expect(page.getByTestId("bubble-user").filter({ hasText: "pass" })).toHaveCount(0);
});

test("a file changed by hand since the rewind is listed and kept unless unticked", async ({ page }) => {
  for (const untick of [false, true]) {
    await page.goto("/");
    const id = await rewound(page);
    const row = lane(page, id);
    await byHand(page, "mine.txt", "a note of mine\n");
    await row.getByTestId("lane-back").click();
    const panel = row.getByTestId("bring-back");
    await expect(panel.getByTestId("bring-back-hand")).toContainText("Changed by hand since the rewind. A ticked file stays as it is now.");
    const box = panel.getByTestId("bring-back-keep");
    await expect(box).toHaveCount(1);
    await expect(panel.getByTestId("bring-back-hand")).toContainText("mine.txt");
    // ticked at first: it stays as it is unless the person says otherwise, so only the turn's note goes back
    await expect(box).toBeChecked();
    await expect(panel.getByTestId("bring-back-count")).toHaveText("1 file goes back as it was just before the rewind.");
    if (untick) {
      await box.uncheck();
      await expect(panel.getByTestId("bring-back-count")).toHaveText("2 files go back as they were just before the rewind.");
    }
    await panel.getByTestId("bring-back-go").click();
    await expect(row.getByTestId("bring-back")).toHaveCount(0);
    expect(await files(page), untick ? "unticked: the file goes with the rest" : "ticked: it stays").toEqual(untick ? ["README.md", "notes/turn-1.md", "notes/turn-2.md", "src/checkout.tsx"] : ["README.md", "mine.txt", "notes/turn-1.md", "notes/turn-2.md", "src/checkout.tsx"]);
  }
});

test("Not now shuts the panel and writes nothing, and the link opens it again", async ({ page }) => {
  const id = await rewound(page);
  const row = lane(page, id);
  await row.getByTestId("lane-back").click();
  await expect(row.getByTestId("bring-back")).toBeVisible();
  await expect(row.getByTestId("lane-back")).toHaveAttribute("aria-expanded", "true");
  await row.getByTestId("bring-back-close").click();
  await expect(row.getByTestId("bring-back")).toHaveCount(0);
  await expect(row.getByTestId("lane-back")).toHaveAttribute("aria-expanded", "false");
  expect(await files(page)).toEqual(["README.md", "notes/turn-1.md", "src/checkout.tsx"]);
  // the same link shuts it too
  await row.getByTestId("lane-back").click();
  await expect(row.getByTestId("bring-back")).toBeVisible();
  await row.getByTestId("lane-back").click();
  await expect(row.getByTestId("bring-back")).toHaveCount(0);
});

test("Bring it back goes when the next turn starts, and its files are not offered again", async ({ page }) => {
  const id = await rewound(page);
  const row = lane(page, id);
  await row.getByTestId("lane-back").click();
  await expect(row.getByTestId("bring-back")).toBeVisible();
  // a turn starts, with the panel open: the lane is at work, and the panel and its link are gone
  await send(page, id, "/kit slow");
  await expect(row.getByTestId("lane-state")).toContainText("Running tests");
  await expect(row.getByTestId("lane-back")).toHaveCount(0);
  await expect(row.getByTestId("bring-back")).toHaveCount(0);
  await expect(row.getByTestId("lane-state")).toHaveText("Checked", { timeout: 10_000 });
  expect(await files(page)).not.toContain("notes/turn-2.md");
});

test("the agent's own rewind of the last message leaves the files where they are, and offers nothing to bring back", async ({ page }) => {
  const id = await startIn(page, "Add a PromptPay QR to the checkout.");
  await send(page, id, "/kit pass");
  await openCode(page);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Checked");
  await page.evaluate((i) => (window as any).__manutSessions.rewind(i), id);
  await expect(lane(page, id).getByTestId("lane-state")).toHaveText("Reverted");
  await expect(lane(page, id).getByTestId("lane-line")).toContainText("The files stay as they are.");
  await expect(lane(page, id).getByTestId("lane-back")).toHaveCount(0);
});

test("the words are in the person's language", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("manut.lang", "ko"));
  await page.reload();
  const id = await rewound(page);
  const row = lane(page, id);
  await expect(row.getByTestId("lane-back")).toHaveText("되살리기");
  await row.getByTestId("lane-back").click();
  await expect(row.getByTestId("bring-back-chat")).toContainText("채팅은 되감기가 남긴 자리에 그대로 있어요.");
  await row.getByTestId("bring-back-go").click();
  await expect(row.getByTestId("lane-line")).toContainText("채팅은 되감기가 남긴 자리에 그대로 있어요.");
});
