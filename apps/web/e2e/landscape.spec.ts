import { expect, test } from "./fixtures";

// `index.html` asks for the whole screen (`viewport-fit=cover`), and nothing in the pages pads for a notch. That is safe
// as long as the column stays clear of where a notch is, and it does because the column is at most 560px wide and
// centred: on a phone turned on its side it starts well in from each edge. This turns each Chromium phone on its side,
// gives it a notch's insets through the DevTools protocol (WebKit cannot be given any), and checks the column is clear of
// them, so widening the column or dropping its centring fails here instead of on an iPhone.
//
// The insets are a Dynamic Island iPhone's in landscape (about 59px at each side) rounded up, and the home bar's below.
const INSETS = { top: 0, left: 60, bottom: 21, right: 60 };

test.describe("a phone on its side, with a notch", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "Only Chromium can be given a notch's insets");

  for (const [name, path, shows] of [
    ["a reply that waits", "/approve/demo", "Sends a reply to Khun Ploy on LINE."],
    ["a long Thai reply that waits", "/approve/demo-long-thai", "Sends a reply to ศิริพรรณเจริญสุขสวัสดิ์ on LINE."],
    ["the shop's data that waits", "/delete/demo-delete", "Delete everything Manut AI stores for Khao Soi Nimman?"],
  ] as const) {
    test(`keeps ${name} clear of the notch`, async ({ page }) => {
      const portrait = page.viewportSize();
      if (!portrait) throw new Error("the project has no screen size");
      // Turned on its side: the same screen, wide instead of tall.
      await page.setViewportSize({ width: portrait.height, height: portrait.width });
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setSafeAreaInsetsOverride", { insets: INSETS });

      await page.goto(path);
      await expect(page.getByText(shows).first()).toBeVisible();
      // The insets reach the page as `env(safe-area-inset-*)`, which is what a page that padded for them would read.
      const seen = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)";
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const insets = { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
        probe.remove();
        return insets;
      });
      expect(seen, "the emulated insets reach the page").toEqual({ left: INSETS.left, right: INSETS.right });

      // Every box in the column, from its left edge to its right, sits between the insets.
      const edges = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll("main, main *")).map((element) => element.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
        return { left: Math.min(...boxes.map((box) => box.left)), right: Math.max(...boxes.map((box) => box.right)), width: window.innerWidth };
      });
      expect(edges.left, "the column's left edge").toBeGreaterThanOrEqual(INSETS.left);
      expect(edges.right, "the column's right edge").toBeLessThanOrEqual(edges.width - INSETS.right);
    });
  }
});
