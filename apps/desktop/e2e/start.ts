// How a spec reaches the screen it tests, now that the app opens on Home and the design canvas's side menu
// (src/sidebar/Sidebar.tsx) has replaced the list of bots and the TERMINALS section (docs/decisions.md, 23 Nov 2026).
//
// Every spec starts as a returning person who left Kami's chat open. playwright.config.ts seeds `manut.resume`, the
// snapshot src/app/resume.ts writes before the app closes, with Kami's main chat, so the app opens on that chat
// through the same start a restart takes: no click, no page in between, and the same bridge calls the specs were
// written against. A spec that removes `manut.resume` before the page loads starts on Home, as a first run does.
import { expect, type Page } from "@playwright/test";
import { HOOD_PAGES } from "../src/settings/pages";

/** The mock bridge's members and the names their chat headers show (BOT_SEED in e2e/mock-bridge.mjs). */
export const MEMBERS: Readonly<Record<string, string>> = { kami: "Kami", friren: "Friren", default: "Hermes", "omh-tui": "OMH TUI" };

/** A `manut.resume` snapshot (src/app/resume.ts, version 1) that opens `bot`'s main chat at start. */
export function chatResume(bot = "kami"): string {
  return JSON.stringify({ v: 1, at: Date.now(), bot, view: "chat", session: null, panelOpen: false, panelTab: "details", runsFull: false, runId: null, drafts: {}, sessions: [] });
}

/** `bot`'s main chat fills the main column. The menu marks Team only once the member list has answered and a member's
 *  main chat (not a thread) is open, and the chat's header names the member. Together they say what the bot row's
 *  aria-current="true" said before the menu replaced the rows. `name` is the member's name as the header shows it,
 *  for a spec that renamed it. */
export async function chatOpen(page: Page, bot = "kami", name = MEMBERS[bot] ?? bot): Promise<void> {
  await expect(page.getByTestId("menu-team")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("who").locator(".head-title")).toHaveText(name);
}

/** The whole start is done: every listed member's chat and threads were read too, not only the open one (the store's
 *  `resumed`). A spec saw that before in the bot rows' previews, which left with the sidebar. */
export async function startDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = (await import(/* @vite-ignore */ "/src/state/store.ts" as string)) as { getStore(): { resumed: Promise<void> } };
    await store.getStore().resumed;
  });
}

/** Open `bot`'s main chat as a person does now: Team in the menu, then the member's row. */
export async function openChat(page: Page, bot: string, name?: string): Promise<void> {
  await page.getByTestId("menu-team").click();
  await page.getByTestId(`team-${bot}`).click();
  await chatOpen(page, bot, name);
}

/** The app started on Home: a first run, or a start without `manut.resume`. Home replaces the chat only once the
 *  member list has answered, so a menu row pressed after this is not undone by the rest of the start. */
export async function homeOpen(page: Page): Promise<void> {
  await expect(page.getByTestId("page-home")).toBeVisible();
}

/** The Code page, where the terminal sessions of the old TERMINALS section and the Tasks row now live. */
export async function openCode(page: Page): Promise<void> {
  await page.getByTestId("menu-code").click();
  await expect(page.getByTestId("page-code")).toBeVisible();
}

/** Automations or Plugins: entries of the Customize page now, where the sidebar's foot buttons went. They keep the
 *  buttons' test ids (`nav-automations`, `nav-plugins`). */
export async function openCustomize(page: Page, entry: "automations" | "plugins"): Promise<void> {
  await page.getByTestId("menu-customize").click();
  await page.getByTestId(`nav-${entry}`).click();
}

/** Settings' developer pages, which live under its "Under the hood" entry. */
export const HOOD_IDS: readonly string[] = HOOD_PAGES.map((p) => p.id);

/** Settings is open: its "Under the hood" entry is opened when it is closed, so the developer pages are in its list. A
 *  spec that starts without `manut.settings.hood` (the config seeds it) reaches a developer page this way. */
export async function openHood(page: Page): Promise<void> {
  const hood = page.getByTestId("settings-hood");
  if ((await hood.getAttribute("aria-expanded")) !== "true") await hood.click();
  await expect(page.getByTestId("settings-hood-list")).toBeVisible();
}

/** Open a page of Settings (`accounts`, `terminal`, `bot-kami`...): the menu's account row opens Settings, and
 *  Settings' own list picks the page, under "Under the hood" for a developer page. The old sidebar's "You" row opened
 *  Accounts in one press. */
export async function openSettings(page: Page, id: string): Promise<void> {
  await page.getByTestId("nav-settings").click();
  if (HOOD_IDS.includes(id)) await openHood(page);
  await page.getByTestId(`settings-nav-${id}`).click();
  await expect(page.getByTestId(`settings-page-${id}`)).toBeVisible();
}

/** Open a thread from the History page, which lists every thread of the team: the thread trees under the bot rows
 *  left with the sidebar. History's rows carry no thread id, so the thread is found by its title. */
export async function openThread(page: Page, title: string | RegExp): Promise<void> {
  await page.getByTestId("menu-history").click();
  await page.getByTestId("history-row").filter({ hasText: title }).click();
}

/** Open an ask from the Needs you page, which replaced the sidebar's Needs strip: its row, like the strip's item,
 *  opens the chat with the card scrolled into view and focused. The page lists the newest ask first, where the strip
 *  listed the oldest first, so `nth` counts from the newest. */
export async function openNeed(page: Page, nth = 0): Promise<void> {
  await page.getByTestId("menu-needs").click();
  await page.getByTestId("needs-row").nth(nth).click();
}
