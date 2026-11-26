// Sounds (Settings › General): the app's quiet sounds and GoSpark's chimes (item 131). AudioContext is a counting fake here,
// so nothing plays on the machine's speakers; the tests count the contexts made and the oscillators and buffer sources
// started. The fake says so (`__manutFakeAudio`), which is what lets the sound module's gate open in a driven browser.
import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { chatOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
// Screenshots stay out of the repo (SOUNDS_SHOTS dir, else Playwright's ignored test-results).
const SHOTS = process.env.SOUNDS_SHOTS || "test-results";

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "s1") res(msg);
    };
    ws.send(JSON.stringify({ id: "s1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

/** A counting AudioContext (and webkitAudioContext); `sounds` presets the switch. The window is out of sight. */
async function fakeAudio(page: Page, sounds?: "on" | "off") {
  await page.addInitScript((pref) => {
    const w = window as any;
    w.__manutFakeAudio = true;
    w.__audio = { made: 0, started: 0, decoded: 0, buffers: 0 };
    const param = { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} };
    class FakeAudioContext {
      state = "running";
      currentTime = 0;
      destination = {};
      constructor() {
        w.__audio.made += 1;
      }
      createOscillator() {
        return { type: "sine", frequency: param, connect() {}, start: () => (w.__audio.started += 1), stop() {} };
      }
      createGain() {
        return { gain: { ...param, value: 1 }, connect() {} };
      }
      createBuffer(_channels: number, length: number) {
        w.__audio.buffers += 1;
        return { length, copyToChannel() {} };
      }
      createBufferSource() {
        return { buffer: null, onended: null, connect() {}, start: () => (w.__audio.started += 1), stop() {} };
      }
      decodeAudioData(bytes: ArrayBuffer) {
        w.__audio.decoded += 1;
        return Promise.resolve({ length: bytes.byteLength });
      }
      resume() {
        return Promise.resolve();
      }
    }
    w.AudioContext = FakeAudioContext;
    w.webkitAudioContext = FakeAudioContext;
    if (pref) localStorage.setItem("manut.sounds", pref);
    document.hasFocus = () => false;
  }, sounds ?? null);
}

const audio = (page: Page) => page.evaluate(() => (window as any).__audio as { made: number; started: number; decoded: number; buffers: number });
/** What the tests that count oscillators and sources compare: the fake's two main counters. */
const counts = async (page: Page) => {
  const a = await audio(page);
  return { made: a.made, started: a.started };
};

async function open(page: Page) {
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("bubble-user").first()).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

const errorEnd = (bot: string) => mock("mock.emit", { events: [{ event: "turn.end", bot, outcome: "error", error: "boom" }] });

test.beforeEach(async () => {
  await mock("mock.reset");
});

test("Settings › General: Sounds is on, Play previews the chime, Off disables Play and stays off", async ({ page }) => {
  await fakeAudio(page);
  await open(page);
  await page.getByTestId("nav-settings").click();
  const seg = page.getByTestId("sounds-seg");
  const play = page.getByTestId("sounds-play");
  await expect(seg.getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  expect(await counts(page)).toEqual({ made: 0, started: 0 });

  await play.click();
  await expect.poll(() => counts(page)).toEqual({ made: 1, started: 2 });

  await seg.getByRole("radio", { name: "Off" }).click();
  await expect(play).toBeDisabled();
  await page.reload();
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("sounds-seg").getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sounds-play")).toBeDisabled();
  expect(await counts(page)).toEqual({ made: 0, started: 0 });
});

test("off: a send, a reply, an approval and an error make no AudioContext", async ({ page }) => {
  await fakeAudio(page, "off");
  await open(page);
  await send(page, "check the 502s");
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "keep-alive" }).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1600);
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  // the ask is in: the menu's Needs you row counts it (the bot row's dot did)
  await expect(page.getByTestId("menu-needs-count")).toHaveText("1");
  await page.waitForTimeout(1600);
  await errorEnd("friren");
  await page.waitForTimeout(500);
  expect(await counts(page)).toEqual({ made: 0, started: 0 });
});

test("on: a send ticks, a reply out of sight plays the finish chime, a new ask chimes, an error sounds its note", async ({ page }) => {
  await fakeAudio(page);
  await open(page);
  await send(page, "check the 502s");
  // one context, one oscillator: the tick
  await expect.poll(() => counts(page)).toEqual({ made: 1, started: 1 });
  // the answer lands ~2.5 s later while the window is out of sight: GoSpark's finish chime, one rendered buffer
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "keep-alive" }).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await audio(page)).started).toBe(2);
  expect((await audio(page)).buffers).toBe(1);
  await page.waitForTimeout(1600);

  await mock("mock.ask", { bot: "friren", kind: "approval" });
  await expect.poll(async () => (await audio(page)).started).toBe(4);
  await page.waitForTimeout(1600);
  await errorEnd("friren");
  await expect.poll(async () => (await audio(page)).started).toBe(5);
  expect((await audio(page)).made).toBe(1);
});

test("first load with an ask already waiting is silent", async ({ page }) => {
  await mock("mock.ask", { bot: "friren", kind: "approval" });
  await fakeAudio(page);
  await open(page);
  // the ask came back with the chat (the bridge's replay), and the menu's Needs you row counts it ...
  await expect(page.getByTestId("menu-needs-count")).toHaveText("1");
  await page.waitForTimeout(2000);
  // ... and made no sound
  expect(await counts(page)).toEqual({ made: 0, started: 0 });
});

test("screenshots: Sounds and chimes in Settings › General, dark and light", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fakeAudio(page);
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await open(page);
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("set-sounds").scrollIntoViewIfNeeded();
    await page.mouse.move(700, 880);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `settings-sounds-${theme}-after.png`) });
    await page.getByTestId("set-sounds").screenshot({ path: join(SHOTS, `settings-sounds-section-${theme}.png`) });
  }
});

// ---- item 131: the chimes' section ---------------------------------------------------------------------------------------

const openSettings = async (page: Page) => {
  await open(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("set-sounds").scrollIntoViewIfNeeded();
};

test("Sounds and chimes: each choice starts as GoSpark's, switches save, and the tone is kept", async ({ page }) => {
  await fakeAudio(page);
  await openSettings(page);
  for (const id of ["sound-finish-seg", "sound-settle-seg", "sound-effort-seg"]) {
    await expect(page.getByTestId(id).getByRole("radio", { name: "On" })).toHaveAttribute("aria-checked", "true");
  }
  const tone = page.getByTestId("sound-tone");
  await expect(tone).toHaveValue("default");
  await expect(tone.locator("option")).toHaveText(["Default", "Heaven", "Highwire", "Iridium", "Krypton", "Kzurb Sonar"]);

  await page.getByTestId("sound-finish-seg").getByRole("radio", { name: "Off" }).click();
  await page.getByTestId("sound-settle-seg").getByRole("radio", { name: "Off" }).click();
  await page.getByTestId("sound-effort-seg").getByRole("radio", { name: "Off" }).click();
  await tone.selectOption("kzurbSonar");
  // choosing a tone reads its file but does not play it: Preview is the person's to press
  await expect.poll(async () => (await audio(page)).decoded).toBe(1);
  expect((await audio(page)).started).toBe(0);

  await page.reload();
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  for (const id of ["sound-finish-seg", "sound-settle-seg", "sound-effort-seg"]) {
    await expect(page.getByTestId(id).getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  }
  await expect(page.getByTestId("sound-tone")).toHaveValue("kzurbSonar");
});

test("Sounds and chimes: Preview plays the chosen sound without throwing, even with the finish chime off", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await fakeAudio(page);
  await openSettings(page);
  // Default: the synthesized chime, rendered once
  await page.getByTestId("sound-preview").click();
  await expect.poll(async () => (await audio(page)).started).toBe(1);
  expect((await audio(page)).buffers).toBe(1);
  // a tone: its bundled WAV is served by the app, decoded and played
  await page.getByTestId("sound-tone").selectOption("heaven");
  await expect.poll(async () => (await audio(page)).decoded).toBe(1);
  await page.getByTestId("sound-finish-seg").getByRole("radio", { name: "Off" }).click();
  await page.getByTestId("sound-preview").click();
  await expect.poll(async () => (await audio(page)).started).toBe(2);
  expect(errors).toEqual([]);
});

test("Sounds and chimes: with the finish chime off, a reply out of sight is silent", async ({ page }) => {
  await fakeAudio(page);
  await page.addInitScript(() => localStorage.setItem("manut.sound.finish", "off"));
  await open(page);
  await send(page, "check the 502s");
  // only the send tick: the answer's finish makes no sound
  await expect.poll(() => counts(page)).toEqual({ made: 1, started: 1 });
  await expect(page.getByTestId("bubble-bot").filter({ hasText: "keep-alive" }).first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  expect(await counts(page)).toEqual({ made: 1, started: 1 });
});
