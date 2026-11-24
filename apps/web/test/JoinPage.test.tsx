import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type JoinAnswer, type PilotApi } from "../src/api";
import { createHttpApi } from "../src/api/client";
import { createFakeApi, DEMO_JOIN_TOKENS, PRACTICE_SIGN_IN_CODE } from "../src/api/fake";
import { App } from "../src/App";
import { JoinPage } from "../src/join/JoinPage";
import { deferred, renderWithApi, stubApi } from "./helpers";

const TOKEN = "inv1.cGlsb3Q6YmFhbi1tYWxp.4f2a9c0e";
const SHOP = { id: "pilot:baan-mali", name: "Baan Mali", ownerName: "Fon" };
const JOINED = {
  answer: "joined" as const,
  shop: SHOP,
  helper: { id: "helper-7", name: "Mint" },
  session: { accessToken: "mhs1.cGlsb3Q.helper-device", expiresAt: "2026-12-24T03:00:00.000Z" },
};

type Seen = { url: string; method: string; headers: Headers; body: string | undefined; credentials: RequestCredentials | undefined };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/// The real client over a scripted backend on the page's own origin, as the pages Worker serves it: every request is
/// recorded, and `answer` gives the response for its method and path.
function liveApi(answer: (route: string, body: unknown) => Response) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = typeof init.body === "string" ? init.body : undefined;
    seen.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body, credentials: init.credentials });
    return answer(`${init.method ?? "GET"} ${new URL(url).pathname}`, body === undefined ? undefined : JSON.parse(body));
  });
  return { api: createHttpApi({ origin: window.location.origin, operatorKey: () => null, fetch }), seen };
}

/// A backend that signs anyone in with 246810, one access token per sign-in (acc-1, acc-2, ...), and answers each accept
/// with the next of `answers`.
function scripted(answers: { status: number; body: unknown }[]) {
  let signIns = 0;
  let accepts = 0;
  return liveApi((route) => {
    switch (route) {
      case "POST /v1/auth/email/code":
        return json({ sent: true, expiresIn: 600, resendIn: 60 });
      case "POST /v1/auth/exchange":
        signIns += 1;
        return json({ accessToken: `acc-${signIns}`, refreshToken: `ref-${signIns}`, csrf: `csrf-${signIns}`, expiresIn: 3600,
          tenant: "email:0f1e2d" });
      case "POST /v1/people/accept": {
        const next = answers[Math.min(accepts, answers.length - 1)]!;
        accepts += 1;
        return json(next.body, next.status);
      }
      case "DELETE /v1/auth/session":
        return json({ revoked: true });
      case "POST /v1/shops/session/end":
        return json({ ended: { shop: SHOP.id, role: "helper" } });
      default:
        return json({ error: "not_found" }, 404);
    }
  });
}

function openJoin(api: PilotApi, mode: "live" | "fake" = "live", token = TOKEN) {
  window.history.replaceState(null, "", `/join/${token}`);
  return render(<App setup={{ api, mode }} />);
}

/// Types an address, asks for a code, and types the code: the sixth digit signs in.
async function signIn(email: string, code = "246810") {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  fireEvent.change(await screen.findByLabelText("6-digit code"), { target: { value: code } });
}

/// A stub API that sends a code and signs in at once, and records how the page ends what it held.
function signedInApi(overrides: Partial<PilotApi> = {}) {
  const signOut = vi.fn(async (_token: string) => undefined);
  const endShopSession = vi.fn(async (_token: string) => undefined);
  const api = stubApi({
    requestEmailCode: vi.fn(async () => ({ sent: true as const, expiresIn: 600, resendIn: 60 })),
    exchangeEmailCode: vi.fn(async () => ({ accessToken: "acc-1", refreshToken: "ref-1", csrf: "csrf-1", expiresIn: 3600,
      tenant: "email:0f1e2d" })),
    acceptInvite: vi.fn(async (): Promise<JoinAnswer> => JOINED),
    signOut,
    endShopSession,
    ...overrides,
  });
  return { api, signOut, endShopSession };
}

describe("the join page, against the real client", () => {
  it("joins with a code sent by email, sends the token only in the accept's body, and keeps nothing anywhere", async () => {
    const { api, seen } = scripted([{ status: 200, body: JOINED }]);
    openJoin(api);

    expect(screen.getByRole("heading", { name: "You've been invited to help with a shop on Manut AI" })).toBeTruthy();
    expect(screen.getByText("Sign in with the email address the invite was sent to. Then you'll see whose shop it is."))
      .toBeTruthy();
    const email = screen.getByLabelText("Email");
    expect([email.getAttribute("type"), email.getAttribute("autocomplete")]).toEqual(["email", "email"]);
    const send = screen.getByRole("button", { name: "Send code" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(email, { target: { value: "mint@" } });
    expect(send.disabled).toBe(true);
    fireEvent.change(email, { target: { value: " Mint@BaanMali.example " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    expect(await screen.findByText("We sent a code to m•••@baanmali.example. It works for 10 minutes.")).toBeTruthy();
    const box = screen.getByLabelText("6-digit code");
    expect([box.getAttribute("autocomplete"), box.getAttribute("inputmode")]).toEqual(["one-time-code", "numeric"]);
    expect(screen.getByText("You can ask for a new code in 1:00.")).toBeTruthy();
    // A pasted line holds the code; its sixth digit signs in with no extra press.
    fireEvent.change(box, { target: { value: "Your code is 246 810." } });

    expect(await screen.findByRole("heading", { name: "You've joined Baan Mali." })).toBeTruthy();
    expect(screen.getByText("Fon invited you to help. You can approve messages and replies to customers. Money, public posts and everything else still wait for Fon."))
      .toBeTruthy();
    expect(screen.getByText("Open Manut AI on a Mac and sign in with mint@baanmali.example. Baan Mali is listed there, ready to open."))
      .toBeTruthy();
    expect(screen.getByText("This page has signed you out, so you can close it.")).toBeTruthy();

    // The sign-in and the helper session the join gave are both ended, and the code went to the exchange only.
    await waitFor(() => expect(seen).toHaveLength(5));
    expect(seen.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/auth/email/code",
      "POST /v1/auth/exchange",
      "POST /v1/people/accept",
      "DELETE /v1/auth/session",
      "POST /v1/shops/session/end",
    ]);
    expect(seen.map((call) => call.headers.get("authorization"))).toEqual(
      [null, null, "Bearer acc-1", "Bearer acc-1", `Bearer ${JOINED.session.accessToken}`]);
    expect(JSON.parse(seen[0]!.body!)).toEqual({ email: "mint@baanmali.example" });
    expect(JSON.parse(seen[1]!.body!)).toMatchObject({ provider: "email", email: "mint@baanmali.example", code: "246810" });
    expect(JSON.parse(seen[1]!.body!).deviceId).toMatch(/^web-/);

    // The token travels in one place: the accept's body, exactly `{ token }`. Every request stays on this origin and
    // carries no cookie.
    for (const [index, call] of seen.entries()) {
      expect(call.url.startsWith(`${window.location.origin}/v1/`), call.url).toBe(true);
      expect(call.url, call.url).not.toContain(TOKEN);
      expect([...call.headers.values()].some((value) => value.includes(TOKEN)), call.url).toBe(false);
      expect(call.credentials, call.url).toBe("omit");
      if (index === 2) expect(call.body).toBe(JSON.stringify({ token: TOKEN }));
      else expect(call.body ?? "", call.url).not.toContain(TOKEN);
    }

    // Nothing was written to storage or cookies, the address bar is as it was opened, and no token is on the page.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect([window.location.pathname, window.location.search, window.location.hash]).toEqual([`/join/${TOKEN}`, "", ""]);
    for (const secret of ["acc-1", "ref-1", "csrf-1", JOINED.session.accessToken, "246810"]) {
      expect(document.body.textContent, secret).not.toContain(secret);
    }
  });

  it("asks no other origin for anything: no fonts, no scripts, no images", async () => {
    const { api } = scripted([{ status: 200, body: JOINED }]);
    openJoin(api);
    await signIn("mint@baanmali.example");
    await screen.findByRole("heading", { name: "You've joined Baan Mali." });
    const foreign = [...document.querySelectorAll("link[href], script[src], img[src], iframe[src]")]
      .map((element) => element.getAttribute("href") ?? element.getAttribute("src") ?? "")
      .filter((address) => new URL(address, window.location.href).origin !== window.location.origin);
    expect(foreign).toEqual([]);
  });

  it("switches account: the first sign-in is ended and forgotten, and the next accept goes with the new one", async () => {
    const { api, seen } = scripted([
      // An invited address in the answer, where the contract has none, must never reach the page.
      { status: 403, body: { answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "email",
        invited: "beam@baanmali.example" } },
      { status: 200, body: JOINED },
    ]);
    openJoin(api);
    await signIn("beam.k@example.com");

    expect(await screen.findByText("This invite to Baan Mali is for another email address. You signed in as beam.k@example.com."))
      .toBeTruthy();
    expect(screen.getByText("Sign in with the address Fon sent the invite to, or ask Fon for a new one.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("beam@baanmali.example");
    await waitFor(() => expect(seen.filter((call) => call.method === "DELETE")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(screen.getByRole("heading", { name: "You've been invited to help with a shop on Manut AI" })).toBeTruthy();
    await signIn("beam@baanmali.example");
    expect(await screen.findByRole("heading", { name: "You've joined Baan Mali." })).toBeTruthy();

    const accepts = seen.filter((call) => call.url.endsWith("/v1/people/accept"));
    expect(accepts.map((call) => call.headers.get("authorization"))).toEqual(["Bearer acc-1", "Bearer acc-2"]);
    await waitFor(() => expect(seen.filter((call) => call.method === "DELETE").map((call) => call.headers.get("authorization")))
      .toEqual(["Bearer acc-1", "Bearer acc-2"]));
    expect([localStorage.length, sessionStorage.length, document.cookie]).toEqual([0, 0, ""]);
  });
});

describe("the join page's answers", () => {
  const notices: [JoinAnswer, string, string][] = [
    [{ answer: "expired" }, "This invite has expired", "Ask the shop's owner for a new one. Invites work for 7 days."],
    [{ answer: "revoked" }, "This invite was cancelled", "The shop's owner cancelled it. Ask them for a new one if you still need it."],
    [{ answer: "already_used" }, "This invite has already been used",
      "Each invite works once. If you joined with it, open Manut AI on a Mac and sign in with that email. If not, ask the shop's owner for a new one."],
    [{ answer: "unknown" }, "This invite link does not work", "It may be cut short or changed. Ask the shop's owner to send it again."],
  ];

  for (const [answer, title, body] of notices) {
    it(`says ${answer.answer} in plain words that name no shop, and ends the sign-in`, async () => {
      const { api, signOut, endShopSession } = signedInApi({ acceptInvite: vi.fn(async () => answer) });
      renderWithApi(<JoinPage token={TOKEN} />, api);
      await signIn("mint@baanmali.example");
      expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
      expect(screen.getByText(body)).toBeTruthy();
      expect(document.body.textContent).not.toContain("Baan Mali");
      expect(document.body.textContent).not.toContain("Fon");
      expect(signOut).toHaveBeenCalledWith("acc-1");
      expect(endShopSession).not.toHaveBeenCalled();
    });
  }

  it("says an invite for a LINE account cannot be joined with email yet, naming the owner but never the account", async () => {
    const { api } = signedInApi({
      acceptInvite: vi.fn(async (): Promise<JoinAnswer> => ({ answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" },
        invitedOn: "line" })),
    });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("beam.k@example.com");
    expect(await screen.findByText("This invite to Baan Mali is for a LINE account. You signed in as beam.k@example.com."))
      .toBeTruthy();
    expect(screen.getByText("Manut AI can't sign you in with LINE yet. Ask Fon to invite your email address instead.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
  });

  it("sends the token it was opened with, and the sign-in's token, to the accept", async () => {
    const { api } = signedInApi();
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example");
    await screen.findByRole("heading", { name: "You've joined Baan Mali." });
    expect(api.acceptInvite).toHaveBeenCalledWith({ accessToken: "acc-1", inviteToken: TOKEN });
    expect(api.exchangeEmailCode).toHaveBeenCalledWith(expect.objectContaining({ email: "mint@baanmali.example", code: "246810" }));
  });

  it("tries the accept again when it got no answer, with the same sign-in", async () => {
    const accept = vi.fn<PilotApi["acceptInvite"]>()
      .mockRejectedValueOnce(new ApiError(0, "network"))
      .mockResolvedValueOnce(JOINED);
    const { api, signOut } = signedInApi({ acceptInvite: accept });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example");
    expect(await screen.findByRole("heading", { name: "You have not joined yet" })).toBeTruthy();
    expect(screen.getByText("Signed in as mint@baanmali.example")).toBeTruthy();
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "You've joined Baan Mali." })).toBeTruthy();
    expect(accept.mock.calls.map(([input]) => input.accessToken)).toEqual(["acc-1", "acc-1"]);
  });

  it("asks for a new sign-in when the one it held has ended", async () => {
    const { api } = signedInApi({ acceptInvite: vi.fn(async () => Promise.reject(new ApiError(401, "unauthorized"))) });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example");
    expect(await screen.findByText("Your sign-in ended before you joined. Sign in again.")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("ends a sign-in it still holds when the page goes away", async () => {
    const pending = deferred<JoinAnswer>();
    const { api, signOut } = signedInApi({ acceptInvite: vi.fn(() => pending.promise) });
    const { unmount } = renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example");
    await screen.findByText("Signed in as mint@baanmali.example");
    unmount();
    expect(signOut).toHaveBeenCalledWith("acc-1");
  });
});

describe("the join page's sign-in", () => {
  it("says how many tries a wrong code has left, keeps it in the box, and waits for Sign in once it is changed", async () => {
    const exchange = vi.fn<PilotApi["exchangeEmailCode"]>()
      .mockRejectedValueOnce(new ApiError(401, "wrong_code", undefined, { triesLeft: 3 }))
      .mockRejectedValueOnce(new ApiError(401, "wrong_code", undefined, { triesLeft: 1 }))
      .mockResolvedValueOnce({ accessToken: "acc-1", refreshToken: "r", csrf: "c", expiresIn: 3600, tenant: "email:x" });
    const { api } = signedInApi({ exchangeEmailCode: exchange });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example", "111111");

    expect(await screen.findByText("That code does not match. 3 tries left. Check the newest email from Manut AI.")).toBeTruthy();
    const box = screen.getByLabelText("6-digit code") as HTMLInputElement;
    expect([box.value, box.getAttribute("aria-invalid")]).toEqual(["111111", "true"]);
    // Fixing a digit of a full box does not spend a try by itself.
    fireEvent.change(box, { target: { value: "111112" } });
    expect(exchange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That code does not match. 1 try left. Check the newest email from Manut AI.")).toBeTruthy();
    fireEvent.change(box, { target: { value: "24681" } });
    fireEvent.change(box, { target: { value: "246810" } });
    expect(await screen.findByRole("heading", { name: "You've joined Baan Mali." })).toBeTruthy();
    expect(exchange.mock.calls.map(([input]) => input.code)).toEqual(["111111", "111112", "246810"]);
  });

  it("offers a new code once a code has ended, and the new one empties the box", async () => {
    const send = vi.fn(async () => ({ sent: true as const, expiresIn: 600, resendIn: 0 }));
    const { api } = signedInApi({
      requestEmailCode: send,
      exchangeEmailCode: vi.fn(async () => Promise.reject(new ApiError(401, "wrong_code", undefined, { triesLeft: 0 }))),
    });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example", "999999");
    expect(await screen.findByText("That code does not match, and it can't be tried again. Send a new code.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    expect(await screen.findByText("We sent a new code. The one before no longer works.")).toBeTruthy();
    expect((screen.getByLabelText("6-digit code") as HTMLInputElement).value).toBe("");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("mint@baanmali.example");
  });

  it("says a code ended in the canvas's terms", async () => {
    const { api } = signedInApi({ exchangeEmailCode: vi.fn(async () => Promise.reject(new ApiError(401, "code_ended"))) });
    renderWithApi(<JoinPage token={TOKEN} />, api);
    await signIn("mint@baanmali.example");
    expect(await screen.findByText("This code no longer works. Codes last 10 minutes, and five wrong tries end one. Send a new code."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeTruthy();
  });

  it("says each refusal of asking for a code, with the wait it carries", async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(429, "too_many_codes", undefined, { retryAfter: 42 }), "Too many codes for this address. Try again in 1 minute."],
      [new ApiError(429, "too_many_codes", undefined, { retryAfter: 30_000 }), "Too many codes for this address. Try again in 9 hours."],
      [new ApiError(429, "rate_limited", undefined, { retryAfter: 60 }), "Too many tries from this network. Try again in 1 minute."],
      [new ApiError(0, "network"), "You're offline, or Manut AI can't be reached. Check your connection and try again."],
      [new ApiError(400, "invalid_request"), "Manut AI did not accept that address. Check it and try again."],
      [new ApiError(503, "rate_limit_unavailable"), "Something went wrong at Manut AI. Try again in a moment."],
    ];
    for (const [refusal, words] of cases) {
      const { api } = signedInApi({ requestEmailCode: vi.fn(async () => Promise.reject(refusal)) });
      const { unmount } = renderWithApi(<JoinPage token={TOKEN} />, api);
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mint@baanmali.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Send code" }));
      expect(await screen.findByText(words), refusal.code).toBeTruthy();
      expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true");
      unmount();
    }
  });

  it("says each refusal of a code", async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(0, "network"), "You're offline, or Manut AI can't be reached. Check your connection and try again."],
      [new ApiError(400, "invalid_request"), "Manut AI did not accept that code. Check it and try again."],
      [new ApiError(429, "rate_limited", undefined, { retryAfter: 60 }), "Too many tries from this network. Try again in 1 minute."],
    ];
    for (const [refusal, words] of cases) {
      const { api } = signedInApi({ exchangeEmailCode: vi.fn(async () => Promise.reject(refusal)) });
      const { unmount } = renderWithApi(<JoinPage token={TOKEN} />, api);
      await signIn("mint@baanmali.example");
      expect(await screen.findByText(words), refusal.code).toBeTruthy();
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
      unmount();
    }
  });

  it("says plainly that joining by email is not on yet, from either sign-in route", async () => {
    for (const where of ["code", "exchange"] as const) {
      const off = () => Promise.reject(new ApiError(400, "email_not_configured"));
      const { api } = signedInApi(where === "code" ? { requestEmailCode: vi.fn(off) } : { exchangeEmailCode: vi.fn(off) });
      const { unmount } = renderWithApi(<JoinPage token={TOKEN} />, api);
      if (where === "code") {
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mint@baanmali.example" } });
        fireEvent.click(screen.getByRole("button", { name: "Send code" }));
      } else {
        await signIn("mint@baanmali.example");
      }
      expect(await screen.findByRole("heading", { name: "Joining by email isn't on yet" }), where).toBeTruthy();
      expect(screen.getByText("Manut AI can't sign you in with an email code yet, so this invite can't be used today. Ask the shop's owner to try again later."))
        .toBeTruthy();
      expect(screen.queryByLabelText("Email")).toBeNull();
      expect(screen.queryByLabelText("6-digit code")).toBeNull();
      unmount();
    }
  });

  it("counts down to a new code from when the answer arrived, then offers one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { api } = signedInApi();
    renderWithApi(<JoinPage token={TOKEN} />, api);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mint@baanmali.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText("You can ask for a new code in 1:00.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a new code" })).toBeNull();
    act(() => vi.advanceTimersByTime(18_000));
    expect(screen.getByText("You can ask for a new code in 0:42.")).toBeTruthy();
    act(() => vi.advanceTimersByTime(42_000));
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeTruthy();
  });

  it("goes back to the address with Use another email, keeping what was typed", async () => {
    const { api } = signedInApi();
    renderWithApi(<JoinPage token={TOKEN} />, api);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "mint@baanmali.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use another email" }));
    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("mint@baanmali.example");
  });
});

describe("the join page in practice mode", () => {
  it("serves the whole flow from the fake, saying its pretend code, and joins the demo shop", async () => {
    openJoin(createFakeApi(), "fake", DEMO_JOIN_TOKENS.joined);
    expect(screen.getByText("Practice mode. This page uses sample data and sends no email.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "noi@khaosoi.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText(`Practice mode: no email was sent. Your code is ${PRACTICE_SIGN_IN_CODE}.`)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: PRACTICE_SIGN_IN_CODE } });
    expect(await screen.findByRole("heading", { name: "You've joined Khao Soi Nimman." })).toBeTruthy();
    expect(screen.getByText(/^Lek invited you to help\./)).toBeTruthy();
  });

  it("answers the sign-in-off demo link as every real environment does today", async () => {
    openJoin(createFakeApi(), "fake", DEMO_JOIN_TOKENS.signInOff);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "noi@khaosoi.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByRole("heading", { name: "Joining by email isn't on yet" })).toBeTruthy();
  });

  it("answers a wrong practice code with the tries it has left", async () => {
    openJoin(createFakeApi(), "fake", DEMO_JOIN_TOKENS.expired);
    await signIn("noi@khaosoi.example", "000000");
    expect(await screen.findByText("That code does not match. 4 tries left. Check the newest email from Manut AI.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: PRACTICE_SIGN_IN_CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "This invite has expired" })).toBeTruthy();
  });
});
