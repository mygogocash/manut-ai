// Several shops (docs/several-shops.md), against the mock bridge: a person in one shop sees no switcher and the account
// row opens Settings as before; in two, the switch button at the row's end lists them, the owned one first with a tick,
// and choosing one shows it; asks from both shops wait in one Needs you, newest first, each naming its shop, and a
// helper's ask that only the owner may decide offers Ask <owner>, which passes it on with a note.
import { expect, test } from "@playwright/test";
import { chatOpen, startDone } from "./start";

const MOCK = Number(process.env.MANUT_MOCK_PORT || 5308);

async function mock(op: string, params: Record<string, unknown> = {}): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${MOCK}/?token=e2e`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("mock websocket error"));
  });
  const reply = await new Promise<any>((res) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id === "s1") res(msg);
    };
    ws.send(JSON.stringify({ id: "s1", op, ...params }));
  });
  ws.close();
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  return reply.result;
}

const calls = async (op: string) => (await mock("mock.calls")).calls.filter((c: any) => c.op === op);

const OWNED = { id: "pilot:a", name: "Baan Mali", owner: "Fon", role: "owner" };
const HELPED = { id: "pilot:b", name: "Ran Pa Noi", owner: "Noi", role: "helper" };

test.beforeEach(async () => {
  await mock("mock.reset");
});
test.afterAll(async () => {
  await mock("mock.reset");
});

test("a person in one shop sees no switcher, and the account row still opens Settings", async ({ page }) => {
  await mock("mock.shops", { shops: [OWNED] });
  await page.goto("/");
  await chatOpen(page);
  await startDone(page);
  await expect(page.getByTestId("shop-switch")).toHaveCount(0);
  await expect(page.getByTestId("acct-role")).toHaveCount(0);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-view")).toBeVisible();
});

test("a person who only helps at one shop sees no switcher, and the account row marks the shop as one they help at", async ({ page }) => {
  await mock("mock.shops", { shops: [HELPED] });
  await page.goto("/");
  await chatOpen(page);
  await startDone(page);
  await expect(page.getByTestId("shop-switch")).toHaveCount(0);
  await expect(page.getByTestId("nav-settings")).toContainText("Ran Pa Noi");
  await expect(page.getByTestId("acct-role")).toHaveText("Helper");
});

test("in two shops, the switch button lists them, owned first, and choosing one shows it on the account row", async ({ page }) => {
  await mock("mock.shops", { shops: [OWNED, HELPED] });
  await page.goto("/");
  await chatOpen(page);
  await startDone(page);
  const button = page.getByTestId("shop-switch");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toHaveAttribute("aria-label", "Switch shop");
  await button.click();
  const menu = page.getByTestId("shop-menu");
  const items = menu.getByRole("menuitemradio");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Baan Mali");
  await expect(items.nth(0)).toContainText("Owner");
  await expect(items.nth(1)).toContainText("Ran Pa Noi");
  await expect(items.nth(1)).toContainText("Helper");
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(0)).toBeFocused();
  // the keyboard moves through the list and chooses
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect.poll(async () => (await calls("shops.switch")).map((c: any) => c.params.shop)).toEqual([HELPED.id]);
  await expect(page.getByTestId("nav-settings")).toContainText("Ran Pa Noi");
  // the row marks a shop the person only helps at, as the list does
  await expect(page.getByTestId("acct-role")).toHaveText("Helper");
  // Escape closes the list and gives the focus back to the button
  await button.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("asks from both shops wait in one Needs you, each naming its shop, and a helper asks the owner with a note", async ({ page }) => {
  await mock("mock.shops", { shops: [OWNED, HELPED] });
  await page.goto("/");
  await chatOpen(page);
  await startDone(page);
  const now = Date.now() / 1000;
  await mock("mock.emit", {
    events: [
      {
        event: "approval.request",
        bot: "kami",
        request_id: "pilot%3Aa/reply-1@1",
        title: "",
        command: "Send on LINE: “Your parcel left this morning.”",
        choices: ["once", "deny"],
        kind: "reply",
        shop: OWNED,
        asked_at: now - 600,
      },
      {
        event: "approval.request",
        bot: "kami",
        request_id: "pilot%3Ab/refund-1@1",
        title: "",
        command: "Refund ฿120 for order RP-118",
        choices: [],
        kind: "money",
        shop: HELPED,
        asked_at: now - 60,
        pass_on: true,
      },
    ],
  });
  await page.getByTestId("menu-needs").click();
  const rows = page.getByTestId("needs-row");
  await expect(rows).toHaveCount(2);
  // newest first, each naming its shop
  await expect(rows.nth(0)).toContainText("Ran Pa Noi");
  await expect(rows.nth(0)).toContainText("RP-118");
  await expect(rows.nth(1)).toContainText("Baan Mali");
  await rows.nth(0).getByTestId("needs-open").click();
  const card = page.getByTestId("card-approval").filter({ hasText: "RP-118" });
  await expect(card.getByTestId("card-shop")).toHaveText("Ran Pa Noi");
  await expect(card.getByTestId("card-only")).toHaveText("Only Noi can approve money");
  await expect(card.locator("[data-choice]")).toHaveCount(0);
  await card.getByTestId("card-ask-owner").click();
  await card.getByTestId("card-pass-note").fill("  The jar arrived broken.  ");
  await card.getByTestId("card-pass-send").click();
  await expect(card.getByTestId("card-passed")).toContainText("Passed on to Noi");
  await expect(card.getByTestId("card-ask-owner")).toHaveCount(0);
  expect((await calls("approval.pass_on")).map((c: any) => c.params)).toEqual([{ bot: "kami", request_id: "pilot%3Ab/refund-1@1", note: "  The jar arrived broken.  " }]);
});
