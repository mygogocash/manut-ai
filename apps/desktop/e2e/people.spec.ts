// Settings › People in Practice (src/pages/PeoplePane.tsx; docs/people.md): the canvas's sample, Fon the owner, Mint a helper and
// Beam invited, and what the owner can do with them with no API: invite a helper and get a link to send (Manut AI sends nothing),
// copy it, cancel an invite, remove a helper after being asked, set and end the cover, and a shop the person only helps at, which
// has no people to change. Practice is the app's own runtime, so the page asks for it (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts):
// the suite's server is built for the mock bridge, which has no people.
import { expect, test, type Page } from "@playwright/test";

const PORT = Number(process.env.MANUT_PORT || 5307);

test.use({
  permissions: ["clipboard-read", "clipboard-write"],
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

/** Opens Settings › People as a person does: the account row, then People under Shop. */
async function openPeople(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-people").click();
  await expect(page.getByTestId("people-who")).toBeVisible();
}

const rows = (page: Page, testid: string) => page.getByTestId(testid);

test("lists the canvas's sample: the owner marked you, Mint with when they joined, and Beam invited", async ({ page }) => {
  await openPeople(page);
  await expect(page.getByTestId("people-count")).toHaveText("2 people, 1 invited");
  await expect(page.getByTestId("people-owner")).toContainText("Fon (you)");
  await expect(page.getByTestId("people-owner")).toContainText("Owner");
  const mint = rows(page, "people-helper");
  await expect(mint).toHaveCount(1);
  await expect(mint).toContainText("Mint");
  await expect(mint.getByTestId("people-helper-since")).toHaveText(/^Helper since \d{1,2} \w+/);
  await expect(mint.getByTestId("people-helper-account")).toHaveText("mint@example.com. Signed in on 2 devices.");
  const beam = rows(page, "people-invite-row");
  await expect(beam).toHaveCount(1);
  await expect(beam).toContainText("Beam");
  await expect(beam.getByTestId("people-invite-tag")).toHaveText("Invited");
  await expect(beam).toContainText("Nobody can open a LINE invite yet");
  // what the canvas says that is not true of the app as built is not on the page
  await expect(page.getByTestId("people")).not.toContainText(/Usually online|Undo|We send the invite|Helpers are free|Use Code/);
});

test("the roles table holds only what is true: a helper approves messages and replies, and asks the owner about the rest", async ({ page }) => {
  await openPeople(page);
  const role = (id: string) => page.locator(`[data-testid="people-role"][data-role="${id}"]`);
  await expect(role("messages")).toContainText("Approve messages and replies to customers");
  await expect(role("messages").locator("td").nth(1)).toHaveText("Yes");
  for (const id of ["money", "posts", "payments"]) await expect(role(id).locator("td").nth(1)).toHaveText("No, asks you");
  for (const id of ["knows", "change"]) await expect(role(id).locator("td").nth(1)).toHaveText("No");
  await expect(page.getByTestId("people-roles")).not.toContainText(/Use Code|sales|the plan/);
  await expect(page.getByTestId("people-safety")).toContainText("Everyone signs in with their own Apple ID.");
  await expect(page.getByTestId("people-safety")).not.toContainText("LINE or email");
});

test("invites a helper by email: the link is shown with Copy link, the owner sends it, and Manut AI sends nothing", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") outside.push(r.url());
  });
  await openPeople(page);
  await page.getByTestId("people-invite").click();
  const make = page.getByTestId("people-make");
  await expect(make).toBeDisabled();
  await page.getByTestId("people-name").fill("Tum");
  await page.getByTestId("people-contact").fill("tum@example.com");
  await expect(page.getByTestId("people-contact-note")).toHaveText("This invite opens only for someone who signs in with an Apple ID that uses this address.");
  await expect(page.getByTestId("people-invite-form")).toContainText("Manut AI does not send the invite.");
  await expect(page.getByTestId("people-invite-form")).not.toContainText("We send");
  await expect(make).toBeEnabled();
  await make.click();
  // the form is gone, the invite is first in the list and its link is open to copy and send
  await expect(page.getByTestId("people-invite-form")).toHaveCount(0);
  await expect(page.getByTestId("people-who-notice")).toHaveText("The invite for Tum is ready.");
  await expect(page.getByTestId("people-count")).toHaveText("2 people, 2 invited");
  const tum = rows(page, "people-invite-row").first();
  await expect(tum).toContainText("Tum");
  await expect(tum).toContainText("Send this link to Tum yourself. Manut AI does not send it.");
  const link = await page.getByTestId("people-link").inputValue();
  expect(new URL(link).hostname.endsWith(".invalid")).toBe(true);
  // Copy link puts exactly that link on the clipboard
  await page.getByTestId("people-copy-big").click();
  await expect(page.getByTestId("people-copy-big")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  // Done puts the link away; the invite keeps a quiet Copy link of its own
  await page.getByTestId("people-link-done").click();
  await expect(page.getByTestId("people-link-box")).toHaveCount(0);
  await expect(tum.getByTestId("people-copy")).toBeVisible();
  // nothing was sent anywhere outside this computer
  expect(outside).toEqual([]);
});

test("an invite for a LINE ID can be made, and says where it matters that nobody can open it yet", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-invite").click();
  await page.getByTestId("people-name").fill("Nok");
  await page.getByTestId("people-contact").fill("nok.line");
  await expect(page.getByTestId("people-contact-note")).toContainText("Signing in with LINE is not built yet");
  await page.getByTestId("people-make").click();
  const nok = rows(page, "people-invite-row").first();
  await expect(nok).toContainText("Nok");
  await expect(nok).toContainText("Nobody can open a LINE invite yet");
});

test("says in words what it will not make: an empty name, an account that is not one, and a second invite for the same account", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-invite").click();
  await page.getByTestId("people-name").fill("Beam again");
  await page.getByTestId("people-contact").fill("not an account@");
  await expect(page.getByTestId("people-make")).toBeDisabled();
  await page.getByTestId("people-contact").fill("beam.baanmali");
  await page.getByTestId("people-make").click();
  // Beam's invite waits already: the refusal is said, the form stays for fixing, and the list is as it was
  await expect(page.getByTestId("people-who-error")).toHaveText("That account already has an invite waiting. Send its link, or cancel it first.");
  await expect(page.getByTestId("people-invite-form")).toBeVisible();
  await expect(rows(page, "people-invite-row")).toHaveCount(1);
  await page.getByTestId("people-form-cancel").click();
  await expect(page.getByTestId("people-invite-form")).toHaveCount(0);
});

test("cancels an invite that waits", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-cancel-invite").click();
  await expect(page.getByTestId("people-who-notice")).toHaveText("The invite for Beam was cancelled.");
  await expect(rows(page, "people-invite-row")).toHaveCount(0);
  await expect(page.getByTestId("people-count")).toHaveText("2 people");
});

test("removing a helper asks first; Keep changes nothing; Remove signs them out everywhere, and there is no Undo", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-remove").click();
  const question = page.getByTestId("people-remove-question");
  await expect(question).toContainText("Remove Mint?");
  await expect(question).toContainText("Mint can no longer sign in to");
  await expect(question).toContainText("Requests Mint was looking at go back to you.");
  // the safe answer holds the focus, and Escape closes the question too
  await expect(page.getByTestId("people-remove-keep")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(question).toHaveCount(0);
  await expect(rows(page, "people-helper")).toHaveCount(1);
  await page.getByTestId("people-remove").click();
  await page.getByTestId("people-remove-keep").click();
  await expect(rows(page, "people-helper")).toHaveCount(1);
  // Remove Mint does it
  await page.getByTestId("people-remove").click();
  await page.getByTestId("people-remove-yes").click();
  await expect(page.getByTestId("people-who-notice")).toContainText("Mint was removed and signed out on every device.");
  await expect(page.getByTestId("people-who-notice")).toContainText("To let Mint back, invite them again.");
  await expect(rows(page, "people-helper")).toHaveCount(0);
  await expect(page.getByTestId("people-count")).toHaveText("1 person, 1 invited");
  await expect(page.getByRole("button", { name: /undo/i })).toHaveCount(0);
  await expect(page.getByText(/undo/i)).toHaveCount(0);
  // with nobody to cover, the cover asks for a helper first
  await expect(page.getByTestId("people-cover-need")).toBeVisible();
});

test("sets the cover for a helper until a day, and ends it", async ({ page }) => {
  await openPeople(page);
  const set = page.getByTestId("people-cover-set");
  await expect(set).toBeDisabled();
  await page.getByTestId("people-cover-helper").selectOption({ label: "Mint" });
  // the earliest day is today
  const min = await page.getByTestId("people-cover-day").getAttribute("min");
  expect(min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const in3 = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  await page.getByTestId("people-cover-day").fill(in3);
  await expect(set).toBeEnabled();
  await set.click();
  await expect(page.getByTestId("people-cover-notice")).toContainText("Mint covers messages until");
  await expect(page.getByTestId("people-cover-line")).toContainText("You are away until");
  await expect(page.getByTestId("people-cover-line")).toContainText("Mint is covering messages.");
  await expect(page.getByTestId("people-covering")).toBeVisible();
  await expect(page.getByTestId("people-cover-form")).toHaveCount(0);
  await page.getByTestId("people-cover-end").click();
  await expect(page.getByTestId("people-cover-notice")).toHaveText("The cover has ended.");
  await expect(page.getByTestId("people-covering")).toHaveCount(0);
  await expect(page.getByTestId("people-cover-form")).toBeVisible();
});

test("removing the covering helper ends the cover with them, and says so", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-cover-helper").selectOption({ label: "Mint" });
  const in2 = await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  await page.getByTestId("people-cover-day").fill(in2);
  await page.getByTestId("people-cover-set").click();
  await expect(page.getByTestId("people-covering")).toBeVisible();
  await page.getByTestId("people-remove").click();
  await page.getByTestId("people-remove-yes").click();
  await expect(page.getByTestId("people-who-notice")).toContainText("Their cover has ended.");
  await expect(page.getByTestId("people-cover-line")).toHaveCount(0);
});

test("reads the list again when the window comes back to the front, and keeps what the owner was typing", async ({ page }) => {
  await openPeople(page);
  await page.getByTestId("people-invite").click();
  await page.getByTestId("people-name").fill("Draft");
  // the shop's list changes behind the page's back, as when a helper opens their invite on their phone
  await page.evaluate(async () => {
    const host = (await import(/* @vite-ignore */ "/src/runtime/mock/host.ts" as string)) as { sharedHost(): { handle(op: string, p: unknown): unknown } };
    host.sharedHost().handle("people.cancelInvite", { shop: "practice:own-shop", invite: "practice-invite-beam" });
  });
  // the page has not looked yet
  await expect(rows(page, "people-invite-row")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(rows(page, "people-invite-row")).toHaveCount(0);
  await expect(page.getByTestId("people-count")).toHaveText("2 people");
  // what was being typed is still there
  await expect(page.getByTestId("people-invite-form")).toBeVisible();
  await expect(page.getByTestId("people-name")).toHaveValue("Draft");
});

test("a shop the person only helps at has no people to change: the page says whose they are", async ({ page }) => {
  await openPeople(page);
  // choosing a shop shows it on every page, which leaves Settings for the chat as it does for any page; People is opened again
  await page.getByTestId("shop-switch").click();
  await page.getByTestId("shop-menu").getByRole("menuitemradio").nth(1).click();
  await expect(page.getByTestId("people")).toHaveCount(0);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-people").click();
  await expect(page.getByTestId("people-only")).toHaveText(
    "Only Noi can see and change who can use Manut AI for Ran Pa Noi. Ask Noi if someone should be added or removed.",
  );
  await expect(page.getByTestId("people-invite")).toHaveCount(0);
  await expect(page.getByTestId("people-who")).toHaveCount(0);
  await expect(page.getByTestId("people-remove")).toHaveCount(0);
  // switching back shows the person's own shop's people again
  await page.getByTestId("shop-switch").click();
  await page.getByTestId("shop-menu").getByRole("menuitemradio").nth(0).click();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-people").click();
  await expect(page.getByTestId("people-who")).toBeVisible();
  await expect(page.getByTestId("people-owner")).toContainText("Fon (you)");
});

test("People sits under Shop in the Settings list, in its own group, between the bots and Under the hood", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  const headings = await page.locator(".st-nav .st-sh").allTextContents();
  expect(headings.map((h) => h.trim())).toEqual(["Bots", "Shop"]);
  // the developer pages' one entry comes after the shop's (item 85h)
  const order = await page.locator(".st-nav").evaluate((nav) => [...nav.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")));
  expect(order.indexOf("settings-hood")).toBe(order.indexOf("settings-nav-people") + 1);
  await expect(page.getByTestId("settings-nav-people")).toHaveText("People");
  await page.getByTestId("settings-nav-people").click();
  await expect(page.getByTestId("settings-nav-people")).toHaveAttribute("aria-current", "page");
});
