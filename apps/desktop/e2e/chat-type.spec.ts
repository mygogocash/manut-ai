// The chat reads like the Chat board (item 85f, docs/design-audit.md findings 2 and 7). CHAT_SHOTS=<dir> keeps a
// picture of each state in light and dark at 1280 and 900 wide, and BOARD_SHOTS=<dir> the board rendered the same way.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chatOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const SHOTS = process.env.CHAT_SHOTS || "";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "ct1") res(msg);
    };
    ws.send(JSON.stringify({ id: "ct1", op, ...params }));
  });
  ws.close();
  return reply.result;
}
const ev = (event: string, extra: Record<string, unknown> = {}) => ({ event, bot: "kami", ...extra });

/** A long answer that mixes what an answer can hold: paragraphs, a list, code, a table, a quote and links. */
const LONG = [
  "Here is what I found in the gateway logs from last night.",
  "",
  "The upstream closes an idle connection after **sixty seconds**, while the gateway keeps it for seventy five, so a request that picks a stale one fails with a 502. It happened 41 times between 02:00 and 03:00.",
  "",
  "## What I changed",
  "",
  "1. Raised the idle timeout in `gateway.yaml` to 55 seconds",
  "2. Added one retry for idempotent requests",
  "   - with a 200 ms backoff",
  "   - never for a payment",
  "3. Left the payment routes as they were",
  "",
  "```ts",
  "export async function withRetry<T>(fn: () => Promise<T>, tries = 1): Promise<T> {",
  "  try {",
  "    return await fn();",
  "  } catch (e) {",
  "    if (tries <= 0) throw e;",
  "    await sleep(200);",
  "    return withRetry(fn, tries - 1);",
  "  }",
  "}",
  "```",
  "",
  "| Measure | Before | After |",
  "|---|---:|---:|",
  "| 502s an hour | 41 | 0 |",
  "| p50 latency | 412 ms | 198 ms |",
  "",
  "> Retries only ever repeat a request that is safe to repeat.",
  "",
  "The full log is in [the run's page](https://example.com/runs/42) and the change in https://github.com/example/shop/pull/7.",
].join("\n");

async function start(page: Page, theme: "dark" | "light", width: number) {
  await mock("mock.reset");
  await page.setViewportSize({ width, height: 820 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.getByTestId("composer").blur();
  await page.screenshot({ path: join(SHOTS, `${name}.png`), caret: "hide" });
}

test("an answer reads as the board: the serif at 17px on the page, its code, lists and table still scan", async ({ page }) => {
  await start(page, "light", 1280);
  await mock("mock.emit", { events: [ev("turn.start"), ev("message", { id: "ct-long", text: LONG }), ev("turn.end", { outcome: "done" })] });
  const answer = page.getByTestId("bubble-bot").last();
  await expect(answer.locator("table")).toBeVisible();
  const m = await answer.evaluate((el) => {
    const cs = (q: string) => getComputedStyle(el.querySelector(q)!);
    const b = el.querySelector(".b")!;
    const p = cs(".b > p");
    const inline = [...el.querySelectorAll(".b li code")][0]!;
    return {
      family: getComputedStyle(b).fontFamily,
      size: p.fontSize,
      lineHeight: parseFloat(p.lineHeight),
      fill: getComputedStyle(b).backgroundColor,
      width: b.getBoundingClientRect().width,
      gap: parseFloat(cs(".b > p + p").marginTop),
      h2: [cs("h2").fontSize, cs("h2").fontWeight, cs("h2").fontFamily === getComputedStyle(b).fontFamily],
      inline: [getComputedStyle(inline).fontFamily.startsWith('"Geist Mono"'), getComputedStyle(inline).fontSize],
      block: [cs("pre").fontFamily.startsWith('"Geist Mono"'), cs("pre").fontSize, parseFloat(cs("pre").lineHeight)],
      table: [/^"?Geist"?,/.test(cs("table").fontFamily), cs("table").fontSize, cs("table").fontVariantNumeric, cs("th").fontWeight],
      list: cs("li").fontFamily === getComputedStyle(b).fontFamily,
    };
  });
  expect(m.family).toBe('"Source Serif 4", "Noto Serif Thai", Georgia, serif');
  expect(m.size).toBe("17px");
  expect(m.lineHeight).toBeCloseTo(28.05, 1);
  expect(m.fill).toBe("rgba(0, 0, 0, 0)");
  expect(m.width).toBeLessThanOrEqual(696);
  expect(m.gap).toBe(12);
  expect(m.h2).toEqual(["20px", "600", true]);
  expect(m.inline).toEqual([true, "14px"]);
  expect(m.block).toEqual([true, "12px", 19.2]);
  expect(m.table).toEqual([true, "13px", "tabular-nums", "500"]);
  expect(m.list).toBe(true);
  // the person's message alone is a bubble, at 15px
  const you = await page.getByTestId("bubble-user").last().locator(".b").evaluate((el) => [getComputedStyle(el).fontSize, /^"?Geist"?,/.test(getComputedStyle(el).fontFamily)]);
  expect(you).toEqual(["15px", true]);
  // the header names no model and shows no maker's or other app's mark; the model is in the box
  await expect(page.getByTestId("header").locator("[data-testid=model-pill], .model-ic, .src-ic")).toHaveCount(0);
  await expect(page.locator(".cw").getByTestId("model-pill")).toBeVisible();
});

test("the model in the box opens its menu above the box and still changes the model", async ({ page }) => {
  await start(page, "light", 1280);
  const pill = page.locator(".cw").getByTestId("model-pill");
  await pill.click();
  const pop = page.getByTestId("model-pop");
  await expect(pop).toBeVisible();
  const [popBox, boxBox] = await Promise.all([pop.boundingBox(), page.locator(".composer").boundingBox()]);
  expect(popBox!.y + popBox!.height).toBeLessThanOrEqual(boxBox!.y + 1);
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(pill).toBeFocused();
});

test.describe("screens", () => {
  test.skip(!SHOTS, "pictures only: CHAT_SHOTS=<dir>");
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 900]) {
      test(`a short answer, a long mixed answer, an ask and an error (${theme}, ${width})`, async ({ page }) => {
        await start(page, theme, width);
        await mock("mock.emit", { events: [ev("turn.start"), ev("message", { id: "ct-short", text: "Done. The retry fix is up, and nothing else changed." }), ev("turn.end", { outcome: "done" })] });
        await expect(page.getByTestId("bubble-bot").last()).toContainText("retry fix is up");
        await shot(page, `short-${theme}-${width}`);
        await mock("mock.emit", { events: [ev("turn.start"), ev("message", { id: "ct-long", text: LONG }), ev("turn.end", { outcome: "done" })] });
        await expect(page.getByTestId("bubble-bot").last().locator("table")).toBeVisible();
        await page.getByTestId("bubble-bot").last().evaluate((el) => el.scrollIntoView({ block: "start" }));
        await shot(page, `long-${theme}-${width}`);
        await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
        await shot(page, `long-end-${theme}-${width}`);
        await mock("mock.ask", { bot: "kami", kind: "approval" });
        await expect(page.getByTestId("card-approval")).toBeVisible();
        await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
        await shot(page, `ask-${theme}-${width}`);
        await page.getByTestId("card-approval").getByRole("button").first().click();
        await mock("mock.emit", { events: [ev("turn.start"), ev("turn.end", { outcome: "error", error: "provider 500" })] });
        await page.waitForTimeout(300);
        await page.getByTestId("timeline").evaluate((el) => (el.scrollTop = el.scrollHeight));
        await shot(page, `error-${theme}-${width}`);
      });
    }
  }
});

const BOARDS = "/Users/kunanonjarat/Developer/gospark-main/manut-ai-artifacts/app-screens/project";
test.describe("the board", () => {
  test.skip(!process.env.BOARD_SHOTS, "pictures only: BOARD_SHOTS=<dir>");
  for (const [board, theme] of [["Chat", "light"], ["ChatDark", "dark"]] as const) {
    for (const width of [1280, 900]) {
      test(`${board} at ${width}`, async ({ page }) => {
        const dir = process.env.BOARD_SHOTS!;
        mkdirSync(dir, { recursive: true });
        // the board's own files only: its web fonts are not fetched, so it falls back as the app does
        await page.route("**/*", (r) => (r.request().url().startsWith("file:") ? r.continue() : r.abort()));
        await page.setViewportSize({ width, height: 820 });
        await page.goto(`file://${BOARDS}/${board}.dc.html`);
        await page.waitForTimeout(1500);
        await page.screenshot({ path: join(dir, `board-${theme}-${width}.png`) });
      });
    }
  }
});
