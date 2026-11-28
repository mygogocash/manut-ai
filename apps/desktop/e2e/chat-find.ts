// Shared by e2e/chat-find.spec.ts and chat-find-webkit.spec.ts (item 150): Kami's chat on the mock bridge with two finished
// turns whose steps are folded, a way to press Command+F (Control+F off macOS), and what find has painted.
import { expect, type Page } from "@playwright/test";
import { mock, modKey, openApp, type OpenOpts } from "./term-find-helpers";

/** A key the chat's masker hides (chat/activity/Work.tsx masks a diff line as it draws it). */
export const KEY = "sk-FAKE0000000000000000TEST";

const ev = (event: string, extra: Record<string, unknown> = {}) => ({ event, bot: "kami", ...extra });

/** Two turns of steps and answers: "checkout" is in two folded steps of the first (A), in its answer, and in the second's
 *  answer (B), as Checkout; B's one step is a file edit whose change holds a key. In the order the page draws them the
 *  matches are A's two steps, A's answer, then B's answer: 1 of 4 to 4 of 4. */
export const TURNS = [
  ev("turn.start"),
  ev("tool.start", { tool_id: "a1", name: "terminal", detail: "pnpm test checkout" }),
  ev("tool.end", { tool_id: "a1", name: "terminal", ok: true, ms: 1200 }),
  ev("tool.start", { tool_id: "a2", name: "read_file", detail: "src/checkout.tsx" }),
  ev("tool.end", { tool_id: "a2", name: "read_file", ok: true, ms: 40 }),
  ev("message", { id: "ma", text: "I ran the tests and read the checkout file. The shipping is added twice, so the total comes out wrong." }),
  ev("turn.end", { outcome: "done" }),
  ev("turn.start"),
  ev("tool.start", { tool_id: "b1", name: "patch", detail: "src/config.ts" }),
  ev("tool.diff", {
    tool_id: "b1",
    files: [{ path: "src/config.ts", kind: "update", added: 1, removed: 0, lines: ["@@ -1,1 +1,2 @@", " const a = 1;", `+export const PROMPTPAY_KEY = "${KEY}";`] }],
  }),
  ev("tool.end", { tool_id: "b1", name: "patch", ok: true, ms: 20 }),
  ev("message", { id: "mb", text: "Checkout is fixed now. ยอดรวมถูกต้องแล้วครับ" }),
  ev("turn.end", { outcome: "done" }),
];

export const tl = (page: Page) => page.getByTestId("timeline");
export const bar = (page: Page) => page.getByTestId("chat-find");
export const input = (page: Page) => page.getByTestId("chat-find-input");
export const count = (page: Page) => page.getByTestId("chat-find-count");
export const group = (page: Page, n: 0 | 1) => page.getByTestId("activity").nth(n);

export async function stage(page: Page, o: OpenOpts = {}) {
  await mock("mock.reset");
  await openApp(page, o);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
  await mock("mock.emit", { events: TURNS });
  await expect(page.getByTestId("activity")).toHaveCount(2);
  await expect(tl(page).getByText("Checkout is fixed now.")).toBeVisible();
  // the rows have finished rising in: a shape measured before that is a shape in motion
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
}

/** Command+F on macOS, Control+F elsewhere. */
export async function find(page: Page) {
  await page.keyboard.press(`${await modKey(page)}+f`);
}

/** What find has painted: the browser's highlights (their text) where it has them, and the boxes where it has not. */
export const painted = (page: Page) =>
  page.evaluate(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights;
    const words = (name: string) => [...(reg?.get(name) ?? [])].map((r) => r.toString());
    return { api: !!reg, plain: words("chat-find"), current: words("chat-find-current"), boxes: document.querySelectorAll(".cf-box").length, rings: document.querySelectorAll(".cf-cur").length };
  });

/** The chat's finished bubbles, as the page draws them (markup, and where each stands in the timeline's own scroll). */
export const bubbles = (page: Page) =>
  page.evaluate(() => {
    const thread = document.querySelector<HTMLElement>('[data-testid="timeline"]')!;
    const top = thread.getBoundingClientRect().top - thread.scrollTop;
    return [...thread.querySelectorAll<HTMLElement>('[data-testid^="bubble-"]')].map((b) => {
      const r = b.getBoundingClientRect();
      return { html: b.outerHTML, y: Math.round(r.top - top), w: Math.round(r.width), h: Math.round(r.height) };
    });
  });

/** Press Enter until the bar says `at`, at most `n` times. */
export async function goTo(page: Page, at: string, n = 5) {
  for (let i = 0; i < n && (await count(page).textContent()) !== at; i++) await page.keyboard.press("Enter");
  await expect(count(page)).toHaveText(at);
}
