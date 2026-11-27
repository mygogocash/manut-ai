// Other programs reach chats (item 103, docs/mcp-threads.md), with the shell stood in for by `window.__manutThreadsMcp` as the
// snapshot key's is: Settings › MCP and Skills › Other programs is off until it is turned on, then lists the chats added from
// item 97's picker and gives the address to copy; a program waiting to be let in is a card over whatever is showing, answered
// once by the person's press; list_chats answers with the list alone; a card whose call is gone answers nothing; and a read is
// refused until its slice is built.
import { expect, test, type Page } from "@playwright/test";
import { chatOpen, startDone } from "./start";

interface Reply {
  id: string;
  text: string;
  error: boolean;
}

const CLAUDE = { name: "Claude", path: "/Applications/Claude.app/Contents/MacOS/Claude", callsItself: "Claude 1.0" };
const ROOT = "/home/you/code/baanmali-preorder";

/** A lane in the project on `agent`, started through the sessions store as the + menu's Chat with Kit does (as reach-chats.spec). */
async function lane(page: Page, agent: string, first: string): Promise<string> {
  return page.evaluate(
    async ([root, a, f]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft(a);
      s.setDraft(id, { cwd: root });
      await s.start(id, f);
      return id as string;
    },
    [ROOT, agent, first] as const,
  );
}

/** The shell hands the page a call, once the page listens. */
async function call(page: Page, id: string, tool: string, args: Record<string, unknown> = {}): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as { __manutThreadsMcp?: { call?: unknown } }).__manutThreadsMcp?.call);
  await page.evaluate(
    ([id, tool, args, program]) => (window as unknown as { __manutThreadsMcp: { call(c: unknown): void } }).__manutThreadsMcp.call({ id, tool, args, program }),
    [id, tool, args, CLAUDE] as const,
  );
}

const gone = (page: Page, id: string) => page.evaluate((id) => (window as unknown as { __manutThreadsMcp: { gone(id: string): void } }).__manutThreadsMcp.gone(id), id);
const replies = (page: Page): Promise<Reply[]> => page.evaluate(() => (window as unknown as { __manutThreadsMcp: { replies: Reply[] } }).__manutThreadsMcp.replies);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    (window as unknown as { __manutThreadsMcpMock: boolean }).__manutThreadsMcpMock = true;
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
  }, ROOT);
  await page.goto("/");
  await chatOpen(page);
  await startDone(page);
});

test("Settings lists the chats other programs may reach, off until it is turned on, with the address to copy", async ({ page }) => {
  await lane(page, "codex", "Print the receipt in Thai");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-mcp").click();
  const section = page.getByTestId("tm-settings");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("tm-list")).toHaveCount(0);
  await section.getByTestId("tm-switch").getByRole("radio", { name: "On" }).click();
  await expect(section.getByTestId("tm-claude")).toContainText("claude mcp add manut-threads -- '/Applications/Manut AI.app/Contents/MacOS/manut' '--threads-mcp'");
  await expect(section.getByTestId("tm-json")).toContainText('"manut-threads"');
  await section.getByTestId("tm-add").click();
  await page.getByTestId("bring-option").filter({ hasText: "Print the receipt in Thai" }).click();
  await expect(section.getByTestId("tm-chip")).toHaveCount(1);
  await expect(section.getByTestId("tm-chip").first()).toHaveAttribute("data-n", "1");
  // a program the person lets in sees that chat, by its number, and nothing else
  await call(page, "tm-1", "let_in");
  await page.getByTestId("tm-card").getByTestId("tm-yes").click();
  await call(page, "tm-2", "list_chats");
  await expect.poll(async () => (await replies(page)).length).toBe(2);
  expect((await replies(page))[1].text.split("\n")[0]).toMatch(/^1\. Print the receipt in Thai \(Codex, (working|idle|waiting on the person)\)$/);
  // the list is kept on this Mac: a reload reads it back (the stand-in shell's switch is not kept, as the shell's file is)
  await page.reload();
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-mcp").click();
  await page.getByTestId("tm-switch").getByRole("radio", { name: "On" }).click();
  await expect(page.getByTestId("tm-chip")).toHaveCount(1);
  await page.getByTestId("tm-remove").click();
  await expect(page.getByTestId("tm-chip")).toHaveCount(0);
});

test("a program waiting to be let in is a card over whatever shows, answered once, and then lists only the listed chats", async ({ page }) => {
  await call(page, "tm-1", "let_in");
  const card = page.getByTestId("tm-card");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Claude wants to reach the chats you listed");
  await expect(card.getByTestId("tm-path")).toHaveText(CLAUDE.path);
  await expect(card).toContainText("It calls itself “Claude 1.0”.");
  expect(await replies(page)).toEqual([]);
  await card.getByTestId("tm-yes").click();
  await expect(card).toHaveCount(0);
  expect(await replies(page)).toEqual([{ id: "tm-1", text: "", error: false }]);
  // nothing listed yet: list_chats says where to list chats, and names none
  await call(page, "tm-2", "list_chats");
  await expect.poll(async () => (await replies(page)).length).toBe(2);
  const listed = (await replies(page))[1];
  expect(listed.error).toBe(false);
  expect(listed.text).toContain("has not listed any chats for other programs");
  // a read is refused, plainly, until its slice is built
  await call(page, "tm-3", "read_chat", { chat: 1 });
  await expect.poll(async () => (await replies(page)).length).toBe(3);
  expect((await replies(page))[2]).toMatchObject({ id: "tm-3", error: true });
});

test("a program refused, and one whose call is gone, are answered once or not at all", async ({ page }) => {
  await call(page, "tm-4", "let_in");
  await page.getByTestId("tm-card").getByTestId("tm-no").click();
  await expect(page.getByTestId("tm-card")).toHaveCount(0);
  expect(await replies(page)).toEqual([{ id: "tm-4", text: "", error: true }]);
  await call(page, "tm-5", "let_in");
  await gone(page, "tm-5");
  const card = page.getByTestId("tm-card");
  await expect(card).toContainText("No longer open");
  await expect(card.getByTestId("tm-yes")).toHaveCount(0);
  await card.getByTestId("tm-dismiss").click();
  await expect(card).toHaveCount(0);
  expect(await replies(page)).toEqual([{ id: "tm-4", text: "", error: true }]);
});
