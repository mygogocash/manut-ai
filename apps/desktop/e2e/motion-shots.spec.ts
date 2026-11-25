// The Motion board's moves as a person sees them (item 85a, docs/motion.md): a button's Hover and Press, the switch,
// a menu and a popover opening, and the palette opening, each as frames at the start, the middle and the end of its
// move, in light and in dark. Each move is held still with the Web Animations API (paused, then set to a moment), so
// a frame is the same on a fast Mac and a loaded runner. With reduced motion on there is nothing in between: the frame
// taken the moment a move starts is already its last.
//
// MOTION_SHOTS=<dir> keeps every frame as a PNG to look at (<control>-<theme>-<moment>.png). Without it the spec still
// checks that each move changes what is drawn, and that reduced motion leaves no frame between.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usePlatform } from "./term-find-helpers";
import { chatOpen, openSettings } from "./start";

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
      if (msg.id === "mo1") res(msg);
    };
    ws.send(JSON.stringify({ id: "mo1", op, ...params }));
  });
  ws.close();
  return reply.result;
}

type Moment = "start" | "middle" | "end";
type Box = { x: number; y: number; width: number; height: number };

/** Hold every move running in `root` (and its pseudo-elements) still at `at` of its own length, delay included. */
const hold = (root: Locator, at: Moment) =>
  root.evaluate((el, at) => {
    const anims = el.getAnimations({ subtree: true });
    for (const a of anims) {
      a.pause();
      const end = Number(a.effect?.getComputedTiming().endTime ?? 0);
      a.currentTime = at === "start" ? 0 : at === "middle" ? end / 2 : end;
    }
    return anims.length;
  }, at);

/** Let every held move finish, so the next one starts from rest. */
const release = (root: Locator) => root.evaluate((el) => el.getAnimations({ subtree: true }).forEach((a) => a.finish()));

/** Nothing moves on the page: no transition or animation is running, three frames in a row. */
const still = (page: Page) =>
  page.waitForFunction(
    (key) => {
      const w = window as unknown as Record<string, number>;
      const moving = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
      w[key] = moving ? 0 : (w[key] ?? 0) + 1;
      return w[key] >= 3;
    },
    `__still${Math.random().toString(36).slice(2)}`,
    { polling: "raf" },
  );

const pad = (b: Box, by = 16): Box => ({ x: Math.max(0, b.x - by), y: Math.max(0, b.y - by), width: b.width + by * 2, height: b.height + by * 2 });
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

async function shot(page: Page, clip: Box, name: string): Promise<Buffer> {
  const png = await page.screenshot({ clip, caret: "hide" });
  if (DIR) writeFileSync(join(DIR, `${name}.png`), png);
  return png;
}

/** The three frames of the move `root` is running now: held at its start, its middle and its end. */
async function frames(page: Page, root: Locator, clip: Box, name: string): Promise<Record<Moment, Buffer>> {
  const out = {} as Record<Moment, Buffer>;
  for (const at of ["start", "middle", "end"] as const) {
    expect(await hold(root, at), `${name}: a move is running`).toBeGreaterThan(0);
    out[at] = await shot(page, clip, `${name}-${at}`);
  }
  await release(root);
  return out;
}

/** How much of two frames differs: the share of pixels where a colour channel moved by more than a rounding error.
 *  Decoded in the page, which has a PNG reader. A move that only re-rasterises text and edges (a layer made for it)
 *  moves a few dozen pixels; a move a person sees moves far more. */
const differs = (page: Page, a: Buffer, b: Buffer) =>
  page.evaluate(
    async ([a, b]) => {
      const read = async (s: string) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d")!;
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [x, y] = await Promise.all([read(a), read(b)]);
      if (x.width !== y.width || x.height !== y.height) return 1;
      let n = 0;
      for (let i = 0; i < x.data.length; i += 4)
        if (Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) > 8) n++;
      return n / (x.width * x.height);
    },
    [a.toString("base64"), b.toString("base64")] as const,
  );
/** Seen as the same frame, and as a frame that moved. */
const SAME = 0.02;
const MOVED = 0.03;

/** With reduced motion: the frame just after the move would start, and one well after it. They must be the same. */
async function noFrames(page: Page, root: Locator, clip: Box, name: string): Promise<void> {
  // a move made now starts on the next frame; with reduced motion it has ended by the one after (a Rise would still
  // be a third of the way in)
  await expect
    .poll(() => root.evaluate((el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).length), {
      message: `${name}: nothing runs with reduced motion`,
      timeout: 200,
      intervals: [16, 16, 32, 32, 50],
    })
    .toBe(0);
  const first = await shot(page, clip, `${name}-middle`);
  await page.waitForTimeout(600);
  const last = await shot(page, clip, `${name}-end`);
  expect(first.equals(last), `${name}: the first frame is already the last`).toBe(true);
}

/** From now on, record each overlay that is marked as leaving (whether it was inert then), however briefly it stays. */
const watchLeaving = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __left: { cls: string; inert: boolean; hidden: string | null }[] };
    w.__left = [];
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target as HTMLElement;
        if (el.hasAttribute("data-leaving")) w.__left.push({ cls: el.className, inert: el.inert, hidden: el.getAttribute("aria-hidden") });
      }
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-leaving"] });
  });
const leftSoFar = (page: Page) => page.evaluate(() => (window as unknown as { __left: { cls: string; inert: boolean; hidden: string | null }[] }).__left);

async function start(page: Page, theme: "dark" | "light", reduced: boolean) {
  await mock("mock.reset");
  if (DIR) mkdirSync(DIR, { recursive: true });
  await page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await usePlatform(page);
  await page.goto("/");
  await chatOpen(page);
  await still(page);
  await watchLeaving(page);
}

test.describe("motion shots", () => {
  test.use({ viewport: { width: 1280, height: 820 } });

  for (const theme of ["dark", "light"] as const) {
    test(`a button fades its fill in under the pointer and presses to 97% (${theme})`, async ({ page }) => {
      await start(page, theme, false);
      await page.getByTestId("menu-team").click();
      const btn = page.getByTestId("pause-open");
      await expect(btn).toBeVisible();
      await still(page);
      const box = (await btn.boundingBox())!;
      const clip = pad(box);
      const rest = await shot(page, clip, `button-${theme}-rest`);
      // Hover: the fill fades in
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const hover = await frames(page, btn, clip, `button-hover-${theme}`);
      expect(await differs(page, hover.start, rest), "the hover starts from the button at rest").toBeLessThan(SAME);
      expect(await differs(page, hover.end, rest), "the fill came in").toBeGreaterThan(MOVED);
      // Press: 97% while held, on the curve
      await page.mouse.down();
      const press = await frames(page, btn, clip, `button-press-${theme}`);
      expect(await differs(page, press.start, hover.end), "the press starts from the hovered button").toBeLessThan(SAME);
      expect(await differs(page, press.end, press.start), "the button shrank").toBeGreaterThan(MOVED);
      expect(await btn.evaluate((el) => getComputedStyle(el).scale)).toBe("0.97");
      // let go somewhere else, so nothing is pressed for real
      await page.mouse.move(box.x + box.width / 2, box.y - 80);
      await page.mouse.up();
    });

    test(`the switch slides its thumb on the curve (${theme})`, async ({ page }) => {
      await start(page, theme, false);
      await openSettings(page, "general");
      const sw = page.getByTestId("set-suggest");
      await sw.scrollIntoViewIfNeeded();
      await still(page);
      const clip = pad((await sw.boundingBox())!, 12);
      const before = await sw.getAttribute("aria-checked");
      await sw.click();
      const f = await frames(page, sw, clip, `switch-${theme}`);
      expect(await differs(page, f.start, f.end), "the thumb moved").toBeGreaterThan(MOVED);
      await expect(sw).not.toHaveAttribute("aria-checked", before ?? "");
      // put it back as it was
      await sw.click();
    });

    test(`a menu and a popover arrive with a short Rise (${theme})`, async ({ page }) => {
      await start(page, theme, false);
      // the + menu (its own component): measure where it lands, then hold its arrival
      await page.getByTestId("attach").click();
      const menu = page.getByTestId("attach-menu");
      await expect(menu).toBeVisible();
      await still(page);
      const menuClip = pad(union((await menu.boundingBox())!, (await page.getByTestId("attach").boundingBox())!), 12);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await page.getByTestId("attach").click();
      const m = await frames(page, menu, menuClip, `menu-${theme}`);
      expect(await differs(page, m.start, m.end), "the menu came in").toBeGreaterThan(MOVED);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);

      // the shared popover (the model picker): its list is read once, so the frames show the arrival, not the loading
      const pill = page.getByTestId("model-pill");
      await pill.click();
      const pop = page.getByTestId("model-pop");
      await expect(pop.getByTestId("model-opt").first()).toBeVisible();
      await still(page);
      const popBox = page.locator(".ui-pop").filter({ has: pop });
      const popClip = pad(union((await popBox.boundingBox())!, (await pill.boundingBox())!), 12);
      await page.keyboard.press("Escape");
      // it fades where it stands, inert and hidden from a screen reader, and is then gone
      await expect.poll(() => leftSoFar(page)).toEqual([{ cls: expect.stringContaining("ui-pop"), inert: true, hidden: "true" }]);
      await expect(popBox).toHaveCount(0);
      await pill.click();
      await expect(pop.getByTestId("model-opt").first()).toBeVisible();
      const p = await frames(page, popBox, popClip, `popover-${theme}`);
      expect(await differs(page, p.start, p.end), "the popover came in").toBeGreaterThan(MOVED);
    });

    test(`the palette arrives over a fading backdrop and leaves faster than it came (${theme})`, async ({ page }) => {
      await start(page, theme, false);
      const key = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));
      await page.keyboard.press(`${key}+k`);
      const back = page.getByTestId("palette-backdrop");
      await expect(page.getByTestId("palette")).toBeVisible();
      const clip = pad((await page.getByTestId("palette").boundingBox())!, 40);
      const f = await frames(page, back, clip, `palette-${theme}`);
      expect(await differs(page, f.start, f.end), "the palette came in").toBeGreaterThan(MOVED);
      await page.keyboard.press("Escape");
      await expect.poll(() => leftSoFar(page)).toEqual([{ cls: "pal-back", inert: true, hidden: "true" }]);
      await expect(page.getByTestId("palette")).toHaveCount(0);
      // the focus went back while it faded
      await expect(page.getByTestId("composer")).toBeFocused();
    });
  }

  test("with reduced motion every move is off: each control's first frame is its last", async ({ page }) => {
    await start(page, "light", true);
    const key = await page.evaluate(() => (/Mac/.test(navigator.platform) ? "Meta" : "Control"));

    // the + menu opens, and closes, at once
    await page.getByTestId("attach").click();
    const menu = page.getByTestId("attach-menu");
    await expect(menu).toBeVisible();
    await noFrames(page, menu, pad(union((await menu.boundingBox())!, (await page.getByTestId("attach").boundingBox())!), 12), "reduced-menu");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // the popover never lingers to fade
    await page.getByTestId("model-pill").click();
    const pop = page.locator(".ui-pop").filter({ has: page.getByTestId("model-pop") });
    await expect(pop).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);

    // the palette
    await page.keyboard.press(`${key}+k`);
    await expect(page.getByTestId("palette")).toBeVisible();
    await noFrames(page, page.getByTestId("palette-backdrop"), pad((await page.getByTestId("palette").boundingBox())!, 40), "reduced-palette");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette")).toHaveCount(0);
    // neither the popover nor the palette lingered to fade
    expect(await leftSoFar(page)).toEqual([]);

    // a button held down
    await page.getByTestId("menu-team").click();
    const btn = page.getByTestId("pause-open");
    await expect(btn).toBeVisible();
    const box = (await btn.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await noFrames(page, btn, pad(box), "reduced-press");
    await page.mouse.move(box.x + box.width / 2, box.y - 80);
    await page.mouse.up();

    // the switch
    await openSettings(page, "general");
    const sw = page.getByTestId("set-suggest");
    await sw.scrollIntoViewIfNeeded();
    const clip = pad((await sw.boundingBox())!, 12);
    await sw.click();
    await noFrames(page, sw, clip, "reduced-switch");
    await sw.click();

    // the working dots still pulse nowhere: every loop stands on its still frame
    const loops = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
    expect(loops).toBe(0);
  });
});
