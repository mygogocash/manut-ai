// Customize › Connections in Practice: the owner adding a sign-in to the vault and choosing who may use one
// (src/pages/ConnectionsPane.tsx; docs/browser-control.md, "The owner's Connections"). Practice keeps the canvas's two sample
// sign-ins for the person's own shop and changes them by the vault's rules (src/runtime/mock/vault.ts), so both can be walked
// with no API: an address that is not https said plainly, a page's address kept as its site's part, the password gone from
// the page once Add is pressed, and the members ticked. Practice is the app's own runtime, so the page asks for it
// (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the mock bridge, which has no vault.
import { expect, test, type Page } from "@playwright/test";

const PORT = Number(process.env.MANUT_PORT || 5307);
// Made up for this file, and never a real password: a search for it finds only what this file typed.
const PASSWORD = "practice-typed-pw-5e2d";

test.use({
  storageState: {
    cookies: [],
    origins: [
      {
        origin: `http://127.0.0.1:${PORT}`,
        localStorage: [
          { name: "manut.onboarded", value: "1" },
          { name: "manut.lang", value: "en" },
          // quiet hours would hold notifications back by the hour the suite runs at
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

/** Opens Customize › Connections as a person does, and waits for the vault to be read. */
async function openConnections(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("menu-customize").click();
  await page.getByTestId("customize-tab-connections").click();
  await expect(page.getByTestId("signin")).toHaveCount(2);
}

const row = (page: Page, site: string) => page.getByTestId("signin").filter({ hasText: site });

test("adds a sign-in: https only, said plainly, a page's address kept as its site's part, and the password gone once added", async ({ page }) => {
  await openConnections(page);
  await page.getByTestId("signin-add").click();
  const form = page.getByTestId("add-form");
  await expect(form).toBeVisible();
  await expect(page.getByTestId("add-site")).toBeFocused();
  const add = page.getByTestId("add-save");
  await expect(add).toBeDisabled();

  await page.getByTestId("add-site").fill("Lazada Seller Center");
  const address = page.getByTestId("add-address");
  await address.first().fill("http://sellercenter.lazada.co.th");
  await expect(page.getByTestId("add-address-problem")).toHaveText("Only addresses that start with https:// work.");
  await address.first().fill("sellercenter.lazada.co.th");
  await expect(page.getByTestId("add-address-problem")).toHaveText("Paste the whole address from your browser, starting with https://.");
  await address.first().fill("https://sellercenter.lazada.co.th/apps/order/list?tab=toship");
  await expect(page.getByTestId("add-address-problem")).toHaveCount(0);
  await expect(page.getByTestId("add-address-kept")).toHaveText("Kept as https://sellercenter.lazada.co.th");

  // A second address of the same site is said to be a repeat, and can be taken out again.
  await page.getByTestId("add-address-more").click();
  await address.nth(1).fill("https://SellerCenter.lazada.co.th");
  await expect(page.getByTestId("add-address-problem")).toHaveText("This address is already in the list.");
  await page.getByTestId("add-address-remove").nth(1).click();
  await expect(address).toHaveCount(1);

  await page.getByTestId("add-username").fill("baan.mali@example.com");
  await page.getByTestId("add-password").fill(PASSWORD);
  await expect(add).toBeDisabled();
  // Nobody is ticked until the owner says who.
  for (const member of ["nam", "pim", "ton", "kit"]) await expect(page.getByTestId(`member-${member}`)).not.toBeChecked();
  await page.getByTestId("member-ton").check();
  await page.getByTestId("member-nam").check();
  await expect(add).toBeEnabled();
  await add.click();

  await expect(page.getByTestId("vault-notice")).toHaveText("Added Lazada Seller Center to the vault. Nam and Ton may use it from now on.");
  await expect(form).toHaveCount(0);
  await expect(page.getByTestId("signin")).toHaveCount(3);
  const added = row(page, "Lazada Seller Center");
  await expect(added.getByTestId("signin-line")).toHaveText("Used by Nam and Ton");
  await expect(added.getByTestId("signin-tag")).toHaveText("Working");
  // The password is in no field and no word on the page now.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(await page.content()).not.toContain(PASSWORD);
  // The canvas's link is back for the next one.
  await expect(page.getByTestId("signin-add")).toBeEnabled();
});

test("closes Add a sign-in on Escape or Cancel, and keeps nothing that was typed", async ({ page }) => {
  await openConnections(page);
  await page.getByTestId("signin-add").click();
  await page.getByTestId("add-site").fill("Flash Express");
  await page.getByTestId("add-password").fill(PASSWORD);
  await page.getByTestId("add-password").press("Escape");
  await expect(page.getByTestId("add-form")).toHaveCount(0);
  await page.getByTestId("signin-add").click();
  await expect(page.getByTestId("add-site")).toHaveValue("");
  await expect(page.getByTestId("add-password")).toHaveValue("");
  await page.getByTestId("add-cancel").click();
  await expect(page.getByTestId("add-form")).toHaveCount(0);
  expect(await page.content()).not.toContain(PASSWORD);
});

test("chooses who may use a sign-in: those who may now are ticked, Save waits for a change, and the row says who may now", async ({ page }) => {
  await openConnections(page);
  const shopee = row(page, "Shopee Seller Centre");
  await expect(shopee.getByTestId("signin-line")).toContainText("Used by Nam and Ton");
  await shopee.getByTestId("signin-who").click();
  const form = shopee.getByTestId("members-form");
  await expect(form).toContainText("Who may use Shopee Seller Centre");
  await expect(form.getByTestId("member-nam")).toBeChecked();
  await expect(form.getByTestId("member-ton")).toBeChecked();
  await expect(form.getByTestId("member-pim")).not.toBeChecked();
  const save = form.getByTestId("members-save");
  await expect(save).toBeDisabled();
  // Nobody ticked is no answer.
  await form.getByTestId("member-nam").uncheck();
  await form.getByTestId("member-ton").uncheck();
  await expect(save).toBeDisabled();
  await form.getByTestId("member-kit").check();
  await form.getByTestId("member-nam").check();
  await expect(save).toBeEnabled();
  await save.click();

  await expect(page.getByTestId("vault-notice")).toHaveText("Saved. Nam and Kit may use Shopee Seller Centre from now on.");
  await expect(form).toHaveCount(0);
  await expect(shopee.getByTestId("signin-line")).toContainText("Used by Nam and Kit");
  // Nothing else about it changed: it still works, and the refused one still asks for a new password.
  await expect(shopee.getByTestId("signin-tag")).toHaveText("Working");
  await expect(row(page, "Carrier portal").getByTestId("signin-tag")).toHaveText("Needs a new password");
});

test("at Ran Pa Noi, where the person helps, there is nothing to add or choose: only the owner sees the vault", async ({ page }) => {
  await openConnections(page);
  // Choosing a shop shows it on every page, which leaves Customize for the chat; Connections is opened again.
  await page.getByTestId("shop-switch").click();
  await page.getByTestId("shop-menu").getByRole("menuitemradio").nth(1).click();
  await page.getByTestId("menu-customize").click();
  await page.getByTestId("customize-tab-connections").click();
  await expect(page.getByTestId("vault-unavailable")).toHaveText("Only the shop's owner sees and changes its sign-ins and outposts.");
  await expect(page.getByTestId("signin-add")).toHaveCount(0);
  await expect(page.getByTestId("signin-who")).toHaveCount(0);
});
