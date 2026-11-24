// The owner's web app's pages (src/app/OwnerApp.tsx): opening it signed out, with signing in off, offline or signed in;
// signing in with a code; Needs you across an owned shop and a helped one, each request with its exact words and only the
// answers the person's role allows; every answer's words; offline; signing out; and nothing kept beyond the cookies the
// page cannot read.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type PilotApi, type WebAnswer, type WebDecision } from "../src/api";
import { createFakeApi, PRACTICE_SIGN_IN_CODE } from "../src/api/fake";
import { outcomeWords } from "../src/app/AskCard";
import { decodeApprovals, type Outcome } from "../src/app/asks";
import type { Ask } from "../src/app/needs";
import { OwnerApp, tabOf } from "../src/app/OwnerApp";
import { en as s } from "../src/app/strings";
import { approvalJson, decided, HELPED, listing, OWNED, T0 } from "./appKit";
import { renderWithApi, stubApi } from "./helpers";

const GREETING = /^Good (morning|afternoon|evening), Fon$/;
const REPLY = "ขออภัยที่พัสดุล่าช้านะคะ ของออกจากคลังแล้วค่ะ";
const BOOKS = "Append the books for 2026-10 to the Google Sheet \"Manut AI books: Baan Mali\", tab \"Books\": a header row, then 47 rows.";
const HELPER_BOOKS = "Ton asks to append the books for 2026-10 to the owner's Google Sheet. Only the owner sees the books and can approve it.";

afterEach(() => {
  vi.restoreAllMocks();
});

/// An API for a person who owns Baan Mali and helps at Khao Soi Nimman, each with requests waiting.
function twoShops(over: Partial<PilotApi> = {}) {
  const decisions: WebDecision[] = [];
  const api = stubApi({
    webShops: async () => ({ signedIn: true, shops: [OWNED, HELPED] }),
    webApprovals: async (shop, state): Promise<WebAnswer> => {
      if (state === "recent") return listing("recent");
      return shop === OWNED.id
        ? listing("open", approvalJson({ id: "bm-reply", createdAt: T0, detail: { actionId: "bm-reply", operationType: "line.message.push",
          targetResourceId: "bot", recipient: "U-c", text: REPLY } }),
        approvalJson({ id: "bm-books", kind: "command", createdAt: T0 + 60_000, detail: { actionId: "bm-books",
          operationType: "google.sheets.append", text: BOOKS } }))
        : listing("open", approvalJson({ id: "ksn-books", kind: "command", createdAt: T0 + 120_000, detail: { actionId: "ksn-books",
          operationType: "google.sheets.append", text: HELPER_BOOKS } }));
    },
    webDecide: async (input) => {
      decisions.push(input);
      return { status: 200, body: { result: { ok: true, decision: decided({ requestId: input.requestId }) }, action: "confirmed" } };
    },
    ...over,
  });
  return { api, decisions };
}

async function openNeeds() {
  fireEvent.click(await screen.findByRole("link", { name: "Needs you" }));
  await screen.findByRole("heading", { name: "Needs you", level: 1 });
  await waitFor(() => expect(document.querySelectorAll("[data-ask]").length).toBeGreaterThan(0));
}

const card = (id: string) => document.querySelector(`[data-ask="${id}"]`) as HTMLElement;

describe("opening the app", () => {
  it("says plainly that signing in isn't on yet, and offers nothing else", async () => {
    renderWithApi(<OwnerApp />, stubApi({ webShops: async () => ({ signedIn: false, emailSignIn: false }) }));
    expect(await screen.findByText(s.offTitle)).toBeTruthy();
    expect(screen.getByText(s.offBody)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("asks a signed-out person to sign in, after asking twice in case another tab was refreshing the sign-in", async () => {
    const webShops = vi.fn(async () => ({ signedIn: false as const, emailSignIn: true }));
    renderWithApi(<OwnerApp />, stubApi({ webShops }));
    expect(await screen.findByRole("heading", { name: s.signInTitle })).toBeTruthy();
    expect(webShops).toHaveBeenCalledTimes(2);
  });

  it("says when it is offline or the API did not answer, and tries again, by itself once back online", async () => {
    const webShops = vi.fn(async () => Promise.reject(new ApiError(0, "network")));
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderWithApi(<OwnerApp />, stubApi({ webShops }));
    expect(await screen.findByText(s.offlineTitle)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: s.tryAgain }));
    await waitFor(() => expect(webShops).toHaveBeenCalledTimes(2));
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(webShops).toHaveBeenCalledTimes(3));
  });
});

describe("signing in", () => {
  it("signs in with the join page's steps and words, then opens the person's shops", async () => {
    let signedIn = false;
    const webSignIn = vi.fn(async () => {
      signedIn = true;
    });
    const requestEmailCode = vi.fn(async () => ({ sent: true as const, expiresIn: 600, resendIn: 60 }));
    const { api } = twoShops({
      webShops: async () => (signedIn ? { signedIn: true, shops: [OWNED, HELPED] } : { signedIn: false, emailSignIn: true }),
      webSignIn,
      requestEmailCode,
    });
    renderWithApi(<OwnerApp />, api);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: " Fon@BaanMali.example " } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(requestEmailCode).toHaveBeenCalledWith("fon@baanmali.example");
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "Your code is 482915." } });
    await waitFor(() => expect(webSignIn).toHaveBeenCalledWith({ email: "fon@baanmali.example", code: "482915" }));
    expect(await screen.findByRole("heading", { name: GREETING })).toBeTruthy();
  });

  it("says a wrong code as the join page does, and keeps the person on the code", async () => {
    const { api } = twoShops({
      webShops: async () => ({ signedIn: false, emailSignIn: true }),
      requestEmailCode: async () => ({ sent: true, expiresIn: 600, resendIn: 60 }),
      webSignIn: async () => Promise.reject(new ApiError(401, "wrong_code", undefined, { triesLeft: 2 })),
    });
    renderWithApi(<OwnerApp />, api);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "fon@baanmali.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.change(await screen.findByLabelText("6-digit code"), { target: { value: "111111" } });
    expect(await screen.findByText("That code does not match. 2 tries left. Check the newest email from Manut AI.")).toBeTruthy();
  });
});

describe("what waits across the shops", () => {
  it("greets the owner, counts what waits, and shows each request's exact words in its own shop", async () => {
    const { api } = twoShops();
    renderWithApi(<OwnerApp />, api);
    expect(await screen.findByRole("heading", { name: GREETING })).toBeTruthy();
    expect(await screen.findByText("3 need you")).toBeTruthy();
    expect(screen.getByText("3 requests wait for you.")).toBeTruthy();
    await openNeeds();
    const reply = card("bm-reply");
    expect(within(reply).getByText("Sends a reply to a customer on LINE. It can't be unsent.")).toBeTruthy();
    expect(within(reply).getByText(s.replyLabel)).toBeTruthy();
    expect(within(reply).getByTestId("ask-words").textContent).toBe(REPLY);
    expect(within(reply).getByTestId("ask-words").getAttribute("lang")).toBe("th");
    expect(within(reply).getByText("LINE reply")).toBeTruthy();
    expect(within(reply).getByText(/^Baan Mali, asked /)).toBeTruthy();
    expect(within(reply).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(within(reply).getByRole("button", { name: "Decline" })).toBeTruthy();
    // The owner decides their books; the sentence is the control plane's own.
    const books = card("bm-books");
    expect(within(books).getByText(s.sentenceLabel)).toBeTruthy();
    expect(within(books).getByTestId("ask-words").textContent).toBe(BOOKS);
    expect(within(books).getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("shows a helper what waits for the owner, and offers them no answer to it", async () => {
    renderWithApi(<OwnerApp />, twoShops().api);
    await openNeeds();
    const helped = card("ksn-books");
    expect(within(helped).getByText(/^Khao Soi Nimman, asked /)).toBeTruthy();
    expect(within(helped).getByTestId("ask-words").textContent).toBe(HELPER_BOOKS);
    expect(within(helped).getByText("Only the owner can approve changes to the shop's own records. It waits for Lek.")).toBeTruthy();
    expect(within(helped).queryByRole("button")).toBeNull();
  });

  it("approves with that shop's own session, by the option that approves, and says it was sent", async () => {
    const { api, decisions } = twoShops();
    renderWithApi(<OwnerApp />, api);
    await openNeeds();
    fireEvent.click(within(card("bm-reply")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(s.sent)).toBeTruthy();
    expect(decisions).toEqual([{ shop: OWNED.id, requestId: "bm-reply", optionId: "approve", seenRevision: 1 }]);
  });

  it("presses once: a second press while the first is out sends nothing", async () => {
    let release: (answer: WebAnswer) => void = () => undefined;
    const webDecide = vi.fn(() => new Promise<WebAnswer>((resolve) => {
      release = resolve;
    }));
    renderWithApi(<OwnerApp />, twoShops({ webDecide }).api);
    await openNeeds();
    const approve = within(card("bm-reply")).getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(within(card("bm-reply")).getByRole("button", { name: /Approv/ }));
    fireEvent.click(within(card("bm-books")).getByRole("button", { name: "Decline" }));
    expect(webDecide).toHaveBeenCalledTimes(1);
    await act(async () => release({ status: 200, body: { result: { ok: true }, action: "confirmed" } }));
    expect(await screen.findByText(s.sent)).toBeTruthy();
  });

  it("says who decided first when someone did, and that nothing was sent twice", async () => {
    const { api } = twoShops({
      webDecide: async () => ({ status: 409, body: { error: "already_decided", action: "confirmed", result: { ok: false,
        refused: "already_decided", decision: decided({ requestId: "bm-reply", decidedBy: "helper-mint", role: "helper", decidedAt: T0 + 60_000 }) } } }),
    });
    renderWithApi(<OwnerApp />, api);
    await openNeeds();
    fireEvent.click(within(card("bm-reply")).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText(/^A helper already approved this at \d\d:\d\d .+, so your answer was not used\. Nothing was sent twice\.$/))
      .toBeTruthy();
  });

  it("offers no answer offline, says what it holds may have changed, and reads again when back online", async () => {
    const { api } = twoShops();
    const webApprovals = vi.spyOn(api, "webApprovals");
    renderWithApi(<OwnerApp />, api);
    await openNeeds();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(await screen.findByText(/^You're offline\. Read at .+These may have changed, so they can't be answered until you're back online\.$/))
      .toBeTruthy();
    expect(within(card("bm-reply")).queryByRole("button", { name: "Approve" })).toBeNull();
    const reads = webApprovals.mock.calls.length;
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(webApprovals.mock.calls.length).toBeGreaterThan(reads));
    expect(await within(card("bm-reply")).findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("goes back to signing in when the sign-in has ended", async () => {
    renderWithApi(<OwnerApp />, twoShops({
      webApprovals: async (shop) => ({ status: 401, body: { error: "session_ended", shop } }),
      webShops: vi.fn().mockResolvedValueOnce({ signedIn: true, shops: [OWNED] }).mockResolvedValue({ signedIn: false, emailSignIn: true }),
    }).api);
    expect(await screen.findByText(s.signedOutBody)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});

describe("the other tabs", () => {
  it("says chat with Buddy waits for a model, lists the shops and roles, and signs out", async () => {
    const webSignOut = vi.fn(async () => undefined);
    const { api } = twoShops({ webSignOut });
    renderWithApi(<OwnerApp />, api);
    fireEvent.click(await screen.findByRole("link", { name: "Chat" }));
    expect(await screen.findByText(s.chatBody)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Shops" }));
    expect(await screen.findByText(s.youOwn)).toBeTruthy();
    expect(screen.getByText("You help Lek")).toBeTruthy();
    expect(screen.getByText(s.helperRule("Lek"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: s.signInTitle })).toBeTruthy();
    expect(webSignOut).toHaveBeenCalledTimes(1);
  });

  it("keeps the person signed in when signing out gets no answer, and says why", async () => {
    renderWithApi(<OwnerApp />, twoShops({ webSignOut: async () => Promise.reject(new ApiError(0, "network")) }).api);
    fireEvent.click(await screen.findByRole("link", { name: "Shops" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(s.signOutOffline)).toBeTruthy();
  });

  it("reads the tab from the address, Today by default", () => {
    expect(tabOf("")).toBe("today");
    expect(tabOf("#needs")).toBe("needs");
    expect(tabOf("#shops")).toBe("shops");
    expect(tabOf("#chat")).toBe("chat");
    expect(tabOf("#elsewhere")).toBe("today");
  });
});

describe("every answer, in words", () => {
  const ask = (over: Parameters<typeof approvalJson>[0] = {}, shop = OWNED): Ask =>
    ({ shop, approval: decodeApprovals({ approvals: [approvalJson(over)] }, [])[0]! });
  const line = ask();
  const other = ask({ kind: "command", detail: { operationType: "google.sheets.append", text: "Append." } });
  const words = (outcome: Outcome, on = line) => outcomeWords(s, outcome, on, T0).text;

  it("says what became of the send, and of a no", () => {
    expect(words({ kind: "decided", approved: true, action: "confirmed" })).toBe("Approved and sent.");
    expect(words({ kind: "decided", approved: true, action: "dispatching" })).toBe("Approved. It's being sent now, once.");
    expect(words({ kind: "decided", approved: true, action: "approved" })).toBe("Approved. It's being sent now, once.");
    expect(words({ kind: "decided", approved: true, action: "failed" })).toBe("You approved, but LINE did not accept the reply. Nothing was sent.");
    expect(words({ kind: "decided", approved: true, action: "failed" }, other)).toBe("You approved, but it could not be done. Nothing was sent.");
    expect(words({ kind: "decided", approved: true, action: "unknown" })).toBe("We are not sure it was sent. Do not send it again; we will check.");
    expect(words({ kind: "decided", approved: false, action: "rejected" })).toBe("You said no. Nothing was sent.");
  });

  it("says who decided first, and how", () => {
    const first = (over: Record<string, unknown>) => ({ kind: "already" as const, action: null, decision: decided(over) as never });
    expect(words(first({ decidedBy: "owner-link", role: "owner", optionId: "approve" }), ask({}, HELPED)))
      .toMatch(/^Lek already approved this from the LINE link at \d\d:\d\d .+, so your answer was not used\. Nothing was sent twice\.$/);
    expect(words(first({ decidedBy: "owner-fon", role: "owner", optionId: "decline" })))
      .toMatch(/^You already declined this at \d\d:\d\d .+, so your answer was not used\.$/);
    expect(words(first({ decidedBy: "helper-mint", role: "helper", optionId: "decline", decidedAt: 0 })))
      .toBe("A helper already declined this, so your answer was not used.");
  });

  it("says why a request can no longer be answered, or why it waits", () => {
    expect(words({ kind: "changed" })).toBe(s.changed);
    expect(words({ kind: "superseded", reason: "withdrawn" })).toBe("The team took this back. Nothing was decided.");
    expect(words({ kind: "superseded", reason: "attempt_ended" })).toBe("No longer asked: the work it was for has stopped. Nothing was decided.");
    expect(words({ kind: "expired", at: T0 })).toMatch(/^Nobody answered in time: it ran out at \d\d:\d\d .+, so nothing was done\.$/);
    expect(words({ kind: "expired", at: null })).toBe("Nobody answered in time, so nothing was done.");
    expect(words({ kind: "not_permitted" }, ask({ kind: "money" }, HELPED))).toBe("Only the owner can approve money. It waits for Lek.");
    expect(words({ kind: "not_permitted" }, ask({ kind: "public_post" }, HELPED))).toBe("Only the owner can approve public posts. It waits for Lek.");
    expect(words({ kind: "consent_required" })).toBe("Baan Mali hasn't agreed yet to let Manut AI send for it. Nothing was decided.");
    expect(words({ kind: "switched_off" })).toBe(s.switchedOff);
    expect(words({ kind: "not_offered" })).toBe(s.notOffered);
    expect(words({ kind: "gone" })).toBe(s.gone);
    expect(words({ kind: "left", left: { why: "removed", at: null } })).toBe("The owner removed you from Baan Mali. Ask them if this is a mistake.");
    expect(words({ kind: "unclear" })).toBe(s.unclear);
  });
});

describe("what the app keeps", () => {
  it("keeps nothing in the browser beyond the cookies it cannot read, and puts nothing in its address", async () => {
    const api = createFakeApi({ pagePath: () => "/app/", pageSearch: () => "" });
    window.history.replaceState(null, "", "/app/");
    renderWithApi(<OwnerApp />, api, "fake");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "fon@baanmali.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText(`Practice mode: no email was sent. Your code is ${PRACTICE_SIGN_IN_CODE}.`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: PRACTICE_SIGN_IN_CODE } });
    expect(await screen.findByRole("heading", { name: GREETING })).toBeTruthy();
    await openNeeds();
    fireEvent.click(within(card("practice-bm-late")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(s.sent)).toBeTruthy();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.pathname + window.location.search).toBe("/app/");
    expect(window.location.hash).toBe("#needs");
  });
});
