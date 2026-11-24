import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The buttons an owner presses, pressed the way a thumb does: with touch events, on each phone. owner-pages.spec.ts
// already taps Approve, Allow and No on its way to each state it measures (the permission step, a send under way, a
// send that fails); this goes through what each button does, step by step, and presses the ones that spec does not:
// Not now, the deletion page's two buttons, and Try again. A tap fails here when something covers the button or when
// a press does not do what its words say. Colour changes nothing a button does, so these run in light only.
//
// Practice mode sends nothing and deletes nothing real; the fake settles a send about five seconds after the press.

const tap = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).tap();
const shows = (page: Page, text: string | RegExp) => expect(page.getByText(text).first()).toBeVisible();

test("Approve asks for the one-time permission, Not now goes back, and Allow sends the reply", async ({ page }) => {
  await page.goto("/approve/demo");
  await tap(page, "Approve");
  await shows(page, "Allow Manut AI to send messages for Baan Mali on LINE");

  // Not now: back to the request, nothing sent, and the question is still there to answer.
  await tap(page, "Not now");
  await shows(page, "Sends a reply to Khun Ploy on LINE.");
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();

  // Approve again, give the permission, and the reply goes: under way first, then sent.
  await tap(page, "Approve");
  await tap(page, "Allow and send this reply");
  await shows(page, "Approved. Sending the reply to Khun Ploy.");
  await shows(page, "Approved. Nam sent the reply to Khun Ploy.");
  await expect(page.getByRole("button")).toHaveCount(0);

  // The permission is given once: another reply of the same shop goes without asking again.
  await page.goto("/approve/demo-unknown");
  await tap(page, "Approve");
  await shows(page, "Approved. Sending the reply to");
});

test("No declines the reply, and nothing is sent", async ({ page }) => {
  await page.goto("/approve/demo");
  await tap(page, "No");
  await shows(page, "You said no. Nothing was sent to Khun Ploy.");
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("Keep my data keeps the shop's data", async ({ page }) => {
  await page.goto("/delete/demo-delete");
  await tap(page, "Keep my data");
  await shows(page, "You kept your data. Nothing was deleted.");
  await expect(page.getByRole("button")).toHaveCount(0);
});

test("Delete everything deletes the shop's data (a practice shop's)", async ({ page }) => {
  await page.goto("/delete/demo-delete");
  await tap(page, "Delete everything");
  await shows(page, "Done. Khao Soi Nimman's data is deleted.");
  await expect(page.getByRole("button")).toHaveCount(0);
});

for (const [name, path] of [["approval", "/approve/demo-offline"], ["deletion", "/delete/demo-delete-offline"]] as const) {
  test(`Try again asks for the ${name} page's request again`, async ({ page }) => {
    await page.goto(path);
    await shows(page, "Could not load this request");
    // The page swaps the notice for its loading skeleton while it asks again; a watcher records that it did, because
    // the skeleton is on screen for only as long as the practice fake takes to answer.
    await page.evaluate(() => {
      const seen = window as unknown as { __askedAgain?: boolean };
      new MutationObserver(() => {
        if (document.querySelector("[aria-busy='true']")) seen.__askedAgain = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await tap(page, "Try again");
    await page.waitForFunction(() => (window as unknown as { __askedAgain?: boolean }).__askedAgain === true);
    // The sample connection stays down, so the notice is back, with its button.
    await shows(page, "Could not load this request");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  });
}
