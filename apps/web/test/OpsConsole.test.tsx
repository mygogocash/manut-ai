import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { promptPayPayload } from "@manut/promptpay";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import { createFakeApi } from "../src/api/fake";
import { OpsConsole } from "../src/ops/OpsConsole";
import { readOperatorKey } from "../src/ops/operatorKey";
import { renderWithApi } from "./helpers";

vi.mock("@manut/promptpay", () => ({
  promptPayPayload: vi.fn((input: { id: string; amountSatang?: number }) => {
    if (!/^0\d{9}$/.test(input.id)) throw new Error("invalid_id");
    return `00020101021229370016A000000677010111011300668${input.id.slice(1)}5802TH5303764${input.amountSatang ?? ""}6304ABCD`;
  }),
}));

const NOW = Date.parse("2026-11-23T03:00:00Z");

function fakeApi() {
  return createFakeApi({ operatorKey: readOperatorKey, now: () => NOW, webOrigin: "https://web.test" });
}

describe("the operator console", () => {
  beforeEach(() => {
    vi.mocked(promptPayPayload).mockClear();
  });

  it("keeps the operator key in sessionStorage only, then loads the shops and messages newest first", async () => {
    renderWithApi(<OpsConsole />, fakeApi());

    const field = screen.getByLabelText("Operator key");
    expect(field.getAttribute("type")).toBe("password");
    fireEvent.change(field, { target: { value: "op-key-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));

    expect(sessionStorage.getItem("manut.pilot.operatorKey")).toBe("op-key-123");
    expect(Object.values({ ...localStorage })).not.toContain("op-key-123");

    const shopButton = await screen.findByRole("button", { name: "Baan Mali" });
    await waitFor(() => expect(shopButton.getAttribute("aria-current")).toBe("page"));
    expect(screen.getByRole("button", { name: "Sabai Tea" })).toBeTruthy();
    const section = await screen.findByRole("region", { name: "Customer messages" });
    await within(section).findByText("Khun Ploy");
    const names = within(section)
      .getAllByRole("button")
      .map((row) => row.textContent ?? "");
    expect(names).toHaveLength(7);
    const order = ["Khun Ploy", "Khun Arthit", "Khun Nok", "A customer", "Khun Mai", "Khun Fah", "Khun Joy"];
    expect(names.map((text) => order.find((name) => text.includes(name)))).toEqual(order);
  });

  it("proposes a reply on the selected message and shows the approval link with Copy", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const api = fakeApi();
    const propose = vi.spyOn(api, "proposeReply");
    renderWithApi(<OpsConsole />, api);

    fireEvent.click(await screen.findByRole("button", { name: /Khun Arthit/ }));
    const reply = screen.getByLabelText("Reply as Nam");
    fireEvent.change(reply, { target: { value: "  ขออภัยด้วยนะคะ จะคืนเงิน ฿350 ให้ภายในวันนี้ค่ะ  " } });
    expect(screen.getByText(/Fon sees exactly this text and approves it before anything is sent\. 47 of 5,000 characters\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Propose reply" }));

    const box = await screen.findByRole("status");
    const link = within(box).getByLabelText("Approval link") as HTMLInputElement;
    expect(link.value).toMatch(/^https:\/\/web\.test\/approve\/[A-Za-z0-9_-]+$/);
    expect(within(box).getByText(/Send it to Fon on LINE\. It answers this one reply only and works until 24 November 10:00\./)).toBeTruthy();
    expect(propose).toHaveBeenCalledWith({
      tenant: "shop_baanmali",
      messageId: "msg_arthit",
      text: "ขออภัยด้วยนะคะ จะคืนเงิน ฿350 ให้ภายในวันนี้ค่ะ",
    });

    fireEvent.click(within(box).getByRole("button", { name: "Copy approval link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link.value));
    expect(await within(box).findByRole("button", { name: "Copied" })).toBeTruthy();

    // The link really is the owner's: it opens this exact reply.
    const token = decodeURIComponent(link.value.split("/approve/")[1]!);
    expect((await api.getApproval(token)).replyText).toBe("ขออภัยด้วยนะคะ จะคืนเงิน ฿350 ให้ภายในวันนี้ค่ะ");

    // The new reply joins the replies list, waiting for Fon.
    const replies = await screen.findByRole("list", { name: "Replies" });
    await within(replies).findByText("ขออภัยด้วยนะคะ จะคืนเงิน ฿350 ให้ภายในวันนี้ค่ะ");
    expect(within(replies).getAllByText("Waiting for Fon").length).toBeGreaterThan(0);
  });

  it("shows the PromptPay QR and records a payment checked in the bank app", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    const record = vi.spyOn(api, "recordPayment");
    renderWithApi(<OpsConsole />, api);

    fireEvent.click(await screen.findByRole("tab", { name: "PromptPay" }));
    const id = (await screen.findByLabelText("Shop's PromptPay id")) as HTMLInputElement;
    await waitFor(() => expect(id.value).toBe("0812345678"));

    fireEvent.change(screen.getByLabelText("Amount in baht", { selector: "#pp-amount" }), { target: { value: "1,290" } });
    expect(promptPayPayload).toHaveBeenLastCalledWith({ id: "0812345678", amountSatang: 129000 });
    expect(screen.getByRole("img", { name: "PromptPay QR code, ฿1,290 to 0812345678" })).toBeTruthy();

    fireEvent.change(id, { target: { value: "12345" } });
    expect(screen.getByText("This is not a PromptPay phone number, national id, tax id or e-wallet id.")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /PromptPay QR code/ })).toBeNull();
    fireEvent.change(id, { target: { value: "0812345678" } });

    const form = screen.getByRole("form", { name: "Slip checked in the bank app" });
    fireEvent.change(within(form).getByLabelText("Order"), { target: { value: "SP-2310" } });
    fireEvent.change(within(form).getByLabelText("Amount in baht"), { target: { value: "1,290.50" } });
    fireEvent.change(within(form).getByLabelText("Note (optional)"), { target: { value: "Slip time 14:02" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record payment" }));

    expect((await within(form).findByRole("status")).textContent).toBe("Recorded. Order SP-2310, ฿1,290.50.");
    expect(record).toHaveBeenCalledWith({
      tenant: "shop_baanmali",
      orderRef: "SP-2310",
      amountSatang: 129050,
      promptPayId: "0812345678",
      slipNote: "Slip time 14:02",
    });
    const payments = await screen.findByRole("list", { name: "Recorded payments" });
    await within(payments).findByText("Order SP-2310, ฿1,290.50");
    expect(within(payments).getByText("Order SP-2301, ฿1,290")).toBeTruthy();
  });

  it("refuses to record a payment with no order or a bad amount", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "op-key-123");
    const api = fakeApi();
    const record = vi.spyOn(api, "recordPayment");
    renderWithApi(<OpsConsole />, api);
    fireEvent.click(await screen.findByRole("tab", { name: "PromptPay" }));
    const form = await screen.findByRole("form", { name: "Slip checked in the bank app" });
    fireEvent.change(within(form).getByLabelText("Amount in baht"), { target: { value: "12.345" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record payment" }));
    expect(within(form).getByText("Write the order number, like SP-2301.")).toBeTruthy();
    expect(within(form).getByText("Write the amount in baht, like 1,290 or 1,290.50.")).toBeTruthy();
    expect(record).not.toHaveBeenCalled();
  });

  it("says so when the API refuses the key, and lets the operator enter another", async () => {
    sessionStorage.setItem("manut.pilot.operatorKey", "wrong");
    const api = fakeApi();
    vi.spyOn(api, "listShops").mockRejectedValue(new ApiError(403, "forbidden"));
    renderWithApi(<OpsConsole />, api);

    expect((await screen.findByRole("alert")).textContent).toMatch(/The API refused the operator key/);
    fireEvent.click(screen.getByRole("button", { name: "Enter another key" }));
    expect(sessionStorage.getItem("manut.pilot.operatorKey")).toBeNull();
    expect(screen.getByLabelText("Operator key")).toBeTruthy();
  });
});
