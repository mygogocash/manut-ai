import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { ApiProvider, type ApiMode, type ApprovalView, type PilotApi } from "../src/api";

/// A PilotApi whose every method fails loudly unless the test gives it one, so a test can never pass by
/// reaching a route it did not mean to.
export function stubApi(overrides: Partial<PilotApi>): PilotApi {
  const missing = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));
  return {
    deliverLineWebhook: missing("deliverLineWebhook"),
    getApproval: missing("getApproval"),
    giveConsent: missing("giveConsent"),
    decide: missing("decide"),
    createShop: missing("createShop"),
    listShops: missing("listShops"),
    createLineConnection: missing("createLineConnection"),
    listMessages: missing("listMessages"),
    proposeReply: missing("proposeReply"),
    listActions: missing("listActions"),
    recordPayment: missing("recordPayment"),
    listPayments: missing("listPayments"),
    ...overrides,
  };
}

export function sampleView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    shopName: "Baan Mali",
    memberName: "Nam",
    memberRole: "sales chat",
    kind: "line.reply",
    customerName: "Khun Ploy",
    customerMessage: "สวัสดีค่ะ สั่งเทียนหอมไปตั้งแต่วันพุธ ยังไม่ได้รับของเลยค่ะ",
    replyText: "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ",
    state: "proposed",
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
    needsConsent: false,
    ...overrides,
  };
}

export function renderWithApi(ui: ReactElement, api: PilotApi, mode: ApiMode = "live") {
  return render(<ApiProvider value={{ api, mode }}>{ui}</ApiProvider>);
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
