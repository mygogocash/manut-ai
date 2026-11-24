// Signing in by a code sent by email, in Settings › Developer (src/settings/EmailSignIn.tsx): in Practice, where the
// screens run on a pretend code that they say aloud and no email is ever sent, and, over a stubbed desktop shell, against
// an API that has signing in by email switched off, which is what every real environment answers until the owner turns it
// on (docs/sign-in-options.md, "The desktop"). Both run on the app's own runtime, so the page asks for it
// (`__MANUT_IN_PROCESS__`, src/lib/bridge.ts): the suite's server is built for the mock bridge, which has no Practice and no
// Connected.
import { expect, test, type Page } from "@playwright/test";

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

/** Settings › Developer, as a person gets there: the account row, then Developer in Settings' list. */
async function openDeveloper(page: Page) {
  await page.goto("/");
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-nav-developer").click();
  await expect(page.getByTestId("dev-email")).toBeVisible();
}

/** Every request this page makes to an API path, which Practice must make none of. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (/\/v1\//.test(r.url())) seen.push(`${r.method()} ${r.url()}`);
  });
  return seen;
}

/** Pastes `text` into the focused box as the system would, with the clipboard's text on a real paste event. */
async function paste(page: Page, testId: string, text: string) {
  await page.evaluate(
    ([id, value]) => {
      const data = new DataTransfer();
      data.setData("text", value);
      document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    [testId, text],
  );
}

const notice = (page: Page) => page.getByTestId("dev-email-notice");

test.describe("in Practice", () => {
  test("asks for a code, says the pretend one aloud, takes a wrong code and a pasted right one, and sends nothing", async ({ page }) => {
    const requests = apiRequests(page);
    await openDeveloper(page);
    // the app is on its own Practice runtime, not the mock bridge's
    await expect(page.getByTestId("mode-line")).toHaveText("Practice mode");
    const form = page.getByTestId("dev-email");
    await expect(form).toContainText("Practice: nothing is sent and nothing is kept.");
    // Practice has no API, so there is no Apple row and no keychain to sign in to
    await expect(page.getByTestId("dev-token")).toHaveCount(0);

    await page.getByTestId("dev-email-address").fill("Fon@Example.com");
    await page.getByTestId("dev-email-send").click();
    const code = page.getByTestId("dev-email-code");
    await expect(code).toBeFocused();
    await expect(notice(page)).toHaveText("Practice: your code is 123456. No email was sent.");
    await expect(form).toContainText("The six digits we sent to fon@example.com.");
    // the box takes the system's one-time-code autofill on a numeric keyboard, and Sign in waits for six digits
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    await expect(page.getByTestId("dev-email-sign-in")).toBeDisabled();
    // a new code waits out the minute, with the time shown
    await expect(page.getByTestId("dev-email-again")).toBeDisabled();
    await expect(page.getByTestId("dev-email-again")).toHaveText(/^Send a new code in (1:00|0:5\d)$/);

    // a wrong code says how many tries are left, empties the box and gives it the keyboard again
    await code.fill("000000");
    await page.getByTestId("dev-email-sign-in").click();
    await expect(notice(page)).toHaveText("That code is not right. 4 tries left.");
    await expect(code).toHaveValue("");
    await expect(code).toBeFocused();

    // a paste of the whole line from the email is read as the six digits in it
    await paste(page, "dev-email-code", "Your Manut AI sign-in code is 123456.");
    await expect(code).toHaveValue("123456");
    await code.press("Enter");
    await expect(form).toContainText("Practice: signed in");
    await expect(form).toContainText("You are signed in as fon@example.com. Nothing was sent and nothing is kept.");

    // signing out of the pretend sign-in goes back to the start, with the keyboard in the address box
    await page.getByTestId("dev-email-out").click();
    await expect(page.getByTestId("dev-email-address")).toBeFocused();
    expect(requests).toEqual([]);
  });

  test("ends the code on the fifth wrong try, and a new code works once the minute has passed", async ({ page }) => {
    await page.clock.install();
    const requests = apiRequests(page);
    await openDeveloper(page);
    await page.getByTestId("dev-email-address").fill("fon@example.com");
    await page.getByTestId("dev-email-send").click();
    const code = page.getByTestId("dev-email-code");
    const signIn = page.getByTestId("dev-email-sign-in");
    await expect(code).toBeVisible();

    for (const [left, words] of [[4, "4 tries left"], [3, "3 tries left"], [2, "2 tries left"], [1, "1 try left"]] as const) {
      await code.fill("000000");
      await signIn.click();
      await expect(notice(page), String(left)).toHaveText(`That code is not right. ${words}.`);
    }
    await code.fill("000000");
    await signIn.click();
    await expect(notice(page)).toHaveText("That code is not right, and it has ended. Ask for a new one.");
    // the ended code cannot be tried again, whatever is typed
    await code.fill("123456");
    await expect(signIn).toBeDisabled();

    // a new code is held for the minute, counted down on the button, and then asked for
    const again = page.getByTestId("dev-email-again");
    await expect(again).toBeDisabled();
    await page.clock.fastForward(30_000);
    await expect(again).toHaveText(/^Send a new code in 0:[23]\d$/);
    await page.clock.fastForward(31_000);
    await expect(again).toBeEnabled();
    await expect(again).toHaveText("Send a new code");
    await again.click();
    await expect(notice(page)).toHaveText("Practice: your code is 123456. No email was sent.");
    await expect(code).toHaveValue("");
    await code.fill("123456");
    await signIn.click();
    await expect(page.getByTestId("dev-email")).toContainText("Practice: signed in");
    expect(requests).toEqual([]);
  });

  test("says first that an address is not one, and asks nothing", async ({ page }) => {
    const requests = apiRequests(page);
    await openDeveloper(page);
    await page.getByTestId("dev-email-address").fill("fon");
    await page.getByTestId("dev-email-send").click();
    await expect(notice(page)).toHaveText("Type your email address, like name@example.com.");
    await expect(page.getByTestId("dev-email")).toHaveAttribute("data-step", "email");
    // typing again takes the line away
    await page.getByTestId("dev-email-address").fill("fon@");
    await expect(notice(page)).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("goes back to another email, and keeps the first address's minute to itself", async ({ page }) => {
    await openDeveloper(page);
    await page.getByTestId("dev-email-address").fill("fon@example.com");
    await page.getByTestId("dev-email-send").click();
    await expect(page.getByTestId("dev-email-code")).toBeVisible();
    await page.getByTestId("dev-email-another").click();
    await expect(page.getByTestId("dev-email-address")).toBeFocused();
    // the first address still waits out its minute, and a second one does not
    await expect(page.getByTestId("dev-email-send")).toHaveText(/^Send code in (1:00|0:5\d)$/);
    await expect(page.getByTestId("dev-email-send")).toBeDisabled();
    await page.getByTestId("dev-email-address").fill("noi@example.com");
    await expect(page.getByTestId("dev-email-send")).toHaveText("Send code");
    await page.getByTestId("dev-email-send").click();
    await expect(page.getByTestId("dev-email")).toContainText("The six digits we sent to noi@example.com.");
  });

  // Every step in light, in dark and in the narrowest window the app has (900 pixels): all of it shows, and nothing
  // pushes the page wider than the window.
  for (const [name, scheme, width] of [["light", "light", 1280], ["dark", "dark", 1280], ["narrow", "light", 900]] as const) {
    test(`draws every step in ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 820 });
      await page.emulateMedia({ colorScheme: scheme });
      await openDeveloper(page);
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      await expect(page.getByTestId("dev-email-address")).toBeVisible();
      await expect(page.getByTestId("dev-email-send")).toBeVisible();
      expect(await fits(), "first step").toBe(true);

      await page.getByTestId("dev-email-address").fill("a-rather-long-address-for-a-shop-owner@a-long-domain-name.example.com");
      await page.getByTestId("dev-email-send").click();
      for (const id of ["dev-email-code", "dev-email-sign-in", "dev-email-again", "dev-email-another", "dev-email-notice"]) await expect(page.getByTestId(id), id).toBeVisible();
      expect(await fits(), "second step").toBe(true);

      await page.getByTestId("dev-email-code").fill("000000");
      await page.getByTestId("dev-email-sign-in").click();
      await expect(notice(page)).toHaveText("That code is not right. 4 tries left.");
      await expect(notice(page)).toBeVisible();
      expect(await fits(), "a wrong code").toBe(true);
      // what went wrong is not in the quiet colour of the notes beside it
      const [line, hint] = await Promise.all([
        notice(page).evaluate((el) => getComputedStyle(el).color),
        page.getByTestId("dev-email").locator(".st-k span").first().evaluate((el) => getComputedStyle(el).color),
      ]);
      expect(line).not.toBe(hint);

      await page.getByTestId("dev-email-code").fill("123456");
      await page.getByTestId("dev-email-sign-in").click();
      await expect(page.getByTestId("dev-email-out")).toBeVisible();
      expect(await fits(), "signed in").toBe(true);
    });
  }

  test("speaks the app's other languages", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("manut.lang", "ko"));
    await openDeveloper(page);
    await page.getByTestId("dev-email-address").fill("fon@example.com");
    await page.getByTestId("dev-email-send").click();
    await expect(notice(page)).toHaveText("연습: 코드 123456. 이메일은 보내지 않았어요.");
    await page.getByTestId("dev-email-code").fill("000000");
    await page.getByTestId("dev-email-sign-in").click();
    await expect(notice(page)).toHaveText("코드가 맞지 않아요. 4번 남았어요.");
  });
});

test.describe("connected to an API that has signing in by email off", () => {
  // The desktop shell is stood in the page, as the connected runtime reaches the API only through its commands: the API
  // answers 400 email_not_configured to both routes, as every environment does until the owner turns the sign-in on.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("manut.runtime", JSON.stringify({ mode: "connected", origin: "https://dev.manut.xyz" }));
      const w = window as unknown as { __sent: { path: string; body: unknown }[]; __TAURI_INTERNALS__: unknown };
      w.__sent = [];
      let n = 0;
      w.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        transformCallback: () => ++n,
        invoke: async (cmd: string, args: { url: string; body: string | null }) => {
          if (cmd === "api_request") {
            const path = new URL(args.url).pathname;
            w.__sent.push({ path, body: args.body ? JSON.parse(args.body) : null });
            if (path === "/v1/auth/email/code" || path === "/v1/auth/exchange") return { status: 400, body: JSON.stringify({ error: "email_not_configured" }) };
            return { status: 404, body: JSON.stringify({ error: "not_found" }) };
          }
          return null;
        },
      };
    });
  });

  test("says plainly that signing in by email isn't on yet, and what to do instead", async ({ page }) => {
    await openDeveloper(page);
    // the app is on its connected runtime, which asks the API through the stubbed shell
    await expect(page.getByTestId("mode-line")).toContainText("dev.manut.xyz");
    // Apple's way stays beside it
    await expect(page.getByTestId("dev-token")).toBeVisible();
    await expect(page.getByTestId("dev-sign-in")).toBeVisible();

    await page.getByTestId("dev-email-address").fill("fon@example.com");
    await page.getByTestId("dev-email-send").click();
    await expect(notice(page)).toHaveText("Signing in by email isn't on yet. For now, use Practice above, or sign in with Apple below.");
    // nothing moved on: the person can try again, or use Apple's way
    await expect(page.getByTestId("dev-email")).toHaveAttribute("data-step", "email");
    await expect(page.getByTestId("dev-email-send")).toBeEnabled();
    const sent = await page.evaluate(() => (window as unknown as { __sent: { path: string; body: unknown }[] }).__sent.filter((s) => s.path.startsWith("/v1/auth")));
    expect(sent).toEqual([{ path: "/v1/auth/email/code", body: { email: "fon@example.com" } }]);
  });
});
