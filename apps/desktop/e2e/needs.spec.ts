// Needs you: approvals and questions from bots you are not looking at. The side menu's Needs you row counts them,
// Team marks who waits, and the Needs you page (the sidebar's old strip made a page) lists them and jumps to the card;
// 1/2/3 on a focused approval card only, a 3-question interview answered with one clarify.respond, and a timeout
// clears the count. The bot rows' amber dot, preview and menu left with the sidebar.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { chatOpen, openChat, startDone } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
// Screenshots stay out of the repo (NEEDS_SHOTS dir, else Playwright's ignored test-results).
const SHOTS = process.env.NEEDS_SHOTS || "test-results";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "n1") res(msg);
    };
    ws.send(JSON.stringify({ id: "n1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

const calls = async (op: string) => (await mock("mock.calls")).calls.filter((c: any) => c.op === op);
const mod = async (page: Page) => ((await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control");

async function open(page: Page, theme: "dark" | "light" = "dark") {
  await page.emulateMedia({ colorScheme: theme });
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
  // every other bot's chat is loaded too, so its asks count
  await startDone(page);
}

test.beforeEach(async ({ page }) => {
  await mock("mock.reset");
  // start each test with nothing pinned and all four bots listed (once per tab, so a reload keeps what the test set)
  await page.addInitScript(() => {
    if (sessionStorage.getItem("needs-e2e")) return;
    sessionStorage.setItem("needs-e2e", "1");
    localStorage.removeItem("manut.pinned");
    localStorage.setItem("manut.roster", JSON.stringify(["kami", "friren", "default", "omh-tui"]));
  });
});

test("asks on bots you are not looking at: the menu counts them, Needs you lists them, a row jumps and focuses the card", async ({ page }) => {
  await open(page);
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  await mock("mock.ask", { bot: "default", kind: "clarify" });
  // a count on the menu's Needs you row, and Team marks both members as waiting on you
  await expect(page.getByTestId("menu-needs-count")).toHaveText("2");
  await page.getByTestId("menu-team").click();
  await expect(page.getByTestId("team-friren")).toContainText("Needs you");
  await expect(page.getByTestId("team-default")).toContainText("Needs you");
  await expect(page.getByTestId("team-kami")).not.toContainText("Needs you");

  // the page lists each ask with who asks and which kind; asks of the same second keep no fixed order, so the rows
  // are found by who asks
  await page.getByTestId("menu-needs").click();
  const items = page.getByTestId("needs-row");
  await expect(items).toHaveCount(2);
  const friren = items.filter({ hasText: "Friren" });
  const hermes = items.filter({ hasText: "Hermes" });
  // the ask in its card's words, with the exact action under it set as code, not with raw backticks
  await expect(friren.locator(".l1")).toHaveText("Run shell command");
  await expect(friren.locator("code.act")).toHaveText("rm -rf build/");
  // the tag names what waits, a noun, since item 85i: "Approval", where the button beside it says "Approve"
  await expect(friren.locator(".tag")).toHaveText("Approval");
  await expect(hermes.locator(".l1")).toHaveText("Which environment should I deploy to?");
  await expect(hermes.locator(".tag")).toHaveText("Question");
  await page.screenshot({ path: join(SHOTS, "T12-needs-dark.png"), animations: "disabled" });

  await friren.getByTestId("needs-open").click();
  await chatOpen(page, "friren");
  const card = page.getByTestId("timeline").getByTestId("card-approval");
  await expect(card).toBeFocused();
  await expect(card).toBeInViewport();

  // ⌘J goes to the next ask (Hermes' question), then wraps back
  const key = await mod(page);
  await page.keyboard.press(`${key}+j`);
  await chatOpen(page, "default");
  await expect(page.getByTestId("timeline").getByTestId("card-clarify")).toBeFocused();
  await page.keyboard.press(`${key}+j`);
  await chatOpen(page, "friren");
  await expect(page.getByTestId("timeline").getByTestId("card-approval")).toBeFocused();
});

test("a command in the row preview never breaks across lines: one line box, whole or ellipsized as one", async ({ page }) => {
  test.skip(true, "the bot row's one-line preview left with the sidebar; the Needs you page shows the ask on a full-width row");
  await open(page);
  const ask = (request_id: string, command: string) =>
    mock("mock.emit", { events: [{ event: "approval.request", bot: "friren", request_id, title: "Run shell command", command, choices: ["once", "deny"] }] });
  const sub = page.getByTestId("bot-friren").getByTestId("bot-sub");
  const geo = () =>
    sub.evaluate((el) => {
      const code = el.querySelector("code")!;
      return {
        rects: code.getClientRects().length,
        ws: getComputedStyle(code).whiteSpace,
        clipped: el.scrollHeight > el.clientHeight + 1,
        whole: code.scrollWidth <= code.clientWidth + 1,
        inside: code.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5,
      };
    });
  // `git status --short` used to split at "--": two line rects that read as two commands
  await ask("approval-wrap-1", "git status --short");
  await expect(sub).toHaveText("Allow git status --short?");
  expect(await geo()).toEqual({ rects: 1, ws: "nowrap", clipped: false, whole: true, inside: true });
  // longer than the row: still one line box, ellipsized inside the row
  await ask("approval-wrap-2", "git log --oneline --decorate --graph --all --since=two.weeks.ago -- apps/desktop/src/sidebar");
  await expect(sub).toContainText("git log --oneline");
  const long = await geo();
  expect(long.rects).toBe(1);
  expect(long.whole).toBe(false);
  expect(long.inside).toBe(true);
  expect(await sub.locator("code").evaluate((e) => getComputedStyle(e).textOverflow)).toBe("ellipsis");
});

test("1/2/3 answer an approval only while its card has focus", async ({ page }) => {
  await open(page);
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  await openChat(page, "friren");
  const card = page.getByTestId("timeline").getByTestId("card-approval");
  await expect(card).toBeVisible();

  // typing 1/2/3 in the composer just types
  const composer = page.getByTestId("composer");
  await composer.focus();
  await page.keyboard.type("123");
  await expect(composer).toHaveValue("123");
  await composer.fill("");
  // nor do they act with the focus on the page body
  await page.getByTestId("timeline").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("2");
  await page.waitForTimeout(300);
  expect(await calls("approval.respond")).toEqual([]);
  await expect(card).toBeVisible();

  // focused: 2 = Allow once
  await card.focus();
  await page.screenshot({ path: join(SHOTS, "T12-card-focused-dark.png"), animations: "disabled" });
  await page.keyboard.press("2");
  await expect(page.getByTestId("timeline").getByTestId("card-line")).toHaveText(/Allowed once/);
  expect(await calls("approval.respond")).toEqual([
    expect.objectContaining({ params: expect.objectContaining({ bot: "friren", choice: "once" }) }),
  ]);
  await expect(page.getByTestId("menu-needs-count")).toHaveCount(0);
});

test("interview: three questions in one card, answers go back in one clarify.respond (skips allowed)", async ({ page }) => {
  await open(page);
  await mock("mock.ask", { bot: "friren", kind: "interview" });
  await page.getByTestId("menu-needs").click();
  const row = page.getByTestId("needs-row");
  await expect(row.locator(".l1")).toHaveText(/^3 questions: Who is the release note for\?/);
  await row.click();

  const card = page.getByTestId("timeline").getByTestId("card-interview");
  await expect(card).toBeFocused();
  await expect(card.getByTestId("iv-question")).toHaveCount(3);
  await expect(card.getByTestId("iv-count")).toHaveText("0 of 3 answered · 3 will be skipped");

  // 1: single choice; picking another replaces it
  const q1 = card.getByRole("radiogroup", { name: "Who is the release note for?" });
  await q1.getByRole("radio", { name: "Users" }).click();
  await q1.getByRole("radio", { name: "Both" }).click();
  await expect(q1.getByRole("radio", { name: "Both" })).toHaveAttribute("aria-checked", "true");
  await expect(q1.getByRole("radio", { name: "Users" })).toHaveAttribute("aria-checked", "false");
  // Other… is a chip like the rest (not dimmed) and opens a field as wide as the chip row; empty, it folds back
  const other1 = q1.getByRole("button", { name: "Other…" });
  const chipColor = await q1.getByRole("radio", { name: "Users" }).evaluate((el) => getComputedStyle(el).color);
  expect(await other1.evaluate((el) => getComputedStyle(el).color)).toBe(chipColor);
  await other1.click();
  await expect(other1).toHaveAttribute("aria-expanded", "true");
  const field1 = q1.getByLabel("Other answer 1");
  await expect(field1).toBeFocused();
  // same left edge as the first chip, same right edge as the chip row
  const q1Box = (await q1.boundingBox())!;
  const chip1 = (await q1.getByRole("radio", { name: "Users" }).boundingBox())!;
  const f1 = (await field1.boundingBox())!;
  expect(Math.abs(f1.x - chip1.x)).toBeLessThan(2);
  expect(Math.abs(f1.x + f1.width - (q1Box.x + q1Box.width))).toBeLessThan(2);
  await field1.blur();
  await expect(field1).toHaveCount(0);
  await expect(other1).toHaveAttribute("aria-expanded", "false");
  // 2: multi-select plus an Other text (the same chip, then the field)
  const q2 = card.getByRole("group", { name: "Which sections should it have?" });
  await q2.getByRole("checkbox", { name: "Highlights" }).click();
  await q2.getByRole("checkbox", { name: "Fixes" }).click();
  await q2.getByRole("button", { name: "Other…" }).click();
  await q2.getByLabel("Other answer 2").fill("Upgrade notes");
  await expect(q2.getByRole("button", { name: "Other…" })).toBeVisible();
  // 3: the free-text field lines up with the chip rows (same left and right edge)
  const q2Box = (await q2.boundingBox())!;
  const chip2 = (await q2.getByRole("checkbox", { name: "Highlights" }).boundingBox())!;
  const in3 = (await card.getByLabel("Answer 3").boundingBox())!;
  expect(Math.abs(in3.x - chip2.x)).toBeLessThan(2);
  expect(Math.abs(in3.x + in3.width - (q2Box.x + q2Box.width))).toBeLessThan(2);
  // while the ask is open the composer points at it
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "Answer above, or type to reply");
  // 3: left blank -> skipped
  await expect(card.getByTestId("iv-count")).toHaveText("2 of 3 answered · 1 will be skipped");
  // Other… with text is selected like its siblings
  await expect(q2.getByRole("button", { name: "Other…" })).toHaveClass(/\bon\b/);

  // selected chips are gray, never the brand gradient
  const on = q1.getByRole("radio", { name: "Both" });
  expect(await on.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  const [r, g, b] = ((await on.evaluate((el) => getComputedStyle(el).backgroundColor)).match(/[\d.]+/g) ?? []).map(Number);
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(24);
  // Submit is the app's neutral primary (ink fill), not a gray chip and never the accent gradient
  const submit = card.getByRole("button", { name: "Submit" });
  const sub = await submit.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, img: cs.backgroundImage };
  });
  expect(sub.img).toBe("none");
  const [sr, sg, sb] = (sub.bg.match(/[\d.]+/g) ?? []).map(Number);
  expect(Math.min(sr, sg, sb)).toBeGreaterThan(200); // dark theme: light ink fill
  // meta text uses the readable secondary colour, not the faint one
  const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
  expect(await card.getByTestId("iv-count").evaluate((el) => getComputedStyle(el).color)).toBe(
    await page.evaluate((c) => {
      const d = document.createElement("span");
      d.style.color = c;
      document.body.append(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, muted),
  );
  await card.locator(".card-title").click(); // the shot shows the fields at rest, not one mid-typing
  await page.screenshot({ path: join(SHOTS, "T12-interview-dark.png"), animations: "disabled" });

  await submit.click();
  await expect(page.getByTestId("timeline").getByTestId("card-line")).toHaveText(/Answered: 2 of 3/);
  const responds = await calls("clarify.respond");
  expect(responds).toHaveLength(1);
  expect(responds[0].params).toEqual({
    bot: "friren",
    request_id: expect.stringMatching(/^interview-/),
    answers: { q1: "Both", q2: JSON.stringify(["Highlights", "Fixes", "Upgrade notes"]), q3: null },
  });
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "Got it, using 2 of 3 answers." })).toBeVisible();
  await expect(page.getByTestId("menu-needs-count")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toHaveAttribute("placeholder", "Message Friren");
});

test("a timed-out ask shows Timed out and the count clears", async ({ page }) => {
  await open(page);
  await mock("mock.ask", { bot: "friren", kind: "approval", timeout_ms: 1500 });
  const count = page.getByTestId("menu-needs-count");
  await expect(count).toHaveText("1");
  await expect(count).toHaveCount(0, { timeout: 6_000 });
  await openChat(page, "friren");
  await expect(page.getByTestId("timeline").getByTestId("card-line")).toHaveText(/Timed out/);
  await expect(page.getByTestId("timeline").getByTestId("card-approval")).toHaveCount(0);
  expect(await calls("approval.respond")).toEqual([]);
});

test("Team's menu: Pin to top moves a member to the top and marks them, Unpin puts them back, and the pin survives a reload", async ({ page }) => {
  // The sidebar's row menu also had Edit bot, Remove from list and the + to add a bot back. Those left with the
  // sidebar and Team's menu has none of them, so only the pin is tested (the old test also pressed ⌘1 after pinning;
  // that is not carried over).
  await open(page);
  await page.getByTestId("menu-team").click();
  const order = () => page.locator('[data-testid^="team-row-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  await expect.poll(order).toEqual(["team-row-kami", "team-row-friren", "team-row-default", "team-row-omh-tui"]);
  await expect(page.locator('[data-testid^="team-pinned-"]')).toHaveCount(0);

  await page.getByTestId("team-more-default").click();
  await expect(page.getByTestId("team-menu-default").getByRole("menuitem")).toHaveText([/^New thread · /, "Pin to top", "Restart"]);
  await page.getByTestId("team-menu-pin-default").click();
  await expect.poll(order).toEqual(["team-row-default", "team-row-kami", "team-row-friren", "team-row-omh-tui"]);
  await expect(page.getByTestId("team-pinned-default")).toBeVisible();

  // kept on this computer: the pin is there after a reload
  await page.reload();
  await startDone(page);
  await page.getByTestId("menu-team").click();
  await expect.poll(order).toEqual(["team-row-default", "team-row-kami", "team-row-friren", "team-row-omh-tui"]);
  await expect(page.getByTestId("team-pinned-default")).toBeVisible();

  // the menu now offers Unpin, and the member goes back to where the list put them
  await page.getByTestId("team-more-default").click();
  await expect(page.getByTestId("team-menu-unpin-default")).toHaveText("Unpin");
  await page.getByTestId("team-menu-unpin-default").click();
  await expect.poll(order).toEqual(["team-row-kami", "team-row-friren", "team-row-default", "team-row-omh-tui"]);
  await expect(page.getByTestId("team-pinned-default")).toHaveCount(0);
});

test("light theme: the Needs you page and the interview stay readable", async ({ page }) => {
  await open(page, "light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await mock("mock.ask", { bot: "friren", kind: "interview" });
  await mock("mock.ask", { bot: "default", kind: "approval" });
  await expect(page.getByTestId("menu-needs-count")).toHaveText("2");
  await page.getByTestId("menu-needs").click();
  await page.screenshot({ path: join(SHOTS, "T12-needs-light.png"), animations: "disabled" });
  await page.getByTestId("needs-row").filter({ hasText: "Friren" }).click();
  const card = page.getByTestId("timeline").getByTestId("card-interview");
  await expect(card).toBeFocused();
  await card.getByRole("radio", { name: "Developers" }).click();
  await card.getByRole("checkbox", { name: "Fixes" }).click();
  await card.getByRole("group", { name: "Which sections should it have?" }).getByRole("button", { name: "Other…" }).click();
  await card.getByLabel("Other answer 2").fill("Upgrade notes");
  const [lr, lg, lb] = ((await card.getByRole("button", { name: "Submit" }).evaluate((el) => getComputedStyle(el).backgroundColor)).match(/[\d.]+/g) ?? []).map(Number);
  expect(Math.max(lr, lg, lb)).toBeLessThan(60); // light theme: dark ink fill
  await card.locator(".card-title").click();
  await page.screenshot({ path: join(SHOTS, "T12-interview-light.png"), animations: "disabled" });
});
