// The effort card (item 132, the owner's request of 26 Nov 2026 that changing a chat's effort works and looks as it does
// in GoSpark): the chat box's model chip opens the card first, with the level large and the model under it; a drag shows
// each stop it crosses and sends the level it lets go on; a click and the keys land on a stop; Reset goes back to the
// default; the title opens the model list as the card's second view and Back or a pick returns; at the top level the
// title and the track take the provider's colour; each stop crossed plays item 131's effort sound; and a Claude Code
// chat's one-click Ultrathink row writes a visible line into the draft and takes it out again. Kit's chat runs on the stand-in coding agent of src/sessions/host.mock.ts, as
// chat-box.spec.ts's does, and what reaches the agent is read from its calls.
//
// EFFORT_SHOTS=<dir> keeps pictures of the card at a low level, at the top level for Claude Code and for Codex, and of
// the model list, in dark and light.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/you/code/baanmali-preorder";
type Input = { kind: string; text?: string; model?: string; effort?: string };
type Call = { op: string; input?: Input };
const inputs = async (page: Page): Promise<Input[]> =>
  ((await page.evaluate(() => (window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? [])) as Call[])
    .filter((c) => c.op === "chat.input")
    .map((c) => c.input!);
const sentLevels = async (page: Page) => (await inputs(page)).filter((i) => i.kind === "effort").map((i) => i.effort);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    (window as any).__manutBranches = { [root]: "main" };
  }, ROOT);
  await page.goto("/");
});

/** A lane of `agent` in the project, started through the sessions store as the + menu's Chat with Kit does, then open
 *  in the main column. */
async function lane(page: Page, agent: "claude" | "codex" = "claude"): Promise<void> {
  const id = await page.evaluate(
    async ([root, a]) => {
      const s = (window as any).__manutSessions;
      await s.loadAgents();
      const id = s.draft(a);
      s.setDraft(id, { cwd: root });
      await s.start(id, "/status");
      return id as string;
    },
    [ROOT, agent] as const,
  );
  await page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
  await expect(page.getByTestId("session-status")).toHaveText("Ready");
}

const box = (page: Page) => page.getByTestId("composer-box");
const card = (page: Page) => page.getByTestId("effort-card");
const level = (page: Page) => page.getByTestId("effort-level");

/** The middle of stop `i` on the slider's track, in page coordinates. */
async function stopAt(page: Page, i: number): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId("effort-stop").nth(i).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test("the chip opens the effort card first: the level large, the model under it, one stop for each level", async ({ page }) => {
  await lane(page);
  await expect(box(page).getByTestId("model-label")).toHaveText("Opus 5.5");
  await expect(box(page).getByTestId("reasoning-label")).toHaveText("High");
  await box(page).getByTestId("model-pill").click();
  // while the card is open the chip says what it is for, as GoSpark's does
  await expect(box(page).getByTestId("model-select")).toHaveText("Select effort");
  await expect(card(page)).toBeVisible();
  await expect(level(page)).toHaveText("High");
  await expect(page.getByTestId("effort-model")).toHaveText("Opus 5.5");
  await expect(page.getByTestId("effort-stop")).toHaveCount(5);
  await expect(page.getByTestId("model-opt")).toHaveCount(0);
  const slider = page.getByTestId("effort-slider");
  await expect(slider).toBeFocused();
  await expect(slider).toHaveAttribute("aria-valuenow", "2");
  await expect(slider).toHaveAttribute("aria-valuetext", "High");
  await expect(page.getByTestId("model-pop")).toContainText("Applies to this session");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(box(page).getByTestId("model-pill")).toBeFocused();
});

test("a drag names each stop it crosses, takes the provider's colour at the top, and sends only where it lets go", async ({ page }) => {
  await lane(page);
  await box(page).getByTestId("model-pill").click();
  const from = await stopAt(page, 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const next = await stopAt(page, 3);
  await page.mouse.move(next.x, next.y, { steps: 4 });
  await expect(level(page)).toHaveText("Extra High");
  await expect(card(page)).not.toHaveAttribute("data-top", /.*/);
  const end = await stopAt(page, 4);
  await page.mouse.move(end.x + 30, end.y, { steps: 4 });
  await expect(level(page)).toHaveText("Max");
  await expect(card(page)).toHaveAttribute("data-top", "true");
  // nothing has gone to the agent while the knob is held
  expect(await sentLevels(page)).toEqual([]);
  await page.mouse.up();
  await expect.poll(() => sentLevels(page)).toEqual(["max"]);
  await expect(page.getByTestId("effort-slider")).toHaveAttribute("aria-valuenow", "4");
  // Claude's terracotta, from its mark, on the track and (toward the ink, to read on the card) on the title
  await expect(card(page)).toHaveAttribute("data-brand", "colour");
  await expect.poll(() => page.locator(".ef-fill").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(217, 119, 87)");
  const title = await level(page).evaluate((el) => getComputedStyle(el).color);
  expect(title).not.toBe(await page.getByTestId("effort-model").evaluate((el) => getComputedStyle(el).color));
  await page.keyboard.press("Escape");
  await expect(box(page).getByTestId("reasoning-label")).toHaveText("Max");
});

test("a click lands on the stop clicked, the arrow keys move a stop, Home and End go to the ends, and Reset to the default", async ({ page }) => {
  await lane(page);
  await box(page).getByTestId("model-pill").click();
  const low = await stopAt(page, 0);
  await page.mouse.click(low.x, low.y);
  await expect(level(page)).toHaveText("Low");
  await expect.poll(() => sentLevels(page)).toEqual(["low"]);
  const slider = page.getByTestId("effort-slider");
  await expect(slider).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(level(page)).toHaveText("Medium");
  await page.keyboard.press("End");
  await expect(level(page)).toHaveText("Max");
  await page.keyboard.press("ArrowLeft");
  await expect(level(page)).toHaveText("Extra High");
  await page.keyboard.press("Home");
  await expect(level(page)).toHaveText("Low");
  // a key past the end sends nothing more
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => sentLevels(page)).toEqual(["low", "medium", "max", "xhigh", "low"]);
  // Reset: GoSpark's default for a model that names none, high or medium in the agent's order (here medium)
  await page.getByTestId("effort-reset").click();
  await expect(level(page)).toHaveText("Medium");
  await expect.poll(() => sentLevels(page)).toEqual(["low", "medium", "max", "xhigh", "low", "medium"]);
});

test("the title opens the model list as the card's second view; Back returns, and so does a pick, which goes to the agent", async ({ page }) => {
  await lane(page);
  await box(page).getByTestId("model-pill").click();
  await page.getByTestId("effort-title").click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("model-list")).toBeVisible();
  await expect(page.getByTestId("model-opt")).toHaveText(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  await expect(page.getByTestId("model-opt").filter({ hasText: "Opus 5.5" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("model-back").click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("effort-title")).toBeFocused();
  await page.getByTestId("effort-title").click();
  await page.getByTestId("model-opt").filter({ hasText: "Haiku 5.5" }).click();
  await expect(card(page)).toBeVisible();
  await expect(page.getByTestId("effort-model")).toHaveText("Haiku 5.5");
  expect(await inputs(page)).toContainEqual({ kind: "model", model: "haiku" });
});

test("Ultrathink, in a Claude Code chat: a visible line in the draft, put in and taken out by the switch", async ({ page }) => {
  await lane(page);
  const field = page.getByTestId("composer");
  await field.fill("fix the cart");
  await box(page).getByTestId("model-pill").click();
  const sw = page.getByTestId("ultrathink-switch");
  await expect(page.getByTestId("ultrathink-row")).toContainText("Ultrathink this message");
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(field).toHaveValue("Ultrathink:\nfix the cart");
  await expect(sw).toHaveAttribute("aria-checked", "true");
  // the level is not touched by it
  expect(await sentLevels(page)).toEqual([]);
  await sw.click();
  await expect(field).toHaveValue("fix the cart");
  await sw.click();
  await page.keyboard.press("Escape");
  // sent as the person sees it
  await field.press("Enter");
  await expect.poll(async () => (await inputs(page)).filter((i) => i.kind === "send").pop()?.text).toBe("Ultrathink:\nfix the cart");
  // a word the person typed locks it on; a slash command locks it off
  await field.fill("ultrathink about the cart");
  await box(page).getByTestId("model-pill").click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(sw).toBeDisabled();
  await expect(page.getByTestId("ultrathink-line")).toHaveText("Delete “ultrathink” from your message to turn this off.");
  await page.keyboard.press("Escape");
  await field.fill("/review the cart");
  await page.keyboard.press("Escape");
  await box(page).getByTestId("model-pill").click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(sw).toBeDisabled();
  await expect(page.getByTestId("ultrathink-line")).toHaveText("Claude Code ignores ultrathink in a slash command.");
});

test("Codex: no Ultrathink row, and its top level is drawn in the ink, as its mark is", async ({ page }) => {
  await lane(page, "codex");
  await box(page).getByTestId("model-pill").click();
  await expect(page.getByTestId("effort-stop")).toHaveCount(6);
  await expect(level(page)).toHaveText("Medium");
  await expect(page.getByTestId("ultrathink-row")).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(level(page)).toHaveText("Ultra");
  await expect(card(page)).toHaveAttribute("data-top", "true");
  await expect(card(page)).toHaveAttribute("data-brand", "ink");
  await expect.poll(() => sentLevels(page)).toEqual(["ultra"]);
});

test("each stop the knob crosses, and each key step, plays item 131's effort sound once", async ({ page }) => {
  // a counting AudioContext, as e2e/sounds.spec.ts's: it cannot make a sound, and saying so opens the sound gate
  await page.addInitScript(() => {
    const w = window as any;
    w.__manutFakeAudio = true;
    w.__started = 0;
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      createOscillator() {
        return { type: "sine", frequency: param, connect() {}, start() {}, stop() {} };
      }
      createGain() {
        return { gain: { ...param, value: 1 }, connect() {} };
      }
      createBuffer(_channels: number, length: number) {
        return { length, copyToChannel() {} };
      }
      createBufferSource() {
        return { buffer: null, onended: null, connect() {}, start: () => (w.__started += 1), stop() {} };
      }
      decodeAudioData(bytes: ArrayBuffer) {
        return Promise.resolve({ length: bytes.byteLength });
      }
      resume() {
        return Promise.resolve();
      }
    }
    w.AudioContext = FakeAudioContext;
    w.webkitAudioContext = FakeAudioContext;
  });
  await page.reload();
  await lane(page);
  const started = () => page.evaluate(() => (window as any).__started as number);
  await box(page).getByTestId("model-pill").click();
  await expect(level(page)).toHaveText("High");
  const before = await started();
  // a drag from High across Extra High to Max: two stops crossed, two sounds; moving within Max adds none
  const from = await stopAt(page, 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const end = await stopAt(page, 4);
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.move(end.x + 20, end.y, { steps: 3 });
  await page.mouse.up();
  await expect(level(page)).toHaveText("Max");
  await expect.poll(started).toBe(before + 2);
  // a key step plays its stop; a key at the end moves nothing and plays nothing
  await page.keyboard.press("ArrowLeft");
  await expect(level(page)).toHaveText("Extra High");
  await expect.poll(started).toBe(before + 3);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowLeft");
  await expect(level(page)).toHaveText("Low");
  await expect.poll(started).toBe(before + 4);
});

test("pictures of the card and the model list (EFFORT_SHOTS)", async ({ page }) => {
  const dir = process.env.EFFORT_SHOTS;
  test.skip(!dir, "set EFFORT_SHOTS=<dir> to keep the pictures");
  mkdirSync(dir!, { recursive: true });
  const shoot = async (name: string) => {
    // the popover's Rise has ended before the picture
    await page.waitForTimeout(400);
    const pop = page.locator(".ui-pop").filter({ has: page.getByTestId("model-pop") });
    const b = (await pop.boundingBox())!;
    await page.screenshot({ path: join(dir!, `${name}.png`), clip: { x: b.x - 24, y: b.y - 24, width: b.width + 48, height: b.height + 96 } });
  };
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("manut.theme", t), theme);
    await page.reload();
    await lane(page);
    await page.getByTestId("composer").fill("fix the cart");
    await box(page).getByTestId("model-pill").click();
    // by the pointer, as a person mostly does, so the pictures show the card without the keys' focus ring
    const click = async (i: number) => {
      const at = await stopAt(page, i);
      await page.mouse.click(at.x, at.y);
      await page.mouse.move(at.x, at.y + 120);
    };
    await click(0);
    await expect(level(page)).toHaveText("Low");
    await shoot(`${theme}-claude-low`);
    await click(2);
    await expect(level(page)).toHaveText("High");
    await shoot(`${theme}-claude-mid`);
    await click(4);
    await expect(level(page)).toHaveText("Max");
    await shoot(`${theme}-claude-top`);
    await page.getByTestId("effort-title").click();
    await expect(page.getByTestId("model-list")).toBeVisible();
    await shoot(`${theme}-model-list`);
    await page.keyboard.press("Escape");
    await lane(page, "codex");
    await box(page).getByTestId("model-pill").click();
    const top = await stopAt(page, 5);
    await page.mouse.click(top.x, top.y);
    await page.mouse.move(top.x, top.y + 120);
    await expect(level(page)).toHaveText("Ultra");
    await shoot(`${theme}-codex-top`);
    await page.keyboard.press("Escape");
  }
});
