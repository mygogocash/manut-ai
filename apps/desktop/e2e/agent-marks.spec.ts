// Each provider by its own logo (the owner's request of 26 Nov 2026): every published mark and every monogram, drawn
// on the app's tokens at a row's size and the header's, in light and dark. MARKS_SHOTS=<dir> keeps the pictures.
import { expect, test } from "@playwright/test";
import { join } from "node:path";

const SHOTS = process.env.MARKS_SHOTS;

for (const theme of ["light", "dark"] as const) {
  test(`every published mark and every monogram stands in its box, in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 420 });
    await page.goto(`/e2e/agents.html?theme=${theme}`);
    const grid = page.getByTestId("agent-grid");
    // 23 published marks and 6 monograms (OmO, DSH, oh-my-hermes, oh-my-pi, VS Code, and Xcode, since Apple's marks are
    // never drawn), each drawn twice
    await expect(grid.locator("[data-testid^=agent-cell-]")).toHaveCount(29);
    await expect(grid.locator('svg.agent-ic:not([data-agent="letter"])')).toHaveCount(46);
    await expect(grid.locator('.agent-mono[data-agent="letter"]')).toHaveCount(12);
    await expect(grid.getByTestId("agent-cell-xcode").locator('svg[data-agent="xcode"]')).toHaveCount(0);
    // each mark fills the box it is given, and a monogram's letter is the stylesheet's, centred on its tile
    const boxes = await grid.locator(".agent-ic").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(new Set(boxes)).toEqual(new Set([22, 16]));
    const mono = grid.getByTestId("agent-cell-omo").locator(".agent-mono").last();
    expect(await mono.evaluate((e) => [getComputedStyle(e, "::before").content, e.textContent, getComputedStyle(e).fontWeight])).toEqual(['"O"', "", "600"]);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `marks-${theme}.png`) });
  });
}
