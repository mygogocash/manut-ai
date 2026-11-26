import {
  decodeRecord,
  encodeRecord,
  encodeStanding,
  InMemoryApprovalStore,
  requestStanding,
  type ApprovalKind,
  type ApprovalOption,
  type ApprovalRecord,
  type DecideResult,
  type Role,
} from "@manut/approval-core";
import type { WebAnswer, WebApprovalsState, WebDecision, WebShop } from "./types";

/// The owner's web app in practice mode (src/app; docs/web-app.md): the shops a practice sign-in is in, and each shop's
/// requests as approval-core records in approval-core's own in-memory store, so a decision here is settled or refused by
/// the same rules as the API's: who may decide which kind, once, at the revision seen, before it expires. Answers are the
/// web routes' (docs/pilot-api.md, "The web app's session"): a listing as `GET /v1/approvals` answers it, a decision as
/// `POST /v1/approvals/{requestId}/decision` does.
///
/// A practice sign-in owns Baan Mali, the console's sample shop, as Fon, and helps at Khao Soi Nimman, the join page's
/// demo shop, as Noi. Baan Mali waits for two LINE replies (LINE accepts the first and refuses the second) and Ton's
/// books for October; Khao Soi Nimman for a reply whose send nobody can confirm, a reply its owner Lek answers from LINE
/// a moment before Noi does, and its own books, which wait for Lek. Each shop also has two requests answered lately: one a
/// helper decided, one that nobody answered in time. No payment or post is asked for, since both are parked.
///
/// Everything lives in this object, made at each practice sign-in, and nothing reaches the browser's storage.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/// The options every request offers, as the API's task object offers them (`JOB_REQUEST_OPTIONS`).
const OPTIONS: readonly ApprovalOption[] = [
  { id: "approve", label: "Approve", effect: "approve" },
  { id: "decline", label: "Decline", effect: "decline" },
];

/// Where an approved request's send stands after it, as the decision route's `action` says it.
type Send = "confirmed" | "failed" | "unknown";

type Sample = {
  id: string;
  kind: ApprovalKind;
  detail: Record<string, unknown>;
  /// Minutes before the sign-in that it was asked.
  askedAgo: number;
  /// What an approval's send comes to.
  sends?: Send;
  /// Someone else decides it a moment before the person does: the shop's owner from the LINE link.
  takenFirst?: boolean;
  /// Answered before the sign-in: by a helper, or by nobody in time.
  answered?: "byHelper" | "expired";
};

export const PRACTICE_SHOPS: readonly WebShop[] = [
  { id: "shop_baanmali", name: "Baan Mali", ownerName: "Fon", role: "owner", you: "owner-fon", ready: true },
  // The join page's demo shop (`DEMO_JOIN_SHOP` in fake.ts), where the practice person helps.
  { id: "pilot:practice-khao-soi-nimman", name: "Khao Soi Nimman", ownerName: "Lek", role: "helper", you: "helper-noi",
    ready: true },
];

const BOT = `U${"b".repeat(32)}`;
const CUSTOMER = `U${"c".repeat(32)}`;

function reply(id: string, text: string): Record<string, unknown> {
  return { actionId: id, operationType: "line.message.push", targetResourceId: BOT, recipient: CUSTOMER, text,
    payloadHash: "practice" };
}

/// Ton's books for a month as the owner's request names them, with the control plane's own sentence (books-detail.ts).
function books(id: string, title: string): Record<string, unknown> {
  return {
    actionId: id,
    operationType: "google.sheets.append",
    sheet: { id: "practice-sheet", title, tab: "Books" },
    month: "2026-10",
    rows: 47,
    totals: { sales: "฿48,250", salesCount: 41, refunds: "฿350", refundsCount: 1, expenses: "฿6,120", expensesCount: 5,
      net: "฿47,900" },
    flags: 1,
    lines: [],
    text: `Append the books for 2026-10 to the Google Sheet ${JSON.stringify(title)}, tab "Books": a header row, then 47 rows. ` +
      "Sales ฿48,250 (41 entries), refunds ฿350 (1), expenses ฿6,120 (5), net sales ฿47,900. Ton flagged 1 entry for you to check.",
    payloadHash: "practice",
  };
}

/// Ton's books as a helper is shown them (books-detail.ts, `helperBooksDetail`): that they wait, and nothing of the sales.
function helperBooks(id: string): Record<string, unknown> {
  return { actionId: id, operationType: "google.sheets.append", month: "2026-10", sheet: { title: "Manut AI books: Khao Soi Nimman" },
    ownerOnly: true, text: "Ton asks to append the books for 2026-10 to the owner's Google Sheet. Only the owner sees the books " +
      "and can approve it." };
}

const SAMPLES: Readonly<Record<string, readonly Sample[]>> = {
  shop_baanmali: [
    { id: "practice-bm-late", kind: "reply", askedAgo: 25, sends: "confirmed",
      detail: reply("practice-bm-late", "ขออภัยที่พัสดุล่าช้านะคะ ตอนนี้ของออกจากคลังแล้ว คาดว่าจะถึงภายในวันอังคารค่ะ") },
    { id: "practice-bm-free", kind: "reply", askedAgo: 12, sends: "failed",
      detail: reply("practice-bm-free", "รอบหน้ามีโปรส่งฟรีเมื่อซื้อครบ 500 บาทนะคะ") },
    { id: "practice-bm-books", kind: "command", askedAgo: 4, sends: "confirmed",
      detail: books("practice-bm-books", "Manut AI books: Baan Mali") },
    { id: "practice-bm-mint", kind: "reply", askedAgo: 180, answered: "byHelper",
      detail: reply("practice-bm-mint", "ได้ค่ะ เดี๋ยวแอดมินส่งรูปสีอื่นให้นะคะ") },
    { id: "practice-bm-old", kind: "reply", askedAgo: 30 * 60, answered: "expired",
      detail: reply("practice-bm-old", "สินค้าหมดชั่วคราวค่ะ") },
  ],
  "pilot:practice-khao-soi-nimman": [
    { id: "practice-ksn-hours", kind: "reply", askedAgo: 18, sends: "unknown",
      detail: reply("practice-ksn-hours", "พรุ่งนี้ร้านเปิด 10 โมงค่ะ") },
    { id: "practice-ksn-taken", kind: "reply", askedAgo: 9, sends: "confirmed", takenFirst: true,
      detail: reply("practice-ksn-taken", "รับจองโต๊ะ 4 ที่ 19:00 ค่ะ") },
    { id: "practice-ksn-books", kind: "command", askedAgo: 6, sends: "confirmed", detail: helperBooks("practice-ksn-books") },
    { id: "practice-ksn-mint", kind: "reply", askedAgo: 240, answered: "byHelper",
      detail: reply("practice-ksn-mint", "มีเมนูมังสวิรัติค่ะ") },
  ],
};

/// The same statuses the API's decision route answers approval-core's refusals with (approvals.ts, `REFUSAL_STATUS`).
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  already_decided: 409,
  not_permitted: 403,
  superseded: 409,
  expired: 410,
  changed: 409,
  not_offered: 400,
};

export type PracticeOwner = {
  approvals(shop: string, state: WebApprovalsState): Promise<WebAnswer>;
  decide(input: WebDecision): Promise<WebAnswer>;
};

/// A practice world as it stands at a sign-in at `now()`.
export async function practiceOwner(now: () => number): Promise<PracticeOwner> {
  let skew = 0;
  const clock = () => now() + skew;
  const stores = new Map<string, InMemoryApprovalStore>();
  /// Where each approved request's send stands, as the action's state after a decision.
  const actions = new Map<string, string>();
  const signedInAt = now();

  for (const shop of PRACTICE_SHOPS) {
    const store = new InMemoryApprovalStore({ now: clock });
    stores.set(shop.id, store);
    for (const sample of SAMPLES[shop.id] ?? []) {
      skew = -sample.askedAgo * MINUTE;
      // Every request waits 24 hours, as a reply's link does; the one nobody answered ran out an hour after it was asked.
      const expiresAt = signedInAt - sample.askedAgo * MINUTE + (sample.answered === "expired" ? HOUR : 24 * HOUR);
      await store.open({ id: sample.id, kind: sample.kind, options: OPTIONS, expiresAt, detail: sample.detail });
      if (sample.answered === "byHelper") {
        skew = -(sample.askedAgo - 7) * MINUTE;
        await store.decide({ requestId: sample.id, optionId: "approve", seenRevision: 1, decidedBy: "helper-mint",
          role: "helper" }, { running: {} });
        actions.set(sample.id, "confirmed");
      }
    }
  }
  skew = 0;

  function sampleOf(shop: string, id: string): Sample | undefined {
    return SAMPLES[shop]?.find((sample) => sample.id === id);
  }

  return {
    async approvals(shop, state) {
      const store = stores.get(shop);
      if (!store) return { status: 401, body: { error: "session_ended", shop } };
      const listed: { taskId: string; record: unknown; standing: unknown }[] = [];
      for (const sample of SAMPLES[shop] ?? []) {
        const record = await store.get(sample.id);
        if (!record) continue;
        const standing = requestStanding(record, { seenRevision: record.request.revision, running: {}, now: clock() });
        if ((standing.state === "open") !== (state === "open")) continue;
        listed.push({ taskId: `practice-task-${shop}`, record: encodeRecord(decodeRecord(record)), standing: encodeStanding(standing),
          createdAt: record.request.createdAt } as never);
      }
      // Newest asked first, as the API lists them.
      const sorted = listed.sort((a, b) => order(b) - order(a)).map(({ taskId, record, standing }) => ({ taskId, record, standing }));
      return { status: 200, body: { state, approvals: sorted } };
    },

    async decide(input) {
      const store = stores.get(input.shop);
      const shop = PRACTICE_SHOPS.find((one) => one.id === input.shop);
      if (!store || !shop?.you) return { status: 401, body: { error: "session_ended", shop: input.shop } };
      const sample = sampleOf(input.shop, input.requestId);
      const role: Role = shop.role;
      if (sample?.takenFirst) {
        // The shop's owner answers from the LINE link a moment before: the store settles theirs first, so the person's
        // own answer is approval-core's `already_decided`, naming the link.
        const first = await store.decide({ requestId: sample.id, optionId: "approve", seenRevision: input.seenRevision,
          decidedBy: "owner-link", role: "owner" }, { running: {} });
        if (first.ok) actions.set(sample.id, sample.sends ?? "confirmed");
      }
      const result: DecideResult = await store.decide({ requestId: input.requestId, optionId: input.optionId,
        seenRevision: input.seenRevision, decidedBy: shop.you, role }, { running: {} });
      if (result.ok) {
        const approved = input.optionId === "approve";
        const action = approved ? (sample?.sends ?? "confirmed") : "rejected";
        actions.set(input.requestId, action);
        return { status: 200, body: { result, action } };
      }
      const action = actions.get(input.requestId) ?? "proposed";
      return { status: REFUSAL_STATUS[result.refused] ?? 409, body: { error: result.refused, result, action } };
    },
  };
}

function order(entry: unknown): number {
  const at = (entry as { createdAt?: unknown }).createdAt;
  return typeof at === "number" ? at : 0;
}

/// The record a practice request holds now, for tests.
export type PracticeRecord = ApprovalRecord;
