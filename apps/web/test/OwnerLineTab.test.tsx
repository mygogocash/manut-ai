import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeApi, lineSignature, PRACTICE_OWNER_LINE_SECRET } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { renderWithApi } from "./helpers";

// Owner messages on LINE in the operator console, against the practice-mode fake: whether a shop's owner is linked,
// getting a link code with how to use it, unlinking, and each card's delivery on its reply.

const NOW = Date.parse("2026-11-23T03:00:00Z"); // 10:00 in Bangkok

function fakeApi(options: { ownerLineEnabled?: boolean } = {}) {
  return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test", ...options });
}

async function openOwnerTab(shopName: string) {
  fireEvent.click(await screen.findByRole("button", { name: shopName }));
  fireEvent.click(await screen.findByRole("tab", { name: "Owner on LINE" }));
  return screen.findByRole("tabpanel", { name: "Owner on LINE" });
}

describe("the console's owner on LINE", () => {
  beforeEach(() => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
  });

  it("gets a link code for an owner not yet linked, says how to use it, and shows the link once made", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fakeApi();
    renderWithApi(<OpsConsole />, api);
    const panel = await openOwnerTab("Sabai Tea");
    expect(screen.getByText("Owner not linked on LINE")).toBeTruthy();
    await within(panel).findByText("Dao is not linked yet.");

    fireEvent.click(within(panel).getByRole("button", { name: "Get a link code" }));
    const box = await within(panel).findByRole("group", { name: "Link code for Dao" });
    const shown = (within(box).getByLabelText("Link code") as HTMLInputElement).value;
    expect(shown).toMatch(/^[0-9]{4} [0-9]{4}$/);
    expect(within(box).getByText("Ask Dao to add Manut AI (@manutai) as a friend on LINE.")).toBeTruthy();
    expect(within(box).getByText("Dao sends this code in that chat. Spaces do not matter.")).toBeTruthy();
    expect(within(box).getByText(
      "It works once, until 10:30. Dao gets an answer in the chat when it works. Refresh to see it here.")).toBeTruthy();
    fireEvent.click(within(box).getByRole("button", { name: "Copy link code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shown.replace(" ", "")));

    // Dao sends the code to Manut AI's account; a refresh shows the link.
    const body = JSON.stringify({ destination: "Umanutpractice", events: [{ type: "message", webhookEventId: "ev1",
      replyToken: "practice", source: { type: "user", userId: `U${"d".repeat(32)}` },
      message: { type: "text", id: "1", text: shown } }] });
    await api.deliverOwnerLineWebhook(body, await lineSignature(PRACTICE_OWNER_LINE_SECRET, body));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await within(panel).findByText("Dao linked on LINE at 10:00.");
    expect(await screen.findByText("Owner linked on LINE")).toBeTruthy();
  });

  it("says why a code would get no answer while owner messages are off, and offers none", async () => {
    renderWithApi(<OpsConsole />, fakeApi({ ownerLineEnabled: false }));
    const panel = await openOwnerTab("Sabai Tea");
    await within(panel).findByText(
      "Owner messages on LINE are turned off. Codes get no answer and nothing is sent until they are turned on.");
    expect((within(panel).getByRole("button", { name: "Get a link code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("unlinks a linked owner after asking first", async () => {
    const api = fakeApi();
    const unlink = vi.spyOn(api, "unlinkOwner");
    renderWithApi(<OpsConsole />, api);
    const panel = await openOwnerTab("Baan Mali");
    await within(panel).findByText("Fon linked on LINE on 20 November at 10:00.");

    fireEvent.click(within(panel).getByRole("button", { name: "Unlink" }));
    const ask = within(panel).getByRole("group", { name: "Unlink Fon?" });
    expect(within(ask).getByText(
      "Fon gets no more cards or morning summaries until linked again with a new code. Nothing else changes.")).toBeTruthy();
    fireEvent.click(within(ask).getByRole("button", { name: "Keep linked" }));
    expect(unlink).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Unlink" }));
    fireEvent.click(within(within(panel).getByRole("group", { name: "Unlink Fon?" })).getByRole("button",
      { name: "Unlink Fon" }));
    await within(panel).findByText("Fon is not linked yet.");
    expect(unlink).toHaveBeenCalledWith("shop_baanmali");
    expect(await screen.findByText("Owner not linked on LINE")).toBeTruthy();
  });

  it("shows each card's delivery on its reply, and sends a failed one again", async () => {
    const api = fakeApi();
    const retry = vi.spyOn(api, "retryOwnerCard");
    renderWithApi(<OpsConsole />, api);
    const replies = await screen.findByRole("list", { name: "Replies" });
    await within(replies).findByText("The card to Fon did not go out: LINE refused it (provider_429).");
    expect(within(replies).getAllByText(/^Card sent to Fon on LINE/).length).toBeGreaterThan(0);
    expect(within(replies).getByText(
      "Not sure the card reached Fon: LINE did not answer. Sending it again is safe, since LINE never shows it twice.")).toBeTruthy();
    // Only replies that still wait, and whose card may not have arrived, offer it.
    expect(within(replies).getAllByRole("button", { name: "Send the card again" })).toHaveLength(2);

    const row = within(replies).getByText("The card to Fon did not go out: LINE refused it (provider_429).").closest("li")!;
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Send the card again" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("shop_baanmali", "act_nok"));
    await waitFor(() => expect(within(replies).queryByText(
      "The card to Fon did not go out: LINE refused it (provider_429).")).toBeNull());
    expect(within(replies).getAllByRole("button", { name: "Send the card again" })).toHaveLength(1);
  });
});
