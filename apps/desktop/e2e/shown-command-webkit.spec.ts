// What an approval card shows of a command that holds characters that do not show, or that reorder what does (item 121),
// in WebKit, the macOS web view's engine, whose bidi algorithm drew `echo 'Tests passed' '; rm -rf src .git; echo done'`
// for a line whose `rm` runs. Each such character is a visible mark (`⟨U+202E⟩`), the line reads in the order it runs,
// and the card says the command holds hidden characters, in light and in dark.
//
// SHOWN_SHOTS=<dir> keeps a picture of each card as a PNG (webkit-<theme>-<name>.png). Without it the spec still checks
// each one.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, webkit, type Page } from "@playwright/test";
import { chatOpen, startDone } from "./start";

test.use({ browserName: "webkit" });
// Only the macOS window is WebKit (Windows' is WebView2, Chromium). CI's macOS job installs WebKit for this spec;
// a local run on a Mac without it (`pnpm exec playwright install webkit`) skips it.
test.skip(
  process.platform !== "darwin" || (!process.env.CI && !existsSync(webkit.executablePath())),
  "WebKit is the macOS webview only; install it with `pnpm exec playwright install webkit` to run this locally",
);

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const DIR = process.env.SHOWN_SHOTS || "";
const THEMES = ["light", "dark"] as const;

async function mock(op: string, params: Record<string, unknown> = {}): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res) => (ws.onopen = () => res()));
  await new Promise<void>((res) => {
    ws.onmessage = (m) => JSON.parse(String(m.data)).id === "w1" && res();
    ws.send(JSON.stringify({ id: "w1", op, ...params }));
  });
  ws.close();
}

/** The second security read's line (26 Nov): direction controls around a second command. */
const BIDI = "echo 'Tests passed' ‮⁦; rm -rf src .git; echo ⁩'‬done'";
const SHOWN = "echo 'Tests passed' ⟨U+202E⟩⟨U+2066⟩; rm -rf src .git; echo ⟨U+2069⟩'⟨U+202C⟩done'";
/** No direction control, only characters with no width: a zero-width space, a joiner, a soft hyphen and a tag. */
const ZERO = "git push origin main​ ⁠--force­ \u{e0041}";
const ZERO_SHOWN = "git push origin main⟨U+200B⟩ ⟨U+2060⟩--force⟨U+00AD⟩ ⟨U+E0041⟩";

async function open(page: Page, theme: (typeof THEMES)[number]) {
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await page.goto("/");
  await chatOpen(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await startDone(page);
}

test.beforeEach(async () => {
  await mock("mock.reset");
});

for (const theme of THEMES) {
  test(`${theme}: a command's hidden characters are marks, it reads in the order it runs, and the card says so`, async ({ page }) => {
    await open(page, theme);
    await mock("mock.emit", {
      events: [
        { event: "turn.start", bot: "kami" },
        { event: "approval.request", bot: "kami", request_id: "hw-bidi", title: "Run ‮tset‬", command: BIDI, choices: ["deny", "once", "session"] },
        { event: "approval.request", bot: "kami", request_id: "hw-zero", title: "Push", command: ZERO, choices: ["deny", "once", "session"] },
      ],
    });
    const cards = page.getByTestId("timeline").getByTestId("card-approval");
    await expect(cards).toHaveCount(2);
    for (const [i, [name, shown]] of ([["bidi", SHOWN], ["zero", ZERO_SHOWN]] as const).entries()) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      const block = card.getByTestId("card-command");
      expect(await block.evaluate((el) => el.textContent)).toBe(shown);
      // drawn in the order it runs: what WebKit lays out from left to right is the text itself, no run reversed
      expect(await block.evaluate((el) => (el as HTMLElement).innerText)).toBe(shown);
      expect(await block.evaluate((el) => /[​-‏‪-‮⁠-⁯­﻿]/u.test(el.textContent ?? ""))).toBe(false);
      await expect(card.getByTestId("card-cmd-hidden")).toHaveText("This command holds hidden characters. Each is shown here as a mark like ⟨U+202E⟩.");
      if (DIR) {
        mkdirSync(DIR, { recursive: true });
        await card.screenshot({ path: join(DIR, `webkit-${theme}-${name}.png`), animations: "disabled" });
      }
    }
    // the title is marked too
    await expect(cards.nth(0).locator(".card-title")).toHaveText("Run ⟨U+202E⟩tset⟨U+202C⟩");
  });
}
