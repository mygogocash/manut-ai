import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApprovalView } from "../src/api";
import { ApprovePage } from "../src/approve/ApprovePage";
import { deferred, renderWithApi, sampleView, stubApi } from "./helpers";

const TOKEN = "tok_abc";

function approveButton() {
  return screen.getByRole("button", { name: "Approve" });
}

function noButton() {
  return screen.getByRole("button", { name: "No" });
}

describe("the owner's page", () => {
  it("shows who is asking, the customer's message, the exact reply, Approve and No", async () => {
    const view = sampleView();
    const getApproval = vi.fn(() => Promise.resolve(view));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval }));

    expect(await screen.findByText("Nam, sales chat")).toBeTruthy();
    expect(getApproval).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByText("Sends a reply to Khun Ploy on LINE. It can't be unsent.")).toBeTruthy();
    expect(screen.getByText("Khun Ploy wrote")).toBeTruthy();
    expect(screen.getByText(view.customerMessage).getAttribute("lang")).toBe("th");
    expect(screen.getByTestId("reply-text").textContent).toBe(view.replyText);
    expect(approveButton().hasAttribute("disabled")).toBe(false);
    expect(noButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/^If nobody answers by \d\d:\d\d (today|tomorrow), nothing is sent\.$/)).toBeTruthy();
  });

  it("asks for consent once before approving, then records it and sends", async () => {
    const decide = vi.fn(() => Promise.resolve(sampleView({ state: "dispatching", decidedAt: new Date().toISOString() })));
    const giveConsent = vi.fn(() => Promise.resolve(sampleView({ needsConsent: false })));
    const getApproval = vi.fn(() => Promise.resolve(sampleView({ needsConsent: true })));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval, giveConsent, decide }));

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(screen.getByRole("heading", { name: "Allow Manut AI to send messages for Baan Mali on LINE" })).toBeTruthy();
    expect(screen.getByText(/needs your permission to send messages from your LINE account/)).toBeTruthy();
    expect(giveConsent).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Allow and send this reply" }));
    expect(await screen.findByText("Approved. Sending the reply to Khun Ploy.")).toBeTruthy();
    expect(giveConsent).toHaveBeenCalledWith(TOKEN);
    expect(decide).toHaveBeenCalledWith(TOKEN, true);
    expect(giveConsent.mock.invocationCallOrder[0]!).toBeLessThan(decide.mock.invocationCallOrder[0]!);
  });

  it("goes back to the request, with nothing sent, when the owner picks Not now", async () => {
    const giveConsent = vi.fn();
    const decide = vi.fn();
    renderWithApi(
      <ApprovePage token={TOKEN} />,
      stubApi({ getApproval: () => Promise.resolve(sampleView({ needsConsent: true })), giveConsent, decide }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(approveButton()).toBeTruthy();
    expect(giveConsent).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it("lets the first press win: both buttons are off while the answer is on its way", async () => {
    const pending = deferred<ApprovalView>();
    const decide = vi.fn(() => pending.promise);
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.resolve(sampleView()), decide }));

    const approve = await screen.findByRole("button", { name: "Approve" });
    const no = noButton();
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(no);

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledWith(TOKEN, true);
    const busy = screen.getByRole("button", { name: "Approving" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(no.hasAttribute("disabled")).toBe(true);

    await act(async () => pending.resolve(sampleView({ state: "dispatching" })));
    expect(screen.getByText("Approved. Sending the reply to Khun Ploy.")).toBeTruthy();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("polls every 2 seconds while sending and stops once the reply is sent", async () => {
    vi.useFakeTimers();
    const decidedAt = "2026-11-23T07:05:00Z";
    const reads = [
      sampleView(),
      sampleView({ state: "dispatching", decidedAt }),
      sampleView({ state: "confirmed", decidedAt }),
    ];
    let read = 0;
    const getApproval = vi.fn(() => Promise.resolve(reads[Math.min(read++, 2)]!));
    const decide = vi.fn(() => Promise.resolve(sampleView({ state: "dispatching", decidedAt })));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval, decide }));
    const flush = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    await flush(0);
    fireEvent.click(approveButton());
    await flush(0);
    expect(screen.getByText("Approved. Sending the reply to Khun Ploy.")).toBeTruthy();
    expect(getApproval).toHaveBeenCalledTimes(1);

    await flush(1999);
    expect(getApproval).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(getApproval).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Sending")).toBeTruthy();

    await flush(2000);
    expect(getApproval).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Approved. Nam sent the reply to Khun Ploy.")).toBeTruthy();
    expect(screen.getByText("Answered at 14:05.")).toBeTruthy();

    await flush(10000);
    expect(getApproval).toHaveBeenCalledTimes(3);
  });

  it("says plainly when the send failed", async () => {
    let reads = 0;
    const getApproval = vi.fn(() => Promise.resolve(sampleView({ state: reads++ === 0 ? "proposed" : "failed" })));
    renderWithApi(
      <ApprovePage token={TOKEN} pollMs={1} />,
      stubApi({ getApproval, decide: () => Promise.resolve(sampleView({ state: "dispatching" })) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("You approved, but LINE did not accept the reply. Nothing was sent to Khun Ploy.");
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("warns not to send again when nobody can tell whether it was sent", async () => {
    let reads = 0;
    const getApproval = vi.fn(() => Promise.resolve(sampleView({ state: reads++ === 0 ? "proposed" : "unknown" })));
    renderWithApi(
      <ApprovePage token={TOKEN} pollMs={1} />,
      stubApi({ getApproval, decide: () => Promise.resolve(sampleView({ state: "dispatching" })) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("We are not sure it was sent. Do not send it again; we will check.");
  });

  it("shows a declined request with nothing sent", async () => {
    const decide = vi.fn(() => Promise.resolve(sampleView({ state: "rejected", decidedAt: "2026-11-23T07:05:00Z" })));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.resolve(sampleView({ needsConsent: true })), decide }));
    fireEvent.click(await screen.findByRole("button", { name: "No" }));
    expect(await screen.findByText("You said no. Nothing was sent to Khun Ploy.")).toBeTruthy();
    expect(decide).toHaveBeenCalledWith(TOKEN, false);
    expect(screen.getByText("Declined")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows what happened when someone else answered first", async () => {
    const decided = sampleView({ state: "confirmed", decidedAt: "2026-11-23T12:42:00Z" });
    const decide = vi.fn(() => Promise.reject(new ApiError(409, "already_decided", decided)));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.resolve(sampleView()), decide }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(
      "This request was already answered at 19:42, so your answer was not used. Nothing was sent twice.",
    );
    expect(screen.getByText("Approved. Nam sent the reply to Khun Ploy.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("opens straight to the outcome when the request was answered before", async () => {
    renderWithApi(
      <ApprovePage token={TOKEN} />,
      stubApi({ getApproval: () => Promise.resolve(sampleView({ state: "confirmed", decidedAt: "2026-11-23T07:05:00Z" })) }),
    );
    expect(await screen.findByText("Approved. Nam sent the reply to Khun Ploy.")).toBeTruthy();
    expect(screen.getByText("What was sent")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains a request nobody answered in time", async () => {
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.resolve(sampleView({ state: "expired" })) }));
    expect(
      await screen.findByText("Nam asked to send a reply to Khun Ploy. Nobody answered in 24 hours, so nothing was sent."),
    ).toBeTruthy();
  });

  it("explains an expired link", async () => {
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.reject(new ApiError(410, "link_expired")) }));
    expect(await screen.findByRole("heading", { name: "This link has expired" })).toBeTruthy();
    expect(screen.getByText(/Links work for 24 hours/)).toBeTruthy();
  });

  it("explains a link that does not work", async () => {
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.reject(new ApiError(404, "link_invalid")) }));
    expect(await screen.findByRole("heading", { name: "This link does not work" })).toBeTruthy();
  });

  it("offers Try again when the request cannot be loaded", async () => {
    const getApproval = vi
      .fn<() => Promise<ApprovalView>>()
      .mockRejectedValueOnce(new ApiError(0, "network"))
      .mockResolvedValue(sampleView());
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("checks where things stand when an answer is lost, then lets the owner try again", async () => {
    const getApproval = vi.fn(() => Promise.resolve(sampleView()));
    const decide = vi.fn(() => Promise.reject(new ApiError(0, "network")));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval, decide }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Your answer did not get through. Nothing was sent. Try again.");
    expect(getApproval).toHaveBeenCalledTimes(2);
    expect(approveButton().hasAttribute("disabled")).toBe(false);
  });

  it("asks for consent when the backend says it is missing", async () => {
    const decide = vi.fn(() => Promise.reject(new ApiError(403, "consent_required")));
    renderWithApi(<ApprovePage token={TOKEN} />, stubApi({ getApproval: () => Promise.resolve(sampleView()), decide }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const step = await screen.findByRole("article", { name: "Allow Manut AI to send messages for Baan Mali on LINE" });
    expect(within(step).getByRole("alert").textContent).toBe(
      "Manut AI needs your permission before it can send this reply.",
    );
  });
});
