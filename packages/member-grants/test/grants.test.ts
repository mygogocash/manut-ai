import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROSTER,
  PRACTICE_DAYS,
  decide,
  endPractice,
  inPracticeMode,
  newConnection,
  practiceEndsAt,
  type Roster,
} from "../src";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 9, 0);
const afterPractice = T0 + PRACTICE_DAYS * DAY;
const fresh = newConnection(T0);

describe("default roster", () => {
  const ids = (m: string) => DEFAULT_ROSTER.find((x) => x.id === m)!.capabilities.map((c) => c.id);
  it("gives each member its jobs", () => {
    expect(ids("buddy")).toEqual(["route_work"]);
    expect(ids("nam")).toEqual(["read_orders", "order_status", "reply_customers", "place_orders", "change_orders"]);
    expect(ids("pim")).toEqual(["draft_posts", "publish_posts"]);
    expect(ids("ton")).toEqual(["read_payments", "check_slips", "draft_books", "confirm_payment", "send_books", "ask_refund",
      "append_books"]);
    expect(ids("kit")).toEqual(["run_command"]);
  });
  it("maps writes to the approval kinds", () => {
    const kind = (cap: string) => {
      for (const m of DEFAULT_ROSTER) for (const c of m.capabilities) if (c.id === cap && c.access === "write") return c.kind;
    };
    expect(kind("reply_customers")).toBe("reply");
    expect(kind("publish_posts")).toBe("public_post");
    expect(kind("ask_refund")).toBe("money");
    expect(kind("confirm_payment")).toBe("payment_confirmation");
    expect(kind("send_books")).toBe("message");
    expect(kind("run_command")).toBe("command");
    // An order placed or changed may spend, charge or refund the shop's money, so it asks as money: the owner's only.
    expect(kind("place_orders")).toBe("money");
    expect(kind("change_orders")).toBe("money");
    // A month of the books into the owner's Google Sheet changes the shop's records, and its sales are the owner's alone.
    expect(kind("append_books")).toBe("command");
  });
});

describe("decide after practice", () => {
  const now = afterPractice;
  it("allows reads", () => {
    expect(decide("nam", "read_orders", fresh, now)).toEqual({ answer: "allowed" });
    expect(decide("ton", "check_slips", null, now)).toEqual({ answer: "allowed" });
    expect(decide("buddy", "route_work", undefined, now)).toEqual({ answer: "allowed" });
  });
  it("asks for writes with the right kind", () => {
    expect(decide("nam", "reply_customers", fresh, now)).toEqual({ answer: "ask", kind: "reply" });
    expect(decide("ton", "ask_refund", fresh, now)).toEqual({ answer: "ask", kind: "money" });
    expect(decide("pim", "publish_posts", fresh, now)).toEqual({ answer: "ask", kind: "public_post" });
    expect(decide("kit", "run_command", fresh, now)).toEqual({ answer: "ask", kind: "command" });
    expect(decide("nam", "place_orders", fresh, now)).toEqual({ answer: "ask", kind: "money" });
    expect(decide("nam", "change_orders", fresh, now)).toEqual({ answer: "ask", kind: "money" });
  });
  it("says not_my_job naming the member whose job it is", () => {
    expect(decide("nam", "ask_refund", fresh, now)).toEqual({ answer: "not_my_job", member: "ton" });
    expect(decide("ton", "reply_customers", fresh, now)).toEqual({ answer: "not_my_job", member: "nam" });
    expect(decide("buddy", "publish_posts", fresh, now)).toEqual({ answer: "not_my_job", member: "pim" });
    expect(decide("ton", "change_orders", fresh, now)).toEqual({ answer: "not_my_job", member: "nam" });
  });
  it("says not_connected without a usable connection", () => {
    expect(decide("nam", "reply_customers", null, now)).toEqual({ answer: "not_connected" });
    expect(decide("nam", "read_orders", undefined, now)).toEqual({ answer: "not_connected" });
    expect(decide("nam", "reply_customers", { ...fresh, connected: false }, now)).toEqual({ answer: "not_connected" });
    expect(decide("nam", "reply_customers", { ...fresh, connectedAt: Number.NaN }, now)).toEqual({ answer: "not_connected" });
  });
  it("lets jobs that need no connection run without one", () => {
    expect(decide("pim", "draft_posts", null, now)).toEqual({ answer: "allowed" });
  });
});

describe("practice mode", () => {
  it("makes every write draft only, keeping the approval kind", () => {
    const now = T0 + DAY;
    expect(decide("nam", "reply_customers", fresh, now)).toEqual({ answer: "draft_only", kind: "reply" });
    expect(decide("ton", "ask_refund", fresh, now)).toEqual({ answer: "draft_only", kind: "money" });
    expect(decide("pim", "publish_posts", fresh, now)).toEqual({ answer: "draft_only", kind: "public_post" });
    expect(decide("nam", "place_orders", fresh, now)).toEqual({ answer: "draft_only", kind: "money" });
  });
  it("still allows reads", () => {
    expect(decide("nam", "read_orders", fresh, T0 + DAY)).toEqual({ answer: "allowed" });
  });
  it("ends exactly 3 days after connecting", () => {
    expect(practiceEndsAt(fresh)).toBe(afterPractice);
    expect(inPracticeMode(fresh, afterPractice - 1)).toBe(true);
    expect(inPracticeMode(fresh, afterPractice)).toBe(false);
    expect(decide("nam", "reply_customers", fresh, afterPractice - 1).answer).toBe("draft_only");
    expect(decide("nam", "reply_customers", fresh, afterPractice).answer).toBe("ask");
  });
  it("is set per connection", () => {
    const longer = newConnection(T0, 7);
    const none = newConnection(T0, 0);
    const now = afterPractice;
    expect(decide("nam", "reply_customers", longer, now).answer).toBe("draft_only");
    expect(decide("nam", "reply_customers", none, T0).answer).toBe("ask");
  });
  it("falls back to 3 days on a broken setting", () => {
    expect(practiceEndsAt({ ...fresh, practiceDays: -1 })).toBe(afterPractice);
    expect(practiceEndsAt({ ...fresh, practiceDays: Number.NaN })).toBe(afterPractice);
    expect(practiceEndsAt({ connected: true, connectedAt: T0 })).toBe(afterPractice);
  });
  it("can be ended early by the owner", () => {
    const ended = endPractice(fresh, T0 + DAY);
    expect(inPracticeMode(ended, T0 + DAY - 1)).toBe(true);
    expect(inPracticeMode(ended, T0 + DAY)).toBe(false);
    expect(decide("ton", "ask_refund", ended, T0 + DAY).answer).toBe("ask");
    expect(endPractice(ended, T0 + 2 * DAY)).toBe(ended);
    expect(fresh.practiceEndedAt).toBeUndefined();
  });
  it("does not apply to a connection that is missing", () => {
    expect(decide("nam", "reply_customers", null, T0).answer).toBe("not_connected");
  });
});

describe("rules no data can change", () => {
  const now = afterPractice;
  it("never answers allowed for a write, whatever the data says", () => {
    const sneaky = [
      {
        id: "nam",
        capabilities: [{ id: "reply_customers", access: "write", kind: "reply", needsConnection: false, allowed: true }],
      },
    ] as unknown as Roster;
    expect(decide("nam", "reply_customers", null, now, sneaky)).toEqual({ answer: "ask", kind: "reply" });
    for (const m of DEFAULT_ROSTER)
      for (const c of m.capabilities)
        if (c.access === "write") {
          for (const t of [T0, now]) {
            const r = decide(m.id, c.id, fresh, t);
            expect(r.answer === "ask" || r.answer === "draft_only").toBe(true);
          }
        }
  });
  it("asks or drafts for money and public posts, never allows", () => {
    for (const t of [T0, T0 + DAY, now, now + 100 * DAY]) {
      for (const [m, c] of [["ton", "ask_refund"], ["pim", "publish_posts"], ["nam", "place_orders"],
        ["nam", "change_orders"]] as const) {
        expect(["ask", "draft_only"]).toContain(decide(m, c, fresh, t).answer);
      }
    }
  });
  it("refuses an unknown member, capability or kind", () => {
    expect(decide("zed", "read_orders", fresh, now)).toEqual({ answer: "refused", reason: "unknown_member" });
    expect(decide("nam", "fly", fresh, now)).toEqual({ answer: "refused", reason: "unknown_capability" });
    const bad = [{ id: "nam", capabilities: [{ id: "x", access: "write", kind: "free_money", needsConnection: false }] }] as unknown as Roster;
    expect(decide("nam", "x", fresh, now, bad)).toEqual({ answer: "refused", reason: "unknown_kind" });
    const noKind = [{ id: "nam", capabilities: [{ id: "x", access: "write", needsConnection: false }] }] as unknown as Roster;
    expect(decide("nam", "x", fresh, now, noKind)).toEqual({ answer: "refused", reason: "unknown_kind" });
  });
  it("does not guess a member from a lookalike name", () => {
    expect(decide("Nam", "read_orders", fresh, now).answer).toBe("refused");
    expect(decide("nam ", "read_orders", fresh, now).answer).toBe("refused");
  });
});
