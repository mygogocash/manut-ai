import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/// The `test` every spec in this folder uses. It differs from Playwright's in one thing: the page's request for its
/// web fonts (Geist and IBM Plex Sans Thai, from Google Fonts) is refused, so a run never waits on the network and
/// every run measures the same fallback fonts. The engines' own fonts stand in, and a real phone shows the real
/// ones: docs/phone-pass.md lists that among what only a real phone checks.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    await use(context);
  },
});
