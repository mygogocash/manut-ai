// The Artifacts page and Settings › Artifacts (item 83; src/pages/ArtifactsPage.tsx, src/settings/ArtifactLinksPage.tsx): publishing
// public links is off until the person turns it on, and while it is off the page says so and offers nothing; on, in Practice, Share
// still says why it cannot be used, since a link needs a shop's account on the API. No request reaches an API path either way. The
// page asks for the app's own runtime (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts), as memory-routines.spec.ts does: the suite's server
// is built for the mock bridge. What is published, and the ask before it, are tested against the connected runtime in
// src/runtime/http/artifacts.test.ts.
import { expect, test } from "@playwright/test";

const PORT = Number(process.env.MANUT_PORT || 5307);

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [
          { name: "manut.onboarded", value: "1" },
          { name: "manut.lang", value: "en" },
          { name: "manut.notify.quiet", value: "00:00-00:00" },
        ],
      },
    ],
  },
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __MANUT_IN_PROCESS__: boolean }).__MANUT_IN_PROCESS__ = true;
  });
});

test("publishing links is off until turned on in Settings, and Practice says why Share cannot be used, sending nothing", async ({ page }) => {
  const api: string[] = [];
  page.on("request", (r) => {
    if (/\/v1\//.test(r.url())) api.push(`${r.method()} ${r.url()}`);
  });
  await page.goto("/");
  await page.getByTestId("menu-artifacts").click();
  await expect(page.getByTestId("page-artifacts")).toBeVisible();
  await expect(page.getByTestId("art-why")).toHaveAttribute("data-state", "switched_off");
  await expect(page.getByTestId("art-why")).toContainText("Publishing public links is off on this Mac.");
  await expect(page.getByTestId("art-share")).toBeDisabled();

  // the note's button opens Settings › Artifacts, where the switch is off
  await page.getByTestId("art-open-settings").click();
  await expect(page.getByTestId("artifact-links-page")).toBeVisible();
  const toggle = page.getByTestId("art-set-publish");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  // back on the page, Practice has no links: Share stays off and says why
  await page.getByTestId("art-set-open").click();
  await expect(page.getByTestId("art-why")).toHaveAttribute("data-state", "practice");
  await expect(page.getByTestId("art-why")).toContainText("Public links can be made once Manut AI is connected to your shop.");
  await expect(page.getByTestId("art-share")).toBeDisabled();
  await expect(page.getByTestId("art-ask")).toHaveCount(0);
  expect(api).toEqual([]);
});
