import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { findProblems, percent, setTextScale } from "./layout";

// The checks in layout.ts are only worth having if they can fail. Each test here puts one known defect on a real page
// and expects the checks to name it, on every phone, so a check that quietly stopped working fails here instead of
// letting every state pass. The text-size emulation is tried the same way: it must make the page's text bigger, in
// text that was there and in text added later.

/// The page's checks after `markup` is added to its `main`.
async function problemsWith(page: Page, markup: string): Promise<string> {
  await page.goto("/approve/demo-expired");
  await page.getByText("This link has expired").first().waitFor();
  await page.evaluate((html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", html), markup);
  return (await findProblems(page, page.viewportSize()?.width ?? 0)).join("\n");
}

test.describe("the checks catch what they are for", () => {
  test("a box wider than the screen scrolls the page sideways", async ({ page }) => {
    const problems = await problemsWith(page, `<div style="width: 700px; height: 20px; background: #f0f"></div>`);
    expect(problems).toContain("The page scrolls sideways");
    expect(problems).toContain("Reaches past the");
  });

  test("a long word runs out of the box that holds it", async ({ page }) => {
    const word = "Pneumonoultramicroscopicsilicovolcanoconiosis".repeat(2);
    const problems = await problemsWith(page, `<section class="box" style="padding: 16px"><p style="margin: 0">${word}</p></section>`);
    expect(problems).toContain("Text sticks out of its box");
  });

  test("a button that cannot wrap pokes out of a card narrower than it", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<section class="box" style="padding: 16px; width: 200px"><button class="btn" style="min-height: 44px">A label that cannot wrap and is long</button></section>`,
    );
    expect(problems).toContain("Crosses the edge of its card");
  });

  test("text in a box that clips is cut off", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<div style="width: 120px; height: 20px; overflow: hidden">Some words that need more than one line to fit in here</div>`,
    );
    expect(problems).toContain("Text is cut off");
  });

  test("a line pulled up over the line above it overlaps", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<p style="margin: 0">The first line of a paragraph</p><p style="margin: -30px 0 0">The second line, drawn on top of it</p>`,
    );
    expect(problems).toContain("Text overlaps other text");
  });

  test("a button under 44px tall or wide is named", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<button class="btn" style="height: 30px; min-height: 0">Short</button><button class="btn" style="width: 30px; min-height: 44px; padding: 0">Thin</button>`,
    );
    expect(problems).toContain("is 30px tall");
    expect(problems).toContain("is 30px wide");
  });

  test("a button with something on top of it is named", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<button class="btn" style="min-height: 44px">Pressed</button><div style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.1)"></div>`,
    );
    expect(problems).toContain("is covered by");
  });

  test("text under a button is named", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<p style="margin: 0">Words that a button was drawn over</p><button class="btn" style="min-height: 44px; margin-top: -30px; background: #ccc">Pressed</button>`,
    );
    expect(problems).toContain("runs under");
  });

  test("a clean card has nothing to report", async ({ page }) => {
    const problems = await problemsWith(
      page,
      `<section class="box" style="padding: 16px"><p style="margin: 0 0 12px">A short, ordinary paragraph that wraps inside its card without trouble.</p><button class="btn" style="min-height: 44px">Fine</button></section>`,
    );
    expect(problems).toBe("");
  });
});

test.describe("the text-size emulation", () => {
  test("makes the page's text bigger, so a fixed-height box that held it at 100% cuts it off at 150%", async ({ page }) => {
    // One line of 14px text fits the 24px box. At 150% the line is 29px tall, so the same words no longer fit it.
    const problems = await problemsWith(
      page,
      `<div style="width: 150px; height: 24px; overflow: hidden; font-size: 14px; line-height: 1.4">Alpha beta</div>`,
    );
    expect(problems, "at normal size").toBe("");
    await setTextScale(page, 1.25);
    await setTextScale(page, 1.5);
    const bigger = (await findProblems(page, page.viewportSize()?.width ?? 0)).join("\n");
    expect(bigger, `at ${percent(1.5)}`).toContain("Text is cut off");
  });

  test("scales text written in a stylesheet, in an inline style, and added after the page loaded", async ({ page }) => {
    await page.goto("/approve/demo");
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await approve.waitFor();
    const sizeOf = (selector: string) =>
      page.locator(selector).first().evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(await sizeOf(".big"), "a heading, from the stylesheet").toBe(17);
    expect(await sizeOf("button.btn"), "a button, from the stylesheet").toBe(13);
    expect(await sizeOf("span.mut"), "the member line, from an inline style").toBe(13);

    await setTextScale(page, 1.5);
    expect(await sizeOf(".big")).toBe(25.5);
    expect(await sizeOf("button.btn")).toBe(19.5);
    expect(await sizeOf("span.mut")).toBe(19.5);

    // Declining swaps the card for another one, whose text the page adds after the emulation was installed.
    await page.getByRole("button", { name: "No", exact: true }).tap();
    await page.getByText("You said no. Nothing was sent to Khun Ploy.").waitFor();
    expect(await sizeOf("span.mut"), "inline text added later").toBe(19.5);
    expect(await sizeOf("p.hint"), "stylesheet text added later").toBe(18.75);

    await setTextScale(page, 1);
    expect(await sizeOf("span.mut")).toBe(13);
  });
});
