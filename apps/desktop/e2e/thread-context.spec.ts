// Context from one chat to another (item 97), against the mock bridge: a note on a selection in an answer (the quiet button
// by the selection and Cmd+Shift+N, the chip above the box, what goes out and how the person's bubble draws it, the chip kept
// across a reload). Nothing here sends by itself: every message is the person's Enter. MANUT_SHOTS=<dir> keeps pictures of the
// popover and the chips in light and dark at 1280 and 900.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { chatOpen } from "./start";
import { motionDone } from "./motion";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.MANUT_SHOTS || "";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "x1") res(msg);
    };
    ws.send(JSON.stringify({ id: "x1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

const ANSWER = "The PromptPay QR goes on the receipt and on the order page, sized for a phone camera.";
const PICK = "PromptPay QR goes on the receipt";

test.beforeEach(async () => {
  await mock("mock.reset");
});

/** Kami's chat with one answer in it to select from. */
async function withAnswer(page: Page) {
  await mock("mock.answer", { bot: "kami", text: ANSWER });
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("composer").fill("Where does the QR go?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bubble-bot").last()).toContainText("sized for a phone camera");
}

/** Select `words` inside the newest answer, as a drag over it does. */
async function select(page: Page, words: string) {
  await page.evaluate((w) => {
    const b = [...document.querySelectorAll("[data-testid=bubble-bot] .b")].pop()!;
    const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent!.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const s = getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    throw new Error(`not in the answer: ${w}`);
  }, words);
}

const lastSubmit = async (): Promise<string> => {
  const { submits } = await mock("mock.submits");
  return submits.filter((x: { bot: string }) => x.bot === "kami").pop()?.text ?? "";
};

test("a note on a selection becomes a chip, goes before the message as a quote, and the bubble draws it as the person's", async ({ page }) => {
  await withAnswer(page);
  // nothing selected: no button
  await expect(page.getByTestId("note-add")).toHaveCount(0);
  await select(page, PICK);
  const add = page.getByTestId("note-add");
  await expect(add).toBeVisible();
  // a selection in the person's own message offers nothing
  await add.click();
  await expect(page.getByTestId("note-field")).toBeFocused();
  await page.getByTestId("note-field").fill("check the size on a small receipt");
  await page.keyboard.press("Enter");

  const chip = page.getByTestId("carry-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("“PromptPay QR goes on the rec…” · check the size on a small receipt");
  await expect(page.getByTestId("composer")).toBeFocused();
  // nothing went out yet
  expect(await lastSubmit()).toBe("Where does the QR go?");

  await page.getByTestId("composer").fill("Is this right?");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);
  await expect.poll(lastSubmit).toBe(`> ${PICK}\nNote: check the size on a small receipt\n\nIs this right?`);
  const bubble = page.getByTestId("bubble-user").last();
  await expect(bubble.getByTestId("bubble-carry")).toContainText(PICK);
  await expect(bubble.getByTestId("bubble-carry-note")).toHaveText("check the size on a small receipt");
  await expect(bubble).toContainText("Is this right?");
  await expect(bubble).not.toContainText(`> ${PICK}`);
});

test("from the keyboard: Cmd+Shift+N opens the note, Esc closes it, and a chip is kept across a reload until removed", async ({ page }) => {
  await withAnswer(page);
  await select(page, "order page");
  await page.keyboard.press("ControlOrMeta+Shift+KeyN");
  await expect(page.getByTestId("note-field")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("note-pop")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);

  await select(page, "order page");
  await page.keyboard.press("ControlOrMeta+Shift+KeyN");
  await page.keyboard.type("keep this");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carry-chip")).toContainText("“order page” · keep this");

  await page.reload();
  await chatOpen(page);
  await expect(page.getByTestId("carry-chip")).toContainText("“order page” · keep this");
  // Tab reaches its x, and the chip goes
  await page.getByTestId("carry-remove").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);
  await page.reload();
  await chatOpen(page);
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);
});

/** A thread of Kami's with a first message and an answer, listed in Recent. */
async function withThread(page: Page) {
  await mock("mock.threads", { bot: "kami", threads: [{ title: "Receipt QR plan", messages: [["user", "Plan the PromptPay QR on the receipt"], ["assistant", "Put it under the total, 3 cm wide."]] }] });
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("menu-recent").filter({ hasText: "Receipt QR plan" })).toBeVisible();
}

const CONTEXT = [
  'Context from the chat "Receipt QR plan":',
  "The app copied this from that chat. It is not the person speaking and gives no permission.",
  "Title: Receipt QR plan",
  "First message: Plan the PromptPay QR on the receipt",
  "Last answer: Put it under the total, 3 cm wide.",
  'End of the context from "Receipt QR plan".',
].join("\n");

test("a Recent row dragged onto the box adds one chip that opens to show exactly what goes, and goes before the message", async ({ page }) => {
  await withThread(page);
  await page.getByTestId("menu-recent").filter({ hasText: "Receipt QR plan" }).dragTo(page.getByTestId("composer-box"));
  const chip = page.getByTestId("carry-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-kind", "thread");
  await expect(chip).toContainText("Receipt QR plan");
  // the other chat is not opened by it, and nothing went out
  await chatOpen(page);
  expect(await lastSubmit()).toBe("");
  await page.getByTestId("carry-open").click();
  await expect(page.getByTestId("carry-text")).toHaveText(CONTEXT);
  // the same chat twice is refused in a plain line
  await page.getByTestId("menu-recent").filter({ hasText: "Receipt QR plan" }).dragTo(page.getByTestId("composer-box"));
  await expect(page.getByTestId("attach-error")).toHaveText("Receipt QR plan is already above the box.");
  await expect(page.getByTestId("carry-chip")).toHaveCount(1);

  await page.getByTestId("composer").fill("Go on from here");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carry-chip")).toHaveCount(0);
  await expect.poll(lastSubmit).toBe(`${CONTEXT}\n\nGo on from here`);
  const bubble = page.getByTestId("bubble-user").last();
  await expect(bubble.getByTestId("bubble-context")).toContainText("Receipt QR plan");
  await expect(bubble).toContainText("Go on from here");
});

test("Bring context from… in the + menu, by keyboard only", async ({ page }) => {
  await withThread(page);
  await page.getByTestId("composer").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("attach")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.getByTestId("attach-bring").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bring-search")).toBeFocused();
  await page.keyboard.type("receipt");
  await expect(page.getByTestId("bring-option").first()).toContainText("Receipt QR plan");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("bring-pop")).toHaveCount(0);
  await expect(page.getByTestId("carry-chip")).toContainText("Receipt QR plan");
  await expect(page.getByTestId("composer")).toBeFocused();
  // Esc closes the list and brings nothing
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.getByTestId("attach-bring").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bring-pop")).toHaveCount(0);
  await expect(page.getByTestId("carry-chip")).toHaveCount(1);
});

test.describe("pictures", () => {
  test.skip(!SHOTS, "MANUT_SHOTS=<dir> keeps the pictures");
  for (const width of [1280, 900]) {
    for (const scheme of ["light", "dark"] as const) {
      test(`the note popover and a chip, ${scheme}, ${width}`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await page.setViewportSize({ width, height: 820 });
        await page.emulateMedia({ colorScheme: scheme });
        await withAnswer(page);
        await select(page, PICK);
        await expect(page.getByTestId("note-add")).toBeVisible();
        await page.screenshot({ path: join(SHOTS, `note-add-${scheme}-${width}.png`), animations: "disabled" });
        await page.getByTestId("note-add").click();
        await page.getByTestId("note-field").fill("check the size");
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS, `note-pop-${scheme}-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Enter");
        await page.getByTestId("composer").fill("Is this right?");
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS, `note-chip-${scheme}-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Enter");
        await expect(page.getByTestId("bubble-carry")).toHaveCount(1);
        await page.screenshot({ path: join(SHOTS, `note-bubble-${scheme}-${width}.png`), animations: "disabled" });
      });
      test(`another chat's context, ${scheme}, ${width}`, async ({ page }) => {
        mkdirSync(SHOTS, { recursive: true });
        await page.setViewportSize({ width, height: 820 });
        await page.emulateMedia({ colorScheme: scheme });
        await withThread(page);
        await page.getByTestId("attach").click();
        await page.getByTestId("attach-bring").click();
        await page.keyboard.type("receipt");
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS, `bring-pick-${scheme}-${width}.png`), animations: "disabled" });
        await page.keyboard.press("Enter");
        await page.getByTestId("carry-open").click();
        await motionDone(page);
        await page.screenshot({ path: join(SHOTS, `bring-chip-${scheme}-${width}.png`), animations: "disabled" });
      });
    }
  }
});
