// Themes for the whole app and the chat width (item 99b; the owner chose full themes on 27 Nov 2026). In Settings › General
// › Appearance the person imports a VS Code theme (the test's own, written as VS Code writes them: src/theme/__fixtures__)
// and every screen takes its colours, the terminal included; a theme whose text cannot be read is refused with why; they
// make a theme of their own from it, change its colours (a change that would make text unreadable is refused), rename it,
// keep it across a restart, widen and narrow the chat, go back to the brand's look, and delete the theme. THEME_SHOTS=1
// keeps pictures of the steps in e2e/__shots__.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chatOpen } from "./start";
import { tokenColor } from "./tokens";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);
const HERE = dirname(fileURLToPath(import.meta.url));
const HARBOR = join(HERE, "..", "src", "theme", "__fixtures__", "harbor-night-color-theme.json");
const SHOTS = process.env.THEME_SHOTS ? join(HERE, "__shots__") : null;

test.use({ colorScheme: "dark" });

async function mock(op: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  await new Promise<void>((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: "t1", op }));
  });
  ws.close();
}

test.beforeEach(async ({ page }) => {
  await mock("mock.reset");
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("kept")) for (const k of ["manut.look", "manut.theme", "manut.themes"]) localStorage.removeItem(k);
  });
});

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const bg = (page: Page, testId: string) => page.getByTestId(testId).first().evaluate((e) => getComputedStyle(e).backgroundColor);
const shot = async (page: Page, name: string, at?: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  if (at) await page.getByTestId(at).evaluate((e) => e.scrollIntoView({ block: "start" }));
  await page.mouse.move(700, 790);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("imports a VS Code theme, makes and edits one of its own, keeps it, sets the chat width, and goes back to the brand's look", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await chatOpen(page);
  const brand = { bg: await tokenColor(page, "--bg"), side: await tokenColor(page, "--side"), body: await tokenColor(page, "--body") };
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("appearance")).toBeVisible();
  await expect(page.getByTestId("theme-pick")).toHaveValue("manut");
  await shot(page, "themes-brand", "width-seg");

  // import: every screen takes the theme's colours, read from the page
  await page.getByTestId("theme-file").setInputFiles(HARBOR);
  await expect(page.getByTestId("theme-note")).toHaveText("Imported Harbor Night: 34 colours read from the file, the rest worked out from them.");
  await expect(page.getByTestId("theme-pick").locator("option:checked")).toHaveText("Harbor Night");
  await expect(page.locator("html")).toHaveAttribute("data-palette", /^mine-[a-z0-9]+$/);
  expect(await tokenColor(page, "--bg")).toBe(rgb("#1b2330"));
  expect(await tokenColor(page, "--side")).toBe(rgb("#161d28"));
  expect(await tokenColor(page, "--body")).toBe(rgb("#d8dee9"));
  expect(await tokenColor(page, "--accent")).toBe(rgb("#7fb4ff"));
  expect(await bg(page, "sidebar")).toBe(rgb("#161d28"));
  expect(await bg(page, "appearance-preview")).toBe(rgb("#1b2330"));
  // one stylesheet does it, after the brand's
  await expect(page.locator("head > style#manut-theme")).toHaveCount(1);
  await shot(page, "themes-imported", "width-seg");

  // the terminal takes the theme's terminal colours where manut's own would be
  await page.getByTestId("settings-nav-terminal").click();
  await expect(page.getByTestId("term-theme-manut-dark")).toHaveAttribute("title", "Harbor Night");
  await expect(page.getByTestId("term-theme-manut-dark")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("settings-nav-general").click();

  // a theme whose text cannot be read is refused, with why, and the one in force stays
  await page.getByTestId("theme-file").setInputFiles({
    name: "dim-color-theme.json",
    mimeType: "application/json",
    buffer: Buffer.from('// dim\n{ "name": "Dim", "colors": { "editor.background": "#1e1e1e", "editor.foreground": "#5a5a5a", }, }'),
  });
  await expect(page.getByTestId("theme-note")).toHaveText(/^Not imported: text would read at \d\.\d to 1 on [a-z ]+, and text needs 4\.5 to 1\.$/);
  await expect(page.getByTestId("theme-pick").locator("option")).toHaveText(["Manut AI", "Harbor Night"]);
  expect(await tokenColor(page, "--bg")).toBe(rgb("#1b2330"));
  // and a file that is not a theme
  await page.getByTestId("theme-file").setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from("not json at all") });
  await expect(page.getByTestId("theme-note")).toHaveText("Not imported: it is not a theme file Manut AI can read (JSON, comments allowed).");

  // make one's own from it, and change its background
  await page.getByTestId("theme-make").click();
  await expect(page.getByTestId("theme-note")).toHaveText("Made Harbor Night copy from the look you had. Change its colours below.");
  await expect(page.getByTestId("theme-pick").locator("option:checked")).toHaveText("Harbor Night copy");
  await page.getByTestId("theme-colour-background").fill("#2a1f33");
  await expect.poll(() => tokenColor(page, "--bg")).toBe(rgb("#2a1f33"));
  expect(await bg(page, "appearance-preview")).toBe(rgb("#2a1f33"));
  // the side menu is its own colour
  await page.getByTestId("theme-colour-side").fill("#22192a");
  await expect.poll(() => bg(page, "sidebar")).toBe(rgb("#22192a"));
  // text the eye cannot read on it is refused, with why; the text stays as it was
  await page.getByTestId("theme-colour-text").fill("#3a2f43");
  await expect(page.getByTestId("theme-err-text")).toHaveText(/^Not changed: text would read at \d\.\d to 1 on [a-z ]+, and text needs 4\.5 to 1\.$/);
  expect(await tokenColor(page, "--body")).toBe(rgb("#d8dee9"));
  await shot(page, "themes-refused", "theme-pick");
  // a readable one is kept
  await page.getByTestId("theme-colour-text").fill("#f4e9ff");
  await expect.poll(() => tokenColor(page, "--body")).toBe(rgb("#f4e9ff"));
  await expect(page.getByTestId("theme-err-text")).toHaveCount(0);
  // renamed
  await page.getByTestId("theme-name").fill("Plum Harbor");
  await page.getByTestId("theme-name").press("Enter");
  await expect(page.getByTestId("theme-pick").locator("option:checked")).toHaveText("Plum Harbor");
  await shot(page, "themes-own", "theme-pick");

  // kept on this Mac: a restart opens in it
  const id = await page.locator("html").getAttribute("data-palette");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.evaluate(() => sessionStorage.setItem("kept", "1"));
  await page.reload();
  await chatOpen(page);
  await expect(page.locator("html")).toHaveAttribute("data-palette", id!);
  expect(await tokenColor(page, "--bg")).toBe(rgb("#2a1f33"));
  expect(await bg(page, "sidebar")).toBe(rgb("#22192a"));

  // the chat width moves the chat's column and its box
  const box = () => page.locator(".cw").first().evaluate((e) => Math.round(e.getBoundingClientRect().width));
  expect(await box()).toBe(696);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("width-seg").getByRole("radio", { name: "Wide" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.poll(box).toBe(880);
  await shot(page, "themes-chat-wide");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("width-seg").getByRole("radio", { name: "Narrow" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.poll(box).toBe(600);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("manut.look"))) ?? "{}")).toMatchObject({ palette: id, width: "narrow" });

  // back to the brand's look: its own values, no theme stylesheet
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("theme-pick").selectOption("manut");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "manut");
  expect(await tokenColor(page, "--bg")).toBe(brand.bg);
  expect(await tokenColor(page, "--side")).toBe(brand.side);
  expect(await tokenColor(page, "--body")).toBe(brand.body);
  await expect(page.locator("style#manut-theme")).toHaveCount(0);
  await expect(page.getByTestId("theme-editor")).toHaveCount(0);

  // and the theme of their own deleted, after a second press
  await page.getByTestId("theme-pick").selectOption({ label: "Plum Harbor" });
  await page.getByTestId("theme-delete").click();
  await page.getByTestId("theme-delete-no").click();
  await expect(page.getByTestId("theme-pick").locator("option")).toHaveText(["Manut AI", "Harbor Night", "Plum Harbor"]);
  await page.getByTestId("theme-delete").click();
  await page.getByTestId("theme-delete-yes").click();
  await expect(page.getByTestId("theme-note")).toHaveText("Deleted Plum Harbor.");
  await expect(page.getByTestId("theme-pick").locator("option")).toHaveText(["Manut AI", "Harbor Night"]);
  await expect(page.locator("html")).toHaveAttribute("data-palette", "manut");
  expect(await tokenColor(page, "--bg")).toBe(brand.bg);
});

test("a light theme picked while the app is dark turns the app light, and its colours apply there", async ({ page }) => {
  await page.goto("/");
  await chatOpen(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("theme-file").setInputFiles({
    name: "paper-color-theme.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ name: "Paper", type: "light", colors: { "editor.background": "#f6f1e7", "editor.foreground": "#2b2621" } })),
  });
  await expect(page.getByTestId("theme-note")).toContainText("Imported Paper");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("theme-seg").getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
  expect(await tokenColor(page, "--bg")).toBe(rgb("#f6f1e7"));
  await expect(page.getByTestId("colours-hint")).toHaveText("A light theme: while the app is dark, the brand's dark look shows");
  // in dark the brand's dark look shows
  await page.getByTestId("theme-seg").getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await tokenColor(page, "--bg")).toBe(rgb("#171716"));
});
