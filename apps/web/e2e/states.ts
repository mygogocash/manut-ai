import type { Page } from "@playwright/test";

// Every state of the owner's two pages, and how an owner gets there. The practice home page ("/") has one link for
// each state a link can open; the states an owner reaches by pressing a button (the permission step, a send under way,
// a send that failed) are reached here the same way, by tapping. The specs run each state on every phone, so adding a
// demo link to the practice home page without a line here fails `home page lists only states that are checked`.
//
// This file imports nothing but a type, so a plain script can load it too (the screenshots in the report do).

export type OwnerPage = "approval" | "deletion";

export type PageState = {
  page: OwnerPage;
  /// What the owner sees, in a few words. It is the test's title.
  name: string;
  /// The practice link that opens the page.
  path: string;
  /// What an owner does after opening it, for a state a link does not open as it is.
  reach?: (page: Page) => Promise<void>;
  /// Words that are on the page once it is in this state, so a spec that reached some other state fails here and
  /// not as a confusing layout result.
  shows: string | RegExp;
  /// The buttons the state offers, by name. The checks measure every button on the page whatever this says; the list
  /// makes sure the state really offers them, so a page that lost its buttons cannot pass as having none to measure.
  buttons: string[];
};

const tap = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).tap();

/// The owner presses Approve, and then Allow, the one-time permission every shop gives before its first send.
async function approveAndAllow(page: Page): Promise<void> {
  await tap(page, "Approve");
  await tap(page, "Allow and send this reply");
}

export const STATES: PageState[] = [
  {
    page: "approval",
    name: "a reply waits for the owner",
    path: "/approve/demo",
    shows: "Sends a reply to Khun Ploy on LINE.",
    buttons: ["Approve", "No"],
  },
  {
    page: "approval",
    name: "the one-time permission step",
    path: "/approve/demo",
    reach: (page) => tap(page, "Approve"),
    shows: "Allow Manut AI to send messages for Baan Mali on LINE",
    buttons: ["Allow and send this reply", "Not now"],
  },
  {
    page: "approval",
    name: "approved, the send is under way",
    path: "/approve/demo",
    reach: approveAndAllow,
    shows: "Approved. Sending the reply to Khun Ploy.",
    buttons: [],
  },
  {
    page: "approval",
    name: "approved, and the send failed",
    path: "/approve/demo-failed",
    reach: approveAndAllow,
    shows: "You approved, but LINE did not accept the reply. Nothing was sent to Khun Nok.",
    buttons: [],
  },
  {
    page: "approval",
    name: "approved, and nobody can tell if it was sent",
    path: "/approve/demo-unknown",
    reach: approveAndAllow,
    shows: "We are not sure it was sent. Do not send it again; we will check.",
    buttons: [],
  },
  {
    page: "approval",
    name: "already sent",
    path: "/approve/demo-sent",
    shows: "Approved. Nam sent the reply to Khun Mai.",
    buttons: [],
  },
  {
    page: "approval",
    name: "already declined",
    path: "/approve/demo-declined",
    shows: "You said no. Nothing was sent to Khun Fah.",
    buttons: [],
  },
  {
    page: "approval",
    name: "nobody answered in time",
    path: "/approve/demo-old",
    shows: "Nobody answered in 24 hours, so nothing was sent.",
    buttons: [],
  },
  {
    page: "approval",
    name: "the link has expired",
    path: "/approve/demo-expired",
    shows: "This link has expired",
    buttons: [],
  },
  {
    page: "approval",
    name: "the link does not work",
    path: "/approve/not-a-real-link",
    shows: "This link does not work",
    buttons: [],
  },
  // Customers write in Thai and the drafts answer in Thai: a long message and a long reply, in a shop with a long Thai
  // name, and then the same reply on the permission step and while it is sent.
  {
    page: "approval",
    name: "a long Thai message and reply wait for the owner",
    path: "/approve/demo-long-thai",
    shows: "Sends a reply to ศิริพรรณเจริญสุขสวัสดิ์ on LINE.",
    buttons: ["Approve", "No"],
  },
  {
    page: "approval",
    name: "the permission step, for a shop with a long Thai name",
    path: "/approve/demo-long-thai",
    reach: (page) => tap(page, "Approve"),
    shows: "Allow Manut AI to send messages for ร้านเทียนหอมและน้ำมันหอมระเหยบ้านสวนมะลิ",
    buttons: ["Allow and send this reply", "Not now"],
  },
  {
    page: "approval",
    name: "a long Thai reply, approved and being sent",
    path: "/approve/demo-long-thai",
    reach: approveAndAllow,
    shows: "Approved. Sending the reply to ศิริพรรณเจริญสุขสวัสดิ์.",
    buttons: [],
  },
  // A long order id and a long tracking link have no place to break, and neither has a customer name made of one word.
  {
    page: "approval",
    name: "a long order id, link and customer name wait for the owner",
    path: "/approve/demo-long-link",
    shows: "Sends a reply to Khun_Wichai_Chaiyaphum_01 on LINE.",
    buttons: ["Approve", "No"],
  },
  {
    page: "approval",
    name: "the permission step, with a long link in the reply",
    path: "/approve/demo-long-link",
    reach: (page) => tap(page, "Approve"),
    shows: "Allow Manut AI to send messages for Baan Suan Mali Natural Candles and Essential Oils, Chiang Mai",
    buttons: ["Allow and send this reply", "Not now"],
  },
  {
    page: "approval",
    name: "a long link, approved and being sent",
    path: "/approve/demo-long-link",
    reach: approveAndAllow,
    shows: "Approved. Sending the reply to Khun_Wichai_Chaiyaphum_01.",
    buttons: [],
  },
  {
    page: "approval",
    name: "a long customer name, after the owner says no",
    path: "/approve/demo-long-link",
    reach: (page) => tap(page, "No"),
    shows: "You said no. Nothing was sent to Khun_Wichai_Chaiyaphum_01.",
    buttons: [],
  },
  // On a phone with a weak connection the request does not arrive: the page says so and offers one button.
  {
    page: "approval",
    name: "the request cannot be loaded",
    path: "/approve/demo-offline",
    shows: "Could not load this request",
    buttons: ["Try again"],
  },
  {
    page: "deletion",
    name: "the shop's data waits for the owner",
    path: "/delete/demo-delete",
    shows: "Delete everything Manut AI stores for Khao Soi Nimman?",
    buttons: ["Delete everything", "Keep my data"],
  },
  {
    page: "deletion",
    name: "being deleted",
    path: "/delete/demo-delete-deleting",
    shows: "You said yes. Deleting Khao Soi Nimman's data.",
    buttons: [],
  },
  {
    page: "deletion",
    name: "already deleted",
    path: "/delete/demo-delete-done",
    shows: "Done. Khao Soi Nimman's data is deleted.",
    buttons: [],
  },
  {
    page: "deletion",
    name: "the owner kept the data",
    path: "/delete/demo-delete-kept",
    shows: "You kept your data. Nothing was deleted.",
    buttons: [],
  },
  {
    page: "deletion",
    name: "nobody answered in time",
    path: "/delete/demo-delete-old",
    shows: "Nobody answered in 24 hours, so nothing was deleted.",
    buttons: [],
  },
  {
    page: "deletion",
    name: "the link has expired",
    path: "/delete/demo-delete-expired",
    shows: "This link has expired",
    buttons: [],
  },
  {
    page: "deletion",
    name: "the link does not work",
    path: "/delete/not-a-real-link",
    shows: "This link does not work",
    buttons: [],
  },
  // A shop with a long Thai name, whose counts run to the millions.
  {
    page: "deletion",
    name: "a shop with a long Thai name waits for the owner",
    path: "/delete/demo-delete-long",
    shows: "Delete everything Manut AI stores for ร้านขนมไทยโบราณและเครื่องแกงสดบ้านคุณยายสมศรี",
    buttons: ["Delete everything", "Keep my data"],
  },
  {
    page: "deletion",
    name: "the request cannot be loaded",
    path: "/delete/demo-delete-offline",
    shows: "Could not load this request",
    buttons: ["Try again"],
  },
];

/// Opens a state and waits until the page is in it. A send takes about five seconds to settle in practice mode, so the
/// states after one wait that long.
export async function openState(page: Page, state: PageState): Promise<void> {
  await page.goto(state.path);
  await state.reach?.(page);
  await page.getByText(state.shows).first().waitFor({ state: "visible", timeout: 15_000 });
  for (const name of state.buttons) {
    await page.getByRole("button", { name, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
  }
}
