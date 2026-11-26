// The sidebar as an inbox (item 94): a row's mark taken back with Undo (the quiet toast and ⌘Z on the row), several rows
// selected and acted on at once, and the Working group. `INBOX_SHOTS=<dir>` keeps a picture of each in light and dark.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { usePlatform } from "./term-find-helpers";
import { chatOpen } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "in1") res(msg);
    };
    ws.send(JSON.stringify({ id: "in1", op, ...params }));
  });
  ws.close();
  return reply.result;
}

const DIR = process.env.INBOX_SHOTS || "";
const shot = async (page: Page, name: string) => {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `${name}.png`) });
};

const TITLES = ["Late parcels", "The 12.12 teaser", "Check the books"];

async function begin(page: Page, theme: "light" | "dark") {
  await mock("mock.reset");
  await mock("mock.threads", { bot: "kami", threads: TITLES.map((title, i) => ({ title, ago: 60 * (i + 1) })) });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript((t) => localStorage.setItem("manut.theme", t), theme);
  await usePlatform(page);
  await page.goto("/");
  await chatOpen(page);
  await expect(page.getByTestId("menu-recent")).toHaveCount(3);
}

/** Kami's thread `title` starts or ends a turn, as the store hears it from the runtime (a turn's end is its newest activity). */
async function turn(page: Page, title: string, running: boolean) {
  await page.evaluate(
    async ([title, running]) => {
      const m = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { getState(): { threads: Record<string, { title: string }[]> }; dispatch(a: unknown): void } };
      const st = m.getStore();
      const row = st.getState().threads.kami!.find((r) => r.title === title)!;
      st.dispatch({ type: "thread.upsert", bot: "kami", row: { ...row, running, last: Date.now() / 1000 } });
    },
    [title, running] as const,
  );
}

const recent = (page: Page, title: string) => page.locator(".sb-recent .rec-li").filter({ hasText: title });
const isMac = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));

for (const theme of ["light", "dark"] as const) {
  test.describe(`the inbox (${theme})`, () => {
    test("Done for now is taken back by the toast's Undo, and by ⌘Z on the row", async ({ page }) => {
      await begin(page, theme);
      const row = recent(page, "Late parcels");
      await row.hover();
      await row.getByTestId("row-more").click();
      await page.getByTestId("row-settle").click();
      await expect(row).toHaveAttribute("data-place", "settled");
      const toast = page.getByTestId("row-undo-toast");
      await expect(toast).toContainText("Done for now: Late parcels");
      await shot(page, `undo-toast-${theme}`);
      await toast.getByTestId("row-undo").click();
      await expect(row).not.toHaveAttribute("data-place", "settled");
      await expect(toast).toHaveCount(0);

      // again, and this time the key: the focus went back to the row's "more" button, in the side menu
      await row.hover();
      await row.getByTestId("row-more").click();
      await page.getByTestId("row-settle").click();
      await expect(row).toHaveAttribute("data-place", "settled");
      await expect(row.getByTestId("row-more")).toBeFocused();
      await page.keyboard.press((await isMac(page)) ? "Meta+z" : "Control+Shift+z");
      await expect(row).not.toHaveAttribute("data-place", "settled");
      await expect(page.getByTestId("row-undo-toast")).toHaveCount(0);
    });

    test("Snooze until a picked time: a time that has passed is refused, a later one puts the row away", async ({ page }) => {
      await begin(page, theme);
      const row = recent(page, "Check the books");
      await row.hover();
      await row.getByTestId("row-more").click();
      await page.getByTestId("row-snooze").click();
      // no turn runs in this chat, so there is no Until it finishes
      await expect(page.getByTestId("row-snooze-done")).toHaveCount(0);
      await page.getByTestId("row-snooze-pick").click();
      await expect(page.getByTestId("row-pick-date")).toBeFocused();
      await page.getByTestId("row-pick-date").fill("2020-01-01");
      await page.getByTestId("row-pick-go").click();
      await expect(page.getByTestId("row-pick-late")).toBeVisible();
      await shot(page, `snooze-pick-${theme}`);
      const tomorrow = await page.evaluate(() => {
        const d = new Date(Date.now() + 86_400_000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
      await page.getByTestId("row-pick-date").fill(tomorrow);
      await page.getByTestId("row-pick-time").fill("09:30");
      await page.getByTestId("row-pick-go").click();
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId("row-undo-toast")).toContainText("Snoozed: Check the books");
      await page.getByTestId("row-undo").click();
      await expect(row).toHaveCount(1);
    });

    test("the Working group is off by default; on, a working chat waits there and is back on top when it finishes", async ({ page }) => {
      await begin(page, theme);
      // off by default: Settings says so, and a working chat stays in Recent
      await page.getByTestId("nav-settings").click();
      await expect(page.getByTestId("set-inbox")).toBeVisible();
      await expect(page.getByTestId("set-working")).toHaveAttribute("aria-checked", "false");
      await turn(page, "The 12.12 teaser", true);
      await expect(page.getByTestId("menu-working")).toHaveCount(0);
      await expect(recent(page, "The 12.12 teaser")).toHaveCount(1);
      await page.getByTestId("set-working").click();
      await expect(page.getByTestId("set-working")).toHaveAttribute("aria-checked", "true");
      await shot(page, `working-setting-${theme}`);
      const group = page.getByTestId("menu-working");
      await expect(group).toContainText("The 12.12 teaser");
      await expect(page.locator(".sb-recent:not(.sb-working) .rec-li").filter({ hasText: "The 12.12 teaser" })).toHaveCount(0);
      await shot(page, `working-group-${theme}`);
      // its turn ends: back in Recent, on top
      await turn(page, "The 12.12 teaser", false);
      await expect(group).toHaveCount(0);
      await expect(page.getByTestId("menu-recent").first()).toHaveText("The 12.12 teaser");
    });

    test("⌘Z in the chat box leaves a row's mark alone", async ({ page }) => {
      await begin(page, theme);
      const row = recent(page, "The 12.12 teaser");
      await row.hover();
      await row.getByTestId("row-more").click();
      await page.getByTestId("row-pin").click();
      await expect(row).toHaveAttribute("data-place", "pinned");
      await page.getByTestId("composer").focus();
      await page.keyboard.press((await isMac(page)) ? "Meta+z" : "Control+Shift+z");
      await expect(row).toHaveAttribute("data-place", "pinned");
      await expect(page.getByTestId("row-undo-toast")).toContainText("Pinned: The 12.12 teaser");
    });
  });
}
