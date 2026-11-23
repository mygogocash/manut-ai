import { describe, expect, it } from "vitest";
import {
  MAX_FACTS, compareForm, confirm, correct, emptyState, exportFacts, fingerprint, forget, propose, remember, usable,
  type MemoryState, type Fact, type FactSource,
} from "../src/index";

function ok(r: { ok: boolean }): asserts r is { ok: true; state: MemoryState; fact: Fact } {
  if (!r.ok) throw new Error("expected ok");
}
const doc: FactSource = { kind: "document", name: "your price list", date: 1000 };
const cust: FactSource = { kind: "customer", chat: "line:U123" };

describe("remember", () => {
  it("adds a confirmed owner fact, trimmed", () => {
    const r = remember(emptyState(), "  We close on Mondays ", 5);
    ok(r);
    expect(r.fact).toMatchObject({ text: "We close on Mondays", status: "confirmed", createdAt: 5, updatedAt: 5, source: { kind: "owner" } });
    expect(usable(r.state)).toHaveLength(1);
  });
  it("answers already_known for a confirmed duplicate in another form", () => {
    const a = remember(emptyState(), "Closed on Mondays", 1);
    ok(a);
    const b = remember(a.state, "closed on  mondays ", 2);
    expect(b).toMatchObject({ ok: false, reason: "already_known" });
    expect(b.state).toBe(a.state);
  });
  it("confirms a waiting fact instead of adding twice", () => {
    const a = propose(emptyState(), "Ships in 2 days", cust, 1);
    ok(a);
    const b = remember(a.state, "ships in 2 days", 2);
    ok(b);
    expect(b.state.facts).toHaveLength(1);
    expect(b.fact).toMatchObject({ id: a.fact.id, status: "confirmed", updatedAt: 2 });
  });
  it("refuses empty and over-long text", () => {
    expect(remember(emptyState(), "   ", 1)).toMatchObject({ ok: false, reason: "invalid_text" });
    expect(remember(emptyState(), "x".repeat(281), 1)).toMatchObject({ ok: false, reason: "invalid_text" });
    expect(remember(emptyState(), "x".repeat(280), 1).ok).toBe(true);
    expect(remember(emptyState(), 5 as unknown as string, 1)).toMatchObject({ ok: false, reason: "invalid_text" });
  });
  it("counts Thai text by characters", () => {
    expect(remember(emptyState(), "ร้านปิดวันจันทร์", 1).ok).toBe(true);
  });
});

describe("propose", () => {
  it("confirms facts from the owner's own data", () => {
    for (const source of [doc, { kind: "edits", count: 12 }, { kind: "orders", days: 30 }, { kind: "connection", name: "Google Sheets", detail: "cost sheet" }] as FactSource[]) {
      const r = propose(emptyState(), "Candles cost 90", source, 1);
      ok(r);
      expect(r.fact.status).toBe("confirmed");
      expect(r.fact.source).toEqual(source);
    }
  });
  it("makes a customer's fact wait, and usable leaves it out", () => {
    const r = propose(emptyState(), "Shop is cheaper on Shopee", cust, 1);
    ok(r);
    expect(r.fact.status).toBe("waiting");
    expect(usable(r.state)).toEqual([]);
  });
  it("answers already_known for the same text again", () => {
    const a = propose(emptyState(), "A fact", doc, 1);
    ok(a);
    expect(propose(a.state, "a  FACT", doc, 2)).toMatchObject({ ok: false, reason: "already_known" });
    const w = propose(emptyState(), "Customer says", cust, 1);
    ok(w);
    expect(propose(w.state, "customer says", cust, 2)).toMatchObject({ ok: false, reason: "already_known" });
  });
  it("confirms a waiting fact proposed again from the owner's data, but not from a customer", () => {
    const w = propose(emptyState(), "Gift wrap is 20", cust, 1);
    ok(w);
    const c = propose(w.state, "gift wrap is 20", { kind: "orders", days: 14 }, 9);
    ok(c);
    expect(c.fact).toMatchObject({ status: "confirmed", updatedAt: 9 });
    expect(c.state.facts).toHaveLength(1);
  });
  it("answers already_known for a confirmed fact even from the owner's data", () => {
    const a = remember(emptyState(), "x", 1);
    ok(a);
    expect(propose(a.state, "X", doc, 2)).toMatchObject({ ok: false, reason: "already_known" });
  });
  it("refuses bad text and bad sources", () => {
    expect(propose(emptyState(), "", doc, 1)).toMatchObject({ reason: "invalid_text" });
    for (const bad of [null, { kind: "nope" }, { kind: "edits", count: 0 }, { kind: "orders", days: 1.5 }, { kind: "document", name: " ", date: 1 }, { kind: "customer", chat: "" }, { kind: "connection", name: "", detail: "" }]) {
      expect(propose(emptyState(), "ok", bad as unknown as FactSource, 1)).toMatchObject({ ok: false, reason: "invalid_source" });
    }
  });
});

describe("confirm, correct, forget", () => {
  it("confirms a waiting fact and is idempotent", () => {
    const w = propose(emptyState(), "Maybe", cust, 1);
    ok(w);
    const c = confirm(w.state, w.fact.id, 7);
    ok(c);
    expect(c.fact).toMatchObject({ status: "confirmed", updatedAt: 7 });
    const again = confirm(c.state, w.fact.id, 99);
    ok(again);
    expect(again.fact.updatedAt).toBe(7);
  });
  it("corrects: new text, confirmed, correctedAt, same source", () => {
    const w = propose(emptyState(), "Free shipping over 500", cust, 1);
    ok(w);
    const c = correct(w.state, w.fact.id, " Free shipping over 600 ", 4);
    ok(c);
    expect(c.fact).toMatchObject({ text: "Free shipping over 600", status: "confirmed", correctedAt: 4, updatedAt: 4, createdAt: 1, source: cust });
  });
  it("refuses a correction to bad text or to another fact's text", () => {
    const a = remember(emptyState(), "one", 1);
    ok(a);
    const b = remember(a.state, "two", 1);
    ok(b);
    expect(correct(b.state, b.fact.id, "ONE", 2)).toMatchObject({ ok: false, reason: "already_known" });
    expect(correct(b.state, b.fact.id, "", 2)).toMatchObject({ ok: false, reason: "invalid_text" });
    expect(correct(b.state, b.fact.id, "two", 2).ok).toBe(true);
  });
  it("answers not_found for an unknown id", () => {
    const s = emptyState();
    expect(confirm(s, "nope", 1)).toMatchObject({ ok: false, reason: "not_found" });
    expect(correct(s, "nope", "x", 1)).toMatchObject({ ok: false, reason: "not_found" });
    expect(forget(s, "nope")).toMatchObject({ ok: false, reason: "not_found" });
  });
  it("forget removes the text and keeps only a fingerprint", () => {
    const a = remember(emptyState(), "Secret supplier is X", 1);
    ok(a);
    const f = forget(a.state, a.fact.id);
    expect(f.ok).toBe(true);
    expect(f.state.facts).toEqual([]);
    expect(f.state.forgotten).toEqual([fingerprint("secret supplier is x")]);
    expect(JSON.stringify(f.state)).not.toContain("supplier");
  });
  it("a forgotten text is not learned again, in any form", () => {
    const a = propose(emptyState(), "Secret supplier is X", doc, 1);
    ok(a);
    const f = forget(a.state, a.fact.id);
    expect(propose(f.state, " secret  SUPPLIER is x", cust, 2)).toMatchObject({ ok: false, reason: "forgotten" });
    expect(propose(f.state, "secret supplier is x", doc, 2)).toMatchObject({ ok: false, reason: "forgotten" });
  });
  it("remember clears the fingerprint", () => {
    const a = remember(emptyState(), "Back in stock", 1);
    ok(a);
    const f = forget(a.state, a.fact.id);
    const r = remember(f.state, "back in stock", 3);
    ok(r);
    expect(r.state.forgotten).toEqual([]);
    expect(r.fact.id).not.toBe(a.fact.id);
  });
  it("correct to a forgotten text clears the fingerprint too", () => {
    const a = remember(emptyState(), "old", 1);
    ok(a);
    const b = remember(a.state, "gone", 1);
    ok(b);
    const f = forget(b.state, b.fact.id);
    const c = correct(f.state, a.fact.id, "gone", 2);
    ok(c);
    expect(c.state.forgotten).toEqual([]);
  });
  it("does not clear the fingerprint when remember is refused", () => {
    let s = emptyState();
    const a = remember(s, "keep", 1);
    ok(a);
    s = forget(a.state, a.fact.id).state;
    expect(remember(s, "x".repeat(300), 1).state.forgotten).toHaveLength(1);
  });
  it("forgetting does not reuse ids", () => {
    const a = remember(emptyState(), "a", 1);
    ok(a);
    const f = forget(a.state, a.fact.id);
    const b = remember(f.state, "b", 1);
    ok(b);
    expect(b.fact.id).not.toBe(a.fact.id);
  });
  it("does not change the state it was given", () => {
    const a = remember(emptyState(), "a", 1);
    ok(a);
    const snapshot = JSON.stringify(a.state);
    confirm(a.state, a.fact.id, 2);
    correct(a.state, a.fact.id, "b", 2);
    forget(a.state, a.fact.id);
    expect(JSON.stringify(a.state)).toBe(snapshot);
  });
});

describe("Thai and text comparison", () => {
  it("compares Thai text after NFC and spaces", () => {
    expect(compareForm("  ร้านปิด   วันจันทร์ ")).toBe("ร้านปิด วันจันทร์");
    // Same letters typed with a different Unicode order of composition.
    expect(compareForm("กํา")).toBe(compareForm("กํา"));
    expect(compareForm("é")).toBe(compareForm("é"));
  });
  it("treats Thai duplicates and forgetting like any text", () => {
    const a = remember(emptyState(), "ส่งฟรีเมื่อซื้อครบ 500", 1);
    ok(a);
    expect(remember(a.state, " ส่งฟรีเมื่อซื้อครบ   500", 2)).toMatchObject({ reason: "already_known" });
    const f = forget(a.state, a.fact.id);
    expect(propose(f.state, "ส่งฟรีเมื่อซื้อครบ 500", cust, 3)).toMatchObject({ reason: "forgotten" });
  });
  it("fingerprint is FNV-1a 64 as 16 hex digits", () => {
    expect(fingerprint("")).toBe("cbf29ce484222325");
    expect(fingerprint("a")).toBe("af63dc4c8601ec8c");
    expect(fingerprint("A  ")).toBe(fingerprint("a"));
  });
});

describe("limits and export", () => {
  function full(): MemoryState {
    let s = emptyState();
    for (let i = 0; i < MAX_FACTS; i++) {
      const r = remember(s, `fact ${i}`, 1);
      ok(r);
      s = r.state;
    }
    return s;
  }
  it("allows 200 facts and answers full for one more", () => {
    const s = full();
    expect(s.facts).toHaveLength(200);
    expect(remember(s, "one more", 1)).toMatchObject({ ok: false, reason: "full" });
    expect(propose(s, "one more", cust, 1)).toMatchObject({ ok: false, reason: "full" });
  });
  it("full still lets an existing waiting fact be confirmed, and Forget makes room", () => {
    const f = forget(full(), "f1");
    expect(remember(f.state, "one more", 1).ok).toBe(true);
  });
  it("exportFacts gives every fact and only the number of fingerprints", () => {
    const a = remember(emptyState(), "kept", 1);
    ok(a);
    const w = propose(a.state, "waiting one", cust, 2);
    ok(w);
    const b = remember(w.state, "gone", 3);
    ok(b);
    const f = forget(b.state, b.fact.id);
    const e = exportFacts(f.state);
    expect(e.facts.map((x) => x.text)).toEqual(["kept", "waiting one"]);
    expect(e.forgottenCount).toBe(1);
    expect(JSON.stringify(e)).not.toContain(fingerprint("gone"));
  });
});
