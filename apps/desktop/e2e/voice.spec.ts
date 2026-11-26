// Voice in the chat box (item 81) in a browser, with the stand-in for the Mac's listening and voices that
// src/voice/engine.ts installs when `window.__manutVoiceMock` is set: the test says the words the Mac would have heard
// (`__manutVoice.hear`) and finishes reading aloud (`__manutVoice.doneSpeaking`). Kit's chat runs on the stand-in coding
// agent of src/sessions/host.ts, as chat-box.spec.ts's does. What only a real microphone can show is in docs/voice.md.
import { expect, test, type Page } from "@playwright/test";

const ROOT = "/home/you/code/baanmali-preorder";
type Call = { op: string; input?: { kind: string; text?: string } };
type Voice = { calls: string[]; spoken: string[]; status: unknown };
const sends = async (page: Page) =>
  (await page.evaluate(() => ((window as unknown as { __manutSessionCalls?: Call[] }).__manutSessionCalls ?? [])))
    .filter((c) => c.op === "chat.input" && c.input?.kind === "send")
    .map((c) => c.input?.text);
const voice = (page: Page) => page.evaluate(() => (window as unknown as { __manutVoice?: Voice }).__manutVoice ?? { calls: [], spoken: [], status: null });
const hear = (page: Page, text: string, final = false) => page.evaluate(([t, f]) => (window as any).__manutVoice.hear(t, f), [text, final] as const);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((root) => {
    localStorage.removeItem("manut.kit.projects");
    localStorage.setItem("manut.lang", "en");
    localStorage.setItem("manut.voice.lang", "en-US");
    (window as any).__manutBranches = { [root]: "main" };
    (window as any).__manutVoiceMock = true;
  }, ROOT);
  await page.goto("/");
  const id = await page.evaluate(async (root) => {
    const s = (window as any).__manutSessions;
    await s.loadAgents();
    const id = s.draft("claude");
    s.setDraft(id, { cwd: root });
    await s.start(id, "/status");
    return id as string;
  }, ROOT);
  await page.evaluate(async (i) => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { actions: { openSession(id: string): void } } };
    store.getStore().actions.openSession(i);
  }, id);
  await expect(page.getByTestId("session-status")).toHaveText("Ready");
});

test("the microphone puts the words in the box as they are heard, and sends nothing", async ({ page }) => {
  const box = page.getByTestId("composer");
  await box.fill("Ask Pim");
  const before = (await sends(page)).length;
  await page.getByTestId("voice-mic").click();
  await expect(page.getByTestId("voice-mic")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("voice-mic-line")).toContainText("Listening in English, on this Mac.");
  await hear(page, "about the");
  await expect(box).toHaveValue("Ask Pim about the");
  await hear(page, "about the late order");
  await expect(box).toHaveValue("Ask Pim about the late order");
  // Esc stops it; the words stay to be read and corrected, and nothing went
  await box.press("Escape");
  await expect(page.getByTestId("voice-mic")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("voice-mic-line")).toHaveCount(0);
  await expect(box).toHaveValue("Ask Pim about the late order");
  expect((await sends(page)).length).toBe(before);
  expect((await voice(page)).calls).toEqual(["status en-US", "listen en-US", "stop"]);
  // Send is the person's
  await box.press("Enter");
  await expect.poll(() => sends(page)).toContain("Ask Pim about the late order");
});

test("a language this Mac cannot recognize by itself asks first, and listens through Apple only after the yes", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("manut.voice.lang", "th-TH");
    // the stand-in this page already holds: Thai, which this Mac recognizes only through Apple's servers
    const v = (window as any).__manutVoice;
    v.calls.length = 0;
    v.status = { lang: "th-TH", supported: true, available: true, onDevice: false, speech: "notAsked", mic: "notAsked" };
  });
  await page.getByTestId("voice-mic").click();
  const card = page.getByTestId("voice-consent");
  await expect(card).toContainText("Thai (ไทย) is turned into text by Apple's servers");
  await expect(card).toContainText("Manut AI keeps no recording.");
  // Not now: nothing listens, nothing is kept
  await page.getByTestId("voice-consent-no").click();
  await expect(card).toHaveCount(0);
  expect((await voice(page)).calls).toEqual(["status th-TH"]);
  expect(await page.evaluate(() => localStorage.getItem("manut.voice.where"))).toBeNull();
  // the yes: kept, and listening goes through Apple's servers, which the line says
  await page.getByTestId("voice-mic").click();
  await page.getByTestId("voice-consent-yes").click();
  await expect(page.getByTestId("voice-mic-line")).toContainText("through Apple's servers");
  expect((await voice(page)).calls).toContain("listen th-TH apple");
  expect(await page.evaluate(() => localStorage.getItem("manut.voice.where"))).toBe("apple");
});

test("voice mode sends at a pause, reads the answer aloud, listens again, and pauses on an ask it never answers", async ({ page }) => {
  await page.getByTestId("voice-mode").click();
  const strip = page.getByTestId("voice-strip");
  await expect(strip).toHaveAttribute("data-phase", "listening");
  await expect(strip).toContainText("Voice mode is listening in English, on this Mac.");
  await hear(page, "add a mul function");
  await expect(page.getByTestId("voice-heard")).toHaveText("add a mul function");
  // the pause sends what was said, as the person's message, through the same chat
  await expect.poll(() => sends(page), { timeout: 8_000 }).toContain("add a mul function");
  // the agent's answer is read aloud (the stand-in agent says what it was told)
  await expect.poll(async () => (await voice(page)).spoken.join("\n"), { timeout: 10_000 }).toContain("en-US: (mock Claude Code) You said: add a mul function");
  await expect(strip).toHaveAttribute("data-phase", "speaking");
  await page.evaluate(() => (window as any).__manutVoice.doneSpeaking());
  await expect(strip).toHaveAttribute("data-phase", "listening");

  // an ask: voice mode stops listening, says so, and waits for the card
  await hear(page, "/approve");
  await expect(page.getByTestId("card-approval")).toBeVisible({ timeout: 8_000 });
  await expect(strip).toHaveAttribute("data-phase", "paused");
  await expect(strip).toContainText("There is something to approve above. Voice mode waits: decide with the card, as always.");
  await expect.poll(async () => (await voice(page)).spoken.join("\n")).toContain("en: There is something to approve. Please decide on the screen.");
  // anything said meanwhile is not sent and does not answer the card
  const asked = (await sends(page)).length;
  await hear(page, "yes allow it");
  await page.waitForTimeout(2_500);
  expect((await sends(page)).length).toBe(asked);
  await expect(page.getByTestId("card-approval")).toBeVisible();
  expect((await voice(page)).calls.filter((c) => c.startsWith("listen"))).toHaveLength(2);

  // decided on the card, as always: the agent goes on, its answer is read, and voice mode listens again
  const heardBefore = (await voice(page)).spoken.length;
  await page.getByTestId("card-approval").getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(async () => (await voice(page)).spoken.length, { timeout: 10_000 }).toBeGreaterThan(heardBefore);
  await expect(strip).toHaveAttribute("data-phase", "speaking");
  await page.evaluate(() => (window as any).__manutVoice.doneSpeaking());
  await expect(strip).toHaveAttribute("data-phase", "listening");

  // one press stops it
  await page.getByTestId("voice-stop").click();
  await expect(strip).toHaveCount(0);
  await expect(page.getByTestId("voice-mode")).toHaveAttribute("aria-pressed", "false");
});
