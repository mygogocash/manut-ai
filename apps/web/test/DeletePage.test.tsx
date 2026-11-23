import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type DeletionView } from "../src/api";
import { DeletePage } from "../src/delete/DeletePage";
import { deferred, renderWithApi, sampleDeletionView, stubApi } from "./helpers";

const TOKEN = "del_abc";
const DECIDED_AT = "2026-11-23T07:05:00Z";

function deleteButton() {
  return screen.getByRole("button", { name: "Delete everything" });
}

function keepButton() {
  return screen.getByRole("button", { name: "Keep my data" });
}

describe("the owner's deletion page", () => {
  it("says what goes and that it can't be undone, and ends in the danger step beside Keep my data", async () => {
    const getDeletion = vi.fn(() => Promise.resolve(sampleDeletionView()));
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion }));

    const card = await screen.findByRole("article", { name: "Delete everything Manut AI stores for Baan Mali?" });
    expect(getDeletion).toHaveBeenCalledWith(TOKEN);
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your shop's details",
      "7 customer messages",
      "6 replies",
      "2 payment records",
      "The connection to your LINE account, so new messages stop arriving at Manut AI",
    ]);
    expect(within(card).getByText("It can't be undone. Your chats in LINE itself are not touched.")).toBeTruthy();
    expect(deleteButton().className).toBe("btn danger solid");
    expect(keepButton().className).toBe("btn");
    expect(within(card).getByText(/^If you do not answer by \d\d:\d\d (today|tomorrow), nothing is deleted\.$/))
      .toBeTruthy();
    expect(document.title).toBe("Delete your shop's data");
  });

  it("names only what the shop has, one at a time", async () => {
    const view = sampleDeletionView({ goes: { messages: 1, replies: 0, payments: 1, lineConnected: false } });
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion: () => Promise.resolve(view) }));
    const card = await screen.findByRole("article");
    expect(within(card).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your shop's details",
      "1 customer message",
      "1 payment record",
    ]);
  });

  it("deletes on yes and says it is done", async () => {
    const decideDeletion = vi.fn(() => Promise.resolve(sampleDeletionView({ state: "deleted", decidedAt: DECIDED_AT })));
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()), decideDeletion }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));

    expect(await screen.findByText("Done. Baan Mali's data is deleted.")).toBeTruthy();
    expect(decideDeletion).toHaveBeenCalledWith(TOKEN, true);
    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getByText("Answered at 14:05.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the data on Keep my data", async () => {
    const decideDeletion = vi.fn(() => Promise.resolve(sampleDeletionView({ state: "declined", decidedAt: DECIDED_AT })));
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()), decideDeletion }));

    fireEvent.click(await screen.findByRole("button", { name: "Keep my data" }));

    expect(await screen.findByText("You kept your data. Nothing was deleted.")).toBeTruthy();
    expect(decideDeletion).toHaveBeenCalledWith(TOKEN, false);
    expect(screen.getByText("The Manut AI team can see your answer.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets the first press win: both buttons are off while the answer is on its way", async () => {
    const pending = deferred<DeletionView>();
    const decideDeletion = vi.fn(() => pending.promise);
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()), decideDeletion }));

    const remove = await screen.findByRole("button", { name: "Delete everything" });
    const keep = keepButton();
    fireEvent.click(remove);
    fireEvent.click(remove);
    fireEvent.click(keep);

    expect(decideDeletion).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole("button", { name: "Deleting" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(true);
    expect(keep.hasAttribute("disabled")).toBe(true);

    await act(async () => pending.resolve(sampleDeletionView({ state: "deleted", decidedAt: DECIDED_AT })));
    expect(screen.getByText("Done. Baan Mali's data is deleted.")).toBeTruthy();
  });

  it("reads the request again every 2 seconds while it is being deleted, and stops once it is", async () => {
    vi.useFakeTimers();
    const reads = [sampleDeletionView(), sampleDeletionView({ state: "deleting", decidedAt: DECIDED_AT }),
      sampleDeletionView({ state: "deleted", decidedAt: DECIDED_AT })];
    let read = 0;
    const getDeletion = vi.fn(() => Promise.resolve(reads[Math.min(read++, 2)]!));
    const decideDeletion = vi.fn(() => Promise.resolve(sampleDeletionView({ state: "deleting", decidedAt: DECIDED_AT })));
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion, decideDeletion }));
    const flush = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    await flush(0);
    fireEvent.click(deleteButton());
    await flush(0);
    expect(screen.getByText("You said yes. Deleting Baan Mali's data.")).toBeTruthy();
    expect(screen.getByText("Manut AI finishes it even if you close this page.")).toBeTruthy();
    expect(getDeletion).toHaveBeenCalledTimes(1);

    await flush(1999);
    expect(getDeletion).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(getDeletion).toHaveBeenCalledTimes(2);
    await flush(2000);
    expect(getDeletion).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Done. Baan Mali's data is deleted.")).toBeTruthy();

    await flush(10000);
    expect(getDeletion).toHaveBeenCalledTimes(3);
  });

  it("stops reading a deletion that does not finish, which Manut AI then finishes", async () => {
    vi.useFakeTimers();
    const getDeletion = vi.fn(() => Promise.resolve(sampleDeletionView({ state: "deleting", decidedAt: DECIDED_AT })));
    renderWithApi(<DeletePage token={TOKEN} pollMs={2000} maxPolls={3} />, stubApi({ getDeletion }));
    const flush = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    await flush(0);
    expect(screen.getByText("You said yes. Deleting Baan Mali's data.")).toBeTruthy();
    // One interval at a time, so each read's answer renders before the next is due.
    for (let step = 0; step < 10; step++) await flush(2000);
    expect(getDeletion).toHaveBeenCalledTimes(4);
    expect(screen.getByText("Manut AI finishes it even if you close this page.")).toBeTruthy();
  });

  it("shows what happened when someone answered first", async () => {
    const decided = sampleDeletionView({ state: "declined", decidedAt: "2026-11-23T12:42:00Z" });
    const decideDeletion = vi.fn(() =>
      Promise.reject(new ApiError(409, "already_decided", undefined, { deletionView: decided })));
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()), decideDeletion }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("This request was already answered at 19:42, so your answer was not used.");
    expect(screen.getByText("You kept your data. Nothing was deleted.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete everything" })).toBeNull();
  });

  it.each([
    ["deleted", "Done. Baan Mali's data is deleted."],
    ["declined", "You kept your data. Nothing was deleted."],
    ["expired", "Nobody answered in 24 hours, so nothing was deleted."],
    ["deleting", "You said yes. Deleting Baan Mali's data."],
  ] as const)("opens straight to the outcome of a request that is %s", async (state, text) => {
    vi.useFakeTimers();
    const view = sampleDeletionView({ state, ...(state === "expired" ? {} : { decidedAt: DECIDED_AT }) });
    renderWithApi(<DeletePage token={TOKEN} maxPolls={0} />, stubApi({ getDeletion: () => Promise.resolve(view) }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    if (state === "expired") expect(screen.getByText("To delete your data, ask the Manut AI team for a new link.")).toBeTruthy();
  });

  it("explains an expired link", async () => {
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.reject(new ApiError(410, "link_expired")) }));
    expect(await screen.findByRole("heading", { name: "This link has expired" })).toBeTruthy();
    expect(screen.getByText(/Links work for 24 hours, and this one has run out\. If you answered before then/))
      .toBeTruthy();
  });

  it("explains a link that does not work", async () => {
    renderWithApi(<DeletePage token={TOKEN} />,
      stubApi({ getDeletion: () => Promise.reject(new ApiError(404, "link_invalid")) }));
    expect(await screen.findByRole("heading", { name: "This link does not work" })).toBeTruthy();
    expect(screen.getByText(/Nothing was deleted from it\./)).toBeTruthy();
  });

  it("offers Try again when the request cannot be loaded", async () => {
    const getDeletion = vi
      .fn<() => Promise<DeletionView>>()
      .mockRejectedValueOnce(new ApiError(0, "network"))
      .mockResolvedValue(sampleDeletionView());
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion }));
    expect(await screen.findByRole("heading", { name: "Could not load this request" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Delete everything" })).toBeTruthy();
  });

  it("checks where things stand when an answer is lost, then lets the owner try again", async () => {
    const getDeletion = vi.fn(() => Promise.resolve(sampleDeletionView()));
    const decideDeletion = vi.fn(() => Promise.reject(new ApiError(0, "network")));
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion, decideDeletion }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Your answer did not get through. Nothing was deleted. Try again.");
    expect(getDeletion).toHaveBeenCalledTimes(2);
    expect(deleteButton().hasAttribute("disabled")).toBe(false);
  });

  it("shows the outcome when a lost answer did land", async () => {
    const getDeletion = vi
      .fn<() => Promise<DeletionView>>()
      .mockResolvedValueOnce(sampleDeletionView())
      .mockResolvedValue(sampleDeletionView({ state: "deleted", decidedAt: DECIDED_AT }));
    const decideDeletion = vi.fn(() => Promise.reject(new ApiError(503, "unavailable")));
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion, decideDeletion }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));
    expect(await screen.findByText("Done. Baan Mali's data is deleted.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when Manut AI cannot be reached to check an answer", async () => {
    const getDeletion = vi
      .fn<() => Promise<DeletionView>>()
      .mockResolvedValueOnce(sampleDeletionView())
      .mockRejectedValue(new ApiError(0, "network"));
    const decideDeletion = vi.fn(() => Promise.reject(new ApiError(0, "network")));
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion, decideDeletion }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete everything" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "We could not reach Manut AI to check your answer. Try again.");
  });

  it("moves to the expired or broken link notice when the answer says so", async () => {
    for (const [error, heading] of [
      [new ApiError(410, "link_expired"), "This link has expired"],
      [new ApiError(404, "link_invalid"), "This link does not work"],
    ] as const) {
      const { unmount } = renderWithApi(<DeletePage token={TOKEN} />, stubApi({
        getDeletion: () => Promise.resolve(sampleDeletionView()),
        decideDeletion: () => Promise.reject(error),
      }));
      fireEvent.click(await screen.findByRole("button", { name: "Keep my data" }));
      expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
      unmount();
    }
  });

  it("says when it is practice", async () => {
    renderWithApi(<DeletePage token={TOKEN} />, stubApi({ getDeletion: () => Promise.resolve(sampleDeletionView()) }),
      "fake");
    expect(await screen.findByText("Practice mode. This page uses sample data and deletes nothing real.")).toBeTruthy();
  });
});
