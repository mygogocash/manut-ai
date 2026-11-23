import { describe, expect, it } from "vitest";
import { checkSlip, missingFields, normalizeName, sameName, type SlipCheckInput } from "../src/index.js";

const base = (): SlipCheckInput => ({
  slip: { amountSatang: 129000, payeeName: "Fon S.", paidAt: "2026-11-23T10:05:00+07:00", reference: "REF1" },
  order: { orderRef: "A-1", amountSatang: 129000, placedAt: "2026-11-23T10:00:00+07:00" },
  shopName: "fon s",
  usedReferences: {},
});

describe("names", () => {
  it("ignore case, spaces and dots", () => {
    expect(sameName("Fon S.", "fon s")).toBe(true);
    expect(sameName("F.O.N  S", "fons")).toBe(true);
    expect(normalizeName(" Ab.C ")).toBe("abc");
  });
  it("tell different names apart and ignore accent composition", () => {
    expect(sameName("Fon S.", "Fon T.")).toBe(false);
    expect(sameName("Café", "Café")).toBe(true);
  });
});

describe("matches", () => {
  it("agrees and still leaves confirming to the owner", () => {
    const v = checkSlip(base());
    expect(v).toEqual({ kind: "matches", ownerMustConfirm: true });
  });
  it("accepts a slip paid exactly five minutes before the order", () => {
    const i = base();
    i.slip.paidAt = "2026-11-23T09:55:00+07:00";
    expect(checkSlip(i).kind).toBe("matches");
  });
  it("accepts the same slip checked again against the order it settled", () => {
    const i = base();
    i.usedReferences = { REF1: "A-1" };
    expect(checkSlip(i).kind).toBe("matches");
  });
});

describe("each verdict", () => {
  it("unreadable lists every missing field in a fixed order", () => {
    const i = base();
    i.slip = { amountSatang: null, paidAt: "not a date" };
    expect(checkSlip(i)).toEqual({ kind: "unreadable", missing: ["amountSatang", "payeeName", "paidAt", "reference"] });
  });
  it("treats blank text, a fraction and a negative amount as missing", () => {
    expect(missingFields({ amountSatang: 1.5, payeeName: "  ", paidAt: "2026-11-23T10:00:00Z", reference: "" })).toEqual([
      "amountSatang", "payeeName", "reference",
    ]);
    expect(missingFields({ amountSatang: -1, payeeName: "x", paidAt: "2026-11-23T10:00:00Z", reference: "r" })).toEqual(["amountSatang"]);
  });
  it("already_used names the earlier order", () => {
    const i = base();
    i.usedReferences = { REF1: "A-0" };
    expect(checkSlip(i)).toEqual({ kind: "already_used", reference: "REF1", earlierOrderRef: "A-0" });
  });
  it("does not mistake object prototype keys for used references", () => {
    const i = base();
    i.slip.reference = "toString";
    expect(checkSlip(i).kind).toBe("matches");
  });
  it("other_payee gives the name on the slip", () => {
    const i = base();
    i.slip.payeeName = "Somchai";
    expect(checkSlip(i)).toEqual({ kind: "other_payee", payeeName: "Somchai" });
  });
  it("amount_differs gives both amounts", () => {
    const i = base();
    i.slip.amountSatang = 128900;
    expect(checkSlip(i)).toEqual({ kind: "amount_differs", slipSatang: 128900, orderSatang: 129000 });
  });
  it("older_than_order beyond five minutes of clock difference", () => {
    const i = base();
    i.slip.paidAt = "2026-11-23T09:54:59+07:00";
    expect(checkSlip(i)).toEqual({
      kind: "older_than_order",
      paidAt: "2026-11-23T09:54:59+07:00",
      placedAt: "2026-11-23T10:00:00+07:00",
    });
  });
  it("compares moments, not text, across time zones", () => {
    const i = base();
    i.slip.paidAt = "2026-11-23T03:05:00Z";
    expect(checkSlip(i).kind).toBe("matches");
  });
});

describe("precedence", () => {
  const allWrong = (): SlipCheckInput => {
    const i = base();
    i.slip = { amountSatang: 1, payeeName: "Other", paidAt: "2026-01-01T00:00:00Z", reference: "REF1" };
    i.usedReferences = { REF1: "A-0" };
    return i;
  };
  it("unreadable beats everything", () => {
    const i = allWrong();
    delete i.slip.reference;
    expect(checkSlip(i).kind).toBe("unreadable");
  });
  it("already used beats other payee, amount and age", () => {
    expect(checkSlip(allWrong()).kind).toBe("already_used");
  });
  it("other payee beats amount and age", () => {
    const i = allWrong();
    i.usedReferences = {};
    expect(checkSlip(i).kind).toBe("other_payee");
  });
  it("amount beats age", () => {
    const i = allWrong();
    i.usedReferences = {};
    i.slip.payeeName = "fon s";
    expect(checkSlip(i).kind).toBe("amount_differs");
  });
  it("age is last", () => {
    const i = allWrong();
    i.usedReferences = {};
    i.slip.payeeName = "fon s";
    i.slip.amountSatang = 129000;
    expect(checkSlip(i).kind).toBe("older_than_order");
  });
});
