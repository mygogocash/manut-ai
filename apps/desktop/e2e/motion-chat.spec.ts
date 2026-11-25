// Motion in the chat (item 85b, docs/motion.md): a message that arrives while the chat is open Rises once, and what was
// already there when the chat opened, or is drawn again, does not move. The working line shimmers only while someone
// works, the done mark settles when the turn ends in front of the person, and an ask fades in where it stands. Frames
// are held at the start, the middle and the end of the arrival (the Web Animations API, as motion-shots.spec.ts does),
// in light and dark and with reduced motion, where there is nothing in between.
//
// MOTION_SHOTS=<dir> keeps each frame as a PNG to look at.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatOpen, openChat } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const DIR = process.env.MOTION_SHOTS || "";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "mc1") res(msg);
    };
    ws.send(JSON.stringify({ id: "mc1", op, ...params }));
  });
  ws.close();
  return reply.result;
}
const ev = (event: string, extra: Record<string, unknown> = {}) => ({ event, bot: "kami", ...extra });

async function start(page: Page, theme: "dark" | "light", reduced: boolean) {
  await mock("mock.reset");
  if (DIR) mkdirSync(DIR, { recursive: true });
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

/** The moves running in the timeline that play once (a loop is not an arrival). */
const arriving = (page: Page) =>
  page.getByTestId("timeline").evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && a.effect?.getComputedTiming().iterations !== Infinity && a.playState === "running").length);

const hold = (root: Locator, at: "start" | "middle" | "end") =>
  root.evaluate((el, at) => {
    const anims = el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    for (const a of anims) {
      a.pause();
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      a.currentTime = at === "start" ? 0 : at === "middle" ? end / 2 : end;
    }
    return anims.length;
  }, at);

async function shot(page: Page, root: Locator, name: string) {
  const png = await root.screenshot({ caret: "hide" });
  if (DIR) writeFileSync(join(DIR, `${name}.png`), png);
}

test.describe("motion in the chat", () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  test("reopening a chat animates nothing", async ({ page }) => {
    await start(page, "light", false);
    // the rows drawn when the chat opened never moved
    expect(await page.locator(".thread .row.mo-rise, .thread .row.arrived-ask, .thread .line.landed").count()).toBe(0);
    expect(await arriving(page)).toBe(0);
    // away and back: the same history is drawn again and still does not move
    await openChat(page, "friren");
    await openChat(page, "kami");
    expect(await page.locator(".thread .row.mo-rise, .thread .row.arrived-ask, .thread .line.landed").count()).toBe(0);
    expect(await arriving(page)).toBe(0);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`a new message rises once, and a re-render does not play it again (${theme})`, async ({ page }) => {
      await start(page, theme, false);
      await mock("mock.emit", { events: [ev("message", { id: "mc-a1", text: "The idle timeout is shorter than the gateway's." })] });
      const row = page.locator('.thread .row-assistant[class*="mo-rise"]').last();
      await expect(row).toBeVisible();
      const tl = page.getByTestId("timeline");
      for (const at of ["start", "middle", "end"] as const) {
        expect(await hold(tl, at), "a Rise is running").toBeGreaterThan(0);
        await shot(page, tl, `chat-arrive-${theme}-${at}`);
      }
      await tl.evaluate((el) => el.getAnimations({ subtree: true }).forEach((a) => a.finish()));
      // a second message moves only itself
      await mock("mock.emit", { events: [ev("message", { id: "mc-a2", text: "And the jitter bounds." })] });
      await expect(page.locator(".thread .row-assistant").last()).toContainText("jitter");
      expect(await page.locator(".thread .row.mo-rise").count()).toBe(2);
      await tl.evaluate((el) => el.getAnimations({ subtree: true }).forEach((a) => a.finish()));
      // another message and a scroll: the earlier rows are not animated again
      await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = 0));
      await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
      expect(await arriving(page)).toBe(0);
    });
  }

  test("the working line shimmers while the turn runs and every loop stops when it ends; the done mark settles", async ({ page }) => {
    await start(page, "light", false);
    await mock("mock.emit", { events: [ev("turn.start"), ev("tool.start", { tool_id: "w1", name: "read_file", detail: "a.txt" })] });
    const act = page.getByTestId("activity");
    await expect(act).toHaveAttribute("data-state", "live");
    const loops = () => page.getByTestId("timeline").evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations === Infinity && a.playState === "running").length);
    expect(await act.locator(".act-tick").evaluate((e) => getComputedStyle(e).animationName)).toBe("shim");
    expect(await loops()).toBeGreaterThan(0);
    await mock("mock.emit", { events: [ev("tool.end", { tool_id: "w1", name: "read_file", ok: true, ms: 10 }), ev("turn.end", { outcome: "done" })] });
    await expect(act).toHaveAttribute("data-state", "done");
    expect(await loops()).toBe(0);
    await expect(act.locator(".act-ic.done")).toHaveClass(/mo-settle/);
    // opened again from history it does not settle
    await openChat(page, "friren");
    await openChat(page, "kami");
    expect(await page.locator(".act-ic.mo-settle").count()).toBe(0);
  });

  test("an ask fades in where it stands, and Allow settles its line", async ({ page }) => {
    await start(page, "light", false);
    await mock("mock.ask", { bot: "kami", kind: "approval" });
    const card = page.getByTestId("card-approval");
    await expect(card).toBeVisible();
    const row = page.locator(".thread .row-approval").last();
    await expect(row).toHaveClass(/arrived-ask/);
    expect(await row.evaluate((e) => getComputedStyle(e).getPropertyValue("--rise-by").trim())).toBe("0px");
    await card.getByRole("button").first().click();
    await expect(page.getByTestId("card-line").last()).toBeVisible();
  });

  test("with reduced motion an arrival has no frame between", async ({ page }) => {
    await start(page, "light", true);
    await mock("mock.emit", { events: [ev("message", { id: "mc-r1", text: "Nothing moves here." })] });
    await expect(page.locator(".thread .row-assistant").last()).toContainText("Nothing moves");
    await expect
      .poll(() => arriving(page), { timeout: 400, intervals: [16, 16, 32, 50] })
      .toBe(0);
    const tl = page.getByTestId("timeline");
    const first = await tl.screenshot({ caret: "hide" });
    await page.waitForTimeout(600);
    expect(first.equals(await tl.screenshot({ caret: "hide" }))).toBe(true);
  });
});
