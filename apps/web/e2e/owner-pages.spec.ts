import { expect, test } from "./fixtures";
import { findProblems, percent, setTextScale, TEXT_SCALES } from "./layout";
import { openState, STATES } from "./states";

// Every state of the owner's pages, on every phone project, in light and in dark, at its normal text size and at
// larger ones. One test is one state in one colour scheme: it opens the page once and measures it at each text size,
// so a failure says which size broke it. The checks are in layout.ts and say what they look for.

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });

    for (const state of STATES) {
      test(`${state.page} page: ${state.name}`, async ({ page }) => {
        await openState(page, state);
        // The phone's screen width, from the project: the page cannot be asked, because a page that is too wide widens
        // the width it reports (layout.ts).
        const screen = page.viewportSize()?.width ?? 0;
        expect(screen).toBeGreaterThan(0);
        for (const scale of TEXT_SCALES) {
          await setTextScale(page, scale);
          expect.soft(await findProblems(page, screen), `at ${percent(scale)} text on a ${screen}px screen`).toEqual([]);
        }
      });
    }
  });
}

test("home page lists only states that are checked", async ({ page }) => {
  // The practice home page links every demo state of the owner's pages: approval, deletion, join and the web app. A
  // link added there needs a line in states.ts, or a new state ships without ever being opened on a phone.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Practice mode" })).toBeVisible();
  const links = await page.locator("a[href^='/approve/'], a[href^='/delete/'], a[href^='/join/'], a[href^='/app/']").evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
  );
  expect(links.length).toBeGreaterThan(10);
  const checked = new Set(STATES.map((state) => state.path));
  expect(links.filter((href) => !checked.has(href)), "demo links that no state in e2e/states.ts opens").toEqual([]);
});
