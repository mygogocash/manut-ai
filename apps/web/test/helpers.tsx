import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { onTestFinished, vi } from "vitest";
import { ApiProvider, type ApiMode, type ApprovalView, type DeletionView, type PilotApi } from "../src/api";

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
    listTemplates: missing("listTemplates"),
    getQuestions: missing("getQuestions"),
    answerQuestion: missing("answerQuestion"),
    createLineConnection: missing("createLineConnection"),
    listMessages: missing("listMessages"),
    proposeReply: missing("proposeReply"),
    listActions: missing("listActions"),
    recordPayment: missing("recordPayment"),
    listPayments: missing("listPayments"),
    exportShop: missing("exportShop"),
    deleteShop: missing("deleteShop"),
    getDeletion: missing("getDeletion"),
    decideDeletion: missing("decideDeletion"),
    recordSubscriptionPayment: missing("recordSubscriptionPayment"),
    listSubscriptionPayments: missing("listSubscriptionPayments"),
    getGate: missing("getGate"),
    setGateCohort: missing("setGateCohort"),
    listAudit: missing("listAudit"),
    getMemory: missing("getMemory"),
    rememberFact: missing("rememberFact"),
    confirmFact: missing("confirmFact"),
    correctFact: missing("correctFact"),
    forgetFact: missing("forgetFact"),
    getPeople: missing("getPeople"),
    createInvite: missing("createInvite"),
    revokeInvite: missing("revokeInvite"),
    removeHelper: missing("removeHelper"),
    setAway: missing("setAway"),
    clearAway: missing("clearAway"),
    linkOwner: missing("linkOwner"),
    unlinkOwner: missing("unlinkOwner"),
    getModelUsage: missing("getModelUsage"),
    setModelCap: missing("setModelCap"),
    listWorkerJobs: missing("listWorkerJobs"),
    requestEmailCode: missing("requestEmailCode"),
    exchangeEmailCode: missing("exchangeEmailCode"),
    acceptInvite: missing("acceptInvite"),
    endShopSession: missing("endShopSession"),
    signOut: missing("signOut"),
    webSignIn: missing("webSignIn"),
    webShops: missing("webShops"),
    webApprovals: missing("webApprovals"),
    webDecide: missing("webDecide"),
    webSignOut: missing("webSignOut"),
    ...overrides,
  };
}

export function sampleDeletionView(overrides: Partial<DeletionView> = {}): DeletionView {
  return {
    shopName: "Baan Mali",
    goes: { messages: 7, replies: 6, payments: 2, lineConnected: true },
    state: "awaiting_owner",
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
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

export type CapturedDownload = { name: string; href: string; attached: boolean };

/// Records every file the page hands to the browser. jsdom has no object URLs and does not follow links, so
/// this stands in for both: each Blob is kept, and a click on a link records its file name instead of
/// navigating. Everything is put back when the test ends.
export function captureDownloads() {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const downloads: CapturedDownload[] = [];
  const saved = {
    create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return `blob:https://web.test/download-${blobs.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href, attached: this.isConnected });
  });
  onTestFinished(() => {
    for (const [key, descriptor] of [
      ["createObjectURL", saved.create],
      ["revokeObjectURL", saved.revoke],
    ] as const) {
      if (descriptor) Object.defineProperty(URL, key, descriptor);
      else delete (URL as unknown as Record<string, unknown>)[key];
    }
  });
  return { blobs, revoked, downloads };
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
