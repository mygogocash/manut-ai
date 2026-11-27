import type { Page } from "@playwright/test";

// Every state of the owner's pages, and how an owner gets there: the approval and deletion pages a link opens, the page
// an invite link opens (join), and the owner's web app (`/app/`). The practice home page ("/") has one link for each
// state a link can open; the states an owner reaches by pressing a button (the permission step, a send under way, a send
// that failed, signing in with the practice code) are reached here the same way, by tapping. The specs run each state on
// every phone, so adding a demo link to the practice home page without a line here fails `home page lists only states
// that are checked`.
//
// This file imports nothing but a type, so a plain script can load it too (the screenshots in the report do).

export type OwnerPage = "approval" | "deletion" | "join" | "app";

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

/// The address the join page's and the app's sign-in is tried with, and practice's one code, which the page says aloud.
const EMAIL = "noi@khaosoi.example";
const CODE = "123456";

/// An address typed in the sign-in's first step, so Send code is there to press.
async function typeAddress(page: Page): Promise<void> {
  await page.getByLabel("Email").fill(EMAIL);
}

/// Signing in with a code: the address, Send code, then the code, whose sixth digit signs in. A wrong code stays in the
/// box with the words under it, and Sign in waits for it to be fixed.
async function signIn(page: Page, code = CODE): Promise<void> {
  await typeAddress(page);
  await tap(page, "Send code");
  await page.getByLabel("6-digit code").fill(code);
}

/// Signed in to the owner's app, on one of its tabs.
async function appTab(page: Page, tab: "Today" | "Needs you" | "Chat" | "Shops"): Promise<void> {
  await signIn(page);
  await page.getByRole("heading", { name: /^Good (morning|afternoon|evening), Fon$/ }).waitFor();
  if (tab !== "Today") await page.getByRole("link", { name: tab, exact: true }).tap();
}

/// Presses Approve on one of the app's practice requests, and waits for what it came to.
async function approveIn(page: Page, request: string, outcome: string | RegExp): Promise<void> {
  await page.locator(`[data-ask="${request}"]`).getByRole("button", { name: "Approve", exact: true }).tap();
  await page.getByText(outcome).first().waitFor();
}

/// What a phone says when it loses its connection; every engine takes this the same way.
async function goOffline(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
  });
}

/// Your Mac in practice: a pasted link, Pair, and the pretend Mac's four digits.
async function macDigits(page: Page): Promise<void> {
  await page.getByLabel("or paste the link").fill("https://dev.manut.xyz/app/#pair=practice");
  await tap(page, "Pair");
  await page.getByRole("heading", { name: "Type these on your Mac" }).waitFor();
}

/// The digits "typed at the Mac", so the passkey step shows.
async function macPasskey(page: Page): Promise<void> {
  await macDigits(page);
  await tap(page, "Type them for me");
  await page.getByRole("heading", { name: "Your Mac took the code" }).waitFor();
}

/// Paired: the pretend passkey made, and the Mac's chats listed.
async function macPaired(page: Page): Promise<void> {
  await macPasskey(page);
  await tap(page, "Make a passkey");
  await page.getByRole("heading", { name: "Needs you" }).waitFor();
}

/// One chat open, with its approval and its question.
async function macChat(page: Page): Promise<void> {
  await macPaired(page);
  await page.getByRole("button", { name: /Shop launch plan/ }).tap();
  await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
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
  // The page an invite link opens: signing in with a code sent by email, then the invite's answer. Every demo link names
  // Khao Soi Nimman and answers as its name says whoever signs in; the sign-in-off link stands for every real
  // environment today.
  {
    page: "join",
    name: "an invite asks the person to sign in",
    path: "/join/demo-join",
    reach: typeAddress,
    shows: "You've been invited to help with a shop on Manut AI",
    buttons: ["Send code"],
  },
  {
    page: "join",
    name: "a wrong code",
    path: "/join/demo-join",
    reach: (page) => signIn(page, "000000"),
    shows: "That code does not match. 4 tries left.",
    buttons: ["Sign in", "Use another email"],
  },
  {
    page: "join",
    name: "joined the shop",
    path: "/join/demo-join",
    reach: signIn,
    shows: "You've joined Khao Soi Nimman.",
    buttons: [],
  },
  {
    page: "join",
    name: "the invite is for another email",
    path: "/join/demo-join-wrong",
    reach: signIn,
    shows: "This invite to Khao Soi Nimman is for another email address.",
    buttons: ["Switch account"],
  },
  {
    page: "join",
    name: "the invite is for a LINE account",
    path: "/join/demo-join-line",
    reach: signIn,
    shows: "This invite to Khao Soi Nimman is for a LINE account.",
    buttons: ["Switch account"],
  },
  {
    page: "join",
    name: "the invite has expired",
    path: "/join/demo-join-expired",
    reach: signIn,
    shows: "This invite has expired",
    buttons: [],
  },
  {
    page: "join",
    name: "the invite was already used",
    path: "/join/demo-join-used",
    reach: signIn,
    shows: "This invite has already been used",
    buttons: [],
  },
  {
    page: "join",
    name: "the invite was cancelled",
    path: "/join/demo-join-revoked",
    reach: signIn,
    shows: "This invite was cancelled",
    buttons: [],
  },
  {
    page: "join",
    name: "the invite link does not work",
    path: "/join/not-a-real-invite",
    reach: signIn,
    shows: "This invite link does not work",
    buttons: [],
  },
  {
    page: "join",
    name: "signing in by email is off",
    path: "/join/demo-join-off",
    reach: async (page) => {
      await typeAddress(page);
      await tap(page, "Send code");
    },
    shows: "Joining by email isn't on yet",
    buttons: [],
  },
  // The owner's web app, which a person adds to their home screen: signing in, then Today, Needs you across a shop they
  // own and one they help at, the answers, Chat and their shops. Practice's person owns Baan Mali and helps at Khao Soi
  // Nimman; the sign-in-off link stands for every real environment today.
  {
    page: "app",
    name: "signing in",
    path: "/app/",
    reach: typeAddress,
    shows: "Sign in to Manut AI",
    buttons: ["Send code"],
  },
  {
    page: "app",
    name: "a wrong code",
    path: "/app/",
    reach: (page) => signIn(page, "000000"),
    shows: "That code does not match. 4 tries left.",
    buttons: ["Sign in", "Use another email"],
  },
  {
    page: "app",
    name: "today: Buddy's brief and the oldest requests",
    path: "/app/",
    reach: (page) => appTab(page, "Today"),
    shows: "6 requests wait for you.",
    buttons: ["Approve", "Decline"],
  },
  {
    page: "app",
    name: "needs you, in a shop the person owns and one they help at",
    path: "/app/",
    reach: (page) => appTab(page, "Needs you"),
    shows: "Only the owner can approve changes to the shop's own records. It waits for Lek.",
    buttons: ["Approve", "Decline"],
  },
  {
    page: "app",
    name: "answered: sent, refused by LINE, and answered first from LINE",
    path: "/app/",
    reach: async (page) => {
      await appTab(page, "Needs you");
      await approveIn(page, "practice-bm-late", "Approved and sent.");
      await approveIn(page, "practice-bm-free", "You approved, but LINE did not accept the reply. Nothing was sent.");
      await approveIn(page, "practice-ksn-taken", /^Lek already approved this from the LINE link at /);
    },
    shows: "Nothing was sent twice.",
    buttons: ["Approve", "Decline"],
  },
  {
    page: "app",
    name: "offline, what was read cannot be answered",
    path: "/app/",
    reach: async (page) => {
      await appTab(page, "Needs you");
      await page.locator("[data-ask]").first().waitFor();
      // What a phone says when it loses its connection; every engine takes this the same way.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        window.dispatchEvent(new Event("offline"));
      });
    },
    shows: /These may have changed, so they can't be answered until you're back online\./,
    buttons: [],
  },
  {
    page: "app",
    name: "chat waits for the team's model",
    path: "/app/",
    reach: (page) => appTab(page, "Chat"),
    shows: "Chat with Buddy",
    buttons: [],
  },
  {
    page: "app",
    name: "the person's shops",
    path: "/app/",
    reach: (page) => appTab(page, "Shops"),
    shows: "You help Lek",
    buttons: ["Sign out"],
  },
  {
    page: "app",
    name: "signing in by email is off",
    path: "/app/?demo=sign-in-off",
    shows: "Signing in isn't on yet",
    buttons: [],
  },
  // Your Mac (src/app/mac/, docs/remote-access.md), which needs no sign-in, on practice's pretend Mac: each state from
  // not available to a chat with its asks, and the view greyed while the Mac is out of reach.
  {
    page: "app",
    name: "your Mac: reaching it is not available yet",
    path: "/app/?demo=mac-off#mac",
    shows: "Reaching your Mac isn't available yet",
    buttons: [],
  },
  {
    page: "app",
    name: "your Mac: scan or paste the code",
    path: "/app/#mac",
    // The camera row settles once the browser has said whether it reads QR codes: Scan, or the words saying it cannot.
    reach: (page) => page.getByRole("button", { name: "Scan", exact: true }).or(page.getByText("This browser can't read a code")).waitFor(),
    shows: "Scan the code on your Mac",
    buttons: ["Pair"],
  },
  {
    page: "app",
    name: "your Mac: a pairing link opened outside the installed app",
    path: "/app/#pair=AQID",
    shows: "Pair from the app on your Home Screen",
    buttons: ["Copy link"],
  },
  {
    page: "app",
    name: "your Mac: the four digits to type on the Mac",
    path: "/app/#mac",
    reach: macDigits,
    shows: "Type these on your Mac",
    buttons: ["Type them for me"],
  },
  {
    page: "app",
    name: "your Mac: making the passkey",
    path: "/app/#mac",
    reach: macPasskey,
    shows: "Your Mac took the code",
    buttons: ["Make a passkey"],
  },
  {
    page: "app",
    name: "your Mac: the paired Mac's chats",
    path: "/app/#mac",
    reach: macPaired,
    shows: "Connected to your Mac",
    buttons: ["Forget this Mac"],
  },
  {
    page: "app",
    name: "your Mac: told when the Mac needs you",
    path: "/app/#mac",
    reach: async (page) => {
      await macPaired(page);
      const toggle = page.getByRole("switch", { name: "Tell me when my Mac needs me" });
      await toggle.click();
      await page.locator('[role="switch"][aria-checked="true"]').waitFor();
    },
    shows: "Tell me when my Mac needs me",
    buttons: ["Forget this Mac"],
  },
  {
    page: "app",
    name: "your Mac: a chat with an approval and a question",
    path: "/app/#mac",
    reach: macChat,
    shows: "Send a LINE broadcast",
    buttons: ["Allow once", "No", "Send answer", "Stop"],
  },
  {
    page: "app",
    name: "your Mac: greyed while the Mac is out of reach",
    path: "/app/#mac",
    reach: async (page) => {
      await macChat(page);
      await goOffline(page);
    },
    shows: /What you see was current at/,
    buttons: ["All chats"],
  },
];

/// Opens a state and waits until the page is in it. A send takes about five seconds to settle in practice mode, so the
/// states after one wait that long.
export async function openState(page: Page, state: PageState): Promise<void> {
  await page.goto(state.path);
  await state.reach?.(page);
  await page.getByText(state.shows).first().waitFor({ state: "visible", timeout: 15_000 });
  // A page may offer a button more than once (the owner's app has an Approve on each request), so the first stands for
  // them all.
  for (const name of state.buttons) {
    await page.getByRole("button", { name, exact: true }).first().waitFor({ state: "visible", timeout: 15_000 });
  }
}
